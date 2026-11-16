import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importFolder, parseCsv } from "../server/music/importers.js";
import { createFileHistory } from "../server/music/history.js";
import { pollRecentlyPlayed } from "../server/music/tracker.js";
import { createSpotifyApi } from "../server/spotify.js";
import { createFakeSpotify, fakeTrack, FAKE_AUTH } from "./fake-spotify.js";
import { removeTempDir } from "./helpers.js";

const uri = (n) => `spotify:track:${String(n).padStart(22, "0")}`;
const stream = (ts, n, ms, extra = {}) => ({
  ts, platform: "ios", ms_played: ms, conn_country: "US",
  master_metadata_track_name: `Song ${n}`, master_metadata_album_artist_name: "Artist", master_metadata_album_album_name: "Album",
  spotify_track_uri: uri(n), episode_name: null, spotify_episode_uri: null, reason_start: "trackdone", reason_end: "trackdone",
  shuffle: false, skipped: false, offline: false, offline_timestamp: null, incognito_mode: false, ...extra
});

async function exportFolder(root) {
  const spotifyDir = join(root, "my_spotify_data", "Spotify Extended Streaming History");
  const appleDir = join(root, "Apple Music Activity", "Apple Music Activity");
  await mkdir(spotifyDir, { recursive: true });
  await mkdir(appleDir, { recursive: true });
  await mkdir(join(root, "Apple Music Activity", "__MACOSX"), { recursive: true });
  await writeFile(join(spotifyDir, "Streaming_History_Audio_2025.json"), JSON.stringify([
    stream("2025-03-01T10:00:00Z", 1, 200000),
    stream("2025-03-01T10:04:00Z", 1, 30000),
    stream("2025-03-01T10:05:00Z", 2, 29999),
    stream("2025-03-01T10:06:00Z", 3, 5000, { skipped: true }),
    stream("2025-03-01T10:07:00Z", 0, 1800000, { spotify_track_uri: null, master_metadata_track_name: null, episode_name: "Podcast", spotify_episode_uri: "spotify:episode:abc" }),
    stream("2025-03-01T10:40:00Z", 0, 60000, { spotify_track_uri: "spotify:local:Artist:Album:Song:200" })
  ]));
  await writeFile(join(spotifyDir, "Streaming_History_Audio_2026.json"), JSON.stringify([stream("2026-01-02T00:00:00Z", 2, 120000)]));
  await writeFile(join(spotifyDir, "Streaming_History_Video_2026.json"), JSON.stringify([stream("2026-01-03T00:00:00Z", 9, 120000)]));
  await writeFile(join(appleDir, "Apple Music - Play History Daily Tracks.csv"), [
    "Country,\"Track Identifier\",\"Media type\",\"Date Played\",Hours,\"Play Duration Milliseconds\",\"End Reason Type\",\"Source Type\",\"Play Count\",\"Skip Count\",\"Ignore For Recommendations\",\"Track Reference\",\"Track Description\"",
    "United States,1440857781,AUDIO,20190315,\"9, 14\",412000,NATURAL_END_OF_TRACK,IPHONE,2,0,false,1440857781,\"Fleetwood Mac - Dreams (2004 Remaster)\"",
    "United States,1440857782,AUDIO,20190315,9,0,TRACK_SKIPPED_FORWARDS,IPHONE,0,1,false,1440857782,\"Fleetwood Mac - Skipped\"",
    "United States,1440857783,VIDEO,20190316,9,200000,NATURAL_END_OF_TRACK,IPHONE,1,0,false,1440857783,\"Someone - A Video\"",
    "United States,1440857784,AUDIO,20220830,23,200000,NATURAL_END_OF_TRACK,\"IPHONE, WINDOWS\",1,0,false,a/b,\"AC/DC - Back In Black, Live\""
  ].join("\r\n"));
  return root;
}

