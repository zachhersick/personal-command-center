// Self-update from private GitHub releases, downloaded with the gh CLI the
// user is already signed in to (no token is stored in the app).
// Electron specifics (quitting, paths) are injected so this runs under tests.
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { accessSync, constants, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const STATES = ["idle", "checking", "up-to-date", "available", "downloading", "ready", "installing", "error"];

// ---------- pure helpers ----------
export function parseVersion(value) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(value || ""));
  return match ? match.slice(1).map(Number) : null;
}

export function compareVersions(a, b) {
  const left = parseVersion(a) || [0, 0, 0];
  const right = parseVersion(b) || [0, 0, 0];
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

export function parseLatestRelease(json) {
  let list;
  try {
    list = JSON.parse(json || "[]");
  } catch {
    return null;
  }
  const release = (Array.isArray(list) ? list : [list]).find((entry) => parseVersion(entry?.tagName));
  if (!release) return null;
  return { tag: release.tagName, version: parseVersion(release.tagName).join("."), name: release.name || release.tagName, publishedAt: release.publishedAt || null };
}

export function parseSha256Sums(text) {
  const sums = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match) sums[match[2].trim()] = match[1].toLowerCase();
  }
  return sums;
}

export function installerName(version) {
  return `Jarvis-Setup-${version}-x64.exe`;
}

export function macArchiveName(version) {
  return `Jarvis-${version}-universal-mac.zip`;
}

// The release asset this platform installs from.
export function assetName(version, platform = process.platform) {
  return platform === "darwin" ? macArchiveName(version) : installerName(version);
}

// macOS: once Jarvis has quit, swap the .app bundle and reopen it. If the copy
// fails, the old bundle is put back so Jarvis still opens.
export const MAC_SWAP_SCRIPT = [
  "#!/bin/sh",
  'PID="$1"; NEW="$2"; TARGET="$3"',
  "i=0",
  'while kill -0 "$PID" 2>/dev/null && [ "$i" -lt 120 ]; do sleep 0.5; i=$((i + 1)); done',
  'rm -rf "$TARGET.previous"',
  'if mv "$TARGET" "$TARGET.previous" && ditto "$NEW" "$TARGET"; then',
  '  xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null',
  '  rm -rf "$TARGET.previous"',
  "else",
  '  rm -rf "$TARGET"',
  '  mv "$TARGET.previous" "$TARGET"',
  "fi",
  'open "$TARGET"',
  ""
].join("\n");

// /S installs silently into the existing per-user location; --force-run
// starts Jarvis again when the installer finishes.
export function installerArgs() {
  return ["/S", "--updated", "--force-run"];
}

export function canInstallNow({ focusActive = false, runningAgents = 0 } = {}) {
  const blocked = [];
  if (focusActive) blocked.push("A focus session is running");
  if (runningAgents > 0) blocked.push(`${runningAgents} agent ${runningAgents === 1 ? "run is" : "runs are"} still working`);
  return { ok: blocked.length === 0, blocked };
}

export async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function runCommand(command, args, { timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, stdout: String(stdout || ""), stderr: String(stderr || error?.message || "") });
    });
  });
}

export function resolveGh(env = process.env, platform = process.platform, exists = existsSync) {
  if (platform === "win32") {
    const installed = join(env.ProgramFiles || "C:\\Program Files", "GitHub CLI", "gh.exe");
    if (exists(installed)) return installed;
    return "gh.exe";
  }
  if (platform === "darwin") {
    for (const path of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) if (exists(path)) return path;
  }
  return "gh";
}

