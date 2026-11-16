import test from "node:test";
import assert from "node:assert/strict";
import { canAskAgent, taskAgentDraft } from "../public/app/agents/task-request.js";

test("only open code tasks offer an agent", () => {
  assert.equal(canAskAgent({ category: "Build" }), true);
  assert.equal(canAskAgent({ category: "Study", repair: true }), true);
  assert.equal(canAskAgent({ category: "Personal", custom: true }), true);
  assert.equal(canAskAgent({ category: "Applications" }), false);
  assert.equal(canAskAgent({ category: "Build", done: true }), false);
  assert.equal(canAskAgent(null), false);
});

test("a repair task asks for an explanation in the audited repo and links back", () => {
  const draft = taskAgentDraft({
    id: "portfolio-s2",
    title: "Repair session 2",
    repair: true,
    detail: "Fix the flagged issues.",
    doneWhen: "Each ID has evidence.",
    auditItems: [{ id: "AD-P0-1", title: "Leaky split", repo: "anomaly-detection" }, { id: "AD-P1-3", title: "No seed", repo: "anomaly-detection" }]
  });
  assert.equal(draft.projectId, "anomaly-detection");
  assert.equal(draft.mode, "plan");
  assert.equal(draft.taskId, "portfolio-s2");
  assert.match(draft.prompt, /AD-P0-1: Leaky split/);
  assert.match(draft.prompt, /Done when: Each ID has evidence\./);
  assert.match(draft.prompt, /so I can make the repair myself/, "the roadmap wants repairs explained, not done for you");
});

test("a build task plans first and leaves the repository to the composer", () => {
  const draft = taskAgentDraft({ id: "w3-build0", title: "Add search", category: "Build", detail: "", auditItems: [] });
  assert.equal("projectId" in draft, false);
  assert.match(draft.prompt, /^Roadmap task: Add search/);
  assert.match(draft.prompt, /Propose a short plan first/);
});
