import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function expandPath(input, options = {}) {
  const env = options.env || process.env;
  const home = options.home || homedir();
  const baseDir = options.baseDir || process.cwd();
  let missingVariable = false;
  let value = String(input || "").replace(/%([^%]+)%/g, (_, key) => {
    if (env[key] === undefined) missingVariable = true;
    return env[key] || "";
  });
  value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, plain) => {
    const key = braced || plain;
    if (env[key] === undefined) missingVariable = true;
    return env[key] || "";
  });
  if (missingVariable || !value) return "";
  if (value === "~") value = home;
  else if (/^~[\\/]/.test(value)) value = join(home, value.slice(2));
  return resolve(isAbsolute(value) ? value : join(baseDir, value));
}

function expandList(values, options) {
  return (values || []).map((value) => expandPath(value, options)).filter(Boolean);
}

export function normalizeConfigPaths(config, options = {}) {
  const workspace = config.workspace || {};
  const integrations = config.integrations || {};
  const withPath = (item) => ({ ...item, path: expandPath(item.path, options) });
  return {
    ...config,
    workspace: {
      ...workspace,
      root: expandPath(workspace.root, options),
      primaryProject: expandPath(workspace.primaryProject, options),
      trackedRepos: expandList(workspace.trackedRepos, options),
      projects: (workspace.projects || []).map(withPath)
    },
    integrations: {
      ...integrations,
      jobs: {
        ...(integrations.jobs || {}),
        automationRoots: expandList(integrations.jobs?.automationRoots, options),
        localResultsFiles: expandList(integrations.jobs?.localResultsFiles, options)
      },
      career: {
        ...(integrations.career || {}),
        roadmapFiles: expandList(integrations.career?.roadmapFiles, options),
        todoFiles: expandList(integrations.career?.todoFiles, options)
      },
      googleDrive: {
        ...(integrations.googleDrive || {}),
        contextFiles: expandList(integrations.googleDrive?.contextFiles, options)
      },
      googleCalendar: {
        ...(integrations.googleCalendar || {}),
        contextFiles: expandList(integrations.googleCalendar?.contextFiles, options)
      },
      gmail: {
        ...(integrations.gmail || {}),
        contextFiles: expandList(integrations.gmail?.contextFiles, options)
      }
    }
  };
}

export function getOpenCommand(target, platform = process.platform) {
  if (platform === "win32") return { command: "cmd.exe", args: ["/c", "start", "", target] };
  if (platform === "darwin") return { command: "open", args: [target] };
  return { command: "xdg-open", args: [target] };
}

export function getClipboardCommand(platform = process.platform) {
  if (platform === "win32") return { command: "clip.exe", args: [] };
  if (platform === "darwin") return { command: "pbcopy", args: [] };
  return { command: "xclip", args: ["-selection", "clipboard"] };
}

export function resolveVscodeCommand(config, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const exists = options.exists || existsSync;
  const configured = String(config.workspace?.vscodeCommand || "code");
  if (exists(configured)) return configured;
  const candidates = platform === "win32"
    ? [env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe")]
    : platform === "darwin"
      ? [
          "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
          env.HOME && join(env.HOME, "Applications", "Visual Studio Code.app", "Contents", "Resources", "app", "bin", "code")
        ]
      : [];
  return candidates.filter(Boolean).find(exists) || configured;
}

export function resolvePythonCommand(config, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const configured = env.JARVIS_PYTHON || config.dashboard?.pythonPath;
  if (configured) return configured;
  if (platform !== "win32") return "python3";
  return join(env.USERPROFILE || homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");
}

export function getMacChatGptAutomationCommand() {
  const lines = [
    'tell application "ChatGPT" to activate',
    "delay 0.8",
    'tell application "System Events"',
    'keystroke "v" using command down',
    "delay 0.2",
    "key code 36",
    "end tell"
  ];
  return { command: "osascript", args: lines.flatMap((line) => ["-e", line]) };
}

export async function handoffChatGptOnMac(prompt, tools) {
  const clipboard = getClipboardCommand("darwin");
  const copied = await tools.runWithInput(clipboard.command, clipboard.args, prompt, { timeout: 2500 });
  const opened = await tools.run("open", ["-a", "ChatGPT"], { timeout: 3500 });
  if (!opened.ok) {
    const web = await tools.run("open", ["https://chatgpt.com/"], { timeout: 2500 });
    return {
      ok: copied.ok && web.ok,
      note: copied.ok && web.ok
        ? "Prompt copied and ChatGPT Web opened. Paste to continue."
        : copied.stderr || web.stderr || "ChatGPT could not be opened."
    };
  }
  const automation = getMacChatGptAutomationCommand();
  const submitted = await tools.run(automation.command, automation.args, { timeout: 6000 });
  return submitted.ok
    ? { ok: true, note: "Prompt sent to the ChatGPT app." }
    : {
        ok: copied.ok,
        note: copied.ok
          ? "Prompt copied and ChatGPT opened. Paste manually, or allow Jarvis accessibility control in macOS System Settings."
          : copied.stderr || submitted.stderr || "ChatGPT handoff failed."
      };
}
