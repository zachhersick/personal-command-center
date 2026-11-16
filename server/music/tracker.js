// Records plays from Spotify's "recently played" list. Spotify only keeps the
// last 50, so a poll that finds all 50 newer than the previous one may have
// missed plays in between; that span is reported as a gap, which a fresh
// Spotify export fills.
import { isSpotifyTrack } from "./rank.js";

export function trackFromSpotify(item) {
  if (!item) return null;
  return {
    name: item.name || "",
    artists: (item.artists || []).map((artist) => artist?.name).filter(Boolean),
    album: item.album?.name || "",
    isrc: item.external_ids?.isrc || "",
    durationMs: Number(item.duration_ms) || 0
  };
}

export async function pollRecentlyPlayed(api, { cursorMs = null } = {}) {
  const data = await api.json("/me/player/recently-played?limit=50");
  const items = (data?.items || [])
    .map((entry) => ({ ms: Date.parse(entry?.played_at), item: entry?.track }))
    .filter((entry) => Number.isFinite(entry.ms) && isSpotifyTrack(entry.item?.uri));
  const fresh = items.filter((entry) => cursorMs === null || entry.ms > cursorMs);
  const tracks = {};
  for (const entry of fresh) tracks[entry.item.uri] = trackFromSpotify(entry.item);
  const newest = Math.max(cursorMs ?? -Infinity, ...items.map((entry) => entry.ms));
  const oldest = Math.min(...items.map((entry) => entry.ms));
  const full = (data?.items || []).length >= 50;
  const gap = cursorMs !== null && full && fresh.length === items.length && oldest > cursorMs
    ? { from: new Date(cursorMs).toISOString(), to: new Date(oldest).toISOString() }
    : null;
  return {
    plays: fresh.map((entry) => ({ ms: entry.ms, ref: entry.item.uri })),
    tracks,
    cursorMs: Number.isFinite(newest) ? newest : cursorMs,
    gap
  };
}
