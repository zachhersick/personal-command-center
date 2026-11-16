import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hookScriptSource, HookStore, hooksInstalled, mergeHooks, planHookInstall, removeHooks } from "../server/agents/hooks.js";
import { evaluateLabs, LabProgress, LABS } from "../server/agents/labs.js";

test("hook merge keeps the user's hooks and is idempotent", () => {
  const existing = { model: "x", hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "prettier --write" }] }] } };
  const once = mergeHooks(existing, "C:\\data\\hooks\\agent-hook.mjs");
  const twice = mergeHooks(once, "C:\\data\\hooks\\agent-hook.mjs");
  assert.deepEqual(once, twice);
  assert.equal(once.model, "x");
  assert.equal(once.hooks.PostToolUse.length, 2);
  assert.equal(once.hooks.PostToolUse[0].hooks[0].command, "prettier --write");
  assert.ok(hooksInstalled(once));
  assert.match(once.hooks.Notification[0].hooks[0].command, /node "C:\/data\/hooks\/agent-hook\.mjs" claude/);
  const removed = removeHooks(once);
  assert.deepEqual(removed, existing);
  assert.deepEqual(removeHooks(mergeHooks({}, "/x/agent-hook.mjs")), {});
});

test("hook events turn into status hints", () => {
  const store = new HookStore();
  assert.throws(() => store.ingest({ event: {} }), (error) => error.status === 400);
  store.ingest({ provider: "claude", event: { session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" } } });
  assert.equal(store.hint("s1").status, "working");
  assert.equal(store.hint("s1").current, "Ran npm test");
  store.ingest({ provider: "claude", event: { session_id: "s1", hook_event_name: "Notification", message: "Claude needs your permission to use Bash" } });
  assert.deepEqual([store.hint("s1").status, store.hint("s1").waitingFor], ["needs-you", "Claude needs your permission to use Bash"]);
  store.ingest({ provider: "codex", event: { session_id: "t1", hook_event_name: "Stop" } });
  assert.equal(store.hint("t1").status, "idle");
  assert.deepEqual(store.stats().counts, { claude: 2, codex: 1 });
  assert.equal(store.hint("unknown"), null);
});

test("the hook script exits 0 quickly even when Jarvis isn't running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-hook-"));
  try {
    const script = join(dir, "hooks", "agent-hook.mjs");
    await mkdir(join(dir, "hooks"), { recursive: true });
    await writeFile(script, hookScriptSource(1));
    const started = Date.now();
    const result = spawnSync(process.execPath, [script, "claude"], { input: JSON.stringify({ session_id: "s", hook_event_name: "Stop" }), timeout: 5000 });
    assert.equal(result.status, 0);
    assert.ok(Date.now() - started < 4000);
    assert.equal(spawnSync(process.execPath, [script], { input: "not json", timeout: 5000 }).status, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hook install previews, backs up and writes only on apply", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-install-"));
  try {
    const env = { JARVIS_CLAUDE_HOME: join(dir, "claude") };
    await mkdir(env.JARVIS_CLAUDE_HOME, { recursive: true });
    const settings = join(env.JARVIS_CLAUDE_HOME, "settings.json");
    await writeFile(settings, JSON.stringify({ theme: "dark" }));
    const plan = await planHookInstall({ scope: "user", dataRoot: join(dir, "data"), defaultPort: 4317, env });
    assert.equal(plan.changed, true);
    assert.equal(plan.installed, false);
    assert.equal(JSON.parse(readFileSync(settings, "utf8")).hooks, undefined, "preview doesn't write");
    await plan.apply();
    const written = JSON.parse(readFileSync(settings, "utf8"));
    assert.equal(written.theme, "dark");
    assert.ok(hooksInstalled(written));
    assert.ok(existsSync(join(dir, "data", "hooks", "agent-hook.mjs")));
    assert.ok(readdirSync(env.JARVIS_CLAUDE_HOME).some((name) => name.startsWith("settings.json.jarvis-backup-")));
    const again = await planHookInstall({ scope: "user", dataRoot: join(dir, "data"), defaultPort: 4317, env });
    assert.equal(again.changed, false);
    assert.equal(again.installed, true);
    await assert.rejects(() => planHookInstall({ scope: "project", dataRoot: dir, env }), (error) => error.status === 400);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("labs are checked from real evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-labs-"));
  try {
    const project = { id: "demo", path: join(dir, "demo") };
    await mkdir(join(project.path, ".claude", "commands"), { recursive: true });
    await writeFile(join(project.path, "CLAUDE.md"), "# Demo\nRun tests with `npm test`.\n");
    await writeFile(join(project.path, "AGENTS.md"), "# Demo\n");
    await writeFile(join(project.path, ".claude", "settings.json"), JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "prettier --write" }] }] } }));
    await writeFile(join(project.path, ".claude", "commands", "review.md"), "Review the diff.");
    const runs = [
      { id: "a", provider: "claude", worktree: "w1", startedAt: "2026-10-18T10:00:00Z", endedAt: "2026-10-18T10:30:00Z", turns: [{ mode: "plan" }, { mode: "edit" }], loop: { status: "passed", iterations: [{}, {}] }, diffViewed: true, outcome: "kept", diffLines: 40 },
      { id: "b", provider: "codex", worktree: "w2", startedAt: "2026-10-18T10:10:00Z", endedAt: "2026-10-18T10:20:00Z", turns: [{ mode: "edit" }], kind: "review", reviewOf: "a" }
    ];
    const labs = evaluateLabs({ projects: [project], runs, sessions: [], hookStats: { counts: { claude: 3, codex: 0 } }, env: { JARVIS_CLAUDE_HOME: join(dir, "none") } });
    const done = Object.fromEntries(labs.map((lab) => [lab.id, lab.done]));
    assert.deepEqual(done, {
      "context-file": true,
      "plan-first": true,
      "verification-loop": true,
      "small-diffs": true,
      "hooks-format": true,
      "hooks-jarvis": true,
      "parallel-worktrees": true,
      "writer-reviewer": true,
      "custom-command": true,
      "context-hygiene": false
    });
    const empty = evaluateLabs({ projects: [], runs: [], sessions: [], hookStats: { counts: { claude: 0, codex: 0 } }, env: { JARVIS_CLAUDE_HOME: join(dir, "none") } });
    assert.equal(empty.filter((lab) => lab.done).length, 0);

    const progress = new LabProgress(() => dir);
    await progress.setManual("context-hygiene", true);
    const fresh = new LabProgress(() => dir);
    const withManual = evaluateLabs({ projects: [], runs: [], sessions: [], hookStats: { counts: {} }, env: {} }, fresh.read());
    assert.equal(withManual.find((lab) => lab.id === "context-hygiene").done, true);
    await assert.rejects(() => progress.setManual("nope", true), (error) => error.status === 404);
    assert.equal(LABS.length, 10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
