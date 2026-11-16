// The cloud Jarvis API (jarvis.example.com). Reuses the desktop plan API
// unchanged; only storage, auth and the sync endpoint are cloud-specific.
import { randomUUID } from "node:crypto";
import { mergePlanState, ensurePlanState } from "../plan/state.js";
import { createPlanApi } from "../plan/routes.js";
import { createJobsApi } from "../jobs/routes.js";
import { createCloudMusic } from "./music.js";
import { httpError, readJsonBody } from "../http.js";
import { addCommand, applyResults, claimCommands, commandView, settle, updateCommands, validateCommand } from "./agent-commands.js";
import {
  bearerToken, checkOAuthState, clearCookie, cookie, createSession, githubAuthorizeUrl, githubUser, hashToken,
  newDeviceToken, newOAuthState, parseCookies, readSession, SESSION_COOKIE, sessionCookie, STATE_COOKIE
} from "./auth.js";

const SYNC_LIMIT = 4_000_000;
const MAX_RETRIES = 5;

export function cloudConfig(env = process.env) {
  const config = {
    appUrl: String(env.APP_URL || "").replace(/\/$/, ""),
    clientId: env.GITHUB_CLIENT_ID || "",
    clientSecret: env.GITHUB_CLIENT_SECRET || "",
    sessionSecret: env.SESSION_SECRET || "",
    allowedGithubId: String(env.ALLOWED_GITHUB_ID || ""),
    timeZone: env.TIME_ZONE || "America/Los_Angeles",
    // Local testing only: sign in without GitHub. It hands out the owner's
    // session, so every sign of a real deployment turns it off, not just one.
    devLogin: env.JARVIS_CLOUD_DEV_LOGIN === "1" && !env.VERCEL && env.NODE_ENV !== "production" && !env.DATABASE_URL &&
      /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(String(env.APP_URL || ""))
  };
  const missing = ["appUrl", "sessionSecret", "allowedGithubId", ...(config.devLogin ? [] : ["clientId", "clientSecret"])].filter((key) => !config[key]);
  if (config.sessionSecret && config.sessionSecret.length < 32) missing.push("sessionSecret (32+ characters)");
  return { ...config, missing };
}

function sendJson(res, body, status = 200, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { location, "cache-control": "no-store", ...headers });
  res.end();
}

// Read-merge-write with optimistic concurrency: two devices saving at once
// both land, record by record, exactly like the desktop's merge-on-save.
export async function savePlanDoc(store, incoming) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const { doc, version } = await store.getDoc("plan");
    const merged = ensurePlanState(mergePlanState(ensurePlanState(incoming), doc ? ensurePlanState(doc) : null));
    if (await store.putDoc("plan", merged, version)) return merged;
  }
  throw httpError(409, "The plan changed too many times at once. Try again.");
}

