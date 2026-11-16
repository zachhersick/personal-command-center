// Plan state lives at runtimeState.plan. It never stores generated tasks, only
// what the user changed: per-task overrides, custom tasks, settings, focus
// sessions and the NeetCode log. Every record carries updatedAt so the
// iCloud/runtime merge can resolve conflicts record by record.
import { effectiveSettings, generateBaseTasks } from "./generator.js";
import { weekStartMonday } from "./dates.js";
import { mergeInbox, mergeJobs } from "../jobs/model.js";

export const PLAN_STATE_VERSION = 1;

// Fields a task override may set. Anything else in a record is ignored.
export const TASK_OVERRIDE_FIELDS = [
  "done",
  "completedAt",
  "skipped",
  "date",
  "minutes",
  "title",
  "detail",
  "notes",
  "evidenceUrl",
  "pinnedStart",
  "schedulePlacement",
  "timelineReleased",
  "accumulatedSeconds",
  "lastFocusedAt"
];

export function ensurePlanState(plan) {
  return {
    version: PLAN_STATE_VERSION,
    importedAt: null,
    importSource: null,
    records: {},
    focusSessions: [],
    neetcodeLog: [],
    jobs: [],
    jobInbox: [],
    musicPlaylists: [],
    musicPlaylistState: [],
    ...(plan || {}),
    records: { ...(plan?.records || {}) },
    focusSessions: [...(plan?.focusSessions || [])],
    neetcodeLog: [...(plan?.neetcodeLog || [])],
    jobs: [...(plan?.jobs || [])],
    jobInbox: [...(plan?.jobInbox || [])],
    musicPlaylists: [...(plan?.musicPlaylists || [])],
    musicPlaylistState: [...(plan?.musicPlaylistState || [])]
  };
}

export function planSettings(data, plan) {
  return effectiveSettings(data, plan?.records?.settings);
}

function overrideFor(record) {
  if (!record || record.reset) return {};
  const values = {};
  for (const field of TASK_OVERRIDE_FIELDS) if (record[field] !== undefined) values[field] = record[field];
  return values;
}

// Anomaly-detection backlog tickets, such as "AN-002 (2/3): ...". The title sets
// their order and puts them first when spreading. Derived rather than saved, so
// sync and old records aren't involved.
function backlogMarks(title) {
  const ticket = /^AN-(\d+)(?: \((\d+)\/\d+\))?:/.exec(title);
  if (!ticket) return {};
  return { spreadFirst: true, sequences: [{ key: "backlog:anomaly-detection", step: Number(ticket[1]) * 100 + Number(ticket[2] || 1) }] };
}

export function applyOverlay(data, baseTasks, records = {}) {
  const replacedSlots = new Set(data.audit.sessions.map((session) => session.slot));
  const tasks = baseTasks.map((task) => {
    const merged = { ...task, plannedDate: task.date, ...overrideFor(records[`task:${task.id}`]) };
    return { ...merged, done: Boolean(merged.done), skipped: Boolean(merged.skipped), week: weekStartMonday(merged.date) };
  });
  // A repair session replaced a build block that may already have progress on
  // it. Keep that earlier block visible instead of silently dropping it.
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of baseTasks) {
    if (!task.replaced || !replacedSlots.has(task.slot)) continue;
    const record = records[`task:${task.slot}`];
    if (!record || record.reset || ids.has(task.slot)) continue;
    const { fixIds, replaced, sequences, ...rest } = task;
    const previous = { ...rest, ...replaced, id: task.slot, plannedDate: task.date, previousPlan: true };
    const merged = { ...previous, ...overrideFor(record) };
    tasks.push({ ...merged, done: Boolean(merged.done), skipped: Boolean(merged.skipped), week: weekStartMonday(merged.date) });
  }
  for (const [key, record] of Object.entries(records)) {
    if (!key.startsWith("custom:") || record?.deleted || !record?.title || !record?.date) continue;
    tasks.push({
      ...record,
      id: key,
      custom: true,
      plannedDate: record.plannedDate || record.date,
      slot: key,
      week: weekStartMonday(record.date),
      category: record.category || "Personal",
      minutes: Number(record.minutes) || 30,
      preferred: Number(record.preferred) || 960,
      detail: record.detail || "",
      doneWhen: record.doneWhen || "Task complete.",
      resources: record.resources || [],
      done: Boolean(record.done),
      skipped: Boolean(record.skipped),
      ...backlogMarks(record.title)
    });
  }
  return tasks;
}