test("imports Spotify and Apple exports in place with the 30-second rule", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-music-import-"));
  t.after(() => removeTempDir(root));
  const parsed = await importFolder(await exportFolder(join(root, "exports")));

  assert.equal(parsed.spotify.files, 2, "video history isn't read");
  assert.deepEqual(parsed.spotify.plays.length, 3, "a play is 30s or more; skips, podcasts and local files don't count");
  assert.deepEqual(parsed.spotify.tracks.map((track) => track[0]), [uri(1), uri(2)]);
  assert.equal(parsed.spotify.short, 2);
  assert.equal(parsed.spotify.other, 2);
  assert.equal(parsed.spotify.from, Date.parse("2025-03-01T10:00:00Z"));
  assert.equal(parsed.spotify.to, Date.parse("2026-01-02T00:00:00Z"));

  assert.equal(parsed.apple.plays.length, 3, "two plays of Dreams and one of Back In Black; skips and videos dropped");
  assert.deepEqual(parsed.apple.tracks.map((track) => track.slice(0, 3)), [
    ["apple:1440857781", "Dreams (2004 Remaster)", "Fleetwood Mac"],
    ["apple:1440857784", "Back In Black, Live", "AC/DC"]
  ]);
  assert.deepEqual(parsed.apple.plays.slice(0, 2).map(([sec]) => new Date(sec * 1000).toISOString()), ["2019-03-15T09:00:00.000Z", "2019-03-15T14:00:01.000Z"], "plays land on the hours Apple lists");
});

test("a fresh Spotify export replaces polled plays it covers, and re-importing doesn't double count", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-music-import-"));
  t.after(() => removeTempDir(root));
  const history = createFileHistory(() => root);
  const inside = Date.parse("2025-06-01T00:00:00Z");
  const after = Date.parse("2026-02-01T00:00:00Z");
  await history.addPlays([{ ms: inside, ref: uri(1) }, { ms: after, ref: uri(1) }, { ms: after, ref: uri(1) }]);
  assert.equal((await history.counts()).get(uri(1)).plays, 2, "the same play polled twice is kept once");

  const parsed = await importFolder(await exportFolder(join(root, "exports")));
  for (let i = 0; i < 2; i += 1) {
    await history.setExport("spotify", parsed.spotify);
    await history.setExport("apple", parsed.apple);
  }
  const counts = await history.counts();
  assert.equal(counts.get(uri(1)).plays, 3, "2 from the export, the polled one inside its range is dropped, the later one stays");
  assert.equal(counts.get("apple:1440857781").plays, 2);
  await history.addPlays([{ ms: inside + 1000, ref: uri(5) }]);
  assert.equal((await history.counts()).get(uri(5)), undefined, "a late poll inside the export's range is ignored");
  const summary = await history.summary();
  assert.equal(summary.plays, 3 + 1 + 3);
  assert.equal(summary.first, "2019-03-15T09:00:00.000Z");

  const reloaded = createFileHistory(() => root);
  assert.equal((await reloaded.counts()).get(uri(1)).plays, 3, "everything is persisted");
});

test("rejects a folder with no exports", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-music-import-"));
  t.after(() => removeTempDir(root));
  await assert.rejects(importFolder(root), /No Spotify/);
  await assert.rejects(importFolder(join(root, "missing")), /folder that exists/);
});

test("CSV parsing handles quotes, commas and CRLF", () => {
  assert.deepEqual(parseCsv("a,\"b, c\",\"d \"\"e\"\"\"\r\n1,2,3\r\n"), [["a", "b, c", "d \"e\""], ["1", "2", "3"]]);
});

test("polling records new plays, keeps a cursor, and reports a gap when 50 new plays arrive at once", async () => {
  const tracks = [fakeTrack(1, "One"), fakeTrack(2, "Two")];
  const fake = createFakeSpotify({ tracks });
  let auth = { ...FAKE_AUTH };
  const api = createSpotifyApi({ loadAuth: async () => auth, saveAuth: async (next) => { auth = next; }, fetch: fake.fetch });
  const at = (minute) => new Date(Date.parse("2026-11-09T10:00:00Z") + minute * 60_000).toISOString();
  fake.state.recent.push({ played_at: at(0), track: tracks[0] }, { played_at: at(4), track: tracks[1] }, { played_at: at(5), track: { ...tracks[0], uri: "spotify:local:x", is_local: true } });
  const first = await pollRecentlyPlayed(api, {});
  assert.deepEqual(first.plays.map((play) => play.ref), [tracks[1].uri, tracks[0].uri]);
  assert.equal(first.gap, null);
  assert.deepEqual(first.tracks[tracks[0].uri].artists, ["Artist"]);

  fake.state.recent.push({ played_at: at(8), track: tracks[0] });
  const second = await pollRecentlyPlayed(api, { cursorMs: first.cursorMs });
  assert.deepEqual(second.plays.map((play) => play.ms), [Date.parse(at(8))], "only plays after the cursor");

  for (let i = 0; i < 50; i += 1) fake.state.recent.push({ played_at: at(100 + i * 4), track: tracks[i % 2] });
  const third = await pollRecentlyPlayed(api, { cursorMs: second.cursorMs });
  assert.equal(third.plays.length, 50);
  assert.deepEqual(third.gap, { from: at(8), to: at(100) });
});
