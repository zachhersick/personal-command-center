import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePlanState, planTasks } from "../server/plan/state.js";
import { triage } from "../server/plan/mutations.js";
import { taskDetail } from "../server/plan/views.js";

const TODAY = "2026-10-23";
const TOMORROW = "2026-10-24";
const NOW = "2026-10-23T20:15:00.000Z";
const context = { now: NOW, todayKey: TODAY, timeZone: "America/Los_Angeles" };
const data = {
  weeks: [], audit: { sessions: [] },
  defaults: { dayStart: 900, dayEnd: 960, classMode: false, gymConfirmed: true, gymAnchor: TODAY, gymPhase: 3, weekendGym: 720 }
};
const step = (n, minutes, extra = {}) => ({ title: `Step ${n}`, preferred: 900, minutes, category: "Personal", date: TODAY, sequences: [{ key: "set", step: n }], ...extra });
function fixture(records, settings = {}, rest = {}) {
  return ensurePlanState({ ...rest, records: {
    settings: { ...settings, updatedAt: NOW },
    ...Object.fromEntries(Object.entries(records).map(([id, value]) => [`custom:${id}`, { ...value, updatedAt: "2026-10-22T20:15:00.000Z" }]))
  } });
}
const spread = (plan, ids, days = 7) => triage(data, plan, { action: "rebalance", reclaimCompleted: true, days, ids: ids.map((id) => `custom:${id}`), dryRun: true }, context).result;
const moveOf = (preview, id) => preview.moves.find((move) => move.id === `custom:${id}`);
const position = (move) => `${move.to} ${String(move.start).padStart(4, "0")}`;

test("roadmap sets run in order, and a repair session spanning projects closes each of them", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const roadmap = JSON.parse(readFileSync(join(root, "data", "plan", "roadmap-plan.v1.json"), "utf8"));
  const tasks = planTasks(roadmap, ensurePlanState({}));
  const members = (key) => tasks
    .filter((task) => task.sequences?.some((entry) => entry.key === key))
    .sort((a, b) => a.sequences.find((entry) => entry.key === key).step - b.sequences.find((entry) => entry.key === key).step);

  assert.deepEqual(members("series:typescript").map((task) => task.title.slice(0, 14)), Array.from({ length: 8 }, (_, index) => `TypeScript ${index + 1}/8`));
  const systems = members("systems").map((task) => task.title);
  assert.ok(systems.indexOf("Hello Interview: Design Bitly · requirements and APIs") < systems.indexOf("Hello Interview: Design Bitly · high-level design"));
  assert.ok(systems.indexOf("Hello Interview: Design Bitly · high-level design") < systems.indexOf("Hello Interview: Design Bitly · scaling and tradeoffs"));
  assert.deepEqual(members("behavioral").map((task) => task.weekIndex), [...members("behavioral").map((task) => task.weekIndex)].sort((a, b) => a - b));

  const copilot = members("repair:anomalyops-copilot").map((task) => task.title);
  assert.ok(copilot.indexOf("Copilot: usable offline retrieval, part 1") < copilot.indexOf("Copilot: offline retrieval, part 2"));
  for (const repo of ["anomaly-detection", "anomalyops-copilot"]) {
    assert.equal(members(`repair:${repo}`).at(-1).slot, "w24-build1");
  }
  assert.equal(members("repair:sample-project").at(-1).slot, "w24-build0");
  assert.deepEqual(members("study:w4").map((task) => task.title), ["Trace data into predictions", "Check leakage and metrics"]);
  assert.ok(tasks.filter((task) => task.category === "NeetCode" || task.category === "Homework").every((task) => !task.sequences?.length));
  assert.ok(tasks.filter((task) => /^w\d+-build\d$/.test(task.id) && task.replaced === undefined).every((task) => task.sequences.length === 1));
});

