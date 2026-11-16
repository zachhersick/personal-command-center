// Pure job-pipeline logic. Jobs live in runtimeState.plan.jobs and sync with
// the rest of the plan, so every function here takes and returns plain data.
import { createHash } from "node:crypto";

export const STAGES = ["saved", "applied", "assessment", "screen", "interview", "offer", "rejected", "withdrawn"];
export const OPEN_STAGES = ["saved", "applied", "assessment", "screen", "interview", "offer"];
export const CLOSED_STAGES = ["rejected", "withdrawn"];
export const SOURCES = ["linkedin", "runway", "ats", "bookmark", "manual", "import", "email"];
// Event kinds an email or the user can add. Stage kinds double as stages.
export const EVENT_KINDS = ["applied", "viewed", "assessment", "screen", "interview", "offer", "rejected", "withdrawn", "followed_up", "note", "stage", "imported"];
// Stages reached only when a person at the company took a step.
export const HUMAN_STAGES = ["screen", "interview", "offer"];

export const FOLLOW_UP_DAYS = 14;
// Past this, a follow-up is unlikely to help; the job just shows as ghosted.
export const FOLLOW_UP_WINDOW_DAYS = 45;
export const GHOSTED_DAYS = 30;
export const COHORT_SIZE = 30;
const MAX_EVENTS = 100;
const MAX_JOBS = 2000;
const MAX_INBOX = 300;

const RANK = { saved: 0, applied: 1, assessment: 2, screen: 3, interview: 4, offer: 5 };

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const LEGAL_SUFFIX = /\b(incorporated|inc|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|gmbh|holdings)\b\.?/g;

