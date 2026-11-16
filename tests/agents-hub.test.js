import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentsApi } from "../server/agents/routes.js";
import { columnFor, runSession } from "../server/agents/registry.js";
import { createPrWatcher, failurePrompt, summarizePr } from "../server/agents/pr-status.js";
import { createRemoteAgents } from "../server/agents/remote.js";
import { trimBoard } from "../server/cloud-sync.js";
import { awaitingApproval, boardColumns, columnOf, conversationItems, parseDiff, prLabel, retryPrompt, threadGroups } from "../public/app/agents/logic.js";
import { removeTempDir } from "./helpers.js";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));

// A real repo with a bare remote, the fake agent, and a stubbed gh.
async function withHub(fn, { maxConcurrent = 3, gh = async () => ({ ok: true, stdout: "", stderr: "" }) } = {}) {
  const root = await mkdtemp(join(tmpdir(), "jarvis-agents-hub-"));
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  await writeFile(join(repo, "math.js"), "export const add = (a, b) => a - b;\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo });
  const seen = [];
  const deps = {
    dataRoot: () => root,
    loadConfig: async () => ({ agents: { timeoutMinutes: 1, maxConcurrent }, workspace: { projects: [{ id: "test", path: repo }] } }),
    env: { JARVIS_CLAUDE_HOME: join(root, "claude"), JARVIS_CODEX_HOME: join(root, "codex") },
    run: gh,
    sendJson: (res, body, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
  };
  const make = () => {
    const api = createAgentsApi(deps);
    api.launcher.inspect = null;
    api.launcher.commandFor = (provider, options) => {
      seen.push({ provider, mode: options.mode });
      return { command: process.execPath, args: [fakeAgent, provider, ...(options.sessionId ? ["--resume", options.sessionId] : [])], cwd: options.worktree };
    };
    return api;
  };
  const api = make();
  const server = createServer((req, res) => api.handle(req, res, new URL(req.url, "http://localhost")));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const call = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/agents/${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  // Waits out queued follow-ups too, since one turn can lead straight into the next.
  const settled = async (id) => {
    for (let handle = api.launcher.active.get(id); handle; handle = api.launcher.active.get(id)) await handle.done;
    return api.launcher.get(id);
  };
  try {
    await fn({ api, make, call, settled, seen, repo, remote, root, port: () => server.address().port });
  } finally {
    api.shutdown();
    await Promise.all([...api.launcher.active.values(), ...api.launcher.loops.values()].map((handle) => handle.done));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await api.launcher.flush();
    await api.drafts.flush();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await removeTempDir(root);
  }
}

test("each run lands in the right board column", () => {
  const cases = [
    [{ status: "queued" }, "todo"],
    [{ status: "starting" }, "running"],
    [{ status: "working" }, "running"],
    [{ status: "checking" }, "running"],
    [{ status: "needs-you" }, "review"],
    [{ status: "failed", outcome: null }, "review"],
    [{ status: "stopped", outcome: null }, "review"],
    [{ status: "stopped", outcome: null, worktreeRemoved: true }, "done"],
    [{ status: "stopped", outcome: "kept" }, "done"],
    [{ status: "done", outcome: "kept" }, "done"],
    [{ status: "done", outcome: "discarded" }, "done"],
    [{ status: "done", outcome: "kept", prUrl: "u" }, "review"],
    [{ status: "done", outcome: "kept", prUrl: "u", pr: { state: "OPEN" } }, "review"],
    [{ status: "done", outcome: "kept", prUrl: "u", pr: { state: "MERGED" } }, "done"],
    [{ status: "done", outcome: "kept", prUrl: "u", pr: { state: "CLOSED" } }, "done"],
    [{ status: "needs-you", outcome: "kept", prUrl: "u", pr: { state: "MERGED" } }, "review"]
  ];
  for (const [session, column] of cases) assert.equal(columnFor(session), column, JSON.stringify(session));
});

test("a run record from before this version still gets a card", () => {
  const old = { id: "a", provider: "claude", status: "idle", outcome: null, title: "Old", repo: "/r", worktree: "/r/w", branch: "agent/x", events: [], turns: [], mode: "edit", kind: "task", tokens: 0, startedAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" };
  const session = runSession(old, []);
  assert.equal(session.column, "review");
  assert.equal(session.status, "needs-you");
  assert.deepEqual(session.pendingMessages, []);
  assert.equal(session.pr, null);
  assert.equal(session.unsaved, false);
});

test("uncommitted follow-up work and failing checks both ask for you", () => {
  const base = { id: "a", provider: "claude", status: "idle", outcome: "kept", title: "T", repo: "/r", worktree: "/r/w", events: [], turns: [], tokens: 0 };
  assert.equal(runSession(base, []).status, "done");
  const unsaved = runSession({ ...base, unsaved: true }, []);
  assert.equal(unsaved.status, "needs-you");
  assert.match(unsaved.waitingFor, /isn't committed/);
  assert.equal(runSession({ ...base, unsaved: true, worktreeRemoved: true }, []).status, "done");
  const failing = runSession({ ...base, prUrl: "u", pr: { state: "OPEN", checks: { failing: 2 } } }, []);
  assert.equal(failing.status, "needs-you");
  assert.match(failing.waitingFor, /2 checks failing/);
  assert.equal(failing.column, "review");
  assert.equal(runSession({ ...base, prUrl: "u", pr: { state: "MERGED", checks: { failing: 2 } } }, []).status, "done");
});

test("the board groups runs, drafts and outside sessions", () => {
  const run = (id, extra) => ({ id, origin: "jarvis", provider: "claude", updatedAt: "2026-11-01T00:00:00Z", ...extra });
  const data = {
    drafts: [{ id: "d", provider: "codex" }],
    sessions: [
      run("ready", { column: "review", status: "done", updatedAt: "2026-11-03T00:00:00Z" }),
      run("waiting", { column: "review", status: "needs-you" }),
      run("second", { column: "todo", status: "queued", queuedAt: "2026-11-02T00:00:00Z" }),
      run("first", { column: "todo", status: "queued", queuedAt: "2026-11-01T00:00:00Z" }),
      { id: "term", origin: "external", provider: "claude", status: "idle", updatedAt: "2026-11-04T00:00:00Z" },
      { id: "live", origin: "external", provider: "codex", status: "working", updatedAt: "2026-11-01T00:00:00Z" }
    ]
  };
  const { columns, drafts, outside } = boardColumns(data);
  assert.deepEqual(columns.review.map((session) => session.id), ["waiting", "ready"], "needs-you sorts first");
  assert.deepEqual(columns.todo.map((session) => session.id), ["first", "second"], "the queue keeps its order");
  assert.deepEqual(outside.map((session) => session.id), ["live", "term"], "outside sessions never join a column");
  assert.equal(drafts.length, 1);
  assert.deepEqual(boardColumns(data, "codex").drafts.map((draft) => draft.id), ["d"]);
  assert.equal(boardColumns(data, "codex").columns.review.length, 0);
  // A board from a desktop that hasn't updated yet has no column.
  assert.equal(columnOf({ status: "needs-you" }), "review");
  assert.equal(columnOf({ status: "queued" }), "todo");
  assert.equal(columnOf({ status: "failed" }), "done");

  // The sidebar splits review into what needs you and what's waiting on a PR.
  const groups = threadGroups(data);
  assert.deepEqual(groups.needs.map((session) => session.id), ["waiting"]);
  assert.deepEqual(groups.review.map((session) => session.id), ["ready"]);
  assert.deepEqual(groups.todo.map((session) => session.id), ["first", "second"]);
  assert.deepEqual(groups.outside.map((session) => session.id), ["live", "term"]);
  assert.equal(threadGroups(data, "codex").needs.length, 0);
});

test("the conversation folds tool calls and drops the repeated result", () => {
  const items = conversationItems([
    { kind: "prompt", title: "Fix it…", detail: "Fix it please", at: "a" },
    { kind: "command", title: "npm test" },
    { kind: "edit", title: "math.js" },
    { kind: "message", title: "Fixed add()." },
    { kind: "result", title: "Fixed add().", detail: "Fixed add().", ok: true },
    { kind: "prompt", title: "Now the docs" },
    { kind: "error", title: "Stopped", ok: false },
    { kind: "result", title: "Done", ok: true },
    { kind: "result", title: "All good", detail: "All good", ok: true }
  ]);
  assert.deepEqual(items.map((item) => item.type), ["you", "activity", "agent", "you", "error", "agent"]);
  assert.equal(items[0].text, "Fix it please", "the full text, not the shortened title");
  assert.equal(items[1].events.length, 2);
  assert.equal(items[5].text, "All good");
  assert.equal(retryPrompt(items, 0), "Fix it please");
  assert.match(retryPrompt(items, 1), /^Fix it please\n\nFollow-ups I gave on an earlier attempt:\n- Now the docs$/);
});

test("a unified diff splits by file", () => {
  const patch = [
    "diff --git a/src/a b.js b/src/a b.js", "index 1..2 100644", "--- a/src/a b.js", "+++ b/src/a b.js", "@@ -1 +1 @@", "-old", "+new", " same",
    "diff --git a/new.js b/new.js", "new file mode 100644", "--- /dev/null", "+++ b/new.js", "@@ -0,0 +1 @@", "+--x"
  ].join("\n");
  const files = parseDiff(patch);
  assert.deepEqual(files.map((file) => file.path), ["src/a b.js", "new.js"]);
  assert.deepEqual(files[0].lines.map((line) => line.kind), ["hunk", "del", "add", ""]);
  assert.deepEqual(files[1].lines.map((line) => line.text), ["@@ -0,0 +1 @@", "+--x"]);
  assert.deepEqual(parseDiff(""), []);
});

test("a PR's status reads the same from either kind of check", () => {
  const summary = summarizePr({ state: "OPEN", isDraft: false, reviewDecision: "APPROVED", statusCheckRollup: [
    { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "skip", status: "COMPLETED", conclusion: "SKIPPED" },
    { name: "mac", status: "IN_PROGRESS", conclusion: "" },
    { name: "win", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/o/r/actions/runs/123/job/4" },
    { context: "deploy", state: "ERROR", targetUrl: "https://x.test" },
    { context: "lint", state: "PENDING" },
    { context: "ok", state: "SUCCESS" }
  ] });
  assert.deepEqual([summary.checks.passing, summary.checks.failing, summary.checks.pending], [3, 2, 2]);
  assert.deepEqual(summary.checks.failed.map((check) => check.name), ["win", "deploy"]);
  assert.equal(summary.review, "APPROVED");
  assert.deepEqual(summarizePr({}).checks.failed, []);

  assert.equal(prLabel(summary).tone, "danger");
  assert.equal(prLabel(null).text, "PR open");
  assert.equal(prLabel({ state: "MERGED", checks: { failing: 3 } }).text, "Merged");
  assert.equal(prLabel({ state: "CLOSED" }).text, "PR closed");
  assert.equal(prLabel({ state: "OPEN", review: "CHANGES_REQUESTED", checks: {} }).text, "Changes requested");
  assert.equal(prLabel({ state: "OPEN", checks: { pending: 1, passing: 1 } }).text, "Checks running");
  assert.equal(prLabel({ state: "OPEN", checks: { passing: 2 } }).text, "Checks passing");
});

test("only open PRs get looked at, and a failed look keeps what was known", async () => {
  const runs = [
    { id: "open", prUrl: "u/open", repo: "/r" },
    { id: "merged", prUrl: "u/merged", repo: "/r", pr: { state: "MERGED" } },
    { id: "none", repo: "/r" }
  ];
  const changes = [];
  const launcher = { list: () => runs, setPr: (run, pr) => { run.pr = pr; changes.push(run.id); } };
  const asked = [];
  let answer = { ok: true, stdout: JSON.stringify({ state: "OPEN", statusCheckRollup: [{ name: "t", conclusion: "SUCCESS" }] }) };
  let watched = false;
  const watcher = createPrWatcher({ launcher, run: async (command, args) => { asked.push(args[2]); return answer; }, isWatched: () => watched });
  await watcher.tick();
  assert.deepEqual(asked, [], "nobody's watching, so no gh calls");
  watched = true;
  await watcher.tick();
  assert.deepEqual(asked, ["u/open"]);
  assert.equal(runs[0].pr.checks.passing, 1);
  answer = { ok: false, stdout: "", stderr: "gh: network down" };
  await watcher.tick();
  assert.equal(runs[0].pr.checks.passing, 1, "the last result stays");
  assert.equal(runs[0].pr.error, "gh: network down");
  answer = { ok: true, stdout: "not json" };
  await watcher.tick();
  assert.equal(runs[0].pr.checks.passing, 1);
  assert.match(runs[0].pr.error, /unreadable/);
  answer = { ok: true, stdout: JSON.stringify({ state: "MERGED" }) };
  await watcher.tick();
  assert.equal(runs[0].pr.error, "");
  asked.length = 0;
  await watcher.tick();
  assert.deepEqual(asked, [], "merged now, so it stops looking");
  // No gh available at all is a quiet no-op.
  const silent = createPrWatcher({ launcher, run: undefined });
  await silent.tick();
  await silent.refresh(runs[0]);
});

test("opening the board looks at open PRs right away", async () => {
  const asked = [];
  const gh = async (command, args) => {
    asked.push(args[2]);
    return { ok: true, stdout: JSON.stringify({ state: "MERGED" }), stderr: "" };
  };
  await withHub(async ({ api, port }) => {
    const { run } = await api.startOrQueue(api.startRequest({ projectId: "test", provider: "claude", prompt: "x" }));
    await api.launcher.active.get(run.id)?.done;
    api.launcher.touch(run, { prUrl: "https://github.com/o/r/pull/1" });
    const controller = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${port()}/api/agents/stream`, { signal: controller.signal });
    const deadline = Date.now() + 5000;
    while (!run.pr && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await stream.body?.cancel().catch(() => {});
    assert.deepEqual(asked, ["https://github.com/o/r/pull/1"]);
    assert.equal(run.pr.state, "MERGED");
  }, { gh });
});

test("the fix prompt names failing checks and carries a capped log", async () => {
  const target = { repo: "/r", pr: { checks: { failed: [
    { name: "win", url: "https://github.com/o/r/actions/runs/123/job/1" },
    { name: "mac", url: "https://github.com/o/r/actions/runs/123/job/2" },
    { name: "deploy", url: "https://x.test" }
  ] } } };
  const asked = [];
  const prompt = await failurePrompt(target, async (command, args) => { asked.push(args); return { ok: true, stdout: `${"x".repeat(10_000)}END` }; });
  assert.deepEqual(asked, [["run", "view", "123", "--log-failed"]], "one log per workflow run");
  assert.match(prompt, /- win\n- mac\n- deploy/);
  assert.match(prompt, /END\n```/);
  assert.ok(prompt.length < 7000);
  assert.match(prompt, /Don't push/);
  assert.equal(await failurePrompt({ repo: "/r" }, async () => assert.fail("no checks, no call")), "");
  // A log that can't be fetched still leaves a usable prompt.
  assert.match(await failurePrompt(target, async () => ({ ok: false, stderr: "too big" })), /- win/);
});

test("drafts save, edit, survive a restart, and leave To do once started", async () => {
  await withHub(async ({ api, make, call, settled }) => {
    assert.equal((await call("drafts", { projectId: "test", provider: "claude", prompt: "   " })).status, 400);
    assert.equal((await call("drafts", { projectId: "test", provider: "nobody", prompt: "x" })).status, 400);
    assert.equal((await call("drafts", { projectId: "test", provider: "claude", prompt: "x", mode: "yolo" })).status, 400);
    assert.equal((await call("drafts", { projectId: "gone", provider: "claude", prompt: "x" })).status, 404);

    const { draft } = await call("drafts", { projectId: "test", provider: "codex", model: "m", mode: "plan", prompt: "Look into the search bug and report back to me today", taskId: "w3-build0", taskTitle: "Build", loop: { check: "npm test", maxIterations: 3 } });
    assert.equal(draft.title, "Look into the search bug and");
    assert.deepEqual(draft.loop, { check: "npm test", maxIterations: 3 });
    const edited = (await call("drafts", { id: draft.id, projectId: "test", provider: "claude", mode: "plan", prompt: "Edited", title: "My title", taskId: "w3-build0", taskTitle: "Build" })).draft;
    assert.equal(edited.id, draft.id);
    assert.equal(edited.createdAt, draft.createdAt);
    assert.equal(edited.title, "My title");
    assert.equal(edited.loop, null);
    assert.equal((await call("drafts", { id: "missing", projectId: "test", provider: "claude", prompt: "x" })).status, 404);

    assert.deepEqual((await api.registry.snapshot()).drafts.map((entry) => entry.id), [draft.id]);
    await api.drafts.flush();
    const reloaded = make();
    await reloaded.drafts.load();
    assert.equal(reloaded.drafts.list()[0].prompt, "Edited");
    reloaded.shutdown();

    const started = await call("drafts/start", { id: draft.id });
    assert.equal(started.status, 200);
    const run = await settled(started.runId);
    assert.equal(run.mode, "plan");
    assert.equal(run.taskId, "w3-build0");
    assert.equal(run.title, "My title");
    assert.deepEqual(api.drafts.list(), []);
    assert.equal((await call("drafts/start", { id: draft.id })).status, 404);

    const doomed = (await call("drafts", { projectId: "test", provider: "claude", prompt: "x" })).draft;
    assert.equal((await call("drafts/delete", { id: doomed.id })).status, 200);
    assert.deepEqual(api.drafts.list(), []);
  });
});

test("a draft that can't start stays in To do, and a full board queues it", async () => {
  await withHub(async ({ api, call, settled }) => {
    const { draft } = await call("drafts", { projectId: "test", provider: "claude", prompt: "x", base: "no-such-ref" });
    const failed = await call("drafts/start", { id: draft.id });
    assert.notEqual(failed.status, 200);
    assert.deepEqual(api.drafts.list().map((entry) => entry.id), [draft.id]);

    const busy = await call("runs", { projectId: "test", provider: "claude", prompt: "SLEEP" });
    const waiting = (await call("drafts", { projectId: "test", provider: "claude", prompt: "later" })).draft;
    const queued = await call("drafts/start", { id: waiting.id });
    assert.equal(queued.queued, true);
    assert.equal(api.launcher.get(queued.runId).status, "queued");
    assert.equal(api.drafts.list().some((entry) => entry.id === waiting.id), false);
    api.launcher.cancelQueued(queued.runId);
    api.launcher.stop(busy.runId);
    await settled(busy.runId);
  }, { maxConcurrent: 1 });
});

test("messages sent while a turn runs go out together when it ends", async () => {
  await withHub(async ({ api, call, settled, seen }) => {
    const { runId } = await call("runs", { projectId: "test", provider: "claude", prompt: "PAUSE then look" });
    const run = api.launcher.get(runId);
    const first = await call("runs/message", { id: runId, text: "Also check the docs", mode: "plan" });
    assert.deepEqual([first.status, first.queued], [200, true]);
    const removed = await call("runs/message", { id: runId, text: "Never mind this", mode: "plan" });
    assert.equal(removed.queued, true);
    const second = await call("runs/message", { id: runId, text: "And the README", mode: "edit" });
    assert.equal(second.queued, true);
    assert.equal(run.pendingMessages.length, 3);
    assert.equal((await api.registry.snapshot()).sessions.find((session) => session.runId === runId).pendingMessages.length, 3);

    assert.equal((await call("runs/message/remove", { id: runId, messageId: run.pendingMessages[1].id })).status, 200);
    assert.equal((await call("runs/message/remove", { id: runId, messageId: "nope" })).status, 404);
    assert.equal((await call("runs/message", { id: runId, text: "   " })).status, 400);

    await settled(runId);
    assert.equal(run.status, "idle");
    assert.equal(run.turns.length, 2);
    assert.deepEqual(run.pendingMessages, []);
    assert.equal(run.mode, "edit", "the last message's mode wins");
    assert.equal(seen.at(-1).mode, "edit");
    const prompts = run.events.filter((item) => item.kind === "prompt");
    assert.equal(prompts.at(-1).detail, "Also check the docs\n\nAnd the README");
    assert.equal(api.launcher.occupied(), 0);
  });
});

test("queued messages wait after a stop or a restart, and go out when you say", async () => {
  await withHub(async ({ api, make, call, settled }) => {
    const { runId } = await call("runs", { projectId: "test", provider: "claude", prompt: "SLEEP" });
    const run = api.launcher.get(runId);
    await call("runs/message", { id: runId, text: "Queued" });
    api.launcher.stop(runId);
    await settled(runId);
    assert.equal(run.status, "stopped");
    assert.equal(run.turns.length, 1, "a stopped turn doesn't send them");
    assert.equal(run.pendingMessages.length, 1);

    await api.launcher.flush();
    const reloaded = make();
    await reloaded.launcher.load();
    assert.equal(reloaded.launcher.get(runId).pendingMessages[0].text, "Queued");
    reloaded.shutdown();

    assert.equal((await call("runs/message", { id: runId, text: "" })).status, 200);
    await settled(runId);
    assert.equal(run.turns.length, 2);
    assert.deepEqual(run.pendingMessages, []);
    assert.equal(run.events.filter((item) => item.kind === "prompt").at(-1).detail, "Queued");
  });
});

test("a loop run refuses queued messages", async () => {
  await withHub(async ({ api, call }) => {
    const { runId } = await call("runs", { projectId: "test", provider: "codex", prompt: "x", loop: { check: 'node -e "setTimeout(() => {}, 60000)"', maxIterations: 1 } });
    const run = api.launcher.get(runId);
    const deadline = Date.now() + 10_000;
    while (run.status !== "checking" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    const refused = await call("runs/message", { id: runId, text: "hello" });
    assert.equal(refused.status, 409);
    assert.match(refused.error, /looping/);
    assert.equal(run.pendingMessages, undefined);
    api.stopRun(runId);
    await api.launcher.discard(runId);
  });
});

test("approving a plan runs the next turn in edit mode", async () => {
  await withHub(async ({ api, call, settled, seen }) => {
    const { runId } = await call("runs", { projectId: "test", provider: "claude", prompt: "plan it", mode: "plan" });
    await settled(runId);
    const planned = (await api.registry.snapshot()).sessions.find((session) => session.runId === runId);
    assert.equal(awaitingApproval(planned), true);
    assert.equal(seen.at(-1).mode, "plan");
    assert.equal((await call("runs/message", { id: runId, text: "Approved.", mode: "edit" })).queued, false);
    await settled(runId);
    assert.equal(api.launcher.get(runId).mode, "edit");
    assert.equal(seen.at(-1).mode, "edit");
    assert.equal(awaitingApproval((await api.registry.snapshot()).sessions.find((session) => session.runId === runId)), false);
    assert.equal(awaitingApproval({ origin: "jarvis", mode: "plan", kind: "review", status: "needs-you" }), false);
    assert.equal(awaitingApproval({ origin: "external", mode: "plan", kind: "task", status: "needs-you" }), false);
  });
});

test("a retry is a separate run from the original commit and leaves the first alone", async () => {
  await withHub(async ({ api, call, settled, repo }) => {
    const { runId } = await call("runs", { projectId: "test", provider: "claude", prompt: "FIX NOW", title: "First" });
    const original = await settled(runId);
    const before = JSON.stringify({ branch: original.branch, turns: original.turns.length, outcome: original.outcome, worktree: original.worktree });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "moved on"], { cwd: repo });

    const retried = await call("runs", { projectId: "test", provider: "claude", prompt: "Try again", title: "Retry: First", base: original.baseSha, retryOf: runId });
    const retry = await settled(retried.runId);
    assert.equal(retry.retryOf, runId);
    assert.equal(retry.baseSha, original.baseSha, "same starting point, not today's HEAD");
    assert.notEqual(retry.worktree, original.worktree);
    assert.notEqual(retry.branch, original.branch);
    assert.equal(JSON.stringify({ branch: original.branch, turns: original.turns.length, outcome: original.outcome, worktree: original.worktree }), before);
    assert.equal((await api.registry.snapshot()).sessions.find((session) => session.runId === retried.runId).retryOf, runId);
  });
});

test("fixes on a pull request get committed and pushed to its branch", async () => {
  const gh = async (command, args) => {
    if (args[0] === "run") return { ok: true, stdout: "boom", stderr: "" };
    if (args[1] === "create") return { ok: true, stdout: "https://github.com/o/r/pull/7", stderr: "" };
    if (args[1] === "view") return { ok: true, stdout: JSON.stringify({ state: "OPEN", statusCheckRollup: [{ name: "test", conclusion: "FAILURE", detailsUrl: "https://github.com/o/r/actions/runs/9/job/1" }] }), stderr: "" };
    return { ok: false, stderr: "unexpected" };
  };
  await withHub(async ({ api, call, settled, repo, remote }) => {
    const { runId } = await call("runs", { projectId: "test", provider: "claude", prompt: "FIX NOW" });
    const run = await settled(runId);
    assert.equal((await call("runs/push", { id: runId })).status, 409, "no PR yet");

    const opened = await call("runs/pr", { id: runId });
    assert.equal(opened.url, "https://github.com/o/r/pull/7");
    await call("runs/pr/refresh", { id: runId });
    assert.equal(run.pr.checks.failing, 1);
    let session = (await api.registry.snapshot()).sessions.find((entry) => entry.runId === runId);
    assert.equal(session.column, "review");
    assert.equal(session.status, "needs-you");

    const failures = await call(`runs/pr/failures?id=${runId}`);
    assert.match(failures.prompt, /- test/);
    assert.match(failures.prompt, /boom/);

    await writeFile(join(run.worktree, "fix.txt"), "fix\n");
    await call("runs/message", { id: runId, text: failures.prompt, mode: "edit" });
    await settled(runId);
    assert.equal(run.unsaved, true);
    assert.equal(run.outcome, "kept");
    session = (await api.registry.snapshot()).sessions.find((entry) => entry.runId === runId);
    assert.match(session.waitingFor, /isn't committed/);

    const pushed = await call("runs/push", { id: runId });
    assert.deepEqual([pushed.status, pushed.committed], [200, true]);
    assert.equal(run.unsaved, false);
    const local = execFileSync("git", ["rev-parse", run.branch], { cwd: repo, encoding: "utf8" }).trim();
    assert.equal(execFileSync("git", ["rev-parse", run.branch], { cwd: remote, encoding: "utf8" }).trim(), local);
    assert.match(execFileSync("git", ["show", "--name-only", "--format=", local], { cwd: repo, encoding: "utf8" }), /fix\.txt/);

    // A plan-only follow-up changes nothing, so there's nothing to commit.
    await call("runs/message", { id: runId, text: "What's left?", mode: "plan" });
    await settled(runId);
    assert.equal(run.unsaved, false);
  }, { gh });
});

test("the phone gets the new fields without prompts, and can queue a message", async () => {
  const trimmed = trimBoard({
    generatedAt: "t",
    counts: {},
    drafts: [{ id: "d", title: "Draft", provider: "claude", projectId: "p", mode: "plan", updatedAt: "u", prompt: "SECRET PROMPT", base: "HEAD" }],
    sessions: [{ id: "run:a", runId: "a", origin: "jarvis", provider: "claude", title: "T", status: "working", updatedAt: "u", column: "running", pendingMessages: [{ id: "m", text: "SECRET MESSAGE" }], prUrl: "url", pr: { state: "OPEN", draft: false, review: "", error: "x", checks: { passing: 1, failing: 2, pending: 3, failed: [{ name: "n", url: "SECRET URL" }] } } }]
  });
  assert.equal(JSON.stringify(trimmed).includes("SECRET"), false);
  assert.deepEqual(trimmed.drafts[0], { id: "d", title: "Draft", provider: "claude", projectId: "p", mode: "plan", updatedAt: "u" });
  const [session] = trimmed.sessions;
  assert.equal(session.column, "running");
  assert.equal(session.pendingMessages, 1);
  assert.deepEqual(session.pr.checks, { passing: 1, failing: 2, pending: 3 });
  assert.deepEqual(trimBoard({ counts: {} }).drafts, []);

  await withHub(async ({ api, root, call, settled }) => {
    const { runId } = await call("runs", { projectId: "test", provider: "claude", prompt: "SLEEP" });
    const remote = createRemoteAgents({ agentsApi: api, dataRoot: () => root });
    const answer = await remote.run({ id: "c1", type: "message", runId, prompt: "From the phone", mode: "plan" });
    assert.equal(answer.ok, true);
    assert.equal(api.launcher.get(runId).pendingMessages[0].text, "From the phone");
    api.launcher.stop(runId);
    await settled(runId);
  });
});