export function createCloudApp({ store, env = process.env, fetchImpl = fetch, spotifyFetch = fetch, resourceRoot = process.cwd(), musicEnrichGapMs }) {
  const config = cloudConfig(env);

  function session(req) {
    return readSession(parseCookies(req.headers.cookie)[SESSION_COOKIE], config.sessionSecret);
  }

  // Cookie-authenticated writes must come from the app itself.
  function sameOrigin(req) {
    return Boolean(config.appUrl) && req.headers.origin === config.appUrl;
  }

  const planApi = createPlanApi({
    resourceRoot,
    dataRoot: () => "/tmp/jarvis-cloud",
    loadConfig: async () => ({ profile: { location: config.timeZone }, dashboard: {} }),
    loadRuntimeState: async () => ({ plan: (await store.getDoc("plan")).doc || undefined }),
    saveRuntimeState: async (next) => savePlanDoc(store, next.plan),
    serializeTaskMutation: (work) => work(),
    sendJson,
    openTarget: async () => ({ ok: false }),
    desktopActions: () => null,
    allowWrite: sameOrigin
  });

  // Same pipeline as the desktop, without the Gmail inbox or the old-data import.
  const jobsApi = createJobsApi({
    loadConfig: async () => ({ profile: { location: config.timeZone } }),
    loadRuntimeState: async () => ({ plan: (await store.getDoc("plan")).doc || undefined }),
    saveRuntimeState: async (next) => savePlanDoc(store, next.plan),
    serializeTaskMutation: (work) => work(),
    sendJson,
    allowWrite: sameOrigin,
    appUrl: async () => config.appUrl
  });

  async function device(req) {
    const token = bearerToken(req);
    if (!token) return null;
    const found = await store.findDevice(hashToken(token));
    if (found) await store.touchDevice(found.id).catch(() => {});
    return found;
  }

  const music = createCloudMusic({ store, config, fetchImpl: spotifyFetch, sendJson, sameOrigin, savePlanDoc, enrichGapMs: musicEnrichGapMs });

  async function handle(req, res) {
    const url = new URL(req.url, "http://cloud.local");
    const path = url.pathname;
    if (config.missing.length) return sendJson(res, { ok: false, error: `Jarvis cloud isn't configured. Missing: ${config.missing.join(", ")}.` }, 503);

    // ---- sign-in ----
    if (path === "/api/auth/login" && req.method === "GET") {
      if (config.devLogin) return redirect(res, "/api/auth/callback?dev=1");
      const state = newOAuthState(config.sessionSecret);
      return redirect(res, githubAuthorizeUrl({ clientId: config.clientId, redirectUri: `${config.appUrl}/api/auth/callback`, state: state.nonce }), {
        "set-cookie": cookie(STATE_COOKIE, state.cookieValue, { maxAge: 600 })
      });
    }
    if (path === "/api/auth/callback" && req.method === "GET") {
      let user;
      if (config.devLogin && url.searchParams.get("dev") === "1") user = { id: config.allowedGithubId, login: "dev" };
      else {
        const stateCookie = parseCookies(req.headers.cookie)[STATE_COOKIE];
        if (!checkOAuthState(stateCookie, url.searchParams.get("state"), config.sessionSecret)) return redirect(res, "/?signin=expired", { "set-cookie": clearCookie(STATE_COOKIE) });
        try {
          user = await githubUser({ code: url.searchParams.get("code"), clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: `${config.appUrl}/api/auth/callback`, fetchImpl });
        } catch {
          return redirect(res, "/?signin=failed", { "set-cookie": clearCookie(STATE_COOKIE) });
        }
      }
      if (String(user.id) !== config.allowedGithubId) return redirect(res, "/?signin=denied", { "set-cookie": clearCookie(STATE_COOKIE) });
      return redirect(res, "/", { "set-cookie": [sessionCookie(createSession(user, config.sessionSecret)), clearCookie(STATE_COOKIE)] });
    }
    if (path === "/api/auth/logout" && req.method === "POST") {
      return sendJson(res, { ok: true }, 200, { "set-cookie": clearCookie(SESSION_COOKIE) });
    }

    // ---- desktop sync (device token) ----
    if (path === "/api/sync" && req.method === "POST") {
      const from = await device(req);
      if (!from) return sendJson(res, { ok: false, error: "Unknown or revoked device token." }, 401);
      const body = await readJsonBody(req, { limit: SYNC_LIMIT });
      const plan = body.plan ? await savePlanDoc(store, body.plan) : (await store.getDoc("plan")).doc;
      if (body.agentsBoard && typeof body.agentsBoard === "object") {
        const { version } = await store.getDoc("agentsBoard");
        await store.putDoc("agentsBoard", { ...body.agentsBoard, device: from.name, deviceId: from.id, receivedAt: new Date().toISOString() }, version);
      }
      let agentCommands;
      if (body.agentResults || body.acceptAgentCommands === true) {
        const now = Date.now();
        // Results first, so a command answered in this push isn't handed out again.
        ({ claimed: agentCommands } = await updateCommands(store, (commands) => {
          const answered = applyResults(commands, body.agentResults, from.id, now);
          return body.acceptAgentCommands === true ? claimCommands(answered, from.id, now) : { commands: answered, claimed: [] };
        }));
      }
      return sendJson(res, { ok: true, plan: plan || null, device: from.name, ...(agentCommands ? { agentCommands } : {}) });
    }

    // ---- music: the hourly scheduler (tick token) and desktop push/pull ----
    if (path.startsWith("/api/music/")) {
      const handled = await music.handleToken(req, res, url, device);
      if (handled !== undefined || res.headersSent) return handled;
    }

    // ---- everything else needs a signed-in session ----
    const user = session(req);
    if (path === "/api/session") {
      return user ? sendJson(res, { ok: true, mode: "web", user: { login: user.login } }) : sendJson(res, { ok: false, mode: "web", signedIn: false }, 401);
    }
    if (!user) return sendJson(res, { ok: false, error: "Sign in to use Jarvis." }, 401);
    if (req.method !== "GET" && !sameOrigin(req)) return sendJson(res, { ok: false, error: "Cross-site request refused." }, 403);

    if (path === "/api/devices" && req.method === "GET") return sendJson(res, { ok: true, devices: await store.listDevices() });
    if (path === "/api/devices" && req.method === "POST") {
      const body = await readJsonBody(req);
      const name = String(body.name || "Desktop").trim().slice(0, 60) || "Desktop";
      const token = newDeviceToken();
      const id = randomUUID();
      await store.createDevice({ id, name, tokenHash: hashToken(token) });
      return sendJson(res, { ok: true, device: { id, name }, token });
    }
    if (path === "/api/devices/revoke" && req.method === "POST") {
      const body = await readJsonBody(req);
      return (await store.revokeDevice(String(body.id || ""))) ? sendJson(res, { ok: true }) : sendJson(res, { ok: false, error: "Device not found." }, 404);
    }
    if (path === "/api/agents/board" && req.method === "GET") {
      const { doc } = await store.getDoc("agentsBoard");
      return sendJson(res, { ok: true, board: doc });
    }
    if (path === "/api/agents/commands" && req.method === "GET") {
      const { doc } = await store.getDoc("agentCommands");
      const commands = settle(Array.isArray(doc?.commands) ? doc.commands : [], Date.now());
      return sendJson(res, { ok: true, commands: commands.slice(0, 20).map(commandView) });
    }
    if (path === "/api/agents/commands" && req.method === "POST") {
      const command = validateCommand(await readJsonBody(req));
      const { doc: board } = await store.getDoc("agentsBoard");
      // Commands go to the desktop whose board the phone is looking at, and
      // only if that desktop said it accepts them.
      if (!board?.deviceId || !board.remote?.enabled) throw httpError(409, "Your desktop isn't accepting agent commands. Turn it on in Jarvis on your computer: Settings → Devices.");
      const { entry } = await updateCommands(store, (commands) => addCommand(commands, command, { deviceId: board.deviceId, now: Date.now() }));
      return sendJson(res, { ok: true, command: commandView(entry) });
    }
    if (path.startsWith("/api/plan/") || path.startsWith("/api/focus/")) return planApi.handle(req, res, url);
    if (path === "/api/jobs" || path.startsWith("/api/jobs/")) return jobsApi.handle(req, res, url);
    if (path === "/api/music" || path.startsWith("/api/music/")) return music.handleSession(req, res, url);
    return sendJson(res, { ok: false, error: "Not available on the web." }, 404);
  }

  return {
    config,
    async handle(req, res) {
      try {
        return await handle(req, res);
      } catch (error) {
        if (res.headersSent) return res.end();
        return sendJson(res, { ok: false, error: error.status ? error.message : "Something went wrong." }, error.status || 500);
      }
    }
  };
}
