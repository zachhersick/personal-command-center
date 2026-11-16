import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileHistory } from "../server/music/history.js";
import { buildPlaylist, syncPlaylist } from "../server/music/playlists.js";
import { createResolver } from "../server/music/resolver.js";
import { createMusicEngine } from "../server/music/engine.js";
import { saveRule, playlistState } from "../server/music/rules.js";
import { ensurePlanState } from "../server/plan/state.js";
import { createSpotifyApi, missingMusicScopes } from "../server/spotify.js";
import { createFakeSpotify, fakeTrack, FAKE_AUTH, FAKE_SCOPES } from "./fake-spotify.js";
import { removeTempDir } from "./helpers.js";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const DAY = 86_400_000;

async function setup({ tracks, plays, apple = null, scopes = FAKE_SCOPES }) {
  const root = await mkdtemp(join(tmpdir(), "jarvis-music-"));
  const history = createFileHistory(() => root);
  const fake = createFakeSpotify({ tracks, scopes });
  let auth = { ...FAKE_AUTH, scopes };
  const api = createSpotifyApi({ loadAuth: async () => auth, saveAuth: async (next) => { auth = next; }, fetch: fake.fetch });
  // plays: [[trackIndexInTracks, daysAgo, times]]
  const rows = [];
  for (const [at, daysAgo, times = 1] of plays) for (let i = 0; i < times; i += 1) rows.push({ ms: NOW - daysAgo * DAY - i * 60_000, ref: tracks[at].uri });
  const played = new Set(rows.map((row) => row.ref));
  const catalog = Object.fromEntries(tracks.filter((track) => played.has(track.uri)).map((track) => [track.uri, { name: track.name, artists: track.artists.map((artist) => artist.name), album: track.album.name }]));
  await history.addPlays(rows, catalog);
  if (apple) await history.setExport("apple", apple, "2026-11-01T00:00:00.000Z");
  const resolver = createResolver({ api, loadCache: () => history.readResolveCache(), saveCache: (value) => history.writeResolveCache(value), now: () => NOW });
  return { root, history, fake, api, resolver };
}

const rule = (extra = {}) => ({ id: "mp_test", name: "Top of the week", topK: 3, windowDays: 7, synced: true, intervalHours: 24, ...extra });

test("never puts the same song twice, and picks the version Zach plays most", async (t) => {
  const tracks = [
    fakeTrack(1, "Dreams", ["Fleetwood Mac"]),
    fakeTrack(2, "Dreams - 2004 Remaster", ["Fleetwood Mac"]),
    fakeTrack(3, "Dreams - Live", ["Fleetwood Mac"]),
    fakeTrack(4, "Landslide", ["Fleetwood Mac"]),
    fakeTrack(5, "Rhiannon", ["Fleetwood Mac"])
  ];
  const { root, history, resolver } = await setup({ tracks, plays: [[0, 1, 4], [1, 2, 5], [2, 1, 3], [3, 3, 6], [4, 1, 1]] });
  t.after(() => removeTempDir(root));
  const built = await buildPlaylist(rule(), { history, resolver, now: NOW });
  assert.deepEqual(built.tracks.map((track) => track.ref), [tracks[1].uri, tracks[3].uri, tracks[2].uri], "Dreams (9 plays, remaster version) beats Landslide (6); Live is its own song");
  assert.equal(new Set(built.tracks.map((track) => track.ref)).size, built.tracks.length);
});

test("an unplayable version falls back to another version Zach played, then the next song fills the slot", async (t) => {
  const tracks = [
    fakeTrack(1, "Song A", ["X"], { playable: false }),
    fakeTrack(2, "Song A - Remastered 2011", ["X"]),
    fakeTrack(3, "Song B", ["X"], { restricted: true, playable: false }),
    fakeTrack(4, "Song C", ["X"]),
    fakeTrack(5, "Song D", ["X"])
  ];
  const { root, history, resolver } = await setup({ tracks, plays: [[0, 1, 9], [1, 1, 1], [2, 1, 8], [3, 1, 7], [4, 1, 6]] });
  t.after(() => removeTempDir(root));
  const built = await buildPlaylist(rule(), { history, resolver, now: NOW });
  assert.deepEqual(built.tracks.map((track) => track.ref), [tracks[1].uri, tracks[3].uri, tracks[4].uri]);
  assert.match(built.tracks[0].note, /Another version/);
  assert.deepEqual(built.skipped.map((song) => [song.title, song.reason]), [["Song B", "No version you play is available on Spotify"]]);
});

