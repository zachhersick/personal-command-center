import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentsApi } from "../server/agents/routes.js";
import { removeTempDir } from "./helpers.js";

test("dashboard requests preserve settings through runs, follow-ups, loops and reviews", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-agent-controls-"));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "math.js"), "export const add = (a, b) => a - b;\n");
  execFileSync("git", ["add", "math.js"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  const api = createAgentsApi({
    dataRoot: () => root,
    loadConfig: async () => ({ agents: { timeoutMinutes: 1 }, workspace: { projects: [{ id: "test", path: repo }] } }),
    env: { JARVIS_CLAUDE_HOME: join(root, "claude"), JARVIS_CODEX_HOME: join(root, "codex") },
    sendJson: (res, body, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
  });
  const seen = [];
  api.launcher.inspect = async () => ({ ready: true, version: "fixture", models: [{ id: "", efforts: [] }, { id: "test-model", efforts: ["high"] }] });
  api.launcher.commandFor = (provider, options) => {
    seen.push({ provider, model: options.model, effort: options.effort, mode: options.mode });
    return { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url)), provider, ...(options.sessionId ? ["--resume", options.sessionId] : [])], cwd: options.worktree };
  };
  const server = createServer((req, res) => api.handle(req, res, new URL(req.url, "http://localhost")));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const post = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/agents/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  const finish = async (id) => { await api.launcher.active.get(id)?.done; return api.launcher.get(id); };
  try {
    const choices = { model: "test-model", effort: "high" };
    const started = await post("runs", { projectId: "test", provider: "claude", prompt: "inspect", mode: "plan", ...choices });
    assert.equal(started.status, 200);
    const run = await finish(started.runId);
    assert.equal(run.status, "idle");
    assert.equal((await post("runs/message", { id: run.id, text: "explain", mode: "plan" })).status, 200);
    await finish(run.id);
    assert.equal(run.turns.length, 2);
    assert.equal((await post("runs/review", { id: run.id, provider: "codex", model: "bad" })).status, 400);
    assert.equal(run.outcome, null, "invalid reviews do not keep/commit the original run");
    const reviewed = await post("runs/review", { id: run.id, provider: "codex", ...choices });
    assert.equal(reviewed.status, 200);
    const review = await finish(reviewed.runId);
    assert.equal(review.kind, "review");
    assert.equal(review.mode, "plan");
    assert.equal(review.reviewOf, run.id);
    assert.equal(run.outcome, "kept");
    const looping = await post("runs", { projectId: "test", provider: "codex", prompt: "inspect", ...choices, loop: { check: 'node -e "process.exit(0)"', maxIterations: 1 } });
    assert.equal(looping.status, 200);
    await api.launcher.loops.get(looping.runId).done;
    assert.equal(api.launcher.get(looping.runId).loop.status, "passed");
    assert.ok(seen.length >= 4);
    assert.ok(seen.every((entry) => entry.model === "test-model" && entry.effort === "high"));
    for (const entry of api.launcher.list()) assert.equal((await post("runs/discard", { id: entry.id })).status, 200);
    assert.equal(api.launcher.occupied(), 0);
  } finally {
    api.shutdown();
    await Promise.all([...api.launcher.active.values(), ...api.launcher.loops.values()].map((handle) => handle.done));
    await api.launcher.flush();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await removeTempDir(root);
  }
});

