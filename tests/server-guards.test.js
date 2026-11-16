import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeConfigPaths } from "../server/platform.js";
import { startServer } from "../server.js";
import { removeTempDir } from "./helpers.js";

async function withServer(fn) {
  const previous = process.env.JARVIS_SHARED_DIR;
  const root = await mkdtemp(join(tmpdir(), "jarvis-guards-"));
  process.env.JARVIS_SHARED_DIR = join(root, "shared");
  const dataRoot = join(root, "app");
  await mkdir(join(dataRoot, "config"), { recursive: true });
  await mkdir(join(dataRoot, "data"), { recursive: true });
  const config = normalizeConfigPaths(JSON.parse(await readFile(join(process.cwd(), "config", "jarvis.config.json"), "utf8")), { baseDir: process.cwd() });
  await writeFile(join(dataRoot, "config", "jarvis.config.json"), JSON.stringify(config));
  const handle = await startServer({ host: "127.0.0.1", port: 0, dataRoot });
  try {
    return await fn(handle);
  } finally {
    await new Promise((resolve) => handle.server.close(resolve));
    if (previous === undefined) delete process.env.JARVIS_SHARED_DIR;
    else process.env.JARVIS_SHARED_DIR = previous;
    await removeTempDir(root);
  }
}

function raw(handle, { method = "GET", path, host, type, body = "", extra = {} }) {
  return new Promise((resolve, reject) => {
    const headers = { host: host || `127.0.0.1:${handle.port}`, ...extra };
    if (type) headers["content-type"] = type;
    const req = request({ host: handle.host, port: handle.port, path, method, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("API reads and writes are refused for non-loopback hosts (DNS rebinding)", async () => {
  await withServer(async (handle) => {
    assert.equal(await raw(handle, { path: "/api/plan/meta", host: "evil.example" }), 403);
    assert.equal(await raw(handle, { path: "/api/agents", host: "evil.example:80" }), 403);
    assert.equal(await raw(handle, { path: "/api/plan/meta" }), 200);
    assert.equal(await raw(handle, { path: "/api/plan/meta", host: `localhost:${handle.port}` }), 200);
    // Static files (no data) still load from any host so the app shell works.
    assert.equal(await raw(handle, { path: "/index.html", host: "evil.example" }), 200);
  });
});

test("every state-changing route requires a JSON body", async () => {
  await withServer(async (handle) => {
    assert.equal(await raw(handle, { method: "POST", path: "/api/integrations/spotify/disconnect", type: "text/plain", body: "{}" }), 415);
    assert.equal(await raw(handle, { method: "POST", path: "/api/project/open", type: "text/plain", body: "{\"projectId\":\"jarvis\"}" }), 415);
    assert.equal(await raw(handle, { method: "POST", path: "/api/project/open", type: "application/json", body: "{not json" }), 400);
  });
});

// A browser sends these without a CORS preflight, since the media type is
// really text/plain. Each one would otherwise reach the route.
test("a content type that only mentions JSON is refused", async () => {
  await withServer(async (handle) => {
    const body = "{\"enabled\":true}";
    for (const type of ["text/plain; x=application/json", "text/plain;application/json", "application/jsonp", "multipart/form-data; boundary=application/json"]) {
      assert.equal(await raw(handle, { method: "POST", path: "/api/cloud/phone-agents", type, body }), 415, type);
    }
    assert.notEqual(await raw(handle, { method: "POST", path: "/api/cloud/phone-agents", type: "Application/JSON; charset=utf-8", body }), 415);
  });
});

test("writes from another site are refused even when they look like JSON", async () => {
  await withServer(async (handle) => {
    const write = (extra) => raw(handle, { method: "POST", path: "/api/cloud/phone-agents", type: "application/json", body: "{\"enabled\":false}", extra });
    assert.equal(await write({ origin: "https://evil.example" }), 403);
    assert.equal(await write({ origin: "http://localhost:5173" }), 403, "another local port is another site");
    assert.equal(await write({ origin: "null" }), 403);
    assert.equal(await write({ "sec-fetch-site": "cross-site" }), 403);
    // The cloud isn't connected in the sandbox, so allowed writes get the
    // route's own answer rather than a guard's.
    assert.ok(![403, 415].includes(await write({ origin: `http://127.0.0.1:${handle.port}`, "sec-fetch-site": "same-origin" })));
    assert.ok(![403, 415].includes(await write({})), "tools without a browser send no Origin");
  });
});