test("a compilation release credited to Various Artists doesn't become a second copy of the song", async (t) => {
  // The Spotify export only names the album artist, so this release looks
  // like a different song until Spotify's own metadata says who sings it.
  const tracks = [fakeTrack(1, "Dreams", ["Fleetwood Mac"]), fakeTrack(2, "Dreams", ["Fleetwood Mac"]), fakeTrack(3, "Gypsy", ["Fleetwood Mac"])];
  // Either release can rank first; both orders must give one Dreams.
  for (const [compilationPlays, albumPlays, first] of [[4, 3, 0], [3, 5, 1]]) {
    const { root, history, resolver } = await setup({ tracks, plays: [[1, 1, albumPlays], [2, 1, 2]] });
    t.after(() => removeTempDir(root));
    await history.setExport("spotify", { from: NOW - 3 * DAY, to: NOW - 2 * DAY, tracks: [[tracks[0].uri, "Dreams", "Various Artists", "Hits"]], plays: [...Array(compilationPlays)].map((_, i) => [Math.floor((NOW - 2.5 * DAY) / 1000) + i, 0]) });
    const built = await buildPlaylist(rule({ topK: 5 }), { history, resolver, now: NOW });
    assert.deepEqual(built.tracks.map((track) => track.ref), [tracks[first].uri, tracks[2].uri]);
    assert.deepEqual(built.skipped.map((song) => song.reason), ["Already on the playlist"]);
  }
});

test("plays outside the rolling window don't count", async (t) => {
  const tracks = [fakeTrack(1, "Old", ["X"]), fakeTrack(2, "New", ["X"]), fakeTrack(3, "Edge", ["X"])];
  const { root, history } = await setup({ tracks, plays: [[0, 8, 50], [1, 6, 1], [2, 6.99, 2]] });
  t.after(() => removeTempDir(root));
  const week = await buildPlaylist(rule({ topK: 10 }), { history, now: NOW });
  assert.deepEqual(week.tracks.map((track) => track.title), ["Edge", "New"]);
  const allTime = await buildPlaylist(rule({ topK: 10, windowDays: null }), { history, now: NOW });
  assert.deepEqual(allTime.tracks.map((track) => track.title), ["Old", "Edge", "New"]);
});

test("songs heard only on Apple Music are matched on Spotify by search, without duplicating a Spotify song", async (t) => {
  const tracks = [fakeTrack(1, "Dreams", ["Fleetwood Mac"]), fakeTrack(2, "Everywhere", ["Fleetwood Mac"]), fakeTrack(3, "Everywhere - Live", ["Fleetwood Mac"])];
  const apple = {
    from: NOW - 900 * DAY,
    to: NOW - 800 * DAY,
    tracks: [["apple:11", "Everywhere (2017 Remaster)", "Fleetwood Mac", ""], ["apple:12", "Dreams", "Fleetwood Mac", ""], ["apple:13", "Unknown Song", "Nobody", ""]],
    plays: [...Array(30)].map((_, i) => [Math.floor((NOW - 850 * DAY) / 1000) + i, 0]).concat([[Math.floor((NOW - 850 * DAY) / 1000) + 100, 1], [Math.floor((NOW - 850 * DAY) / 1000) + 101, 2], [Math.floor((NOW - 850 * DAY) / 1000) + 102, 2]])
  };
  const { root, history, resolver } = await setup({ tracks, plays: [[0, 1, 5]], apple });
  t.after(() => removeTempDir(root));
  const built = await buildPlaylist(rule({ windowDays: null, topK: 10 }), { history, resolver, now: NOW });
  assert.deepEqual(built.tracks.map((track) => [track.title, track.ref]), [
    ["Everywhere (2017 Remaster)", tracks[1].uri],
    ["Dreams", tracks[0].uri]
  ], "Everywhere is found by search; the studio version, not the live one; Apple's Dreams plays join the Spotify Dreams");
  assert.deepEqual(built.skipped.map((song) => song.title), ["Unknown Song"]);
  const preview = await buildPlaylist(rule({ windowDays: null, topK: 10 }), { history, now: NOW });
  assert.equal(preview.tracks[0].ref, null, "without Spotify the Apple-only song waits to be matched");
});

