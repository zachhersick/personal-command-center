// Routes for the desktop app's self-update. The work happens in the Electron
// main process (desktop/updater.mjs); the server only relays and guards it.
import { canInstallNow } from "../desktop/updater.mjs";
import { httpError, isLocalHost, readJsonBody } from "./http.js";

export function createAppUpdateApi({ sendJson, desktopActions, focusActive, runningAgents }) {
  async function handle(req, res, url) {
    const desktop = desktopActions();
    if (!desktop?.updateStatus) return sendJson(res, { ok: false, desktop: false, error: "Updates apply to the installed desktop app." }, 409);
    if (req.method === "GET" && url.pathname === "/api/app/update") return sendJson(res, { ok: true, ...desktop.updateStatus() });
    if (req.method !== "POST") return sendJson(res, { ok: false, error: "Not found" }, 404);
    if (!isLocalHost(req.headers.host)) return sendJson(res, { ok: false, error: "Updates can only be started from this computer." }, 403);
    const body = await readJsonBody(req);
    if (url.pathname === "/api/app/update/check") return sendJson(res, { ok: true, ...(await desktop.checkForUpdates()) });
    if (url.pathname === "/api/app/update/skip") return sendJson(res, { ok: true, ...(await desktop.skipUpdate(String(body.version || ""))) });
    if (url.pathname === "/api/app/update/install") {
      const gate = canInstallNow({ focusActive: await focusActive(), runningAgents: runningAgents() });
      if (!gate.ok && !body.force) return sendJson(res, { ok: false, blocked: gate.blocked, error: `${gate.blocked.join(" and ")}.` }, 409);
      // Respond first: the app quits as soon as the installer starts.
      sendJson(res, { ok: true, state: "installing" });
      setTimeout(() => void desktop.installUpdate().catch((error) => console.error("Update install:", error.message)), 200);
      return undefined;
    }
    throw httpError(404, "Not found");
  }
  return {
    async handle(req, res, url) {
      try {
        return await handle(req, res, url);
      } catch (error) {
        return sendJson(res, { ok: false, error: error.message }, error.status || 500);
      }
    }
  };
}
