// NeetCode practice log. Each solved problem is recorded with how it went, so
// the Sunday "spaced review" can surface misses from 7 and 21 days ago.
import { randomUUID } from "node:crypto";
import { daysBetween, isDateKey } from "./dates.js";

export const NEETCODE_RESULTS = ["independent", "hinted", "studied"];
export const REVIEW_INTERVALS = [7, 21];
const GRACE_DAYS = 2;
const RESULT_RANK = { studied: 0, hinted: 1, independent: 2 };

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function liveEntries(log = []) {
  return log.filter((entry) => !entry.deleted);
}

export function addNeetcodeEntry(plan, input = {}, now) {
  const problem = String(input.problem || "").trim();
  if (!problem) throw badRequest("Problem name is required.");
  if (!NEETCODE_RESULTS.includes(input.result)) throw badRequest(`Result must be one of ${NEETCODE_RESULTS.join(", ")}.`);
  if (!isDateKey(input.date)) throw badRequest("date must be YYYY-MM-DD.");
  const url = String(input.url || "").trim();
  if (url && !/^https?:\/\//i.test(url)) throw badRequest("url must start with http:// or https://.");
  const entry = {
    id: randomUUID(),
    date: input.date,
    taskId: input.taskId ? String(input.taskId) : null,
    problem: problem.slice(0, 200),
    url: url.slice(0, 500),
    pattern: String(input.pattern || "").trim().slice(0, 120),
    result: input.result,
    minutes: Number.isFinite(Number(input.minutes)) ? Math.max(0, Math.min(600, Math.round(Number(input.minutes)))) : null,
    notes: String(input.notes || "").slice(0, 5000),
    reviewOf: input.reviewOf ? String(input.reviewOf) : null,
    interval: REVIEW_INTERVALS.includes(Number(input.interval)) ? Number(input.interval) : null,
    createdAt: now,
    updatedAt: now
  };
  return { plan: { ...plan, neetcodeLog: [entry, ...plan.neetcodeLog] }, entry };
}

export function deleteNeetcodeEntry(plan, id, now) {
  if (!plan.neetcodeLog.some((entry) => entry.id === id)) {
    const error = new Error("Log entry not found.");
    error.status = 404;
    throw error;
  }
  return {
    plan: { ...plan, neetcodeLog: plan.neetcodeLog.map((entry) => (entry.id === id ? { id, deleted: true, updatedAt: now } : entry)) },
    entry: { id, deleted: true }
  };
}

export function reviewCandidates(log, dateKey) {
  const entries = liveEntries(log);
  const reviewed = new Set(entries.filter((entry) => entry.reviewOf).map((entry) => `${entry.reviewOf}:${entry.interval}`));
  const candidates = [];
  for (const entry of entries) {
    if (entry.reviewOf) continue;
    const age = daysBetween(dateKey, entry.date);
    for (const interval of REVIEW_INTERVALS) {
      if (age < interval || age > interval + GRACE_DAYS) continue;
      if (reviewed.has(`${entry.id}:${interval}`)) continue;
      candidates.push({ entry, interval, age });
    }
  }
  return candidates.sort((a, b) => RESULT_RANK[a.entry.result] - RESULT_RANK[b.entry.result] || b.age - a.age);
}

export function neetcodeStats(log, dateKey) {
  const entries = liveEntries(log).filter((entry) => !entry.reviewOf);
  const counts = Object.fromEntries(NEETCODE_RESULTS.map((result) => [result, entries.filter((entry) => entry.result === result).length]));
  const days = new Set(liveEntries(log).map((entry) => entry.date));
  let streak = 0;
  let cursor = dateKey;
  if (!days.has(cursor)) cursor = new Date(Date.parse(`${cursor}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  while (days.has(cursor)) {
    streak += 1;
    cursor = new Date(Date.parse(`${cursor}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  }
  return { total: entries.length, counts, streakDays: streak };
}
