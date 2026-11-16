import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearClaudeTails, listLiveClaudeSessions, listRecentClaudeSessions, parseClaudeRecord, tailTranscript, transcriptPath } from "../server/agents/claude-source.js";
import { cleanCwd, listCodexThreads, parseCodexItem } from "../server/agents/codex-source.js";
import { claudeProjectSlug } from "../server/agents/paths.js";
import { laneFor, matchProject } from "../server/agents/registry.js";

const line = (value) => `${JSON.stringify(value)}\n`;
const at = "2026-10-18T18:00:00.000Z";

async function claudeFixture() {
  const home = await mkdtemp(join(tmpdir(), "jarvis-claude-"));
  const cwd = "C:\\Dev\\demo\\.claude\\worktrees\\x";
  await mkdir(join(home, "sessions"), { recursive: true });
  await writeFile(join(home, "sessions", "100.json"), JSON.stringify({ pid: 100, sessionId: "s-live", cwd, status: "waiting", waitingFor: "approve Bash", name: "Fix the parser", startedAt: Date.parse(at), updatedAt: Date.parse(at) }));
  await writeFile(join(home, "sessions", "200.json"), JSON.stringify({ pid: 200, sessionId: "s-dead", cwd, status: "busy" }));
  const path = transcriptPath(home, cwd, "s-live");
  await mkdir(join(home, "projects", claudeProjectSlug(cwd)), { recursive: true });
  await writeFile(path, [
    line({ type: "user", timestamp: at, cwd, gitBranch: "fix/parser", message: { role: "user", content: "Fix the CSV parser bug" } }),
    line({ type: "assistant", timestamp: at, message: { model: "claude-x", usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50 }, content: [{ type: "tool_use", name: "Read", input: { file_path: "C:\\Dev\\demo\\src\\csv.js" } }] } }),
    line({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } }),
    line({ type: "user", timestamp: at, message: { content: [{ type: "tool_result", is_error: true, content: [{ type: "text", text: "1 failing" }] }] } }),
    line({ type: "pr-link", prUrl: "https://github.com/x/y/pull/1", sessionId: "s-live" }),
    line({ type: "assistant", isSidechain: true, timestamp: at, message: { content: [{ type: "tool_use", name: "Bash", input: { command: "subagent stuff" } }] } }),
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"src/csv.js"}}]}}'
  ].join(""));
  return { home, cwd, path };
}

test("Claude transcript records become events and metadata", () => {
  const meta = {};
  const { events } = parseClaudeRecord({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "C:\\a\\b\\c.js" } }, { type: "tool_use", name: "ExitPlanMode", input: { plan: "Do it" } }] } }, meta);
  assert.deepEqual(events.map((item) => [item.kind, item.title]), [["edit", "b/c.js"], ["plan", "Proposed a plan"]]);
  parseClaudeRecord({ type: "custom-title", customTitle: "Named" }, meta);
  assert.equal(meta.title, "Named");
  assert.equal(parseClaudeRecord({ type: "user", message: { content: "<system-reminder>x</system-reminder>" } }).events.length, 0);
});

