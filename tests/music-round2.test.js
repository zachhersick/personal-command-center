import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importFolder, parseAppleDaily } from "../server/music/importers.js";
import { createFileHistory, mergeExport, supersededBy } from "../server/music/history.js";
import { bucketStart, fillTimeline, filterByGenre, genreMatches, rankGenres, rankSongs, timelineUnit, DAY_MS } from "../server/music/rank.js";
import { createEnricher } from "../server/music/enrich.js";
import { normalizeRule } from "../server/music/rules.js";
import { buildPlaylist } from "../server/music/playlists.js";
import { createMusicEngine } from "../server/music/engine.js";
import { MemoryStore } from "../server/cloud/store.js";
import { createCloudHistory, receivePush } from "../server/cloud/music.js";
import { createSpotifyApi } from "../server/spotify.js";
import { createFakeSpotify, fakeTrack, FAKE_AUTH } from "./fake-spotify.js";
import { removeTempDir } from "./helpers.js";

const uri = (n) => `spotify:track:${String(n).padStart(22, "0")}`;

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "jarvis-music-r2-"));
  t.after(() => removeTempDir(root));
  return root;
}

function fakeApi(fake) {
  let auth = { ...FAKE_AUTH };
  return createSpotifyApi({ loadAuth: async () => auth, saveAuth: async (next) => { auth = next; }, fetch: fake.fetch });
}

// ---------- minutes ----------
test("imports keep the time heard: Spotify per stream, Apple split across a day's plays", async (t) => {
  const root = await tempRoot(t);
  const dir = join(root, "export");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "Streaming_History_Audio_2026.json"), JSON.stringify([
    { ts: "2026-01-01T10:00:00Z", ms_played: 95_000, spotify_track_uri: uri(1), master_metadata_track_name: "A", master_metadata_album_artist_name: "X" },
    { ts: "2026-01-01T11:00:00Z", ms_played: 10_000, spotify_track_uri: uri(1), master_metadata_track_name: "A", master_metadata_album_artist_name: "X" }
  ]));
  const parsed = await importFolder(root);
  assert.deepEqual(parsed.spotify.plays.map(([, , ms]) => ms), [95_000], "a 10 s stream doesn't count");

  const csv = join(root, "Apple Music - Play History Daily Tracks.csv");
  await writeFile(csv, [
    "Country,\"Track Identifier\",\"Media type\",\"Date Played\",Hours,\"Play Duration Milliseconds\",\"End Reason Type\",\"Source Type\",\"Play Count\",\"Skip Count\",\"Ignore For Recommendations\",\"Track Reference\",\"Track Description\"",
    "US,111,AUDIO,20210301,\"9, 10\",600000,NATURAL_END_OF_TRACK,,3,0,,1,Artist - Song"
  ].join("\n"));
  const apple = await parseAppleDaily(csv);
  assert.deepEqual(apple.plays.map(([, , ms]) => ms), [200_000, 200_000, 200_000]);
});

test("the same streams in an old and a new export folder count once", async (t) => {
  const root = await tempRoot(t);
  const rows = [
    { ts: "2026-01-01T10:00:00Z", ms_played: 100_000, spotify_track_uri: uri(1), master_metadata_track_name: "A", master_metadata_album_artist_name: "X" },
    { ts: "2026-01-02T10:00:00Z", ms_played: 100_000, spotify_track_uri: uri(2), master_metadata_track_name: "B", master_metadata_album_artist_name: "X" }
  ];
  for (const [folder, list] of [["my_spotify_data (Aug)", rows], ["my_spotify_data (Nov)", [...rows, { ...rows[0], ts: "2026-02-01T10:00:00Z" }]]]) {
    await mkdir(join(root, folder, "Spotify Extended Streaming History"), { recursive: true });
    await writeFile(join(root, folder, "Spotify Extended Streaming History", "Streaming_History_Audio_2026.json"), JSON.stringify(list));
  }
  const parsed = await importFolder(root);
  assert.equal(parsed.spotify.plays.length, 3);
  assert.equal(parsed.spotify.duplicates, 2);
});

test("rankings use listening time: fewer, longer plays can outrank more, shorter ones", () => {
  const counts = new Map([[uri(1), { plays: 5, ms: 5 * 60_000, last: 1 }], [uri(2), { plays: 2, ms: 2 * 400_000, last: 2 }]]);
  const catalog = new Map([[uri(1), { name: "Short", artist: "X" }], [uri(2), { name: "Long", artist: "Y" }]]);
  assert.deepEqual(rankSongs(counts, catalog).map((song) => song.title), ["Long", "Short"]);
});

