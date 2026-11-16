import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWindowMover, LineHelper, monitorOf, normalRect, pickTarget, placeOn, planMoves, stillPlaced, windowsToMove } from "../desktop/windows.mjs";
import { removeTempDir } from "./helpers.js";

// A two-monitor layout: a 1920x1080 main monitor, a second one to the left and lower.
const MAIN = { id: 1, primary: true, rect: { l: 0, t: 0, r: 1920, b: 1080 }, work: { l: 0, t: 0, r: 1920, b: 1032 } };
const LEFT = { id: 2, primary: false, rect: { l: -1920, t: 101, r: 0, b: 1181 }, work: { l: -1920, t: 101, r: 0, b: 1133 } };
const SMALL = { id: 3, primary: false, rect: { l: 1920, t: 0, r: 3200, b: 720 }, work: { l: 1920, t: 0, r: 3200, b: 680 } };
const JARVIS_PID = 100;

const win = (hwnd, rect, extra = {}) => ({ hwnd, pid: 200 + hwnd, cls: "Chrome_WidgetWin_1", title: `Window ${hwnd}`, rect, maximized: false, minimized: false, cloaked: false, tool: false, owned: false, placement: { showCmd: 1, flags: 0, normal: rect }, ...extra });

test("only real windows on Jarvis's monitor are picked", () => {
  const windows = [
    win(1, { l: 100, t: 100, r: 900, b: 700 }, { title: "Spotify Premium" }),
    win(2, { l: 100, t: 100, r: 900, b: 700 }, { pid: JARVIS_PID, title: "Jarvis" }),
    win(3, { l: 100, t: 100, r: 900, b: 700 }, { minimized: true }),
    win(4, { l: 100, t: 100, r: 900, b: 700 }, { cloaked: true }),
    win(5, { l: 100, t: 100, r: 900, b: 700 }, { tool: true }),
    win(6, { l: 0, t: 1032, r: 1920, b: 1080 }, { cls: "Shell_TrayWnd", title: "taskbar" }),
    win(7, { l: -1500, t: 300, r: -500, b: 900 }, { title: "Already on the other monitor" }),
    win(8, { l: 100, t: 100, r: 900, b: 700 }, { title: "" }),
    win(9, { l: 100, t: 100, r: 900, b: 700 }, { owned: true })
  ];
  const picked = windowsToMove({ windows, monitors: [MAIN, LEFT], jarvisMonitorId: 1, jarvisPid: JARVIS_PID });
  assert.deepEqual(picked.map((w) => w.hwnd), [1]);
  assert.equal(monitorOf({ l: -1500, t: 300, r: -500, b: 900 }, [MAIN, LEFT]).id, 2);
});

test("windows go to the largest other monitor, keeping their spot and fitting inside", () => {
  assert.equal(pickTarget([MAIN, SMALL, LEFT], 1).id, 2, "the 1920x1080 one beats the 1280x720 one");
  assert.equal(pickTarget([MAIN], 1), null);
  assert.deepEqual(placeOn({ l: 100, t: 50, r: 900, b: 650 }, MAIN.work, LEFT.work), { l: -1820, t: 151, r: -1020, b: 751 });
  // Too big for the small monitor: shrunk to fit, pinned to its corner.
  assert.deepEqual(placeOn({ l: 200, t: 100, r: 1800, b: 1000 }, MAIN.work, SMALL.work), { l: 1920, t: 0, r: 3200, b: 680 });
  // Near the bottom-right: nudged back inside.
  assert.deepEqual(placeOn({ l: 1500, t: 900, r: 1900, b: 1030 }, MAIN.work, SMALL.work), { l: 2800, t: 550, r: 3200, b: 680 });
});

test("a plan moves normal and maximized windows, or explains why not", () => {
  const list = {
    monitors: [MAIN, LEFT],
    jarvisMonitor: 1,
    windows: [win(1, { l: 100, t: 100, r: 900, b: 700 }), win(2, { l: -8, t: -8, r: 1928, b: 1040 }, { maximized: true, placement: { showCmd: 3, flags: 0, normal: { l: 50, t: 50, r: 850, b: 650 } } })]
  };
  const plan = planMoves(list, JARVIS_PID);
  assert.equal(plan.moves.length, 2);
  // Maximized: moved by its normal rect, maximized again there, and remembered by it.
  assert.deepEqual(plan.moves[1], { hwnd: 2, title: "Window 2", maximize: true, rect: { l: -1870, t: 151, r: -1070, b: 751 }, original: { maximize: true, rect: { l: 50, t: 50, r: 850, b: 650 } } });
  assert.deepEqual(plan.moves[0].original, { maximize: false, rect: list.windows[0].rect });
  // A taskbar on top of the primary monitor shifts workspace coordinates.
  const topBar = { ...MAIN, work: { l: 0, t: 48, r: 1920, b: 1080 } };
  assert.deepEqual(normalRect(list.windows[1], [topBar, LEFT]), { l: 50, t: 98, r: 850, b: 698 });
  assert.equal(planMoves({ ...list, monitors: [MAIN] }, JARVIS_PID).note, "Only one monitor, so nothing was moved.");
});

