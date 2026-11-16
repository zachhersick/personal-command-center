import test from "node:test";
import assert from "node:assert/strict";
import { ensurePlanState, mergePlanState } from "../server/plan/state.js";
import { patchTask, triage } from "../server/plan/mutations.js";
import { dayView } from "../server/plan/views.js";
import { fixedBlocks } from "../server/plan/scheduler.js";
import { addDays } from "../server/plan/dates.js";

const TODAY = "2026-10-23";
const NOW = "2026-10-23T20:15:00.000Z";
const context = { now: NOW, todayKey: TODAY, timeZone: "America/Los_Angeles" };
const data = {
  weeks: [], audit: { sessions: [] },
  defaults: { dayStart: 780, dayEnd: 1020, classMode: false, gymConfirmed: true, gymAnchor: TODAY, gymPhase: 3, weekendGym: 720 }
};
const task = (title, preferred, minutes, extra = {}) => ({ title, preferred, minutes, category: "Personal", date: TODAY, ...extra });
function fixture(records, settings = {}) {
  return ensurePlanState({ records: {
    settings: { ...settings, updatedAt: NOW },
    ...Object.fromEntries(Object.entries(records).map(([id, value]) => [`custom:${id}`, { ...value, updatedAt: "2026-10-22T20:15:00.000Z" }]))
  } });
}
function preview(plan, ids = ["custom:carry"], extra = {}, ctx = context) {
  return triage(data, plan, { action: "rebalance", reclaimCompleted: true, days: 1, ids, dryRun: true, ...extra }, ctx).result;
}
function apply(plan, proposed, ctx = context) {
  return triage(data, plan, { action: "rebalance", reclaimCompleted: true, days: 1, ids: proposed.ids, previewToken: proposed.previewToken }, ctx);
}
const taskBlocks = (plan) => dayView(data, plan, TODAY, TODAY).blocks.filter((block) => block.kind === "task");

test("reclamation preview and displayed schedule agree, preserving completion history", () => {
  const plan = fixture({
    done: task("Completed early", 900, 60, { done: true, completedAt: NOW, notes: "Keep me", accumulatedSeconds: 120 }),
    carry: task("Carryover", 900, 60, { date: "2026-10-22" })
  }, { dayStart: 900, dayEnd: 960 });
  const original = JSON.stringify(plan);
  const proposed = preview(plan);
  assert.equal(JSON.stringify(plan), original);
  assert.deepEqual(proposed.moves.map(({ id, start, end }) => ({ id, start, end })), [{ id: "custom:carry", start: 900, end: 960 }]);
  const applied = apply(plan, proposed).plan;
  const view = dayView(data, applied, TODAY, TODAY);
  assert.deepEqual(taskBlocks(applied).map((block) => [block.id, block.start, block.end]), [["custom:carry", 900, 960]]);
  assert.deepEqual(view.completed.map((entry) => entry.id), ["custom:done"]);
  for (const field of ["done", "completedAt", "notes", "accumulatedSeconds", "date"]) assert.equal(applied.records["custom:done"][field], plan.records["custom:done"][field]);
  assert.equal(view.summary.done, 1);
  assert.deepEqual(taskBlocks(mergePlanState(plan, JSON.parse(JSON.stringify(applied)))).map((b) => b.id), ["custom:carry"]);
});

test("past and underway completed blocks and existing unfinished times remain fixed", () => {
  const plan = fixture({
    past1: task("Past 1", 480, 30, { done: true }), past2: task("Past 2", 520, 30, { done: true }),
    past3: task("Past 3", 560, 30, { done: true }), past4: task("Past 4", 600, 30, { done: true }),
    underway: task("Underway", 780, 30, { done: true }),
    future: task("Future done", 900, 60, { done: true }),
    pinned: task("Pinned", 840, 30, { pinnedStart: 840 }),
    carry: task("Carryover", 900, 60, { date: "2026-10-22" })
  }, { dayStart: 480, dayEnd: 960 });
  const before = taskBlocks(plan);
  const proposed = preview(plan);
  const applied = apply(plan, proposed).plan;
  assert.deepEqual(proposed.reclaimed.map((entry) => entry.id), ["custom:future"]);
  for (const id of ["past1", "past2", "past3", "past4", "underway", "pinned"]) {
    const original = before.find((b) => b.id === `custom:${id}`);
    const after = taskBlocks(applied).find((b) => b.id === original.id);
    assert.deepEqual([after.start, after.end], [original.start, original.end]);
  }
});