test("plays saved without their time count the track's length once it's known", async (t) => {
  const root = await tempRoot(t);
  const history = createFileHistory(() => root);
  // An import from the first version: plays without ms.
  await mkdir(join(root, "data", "music"), { recursive: true });
  await writeFile(join(root, "data", "music", "spotify-export.local.json"), JSON.stringify({ version: 1, source: "spotify", from: 0, to: 10_000_000, tracks: [[uri(1), "A", "X", ""]], plays: [[100, 0], [200, 0]] }));
  assert.equal((await history.counts()).get(uri(1)).ms, 0);
  await history.saveEnrichment({ tracks: { [uri(1)]: { checkedAt: 1, durationMs: 180_000 } } });
  assert.equal((await history.counts()).get(uri(1)).ms, 360_000);
  assert.equal((await history.summary()).spotifyExport.exactMinutes, false);
});

test("stats count the plays with no known time, so the page can ask for a re-import", async (t) => {
  const root = await tempRoot(t);
  const history = createFileHistory(() => root);
  await mkdir(join(root, "data", "music"), { recursive: true });
  await writeFile(join(root, "data", "music", "spotify-export.local.json"), JSON.stringify({ version: 1, source: "spotify", from: 0, to: 10_000_000, tracks: [[uri(1), "A", "X", ""], [uri(2), "B", "X", ""]], plays: [[100, 0], [200, 0], [300, 1]] }));
  await history.saveEnrichment({ tracks: { [uri(2)]: { checkedAt: 1, durationMs: 180_000 } } });
  const engine = createMusicEngine({ history, spotify: async () => null, loadPlan: async () => ({}), updatePlan: async () => {}, clock: () => 20_000_000, timeZone: "UTC" });
  const before = await engine.top({ windowDays: null });
  assert.equal(before.plays, 3);
  assert.equal(before.untimed, 2, "two plays of a track whose length isn't known");
  assert.equal(before.ms, 180_000);

  // Importing the export again gives every play its time.
  await history.setExport("spotify", { from: 0, to: 10_000_000, tracks: [[uri(1), "A", "X", ""], [uri(2), "B", "X", ""]], plays: [[100, 0, 90_000], [200, 0, 90_000], [300, 1, 170_000]] });
  const after = await engine.top({ windowDays: null });
  assert.equal(after.untimed, 0);
  assert.equal(after.ms, 350_000);

  const store = new MemoryStore();
  await store.musicInsertPlays([{ ts: 100, ref: uri(1), src: "s" }, { ts: 200, ref: uri(2), src: "s", ms: 60_000 }]);
  const cloud = await createCloudHistory(store).counts();
  assert.equal(cloud.get(uri(1)).untimed, 1);
  assert.equal(cloud.get(uri(2)).untimed, 0);
});

// ---------- re-importing ----------
const day = (n) => Date.UTC(2026, 0, 1) + n * DAY_MS;
const sec = (ms) => Math.floor(ms / 1000);
const exportOf = (from, to, plays) => ({ from, to, tracks: [[uri(1), "A", "X", ""], [uri(2), "B", "X", ""]], plays });

test("a new export replaces only its own dates and keeps older history", () => {
  const previous = exportOf(day(0), day(100), [[sec(day(1)), 0, 1000], [sec(day(50)), 0, 1000], [sec(day(99)), 1, 1000]]);
  // A shorter export, covering only day 40 onwards.
  const next = exportOf(day(40), day(120), [[sec(day(50)), 0, 2000], [sec(day(110)), 1, 2000]]);
  const { record, kept, replaced } = mergeExport(previous, next);
  assert.equal(kept, 1, "day 1 is outside the new export and stays");
  assert.equal(replaced, 2);
  assert.deepEqual(record.plays.map(([s, , ms]) => [s, ms]), [[sec(day(1)), 1000], [sec(day(50)), 2000], [sec(day(110)), 2000]]);
  assert.deepEqual([record.from, record.to], [day(0), day(120)]);
});

