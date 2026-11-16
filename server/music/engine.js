// The music work both the desktop and the cloud do: record plays, rank, and
// build or sync playlists. Storage, the Spotify token store and the plan are
// injected, so the same code runs over local files or the cloud database.
import { createEnricher } from "./enrich.js";
import { buildPlaylist, OutOfTime, syncPlaylist } from "./playlists.js";
import { selectPlays } from "./query.js";
import { fillTimeline, isSpotifyTrack, leadArtist, localDay, rankArtists, rankGenres, rankSongs, timelineUnit } from "./rank.js";
import { createResolver } from "./resolver.js";
import { isDue, nextSyncAt, normalizeRule, playlistRules, playlistState, withRunState } from "./rules.js";
import { createLookupBudget, LOOKUPS_PER_HOUR, pausesAfterLimit, pausesFrom, SYNC_QUIET_MS } from "./limits.js";
import { pollRecentlyPlayed } from "./tracker.js";
import { httpError } from "../http.js";

const ART_FOR_TOP = 50;
// Background lookups share Spotify's per-app rate limit with playlist syncs
// (and with the cloud, which uses the same app). At about one a second
// Spotify answered with an 11-hour Retry-After, so they go slowly, and
// limits.js keeps them out of the way of syncs.
export const LOOKUP_GAP_MS = 6000;

