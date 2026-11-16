import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileHistory } from "../server/music/history.js";
import { createMusicEngine } from "../server/music/engine.js";
import { createMusicApi } from "../server/music/routes.js";
import { DAY_MS } from "../server/music/rank.js";
import { MemoryStore } from "../server/cloud/store.js";
import { createCloudHistory } from "../server/cloud/music.js";
import { removeTempDir } from "./helpers.js";

const uri = (n) => `spotify:track:${String(n).padStart(22, "0")}`;
const day = (n) => Date.UTC(2026, 0, 1) + n * DAY_MS;
const MIN = 60_000;

const TRACKS = {
  [uri(1)]: { name: "Glow", artists: ["The Lanterns"] },
  [uri(2)]: { name: "Ember", artists: ["The Lanterns"] },
  [uri(3)]: { name: "Tide", artists: ["Harbor Lights", "The Lanterns"] }, // The Lanterns only featured
  [uri(4)]: { name: "Glow - 2024 Remaster", artists: ["The Lanterns"] }
};
// Day 0 is before the period used below; days 10 to 19 are inside it.
const PLAYS = [
  { ms: day(0), ref: uri(1), heard: 3 * MIN },
  { ms: day(10), ref: uri(1), heard: 3 * MIN },
  { ms: day(11), ref: uri(2), heard: 4 * MIN },
  { ms: day(11) + 1000, ref: uri(1), heard: 3 * MIN },
  { ms: day(12), ref: uri(3), heard: 20 * MIN },
  { ms: day(18), ref: uri(4), heard: 2 * MIN }
];

function engineOver(history) {
  return createMusicEngine({ history, spotify: async () => null, loadPlan: async () => ({}), updatePlan: async () => {}, clock: () => day(20), timeZone: "UTC" });
}

async function fileHistory(t) {
  const root = await mkdtemp(join(tmpdir(), "jarvis-music-artist-"));
  t.after(() => removeTempDir(root));
  const history = createFileHistory(() => root);
  await history.addPlays(PLAYS, TRACKS);
  await history.saveEnrichment({ artists: { lanterns: { checkedAt: 1, genres: ["indie pop"] } } });
  return history;
}

async function cloudHistory() {
  const store = new MemoryStore();
  const history = createCloudHistory(store);
  await history.addPlays(PLAYS.map((play) => ({ ...play, src: "l" })), TRACKS);
  await history.saveEnrichment({ artists: { lanterns: { checkedAt: 1, genres: ["indie pop"] } } });
  return history;
}

function checkLanterns(stats) {
  assert.equal(stats.key, "lanterns");
  assert.equal(stats.name, "The Lanterns");
  assert.deepEqual(stats.genres, ["indie pop"]);
  // Featured on "Tide" earns nothing; the lead artist gets those minutes.
  assert.equal(stats.plays, 4);
  assert.equal(stats.ms, 12 * MIN);
  assert.equal(stats.rank, 2, "Harbor Lights has more minutes in the period");
  assert.equal(stats.artistCount, 2);
  assert.equal(Math.round(stats.share * 1000), Math.round((12 / 32) * 1000));
  assert.equal(stats.first, day(10));
  assert.equal(stats.last, day(18));
  assert.equal(stats.firstEver, day(0), "first ever looks past the selected period");
  assert.deepEqual(stats.songs.map((song) => [song.title, song.plays]), [["Glow", 3], ["Ember", 1]], "a remaster merges into its song");
  assert.equal(stats.songCount, 2);
  assert.equal(stats.timeline.unit, "day");
  assert.equal(stats.timeline.buckets.length, 11);
  assert.equal(stats.timeline.buckets.reduce((sum, row) => sum + row.ms, 0), 12 * MIN);
  assert.equal(stats.timeline.buckets[2].ms, 7 * MIN);
}

test("artist stats: totals, rank, songs, first and last, and listening over time", async (t) => {
  const engine = engineOver(await fileHistory(t));
  checkLanterns(await engine.artist({ key: "lanterns", from: day(9) + 1, to: day(19) + 1, timeZone: "UTC" }));
});

test("artist stats: the cloud history gives the same answer", async () => {
  const engine = engineOver(await cloudHistory());
  checkLanterns(await engine.artist({ key: "lanterns", from: day(9) + 1, to: day(19) + 1, timeZone: "UTC" }));
});

test("artist stats: no plays in the period still reports the artist; unknown artists are a 404", async (t) => {
  const engine = engineOver(await fileHistory(t));
  const quiet = await engine.artist({ key: "lanterns", from: day(1), to: day(5), timeZone: "UTC" });
  assert.equal(quiet.plays, 0);
  assert.equal(quiet.rank, null);
  assert.equal(quiet.name, "The Lanterns");
  assert.equal(quiet.firstEver, day(0));
  await assert.rejects(engine.artist({ key: "nobody", windowDays: null }), (error) => error.status === 404);
});

test("songs and recent plays carry their lead artist's key", async (t) => {
  const engine = engineOver(await fileHistory(t));
  const top = await engine.top({ windowDays: null });
  assert.equal(top.tracks.find((song) => song.title === "Tide").artistKey, "harbor lights");
  const recent = await engine.recent(10);
  assert.equal(recent[0].artistKey, "lanterns");
});

test("artist route validates its key and passes the period through", async (t) => {
  const engine = engineOver(await fileHistory(t));
  const api = createMusicApi({ engine, status: async () => ({}), sendJson: (res, body, status = 200) => Object.assign(res, { body, status }), timeZone: "UTC" });
  const call = async (query) => {
    const res = {};
    await api.handle({ method: "GET", headers: { host: "127.0.0.1" } }, res, new URL(`http://127.0.0.1/api/music/artist?${query}`));
    return res;
  };
  assert.equal((await call("")).status, 400);
  assert.equal((await call(`key=${"x".repeat(201)}`)).status, 400);
  assert.equal((await call("key=nobody&days=all")).status, 404);
  const ok = await call(`key=lanterns&from=${day(9) + 1}&to=${day(19) + 1}&tz=UTC`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  checkLanterns(ok.body);
});
