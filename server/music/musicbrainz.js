// Artist genres from MusicBrainz, since Spotify no longer returns genres to
// apps like this one. An artist is found by the Spotify link MusicBrainz
// keeps for it; failing that, by a name search that only counts when exactly
// one artist has that exact name, so a common name never gets someone
// else's genres. MusicBrainz allows about one request a second and asks for
// a named client; the name carries no personal details.
import { fold } from "./identity.js";

const BASE = "https://musicbrainz.org/ws/2";
export const USER_AGENT = "JarvisMusicStats/1.0 ( personal listening stats )";
const MAX_GENRES = 8;
const TIMEOUT_MS = 15_000;
const RETRIES = 2;
const RETRY_MS = 1500;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

// Genres by votes, strongest first. One with a tenth of the top genre's votes
// or fewer is noise ("acoustic rock" on Nirvana).
export function pickGenres(list) {
  const genres = (Array.isArray(list) ? list : [])
    .filter((genre) => genre?.name && Number(genre.count) > 0)
    .sort((a, b) => b.count - a.count);
  if (!genres.length) return [];
  const floor = Math.max(1, genres[0].count / 10);
  return genres.filter((genre) => genre.count >= floor).slice(0, MAX_GENRES).map((genre) => String(genre.name).toLowerCase().slice(0, 80));
}

export function createMusicBrainz({ fetchImpl = fetch, gapMs = 1100, clock = () => Date.now(), sleep = wait } = {}) {
  let lastCall = 0;

  // MusicBrainz's limit is shared with every other client, so a busy answer
  // often clears in a second or two; give it two more tries before waiting
  // for the next run.
  async function get(path) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await getOnce(path);
      } catch (error) {
        if (!error.retry || attempt >= RETRIES) throw error;
        await sleep(RETRY_MS * (attempt + 1));
      }
    }
  }

  async function getOnce(path) {
    const delay = lastCall + (typeof gapMs === "function" ? gapMs() : gapMs) - clock();
    if (delay > 0) await sleep(delay);
    lastCall = clock();
    let response;
    try {
      response = await fetchImpl(`${BASE}${path}`, { headers: { "user-agent": USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw Object.assign(new Error(`MusicBrainz can't be reached: ${error.message}`), { busy: true });
    } finally {
      lastCall = clock();
    }
    if (response.status === 404) return null;
    // MusicBrainz answers 503 when asked too often.
    if (response.status === 503 || response.status === 429) throw Object.assign(new Error("MusicBrainz is busy."), { busy: true, retry: true });
    if (!response.ok) throw Object.assign(new Error(`MusicBrainz answered ${response.status}.`), { busy: true });
    return response.json();
  }

  async function findBySpotify(spotifyId) {
    if (!/^[A-Za-z0-9]{22}$/.test(String(spotifyId || ""))) return "";
    const found = await get(`/url?resource=${encodeURIComponent(`https://open.spotify.com/artist/${spotifyId}`)}&inc=artist-rels&fmt=json`);
    const artists = (found?.relations || []).filter((relation) => relation?.["target-type"] === "artist" && relation.artist?.id);
    // A link shared by several artists (a duo's page) says nothing certain.
    return artists.length === 1 ? artists[0].artist.id : "";
  }

  async function findByName(name) {
    const wanted = fold(name);
    if (!wanted) return "";
    const found = await get(`/artist?query=${encodeURIComponent(`artist:"${String(name).replace(/"/g, "")}"`)}&limit=10&fmt=json`);
    const exact = (found?.artists || []).filter((artist) => fold(artist?.name) === wanted);
    return exact.length === 1 ? exact[0].id : "";
  }

  return {
    // { mbid, genres } for an artist, or null when MusicBrainz has no sure match.
    async genres({ spotifyId = "", name = "" } = {}) {
      const mbid = (await findBySpotify(spotifyId)) || (await findByName(name));
      if (!mbid) return null;
      const artist = await get(`/artist/${encodeURIComponent(mbid)}?inc=genres&fmt=json`);
      if (!artist) return null;
      return { mbid, genres: pickGenres(artist.genres) };
    }
  };
}
