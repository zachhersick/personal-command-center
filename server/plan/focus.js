// Focus sessions. Time is accounted on the server: a running session stores
// runningSince and accumulatedSeconds, and the renderer sends heartbeats. If
// the heartbeats stop (app closed, machine asleep) the session is treated as
// paused at the last heartbeat so time never accrues while nobody is there.
import { randomUUID } from "node:crypto";
import { recordKeyForTask } from "./state.js";

export const HEARTBEAT_STALE_MS = 3 * 60 * 1000;
export const FOCUS_MODES = ["countdown", "pomodoro", "stopwatch"];
// A meal timer is still a session, but it isn't deep work, so it doesn't count
// toward focused time or the streak. Sessions saved before this are "work".
export const FOCUS_KINDS = ["work", "break"];
const isWork = (session) => (session.kind || "work") !== "break";

function ms(value) {
  return Date.parse(value || 0) || 0;
}

function runningUntil(session, now) {
  const heartbeat = ms(session.lastHeartbeatAt || session.runningSince);
  const current = ms(now);
  return current - heartbeat > HEARTBEAT_STALE_MS ? heartbeat : current;
}

export function sessionElapsedSeconds(session, now = new Date().toISOString()) {
  const base = Number(session.accumulatedSeconds || 0);
  if (session.status !== "active" || !session.runningSince) return base;
  return base + Math.max(0, Math.floor((runningUntil(session, now) - ms(session.runningSince)) / 1000));
}

export function isStale(session, now) {
  return session.status === "active" && ms(now) - ms(session.lastHeartbeatAt || session.runningSince) > HEARTBEAT_STALE_MS;
}

function pauseSession(session, now) {
  if (session.status !== "active") return session;
  const until = new Date(runningUntil(session, now)).toISOString();
  return {
    ...session,
    status: "paused",
    accumulatedSeconds: sessionElapsedSeconds(session, now),
    runningSince: null,
    pausedAt: until,
    updatedAt: now
  };
}

export function activeSession(plan) {
  return plan.focusSessions.find((session) => session.status === "active" || session.status === "paused") || null;
}

export function reconcileFocus(plan, now) {
  let changed = false;
  const focusSessions = plan.focusSessions.map((session) => {
    if (!isStale(session, now)) return session;
    changed = true;
    return { ...pauseSession(session, now), autoPaused: true };
  });
  return { plan: changed ? { ...plan, focusSessions } : plan, changed };
}

function replaceSession(plan, next) {
  return { ...plan, focusSessions: plan.focusSessions.map((session) => (session.id === next.id ? next : session)) };
}

function creditTask(plan, taskId, seconds, now, extra = {}) {
  if (!taskId) return plan;
  const key = recordKeyForTask(taskId);
  const existing = plan.records[key] && !plan.records[key].reset ? plan.records[key] : {};
  return {
    ...plan,
    records: {
      ...plan.records,
      [key]: {
        ...existing,
        accumulatedSeconds: Number(existing.accumulatedSeconds || 0) + Math.max(0, seconds),
        lastFocusedAt: now,
        ...extra,
        updatedAt: now
      }
    }
  };
}

function requireOpenSession(plan) {
  const session = activeSession(plan);
  if (!session) {
    const error = new Error("No focus session is running.");
    error.status = 409;
    throw error;
  }
  return session;
}

export function startFocus(plan, { taskId = null, plannedMinutes = 50, mode = "countdown", label = "", kind = "work" } = {}, now) {
  if (!FOCUS_KINDS.includes(kind)) {
    const error = new Error(`Focus kind must be one of ${FOCUS_KINDS.join(", ")}.`);
    error.status = 400;
    throw error;
  }
  if (!FOCUS_MODES.includes(mode)) {
    const error = new Error(`Focus mode must be one of ${FOCUS_MODES.join(", ")}.`);
    error.status = 400;
    throw error;
  }
  const minutes = Number(plannedMinutes);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 600) {
    const error = new Error("plannedMinutes must be between 1 and 600.");
    error.status = 400;
    throw error;
  }
  let next = plan;
  const open = activeSession(plan);
  if (open && open.taskId === taskId && open.status === "paused") {
    const resumed = { ...open, status: "active", runningSince: now, lastHeartbeatAt: now, plannedMinutes: minutes, mode, updatedAt: now };
    return { plan: replaceSession(plan, resumed), session: resumed };
  }
  if (open) next = finishSession(plan, open, now, { reason: "switched" }).plan;
  const session = {
    id: randomUUID(),
    taskId,
    label: String(label || "").slice(0, 200),
    kind,
    mode,
    plannedMinutes: minutes,
    status: "active",
    startedAt: now,
    runningSince: now,
    lastHeartbeatAt: now,
    accumulatedSeconds: 0,
    notes: "",
    updatedAt: now
  };
  return { plan: { ...next, focusSessions: [session, ...next.focusSessions].slice(0, 2000) }, session };
}

export function pauseFocus(plan, now) {
  const session = requireOpenSession(plan);
  const paused = pauseSession(session, now);
  return { plan: replaceSession(plan, paused), session: paused };
}

