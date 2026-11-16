// Desktop side of cloud sync: pushes this computer's plan to
// jarvis.example.com and merges back what the phone (or another computer)
// changed. Record-level last-writer-wins, the same merge as everywhere else.
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensurePlanState, mergePlanState } from "./plan/state.js";
import { safeWriteJson } from "./shared-state.js";

const PLAN_INTERVAL_MS = 60_000;
const BOARD_INTERVAL_MS = 30_000;
const KICK_DELAY_MS = 2_000;

export function normalizeCloudUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    return "";
  }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return "";
  return url.origin;
}

// What the phone shows for agents: enough to know who is working on what and
// who needs you, without transcripts or command output.
export function trimBoard(board) {
  if (!board) return null;
  return {
    generatedAt: board.generatedAt,
    counts: board.counts,
    slots: board.slots || null,
    // Titles only: prompts stay on the desktop until a task is started.
    drafts: (board.drafts || []).slice(0, 40).map((draft) => ({ id: draft.id, title: draft.title, provider: draft.provider, projectId: draft.projectId, mode: draft.mode, updatedAt: draft.updatedAt })),
    sessions: (board.sessions || []).slice(0, 40).map((session) => ({
      id: session.id,
      runId: session.runId || "",
      kind: session.kind || "",
      mode: session.mode || "",
      taskId: session.taskId || "",
      taskTitle: session.taskTitle || "",
      requestedFrom: session.requestedFrom || "",
      column: session.column || "",
      pendingMessages: session.pendingMessages?.length || 0,
      prUrl: session.prUrl || "",
      pr: session.pr ? { state: session.pr.state, draft: session.pr.draft, review: session.pr.review, checks: { passing: session.pr.checks?.passing || 0, failing: session.pr.checks?.failing || 0, pending: session.pr.checks?.pending || 0 } } : null,
      outcome: session.outcome || null,
      worktreeRemoved: Boolean(session.worktreeRemoved),
      provider: session.provider,
      model: session.model || "",
      effort: session.effort || "",
      effectiveModel: session.effectiveModel || "",
      effectiveEffort: session.effectiveEffort || "",
      settingsDiffer: Boolean(session.settingsDiffer),
      origin: session.origin,
      title: session.title,
      project: session.project?.name || null,
      branch: session.branch || "",
      status: session.status,
      waitingFor: session.waitingFor || "",
      current: session.current || "",
      updatedAt: session.updatedAt,
      tokens: session.tokens || 0,
      tokensKind: session.tokensKind || "used",
      loop: session.loop ? { status: session.loop.status, iterations: session.loop.iterations?.length || 0, maxIterations: session.loop.maxIterations } : null,
      recent: (session.recent || []).slice(-5).map((event) => ({ at: event.at, kind: event.kind, title: event.title }))
    }))
  };
}

