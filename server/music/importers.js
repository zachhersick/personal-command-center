// Reads listening-history exports in place. Nothing is copied: the parsed
// plays go into Jarvis's own compact store and the export stays where it is.
//
// Spotify "Extended streaming history": Streaming_History_Audio_*.json, one
// record per stream with ts (UTC, when it ended), ms_played and
// spotify_track_uri.
// Apple Music: "Apple Music - Play History Daily Tracks.csv", one row per
// track per day with Play Count and the hours it was played. Apple's export
// has no per-play time, so plays land on the listed hours of that day.
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { splitAppleDescription } from "./identity.js";
import { isSpotifyTrack } from "./rank.js";

export const MIN_PLAY_MS = 30_000;
const SPOTIFY_FILE = /^Streaming_History_Audio_.*\.json$/i;
const APPLE_DAILY = "apple music - play history daily tracks.csv";

export async function findExportFiles(folder, depth = 4) {
  const found = { spotify: [], appleDaily: null };
  async function walk(dir, level) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "__MACOSX" || entry.name.startsWith("._")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory() && level < depth) await walk(path, level + 1);
      else if (entry.isFile() && SPOTIFY_FILE.test(entry.name)) found.spotify.push(path);
      else if (entry.isFile() && entry.name.toLowerCase() === APPLE_DAILY && !found.appleDaily) found.appleDaily = path;
    }
  }
  await walk(folder, 0);
  found.spotify.sort();
  return found;
}

// Plays are [seconds since epoch, track index, ms heard]; tracks are
// [ref, name, artist, album].
function collector() {
  const index = new Map();
  const tracks = [];
  const plays = [];
  let from = Infinity;
  let to = -Infinity;
  return {
    span(ms) {
      if (ms < from) from = ms;
      if (ms > to) to = ms;
    },
    add(ms, ref, name, artist, album, heard = 0) {
      let at = index.get(ref);
      if (at === undefined) {
        at = tracks.length;
        index.set(ref, at);
        tracks.push([ref, name || "", artist || "", album || ""]);
      }
      plays.push([Math.floor(ms / 1000), at, Math.max(0, Math.round(heard) || 0)]);
    },
    result(extra) {
      plays.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      return { from: Number.isFinite(from) ? from : null, to: Number.isFinite(to) ? to : null, tracks, plays, ...extra };
    }
  };
}

export async function parseSpotifyExport(files) {
  const out = collector();
  let streams = 0;
  let short = 0;
  let other = 0;
  let duplicates = 0;
  // The same stream can be in two files when a newer export is unzipped next
  // to an older one; time and track identify a stream, so count it once.
  const seen = new Set();
  for (const file of files) {
    let rows;
    try {
      rows = JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, ""));
    } catch {
      throw Object.assign(new Error(`${basename(file)} isn't valid JSON.`), { status: 400 });
    }
    if (!Array.isArray(rows)) throw Object.assign(new Error(`${basename(file)} isn't a Spotify streaming history file.`), { status: 400 });
    for (const row of rows) {
      const ms = Date.parse(row?.ts);
      if (!Number.isFinite(ms)) continue;
      const id = `${ms}|${row.spotify_track_uri || row.spotify_episode_uri || row.master_metadata_track_name || ""}|${row.ms_played}`;
      if (seen.has(id)) {
        duplicates += 1;
        continue;
      }
      seen.add(id);
      streams += 1;
      out.span(ms);
      // Podcasts, audiobooks and local files have no track URI.
      if (!isSpotifyTrack(row.spotify_track_uri)) {
        other += 1;
        continue;
      }
      if (!(Number(row.ms_played) >= MIN_PLAY_MS)) {
        short += 1;
        continue;
      }
      out.add(ms, row.spotify_track_uri, row.master_metadata_track_name, row.master_metadata_album_artist_name, row.master_metadata_album_album_name, Number(row.ms_played));
    }
  }
  return out.result({ source: "spotify", streams, short, other, duplicates });
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === "\"" && text[i + 1] === "\"") {
        cell += "\"";
        i += 1;
      } else if (ch === "\"") quoted = false;
      else cell += ch;
    } else if (ch === "\"") quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export async function parseAppleDaily(file) {
  const rows = parseCsv((await readFile(file, "utf8")).replace(/^﻿/, ""));
  const header = rows.shift() || [];
  const col = (name) => header.findIndex((value) => value.trim().toLowerCase() === name);
  const at = {
    id: col("track identifier"),
    description: col("track description"),
    date: col("date played"),
    hours: col("hours"),
    count: col("play count"),
    media: col("media type"),
    duration: col("play duration milliseconds")
  };
  if ([at.id, at.description, at.date, at.count].some((index) => index < 0)) {
    throw Object.assign(new Error("That Apple Music file is missing the Track Identifier, Track Description, Date Played or Play Count column."), { status: 400 });
  }
  const out = collector();
  let skipped = 0;
  for (const row of rows) {
    const date = /^(\d{4})(\d{2})(\d{2})$/.exec(String(row[at.date] || "").trim());
    const count = Number(row[at.count]);
    if (!date) continue;
    const day = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
    out.span(day);
    out.span(day + 86_399_000);
    // Apple only counts a play once enough of it was heard; skips have a
    // count of zero. Videos aren't songs.
    if (!(count > 0) || (at.media >= 0 && row[at.media] && row[at.media] !== "AUDIO")) {
      skipped += 1;
      continue;
    }
    const id = String(row[at.id] || "").trim();
    if (!/^\d+$/.test(id)) {
      skipped += 1;
      continue;
    }
    const { artist, title } = splitAppleDescription(row[at.description]);
    const hours = String(at.hours >= 0 ? row[at.hours] : "").split(",").map((value) => Number(value.trim())).filter((hour) => Number.isInteger(hour) && hour >= 0 && hour < 24);
    // The row's listening time covers the whole day; each play gets an
    // equal share. Without it, the track's length fills in later.
    const total = at.duration >= 0 ? Number(row[at.duration]) : 0;
    const each = Number.isFinite(total) && total > 0 ? total / count : 0;
    for (let i = 0; i < count; i += 1) {
      const hour = hours.length ? hours[i % hours.length] : 12;
      out.add(day + hour * 3_600_000 + i * 1000, `apple:${id}`, title, artist, "", each);
    }
  }
  return out.result({ source: "apple", skipped });
}

export async function importFolder(folder) {
  const info = await stat(folder).catch(() => null);
  if (!info?.isDirectory()) throw Object.assign(new Error("Choose a folder that exists on this computer."), { status: 400 });
  const files = await findExportFiles(folder);
  if (!files.spotify.length && !files.appleDaily) {
    throw Object.assign(new Error("No Spotify Streaming_History_Audio files or Apple Music \"Play History Daily Tracks\" file in that folder. Unzip the export first."), { status: 400 });
  }
  return {
    spotify: files.spotify.length ? { ...(await parseSpotifyExport(files.spotify)), files: files.spotify.length } : null,
    apple: files.appleDaily ? { ...(await parseAppleDaily(files.appleDaily)), files: 1 } : null
  };
}
