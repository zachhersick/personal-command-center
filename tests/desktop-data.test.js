import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeUserData } from "../desktop/user-data.mjs";

test("installed data migration preserves progress and project paths without replacing later updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-install-data-"));
  const legacy = join(root, "source"); const target = join(root, "installed");
  try {
    await mkdir(join(legacy, "config"), { recursive: true });
    await mkdir(join(legacy, "data"), { recursive: true });
    await writeFile(join(legacy, "config", "jarvis.config.json"), JSON.stringify({
      workspace: { projects: [{ id: "project", path: "../project" }], root: ".." },
      integrations: { career: { todoFiles: ["data/todo.json"] }, jobs: { localResultsFiles: ["data/jobs.json"] } }
    }));
    await writeFile(join(legacy, "data", "runtime-state.local.json"), JSON.stringify({ taskExecution: { tasks: { done: { status: "complete" } } } }));
    await initializeUserData({ dataRoot: target, resourceRoot: legacy, legacyRoot: legacy });
    const config = JSON.parse(await readFile(join(target, "config", "jarvis.config.json")));
    assert.equal(config.workspace.projects[0].path, join(root, "project"));
    assert.equal(config.integrations.career.todoFiles[0], join(target, "data", "todo.json"));
    const runtime = join(target, "data", "runtime-state.local.json");
    assert.equal(JSON.parse(await readFile(runtime)).taskExecution.tasks.done.status, "complete");
    await writeFile(runtime, JSON.stringify({ newer: true }));
    await initializeUserData({ dataRoot: target, resourceRoot: legacy, legacyRoot: legacy });
    assert.equal(JSON.parse(await readFile(runtime)).newer, true);
    assert.equal(JSON.parse(await readFile(join(target, "backups", "initial-import", "data", "runtime-state.local.json"))).taskExecution.tasks.done.status, "complete");
  } finally { await rm(root, { recursive: true, force: true }); }
});