test("bring-back leaves windows the user moved or closed", () => {
  const placed = { rect: { l: -1820, t: 151, r: -1020, b: 751 }, maximize: false };
  assert.equal(stillPlaced({ exists: true, rect: { l: -1815, t: 151, r: -1015, b: 751 } }, placed, [MAIN, LEFT]), true);
  assert.equal(stillPlaced({ exists: true, rect: { l: 300, t: 151, r: 1100, b: 751 } }, placed, [MAIN, LEFT]), false);
  assert.equal(stillPlaced({ exists: false }, placed, [MAIN, LEFT]), false);
  assert.equal(stillPlaced({ exists: true, maximized: true, rect: { l: -1928, t: 93, r: 8, b: 1141 } }, { rect: LEFT.work, maximize: true }, [MAIN, LEFT]), true);
});

// A fake helper that keeps an in-memory desktop.
function fakeHelper(list) {
  const calls = [];
  const states = new Map(list.windows.map((w) => [w.hwnd, { hwnd: w.hwnd, exists: true, maximized: w.maximized, rect: w.rect }]));
  return {
    calls,
    states,
    stopped: false,
    async request(command) {
      calls.push(command);
      if (command.op === "list") return { ok: true, ...list };
      if (command.op === "place") return { ok: true, states: command.moves.map((m) => (states.set(m.hwnd, { hwnd: m.hwnd, exists: true, maximized: m.maximize, rect: m.rect }), states.get(m.hwnd))) };
      if (command.op === "state") return { ok: true, states: command.hwnds.map((h) => states.get(h) || { hwnd: h, exists: false }) };
      if (command.op === "restore") return { ok: true, states: command.windows.map((w) => (states.set(w.hwnd, { hwnd: w.hwnd, exists: true, maximized: w.maximize, rect: w.rect }), states.get(w.hwnd))) };
      return { ok: false, error: "unknown" };
    },
    stop() { this.stopped = true; }
  };
}

test("focus moves windows away and brings back only the untouched ones", async () => {
  const list = { monitors: [MAIN, LEFT], jarvisMonitor: 1, windows: [win(1, { l: 100, t: 100, r: 900, b: 700 }), win(2, { l: 200, t: 200, r: 1000, b: 800 }), win(3, { l: 300, t: 300, r: 1100, b: 900 })] };
  const helper = fakeHelper(list);
  const mover = createWindowMover({ platform: "win32", helper, log: () => {} });
  assert.deepEqual(await mover.moveAway({ hwnd: 999, pid: JARVIS_PID }), { moved: 3, note: "" });
  assert.equal(helper.calls[0].jarvis, 999);
  assert.equal(monitorOf(helper.states.get(1).rect, [MAIN, LEFT]).id, 2);

  helper.states.set(2, { hwnd: 2, exists: true, maximized: false, rect: { l: 50, t: 50, r: 850, b: 650 } }); // dragged back by hand
  helper.states.delete(3); // closed
  assert.deepEqual(await mover.bringBack(), { restored: 1 });
  assert.deepEqual(helper.states.get(1).rect, { l: 100, t: 100, r: 900, b: 700 });
  assert.deepEqual(helper.states.get(2).rect, { l: 50, t: 50, r: 850, b: 650 }, "left where the user put it");
  assert.deepEqual(await mover.bringBack(), { restored: 0 }, "nothing left to restore");
  mover.dispose();
  assert.equal(helper.stopped, true);
});