test("recorded plays inside an export, or repeating its last stream, are dropped", () => {
  const data = exportOf(day(0), day(10), [[sec(day(10)), 0, 1000]]);
  const live = [
    [sec(day(5)), uri(2)], // inside
    [sec(day(10)) + 120, uri(1)], // the export's last stream, seen two minutes later
    [sec(day(10)) + 120, uri(2)], // a different track just after: real
    [sec(day(10)) + 3600, uri(1)] // the same track an hour later: real
  ];
  assert.deepEqual([...supersededBy(data, live)].sort(), [0, 1]);
});

test("importing previews first, merges, and warns about an older export", async (t) => {
  const root = await tempRoot(t);
  const history = createFileHistory(() => root);
  await history.setExport("spotify", exportOf(day(0), day(100), [[sec(day(1)), 0, 1000], [sec(day(90)), 1, 1000]]));
  await history.addPlays([{ ms: day(95), ref: uri(1), heard: 5000 }, { ms: day(105), ref: uri(2), heard: 5000 }]);
  assert.equal((await history.counts()).size, 2);
  const live = await history.livePlays();
  assert.equal(live.length, 1, "a recorded play inside the first export was never kept");

  const newer = exportOf(day(50), day(110), [[sec(day(90)), 1, 3000], [sec(day(104)), 1, 3000]]);
  const preview = await history.previewExport("spotify", newer);
  assert.deepEqual({ kept: preview.kept, replaced: preview.replaced, recorded: preview.recorded, older: preview.older }, { kept: 1, replaced: 1, recorded: 1, older: false });
  assert.equal((await history.summary()).plays, 3, "a preview changes nothing");

  await history.setExport("spotify", newer);
  const summary = await history.summary();
  assert.equal(summary.plays, 3, "day 1 kept, two from the new export, the recorded play it covers dropped");
  assert.equal(summary.spotifyExport.exactMinutes, true);
  assert.equal((await history.livePlays()).length, 0);

  const older = await history.previewExport("spotify", exportOf(day(0), day(60), [[sec(day(1)), 0, 1000]]));
  assert.equal(older.older, true);
});

// ---------- genres ----------
test("a genre filter matches whole words, so house includes deep house but not warehouse", () => {
  assert.equal(genreMatches("deep house", "house"), true);
  assert.equal(genreMatches("tech house", "House"), true);
  assert.equal(genreMatches("warehouse rave", "house"), false);
  assert.equal(genreMatches("deep house", "deep house"), true);
  assert.equal(genreMatches("tech house", "deep house"), false);
  assert.equal(genreMatches("hip hop", "hip-hop"), true);
});

test("genres rank by listening time and say how much is known", () => {
  const counts = new Map([[uri(1), { plays: 1, ms: 300, last: 1 }], [uri(2), { plays: 1, ms: 100, last: 1 }], [uri(3), { plays: 1, ms: 100, last: 1 }]]);
  const catalog = new Map([[uri(1), { name: "A", artist: "Deep One" }], [uri(2), { name: "B", artist: "Techy" }], [uri(3), { name: "C", artist: "Unknown" }]]);
  const artists = new Map([["deep one", { checkedAt: 1, genres: ["deep house", "house"] }], ["techy", { checkedAt: 1, genres: ["tech house"] }]]);
  const { genres, known } = rankGenres(counts, catalog, artists);
  assert.deepEqual(genres.map((genre) => [genre.name, genre.ms]), [["deep house", 300], ["house", 300], ["tech house", 100]]);
  assert.equal(known, 0.8);
  assert.deepEqual([...filterByGenre(counts, catalog, artists, "house").keys()], [uri(1), uri(2)]);
});

// ---------- timeline ----------
test("timeline buckets: day, Monday weeks and months, gaps filled", () => {
  assert.equal(timelineUnit(0, 30 * DAY_MS), "day");
  assert.equal(timelineUnit(0, 365 * DAY_MS), "week");
  assert.equal(timelineUnit(0, 1000 * DAY_MS), "month");
  assert.equal(bucketStart("2026-11-08", "week"), "2026-11-02", "a Sunday belongs to the week starting Monday");
  assert.equal(bucketStart("2026-11-09", "week"), "2026-11-09");
  assert.equal(bucketStart("2026-11-09", "month"), "2026-11-01");
  const filled = fillTimeline([{ start: "2026-10-01", ms: 5, plays: 1 }, { start: "2026-12-01", ms: 7, plays: 2 }], { firstDay: "2026-10-15", lastDay: "2026-12-03", unit: "month" });
  assert.deepEqual(filled.map((row) => [row.start, row.ms]), [["2026-10-01", 5], ["2026-11-01", 0], ["2026-12-01", 7]]);
});

