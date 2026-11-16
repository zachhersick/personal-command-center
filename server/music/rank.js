// Ranking plays into top songs, artists and genres. Pure functions shared by
// the desktop and the cloud; storage hands in per-track totals for a period.
import { fold, groupSongs, primaryArtist } from "./identity.js";

export const DAY_MS = 86_400_000;
// A play Jarvis recorded just after an export ends may be the export's own
// last stream seen from the other side; the same track this close counts once.
export const EDGE_SECONDS = 600;
const SPOTIFY_TRACK = /^spotify:track:[A-Za-z0-9]{22}$/;

export function isSpotifyTrack(ref) {
  return SPOTIFY_TRACK.test(String(ref || ""));
}

// A rolling window ending now. windowDays null means all time.
export function windowRange(windowDays, now) {
  const to = typeof now === "number" ? now : Date.parse(now);
  return { from: windowDays ? to - windowDays * DAY_MS : null, to };
}

// A rule's or a request's period: fixed dates win over a rolling window.
export function periodRange({ windowDays = null, from = null, to = null } = {}, now) {
  if (Number.isFinite(from) && Number.isFinite(to)) return { from, to };
  return windowRange(windowDays, now);
}

export function artistLabel(track) {
  if (!track) return "";
  if (Array.isArray(track.artists) && track.artists.length) return track.artists.join(", ");
  return track.artist || "";
}

// The credited first artist of a track, as written, and its matching key.
export function leadArtist(track) {
  const name = Array.isArray(track?.artists) && track.artists.length ? track.artists[0] : String(track?.artist || "").split(/\s*(?:,|;|\s&\s)\s*/)[0];
  return { name, key: primaryArtist(name) };
}

