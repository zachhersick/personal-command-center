import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWallpaperEngine, dedupe, parseLibraryPaths, scanWorkshop, steamRoots, workshopDirs, WALLPAPER_ENGINE_APP } from "../server/wallpaper-engine.js";
import { removeTempDir } from "./helpers.js";

const VDF = `"libraryfolders"
{
\t"0"
\t{
\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"
\t\t"apps" { "431960" "826275581" }
\t}
\t"1"
\t{
\t\t"path"\t\t"D:\\\\SteamLibrary"
\t}
}`;

test("Steam libraries come from the vdf and the usual folders", async () => {
  assert.deepEqual(parseLibraryPaths(VDF), ["C:\\Program Files (x86)\\Steam", "D:\\SteamLibrary"]);
  assert.deepEqual(parseLibraryPaths("nonsense"), []);

  // The install path is built with path.join, so its separator follows the
  // platform running the tests; the other two are literal strings in the code.
  const install = join("C:\\Program Files (x86)", "Steam");
  const present = new Set([install, "D:\\SteamLibrary", "E:\\SteamLibrary"]);
  const roots = await steamRoots({
    env: { "ProgramFiles(x86)": "C:\\Program Files (x86)" },
    exists: (path) => present.has(path),
    read: async () => VDF
  });
  assert.ok(roots.includes(install), "the install itself");
  assert.ok(roots.includes("D:\\SteamLibrary"), "a library named in the vdf");
  assert.ok(roots.includes("E:\\SteamLibrary"), "a library the vdf never mentions");
  assert.equal(new Set(roots).size, roots.length, "no duplicates");
});

// A fake Workshop tree: one wallpaper per entry.
async function workshop(root, entries) {
  const dir = join(root, "steamapps", "workshop", "content", WALLPAPER_ENGINE_APP);
  for (const [id, entry] of Object.entries(entries)) {
    const itemDir = join(dir, id);
    await mkdir(itemDir, { recursive: true });
    if (entry.project !== null) await writeFile(join(itemDir, "project.json"), entry.project ?? JSON.stringify({ type: entry.type, title: entry.title, file: entry.file }));
    if (entry.bytes) await writeFile(join(itemDir, entry.file), Buffer.alloc(entry.bytes, 7));
    if (entry.preview) await writeFile(join(itemDir, entry.preview), "img");
  }
  return dir;
}

test("scanning keeps playable videos and says how many it hid", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-we-"));
  try {
    const dir = await workshop(root, {
      100: { type: "video", title: "Matterhorn", file: "Matterhorn.mp4", bytes: 2048, preview: "preview.jpg" },
      101: { type: "video", title: "Winter Cabin ❄️", file: "cabin.webm", bytes: 512 },
      200: { type: "scene", title: "Fall", file: "scene.pkg", bytes: 10 },
      201: { type: "web", title: "Terminal Dashboard", file: "index.html", bytes: 10 },
      300: { type: "video", title: "Gone", file: "missing.mp4" },
      301: { type: "video", title: "Not playable", file: "clip.avi", bytes: 10 },
      302: { project: "{ broken json", type: "video" },
      303: { project: null, type: "video" },
      "not-an-id": { type: "video", title: "Ignored", file: "x.mp4", bytes: 10 }
    });
    assert.deepEqual(workshopDirs([root]), [dir]);
    assert.deepEqual(workshopDirs([join(root, "nope")]), []);

    const { items, hidden } = await scanWorkshop([dir]);
    assert.deepEqual(items.map((item) => item.title), ["Matterhorn", "Winter Cabin ❄️"]);
    assert.equal(hidden, 5, "scene, web, missing file, wrong extension, broken json");
    const matterhorn = items.find((item) => item.title === "Matterhorn");
    assert.equal(matterhorn.id, "100");
    assert.equal(matterhorn.size, 2048);
    assert.ok(matterhorn.preview.endsWith("preview.jpg"));
    assert.equal(items.find((item) => item.title === "Winter Cabin ❄️").preview, "", "no preview file is fine");
    assert.deepEqual((await scanWorkshop([join(root, "missing")])).items, []);
  } finally {
    await removeTempDir(root);
  }
});

test("the same wallpaper in two libraries is listed once", async () => {
  const a = await mkdtemp(join(tmpdir(), "jarvis-we-a-"));
  const b = await mkdtemp(join(tmpdir(), "jarvis-we-b-"));
  try {
    const one = await workshop(a, { 100: { type: "video", title: "Matrix", file: "Matrix.mp4", bytes: 4096 } });
    const two = await workshop(b, { 100: { type: "video", title: "Matrix", file: "Matrix.mp4", bytes: 4096 } });
    const { items } = await scanWorkshop([one, two]);
    assert.equal(items.length, 1);
    // Same title, different file or size: a different wallpaper.
    assert.equal(dedupe([
      { id: "1", title: "Matrix", path: "/a/Matrix.mp4", size: 10, changed: 1 },
      { id: "2", title: "Matrix", path: "/b/Matrix.mp4", size: 99, changed: 2 },
      { id: "3", title: "matrix", path: "/c/Matrix.mp4", size: 10, changed: 9 }
    ]).length, 2);
  } finally {
    await removeTempDir(a);
    await removeTempDir(b);
  }
});

