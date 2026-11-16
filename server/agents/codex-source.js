// Reads Codex sessions ("threads") from its SQLite stores. Opened read-only;
// Codex writes with WAL so readers never block it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { codexHome } from "./paths.js";
import { baseName, currentLine, event, summarize } from "./events.js";

let sqlite = null;
async function sqliteModule() {
  if (sqlite === null) {
    try {
      sqlite = await import("node:sqlite");
    } catch {
      sqlite = false;
    }
  }
  return sqlite;
}

function open(mod, path) {
  if (!mod || !existsSync(path)) return null;
  try {
    return new mod.DatabaseSync(path, { readOnly: true });
  } catch {
    return null;
  }
}

export function cleanCwd(cwd) {
  return String(cwd || "").replace(/^\\\\\?\\/, "");
}

export function parseCodexItem(item, at) {
  switch (item.type) {
    case "userMessage": {
      const text = (item.content || []).map((part) => part.text || "").join(" ");
      return text ? event(at, "prompt", text) : null;
    }
    case "agentMessage":
      return item.text ? event(at, "message", item.text, { detail: summarize(item.text, 1200) }) : null;
    case "commandExecution": {
      const command = item.commandActions?.[0]?.command || item.command || "command";
      const ok = item.exitCode === undefined || item.exitCode === null ? undefined : item.exitCode === 0;
      return event(at, "command", command, { ok, detail: item.exitCode === undefined || item.exitCode === null ? "" : `exit ${item.exitCode}` });
    }
    case "fileChange": {
      const paths = (item.changes || []).map((change) => baseName(change.path));
      return event(at, "edit", paths.slice(0, 3).join(", ") + (paths.length > 3 ? ` +${paths.length - 3}` : ""));
    }
    case "mcpToolCall":
      return event(at, "tool", `${item.server || "mcp"} · ${item.tool || "tool"}`, { ok: item.error ? false : undefined });
    case "webSearch":
      return event(at, "search", item.query || item.action?.queries?.[0] || "web search");
    case "plan":
      return event(at, "plan", "Wrote a plan", { detail: summarize(item.text, 600) });
    case "subAgentActivity":
    case "collabAgentToolCall":
      return event(at, "tool", "Subagent activity");
    case "contextCompaction":
      return event(at, "status", "Compacted context");
    default:
      return null;
  }
}

// Token totals per thread, archived ones included, for the usage tab. Codex
// keeps one running total per thread, so a thread counts on its last day.
export async function codexUsageRows({ home = codexHome(), since = 0 } = {}) {
  const state = open(await sqliteModule(), join(home, "state_5.sqlite"));
  if (!state) return null;
  try {
    return state.prepare("select model, tokens_used, updated_at_ms from threads where updated_at_ms >= ?").all(since)
      .map((row) => ({ at: new Date(row.updated_at_ms).toISOString(), model: row.model || "", tokens: Number(row.tokens_used) || 0 }));
  } finally {
    state.close();
  }
}

const TURN_STATUS = { inProgress: "working", completed: "idle", interrupted: "stopped", failed: "failed" };

export async function listCodexThreads({ home = codexHome(), now = Date.now(), recentHours = 168, eventsFor = 12 } = {}) {
  const mod = await sqliteModule();
  const state = open(mod, join(home, "state_5.sqlite"));
  if (!state) return { available: false, threads: [] };
  const history = open(mod, join(home, "thread_history_1.sqlite"));
  try {
    const cutoff = now - recentHours * 3_600_000;
    const rows = state.prepare(`select id, cwd, title, name, git_branch, model, tokens_used, created_at_ms, updated_at_ms, source, first_user_message, archived
      from threads where updated_at_ms >= ? and archived = 0 order by updated_at_ms desc limit 40`).all(cutoff);
    const lastTurn = history?.prepare("select status, error_json, started_at, completed_at from thread_turns where thread_id = ? order by rollout_ordinal desc limit 1");
    const items = history?.prepare("select item_json, created_at_ms from thread_items where thread_id = ? order by rollout_ordinal desc, rowid desc limit ?");
    const threads = rows.map((row, index) => {
      const turn = lastTurn?.get(row.id);
      let status = TURN_STATUS[turn?.status] || "idle";
      // An "inProgress" turn that hasn't moved for 30 min was abandoned.
      if (status === "working" && now - row.updated_at_ms > 30 * 60_000) status = "stopped";
      if (status === "idle" && now - row.updated_at_ms > 6 * 3_600_000) status = "done";
      const recent = [];
      if (items && index < eventsFor) {
        for (const item of items.all(row.id, 40).reverse()) {
          try {
            const parsed = parseCodexItem(JSON.parse(item.item_json), item.created_at_ms ? new Date(item.created_at_ms).toISOString() : null);
            if (parsed) recent.push(parsed);
          } catch {
            // Skip malformed item rows.
          }
        }
      }
      let error = "";
      if (turn?.error_json) {
        try {
          error = JSON.parse(turn.error_json).message || "";
        } catch {
          error = String(turn.error_json);
        }
      }
      return {
        id: `codex:${row.id}`,
        provider: "codex",
        sessionId: row.id,
        title: summarize(row.name || row.title || row.first_user_message || "Codex thread", 90),
        cwd: cleanCwd(row.cwd),
        branch: row.git_branch || "",
        model: row.model || "",
        tokens: row.tokens_used || 0,
        tokensKind: "used",
        status,
        error: summarize(error, 200),
        source: row.source || "",
        startedAt: row.created_at_ms ? new Date(row.created_at_ms).toISOString() : null,
        updatedAt: row.updated_at_ms ? new Date(row.updated_at_ms).toISOString() : null,
        live: status === "working",
        current: status === "failed" && error ? summarize(error, 120) : currentLine(recent),
        recent
      };
    });
    return { available: true, threads };
  } finally {
    state.close();
    history?.close();
  }
}

export async function codexThreadEvents(threadId, { home = codexHome(), limit = 120 } = {}) {
  const mod = await sqliteModule();
  const history = open(mod, join(home, "thread_history_1.sqlite"));
  if (!history) return [];
  try {
    return history.prepare("select item_json, created_at_ms from thread_items where thread_id = ? order by rollout_ordinal desc, rowid desc limit ?")
      .all(threadId, limit)
      .reverse()
      .map((row) => {
        try {
          return parseCodexItem(JSON.parse(row.item_json), row.created_at_ms ? new Date(row.created_at_ms).toISOString() : null);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } finally {
    history.close();
  }
}
