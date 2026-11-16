import test from "node:test";
import assert from "node:assert/strict";
import { ensurePlanState } from "../server/plan/state.js";
import { exitFocusEarly, focusView, heartbeatFocus, pauseFocus, reconcileFocus, resumeFocus, sessionElapsedSeconds, startFocus, stopFocus } from "../server/plan/focus.js";
import { addNeetcodeEntry, deleteNeetcodeEntry, neetcodeStats, reviewCandidates } from "../server/plan/neetcode.js";

const at = (minutes) => new Date(Date.parse("2026-10-18T16:00:00.000Z") + minutes * 60_000).toISOString();
const dateKeyOf = (iso) => iso.slice(0, 10);
// The renderer heartbeats every 30s; tick once a minute between two times.
const tick = (plan, from, to) => {
  let next = plan;
  for (let minute = from + 1; minute <= to; minute += 1) next = heartbeatFocus(next, at(minute)).plan;
  return next;
};

test("focus time accrues while running and pauses cleanly", () => {
  let { plan, session } = startFocus(ensurePlanState(), { taskId: "w1-study0", plannedMinutes: 50 }, at(0));
  plan = heartbeatFocus(plan, at(1)).plan;
  plan = heartbeatFocus(plan, at(2)).plan;
  plan = pauseFocus(plan, at(2)).plan;
  assert.equal(sessionElapsedSeconds(plan.focusSessions[0], at(30)), 120);
  plan = resumeFocus(plan, at(30)).plan;
  plan = heartbeatFocus(plan, at(31)).plan;
  const stopped = stopFocus(plan, { markDone: true }, at(31));
  assert.equal(stopped.session.accumulatedSeconds, 180);
  assert.equal(stopped.plan.records["task:w1-study0"].accumulatedSeconds, 180);
  assert.equal(stopped.plan.records["task:w1-study0"].done, true);
  assert.equal(session.status, "active");
});

test("a session without heartbeats stops accruing time", () => {
  let { plan } = startFocus(ensurePlanState(), { taskId: "w1-study0", plannedMinutes: 25 }, at(0));
  plan = heartbeatFocus(plan, at(1)).plan;
  // The app closed after one minute; two hours later the server boots.
  const reconciled = reconcileFocus(plan, at(120));
  assert.equal(reconciled.changed, true);
  assert.equal(reconciled.plan.focusSessions[0].status, "paused");
  assert.equal(reconciled.plan.focusSessions[0].accumulatedSeconds, 60);
  const view = focusView(reconciled.plan, at(121), dateKeyOf);
  assert.equal(view.session.elapsedSeconds, 60);
});

test("starting another task finishes the previous session", () => {
  let { plan } = startFocus(ensurePlanState(), { taskId: "a", plannedMinutes: 25 }, at(0));
  plan = tick(plan, 0, 10);
  plan = startFocus(plan, { taskId: "b", plannedMinutes: 25 }, at(10)).plan;
  assert.deepEqual(plan.focusSessions.map((session) => [session.taskId, session.status]), [["b", "active"], ["a", "completed"]]);
  assert.equal(plan.records["task:a"].accumulatedSeconds, 600);
});

test("leaving early is logged with the remaining time", () => {
  let { plan } = startFocus(ensurePlanState(), { taskId: "w1-study0", plannedMinutes: 50 }, at(0));
  plan = tick(plan, 0, 20);
  const exited = exitFocusEarly(plan, { reason: "got distracted", heldMs: 2100 }, at(20));
  assert.equal(exited.session.status, "exited");
  assert.equal(exited.session.earlyExit.reason, "got distracted");
  assert.equal(exited.session.earlyExit.remainingSeconds, 30 * 60);
  const view = focusView(exited.plan, at(21), dateKeyOf);
  assert.equal(view.session, null);
  assert.equal(view.today.earlyExits, 1);
  assert.equal(view.today.seconds, 1200);
});

