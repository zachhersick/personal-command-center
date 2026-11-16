// Music tab state: the overview (status and playlist rules), the top lists
// for the chosen period, and recent plays.
import { signal } from "@preact/signals";
import { get, post } from "../api.js";
import { reportError, toast } from "../store.js";
import { ago as timeAgo } from "../format.js";

export const PERIODS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 180, label: "6 months" },
  { days: 365, label: "1 year" },
  { days: 1825, label: "5 years" },
  { days: null, label: "All time" }
];

export const INTERVALS = [
  { hours: 6, label: "Every 6 hours" },
  { hours: 12, label: "Every 12 hours" },
  { hours: 24, label: "Every day" },
  { hours: 72, label: "Every 3 days" },
  { hours: 168, label: "Every week" },
  { hours: 720, label: "Every 30 days" }
];

export const music = signal(null);
export const top = signal(null);
export const timeline = signal(null);
export const recent = signal(null);
export const period = signal(30);
// Custom dates on the Stats tab: { fromDay, toDay } (YYYY-MM-DD) or null.
// { year: true } is the current year so far, worked out when it's asked for.
export const customRange = signal(null);
export const genre = signal("");
export const genres = signal(null);
export const tab = signal("stats");
// The playlist editor: null when closed, otherwise the rule being edited.
export const editing = signal(null);
// The artist whose stats are open (their key), and those stats once loaded.
export const artistKey = signal(null);
export const artist = signal(null);

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

// Local midnight at the start of fromDay to the last moment of toDay.
export function dayRange(fromDay, toDay) {
  const start = new Date(`${fromDay}T00:00:00`);
  const end = new Date(`${toDay}T00:00:00`);
  end.setDate(end.getDate() + 1);
  return { from: start.getTime(), to: end.getTime() - 1 };
}

export function localDay(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// January 1 of this year to today.
export function yearRange(date = new Date()) {
  return { fromDay: `${date.getFullYear()}-01-01`, toDay: localDay(date), year: date.getFullYear() };
}

function currentRange() {
  return customRange.value?.year ? yearRange() : customRange.value;
}

function periodQuery() {
  const params = new URLSearchParams();
  const range = currentRange();
  if (range) {
    const { from, to } = dayRange(range.fromDay, range.toDay);
    params.set("from", String(from));
    params.set("to", String(to));
  } else params.set("days", period.value === null ? "all" : String(period.value));
  if (genre.value) params.set("genre", genre.value);
  return params;
}

export async function loadMusic() {
  try {
    music.value = await get("/api/music");
  } catch (error) {
    reportError(error);
  }
  return music.value;
}

// Both follow the period and genre chosen when they were asked; an answer
// for a choice that has since changed is dropped.
export async function loadTop() {
  const query = periodQuery();
  try {
    const data = await get(`/api/music/top?${query}&limit=50`);
    if (periodQuery().toString() === query.toString()) top.value = data;
  } catch (error) {
    reportError(error);
  }
}

export async function loadTimeline() {
  const query = periodQuery();
  try {
    const data = await get(`/api/music/timeline?${query}&tz=${encodeURIComponent(zone())}`);
    if (periodQuery().toString() === query.toString()) timeline.value = data;
  } catch (error) {
    reportError(error);
  }
}

export function openArtist(key) {
  if (!key) return;
  artist.value = null;
  artistKey.value = key;
}

export function closeArtist() {
  artistKey.value = null;
  artist.value = null;
}

// One artist over the chosen period. The genre filter doesn't narrow it.
export async function loadArtist() {
  const ask = () => {
    const query = periodQuery();
    query.delete("genre");
    query.set("key", artistKey.value || "");
    query.set("tz", zone());
    return query.toString();
  };
  if (!artistKey.value) return;
  const asked = ask();
  // An answer for an artist or period that has since changed is dropped.
  try {
    const data = await get(`/api/music/artist?${asked}`);
    if (ask() === asked) artist.value = data;
  } catch (error) {
    if (ask() === asked) artist.value = { key: artistKey.value, error: error.message };
  }
}

export async function loadGenres() {
  try {
    genres.value = await get("/api/music/genres");
  } catch (error) {
    reportError(error);
  }
}

export function minutes(ms) {
  return Math.round((ms || 0) / 60_000).toLocaleString();
}

export function hours(ms) {
  const value = (ms || 0) / 3_600_000;
  return value >= 100 ? Math.round(value).toLocaleString() : value.toFixed(1);
}

export function describePeriod() {
  const range = currentRange();
  if (range?.year) return `${range.year} so far`;
  if (range) return `${shortDate(`${range.fromDay}T00:00:00`)} to ${shortDate(`${range.toDay}T00:00:00`)}`;
  return describeWindow(period.value);
}

export async function loadRecent() {
  try {
    recent.value = (await get("/api/music/recent?limit=30")).plays;
  } catch (error) {
    reportError(error);
  }
}

export async function musicAction(path, body, message) {
  try {
    const result = await post(`/api/music/${path}`, body);
    await loadMusic();
    if (message) toast(typeof message === "function" ? message(result) : message);
    return result;
  } catch (error) {
    reportError(error);
    return null;
  }
}

export function describeWindow(days) {
  if (!days) return "all time";
  if (days % 365 === 0) return days === 365 ? "the last year" : `the last ${days / 365} years`;
  return days === 1 ? "the last day" : `the last ${days} days`;
}

export function describeInterval(hours) {
  const known = INTERVALS.find((entry) => entry.hours === hours);
  if (known) return known.label.toLowerCase();
  return hours % 24 === 0 ? `every ${hours / 24} days` : `every ${hours} hours`;
}

export function ago(iso) {
  return iso ? timeAgo(iso) : "never";
}

export function until(iso) {
  if (!iso) return "";
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (minutes <= 1) return "at the next check";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} days`;
}

export function shortDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
