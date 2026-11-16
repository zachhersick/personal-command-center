import { createServer } from "node:http";
import { createPlanApi, WALLPAPER_TYPES, wallpapersDir } from "./server/plan/routes.js";
import { createAgentsApi } from "./server/agents/routes.js";
import { createRemoteAgents } from "./server/agents/remote.js";
import { createAppUpdateApi } from "./server/app-update.js";
import { isCrossSite, isJsonType, isLocalHost, readJsonBody } from "./server/http.js";
import { createCloudSync } from "./server/cloud-sync.js";
import { createJobsApi } from "./server/jobs/routes.js";
import { createJobsInbox } from "./server/jobs/gmail.js";
import { createMusicApi } from "./server/music/routes.js";
import { createMusicService } from "./server/music/service.js";
import { createMusicBrainz } from "./server/music/musicbrainz.js";
import { LOOKUP_GAP_MS } from "./server/music/engine.js";
import { createWallpaperEngine } from "./server/wallpaper-engine.js";
import { hostname } from "node:os";
import { readFile, realpath, stat } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { projectConnection } from "./server/project-connections.js";
import { createProjects } from "./server/projects.js";
import { getOpenCommand, normalizeConfigPaths, resolveVscodeCommand } from "./server/platform.js";
import {
  loadSyncedRuntimeState,
  mergeRuntimeStates,
  saveSyncedRuntimeState,
  readJsonWithBackup
} from "./server/shared-state.js";
import {
  beginSpotifyConnect,
  controlSpotifyPlayback,
  disconnectSpotify,
  finishSpotifyConnect,
  listSpotifyDevices,
  setSpotifyVolume,
  spotifyStatus,
  transferSpotifyPlayback
} from "./server/spotify.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
let dataRoot = resolve(process.env.JARVIS_DATA_DIR || __dirname);
let configPath = join(dataRoot, "config", "jarvis.config.json");
const publicDir = join(__dirname, "public");
let taskMutationQueue = Promise.resolve();

function serializeTaskMutation(work) {
  const result = taskMutationQueue.then(work, work);
  taskMutationQueue = result.catch(() => {});
  return result;
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json"
};

// Frontend libraries served straight from node_modules. Only these packages and
// only script files are exposed.
const VENDOR_PACKAGES = new Set(["preact", "htm", "@preact/signals", "@preact/signals-core"]);
const VENDOR_EXTENSIONS = new Set([".js", ".mjs", ".map"]);

async function loadConfig() {
  const raw = await readFile(configPath, "utf8");
  return normalizeConfigPaths(JSON.parse(raw), { baseDir: dataRoot });
}

let runtimeAccess = Promise.resolve();
function withRuntimeAccess(work) {
  const result = runtimeAccess.then(work, work);
  runtimeAccess = result.catch(() => {});
  return result;
}

async function loadRuntimeState() {
  return withRuntimeAccess(() => loadSyncedRuntimeState(dataRoot, { localFirst: true }));
}

async function saveRuntimeState(nextState, options = {}) {
  return withRuntimeAccess(async () => {
    const latest = await readJsonWithBackup(join(dataRoot, "data", "runtime-state.local.json"));
    return saveSyncedRuntimeState(dataRoot, mergeRuntimeStates(nextState, latest), { ...options, localFirst: true });
  });
}

const projects = createProjects({ run: (command, args, options) => run(command, args, options) });

// Focus backgrounds can also come from Wallpaper Engine's video wallpapers,
// read where Steam put them.
const wallpaperEngine = createWallpaperEngine();

const planApi = createPlanApi({
  resourceRoot: __dirname,
  dataRoot: () => dataRoot,
  loadConfig,
  loadRuntimeState,
  saveRuntimeState,
  serializeTaskMutation,
  sendJson,
  openTarget: (target) => openTarget(target),
  desktopActions: () => globalThis.jarvisDesktopActions,
  wallpaperEngine: () => wallpaperEngine,
  // Tests pin the clock so plan dates stay inside the roadmap window.
  now: () => process.env.JARVIS_PLAN_NOW || new Date().toISOString(),
  onChange: () => cloudSync.kick()
});