test("timeline days follow the viewer's time zone", async (t) => {
  const root = await tempRoot(t);
  const history = createFileHistory(() => root);
  // 2026-03-02 05:30 UTC is still March 1 in Los Angeles.
  await history.addPlays([{ ms: Date.UTC(2026, 2, 2, 5, 30), ref: uri(1), heard: 60_000 }]);
  const la = await history.timeline({ unit: "day", timeZone: "America/Los_Angeles" });
  const utc = await history.timeline({ unit: "day", timeZone: "UTC" });
  assert.equal(la[0].start, "2026-03-01");
  assert.equal(utc[0].start, "2026-03-02");
});

// ---------- lookups ----------
function enrichHistory(counts, catalog) {
  const saved = { tracks: {}, artists: {}, pausedUntil: null, spotifyPausedUntil: null, lookupsPausedUntil: null };
  return {
    saved,
    async counts() {
      return counts;
    },
    async catalog(refs) {
      return new Map([...refs].map((ref) => [ref, { ...catalog.get(ref), ...saved.tracks[ref] }]));
    },
    async artists(keys) {
      return new Map([...keys].filter((key) => saved.artists[key]).map((key) => [key, saved.artists[key]]));
    },
    async enrichState() {
      return { pausedUntil: saved.pausedUntil, spotifyPausedUntil: saved.spotifyPausedUntil, lookupsPausedUntil: saved.lookupsPausedUntil };
    },
    async saveEnrichment({ tracks = {}, artists = {}, pausedUntil, spotifyPausedUntil, lookupsPausedUntil }) {
      Object.assign(saved.tracks, tracks);
      Object.assign(saved.artists, artists);
      if (pausedUntil !== undefined) saved.pausedUntil = pausedUntil;
      if (spotifyPausedUntil !== undefined) saved.spotifyPausedUntil = spotifyPausedUntil;
      if (lookupsPausedUntil !== undefined) saved.lookupsPausedUntil = lookupsPausedUntil;
    }
  };
}

