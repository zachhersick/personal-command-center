// Token use per day for the Agents usage tab. Claude Code writes every API
// response's usage into its transcripts; Codex keeps a running total per
// thread. Only usage numbers, model names and timestamps are read here.
import { existsSync, readdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { codexUsageRows } from "./codex-source.js";

export const USAGE_DAYS = 14;

// "2026-10-25" in the given time zone (the computer's when omitted).
export function dayOf(at, timeZone) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function dayKeys(now, days, timeZone) {
  const keys = [];
  for (let back = days - 1; back >= 0; back -= 1) keys.push(dayOf(now - back * 86_400_000, timeZone));
  // Daylight-saving changes can repeat or skip a key when stepping by 24h.
  return [...new Set(keys)];
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// claude: [{ at, model, input, output, cacheRead, cacheWrite }]
// codex:  [{ at, model, tokens }]    runs: launcher runs (their turns carry tokens)
export function aggregateUsage({ claude = [], codex = null, runs = [], days = USAGE_DAYS, now = Date.now(), timeZone } = {}) {
  const keys = dayKeys(now, days, timeZone);
  const byDay = new Map(keys.map((day) => [day, { day, claude: 0, claudeCacheRead: 0, codex: 0, jarvis: 0 }]));
  const models = new Map();
  const model = (provider, name) => {
    const key = `${provider}:${name || "unknown"}`;
    if (!models.has(key)) models.set(key, { provider, model: name || "unknown", tokens: 0, cacheRead: 0 });
    return models.get(key);
  };
  for (const entry of claude) {
    const day = byDay.get(dayOf(entry.at, timeZone));
    if (!day) continue;
    // Fresh tokens: what was sent new (input and cache writes) plus output.
    // Cache reads are re-sent context, so they're shown on their own.
    const fresh = (entry.input || 0) + (entry.cacheWrite || 0) + (entry.output || 0);
    day.claude += fresh;
    day.claudeCacheRead += entry.cacheRead || 0;
    const row = model("claude", entry.model);
    row.tokens += fresh;
    row.cacheRead += entry.cacheRead || 0;
  }
  for (const entry of codex || []) {
    const day = byDay.get(dayOf(entry.at, timeZone));
    if (!day) continue;
    day.codex += entry.tokens || 0;
    model("codex", entry.model).tokens += entry.tokens || 0;
  }
  for (const run of runs) {
    for (const turn of run.turns || []) {
      const day = byDay.get(dayOf(turn.startedAt, timeZone));
      if (day) day.jarvis += turn.tokens || 0;
    }
  }
  const list = [...byDay.values()];
  const today = list[list.length - 1];
  const week = list.slice(-7).reduce((sum, day) => ({ claude: sum.claude + day.claude, codex: sum.codex + day.codex }), { claude: 0, codex: 0 });
  // Codex's figure includes re-sent context and Claude's doesn't, so each
  // provider is only ever compared with itself.
  const pace = (provider) => {
    const usual = median(list.slice(-8, -1).map((day) => day[provider]));
    return { usual, ratio: usual ? today[provider] / usual : null, fast: usual > 0 && today[provider] > usual * 2 };
  };
  return {
    days: list,
    today,
    week,
    pace: { claude: pace("claude"), codex: pace("codex") },
    models: [...models.values()].filter((row) => row.tokens || row.cacheRead).sort((a, b) => b.tokens - a.tokens),
    sources: { claude: true, codex: codex !== null }
  };
}

// One usage record per API response. Claude Code writes a response once per
// content block, all with the same message id, so later copies are skipped.
export function claudeUsageRecord(line) {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return null;
  let record;
  try { record = JSON.parse(line); } catch { return null; }
  const message = record?.message;
  const usage = message?.usage;
  if (record?.type !== "assistant" || !usage || !message.id) return null;
  return {
    id: message.id,
    at: record.timestamp,
    model: message.model || "",
    input: Number(usage.input_tokens) || 0,
    output: Number(usage.output_tokens) || 0,
    cacheRead: Number(usage.cache_read_input_tokens) || 0,
    cacheWrite: Number(usage.cache_creation_input_tokens) || 0
  };
}

function transcripts(dir, since, found = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) transcripts(path, since, found);
    else if (entry.name.endsWith(".jsonl")) {
      try {
        const stat = statSync(path);
        if (stat.mtimeMs >= since) found.push({ path, size: stat.size });
      } catch { /* Removed while listing. */ }
    }
  }
  return found;
}

// Transcripts only grow, so each file is read once and then only from where
// the last read stopped.
export function createClaudeUsageReader() {
  const files = new Map();
  // Reads complete lines between the last stop and `end`. Returns where the
  // next read should start, so a half-written last line is read whole later.
  async function readFrom(path, start, end, file) {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(end - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const last = buffer.lastIndexOf(10, bytesRead - 1);
      if (last < 0) return start;
      for (const line of buffer.subarray(0, last).toString("utf8").split("\n")) {
        const record = claudeUsageRecord(line);
        if (record && !file.ids.has(record.id)) {
          file.ids.add(record.id);
          file.records.push(record);
        }
      }
      return start + last + 1;
    } finally {
      await handle.close();
    }
  }
  return async function read(home, since) {
    const root = join(home, "projects");
    if (!existsSync(root)) return [];
    const out = [];
    for (const { path, size } of transcripts(root, since)) {
      let file = files.get(path);
      // A file that shrank was rewritten; start over.
      if (!file || size < file.size) file = { size: 0, ids: new Set(), records: [] };
      if (size > file.size) file.size = await readFrom(path, file.size, size, file);
      files.set(path, file);
      out.push(...file.records);
    }
    // The same response can appear in a resumed session's copy of the transcript.
    const seen = new Set();
    return out.filter((record) => record.at && Date.parse(record.at) >= since && !seen.has(record.id) && seen.add(record.id));
  };
}

export async function collectUsage({ claudeHome, codexHome, runs, days = USAGE_DAYS, now = Date.now(), readClaude, timeZone }) {
  const since = now - days * 86_400_000;
  const [claude, codex] = await Promise.all([
    readClaude(claudeHome, since).catch(() => []),
    codexUsageRows({ home: codexHome, since }).catch(() => null)
  ]);
  return aggregateUsage({ claude, codex, runs, days, now, timeZone });
}
