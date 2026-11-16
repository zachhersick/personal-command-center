import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadPlanData, validatePlanData } from "../server/plan/data.js";
import { effectiveSettings, generateBaseTasks } from "../server/plan/generator.js";
import { applyOverlay, planSettings } from "../server/plan/state.js";
import { importSiteRecords } from "../server/plan/import.js";
import { fixedBlocks, scheduleDay, tasksForDay } from "../server/plan/scheduler.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const snapshot = JSON.parse(readFileSync(join(root, "tests", "fixtures", "plan-site-snapshot.json"), "utf8"));
const siteImport = {
  source: "fixture",
  records: Object.fromEntries([
    ["settings", { revision: 1, value: snapshot.userSettings }],
    ...snapshot.userTasks.filter((task) => task.done).map((task) => [`task:${task.id}`, { revision: 1, value: { done: true } }])
  ])
};

const slim = (task) => ({
  id: task.id,
  date: task.date,
  week: task.week,
  minutes: task.minutes,
  category: task.category,
  title: task.title,
  preferred: task.preferred,
  fixIds: task.fixIds || null,
  done: Boolean(task.done),
  previousPlan: Boolean(task.previousPlan)
});

async function loadData() {
  return loadPlanData({ resourceRoot: root });
}

test("bundled plan data is valid and complete", async () => {
  const data = await loadData();
  assert.deepEqual(validatePlanData(data), []);
  assert.equal(data.weeks.length, 34);
  assert.equal(data.audit.items.length, 98);
  assert.equal(data.audit.sessions.length, 40);
});

test("generator reproduces the roadmap site's default task list exactly", async () => {
  const data = await loadData();
  const tasks = applyOverlay(data, generateBaseTasks(data, effectiveSettings(data)), {});
  assert.equal(tasks.length, 1010);
  assert.deepEqual(tasks.map(slim), snapshot.defaultTasks);
});

test("generator plus imported site progress reproduces the user's task list", async () => {
  const data = await loadData();
  const { plan } = importSiteRecords(null, siteImport, "2026-10-18T17:00:00.000Z");
  const settings = planSettings(data, plan);
  assert.equal(settings.capstoneMinutes, 120);
  const tasks = applyOverlay(data, generateBaseTasks(data, settings), plan.records);
  assert.deepEqual(tasks.map(slim), snapshot.userTasks);
  assert.equal(tasks.filter((task) => task.done).length, 17);
});

test("generator details: NeetCode cadence, capstone split and audit replacement", async () => {
  const data = await loadData();
  const tasks = generateBaseTasks(data, { ...effectiveSettings(data), capstoneMinutes: 120 });
  const week1 = tasks.filter((task) => task.weekIndex === 1);
  assert.equal(week1.find((task) => task.id === "w1-code2").minutes, 25);
  assert.equal(week1.find((task) => task.id === "w1-code6").title, "NeetCode: spaced review");
  assert.deepEqual(week1.filter((task) => task.category === "Capstone").map((task) => task.minutes), [60, 60]);
  const repair = tasks.find((task) => task.id === "portfolio-w1-build1");
  assert.ok(repair.fixIds.length > 0);
  assert.equal(repair.slot, "w1-build1");
  assert.match(repair.resources[0].url, /FIX_LIST\.md$/);
  assert.ok(tasks.every((task) => task.date >= "2026-10-08"));
});

test("fixed blocks match the site, except weekend lunch no longer overlaps the gym", async () => {
  const data = await loadData();
  for (const [dateKey, expected] of Object.entries(snapshot.blocks)) {
    for (const [variant, settings] of [["defaults", effectiveSettings(data)], ["user", { ...effectiveSettings(data), ...snapshot.userSettings }]]) {
      const actual = fixedBlocks(dateKey, settings);
      const site = expected[variant];
      const gym = site.find((block) => block.id === "gym");
      const lunch = site.find((block) => block.id === "lunch");
      const overlapping = gym && lunch && lunch.start < gym.end && lunch.end > gym.start && !site.some((block) => block.kind === "class");
      if (!overlapping) {
        assert.deepEqual(actual, site, `${dateKey} ${variant}`);
        continue;
      }
      const movedLunch = actual.find((block) => block.id === "lunch");
      assert.equal(movedLunch.start, gym.end + 10, `${dateKey} ${variant} lunch moves after the gym`);
      assert.deepEqual(actual.filter((block) => block.id !== "lunch"), site.filter((block) => block.id !== "lunch"));
    }
  }
});

test("day scheduling matches the site on days without the lunch fix", async () => {
  const data = await loadData();
  const { plan } = importSiteRecords(null, siteImport, "2026-10-18T17:00:00.000Z");
  const settings = planSettings(data, plan);
  const tasks = applyOverlay(data, generateBaseTasks(data, settings), plan.records);
  for (const dateKey of ["2026-10-15", "2026-10-20"]) {
    const result = scheduleDay(dateKey, tasksForDay(tasks, dateKey, snapshot.today), settings);
    assert.deepEqual(result.blocks.map(({ id, title, start, end, kind }) => ({ id, title, start, end, kind })), snapshot.schedules[dateKey].blocks, dateKey);
    assert.deepEqual(result.unscheduled.map((task) => task.id), snapshot.schedules[dateKey].unscheduled, dateKey);
  }
});

test("today carries every unfinished earlier task, oldest first", async () => {
  const data = await loadData();
  const { plan } = importSiteRecords(null, siteImport, "2026-10-18T17:00:00.000Z");
  const tasks = applyOverlay(data, generateBaseTasks(data, planSettings(data, plan)), plan.records);
  const today = tasksForDay(tasks, "2026-10-18", "2026-10-18");
  const carried = today.filter((task) => task.date < "2026-10-18");
  assert.equal(carried.length, 27);
  assert.ok(carried.every((task) => !task.done));
  assert.deepEqual(carried.map((task) => task.date), [...carried.map((task) => task.date)].sort());
  assert.equal(tasksForDay(tasks, "2026-10-18", "2026-10-19").length, today.length - carried.length);
});
