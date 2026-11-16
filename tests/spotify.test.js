import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  beginSpotifyConnect,
  controlSpotifyPlayback,
  finishSpotifyConnect,
  listSpotifyDevices,
  normalizeSpotifyPlayback,
  setSpotifyVolume,
  spotifyPaths,
  spotifyStatus,
  transferSpotifyPlayback
} from "../server/spotify.js";

const track = {
  is_playing: true,
  progress_ms: 12000,
  device: { volume_percent: 42, supports_volume: true, is_restricted: false },
  item: {
    type: "track",
    name: "Signal",
    duration_ms: 180000,
    artists: [{ name: "Artist One" }, { name: "Artist Two" }],
    album: { name: "Night Drive", images: [{ url: "https://image.test/cover.jpg" }] },
    external_urls: { spotify: "https://open.spotify.com/track/one" }
  },
  actions: { disallows: { skipping_prev: true, skipping_next: true } }
};

test("connects with PKCE and stores Spotify tokens locally", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-spotify-"));
  await mkdir(join(root, "config"));
  const redirectUri = "http://127.0.0.1:4317/api/integrations/spotify/callback";
  const authorizationUrl = await beginSpotifyConnect(root, { clientId: "client123", redirectUri });
  const url = new URL(authorizationUrl);
  assert.equal(url.searchParams.get("client_id"), "client123");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.deepEqual(url.searchParams.get("scope").split(" ").sort(), [
    "playlist-modify-private",
    "playlist-modify-public",
    "playlist-read-private",
    "user-modify-playback-state",
    "user-read-currently-playing",
    "user-read-playback-state",
    "user-read-private",
    "user-read-recently-played"
  ]);
  const savedClient = JSON.parse(await readFile(spotifyPaths(root).auth, "utf8"));
  assert.deepEqual(savedClient, { clientId: "client123" });

  const fetch = async (request) => String(request).includes("/api/token")
    ? new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }), { status: 200 })
    : new Response(null, { status: 204 });
  const connected = await finishSpotifyConnect(root, {
    state: url.searchParams.get("state"),
    code: "authorization-code",
    redirectUri
  }, { fetch });
  assert.equal(connected.connected, true);
  assert.equal(connected.requiresReconnect, false);
  assert.equal(connected.playback, null);
  const auth = JSON.parse(await readFile(spotifyPaths(root).auth, "utf8"));
  assert.equal(auth.refreshToken, "refresh");
  assert.equal(auth.accessToken, "access");
  assert.ok(Date.parse(auth.authorizedAt) <= Date.now(), "the sign-in time is kept so Jarvis can warn before Spotify ends it");
  assert.equal(connected.musicReconnect, false);
  assert.equal(Date.parse(connected.grantExpiresAt) - Date.parse(auth.authorizedAt), 182 * 86_400_000);
});

test("an older grant without the music scopes asks for one reconnect", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-spotify-"));
  await mkdir(join(root, "config"));
  await writeFile(spotifyPaths(root).auth, JSON.stringify({ clientId: "client123", refreshToken: "refresh", accessToken: "access", scopes: ["user-read-currently-playing", "user-read-playback-state", "user-modify-playback-state"], expiresAt: Date.now() + 3600000 }));
  const status = await spotifyStatus(root, { fetch: async () => new Response(null, { status: 204 }) });
  assert.equal(status.requiresReconnect, false, "playback keeps working");
  assert.equal(status.musicReconnect, true);
  assert.equal(status.grantExpiresAt, null);
});

