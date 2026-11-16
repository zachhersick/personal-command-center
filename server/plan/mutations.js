// Pure plan mutations: (plan, command, now) -> { plan, result }. They never
// touch disk; routes.js runs them inside the runtime-state mutation queue.
import { createHash, randomUUID } from "node:crypto";
import { addDays, getLocalDateKey, isDateKey, localMinutes, weekStartMonday } from "./dates.js";
import { CATEGORIES } from "./generator.js";
import { planSettings, planTasks, recordKeyForTask } from "./state.js";
import { rebalance, spreadCarried } from "./scheduler.js";
import { activeSession } from "./focus.js";

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function findTask(data, plan, id) {
  const task = planTasks(data, plan).find((entry) => entry.id === id);
  if (!task) throw fail(404, `Task ${id} was not found.`);
  return task;
}

const TEXT_LIMITS = { title: 200, detail: 8000, notes: 20000, evidenceUrl: 2000 };

export function validateTaskPatch(input = {}) {
  const patch = {};
  for (const field of ["done", "skipped"]) {
    if (input[field] === undefined) continue;
    if (typeof input[field] !== "boolean") throw fail(400, `${field} must be true or false.`);
    patch[field] = input[field];
  }
  if (input.date !== undefined) {
    if (!isDateKey(input.date)) throw fail(400, "date must be YYYY-MM-DD.");
    patch.date = input.date;
  }
  if (input.minutes !== undefined) {
    const minutes = Number(input.minutes);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 600) throw fail(400, "minutes must be a whole number from 5 to 600.");
    patch.minutes = minutes;
  }
  if (input.pinnedStart !== undefined) {
    if (input.pinnedStart === null) patch.pinnedStart = null;
    else {
      const start = Number(input.pinnedStart);
      if (!Number.isInteger(start) || start < 0 || start > 1435 || start % 5) throw fail(400, "pinnedStart must be minutes after midnight on a 5-minute grid.");
      patch.pinnedStart = start;
    }
  }
  for (const [field, limit] of Object.entries(TEXT_LIMITS)) {
    if (input[field] === undefined) continue;
    if (typeof input[field] !== "string") throw fail(400, `${field} must be text.`);
    patch[field] = input[field].slice(0, limit);
  }
  if (patch.title !== undefined && !patch.title.trim()) throw fail(400, "title cannot be empty.");
  if (patch.evidenceUrl && !/^https?:\/\//i.test(patch.evidenceUrl)) throw fail(400, "evidenceUrl must start with http:// or https://.");
  return patch;
}

function writeTaskRecord(plan, task, patch, now) {
  const key = recordKeyForTask(task.id);
  const existing = plan.records[key] && !plan.records[key].reset ? plan.records[key] : {};
  const next = { ...existing, ...patch, updatedAt: now };
  if (patch.done === true && !existing.done) next.completedAt = now;
  if (patch.done === false) next.completedAt = null;
  if (patch.pinnedStart === null) delete next.pinnedStart;
  if (patch.date && patch.date !== existing.date && patch.pinnedStart === undefined) delete next.pinnedStart;
  if (["date", "pinnedStart", "minutes"].some((field) => patch[field] !== undefined) || (patch.done === false && existing.timelineReleased)) {
    next.schedulePlacement = null;
    next.timelineReleased = false;
  }
  // Planner reservations are server-owned and are never accepted by validateTaskPatch.
  if (patch.schedulePlacement !== undefined) next.schedulePlacement = patch.schedulePlacement;
  if (patch.timelineReleased !== undefined) next.timelineReleased = patch.timelineReleased;
  return { ...plan, records: { ...plan.records, [key]: next } };
}

export function patchTask(data, plan, input, now) {
  const task = findTask(data, plan, String(input.id || ""));
  const patch = validateTaskPatch(input);
  if (!Object.keys(patch).length) throw fail(400, "Nothing to change.");
  const next = writeTaskRecord(plan, task, patch, now);
  return { plan: next, result: { id: task.id } };
}

export function resetTask(data, plan, { id } = {}, now) {
  const task = findTask(data, plan, String(id || ""));
  if (task.custom) throw fail(400, "Custom tasks can be edited or deleted, not reset.");
  return { plan: { ...plan, records: { ...plan.records, [`task:${task.id}`]: { reset: true, updatedAt: now } } }, result: { id: task.id } };
}

