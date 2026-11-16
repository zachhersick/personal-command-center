// Commands from the phone to a desktop's agents: start, reply, stop, cancel.
// The phone writes them here; the desktop that owns the board picks them up
// on its next board push and reports back on the one after. Nothing here can
// push code, keep or discard work: those stay on the desktop.
import { randomUUID } from "node:crypto";
import { httpError } from "../http.js";

export const COMMAND_TYPES = ["start", "message", "stop", "cancel"];
export const PENDING_MS = 10 * 60_000;
export const CLAIMED_MS = 5 * 60_000;
const KEEP = 50;
const MAX_RETRIES = 5;

const text = (value, limit) => (typeof value === "string" ? value.trim().slice(0, limit) : "");
const ID = /^[A-Za-z0-9._:-]{1,200}$/;

export function validateCommand(body = {}) {
  const type = body.type;
  if (!COMMAND_TYPES.includes(type)) throw httpError(400, "Unknown agent command.");
  if (type === "start") {
    const prompt = text(body.prompt, 20_000);
    if (!prompt) throw httpError(400, "Write a task for the agent.");
    if (!ID.test(String(body.projectId || ""))) throw httpError(400, "Choose a repository.");
    if (!["claude", "codex"].includes(body.provider)) throw httpError(400, "Choose Claude or Codex.");
    const mode = body.mode === "plan" ? "plan" : "edit";
    return {
      type,
      projectId: body.projectId,
      provider: body.provider,
      model: text(body.model, 200),
      effort: text(body.effort, 20),
      prompt,
      mode,
      title: text(body.title, 200),
      taskId: ID.test(String(body.taskId || "")) ? body.taskId : "",
      taskTitle: text(body.taskTitle, 200)
    };
  }
  const runId = String(body.runId || "");
  if (!/^[0-9a-f-]{36}$/.test(runId)) throw httpError(400, "That agent isn't one Jarvis started.");
  if (type === "message") {
    const prompt = text(body.prompt, 20_000);
    if (!prompt) throw httpError(400, "Write a message for the agent.");
    return { type, runId, prompt, mode: body.mode === "plan" ? "plan" : "edit" };
  }
  return { type, runId };
}

// Pending commands nobody picked up, and picked-up ones nobody answered,
// end with a reason the phone can show.
export function settle(commands, now) {
  return commands.map((command) => {
    if (command.status === "pending" && now - Date.parse(command.createdAt) > PENDING_MS) {
      return { ...command, status: "failed", error: "Your desktop didn't pick this up within 10 minutes. Is Jarvis open there?", doneAt: new Date(now).toISOString() };
    }
    if (command.status === "claimed" && now - Date.parse(command.claimedAt) > CLAIMED_MS) {
      return { ...command, status: "failed", error: "Your desktop picked this up but didn't confirm it.", doneAt: new Date(now).toISOString() };
    }
    return command;
  });
}

export function addCommand(commands, command, { deviceId, now }) {
  const entry = { id: randomUUID(), ...command, deviceId, status: "pending", createdAt: new Date(now).toISOString() };
  return { commands: [entry, ...settle(commands, now)].slice(0, KEEP), entry };
}

export function claimCommands(commands, deviceId, now) {
  const claimed = [];
  const next = settle(commands, now).map((command) => {
    if (command.status !== "pending" || command.deviceId !== deviceId) return command;
    const taken = { ...command, status: "claimed", claimedAt: new Date(now).toISOString() };
    claimed.push(taken);
    return taken;
  });
  // Oldest first, the order the phone sent them.
  return { commands: next, claimed: claimed.reverse() };
}

export function applyResults(commands, results, deviceId, now) {
  const byId = new Map((Array.isArray(results) ? results : []).filter((result) => result && typeof result.id === "string").map((result) => [result.id, result]));
  return commands.map((command) => {
    const result = byId.get(command.id);
    if (!result || command.deviceId !== deviceId || !["pending", "claimed"].includes(command.status)) return command;
    return {
      ...command,
      status: result.ok ? "done" : "failed",
      runId: typeof result.runId === "string" ? result.runId.slice(0, 64) : command.runId || "",
      queued: Boolean(result.queued),
      error: result.ok ? "" : text(result.error, 500) || "The desktop couldn't do that.",
      doneAt: new Date(now).toISOString()
    };
  });
}

// What the phone sees: no prompts beyond a short preview.
export function commandView(command) {
  return {
    id: command.id,
    type: command.type,
    runId: command.runId || "",
    title: command.title || "",
    preview: (command.prompt || "").slice(0, 120),
    status: command.status,
    queued: Boolean(command.queued),
    error: command.error || "",
    createdAt: command.createdAt,
    doneAt: command.doneAt || null
  };
}

export async function updateCommands(store, change) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const { doc, version } = await store.getDoc("agentCommands");
    const current = Array.isArray(doc?.commands) ? doc.commands : [];
    const result = change(current);
    // Most board pushes change nothing here; skip the write.
    if (JSON.stringify(result.commands) === JSON.stringify(current)) return result;
    if (await store.putDoc("agentCommands", { commands: result.commands }, version)) return result;
  }
  throw httpError(409, "Agent commands changed too many times at once. Try again.");
}
