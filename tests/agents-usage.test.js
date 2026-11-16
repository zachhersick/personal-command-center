import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateUsage, claudeUsageRecord, createClaudeUsageReader, dayOf } from "../server/agents/usage.js";
import { removeTempDir } from "./helpers.js";

const TZ = "America/Los_Angeles";
// Noon on 25 October 2026 in Los Angeles.
const NOW = Date.parse("2026-10-25T19:00:00Z");

const line = (id, at, usage, extra = {}) => JSON.stringify({
  type: "assistant",
  timestamp: at,
  message: { id, model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "private words" }], usage },
  ...extra
});

test("days are counted in the computer's time zone, not UTC", () => {
  // 01:00 UTC on the 25th is still the evening of the 24th in Los Angeles.
  assert.equal(dayOf("2026-10-25T01:00:00Z", TZ), "2026-10-24");
  assert.equal(dayOf("2026-10-25T08:00:00Z", TZ), "2026-10-25");
  assert.equal(dayOf("not a date", TZ), "");
});

test("one usage record per response, without any transcript text", () => {
  const record = claudeUsageRecord(line("msg_1", "2026-10-25T18:00:00Z", { input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 }));
  assert.deepEqual(record, { id: "msg_1", at: "2026-10-25T18:00:00Z", model: "claude-opus-5-5", input: 2, output: 100, cacheRead: 5000, cacheWrite: 300 });
  assert.equal(claudeUsageRecord('{"type":"user","message":{"content":"usage"}}'), null);
  assert.equal(claudeUsageRecord('{"type":"assistant","usage": broken'), null);
});

test("the reader dedupes repeated blocks, reads only what grew, and waits for whole lines", async () => {
  const home = await mkdtemp(join(tmpdir(), "jarvis-usage-"));
  try {
    const dir = join(home, "projects", "C--Dev-jarvis", "session", "subagents");
    await mkdir(dir, { recursive: true });
    const main = join(home, "projects", "C--Dev-jarvis", "session.jsonl");
    const usage = { input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    // Claude Code writes one line per content block, all with the same id.
    await writeFile(main, [line("a", "2026-10-25T18:00:00Z", usage), line("a", "2026-10-25T18:00:01Z", usage), line("b", "2026-10-25T18:01:00Z", usage), "{not json"].join("\n") + "\n");
    await writeFile(join(dir, "agent-1.jsonl"), line("c", "2026-10-25T18:02:00Z", usage) + "\n");
    const read = createClaudeUsageReader();
    let records = await read(home, NOW - 86_400_000);
    assert.deepEqual(records.map((record) => record.id).sort(), ["a", "b", "c"]);

    // Half a line arrives: it isn't counted, and isn't lost once it's finished.
    const next = line("d", "2026-10-25T18:03:00Z", usage);
    await appendFile(main, next.slice(0, 40));
    records = await read(home, NOW - 86_400_000);
    assert.equal(records.length, 3);
    await appendFile(main, `${next.slice(40)}\n`);
    records = await read(home, NOW - 86_400_000);
    assert.deepEqual(records.map((record) => record.id).sort(), ["a", "b", "c", "d"]);
  } finally { await removeTempDir(home); }
});

test("totals split fresh tokens from cache reads, count Jarvis runs as a slice, and flag a fast day", () => {
  const claude = [
    { at: "2026-10-25T18:00:00Z", model: "claude-opus-5-5", input: 10, output: 90, cacheRead: 1000, cacheWrite: 100 },
    { at: "2026-10-24T18:00:00Z", model: "claude-haiku-5-5", input: 5, output: 45, cacheRead: 0, cacheWrite: 0 },
    { at: "2026-09-01T18:00:00Z", model: "claude-opus-5-5", input: 9999, output: 9999, cacheRead: 0, cacheWrite: 0 }
  ];
  const codex = [{ at: "2026-10-23T18:00:00Z", model: "gpt-6.1-sol", tokens: 50 }];
  const runs = [{ turns: [{ startedAt: "2026-10-25T17:00:00Z", tokens: 40 }] }];
  const usage = aggregateUsage({ claude, codex, runs, days: 14, now: NOW, timeZone: TZ });
  assert.equal(usage.days.length, 14);
  assert.deepEqual(usage.today, { day: "2026-10-25", claude: 200, claudeCacheRead: 1000, codex: 0, jarvis: 40 });
  assert.deepEqual(usage.week, { claude: 250, codex: 50 });
  assert.deepEqual(usage.models.map((row) => [row.model, row.tokens]), [["claude-opus-5-5", 200], ["claude-haiku-5-5", 50], ["gpt-6.1-sol", 50]]);
  // The previous seven days were mostly empty, so the median is 0 and nothing is flagged.
  assert.equal(usage.pace.claude.fast, false);
  const busy = aggregateUsage({ claude: [...Array.from({ length: 7 }, (_, back) => ({ at: new Date(NOW - (back + 1) * 86_400_000).toISOString(), model: "m", input: 0, output: 100, cacheRead: 0, cacheWrite: 0 })), { at: new Date(NOW).toISOString(), model: "m", input: 0, output: 300, cacheRead: 0, cacheWrite: 0 }], now: NOW, timeZone: TZ });
  assert.equal(busy.pace.claude.usual, 100);
  assert.equal(busy.pace.claude.fast, true);
  assert.equal(busy.pace.codex.fast, false, "providers are paced separately");
  assert.equal(aggregateUsage({ codex: null, now: NOW, timeZone: TZ }).sources.codex, false);
});
