import { normalizeConfigPaths } from "../server/platform.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../server.js";
import { removeTempDir } from "./helpers.js";

async function withServer(fn) {
  const previousSharedDir = process.env.JARVIS_SHARED_DIR;
  const sharedDir = await mkdtemp(join(tmpdir(), "jarvis-api-shared-"));
  process.env.JARVIS_SHARED_DIR = sharedDir;
  const dataRoot = join(sharedDir, "isolated-app");
  await mkdir(join(dataRoot, "config"), { recursive: true });
  await mkdir(join(dataRoot, "data"), { recursive: true });
  const config = normalizeConfigPaths(JSON.parse(await readFile(join(process.cwd(), "config", "jarvis.config.json"), "utf8")), { baseDir: process.cwd() });
  await writeFile(join(dataRoot, "config", "jarvis.config.json"), JSON.stringify(config));
  const handle = await startServer({ host: "127.0.0.1", port: 0, dataRoot });
  try {
    return await fn(`http://${handle.host}:${handle.port}`);
  } finally {
    await new Promise((resolve) => handle.server.close(resolve));
    if (previousSharedDir === undefined) delete process.env.JARVIS_SHARED_DIR;
    else process.env.JARVIS_SHARED_DIR = previousSharedDir;
    await removeTempDir(sharedDir);
  }
}

async function postJson(url, body) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("Spotify and project APIs respond on the local server", async () => {
  await withServer(async (baseUrl) => {
    const spotifyStatus = await fetch(`${baseUrl}/api/integrations/spotify/status`);
    assert.equal(spotifyStatus.ok, true);
    const spotifyStatusBody = await spotifyStatus.json();
    assert.equal(typeof spotifyStatusBody.connected, "boolean");
    assert.equal("playback" in spotifyStatusBody, true);

    const spotifyConnect = await postJson(`${baseUrl}/api/integrations/spotify/connect`, {});
    const spotifyConnectBody = await spotifyConnect.json();
    assert.ok([200, 400].includes(spotifyConnect.status));
    if (spotifyConnect.status === 200) assert.equal(typeof spotifyConnectBody.authorizationUrl, "string");
    else assert.equal(spotifyConnectBody.ok, false);

    assert.equal((await postJson(`${baseUrl}/api/integrations/spotify/playback`, { action: "rewind" })).status, 400);
    assert.equal((await postJson(`${baseUrl}/api/integrations/spotify/playback`, { action: "volume", volumePercent: 101 })).status, 400);

    assert.equal((await postJson(`${baseUrl}/api/project/open`, { projectId: "missing" })).status, 404);
  });
});

test("endpoints from the previous dashboard are gone", async () => {
  await withServer(async (baseUrl) => {
    for (const path of ["/api/snapshot", "/api/tasks", "/api/roadmaps", "/api/integrations/runway/status", "/api/voice-health"]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 404, path);
    }
    assert.equal((await postJson(`${baseUrl}/api/task-execution`, {})).status, 404);
  });
});
