// Fills in what exports don't have: each track's length and album art, and
// each artist's genres and photo. Runs in the background a little at a time,
// biggest artists first, paced well under Spotify's rate limit, and stops
// for as long as Spotify asks when it does push back.
//
// Spotify's batch lookups are gone for apps like this one, so every track or
// artist is its own request. An artist's ID comes from one of their tracks
// (exports carry only names); an artist heard only on Apple Music is found by
// an exact-name search, and left without genres rather than guessed.
import { fold, primaryArtist } from "./identity.js";
import { isSpotifyTrack, leadArtist } from "./rank.js";
import { pausesAfterLimit, pausesFrom } from "./limits.js";

const REFRESH_MS = 90 * 86_400_000;
const SAVE_EVERY = 20;
const WANTED_PER_RUN = 10;

// The smallest image at least this wide: crisp in a list, light to load.
export function pickImage(images, minWidth = 160) {
  const list = (Array.isArray(images) ? images : []).filter((image) => image?.url && /^https:\/\/i\.scdn\.co\//.test(image.url));
  if (!list.length) return "";
  const wide = list.filter((image) => (image.width || 0) >= minWidth).sort((a, b) => (a.width || 0) - (b.width || 0));
  return (wide[0] || list[0]).url;
}

export function trackDetails(item, at) {
  return {
    checkedAt: at,
    durationMs: Number(item?.duration_ms) || 0,
    image: pickImage(item?.album?.images),
    artistIds: (item?.artists || []).map((artist) => artist?.id).filter(Boolean),
    artists: (item?.artists || []).map((artist) => artist?.name).filter(Boolean)
  };
}

export function artistDetails(item, at) {
  return {
    checkedAt: at,
    id: item?.id || "",
    name: item?.name || "",
    genres: Array.isArray(item?.genres) ? item.genres.map(String).slice(0, 30) : [],
    image: pickImage(item?.images)
  };
}

// The artist ID on a track for the artist key, or the track's first artist.
function artistIdOn(track, key) {
  const ids = track?.artistIds || [];
  const names = track?.artists || [];
  const index = names.findIndex((name) => primaryArtist(name) === key);
  return ids[index >= 0 ? index : 0] || "";
}

// history: counts, catalog, artists, enrichState, saveEnrichment.
// wanted: a set of track refs to look up first, kept by the caller between runs.
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

// Thrown to stop a run early without treating it as a failure: a playlist
// sync wants Spotify, or this hour's share of lookups is used up.
class Held extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

// genreSource: { genres({ spotifyId, name }) } for artist genres, since
// Spotify's are empty now (see musicbrainz.js); without it only Spotify's.
// budget: { take() } from limits.js; yieldTo(): true while a sync needs Spotify.
export function createEnricher({ api, history, clock = () => Date.now(), gapMs = 1100, sleep = pause, wanted = new Set(), genreSource = null, budget = { take: () => true }, yieldTo = () => false }) {
  let lastCall = 0;

  async function call(path) {
    if (yieldTo()) throw new Held("sync");
    const wait = lastCall + gapMs - clock();
    if (wait > 0) await sleep(wait);
    // Checked again after the wait, so a sync that started meanwhile goes first.
    if (yieldTo()) throw new Held("sync");
    if (!budget.take()) throw new Held("budget");
    lastCall = clock();
    try {
      return { item: await api.json(path) };
    } catch (error) {
      if ([400, 404].includes(error.status)) return { item: null };
      throw error;
    } finally {
      lastCall = clock();
    }
  }

  return {
    // Tracks on screen without artwork go first at the next run.
    want(refs) {
      for (const ref of refs) if (isSpotifyTrack(ref)) wanted.add(ref);
    },
    // scope.from limits it to recent listening (the cloud's hourly check).
    async run({ deadline = Infinity, from = null } = {}) {
      const report = { tracks: 0, artists: 0, paused: false, done: false };
      const meta = await history.enrichState();
      const pausedUntil = pausesFrom(meta).lookups;
      if (pausedUntil > clock()) return { ...report, paused: true, pausedUntil };
      const counts = await history.counts({ from, to: clock() });
      const catalog = await history.catalog(new Set([...counts.keys(), ...wanted]));

      // Artists by listening time, each with their most-played Spotify track.
      const byArtist = new Map();
      for (const [ref, { ms = 0 }] of counts) {
        const { name, key } = leadArtist(catalog.get(ref));
        if (!key) continue;
        const entry = byArtist.get(key) || { key, name, ms: 0, ref: "", refMs: -1 };
        entry.ms += ms;
        if (isSpotifyTrack(ref) && ms > entry.refMs) {
          entry.ref = ref;
          entry.refMs = ms;
        }
        byArtist.set(key, entry);
      }
      const known = await history.artists(byArtist.keys());
      const now = clock();
      const stale = (at) => !at || now - at > REFRESH_MS;
      const needsSpotify = (info) => stale(info?.checkedAt);
      const needsGenres = (info) => stale(info?.genresAt);
      const artistQueue = [...byArtist.values()]
        .filter((entry) => needsSpotify(known.get(entry.key)) || (genreSource && needsGenres(known.get(entry.key))))
        .sort((a, b) => b.ms - a.ms);
      let finished = 0;
      let genresBusy = false;
      // A few songs' artwork per run, so a busy screen can't hold up artists.
      for (const ref of wanted) if (catalog.get(ref)?.checkedAt) wanted.delete(ref);
      const trackQueue = [...wanted].slice(0, WANTED_PER_RUN);
      // Artist IDs already seen on looked-up tracks save a track lookup each.
      const idOf = new Map();
      const learn = (track) => {
        const ids = track?.artistIds || [];
        (track?.artists || []).forEach((name, index) => {
          const key = primaryArtist(name);
          if (key && ids[index] && !idOf.has(key)) idOf.set(key, ids[index]);
        });
      };
      for (const track of catalog.values()) if (track?.checkedAt) learn(track);

      let pendingTracks = {};
      let pendingArtists = {};
      let unsaved = 0;
      const flush = async (extra = {}) => {
        if (!unsaved && !Object.keys(extra).length) return;
        await history.saveEnrichment({ tracks: pendingTracks, artists: pendingArtists, ...extra });
        pendingTracks = {};
        pendingArtists = {};
        unsaved = 0;
      };
      const lookTrack = async (ref) => {
        const { item } = await call(`/tracks/${ref.split(":")[2]}`);
        const details = item ? trackDetails(item, clock()) : { checkedAt: clock(), missing: true };
        pendingTracks[ref] = details;
        catalog.set(ref, { ...catalog.get(ref), ...details });
        wanted.delete(ref);
        learn(details);
        report.tracks += 1;
        unsaved += 1;
        return details;
      };

      try {
        for (const ref of trackQueue) {
          if (clock() > deadline) break;
          await lookTrack(ref);
          if (unsaved >= SAVE_EVERY) await flush();
        }
        for (const entry of artistQueue) {
          if (clock() > deadline) break;
          const before = known.get(entry.key) || null;
          let details = before;
          if (needsSpotify(before)) {
            const fresh = await spotifyArtist(entry);
            if (fresh === undefined) break;
            // Genres found elsewhere stay when Spotify has none.
            details = !fresh.genres?.length && before?.genresAt ? { ...fresh, genres: before.genres || [], genresAt: before.genresAt, ...(before.mbid ? { mbid: before.mbid } : {}) } : fresh;
          }
          if (genreSource && !genresBusy && needsGenres(details)) {
            try {
              const found = await genreSource.genres({ spotifyId: details?.id || "", name: entry.name });
              details = { ...details, genres: found?.genres?.length ? found.genres : details?.genres || [], genresAt: clock(), ...(found?.mbid ? { mbid: found.mbid } : {}) };
            } catch (error) {
              if (!error.busy) throw error;
              // Pictures carry on; genres wait for the next run.
              genresBusy = true;
              report.genresBusy = true;
            }
          }
          if (details !== before) {
            pendingArtists[entry.key] = details;
            report.artists += 1;
            unsaved += 1;
          }
          if (!needsSpotify(details) && !(genreSource && needsGenres(details))) finished += 1;
          if (unsaved >= SAVE_EVERY) await flush();
        }
        report.done = wanted.size === 0 && finished >= artistQueue.length;
        await flush();
      } catch (error) {
        if (error instanceof Held) {
          await flush();
          return { ...report, held: error.reason };
        }
        if (error.status === 429) {
          const pauses = pausesAfterLimit(error.retryAfterMs, clock(), meta);
          await flush(pauses);
          return { ...report, paused: true, pausedUntil: pauses.lookupsPausedUntil };
        }
        await flush();
        throw error;
      }
      report.remaining = Math.max(0, artistQueue.length - finished);
      return report;

      // An artist's ID, picture and Spotify genres; undefined when the
      // deadline came first.
      async function spotifyArtist(entry) {
        let details = null;
        if (entry.ref || idOf.has(entry.key)) {
          let id = idOf.get(entry.key) || "";
          if (!id) {
            let track = catalog.get(entry.ref);
            if (!track?.checkedAt) track = await lookTrack(entry.ref);
            id = artistIdOn(track, entry.key);
          }
          if (id) {
            if (clock() > deadline) return undefined;
            const { item } = await call(`/artists/${id}`);
            if (item) details = artistDetails(item, clock());
          }
        } else {
          const { item } = await call(`/search?type=artist&limit=10&q=${encodeURIComponent(`artist:${entry.name}`)}`);
          const match = (item?.artists?.items || []).find((artist) => primaryArtist(artist?.name) === entry.key || fold(artist?.name) === fold(entry.name));
          if (match) details = artistDetails(match, clock());
        }
        return details || { checkedAt: clock(), name: entry.name, genres: [], image: "", missing: true };
      }
    }
  };
}
