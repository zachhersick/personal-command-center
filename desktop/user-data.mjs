import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";
import { normalizeConfigPaths } from "../server/platform.js";
import { installPlan } from "./plan-install.mjs";

const CONFIG_FILES = ["secrets.local.json", "google-calendar-oauth.local.json", "spotify-oauth.local.json"];

// Only named application files are imported. Environment files are never read.
export async function initializeUserData({ dataRoot, resourceRoot, legacyRoot = "", now = new Date() }) {
  const imported = await importLegacyUserData({ dataRoot, resourceRoot, legacyRoot, now });
  const plan = await installPlan({ dataRoot, resourceRoot, legacyRoot, now });
  return { ...imported, plan };
}

async function importLegacyUserData({ dataRoot, resourceRoot, legacyRoot, now }) {
  const marker = join(dataRoot, "migration.json");
  if (existsSync(marker)) return { dataRoot, imported: false };
  await mkdir(join(dataRoot, "config"), { recursive: true });
  await mkdir(join(dataRoot, "data"), { recursive: true });
  const legacyConfig = legacyRoot && join(legacyRoot, "config", "jarvis.config.json");
  const importing = Boolean(legacyConfig && existsSync(legacyConfig) && resolve(legacyRoot) !== resolve(dataRoot));
  const backup = join(dataRoot, "backups", "initial-import");
  const copied = [];
  async function copyOnce(source, destination, name) {
    if (!existsSync(source) || existsSync(destination)) return;
    await mkdir(join(backup, name === "data" ? "data" : "config"), { recursive: true });
    await copyFile(source, destination);
    await copyFile(source, join(backup, name, destination.split(/[\\/]/).pop()));
    copied.push(destination);
  }
  const destinationConfig = join(dataRoot, "config", "jarvis.config.json");
  if (!existsSync(destinationConfig)) {
    const source = importing ? legacyConfig : join(resourceRoot, "config", "desktop.defaults.json");
    let config = JSON.parse(await readFile(source, "utf8"));
    config = normalizeConfigPaths(config, { baseDir: importing ? legacyRoot : dataRoot });
    if (importing) {
      const remap = (path) => {
        const rel = relative(resolve(legacyRoot), path);
        return rel && !rel.startsWith("..") && !isAbsolute(rel) && /^data[\\/]/i.test(rel) ? join(dataRoot, rel) : path;
      };
      for (const [name, keys] of Object.entries({ jobs: ["localResultsFiles"], career: ["todoFiles", "roadmapFiles"], googleDrive: ["contextFiles"], googleCalendar: ["contextFiles"], gmail: ["contextFiles"] })) {
        for (const key of keys) if (config.integrations?.[name]?.[key]) config.integrations[name][key] = config.integrations[name][key].map(remap);
      }
    }
    await writeFile(destinationConfig, JSON.stringify(config, null, 2) + "\n", "utf8");
  }
  if (importing) {
    for (const file of CONFIG_FILES) await copyOnce(join(legacyRoot, "config", file), join(dataRoot, "config", file), "config");
    const sourceData = join(legacyRoot, "data");
    if (existsSync(sourceData)) for (const file of await readdir(sourceData, { withFileTypes: true })) {
      if (file.isFile() && !file.name.startsWith(".env") && /\.(json|md|html)(\.bak)?$/i.test(file.name)) await copyOnce(join(sourceData, file.name), join(dataRoot, "data", file.name), "data");
    }
    // Keep a copy of the unmodified source configuration beside the imported state.
    await mkdir(join(backup, "config"), { recursive: true });
    await copyFile(legacyConfig, join(backup, "config", "jarvis.config.json"));
  }
  await writeFile(marker, JSON.stringify({ version: 1, importedFrom: importing ? resolve(legacyRoot) : null, completedAt: now.toISOString(), files: copied.length }, null, 2) + "\n");
  return { dataRoot, imported: importing };
}
