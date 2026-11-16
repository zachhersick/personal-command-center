// Live agent board state. One EventSource for the whole app keeps the rail
// badge current and powers the Agents page.
import { signal, computed } from "@preact/signals";
import { get, post } from "../api.js";
import { navigate, reportError, toast, storage } from "../store.js";
import { isWeb } from "../platform.js";

export const board = signal(null);
export const connected = signal(false);
export const selectedAgent = signal(null);
// All, Claude or Codex: shared by the sidebar and the board.
export const agentFilter = signal("all");

// Opens a run from anywhere in the app. The Agents page reads the run from
// the address, so it is set there rather than only on the signal.
export function openRun(id) {
  selectedAgent.value = id;
  navigate("agents", id);
}
export const composer = signal(null);
export const providers = signal(null);

export function agentPreferences(provider) {
  try {
    const { model, effort } = JSON.parse(storage.get(`jarvis-agent-${provider}`, "{}")) || {};
    return { model: typeof model === "string" ? model : "", effort: typeof effort === "string" ? effort : "" };
  } catch { return { model: "", effort: "" }; }
}

export function rememberAgentPreferences(provider, { model, effort }) {
  storage.set(`jarvis-agent-${provider}`, JSON.stringify({ model, effort }));
}

export async function refreshProviders() {
  const data = await get("/api/agents/providers");
  providers.value = data.providers;
}

export const needsYou = computed(() => board.value?.counts?.["needs-you"] || 0);

let source = null;
let retry = 0;
let seenNeeds = new Set();

function notifyNewNeeds(data) {
  const now = new Set();
  for (const session of data.sessions || []) {
    if (session.status !== "needs-you") continue;
    now.add(session.id);
    if (seenNeeds.has(session.id) || !board.value) continue;
    const body = session.waitingFor || session.current || "Waiting for you";
    if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
      new Notification(`${session.provider === "codex" ? "Codex" : "Claude"} needs you: ${session.title}`, { body });
    } else if (!document.hidden) {
      toast(`${session.title}: ${body}`, { tone: "warn", action: { label: "Open", run: () => openRun(session.id) } });
    }
  }
  seenNeeds = now;
}

// On the desktop, say when the phone started something here.
let seenPhoneRuns = null;
function notifyPhoneRuns(data) {
  const now = new Set((data.sessions || []).filter((session) => session.requestedFrom === "phone").map((session) => session.id));
  if (seenPhoneRuns && !isWeb.value) {
    for (const session of data.sessions || []) {
      if (!now.has(session.id) || seenPhoneRuns.has(session.id)) continue;
      toast(`Started from your phone: ${session.title}`, { action: { label: "Open", run: () => openRun(session.id) } });
    }
  }
  seenPhoneRuns = now;
}

function apply(data) {
  notifyNewNeeds(data);
  notifyPhoneRuns(data);
  board.value = data;
}

export function connectAgents() {
  if (source) return;
  source = new EventSource("/api/agents/stream");
  source.addEventListener("snapshot", (message) => {
    retry = 0;
    connected.value = true;
    try {
      apply(JSON.parse(message.data));
    } catch (error) {
      console.error(error);
    }
  });
  source.onerror = () => {
    connected.value = false;
    source.close();
    source = null;
    retry = Math.min(retry + 1, 6);
    setTimeout(connectAgents, 1000 * 2 ** retry);
  };
}

// On the web there's no local machine to watch: show the board the desktop
// last uploaded.
export const boardSource = signal(null);
export async function loadWebBoard() {
  try {
    const data = await get("/api/agents/board");
    const snapshot = data.board;
    boardSource.value = snapshot ? { device: snapshot.device, receivedAt: snapshot.receivedAt } : null;
    if (snapshot) apply({ ...snapshot, sessions: snapshot.sessions || [], counts: snapshot.counts || {} });
    else board.value = { sessions: [], counts: {} };
  } catch (error) {
    reportError(error);
  }
}

// ---------- phone control ----------
// What the desktop offers the phone, from its last board push: projects, ready
// providers and their models. Absent or disabled means look, don't touch.
export const remote = computed(() => (board.value?.remote?.enabled ? board.value.remote : null));
export const phoneCommands = signal([]);
const WAITING = ["pending", "claimed"];
export const waitingCommands = computed(() => phoneCommands.value.filter((command) => WAITING.includes(command.status)));

export async function loadPhoneCommands() {
  try {
    phoneCommands.value = (await get("/api/agents/commands")).commands;
  } catch {
    // The board still shows; command status just waits for the next try.
  }
}

// The composer and the agent sheet read providers the same way on both sides.
export function useRemoteProviders() {
  const info = remote.value;
  providers.value = info ? Object.fromEntries(["claude", "codex"].map((id) => [id, info.providers?.[id]
    ? { ready: true, version: "", models: [{ id: "", label: "Provider default", efforts: [] }, ...info.providers[id].models.filter((model) => model.id)] }
    : { ready: false, models: [{ id: "", label: "Provider default", efforts: [] }], error: `${id === "claude" ? "Claude Code" : "Codex"} isn't ready on your desktop.` }])) : null;
}

export async function phoneCommand(type, body, success = "Sent. Your desktop picks it up within about 30 seconds.") {
  try {
    const data = await post("/api/agents/commands", { type, ...body });
    phoneCommands.value = [data.command, ...phoneCommands.value];
    toast(success, { tone: "good" });
    return data.command;
  } catch (error) {
    reportError(error);
    return null;
  }
}

export async function loadAgents() {
  try {
    const data = await get("/api/agents");
    providers.value = data.providers;
    apply(data);
  } catch (error) {
    reportError(error);
  }
}

export async function agentAction(path, body, success) {
  try {
    const data = await post(`/api/agents/${path}`, body);
    if (success) toast(success, { tone: "good" });
    return data;
  } catch (error) {
    reportError(error);
    return null;
  }
}

export function openComposer(preset = {}) {
  composer.value = { provider: "claude", mode: "edit", ...agentPreferences(preset.provider || "claude"), ...preset };
}

// Opens a saved To do in the composer, to edit or start.
export function openDraft({ id, loop, ...draft }) {
  composer.value = { ...draft, draftId: id, loop: Boolean(loop), ...(loop ? { check: loop.check, maxIterations: loop.maxIterations } : {}) };
}