export function addCustomTask(plan, input = {}, now) {
  const title = String(input.title || "").trim();
  if (!title) throw fail(400, "A task needs a title.");
  if (!isDateKey(input.date)) throw fail(400, "date must be YYYY-MM-DD.");
  const category = input.category || "Personal";
  if (!CATEGORIES.includes(category)) throw fail(400, `category must be one of ${CATEGORIES.join(", ")}.`);
  const minutes = input.minutes === undefined ? 30 : Number(input.minutes);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 600) throw fail(400, "minutes must be a whole number from 5 to 600.");
  const id = `custom:${randomUUID()}`;
  const record = {
    title: title.slice(0, 200),
    date: input.date,
    plannedDate: input.date,
    category,
    minutes,
    detail: String(input.detail || "").slice(0, 8000),
    doneWhen: String(input.doneWhen || "").slice(0, 2000) || "Task complete.",
    preferred: Number.isInteger(input.preferred) ? input.preferred : 960,
    createdAt: now,
    updatedAt: now
  };
  return { plan: { ...plan, records: { ...plan.records, [id]: record } }, result: { id } };
}

export function deleteCustomTask(plan, { id } = {}, now) {
  if (!String(id || "").startsWith("custom:") || !plan.records[id] || plan.records[id].deleted) throw fail(404, "Custom task not found.");
  return { plan: { ...plan, records: { ...plan.records, [id]: { deleted: true, updatedAt: now } } }, result: { id } };
}

function validMinute(value, label) {
  const minute = Number(value);
  if (!Number.isInteger(minute) || minute < 0 || minute > 1440) throw fail(400, `${label} must be minutes from 0 to 1440.`);
  return minute;
}

export function validateSettings(input = {}) {
  const next = {};
  if (input.classMode !== undefined) {
    if (typeof input.classMode !== "boolean") throw fail(400, "classMode must be true or false.");
    next.classMode = input.classMode;
  }
  if (input.gymConfirmed !== undefined) {
    if (typeof input.gymConfirmed !== "boolean") throw fail(400, "gymConfirmed must be true or false.");
    next.gymConfirmed = input.gymConfirmed;
  }
  if (input.classTimes !== undefined) {
    if (!Array.isArray(input.classTimes) || input.classTimes.length !== 7) throw fail(400, "classTimes needs one list per weekday.");
    next.classTimes = input.classTimes.map((day, index) => {
      if (!Array.isArray(day) || day.length % 2) throw fail(400, `classTimes[${index}] needs start/end pairs.`);
      const minutes = day.map((value) => validMinute(value, "Class times"));
      for (let i = 0; i < minutes.length; i += 2) if (minutes[i] >= minutes[i + 1]) throw fail(400, "Each class must end after it starts.");
      return minutes;
    });
  }
  for (const field of ["dayStart", "dayEnd", "weekendGym"]) if (input[field] !== undefined) next[field] = validMinute(input[field], field);
  if (input.capstoneMinutes !== undefined) {
    const minutes = Number(input.capstoneMinutes);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1200) throw fail(400, "capstoneMinutes must be 0 to 1200.");
    next.capstoneMinutes = minutes;
  }
  if (input.gymPhase !== undefined) {
    const phase = Number(input.gymPhase);
    if (!Number.isInteger(phase) || phase < 0 || phase > 3) throw fail(400, "gymPhase must be 0 to 3.");
    next.gymPhase = phase;
  }
  if (input.gymAnchor !== undefined) {
    if (!isDateKey(input.gymAnchor)) throw fail(400, "gymAnchor must be YYYY-MM-DD.");
    next.gymAnchor = input.gymAnchor;
  }
  if (input.breakWeeks !== undefined) {
    if (!Array.isArray(input.breakWeeks) || !input.breakWeeks.every(isDateKey)) throw fail(400, "breakWeeks must be a list of dates.");
    next.breakWeeks = [...new Set(input.breakWeeks.map(weekStartMonday))].sort();
  }
  return next;
}

export function updateSettings(data, plan, input, now) {
  const patch = validateSettings(input);
  const merged = { ...planSettings(data, plan), ...patch };
  if (merged.dayStart >= merged.dayEnd) throw fail(400, "Your day must end after it starts.");
  const { updatedAt, ...current } = plan.records.settings || {};
  return { plan: { ...plan, records: { ...plan.records, settings: { ...current, ...patch, updatedAt: now } } }, result: { settings: merged } };
}