test("syncs create a private playlist once, write past 100 tracks in chunks, and skip unchanged lists", async (t) => {
  const tracks = [...Array(130)].map((_, i) => fakeTrack(i + 1, `Track ${i + 1}`, ["X"]));
  const { root, history, resolver, fake, api } = await setup({ tracks, plays: tracks.map((_, i) => [i, 1, 200 - i]) });
  t.after(() => removeTempDir(root));
  const big = rule({ topK: 120 });
  const first = await syncPlaylist(big, null, { api, history, resolver, now: NOW });
  assert.equal(first.lastResult.created, true);
  const playlist = fake.state.playlists.get(first.spotifyPlaylistId);
  assert.equal(playlist.public, false);
  assert.equal(playlist.uris.length, 120);
  assert.deepEqual(playlist.uris.slice(0, 2), [tracks[0].uri, tracks[1].uri]);
  assert.match(playlist.description, /\[jarvis:mp_test\]$/);

  fake.state.calls.length = 0;
  const second = await syncPlaylist(big, first, { api, history, resolver, now: NOW + 1000 });
  assert.equal(second.lastResult.changed, false);
  assert.deepEqual(fake.state.calls.filter((call) => !call.startsWith("GET")), [], "an unchanged list writes nothing");

  playlist.uris.reverse();
  const third = await syncPlaylist(big, second, { api, history, resolver, now: NOW + 2000 });
  assert.equal(third.lastResult.changed, true, "a manual reorder is put back");
  assert.equal(playlist.uris[0], tracks[0].uri);
});

test("only writes to the playlist the rule made, and finds it again after the id is lost", async (t) => {
  const tracks = [fakeTrack(1, "A", ["X"]), fakeTrack(2, "B", ["X"])];
  const { root, history, resolver, fake, api } = await setup({ tracks, plays: [[0, 1, 2], [1, 1, 1]] });
  t.after(() => removeTempDir(root));
  fake.state.playlists.set("mine", { id: "mine", name: "Top of the week", description: "my own stats.fm playlist", owner: { id: "zach" }, uris: ["spotify:track:keep"] });
  const first = await syncPlaylist(rule(), null, { api, history, resolver, now: NOW });
  assert.notEqual(first.spotifyPlaylistId, "mine", "a playlist with the same name isn't taken over");
  assert.deepEqual(fake.state.playlists.get("mine").uris, ["spotify:track:keep"]);
  const again = await syncPlaylist(rule(), { lastSyncedAt: null }, { api, history, resolver, now: NOW });
  assert.equal(again.spotifyPlaylistId, first.spotifyPlaylistId, "the marker finds it; no second playlist");
  assert.equal(fake.state.playlists.size, 2);
  const recreated = await syncPlaylist(rule(), { generation: 1 }, { api, history, resolver, now: NOW });
  assert.notEqual(recreated.spotifyPlaylistId, first.spotifyPlaylistId, "recreate makes a new one");
  assert.equal(fake.state.playlists.size, 3);
});

