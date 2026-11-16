import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { agentSettings, AgentLauncher, buildCommand, parseAgentLine } from "../server/agents/launcher.js";
import { feedbackPrompt, LoopRunner } from "../server/agents/loop.js";
import { runSession } from "../server/agents/registry.js";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));

async function scratchRepo() {
  const root = await mkdtemp(join(tmpdir(), "jarvis-agents-"));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  await writeFile(join(repo, "math.js"), "export const add = (a, b) => a - b;\n");
  await writeFile(join(repo, "check.mjs"), "import { readFileSync } from 'node:fs';\nprocess.exit(readFileSync('math.js', 'utf8').includes('a + b') ? 0 : 1);\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "init"], { cwd: repo });
  const dataRoot = join(root, "data-root");
  const launcher = new AgentLauncher({
    dataRoot: () => dataRoot,
    loadConfig: async () => ({ agents: { maxConcurrent: 2, timeoutMinutes: 1 } }),
    commandFor: (provider, { sessionId, worktree }) => ({
      command: process.execPath,
      args: [fakeAgent, provider, ...(sessionId ? ["--resume", sessionId] : [])],
      cwd: worktree
    })
  });
  return { root, repo, launcher };
}

// Let the launcher finish writing its run file before the folder goes; Windows
// refuses to remove a directory while a file is being renamed into it.
async function cleanup(root, launcher) {
  launcher.stopAll();
  await Promise.all([...launcher.active.values(), ...launcher.loops.values()].map((handle) => handle.done));
  await launcher.flush().catch(() => {});
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

const turnEnded = (launcher, id) => new Promise((resolve) => {
  const onEnd = (run) => {
    if (run.id !== id) return;
    launcher.off("turn-ended", onEnd);
    resolve(run);
  };
  launcher.on("turn-ended", onEnd);
});

test("model and effort reach initial and resumed provider commands", () => {
  for (const provider of ["claude", "codex"]) {
    for (const sessionId of [null, "session-1"]) {
      const command = buildCommand(provider, { mode: "plan", sessionId, worktree: "/w", model: "chosen-model", effort: "high", config: { agents: { claudeCommand: "claude", codexCommand: "codex" } } });
      assert.ok(command.args.includes("chosen-model"));
      assert.ok(command.args.includes(provider === "claude" ? "high" : 'model_reasoning_effort="high"'));
    }
  }
});

test("helper models in a result don't replace the model the run reported at start", async () => {
  const { root, repo, launcher } = await scratchRepo();
  try {
    const run = await launcher.start({ provider: "claude", repo, prompt: "Look around", model: "opus" });
    await turnEnded(launcher, run.id);
    assert.equal(run.effectiveModel, "fake-model");
    assert.equal(runSession({ ...run, model: "fake-model" }, []).settingsDiffer, false);
    assert.equal(runSession({ ...run, model: "other-model" }, []).settingsDiffer, true);
  } finally {
    await cleanup(root, launcher);
  }
});

test("simultaneous starts reserve capacity and identical titles get distinct worktrees", async () => {
  const { root, repo, launcher } = await scratchRepo();
  try {
    const attempts = await Promise.allSettled(Array.from({ length: 3 }, () => launcher.start({ provider: "codex", repo, prompt: "SLEEP", title: "Same title" })));
    const accepted = attempts.filter((result) => result.status === "fulfilled").map((result) => result.value);
    assert.equal(accepted.length, 2);
    assert.equal(attempts.find((result) => result.status === "rejected").reason.status, 409);
    assert.notEqual(accepted[0].worktree, accepted[1].worktree);
    await Promise.all(accepted.map((run) => launcher.discard(run.id)));
  } finally {
    await cleanup(root, launcher);
  }
});

test("busy follow-ups queue without changing the running turn", async () => {
  const { root, repo, launcher } = await scratchRepo();
  try {
    const run = await launcher.start({ provider: "claude", repo, prompt: "SLEEP" });
    const events = run.events.length;
    await launcher.message(run.id, "a second prompt", "plan");
    assert.equal(run.pendingMessages[0].text, "a second prompt");
    assert.equal(run.events.length, events);
    assert.equal(run.mode, "edit");
    await launcher.discard(run.id);
  } finally {
    await cleanup(root, launcher);
  }
});

test("stop during startup prevents spawn and releases capacity", async () => {
  const { root, repo, launcher } = await scratchRepo();
  try {
    const original = launcher.loadConfig;
    let unblock;
    const gate = new Promise((resolve) => { unblock = resolve; });
    let calls = 0;
    launcher.loadConfig = async () => { if (++calls === 2) await gate; return original(); };
    const run = await launcher.start({ provider: "codex", repo, prompt: "SLEEP" });
    const ended = turnEnded(launcher, run.id);
    launcher.stop(run.id);
    unblock();
    await ended;
    assert.equal(run.status, "stopped");
    assert.equal(launcher.active.size, 0);
    assert.equal(existsSync(run.logPath), false, "no process output was written");
    await launcher.discard(run.id);
  } finally { await cleanup(root, launcher); }
});

test("stop while a follow-up loads settings prevents a replacement turn", async () => {
  const { root, repo, launcher } = await scratchRepo();
  try {
    const run = await launcher.start({ provider: "codex", repo, prompt: "inspect" });
    await turnEnded(launcher, run.id);
    let unblock;
    const gate = new Promise((resolve) => { unblock = resolve; });
    const original = launcher.loadConfig;
    launcher.loadConfig = async () => { await gate; return original(); };
    const pending = launcher.message(run.id, "SLEEP");
    launcher.stop(run.id);
    unblock();
    await pending;
    assert.equal(run.turns.length, 1);
    assert.equal(run.status, "stopped");
    assert.equal(launcher.active.size, 0);
    await launcher.discard(run.id);
  } finally { await cleanup(root, launcher); }
});

test("setup errors complete the turn and do not leave a loop waiting", async () => {
  const { root, repo, launcher } = await scratchRepo();
  try {
    launcher.commandFor = () => { throw new Error("broken setup"); };
    const loops = new LoopRunner({ launcher });
    const run = await loops.start({ provider: "codex", repo, prompt: "x", check: "node check.mjs" });
    await launcher.loops.get(run.id).done;
    assert.equal(run.status, "failed");
    assert.equal(run.loop.status, "agent-error");
    assert.equal(launcher.occupied(), 0);
    await launcher.discard(run.id);
  } finally { await cleanup(root, launcher); }
});

test("verification errors finish the loop instead of leaving a working card", async () => {
  const { root, repo, launcher } = await scratchRepo();
  try {
    const loops = new LoopRunner({ launcher, check: async () => { throw new Error("verification unavailable"); } });
    const run = await loops.start({ provider: "codex", repo, prompt: "inspect", check: "node --version" });
    await launcher.loops.get(run.id).done;
    assert.equal(run.loop.status, "error");
    assert.equal(run.status, "failed");
    assert.equal(launcher.occupied(), 0);
    await launcher.discard(run.id);
  } finally { await cleanup(root, launcher); }
});

test("stopping a loop kills its verification child before discard", async () => {
  const { root, repo, launcher } = await scratchRepo();
  try {
    const loops = new LoopRunner({ launcher });
    const run = await loops.start({ provider: "codex", repo, prompt: "x", check: 'node -e "setTimeout(() => {}, 60000)"' });
    const deadline = Date.now() + 10_000;
    while (run.status !== "checking" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(run.status, "checking");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await assert.rejects(() => launcher.message(run.id, "interrupt"), (error) => error.status === 409);
    loops.stop(run);
    await launcher.discard(run.id);
    assert.equal(run.loop.status, "stopped");
    assert.equal(run.turns.length, 1);
    assert.equal(existsSync(run.worktree), false);
    assert.equal(launcher.occupied(), 0);
  } finally { await cleanup(root, launcher); }
});

test("preflight rejects unavailable choices before creating a worktree", async () => {
  const { root, repo, launcher } = await scratchRepo();
  try {
    launcher.inspect = async () => ({ ready: true, models: [{ id: "", efforts: [] }] });
    await assert.rejects(() => launcher.start({ provider: "codex", repo, prompt: "x", model: "bad" }), (error) => error.status === 400);
    assert.equal(existsSync(join(repo, ".agent-worktrees")), false);
    assert.equal(launcher.occupied(), 0);
  } finally { await cleanup(root, launcher); }
});

test("model choices survive follow-ups, loops, reloads and board projection", async () => {
  const { root, repo, launcher } = await scratchRepo();
  try {
    const seen = [];
    const commandFor = launcher.commandFor;
    launcher.commandFor = (provider, options) => { seen.push({ model: options.model, effort: options.effort }); return commandFor(provider, options); };
    const loops = new LoopRunner({ launcher });
    const run = await loops.start({ provider: "codex", repo, prompt: "fix", check: "node check.mjs", model: "test-model", effort: "high" });
    await launcher.loops.get(run.id).done;
    assert.equal(run.loop.status, "passed");
    const ended = turnEnded(launcher, run.id);
    await launcher.message(run.id, "explain");
    await ended;
    assert.deepEqual(seen, Array.from({ length: 3 }, () => ({ model: "test-model", effort: "high" })));
    assert.equal(runSession(run, []).model, "test-model");
    await launcher.flush();
    const reload = new AgentLauncher({ dataRoot: launcher.dataRoot, loadConfig: launcher.loadConfig, commandFor });
    await reload.load();
    assert.equal(reload.get(run.id).effort, "high");
    assert.equal(reload.get(run.id).turns[1].model, "test-model");
    const legacy = JSON.parse(readFileSync(launcher.file, "utf8"));
    for (const record of legacy.runs) { delete record.model; delete record.effort; }
    await writeFile(launcher.file, JSON.stringify(legacy));
    const old = new AgentLauncher({ dataRoot: launcher.dataRoot, loadConfig: launcher.loadConfig, commandFor });
    await old.load();
    assert.equal(runSession(old.get(run.id), []).model, "");
    assert.equal(runSession(old.get(run.id), []).effort, "");
    await launcher.discard(run.id);
  } finally { await cleanup(root, launcher); }
});

test("review preparation cannot mutate the original run before validation or capacity", async () => {
  const { root, repo, launcher } = await scratchRepo();
  try {
    let prepared = false;
    launcher.inspect = async () => ({ ready: true, models: [{ id: "", efforts: [] }] });
    await assert.rejects(() => launcher.start({ provider: "claude", repo, prompt: "review", model: "bad", prepare: async () => { prepared = true; } }), (error) => error.status === 400);
    assert.equal(prepared, false);
    assert.equal(launcher.occupied(), 0);
  } finally { await cleanup(root, launcher); }
});

test("a process must exit successfully with a terminal result", async () => {
  const { root, repo, launcher } = await scratchRepo();
  try {
    for (const prompt of ["NO RESULT", "BAD EXIT"]) {
      const run = await launcher.start({ provider: "claude", repo, prompt });
      await turnEnded(launcher, run.id);
      assert.equal(run.status, "failed", prompt);
      assert.equal(run.turns.at(-1).ok, false);
      await launcher.discard(run.id);
    }
  } finally {
    await cleanup(root, launcher);
  }
});

test("claude stream lines become events, session ids and results", () => {
  assert.equal(parseAgentLine("claude", JSON.stringify({ type: "system", subtype: "init", session_id: "s1" })).sessionId, "s1");
  const tool = parseAgentLine("claude", JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } }));
  assert.equal(tool.events[0].kind, "command");
  assert.equal(tool.events[0].title, "npm test");
  const failed = parseAgentLine("claude", JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }));
  assert.equal(failed.failed, true);
  assert.equal(failed.authError, true);
  assert.equal(failed.events[0].title, "Not logged in · Please run /login");
  const reported = parseAgentLine("claude", JSON.stringify({ type: "result", subtype: "success", result: "Done", modelUsage: { "claude-haiku-5-5": { outputTokens: 3 }, "claude-sonnet-5-5": { outputTokens: 90 } } }));
  assert.equal(reported.usedModel, "claude-sonnet-5-5", "the model that did most of the work, not a joined list");
  assert.equal(reported.model, undefined);
  assert.deepEqual(parseAgentLine("claude", "not json").events, []);
  assert.equal(parseAgentLine("claude", "null").failed, true);
  assert.equal(parseAgentLine("codex", "[]").failed, true);
});

