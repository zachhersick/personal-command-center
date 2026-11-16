// HTTP routes for the roadmap plan and focus mode. server.js passes in its
// persistence helpers so every write goes through the same mutation queue and
// iCloud merge as the rest of runtime state.
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { httpError, isLocalHost, readJsonBody } from "../http.js";
import { addDays, daysBetween, getLocalDateKey, isDateKey } from "./dates.js";
import { loadPlanData } from "./data.js";
import { ensurePlanState } from "./state.js";
import { importSiteRecords } from "./import.js";
import { addCustomTask, deleteCustomTask, patchTask, resetTask, triage, updateSettings } from "./mutations.js";
import { dayView, libraryView, neetcodeView, planMeta, portfolioView, rangeView, searchTasks, taskDetail, weekView } from "./views.js";
import { activeSession, exitFocusEarly, extendFocus, focusView, heartbeatFocus, noteFocus, pauseFocus, reconcileFocus, resumeFocus, startFocus, stopFocus } from "./focus.js";
import { addNeetcodeEntry, deleteNeetcodeEntry } from "./neetcode.js";

export const WALLPAPER_TYPES = {
  ".jpg": "image",
  ".jpeg": "image",
  ".png": "image",
  ".webp": "image",
  ".gif": "image",
  ".mp4": "video",
  ".webm": "video"
};
export const SITE_IMPORT_FILE = "plan-site-import.local.json";

export { readJsonBody, isLocalHost };

export function wallpapersDir(dataRoot) {
  return join(dataRoot, "wallpapers");
}

// One shape for both sources, so the picker treats them alike.
export function wallpaperItem({ id, name, kind, url, preview = "", source }) {
  return { id, name, kind, url, preview, source };
}

