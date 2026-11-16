// Listening history on the desktop: the imported exports (one file each), the
// plays Jarvis recorded itself, and what Spotify told Jarvis about tracks and
// artists (length, artwork, genres). All under data/music/, never synced as
// files and never served; the cloud gets its copy through the music push.
//
// A Spotify export is the most accurate record (it has real listen times), so
// inside the period an export covers, it replaces what Jarvis recorded.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJsonWithBackup, safeWriteJson } from "../shared-state.js";
import { bucketStart, EDGE_SECONDS, localDay } from "./rank.js";

export function musicPaths(dataRoot) {
  const dir = join(dataRoot, "data", "music");
  return {
    dir,
    spotify: join(dir, "spotify-export.local.json"),
    apple: join(dir, "apple-export.local.json"),
    live: join(dir, "live.local.json"),
    resolve: join(dir, "resolve.local.json"),
    enrich: join(dir, "enrich.local.json")
  };
}

const MAX_GAPS = 50;

function emptyLive() {
  return { version: 1, tracks: {}, plays: [], cursorMs: null, lastPollAt: null, lastError: "", gaps: [], cloud: {} };
}

function emptyEnrich() {
  return { version: 1, tracks: {}, artists: {}, pausedUntil: null };
}

function trackFromRow([, name, artist, album]) {
  return { name, artist, album };
}

const inside = (sec, range) => Boolean(range && Number.isFinite(range.from) && sec * 1000 >= range.from && sec * 1000 <= range.to);

// A new export of a source over the previous one. The new export is the record
// for the dates it covers; the previous one's plays outside them stay, so a
// shorter or partial export never deletes earlier history.
export function mergeExport(previous, data) {
  const tracks = [];
  const at = new Map();
  const indexOf = (row) => {
    let index = at.get(row[0]);
    if (index === undefined) {
      index = tracks.length;
      at.set(row[0], index);
      tracks.push(row);
    }
    return index;
  };
  const plays = [];
  // New rows first so their metadata wins for a track in both.
  for (const [sec, index, ms] of data.plays) plays.push([sec, indexOf(data.tracks[index]), ms || 0]);
  let kept = 0;
  let replaced = 0;
  if (previous) {
    for (const [sec, index, ms] of previous.plays) {
      if (inside(sec, data)) {
        replaced += 1;
        continue;
      }
      kept += 1;
      plays.push([sec, indexOf(previous.tracks[index]), ms || 0]);
    }
  }
  plays.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const spans = [data, previous].filter((value) => value && Number.isFinite(value.from));
  return {
    record: {
      from: spans.length ? Math.min(...spans.map((value) => value.from)) : null,
      to: spans.length ? Math.max(...spans.map((value) => value.to)) : null,
      lastImport: { from: data.from, to: data.to },
      tracks,
      plays
    },
    kept,
    replaced
  };
}

// Recorded plays an export makes redundant: those inside its dates, and those
// just after it that repeat one of its last streams.
export function supersededBy(exportData, livePlays) {
  if (!Number.isFinite(exportData?.from)) return new Set();
  const toSec = exportData.to / 1000;
  const tail = new Map();
  for (const [sec, index] of exportData.plays) {
    if (sec < toSec - EDGE_SECONDS) continue;
    const ref = exportData.tracks[index][0];
    tail.set(ref, [...(tail.get(ref) || []), sec]);
  }
  const gone = new Set();
  livePlays.forEach(([sec, ref], i) => {
    if (inside(sec, exportData)) gone.add(i);
    else if (sec > toSec && sec <= toSec + EDGE_SECONDS && (tail.get(ref) || []).some((other) => Math.abs(other - sec) <= EDGE_SECONDS)) gone.add(i);
  });
  return gone;
}

