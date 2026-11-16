import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { importSiteRecords } from "../server/plan/import.js";
import { ensurePlanState } from "../server/plan/state.js";
import { safeWriteJson } from "../server/shared-state.js";

const PLAN = "data/plan/roadmap-plan.v1.json";
const SITE_IMPORT = "data/plan-site-import.local.json";
const MARKER = "data/plan-installation.local.json";
const VERSION = 1;

async function readJson(path, fallback = {}) {
  // A damaged existing file must stop the install, never become an empty state.
  return existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : fallback;
}

async function copyMissing(source, target) {
  if (existsSync(target) || !existsSync(source)) return;
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

// Installs the roadmap plan into a desktop workspace once: backs up the old
// state and roadmap, creates the wallpapers folder and imports progress that
// was exported from the hosted roadmap site.
export async function installPlan({ dataRoot, resourceRoot, legacyRoot = "", now = new Date() }) {
  if (!existsSync(join(resourceRoot, PLAN))) return { installed: false };
  const markerPath = join(dataRoot, MARKER);
  const marker = await readJson(markerPath);
  if (Number(marker.version || 0) >= VERSION) return { installed: false, version: marker.version };

  const stamp = now.toISOString();
  const statePath = join(dataRoot, "data/runtime-state.local.json");
  const state = await readJson(statePath);
  const backup = join(dataRoot, "backups/plan-v1");
  await copyMissing(statePath, join(backup, "data/runtime-state.local.json"));
  await copyMissing(join(dataRoot, "data/career-roadmap.local.html"), join(backup, "data/career-roadmap.local.html"));
  await mkdir(join(dataRoot, "wallpapers"), { recursive: true });

  const sources = [join(dataRoot, SITE_IMPORT), legacyRoot && join(legacyRoot, SITE_IMPORT)].filter(Boolean);
  const source = sources.find((path) => existsSync(path));
  let imported = null;
  if (source) {
    const siteExport = await readJson(source);
    const { plan, result } = importSiteRecords(ensurePlanState(state.plan), siteExport, stamp);
    imported = result;
    await copyMissing(source, join(dataRoot, SITE_IMPORT));
    await safeWriteJson(statePath, { ...state, plan });
  }

  await safeWriteJson(markerPath, { version: VERSION, installedAt: stamp, imported: Boolean(imported) });
  return { installed: true, version: VERSION, imported };
}