const agentsApi = createAgentsApi({
  dataRoot: () => dataRoot,
  loadConfig,
  sendJson,
  run: (command, args, options) => run(command, args, options),
  openInEditor: async (target) => run(getVscodeCommand(await loadConfig()), [target], { timeout: 4000 })
});
process.once("exit", () => agentsApi.shutdown());

// Syncs the plan with jarvis.example.com once a device token is connected.
const cloudSync = createCloudSync({
  dataRoot: () => dataRoot,
  loadRuntimeState,
  saveRuntimeState,
  serializeTaskMutation,
  boardSnapshot: async () => agentsApi.registry.boardPayload(await agentsApi.registry.snapshot()),
  remoteAgents: createRemoteAgents({ agentsApi, dataRoot: () => dataRoot }),
  hostname: hostname()
});

// The job pipeline. The Gmail inbox and the old-data import only exist here,
// on the desktop; the cloud serves the same routes without them.
const jobsInbox = createJobsInbox({
  dataRoot: () => dataRoot,
  desktopActions: () => globalThis.jarvisDesktopActions,
  applySignals: (signals, options) => jobsApi.applyFromInbox(signals, options)
});

const jobsApi = createJobsApi({
  loadConfig,
  loadRuntimeState,
  saveRuntimeState,
  serializeTaskMutation,
  sendJson,
  now: () => process.env.JARVIS_PLAN_NOW || new Date().toISOString(),
  onChange: () => cloudSync.kick(),
  inbox: jobsInbox,
  legacySources: async () => ({
    board: await readJsonWithBackup(join(dataRoot, "data", "job-board-cache.local.json"), null),
    runway: await readJsonWithBackup(join(dataRoot, "data", "runway-cache.local.json"), null),
    runtime: await loadRuntimeState()
  }),
  appUrl: async () => (await cloudSync.status()).url
});

// Listening history and synced playlists. Tests and the sandbox swap in a
// fake Spotify through startServer({ spotifyFetch }), and drop the pause
// between genre lookups with musicEnrichGapMs. With a fake Spotify the real
// MusicBrainz is never asked; pass musicBrainzFetch to fake it too.
let spotifyFetch = (...args) => fetch(...args);
let musicBrainzFetch = (...args) => fetch(...args);
let musicEnrichGapMs = LOOKUP_GAP_MS;
// MusicBrainz allows about a request a second; only a fake goes faster.
let musicBrainzGapMs = 1100;
const musicBrainz = createMusicBrainz({ fetchImpl: (...args) => musicBrainzFetch(...args), gapMs: () => musicBrainzGapMs });
const musicService = createMusicService({
  dataRoot: () => dataRoot,
  loadRuntimeState,
  saveRuntimeState,
  serializeTaskMutation,
  onChange: () => cloudSync.kick(),
  cloudSettings: () => cloudSync.credentials(),
  desktopActions: () => globalThis.jarvisDesktopActions,
  spotifyFetch: (...args) => spotifyFetch(...args),
  enrichGapMs: () => musicEnrichGapMs,
  genreSource: () => (musicBrainzFetch ? musicBrainz : null)
});

const musicApi = createMusicApi({
  engine: musicService.engine,
  status: () => musicService.status(),
  loadRuntimeState,
  saveRuntimeState,
  serializeTaskMutation,
  sendJson,
  onChange: () => cloudSync.kick(),
  importFolder: (folder, options) => musicService.importFolder(folder, options),
  pickFolder: () => musicService.pickFolder(),
  poll: () => musicService.poll()
});

const appUpdateApi = createAppUpdateApi({
  sendJson,
  desktopActions: () => globalThis.jarvisDesktopActions,
  focusActive: () => planApi.focusActive(),
  runningAgents: () => agentsApi.launcher.active.size
});

function sendJson(res, body, status = 200, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers
  });
  res.end(payload);
}

function sendText(res, body, status = 200, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}


async function run(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: options.timeout ?? 4500,
      cwd: options.cwd ?? dataRoot,
      input: options.input,
      windowsHide: true
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout?.trim() || "",
      stderr: error.stderr?.trim() || error.message
    };
  }
}

async function openTarget(target, options = {}) {
  const spec = getOpenCommand(target, options.platform);
  return run(spec.command, spec.args, options);
}

