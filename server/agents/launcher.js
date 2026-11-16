// Starts and steers agent runs. A run is one task in one worktree; it can have
// several turns (the first prompt plus follow-ups or loop iterations), each
// resuming the same Claude session or Codex thread.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { safeWriteJson } from "../shared-state.js";
import { event, currentLine, summarize } from "./events.js";
import { parseClaudeRecord } from "./claude-source.js";
import { parseCodexItem } from "./codex-source.js";
import { resolveClaudeCommand, resolveCodexCommand } from "./paths.js";
import { inspectProvider, validateSelection } from "./providers.js";
import { spawnStreaming } from "./spawn.js";
import { commitAll, createWorktree, removeWorktree, worktreeDiff } from "./worktrees.js";

export const PROVIDERS = ["claude", "codex"];
export const MODES = ["plan", "edit"];
const MAX_EVENTS = 300;
const MAX_PENDING_MESSAGES = 10;

export const DEFAULT_AGENT_SETTINGS = {
  maxConcurrent: 3,
  timeoutMinutes: 45,
  // Commands a headless Claude run may execute without asking. Edits inside the
  // worktree are allowed by acceptEdits; everything else is denied.
  claudeAllowedTools: [
    "Bash(npm test:*)",
    "Bash(npm run:*)",
    "Bash(node --test:*)",
    "Bash(npx tsc:*)",
    "Bash(pytest:*)",
    "Bash(python -m pytest:*)",
    "Bash(git status:*)",
    "Bash(git diff:*)",
    "Bash(git log:*)"
  ]
};

// Older configs had an unrelated "agents" array; only an object holds settings.
export function agentSettings(config = {}) {
  const raw = config.agents && !Array.isArray(config.agents) ? config.agents : {};
  const settings = { ...DEFAULT_AGENT_SETTINGS };
  for (const [key, value] of Object.entries(raw)) if (value !== "" && value !== null && value !== undefined) settings[key] = value;
  return settings;
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// ---------- stream parsers ----------
const snakeToCamel = (value) => String(value || "").replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());

function normalizeCodexExecItem(item = {}) {
  const out = {};
  for (const [key, value] of Object.entries(item)) out[snakeToCamel(key)] = value;
  out.type = snakeToCamel(item.type);
  if (out.type === "agentMessage" && !out.text && item.message) out.text = item.message;
  return out;
}

// Returns { events, sessionId?, done?, failed?, error?, usage? } for one line.
export function parseAgentLine(provider, line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return { events: [] };
  }
  const at = new Date().toISOString();
  if (!record || typeof record !== "object" || Array.isArray(record)) return { events: [event(at, "error", "Agent returned an invalid stream record", { ok: false })], failed: true };
  if (provider === "claude") {
    if (record.type === "system" && record.subtype === "init") return { events: [], sessionId: record.session_id, model: record.model };
    if (record.type === "result") {
      const failed = Boolean(record.is_error) || (record.subtype && record.subtype !== "success");
      const text = String(record.result || "");
      const title = failed ? text || `Ended: ${record.subtype || "error"}` : text || "Done";
      return {
        events: [event(at, failed ? "error" : "result", summarize(title, 200), { ok: !failed, detail: summarize(text, 2000) })],
        authError: /not logged in|\/login|invalid api key|authentication/i.test(text),
        sessionId: record.session_id,
        done: true,
        failed,
        // Helper models show up here too; the init record names the main one.
        usedModel: Object.entries(record.modelUsage || {}).sort(([, a], [, b]) => (b?.outputTokens || 0) - (a?.outputTokens || 0))[0]?.[0],
        usage: record.usage ? (record.usage.input_tokens || 0) + (record.usage.output_tokens || 0) : 0
      };
    }
    const { events } = parseClaudeRecord({ ...record, timestamp: at }, {});
    return { events, sessionId: record.session_id };
  }
  // codex exec --json
  if (record.type === "thread.started") return { events: [], sessionId: record.thread_id };
  if (record.type === "turn.completed") {
    const usage = record.usage || {};
    return { events: [], done: true, usage: (usage.input_tokens || 0) + (usage.output_tokens || 0) };
  }
  if (record.type === "turn.failed" || record.type === "error") {
    const message = record.error?.message || record.message || "Codex reported an error";
    return { events: [event(at, "error", message, { ok: false })], done: record.type === "turn.failed", failed: true, error: message };
  }
  if (record.type === "item.started" && record.item?.type === "command_execution") {
    return { events: [event(at, "command", record.item.command || "command")], partial: true };
  }
  if (record.type === "item.completed" && record.item) {
    const item = normalizeCodexExecItem(record.item);
    if (item.type === "commandExecution") {
      return { events: [event(at, "command", item.command || "command", { ok: item.exitCode === undefined ? undefined : item.exitCode === 0, detail: item.exitCode === undefined ? "" : `exit ${item.exitCode}` })] };
    }
    if (item.type === "todoList") return { events: [event(at, "plan", "Updated its task list", { detail: (item.items || []).map((entry) => `${entry.completed ? "✓" : "·"} ${entry.text}`).join("\n") })] };
    const parsed = parseCodexItem(item, at);
    return { events: parsed ? [parsed] : [] };
  }
  return { events: [] };
}