// Memoized full task list. Keyed on the data object and a cheap signature of
// the records so repeated GETs don't regenerate 1,000 tasks.
const taskCache = new WeakMap();
export function planTasks(data, plan) {
  const settings = planSettings(data, plan);
  const signature = JSON.stringify(plan?.records || {});
  const cached = taskCache.get(data);
  if (cached && cached.signature === signature) return cached.tasks;
  const tasks = applyOverlay(data, generateBaseTasks(data, settings), plan?.records || {});
  taskCache.set(data, { signature, tasks });
  return tasks;
}

export function recordKeyForTask(taskId) {
  return String(taskId).startsWith("custom:") ? String(taskId) : `task:${taskId}`;
}

function timestamp(value = {}) {
  return Date.parse(value?.updatedAt || value?.endedAt || value?.startedAt || value?.at || 0) || 0;
}

function mergeById(local = [], shared = [], limit = Infinity) {
  const merged = new Map(local.filter((item) => item?.id).map((item) => [item.id, item]));
  for (const item of shared || []) {
    if (!item?.id) continue;
    const current = merged.get(item.id);
    if (!current || timestamp(item) > timestamp(current)) merged.set(item.id, item);
  }
  return [...merged.values()].sort((a, b) => timestamp(b) - timestamp(a)).slice(0, limit);
}

function singleActiveSession(sessions) {
  const active = sessions.filter((session) => session.status === "active");
  if (active.length < 2) return sessions;
  const keep = active.reduce((best, session) => (timestamp(session) > timestamp(best) ? session : best));
  return sessions.map((session) => {
    if (session.status !== "active" || session.id === keep.id) return session;
    const until = Date.parse(session.lastHeartbeatAt || session.startedAt || 0) || Date.parse(session.updatedAt) || 0;
    const since = Date.parse(session.runningSince || session.startedAt || 0) || until;
    return {
      ...session,
      status: "paused",
      accumulatedSeconds: Number(session.accumulatedSeconds || 0) + Math.max(0, Math.floor((until - since) / 1000)),
      runningSince: null,
      updatedAt: new Date(until).toISOString()
    };
  });
}

export function mergePlanState(local, shared) {
  if (!local && !shared) return undefined;
  const a = ensurePlanState(local);
  const b = ensurePlanState(shared);
  const records = { ...a.records };
  for (const [key, value] of Object.entries(b.records)) {
    if (!records[key] || timestamp(value) > timestamp(records[key])) records[key] = value;
  }
  const importedAt = [a.importedAt, b.importedAt].filter(Boolean).sort()[0] || null;
  return {
    ...a,
    importedAt,
    importSource: a.importSource || b.importSource || null,
    records,
    focusSessions: singleActiveSession(mergeById(a.focusSessions, b.focusSessions, 2000)),
    neetcodeLog: mergeById(a.neetcodeLog, b.neetcodeLog, 5000),
    jobs: mergeJobs(a.jobs, b.jobs),
    jobInbox: mergeInbox(a.jobInbox, b.jobInbox),
    // Deleted rules stay as tombstones so a device that still has them
    // doesn't bring them back.
    musicPlaylists: mergeById(a.musicPlaylists, b.musicPlaylists, 500),
    musicPlaylistState: mergeById(a.musicPlaylistState, b.musicPlaylistState, 500),
    legacyJobsImportedAt: [a.legacyJobsImportedAt, b.legacyJobsImportedAt].filter(Boolean).sort()[0] || null
  };
}
