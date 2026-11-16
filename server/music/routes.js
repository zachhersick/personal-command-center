// HTTP routes for the music tab. Shared by the desktop server and the cloud;
// the desktop also provides imports, a folder picker and Spotify status.
import { httpError, isLocalHost, readJsonBody } from "../http.js";
import { ensurePlanState } from "../plan/state.js";
import { cleanGenre } from "./query.js";
import { deleteRule, saveRule } from "./rules.js";

// Artist keys are folded names (identity.js); the cloud stores up to 200.
const MAX_ARTIST_KEY = 200;

function windowParam(value) {
  if (value === "all" || value === "" || value === null) return null;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 36_500) throw httpError(400, "days must be 1 to 36500, or all.");
  return days;
}

// days=…, or from= and to= in ms; plus an optional genre.
function periodParams(params) {
  const from = params.get("from");
  const to = params.get("to");
  const genre = cleanGenre(params.get("genre"));
  if (from !== null || to !== null) {
    const start = Number(from);
    const end = Number(to);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start >= end || start < 0) throw httpError(400, "from and to must be times in ms, from before to.");
    return { from: start, to: end, genre };
  }
  return { windowDays: windowParam(params.get("days") ?? "30"), genre };
}

function zoneParam(value, fallback) {
  if (!value) return fallback;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw httpError(400, "Unknown time zone.");
  }
}

function limitParam(value, fallback, max) {
  const limit = value === null ? fallback : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) throw httpError(400, `limit must be 1 to ${max}.`);
  return limit;
}

// deps: engine (createMusicEngine), status() -> { spotify, tracking, cloud... },
// loadRuntimeState/saveRuntimeState/serializeTaskMutation like the jobs API,
// optional importFolder(folder), pickFolder(), poll().
export function createMusicApi(deps) {
  const now = () => (deps.now ? deps.now() : new Date().toISOString());
  const allowWrite = deps.allowWrite || ((request) => isLocalHost(request.headers.host));

  function mutate(work) {
    return deps.serializeTaskMutation(async () => {
      const current = await deps.loadRuntimeState();
      const { plan, result } = await work(ensurePlanState(current.plan));
      if (plan) {
        await deps.saveRuntimeState({ ...current, plan }, { localFirst: true });
        deps.onChange?.();
      }
      return result;
    });
  }

  async function overview() {
    return {
      status: await deps.status(),
      playlists: await deps.engine.playlists(),
      lookups: await deps.engine.lookups(),
      canImport: Boolean(deps.importFolder)
    };
  }

  async function handle(req, res, url) {
    const send = deps.sendJson;
    const path = url.pathname;
    if (req.method === "GET") {
      if (path === "/api/music") return send(res, { ok: true, ...(await overview()) });
      if (path === "/api/music/top") {
        return send(res, { ok: true, ...(await deps.engine.top({ ...periodParams(url.searchParams), limit: limitParam(url.searchParams.get("limit"), 50, 200) })) });
      }
      if (path === "/api/music/timeline") {
        return send(res, { ok: true, ...(await deps.engine.timeline({ ...periodParams(url.searchParams), timeZone: zoneParam(url.searchParams.get("tz"), deps.timeZone || "UTC") })) });
      }
      if (path === "/api/music/artist") {
        const key = String(url.searchParams.get("key") || "").trim();
        if (!key || key.length > MAX_ARTIST_KEY) throw httpError(400, `key must be 1 to ${MAX_ARTIST_KEY} characters.`);
        const { genre, ...period } = periodParams(url.searchParams);
        return send(res, { ok: true, ...(await deps.engine.artist({ key, ...period, timeZone: zoneParam(url.searchParams.get("tz"), deps.timeZone || "UTC"), limit: limitParam(url.searchParams.get("limit"), 10, 50) })) });
      }
      if (path === "/api/music/genres") return send(res, { ok: true, ...(await deps.engine.genres()) });
      if (path === "/api/music/recent") return send(res, { ok: true, plays: await deps.engine.recent(limitParam(url.searchParams.get("limit"), 50, 200)) });
      return send(res, { ok: false, error: "Not found" }, 404);
    }
    if (req.method !== "POST") return send(res, { ok: false, error: "Method not allowed" }, 405);
    if (!allowWrite(req)) return send(res, { ok: false, error: "Music changes are only accepted from this computer." }, 403);
    const body = await readJsonBody(req);

    if (path === "/api/music/playlists/save") return send(res, { ok: true, ...(await mutate((plan) => saveRule(plan, body, now()))) });
    if (path === "/api/music/playlists/delete") return send(res, { ok: true, ...(await mutate((plan) => deleteRule(plan, String(body.id || ""), now()))) });
    if (path === "/api/music/playlists/preview") return send(res, { ok: true, preview: await deps.engine.preview(body) });
    if (path === "/api/music/playlists/sync") {
      const result = await deps.engine.syncRule(String(body.id || ""));
      deps.onChange?.();
      return send(res, { ok: true, result, playlists: await deps.engine.playlists() });
    }
    if (path === "/api/music/playlists/recreate") {
      await deps.engine.forget(String(body.id || ""));
      deps.onChange?.();
      return send(res, { ok: true, playlists: await deps.engine.playlists() });
    }
    if (path === "/api/music/poll") {
      const result = deps.poll ? await deps.poll() : await deps.engine.poll();
      return send(res, { ok: true, result, status: await deps.status() });
    }
    if (path === "/api/music/import") {
      if (!deps.importFolder) throw httpError(409, "Import listening history from the Jarvis desktop app on the computer that has the files.");
      // Without apply it only reports what would change.
      return send(res, { ok: true, result: await deps.importFolder(String(body.folder || "").trim(), { apply: body.apply === true }), status: await deps.status() });
    }
    if (path === "/api/music/pick-folder") {
      if (!deps.pickFolder) throw httpError(409, "Folder picking is only available in the desktop app.");
      return send(res, { ok: true, folder: await deps.pickFolder() });
    }
    return send(res, { ok: false, error: "Not found" }, 404);
  }

  return {
    async handle(req, res, url) {
      try {
        return await handle(req, res, url);
      } catch (error) {
        return deps.sendJson(res, { ok: false, error: error.message, retryAfterMs: error.retryAfterMs || 0 }, error.status || 500);
      }
    }
  };
}
