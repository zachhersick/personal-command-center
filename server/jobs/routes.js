// HTTP routes for the job pipeline. Used by the desktop server and the cloud,
// with the same injected persistence as the plan API. The Gmail inbox and the
// old-data import exist only where deps provide them (the desktop).
import { httpError, isLocalHost, readJsonBody } from "../http.js";
import { getLocalDateKey, isDateKey, weekStartMonday } from "../plan/dates.js";
import { ensurePlanState } from "../plan/state.js";
import { addCustomTask } from "../plan/mutations.js";
import { addJobEvent, deleteJob, followUpsDue, jobMetrics, jobView, liveJobs, upsertJob } from "./model.js";
import { applySignals, openReviews, resolveReview } from "./signals.js";
import { parseJobLink } from "./links.js";
import { importLegacyJobs, legacyCandidates } from "./legacy-import.js";

export const DEFAULT_WEEKLY_TARGET = 10;
const SETTINGS_KEY = "jobs:settings";

export function jobSettings(plan) {
  const stored = plan.records?.[SETTINGS_KEY] || {};
  return { weeklyTarget: Number.isInteger(stored.weeklyTarget) ? stored.weeklyTarget : DEFAULT_WEEKLY_TARGET, inboxEmail: stored.inboxEmail || "" };
}

function withSettings(plan, patch, now) {
  const { updatedAt, ...current } = plan.records?.[SETTINGS_KEY] || {};
  return { ...plan, records: { ...plan.records, [SETTINGS_KEY]: { ...current, ...patch, updatedAt: now } } };
}

