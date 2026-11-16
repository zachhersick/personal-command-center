import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeConfigPaths } from "../server/platform.js";
import { startServer } from "../server.js";
import { createCloudApp } from "../server/cloud/app.js";
import { MemoryStore } from "../server/cloud/store.js";
import { normalizeCloudUrl, trimBoard } from "../server/cloud-sync.js";
import { createSession } from "../server/cloud/auth.js";
import { removeTempDir } from "./helpers.js";

const SECRET = "t".repeat(40);

test("cloud URLs must be https (localhost allowed for development)", () => {
  assert.equal(normalizeCloudUrl("https://jarvis.example.com/settings"), "https://jarvis.example.com");
  assert.equal(normalizeCloudUrl("http://jarvis.example.com"), "");
  assert.equal(normalizeCloudUrl("http://localhost:4320"), "http://localhost:4320");
  assert.equal(normalizeCloudUrl("not a url"), "");
});

test("the phone's agent board carries status, not transcripts", () => {
  const board = trimBoard({ counts: { working: 1 }, slots: { used: 1, max: 3 }, sessions: [{ id: "a", runId: "r1", taskId: "w3-build0", taskTitle: "Add search", provider: "claude", model: "opus", effort: "high", effectiveModel: "reported-model", settingsDiffer: true, title: "Fix", status: "working", project: { name: "Jarvis" }, request: { prompt: "queued prompt" }, recent: Array.from({ length: 9 }, (_, i) => ({ kind: "command", title: `cmd ${i}`, detail: "secret output" })) }] });
  assert.deepEqual(board.slots, { used: 1, max: 3 });
  assert.deepEqual([board.sessions[0].runId, board.sessions[0].taskId, board.sessions[0].taskTitle], ["r1", "w3-build0", "Add search"]);
  assert.equal(board.sessions[0].request, undefined);
  assert.equal(board.sessions[0].project, "Jarvis");
  assert.equal(board.sessions[0].model, "opus");
  assert.equal(board.sessions[0].effort, "high");
  assert.equal(board.sessions[0].effectiveModel, "reported-model");
  assert.equal(board.sessions[0].settingsDiffer, true);
  assert.equal(board.sessions[0].recent.length, 5);
  assert.equal(JSON.stringify(board).includes("secret output"), false);
});

test("a desktop and the cloud sync plan changes both ways", async () => {
  const keys = ["JARVIS_SHARED_DIR", "JARVIS_PLAN_NOW", "JARVIS_CLAUDE_HOME", "JARVIS_CODEX_HOME"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const root = await mkdtemp(join(tmpdir(), "jarvis-cloud-sync-"));
  process.env.JARVIS_SHARED_DIR = join(root, "shared");
  process.env.JARVIS_PLAN_NOW = "2026-10-18T17:00:00.000Z";
  process.env.JARVIS_CLAUDE_HOME = join(root, "claude");
  process.env.JARVIS_CODEX_HOME = join(root, "codex");

  // Cloud
  const store = new MemoryStore();
  const appUrl = "http://127.0.0.1";
  const cloudEnv = { APP_URL: appUrl, SESSION_SECRET: SECRET, ALLOWED_GITHUB_ID: "1", GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: "y" };
  const cloud = createCloudApp({ store, env: cloudEnv, resourceRoot: process.cwd() });
  const cloudServer = createServer((req, res) => cloud.handle(req, res));
  await new Promise((resolve) => cloudServer.listen(0, "127.0.0.1", resolve));
  const cloudUrl = `http://127.0.0.1:${cloudServer.address().port}`;
  const cookie = `jarvis_session=${createSession({ id: 1, login: "zach" }, SECRET)}`;
  const web = (path, body) => fetch(`${cloudUrl}${path}`, { method: body ? "POST" : "GET", headers: { cookie, origin: appUrl, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }).then((response) => response.json());

  // Desktop
  const dataRoot = join(root, "app");
  await mkdir(join(dataRoot, "config"), { recursive: true });
  await mkdir(join(dataRoot, "data"), { recursive: true });
  const config = normalizeConfigPaths(JSON.parse(await readFile(join(process.cwd(), "config", "jarvis.config.json"), "utf8")), { baseDir: process.cwd() });
  await writeFile(join(dataRoot, "config", "jarvis.config.json"), JSON.stringify(config));
  const desktop = await startServer({ host: "127.0.0.1", port: 0, dataRoot });
  const local = (path, body) => fetch(`http://127.0.0.1:${desktop.port}${path}`, { method: body ? "POST" : "GET", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }).then(async (response) => ({ status: response.status, ...(await response.json()) }));

  try {
    const { token } = await web("/api/devices", { name: "Test PC" });
    assert.equal((await local("/api/cloud/connect", { url: cloudUrl, token: "jvs_not-a-real-token-at-all-000" })).status, 400, "a bad token is rejected and not saved");
    assert.equal(existsSync(join(dataRoot, "config", "cloud-sync.local.json")), false);

    const connected = await local("/api/cloud/connect", { url: cloudUrl, token });
    assert.equal(connected.configured, true);
    assert.equal(connected.device, "Test PC");
    assert.ok(existsSync(join(dataRoot, "config", "cloud-sync.local.json")));

    // Desktop -> cloud
    await local("/api/plan/tasks/patch", { id: "w1-study0", done: true });
    await local("/api/cloud/sync", {});
    assert.equal((await web("/api/plan/task?id=w1-study0")).task.done, true);

    // Cloud (phone) -> desktop
    await web("/api/plan/tasks/patch", { id: "w1-study1", date: "2026-10-21" });
    const status = await local("/api/cloud/sync", {});
    assert.equal(status.lastError, "");
    assert.equal((await local("/api/plan/task?id=w1-study1")).task.date, "2026-10-21");
    assert.equal((await local("/api/plan/task?id=w1-study0")).task.done, true, "local change survives the merge");

    // Phone -> desktop agents: refused until the desktop turns it on.
    const start = { type: "start", projectId: "not-a-project", provider: "claude", prompt: "Explain server.js", mode: "plan" };
    await local("/api/cloud/sync", {});
    assert.match((await web("/api/agents/commands", start)).error, /isn't accepting/);
    assert.equal((await local("/api/cloud/phone-agents", { enabled: true })).phoneAgents, true);
    await local("/api/cloud/sync", {});
    const board = (await web("/api/agents/board")).board;
    assert.equal(board.remote.enabled, true);
    assert.ok(Array.isArray(board.remote.projects));
    const sent = (await web("/api/agents/commands", start)).command;
    assert.equal(sent.status, "pending");
    // One push picks it up and runs it; the next one reports the outcome.
    await local("/api/cloud/sync", {});
    await local("/api/cloud/sync", {});
    const answered = (await web("/api/agents/commands")).commands.find((command) => command.id === sent.id);
    assert.equal(answered.status, "failed");
    assert.match(answered.error, /Project not found/);
    assert.equal((await local("/api/cloud/phone-agents", { enabled: false })).phoneAgents, false);
    await local("/api/cloud/sync", {});
    assert.equal((await web("/api/agents/board")).board.remote.enabled, false);

    const disconnected = await local("/api/cloud/disconnect", {});
    assert.equal(disconnected.configured, false);
    assert.equal(existsSync(join(dataRoot, "config", "cloud-sync.local.json")), false);
  } finally {
    await new Promise((resolve) => desktop.server.close(resolve));
    await new Promise((resolve) => cloudServer.close(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeTempDir(root);
  }
});