test("codex exec --json lines become events", () => {
  assert.equal(parseAgentLine("codex", JSON.stringify({ type: "thread.started", thread_id: "t1" })).sessionId, "t1");
  const command = parseAgentLine("codex", JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm test", exit_code: 1 } }));
  assert.equal(command.events[0].kind, "command");
  assert.equal(command.events[0].ok, false);
  const edit = parseAgentLine("codex", JSON.stringify({ type: "item.completed", item: { type: "file_change", changes: [{ path: "src/a.js" }] } }));
  assert.equal(edit.events[0].kind, "edit");
  assert.equal(parseAgentLine("codex", JSON.stringify({ type: "turn.failed", error: { message: "limit" } })).failed, true);
  assert.equal(parseAgentLine("codex", JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 } })).usage, 5);
});

test("commands never bypass permissions and resume the same session", () => {
  const claude = buildCommand("claude", { mode: "edit", sessionId: "s1", worktree: "/w", config: { agents: { claudeCommand: "claude" } } });
  assert.ok(claude.args.includes("acceptEdits"));
  assert.deepEqual(claude.args.slice(-2), ["--resume", "s1"]);
  assert.ok(!claude.args.some((arg) => /bypass|dangerously/i.test(arg)));
  assert.ok(buildCommand("claude", { mode: "plan", worktree: "/w", config: {} }).args.includes("plan"));
  const codex = buildCommand("codex", { mode: "edit", worktree: "/w", config: { agents: { codexCommand: "codex" } } });
  assert.deepEqual(codex.args.slice(0, 4), ["exec", "--json", "--sandbox", "workspace-write"]);
  assert.ok(buildCommand("codex", { mode: "plan", worktree: "/w", config: {} }).args.includes("read-only"));
  assert.equal(buildCommand("codex", { mode: "edit", sessionId: "t1", worktree: "/w", config: {} }).args[1], "resume");
  assert.ok(!codex.args.some((arg) => /bypass|dangerously/i.test(arg)));
});