test("the engine syncs due rules, records results in the plan, and reports a deleted playlist", async (t) => {
  const tracks = [fakeTrack(1, "A", ["X"]), fakeTrack(2, "B", ["X"])];
  const { root, history, fake, api } = await setup({ tracks, plays: [[0, 1, 2], [1, 1, 1]] });
  t.after(() => removeTempDir(root));
  let plan = saveRule(ensurePlanState({}), { name: "Week", topK: 5, windowDays: 7, synced: true, intervalHours: 24 }, new Date(NOW - DAY).toISOString()).plan;
  let clock = NOW;
  const engine = createMusicEngine({
    history,
    spotify: async () => ({ api }),
    loadPlan: async () => plan,
    updatePlan: async (work) => { plan = work(plan); },
    clock: () => clock
  });
  const [ruleEntry] = plan.musicPlaylists;
  let done = await engine.syncDue();
  assert.equal(done.length, 1);
  assert.equal(playlistState(plan, ruleEntry.id).lastResult.tracks, 2);
  clock += 3_600_000;
  assert.deepEqual(await engine.syncDue(), [], "not due again an hour later");
  clock += 24 * 3_600_000;
  fake.state.playlists.clear();
  done = await engine.syncDue();
  const state = playlistState(plan, ruleEntry.id);
  assert.equal(state.lastResult.ok, false);
  assert.match(state.lastResult.error, /gone/);
  assert.equal(state.spotifyPlaylistId, null);
  clock += 3_600_000;
  await engine.syncDue();
  assert.equal(playlistState(plan, ruleEntry.id).lastResult.ok, true, "a new playlist is made on the next try");
  assert.equal(fake.state.playlists.size, 1);
});

test("a long build stops at the deadline and continues next time", async (t) => {
  const tracks = [...Array(5)].map((_, i) => fakeTrack(i + 1, `T${i}`, ["X"]));
  const { root, history, resolver } = await setup({ tracks, plays: tracks.map((_, i) => [i, 1, 10 - i]) });
  t.after(() => removeTempDir(root));
  let ticks = 0;
  await assert.rejects(buildPlaylist(rule({ topK: 5 }), { history, resolver, now: NOW, deadline: 2, clock: () => ticks++ }), (error) => error.retrySoon === true);
  await resolver.flush();
  const cache = await history.readResolveCache();
  assert.ok(Object.keys(cache.tracks).length >= 1, "checks already made are kept for the next run");
});

test("Spotify's rate limit pauses syncs and lookups until it says, then syncs resume", async (t) => {
  const tracks = [fakeTrack(1, "A", ["X"]), fakeTrack(2, "B", ["X"])];
  const { root, history, fake, api } = await setup({ tracks, plays: [[0, 1, 2], [1, 1, 1]] });
  t.after(() => removeTempDir(root));
  let plan = saveRule(ensurePlanState({}), { name: "Week", topK: 5, windowDays: 7, synced: true, intervalHours: 24 }, new Date(NOW - DAY).toISOString()).plan;
  let clock = NOW;
  const engine = createMusicEngine({ history, spotify: async () => ({ api }), loadPlan: async () => plan, updatePlan: async (work) => { plan = work(plan); }, clock: () => clock });
  const [ruleEntry] = plan.musicPlaylists;

  // Spotify answers 429 with an 11-hour Retry-After, as it does after too many requests.
  fake.state.failNext = { match: /./, status: 429, headers: { "retry-after": String(11 * 3600) } };
  await engine.syncDue();
  let state = playlistState(plan, ruleEntry.id);
  assert.equal(state.lastResult.ok, false);
  assert.equal(state.lastResult.retryAt, new Date(NOW + 11 * 3_600_000).toISOString());
  assert.equal((await history.enrichState()).spotifyPausedUntil, NOW + 11 * 3_600_000, "syncs wait exactly as long as Spotify says");
  assert.equal((await history.enrichState()).lookupsPausedUntil, NOW + 22 * 3_600_000, "lookups wait twice as long");

  // Inside the pause nothing is asked of Spotify, even when a sync is due or asked for.
  const calls = fake.state.calls.length;
  clock += 2 * 3_600_000;
  assert.deepEqual(await engine.syncDue(), []);
  await engine.syncRule(ruleEntry.id);
  assert.equal(fake.state.calls.length, calls, "no requests during the pause");
  state = playlistState(plan, ruleEntry.id);
  assert.equal(state.lastResult.retryAt, new Date(NOW + 11 * 3_600_000).toISOString());

  // After it, the sync runs on the next tick rather than an hour later.
  clock = NOW + 11 * 3_600_000 + 60_000;
  const done = await engine.syncDue();
  assert.equal(done.length, 1);
  assert.equal(playlistState(plan, ruleEntry.id).lastResult.ok, true);
});