function friendlyGhError(stderr) {
  const text = String(stderr || "");
  if (/ENOENT|not recognized|cannot find/i.test(text)) return "The GitHub CLI isn't installed. Install it from cli.github.com, then run gh auth login.";
  if (/auth login|not logged|authentication|401|HTTP 403|could not resolve to a Repository|404/i.test(text)) return "Sign in with gh auth login (an account with access to the Jarvis repo) to get updates.";
  if (/getaddrinfo|ENOTFOUND|network|timed out|ETIMEDOUT|connection/i.test(text)) return "Couldn't reach GitHub. Check your connection and try again.";
  return text.split(/\r?\n/).find(Boolean)?.slice(0, 200) || "The update check failed.";
}

// ---------- updater ----------
export class Updater extends EventEmitter {
  constructor({
    repo,
    currentVersion,
    stateFile,
    downloadRoot,
    gh = resolveGh(),
    run = runCommand,
    launch = (path, args) => spawn(path, args, { detached: true, stdio: "ignore", windowsHide: false }).unref(),
    quit = () => {},
    now = () => new Date().toISOString(),
    enabled = true,
    platform = process.platform,
    appPath = "",
    pid = process.pid
  }) {
    super();
    Object.assign(this, { repo, currentVersion, stateFile, downloadRoot, gh, run, launch, quit, now, enabled, platform, appPath, pid });
    this.status = { state: enabled ? "idle" : "disabled", currentVersion, latest: null, notes: "", progress: 0, error: "", checkedAt: null, skipped: null, justUpdated: null };
    this.busy = null;
  }

  set(patch) {
    this.status = { ...this.status, ...patch };
    this.emit("status", this.status);
  }

  async loadState() {
    let saved = {};
    try {
      saved = JSON.parse(await readFile(this.stateFile, "utf8"));
    } catch {
      saved = {};
    }
    // First launch after an update: say so once.
    if (saved.lastVersion && compareVersions(this.currentVersion, saved.lastVersion) > 0) {
      this.set({ justUpdated: { from: saved.lastVersion, to: this.currentVersion, notes: saved.pendingNotes || "" } });
    }
    this.set({ skipped: saved.skipped || null });
    await this.saveState({ lastVersion: this.currentVersion, skipped: saved.skipped || null, pendingNotes: null });
  }

  async saveState(patch) {
    let saved = {};
    try {
      saved = JSON.parse(await readFile(this.stateFile, "utf8"));
    } catch {
      saved = {};
    }
    await writeFile(this.stateFile, JSON.stringify({ ...saved, ...patch }, null, 2));
  }

  async check() {
    if (!this.enabled) return this.status;
    if (this.busy) return this.status;
    this.set({ state: "checking", error: "" });
    const list = await this.run(this.gh, ["release", "list", "--repo", this.repo, "--exclude-drafts", "--exclude-pre-releases", "--limit", "5", "--json", "tagName,name,publishedAt"]);
    if (!list.ok) {
      this.set({ state: "error", error: friendlyGhError(list.stderr), checkedAt: this.now() });
      return this.status;
    }
    const latest = parseLatestRelease(list.stdout);
    if (!latest || compareVersions(latest.version, this.currentVersion) <= 0) {
      this.set({ state: "up-to-date", latest, checkedAt: this.now() });
      return this.status;
    }
    const view = await this.run(this.gh, ["release", "view", latest.tag, "--repo", this.repo, "--json", "body,assets"]);
    let notes = "";
    let size = 0;
    if (view.ok) {
      try {
        const detail = JSON.parse(view.stdout);
        notes = String(detail.body || "").slice(0, 4000);
        const asset = detail.assets?.find((entry) => entry.name === assetName(latest.version, this.platform));
        if (detail.assets && !asset) {
          // A release without a build for this platform isn't an update here.
          this.set({ state: "up-to-date", latest, checkedAt: this.now() });
          return this.status;
        }
        size = asset?.size || 0;
      } catch {
        // Notes are optional.
      }
    }
    this.set({ state: "available", latest: { ...latest, size }, notes, checkedAt: this.now() });
    return this.status;
  }

  async skip(version) {
    await this.saveState({ skipped: version });
    this.set({ skipped: version });
  }

