// Focus backgrounds can also come from Wallpaper Engine's Steam Workshop
// folder. Only its *video* wallpapers are usable: "scene" and "web" ones are
// Wallpaper Engine's own formats and only render inside that app. Files are
// read where Steam put them, never copied into the workspace and never synced,
// so a 1.5 GB wallpaper stays exactly where it is.
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export const WALLPAPER_ENGINE_APP = "431960";
const PLAYABLE = new Set([".mp4", ".webm"]);
const CACHE_MS = 60_000;
const MAX_ITEMS = 200;

// Every "path" in steamapps/libraryfolders.vdf, which lists Steam's libraries.
export function parseLibraryPaths(vdf) {
  return [...String(vdf || "").matchAll(/"path"\s*"([^"]+)"/g)].map((match) => match[1].replace(/\\\\/g, "\\"));
}

// Steam installs, plus the usual second-drive library folders: Steam's own vdf
// doesn't always list a library left behind by an older install.
export async function steamRoots({ env = process.env, exists = existsSync, read = readFile } = {}) {
  const roots = [];
  const add = (dir) => dir && exists(dir) && !roots.includes(dir) && roots.push(dir);
  // Tests point this at a fake Steam folder, and then it is the only one.
  if (env.JARVIS_WALLPAPER_ENGINE_STEAM) {
    add(env.JARVIS_WALLPAPER_ENGINE_STEAM);
    return roots;
  }
  add(env.SteamPath);
  for (const base of [env["ProgramFiles(x86)"], env.ProgramFiles, env.ProgramW6432]) add(base && join(base, "Steam"));
  for (const library of [...roots]) {
    const vdf = join(library, "steamapps", "libraryfolders.vdf");
    if (!exists(vdf)) continue;
    try {
      for (const path of parseLibraryPaths(await read(vdf, "utf8"))) add(path);
    } catch {
      // An unreadable vdf just means fewer libraries.
    }
  }
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    for (const name of ["SteamLibrary", "Steam"]) add(`${letter}:\\${name}`);
  }
  return roots;
}

export function workshopDirs(roots, exists = existsSync) {
  return roots.map((root) => join(root, "steamapps", "workshop", "content", WALLPAPER_ENGINE_APP)).filter((dir) => exists(dir));
}

function cleanTitle(value, fallback) {
  const title = String(value || "").replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 120) : fallback;
}

// One usable wallpaper per Workshop item, or null with the reason it was skipped.
async function readItem(dir, id, deps) {
  const { exists, read, info } = deps;
  const file = join(dir, id, "project.json");
  if (!exists(file)) return null;
  let project;
  try {
    project = JSON.parse((await read(file, "utf8")).replace(/^﻿/, ""));
  } catch {
    return { skipped: "unreadable" };
  }
  const type = String(project.type || "").toLowerCase();
  if (type !== "video") return { skipped: type || "unknown" };
  const media = join(dir, id, String(project.file || ""));
  if (!project.file || !PLAYABLE.has(extname(media).toLowerCase()) || !exists(media)) return { skipped: "missing" };
  let size = 0;
  let changed = 0;
  try {
    const stats = await info(media);
    size = stats.size;
    changed = stats.mtimeMs;
  } catch {
    return { skipped: "missing" };
  }
  const preview = ["preview.jpg", "preview.png", "preview.gif", "preview.webp"].map((name) => join(dir, id, name)).find((path) => exists(path)) || "";
  return { item: { id, title: cleanTitle(project.title, `Wallpaper ${id}`), path: media, preview, size, changed } };
}

// The same wallpaper often sits in two libraries; keep one.
export function dedupe(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = `${item.title.toLowerCase()}|${basename(item.path).toLowerCase()}|${item.size}`;
    const current = byKey.get(key);
    if (!current || item.changed > current.changed) byKey.set(key, item);
  }
  return [...byKey.values()].sort((a, b) => a.title.localeCompare(b.title)).slice(0, MAX_ITEMS);
}

export async function scanWorkshop(dirs, { exists = existsSync, read = readFile, list = readdir, info = stat } = {}) {
  const items = [];
  let hidden = 0;
  for (const dir of dirs) {
    let ids = [];
    try {
      ids = await list(dir);
    } catch {
      continue;
    }
    for (const id of ids) {
      if (!/^\d+$/.test(id)) continue;
      const result = await readItem(dir, id, { exists, read, info });
      if (result?.item) items.push(result.item);
      else if (result?.skipped) hidden += 1;
    }
  }
  return { items: dedupe(items), hidden };
}

export function createWallpaperEngine({ platform = process.platform, env = process.env, now = () => Date.now(), fs = {} } = {}) {
  const supported = platform === "win32" || Boolean(env.JARVIS_WALLPAPER_ENGINE_STEAM);
  let cache = null;

  async function load() {
    if (cache && now() - cache.at < CACHE_MS) return cache;
    const dirs = workshopDirs(await steamRoots({ env, exists: fs.exists, read: fs.read }), fs.exists || existsSync);
    const { items, hidden } = dirs.length ? await scanWorkshop(dirs, fs) : { items: [], hidden: 0 };
    cache = { at: now(), dirs, items, hidden };
    return cache;
  }

  return {
    supported,
    // { available, items, hidden }: available is false off Windows or with no Steam.
    async status() {
      if (!supported) return { available: false, items: [], hidden: 0 };
      try {
        const { dirs, items, hidden } = await load();
        return { available: dirs.length > 0, items, hidden };
      } catch {
        return { available: false, items: [], hidden: 0 };
      }
    },
    // Resolve a workshop id to its file, so the route never takes a path.
    async find(id) {
      if (!supported || !/^\d+$/.test(String(id || ""))) return null;
      const { items } = await load();
      return items.find((item) => item.id === String(id)) || null;
    },
    forget() {
      cache = null;
    }
  };
}