export function resumeFocus(plan, now) {
  const session = requireOpenSession(plan);
  if (session.status === "active") return { plan, session };
  const resumed = { ...session, status: "active", runningSince: now, lastHeartbeatAt: now, autoPaused: false, updatedAt: now };
  return { plan: replaceSession(plan, resumed), session: resumed };
}

export function heartbeatFocus(plan, now) {
  const session = activeSession(plan);
  if (!session || session.status !== "active") return { plan, session };
  // A heartbeat after a long gap means the session was effectively paused;
  // bank the time up to the last heartbeat and restart the clock now.
  const next = isStale(session, now)
    ? { ...pauseSession(session, now), status: "active", runningSince: now, lastHeartbeatAt: now, updatedAt: now }
    : { ...session, lastHeartbeatAt: now };
  return { plan: replaceSession(plan, next), session: next };
}

export function extendFocus(plan, minutes, now) {
  const session = requireOpenSession(plan);
  const add = Number(minutes);
  if (!Number.isInteger(add) || add < 1 || add > 240) {
    const error = new Error("Extend by 1 to 240 minutes.");
    error.status = 400;
    throw error;
  }
  const next = { ...session, plannedMinutes: Math.min(600, Number(session.plannedMinutes || 0) + add), updatedAt: now };
  return { plan: replaceSession(plan, next), session: next };
}

export function noteFocus(plan, notes, now) {
  const session = requireOpenSession(plan);
  const next = { ...session, notes: String(notes || "").slice(0, 20000), updatedAt: now };
  return { plan: replaceSession(plan, next), session: next };
}

function finishSession(plan, session, now, { markDone = false, earlyExit = null, reason = "completed" } = {}) {
  const seconds = sessionElapsedSeconds(session, now);
  const ended = {
    ...session,
    status: earlyExit ? "exited" : "completed",
    endReason: reason,
    accumulatedSeconds: seconds,
    runningSince: null,
    endedAt: now,
    earlyExit,
    updatedAt: now
  };
  let next = replaceSession(plan, ended);
  const extra = markDone ? { done: true, completedAt: now } : {};
  if (session.notes && session.taskId) {
    const key = recordKeyForTask(session.taskId);
    const existingNotes = next.records[key]?.notes || "";
    if (!existingNotes.includes(session.notes)) extra.notes = existingNotes ? `${existingNotes}\n\n${session.notes}` : session.notes;
  }
  next = creditTask(next, session.taskId, seconds, now, extra);
  return { plan: next, session: ended };
}

export function stopFocus(plan, { markDone = false } = {}, now) {
  const session = requireOpenSession(plan);
  return finishSession(plan, session, now, { markDone, reason: markDone ? "done" : "completed" });
}

export function exitFocusEarly(plan, { reason = "", heldMs = 0, source = "hold-escape" } = {}, now) {
  const session = activeSession(plan);
  if (!session) return { plan, session: null };
  const seconds = sessionElapsedSeconds(session, now);
  const earlyExit = {
    at: now,
    reason: String(reason || "").slice(0, 500),
    heldMs: Number(heldMs) || 0,
    source: String(source || "hold-escape").slice(0, 40),
    remainingSeconds: Math.max(0, Math.round(Number(session.plannedMinutes || 0) * 60 - seconds))
  };
  return finishSession(plan, session, now, { earlyExit, reason: "early-exit" });
}

export function focusView(plan, now, dateKeyOf) {
  const session = activeSession(plan);
  const todayKey = dateKeyOf(now);
  const sessions = plan.focusSessions.filter((entry) => entry.startedAt);
  const todaySessions = sessions.filter((entry) => dateKeyOf(entry.startedAt) === todayKey);
  const secondsToday = todaySessions.filter(isWork).reduce((total, entry) => total + sessionElapsedSeconds(entry, now), 0);
  const breakSecondsToday = todaySessions.filter((entry) => !isWork(entry)).reduce((total, entry) => total + sessionElapsedSeconds(entry, now), 0);
  const days = new Set(sessions.filter((entry) => isWork(entry) && sessionElapsedSeconds(entry, now) >= 600).map((entry) => dateKeyOf(entry.startedAt)));
  // Consecutive days with at least 10 focused minutes. Today only counts once
  // it qualifies, so the streak doesn't reset first thing in the morning.
  const dayKeyAt = (time) => dateKeyOf(new Date(time).toISOString());
  let cursor = ms(now);
  if (!days.has(dayKeyAt(cursor))) cursor -= 86_400_000;
  let streak = 0;
  while (days.has(dayKeyAt(cursor))) {
    streak += 1;
    cursor -= 86_400_000;
  }
  return {
    session: session ? { ...session, elapsedSeconds: sessionElapsedSeconds(session, now), stale: isStale(session, now) } : null,
    today: {
      sessions: todaySessions.filter(isWork).length,
      seconds: secondsToday,
      breakSeconds: breakSecondsToday,
      earlyExits: todaySessions.filter((entry) => entry.earlyExit).length
    },
    streakDays: streak
  };
}