  async download() {
    const latest = this.status.latest;
    if (!latest || this.status.state !== "available") throw Object.assign(new Error("No update is available to download."), { status: 409 });
    const dir = join(this.downloadRoot, latest.tag);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const file = join(dir, assetName(latest.version, this.platform));
    this.set({ state: "downloading", progress: 0, error: "" });
    const poll = setInterval(async () => {
      if (!latest.size) return;
      try {
        const names = await readdir(dir);
        let bytes = 0;
        for (const name of names) bytes += (await stat(join(dir, name))).size;
        this.set({ progress: Math.min(0.99, bytes / latest.size) });
      } catch {
        // The file may not exist yet.
      }
    }, 500);
    const result = await this.run(this.gh, ["release", "download", latest.tag, "--repo", this.repo, "--pattern", assetName(latest.version, this.platform), "--pattern", "SHA256SUMS.txt", "--dir", dir, "--clobber"], { timeout: 15 * 60_000 });
    clearInterval(poll);
    if (!result.ok || !existsSync(file)) {
      this.set({ state: "available", error: friendlyGhError(result.stderr) || "The download didn't finish." });
      throw Object.assign(new Error(this.status.error), { status: 502 });
    }
    const sums = existsSync(join(dir, "SHA256SUMS.txt")) ? parseSha256Sums(await readFile(join(dir, "SHA256SUMS.txt"), "utf8")) : {};
    const expected = sums[assetName(latest.version, this.platform)];
    const actual = await sha256File(file);
    if (!expected || expected !== actual) {
      await rm(dir, { recursive: true, force: true });
      this.set({ state: "available", error: expected ? "The download was corrupted (checksum mismatch). Try again." : "The release has no checksum, so it wasn't installed." });
      throw Object.assign(new Error(this.status.error), { status: 502 });
    }
    this.set({ state: "ready", progress: 1, installer: file });
    return file;
  }

  // Downloads if needed, then hands over to the installer and quits.
  async install() {
    if (this.busy) return this.busy;
    this.busy = (async () => {
      try {
        if (this.status.state === "available") await this.download();
        if (this.status.state !== "ready" || !this.status.installer) throw Object.assign(new Error("Nothing is ready to install."), { status: 409 });
        this.set({ state: "installing" });
        await this.saveState({ pendingNotes: this.status.notes || "" });
        if (this.platform === "darwin") await this.installMac();
        else this.launch(this.status.installer, installerArgs());
        this.quit();
        return this.status;
      } finally {
        this.busy = null;
      }
    })();
    return this.busy;
  }

  async installMac() {
    if (!this.appPath || !this.appPath.endsWith(".app")) throw Object.assign(new Error("Can't find the installed Jarvis.app to replace."), { status: 409 });
    try {
      accessSync(dirname(this.appPath), constants.W_OK);
    } catch {
      throw Object.assign(new Error(`Jarvis can't write to ${dirname(this.appPath)}. Move Jarvis.app to Applications and try again.`), { status: 409 });
    }
    const dir = dirname(this.status.installer);
    const extracted = join(dir, "extracted");
    await rm(extracted, { recursive: true, force: true });
    const unzip = await this.run("ditto", ["-x", "-k", this.status.installer, extracted], { timeout: 5 * 60_000 });
    const bundle = join(extracted, "Jarvis.app");
    if (!unzip.ok || !existsSync(bundle)) throw Object.assign(new Error("Couldn't unpack the update."), { status: 502 });
    const script = join(dir, "swap-jarvis.sh");
    await writeFile(script, MAC_SWAP_SCRIPT, { mode: 0o755 });
    this.launch("/bin/sh", [script, String(this.pid), bundle, this.appPath]);
  }

  view() {
    const { installer, ...rest } = this.status;
    return { ...rest, available: rest.state === "available" || rest.state === "ready", skippedThis: Boolean(rest.latest && rest.skipped === rest.latest.version) };
  }
}