test("an expired Spotify sign-in reads as a reconnect", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-spotify-"));
  await mkdir(join(root, "config"));
  await writeFile(spotifyPaths(root).auth, JSON.stringify({ clientId: "client123", refreshToken: "old", accessToken: "x", expiresAt: 0 }));
  const status = await spotifyStatus(root, { fetch: async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Refresh token revoked" }), { status: 400 }) });
  assert.match(status.error, /Reconnect Spotify/);
});

test("normalizes tracks, episodes, and empty playback", () => {
  assert.deepEqual(normalizeSpotifyPlayback(null), null);
  const normalizedTrack = normalizeSpotifyPlayback(track, 123);
  assert.equal(normalizedTrack.title, "Signal");
  assert.equal(normalizedTrack.subtitle, "Artist One, Artist Two");
  assert.equal(normalizedTrack.context, "Night Drive");
  assert.equal(normalizedTrack.canPrevious, false);
  assert.equal(normalizedTrack.canNext, false);
  assert.equal(normalizedTrack.volumePercent, 42);
  assert.equal(normalizedTrack.canSetVolume, true);
  assert.equal(normalizedTrack.fetchedAt, 123);

  const episode = normalizeSpotifyPlayback({
    is_playing: false,
    item: {
      type: "episode",
      name: "Episode 7",
      duration_ms: 2400000,
      show: { name: "Build Notes", publisher: "Jarvis Labs", images: [{ url: "https://image.test/show.jpg" }] },
      external_urls: { spotify: "https://open.spotify.com/episode/seven" }
    }
  });
  assert.equal(episode.type, "episode");
  assert.equal(episode.subtitle, "Jarvis Labs");
  assert.equal(episode.context, "Build Notes");
  assert.equal(episode.isPlaying, false);
  assert.equal(episode.volumePercent, null);
  assert.equal(episode.canSetVolume, false);
});

test("normalizes unsupported Spotify volume devices", () => {
  const playback = normalizeSpotifyPlayback({ ...track, device: { volume_percent: 80, supports_volume: false } });
  assert.equal(playback.volumePercent, 80);
  assert.equal(playback.canSetVolume, false);
});

test("refreshes tokens and sends only supported playback controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-spotify-"));
  await mkdir(join(root, "config"));
  await writeFile(spotifyPaths(root).auth, JSON.stringify({ clientId: "client123", refreshToken: "refresh", accessToken: "expired", expiresAt: 0 }));
  const controls = [];
  const fetch = async (request, init = {}) => {
    const url = String(request);
    if (url.includes("/api/token")) return new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), { status: 200 });
    if (url.includes("currently-playing")) return new Response(JSON.stringify(track), { status: 200 });
    controls.push([init.method, new URL(url).pathname]);
    return new Response(null, { status: 204 });
  };
  for (const action of ["previous", "play", "pause", "next"]) {
    const playback = await controlSpotifyPlayback(root, action, { fetch, now: () => 456 });
    assert.equal(playback.fetchedAt, 456);
  }
  assert.deepEqual(controls, [
    ["POST", "/v1/me/player/previous"],
    ["PUT", "/v1/me/player/play"],
    ["PUT", "/v1/me/player/pause"],
    ["POST", "/v1/me/player/next"]
  ]);
  await assert.rejects(controlSpotifyPlayback(root, "rewind", { fetch }), (error) => error.status === 400);
});

test("reports rate limits without dropping connection state", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-spotify-"));
  await mkdir(join(root, "config"));
  await writeFile(spotifyPaths(root).auth, JSON.stringify({ clientId: "client123", refreshToken: "refresh", accessToken: "access", expiresAt: Date.now() + 3600000 }));
  const status = await spotifyStatus(root, {
    fetch: async () => new Response(JSON.stringify({ error: { message: "Too many requests" } }), { status: 429, headers: { "retry-after": "3" } })
  });
  assert.equal(status.connected, true);
  assert.equal(status.requiresReconnect, true);
  assert.equal(status.error, "Too many requests");
  assert.equal(status.retryAfterMs, 3000);
});