test("settings ignore the legacy agents array", () => {
  assert.equal(agentSettings({ agents: [{ id: "planner" }] }).maxConcurrent, 3);
  assert.equal(agentSettings({ agents: { maxConcurrent: 5, claudeCommand: "" } }).maxConcurrent, 5);
});

test("a run works in its own worktree, takes follow-ups, and can be kept or discarded", async () => {
  const { root, repo, launcher } = await scratchRepo();
  try {
    const run = await launcher.start({ provider: "claude", repo, prompt: "Look at add()", title: "Fix add" });
    assert.ok(run.worktree.includes(".agent-worktrees"));
    assert.match(run.branch, /^agent\/fix-add-/);
    await turnEnded(launcher, run.id);
    assert.equal(run.status, "idle");
    assert.equal(run.sessionId, "fake-session-1");
    assert.ok(run.events.some((item) => item.kind === "command" && item.title === "npm test"));
    assert.equal(readFileSync(join(repo, "math.js"), "utf8").includes("a - b"), true, "main checkout untouched");

    const ended = turnEnded(launcher, run.id);
    await launcher.message(run.id, "Now fix it");
    await ended;
    assert.equal(run.turns.length, 2);
    assert.ok(run.events.some((item) => item.kind === "edit"));
    const diff = await launcher.diff(run.id);
    assert.ok(diff.files.some((file) => file.path === "math.js"));
    assert.equal(run.diffViewed, true);

    const kept = await launcher.keep(run.id);
    assert.equal(kept.committed, true);
    assert.equal(run.outcome, "kept");
    await launcher.discard(run.id);
    assert.equal(existsSync(run.worktree), false);
    assert.match(execFileSync("git", ["branch", "--list", run.branch], { cwd: repo, encoding: "utf8" }), /agent\//, "kept branch survives worktree removal");
    await launcher.flush();
    assert.ok(existsSync(launcher.file));
  } finally {
    await cleanup(root, launcher);
  }
});

test("stop kills a running agent and the concurrency cap holds", async () => {
  const { root, repo, launcher } = await scratchRepo();
  try {
    const first = await launcher.start({ provider: "codex", repo, prompt: "SLEEP please", title: "Long" });
    const second = await launcher.start({ provider: "codex", repo, prompt: "SLEEP too", title: "Long two" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await assert.rejects(() => launcher.start({ provider: "claude", repo, prompt: "third" }), (error) => error.status === 409);
    const ended = turnEnded(launcher, first.id);
    launcher.stop(first.id);
    await ended;
    assert.equal(first.status, "stopped");
    const ended2 = turnEnded(launcher, second.id);
    launcher.stop(second.id);
    await ended2;
    await launcher.discard(first.id);
    await launcher.discard(second.id);
    assert.equal(existsSync(first.worktree), false);
  } finally {
    await cleanup(root, launcher);
  }
});

test("a loop feeds failures back and passes on the second iteration", async () => {
  const { root, repo, launcher } = await scratchRepo();
  try {
    const loops = new LoopRunner({ launcher });
    const run = await loops.start({ provider: "codex", repo, prompt: "Make the check pass", check: "node check.mjs", maxIterations: 4 });
    const deadline = Date.now() + 30_000;
    while (run.loop.status === "running" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(run.loop.status, "passed");
    assert.equal(run.loop.iterations.length, 2);
    assert.equal(run.loop.iterations[0].checkOk, false);
    assert.equal(run.loop.iterations[1].checkOk, true);
    assert.ok(run.turns[1].prompt.includes("failed"));
    await launcher.discard(run.id);
  } finally {
    await cleanup(root, launcher);
  }
});

test("feedback prompts carry the failing output and forbid gaming the check", () => {
  const prompt = feedbackPrompt("npm test", { code: 1, tail: "AssertionError: 5 !== -1" }, 2);
  assert.match(prompt, /AssertionError/);
  assert.match(prompt, /Don't weaken, skip or delete/);
});

test("the newest Codex install wins", async () => {
  const { resolveCodexCommand, cliVersion } = await import("../server/agents/paths.js");
  const versions = { "C:/old/codex.exe": [0, 130, 0], "C:/npm/codex.exe": [0, 160, 1] };
  const pick = resolveCodexCommand({}, {}, { candidates: () => Object.keys(versions), version: (path) => versions[path] });
  if (process.platform === "win32") assert.equal(pick, "C:/npm/codex.exe");
  assert.equal(resolveCodexCommand({ agents: { codexCommand: "C:/mine.exe" } }), "C:/mine.exe");
  assert.deepEqual(cliVersion("fake-cli", () => "codex-cli 1.2.3"), [1, 2, 3]);
  assert.deepEqual(cliVersion("broken-cli", () => { throw new Error("nope"); }), [0, 0, 0]);
});
