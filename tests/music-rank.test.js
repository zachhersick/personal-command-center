import test from "node:test";
import assert from "node:assert/strict";
import { DAY_MS, rankArtists, rankSongs, windowRange } from "../server/music/rank.js";
import { deleteRule, isDue, normalizeRule, playlistRules, saveRule, withRunState } from "../server/music/rules.js";
import { ensurePlanState, mergePlanState } from "../server/plan/state.js";

const id = (n) => `spotify:track:${String(n).padStart(22, "0")}`;

test("versions of one song add up and the most played version leads", () => {
  const catalog = new Map([
    [id(1), { name: "Dreams", artists: ["Fleetwood Mac"], album: "Rumours" }],
    [id(2), { name: "Dreams - 2004 Remaster", artists: ["Fleetwood Mac"], album: "Rumours (Super Deluxe)" }],
    [id(3), { name: "Dreams - Live", artists: ["Fleetwood Mac"] }],
    [id(4), { name: "Landslide", artists: ["Fleetwood Mac"] }]
  ]);
  const counts = new Map([
    [id(1), { plays: 3, last: 100 }],
    [id(2), { plays: 5, last: 90 }],
    [id(3), { plays: 6, last: 80 }],
    [id(4), { plays: 7, last: 70 }]
  ]);
  const songs = rankSongs(counts, catalog);
  assert.deepEqual(songs.map((song) => [song.title, song.plays]), [["Dreams - 2004 Remaster", 8], ["Landslide", 7], ["Dreams - Live", 6]]);
  assert.deepEqual(songs[0].versions.map((version) => version.ref), [id(2), id(1)], "the remaster is played more, so it is tried first");
  assert.equal(songs[0].last, 100);
});

test("ties go to the song played most recently", () => {
  const catalog = new Map([[id(1), { name: "A", artists: ["X"] }], [id(2), { name: "B", artists: ["X"] }]]);
  const songs = rankSongs(new Map([[id(1), { plays: 4, last: 10 }], [id(2), { plays: 4, last: 20 }]]), catalog);
  assert.deepEqual(songs.map((song) => song.title), ["B", "A"]);
});

test("Apple and Spotify plays of one song combine", () => {
  const catalog = new Map([
    ["apple:123", { name: "Dreams (2004 Remaster)", artist: "Fleetwood Mac" }],
    [id(1), { name: "Dreams", artists: ["Fleetwood Mac"] }]
  ]);
  const songs = rankSongs(new Map([["apple:123", { plays: 40, last: 5 }], [id(1), { plays: 2, last: 9 }]]), catalog);
  assert.equal(songs.length, 1);
  assert.equal(songs[0].plays, 42);
  assert.deepEqual(songs[0].versions.map((version) => version.ref), ["apple:123", id(1)]);
});

test("artists rank by plays across collaborators", () => {
  const catalog = new Map([
    [id(1), { name: "A", artists: ["Drake", "Future"] }],
    [id(2), { name: "B", artists: ["Future"] }],
    ["apple:9", { name: "C", artist: "Drake & 21 Savage" }]
  ]);
  const artists = rankArtists(new Map([[id(1), { plays: 2, last: 1 }], [id(2), { plays: 3, last: 2 }], ["apple:9", { plays: 2, last: 3 }]]), catalog);
  assert.deepEqual(artists.map((artist) => [artist.name, artist.plays]), [["Drake", 4], ["Future", 3]]);
});

test("rolling windows end now and all time has no start", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  assert.deepEqual(windowRange(7, now), { from: now - 7 * DAY_MS, to: now });
  assert.deepEqual(windowRange(null, "2026-11-09T12:00:00Z"), { from: null, to: now });
});

