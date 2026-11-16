import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import {
  expandPath,
  getClipboardCommand,
  getMacChatGptAutomationCommand,
  getOpenCommand,
  handoffChatGptOnMac,
  normalizeConfigPaths,
  resolvePythonCommand,
  resolveVscodeCommand
} from "../server/platform.js";

test("expands portable environment, home, and repository-relative paths", () => {
  const options = { baseDir: resolve("repo", "jarvis"), home: resolve("users", "zach"), env: { WORK_ROOT: resolve("work") } };
  assert.equal(expandPath("data/todo.json", options), resolve(options.baseDir, "data", "todo.json"));
  assert.equal(expandPath("~/Downloads/roadmap.html", options), resolve(options.home, "Downloads", "roadmap.html"));
  assert.equal(expandPath("$WORK_ROOT/project", options), resolve(options.env.WORK_ROOT, "project"));
  assert.equal(expandPath("%WORK_ROOT%/project", options), resolve(options.env.WORK_ROOT, "project"));
  assert.equal(expandPath("$MISSING/project", options), "");
});

test("normalizes configured workspace and integration paths without changing other fields", () => {
  const baseDir = resolve("repo", "jarvis");
  const config = normalizeConfigPaths({
    profile: { operatorName: "Zach" },
    workspace: { root: "..", primaryProject: ".", trackedRepos: [".", "../project"], projects: [{ id: "project", path: "../project" }] },
    integrations: { jobs: { automationRoots: ["~/.codex/automations"], localResultsFiles: ["data/jobs.json"] } }
  }, { baseDir, home: resolve("home", "zach"), env: {} });
  assert.equal(config.profile.operatorName, "Zach");
  assert.equal(config.workspace.primaryProject, baseDir);
  assert.equal(config.workspace.projects[0].path, resolve(baseDir, "../project"));
  assert.equal(config.integrations.jobs.localResultsFiles[0], resolve(baseDir, "data/jobs.json"));
});

test("selects native open, clipboard, VS Code, and Python commands", () => {
  assert.deepEqual(getOpenCommand("https://example.com", "win32"), { command: "cmd.exe", args: ["/c", "start", "", "https://example.com"] });
  assert.deepEqual(getOpenCommand("https://example.com", "darwin"), { command: "open", args: ["https://example.com"] });
  assert.deepEqual(getClipboardCommand("win32"), { command: "clip.exe", args: [] });
  assert.deepEqual(getClipboardCommand("darwin"), { command: "pbcopy", args: [] });
  const macCode = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
  assert.equal(resolveVscodeCommand({ workspace: { vscodeCommand: "code" } }, { platform: "darwin", env: {}, exists: (value) => value === macCode }), macCode);
  assert.equal(resolvePythonCommand({ dashboard: {} }, { platform: "darwin", env: {} }), "python3");
  assert.match(resolvePythonCommand({ dashboard: {} }, { platform: "win32", env: { USERPROFILE: join("C:", "Users", "Zach") } }), /python\.exe$/);
});

test("builds the macOS ChatGPT accessibility handoff", () => {
  const command = getMacChatGptAutomationCommand();
  assert.equal(command.command, "osascript");
  assert.ok(command.args.includes('tell application "ChatGPT" to activate'));
  assert.ok(command.args.includes('keystroke "v" using command down'));
});

test("falls back to ChatGPT Web when the macOS app is missing", async () => {
  const calls = [];
  const result = await handoffChatGptOnMac("hello", {
    runWithInput: async (...args) => { calls.push(args); return { ok: true }; },
    run: async (command, args) => { calls.push([command, args]); return { ok: args[0] !== "-a" }; }
  });
  assert.equal(result.ok, true);
  assert.match(result.note, /ChatGPT Web opened/);
  assert.equal(calls[0][0], "pbcopy");
  assert.deepEqual(calls.at(-1), ["open", ["https://chatgpt.com/"]]);
});

test("keeps a copied prompt available when macOS accessibility control is denied", async () => {
  const result = await handoffChatGptOnMac("hello", {
    runWithInput: async () => ({ ok: true }),
    run: async (command) => command === "open" ? { ok: true } : { ok: false, stderr: "not authorized" }
  });
  assert.equal(result.ok, true);
  assert.match(result.note, /Paste manually/);
});