// Minutes first; plays and the latest play break ties.
function byTime(a, b) {
  return b.ms - a.ms || b.plays - a.plays || b.last - a.last || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

// counts: Map(ref -> { plays, ms, last }) for the period; catalog: Map(ref ->
// track). Each song lists its versions (track refs) with the most listening
// time first, which is the order a playlist tries them in.
export function rankSongs(counts, catalog) {
  const refs = [...counts.keys()];
  const { groups, keyOf } = groupSongs(refs, catalog);
  const songs = groups.map((group) => {
    const versions = group
      .map((ref) => ({ ref, key: ref, plays: counts.get(ref).plays, ms: counts.get(ref).ms || 0, last: counts.get(ref).last }))
      .sort(byTime)
      .map(({ ref, plays, ms, last }) => ({ ref, plays, ms, last }));
    const named = versions.find((version) => catalog.get(version.ref)?.name) || versions[0];
    const track = catalog.get(named.ref) || {};
    const pictured = versions.find((version) => catalog.get(version.ref)?.image);
    return {
      key: keyOf(versions[0].ref),
      title: track.name || "Unknown track",
      artist: artistLabel(track) || "Unknown artist",
      artistKey: leadArtist(track).key,
      album: track.album || "",
      image: pictured ? catalog.get(pictured.ref).image : "",
      plays: versions.reduce((sum, version) => sum + version.plays, 0),
      ms: versions.reduce((sum, version) => sum + version.ms, 0),
      last: Math.max(...versions.map((version) => version.last)),
      versions
    };
  });
  return songs.sort(byTime);
}

// artists: Map(artist key -> { image, genres, ... }) when known.
export function rankArtists(counts, catalog, artists = new Map()) {
  const totals = new Map();
  for (const [ref, { plays, ms = 0, last }] of counts) {
    const { name, key } = leadArtist(catalog.get(ref));
    if (!key) continue;
    const entry = totals.get(key) || { key, names: new Map(), plays: 0, ms: 0, last: 0 };
    entry.plays += plays;
    entry.ms += ms;
    entry.last = Math.max(entry.last, last);
    entry.names.set(name, (entry.names.get(name) || 0) + ms + plays);
    totals.set(key, entry);
  }
  return [...totals.values()]
    .map(({ key, names, plays, ms, last }) => ({
      key,
      name: [...names.entries()].sort((a, b) => b[1] - a[1])[0][0],
      image: artists.get(key)?.image || "",
      genres: artists.get(key)?.genres || [],
      plays,
      ms,
      last
    }))
    .sort(byTime);
}

// ---------- genres ----------
const words = (text) => fold(text).split(" ").filter(Boolean);

// "house" matches "deep house" and "tech house" but not "warehouse"; a
// filter of several words needs all of them, in any order.
export function genreMatches(genre, term) {
  const want = words(term);
  if (!want.length) return true;
  const have = new Set(words(genre));
  return want.every((word) => have.has(word));
}

export function artistMatches(info, term) {
  return Boolean(info?.genres?.some((genre) => genreMatches(genre, term)));
}

// Keeps the tracks whose lead artist has a matching genre. Artists whose
// genres aren't known yet are left out rather than guessed.
export function filterByGenre(counts, catalog, artists, term) {
  if (!term) return counts;
  const kept = new Map();
  for (const [ref, entry] of counts) {
    if (artistMatches(artists.get(leadArtist(catalog.get(ref)).key), term)) kept.set(ref, entry);
  }
  return kept;
}

// Listening time per genre. A play counts toward every genre of its lead
// artist (featured artists would skew the list). known is the share of time
// whose artist's genres have been looked up, so the page can say how complete
// it is. Spotify now answers with no genres, so its check alone doesn't count.
export function rankGenres(counts, catalog, artists) {
  const totals = new Map();
  let all = 0;
  let checked = 0;
  for (const [ref, { plays, ms = 0, last }] of counts) {
    all += ms;
    const info = artists.get(leadArtist(catalog.get(ref)).key);
    if (!info?.genresAt && !(info?.checkedAt && info.genres?.length)) continue;
    checked += ms;
    for (const genre of new Set(info.genres || [])) {
      const entry = totals.get(genre) || { key: genre, name: genre, plays: 0, ms: 0, last: 0 };
      entry.plays += plays;
      entry.ms += ms;
      entry.last = Math.max(entry.last, last);
      totals.set(genre, entry);
    }
  }
  return { genres: [...totals.values()].sort(byTime), known: all ? checked / all : 0 };
}

// ---------- listening over time ----------
// Day buckets up to about three months, weeks up to two years, then months.
export function timelineUnit(from, to) {
  const days = (to - from) / DAY_MS;
  if (days <= 92) return "day";
  if (days <= 731) return "week";
  return "month";
}

const formatters = new Map();

// The local calendar date of a moment in a time zone, as YYYY-MM-DD. Every
// zone's offset is a whole number of quarter hours, so one answer per
// quarter hour is exact.
export function localDay(ms, timeZone, cache = new Map()) {
  const quarter = Math.floor(ms / 900_000);
  let day = cache.get(quarter);
  if (!day) {
    let format = formatters.get(timeZone);
    if (!format) {
      format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
      formatters.set(timeZone, format);
    }
    day = format.format(new Date(quarter * 900_000));
    cache.set(quarter, day);
  }
  return day;
}

const dayNumber = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY_MS;
const isoOf = (number) => new Date(number * DAY_MS).toISOString().slice(0, 10);

// The first day of the bucket a local date falls in. Weeks start on Monday,
// as Postgres's date_trunc does.
export function bucketStart(day, unit) {
  if (unit === "month") return `${day.slice(0, 7)}-01`;
  if (unit === "week") {
    const number = dayNumber(day);
    const weekday = (new Date(number * DAY_MS).getUTCDay() + 6) % 7;
    return isoOf(number - weekday);
  }
  return day;
}

function nextBucket(start, unit) {
  if (unit === "month") {
    const year = Number(start.slice(0, 4));
    const month = Number(start.slice(5, 7));
    return month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  }
  return isoOf(dayNumber(start) + (unit === "week" ? 7 : 1));
}

// Every bucket from the first to the last day, with the empty ones filled in.
export function fillTimeline(rows, { firstDay, lastDay, unit }) {
  const by = new Map(rows.map((row) => [row.start, row]));
  const out = [];
  const end = bucketStart(lastDay, unit);
  for (let start = bucketStart(firstDay, unit), guard = 0; start <= end && guard < 5000; start = nextBucket(start, unit), guard += 1) {
    const row = by.get(start);
    out.push({ start, ms: row?.ms || 0, plays: row?.plays || 0 });
  }
  return out;
}