test("a short later step can't jump into a gap ahead of a longer earlier step", () => {
  const plan = fixture({
    pin: { title: "Pinned", preferred: 950, minutes: 10, category: "Personal", date: TODAY, pinnedStart: 950 },
    first: step(1, 60, { date: "2026-10-21" }),
    second: step(2, 30, { date: "2026-10-22" })
  });
  const preview = spread(plan, ["first", "second"]);
  assert.ok(position(moveOf(preview, "first")) < position(moveOf(preview, "second")));
  assert.notEqual(moveOf(preview, "second").to, TODAY);
});

test("a later step already on the calendar moves back, and the preview says why", () => {
  const plan = fixture({ first: step(1, 30, { date: "2026-10-22" }), second: step(2, 30) });
  const preview = spread(plan, ["first"]);
  const first = moveOf(preview, "first");
  const second = moveOf(preview, "second");
  assert.ok(position(first) < position(second));
  assert.equal(second.keepOrder, true);
  assert.equal(first.keepOrder, undefined);
  const applied = triage(data, plan, { action: "rebalance", reclaimCompleted: true, days: 7, ids: preview.ids, previewToken: preview.previewToken }, context);
  assert.equal(applied.result.stale, undefined);
  assert.equal(applied.plan.records["custom:second"].date, second.to);
  assert.equal(applied.plan.records["custom:second"].schedulePlacement.start, second.start);
});

test("later steps that are already later stay where they are", () => {
  const plan = fixture({ first: step(1, 30, { date: "2026-10-22" }), second: step(2, 30, { date: "2026-10-27" }) });
  const preview = spread(plan, ["first"]);
  assert.equal(moveOf(preview, "first").to, TODAY);
  assert.equal(moveOf(preview, "second"), undefined);
});

test("a pinned later step stays, and the earlier step goes before it or stays in Today", () => {
  const fits = fixture({ first: step(1, 15, { date: "2026-10-22" }), second: step(2, 15, { pinnedStart: 930 }) });
  const fitted = spread(fits, ["first"]);
  assert.equal(moveOf(fitted, "first").start, 900);
  assert.equal(moveOf(fitted, "second"), undefined);

  const tooLong = fixture({ first: step(1, 30, { date: "2026-10-22" }), second: step(2, 15, { pinnedStart: 930 }) });
  const blocked = spread(tooLong, ["first"]);
  assert.deepEqual(blocked.moves, []);
  assert.deepEqual(blocked.unplaced, ["custom:first"]);
});

test("a later step in a focus session never moves", () => {
  const plan = fixture(
    { first: step(1, 30, { date: "2026-10-22" }), second: step(2, 30) },
    {},
    { focusSessions: [{ id: "focus", taskId: "custom:second", status: "active" }] }
  );
  const preview = spread(plan, ["first"]);
  assert.equal(moveOf(preview, "second"), undefined);
  assert.deepEqual(preview.unplaced, ["custom:first"]);
});

test("spreading only a later step brings its earlier carried steps", () => {
  const plan = fixture({ first: step(1, 30, { date: "2026-10-21" }), second: step(2, 15, { date: "2026-10-22" }) });
  const preview = spread(plan, ["second"]);
  assert.equal(moveOf(preview, "first").keepOrder, true);
  assert.ok(position(moveOf(preview, "first")) < position(moveOf(preview, "second")));
});

test("a chain that doesn't fit leaves everything where it was", () => {
  const plan = fixture({ first: step(1, 30, { date: "2026-10-22" }), second: step(2, 30) }, { dayEnd: 1000 });
  const preview = spread(plan, ["first"], 1);
  assert.deepEqual(preview.moves, []);
  assert.deepEqual(preview.unplaced, ["custom:first"]);
  assert.deepEqual(preview.placements, []);
});

test("later steps of a task that stays behind stay behind too", () => {
  const plan = fixture({
    first: step(1, 120, { date: "2026-10-21" }),
    second: step(2, 15, { date: "2026-10-22" }),
    other: { title: "Unrelated", preferred: 900, minutes: 15, category: "Personal", date: "2026-10-22" }
  });
  const preview = spread(plan, ["first", "second", "other"]);
  assert.deepEqual(preview.unplaced.sort(), ["custom:first", "custom:second"]);
  assert.deepEqual(preview.moves.map((move) => move.id), ["custom:other"]);
});