test("the engine is off outside Windows and caches what it finds", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-we-cache-"));
  try {
    await workshop(root, { 100: { type: "video", title: "Matrix", file: "Matrix.mp4", bytes: 16 } });
    let reads = 0;
    const fsImpl = { read: async (...args) => { reads += 1; return (await import("node:fs/promises")).readFile(...args); } };
    const env = { JARVIS_WALLPAPER_ENGINE_STEAM: root };
    let clock = 0;

    // No override: a Mac never looks for Steam at all.
    const mac = createWallpaperEngine({ platform: "darwin", env: {} });
    assert.equal(mac.supported, false);
    assert.deepEqual(await mac.status(), { available: false, items: [], hidden: 0 });
    assert.equal(await mac.find("100"), null);

    const engine = createWallpaperEngine({ platform: "win32", env, now: () => clock, fs: fsImpl });
    const first = await engine.status();
    assert.equal(first.available, true);
    assert.equal(first.items.length, 1);
    const afterFirst = reads;
    await engine.status();
    assert.equal(reads, afterFirst, "a second look inside a minute is served from the cache");
    clock += 120_000;
    await engine.status();
    assert.ok(reads > afterFirst, "the cache expires");

    assert.equal((await engine.find("100")).title, "Matrix");
    for (const bad of ["999", "../../etc/passwd", "12a", "", null]) assert.equal(await engine.find(bad), null, `${bad} is refused`);

    const empty = createWallpaperEngine({ platform: "win32", env: { JARVIS_WALLPAPER_ENGINE_STEAM: join(root, "nope") } });
    assert.equal((await empty.status()).available, false, "no Steam folder");
  } finally {
    await removeTempDir(root);
  }
});

test("the route serves a wallpaper by id, with Range, and nothing else", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-we-serve-"));
  try {
    await workshop(root, {
      100: { type: "video", title: "Matrix", file: "Matrix.mp4", bytes: 1000, preview: "preview.jpg" },
      101: { type: "video", title: "No preview", file: "clip.mp4", bytes: 10 }
    });
    process.env.JARVIS_WALLPAPER_ENGINE_STEAM = root;
    const { startServer } = await import("../server.js");
    const previous = process.env.JARVIS_SHARED_DIR;
    const dataRoot = join(root, "app");
    await mkdir(join(dataRoot, "config"), { recursive: true });
    await writeFile(join(dataRoot, "config", "jarvis.config.json"), await (await import("node:fs/promises")).readFile(join(process.cwd(), "config", "jarvis.config.json"), "utf8"));
    process.env.JARVIS_SHARED_DIR = join(root, "shared");
    const handle = await startServer({ host: "127.0.0.1", port: 0, dataRoot, cloudSync: false, jobsInbox: false });
    const base = `http://${handle.host}:${handle.port}`;
    try {
      const listed = await (await fetch(`${base}/api/focus/wallpapers`)).json();
      assert.equal(listed.engine.available, true);
      assert.deepEqual(listed.engine.items.map((item) => item.id).sort(), ["we:100", "we:101"]);
      const matrix = listed.engine.items.find((item) => item.id === "we:100");
      assert.equal(matrix.url, "/wallpapers/we/100");
      assert.equal(matrix.preview, "/wallpapers/we/100/preview");
      assert.equal(listed.engine.items.find((item) => item.id === "we:101").preview, "");

      const whole = await fetch(`${base}/wallpapers/we/100`);
      assert.equal(whole.status, 200);
      assert.equal(whole.headers.get("content-type"), "video/mp4");
      assert.equal((await whole.arrayBuffer()).byteLength, 1000);

      const part = await fetch(`${base}/wallpapers/we/100`, { headers: { range: "bytes=0-99" } });
      assert.equal(part.status, 206);
      assert.equal(part.headers.get("content-range"), "bytes 0-99/1000");
      assert.equal((await part.arrayBuffer()).byteLength, 100);

      assert.equal((await fetch(`${base}/wallpapers/we/100/preview`)).status, 200);
      assert.equal((await fetch(`${base}/wallpapers/we/101/preview`)).status, 404, "no preview on disk");
      for (const path of ["/wallpapers/we/999", "/wallpapers/we/abc", "/wallpapers/we/1/../../server.js", "/wallpapers/..%2fserver.js", "/wallpapers/we/100/other"]) {
        assert.equal((await fetch(`${base}${path}`)).status, 404, path);
      }
    } finally {
      await new Promise((resolve) => handle.server.close(resolve));
      if (previous === undefined) delete process.env.JARVIS_SHARED_DIR;
      else process.env.JARVIS_SHARED_DIR = previous;
      delete process.env.JARVIS_WALLPAPER_ENGINE_STEAM;
    }
  } finally {
    await removeTempDir(root);
  }
});
