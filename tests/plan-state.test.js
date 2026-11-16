import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadPlanData } from "../server/plan/data.js";
import { ensurePlanState, mergePlanState, planTasks } from "../server/plan/state.js";
import { addCustomTask, deleteCustomTask, patchTask, resetTask, triage, updateSettings } from "../server/plan/mutations.js";
import { dayView, planMeta, portfolioView, weekView } from "../server/plan/views.js";
import { importSiteRecords } from "../server/plan/import.js";
import { mergeRuntimeStates, portableRuntimeState } from "../server/shared-state.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = await loadPlanData({ resourceRoot: root });
const T0 = "2026-10-18T17:00:00.000Z";
const T1 = "2026-10-18T17:05:00.000Z";
const T2 = "2026-10-18T17:10:00.000Z";

test("patching marks done, moves and resets a task", () => {
  let plan = ensurePlanState();
  plan = patchTask(data, plan, { id: "w1-study0", done: true }, T0).plan;
  let task = planTasks(data, plan).find((entry) => entry.id === "w1-study0");
  assert.equal(task.done, true);
  assert.equal(plan.records["task:w1-study0"].completedAt, T0);

  plan = patchTask(data, plan, { id: "w1-study0", done: false, date: "2026-10-20" }, T1).plan;
  task = planTasks(data, plan).find((entry) => entry.id === "w1-study0");
  assert.equal(task.done, false);
  assert.equal(task.date, "2026-10-20");
  assert.equal(task.plannedDate, "2026-10-13");

  plan = resetTask(data, plan, { id: "w1-study0" }, T2).plan;
  task = planTasks(data, plan).find((entry) => entry.id === "w1-study0");
  assert.equal(task.date, "2026-10-13");
  assert.deepEqual(plan.records["task:w1-study0"], { reset: true, updatedAt: T2 });
});

test("patch validation rejects bad input", () => {
  const plan = ensurePlanState();
  assert.throws(() => patchTask(data, plan, { id: "w1-study0", date: "next week" }, T0), /YYYY-MM-DD/);
  assert.throws(() => patchTask(data, plan, { id: "w1-study0", minutes: 3 }, T0), /minutes/);
  assert.throws(() => patchTask(data, plan, { id: "nope", done: true }, T0), (error) => error.status === 404);
  assert.throws(() => patchTask(data, plan, { id: "w1-study0" }, T0), /Nothing/);
});

test("custom tasks can be added and deleted with a tombstone", () => {
  let plan = ensurePlanState();
  const created = addCustomTask(plan, { title: "Call recruiter", date: "2026-10-19", minutes: 20, category: "Applications" }, T0);
  plan = created.plan;
  assert.ok(planTasks(data, plan).some((task) => task.id === created.result.id && task.custom));
  plan = deleteCustomTask(plan, { id: created.result.id }, T1).plan;
  assert.ok(!planTasks(data, plan).some((task) => task.id === created.result.id));
  assert.equal(plan.records[created.result.id].deleted, true);
});

test("settings are validated and regenerate the plan", () => {
  let plan = ensurePlanState();
  assert.throws(() => updateSettings(data, plan, { dayStart: 900, dayEnd: 800 }, T0), /end after/);
  assert.throws(() => updateSettings(data, plan, { classTimes: [[600]] }, T0), /weekday/);
  plan = updateSettings(data, plan, { capstoneMinutes: 0 }, T0).plan;
  assert.ok(!planTasks(data, plan).some((task) => task.category === "Capstone"));
});

test("site import is idempotent and never overwrites local records", () => {
  const site = { source: "site", records: { "task:w0-home3": { revision: 1, value: { done: true } }, settings: { revision: 1, value: { capstoneMinutes: 120 } }, junk: { value: 1 } } };
  const first = importSiteRecords(ensurePlanState(), site, T0);
  assert.deepEqual(first.result.added.sort(), ["settings", "task:w0-home3"]);
  assert.deepEqual(first.result.ignored, ["junk"]);
  assert.equal(first.plan.importedAt, T0);
  const second = importSiteRecords(first.plan, site, T1);
  assert.deepEqual(second.result.added, []);
  assert.equal(second.plan.importedAt, T0);
});

