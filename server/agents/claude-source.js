// Reads Claude Code sessions: the live registry in ~/.claude/sessions and the
// JSONL transcripts in ~/.claude/projects. Transcripts are megabytes, so they're
// tailed from a cached byte offset instead of re-read.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { claudeHome, claudeProjectSlug } from "./paths.js";
import { baseName, currentLine, event, summarize } from "./events.js";

const INITIAL_TAIL_BYTES = 192 * 1024;
const MAX_EVENTS = 60;
const tails = new Map();

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function toolEvent(at, block) {
  const input = block.input || {};
  const name = block.name || "tool";
  if (name === "Bash" || name === "PowerShell") return event(at, "command", input.command || name, { detail: input.description || "" });
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name)) return event(at, "edit", baseName(input.file_path || input.notebook_path), { detail: input.file_path || "" });
  if (name === "Read") return event(at, "read", baseName(input.file_path));
  if (name === "Grep" || name === "Glob") return event(at, "search", input.pattern || name);
  if (name === "WebFetch" || name === "WebSearch") return event(at, "search", input.url || input.query || name);
  if (name === "ExitPlanMode") return event(at, "plan", "Proposed a plan", { detail: summarize(input.plan, 600) });
  if (name === "Agent" || name === "Task") return event(at, "tool", `Subagent: ${input.description || input.subagent_type || "task"}`);
  if (name === "AskUserQuestion") return event(at, "status", "Asked you a question", { detail: summarize(input.questions?.[0]?.question, 300) });
  return event(at, "tool", name.startsWith("mcp__") ? name.split("__").slice(1).join(" · ") : name);
}

// Turn one transcript record into zero or more events, plus metadata updates.
export function parseClaudeRecord(record, meta = {}) {
  const events = [];
  const at = record.timestamp || null;
  if (record.type === "custom-title" && record.customTitle) meta.title = record.customTitle;
  if (record.type === "agent-name" && record.agentName && !meta.title) meta.title = record.agentName;
  if (record.type === "pr-link" && record.prUrl) meta.prUrl = record.prUrl;
  if (record.type === "last-prompt" && record.lastPrompt) meta.lastPrompt = record.lastPrompt;
  if (record.gitBranch) meta.branch = record.gitBranch;
  if (record.cwd) meta.cwd = record.cwd;
  if (at) meta.updatedAt = at;
  if (record.isSidechain) return { events, meta };

  const content = record.message?.content;
  if (record.type === "user") {
    if (typeof content === "string" && !content.startsWith("<")) events.push(event(at, "prompt", content));
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text && !block.text.startsWith("<")) events.push(event(at, "prompt", block.text));
        if (block.type === "tool_result" && block.is_error) {
          const text = Array.isArray(block.content) ? block.content.map((part) => part.text || "").join(" ") : block.content;
          events.push(event(at, "error", summarize(text || "Tool failed", 160), { ok: false }));
        }
      }
    }
  }
  if (record.type === "assistant" && Array.isArray(content)) {
    if (record.message?.model) meta.model = record.message.model;
    const usage = record.message?.usage;
    // Context size of the latest call: what the session is carrying right now.
    if (usage) meta.tokens = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.output_tokens || 0);
    for (const block of content) {
      if (block.type === "tool_use") events.push(toolEvent(at, block));
      if (block.type === "text" && block.text?.trim()) events.push(event(at, "message", block.text, { detail: summarize(block.text, 1200) }));
    }
  }
  if (record.type === "system" && record.stopReason) events.push(event(at, "status", `Stopped: ${record.stopReason}`));
  return { events, meta };
}

function readFrom(path, start) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const from = Math.min(start, size);
    const length = size - from;
    const buffer = Buffer.alloc(length);
    if (length) readSync(fd, buffer, 0, length, from);
    return { text: buffer.toString("utf8"), size };
  } finally {
    closeSync(fd);
  }
}