export function normalizeCompany(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/^the\s+/, "")
    .replace(LEGAL_SUFFIX, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeRole(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\((remote|hybrid|on-?site)[^)]*\)/g, " ")
    .replace(/\b(req|job)\s*(id)?\s*[#:]?\s*[a-z]?\d{4,}\b/g, " ")
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim();
}

// Same company and role on any device gives the same id, so two desktops that
// read the same email update one record instead of creating two.
export function jobId(company, role) {
  const key = `${normalizeCompany(company)}|${normalizeRole(role)}`;
  return `job:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function timestamp(value) {
  return Date.parse(value?.updatedAt || value?.at || 0) || 0;
}

function eventTime(event) {
  return Date.parse(event?.at || 0) || 0;
}

export function sortEvents(events = []) {
  return [...events].sort((a, b) => eventTime(a) - eventTime(b)).slice(-MAX_EVENTS);
}

function unionEvents(a = [], b = []) {
  const byId = new Map();
  for (const event of [...a, ...b]) if (event?.id && !byId.has(event.id)) byId.set(event.id, event);
  return sortEvents([...byId.values()]);
}

// Newer record wins its fields; the timelines are combined so an email seen on
// one device and a note added on another both survive.
export function mergeJobs(local = [], shared = []) {
  const merged = new Map();
  for (const job of [...(local || []), ...(shared || [])]) {
    if (!job?.id) continue;
    const current = merged.get(job.id);
    if (!current) {
      merged.set(job.id, job);
      continue;
    }
    const [older, newer] = timestamp(job) > timestamp(current) ? [current, job] : [job, current];
    merged.set(job.id, { ...older, ...newer, events: unionEvents(older.events, newer.events) });
  }
  return [...merged.values()].sort((a, b) => timestamp(b) - timestamp(a)).slice(0, MAX_JOBS);
}

export function mergeInbox(local = [], shared = []) {
  const merged = new Map();
  for (const item of [...(local || []), ...(shared || [])]) {
    if (!item?.id) continue;
    const current = merged.get(item.id);
    if (!current || timestamp(item) > timestamp(current)) merged.set(item.id, item);
  }
  return [...merged.values()].sort((a, b) => timestamp(b) - timestamp(a)).slice(0, MAX_INBOX);
}

export function liveJobs(plan) {
  return (plan?.jobs || []).filter((job) => !job.deleted);
}

// Automatic updates only move a job forward. A late "thanks for applying"
// must not undo an interview, and nothing reopens a withdrawn application.
export function advanceStage(current, incoming) {
  if (!STAGES.includes(incoming)) return current;
  if (current === "withdrawn") return current;
  if (incoming === "rejected") return current === "offer" ? current : "rejected";
  if (CLOSED_STAGES.includes(current)) return current;
  return (RANK[incoming] ?? -1) > (RANK[current] ?? -1) ? incoming : current;
}

export function addEvent(job, event) {
  const events = job.events || [];
  if (event.messageId && events.some((item) => item.messageId === event.messageId)) return job;
  if (events.some((item) => item.id === event.id)) return job;
  return { ...job, events: sortEvents([...events, event]) };
}

const TEXT_LIMITS = { company: 120, role: 200, location: 200, url: 2000, notes: 20000, nextAction: 300 };

export function cleanJobInput(input = {}) {
  const out = {};
  for (const [field, limit] of Object.entries(TEXT_LIMITS)) {
    if (input[field] === undefined) continue;
    if (input[field] !== null && typeof input[field] !== "string") throw fail(400, `${field} must be text.`);
    out[field] = String(input[field] ?? "").trim().slice(0, limit);
  }
  if (out.url && !/^https?:\/\//i.test(out.url)) throw fail(400, "url must start with http:// or https://.");
  if (input.stage !== undefined) {
    if (!STAGES.includes(input.stage)) throw fail(400, `stage must be one of ${STAGES.join(", ")}.`);
    out.stage = input.stage;
  }
  if (input.source !== undefined) {
    if (!SOURCES.includes(input.source)) throw fail(400, `source must be one of ${SOURCES.join(", ")}.`);
    out.source = input.source;
  }
  for (const field of ["appliedAt", "nextActionDate"]) {
    if (input[field] === undefined) continue;
    if (input[field] === null || input[field] === "") out[field] = null;
    else if (Number.isNaN(Date.parse(input[field]))) throw fail(400, `${field} must be a date.`);
    else out[field] = String(input[field]).slice(0, 40);
  }
  return out;
}

function eventId(prefix, now) {
  return `${prefix}:${Date.parse(now) || Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

// Add a job or edit one. A new job needs a company; the id comes from company
// and role unless the caller is editing an existing record.
export function upsertJob(plan, input = {}, now) {
  const patch = cleanJobInput(input);
  const jobs = plan.jobs || [];
  const existingId = input.id ? String(input.id) : null;
  if (existingId) {
    const current = jobs.find((job) => job.id === existingId && !job.deleted);
    if (!current) throw fail(404, "Job not found.");
    let next = { ...current, ...patch, updatedAt: now };
    if (patch.stage && patch.stage !== current.stage) {
      next = addEvent(next, { id: eventId("stage", now), at: now, kind: "stage", source: "manual", stage: patch.stage });
      next.lastActivityAt = now;
    }
    return { plan: { ...plan, jobs: jobs.map((job) => (job.id === existingId ? next : job)) }, result: { job: next, created: false } };
  }
  if (!patch.company) throw fail(400, "A job needs a company.");
  const id = jobId(patch.company, patch.role);
  const current = jobs.find((job) => job.id === id && !job.deleted);
  const stage = patch.stage || "applied";
  const appliedAt = patch.appliedAt || (stage === "saved" ? null : now);
  if (current) {
    // Logging the same job twice (bookmark after email) fills gaps only.
    const filled = Object.fromEntries(Object.entries(patch).filter(([key, value]) => value && !current[key]));
    const next = { ...current, ...filled, stage: advanceStage(current.stage, stage), updatedAt: now };
    return { plan: { ...plan, jobs: jobs.map((job) => (job.id === id ? next : job)) }, result: { job: next, created: false } };
  }
  const job = {
    id,
    company: patch.company,
    role: patch.role || "",
    location: patch.location || "",
    url: patch.url || "",
    source: patch.source || "manual",
    stage,
    appliedAt,
    lastActivityAt: appliedAt || now,
    nextAction: patch.nextAction || "",
    nextActionDate: patch.nextActionDate || null,
    notes: patch.notes || "",
    events: stage === "saved" ? [] : [{ id: eventId("applied", now), at: appliedAt || now, kind: "applied", source: patch.source || "manual" }],
    createdAt: now,
    updatedAt: now
  };
  const others = jobs.filter((item) => item.id !== id);
  return { plan: { ...plan, jobs: [job, ...others] }, result: { job, created: true } };
}

export function addJobEvent(plan, { id, kind, note } = {}, now) {
  if (!["followed_up", "note"].includes(kind)) throw fail(400, "kind must be followed_up or note.");
  const jobs = plan.jobs || [];
  const current = jobs.find((job) => job.id === id && !job.deleted);
  if (!current) throw fail(404, "Job not found.");
  const event = { id: eventId(kind, now), at: now, kind, source: "manual", ...(note ? { note: String(note).slice(0, 2000) } : {}) };
  const next = { ...addEvent(current, event), lastActivityAt: kind === "followed_up" ? now : current.lastActivityAt, updatedAt: now };
  return { plan: { ...plan, jobs: jobs.map((job) => (job.id === id ? next : job)) }, result: { job: next } };
}

export function deleteJob(plan, { id } = {}, now) {
  const jobs = plan.jobs || [];
  if (!jobs.some((job) => job.id === id && !job.deleted)) throw fail(404, "Job not found.");
  return { plan: { ...plan, jobs: jobs.map((job) => (job.id === id ? { id, deleted: true, updatedAt: now } : job)) }, result: { id } };
}

// ---- reading the pipeline ----

function daysSince(iso, now) {
  const then = Date.parse(iso || 0);
  if (!then) return null;
  return Math.floor((Date.parse(now) - then) / 86_400_000);
}

const REPLY_KINDS = new Set(["assessment", "screen", "interview", "offer", "rejected"]);

export function hasReply(job) {
  return (job.events || []).some((event) => REPLY_KINDS.has(event.kind) && event.source !== "manual") || !["saved", "applied"].includes(job.stage);
}

export function isGhosted(job, now) {
  if (job.stage !== "applied" || hasReply(job)) return false;
  const quiet = daysSince(job.lastActivityAt || job.appliedAt, now);
  // Imported from the old Jarvis with no date and nothing since: long quiet.
  if (quiet === null) return (job.events || []).every((event) => event.kind === "imported");
  return quiet >= GHOSTED_DAYS;
}

export function jobView(job, now) {
  return {
    ...job,
    ageDays: daysSince(job.appliedAt, now),
    quietDays: daysSince(job.lastActivityAt || job.appliedAt, now),
    ghosted: isGhosted(job, now)
  };
}

// Applied two weeks ago, nothing back, and no follow-up in the last two weeks.
export function followUpsDue(jobs, now) {
  return jobs
    .filter((job) => job.stage === "applied" && !hasReply(job) && !isGhosted(job, now))
    .filter((job) => {
      const age = daysSince(job.appliedAt, now) ?? 0;
      return age >= FOLLOW_UP_DAYS && age <= FOLLOW_UP_WINDOW_DAYS;
    })
    .filter((job) => {
      const last = [...(job.events || [])].reverse().find((event) => event.kind === "followed_up");
      return !last || daysSince(last.at, now) >= FOLLOW_UP_DAYS;
    })
    .filter((job) => !job.nextActionDate || Date.parse(job.nextActionDate) <= Date.parse(now))
    .sort((a, b) => Date.parse(a.appliedAt || 0) - Date.parse(b.appliedAt || 0));
}

// toDateKey turns an ISO time into the planner's local YYYY-MM-DD; weekStart is
// that week's Monday. Kept as parameters so this file stays free of time zones.
// Imported from the old Jarvis and never heard about since: replies were not
// tracked for these, so they can't count toward response rate or screens.
export function untracked(job) {
  const events = job.events || [];
  return events.length > 0 && events.every((event) => event.kind === "imported");
}

export function jobMetrics(jobs, { now, weekStart, toDateKey, weeklyTarget = 10 }) {
  const applied = jobs.filter((job) => job.appliedAt && job.stage !== "saved");
  const appliedThisWeek = applied.filter((job) => toDateKey(job.appliedAt) >= weekStart).length;
  const matured = applied.filter((job) => !untracked(job) && (daysSince(job.appliedAt, now) ?? 0) >= FOLLOW_UP_DAYS);
  const replied = matured.filter(hasReply).length;
  const byStage = Object.fromEntries(STAGES.map((stage) => [stage, 0]));
  for (const job of jobs) byStage[job.stage] = (byStage[job.stage] || 0) + 1;

  // The career kit's rule: look at applications at least 14 days old in groups
  // of 30; fewer than two human screens in a group means rethink targeting.
  const ordered = [...matured].sort((a, b) => Date.parse(a.appliedAt) - Date.parse(b.appliedAt));
  const fullCohorts = Math.floor(ordered.length / COHORT_SIZE);
  let cohort = null;
  if (fullCohorts) {
    const members = ordered.slice((fullCohorts - 1) * COHORT_SIZE, fullCohorts * COHORT_SIZE);
    const screens = members.filter((job) => HUMAN_STAGES.includes(job.stage) || (job.events || []).some((event) => HUMAN_STAGES.includes(event.kind))).length;
    cohort = { number: fullCohorts, size: COHORT_SIZE, screens, needsReview: screens < 2 };
  }
  return {
    total: jobs.length,
    applied: applied.length,
    appliedThisWeek,
    weeklyTarget,
    responseRate: matured.length ? Math.round((replied / matured.length) * 100) : null,
    matured: matured.length,
    active: jobs.filter((job) => ["screen", "interview"].includes(job.stage)).length,
    offers: byStage.offer,
    byStage,
    ghosted: jobs.filter((job) => isGhosted(job, now)).length,
    cohort,
    nextCohortIn: COHORT_SIZE - (ordered.length % COHORT_SIZE)
  };
}
