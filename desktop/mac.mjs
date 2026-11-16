// macOS helpers. Apps opened from Finder or the Dock get a bare PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), so git, gh, node, claude and codex from
// Homebrew or npm would be invisible. Borrow the login shell's PATH instead.
import { execFileSync } from "node:child_process";

export const MAC_TOOL_DIRS = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"];

export function mergePath(current = "", shell = "", extra = MAC_TOOL_DIRS) {
  const seen = new Set();
  const parts = [];
  for (const entry of [...String(shell).split(":"), ...extra, ...String(current).split(":")]) {
    const dir = entry.trim();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    parts.push(dir);
  }
  return parts.join(":");
}

export function loginShellPath({ shell = process.env.SHELL || "/bin/zsh", exec = execFileSync } = {}) {
  try {
    // -i and -l load the user's profile; the markers skip any banner output.
    const output = String(exec(shell, ["-ilc", 'printf "__JARVIS_PATH__%s__END__" "$PATH"'], { timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    const match = /__JARVIS_PATH__(.*?)__END__/s.exec(output);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

export function fixMacPath(env = process.env, options = {}) {
  env.PATH = mergePath(env.PATH, loginShellPath(options));
  return env.PATH;
}