export function createJobsApi(deps) {
  const now = () => (deps.now ? deps.now() : new Date().toISOString());
  const allowWrite = deps.allowWrite || ((request) => isLocalHost(request.headers.host));
  const timeZone = async () => {
    try {
      return (await deps.loadConfig()).profile?.location || "UTC";
    } catch {
      return "UTC";
    }
  };

  async function readPlan() {
    return ensurePlanState((await deps.loadRuntimeState()).plan);
  }

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

  let legacyCount = null;
  async function legacyInfo(plan) {
    if (!deps.legacySources) return null;
    if (plan.legacyJobsImportedAt) return { available: false, importedAt: plan.legacyJobsImportedAt, count: 0 };
    if (legacyCount === null) {
      try {
        legacyCount = legacyCandidates(await deps.legacySources()).length;
      } catch {
        legacyCount = 0;
      }
    }
    return { available: legacyCount > 0, importedAt: null, count: legacyCount };
  }

  async function overview() {
    const plan = await readPlan();
    const zone = await timeZone();
    const at = now();
    const today = getLocalDateKey(new Date(at), zone);
    const settings = jobSettings(plan);
    const jobs = liveJobs(plan);
    return {
      jobs: jobs.map((job) => jobView(job, at)),
      metrics: jobMetrics(jobs, { now: at, weekStart: weekStartMonday(today), toDateKey: (iso) => getLocalDateKey(new Date(iso), zone), weeklyTarget: settings.weeklyTarget }),
      followUps: followUpsDue(jobs, at).map((job) => job.id),
      reviews: openReviews(plan),
      settings,
      today,
      legacy: await legacyInfo(plan),
      inbox: deps.inbox ? await deps.inbox.status() : null,
      appUrl: (await deps.appUrl?.()) || ""
    };
  }

  // The inbox applies what it finds through the same mutation queue.
  async function applyFromInbox(signals, { preview }) {
    if (preview) return applySignals(await readPlan(), signals, now()).result;
    return mutate(async (plan) => applySignals(plan, signals, now()));
  }

  async function handle(req, res, url) {
    const send = deps.sendJson;
    const path = url.pathname;
    if (req.method === "POST" && !allowWrite(req)) return send(res, { ok: false, error: "Job changes are only accepted from this computer." }, 403);
    const body = req.method === "POST" ? await readJsonBody(req) : {};

    if (req.method === "GET") {
      if (path === "/api/jobs") return send(res, { ok: true, ...(await overview()) });
      if (path === "/api/jobs/parse-link") return send(res, { ok: true, ...parseJobLink(url.searchParams.get("url") || "", url.searchParams.get("title") || "") });
      if (path === "/api/jobs/inbox/status") {
        if (!deps.inbox) throw httpError(409, "The job inbox runs in the Jarvis desktop app.");
        return send(res, { ok: true, inbox: await deps.inbox.status() });
      }
      return send(res, { ok: false, error: "Not found" }, 404);
    }

    if (req.method !== "POST") return send(res, { ok: false, error: "Method not allowed" }, 405);
    if (path === "/api/jobs/upsert") return send(res, { ok: true, ...(await mutate((plan) => upsertJob(plan, body, now()))) });
    if (path === "/api/jobs/event") return send(res, { ok: true, ...(await mutate((plan) => addJobEvent(plan, body, now()))) });
    if (path === "/api/jobs/delete") return send(res, { ok: true, ...(await mutate((plan) => deleteJob(plan, body, now()))) });
    if (path === "/api/jobs/review") return send(res, { ok: true, ...(await mutate((plan) => resolveReview(plan, body, now()))) });
    if (path === "/api/jobs/settings") {
      const target = Number(body.weeklyTarget);
      if (!Number.isInteger(target) || target < 0 || target > 200) throw httpError(400, "weeklyTarget must be 0 to 200.");
      return send(res, { ok: true, ...(await mutate((plan) => {
        const next = withSettings(plan, { weeklyTarget: target }, now());
        return { plan: next, result: { settings: jobSettings(next) } };
      })) });
    }
    if (path === "/api/jobs/prep-task") {
      const result = await mutate((plan) => {
        const job = liveJobs(plan).find((entry) => entry.id === body.id);
        if (!job) throw httpError(404, "Job not found.");
        if (!isDateKey(body.date)) throw httpError(400, "date must be YYYY-MM-DD.");
        const title = `Prep: ${job.company}${job.role ? ` ${job.role}` : ""} ${job.stage === "assessment" ? "assessment" : "interview"}`;
        const detail = [`Get ready for the ${job.stage} with ${job.company}.`, job.url ? `Posting: ${job.url}` : "", "Review the role, your matching stories, and the company's product."].filter(Boolean).join("\n\n");
        return addCustomTask(plan, { title, date: body.date, category: "Interview", minutes: Number(body.minutes) || 60, detail, doneWhen: "You can explain why this role, two relevant projects, and your questions for them." }, now());
      });
      return send(res, { ok: true, ...result });
    }
    if (path === "/api/jobs/import-legacy") {
      if (!deps.legacySources) throw httpError(409, "Old Jarvis data can only be imported on the computer that has it.");
      const sources = await deps.legacySources();
      const result = await mutate((plan) => {
        if (plan.legacyJobsImportedAt) throw httpError(409, "Old job data was already imported.");
        return importLegacyJobs(plan, sources, now());
      });
      legacyCount = null;
      return send(res, { ok: true, ...result });
    }
    if (path.startsWith("/api/jobs/inbox/")) {
      if (!deps.inbox) throw httpError(409, "The job inbox runs in the Jarvis desktop app.");
      const action = path.slice("/api/jobs/inbox/".length);
      // The address (not the password) is synced so "Open in Gmail" links on
      // the phone open the right account.
      if (action === "connect") {
        const inbox = await deps.inbox.connect(body);
        await mutate(async (plan) => ({ plan: withSettings(plan, { inboxEmail: inbox.email }, now()), result: {} }));
        return send(res, { ok: true, inbox });
      }
      if (action === "disconnect") {
        const inbox = await deps.inbox.disconnect();
        await mutate(async (plan) => ({ plan: withSettings(plan, { inboxEmail: "" }, now()), result: {} }));
        return send(res, { ok: true, inbox });
      }
      if (action === "scan") return send(res, { ok: true, scan: await deps.inbox.scan({ preview: Boolean(body.preview) }), inbox: await deps.inbox.status() });
    }
    return send(res, { ok: false, error: "Not found" }, 404);
  }

  return {
    applyFromInbox,
    async handle(req, res, url) {
      try {
        return await handle(req, res, url);
      } catch (error) {
        return deps.sendJson(res, { ok: false, error: error.message }, error.status || 500);
      }
    }
  };
}
