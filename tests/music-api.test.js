import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../server.js";
import { normalizeConfigPaths } from "../server/platform.js";
import { spotifyPaths } from "../server/spotify.js";
import { createCloudApp } from "../server/cloud/app.js";
import { createSession } from "../server/cloud/auth.js";
import { MemoryStore } from "../server/cloud/store.js";
import { seal, unseal } from "../server/cloud/music.js";
import { createFileHistory } from "../server/music/history.js";
import { createCloudLink } from "../server/music/cloud-link.js";
import { createFakeSpotify, fakeTrack, FAKE_AUTH } from "./fake-spotify.js";
import { removeTempDir } from "./helpers.js";

const tracks = [
  fakeTrack(1, "Dreams", ["Fleetwood Mac"]),
  fakeTrack(2, "Dreams - 2004 Remaster", ["Fleetwood Mac"]),
  fakeTrack(3, "Landslide", ["Fleetwood Mac"]),
  fakeTrack(4, "Gypsy", ["Fleetwood Mac"], { playable: false })
];
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

async function withDesktop(fn) {
  const previous = process.env.JARVIS_SHARED_DIR;
  const sharedDir = await mkdtemp(join(tmpdir(), "jarvis-music-api-"));
  const dataRoot = join(sharedDir, "app");
  await mkdir(join(dataRoot, "config"), { recursive: true });
  await mkdir(join(dataRoot, "data"), { recursive: true });
  const config = normalizeConfigPaths(JSON.parse(await readFile(join(process.cwd(), "config", "jarvis.config.json"), "utf8")), { baseDir: process.cwd() });
  await writeFile(join(dataRoot, "config", "jarvis.config.json"), JSON.stringify(config));
  process.env.JARVIS_SHARED_DIR = sharedDir;
  const fake = createFakeSpotify({ tracks });
  const handle = await startServer({ host: "127.0.0.1", port: 0, dataRoot, cloudSync: false, jobsInbox: false, music: false, spotifyFetch: fake.fetch, musicEnrichGapMs: 0 });
  try {
    return await fn(`http://${handle.host}:${handle.port}`, { dataRoot, fake, sharedDir });
  } finally {
    await new Promise((resolve) => handle.server.close(resolve));
    if (previous === undefined) delete process.env.JARVIS_SHARED_DIR;
    else process.env.JARVIS_SHARED_DIR = previous;
    await removeTempDir(sharedDir);
  }
}

