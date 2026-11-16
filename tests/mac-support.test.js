import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fixMacPath, loginShellPath, mergePath } from "../desktop/mac.mjs";
import { codexCandidates, resolveClaudeCommand, resolveCodexCommand, whichSync } from "../server/agents/paths.js";

test("a Finder-launched app borrows the login shell's PATH", () => {
  assert.equal(
    mergePath("/usr/bin:/bin", "/Users/z/.npm-global/bin:/opt/homebrew/bin:/usr/bin"),
    "/Users/z/.npm-global/bin:/opt/homebrew/bin:/usr/bin:/opt/homebrew/sbin:/usr/local/bin:/bin"
  );
  const exec = () => "Welcome banner\n__JARVIS_PATH__/opt/homebrew/bin:/usr/bin__END__";
  assert.equal(loginShellPath({ shell: "/bin/zsh", exec }), "/opt/homebrew/bin:/usr/bin");
  assert.equal(loginShellPath({ exec: () => { throw new Error("timeout"); } }), "");
  const env = { PATH: "/usr/bin:/bin" };
  fixMacPath(env, { exec: () => { throw new Error("no shell"); } });
  assert.equal(env.PATH, "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin", "Homebrew is added even without a shell");
});

test("macOS finds claude on PATH before the desktop app's bundled copy", () => {
  const home = "/Users/z";
  const files = new Set(["/opt/homebrew/bin/claude", "/Users/z/.claude/local/claude"]);
  const exists = (path) => files.has(path.replace(/\\/g, "/"));
  const env = { PATH: "/usr/bin:/opt/homebrew/bin" };
  const options = { platform: "darwin", home, exists, newest: () => "/bundled/claude" };
  assert.equal(resolveClaudeCommand({}, env, options).replace(/\\/g, "/"), "/opt/homebrew/bin/claude");
  files.delete("/opt/homebrew/bin/claude");
  assert.equal(resolveClaudeCommand({}, env, options).replace(/\\/g, "/"), "/Users/z/.claude/local/claude");
  files.clear();
  assert.equal(resolveClaudeCommand({}, env, options), "/bundled/claude");
  assert.equal(resolveClaudeCommand({}, env, { ...options, newest: () => "" }), "claude");
  assert.equal(resolveClaudeCommand({ agents: { claudeCommand: "/mine/claude" } }, env, options), "/mine/claude");
});

test("macOS picks the newest codex it can find", () => {
  const files = new Set(["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]);
  const exists = (path) => files.has(path.replace(/\\/g, "/"));
  const found = codexCandidates({ PATH: "/usr/local/bin" }, { platform: "darwin", exists }).map((path) => path.replace(/\\/g, "/"));
  assert.deepEqual(found, ["/usr/local/bin/codex", "/opt/homebrew/bin/codex"]);
  const versions = { "/usr/local/bin/codex": [0, 150, 0], "/opt/homebrew/bin/codex": [0, 161, 0] };
  const pick = resolveCodexCommand({}, {}, { platform: "darwin", candidates: () => Object.keys(versions), version: (path) => versions[path] });
  assert.equal(pick, "/opt/homebrew/bin/codex");
  assert.equal(resolveCodexCommand({}, {}, { platform: "darwin", candidates: () => [] }), "codex");
  assert.equal(whichSync("nothing-here", { PATH: "" }), "");
});
