// Runs agent commands sent from the phone through the cloud. Each one goes
// through the same functions as the dashboard's own buttons, so the same
// validation, slots and queue apply. Only start, reply, stop and cancel exist
// here: keeping, discarding and pushing work stay on this computer.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { event } from "./events.js";
import { safeWriteJson } from "../shared-state.js";

const REMEMBER = 200;

export function createRemoteAgents({ agentsApi, dataRoot }) {
  const file = () => join(dataRoot(), "data", "agent-remote.local.json");
  let handled = null;

  async function seen() {
    if (handled) return handled;
    try {
      handled = existsSync(file()) ? JSON.parse(await readFile(file(), "utf8")).handled || [] : [];
    } catch {
      handled = [];
    }
    return handled;
  }

  async function remember(id) {
    handled = [id, ...(await seen())].slice(0, REMEMBER);
    await safeWriteJson(file(), { version: 1, handled }).catch(() => {});
  }

  async function perform(command) {
    const { launcher } = agentsApi;
    if (command.type === "start") {
      // Only what the phone's form can set. A check command or base would run
      // on this computer, so they never come from a cloud record, whoever
      // wrote it.
      const request = agentsApi.startRequest({
        projectId: command.projectId,
        provider: command.provider,
        model: command.model,
        effort: command.effort,
        prompt: command.prompt,
        mode: command.mode === "plan" ? "plan" : "edit",
        title: command.title,
        taskId: command.taskId,
        taskTitle: command.taskTitle,
        requestedFrom: "phone"
      });
      const { run, queued, position } = await agentsApi.startOrQueue(request, { queue: true });
      launcher.pushEvents(run, [event(new Date().toISOString(), "status", "Started from your phone")]);
      launcher.touch(run);
      return { runId: run.id, queued, position: position || 0 };
    }
    if (command.type === "message") {
      await launcher.message(String(command.runId || ""), command.prompt, command.mode);
      return { runId: command.runId };
    }
    if (command.type === "stop") {
      agentsApi.stopRun(String(command.runId || ""));
      return { runId: command.runId };
    }
    if (command.type === "cancel") {
      launcher.cancelQueued(String(command.runId || ""));
      return { runId: command.runId };
    }
    throw new Error("Jarvis can't do that from the phone.");
  }

  return {
    info: () => agentsApi.remoteInfo(),
    // Never throws: every command gets an answer for the phone.
    async run(command) {
      const id = String(command?.id || "");
      if (!id) return { id, ok: false, error: "Command without an id." };
      // The cloud can hand a command out twice if an answer got lost.
      if ((await seen()).includes(id)) return { id, ok: false, error: "Already handled." };
      await remember(id);
      try {
        return { id, ok: true, ...(await perform(command)) };
      } catch (error) {
        return { id, ok: false, error: error.message || "The desktop couldn't do that." };
      }
    }
  };
}
