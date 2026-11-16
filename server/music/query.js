// The plays a view or a playlist works from: a period, optionally one genre,
// with the catalog and artist details needed to rank them.
import { filterByGenre, leadArtist, periodRange } from "./rank.js";

export const MAX_GENRE = 60;

export function cleanGenre(value) {
  const text = String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
  return text.slice(0, MAX_GENRE);
}

export async function selectPlays(history, { windowDays = null, from = null, to = null, genre = "" } = {}, now = Date.now()) {
  const range = periodRange({ windowDays, from, to }, now);
  const all = await history.counts(range);
  const catalog = await history.catalog(all.keys());
  const keys = new Set();
  for (const ref of all.keys()) {
    const { key } = leadArtist(catalog.get(ref));
    if (key) keys.add(key);
  }
  const artists = await history.artists(keys);
  const counts = genre ? filterByGenre(all, catalog, artists, genre) : all;
  return { range, all, counts, catalog, artists };
}
