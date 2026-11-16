// Only public CLI metadata is read here; authentication remains with each CLI.
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { codexHome, resolveClaudeCommand, resolveCodexCommand } from "./paths.js";

const exec = promisify(execFile);
const cache = new Map();
const DEFAULT_MODEL = { id: "", label: "Provider default", efforts: [] };
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
// Claude Code has no command that lists models, so releases are listed here.
// Each family's alias follows new releases; `since` is the first CLI whose
// alias resolves to a model with effort support.
const CLAUDE_FAMILIES = [
  { family: "Fable", alias: "fable", releases: [["claude-fable-5-1", "Fable 5.1"]] },
  { family: "Opus", alias: "opus", since: "2.1.280", releases: [["claude-opus-5-5", "Opus 5.5"], ["claude-opus-5", "Opus 5"]] },
  { family: "Sonnet", alias: "sonnet", since: "2.1.284", releases: [["claude-sonnet-5-5", "Sonnet 5.5"]] },
  { family: "Haiku", alias: "haiku", since: "2.1.293", releases: [["claude-haiku-5-5", "Haiku 5.5"]] }
];

function claudeModels(version, help, levels) {
  const models = [];
  for (const { family, alias, since, releases } of CLAUDE_FAMILIES) {
    // Only CLIs that already know the fable alias mention it in their help.
    if (since || help.includes(`'${alias}'`)) {
      models.push({ id: alias, label: `${family} · latest`, family, efforts: since && compareVersion(version, since) < 0 ? [] : levels });
    }
    // A pinned release can't resolve to an older model, so no version gate.
    models.push(...releases.map(([id, label]) => ({ id, label, family, efforts: levels })));
  }
  return models;
}

// True unless the provider clearly ran something other than what was asked
// for. An alias matches any release of its family; a pinned release must match
// exactly, apart from a context-size suffix such as "[1m]".
export function sameModel(requested, reported) {
  if (!requested || !reported) return true;
  const strip = (id) => id.replace(/\[[^\]]*\]$/, "");
  if (strip(requested) === strip(reported)) return true;
  return CLAUDE_FAMILIES.some((entry) => entry.alias === requested) && reported.startsWith(`claude-${requested}-`);
}

export async function probeCli(command, args) {
  try {
    const result = await exec(command, args, { timeout: 8000, windowsHide: true, maxBuffer: 256_000 });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { ok: false, stdout: error.stdout || "", stderr: error.stderr || error.message };
  }
}

export async function codexModels(env = process.env) {
  try {
    const data = JSON.parse(await readFile(join(codexHome(env), "models_cache.json"), "utf8"));
    return data.models.filter((model) => model.slug && model.visibility !== "hide").map((model) => ({
      id: model.slug,
      label: model.display_name || model.slug,
      efforts: (model.supported_reasoning_levels || []).map((level) => level.effort).filter((level) => EFFORTS.includes(level))
    }));
  } catch {
    return [];
  }
}

export async function inspectProvider(provider, config = {}, { env = process.env, probe = probeCli, fresh = false } = {}) {
  const command = provider === "claude" ? resolveClaudeCommand(config, env) : resolveCodexCommand(config, env);
  let stamp = "";
  try { const value = await stat(command); stamp = `${value.size}:${value.mtimeMs}`; } catch {}
  const key = `${provider}:${command}:${stamp}:${codexHome(env)}`;
  const cached = cache.get(key);
  if (!fresh && probe === probeCli && cached && Date.now() - cached.at < 30_000) return cached.value;
  const value = (async () => {
    const result = { command, found: false, ready: false, authenticated: false, version: "", models: [DEFAULT_MODEL], error: "" };
    const version = await probe(command, ["--version"]);
    const match = (version.stdout || "").match(provider === "claude" ? /(\d+\.\d+\.\d+[^\s]*)\s*\(Claude Code\)/i : /codex-cli\s+(\d+\.\d+\.\d+[^\s]*)/i);
    if (!version.ok || !match) {
      result.error = provider === "claude"
        ? "Claude Code CLI is missing or cannot run. Install it from code.claude.com/docs/en/setup, then run claude auth login with your subscription. Claude Desktop alone is not the CLI."
        : `Codex CLI cannot run. Update Codex or check agents.codexCommand. ${version.stderr || "The executable did not identify itself as Codex CLI."}`;
      return result;
    }
    result.found = true;
    result.version = match[1];
    const help = await probe(command, provider === "claude" ? ["--help"] : ["exec", "--help"]);
    if (!help.ok || !help.stdout.includes(provider === "claude" ? "--output-format" : "--json")) {
      result.error = "This CLI does not support dashboard runs. Update it and refresh setup.";
      return result;
    }
    if (provider === "claude") {
      const effortLine = help.stdout.match(/--effort\b[\s\S]*?(?=\n {2}--|$)/)?.[0] || "";
      const levels = ["low", "medium", "high", "xhigh", "max"].filter((level) => new RegExp(`\\b${level}\\b`).test(effortLine));
      result.models.push(...claudeModels(result.version, help.stdout, levels));
    } else {
      result.models.push(...await codexModels(env));
      const configCheck = await probe(command, ["features", "list"]);
      if (!configCheck.ok) {
        result.error = `Codex could not load its configuration. Update Codex or correct the reported setting; Jarvis will not bypass your configuration. ${configCheck.stderr.slice(-1500)}`;
        return result;
      }
    }
    const auth = await probe(command, provider === "claude" ? ["auth", "status"] : ["login", "status"]);
    let signedIn = auth.ok;
    if (provider === "claude") {
      try { signedIn = auth.ok && JSON.parse(auth.stdout).loggedIn === true; } catch { signedIn = false; }
    }
    result.authenticated = signedIn;
    result.ready = signedIn;
    if (!signedIn) result.error = `Sign in once with ${provider === "claude" ? "claude auth login (choose your Claude subscription)" : "codex login"}, then refresh setup.`;
    return result;
  })();
  if (probe === probeCli) cache.set(key, { at: Date.now(), value });
  return value;
}

function compareVersion(a, b) {
  const left = a.split(".").map((part) => parseInt(part, 10));
  const right = b.split(".").map((part) => parseInt(part, 10));
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

export function validateSelection(info, { model = "", effort = "" } = {}) {
  const invalid = (message) => { const error = new Error(message); error.status = 400; throw error; };
  if (typeof model !== "string" || typeof effort !== "string") invalid("Model and reasoning strength must be strings.");
  const selected = info.models.find((entry) => entry.id === model);
  if (!selected) invalid("That model is not in the current catalog. Refresh setup and choose again.");
  if (effort && !selected.efforts.includes(effort)) invalid("That reasoning strength is not supported by the selected model. Choose a supported strength or Provider default.");
  return { model, effort };
}