export async function listWallpapers(dataRoot) {
  const dir = wallpapersDir(dataRoot);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const kind = WALLPAPER_TYPES[extname(entry.name).toLowerCase()];
    if (!kind) continue;
    const info = await stat(join(dir, entry.name));
    files.push({ ...wallpaperItem({ id: `local:${entry.name}`, name: entry.name, kind, url: `/wallpapers/${encodeURIComponent(entry.name)}`, source: "local" }), size: info.size });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

export function createPlanApi(deps) {
  const now = () => (deps.now ? deps.now() : new Date().toISOString());
  const roots = () => ({ resourceRoot: deps.resourceRoot, dataRoot: deps.dataRoot() });
  const timeZone = async () => {
    try {
      return (await deps.loadConfig()).profile?.location || "UTC";
    } catch {
      return "UTC";
    }
  };
  const todayKey = async () => getLocalDateKey(new Date(now()), await timeZone());

  async function readPlan() {
    const state = await deps.loadRuntimeState();
    return ensurePlanState(state.plan);
  }

  function mutate(work) {
    return deps.serializeTaskMutation(async () => {
      const current = await deps.loadRuntimeState();
      const { plan, ...rest } = await work(ensurePlanState(current.plan));
      if (plan) {
        await deps.saveRuntimeState({ ...current, plan }, { localFirst: true });
        deps.onChange?.();
      }
      return rest;
    });
  }

  async function focusState(plan) {
    const zone = await timeZone();
    const view = focusView(plan, now(), (iso) => getLocalDateKey(new Date(iso), zone));
    const desktop = deps.desktopActions();
    return {
      ...view,
      desktopAvailable: Boolean(desktop?.setFocusMode),
      window: desktop?.focusStatus ? desktop.focusStatus() : null
    };
  }

  // Pause a session whose heartbeats stopped while the app was closed.
  async function reconcile() {
    return mutate(async (plan) => {
      const { plan: next, changed } = reconcileFocus(plan, now());
      return { plan: changed ? next : null, changed };
    });
  }

  // First run in a workspace: import the site export if it is sitting in data/.
  async function autoImport() {
    const path = join(deps.dataRoot(), "data", SITE_IMPORT_FILE);
    if (!existsSync(path)) return { imported: false };
    const current = ensurePlanState((await deps.loadRuntimeState()).plan);
    if (current.importedAt) return { imported: false };
    const siteExport = JSON.parse(await readFile(path, "utf8"));
    return mutate(async (plan) => {
      if (plan.importedAt) return { plan: null, imported: false };
      const { plan: next, result } = importSiteRecords(plan, siteExport, now());
      return { plan: next, imported: true, result };
    });
  }

  async function handle(req, res, url) {
    const send = deps.sendJson;
    const path = url.pathname;
    if (req.method === "POST" && !(deps.allowWrite || ((request) => isLocalHost(request.headers.host)))(req)) return send(res, { ok: false, error: "Plan changes are only accepted from this computer." }, 403);
    const body = req.method === "POST" ? await readJsonBody(req) : {};
    const data = await loadPlanData(roots());
    const today = await todayKey();
    const dateParam = (name, fallback) => {
      const value = url.searchParams.get(name) || fallback;
      if (!isDateKey(value)) throw httpError(400, `${name} must be YYYY-MM-DD.`);
      return value;
    };

    // ---- reads ----
    if (req.method === "GET") {
      if (path === "/api/plan/meta") {
        await autoImport();
        return send(res, { ok: true, ...planMeta(data, await readPlan(), today) });
      }
      if (path === "/api/plan/day") return send(res, { ok: true, ...dayView(data, await readPlan(), dateParam("date", today), today) });
      if (path === "/api/plan/week") return send(res, { ok: true, ...weekView(data, await readPlan(), dateParam("date", today), today) });
      if (path === "/api/plan/range") {
        const from = dateParam("from");
        const to = dateParam("to");
        if (to < from || daysBetween(to, from) > 62) throw httpError(400, "Ranges must be 0 to 62 days long.");
        return send(res, { ok: true, from, to, tasks: rangeView(data, await readPlan(), from, to) });
      }
      if (path === "/api/plan/search") {
        return send(res, {
          ok: true,
          ...searchTasks(data, await readPlan(), {
            q: url.searchParams.get("q") || "",
            category: url.searchParams.get("category") || "",
            status: url.searchParams.get("status") || "",
            limit: Math.min(500, Number(url.searchParams.get("limit")) || 200)
          }, today)
        });
      }
      if (path === "/api/plan/task") {
        const detail = taskDetail(data, await readPlan(), url.searchParams.get("id") || "");
        return detail ? send(res, { ok: true, task: detail }) : send(res, { ok: false, error: "Task not found." }, 404);
      }
      if (path === "/api/plan/portfolio") return send(res, { ok: true, ...portfolioView(data, await readPlan()) });
      if (path === "/api/plan/library") return send(res, { ok: true, weeks: libraryView(data, await readPlan()) });
      if (path === "/api/plan/neetcode") return send(res, { ok: true, ...neetcodeView(await readPlan(), dateParam("date", today)) });
      if (path === "/api/focus/state") return send(res, { ok: true, ...(await focusState(await readPlan())) });
      if (path === "/api/focus/sessions") {
        const from = dateParam("from", addDays(today, -13));
        const to = dateParam("to", today);
        const zone = await timeZone();
        const sessions = (await readPlan()).focusSessions.filter((session) => {
          const key = getLocalDateKey(new Date(session.startedAt), zone);
          return key >= from && key <= to;
        });
        return send(res, { ok: true, from, to, sessions });
      }
      if (path === "/api/focus/wallpapers") {
        const engine = (await deps.wallpaperEngine?.()?.status()) || { available: false, items: [], hidden: 0 };
        return send(res, {
          ok: true,
          folder: wallpapersDir(deps.dataRoot()),
          wallpapers: await listWallpapers(deps.dataRoot()),
          engine: {
            available: engine.available,
            hidden: engine.hidden,
            items: engine.items.map((item) => wallpaperItem({
              id: `we:${item.id}`,
              name: item.title,
              kind: "video",
              url: `/wallpapers/we/${item.id}`,
              preview: item.preview ? `/wallpapers/we/${item.id}/preview` : "",
              source: "wallpaper-engine"
            }))
          }
        });
      }
      return send(res, { ok: false, error: "Not found" }, 404);
    }

    if (req.method !== "POST") return send(res, { ok: false, error: "Method not allowed" }, 405);

    // ---- plan writes ----
    const planWrite = async (work) => {
      const result = await mutate(async (plan) => work(plan));
      return send(res, { ok: true, ...result });
    };
    if (path === "/api/plan/tasks/patch") return planWrite((plan) => patchTask(data, plan, body, now()));
    if (path === "/api/plan/tasks/reset") return planWrite((plan) => resetTask(data, plan, body, now()));
    if (path === "/api/plan/custom") return planWrite((plan) => addCustomTask(plan, body, now()));
    if (path === "/api/plan/custom/delete") return planWrite((plan) => deleteCustomTask(plan, body, now()));
    if (path === "/api/plan/settings") return planWrite((plan) => updateSettings(data, plan, body, now()));
    if (path === "/api/plan/triage") {
      const zone = await timeZone();
      const run = (plan) => {
        const instant = now();
        return triage(data, plan, body, { now: instant, todayKey: getLocalDateKey(new Date(instant), zone), timeZone: zone });
      };
      if (body.dryRun) return send(res, { ok: true, result: run(await readPlan()).result });
      return planWrite((plan) => {
        const outcome = run(plan);
        return { ...outcome, plan: outcome.plan === plan ? null : outcome.plan };
      });
    }
    if (path === "/api/plan/import") {
      let siteExport = body.records ? body : null;
      if (!siteExport) {
        const file = join(deps.dataRoot(), "data", SITE_IMPORT_FILE);
        if (!existsSync(file)) throw httpError(404, `No ${SITE_IMPORT_FILE} found in the data folder.`);
        siteExport = JSON.parse(await readFile(file, "utf8"));
      }
      return planWrite((plan) => importSiteRecords(plan, siteExport, now(), { dryRun: Boolean(body.dryRun) }));
    }
    if (path === "/api/plan/neetcode/log") {
      return planWrite((plan) => {
        const { plan: next, entry } = addNeetcodeEntry(plan, { date: today, ...body }, now());
        return { plan: next, entry };
      });
    }
    if (path === "/api/plan/neetcode/delete") return planWrite((plan) => deleteNeetcodeEntry(plan, String(body.id || ""), now()));

    // ---- focus ----
    const focusWrite = async (work) => {
      await mutate(async (plan) => work(plan));
      return send(res, { ok: true, ...(await focusState(await readPlan())) });
    };
    if (path === "/api/focus/start") {
      if (body.taskId) {
        const plan = await readPlan();
        if (!taskDetail(data, plan, String(body.taskId))) throw httpError(404, "Task not found.");
      }
      return focusWrite((plan) => startFocus(plan, body, now()));
    }
    if (path === "/api/focus/pause") return focusWrite((plan) => pauseFocus(plan, now()));
    if (path === "/api/focus/resume") return focusWrite((plan) => resumeFocus(plan, now()));
    if (path === "/api/focus/heartbeat") return focusWrite((plan) => heartbeatFocus(plan, now()));
    if (path === "/api/focus/notes") return focusWrite((plan) => noteFocus(plan, body.notes, now()));
    if (path === "/api/focus/extend") return focusWrite((plan) => extendFocus(plan, body.minutes, now()));
    if (path === "/api/focus/stop") return focusWrite((plan) => stopFocus(plan, body, now()));
    if (path === "/api/focus/exit-early") {
      const response = await focusWrite((plan) => exitFocusEarly(plan, body, now()));
      await deps.desktopActions()?.setFocusMode?.(false);
      return response;
    }
    if (path === "/api/focus/window") {
      const desktop = deps.desktopActions();
      if (!desktop?.setFocusMode) return send(res, { ok: false, error: "Focus window control is only available in the desktop app." }, 409);
      const status = await desktop.setFocusMode(Boolean(body.on));
      return send(res, { ok: true, window: status });
    }
    if (path === "/api/focus/move-windows") {
      const desktop = deps.desktopActions();
      if (!desktop?.setMoveOtherWindows) return send(res, { ok: false, error: "Moving windows is only available in the Jarvis desktop app on Windows." }, 409);
      if (typeof body.enabled !== "boolean") throw httpError(400, "enabled must be true or false.");
      return send(res, { ok: true, window: await desktop.setMoveOtherWindows(body.enabled) });
    }
    if (path === "/api/focus/wallpapers/open-folder") {
      const dir = wallpapersDir(deps.dataRoot());
      await mkdir(dir, { recursive: true });
      const result = await deps.openTarget(dir);
      return send(res, { ok: result?.ok !== false, folder: dir });
    }
    return send(res, { ok: false, error: "Not found" }, 404);
  }

  return {
    reconcile,
    autoImport,
    async focusActive() {
      return Boolean(activeSession(await readPlan()));
    },
    async handle(req, res, url) {
      try {
        return await handle(req, res, url);
      } catch (error) {
        return deps.sendJson(res, { ok: false, error: error.message }, error.status || 500);
      }
    }
  };
}
