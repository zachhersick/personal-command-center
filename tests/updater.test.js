import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { assetName, canInstallNow, compareVersions, installerArgs, installerName, MAC_SWAP_SCRIPT, macArchiveName, parseLatestRelease, parseSha256Sums, resolveGh, Updater } from "../desktop/updater.mjs";

test("versions compare numerically", () => {
  assert.equal(compareVersions("0.3.10", "0.3.9"), 1);
  assert.equal(compareVersions("v0.3.1", "0.3.1"), 0);
  assert.equal(compareVersions("0.2.9", "0.3.0"), -1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
});

test("gh output and checksum files are parsed", () => {
  const latest = parseLatestRelease(JSON.stringify([{ tagName: "v0.3.4", name: "Jarvis 0.3.4", publishedAt: "2026-10-19T00:00:00Z" }, { tagName: "v0.3.3" }]));
  assert.deepEqual(latest, { tag: "v0.3.4", version: "0.3.4", name: "Jarvis 0.3.4", publishedAt: "2026-10-19T00:00:00Z" });
  assert.equal(parseLatestRelease("[]"), null);
  assert.equal(parseLatestRelease("not json"), null);
  const hash = "a".repeat(64);
  assert.deepEqual(parseSha256Sums(`${hash} *Jarvis-Setup-0.3.4-x64.exe\r\n\ngarbage`), { "Jarvis-Setup-0.3.4-x64.exe": hash });
  assert.deepEqual(installerArgs(), ["/S", "--updated", "--force-run"]);
});

test("installs wait for focus sessions and running agents unless forced", () => {
  assert.deepEqual(canInstallNow({}), { ok: true, blocked: [] });
  const blocked = canInstallNow({ focusActive: true, runningAgents: 2 });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.blocked, ["A focus session is running", "2 agent runs are still working"]);
});

// A stand-in for the gh CLI: answers list/view and "downloads" by writing files.
function fakeGh({ version = "0.3.5", payload = Buffer.from("installer-bytes"), checksum, failList = "", asset = installerName(version), listedAssets } = {}) {
  const calls = [];
  const run = async (command, args) => {
    calls.push(args);
    if (args[0] === "release" && args[1] === "list") {
      if (failList) return { ok: false, stderr: failList, stdout: "" };
      return { ok: true, stdout: JSON.stringify([{ tagName: `v${version}`, name: `Jarvis ${version}`, publishedAt: "2026-10-19T00:00:00Z" }]) };
    }
    if (args[0] === "release" && args[1] === "view") {
      return { ok: true, stdout: JSON.stringify({ body: "## What's new\n- Faster", assets: listedAssets || [{ name: asset, size: payload.length }] }) };
    }
    if (args[0] === "release" && args[1] === "download") {
      const dir = args[args.indexOf("--dir") + 1];
      await writeFile(join(dir, asset), payload);
      const sum = checksum ?? createHash("sha256").update(payload).digest("hex");
      await writeFile(join(dir, "SHA256SUMS.txt"), `${sum}  ${asset}\n`);
      return { ok: true, stdout: "" };
    }
    if (command === "ditto") {
      // Pretend to unzip: create <dest>/Jarvis.app.
      await mkdir(join(args[3], "Jarvis.app", "Contents"), { recursive: true });
      return { ok: true, stdout: "" };
    }
    return { ok: false, stderr: "unexpected" };
  };
  return { run, calls };
}

async function setup(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-updater-"));
  const gh = fakeGh(options);
  const launched = [];
  let quit = 0;
  const updater = new Updater({
    repo: "me/jarvis",
    currentVersion: options.current || "0.3.1",
    stateFile: join(dir, "update-state.json"),
    downloadRoot: join(dir, "downloads"),
    gh: "gh",
    run: gh.run,
    launch: (path, args) => launched.push({ path, args }),
    quit: () => { quit += 1; },
    platform: options.platform || "win32",
    appPath: options.appPath || ""
  });
  return { dir, updater, gh, launched, quits: () => quit };
}