test("focus input is validated", () => {
  assert.throws(() => startFocus(ensurePlanState(), { mode: "nap" }, at(0)), /Focus mode/);
  assert.throws(() => startFocus(ensurePlanState(), { plannedMinutes: 0 }, at(0)), /plannedMinutes/);
  assert.throws(() => pauseFocus(ensurePlanState(), at(0)), (error) => error.status === 409);
});

test("NeetCode spaced review surfaces misses from 7 and 21 days ago", () => {
  let plan = ensurePlanState();
  const log = (input) => {
    const result = addNeetcodeEntry(plan, input, at(0));
    plan = result.plan;
    return result.entry;
  };
  const twoSum = log({ problem: "Two Sum", result: "independent", date: "2026-10-11" });
  const lru = log({ problem: "LRU Cache", result: "studied", date: "2026-10-10" });
  const stale = log({ problem: "Old one", result: "hinted", date: "2026-09-01" });
  const threeWeeks = log({ problem: "Group Anagrams", result: "hinted", date: "2026-09-27" });
  void stale;
  let candidates = reviewCandidates(plan.neetcodeLog, "2026-10-18");
  assert.deepEqual(candidates.map((entry) => [entry.entry.problem, entry.interval]), [["LRU Cache", 7], ["Group Anagrams", 21], ["Two Sum", 7]]);
  log({ problem: "LRU Cache", result: "independent", date: "2026-10-18", reviewOf: lru.id, interval: 7 });
  candidates = reviewCandidates(plan.neetcodeLog, "2026-10-18");
  assert.ok(!candidates.some((entry) => entry.entry.id === lru.id));
  plan = deleteNeetcodeEntry(plan, twoSum.id, at(1)).plan;
  candidates = reviewCandidates(plan.neetcodeLog, "2026-10-18");
  assert.deepEqual(candidates.map((entry) => entry.entry.id), [threeWeeks.id]);
  const stats = neetcodeStats(plan.neetcodeLog, "2026-10-18");
  assert.equal(stats.total, 3);
  assert.equal(stats.streakDays, 1);
  assert.throws(() => addNeetcodeEntry(plan, { problem: "x", result: "guessed", date: "2026-10-18" }, at(0)), /Result/);
});

test("a meal timer runs like any session but stays out of focused time", () => {
  // 30 minutes of work, then a 20 minute meal.
  let { plan } = startFocus(ensurePlanState(), { taskId: "w1-study0", plannedMinutes: 50 }, at(0));
  plan = tick(plan, 0, 30);
  plan = stopFocus(plan, {}, at(30)).plan;

  const meal = startFocus(plan, { plannedMinutes: 35, kind: "break", label: "Meal / reset" }, at(40));
  plan = tick(meal.plan, 40, 60);
  assert.equal(meal.session.kind, "break");
  assert.equal(meal.session.taskId, null);
  assert.equal(meal.session.label, "Meal / reset");

  const view = focusView(plan, at(60), dateKeyOf);
  assert.equal(view.session.label, "Meal / reset", "the meal is the live session");
  assert.equal(Math.round(view.today.seconds / 60), 30, "only the work counts");
  assert.equal(Math.round(view.today.breakSeconds / 60), 20, "the meal is counted separately");
  assert.equal(view.today.sessions, 1, "the meal isn't a focus session in the tally");

  // A break on its own never earns a streak day.
  let onlyBreak = startFocus(ensurePlanState(), { plannedMinutes: 35, kind: "break" }, at(0)).plan;
  onlyBreak = tick(onlyBreak, 0, 30);
  const breakView = focusView(onlyBreak, at(30), dateKeyOf);
  assert.equal(breakView.today.seconds, 0);
  assert.equal(breakView.streakDays, 0);

  // Sessions saved before breaks existed have no kind, and still count as work.
  const legacy = ensurePlanState({ focusSessions: [{ id: "old", taskId: "t", startedAt: at(0), accumulatedSeconds: 1200, status: "done", updatedAt: at(20) }] });
  assert.equal(Math.round(focusView(legacy, at(30), dateKeyOf).today.seconds / 60), 20);

  assert.throws(() => startFocus(ensurePlanState(), { kind: "nap" }, at(0)), /Focus kind/);
});
