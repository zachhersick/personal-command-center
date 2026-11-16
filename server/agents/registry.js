// One view of every agent on this machine: Claude Code sessions, Codex threads
// and runs launched from Jarvis. Polls while someone is watching and emits a
// snapshot whenever something changed.
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { listLiveClaudeSessions, listRecentClaudeSessions, tailTranscript, transcriptPath } from "./claude-source.js";
import { codexThreadEvents, listCodexThreads } from "./codex-source.js";
import { claudeHome, codexHome } from "./paths.js";
import { agentSettings } from "./launcher.js";
import { sameModel } from "./providers.js";
import { prResolved } from "./pr-status.js";

const POLL_MS = 2000;
const RECENT_TTL_MS = 30_000;
export const LANES = ["needs-you", "working", "idle", "done"];

export function laneFor(status) {
  if (status === "needs-you") return "needs-you";
  if (status === "working" || status === "starting" || status === "queued") return "working";
  if (status === "idle") return "idle";
  return "done";
}

// Where a run sits on the board. Decided here so the desktop and phone agree.
export function columnFor({ status, outcome, prUrl, pr, worktreeRemoved }) {
  if (status === "queued") return "todo";
  if (["working", "starting", "checking"].includes(status)) return "running";
  if (status === "needs-you") return "review";
  if (prUrl) return prResolved(pr) ? "done" : "review";
  if (["failed", "stopped"].includes(status) && !outcome && !worktreeRemoved) return "review";
  return "done";
}

export function runSession(run, projects, queue = []) {
  let status = run.status;
  let waitingFor = "";
  if (status === "queued") waitingFor = `Queued, #${queue.indexOf(run.id) + 1 || 1} in line`;
  else if (status === "starting" || status === "checking" || (run.loop?.status === "running" && !["failed", "stopped"].includes(status))) status = "working";
  else if (status === "idle" && !run.outcome) {
    status = "needs-you";
    waitingFor = run.loop?.status === "passed" ? "Loop passed. Review the diff" : run.loop?.status === "exhausted" ? "Loop ran out of iterations" : "Ready for your review";
  } else if (status === "idle" && run.unsaved && !run.worktreeRemoved) {
    status = "needs-you";
    waitingFor = "New work isn't committed yet";
  } else if (status === "idle" && run.pr?.state === "OPEN" && run.pr.checks?.failing) {
    status = "needs-you";
    waitingFor = `${run.pr.checks.failing} ${run.pr.checks.failing === 1 ? "check" : "checks"} failing on the pull request`;
  } else if (status === "idle") status = "done";
  return {
    id: `run:${run.id}`,
    runId: run.id,
    provider: run.provider,
    model: run.model || "",
    effort: run.effort || "",
    effectiveModel: run.effectiveModel || "",
    effectiveEffort: run.effectiveEffort || "",
    settingsDiffer: !sameModel(run.model, run.effectiveModel) || Boolean(run.effort && run.effectiveEffort && run.effort !== run.effectiveEffort),
    origin: "jarvis",
    taskId: run.taskId || "",
    taskTitle: run.taskTitle || "",
    requestedFrom: run.requestedFrom || "",
    retryOf: run.retryOf || "",
    queuedAt: run.queuedAt || null,
    title: run.title,
    cwd: run.worktree,
    project: matchProject(run.repo, projects),
    branch: run.branch,
    status,
    waitingFor,
    mode: run.mode,
    kind: run.kind,
    sessionId: run.sessionId,
    tokens: run.tokens,
    tokensKind: "used",
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    current: run.current,
    recent: run.events.slice(-40),
    loop: run.loop || null,
    outcome: run.outcome,
    worktreeRemoved: Boolean(run.worktreeRemoved),
    prUrl: run.prUrl || "",
    pr: run.pr || null,
    unsaved: Boolean(run.unsaved),
    pendingMessages: run.pendingMessages || [],
    column: columnFor({ status, outcome: run.outcome, prUrl: run.prUrl, pr: run.pr, worktreeRemoved: run.worktreeRemoved }),
    turns: run.turns.length,
    live: status === "working"
  };
}

export function matchProject(cwd, projects = []) {
  const path = resolve(String(cwd || "")).toLowerCase();
  const hit = projects
    .filter((project) => project.path)
    .sort((a, b) => b.path.length - a.path.length)
    .find((project) => {
      const root = resolve(project.path).toLowerCase();
      return path === root || path.startsWith(`${root}\\`) || path.startsWith(`${root}/`);
    });
  return hit ? { id: hit.id, name: hit.displayName || hit.id } : null;
}

const trim = (session, recent = 6) => ({ ...session, recent: (session.recent || []).slice(-recent) });

