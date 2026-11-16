import test from "node:test";
import assert from "node:assert/strict";
import { launchAgentRunsCheckout, parseRunValues, sourceCopyEntries } from "../scripts/clean-startup.mjs";

// What `reg query` printed on a PC, with the stale dev-copy entry.
const REG = [
  "",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
  "    com.zachhersick.jarvis    REG_SZ    \"C:\\Users\\Alex\\AppData\\Local\\Programs\\Jarvis\\Jarvis.exe\"",
  "    Other App Stable    REG_SZ    \"C:\\Users\\Alex\\AppData\\Local\\Programs\\Other App\\opera.exe\" --autostart",
  "    electron.app.Electron    REG_SZ    C:\\Dev\\jarvis\\node_modules\\electron\\dist\\electron.exe C:\\Dev\\jarvis",
  "    Jarvis Dev    REG_EXPAND_SZ    \"C:\\Dev\\jarvis\\scripts\\start-jarvis.ps1\"",
  ""
].join("\r\n");

test("finds only the login entries that start a source checkout", () => {
  const values = parseRunValues(REG);
  assert.deepEqual(values.map((value) => value.name), ["com.zachhersick.jarvis", "Other App Stable", "electron.app.Electron", "Jarvis Dev"]);
  assert.deepEqual(sourceCopyEntries(values, "C:\\Dev\\jarvis").map((value) => value.name), ["electron.app.Electron", "Jarvis Dev"]);
  // A checkout elsewhere still matches on the development Electron binary.
  assert.deepEqual(sourceCopyEntries(values, "D:\\other").map((value) => value.name), ["electron.app.Electron"]);
});

test("removes the old macOS LaunchAgent only when it runs a checkout", () => {
  assert.equal(launchAgentRunsCheckout("<string>/bin/sh</string><string>/Users/alex/Dev/jarvis/scripts/start-jarvis-mac.sh</string>", "/Users/alex/Dev/jarvis"), true);
  assert.equal(launchAgentRunsCheckout("<string>run</string>\n<string>desktop</string>", "/elsewhere"), true);
  assert.equal(launchAgentRunsCheckout("<string>/Applications/Jarvis.app/Contents/MacOS/Jarvis</string>", "/Users/alex/Dev/jarvis"), false);
});