test("keeps old Spotify playback working while requiring one reconnect for volume", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-spotify-"));
  await mkdir(join(root, "config"));
  await writeFile(spotifyPaths(root).auth, JSON.stringify({ clientId: "client123", refreshToken: "refresh", accessToken: "access", scopes: ["user-read-currently-playing", "user-modify-playback-state"], expiresAt: Date.now() + 3600000 }));
  const status = await spotifyStatus(root, { fetch: async (request) => {
    assert.match(String(request), /currently-playing/);
    return new Response(JSON.stringify({ ...track, device: undefined }), { status: 200 });
  } });
  assert.equal(status.requiresReconnect, true);
  assert.equal(status.playback.title, "Signal");
  assert.equal(status.playback.canSetVolume, false);
});

test("lists output devices and moves playback to the one picked", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-spotify-"));
  await mkdir(join(root, "config"));
  await writeFile(spotifyPaths(root).auth, JSON.stringify({ clientId: "client123", refreshToken: "refresh", accessToken: "access", scopes: ["user-read-playback-state", "user-modify-playback-state"], expiresAt: Date.now() + 3600000 }));
  const sent = [];
  const fetch = async (request, init = {}) => {
    const url = new URL(String(request));
    if (url.pathname === "/v1/me/player/devices") return new Response(JSON.stringify({ devices: [
      { id: "abc123", name: "DESKTOP-PC", type: "Computer", is_active: true, is_restricted: false, volume_percent: 60 },
      { id: "def456", name: "Living Room", type: "Speaker", is_active: false, is_restricted: false, volume_percent: null },
      { id: null, name: "Private session phone", type: "Smartphone", is_active: false, is_restricted: true }
    ] }), { status: 200 });
    if (url.pathname === "/v1/me/player" && init.method === "PUT") {
      sent.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/v1/me/player") return new Response(JSON.stringify({ ...track, device: { id: "def456", name: "Living Room", type: "Speaker", volume_percent: 30, supports_volume: true } }), { status: 200 });
    return new Response(null, { status: 404 });
  };
  const devices = await listSpotifyDevices(root, { fetch });
  assert.deepEqual(devices, [
    { id: "abc123", name: "DESKTOP-PC", type: "Computer", active: true, restricted: false },
    { id: "def456", name: "Living Room", type: "Speaker", active: false, restricted: false }
  ], "a device without an id can't be picked, so it isn't listed");

  const playback = await transferSpotifyPlayback(root, "def456", { fetch, settleMs: 0 });
  assert.deepEqual(sent, [{ device_ids: ["def456"], play: false }], "keeps the current play or pause state");
  assert.deepEqual(playback.device, { id: "def456", name: "Living Room", type: "Speaker" });
  for (const bad of ["", "../x", 42, "a".repeat(200)]) {
    await assert.rejects(transferSpotifyPlayback(root, bad, { fetch, settleMs: 0 }), (error) => error.status === 400);
  }
});

test("sets Spotify volume with the exact percent and validates boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-spotify-"));
  await mkdir(join(root, "config"));
  await writeFile(spotifyPaths(root).auth, JSON.stringify({ clientId: "client123", refreshToken: "refresh", accessToken: "access", scopes: ["user-read-playback-state", "user-modify-playback-state"], expiresAt: Date.now() + 3600000 }));
  const requests = [];
  const fetch = async (request, init = {}) => {
    const url = String(request);
    if (new URL(url).pathname === "/v1/me/player") return new Response(JSON.stringify(track), { status: 200 });
    requests.push([init.method, url]);
    return new Response(null, { status: 204 });
  };
  const playback = await setSpotifyVolume(root, 0, { fetch, now: () => 789 });
  assert.equal(playback.fetchedAt, 789);
  await setSpotifyVolume(root, 100, { fetch });
  assert.deepEqual(requests.map(([method, url]) => [method, new URL(url).pathname, new URL(url).search]), [
    ["PUT", "/v1/me/player/volume", "?volume_percent=0"],
    ["PUT", "/v1/me/player/volume", "?volume_percent=100"]
  ]);
  for (const value of [-1, 101, 4.5, "50"]) {
    await assert.rejects(setSpotifyVolume(root, value, { fetch }), (error) => error.status === 400);
  }
});
