import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileHistory } from "../server/music/history.js";
import { createMusicEngine } from "../server/music/engine.js";
import { createEnricher } from "../server/music/enrich.js";
import { createLookupBudget, pausesFrom, SYNC_QUIET_MS } from "../server/music/limits.js";
import { saveRule, playlistState } from "../server/music/rules.js";
import { ensurePlanState } from "../server/plan/state.js";
import { createSpotifyApi } from "../server/spotify.js";
import { createFakeSpotify, fakeTrack, FAKE_AUTH, FAKE_SCOPES } from "./fake-spotify.js";
import { removeTempDir } from "./helpers.js";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Plays of artists nobody has looked up yet, so lookups have work to do, and
// one synced playlist rule.
async function setup(t, { lookupsPerHour } = {}) {
  const root = await mkdtemp(join(tmpdir(), "jarvis-priority-"));
  t.after(() => removeTempDir(root));
  const history = createFileHistory(() => root);
  const tracks = Array.from({ length: 6 }, (_, i) => fakeTrack(i + 1, `Song ${i + 1}`, [`Artist ${i + 1}`]));
  const fake = createFakeSpotify({ tracks, scopes: FAKE_SCOPES });
  let auth = { ...FAKE_AUTH, scopes: FAKE_SCOPES };
  const api = createSpotifyApi({ loadAuth: async () => auth, saveAuth: async (next) => { auth = next; }, fetch: fake.fetch });
  const rows = tracks.map((track, i) => ({ ms: NOW - (i + 1) * HOUR, ref: track.uri }));
  const catalog = Object.fromEntries(tracks.map((track) => [track.uri, { name: track.name, artists: track.artists.map((artist) => artist.name), album: track.album.name }]));
  await history.addPlays(rows, catalog);
  let plan = saveRule(ensurePlanState({}), { name: "Week", topK: 5, windowDays: 7, synced: true, intervalHours: 24 }, new Date(NOW - DAY).toISOString()).plan;
  const clock = { now: NOW };
  const engine = createMusicEngine({
    history,
    spotify: async () => ({ api }),
    loadPlan: async () => plan,
    updatePlan: async (work) => { plan = work(plan); },
    clock: () => clock.now,
    enrichGapMs: 0,
    ...(lookupsPerHour ? { lookupsPerHour } : {})
  });
  return { history, fake, engine, clock, rule: () => plan.musicPlaylists[0], state: () => playlistState(plan, plan.musicPlaylists[0].id) };
}

test("a rate limit earned by lookups holds lookups for hours but lets syncs go when Spotify allows", async (t) => {
  const { fake, engine, clock, state } = await setup(t);
  fake.state.failNext = { match: /./, status: 429, headers: { "retry-after": "120" } };
  const limited = await engine.enrich();
  assert.equal(limited.paused, true);

  // Spotify's two minutes are up: a sync goes ahead.
  clock.now = NOW + 3 * 60_000;
  const synced = await engine.syncDue();
  assert.equal(synced.length, 1);
  assert.equal(state().lastResult.ok, true);

  // Lookups still wait, for six hours.
  const before = fake.state.calls.length;
  assert.equal((await engine.enrich()).paused, true);
  assert.equal(fake.state.calls.length, before, "no lookups while they're held back");
  assert.ok((await engine.lookups()).pausedUntil, "the Setup tab can say why");
  clock.now = NOW + 6 * HOUR + 1;
  assert.notEqual((await engine.enrich()).paused, true);
  assert.ok(fake.state.calls.length > before);
});

test("lookups stop at their hourly share and carry on the next hour", async (t) => {
  const { fake, engine, clock } = await setup(t, { lookupsPerHour: 3 });
  const first = await engine.enrich();
  assert.equal(first.held, "budget");
  assert.equal(fake.state.calls.length, 3);
  assert.equal((await engine.enrich()).held, "budget", "still the same hour");
  assert.equal(fake.state.calls.length, 3);
  clock.now = NOW + HOUR + 1;
  await engine.enrich();
  assert.equal(fake.state.calls.length, 6);
});

test("no lookups start shortly before a playlist is due", async (t) => {
  const { fake, engine, clock } = await setup(t);
  await engine.syncDue();
  const afterSync = fake.state.calls.length;
  clock.now = NOW + DAY - SYNC_QUIET_MS / 2;
  assert.equal((await engine.enrich()).held, "sync-soon");
  assert.equal(fake.state.calls.length, afterSync);
  assert.equal((await engine.lookups()).hold.reason, "sync-soon");
  clock.now = NOW + HOUR;
  assert.notEqual((await engine.enrich()).held, "sync-soon");
  assert.ok(fake.state.calls.length > afterSync);
});

test("a sync waiting for Spotify stops lookups before their next request", async () => {
  const counts = new Map([["spotify:track:a", { plays: 1, ms: 1000 }], ["spotify:track:b", { plays: 1, ms: 900 }]]);
  const catalog = new Map([["spotify:track:a", { name: "A", artists: ["One"] }], ["spotify:track:b", { name: "B", artists: ["Two"] }]]);
  const history = {
    async counts() { return counts; },
    async catalog() { return catalog; },
    async artists() { return new Map(); },
    async enrichState() { return {}; },
    async saveEnrichment() {}
  };
  let calls = 0;
  const api = { json: async (path) => { calls += 1; return path.startsWith("/tracks/") ? { duration_ms: 1, artists: [{ id: "x", name: "One" }], album: { images: [] } } : { id: "x", name: "One", genres: [], images: [] }; } };
  const report = await createEnricher({ api, history, gapMs: 0, yieldTo: () => calls >= 1 }).run();
  assert.equal(report.held, "sync");
  assert.equal(calls, 1, "one request, then it gives way");
});

test("a pause saved by an older version holds back syncs and lookups alike", () => {
  assert.deepEqual(pausesFrom({ pausedUntil: 500 }), { spotify: 500, lookups: 500 });
  assert.deepEqual(pausesFrom({ spotifyPausedUntil: 100, lookupsPausedUntil: 900 }), { spotify: 100, lookups: 900 });
  assert.deepEqual(pausesFrom({}), { spotify: 0, lookups: 0 });
  let now = 0;
  const budget = createLookupBudget({ perHour: 2, clock: () => now });
  assert.equal(budget.take(), true);
  assert.equal(budget.take(), true);
  assert.equal(budget.take(), false);
  now = HOUR + 1;
  assert.equal(budget.left(), 2);
});
