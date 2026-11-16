// Finds a playable Spotify track for a song. Checks are cached so a daily sync
// of a 100-track playlist doesn't ask Spotify about the same tracks every day.
import { parseTitle, primaryArtist, songKey } from "./identity.js";
import { trackFromSpotify } from "./tracker.js";

const TRACK_TTL_MS = 7 * 86_400_000;
const SEARCH_TTL_MS = 30 * 86_400_000;

// Spotify answers is_playable for the user's own country when a market is
// given; "from_token" means the market of whoever is signed in.
const MARKET = "from_token";

export function createResolver({ api, loadCache, saveCache, now = () => Date.now() }) {
  let cache = null;
  let dirty = false;

  async function state() {
    if (!cache) {
      const loaded = (await loadCache()) || {};
      cache = { tracks: loaded.tracks || {}, search: loaded.search || {} };
    }
    return cache;
  }

  return {
    // { playable, track } for a spotify:track: ref.
    async playable(ref) {
      const store = await state();
      const hit = store.tracks[ref];
      if (hit && now() - hit.at < TRACK_TTL_MS) return { playable: hit.p === 1, track: hit.t || null };
      const id = ref.split(":")[2];
      let playable = false;
      let track = null;
      try {
        const item = await api.json(`/tracks/${id}?market=${MARKET}`);
        track = trackFromSpotify(item);
        // Without relinking information Spotify omits is_playable; treat the
        // track as playable then, as Spotify's own clients do.
        playable = item?.is_playable !== false && !item?.restrictions?.reason;
      } catch (error) {
        if (![400, 404].includes(error.status)) throw error;
      }
      store.tracks[ref] = { p: playable ? 1 : 0, at: now(), t: track };
      dirty = true;
      return { playable, track };
    },
    // A playable Spotify track that is the same song, for songs only heard on
    // Apple Music or whose versions are all unavailable.
    async search(song, { exclude = new Set() } = {}) {
      const store = await state();
      const hit = store.search[song.key];
      if (hit && now() - hit.at < SEARCH_TTL_MS && !exclude.has(hit.ref)) return hit.ref ? { ref: hit.ref, track: hit.t || null } : null;
      const { base } = parseTitle(song.title);
      const artist = primaryArtist(song.artist);
      const query = `track:${base}${artist ? ` artist:${artist}` : ""}`;
      const data = await api.json(`/search?type=track&limit=10&market=${MARKET}&q=${encodeURIComponent(query)}`);
      const match = (data?.tracks?.items || []).find((item) => item?.uri && !exclude.has(item.uri) && item.is_playable !== false && songKey(trackFromSpotify(item)) === song.key);
      store.search[song.key] = { ref: match?.uri || null, at: now(), t: match ? trackFromSpotify(match) : null };
      dirty = true;
      return match ? { ref: match.uri, track: trackFromSpotify(match) } : null;
    },
    async flush() {
      if (!dirty || !cache) return;
      const cutoff = now() - SEARCH_TTL_MS;
      const keep = (entries) => Object.fromEntries(Object.entries(entries).filter(([, value]) => value.at > cutoff));
      await saveCache({ tracks: keep(cache.tracks), search: keep(cache.search) });
      dirty = false;
    }
  };
}
