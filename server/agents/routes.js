// HTTP routes for the Agents hub.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { httpError, isLocalHost, readJsonBody } from "../http.js";
import { AgentLauncher, PROVIDERS } from "./launcher.js";
import { LoopRunner } from "./loop.js";
import { AgentDrafts } from "./drafts.js";
import { createPrWatcher, failurePrompt } from "./pr-status.js";
import { AgentRegistry } from "./registry.js";
import { HookStore, planHookInstall } from "./hooks.js";
import { evaluateLabs, LabProgress, LABS, PLAYBOOK } from "./labs.js";
import { claudeHome, codexHome } from "./paths.js";
import { inspectProvider } from "./providers.js";
import { collectUsage, createClaudeUsageReader, USAGE_DAYS } from "./usage.js";
import { git } from "./worktrees.js";

const REVIEW_PROMPT = (run) => `You are reviewing another agent's work. Compare this branch with commit ${run.baseSha} (run \`git diff ${run.baseSha}...HEAD\`).
The original task was:
"""
${run.prompt}
"""
Report, ranked by severity: bugs or wrong behavior, missing or weak tests, risky changes, and anything unclear. Cite files and lines. Don't edit files.`;

export function createAgentsApi(deps) {
  const launcher = new AgentLauncher({ dataRoot: deps.dataRoot, loadConfig: deps.loadConfig });
  const hooks = new HookStore();
  const drafts = new AgentDrafts({ dataRoot: deps.dataRoot });
  const registry = new AgentRegistry({ loadConfig: deps.loadConfig, launcher, hooks, drafts, env: deps.env || process.env });
  const prWatcher = createPrWatcher({ launcher, run: deps.run, isWatched: () => registry.watchers > 0 });
  prWatcher.start();
  const startingDrafts = new Set();
  const loops = new LoopRunner({ launcher });
  const labs = new LabProgress(deps.dataRoot);
  const readClaude = createClaudeUsageReader();

  async function projectById(id) {
    const projects = (await deps.loadConfig()).workspace?.projects || [];
    const project = projects.find((entry) => entry.id === id);
    if (!project) throw httpError(404, "Project not found.");
    return project;
  }

  // The fields a start request may carry. Queued records keep exactly this, so
  // a run that starts later is validated the same way as one started now.
  function startRequest(body) {
    const text = (value, limit) => (typeof value === "string" ? value.slice(0, limit) : "");
    return {
      projectId: text(body.projectId, 200),
      provider: text(body.provider, 20),
      model: text(body.model, 200),
      effort: text(body.effort, 20),
      prompt: text(body.prompt, 50_000),
      mode: text(body.mode, 10) || "edit",
      base: text(body.base, 200) || "HEAD",
      title: text(body.title, 200),
      taskId: text(body.taskId, 200),
      taskTitle: text(body.taskTitle, 200),
      requestedFrom: text(body.requestedFrom, 20),
      retryOf: text(body.retryOf, 100),
      loop: body.loop?.check ? { check: text(body.loop.check, 500), maxIterations: Number(body.loop.maxIterations) || 5 } : null
    };
  }

  async function startRun(request, { id = "" } = {}) {
    const project = await projectById(request.projectId);
    const input = {
      id,
      provider: request.provider,
      model: request.model,
      effort: request.effort,
      repo: resolve(project.path),
      projectId: project.id,
      prompt: request.prompt,
      mode: request.mode,
      base: request.base,
      title: request.title,
      taskId: request.taskId,
      taskTitle: request.taskTitle,
      requestedFrom: request.requestedFrom,
      retryOf: request.retryOf
    };
    return request.loop
      ? loops.start({ ...input, check: request.loop.check, maxIterations: request.loop.maxIterations })
      : launcher.start(input);
  }

  // Starts a run now, or queues it when every slot is busy and the caller asked
  // for that. Returns { run, queued, position }.
  async function startOrQueue(request, { queue = false } = {}) {
    try {
      // With a queue already waiting, a new request lines up behind it.
      if (!(queue && launcher.queued().length)) return { run: await startRun(request), queued: false };
    } catch (error) {
      if (!(queue && error.capacity)) throw error;
    }
    const project = await projectById(request.projectId);
    const { run, position } = await launcher.enqueue(request, { repo: resolve(project.path), title: request.title, taskId: request.taskId, taskTitle: request.taskTitle, requestedFrom: request.requestedFrom });
    drain();
    return { run, queued: true, position };
  }

  let draining = false;
  let again = false;
  async function drain() {
    if (draining) { again = true; return; }
    draining = true;
    try {
      do {
        again = false;
        for (const next of launcher.queued()) {
          const { settings } = await launcher.settings();
          if (launcher.occupied() >= settings.maxConcurrent) break;
          if (launcher.runs.get(next.id)?.status !== "queued") continue;
          try {
            await startRun(next.request, { id: next.id });
          } catch (error) {
            if (error.capacity) break;
            // A queued run that can't start (provider signed out, project gone)
            // fails on its own card rather than blocking the ones behind it.
            launcher.failQueued(next.id, error.message);
          }
        }
      } while (again);
    } catch (error) {
      console.error("Agent queue:", error.message);
    } finally {
      draining = false;
    }
  }
  launcher.on("slot-free", () => { drain(); });
  launcher.load().then(drain).catch(() => {});

  function stopRun(id) {
    const run = launcher.get(id);
    if (run.loop) loops.stop(run);
    else launcher.stop(run.id);
    return run;
  }

  // What the phone needs to offer a start: repositories that exist here and
  // the providers that are ready, with their model lists. Probing the CLIs
  // costs a few process launches, so this is reused for a few minutes.
  let remoteCache = null;
  async function remoteInfo() {
    if (remoteCache && Date.now() - remoteCache.at < 5 * 60_000) return remoteCache.value;
    const config = await deps.loadConfig();
    const projects = (config.workspace?.projects || [])
      .filter((project) => existsSync(project.path) && existsSync(resolve(project.path, ".git")))
      .map((project) => ({ id: project.id, name: project.displayName || project.id }));
    const found = await providers(config);
    const ready = Object.fromEntries(Object.entries(found).filter(([, info]) => info.ready).map(([id, info]) => [id, { models: info.models.map(({ id: model, label, family, efforts }) => ({ id: model, label, family, efforts })) }]));
    remoteCache = { at: Date.now(), value: { projects, providers: ready } };
    return remoteCache.value;
  }

  async function labsView() {
    const config = await deps.loadConfig();
    const snapshot = registry.last || (await registry.snapshot());
    const evaluated = evaluateLabs({ projects: config.workspace?.projects || [], runs: launcher.list(), sessions: snapshot.sessions, hookStats: hooks.stats(), env: deps.env || process.env }, labs.read());
    await labs.record(evaluated);
    return { labs: evaluated, playbook: PLAYBOOK };
  }

  async function providers(config, fresh) {
    const entries = await Promise.all(PROVIDERS.map(async (provider) => [provider, await inspectProvider(provider, config, { env: deps.env || process.env, fresh })]));
    return Object.fromEntries(entries);
  }

  // Starting removes the draft only once the run exists or is in line.
  async function startDraft(id) {
    if (startingDrafts.has(id)) throw httpError(409, "That draft is already starting.");
    const draft = await drafts.get(id);
    startingDrafts.add(id);
    try {
      const result = await startOrQueue(startRequest(draft), { queue: true });
      await drafts.remove(id);
      return result;
    } finally {
      startingDrafts.delete(id);
    }
  }

  function stream(req, res) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    const send = (data) => res.write(`event: snapshot\ndata: ${JSON.stringify(data)}\n\n`);
    registry.snapshot().then((data) => send(registry.boardPayload(data))).catch(() => {});
    const stop = registry.watch(send);
    prWatcher.tick().catch(() => {});
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
    heartbeat.unref?.();
    req.on("close", () => {
      clearInterval(heartbeat);
      stop();
    });
  }

  async function handle(req, res, url) {
    const send = deps.sendJson;
    const path = url.pathname;
    if (req.method === "GET") {
      if (path === "/api/agents/stream") return stream(req, res);
      if (path === "/api/agents") {
        const data = await registry.snapshot();
        return send(res, { ok: true, ...registry.boardPayload(data), providers: await providers(await deps.loadConfig()) });
      }
      if (path === "/api/agents/providers") return send(res, { ok: true, providers: await providers(await deps.loadConfig(), true) });
      if (path === "/api/agents/session") {
        const detail = await registry.detail(String(url.searchParams.get("id") || ""));
        return detail ? send(res, { ok: true, session: detail }) : send(res, { ok: false, error: "Session not found." }, 404);
      }
      if (path === "/api/agents/runs/pr/failures") {
        const run = launcher.get(String(url.searchParams.get("id") || ""));
        return send(res, { ok: true, prompt: await failurePrompt(run, deps.run) });
      }
      if (path === "/api/agents/runs/diff") return send(res, { ok: true, diff: await launcher.diff(String(url.searchParams.get("id") || "")) });
      if (path === "/api/agents/labs") return send(res, { ok: true, ...(await labsView()) });
      if (path === "/api/agents/usage") {
        const env = deps.env || process.env;
        const days = Math.max(7, Math.min(60, Number(url.searchParams.get("days")) || USAGE_DAYS));
        await launcher.load();
        return send(res, { ok: true, usage: await collectUsage({ claudeHome: claudeHome(env), codexHome: codexHome(env), runs: launcher.list(), days, readClaude }) });
      }
      if (path === "/api/agents/projects") {
        // Fast list for pickers: config only, no git or GitHub calls.
        const projects = ((await deps.loadConfig()).workspace?.projects || []).map((project) => ({
          id: project.id,
          displayName: project.displayName || project.id,
          path: project.path,
          exists: existsSync(project.path) && existsSync(resolve(project.path, ".git"))
        }));
        return send(res, { ok: true, projects });
      }
      if (path === "/api/agents/hooks") {
        const scope = url.searchParams.get("scope") === "project" ? "project" : "user";
        const project = scope === "project" ? await projectById(url.searchParams.get("projectId")) : null;
        const config = await deps.loadConfig();
        const plan = await planHookInstall({ scope, projectPath: project?.path, dataRoot: deps.dataRoot(), defaultPort: config.dashboard?.port, remove: url.searchParams.get("remove") === "1", env: deps.env || process.env });
        const { apply, ...preview } = plan;
        return send(res, { ok: true, ...preview, stats: hooks.stats() });
      }
      return send(res, { ok: false, error: "Not found" }, 404);
    }

    if (req.method !== "POST") return send(res, { ok: false, error: "Method not allowed" }, 405);
    if (!(deps.allowWrite || ((request) => isLocalHost(request.headers.host)))(req)) return send(res, { ok: false, error: "Agent controls only accept requests from this computer." }, 403);
    const body = await readJsonBody(req);

    if (path === "/api/agents/hook") return send(res, { ok: true, received: hooks.ingest(body) });

    if (path === "/api/agents/runs") {
      const { run, queued, position } = await startOrQueue(startRequest(body), { queue: body.queue === true });
      return send(res, { ok: true, runId: run.id, queued, position });
    }
    if (path === "/api/agents/runs/cancel") {
      launcher.cancelQueued(String(body.id || ""));
      return send(res, { ok: true });
    }
    if (path === "/api/agents/runs/message") {
      const id = String(body.id || "");
      const before = launcher.get(id).pendingMessages?.length || 0;
      const run = await launcher.message(id, body.text, body.mode);
      return send(res, { ok: true, queued: (run.pendingMessages?.length || 0) > before });
    }
    if (path === "/api/agents/runs/message/remove") {
      launcher.removeMessage(String(body.id || ""), String(body.messageId || ""));
      return send(res, { ok: true });
    }
    if (path === "/api/agents/drafts") {
      const request = startRequest(body);
      if (!PROVIDERS.includes(request.provider)) throw httpError(400, "Choose Claude or Codex.");
      if (!["plan", "edit"].includes(request.mode)) throw httpError(400, "mode must be plan or edit.");
      await projectById(request.projectId);
      return send(res, { ok: true, draft: await drafts.save(request, String(body.id || "")) });
    }
    if (path === "/api/agents/drafts/delete") {
      await drafts.remove(String(body.id || ""));
      return send(res, { ok: true });
    }
    if (path === "/api/agents/drafts/start") {
      const { run, queued, position } = await startDraft(String(body.id || ""));
      return send(res, { ok: true, runId: run.id, queued, position });
    }
    if (path === "/api/agents/runs/stop") {
      stopRun(String(body.id || ""));
      return send(res, { ok: true });
    }
    if (path === "/api/agents/runs/keep") return send(res, { ok: true, ...(await launcher.keep(String(body.id || ""))) });
    if (path === "/api/agents/runs/discard") {
      await launcher.discard(String(body.id || ""));
      return send(res, { ok: true });
    }
    if (path === "/api/agents/runs/review") {
      const run = launcher.get(String(body.id || ""));
      const provider = PROVIDERS.includes(body.provider) ? body.provider : run.provider === "claude" ? "codex" : "claude";
      const review = await launcher.start({ provider, model: body.model, effort: body.effort, repo: run.repo, projectId: run.projectId, prompt: REVIEW_PROMPT(run), mode: "plan", base: run.branch, title: `Review: ${run.title}`, kind: "review", reviewOf: run.id,
        prepare: async () => { if (run.outcome !== "kept" || run.unsaved) await launcher.keep(run.id); }
      });
      return send(res, { ok: true, runId: review.id });
    }
    if (path === "/api/agents/runs/pr") {
      const run = launcher.get(String(body.id || ""));
      if (run.outcome !== "kept" || run.unsaved) await launcher.keep(run.id);
      const title = String(body.title || run.title).slice(0, 200);
      const prBody = String(body.body || `${run.prompt}\n\n_Made by a ${run.provider} agent run from Jarvis._`).slice(0, 20_000);
      await git(run.repo, ["push", "-u", "origin", run.branch], { timeout: 120_000 });
      const result = await deps.run("gh", ["pr", "create", "--head", run.branch, "--title", title, "--body", prBody], { cwd: run.repo, timeout: 60_000 });
      if (!result.ok) throw httpError(502, result.stderr || "gh pr create failed.");
      launcher.touch(run, { prUrl: result.stdout.trim().split(/\s+/).pop() });
      prWatcher.refresh(run);
      return send(res, { ok: true, url: run.prUrl });
    }
    if (path === "/api/agents/runs/push") {
      const run = launcher.get(String(body.id || ""));
      if (!run.prUrl) throw httpError(409, "This run doesn't have a pull request yet.");
      if (run.worktreeRemoved) throw httpError(409, "This run's worktree was removed.");
      const kept = await launcher.keep(run.id);
      await git(run.repo, ["push", "origin", run.branch], { timeout: 120_000 });
      prWatcher.refresh(run);
      return send(res, { ok: true, committed: kept.committed });
    }
    if (path === "/api/agents/runs/pr/refresh") {
      await prWatcher.refresh(launcher.get(String(body.id || "")));
      return send(res, { ok: true });
    }
    if (path === "/api/agents/open") {
      const target = String(body.path || "");
      const known = (registry.last?.sessions || []).some((session) => session.cwd && resolve(session.cwd).toLowerCase() === resolve(target).toLowerCase());
      if (!known || !existsSync(target)) throw httpError(404, "That folder isn't one of your agent sessions.");
      const result = await deps.openInEditor(target);
      return send(res, { ok: result.ok, note: result.ok ? "Opening in VS Code…" : result.stderr });
    }
    if (path === "/api/agents/hooks") {
      const scope = body.scope === "project" ? "project" : "user";
      const project = scope === "project" ? await projectById(body.projectId) : null;
      const config = await deps.loadConfig();
      const plan = await planHookInstall({ scope, projectPath: project?.path, dataRoot: deps.dataRoot(), defaultPort: config.dashboard?.port, remove: Boolean(body.remove), env: deps.env || process.env });
      await plan.apply();
      return send(res, { ok: true, path: plan.path, installed: !body.remove });
    }
    if (path === "/api/agents/labs/manual") {
      await labs.setManual(String(body.id || ""), Boolean(body.done));
      return send(res, { ok: true, ...(await labsView()) });
    }
    return send(res, { ok: false, error: "Not found" }, 404);
  }

  return {
    launcher,
    registry,
    drafts,
    prWatcher,
    startRequest,
    startOrQueue,
    stopRun,
    remoteInfo,
    drain,
    hooks,
    claudeHome: () => claudeHome(deps.env || process.env),
    labsList: () => LABS,
    async handle(req, res, url) {
      try {
        return await handle(req, res, url);
      } catch (error) {
        if (res.headersSent) return res.end();
        return deps.sendJson(res, { ok: false, error: error.message }, error.status || 500);
      }
    },
    shutdown() {
      prWatcher.stop();
      launcher.stopAll();
    }
  };
}