export class AgentRegistry extends EventEmitter {
  constructor({ loadConfig, launcher, hooks, drafts = null, env = process.env }) {
    super();
    this.loadConfig = loadConfig;
    this.launcher = launcher;
    this.hooks = hooks;
    this.drafts = drafts;
    this.env = env;
    this.recent = { at: 0, sessions: [] };
    this.timer = null;
    this.signature = "";
    this.last = null;
    this.watchers = 0;
    launcher.on("change", () => this.kick());
    drafts?.on("change", () => this.kick());
  }

  async projects() {
    try {
      return (await this.loadConfig()).workspace?.projects || [];
    } catch {
      return [];
    }
  }

  async collect() {
    const home = claudeHome(this.env);
    const projects = await this.projects();
    await this.launcher.load();
    await this.drafts?.load();
    const runs = this.launcher.list().filter((run) => run.outcome !== "discarded" || Date.now() - Date.parse(run.updatedAt) < 6 * 3_600_000);
    const owned = new Set(runs.map((run) => run.sessionId).filter(Boolean));

    const live = listLiveClaudeSessions({ home });
    if (Date.now() - this.recent.at > RECENT_TTL_MS) {
      this.recent = { at: Date.now(), sessions: listRecentClaudeSessions({ home, exclude: new Set(live.map((session) => session.sessionId)) }) };
    }
    const liveIds = new Set(live.map((session) => session.sessionId));
    const codex = await listCodexThreads({ home: codexHome(this.env) }).catch(() => ({ available: false, threads: [] }));

    const external = [...live, ...this.recent.sessions.filter((session) => !liveIds.has(session.sessionId)), ...codex.threads]
      .filter((session) => !owned.has(session.sessionId))
      .map((session) => {
        const hint = this.hooks.hint(session.sessionId);
        const next = { ...session, origin: "external", project: matchProject(session.cwd, projects) };
        if (hint && (!session.updatedAt || hint.at >= session.updatedAt) && session.live !== false) {
          next.status = hint.status;
          if (hint.waitingFor) next.waitingFor = hint.waitingFor;
          if (hint.current) next.current = hint.current;
        }
        return next;
      });
    const queue = this.launcher.queued().map((run) => run.id);
    const sessions = [...runs.map((run) => runSession(run, projects, queue)), ...external]
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    const counts = Object.fromEntries(LANES.map((lane) => [lane, sessions.filter((session) => laneFor(session.status) === lane && session.status !== "queued").length]));
    counts.queued = queue.length;
    const { maxConcurrent } = agentSettings(await this.loadConfig());
    return {
      generatedAt: new Date().toISOString(),
      sessions,
      drafts: this.drafts?.list() || [],
      counts,
      slots: { used: this.launcher.occupied(), max: maxConcurrent },
      sources: { claude: true, codex: codex.available },
      hooks: this.hooks.stats(),
      active: this.launcher.active.size
    };
  }

  async snapshot() {
    const data = await this.collect();
    this.last = data;
    return data;
  }

  boardPayload(data) {
    return { ...data, sessions: data.sessions.map((session) => trim(session)) };
  }

  async detail(id) {
    const data = this.last || (await this.snapshot());
    let session = data.sessions.find((entry) => entry.id === id);
    if (!session) session = (await this.snapshot()).sessions.find((entry) => entry.id === id);
    if (!session) return null;
    if (session.runId) {
      const run = this.launcher.get(session.runId);
      return { ...session, recent: run.events, prompt: run.prompt, turnsDetail: run.turns, worktree: run.worktree, baseSha: run.baseSha, repo: run.repo, error: run.error || "" };
    }
    if (session.provider === "codex") return { ...session, recent: await codexThreadEvents(session.sessionId) };
    const tail = tailTranscript(transcriptPath(claudeHome(this.env), session.cwd, session.sessionId));
    return { ...session, recent: tail?.events || session.recent };
  }

  async tick() {
    try {
      const data = await this.snapshot();
      const signature = JSON.stringify([data.drafts.map((draft) => [draft.id, draft.updatedAt]), data.sessions.map((session) => [session.id, session.status, session.current, session.updatedAt, session.recent?.length, session.loop?.iterations?.length, session.outcome, session.pr?.state, session.pr?.review, session.pr?.checks?.passing, session.pr?.checks?.failing, session.pr?.checks?.pending, session.pr?.error])]);
      if (signature !== this.signature) {
        this.signature = signature;
        this.emit("snapshot", this.boardPayload(data));
      }
    } catch (error) {
      console.error("Agent registry:", error.message);
    }
  }

  kick() {
    if (!this.watchers) return;
    clearTimeout(this.kickTimer);
    this.kickTimer = setTimeout(() => this.tick(), 150);
    this.kickTimer.unref?.();
  }

  watch(listener) {
    this.on("snapshot", listener);
    this.watchers += 1;
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), POLL_MS);
      this.timer.unref?.();
    }
    return () => {
      this.off("snapshot", listener);
      this.watchers -= 1;
      if (this.watchers <= 0) {
        this.watchers = 0;
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }
}
