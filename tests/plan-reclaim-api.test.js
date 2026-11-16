import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { resolve } from "node:path";
import { createPlanApi } from "../server/plan/routes.js";
import { loadPlanData } from "../server/plan/data.js";
import { ensurePlanState, planTasks } from "../server/plan/state.js";

test("preview and stale confirmation perform no writes; accepted spread saves once", async () => {
  const data = await loadPlanData({ resourceRoot: resolve(".") });
  let plan = ensurePlanState();
  plan.records = Object.fromEntries(planTasks(data, plan).map((task) => [`task:${task.id}`, { skipped: true }]));
  plan.records.settings = { classMode: false, gymConfirmed: true, gymPhase: 3, gymAnchor: "2026-10-23", dayStart: 900, dayEnd: 960 };
  plan.records["custom:done"] = { title: "Done", date: "2026-10-23", preferred: 900, minutes: 60, done: true };
  plan.records["custom:carry"] = { title: "Carry", date: "2026-10-22", preferred: 900, minutes: 60 };
  let saves = 0;
  let changes = 0;
  let now = "2026-10-23T20:15:00.000Z";
  let response;
  const api = createPlanApi({
    resourceRoot: resolve("."), dataRoot: () => resolve("."), now: () => now,
    loadConfig: async () => ({ profile: { location: "America/Los_Angeles" } }),
    loadRuntimeState: async () => ({ plan }),
    saveRuntimeState: async (state) => { plan = state.plan; saves++; },
    onChange: () => { changes++; }, serializeTaskMutation: (work) => work(),
    allowWrite: () => true, sendJson: (_, value, status = 200) => { response = { ...value, status }; }
  });
  const request = async (body) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = "POST";
    req.headers = { "content-type": "application/json" };
    await api.handle(req, {}, new URL("http://localhost/api/plan/triage"));
    return response;
  };
  const body = { action: "rebalance", ids: ["custom:carry"], reclaimCompleted: true, days: 1 };
  const original = JSON.stringify(plan);
  const preview = await request({ ...body, dryRun: true });
  assert.equal(preview.status, 200);
  assert.equal(preview.result.moves[0].start, 900);
  assert.equal(JSON.stringify(plan), original);
  assert.equal(saves, 0);
  assert.equal(changes, 0);
  const missing = await request(body);
  assert.equal(missing.status, 400);
  now = "2026-10-23T22:01:00.000Z";
  const stale = await request({ ...body, previewToken: preview.result.previewToken });
  assert.equal(stale.result.stale, true);
  assert.equal(JSON.stringify(plan), original);
  assert.equal(saves, 0);
  assert.equal(changes, 0);
  now = "2026-10-23T20:15:00.000Z";
  const applied = await request({ ...body, previewToken: preview.result.previewToken });
  assert.equal(applied.result.dryRun, false);
  assert.equal(saves, 1);
  assert.equal(changes, 1);
  assert.equal(plan.records["custom:done"].timelineReleased, true);
  assert.equal(plan.records["custom:carry"].schedulePlacement.start, 900);
  const legacy = await request({ action: "rebalance", dryRun: true });
  assert.equal(legacy.status, 200);
  assert.equal(saves, 1);
});
