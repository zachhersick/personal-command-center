// Hooks let Claude Code and Codex push events to Jarvis the moment they happen
// (a tool call, "I need your input", a finished turn) instead of Jarvis
// noticing on its next poll.
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { summarize, baseName } from "./events.js";
import { claudeHome } from "./paths.js";

export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Notification", "Stop"];
const MARKER = "jarvis-agent-hook";

export class HookStore {
  constructor() {
    this.bySession = new Map();
    this.counts = { claude: 0, codex: 0 };
    this.lastAt = null;
  }

  ingest(body = {}) {
    const provider = body.provider === "codex" ? "codex" : "claude";
    const payload = body.event && typeof body.event === "object" ? body.event : {};
    const sessionId = String(payload.session_id || payload.sessionId || payload.thread_id || "").slice(0, 100);
    const name = String(payload.hook_event_name || payload.hookEventName || payload.type || "").slice(0, 60);
    if (!sessionId || !name) {
      const error = new Error("Hook events need a session id and an event name.");
      error.status = 400;
      throw error;
    }
    const at = new Date().toISOString();
    const entry = this.bySession.get(sessionId) || { provider, sessionId, events: [] };
    const record = { at, name, cwd: payload.cwd || "", tool: payload.tool_name || "", message: summarize(payload.message || payload.prompt || "", 200) };
    const input = payload.tool_input || {};
    if (record.tool === "Bash") record.detail = summarize(input.command, 140);
    else if (input.file_path) record.detail = baseName(input.file_path);
    entry.events = [...entry.events, record].slice(-20);
    entry.last = record;
    this.bySession.set(sessionId, entry);
    this.counts[provider] += 1;
    this.lastAt = at;
    if (this.bySession.size > 200) this.bySession.delete(this.bySession.keys().next().value);
    return record;
  }

  // Status hints for the registry: hooks are newer than file polling.
  hint(sessionId) {
    const entry = this.bySession.get(sessionId);
    if (!entry?.last) return null;
    const { name, tool, detail, message, at } = entry.last;
    if (name === "Notification") return { at, status: "needs-you", waitingFor: message || "Waiting for you" };
    if (name === "Stop") return { at, status: "idle" };
    if (name === "PostToolUse" || name === "UserPromptSubmit" || name === "SessionStart") {
      return { at, status: "working", current: tool ? `${tool === "Bash" ? "Ran" : tool} ${detail || ""}`.trim() : message ? `Prompt: ${message}` : "" };
    }
    return null;
  }

  stats() {
    return { counts: { ...this.counts }, lastAt: this.lastAt, sessions: this.bySession.size };
  }
}

// The script each hook runs. Copied into the data folder so it works the same
// for the packaged app (whose code sits inside an asar archive).
export function hookScriptSource(defaultPort) {
  return `#!/usr/bin/env node
// ${MARKER}: forwards Claude Code / Codex hook events to Jarvis.
// Never blocks the agent: always exits 0, gives up after 700ms.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const provider = process.argv[2] === "codex" ? "codex" : "claude";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  try {
    const event = JSON.parse(input || "{}");
    const ports = [];
    try {
      const runtime = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "desktop-runtime.local.json"), "utf8"));
      if (runtime.port) ports.push(runtime.port);
    } catch {}
    ports.push(${Number(defaultPort) || 4317});
    for (const port of [...new Set(ports)]) {
      try {
        await fetch(\`http://127.0.0.1:\${port}/api/agents/hook\`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider, event }),
          signal: AbortSignal.timeout(700)
        });
      } catch {}
    }
  } catch {}
  process.exit(0);
});
setTimeout(() => process.exit(0), 1500).unref();
`;
}

export function hookScriptPath(dataRoot) {
  return join(dataRoot, "hooks", "agent-hook.mjs");
}

function hookCommand(scriptPath, provider = "claude") {
  return `node "${scriptPath.replace(/\\/g, "/")}" ${provider}`;
}

function isJarvisHook(entry) {
  return (entry?.hooks || []).some((hook) => String(hook.command || "").includes("agent-hook.mjs"));
}

// Adds Jarvis's hooks to a Claude settings object without touching anything
// else that's already there. Returns a new object.
export function mergeHooks(settings = {}, scriptPath) {
  const next = JSON.parse(JSON.stringify(settings || {}));
  next.hooks = next.hooks && typeof next.hooks === "object" ? next.hooks : {};
  for (const name of HOOK_EVENTS) {
    const list = Array.isArray(next.hooks[name]) ? next.hooks[name].filter((entry) => !isJarvisHook(entry)) : [];
    list.push({ hooks: [{ type: "command", command: hookCommand(scriptPath), timeout: 5 }] });
    next.hooks[name] = list;
  }
  return next;
}

export function removeHooks(settings = {}) {
  const next = JSON.parse(JSON.stringify(settings || {}));
  if (!next.hooks) return next;
  for (const [name, list] of Object.entries(next.hooks)) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter((entry) => !isJarvisHook(entry));
    if (kept.length) next.hooks[name] = kept;
    else delete next.hooks[name];
  }
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return next;
}

export function settingsPath(scope, projectPath, env = process.env) {
  if (scope === "project") {
    if (!projectPath) throw Object.assign(new Error("Pick a project for project-scoped hooks."), { status: 400 });
    return join(projectPath, ".claude", "settings.json");
  }
  return join(claudeHome(env), "settings.json");
}

export function hooksInstalled(settings = {}) {
  return HOOK_EVENTS.every((name) => (settings.hooks?.[name] || []).some(isJarvisHook));
}

export async function planHookInstall({ scope = "user", projectPath, dataRoot, defaultPort, remove = false, env = process.env }) {
  const path = settingsPath(scope, projectPath, env);
  const before = existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : {};
  const script = hookScriptPath(dataRoot);
  const after = remove ? removeHooks(before) : mergeHooks(before, script);
  return {
    path,
    script,
    before: JSON.stringify(before, null, 2),
    after: JSON.stringify(after, null, 2),
    changed: JSON.stringify(before) !== JSON.stringify(after),
    installed: hooksInstalled(before),
    codexSnippet: JSON.stringify({ hooks: Object.fromEntries(HOOK_EVENTS.map((name) => [name, [{ hooks: [{ type: "command", command: hookCommand(script, "codex") }] }]])) }, null, 2),
    apply: async () => {
      await mkdir(dirname(script), { recursive: true });
      await writeFile(script, hookScriptSource(defaultPort), "utf8");
      await mkdir(dirname(path), { recursive: true });
      if (existsSync(path)) await copyFile(path, `${path}.jarvis-backup-${Date.now()}`);
      await writeFile(path, `${JSON.stringify(after, null, 2)}\n`, "utf8");
    }
  };
}
