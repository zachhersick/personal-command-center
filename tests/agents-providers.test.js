import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexCandidates, cliVersion, resolveClaudeCommand, resolveCodexCommand } from "../server/agents/paths.js";
import { codexModels, inspectProvider, sameModel, validateSelection } from "../server/agents/providers.js";
import { removeTempDir } from "./helpers.js";

const success = (stdout = "") => ({ ok: true, stdout, stderr: "" });

test("Windows discovers versioned Codex and native Claude without launching Desktop", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-cli-paths-"));
  try {
    const versioned = join(root, "OpenAI", "Codex", "bin", "version-hash", "codex.exe");
    await mkdir(join(versioned, ".."), { recursive: true });
    await writeFile(versioned, "fixture");
    assert.ok(codexCandidates({ LOCALAPPDATA: root }, { platform: "win32" }).includes(versioned));
    const native = join(root, ".local", "bin", "claude.exe");
    await mkdir(join(native, ".."), { recursive: true });
    await writeFile(native, "fixture");
    assert.equal(resolveClaudeCommand({}, {}, { platform: "win32", home: root }), native);
    assert.equal(resolveCodexCommand({}, {}, { platform: "win32", candidates: () => ["broken", "works"], version: (path) => path === "broken" ? [0, 0, 0] : [1, 0, 0] }), "works");
  } finally { await removeTempDir(root); }
});

test("an executable replaced in place is probed again", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-cli-version-"));
  try {
    const path = join(root, "cli");
    await writeFile(path, "v1");
    assert.deepEqual(cliVersion(path, () => "1.0.0"), [1, 0, 0]);
    await writeFile(path, "v2-longer");
    await utimes(path, new Date(), new Date(Date.now() + 1000));
    assert.deepEqual(cliVersion(path, () => "2.0.0"), [2, 0, 0]);
  } finally { await removeTempDir(root); }
});

test("readiness reports missing CLI, auth, and config failures without bypassing settings", async () => {
  const config = { agents: { codexCommand: "fixture-codex", claudeCommand: "fixture-claude" } };
  const missing = await inspectProvider("claude", config, { probe: async () => ({ ok: false, stderr: "ENOENT" }) });
  assert.equal(missing.ready, false);
  assert.match(missing.error, /Claude Desktop alone/);
  const seen = [];
  const configError = await inspectProvider("codex", config, { probe: async (_, args) => {
    seen.push(args);
    if (args[0] === "--version") return success("codex-cli 0.163.0");
    if (args[0] === "exec") return success("--json --model");
    return { ok: false, stderr: "unknown variant 'default', expected 'fast' or 'flex'" };
  } });
  assert.equal(configError.ready, false);
  assert.match(configError.error, /unknown variant/);
  assert.ok(!seen.flat().some((arg) => /ignore|bypass/.test(arg)));
  const info = await inspectProvider("claude", config, { probe: async (_, args) => {
    if (args[0] === "--version") return success("2.1.300 (Claude Code)");
    if (args[0] === "--help") return success('--output-format\n  --effort <level> Effort level\n                                        (low, medium, high, xhigh, max)\n  --model <model>');
    return success('{"loggedIn":false}');
  } });
  assert.equal(info.found, true);
  assert.equal(info.ready, false);
  assert.match(info.error, /auth login/);
  assert.deepEqual(info.models.find((model) => model.id === "opus").efforts, ["low", "medium", "high", "xhigh", "max"]);
  validateSelection(info, { model: "opus", effort: "high" });
  assert.throws(() => validateSelection(info, { model: "opus", effort: "ultra" }), /not supported/);
  assert.throws(() => validateSelection(info, { model: "invented" }), /not in the current catalog/);
  assert.throws(() => validateSelection(info, { model: 4 }), /must be strings/);
  const older = await inspectProvider("claude", config, { probe: async (_, args) => {
    if (args[0] === "--version") return success("2.1.100 (Claude Code)");
    if (args[0] === "--help") return success('--output-format\n  --effort <level> (low, medium, high, xhigh, max)');
    return success('{"loggedIn":true}');
  } });
  assert.ok(older.models.filter((model) => !model.id.startsWith("claude-")).every((model) => model.efforts.length === 0), "unknown older aliases never advertise silently downgraded effort");
});

test("Claude catalog lists releases by family next to the latest aliases", async () => {
  const config = { agents: { claudeCommand: "fixture-claude-releases" } };
  const probeWith = (version, help) => async (_, args) => {
    if (args[0] === "--version") return success(`${version} (Claude Code)`);
    if (args[0] === "--help") return success(help);
    return success('{"loggedIn":true}');
  };
  const help = "--output-format\n  --effort <level> (low, medium, high, xhigh, max)\n  --model <model> an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet')";
  const info = await inspectProvider("claude", config, { probe: probeWith("2.1.308", help) });
  const byId = Object.fromEntries(info.models.map((model) => [model.id, model]));
  assert.deepEqual([byId["claude-opus-5-5"].label, byId["claude-opus-5-5"].family], ["Opus 5.5", "Opus"]);
  assert.deepEqual([byId["claude-opus-5"].label, byId["claude-opus-5"].family], ["Opus 5", "Opus"]);
  assert.equal(byId.opus.family, "Opus");
  assert.ok(byId.fable && byId["claude-fable-5-1"]);
  assert.deepEqual(byId["claude-haiku-5-5"].efforts, ["low", "medium", "high", "xhigh", "max"]);
  validateSelection(info, { model: "opus", effort: "high" });
  validateSelection(info, { model: "claude-opus-5", effort: "max" });

  const older = await inspectProvider("claude", config, { probe: probeWith("2.1.100", "--output-format\n  --effort <level> (low, medium, high, xhigh, max)") });
  const olderIds = older.models.map((model) => model.id);
  assert.ok(!olderIds.includes("fable"), "the fable alias is offered only by CLIs that know it");
  assert.deepEqual(older.models.find((model) => model.id === "opus").efforts, []);
  assert.deepEqual(older.models.find((model) => model.id === "claude-opus-5-5").efforts, ["low", "medium", "high", "xhigh", "max"], "a pinned release can't drift to an older model");
});

test("a reported model matches its alias but not a different release", () => {
  assert.equal(sameModel("opus", "claude-opus-5-5"), true);
  assert.equal(sameModel("claude-opus-5-5", "claude-opus-5-5[1m]"), true);
  assert.equal(sameModel("claude-opus-5", "claude-opus-5-5"), false);
  assert.equal(sameModel("sonnet", "claude-opus-5-5"), false);
  assert.equal(sameModel("gpt-6.1-sol", "gpt-6.1-sol"), true);
  assert.equal(sameModel("", "anything"), true, "provider default accepts whatever ran");
  assert.equal(sameModel("opus", ""), true, "nothing reported is not a mismatch");
});

test("Codex catalog reads only model and reasoning metadata, with a safe missing-cache fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-models-"));
  try {
    const env = { JARVIS_CODEX_HOME: root };
    assert.deepEqual(await codexModels(env), []);
    await writeFile(join(root, "models_cache.json"), JSON.stringify({ models: [{ slug: "test-model", display_name: "Test model", instructions: "private instructions", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }] }));
    assert.deepEqual(await codexModels(env), [{ id: "test-model", label: "Test model", efforts: ["low", "high"] }]);
  } finally { await removeTempDir(root); }
});