test("windows that open or come back during focus are moved too, and stay there afterwards", async () => {
  const list = {
    monitors: [MAIN, LEFT],
    jarvisMonitor: 1,
    windows: [win(1, { l: 100, t: 100, r: 900, b: 700 }), win(5, { l: 100, t: 100, r: 900, b: 700 }, { title: "Spotify", minimized: true })]
  };
  const helper = fakeHelper(list);
  const mover = createWindowMover({ platform: "win32", helper, log: () => {}, watchMs: 0 });
  assert.deepEqual(await mover.moveAway({ hwnd: 999, pid: JARVIS_PID }), { moved: 1, note: "" });

  // Mid-session: a new app opens, Spotify is restored from the taskbar, and
  // window 1 is dragged back onto Jarvis's monitor on purpose.
  list.windows.push(win(4, { l: 400, t: 300, r: 1200, b: 900 }, { title: "Notepad" }));
  list.windows[1] = { ...list.windows[1], minimized: false };
  list.windows[0] = { ...list.windows[0], rect: { l: 100, t: 100, r: 900, b: 700 } };
  assert.deepEqual(await mover.sweep(), { moved: 2 });
  assert.equal(monitorOf(helper.states.get(4).rect, [MAIN, LEFT]).id, 2);
  assert.equal(monitorOf(helper.states.get(5).rect, [MAIN, LEFT]).id, 2);
  const placed = helper.calls.filter((call) => call.op === "place").at(-1);
  assert.deepEqual(placed.moves.map((move) => move.hwnd), [5, 4], "window 1 was already moved once and is left alone");
  assert.deepEqual(await mover.sweep(), { moved: 0 }, "nothing new");
  assert.equal(mover.moved(), 3);

  assert.deepEqual(await mover.bringBack(), { restored: 1 });
  const restored = helper.calls.filter((call) => call.op === "restore").at(-1);
  assert.deepEqual(restored.windows.map((entry) => entry.hwnd), [1], "only windows that were open at the start go back");
  assert.equal(monitorOf(helper.states.get(4).rect, [MAIN, LEFT]).id, 2);

  // After focus ends, new windows are left where Windows puts them.
  list.windows.push(win(6, { l: 100, t: 100, r: 900, b: 700 }));
  const before = helper.calls.length;
  assert.deepEqual(await mover.sweep(), { moved: 0 });
  assert.equal(helper.calls.length, before);
  mover.dispose();
});

test("the watch runs on its own during focus and stops when focus ends", async () => {
  const list = { monitors: [MAIN, LEFT], jarvisMonitor: 1, windows: [] };
  const helper = fakeHelper(list);
  const mover = createWindowMover({ platform: "win32", helper, log: () => {}, watchMs: 5 });
  await mover.moveAway({ hwnd: 999, pid: JARVIS_PID });
  list.windows.push(win(7, { l: 100, t: 100, r: 900, b: 700 }));
  for (let tries = 0; tries < 100 && !helper.states.has(7); tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(monitorOf(helper.states.get(7).rect, [MAIN, LEFT]).id, 2, "moved without being asked");
  await mover.bringBack();
  const after = helper.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(helper.calls.length, after, "no more listing once focus is over");
  mover.dispose();
});

test("failures never break focus mode, and other platforms do nothing", async () => {
  const broken = { request: async () => { throw new Error("no powershell"); }, stop() {} };
  const logged = [];
  const mover = createWindowMover({ platform: "win32", helper: broken, log: (...args) => logged.push(args.join(" ")) });
  assert.deepEqual(await mover.moveAway({ hwnd: 1, pid: 1 }), { moved: 0, note: "Couldn't move your other windows." });
  assert.match(logged[0], /no powershell/);
  const mac = createWindowMover({ platform: "darwin", helper: fakeHelper({ monitors: [], windows: [] }) });
  assert.equal(mac.supported, false);
  assert.deepEqual(await mac.moveAway({ hwnd: 1, pid: 1 }), { moved: 0, note: "" });
});

test("the helper protocol: ready line, then one answer per request in order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-helper-"));
  try {
    const script = join(dir, "echo.mjs");
    await writeFile(script, `
      import { createInterface } from "node:readline";
      console.log(JSON.stringify({ ready: true }));
      createInterface({ input: process.stdin }).on("line", (line) => {
        const command = JSON.parse(line);
        setTimeout(() => console.log(JSON.stringify({ ok: true, echo: command.n })), command.delay || 0);
      });
    `);
    const helper = new LineHelper({ command: process.execPath, args: [script], timeoutMs: 5000 });
    const [a, b] = await Promise.all([helper.request({ n: 1 }), helper.request({ n: 2 })]);
    assert.deepEqual([a.echo, b.echo], [1, 2]);
    helper.stop();
    // A generous timeout so only the reply is late, even on a busy machine.
    const slow = new LineHelper({ command: process.execPath, args: [script], timeoutMs: 2000 });
    await assert.rejects(slow.request({ n: 3, delay: 30_000 }), /didn't answer/);
    slow.stop();

    // A helper that never says it's ready is killed, not left running: its
    // pipes would otherwise keep this process alive for good.
    const spawned = [];
    const stuck = new LineHelper({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 400,
      spawnImpl: (...args) => {
        const child = spawn(...args);
        spawned.push(child);
        return child;
      }
    });
    await assert.rejects(stuck.request({ n: 4 }), /didn't start/);
    await new Promise((resolve) => spawned[0].once("exit", resolve));
    assert.equal(spawned[0].killed, true);
  } finally {
    await removeTempDir(dir);
  }
});