test("free gaps are used before completed slots, and only overlapping slots are reclaimed", () => {
  const plan = fixture({ first: task("Future done", 900, 30, { done: true }), second: task("Keep done", 960, 30, { done: true }), carry: task("Carryover", 900, 30, { date: "2026-10-22" }) });
  assert.deepEqual(preview(plan).reclaimed, []);
  const filled = fixture({ first: plan.records["custom:first"], second: plan.records["custom:second"], carry: plan.records["custom:carry"] }, { dayStart: 900, dayEnd: 990 });
  assert.deepEqual(preview(filled).reclaimed.map((entry) => entry.id), ["custom:first"]);
});

test("stale previews and slots overtaken by time apply nothing", () => {
  const plan = fixture({ done: task("Done", 900, 60, { done: true }), carry: task("Carry", 900, 60, { date: "2026-10-22" }) }, { dayStart: 900, dayEnd: 960 });
  const proposed = preview(plan);
  const changed = patchTask(data, plan, { id: "custom:done", done: false }, NOW).plan;
  assert.equal(apply(changed, proposed).result.stale, true);
  assert.equal(apply(changed, proposed).plan, changed);
  const late = { ...context, now: "2026-10-23T22:05:00.000Z" };
  assert.equal(apply(plan, proposed, late).result.stale, true);
  assert.equal(apply(plan, proposed, late).plan, plan);
  const deleted = { ...plan, records: { ...plan.records, "custom:carry": { deleted: true, updatedAt: NOW } } };
  assert.equal(apply(deleted, proposed).result.stale, true);
  assert.equal(apply(deleted, proposed).plan, deleted);
});

test("unchecking a released task cannot evict its replacement; manual edits clear automatic placement", () => {
  const plan = fixture({ done: task("Done", 900, 60, { done: true }), carry: task("Carry", 900, 60, { date: "2026-10-22" }) }, { dayStart: 900, dayEnd: 960 });
  const applied = apply(plan, preview(plan)).plan;
  const undone = patchTask(data, applied, { id: "custom:done", done: false }, NOW).plan;
  assert.equal(taskBlocks(undone)[0].id, "custom:carry");
  assert.ok(dayView(data, undone, TODAY, TODAY).unscheduled.some((entry) => entry.id === "custom:done"));
  assert.equal(patchTask(data, applied, { id: "custom:carry", date: "2026-10-24" }, NOW).plan.records["custom:carry"].schedulePlacement, null);
});

test("placements are rounded forward in the configured timezone and cannot use elapsed time", () => {
  const plan = fixture({ carry: task("Carry", 780, 30, { date: "2026-10-22" }) });
  const proposed = preview(plan, undefined, {}, { ...context, now: "2026-10-23T20:15:01.000Z" });
  assert.equal(proposed.moves[0].start, 800);
  const afterDay = preview(plan, undefined, {}, { ...context, now: "2026-10-24T06:00:00.000Z" });
  assert.deepEqual(afterDay.moves, []);
  assert.deepEqual(afterDay.unplaced, ["custom:carry"]);
});