export function getVscodeCommand(config, env = process.env, platform = process.platform, exists = existsSync) {
  return resolveVscodeCommand(config, { env, platform, exists });
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/jobs" || url.pathname.startsWith("/api/jobs/")) return jobsApi.handle(req, res, url);
  if (url.pathname === "/api/music" || url.pathname.startsWith("/api/music/")) return musicApi.handle(req, res, url);
  if (url.pathname.startsWith("/api/plan/") || url.pathname.startsWith("/api/focus/")) {
    return planApi.handle(req, res, url);
  }

  if (url.pathname === "/api/session" && req.method === "GET") {
    return sendJson(res, { ok: true, mode: "desktop" });
  }

  if (url.pathname === "/api/cloud/status" && req.method === "GET") return sendJson(res, { ok: true, ...(await cloudSync.status()) });
  if (url.pathname === "/api/cloud/connect" && req.method === "POST") return sendJson(res, { ok: true, ...(await cloudSync.connect(await readJsonBody(req))) });
  if (url.pathname === "/api/cloud/disconnect" && req.method === "POST") return sendJson(res, { ok: true, ...(await cloudSync.disconnect()) });
  if (url.pathname === "/api/cloud/sync" && req.method === "POST") {
    // Sync now covers the agent board and phone commands too, not just the plan.
    const result = await cloudSync.syncNow();
    await cloudSync.pushBoard();
    return sendJson(res, { ok: true, ...result });
  }
  if (url.pathname === "/api/cloud/phone-agents" && req.method === "POST") return sendJson(res, { ok: true, ...(await cloudSync.setPhoneAgents((await readJsonBody(req)).enabled === true)) });

  if (url.pathname === "/api/app/update" || url.pathname.startsWith("/api/app/update/")) {
    return appUpdateApi.handle(req, res, url);
  }

  if (url.pathname === "/api/agents" || url.pathname.startsWith("/api/agents/")) {
    return agentsApi.handle(req, res, url);
  }

  if (url.pathname === "/api/projects" && req.method === "GET") {
    return sendJson(res, { ok: true, ...(await projects.list(await loadConfig(), { force: url.searchParams.get("refresh") === "1" })) });
  }

  if (url.pathname === "/api/project/open" && req.method === "POST") {
    const config = await loadConfig();
    const body = await readJsonBody(req);
    const project = (config.workspace.projects || []).find((item) => item.id === String(body.projectId || ""));
    if (!project) return sendJson(res, { ok: false, error: "Configured project was not found." }, 404);
    const connection = projectConnection(project, await projects.repoSnapshot(project.path));
    if (!connection.connected) return sendJson(res, { ok: false, error: connection.reason, connection }, 400);
    const result = await run(getVscodeCommand(config), [project.path], { timeout: 2500 });
    return sendJson(res, { ok: result.ok, projectId: project.id, target: project.path, connection, note: result.ok ? "VS Code launch requested." : result.stderr });
  }

  if (url.pathname === "/api/integrations/spotify/status") {
    return sendJson(res, { ok: true, ...(await spotifyStatus(dataRoot)) });
  }

  if (url.pathname === "/api/integrations/spotify/devices") {
    try {
      return sendJson(res, { ok: true, devices: await listSpotifyDevices(dataRoot) });
    } catch (error) {
      const status = [401, 403, 409, 429].includes(error.status) ? error.status : 502;
      return sendJson(res, { ok: false, error: error.message, retryAfterMs: error.retryAfterMs || 0 }, status);
    }
  }

  if (url.pathname === "/api/integrations/spotify/connect" && req.method === "POST") {
    const body = await readJsonBody(req);
    const host = String(req.headers.host || "");
    if (!/^127\.0\.0\.1:\d+$/.test(host)) return sendJson(res, { ok: false, error: "Spotify requires a 127.0.0.1 loopback callback." }, 400);
    try {
      const redirectUri = `http://${host}/api/integrations/spotify/callback`;
      return sendJson(res, { ok: true, authorizationUrl: await beginSpotifyConnect(dataRoot, { ...body, redirectUri }) });
    } catch (error) {
      return sendJson(res, { ok: false, error: error.message }, 400);
    }
  }

  if (url.pathname === "/api/integrations/spotify/callback") {
    const host = String(req.headers.host || "");
    const redirectUri = `http://${host}/api/integrations/spotify/callback`;
    try {
      await finishSpotifyConnect(dataRoot, {
        state: url.searchParams.get("state"),
        code: url.searchParams.get("code"),
        redirectUri
      });
      return sendText(res, "Spotify connected. You can close this window and return to Jarvis.");
    } catch (error) {
      return sendText(res, `Spotify connection failed: ${error.message}`, 400);
    }
  }

  if (url.pathname === "/api/integrations/spotify/playback" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const action = String(body.action || "");
      const playback = action === "volume"
        ? await setSpotifyVolume(dataRoot, body.volumePercent)
        : action === "device"
          ? await transferSpotifyPlayback(dataRoot, body.deviceId)
          : await controlSpotifyPlayback(dataRoot, action);
      return sendJson(res, { ok: true, playback });
    } catch (error) {
      const status = [400, 401, 403, 404, 409, 429].includes(error.status) ? error.status : 502;
      const message = status === 403
        ? "Spotify Premium and an unrestricted active device are required for playback controls."
        : status === 404
          ? "Open Spotify and start playback on a device first."
          : error.message;
      return sendJson(res, { ok: false, error: message, retryAfterMs: error.retryAfterMs || 0 }, status);
    }
  }

  if (url.pathname === "/api/integrations/spotify/open" && req.method === "POST") {
    const native = await openTarget("spotify:", { timeout: 2500 });
    const result = native.ok ? native : await openTarget("https://open.spotify.com/", { timeout: 2500 });
    return sendJson(res, { ok: result.ok, note: result.ok ? "Spotify launch requested." : result.stderr || "Spotify could not be opened." }, result.ok ? 200 : 502);
  }

  if (url.pathname === "/api/integrations/spotify/disconnect" && req.method === "POST") {
    return sendJson(res, { ok: true, ...(await disconnectSpotify(dataRoot)) });
  }

  return sendJson(res, { error: "Not found" }, 404);
}