test("rules are validated and saved as plan records", () => {
  const now = "2026-11-09T12:00:00.000Z";
  assert.throws(() => normalizeRule({ name: "", topK: 10, windowDays: 7 }), /name/);
  assert.throws(() => normalizeRule({ name: "x", topK: 0, windowDays: 7 }), /track count/);
  assert.throws(() => normalizeRule({ name: "x", topK: 501, windowDays: 7 }), /track count/);
  assert.throws(() => normalizeRule({ name: "x", topK: 5, windowDays: 2.5 }), /period/);
  assert.throws(() => normalizeRule({ name: "x", topK: 5, windowDays: 7, intervalHours: 0 }), /interval/);
  const allTime = normalizeRule({ name: "All", topK: 100, windowDays: null, synced: true, intervalHours: 168 }, null, now);
  assert.equal(allTime.windowDays, null);
  assert.equal(allTime.synced, true);

  let plan = ensurePlanState({});
  const created = saveRule(plan, { name: "Top 50 of the week", topK: 50, windowDays: 7, synced: true, intervalHours: 24 }, now);
  plan = created.plan;
  const ruleId = created.result.rule.id;
  plan = saveRule(plan, { id: ruleId, topK: 25 }, "2026-11-09T13:00:00.000Z").plan;
  assert.equal(playlistRules(plan)[0].topK, 25);
  assert.equal(playlistRules(plan)[0].name, "Top 50 of the week");
  plan = deleteRule(plan, ruleId, "2026-11-09T14:00:00.000Z").plan;
  assert.equal(playlistRules(plan).length, 0);
  assert.throws(() => saveRule(plan, { id: ruleId, topK: 5 }, now), /no longer exists/);
});

test("a rule edit and a sync result from two devices both survive the merge", () => {
  const rule = normalizeRule({ name: "Week", topK: 50, windowDays: 7, synced: true, intervalHours: 24 }, null, "2026-11-01T00:00:00.000Z");
  const base = ensurePlanState({ musicPlaylists: [rule] });
  const phone = saveRule(base, { id: rule.id, topK: 30 }, "2026-11-02T10:00:00.000Z").plan;
  const desktop = withRunState(base, rule.id, { spotifyPlaylistId: "pl1", lastSyncedAt: "2026-11-02T10:05:00.000Z" }, "2026-11-02T10:05:00.000Z");
  const merged = mergePlanState(desktop, phone);
  assert.equal(merged.musicPlaylists[0].topK, 30);
  assert.equal(merged.musicPlaylistState[0].spotifyPlaylistId, "pl1");
  const older = ensurePlanState({});
  assert.deepEqual(mergePlanState(older, merged).musicPlaylists.map((entry) => entry.topK), [30], "a plan without music fields keeps working");
});

test("sync schedule", () => {
  const hour = 3_600_000;
  const day = 24 * hour;
  const t0 = Date.parse("2026-11-01T10:00:00Z");
  const iso = (ms) => new Date(ms).toISOString();
  const rule = { id: "r", name: "x", topK: 5, windowDays: 7, synced: true, intervalHours: 24, updatedAt: iso(t0 - day) };
  assert.equal(isDue(rule, null, t0), true, "never built");
  const state = { lastSyncedAt: iso(t0), lastAttemptAt: iso(t0), lastResult: { ok: true } };
  assert.equal(isDue(rule, state, t0 + 23 * hour), false);
  assert.equal(isDue(rule, state, t0 + day - 10 * 60_000), true, "an hourly tick a few minutes early still counts");
  assert.equal(isDue(rule, state, t0 + day - 20 * 60_000), false);
  assert.equal(isDue(rule, state, t0 + 3 * day), true);
  assert.equal(isDue({ ...rule, updatedAt: iso(t0 + hour) }, state, t0 + 2 * hour), true, "an edit rebuilds at the next check");
  assert.equal(isDue({ ...rule, synced: false }, state, t0 + 30 * day), false, "an unsynced playlist is built once");
  assert.equal(isDue({ ...rule, intervalHours: 1 }, state, t0 + 57 * 60_000), true, "slack is 5% of short intervals");
  assert.equal(isDue({ ...rule, intervalHours: 1 }, state, t0 + 56 * 60_000), false);
  const failed = { ...state, lastAttemptAt: iso(t0 + 2 * day), lastResult: { ok: false, error: "boom" } };
  assert.equal(isDue(rule, failed, t0 + 2 * day + 30 * 60_000), false, "waits an hour after an error");
  assert.equal(isDue(rule, failed, t0 + 2 * day + hour), true);
  assert.equal(isDue(rule, { ...failed, lastResult: { ok: false, retrySoon: true } }, t0 + 2 * day + 60_000), true, "an unfinished build continues at the next check");
  assert.equal(isDue({ ...rule, deleted: true }, null, t0), false);
});
