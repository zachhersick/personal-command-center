import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeConfigPaths } from "../server/platform.js";
import { startServer } from "../server.js";
import { removeTempDir } from "./helpers.js";

async function withServer(fn) {
  const previous = { shared: process.env.JARVIS_SHARED_DIR, now: process.env.JARVIS_PLAN_NOW };
  const root = await mkdtemp(join(tmpdir(), "jarvis-update-api-"));
  process.env.JARVIS_SHARED_DIR = join(root, "shared");
  process.env.JARVIS_PLAN_NOW = "2026-10-18T17:00:00.000Z";
  const dataRoot = join(root, "app");
  await mkdir(join(dataRoot, "config"), { recursive: true });
  await mkdir(join(dataRoot, "data"), { recursive: true });
  const config = normalizeConfigPaths(JSON.parse(await readFile(join(process.cwd(), "config", "jarvis.config.json"), "utf8")), { baseDir: process.cwd() });
  await writeFile(join(dataRoot, "config", "jarvis.config.json"), JSON.stringify(config));
  const handle = await startServer({ host: "127.0.0.1", port: 0, dataRoot });
  try {
    return await fn(`http://${handle.host}:${handle.port}`);
  } finally {
    await new Promise((resolve) => handle.server.close(resolve));
    delete globalThis.jarvisDesktopActions;
    if (previous.shared === undefined) delete process.env.JARVIS_SHARED_DIR;
    else process.env.JARVIS_SHARED_DIR = previous.shared;
    if (previous.now === undefined) delete process.env.JARVIS_PLAN_NOW;
    else process.env.JARVIS_PLAN_NOW = previous.now;
    await removeTempDir(root);
  }
}

const post = (url, body = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("update routes need the desktop app", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/app/update`);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).desktop, false);
  });
});

test("update routes relay to the desktop updater and wait for focus sessions", async () => {
  await withServer(async (base) => {
    const calls = [];
    const status = { state: "available", currentVersion: "0.3.1", latest: { version: "0.3.2", tag: "v0.3.2" }, available: true };
    globalThis.jarvisDesktopActions = {
      updateStatus: () => status,
      checkForUpdates: async () => { calls.push("check"); return status; },
      skipUpdate: async (version) => { calls.push(`skip:${version}`); return { ...status, skippedThis: true }; },
      installUpdate: async () => { calls.push("install"); return { ...status, state: "installing" }; }
    };
    assert.equal((await (await fetch(`${base}/api/app/update`)).json()).latest.version, "0.3.2");
    assert.equal((await (await post(`${base}/api/app/update/check`)).json()).state, "available");
    assert.equal((await (await post(`${base}/api/app/update/skip`, { version: "0.3.2" })).json()).skippedThis, true);

    // A running focus session blocks a plain install…
    assert.equal((await post(`${base}/api/focus/start`, { plannedMinutes: 25, mode: "countdown", label: "Deep work" })).status, 200);
    const blocked = await post(`${base}/api/app/update/install`);
    assert.equal(blocked.status, 409);
    assert.deepEqual((await blocked.json()).blocked, ["A focus session is running"]);
    assert.ok(!calls.includes("install"));

    // …and "Update anyway" goes through.
    const forced = await post(`${base}/api/app/update/install`, { force: true });
    assert.equal(forced.status, 200);
    assert.equal((await forced.json()).state, "installing");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(calls, ["check", "skip:0.3.2", "install"]);
  });
});