test("live Claude sessions: dead pids dropped, status mapped, transcript tailed incrementally", async () => {
  clearClaudeTails();
  const { home, path } = await claudeFixture();
  try {
    const sessions = listLiveClaudeSessions({ home, isAlive: (pid) => pid === 100 });
    assert.equal(sessions.length, 1);
    const [session] = sessions;
    assert.equal(session.status, "needs-you");
    assert.equal(session.waitingFor, "approve Bash");
    assert.equal(session.title, "Fix the parser");
    assert.equal(session.branch, "fix/parser");
    assert.equal(session.prUrl, "https://github.com/x/y/pull/1");
    assert.equal(session.tokens, 1050);
    assert.equal(session.tokensKind, "context");
    assert.equal(session.current, "1 failing");
    assert.ok(!session.recent.some((item) => item.title === "subagent stuff"), "sidechain records are skipped");
    assert.ok(!session.recent.some((item) => item.kind === "edit"), "partial last line waits");

    // The writer finishes the partial line and appends more.
    await appendFile(path, `\n${line({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm run lint" } }] } })}`);
    const tail = tailTranscript(path);
    assert.deepEqual(tail.events.slice(-2).map((item) => item.title), ["src/csv.js", "npm run lint"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("recent Claude sessions come from transcripts without a live process", async () => {
  clearClaudeTails();
  const { home } = await claudeFixture();
  try {
    const recent = listRecentClaudeSessions({ home, exclude: new Set() });
    assert.equal(recent.length, 1);
    assert.equal(recent[0].status, "done");
    assert.equal(recent[0].title, "Fix the CSV parser bug");
    assert.equal(listRecentClaudeSessions({ home, exclude: new Set(["s-live"]) }).length, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function codexFixture(now) {
  const { DatabaseSync } = await import("node:sqlite");
  const home = await mkdtemp(join(tmpdir(), "jarvis-codex-"));
  const state = new DatabaseSync(join(home, "state_5.sqlite"));
  state.exec(`create table threads (id text, rollout_path text, cwd text, title text, name text, git_branch text, model text, tokens_used integer, created_at_ms integer, updated_at_ms integer, source text, first_user_message text, archived integer)`);
  const insert = state.prepare("insert into threads values (?,?,?,?,?,?,?,?,?,?,?,?,?)");
  insert.run("t-working", "", "\\\\?\\C:\\Dev\\demo", "Add search", null, "feat/search", "gpt-x", 1200, now - 60_000, now - 5_000, "cli", "Add search", 0);
  insert.run("t-failed", "", "C:\\Dev\\demo", "Old task", null, "main", "gpt-x", 50, now - 3_600_000, now - 3_000_000, "vscode", "", 0);
  insert.run("t-archived", "", "C:\\Dev\\demo", "Hidden", null, "main", "gpt-x", 1, now, now, "cli", "", 1);
  state.close();
  const history = new DatabaseSync(join(home, "thread_history_1.sqlite"));
  history.exec(`create table thread_turns (thread_id text, turn_id text, rollout_ordinal integer, status text, error_json text, started_at integer, completed_at integer);
    create table thread_items (thread_id text, turn_id text, item_id text, rollout_ordinal integer, created_at_ms integer, item_json text, item_type text)`);
  history.prepare("insert into thread_turns values (?,?,?,?,?,?,?)").run("t-working", "u1", 1, "inProgress", null, 0, null);
  history.prepare("insert into thread_turns values (?,?,?,?,?,?,?)").run("t-failed", "u2", 1, "failed", JSON.stringify({ message: "You've hit your usage limit." }), 0, 1);
  const item = history.prepare("insert into thread_items values (?,?,?,?,?,?,?)");
  item.run("t-working", "u1", "i1", 1, now - 50_000, JSON.stringify({ type: "userMessage", content: [{ type: "text", text: "Add search" }] }), "userMessage");
  item.run("t-working", "u1", "i2", 2, now - 40_000, JSON.stringify({ type: "fileChange", changes: [{ path: "C:\\Dev\\demo\\src\\search.js" }] }), "fileChange");
  item.run("t-working", "u1", "i3", 3, now - 30_000, JSON.stringify({ type: "commandExecution", commandActions: [{ command: "npm test" }], exitCode: 0 }), "commandExecution");
  history.close();
  return home;
}

// node:sqlite ships with Node 22.5+. Without it the Codex reader reports
// itself unavailable (covered below), so only the fixture test is skipped.
const hasSqlite = await import("node:sqlite").then(() => true, () => false);

test("Codex threads come from its SQLite stores", { skip: hasSqlite ? false : "node:sqlite needs Node 22.5+" }, async () => {
  const now = Date.now();
  const home = await codexFixture(now);
  try {
    const { available, threads } = await listCodexThreads({ home, now });
    assert.equal(available, true);
    assert.deepEqual(threads.map((thread) => thread.sessionId), ["t-working", "t-failed"]);
    const [working, failed] = threads;
    assert.equal(working.status, "working");
    assert.equal(working.cwd, "C:\\Dev\\demo");
    assert.equal(working.branch, "feat/search");
    assert.equal(working.current, "Running npm test");
    assert.deepEqual(working.recent.map((item) => item.kind), ["prompt", "edit", "command"]);
    assert.equal(failed.status, "failed");
    assert.match(failed.current, /usage limit/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Codex is reported unavailable when its stores can't be read", async () => {
  assert.deepEqual(await listCodexThreads({ home: join(tmpdir(), "jarvis-no-codex-here") }), { available: false, threads: [] });
});

test("Codex items and helpers", () => {
  assert.equal(parseCodexItem({ type: "mcpToolCall", server: "gh", tool: "search" }).title, "gh · search");
  assert.equal(parseCodexItem({ type: "reasoning" }), null);
  assert.equal(cleanCwd("\\\\?\\C:\\x"), "C:\\x");
  assert.equal(laneFor("starting"), "working");
  assert.equal(laneFor("failed"), "done");
  const projects = [{ id: "demo", path: "C:\\Dev\\demo" }, { id: "demo-app", path: "C:\\Dev\\demo\\app" }];
  assert.equal(matchProject("C:\\Dev\\demo\\.agent-worktrees\\x", projects).id, "demo");
  assert.equal(matchProject("c:\\dev\\demo\\app\\src", projects).id, "demo-app");
  assert.equal(matchProject("C:\\Dev\\demolition", projects), null);
});

test("shell wrappers are stripped from command titles", async () => {
  const { cleanCommand } = await import("../server/agents/events.js");
  assert.equal(cleanCommand(String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'git -c safe.directory=* status --short'`), "git status --short");
  assert.equal(cleanCommand(String.raw`"C:\Windows\system32\cmd.exe" /c "npm test"`), "npm test");
  assert.equal(cleanCommand("npm test"), "npm test");
});