// Incremental reader keyed by file path. Keeps a bounded window of events.
export function tailTranscript(path) {
  if (!existsSync(path)) return null;
  let state = tails.get(path);
  const size = statSync(path).size;
  if (!state || size < state.offset) {
    state = { offset: Math.max(0, size - INITIAL_TAIL_BYTES), partial: "", events: [], meta: {}, skipFirst: size > INITIAL_TAIL_BYTES };
    tails.set(path, state);
  }
  if (size === state.offset) return state;
  const { text, size: end } = readFrom(path, state.offset);
  state.offset = end;
  const lines = (state.partial + text).split("\n");
  state.partial = lines.pop() || "";
  if (state.skipFirst) {
    lines.shift();
    state.skipFirst = false;
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = parseClaudeRecord(record, state.meta);
    state.events.push(...parsed.events);
  }
  if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
  return state;
}

export function transcriptPath(home, cwd, sessionId) {
  return join(home, "projects", claudeProjectSlug(cwd), `${sessionId}.jsonl`);
}

const STATUS = { busy: "working", waiting: "needs-you", idle: "idle" };

function sessionFromTail(base, tail) {
  const events = tail?.events || [];
  const meta = tail?.meta || {};
  return {
    ...base,
    title: base.title || meta.title || summarize(meta.lastPrompt || events.find((entry) => entry.kind === "prompt")?.title || "Claude Code session", 90),
    branch: meta.branch || base.branch || "",
    model: meta.model || "",
    tokens: meta.tokens || 0,
    tokensKind: "context",
    prUrl: meta.prUrl || "",
    updatedAt: base.updatedAt || meta.updatedAt || null,
    current: currentLine(events),
    recent: events.slice(-40)
  };
}

export function listLiveClaudeSessions({ home = claudeHome(), isAlive = isPidAlive } = {}) {
  const sessions = [];
  const registry = join(home, "sessions");
  if (existsSync(registry)) {
    for (const file of readdirSync(registry)) {
      if (!file.endsWith(".json")) continue;
      let info;
      try {
        info = JSON.parse(readFileSync(join(registry, file), "utf8"));
      } catch {
        continue;
      }
      if (!info.sessionId || !isAlive(info.pid)) continue;
      const tail = tailTranscript(transcriptPath(home, info.cwd, info.sessionId));
      sessions.push(sessionFromTail({
        id: `claude:${info.sessionId}`,
        provider: "claude",
        sessionId: info.sessionId,
        pid: info.pid,
        title: info.name || "",
        cwd: info.cwd,
        status: STATUS[info.status] || "idle",
        waitingFor: info.waitingFor || "",
        startedAt: info.startedAt ? new Date(info.startedAt).toISOString() : null,
        updatedAt: info.updatedAt ? new Date(info.updatedAt).toISOString() : null,
        entrypoint: info.entrypoint || "",
        live: true
      }, tail));
    }
  }

  return sessions;
}

// Recently finished sessions: transcripts touched in the window, no live process.
export function listRecentClaudeSessions({ home = claudeHome(), now = Date.now(), recentHours = 168, exclude = new Set() } = {}) {
  const sessions = [];
  const projects = join(home, "projects");
  const cutoff = now - recentHours * 3_600_000;
  if (existsSync(projects)) {
    for (const folder of readdirSync(projects, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue;
      const dir = join(projects, folder.name);
      let files = [];
      try {
        files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const file of files) {
        const sessionId = file.slice(0, -6);
        if (exclude.has(sessionId)) continue;
        const path = join(dir, file);
        const mtime = statSync(path).mtimeMs;
        if (mtime < cutoff) continue;
        const tail = tailTranscript(path);
        if (!tail?.events.length) continue;
        sessions.push(sessionFromTail({
          id: `claude:${sessionId}`,
          provider: "claude",
          sessionId,
          cwd: tail.meta.cwd || "",
          status: "done",
          updatedAt: new Date(mtime).toISOString(),
          live: false
        }, tail));
      }
    }
  }
  return sessions;
}

export function listClaudeSessions(options = {}) {
  const live = listLiveClaudeSessions(options);
  const exclude = new Set(live.map((session) => session.sessionId));
  return [...live, ...listRecentClaudeSessions({ ...options, exclude })];
}

export function clearClaudeTails() {
  tails.clear();
}