test("lookups fetch the most-listened artists first and stop at the deadline", async () => {
  const tracks = [fakeTrack(1, "Small", ["Little Artist"]), fakeTrack(2, "Big", ["Big Artist"])];
  const fake = createFakeSpotify({ tracks, genres: { "Big Artist": ["deep house"], "Little Artist": ["indie"] } });
  const counts = new Map([[tracks[0].uri, { plays: 1, ms: 100, last: 1 }], [tracks[1].uri, { plays: 1, ms: 900, last: 1 }]]);
  const catalog = new Map([[tracks[0].uri, { name: "Small", artist: "Little Artist" }], [tracks[1].uri, { name: "Big", artist: "Big Artist" }]]);
  const history = enrichHistory(counts, catalog);
  let now = 1000;
  // Each call takes a "second"; the deadline allows one artist (track + artist lookups).
  const api = fakeApi(fake);
  const timed = { json: async (path) => { now += 1000; return api.json(path); } };
  const report = await createEnricher({ api: timed, history, clock: () => now, gapMs: 0 }).run({ deadline: 2500 });
  assert.equal(report.artists, 1);
  assert.deepEqual(Object.keys(history.saved.artists), ["big artist"]);
  assert.deepEqual(history.saved.artists["big artist"].genres, ["deep house"]);
  assert.match(history.saved.tracks[tracks[1].uri].image, /^https:\/\/i\.scdn\.co\//);
  assert.equal(history.saved.tracks[tracks[1].uri].durationMs, 200000);
});

test("artists aren't held up by artwork for songs on screen, and known artist IDs are reused", async () => {
  const shown = Array.from({ length: 30 }, (_, i) => fakeTrack(10 + i, `Shown ${i}`, ["Small Act"]));
  const top = fakeTrack(1, "Top", ["Top Act"]);
  const featured = fakeTrack(2, "Duet", ["Small Act", "Top Act"]);
  const fake = createFakeSpotify({ tracks: [top, featured, ...shown] });
  const counts = new Map([[top.uri, { plays: 9, ms: 9_000, last: 1 }], [featured.uri, { plays: 1, ms: 10, last: 1 }]]);
  const catalog = new Map([[top.uri, { name: "Top", artist: "Top Act" }], [featured.uri, { name: "Duet", artists: ["Small Act", "Top Act"] }]]);
  const history = enrichHistory(counts, catalog);
  // Top Act's ID is already known from a looked-up duet.
  history.saved.tracks[featured.uri] = { checkedAt: 1, artistIds: featured.artists.map((artist) => artist.id), artists: ["Small Act", "Top Act"] };
  let now = 1000;
  const api = fakeApi(fake);
  const timed = { json: async (path) => { now += 1000; return api.json(path); } };
  const wanted = new Set(shown.map((track) => track.uri));
  await createEnricher({ api: timed, history, clock: () => now, gapMs: 0, wanted }).run({ deadline: 1000 + 15_000 });
  assert.ok(history.saved.artists["top act"]?.id, "the top artist is looked up despite 30 songs waiting for artwork");
  assert.ok(!history.saved.tracks[top.uri], "its ID came from the duet, so its own track wasn't fetched");
  assert.ok(wanted.size > 0 && wanted.size < 30, "some artwork was fetched too");
});

test("a rate limit pauses lookups, and not-found results aren't asked again", async () => {
  const tracks = [fakeTrack(1, "Song", ["Gone Artist"])];
  const fake = createFakeSpotify({ tracks });
  fake.state.artists.clear();
  const counts = new Map([[tracks[0].uri, { plays: 1, ms: 100, last: 1 }], ["apple:9", { plays: 1, ms: 50, last: 1 }]]);
  const catalog = new Map([[tracks[0].uri, { name: "Song", artist: "Gone Artist" }], ["apple:9", { name: "Other", artist: "Apple Only" }]]);
  const history = enrichHistory(counts, catalog);
  const enricher = createEnricher({ api: fakeApi(fake), history, gapMs: 0, clock: () => 5000 });
  await enricher.run();
  assert.equal(history.saved.artists["gone artist"].missing, true);
  assert.equal(history.saved.artists["apple only"].missing, true, "no exact-name match: no guess");
  const calls = fake.state.calls.length;
  await enricher.run();
  assert.equal(fake.state.calls.length, calls, "both are cached");

  const limited = enrichHistory(counts, catalog);
  fake.state.failNext = { match: /GET \/tracks/, status: 429, headers: { "retry-after": "120" } };
  const report = await createEnricher({ api: fakeApi(fake), history: limited, gapMs: 0, clock: () => 5000 }).run();
  assert.equal(report.paused, true);
  // Syncs may go again when Spotify says; lookups stay off for six hours.
  assert.equal(limited.saved.spotifyPausedUntil, 5000 + 120_000);
  assert.equal(limited.saved.lookupsPausedUntil, 5000 + 6 * 3_600_000);
  const skipped = await createEnricher({ api: fakeApi(fake), history: limited, gapMs: 0, clock: () => 6000 }).run();
  assert.equal(skipped.paused, true, "nothing is asked until the pause ends");
});

// ---------- playlists ----------
test("fixed dates make a one-off playlist; genre and dates narrow what it draws from", async (t) => {
  const rule = normalizeRule({ name: "Summer house", topK: 10, fixedRange: { from: day(10), to: day(20), fromDay: "2026-01-11", toDay: "2026-01-21" }, synced: true, genre: "  House " });
  assert.equal(rule.synced, false);
  assert.equal(rule.windowDays, null);
  assert.equal(rule.genre, "house");
  assert.throws(() => normalizeRule({ name: "x", topK: 5, fixedRange: { from: day(5), to: day(1), fromDay: "2026-01-06", toDay: "2026-01-02" } }), /start date/);
  const back = normalizeRule({ fixedRange: null, windowDays: 30 }, rule);
  assert.equal(back.fixedRange, undefined);
  assert.equal(back.windowDays, 30);

  const root = await tempRoot(t);
  const history = createFileHistory(() => root);
  await history.addPlays([
    { ms: day(12), ref: uri(1), heard: 300_000 }, // house, in range
    { ms: day(12) + 1000, ref: uri(2), heard: 900_000 }, // indie, in range
    { ms: day(30), ref: uri(3), heard: 900_000 } // house, after the range
  ], { [uri(1)]: { name: "H1", artists: ["House Act"] }, [uri(2)]: { name: "I1", artists: ["Indie Act"] }, [uri(3)]: { name: "H2", artists: ["House Act"] } });
  await history.saveEnrichment({ artists: { "house act": { checkedAt: 1, genres: ["deep house"] }, "indie act": { checkedAt: 1, genres: ["indie rock"] } } });
  const built = await buildPlaylist(rule, { history, now: day(40) });
  assert.deepEqual(built.tracks.map((track) => track.title), ["H1"]);
});

test("stats: totals in minutes, genre filter, custom dates and a filled timeline", async (t) => {
  const root = await tempRoot(t);
  const history = createFileHistory(() => root);
  await history.addPlays([
    { ms: day(1), ref: uri(1), heard: 120_000 },
    { ms: day(3), ref: uri(2), heard: 60_000 },
    { ms: day(3) + 1000, ref: uri(1), heard: 120_000 }
  ], { [uri(1)]: { name: "H1", artists: ["House Act"] }, [uri(2)]: { name: "I1", artists: ["Indie Act"] } });
  await history.saveEnrichment({ artists: { "house act": { checkedAt: 1, genres: ["tech house"] }, "indie act": { checkedAt: 1, genres: ["indie"] } } });
  const engine = createMusicEngine({ history, spotify: async () => null, loadPlan: async () => ({}), updatePlan: async () => {}, clock: () => day(5), timeZone: "UTC" });
  const all = await engine.top({ windowDays: 30 });
  assert.equal(all.ms, 300_000);
  assert.deepEqual(all.genres.map((genre) => genre.name), ["tech house", "indie"]);
  const house = await engine.top({ windowDays: 30, genre: "house" });
  assert.equal(house.ms, 240_000);
  assert.deepEqual(house.tracks.map((track) => track.title), ["H1"]);
  const custom = await engine.top({ from: day(2), to: day(4) });
  assert.equal(custom.plays, 2);
  const line = await engine.timeline({ from: day(0), to: day(4), timeZone: "UTC" });
  assert.equal(line.unit, "day");
  assert.deepEqual(line.buckets.map((row) => row.ms), [0, 120_000, 0, 180_000, 0]);
  const genres = await engine.genres();
  assert.deepEqual(genres.genres.map((genre) => genre.name), ["tech house", "indie"]);
});

// ---------- cloud ----------
test("cloud: a re-import keeps recorded plays outside the new export and drops edge repeats", async () => {
  const store = new MemoryStore();
  const history = createCloudHistory(store);
  await store.musicInsertPlays([
    { ts: sec(day(5)), ref: uri(1), src: "c" }, // before the new export's dates: stays
    { ts: sec(day(15)), ref: uri(1), src: "c" }, // inside: replaced
    { ts: sec(day(20)) + 60, ref: uri(2), src: "c" } // the export's last stream again
  ]);
  await store.musicUpsertTracks([{ ref: uri(1), info: { name: "A", artist: "X", durationMs: 100_000 } }]);
  await receivePush(store, {
    src: "s",
    reset: true,
    done: true,
    range: { from: day(0), to: day(20), replaceFrom: day(10), replaceTo: day(20), importedAt: "x" },
    tracks: [[uri(2), "B", "X", "", "", { durationMs: 180_000, image: "https://i.scdn.co/image/abc", extra: "dropped" }]],
    plays: [[sec(day(20)), uri(2), 170_000]],
    artists: [["x", { checkedAt: 1, genres: ["house"], image: "https://evil.example/x.png" }]]
  });
  const counts = await history.counts();
  assert.equal(counts.get(uri(1)).plays, 1, "the recorded play before the new dates stays");
  assert.equal(counts.get(uri(1)).ms, 100_000, "no time recorded: the track's length");
  assert.equal(counts.get(uri(2)).plays, 1);
  assert.equal(counts.get(uri(2)).ms, 170_000);
  const [track] = await store.musicTracks([uri(2)]);
  assert.equal(track.info.image, "https://i.scdn.co/image/abc");
  const artists = await history.artists(["x"]);
  assert.deepEqual(artists.get("x").genres, ["house"]);
  assert.equal(artists.get("x").image, "", "only Spotify's image host is kept");
  const line = await history.timeline({ unit: "month", timeZone: "UTC" });
  assert.equal(line.reduce((sum, row) => sum + row.plays, 0), 2);
});
