import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installPlan } from "../desktop/plan-install.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "jarvis-plan-install-"));
  const resourceRoot = join(root, "resources");
  const dataRoot = join(root, "workspace");
  const legacyRoot = join(root, "legacy");
  await mkdir(join(resourceRoot, "data", "plan"), { recursive: true });
  await copyFile(join(process.cwd(), "data", "plan", "roadmap-plan.v1.json"), join(resourceRoot, "data", "plan", "roadmap-plan.v1.json"));
  await mkdir(join(dataRoot, "data"), { recursive: true });
  await mkdir(join(legacyRoot, "data"), { recursive: true });
  await writeFile(join(dataRoot, "data", "runtime-state.local.json"), JSON.stringify({ captureInbox: [{ id: "keep" }] }));
  await writeFile(join(legacyRoot, "data", "plan-site-import.local.json"), JSON.stringify({ source: "site", records: { "task:w0-home3": { revision: 1, value: { done: true } } } }));
  return { root, resourceRoot, dataRoot, legacyRoot };
}

test("plan install imports site progress once and backs up state", async () => {
  const paths = await fixture();
  try {
    const now = new Date("2026-10-18T17:00:00.000Z");
    const first = await installPlan({ ...paths, now });
    assert.equal(first.installed, true);
    assert.deepEqual(first.imported.added, ["task:w0-home3"]);
    const state = JSON.parse(await readFile(join(paths.dataRoot, "data", "runtime-state.local.json"), "utf8"));
    assert.equal(state.plan.records["task:w0-home3"].done, true);
    assert.deepEqual(state.captureInbox, [{ id: "keep" }]);
    assert.ok(existsSync(join(paths.dataRoot, "backups", "plan-v1", "data", "runtime-state.local.json")));
    assert.ok(existsSync(join(paths.dataRoot, "wallpapers")));

    const before = await readFile(join(paths.dataRoot, "data", "runtime-state.local.json"), "utf8");
    const second = await installPlan({ ...paths, now: new Date("2026-10-19T17:00:00.000Z") });
    assert.equal(second.installed, false);
    assert.equal(await readFile(join(paths.dataRoot, "data", "runtime-state.local.json"), "utf8"), before);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("plan install stops on damaged state without writing the marker", async () => {
  const paths = await fixture();
  try {
    await writeFile(join(paths.dataRoot, "data", "runtime-state.local.json"), "{broken");
    await assert.rejects(() => installPlan({ ...paths }));
    assert.equal(existsSync(join(paths.dataRoot, "data", "plan-installation.local.json")), false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("plan install is a no-op without bundled plan data", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-plan-install-empty-"));
  try {
    assert.deepEqual(await installPlan({ dataRoot: join(root, "w"), resourceRoot: join(root, "r") }), { installed: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
