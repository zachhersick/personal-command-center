// Synced playlist rules. They live in the plan so the phone can edit them and
// both the desktop and the cloud see the same list. What a sync last did is a
// separate record (musicPlaylistState), so a sync finishing on one device
// can't overwrite an edit made on another.
import { randomUUID } from "node:crypto";
import { httpError } from "../http.js";
import { cleanGenre } from "./query.js";

export const MAX_RULES = 50;
export const MAX_TOP_K = 500;
const HOUR_MS = 3_600_000;
const RETRY_AFTER_ERROR_MS = HOUR_MS;

export function playlistRules(plan) {
  return (plan.musicPlaylists || []).filter((rule) => rule?.id && !rule.deleted);
}

export function playlistState(plan, id) {
  return (plan.musicPlaylistState || []).find((state) => state?.id === id) || null;
}

function wholeNumber(value, min, max, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw httpError(400, `${label} must be a whole number from ${min} to ${max}.`);
  return number;
}

const DAY_TEXT = /^\d{4}-\d{2}-\d{2}$/;

// Fixed dates: { from, to } in ms (the browser's local midnights) plus the
// days as written, for display. null when the rule uses a rolling window.
function fixedRangeOf(value) {
  if (!value) return null;
  const from = Number(value.from);
  const to = Number(value.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw httpError(400, "Pick a start date before the end date.");
  if (!DAY_TEXT.test(String(value.fromDay || "")) || !DAY_TEXT.test(String(value.toDay || ""))) throw httpError(400, "Pick both dates.");
  return { from, to, fromDay: value.fromDay, toDay: value.toDay };
}

export function normalizeRule(body = {}, existing = null, now = new Date().toISOString()) {
  const name = String(body.name ?? existing?.name ?? "").trim().replace(/\s+/g, " ").slice(0, 100);
  if (!name) throw httpError(400, "Give the playlist a name.");
  const fixedRange = fixedRangeOf(body.fixedRange === undefined ? existing?.fixedRange : body.fixedRange);
  const windowDays = fixedRange ? null : body.windowDays === null || body.windowDays === "all" ? null : wholeNumber(body.windowDays ?? existing?.windowDays, 1, 36_500, "The period in days");
  // Fixed dates give the same list every time, so there's nothing to keep updated.
  const synced = fixedRange ? false : body.synced === undefined ? existing?.synced !== false : body.synced === true;
  const genre = cleanGenre(body.genre === undefined ? existing?.genre : body.genre);
  return {
    id: existing?.id || String(body.id || "") || `mp_${randomUUID().slice(0, 12)}`,
    name,
    topK: wholeNumber(body.topK ?? existing?.topK, 1, MAX_TOP_K, "The track count"),
    windowDays,
    ...(fixedRange ? { fixedRange } : {}),
    ...(genre ? { genre } : {}),
    synced,
    intervalHours: wholeNumber(body.intervalHours ?? existing?.intervalHours ?? 24, 1, 24 * 90, "The update interval in hours"),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

export function saveRule(plan, body, now) {
  const rules = plan.musicPlaylists || [];
  const existing = body.id ? rules.find((rule) => rule.id === body.id && !rule.deleted) : null;
  if (body.id && !existing) throw httpError(404, "That playlist rule no longer exists.");
  if (!existing && playlistRules(plan).length >= MAX_RULES) throw httpError(400, `Jarvis keeps at most ${MAX_RULES} synced playlists.`);
  const rule = normalizeRule(existing ? body : { ...body, id: undefined }, existing, now);
  return {
    plan: { ...plan, musicPlaylists: [...rules.filter((entry) => entry.id !== rule.id), rule] },
    result: { rule }
  };
}

// Deleting a rule never touches the Spotify playlist; it just stops syncing.
export function deleteRule(plan, id, now) {
  const rules = plan.musicPlaylists || [];
  if (!rules.some((rule) => rule.id === id && !rule.deleted)) throw httpError(404, "That playlist rule no longer exists.");
  return {
    plan: { ...plan, musicPlaylists: rules.map((rule) => (rule.id === id ? { id, deleted: true, updatedAt: now } : rule)) },
    result: { id }
  };
}

export function withRunState(plan, id, patch, now) {
  const states = plan.musicPlaylistState || [];
  const current = states.find((state) => state.id === id) || { id };
  return { ...plan, musicPlaylistState: [...states.filter((state) => state.id !== id), { ...current, ...patch, id, updatedAt: now }] };
}

// Due when it has never been built, the rule changed since the last build, or
// a synced rule's interval has passed. The slack lets an hourly tick that
// arrives a few minutes early still count, so a daily playlist doesn't slide
// an hour later every day.
export function isDue(rule, state, now) {
  if (!rule || rule.deleted) return false;
  const at = typeof now === "number" ? now : Date.parse(now);
  const attempted = Date.parse(state?.lastAttemptAt || 0) || 0;
  // A rate limit says when to try again; other errors wait an hour.
  const retryAt = state?.lastResult?.retryAt ? Date.parse(state.lastResult.retryAt) || 0 : 0;
  if (retryAt) {
    if (at < retryAt) return false;
  } else if (state?.lastResult?.ok === false && !state.lastResult.retrySoon && at - attempted < RETRY_AFTER_ERROR_MS) return false;
  const synced = Date.parse(state?.lastSyncedAt || 0) || 0;
  if (!synced) return true;
  if ((Date.parse(rule.updatedAt || 0) || 0) > synced) return true;
  if (!rule.synced) return false;
  const interval = rule.intervalHours * HOUR_MS;
  const slack = Math.min(15 * 60_000, interval * 0.05);
  return at - synced >= interval - slack;
}

export function nextSyncAt(rule, state) {
  if (!rule?.synced || !state?.lastSyncedAt) return null;
  return new Date(Date.parse(state.lastSyncedAt) + rule.intervalHours * HOUR_MS).toISOString();
}

export function describeWindow(windowDays) {
  if (!windowDays) return "all time";
  if (windowDays % 365 === 0) return windowDays === 365 ? "year" : `${windowDays / 365} years`;
  if (windowDays === 1) return "day";
  return `${windowDays} days`;
}

export function describePeriod(rule) {
  if (rule.fixedRange) return `${rule.fixedRange.fromDay} to ${rule.fixedRange.toDay}`;
  return rule.windowDays ? `the last ${describeWindow(rule.windowDays)}` : "all time";
}

export function describeInterval(hours) {
  if (hours % 24 === 0) return hours === 24 ? "day" : hours === 168 ? "week" : `${hours / 24} days`;
  return hours === 1 ? "hour" : `${hours} hours`;
}