// Resolve a request path inside root, refusing anything that escapes it.
export function resolveInside(root, requested) {
  let decoded;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const target = resolve(root, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return target;
}

async function serveFile(res, filePath, headers = {}) {
  const ext = extname(filePath).toLowerCase();
  const body = await readFile(filePath);
  res.writeHead(200, { "content-type": mimeTypes[ext] || "application/octet-stream", ...headers });
  res.end(body);
}

async function serveVendor(res, url) {
  const rest = url.pathname.slice("/vendor/".length);
  const scoped = rest.startsWith("@");
  const parts = rest.split("/");
  const pkg = scoped ? parts.slice(0, 2).join("/") : parts[0];
  const inner = parts.slice(scoped ? 2 : 1).join("/");
  if (!VENDOR_PACKAGES.has(pkg) || !VENDOR_EXTENSIONS.has(extname(inner).toLowerCase())) return sendText(res, "Not found", 404);
  const root = join(__dirname, "node_modules", pkg);
  const filePath = resolveInside(root, inner);
  if (!filePath) return sendText(res, "Forbidden", 403);
  if (!existsSync(filePath) || !(await stat(filePath)).isFile()) return sendText(res, "Not found", 404);
  return serveFile(res, filePath, { "cache-control": "public, max-age=86400" });
}

async function serveWallpaper(req, res, url) {
  // Wallpaper Engine videos live in Steam's folder: /wallpapers/we/<workshop id>.
  const engineMatch = /^\/wallpapers\/we\/(\d+)(\/preview)?$/.exec(url.pathname);
  if (engineMatch) {
    const item = await wallpaperEngine.find(engineMatch[1]);
    if (!item) return sendText(res, "Not found", 404);
    const wanted = engineMatch[2] ? item.preview : item.path;
    if (!wanted || !existsSync(wanted) || !WALLPAPER_TYPES[extname(wanted).toLowerCase()]) return sendText(res, "Not found", 404);
    return sendMedia(req, res, await realpath(wanted));
  }

  let name;
  try {
    name = decodeURIComponent(url.pathname.slice("/wallpapers/".length));
  } catch {
    return sendText(res, "Bad request", 400);
  }
  if (!name || name !== basename(name) || name.includes("\0") || !WALLPAPER_TYPES[extname(name).toLowerCase()]) return sendText(res, "Not found", 404);
  const dir = wallpapersDir(dataRoot);
  const filePath = join(dir, name);
  if (!existsSync(filePath)) return sendText(res, "Not found", 404);
  const [realDir, realFile] = await Promise.all([realpath(dir), realpath(filePath)]);
  const rel = relative(realDir, realFile);
  if (rel.startsWith("..") || isAbsolute(rel)) return sendText(res, "Forbidden", 403);
  return sendMedia(req, res, realFile);
}

// Streams a wallpaper, honouring Range so long videos can seek.
async function sendMedia(req, res, realFile) {
  const info = await stat(realFile);
  if (!info.isFile()) return sendText(res, "Not found", 404);
  const type = mimeTypes[extname(realFile).toLowerCase()] || "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
    const end = Math.min(range[1] && range[2] ? Number(range[2]) : info.size - 1, info.size - 1);
    if (start > end || start >= info.size) {
      res.writeHead(416, { "content-range": `bytes */${info.size}` });
      return res.end();
    }
    res.writeHead(206, {
      "content-type": type,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${info.size}`,
      "accept-ranges": "bytes"
    });
    return createReadStream(realFile, { start, end }).pipe(res);
  }
  res.writeHead(200, { "content-type": type, "content-length": info.size, "accept-ranges": "bytes" });
  return createReadStream(realFile).pipe(res);
}

async function serveStatic(res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = resolveInside(publicDir, requested);
  if (!filePath) return sendText(res, "Forbidden", 403);
  if (!existsSync(filePath) || !(await stat(filePath)).isFile()) return sendText(res, "Not found", 404);
  return serveFile(res, filePath, { "cache-control": "no-cache" });
}

function createJarvisServer() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        // Only this computer may talk to the API. A loopback Host header also
        // defeats DNS-rebinding pages that try to read local data.
        if (!isLocalHost(req.headers.host)) return sendJson(res, { ok: false, error: "Jarvis only answers requests from this computer." }, 403);
        // Writes must come from Jarvis's own page and be JSON: a cross-site
        // page can't send JSON without a CORS preflight, which this server
        // never approves.
        if (!["GET", "HEAD"].includes(req.method)) {
          if (isCrossSite(req)) return sendJson(res, { ok: false, error: "Jarvis only accepts changes from its own page." }, 403);
          if (!isJsonType(req.headers["content-type"])) return sendJson(res, { ok: false, error: "Send JSON with content-type application/json." }, 415);
        }
        return await handleApi(req, res, url);
      }
      if (url.pathname.startsWith("/vendor/")) return await serveVendor(res, url);
      if (url.pathname.startsWith("/wallpapers/")) return await serveWallpaper(req, res, url);
      return await serveStatic(res, url);
    } catch (error) {
      sendJson(res, { ok: false, error: error.message }, error.status || 500);
    }
  });
}

export async function startServer(options = {}) {
  dataRoot = resolve(options.dataRoot || process.env.JARVIS_DATA_DIR || __dirname);
  configPath = join(dataRoot, "config", "jarvis.config.json");
  const config = await loadConfig();
  const port = Number(options.port ?? process.env.JARVIS_PORT ?? config.dashboard.port ?? 4317);
  const host = options.host || "127.0.0.1";
  const server = createJarvisServer();

  await loadRuntimeState();
  await planApi.reconcile().catch((error) => console.error("Focus reconcile:", error.message));

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  server.once("close", () => {
    agentsApi.shutdown();
    cloudSync.stop();
    jobsInbox.stop();
    musicService.stop();
  });
  spotifyFetch = options.spotifyFetch || ((...args) => fetch(...args));
  musicEnrichGapMs = options.musicEnrichGapMs ?? LOOKUP_GAP_MS;
  musicBrainzFetch = options.musicBrainzFetch || (options.spotifyFetch ? null : (...args) => fetch(...args));
  musicBrainzGapMs = options.musicBrainzFetch ? (options.musicEnrichGapMs ?? 1100) : 1100;
  if (options.jobsInbox !== false) jobsInbox.start();
  if (options.music !== false) musicService.start();
  if (options.cloudSync !== false && process.env.JARVIS_DISABLE_CLOUD_SYNC !== "1") void cloudSync.start().catch((error) => console.error("Cloud sync:", error.message));
  const actualPort = server.address().port;
  console.log(`Jarvis dashboard online at http://${host}:${actualPort}`);
  return { server, port: actualPort, host };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await startServer();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