test("manual pins, selected-only spreading, and active focus cannot be displaced", () => {
  const plan = fixture({
    done: task("Pinned done", 900, 60, { done: true, pinnedStart: 900 }),
    carry: task("Carry", 900, 60, { date: "2026-10-22" }),
    other: task("Other carry", 900, 60, { date: "2026-10-21" })
  }, { dayStart: 900, dayEnd: 960 });
  assert.deepEqual(preview(plan).unplaced, ["custom:carry"]);
  const focus = { ...plan, focusSessions: [{ id: "focus", taskId: "custom:carry", status: "active" }] };
  const proposed = preview(focus);
  assert.deepEqual(proposed.protected, ["custom:carry"]);
  assert.deepEqual(proposed.moves, []);
  assert.equal(apply(focus, proposed).plan, focus);
  const pinnedCarry = patchTask(data, plan, { id: "custom:carry", pinnedStart: 900 }, NOW).plan;
  assert.deepEqual(preview(pinnedCarry).protected, ["custom:carry"]);
  assert.deepEqual(preview(pinnedCarry).moves, []);
});

test("buffers and fragmented space cannot overbook or split a carried task", () => {
  const plan = fixture({
    a: task("A", 840, 30, { pinnedStart: 840 }), b: task("B", 900, 30, { pinnedStart: 900 }),
    carry: task("Too large", 840, 45, { date: "2026-10-22" })
  }, { dayStart: 840, dayEnd: 960 });
  assert.deepEqual(preview(plan).unplaced, ["custom:carry"]);
  const fit = patchTask(data, plan, { id: "custom:carry", minutes: 10 }, NOW).plan;
  assert.equal(preview(fit).moves[0].start, 880);
});

test("seven-day spreading keeps commitments and leaves excess work carried over", () => {
  const records = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`carry${i}`, task(`Carry ${i}`, 900, 60, { date: "2026-10-22" })]));
  const plan = fixture(records, { dayStart: 900, dayEnd: 960 });
  const ids = Object.keys(records).map((id) => `custom:${id}`);
  const proposed = preview(plan, ids, { days: 7 });
  assert.equal(proposed.to, "2026-10-29");
  assert.equal(proposed.moves.length, 7);
  assert.equal(proposed.unplaced.length, 1);
  for (const move of proposed.moves) {
    assert.ok(move.to >= TODAY && move.to <= addDays(TODAY, 6));
    assert.ok(fixedBlocks(move.to, { ...data.defaults, dayStart: 900, dayEnd: 960 }).every((block) => move.start >= block.end || move.end <= block.start));
  }
  const applied = triage(data, plan, { action: "rebalance", reclaimCompleted: true, ids, days: 7, previewToken: proposed.previewToken }, context).plan;
  assert.equal(applied.records[proposed.unplaced[0]].date, "2026-10-22");
  const again = preview(applied, ids, { days: 7 });
  assert.deepEqual(again.moves, []);
});

test("class, gym, meals and invalidated reservations remain protected", () => {
  const settings = { dayStart: 480, dayEnd: 1380, classMode: true, classTimes: [[], [], [], [], [570, 835]], gymPhase: 0 };
  const plan = fixture({ carry: task("Work", 900, 60, { date: "2026-10-22" }) }, settings);
  const proposed = preview(plan);
  const fixed = fixedBlocks(TODAY, { ...data.defaults, ...settings });
  for (const move of proposed.moves) assert.ok(fixed.every((block) => move.start >= block.end || move.end <= block.start));
  const applied = apply(plan, proposed).plan;
  const changed = { ...applied, records: { ...applied.records, settings: { ...settings, dayEnd: 800 } } };
  assert.ok(dayView(data, changed, TODAY, TODAY).unscheduled.some((entry) => entry.id === "custom:carry"));
});

test("planner metadata is not accepted from public task patches", () => {
  const plan = fixture({ carry: task("Work", 900, 60) });
  assert.throws(() => patchTask(data, plan, { id: "custom:carry", schedulePlacement: { date: TODAY, start: 900, end: 960 }, timelineReleased: true }, NOW), /Nothing to change/);
  assert.throws(() => triage(data, plan, { action: "rebalance", reclaimCompleted: "true" }, context), /true or false/);
});