// spotify(): { api, auth } when connected with the music scopes, else null.
// updatePlan(work): runs work(plan) -> plan inside the plan mutation queue.
export function createMusicEngine({ history, spotify, loadPlan, updatePlan, clock = () => Date.now(), enrichGapMs = LOOKUP_GAP_MS, genreSource = () => null, timeZone = "UTC", sleep, lookupsPerHour = LOOKUPS_PER_HOUR } = {}) {
  let syncing = null;
  const budget = createLookupBudget({ perHour: lookupsPerHour, clock });
  // Why the last lookup run stopped early, for the Setup tab.
  let lookupHold = null;
  // Tracks shown without artwork; the next lookup run fetches them first.
  const wanted = new Set();

  async function resolverFor(api) {
    return createResolver({ api, loadCache: () => history.readResolveCache(), saveCache: (value) => history.writeResolveCache(value), now: clock });
  }

  async function poll() {
    const connection = await spotify();
    if (!connection) return { polled: false, added: 0 };
    const live = await history.liveState();
    try {
      const result = await pollRecentlyPlayed(connection.api, { cursorMs: live.cursorMs ?? null });
      const added = await history.addPlays(result.plays.map((play) => ({ ...play, heard: result.tracks[play.ref]?.durationMs || 0, src: connection.source || "l" })), result.tracks);
      await history.updateLive({ cursorMs: result.cursorMs, lastPollAt: new Date(clock()).toISOString(), lastError: "", ...(result.gap ? { gap: { ...result.gap, foundAt: new Date(clock()).toISOString() } } : {}) });
      return { polled: true, added, gap: result.gap };
    } catch (error) {
      await history.updateLive({ lastError: error.message, lastPollAt: new Date(clock()).toISOString() });
      throw error;
    }
  }

  // period: { windowDays } or { from, to } in ms, and an optional genre.
  async function top({ windowDays = 30, from = null, to = null, genre = "", limit = 50 } = {}) {
    const { range, all, counts, catalog, artists } = await selectPlays(history, { windowDays, from, to, genre }, clock());
    let plays = 0;
    let ms = 0;
    let untimed = 0;
    for (const entry of counts.values()) {
      plays += entry.plays;
      ms += entry.ms;
      untimed += entry.untimed || 0;
    }
    const songs = rankSongs(counts, catalog);
    const ranked = rankArtists(counts, catalog, artists);
    const genres = rankGenres(genre ? counts : all, catalog, artists);
    for (const song of songs.slice(0, ART_FOR_TOP)) {
      if (song.image) continue;
      const version = song.versions.find((entry) => isSpotifyTrack(entry.ref));
      if (version) wanted.add(version.ref);
    }
    return {
      windowDays: range.from === null ? null : windowDays,
      from: range.from,
      to: range.to,
      genre,
      plays,
      ms,
      untimed,
      songs: songs.length,
      artistCount: ranked.length,
      tracks: songs.slice(0, limit).map(({ versions, ...song }) => ({ ...song, versions: versions.length })),
      artists: ranked.slice(0, limit),
      genres: genres.genres.slice(0, limit),
      genresKnown: genres.known
    };
  }

  async function timeline({ windowDays = 30, from = null, to = null, genre = "", timeZone: zone = timeZone } = {}) {
    const { range, counts } = await selectPlays(history, { windowDays, from, to, genre }, clock());
    const summary = await history.summary();
    const start = range.from ?? (summary.first ? Date.parse(summary.first) : range.to);
    const unit = timelineUnit(start, range.to);
    const rows = await history.timeline({ from: range.from, to: range.to, unit, timeZone: zone, refs: genre ? new Set(counts.keys()) : null });
    const days = new Map();
    return { unit, buckets: fillTimeline(rows, { firstDay: localDay(start, zone, days), lastDay: localDay(range.to, zone, days), unit }) };
  }

  // One artist's listening in a period. Like the rankings, a track counts
  // toward its lead artist only, so rank and minutes agree with Top artists.
  // The genre filter doesn't apply here: an artist view is about that artist.
  async function artist({ key, windowDays = 30, from = null, to = null, timeZone: zone = timeZone, limit = 10 } = {}) {
    const ever = await selectPlays(history, { windowDays: null }, clock());
    const own = (counts, catalog) => new Map([...counts].filter(([ref]) => leadArtist(catalog.get(ref)).key === key));
    const everOwn = own(ever.all, ever.catalog);
    if (!everOwn.size) throw httpError(404, "No plays by that artist.");
    const { range, all, catalog, artists } = await selectPlays(history, { windowDays, from, to }, clock());
    const mine = own(all, catalog);
    const ranked = rankArtists(all, catalog, artists);
    const index = ranked.findIndex((entry) => entry.key === key);
    const named = index >= 0 ? ranked[index] : rankArtists(everOwn, ever.catalog, ever.artists)[0];
    let plays = 0;
    let ms = 0;
    let total = 0;
    let first = null;
    let last = null;
    for (const entry of all.values()) total += entry.ms;
    for (const entry of mine.values()) {
      plays += entry.plays;
      ms += entry.ms;
      const start = entry.first ?? entry.last;
      if (first === null || start < first) first = start;
      if (last === null || entry.last > last) last = entry.last;
    }
    let firstEver = null;
    for (const entry of everOwn.values()) {
      const start = entry.first ?? entry.last;
      if (firstEver === null || start < firstEver) firstEver = start;
    }
    const songs = rankSongs(mine, catalog);
    const start = range.from ?? firstEver;
    const unit = timelineUnit(start, range.to);
    const rows = mine.size ? await history.timeline({ from: range.from, to: range.to, unit, timeZone: zone, refs: new Set(mine.keys()) }) : [];
    const days = new Map();
    return {
      key,
      name: named.name,
      image: named.image || ever.artists.get(key)?.image || "",
      genres: named.genres?.length ? named.genres : ever.artists.get(key)?.genres || [],
      windowDays: range.from === null ? null : windowDays,
      from: range.from,
      to: range.to,
      plays,
      ms,
      share: total ? ms / total : 0,
      rank: index >= 0 ? index + 1 : null,
      artistCount: ranked.length,
      first,
      last,
      firstEver,
      songCount: songs.length,
      songs: songs.slice(0, limit).map(({ versions, ...song }) => ({ ...song, versions: versions.length })),
      timeline: { unit, buckets: fillTimeline(rows, { firstDay: localDay(start, zone, days), lastDay: localDay(range.to, zone, days), unit }) }
    };
  }

  // A playlist due to sync soon; lookups leave Spotify alone until it has.
  async function syncSoon() {
    const plan = await loadPlan();
    const now = clock();
    return playlistRules(plan).some((rule) => {
      const next = Date.parse(nextSyncAt(rule, playlistState(plan, rule.id)) || "") || 0;
      return next > now && next - now <= SYNC_QUIET_MS;
    });
  }

  async function enrich({ deadline = Infinity, from = null } = {}) {
    const connection = await spotify();
    if (!connection) return { skipped: true };
    if (syncing) return note({ held: "sync" });
    if (await syncSoon()) return note({ held: "sync-soon" });
    const gapMs = typeof enrichGapMs === "function" ? enrichGapMs() : enrichGapMs;
    const report = await createEnricher({ api: connection.api, history, clock, gapMs, wanted, genreSource: genreSource(), budget, yieldTo: () => Boolean(syncing), ...(sleep ? { sleep } : {}) }).run({ deadline, from });
    return note(report);
  }

  function note(report) {
    lookupHold = report.held || report.paused ? { reason: report.paused ? "limited" : report.held, at: new Date(clock()).toISOString(), until: report.pausedUntil ? new Date(report.pausedUntil).toISOString() : null } : null;
    return report;
  }

  async function syncOne(rule, { deadline = Infinity } = {}) {
    const connection = await spotify();
    if (!connection) throw httpError(409, "Connect Spotify with playlist access first.");
    const plan = await loadPlan();
    const state = playlistState(plan, rule.id);
    // While Spotify has asked Jarvis to wait, asking again only extends it.
    // Only Spotify's own wait counts here; lookups' longer one doesn't.
    const pauseState = await history.enrichState();
    const pausedUntil = pausesFrom(pauseState).spotify;
    if (pausedUntil > clock()) {
      const at = new Date(clock()).toISOString();
      const patch = { lastAttemptAt: at, lastResult: limited(at, pausedUntil) };
      await updatePlan((current) => withRunState(current, rule.id, patch, at));
      return patch;
    }
    const resolver = await resolverFor(connection.api);
    let patch;
    try {
      patch = await syncPlaylist(rule, state, { api: connection.api, history, resolver, now: clock(), deadline, clock });
    } catch (error) {
      const at = new Date(clock()).toISOString();
      if (error.status === 429) {
        const pauses = pausesAfterLimit(error.retryAfterMs, clock(), pauseState);
        await history.saveEnrichment(pauses).catch(() => {});
        patch = { lastAttemptAt: at, lastResult: limited(at, pauses.spotifyPausedUntil) };
      } else {
        patch = {
          lastAttemptAt: at,
          ...(error.missing ? { spotifyPlaylistId: null, generation: (Number(state?.generation) || 0) + 1 } : {}),
          lastResult: { ok: false, at, error: error.message, retrySoon: error instanceof OutOfTime, missing: Boolean(error.missing) }
        };
      }
    } finally {
      await resolver.flush().catch(() => {});
    }
    const at = new Date(clock()).toISOString();
    await updatePlan((current) => withRunState(current, rule.id, patch, at));
    return patch;
  }

  function limited(at, until) {
    return { ok: false, at, error: "Spotify is limiting requests from Jarvis for now.", retryAt: new Date(until).toISOString(), retrySoon: false, missing: false };
  }

  // One run at a time per process: a manual sync and the timer don't race.
  function exclusive(work) {
    if (syncing) return syncing.then(() => exclusive(work));
    syncing = work().finally(() => { syncing = null; });
    return syncing;
  }

  return {
    poll,
    // Whether lookups are holding back for playlist syncs, for the Setup tab.
    async lookups() {
      const pausedUntil = pausesFrom(await history.enrichState()).lookups;
      return {
        pausedUntil: pausedUntil > clock() ? new Date(pausedUntil).toISOString() : null,
        hold: lookupHold,
        left: budget.left()
      };
    },
    top,
    timeline,
    artist,
    enrich,
    // Every genre in the history, by all-time listening, for the filters.
    async genres(limit = 400) {
      const { all, catalog, artists } = await selectPlays(history, { windowDays: null }, clock());
      const { genres, known } = rankGenres(all, catalog, artists);
      return { genres: genres.slice(0, limit).map(({ name, ms }) => ({ name, ms })), known };
    },
    async recent(limit = 50) {
      const plays = await history.recent(limit);
      for (const play of plays) if (!play.track?.image && isSpotifyTrack(play.ref)) wanted.add(play.ref);
      return plays.map((play) => ({ ...play, artistKey: play.track ? leadArtist(play.track).key : "" }));
    },
    async playlists() {
      const plan = await loadPlan();
      return playlistRules(plan).map((rule) => {
        const state = playlistState(plan, rule.id);
        return { ...rule, state, nextSyncAt: nextSyncAt(rule, state) };
      });
    },
    async preview(body) {
      const rule = normalizeRule({ ...body, name: String(body.name || "").trim() || "Preview", id: "preview" });
      const connection = await spotify();
      const resolver = connection ? await resolverFor(connection.api) : null;
      try {
        return { checked: Boolean(resolver), ...(await buildPlaylist(rule, { history, resolver, now: clock(), clock })) };
      } finally {
        await resolver?.flush().catch(() => {});
      }
    },
    syncRule(id) {
      return exclusive(async () => {
        const rule = playlistRules(await loadPlan()).find((entry) => entry.id === id);
        if (!rule) throw httpError(404, "That playlist rule no longer exists.");
        return syncOne(rule);
      });
    },
    // Syncs every due rule; stops starting new ones after the deadline.
    syncDue({ deadline = Infinity } = {}) {
      return exclusive(async () => {
        if (!(await spotify())) return [];
        const plan = await loadPlan();
        const done = [];
        for (const rule of playlistRules(plan)) {
          if (clock() > deadline) break;
          if (!isDue(rule, playlistState(plan, rule.id), clock())) continue;
          done.push({ id: rule.id, ...(await syncOne(rule, { deadline })) });
        }
        return done;
      });
    },
    // Recreate: the next sync makes a new playlist and leaves the old one be.
    async forget(id) {
      const at = new Date(clock()).toISOString();
      await updatePlan((current) => {
        const generation = (Number(playlistState(current, id)?.generation) || 0) + 1;
        return withRunState(current, id, { spotifyPlaylistId: null, lastName: null, lastSyncedAt: null, lastResult: null, generation }, at);
      });
    }
  };
}
