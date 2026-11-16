// Only the installed app should open at login; it registers itself the first
// time it runs. This removes login entries that start a source checkout
// instead: ones older builds and the old startup:install script created.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const rootDir = dirname(dirname(scriptPath));
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const LAUNCH_AGENT = "com.zachhersick.jarvis";

// `reg query` lines look like "    Name With Spaces    REG_SZ    command".
export function parseRunValues(output) {
  return String(output || "").split(/\r?\n/).map((line) => /^ {4}(.+?) {4}REG_(?:EXPAND_)?SZ {4}(.*)$/.exec(line)).filter(Boolean).map(([, name, command]) => ({ name, command }));
}

// A login entry starts the source copy when it runs this checkout or the
// development Electron binary. The installed app's entry points at Jarvis.exe.
export function sourceCopyEntries(values, root = rootDir) {
  const checkout = String(root).toLowerCase();
  return values.filter(({ command }) => {
    const text = String(command || "").toLowerCase();
    return text.includes(checkout) || /node_modules[\\/]electron[\\/]dist[\\/]electron(\.exe)?/.test(text);
  });
}

export function launchAgentRunsCheckout(plist, root = rootDir) {
  const text = String(plist || "");
  return text.includes(String(root)) || /start-jarvis-mac\.sh|<string>desktop<\/string>/.test(text);
}

async function cleanWindows() {
  let output = "";
  try {
    ({ stdout: output } = await execFileAsync("reg", ["query", RUN_KEY]));
  } catch {
    return [];
  }
  const found = sourceCopyEntries(parseRunValues(output));
  for (const { name } of found) await execFileAsync("reg", ["delete", RUN_KEY, "/v", name, "/f"]);
  return found.map(({ name, command }) => `${name}: ${command}`);
}

async function cleanMac() {
  const plist = join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT}.plist`);
  if (!existsSync(plist) || !launchAgentRunsCheckout(await readFile(plist, "utf8"))) return [];
  await execFileAsync("launchctl", ["bootout", `gui/${process.getuid()}`, plist]).catch(() => {});
  await rm(plist, { force: true });
  return [plist];
}

async function main() {
  const removed = process.platform === "win32" ? await cleanWindows() : process.platform === "darwin" ? await cleanMac() : [];
  if (removed.length) process.stdout.write(`Removed source-copy login entries:\n${removed.map((entry) => `  ${entry}`).join("\n")}\n`);
  else process.stdout.write("No source-copy login entries found.\n");
  process.stdout.write("The installed Jarvis app opens itself at login; run it once after installing.\n");
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