test("done and skipped steps don't constrain anything", () => {
  const plan = fixture({
    done: step(1, 60, { done: true, date: TOMORROW, pinnedStart: 900 }),
    skipped: step(2, 60, { skipped: true, date: TOMORROW }),
    carried: step(3, 30, { date: "2026-10-22" })
  });
  assert.equal(moveOf(spread(plan, ["carried"]), "carried").to, TODAY);
});

test("the roadmap's Spread out puts later steps on later days", () => {
  const run = (plan, ids) => triage(data, plan, { action: "rebalance", from: TODAY, days: 7, ids: ids.map((id) => `custom:${id}`), dryRun: true }, context).result;
  const both = fixture({ first: step(1, 30), second: step(2, 15) });
  const moved = new Map(run(both, ["first", "second"]).moves.map((move) => [move.id, move]));
  assert.equal(moved.get("custom:second").to, TOMORROW);

  const pulled = run(fixture({ first: step(1, 30, { date: "2026-10-22" }), second: step(2, 15) }), ["first"]);
  const second = pulled.moves.find((move) => move.id === "custom:second");
  assert.equal(second.keepOrder, true);
  assert.equal(second.to, TOMORROW);

  const pinned = run(fixture({ first: step(1, 30, { date: "2026-10-22" }), second: step(2, 15, { pinnedStart: 930 }) }), ["first"]);
  assert.deepEqual(pinned.moves, []);
  assert.deepEqual(pinned.unplaced, ["custom:first"]);
});

const ticket = (title, date, minutes = 40, extra = {}) => ({ title, preferred: 900, minutes, category: "Build", date, ...extra });

test("spreading places carried backlog tickets ahead of older carried work", () => {
  const plan = fixture({
    older: { title: "Older work", preferred: 900, minutes: 40, category: "Personal", date: "2026-10-20" },
    an: ticket("AN-001 (1/2): Make a fresh clone run", "2026-10-22")
  });
  const preview = spread(plan, ["older", "an"]);
  assert.equal(moveOf(preview, "an").to, TODAY);
  assert.equal(moveOf(preview, "older").to, TOMORROW);
});

test("the roadmap's Spread out also gives backlog tickets the first room", () => {
  const plan = fixture({
    other: { title: "Today's work", preferred: 900, minutes: 40, category: "Personal", date: TODAY },
    an: ticket("AN-101: Choose the dataset", "2026-10-22")
  });
  const { moves } = triage(data, plan, { action: "rebalance", from: TODAY, days: 7, ids: ["custom:other", "custom:an"], dryRun: true }, context).result;
  const moved = new Map(moves.map((move) => [move.id, move]));
  assert.equal(moved.get("custom:an").to, TODAY);
  assert.equal(moved.get("custom:other").to, TOMORROW);
});

test("backlog tickets run in title order, whatever their dates or lengths", () => {
  const plan = fixture({
    pin: { title: "Pinned", preferred: 950, minutes: 10, category: "Personal", date: TODAY, pinnedStart: 950 },
    second: ticket("AN-001 (2/2): Make a fresh clone run", "2026-10-21", 15),
    first: ticket("AN-001 (1/2): Make a fresh clone run", "2026-10-22", 60),
    third: ticket("AN-002 (1/3): Package the project", "2026-10-20", 15)
  });
  const preview = spread(plan, ["first", "second", "third"]);
  assert.ok(position(moveOf(preview, "first")) < position(moveOf(preview, "second")));
  assert.ok(position(moveOf(preview, "second")) < position(moveOf(preview, "third")));
});

