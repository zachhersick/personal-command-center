import test from "node:test";
import assert from "node:assert/strict";
import { agentSummary, summaryLabel } from "../public/app/agents/summary.js";

const session = (id, status, updatedAt = "2026-10-26T10:00:00Z") => ({ id, status, updatedAt, title: id });

test("lock-in's agent summary puts the ones waiting on you first and skips finished ones", () => {
  const summary = agentSummary({ sessions: [
    session("old-done", "done"),
    session("building", "working", "2026-10-26T10:05:00Z"),
    session("next-up", "queued"),
    session("blocked", "needs-you"),
    session("idle", "idle"),
    session("booting", "starting", "2026-10-26T10:06:00Z")
  ] });
  assert.deepEqual(summary.shown.map((entry) => entry.id), ["blocked", "booting", "building", "next-up"]);
  assert.deepEqual([summary.needsYou, summary.working, summary.queued, summary.total, summary.more], [1, 2, 1, 4, 0]);
  assert.equal(summaryLabel(summary), "1 needs you · 2 working · 1 queued");
});

test("nothing running means no label, and long lists are cut", () => {
  assert.equal(summaryLabel(agentSummary(null)), "");
  const many = agentSummary({ sessions: Array.from({ length: 9 }, (_, index) => session(`s${index}`, "working")) }, 6);
  assert.equal(many.shown.length, 6);
  assert.equal(many.more, 3);
  assert.equal(summaryLabel({ needsYou: 2, working: 0, queued: 0 }), "2 need you");
});
