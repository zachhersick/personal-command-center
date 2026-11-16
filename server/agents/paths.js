import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";

// Where each CLI keeps its state. Tests point these at fixtures.
export function claudeHome(env = process.env) {
  return env.JARVIS_CLAUDE_HOME || join(homedir(), ".claude");
}

export function codexHome(env = process.env) {
  return env.JARVIS_CODEX_HOME || env.CODEX_HOME || join(homedir(), ".codex");
}

// Claude Code names project folders after the cwd with every path separator,
// drive colon and dot replaced by "-" (C:\Dev\jarvis -> C--Dev-jarvis).
export function claudeProjectSlug(cwd) {
  return String(cwd || "").replace(/[\\/:.]/g, "-");
}

function newestMatch(root, depth, name) {
  if (!existsSync(root)) return "";
  let best = { path: "", mtime: 0 };
  const walk = (dir, level) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && level < depth) walk(full, level + 1);
      else if (entry.isFile() && entry.name.toLowerCase() === name) {
        const mtime = statSync(full).mtimeMs;
        if (mtime > best.mtime) best = { path: full, mtime };
      }
    }
  };
  walk(root, 0);
  return best.path;
}

// First match for a command on PATH, without spawning a shell.
export function whichSync(name, env = process.env, { platform = process.platform, exists = existsSync } = {}) {
  const separator = platform === "win32" ? ";" : ":";
  for (const dir of String(env.PATH || "").split(separator)) {
    if (!dir) continue;
    const candidate = platform === "win32" ? join(dir.replace(/^"|"$/g, ""), /\.[a-z]+$/i.test(name) ? name : `${name}.exe`) : posix.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return "";
}

export function resolveClaudeCommand(config = {}, env = process.env, { platform = process.platform, home = homedir(), exists = existsSync, newest = newestMatch } = {}) {
  if (!Array.isArray(config.agents) && config.agents?.claudeCommand) return config.agents.claudeCommand;
  if (env.JARVIS_CLAUDE_COMMAND) return env.JARVIS_CLAUDE_COMMAND;
  const onPath = whichSync("claude", env, { platform, exists });
  if (onPath) return onPath;
  const native = platform === "win32" ? join(home, ".local", "bin", "claude.exe") : posix.join(home, ".local", "bin", "claude");
  if (exists(native)) return native;
  if (platform === "win32" && env.APPDATA) {
    const bundled = newest(join(env.APPDATA, "Claude", "claude-code"), 2, "claude.exe");
    if (bundled) return bundled;
  }
  if (platform === "darwin") {
    // A CLI you installed (and signed in to) beats the copy inside the desktop app.
    const onPath = whichSync("claude", env, { platform, exists });
    if (onPath) return onPath;
    const local = posix.join(home, ".claude", "local", "claude");
    if (exists(local)) return local;
    const bundled = newest(posix.join(home, "Library", "Application Support", "Claude", "claude-code"), 2, "claude");
    if (bundled) return bundled;
  }
  return platform === "win32" ? "claude.exe" : "claude";
}

const versions = new Map();

// "codex-cli 0.160.1" -> [0, 160, 1]; unknown versions sort first.
export function cliVersion(command, probe = (cmd) => execFileSync(cmd, ["--version"], { timeout: 5000, windowsHide: true, encoding: "utf8" })) {
  let stamp = "";
  try { const stat = statSync(command); stamp = `${stat.mtimeMs}:${stat.size}`; } catch {}
  const key = `${command}:${stamp}`;
  if (!versions.has(key)) {
    let parts = [0, 0, 0];
    try {
      const match = /(\d+)\.(\d+)\.(\d+)/.exec(probe(command));
      if (match) parts = match.slice(1).map(Number);
    } catch {
      // Not runnable; leave it at 0.0.0.
    }
    versions.set(key, parts);
  }
  return versions.get(key);
}

function newer(a, b) {
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}

// Windows can have several Codex installs (npm's and the desktop app's own copy).
// Use the newest one, since older builds can't read config written by newer ones.
export function codexCandidates(env = process.env, { platform = process.platform, exists = existsSync, newest = newestMatch } = {}) {
  const found = [];
  if (platform === "darwin") {
    for (const path of [whichSync("codex", env, { platform, exists }), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]) {
      if (path && exists(path) && !found.includes(path)) found.push(path);
    }
    return found;
  }
  const onPath = whichSync("codex", env, { platform, exists });
  if (onPath) found.push(onPath);
  if (env.APPDATA) {
    for (const arch of ["x64", "arm64"]) {
      const vendor = join(env.APPDATA, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", `codex-win32-${arch}`, "vendor");
      const exe = newest(vendor, 2, "codex.exe");
      if (exe) found.push(exe);
    }
  }
  if (env.LOCALAPPDATA) {
    for (const root of [join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin"), join(env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin")]) {
      const direct = join(root, "codex.exe");
      if (exists(direct)) found.push(direct);
      // Desktop updates keep executables in version-specific subdirectories.
      try {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          const candidate = join(root, entry.name, "codex.exe");
          if (entry.isDirectory() && exists(candidate)) found.push(candidate);
        }
      } catch {}
    }
  }
  return [...new Set(found)];
}

export function resolveCodexCommand(config = {}, env = process.env, { candidates = codexCandidates, version = cliVersion, platform = process.platform } = {}) {
  if (!Array.isArray(config.agents) && config.agents?.codexCommand) return config.agents.codexCommand;
  if (env.JARVIS_CODEX_COMMAND) return env.JARVIS_CODEX_COMMAND;
  if (platform === "win32" || platform === "darwin") {
    let best = null;
    for (const path of candidates(env, { platform })) {
      const parts = version(path);
      if (parts.some(Boolean) && (!best || newer(parts, version(best)))) best = path;
    }
    if (best) return best;
  }
  return platform === "win32" ? "codex.exe" : "codex";
}