export function buildCommand(provider, { mode, sessionId, worktree, model = "", effort = "", config = {}, settings = DEFAULT_AGENT_SETTINGS }) {
  if (provider === "claude") {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", mode === "plan" ? "plan" : "acceptEdits"];
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    if (mode !== "plan" && settings.claudeAllowedTools?.length) args.push("--allowedTools", ...settings.claudeAllowedTools);
    if (sessionId) args.push("--resume", sessionId);
    return { command: resolveClaudeCommand(config), args, cwd: worktree };
  }
  const sandbox = mode === "plan" ? "read-only" : "workspace-write";
  const args = sessionId ? ["exec", "resume", sessionId, "--json", "-c", `sandbox_mode="${sandbox}"`] : ["exec", "--json", "--sandbox", sandbox, "-C", worktree];
  if (model) args.push("--model", model);
  if (effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
  args.push("-");
  return { command: resolveCodexCommand(config), args, cwd: worktree };
}

// ---------- store + launcher ----------
export class AgentLauncher extends EventEmitter {
  constructor({ dataRoot, loadConfig, now = () => new Date().toISOString(), commandFor = buildCommand, inspect = commandFor === buildCommand ? inspectProvider : null }) {
    super();
    this.dataRoot = dataRoot;
    this.loadConfig = loadConfig;
    this.now = now;
    this.commandFor = commandFor;
    this.inspect = inspect;
    this.runs = new Map();
    this.active = new Map();
    this.loops = new Map();
    this.operations = new Set();
    this.loaded = false;
    this.saveTimer = null;
  }

  get file() {
    return join(this.dataRoot(), "data", "agent-runs.local.json");
  }

  get logDir() {
    return join(this.dataRoot(), "data", "agent-logs");
  }

  async load() {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = this.loadRuns();
    await this.loading;
    this.loaded = true;
  }

  async loadRuns() {
    if (!existsSync(this.file)) return;
    try {
      const data = JSON.parse(await readFile(this.file, "utf8"));
      for (const run of data.runs || []) {
        // A run that was mid-turn when Jarvis quit can't be reattached.
        if (["starting", "working", "checking"].includes(run.status)) run.status = "stopped";
        if (run.loop?.status === "running") run.loop.status = "stopped";
        this.runs.set(run.id, run);
      }
    } catch (error) {
      console.error("Agent runs:", error.message);
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.writeRuns().catch((error) => console.error("Agent runs save:", error.message));
    }, 250);
    this.saveTimer.unref?.();
  }

  // Writes run one after another, so flush() also waits for a save already under way.
  writeRuns() {
    const runs = [...this.runs.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, 200);
    this.writing = (this.writing || Promise.resolve()).catch(() => {}).then(() => safeWriteJson(this.file, { version: 1, runs }));
    return this.writing;
  }

  async flush() {
    clearTimeout(this.saveTimer);
    await this.writeRuns();
  }

  list() {
    return [...this.runs.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  }

  get(id) {
    const run = this.runs.get(id);
    if (!run) throw fail(404, "Run not found.");
    return run;
  }

  touch(run, patch = {}) {
    Object.assign(run, patch, { updatedAt: this.now() });
    run.current = currentLine(run.events);
    this.save();
    this.emit("change", run);
  }

  pushEvents(run, events) {
    if (!events.length) return;
    run.events.push(...events);
    if (run.events.length > MAX_EVENTS) run.events = run.events.slice(-MAX_EVENTS);
  }

  async settings() {
    const config = await this.loadConfig();
    return { config, settings: agentSettings(config) };
  }

  occupied() {
    return new Set([...this.active.keys(), ...this.loops.keys()]).size;
  }

  // Tells the queue to look again. Deferred so the slot is really gone first.
  released() {
    setImmediate(() => this.emit("slot-free"));
  }

  queued() {
    return [...this.runs.values()].filter((run) => run.status === "queued").sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)));
  }

  // A queued run is a run-shaped record without a worktree. It keeps the
  // request so the same validation runs when it finally starts.
  async enqueue(request, { repo, title = "", taskId = "", taskTitle = "", requestedFrom = "" } = {}) {
    await this.load();
    if (!PROVIDERS.includes(request.provider)) throw fail(400, `provider must be one of ${PROVIDERS.join(", ")}.`);
    if (request.mode && !MODES.includes(request.mode)) throw fail(400, `mode must be one of ${MODES.join(", ")}.`);
    const text = String(request.prompt || "").trim();
    if (!text) throw fail(400, "A prompt is required.");
    if (!repo || !existsSync(repo)) throw fail(400, "Pick a repository that exists on this computer.");
    const at = this.now();
    const name = title || text.split(/\s+/).slice(0, 6).join(" ");
    const run = {
      id: randomUUID(),
      provider: request.provider,
      model: request.model || "",
      effort: request.effort || "",
      mode: request.loop?.check ? "edit" : request.mode || "edit",
      kind: request.loop?.check ? "loop" : "task",
      title: summarize(name, 80),
      prompt: text,
      projectId: request.projectId || "",
      repo,
      taskId,
      taskTitle,
      requestedFrom,
      retryOf: request.retryOf || "",
      request,
      status: "queued",
      queuedAt: at,
      startedAt: at,
      updatedAt: at,
      tokens: 0,
      turns: [],
      events: [event(at, "prompt", text, { detail: text })],
      current: "",
      outcome: null
    };
    this.runs.set(run.id, run);
    this.touch(run);
    return { run, position: this.queued().findIndex((entry) => entry.id === run.id) + 1 };
  }

  cancelQueued(id) {
    const run = this.get(id);
    if (run.status !== "queued") throw fail(409, "Only a queued agent can be cancelled. Stop it instead.");
    this.runs.delete(id);
    this.save();
    this.emit("change", run);
    return run;
  }

  failQueued(id, message) {
    const run = this.get(id);
    this.pushEvents(run, [event(this.now(), "error", message, { ok: false })]);
    this.touch(run, { status: "failed", error: message, request: undefined });
  }

  reserve(id, settings) {
    if (this.active.has(id) || this.operations.has(id)) throw fail(409, "This agent is busy. Wait for it or stop it first.");
    if (!this.loops.has(id) && this.occupied() >= settings.maxConcurrent) throw Object.assign(fail(409, `Already running ${this.occupied()} agents. Stop one or raise agents.maxConcurrent.`), { capacity: true });
    let finish;
    const slot = { stopped: false, child: null, done: new Promise((resolve) => { finish = resolve; }), finish,
      stop() { this.stopped = true; this.child?.stop(); } };
    this.active.set(id, slot);
    return slot;
  }

  async preflight(provider, selection, config) {
    if (!PROVIDERS.includes(provider)) throw fail(400, "Choose Claude or Codex.");
    if (!this.inspect) return;
    const info = await this.inspect(provider, config || (await this.loadConfig()), { fresh: true });
    if (!info.ready) throw fail(409, info.error);
    validateSelection(info, selection);
    return info;
  }

  async start({ id: queuedId = "", provider, repo, projectId = "", prompt, mode = "edit", base = "HEAD", title = "", kind = "task", reviewOf = null, loopId = null, model = "", effort = "", taskId = "", taskTitle = "", requestedFrom = "", retryOf = "", prepare }) {
    await this.load();
    // Starting a queued record keeps its id, so links to it stay valid.
    const queued = queuedId ? this.get(queuedId) : null;
    if (queued && queued.status !== "queued") throw fail(409, "That agent already started.");
    if (!PROVIDERS.includes(provider)) throw fail(400, `provider must be one of ${PROVIDERS.join(", ")}.`);
    if (!MODES.includes(mode)) throw fail(400, `mode must be one of ${MODES.join(", ")}.`);
    const text = String(prompt || "").trim();
    if (!text) throw fail(400, "A prompt is required.");
    if (!repo || !existsSync(repo)) throw fail(400, "Pick a repository that exists on this computer.");
    const { config, settings } = await this.settings();
    const id = queued?.id || randomUUID();
    const slot = this.reserve(id, settings);
    try {
      const info = await this.preflight(provider, { model, effort }, config);
      if (slot.stopped) throw fail(409, "Agent start was stopped.");
      if (prepare) await prepare();
      const name = title || text.split(/\s+/).slice(0, 6).join(" ");
      const worktree = await createWorktree({ repo, name, base });
      const run = {
        id,
        provider,
        model,
        effort,
        cliVersion: info?.version || "",
        mode,
        kind,
        reviewOf,
        loopId,
        title: summarize(name, 80),
        prompt: text,
        projectId,
        taskId: taskId || queued?.taskId || "",
        taskTitle: taskTitle || queued?.taskTitle || "",
        requestedFrom: requestedFrom || queued?.requestedFrom || "",
        retryOf: retryOf || queued?.retryOf || "",
        queuedAt: queued?.queuedAt || null,
        repo: worktree.root,
        worktree: worktree.path,
        branch: worktree.branch,
        baseSha: worktree.baseSha,
        sessionId: null,
        status: "starting",
        startedAt: this.now(),
        updatedAt: this.now(),
        endedAt: null,
        tokens: 0,
        turns: [],
        events: [event(this.now(), "prompt", text, { detail: text })],
        current: "",
        diffViewed: false,
        outcome: null
      };
      this.runs.set(run.id, run);
      this.touch(run);
      this.turn(run, text, mode, slot);
      return run;
    } catch (error) {
      this.active.delete(id);
      slot.finish();
      this.released();
      throw error;
    }
  }

  async turn(run, prompt, mode, slot) {
    const turn = { prompt: summarize(prompt, 400), mode, model: run.model || "", effort: run.effort || "", startedAt: this.now(), endedAt: null, exitCode: null, ok: false, tokens: 0 };
    run.turns.push(turn);
    run.authError = false;
    run.error = "";
    try {
      const { config, settings } = await this.settings();
      const { command, args, cwd } = this.commandFor(run.provider, { mode, model: run.model, effort: run.effort, sessionId: run.sessionId, worktree: run.worktree, config, settings });
      await mkdir(this.logDir, { recursive: true });
      const logPath = join(this.logDir, `${run.id}.jsonl`);
      run.logPath = logPath;
      if (slot.stopped) return;
      let failed = false;
      let sawResult = false;
      const handle = spawnStreaming(command, args, {
        cwd,
        input: prompt,
        timeoutMs: settings.timeoutMinutes * 60_000,
        onLine: (line) => {
          appendFile(logPath, `${line}\n`).catch(() => {});
          let parsed;
          try { parsed = parseAgentLine(run.provider, line); }
          catch { parsed = { failed: true, events: [event(this.now(), "error", "Agent returned an invalid stream record", { ok: false })] }; }
          if (parsed.sessionId && !run.sessionId) run.sessionId = parsed.sessionId;
          if (parsed.model) run.effectiveModel = turn.effectiveModel = parsed.model;
          else if (parsed.usedModel && !turn.effectiveModel) run.effectiveModel = turn.effectiveModel = parsed.usedModel;
          if (parsed.usage) {
            run.tokens += parsed.usage;
            turn.tokens += parsed.usage;
          }
          if (parsed.failed) failed = true;
          if (parsed.authError && !run.authError) {
            run.authError = true;
            this.pushEvents(run, [event(this.now(), "error", run.provider === "claude"
              ? "Claude Code isn't signed in for command-line runs. Open a terminal, run the Claude Code CLI once and sign in with /login, then try again."
              : "Codex isn't signed in. Run codex login in a terminal, then try again.", { ok: false })]);
          }
          if (parsed.done) sawResult = true;
          this.pushEvents(run, parsed.events);
          this.touch(run);
        },
        onStderr: (line) => {
          appendFile(logPath, `${JSON.stringify({ stderr: line })}\n`).catch(() => {});
          if (/error|denied|not found|unauthorized|unknown variant/i.test(line)) {
            run.error = line.slice(-1500);
            this.pushEvents(run, [event(this.now(), "error", line, { ok: false })]);
            this.touch(run);
          }
        }
      });
      slot.child = handle;
      this.touch(run, { status: "working" });
      const result = await handle.done;
      turn.endedAt = this.now();
      turn.exitCode = result.code;
      turn.ok = result.code === 0 && sawResult && !failed && !result.timedOut && !result.stopped;
      if (result.error) this.pushEvents(run, [event(this.now(), "error", `Could not start ${run.provider}: ${result.error}`, { ok: false })]);
      if (result.timedOut) this.pushEvents(run, [event(this.now(), "error", "Stopped after reaching the time limit", { ok: false })]);
      if (!turn.ok && !result.stopped) run.error ||= result.error || (result.timedOut ? "Agent timed out." : !sawResult ? "Agent exited without a terminal result." : `Agent failed (exit ${result.code}).`);
    } catch (error) {
      run.error = error.message;
      this.pushEvents(run, [event(this.now(), "error", error.message, { ok: false })]);
    } finally {
      turn.endedAt = this.now();
      if (slot.stopped) turn.ok = false;
      this.active.delete(run.id);
      this.touch(run, { status: slot.stopped ? "stopped" : turn.ok ? "idle" : "failed", endedAt: this.now() });
      this.emit("turn-ended", run, turn);
      slot.finish();
      // Reserves the slot before the queue gets a look at it. After a stop or a
      // failure, queued messages wait for you instead.
      if (turn.ok && !slot.stopped && run.pendingMessages?.length && !this.loops.has(run.id)) {
        this.message(run.id, "").catch((error) => {
          this.pushEvents(run, [event(this.now(), "error", `Couldn't send your queued messages: ${error.message}`, { ok: false })]);
          this.touch(run);
        });
      }
      this.released();
    }
    return turn;
  }

  async message(id, text, mode, { loop = false } = {}) {
    const run = this.get(id);
    if (run.status === "queued") throw fail(409, "This agent hasn't started yet. Cancel it or wait for a free slot.");
    if (mode && !MODES.includes(mode)) throw fail(400, "mode must be plan or edit.");
    const written = String(text || "").trim();
    // A loop owns its own turns, so only a plain running turn can take a queued message.
    if (!loop && this.loops.has(id)) throw fail(409, "This agent is looping. Wait for the loop to end or stop it first.");
    if (!loop && this.active.has(id)) return this.queueMessage(run, written, mode);
    if (this.active.has(id) || this.operations.has(id)) throw fail(409, "This agent is still working. Wait for it or stop it first.");
    const waiting = loop ? [] : run.pendingMessages || [];
    const prompt = [...waiting.map((message) => message.text), written].filter(Boolean).join("\n\n");
    if (!prompt) throw fail(400, "Write a message for the agent.");
    if (!existsSync(run.worktree)) throw fail(409, "This run's worktree was removed.");
    // Reserve before loading settings so Stop also covers this startup window.
    const slot = this.reserve(id, { maxConcurrent: Infinity });
    try {
      const { settings } = await this.settings();
      if (slot.stopped || (loop && this.loops.get(id)?.controller.signal.aborted)) {
        this.touch(run, { status: "stopped" });
        this.active.delete(id);
        slot.finish();
        return run;
      }
      if (!this.loops.has(id) && this.occupied() > settings.maxConcurrent) throw fail(409, "All agent slots are busy. Stop an agent and try again.");
      const nextMode = mode || waiting.at(-1)?.mode;
      if (nextMode) run.mode = nextMode;
      if (waiting.length) run.pendingMessages = run.pendingMessages.filter((message) => !waiting.includes(message));
      // Follow-up edits on committed work need committing again before they're safe.
      if (run.outcome === "kept" && run.mode === "edit") run.unsaved = true;
      this.pushEvents(run, [event(this.now(), "prompt", prompt, { detail: prompt })]);
      this.touch(run, { status: "starting" });
      this.turn(run, prompt, run.mode, slot);
      return run;
    } catch (error) {
      this.active.delete(id);
      slot.finish();
      this.released();
      throw error;
    }
  }

  queueMessage(run, text, mode) {
    if (!text) throw fail(400, "Write a message for the agent.");
    const waiting = run.pendingMessages || [];
    if (waiting.length >= MAX_PENDING_MESSAGES) throw fail(409, "That's plenty queued already. Wait for this turn to finish.");
    run.pendingMessages = [...waiting, { id: randomUUID(), text, mode: mode || "", at: this.now() }];
    this.touch(run);
    return run;
  }

  removeMessage(id, messageId) {
    const run = this.get(id);
    const waiting = run.pendingMessages || [];
    if (!waiting.some((message) => message.id === messageId)) throw fail(404, "That message already went out.");
    run.pendingMessages = waiting.filter((message) => message.id !== messageId);
    this.touch(run);
    return run;
  }

  // Doesn't count as activity on the run: a CI result shouldn't reorder cards.
  setPr(run, pr) {
    const same = JSON.stringify({ ...run.pr, checkedAt: 0 }) === JSON.stringify({ ...pr, checkedAt: 0 });
    run.pr = pr;
    this.save();
    if (!same) this.emit("change", run);
  }

  stop(id) {
    const run = this.get(id);
    if (run.status === "queued") return this.cancelQueued(id);
    const handle = this.active.get(id);
    this.loops.get(id)?.controller.abort();
    if (run.loop?.status === "running") run.loop.status = "stopped";
    if (handle) handle.stop();
    else this.touch(run, { status: "stopped" });
    return run;
  }

  async diff(id) {
    const run = this.get(id);
    const diff = await worktreeDiff({ path: run.worktree, baseSha: run.baseSha });
    run.diffViewed = true;
    run.diffLines = (diff.added || 0) + (diff.removed || 0);
    this.touch(run);
    return diff;
  }

  async keep(id) {
    const run = this.get(id);
    if (run.status === "queued") throw fail(409, "This agent hasn't started yet.");
    if (this.active.has(id) || this.loops.has(id) || this.operations.has(id)) throw fail(409, "Stop the agent before keeping its work.");
    this.operations.add(id);
    try {
      const result = await commitAll({ path: run.worktree, message: `${run.title}\n\nMade by a ${run.provider} agent run from Jarvis.` });
      this.touch(run, { outcome: "kept", unsaved: false, keptAt: this.now(), commit: result.sha || run.commit || null });
      return { ...result, branch: run.branch };
    } finally { this.operations.delete(id); }
  }

  async discard(id) {
    const run = this.get(id);
    if (run.status === "queued") return this.cancelQueued(id);
    if (this.operations.has(id)) throw fail(409, "This run is busy. Try again when the current action finishes.");
    this.operations.add(id);
    try {
      const active = this.active.get(id);
      const loop = this.loops.get(id);
      this.stop(id);
      await Promise.all([active?.done, loop?.done]);
      await removeWorktree({ root: run.repo, path: run.worktree, branch: run.branch, deleteBranch: run.outcome !== "kept" });
      this.touch(run, { outcome: run.outcome === "kept" ? "kept" : "discarded", status: run.status === "working" ? "stopped" : run.status, worktreeRemoved: true });
      return run;
    } finally { this.operations.delete(id); }
  }

  stopAll() {
    for (const handle of this.active.values()) handle.stop();
    for (const loop of this.loops.values()) loop.controller.abort();
  }
}
