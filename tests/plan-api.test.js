import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { normalizeConfigPaths } from "../server/platform.js";
import { startServer } from "../server.js";
import { removeTempDir } from "./helpers.js";

const NOW = "2026-10-18T17:00:00.000Z";

async function withServer(fn, { siteImport = null } = {}) {
  const previous = { shared: process.env.JARVIS_SHARED_DIR, now: process.env.JARVIS_PLAN_NOW };
  const sharedDir = await mkdtemp(join(tmpdir(), "jarvis-plan-api-"));
  process.env.JARVIS_SHARED_DIR = sharedDir;
  process.env.JARVIS_PLAN_NOW = NOW;
  const dataRoot = join(sharedDir, "app");
  await mkdir(join(dataRoot, "config"), { recursive: true });
  await mkdir(join(dataRoot, "data"), { recursive: true });
  const config = normalizeConfigPaths(JSON.parse(await readFile(join(process.cwd(), "config", "jarvis.config.json"), "utf8")), { baseDir: process.cwd() });
  await writeFile(join(dataRoot, "config", "jarvis.config.json"), JSON.stringify(config));
  if (siteImport) await writeFile(join(dataRoot, "data", "plan-site-import.local.json"), JSON.stringify(siteImport));
  let handle = await startServer({ host: "127.0.0.1", port: 0, dataRoot });
  const restart = async () => {
    await new Promise((resolve) => handle.server.close(resolve));
    handle = await startServer({ host: "127.0.0.1", port: 0, dataRoot });
    return `http://${handle.host}:${handle.port}`;
  };
  try {
    return await fn(`http://${handle.host}:${handle.port}`, { dataRoot, restart });
  } finally {
    await new Promise((resolve) => handle.server.close(resolve));
    delete globalThis.jarvisDesktopActions;
    for (const [key, value] of [["JARVIS_SHARED_DIR", previous.shared], ["JARVIS_PLAN_NOW", previous.now]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeTempDir(sharedDir);
  }
}

// fetch() won't let a test override Host, so use node:http for that check.
function postWithHost(base, path, host) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: hostname, port, path, method: "POST", headers: { host, "content-type": "application/json" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ id: "w1-study0", done: true }));
  });
}

const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("plan API serves the roadmap and imports site progress on first load", async () => {
  const siteImport = { source: "test", records: { "task:w0-home3": { revision: 1, value: { done: true } }, settings: { revision: 1, value: { capstoneMinutes: 120 } } } };
  await withServer(async (base) => {
    const meta = await (await fetch(`${base}/api/plan/meta`)).json();
    assert.equal(meta.ok, true);
    assert.equal(meta.todayKey, "2026-10-18");
    assert.equal(meta.weeks.length, 34);
    assert.equal(meta.currentWeekIndex, 1);
    assert.equal(meta.settings.capstoneMinutes, 120);
    assert.equal(meta.importedAt, NOW);

    const day = await (await fetch(`${base}/api/plan/day?date=2026-10-18`)).json();
    assert.equal(day.isToday, true);
    assert.ok(day.carried.length > 0);
    const week = await (await fetch(`${base}/api/plan/week?date=2026-10-14`)).json();
    assert.equal(week.start, "2026-10-12");
    const search = await (await fetch(`${base}/api/plan/search?q=bitly`)).json();
    assert.ok(search.total >= 3);
    const detail = await (await fetch(`${base}/api/plan/task?id=portfolio-w1-build1`)).json();
    assert.ok(detail.task.auditItems.length > 0);
    assert.equal((await fetch(`${base}/api/plan/range?from=2026-10-01&to=2027-01-01`)).status, 400);
    assert.equal((await fetch(`${base}/api/plan/day?date=tomorrow`)).status, 400);
  }, { siteImport });
});

test("plan writes persist across a restart and reject bad requests", async () => {
  await withServer(async (base, { restart }) => {
    let response = await post(`${base}/api/plan/tasks/patch`, { id: "w1-study0", done: true });
    assert.equal(response.status, 200);
    response = await post(`${base}/api/plan/tasks/patch`, { id: "w1-study1", date: "2026-10-21" });
    assert.equal(response.status, 200);
    assert.equal((await post(`${base}/api/plan/settings`, { dayStart: 1000, dayEnd: 900 })).status, 400);
    assert.equal((await fetch(`${base}/api/plan/tasks/patch`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
    assert.equal((await fetch(`${base}/api/plan/tasks/patch`, { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" })).status, 400);
    assert.equal(await postWithHost(base, "/api/plan/tasks/patch", "evil.example"), 403);

    const nextBase = await restart();
    const detail = await (await fetch(`${nextBase}/api/plan/task?id=w1-study0`)).json();
    assert.equal(detail.task.done, true);
    const moved = await (await fetch(`${nextBase}/api/plan/task?id=w1-study1`)).json();
    assert.equal(moved.task.date, "2026-10-21");
  });
});

test("focus sessions run through the API and control the desktop window", async () => {
  await withServer(async (base) => {
    let state = await (await post(`${base}/api/focus/start`, { taskId: "w1-study0", plannedMinutes: 25 })).json();
    assert.equal(state.session.taskId, "w1-study0");
    assert.equal(state.desktopAvailable, false);
    assert.equal((await post(`${base}/api/focus/window`, { on: true })).status, 409);

    const calls = [];
    globalThis.jarvisDesktopActions = { setFocusMode: (on) => { calls.push(on); return { focusMode: on }; }, focusStatus: () => ({ focusMode: calls.at(-1) ?? false }) };
    const windowResponse = await (await post(`${base}/api/focus/window`, { on: true })).json();
    assert.deepEqual(windowResponse.window, { focusMode: true });

    state = await (await post(`${base}/api/focus/exit-early`, { reason: "test", heldMs: 2000 })).json();
    assert.equal(state.session, null);
    assert.equal(state.today.earlyExits, 1);
    assert.deepEqual(calls, [true, false]);
    assert.equal((await post(`${base}/api/focus/pause`, {})).status, 409);
  });
});

test("NeetCode log endpoints record results", async () => {
  await withServer(async (base) => {
    const created = await (await post(`${base}/api/plan/neetcode/log`, { problem: "Two Sum", result: "hinted", url: "https://neetcode.io/problems/two-integer-sum" })).json();
    assert.equal(created.entry.date, "2026-10-18");
    const view = await (await fetch(`${base}/api/plan/neetcode?date=2026-10-25`)).json();
    assert.equal(view.reviews[0].entry.problem, "Two Sum");
    assert.equal((await post(`${base}/api/plan/neetcode/log`, { problem: "x", result: "nope" })).status, 400);
  });
});