test("backlog marks come from the title and are never saved", () => {
  const plan = fixture({
    an: ticket("AN-204: Replace threshold selection", "2026-10-22"),
    next: ticket("AN-205 (1/2): Build baselines", "2026-10-27"),
    lookalike: ticket("PLAN-204: Not a backlog ticket", "2026-10-22"),
    mentions: ticket("Review AN-204 notes", "2026-10-22")
  });
  const tasks = new Map(planTasks(data, plan).map((task) => [task.id, task]));
  assert.deepEqual(tasks.get("custom:an").sequences.map((entry) => entry.key), ["backlog:anomaly-detection"]);
  for (const id of ["custom:lookalike", "custom:mentions"]) {
    assert.equal(tasks.get(id).sequences, undefined);
    assert.equal(tasks.get(id).spreadFirst, undefined);
  }
  const preview = spread(plan, ["an"]);
  const applied = triage(data, plan, { action: "rebalance", reclaimCompleted: true, days: 7, ids: preview.ids, previewToken: preview.previewToken }, context);
  assert.equal(applied.plan.records["custom:an"].date, TODAY);
  assert.equal("sequences" in applied.plan.records["custom:an"], false);
  assert.equal("spreadFirst" in applied.plan.records["custom:an"], false);
  assert.equal(taskDetail(data, plan, "custom:an").order[0].label, "anomaly-detection backlog");
});

const block = (title, date, minutes = 60, extra = {}) => ({ title, preferred: 900, minutes, category: "Build", date, ...extra });
const carriedTicket = ticket("AN-001: Make a fresh clone run", "2026-10-22", 30);

test("a backlog ticket bumps other work when the week has no room", () => {
  const plan = fixture({ an: carriedTicket, other: block("Build block", TODAY) });
  const preview = spread(plan, ["an"], 1);
  assert.equal(moveOf(preview, "an").to, TODAY);
  assert.equal(moveOf(preview, "an").bumped, undefined);
  assert.equal(moveOf(preview, "other").to, TOMORROW);
  assert.equal(moveOf(preview, "other").bumped, true);
  // The client only has today's tasks, and a bumped task is often on another day.
  assert.equal(moveOf(preview, "other").title, "Build block");
  assert.equal(moveOf(preview, "other").category, "Build");
  assert.deepEqual(preview.unplaced, []);
  const applied = triage(data, plan, { action: "rebalance", reclaimCompleted: true, days: 1, ids: preview.ids, previewToken: preview.previewToken }, context);
  assert.equal(applied.result.stale, undefined);
  assert.equal(applied.plan.records["custom:other"].date, TOMORROW);
  assert.equal(applied.plan.records["custom:an"].schedulePlacement.start, moveOf(preview, "an").start);
});

test("a backlog ticket uses free room before it bumps anything", () => {
  const preview = spread(fixture({ an: carriedTicket, other: block("Build block", TODAY) }), ["an"], 2);
  assert.equal(moveOf(preview, "an").to, TOMORROW);
  assert.equal(moveOf(preview, "other"), undefined);
});

test("a backlog ticket bumps to stay ahead of the next ticket rather than pushing it back", () => {
  const plan = fixture({
    an: carriedTicket,
    other: block("Build block", TODAY),
    next: ticket("AN-002 (1/3): Package the project", TOMORROW, 30)
  });
  const preview = spread(plan, ["an"], 3);
  assert.equal(moveOf(preview, "an").to, TODAY);
  assert.equal(moveOf(preview, "other").bumped, true);
  assert.equal(moveOf(preview, "next"), undefined);
});

test("other carried work never bumps anything", () => {
  const preview = spread(fixture({ mine: block("Carried build", "2026-10-22", 30), other: block("Build block", TODAY) }), ["mine"], 1);
  assert.deepEqual(preview.moves, []);
  assert.deepEqual(preview.unplaced, ["custom:mine"]);
});