test("an all-time playlist that needs search asks for a reconnect when the sign-in lacks user-read-private", async (t) => {
  // The ALLTIME case: an Apple-only song has to be found by search, and a
  // sign-in from before user-read-private was asked for gets a 403 there.
  const tracks = [fakeTrack(1, "Dreams", ["Fleetwood Mac"]), fakeTrack(2, "Everywhere", ["Fleetwood Mac"])];
  const apple = {
    from: NOW - 900 * DAY,
    to: NOW - 800 * DAY,
    tracks: [["apple:11", "Everywhere", "Fleetwood Mac", ""]],
    plays: [...Array(5)].map((_, i) => [Math.floor((NOW - 850 * DAY) / 1000) + i, 0])
  };
  const oldScopes = FAKE_SCOPES.filter((scope) => scope !== "user-read-private");
  assert.deepEqual(missingMusicScopes({ scopes: oldScopes }), ["user-read-private"], "Jarvis treats the old sign-in as needing a reconnect");
  const { root, history, fake, api } = await setup({ tracks, plays: [[0, 1, 2]], apple, scopes: oldScopes });
  t.after(() => removeTempDir(root));
  let plan = saveRule(ensurePlanState({}), { name: "ALLTIME", topK: 500, windowDays: null, synced: true, intervalHours: 168 }, new Date(NOW - DAY).toISOString()).plan;
  const engine = createMusicEngine({ history, spotify: async () => ({ api }), loadPlan: async () => plan, updatePlan: async (work) => { plan = work(plan); }, clock: () => NOW });
  const [ruleEntry] = plan.musicPlaylists;
  await engine.syncDue();
  const state = playlistState(plan, ruleEntry.id);
  assert.equal(state.lastResult.ok, false);
  assert.match(state.lastResult.error, /Reconnect Spotify/);
  assert.equal(state.lastResult.missing, false, "a permission problem isn't a missing playlist");
  assert.equal(state.generation, undefined, "the playlist isn't abandoned for a new one");
  assert.equal(fake.state.playlists.size, 0);
});

test("with user-read-private the same all-time playlist syncs, including the song found by search", async (t) => {
  const tracks = [fakeTrack(1, "Dreams", ["Fleetwood Mac"]), fakeTrack(2, "Everywhere", ["Fleetwood Mac"])];
  const apple = {
    from: NOW - 900 * DAY,
    to: NOW - 800 * DAY,
    tracks: [["apple:11", "Everywhere", "Fleetwood Mac", ""]],
    plays: [...Array(5)].map((_, i) => [Math.floor((NOW - 850 * DAY) / 1000) + i, 0])
  };
  const { root, history, fake, api } = await setup({ tracks, plays: [[0, 1, 2]], apple });
  t.after(() => removeTempDir(root));
  let plan = saveRule(ensurePlanState({}), { name: "ALLTIME", topK: 500, windowDays: null, synced: true, intervalHours: 168 }, new Date(NOW - DAY).toISOString()).plan;
  const engine = createMusicEngine({ history, spotify: async () => ({ api }), loadPlan: async () => plan, updatePlan: async (work) => { plan = work(plan); }, clock: () => NOW });
  await engine.syncDue();
  const state = playlistState(plan, plan.musicPlaylists[0].id);
  assert.equal(state.lastResult.ok, true);
  assert.deepEqual([...fake.state.playlists.values()][0].uris, [tracks[1].uri, tracks[0].uri]);
});

test("background lookups ask Spotify at most every few seconds by default", async (t) => {
  const tracks = [fakeTrack(1, "A", ["X"]), fakeTrack(2, "B", ["Y"])];
  const { root, history, api } = await setup({ tracks, plays: [[0, 1, 2], [1, 1, 1]] });
  t.after(() => removeTempDir(root));
  let clock = NOW;
  const waits = [];
  const timed = { json: async (path) => api.json(path) };
  const engine = createMusicEngine({ history, spotify: async () => ({ api: timed }), loadPlan: async () => ({}), updatePlan: async () => {}, clock: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
  await engine.enrich();
  assert.ok(waits.length >= 2);
  assert.ok(Math.min(...waits) >= 5000, `waited ${Math.min(...waits)} ms between requests`);
});