export const TRIAGE_ACTIONS = ["rebalance", "move", "skip", "done", "unskip"];

export function triage(data, plan, input = {}, { now, todayKey, timeZone = "UTC" }) {
  const action = input.action;
  if (!TRIAGE_ACTIONS.includes(action)) throw fail(400, `action must be one of ${TRIAGE_ACTIONS.join(", ")}.`);
  const all = planTasks(data, plan);
  const byId = new Map(all.map((task) => [task.id, task]));
  const ids = Array.isArray(input.ids) ? [...new Set(input.ids.map(String))] : null;
  const selected = ids
    ? ids.map((id) => {
      const task = byId.get(id);
      if (!task && input.reclaimCompleted === true) return null;
      if (!task) throw fail(404, `Task ${id} was not found.`);
      return task;
    }).filter(Boolean)
    : all.filter((task) => task.date < todayKey && !task.done && !task.skipped);
  if (selected.length > 500) throw fail(400, "Too many tasks in one request.");

  let next = plan;
  let result;
  if (action === "rebalance") {
    if (input.reclaimCompleted !== undefined && typeof input.reclaimCompleted !== "boolean") throw fail(400, "reclaimCompleted must be true or false.");
    if (input.reclaimCompleted) {
      const date = new Date(now);
      todayKey = getLocalDateKey(date, timeZone);
      const days = Math.max(1, Math.min(7, Math.floor(Number(input.days) || 7)));
      const pending = selected.filter((task) => !task.done && !task.skipped);
      const settings = planSettings(data, plan);
      const activeTaskId = activeSession(plan)?.taskId;
      const outcome = spreadCarried({ tasks: pending, allTasks: all, settings, from: todayKey, days, todayKey, nowMinutes: localMinutes(date, timeZone) + date.getUTCSeconds() / 60 + date.getUTCMilliseconds() / 60000, activeTaskId });
      const previewToken = createHash("sha256").update(JSON.stringify({ all, settings, activeTaskId, from: todayKey, days, ids: selected.map((task) => task.id), outcome })).digest("hex");
      result = { action, from: todayKey, to: addDays(todayKey, days - 1), ids: selected.map((task) => task.id), days, ...outcome, previewToken };
      if (input.dryRun) return { plan, result: { ...result, dryRun: true } };
      if (!input.previewToken) throw fail(400, "Preview the spread before applying it.");
      if (input.previewToken !== previewToken) return { plan, result: { ...result, stale: true, dryRun: true } };
      for (const move of outcome.moves) next = writeTaskRecord(next, byId.get(move.id), { date: move.to, pinnedStart: null }, now);
      for (const { id, ...placement } of outcome.placements) next = writeTaskRecord(next, byId.get(id), { schedulePlacement: placement }, now);
      for (const { id, ...placement } of outcome.reclaimed) next = writeTaskRecord(next, byId.get(id), { schedulePlacement: placement, timelineReleased: true }, now);
      return { plan: next, result: { ...result, dryRun: false } };
    }
    const from = isDateKey(input.from) ? input.from : todayKey;
    const days = Math.max(1, Math.min(28, Number(input.days) || 7));
    const pending = selected.filter((task) => !task.done && !task.skipped);
    const outcome = rebalance({ tasks: pending, allTasks: all, settings: planSettings(data, next), from, days, todayKey, activeTaskId: activeSession(plan)?.taskId });
    for (const move of outcome.moves) next = writeTaskRecord(next, byId.get(move.id), { date: move.to }, now);
    result = { action, from, to: addDays(from, days - 1), ...outcome };
  } else if (action === "move") {
    if (!isDateKey(input.date)) throw fail(400, "date must be YYYY-MM-DD.");
    for (const task of selected) next = writeTaskRecord(next, task, { date: input.date }, now);
    result = { action, moves: selected.map((task) => ({ id: task.id, from: task.date, to: input.date })) };
  } else {
    const patch = action === "done" ? { done: true } : { skipped: action === "skip" };
    for (const task of selected) next = writeTaskRecord(next, task, patch, now);
    result = { action, ids: selected.map((task) => task.id) };
  }
  return { plan: input.dryRun ? plan : next, result: { ...result, dryRun: Boolean(input.dryRun) } };
}