const post = (url, body, headers = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const json = async (response) => {
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${body.error}`);
  return body;
};

test("desktop: import, rank, preview and sync a playlist through the API", async () => {
  await withDesktop(async (base, { dataRoot, fake, sharedDir }) => {
    let overview = await json(await fetch(`${base}/api/music`));
    assert.equal(overview.status.spotify.connected, false);
    assert.equal(overview.canImport, true);
    assert.deepEqual(overview.playlists, []);
    assert.equal((await post(`${base}/api/music/playlists/sync`, { id: "nope" })).status, 404);

    // Import a small export folder (read in place).
    const exportDir = join(sharedDir, "exports", "Spotify Extended Streaming History");
    await mkdir(exportDir, { recursive: true });
    const stream = (ts, track) => ({ ts, ms_played: 180000, spotify_track_uri: track.uri, master_metadata_track_name: track.name, master_metadata_album_artist_name: "Fleetwood Mac", master_metadata_album_album_name: "Rumours" });
    await writeFile(join(exportDir, "Streaming_History_Audio_2026.json"), JSON.stringify([
      stream(minutesAgo(60 * 24 * 3), tracks[0]),
      stream(minutesAgo(60 * 24 * 3 - 5), tracks[0]),
      stream(minutesAgo(60 * 24 * 2), tracks[2]),
      stream(minutesAgo(60 * 24 * 2 - 5), tracks[3]),
      stream(minutesAgo(60 * 24 * 2 - 10), tracks[3]),
      stream(minutesAgo(60 * 24 * 2 - 15), tracks[3])
    ]));
    assert.equal((await post(`${base}/api/music/import`, { folder: "exports" })).status, 400, "relative paths are refused");
    // First a preview that changes nothing, then the import.
    const previewed = await json(await post(`${base}/api/music/import`, { folder: join(sharedDir, "exports") }));
    assert.equal(previewed.result.applied, false);
    assert.equal(previewed.result.spotify.plays, 6);
    assert.equal(previewed.result.spotify.previous, null);
    assert.equal(previewed.status.history.plays, 0);
    const imported = await json(await post(`${base}/api/music/import`, { folder: join(sharedDir, "exports"), apply: true }));
    assert.equal(imported.result.spotify.plays, 6);
    assert.equal(imported.status.history.plays, 6);

    // Connect a (fake) Spotify grant and poll recently played.
    await writeFile(spotifyPaths(dataRoot).auth, JSON.stringify(FAKE_AUTH));
    fake.state.recent.push({ played_at: minutesAgo(30), track: tracks[1] }, { played_at: minutesAgo(25), track: tracks[1] }, { played_at: minutesAgo(20), track: tracks[1] });
    const polled = await json(await post(`${base}/api/music/poll`, {}));
    assert.equal(polled.result.added, 3);
    assert.equal((await json(await post(`${base}/api/music/poll`, {}))).result.added, 0, "polling again adds nothing");

    const top = await json(await fetch(`${base}/api/music/top?days=7&limit=10`));
    assert.deepEqual(top.tracks.map((track) => [track.title, track.plays, track.versions]), [["Dreams - 2004 Remaster", 5, 2], ["Gypsy", 3, 1], ["Landslide", 1, 1]]);
    assert.equal(top.artists[0].name, "Fleetwood Mac");
    assert.equal((await fetch(`${base}/api/music/top?days=0`)).status, 400);
    const recent = await json(await fetch(`${base}/api/music/recent?limit=2`));
    assert.equal(recent.plays[0].track.name, "Dreams - 2004 Remaster");

    const preview = await json(await post(`${base}/api/music/playlists/preview`, { topK: 2, windowDays: 7 }));
    assert.equal(preview.preview.checked, true);
    assert.deepEqual(preview.preview.tracks.map((track) => track.ref), [tracks[1].uri, tracks[2].uri], "Gypsy is unplayable, so Landslide fills its slot");

    const saved = await json(await post(`${base}/api/music/playlists/save`, { name: "Weekly top", topK: 2, windowDays: 7, synced: true, intervalHours: 24 }));
    const synced = await json(await post(`${base}/api/music/playlists/sync`, { id: saved.rule.id }));
    assert.equal(synced.result.lastResult.ok, true);
    const playlist = fake.state.playlists.get(synced.result.spotifyPlaylistId);
    assert.deepEqual(playlist.uris, [tracks[1].uri, tracks[2].uri]);
    assert.equal(playlist.public, false);

    overview = await json(await fetch(`${base}/api/music`));
    assert.equal(overview.playlists[0].state.lastResult.skipped[0].title, "Gypsy");
    assert.ok(overview.playlists[0].nextSyncAt);

    // Writes need JSON from this computer.
    const foreign = await fetch(`${base}/api/music/playlists/save`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    assert.equal(foreign.status, 415);
    await json(await post(`${base}/api/music/playlists/delete`, { id: saved.rule.id }));
    assert.deepEqual((await json(await fetch(`${base}/api/music`))).playlists, []);
    assert.equal(fake.state.playlists.size, 1, "deleting a rule leaves the Spotify playlist alone");
  });
});

const SECRET = "s".repeat(40);
const ENV = { APP_URL: "https://jarvis.example.com", GITHUB_CLIENT_ID: "cid", GITHUB_CLIENT_SECRET: "csecret", SESSION_SECRET: SECRET, ALLOWED_GITHUB_ID: "42" };

async function withCloud(fn) {
  const store = new MemoryStore();
  const fake = createFakeSpotify({ tracks });
  const app = createCloudApp({ store, env: ENV, spotifyFetch: fake.fetch, resourceRoot: process.cwd(), musicEnrichGapMs: 0 });
  const server = createServer((req, res) => app.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `jarvis_session=${encodeURIComponent(createSession({ id: 42, login: "zach" }, SECRET))}`;
  const call = (path, { method = "GET", body, headers = {} } = {}) => fetch(`${base}${path}`, {
    method,
    redirect: "manual",
    headers: { cookie, origin: ENV.APP_URL, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  try {
    return await fn({ base, store, fake, call });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("cloud: tokens are sealed, the tick needs its own token, and Spotify connects from the web", async () => {
  assert.deepEqual(unseal(seal({ refreshToken: "x" }, SECRET), SECRET), { refreshToken: "x" });
  assert.equal(unseal(seal({ refreshToken: "x" }, SECRET), "y".repeat(40)), null);

  await withCloud(async ({ base, store, fake, call }) => {
    assert.equal((await fetch(`${base}/api/music/tick`)).status, 401);
    assert.equal((await fetch(`${base}/api/music`)).status, 401, "stats need a signed-in session");
    assert.equal((await call("/api/music/playlists/save", { method: "POST", body: { name: "x", topK: 5, windowDays: 7 }, headers: { origin: "https://evil.example" } })).status, 403);

    const connect = await call("/api/music/spotify/connect", { method: "POST", body: { clientId: "fakeclient123" } });
    const started = await json(connect);
    const authorize = new URL(started.authorizationUrl);
    assert.equal(authorize.searchParams.get("redirect_uri"), "https://jarvis.example.com/api/music/spotify/callback");
    assert.match(authorize.searchParams.get("scope"), /user-read-recently-played/);
    const pkce = connect.headers.get("set-cookie").split(";")[0];
    const sessionCookie = `jarvis_session=${encodeURIComponent(createSession({ id: 42, login: "zach" }, SECRET))}`;
    const wrongState = await fetch(`${base}/api/music/spotify/callback?code=c&state=nope`, { redirect: "manual", headers: { cookie: `${sessionCookie}; ${pkce}` } });
    assert.equal(wrongState.headers.get("location"), "/?spotify=expired#music");
    const callback = await fetch(`${base}/api/music/spotify/callback?code=c&state=${authorize.searchParams.get("state")}`, { redirect: "manual", headers: { cookie: `${sessionCookie}; ${pkce}` } });
    assert.equal(callback.headers.get("location"), "/?spotify=connected#music");
    const stored = (await store.getDoc("musicSpotify")).doc;
    assert.ok(stored.sealed && !JSON.stringify(stored).includes("fake-refresh-from-code"), "the refresh token is stored encrypted");

    let overview = await json(await call("/api/music"));
    assert.equal(overview.status.spotify.ready, true);
    assert.equal(overview.status.spotify.where, "cloud");
    assert.equal(overview.canImport, false);
    assert.equal((await call("/api/music/import", { method: "POST", body: { folder: "C:\\x" } })).status, 409);

    const { token, url } = await json(await call("/api/music/tick-token", { method: "POST", body: {} }));
    assert.match(token, /^jvt_/);
    assert.equal(url, "https://jarvis.example.com/api/music/tick");
    assert.equal((await fetch(`${base}/api/music/tick`, { headers: { authorization: "Bearer jvt_wrong" } })).status, 401);

    // A rule made on the phone, built by the next tick from plays the cloud recorded.
    await json(await call("/api/music/playlists/save", { method: "POST", body: { name: "Phone weekly", topK: 5, windowDays: 7, synced: true, intervalHours: 24 } }));
    fake.state.recent.push({ played_at: minutesAgo(10), track: tracks[2] }, { played_at: minutesAgo(5), track: tracks[0] }, { played_at: minutesAgo(3), track: tracks[0] });
    const tick = await json(await fetch(`${base}/api/music/tick`, { method: "POST", headers: { authorization: `Bearer ${token}` } }));
    assert.equal(tick.poll.added, 3);
    assert.deepEqual(tick.synced.map((entry) => entry.ok), [true]);
    const [playlist] = fake.state.playlists.values();
    assert.deepEqual(playlist.uris, [tracks[0].uri, tracks[2].uri]);
    const again = await json(await fetch(`${base}/api/music/tick?token=${token}`));
    assert.deepEqual(again.synced, [], "not due again within the day");
    overview = await json(await call("/api/music"));
    assert.equal(overview.status.tick.configured, true);
    assert.equal(overview.playlists[0].state.lastResult.tracks, 2);
  });
});

test("cloud: the desktop pushes its history and pulls what the cloud recorded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-music-link-"));
  t.after(() => removeTempDir(root));
  await withCloud(async ({ base, store, call }) => {
    const { token } = await json(await call("/api/devices", { method: "POST", body: { name: "PC" } }));
    const history = createFileHistory(() => root);
    const day = 86_400_000;
    const now = Date.now();
    await history.setExport("spotify", {
      from: now - 30 * day,
      to: now - 10 * day,
      tracks: [[tracks[0].uri, "Dreams", "Fleetwood Mac", "Rumours"]],
      plays: [0, 1, 2].map((i) => [Math.floor((now - 20 * day) / 1000) + i, 0])
    });
    await history.setExport("apple", { from: now - 900 * day, to: now - 800 * day, tracks: [["apple:5", "Landslide", "Fleetwood Mac", ""]], plays: [[Math.floor((now - 850 * day) / 1000), 0]] });
    await history.addPlays([{ ms: now - day, ref: tracks[2].uri, src: "l" }], { [tracks[2].uri]: { name: "Landslide", artists: ["Fleetwood Mac"], album: "", isrc: "US1" } });
    // Something the cloud recorded while the PC was off, and a play inside the export's range that the export replaces.
    await store.musicInsertPlays([{ ts: Math.floor((now - 2 * day) / 1000), ref: tracks[1].uri, src: "c" }, { ts: Math.floor((now - 15 * day) / 1000), ref: tracks[3].uri, src: "c" }]);
    await store.musicUpsertTracks([{ ref: tracks[1].uri, info: { name: "Dreams - 2004 Remaster", artists: ["Fleetwood Mac"] } }]);

    const link = createCloudLink({ history, settings: () => ({ url: base, token }) });
    const first = await link.exchange();
    assert.equal(first.pulled, 1);
    const cloudCounts = new Map((await store.musicCounts({ from: null, to: null })).map((row) => [row.ref, row.plays]));
    assert.equal(cloudCounts.get(tracks[0].uri), 3);
    assert.equal(cloudCounts.get("apple:5"), 1);
    assert.equal(cloudCounts.get(tracks[2].uri), 1);
    assert.equal(cloudCounts.get(tracks[3].uri), undefined, "the export replaced the polled play in its range");
    assert.deepEqual((await store.musicTracks([tracks[2].uri]))[0].info.artists, ["Fleetwood Mac"]);
    const local = await history.counts();
    assert.equal(local.get(tracks[1].uri).plays, 1, "the cloud's play reached the desktop");

    const second = await link.exchange();
    assert.equal(second.pulled, 0);
    assert.equal((await store.musicSummary()).plays, 3 + 1 + 1 + 1, "nothing was pushed twice");

    const overview = await json(await call("/api/music/top?days=all"));
    assert.deepEqual(overview.tracks.map((track) => [track.title, track.plays]), [["Dreams", 4], ["Landslide", 2]], "the phone ranks the same history, Apple and Spotify combined");

    const unauthorized = await fetch(`${base}/api/music/plays?after=0`, { headers: { authorization: "Bearer jvs_nope" } });
    assert.equal(unauthorized.status, 401);
  });
});

test("cloud: a second computer downloads the imports the first one pushed, and a newer import replaces them", async (t) => {
  const pcRoot = await mkdtemp(join(tmpdir(), "jarvis-music-pc-"));
  const macRoot = await mkdtemp(join(tmpdir(), "jarvis-music-mac-"));
  t.after(() => Promise.all([removeTempDir(pcRoot), removeTempDir(macRoot)]));
  await withCloud(async ({ base, store, call }) => {
    const pcToken = (await json(await call("/api/devices", { method: "POST", body: { name: "PC" } }))).token;
    const macToken = (await json(await call("/api/devices", { method: "POST", body: { name: "Mac" } }))).token;
    const pc = createFileHistory(() => pcRoot);
    const mac = createFileHistory(() => macRoot);
    const day = 86_400_000;
    const now = Date.now();
    const second = (daysAgo, i = 0) => Math.floor((now - daysAgo * day) / 1000) + i;
    await pc.setExport("spotify", {
      from: now - 400 * day,
      to: now - 10 * day,
      tracks: [[tracks[0].uri, "Dreams", "Fleetwood Mac", "Rumours"], [tracks[2].uri, "Landslide", "Fleetwood Mac", "Fleetwood Mac"]],
      plays: [[second(300), 0, 200000], [second(300, 5), 0, 200000], [second(20), 1, 180000]]
    }, "2026-10-01T00:00:00.000Z");
    await pc.setExport("apple", { from: now - 900 * day, to: now - 800 * day, tracks: [["apple:5", "Landslide", "Fleetwood Mac", ""]], plays: [[second(850), 0, 0]] }, "2026-10-01T00:00:00.000Z");
    // The Mac recorded a play inside the export's dates (the export has the real one) and one after it.
    await mac.addPlays([{ ms: (now - 20 * day) + 3000, ref: tracks[2].uri, src: "l" }, { ms: now - day, ref: tracks[1].uri, src: "l" }], {});

    const pcLink = createCloudLink({ history: pc, settings: () => ({ url: base, token: pcToken }) });
    const macLink = createCloudLink({ history: mac, settings: () => ({ url: base, token: macToken }) });
    assert.deepEqual((await pcLink.exchange()).imports, {}, "the PC doesn't download what it pushed");
    const cloudPlays = (await store.musicSummary()).plays;

    const first = await macLink.exchange();
    assert.deepEqual(first.imports, { spotify: 3, apple: 1 });
    const spotify = await mac.exportRecord("spotify");
    assert.equal(spotify.importedAt, "2026-10-01T00:00:00.000Z");
    assert.equal(spotify.from, now - 400 * day);
    assert.deepEqual(spotify.tracks.find((row) => row[0] === tracks[0].uri), [tracks[0].uri, "Dreams", "Fleetwood Mac", "Rumours"]);
    const counts = await mac.counts();
    assert.equal(counts.get(tracks[0].uri).plays, 2, "the PC's history counts on the Mac");
    assert.equal(counts.get(tracks[0].uri).ms, 400000, "with its real listening time");
    assert.equal(counts.get(tracks[2].uri).plays, 1, "the Mac's recorded play inside the export's dates gave way to the export");
    assert.equal(counts.get("apple:5").plays, 1);
    assert.equal(counts.get(tracks[1].uri).plays, 1, "the Mac's own play after the export stays");
    assert.equal((await store.musicSummary()).plays, cloudPlays + 1, "only the Mac's own recent play went up");

    assert.deepEqual((await macLink.exchange()).imports, {}, "nothing is downloaded twice");
    assert.equal((await store.musicSummary()).plays, cloudPlays + 1, "the downloaded import isn't pushed back");

    // The PC imports a newer export; the Mac gets it on its next exchange.
    await pc.setExport("spotify", { from: now - 9 * day, to: now - 5 * day, tracks: [[tracks[0].uri, "Dreams", "Fleetwood Mac", "Rumours"]], plays: [[second(7), 0, 210000]] }, "2026-11-01T00:00:00.000Z");
    await pcLink.exchange();
    const next = await macLink.exchange();
    assert.deepEqual(next.imports, { spotify: 4 });
    assert.equal((await mac.counts()).get(tracks[0].uri).plays, 3);

    // A newer import made on the Mac itself is never replaced by an older one from the cloud.
    await mac.setExport("apple", { from: now - 700 * day, to: now - 600 * day, tracks: [["apple:6", "Gypsy", "Fleetwood Mac", ""]], plays: [[second(650), 0, 0]] }, "2026-12-01T00:00:00.000Z");
    await macLink.exchange();
    assert.deepEqual((await pcLink.exchange()).imports, { apple: 2 }, "and the PC picks up the Mac's import");
    assert.equal((await mac.exportRecord("apple")).importedAt, "2026-12-01T00:00:00.000Z");
    assert.equal((await pc.counts()).get("apple:6").plays, 1);

    const exportsInfo = await fetch(`${base}/api/music/exports`, { headers: { authorization: "Bearer jvs_nope" } });
    assert.equal(exportsInfo.status, 401);
  });
});