// remoteAgents: { info() -> what the phone needs to start an agent, run(command) -> result }
export function createCloudSync({ dataRoot, loadRuntimeState, saveRuntimeState, serializeTaskMutation, boardSnapshot = async () => null, remoteAgents = null, fetchImpl = fetch, hostname = "" }) {
  const file = () => join(dataRoot(), "config", "cloud-sync.local.json");
  let settings = null;
  let status = { configured: false, url: "", device: "", lastSyncAt: null, lastError: "", syncing: false, boardPushedAt: null };
  let planTimer = null;
  let boardTimer = null;
  let kickTimer = null;
  let boardKick = null;
  let lastBoard = "";
  let failures = 0;
  let pushing = null;
  // Results of phone commands, sent with the next push.
  let agentResults = [];

  async function loadSettings() {
    if (settings) return settings;
    try {
      settings = existsSync(file()) ? JSON.parse(await readFile(file(), "utf8")) : {};
    } catch {
      settings = {};
    }
    status = { ...status, configured: Boolean(settings.url && settings.token), url: settings.url || "", phoneAgents: phoneAgents() };
    return settings;
  }

  // Off unless turned on here: the phone can only ask a desktop that agreed.
  const phoneAgents = () => Boolean(remoteAgents && settings?.phoneAgents === true);

  async function post(body) {
    const response = await fetchImpl(`${settings.url}/api/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${settings.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      const error = new Error(response.status === 401 ? "The cloud doesn't recognize this computer's token. Connect it again." : data.error || `Sync failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function syncNow() {
    await loadSettings();
    if (!status.configured || status.syncing) return view();
    status = { ...status, syncing: true };
    try {
      const local = ensurePlanState((await loadRuntimeState()).plan);
      const data = await post({ plan: local });
      if (data.plan) {
        // Merge inside the mutation queue so a local edit made meanwhile wins.
        await serializeTaskMutation(async () => {
          const current = await loadRuntimeState();
          const merged = mergePlanState(current.plan, data.plan);
          if (JSON.stringify(merged) !== JSON.stringify(current.plan)) await saveRuntimeState({ ...current, plan: merged }, { localFirst: true });
        });
      }
      failures = 0;
      status = { ...status, syncing: false, lastSyncAt: new Date().toISOString(), lastError: "", device: data.device || status.device };
    } catch (error) {
      failures += 1;
      status = { ...status, syncing: false, lastError: error.name === "TimeoutError" ? "The cloud didn't answer. Will retry." : error.message };
    }
    return view();
  }

  async function pushBoard() {
    // One push at a time; a second caller waits for the one under way.
    if (pushing) return pushing;
    pushing = pushBoardOnce().finally(() => { pushing = null; });
    return pushing;
  }

  async function pushBoardOnce() {
    await loadSettings();
    if (!status.configured) return;
    try {
      const board = trimBoard(await boardSnapshot());
      if (!board) return;
      const accepting = phoneAgents();
      board.remote = accepting ? { enabled: true, ...(await remoteAgents.info()) } : { enabled: false };
      const signature = JSON.stringify([board.remote, board.sessions.map((session) => [session.id, session.status, session.current, session.updatedAt])]);
      // While the phone may send commands, every push is also a check for them.
      if (signature === lastBoard && !accepting && !agentResults.length) return;
      const sending = agentResults;
      const data = await post({
        ...(signature === lastBoard ? {} : { agentsBoard: board }),
        ...(accepting ? { acceptAgentCommands: true } : {}),
        ...(sending.length ? { agentResults: sending } : {})
      });
      agentResults = agentResults.filter((result) => !sending.includes(result));
      lastBoard = signature;
      status = { ...status, boardPushedAt: new Date().toISOString() };
      if (accepting && Array.isArray(data.agentCommands) && data.agentCommands.length) {
        for (const command of data.agentCommands) agentResults.push(await remoteAgents.run(command));
        // Answer soon, and show the new run, rather than in 30 seconds.
        clearTimeout(boardKick);
        boardKick = setTimeout(() => void pushBoard(), KICK_DELAY_MS);
        boardKick.unref?.();
      }
    } catch {
      // The plan sync reports connection problems; the board just tries again.
    }
  }

  function schedule() {
    clearInterval(planTimer);
    clearInterval(boardTimer);
    if (!status.configured) return;
    // Back off while offline: 1, 2, 4 … up to 10 minutes between attempts.
    planTimer = setInterval(() => {
      if (failures && Math.random() > 1 / Math.min(10, 2 ** (failures - 1))) return;
      void syncNow();
    }, PLAN_INTERVAL_MS);
    boardTimer = setInterval(() => void pushBoard(), BOARD_INTERVAL_MS);
    planTimer.unref?.();
    boardTimer.unref?.();
  }

  function view() {
    return { ...status };
  }

  return {
    async start() {
      await loadSettings();
      schedule();
      if (status.configured) void syncNow().then(() => pushBoard());
    },
    stop() {
      clearInterval(planTimer);
      clearInterval(boardTimer);
      clearTimeout(kickTimer);
      clearTimeout(boardKick);
    },
    async setPhoneAgents(enabled) {
      await loadSettings();
      if (!status.configured) throw Object.assign(new Error("Connect this computer to your Jarvis cloud first."), { status: 409 });
      if (!remoteAgents) throw Object.assign(new Error("Agents aren't available in this copy of Jarvis."), { status: 409 });
      settings = { ...settings, phoneAgents: enabled === true };
      await safeWriteJson(file(), settings);
      status = { ...status, phoneAgents: phoneAgents() };
      // Tell the phone now, so its buttons appear or disappear without waiting.
      void pushBoard();
      return view();
    },
    // Called after any local plan change.
    kick() {
      if (!status.configured) return;
      clearTimeout(kickTimer);
      kickTimer = setTimeout(() => void syncNow(), KICK_DELAY_MS);
      kickTimer.unref?.();
    },
    async connect({ url, token }) {
      const origin = normalizeCloudUrl(url);
      if (!origin) throw Object.assign(new Error("Use the https:// address of your Jarvis cloud, e.g. https://jarvis.example.com."), { status: 400 });
      if (!/^jvs_[A-Za-z0-9_-]{20,}$/.test(String(token || "").trim())) throw Object.assign(new Error("That doesn't look like a Jarvis device token (it starts with jvs_)."), { status: 400 });
      const previous = settings;
      settings = { url: origin, token: String(token).trim(), hostname };
      status = { ...status, configured: true, url: origin, lastError: "" };
      const result = await syncNow();
      if (result.lastError) {
        settings = previous;
        status = { ...status, configured: Boolean(previous?.url && previous?.token), url: previous?.url || "" };
        throw Object.assign(new Error(result.lastError), { status: 400 });
      }
      await safeWriteJson(file(), settings);
      schedule();
      void pushBoard();
      return view();
    },
    async disconnect() {
      settings = {};
      lastBoard = "";
      agentResults = [];
      await rm(file(), { force: true });
      status = { configured: false, url: "", device: "", lastSyncAt: null, lastError: "", syncing: false, boardPushedAt: null, phoneAgents: false };
      schedule();
      return view();
    },
    syncNow,
    pushBoard,
    // For the music link, which talks to the same cloud with the same token.
    credentials: async () => {
      await loadSettings();
      return status.configured ? { url: settings.url, token: settings.token } : null;
    },
    status: async () => {
      await loadSettings();
      return view();
    }
  };
}