export function createFileHistory(dataRoot) {
  const paths = () => musicPaths(dataRoot());
  let cache = null;

  async function load() {
    if (cache) return cache;
    const p = paths();
    const read = (path, fallback) => (existsSync(path) ? readJsonWithBackup(path, fallback) : fallback);
    const [spotify, apple, live, enrich] = await Promise.all([read(p.spotify, null), read(p.apple, null), read(p.live, null), read(p.enrich, null)]);
    cache = { spotify, apple, live: { ...emptyLive(), ...(live || {}) }, enrich: { ...emptyEnrich(), ...(enrich || {}) }, index: null };
    return cache;
  }

  // One flat list of every counted play, built once per change. A play saved
  // without its listening time counts the track's length when that's known.
  async function index() {
    const state = await load();
    if (state.index) return state.index;
    const ts = [];
    const refs = [];
    const heard = [];
    const catalog = new Map();
    let estimated = 0;
    for (const source of [state.apple, state.spotify]) {
      if (!source) continue;
      for (const row of source.tracks) catalog.set(row[0], trackFromRow(row));
      for (const [sec, at, ms] of source.plays) {
        ts.push(sec);
        refs.push(source.tracks[at][0]);
        heard.push(ms || 0);
      }
    }
    // Details Spotify itself returned (all artists, ISRC, length, artwork)
    // beat export metadata.
    for (const [ref, track] of Object.entries(state.live.tracks)) catalog.set(ref, { ...catalog.get(ref), ...track });
    for (const [ref, extra] of Object.entries(state.enrich.tracks)) catalog.set(ref, { ...catalog.get(ref), ...extraTrack(extra) });
    for (const [sec, ref, , ms] of state.live.plays) {
      ts.push(sec);
      refs.push(ref);
      heard.push(ms || 0);
    }
    for (let i = 0; i < heard.length; i += 1) {
      if (heard[i]) continue;
      heard[i] = catalog.get(refs[i])?.durationMs || 0;
      estimated += 1;
    }
    state.index = { ts, refs, heard, catalog, estimated };
    return state.index;
  }

  async function saveLive(state) {
    state.index = null;
    await safeWriteJson(paths().live, state.live);
  }

  // Stores a source's record. A Spotify export also drops the recorded plays
  // it covers.
  async function storeExport(state, source, record, covers) {
    await safeWriteJson(paths()[source], record);
    state[source] = record;
    state.index = null;
    if (source === "spotify") {
      const gone = supersededBy(covers, state.live.plays);
      state.live.plays = state.live.plays.filter((_, i) => !gone.has(i));
      state.live.gaps = state.live.gaps.filter((gap) => Date.parse(gap.to) > covers.to);
      await saveLive(state);
    }
    return record;
  }

  return {
    // Totals per track for plays in [from, to] (ms). from null = all time.
    // untimed counts plays whose time heard and track length are both unknown.
    async counts({ from = null, to = Infinity } = {}) {
      const { ts, refs, heard } = await index();
      const lo = from === null ? -Infinity : from / 1000;
      const hi = to / 1000;
      const counts = new Map();
      for (let i = 0; i < ts.length; i += 1) {
        if (ts[i] < lo || ts[i] > hi) continue;
        const entry = counts.get(refs[i]);
        if (entry) {
          entry.plays += 1;
          entry.ms += heard[i];
          if (!heard[i]) entry.untimed += 1;
          if (ts[i] * 1000 > entry.last) entry.last = ts[i] * 1000;
          if (ts[i] * 1000 < entry.first) entry.first = ts[i] * 1000;
        } else counts.set(refs[i], { plays: 1, ms: heard[i], untimed: heard[i] ? 0 : 1, first: ts[i] * 1000, last: ts[i] * 1000 });
      }
      return counts;
    },
    // Listening per local day, week or month. refs limits it (a genre filter).
    async timeline({ from = null, to = Infinity, unit = "day", timeZone = "UTC", refs = null } = {}) {
      const { ts, refs: all, heard } = await index();
      const lo = from === null ? -Infinity : from / 1000;
      const hi = to / 1000;
      const days = new Map();
      const buckets = new Map();
      for (let i = 0; i < ts.length; i += 1) {
        if (ts[i] < lo || ts[i] > hi || (refs && !refs.has(all[i]))) continue;
        const start = bucketStart(localDay(ts[i] * 1000, timeZone, days), unit);
        const entry = buckets.get(start) || { start, ms: 0, plays: 0 };
        entry.ms += heard[i];
        entry.plays += 1;
        buckets.set(start, entry);
      }
      return [...buckets.values()];
    },
    async catalog(refs) {
      const { catalog } = await index();
      return new Map([...refs].map((ref) => [ref, catalog.get(ref) || null]));
    },
    async artists(keys = null) {
      const { enrich } = await load();
      const list = keys ? [...keys] : Object.keys(enrich.artists);
      return new Map(list.filter((key) => enrich.artists[key]).map((key) => [key, enrich.artists[key]]));
    },
    async recent(limit = 50) {
      const { ts, refs, heard, catalog } = await index();
      const order = ts.map((_, i) => i).sort((a, b) => ts[b] - ts[a]).slice(0, limit);
      return order.map((i) => ({ at: new Date(ts[i] * 1000).toISOString(), ref: refs[i], ms: heard[i], track: catalog.get(refs[i]) || null }));
    },
    async summary() {
      const state = await load();
      const { ts, estimated } = await index();
      let first = Infinity;
      let last = -Infinity;
      for (const sec of ts) {
        if (sec < first) first = sec;
        if (sec > last) last = sec;
      }
      const source = (value) => (value ? { importedAt: value.importedAt, from: new Date(value.from).toISOString(), to: new Date(value.to).toISOString(), plays: value.plays.length, tracks: value.tracks.length, exactMinutes: value.version >= 2 } : null);
      return {
        plays: ts.length,
        first: ts.length ? new Date(first * 1000).toISOString() : null,
        last: ts.length ? new Date(last * 1000).toISOString() : null,
        spotifyExport: source(state.spotify),
        appleExport: source(state.apple),
        estimatedMinutes: estimated,
        tracked: { plays: state.live.plays.length, lastPollAt: state.live.lastPollAt, lastError: state.live.lastError, gaps: state.live.gaps }
      };
    },
    // What importing would change, without changing anything.
    async previewExport(source, data) {
      const state = await load();
      const previous = state[source];
      const { kept, replaced } = mergeExport(previous, data);
      return {
        from: data.from,
        to: data.to,
        plays: data.plays.length,
        previous: previous ? { from: previous.from, to: previous.to, plays: previous.plays.length } : null,
        kept,
        replaced,
        recorded: source === "spotify" ? supersededBy(data, state.live.plays).size : 0,
        older: Boolean(previous && Number.isFinite(previous.to) && data.to < previous.to)
      };
    },
    // Merges a new export into the stored one. A Spotify export also drops
    // the recorded plays it covers.
    async setExport(source, data, now = new Date().toISOString()) {
      if (!["spotify", "apple"].includes(source)) throw new Error(`Unknown source ${source}`);
      const state = await load();
      const { record: merged } = mergeExport(state[source], data);
      return storeExport(state, source, { version: 2, source, importedAt: now, ...merged }, data);
    },
    // The whole import as another computer made it (from the cloud), in place
    // of this one's. It already holds everything the older imports had.
    async replaceExport(source, data) {
      if (!["spotify", "apple"].includes(source)) throw new Error(`Unknown source ${source}`);
      const state = await load();
      const record = { version: 2, source, importedAt: data.importedAt, from: data.from, to: data.to, lastImport: { from: data.from, to: data.to }, tracks: data.tracks, plays: data.plays };
      return storeExport(state, source, record, record);
    },
    async exportRecord(source) {
      return (await load())[source] || null;
    },
    // plays: [{ ms, ref, src, heard }]; tracks: { ref: track }. Returns how many were new.
    async addPlays(plays, tracks = {}) {
      const state = await load();
      const seen = new Set(state.live.plays.map(([sec, ref]) => `${sec}|${ref}`));
      let added = 0;
      for (const play of plays) {
        const sec = Math.floor(play.ms / 1000);
        const key = `${sec}|${play.ref}`;
        if (seen.has(key) || inside(sec, state.spotify)) continue;
        seen.add(key);
        const heard = Number(play.heard) || Number(tracks[play.ref]?.durationMs) || 0;
        state.live.plays.push([sec, play.ref, play.src || "l", heard]);
        added += 1;
      }
      let changed = added > 0;
      for (const [ref, track] of Object.entries(tracks)) {
        if (!track || JSON.stringify(state.live.tracks[ref]) === JSON.stringify(track)) continue;
        state.live.tracks[ref] = track;
        changed = true;
      }
      if (changed) {
        state.live.plays.sort((a, b) => a[0] - b[0]);
        await saveLive(state);
      }
      return added;
    },
    async liveState() {
      const { live } = await load();
      const { plays, tracks, ...rest } = live;
      return rest;
    },
    async livePlays({ after = -Infinity, src } = {}) {
      const { live } = await load();
      return live.plays.filter(([sec, , source]) => sec > after && (!src || source === src));
    },
    async liveTracks(refs) {
      const { live } = await load();
      return Object.fromEntries(refs.filter((ref) => live.tracks[ref]).map((ref) => [ref, live.tracks[ref]]));
    },
    async updateLive(patch) {
      const state = await load();
      const next = { ...patch };
      if (next.gap) {
        state.live.gaps = [...state.live.gaps, next.gap].slice(-MAX_GAPS);
        delete next.gap;
      }
      state.live = { ...state.live, ...next, cloud: { ...state.live.cloud, ...(next.cloud || {}) } };
      await saveLive(state);
    },
    // ---------- what Spotify said about tracks and artists ----------
    async enrichState() {
      const { enrich } = await load();
      // pausedUntil is the single pause older versions wrote; see limits.js.
      return { tracks: enrich.tracks, artists: enrich.artists, pausedUntil: enrich.pausedUntil, spotifyPausedUntil: enrich.spotifyPausedUntil || null, lookupsPausedUntil: enrich.lookupsPausedUntil || null };
    },
    async saveEnrichment({ tracks = {}, artists = {}, pausedUntil, spotifyPausedUntil, lookupsPausedUntil } = {}) {
      const state = await load();
      Object.assign(state.enrich.tracks, tracks);
      Object.assign(state.enrich.artists, artists);
      if (pausedUntil !== undefined) state.enrich.pausedUntil = pausedUntil;
      if (spotifyPausedUntil !== undefined) state.enrich.spotifyPausedUntil = spotifyPausedUntil;
      if (lookupsPausedUntil !== undefined) state.enrich.lookupsPausedUntil = lookupsPausedUntil;
      state.index = null;
      await safeWriteJson(paths().enrich, state.enrich);
    },
    // Entries looked up after a time, for the cloud push.
    async enrichedSince(at = 0) {
      const { enrich } = await load();
      const pick = (entries) => Object.fromEntries(Object.entries(entries).filter(([, value]) => Math.max(value.checkedAt || 0, value.genresAt || 0) > at));
      return { tracks: pick(enrich.tracks), artists: pick(enrich.artists) };
    },
    async readResolveCache() {
      return readJsonWithBackup(paths().resolve, {});
    },
    async writeResolveCache(cacheValue) {
      await safeWriteJson(paths().resolve, cacheValue);
    }
  };
}

// The fields of a looked-up track that join the catalog.
export function extraTrack(extra) {
  const out = { checkedAt: extra.checkedAt || 0 };
  if (extra.missing) return out;
  if (extra.durationMs) out.durationMs = extra.durationMs;
  if (extra.image) out.image = extra.image;
  if (extra.artistIds?.length) out.artistIds = extra.artistIds;
  if (extra.artists?.length) out.artists = extra.artists;
  return out;
}