test("a full board queues runs, starts them in order as slots free, and keeps their ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-agent-queue-"));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "math.js"), "export const add = (a, b) => a - b;\n");
  execFileSync("git", ["add", "math.js"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: repo });
  let projects = [{ id: "test", path: repo }];
  const deps = {
    dataRoot: () => root,
    loadConfig: async () => ({ agents: { timeoutMinutes: 1, maxConcurrent: 1 }, workspace: { projects } }),
    env: { JARVIS_CLAUDE_HOME: join(root, "claude"), JARVIS_CODEX_HOME: join(root, "codex") },
    sendJson: (res, body, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
  };
  const fake = (api) => {
    api.launcher.inspect = null;
    api.launcher.commandFor = (provider, options) => ({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url)), provider], cwd: options.worktree });
  };
  let api = createAgentsApi(deps);
  fake(api);
  const started = (id) => new Promise((resolve) => {
    const check = () => { if (api.launcher.runs.get(id)?.status !== "queued") { api.launcher.off("change", check); resolve(api.launcher.get(id)); } };
    api.launcher.on("change", check);
    check();
  });
  try {
    const busy = await api.startOrQueue(api.startRequest({ projectId: "test", provider: "claude", prompt: "SLEEP" }), { queue: true });
    assert.equal(busy.queued, false);
    // Without asking to queue, a full board still refuses.
    await assert.rejects(() => api.startOrQueue(api.startRequest({ projectId: "test", provider: "claude", prompt: "late" })), (error) => error.status === 409);
    const first = await api.startOrQueue(api.startRequest({ projectId: "test", provider: "claude", prompt: "first", taskId: "w3-build0", taskTitle: "Build the thing" }), { queue: true });
    const second = await api.startOrQueue(api.startRequest({ projectId: "test", provider: "codex", prompt: "second" }), { queue: true });
    const doomed = await api.startOrQueue(api.startRequest({ projectId: "gone-later", provider: "claude", prompt: "x" }), { queue: true }).catch((error) => error);
    assert.equal(doomed.status, 404, "an unknown project is refused up front, not queued");
    assert.deepEqual([first.queued, first.position, second.position], [true, 1, 2]);
    assert.equal(api.launcher.get(first.run.id).status, "queued");
    assert.equal(api.launcher.get(first.run.id).worktree, undefined, "no worktree until it starts");
    const board = await api.registry.snapshot();
    assert.equal(board.counts.queued, 2);
    assert.deepEqual(board.slots, { used: 1, max: 1 });
    assert.match(board.sessions.find((session) => session.runId === second.run.id).waitingFor, /#2/);
    await assert.rejects(() => api.launcher.message(first.run.id, "hi"), (error) => error.status === 409);

    // A restart keeps the queue.
    api.shutdown();
    await api.launcher.active.get(busy.run.id)?.done;
    // The stopped turn's last save has to land before a second launcher reads the file.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await api.launcher.flush();
    api = createAgentsApi(deps);
    fake(api);
    await api.launcher.load();
    assert.equal(api.launcher.get(busy.run.id).status, "stopped");
    const run = await started(first.run.id);
    assert.equal(run.id, first.run.id);
    assert.equal(run.taskId, "w3-build0");
    assert.ok(run.worktree, "it got a worktree when it started");
    await api.launcher.active.get(run.id)?.done;
    const next = await started(second.run.id);
    assert.equal(next.provider, "codex");

    // A queued run that can no longer start fails on its own card, and cancel removes one.
    await api.launcher.active.get(next.id)?.done;
    const blocker = await api.startOrQueue(api.startRequest({ projectId: "test", provider: "claude", prompt: "SLEEP" }), { queue: true });
    const broken = await api.startOrQueue(api.startRequest({ projectId: "test", provider: "claude", prompt: "broken" }), { queue: true });
    const cancelled = await api.startOrQueue(api.startRequest({ projectId: "test", provider: "claude", prompt: "cancel me" }), { queue: true });
    api.launcher.cancelQueued(cancelled.run.id);
    assert.throws(() => api.launcher.get(cancelled.run.id), /not found/);
    projects = [];
    api.launcher.stop(blocker.run.id);
    await api.launcher.active.get(blocker.run.id)?.done;
    const failed = await started(broken.run.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /Project not found/);
  } finally {
    api.shutdown();
    await Promise.all([...api.launcher.active.values(), ...api.launcher.loops.values()].map((handle) => handle.done));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await api.launcher.flush();
    await removeTempDir(root);
  }
});
