// Builds a rule's track list and writes it to the Spotify playlist Jarvis
// made for it. Two guarantees: each song appears once, and the version used is
// one Zach plays that Spotify can actually play.
import { songKey } from "./identity.js";
import { selectPlays } from "./query.js";
import { isSpotifyTrack, rankSongs } from "./rank.js";
import { describePeriod } from "./rules.js";

const WRITE_CHUNK = 100;
const MAX_SKIPPED_REPORTED = 25;

export class OutOfTime extends Error {
  constructor() {
    super("Ran out of time while checking tracks on Spotify; the rest is done at the next check.");
    this.retrySoon = true;
  }
}

// check false: no Spotify calls (a preview where Spotify isn't connected).
// The most played Spotify version is shown, and Apple-only songs are listed
// as still to be matched.
export async function buildPlaylist(rule, { history, resolver = null, now = Date.now(), deadline = Infinity, clock = () => Date.now() }) {
  const { range, counts, catalog } = await selectPlays(history, { windowDays: rule.windowDays, from: rule.fixedRange?.from, to: rule.fixedRange?.to, genre: rule.genre }, now);
  const songs = rankSongs(counts, catalog);
  const tracks = [];
  const skipped = [];
  const usedRefs = new Set();
  const usedKeys = new Set();
  const skip = (song, reason) => {
    skipped.push({ title: song.title, artist: song.artist, plays: song.plays, ms: song.ms, reason });
  };
  const entry = (song, ref, note = "") => ({ ref, title: song.title, artist: song.artist, image: song.image, plays: song.plays, ms: song.ms, note });

  for (const song of songs) {
    if (tracks.length >= rule.topK) break;
    if (clock() > deadline) throw new OutOfTime();
    if (usedKeys.has(song.key)) {
      skip(song, "Already on the playlist");
      continue;
    }
    let pick = null;
    let fallback = false;
    const spotifyVersions = song.versions.filter((version) => isSpotifyTrack(version.ref) && !usedRefs.has(version.ref));
    for (const version of spotifyVersions) {
      if (!resolver) {
        pick = { ref: version.ref, track: catalog.get(version.ref) };
        break;
      }
      const result = await resolver.playable(version.ref);
      if (result.playable) {
        pick = { ref: version.ref, track: result.track };
        break;
      }
      fallback = true;
    }
    if (!pick && resolver) {
      const found = await resolver.search(song, { exclude: usedRefs });
      if (found) {
        pick = found;
        fallback = true;
      }
    }
    if (!pick && !resolver && !spotifyVersions.length) {
      tracks.push(entry(song, null, "Matched on Spotify when it syncs"));
      usedKeys.add(song.key);
      continue;
    }
    if (!pick) {
      skip(song, spotifyVersions.length ? "No version you play is available on Spotify" : "Not found on Spotify");
      continue;
    }
    // The version picked may be the same song as one already on the list
    // under a different spelling (Spotify returns its own metadata).
    const pickedKey = pick.track ? songKey(pick.track) : "";
    if (usedRefs.has(pick.ref) || (pickedKey && pickedKey !== song.key && usedKeys.has(pickedKey))) {
      skip(song, "Already on the playlist");
      continue;
    }
    usedRefs.add(pick.ref);
    usedKeys.add(song.key);
    if (pickedKey) usedKeys.add(pickedKey);
    tracks.push(entry(song, pick.ref, fallback ? "Another version, since the one you play isn't available" : ""));
  }
  return { tracks, skipped, songs: songs.length, from: range.from ? new Date(range.from).toISOString() : null, to: new Date(range.to).toISOString() };
}

export function playlistDescription(rule, now, state = null) {
  const day = new Date(now).toISOString().slice(0, 10);
  const genre = rule.genre ? ` ${rule.genre}` : "";
  return `Your top ${rule.topK}${genre} tracks of ${describePeriod(rule)}, by listening time. Updated by Jarvis ${day}. ${marker(rule, state)}`;
}

// The marker lets a second device (or a lost id) find the playlist this rule
// made instead of making another. Recreating bumps the generation so the old
// playlist is left alone.
export function marker(rule, state = null) {
  const generation = Number(state?.generation) || 0;
  return `[jarvis:${rule.id}${generation ? `.${generation}` : ""}]`;
}

async function findByMarker(api, rule, state) {
  const tag = marker(rule, state);
  let path = "/me/playlists?limit=50";
  for (let page = 0; path && page < 40; page += 1) {
    const data = await api.json(path);
    const found = (data?.items || []).find((playlist) => String(playlist?.description || "").includes(tag));
    if (found) return found.id;
    path = data?.next || null;
  }
  return null;
}

async function currentUris(api, id) {
  const uris = [];
  let path = `/playlists/${id}/items?limit=50&fields=${encodeURIComponent("next,items(item(uri),track(uri))")}`;
  while (path) {
    const data = await api.json(path);
    for (const entry of data?.items || []) uris.push(entry?.item?.uri || entry?.track?.uri || "");
    path = data?.next || null;
  }
  return uris;
}

// Writes the list. Only ever to the playlist this rule created (its stored
// id, or the one carrying its marker), never to another playlist.
export async function syncPlaylist(rule, state, { api, history, resolver, now = Date.now(), deadline = Infinity, clock = () => Date.now() }) {
  const built = await buildPlaylist(rule, { history, resolver, now, deadline, clock });
  const uris = built.tracks.map((track) => track.ref);
  const description = playlistDescription(rule, now, state);
  let id = state?.spotifyPlaylistId || (await findByMarker(api, rule, state));
  let created = false;
  if (!id) {
    const playlist = await api.json("/me/playlists", { method: "POST", body: { name: rule.name, public: false, description } });
    id = playlist?.id;
    if (!id) throw new Error("Spotify didn't return the new playlist.");
    created = true;
  }
  let existing;
  try {
    existing = created ? [] : await currentUris(api, id);
  } catch (error) {
    if (error.status === 404) throw Object.assign(new Error("The Spotify playlist is gone. Use Recreate to make a new one."), { missing: true });
    if (error.status === 403 && !error.reconnect) throw Object.assign(new Error("Spotify won't let Jarvis read that playlist. Use Recreate to make a new one."), { missing: true });
    throw error;
  }
  const changed = existing.length !== uris.length || existing.some((uri, index) => uri !== uris[index]);
  if (changed) {
    // Replace with the first 100 (clearing anything else), then append.
    await api.json(`/playlists/${id}/items`, { method: "PUT", body: { uris: uris.slice(0, WRITE_CHUNK) } });
    for (let at = WRITE_CHUNK; at < uris.length; at += WRITE_CHUNK) {
      await api.json(`/playlists/${id}/items`, { method: "POST", body: { uris: uris.slice(at, at + WRITE_CHUNK) } });
    }
  }
  if (changed || state?.lastName !== rule.name) {
    await api.json(`/playlists/${id}`, { method: "PUT", body: { name: rule.name, description } });
  }
  const at = new Date(now).toISOString();
  return {
    spotifyPlaylistId: id,
    lastName: rule.name,
    lastSyncedAt: at,
    lastAttemptAt: at,
    lastResult: {
      ok: true,
      at,
      created,
      changed,
      tracks: uris.length,
      wanted: rule.topK,
      substituted: built.tracks.filter((track) => track.note).length,
      skipped: built.skipped.slice(0, MAX_SKIPPED_REPORTED),
      skippedCount: built.skipped.length
    }
  };
}