test("check, download, verify and install hand off to the installer", async () => {
  const { dir, updater, launched, quits } = await setup();
  try {
    const status = await updater.check();
    assert.equal(status.state, "available");
    assert.equal(status.latest.version, "0.3.5");
    assert.match(status.notes, /Faster/);
    assert.equal(updater.view().available, true);

    await updater.install();
    assert.equal(launched.length, 1);
    assert.match(launched[0].path, /Jarvis-Setup-0\.3\.5-x64\.exe$/);
    assert.deepEqual(launched[0].args, ["/S", "--updated", "--force-run"]);
    assert.equal(quits(), 1);
    assert.equal(updater.status.state, "installing");
    assert.equal(JSON.parse(await readFile(join(dir, "update-state.json"), "utf8")).pendingNotes, "## What's new\n- Faster");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a checksum mismatch is rejected and nothing is installed", async () => {
  const { dir, updater, launched, quits } = await setup({ checksum: "b".repeat(64) });
  try {
    await updater.check();
    await assert.rejects(() => updater.install(), /checksum mismatch/);
    assert.equal(launched.length, 0);
    assert.equal(quits(), 0);
    assert.equal(updater.status.state, "available", "you can retry");
    assert.equal(existsSync(join(dir, "downloads", "v0.3.5")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("up to date, missing gh and signed-out errors are explained", async () => {
  const current = await setup({ version: "0.3.1", current: "0.3.1" });
  const missing = await setup({ failList: "spawn gh ENOENT" });
  const signedOut = await setup({ failList: "To get started with GitHub CLI, please run:  gh auth login" });
  const offline = await setup({ failList: "error connecting to api.github.com: getaddrinfo ENOTFOUND" });
  try {
    assert.equal((await current.updater.check()).state, "up-to-date");
    assert.match((await missing.updater.check()).error, /isn't installed/);
    assert.match((await signedOut.updater.check()).error, /gh auth login/);
    assert.match((await offline.updater.check()).error, /Couldn't reach GitHub/);
    await assert.rejects(() => current.updater.download(), (error) => error.status === 409);
  } finally {
    for (const entry of [current, missing, signedOut, offline]) await rm(entry.dir, { recursive: true, force: true });
  }
});

test("the first launch after an update says so once", async () => {
  const { dir } = await setup();
  try {
    const stateFile = join(dir, "update-state.json");
    await writeFile(stateFile, JSON.stringify({ lastVersion: "0.3.1", pendingNotes: "- New things" }));
    const updated = new Updater({ repo: "me/jarvis", currentVersion: "0.3.2", stateFile, downloadRoot: dir, run: async () => ({ ok: true, stdout: "[]" }) });
    await updated.loadState();
    assert.deepEqual(updated.status.justUpdated, { from: "0.3.1", to: "0.3.2", notes: "- New things" });
    const again = new Updater({ repo: "me/jarvis", currentVersion: "0.3.2", stateFile, downloadRoot: dir, run: async () => ({ ok: true, stdout: "[]" }) });
    await again.loadState();
    assert.equal(again.status.justUpdated, null);
    await again.skip("0.3.3");
    assert.equal(JSON.parse(await readFile(stateFile, "utf8")).skipped, "0.3.3");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a disabled updater (dev mode) never calls gh", async () => {
  let calls = 0;
  const updater = new Updater({ repo: "me/jarvis", currentVersion: "0.3.0", stateFile: join(tmpdir(), "x.json"), downloadRoot: tmpdir(), run: async () => { calls += 1; return { ok: true, stdout: "[]" }; }, enabled: false });
  assert.equal((await updater.check()).state, "disabled");
  assert.equal(calls, 0);
});

test("asset names and gh lookup are per platform", () => {
  assert.equal(assetName("0.3.5", "win32"), "Jarvis-Setup-0.3.5-x64.exe");
  assert.equal(assetName("0.3.5", "darwin"), "Jarvis-0.3.5-universal-mac.zip");
  assert.equal(resolveGh({}, "darwin", (path) => path === "/usr/local/bin/gh"), "/usr/local/bin/gh");
  assert.equal(resolveGh({}, "darwin", () => false), "gh");
  assert.equal(resolveGh({ ProgramFiles: "C:\\PF" }, "win32", () => false), "gh.exe");
});

test("on macOS the update unzips and hands off to a swap script", async () => {
  const appRoot = await mkdtemp(join(tmpdir(), "jarvis-mac-app-"));
  const appPath = join(appRoot, "Jarvis.app");
  await mkdir(appPath, { recursive: true });
  const { dir, updater, launched, quits } = await setup({ platform: "darwin", asset: macArchiveName("0.3.5"), appPath });
  try {
    await updater.check();
    assert.equal(updater.status.state, "available");
    await updater.install();
    assert.equal(launched.length, 1);
    assert.equal(launched[0].path, "/bin/sh");
    const [script, pid, bundle, target] = launched[0].args;
    assert.match(script, /swap-jarvis\.sh$/);
    assert.equal(pid, String(process.pid));
    assert.match(bundle, /extracted[\\/]Jarvis\.app$/);
    assert.equal(target, appPath);
    assert.equal(await readFile(script, "utf8"), MAC_SWAP_SCRIPT);
    assert.equal(quits(), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(appRoot, { recursive: true, force: true });
  }
});

test("macOS refuses to update a copy that isn't an installed .app", async () => {
  const { dir, updater, launched, quits } = await setup({ platform: "darwin", asset: macArchiveName("0.3.5"), appPath: "" });
  try {
    await updater.check();
    await assert.rejects(() => updater.install(), /Jarvis\.app/);
    assert.equal(launched.length, 0);
    assert.equal(quits(), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a release without a Mac build isn't offered on macOS", async () => {
  const { dir, updater } = await setup({ platform: "darwin", listedAssets: [{ name: installerName("0.3.5"), size: 10 }] });
  try {
    assert.equal((await updater.check()).state, "up-to-date");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the macOS swap script is valid shell and restores on failure", { skip: spawnSync("sh", ["-c", "true"]).status !== 0 ? "no sh available" : false }, () => {
  const check = spawnSync("sh", ["-n"], { input: MAC_SWAP_SCRIPT });
  assert.equal(check.status, 0, String(check.stderr));
  assert.match(MAC_SWAP_SCRIPT, /mv "\$TARGET\.previous" "\$TARGET"/);
  assert.match(MAC_SWAP_SCRIPT, /open "\$TARGET"/);
});
