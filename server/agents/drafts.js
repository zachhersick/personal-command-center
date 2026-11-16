// The To do column: tasks written down to start later. A draft keeps the same
// request a run starts from, so starting one goes through the normal validation
// and queue. Local to this computer, like runs.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { safeWriteJson } from "../shared-state.js";
import { summarize } from "./events.js";

const MAX_DRAFTS = 200;

const fail = (status, message) => Object.assign(new Error(message), { status });

export class AgentDrafts extends EventEmitter {
  constructor({ dataRoot, now = () => new Date().toISOString() }) {
    super();
    this.dataRoot = dataRoot;
    this.now = now;
    this.drafts = new Map();
    this.loading = null;
  }

  get file() {
    return join(this.dataRoot(), "data", "agent-drafts.local.json");
  }

  load() {
    this.loading ||= this.read();
    return this.loading;
  }

  async read() {
    if (!existsSync(this.file)) return;
    try {
      for (const draft of JSON.parse(await readFile(this.file, "utf8")).drafts || []) this.drafts.set(draft.id, draft);
    } catch (error) {
      console.error("Agent drafts:", error.message);
    }
  }

  // Oldest first: the top of the column is what has been waiting longest.
  list() {
    return [...this.drafts.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  async get(id) {
    await this.load();
    const draft = this.drafts.get(id);
    if (!draft) throw fail(404, "Draft not found.");
    return draft;
  }

  // Writes one after another, so flush() also waits for a save already under way.
  write() {
    this.writing = (this.writing || Promise.resolve()).catch(() => {}).then(() => safeWriteJson(this.file, { version: 1, drafts: this.list() }));
    this.emit("change");
    return this.writing;
  }

  async save(request, id = "") {
    await this.load();
    const text = request.prompt.trim();
    if (!text) throw fail(400, "Write the task before saving it.");
    const existing = id ? await this.get(id) : null;
    if (!existing && this.drafts.size >= MAX_DRAFTS) throw fail(409, "To do is full. Start or delete a draft first.");
    const at = this.now();
    const draft = {
      ...request,
      prompt: text,
      title: summarize(request.title || text.split(/\s+/).slice(0, 6).join(" "), 80),
      id: existing?.id || randomUUID(),
      createdAt: existing?.createdAt || at,
      updatedAt: at
    };
    this.drafts.set(draft.id, draft);
    await this.write();
    return draft;
  }

  async remove(id) {
    await this.get(id);
    this.drafts.delete(id);
    await this.write();
  }

  async flush() {
    await this.writing;
  }
}
