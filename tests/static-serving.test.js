import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { normalizeConfigPaths } from "../server/platform.js";
import { resolveInside, startServer } from "../server.js";
import { removeTempDir } from "./helpers.js";

async function withServer(fn) {
  const previous = process.env.JARVIS_SHARED_DIR;
  const sharedDir = await mkdtemp(join(tmpdir(), "jarvis-static-"));
  process.env.JARVIS_SHARED_DIR = sharedDir;
  const dataRoot = join(sharedDir, "app");
  await mkdir(join(dataRoot, "config"), { recursive: true });
  await mkdir(join(dataRoot, "data"), { recursive: true });
  await mkdir(join(dataRoot, "wallpapers"), { recursive: true });
  await writeFile(join(dataRoot, "wallpapers", "loop.mp4"), Buffer.from("0123456789"));
  await writeFile(join(dataRoot, "wallpapers", "notes.txt"), "not a wallpaper");
  const config = normalizeConfigPaths(JSON.parse(await readFile(join(process.cwd(), "config", "jarvis.config.json"), "utf8")), { baseDir: process.cwd() });
  await writeFile(join(dataRoot, "config", "jarvis.config.json"), JSON.stringify(config));
  const handle = await startServer({ host: "127.0.0.1", port: 0, dataRoot });
  try {
    return await fn(handle);
  } finally {
    await new Promise((resolve) => handle.server.close(resolve));
    if (previous === undefined) delete process.env.JARVIS_SHARED_DIR;
    else process.env.JARVIS_SHARED_DIR = previous;
    await removeTempDir(sharedDir);
  }
}

// fetch() normalizes "..", so send raw paths with node:http.
function rawGet(handle, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: handle.host, port: handle.port, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("resolveInside refuses paths that escape the root", () => {
  assert.equal(resolveInside("/srv/public", "/../secret"), null);
  assert.equal(resolveInside("/srv/public", "/%2e%2e/secret"), null);
  assert.equal(resolveInside("/srv/public", "/a%00b"), null);
  assert.ok(resolveInside("/srv/public", "/app/main.js"));
});

test("vendor route serves only allowlisted frontend packages", async () => {
  await withServer(async (handle) => {
    const preact = await rawGet(handle, "/vendor/preact/dist/preact.module.js");
    assert.equal(preact.status, 200);
    assert.match(preact.headers["content-type"], /javascript/);
    const signals = await rawGet(handle, "/vendor/@preact/signals/dist/signals.module.js");
    assert.equal(signals.status, 200);
    assert.equal((await rawGet(handle, "/vendor/electron/index.js")).status, 404);
    assert.equal((await rawGet(handle, "/vendor/preact/package.json")).status, 404);
    assert.notEqual((await rawGet(handle, "/vendor/preact/../electron/index.js")).status, 200);
    assert.notEqual((await rawGet(handle, "/%2e%2e/package.json")).status, 200);
  });
});

test("wallpapers support byte ranges and reject traversal", async () => {
  await withServer(async (handle) => {
    const list = await rawGet(handle, "/api/focus/wallpapers");
    assert.deepEqual(JSON.parse(list.body).wallpapers.map((item) => item.name), ["loop.mp4"]);
    const full = await rawGet(handle, "/wallpapers/loop.mp4");
    assert.equal(full.status, 200);
    assert.equal(full.headers["accept-ranges"], "bytes");
    const partial = await rawGet(handle, "/wallpapers/loop.mp4", { range: "bytes=2-5" });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers["content-range"], "bytes 2-5/10");
    assert.equal(partial.body, "2345");
    assert.equal((await rawGet(handle, "/wallpapers/loop.mp4", { range: "bytes=50-" })).status, 416);
    assert.equal((await rawGet(handle, "/wallpapers/notes.txt")).status, 404);
    assert.equal((await rawGet(handle, "/wallpapers/..%2Fconfig%2Fjarvis.config.json")).status, 404);
  });
});