test("merge keeps the newest record and a stale save cannot clobber a newer one", () => {
  const older = patchTask(data, ensurePlanState(), { id: "w1-code0", done: true }, T0).plan;
  const newer = patchTask(data, older, { id: "w1-code0", done: false }, T1).plan;
  // A stale writer saves its old copy; saveRuntimeState merges it with disk.
  const merged = mergeRuntimeStates({ plan: older }, { plan: newer });
  assert.equal(merged.plan.records["task:w1-code0"].done, false);
  const reverse = mergeRuntimeStates({ plan: newer }, { plan: older });
  assert.equal(reverse.plan.records["task:w1-code0"].done, false);
  assert.ok(portableRuntimeState({ plan: newer }).plan.records["task:w1-code0"]);
  assert.equal(mergeRuntimeStates({}, {}).plan, undefined);
});

test("merge keeps at most one active focus session", () => {
  const a = { ...ensurePlanState(), focusSessions: [{ id: "a", status: "active", startedAt: T0, runningSince: T0, lastHeartbeatAt: T1, accumulatedSeconds: 0, updatedAt: T0 }] };
  const b = { ...ensurePlanState(), focusSessions: [{ id: "b", status: "active", startedAt: T1, runningSince: T1, lastHeartbeatAt: T1, accumulatedSeconds: 0, updatedAt: T1 }] };
  const merged = mergePlanState(a, b);
  assert.deepEqual(merged.focusSessions.map((session) => [session.id, session.status]).sort(), [["a", "paused"], ["b", "active"]]);
  assert.equal(merged.focusSessions.find((session) => session.id === "a").accumulatedSeconds, 300);
});

test("triage rebalance spreads carried tasks into the coming days", () => {
  const plan = ensurePlanState();
  const today = "2026-10-18";
  const preview = triage(data, plan, { action: "rebalance", dryRun: true }, { now: T0, todayKey: today });
  assert.equal(preview.plan, plan);
  assert.ok(preview.result.moves.length > 0);
  assert.ok(preview.result.moves.every((move) => move.to >= today && move.to <= "2026-10-24"));
  const applied = triage(data, plan, { action: "rebalance" }, { now: T0, todayKey: today });
  const moved = planTasks(data, applied.plan).filter((task) => preview.result.moves.some((move) => move.id === task.id));
  assert.ok(moved.every((task) => task.date >= today));
  // Every day the rebalance touched still fits.
  for (const date of new Set(preview.result.moves.map((move) => move.to))) {
    const before = dayView(data, plan, date, "2026-10-17").unscheduled.length;
    const after = dayView(data, applied.plan, date, "2026-10-17").unscheduled.length;
    assert.ok(after <= before, `${date} gained unscheduled tasks`);
  }
});

test("triage skip and move", () => {
  const plan = ensurePlanState();
  const skipped = triage(data, plan, { action: "skip", ids: ["w1-code0"] }, { now: T0, todayKey: "2026-10-18" }).plan;
  assert.equal(planTasks(data, skipped).find((task) => task.id === "w1-code0").skipped, true);
  const moved = triage(data, plan, { action: "move", ids: ["w1-code0", "w1-code1"], date: "2026-10-25" }, { now: T0, todayKey: "2026-10-18" }).plan;
  assert.deepEqual(planTasks(data, moved).filter((task) => ["w1-code0", "w1-code1"].includes(task.id)).map((task) => task.date), ["2026-10-25", "2026-10-25"]);
});

test("views summarize the roadmap", () => {
  const plan = ensurePlanState();
  const meta = planMeta(data, plan, "2026-10-18");
  assert.equal(meta.weeks.length, 34);
  assert.equal(meta.currentWeekIndex, 1);
  assert.equal(meta.phases[0].name, "Baseline");
  assert.equal(meta.totals.total, 1010);
  const week = weekView(data, plan, "2026-10-15", "2026-10-18");
  assert.equal(week.start, "2026-10-12");
  assert.equal(week.days.length, 7);
  const day = dayView(data, plan, "2026-10-18", "2026-10-18");
  assert.ok(day.carried.length > 0);
  assert.ok(day.blocks.some((block) => block.kind === "gym" || block.kind === "meal"));
  const portfolio = portfolioView(data, plan);
  assert.equal(portfolio.sessions.length, 40);
  assert.equal(portfolio.items.length, 98);
});