test("only Build and Review work gets bumped, and never when pinned or in focus", () => {
  for (const category of ["Study", "NeetCode", "Behavioral", "Applications", "Interview", "Capstone", "PaidWork", "Homework", "Personal"]) {
    const preview = spread(fixture({ an: carriedTicket, other: block("Held", TODAY, 60, { category }) }), ["an"], 1);
    assert.deepEqual(preview.moves, [], category);
    assert.deepEqual(preview.unplaced, ["custom:an"], category);
  }
  assert.equal(moveOf(spread(fixture({ an: carriedTicket, other: block("Weekly review", TODAY, 60, { category: "Review" }) }), ["an"], 1), "other").bumped, true);
  const pinned = spread(fixture({ an: carriedTicket, other: block("Pinned", TODAY, 60, { pinnedStart: 900 }) }), ["an"], 1);
  assert.deepEqual(pinned.unplaced, ["custom:an"]);
  const focused = spread(fixture({ an: carriedTicket, other: block("In focus", TODAY) }, {}, { focusSessions: [{ id: "focus", taskId: "custom:other", status: "active" }] }), ["an"], 1);
  assert.deepEqual(focused.unplaced, ["custom:an"]);
});

test("bumped work moves later, never earlier", () => {
  const plan = fixture({
    an: ticket("AN-001: Make a fresh clone run", "2026-10-22", 60),
    held: block("Homework", TODAY, 30, { category: "Homework" }),
    other: block("Short build", TOMORROW, 15)
  });
  const preview = spread(plan, ["an"], 2);
  assert.equal(moveOf(preview, "an").to, TOMORROW);
  assert.ok(moveOf(preview, "other").to > TOMORROW);
});

test("a bumped step's later steps stay behind it", () => {
  const plan = fixture({ an: carriedTicket, first: step(1, 60, { category: "Build" }), second: step(2, 60, { category: "Build", date: TOMORROW }) });
  const preview = spread(plan, ["an"], 1);
  assert.equal(moveOf(preview, "first").bumped, true);
  assert.equal(moveOf(preview, "second").keepOrder, true);
  assert.ok(position(moveOf(preview, "first")) < position(moveOf(preview, "second")));
});

test("work that can't move out of the way stays put, and the ticket stays in Today", () => {
  const plan = fixture({
    an: carriedTicket,
    first: step(1, 30, { category: "Build" }),
    second: step(2, 10, { category: "Build", pinnedStart: 945 })
  });
  const preview = spread(plan, ["an"], 1);
  assert.deepEqual(preview.moves, []);
  assert.deepEqual(preview.unplaced, ["custom:an"]);
});

test("a task's detail links the steps around it in each ordered set", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const roadmap = JSON.parse(readFileSync(join(root, "data", "plan", "roadmap-plan.v1.json"), "utf8"));
  const plan = ensurePlanState({ records: { "task:w17-build0": { done: true, updatedAt: NOW }, "custom:mine": { title: "Mine", date: TODAY, minutes: 30, category: "Personal", updatedAt: NOW } } });

  const [series] = taskDetail(roadmap, plan, "w18-build0").order;
  assert.equal(series.label, "TypeScript series");
  assert.deepEqual([series.position, series.total], [3, 8]);
  assert.deepEqual(series.steps.map((entry) => entry.id), ["w17-build0", "w17-build1", "w18-build0", "w18-build1", "w19-build0"]);
  assert.deepEqual(series.steps.map((entry) => entry.done), [true, false, false, false, false]);
  assert.deepEqual(series.steps.map((entry) => entry.current), [false, false, true, false, false]);

  assert.deepEqual(taskDetail(roadmap, plan, "w17-build0").order[0].steps.map((entry) => entry.id), ["w17-build0", "w17-build1", "w18-build0"]);
  assert.deepEqual(taskDetail(roadmap, plan, "portfolio-w24-build1").order.map((set) => set.label), ["anomaly-detection repairs", "anomalyops-copilot repairs"]);
  assert.equal(taskDetail(roadmap, plan, "w4-study0").order[0].label, "This week's study");
  assert.equal(taskDetail(roadmap, plan, "w4-systems").order[0].label, "Hello Interview lessons");
  assert.deepEqual(taskDetail(roadmap, plan, "w4-home0").order, []);
  assert.deepEqual(taskDetail(roadmap, plan, "custom:mine").order, []);
});
