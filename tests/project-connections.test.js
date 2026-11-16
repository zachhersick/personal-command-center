import test from "node:test";
import assert from "node:assert/strict";
import { enrichProjectConnection, normalizeGithubSlug, projectConnection, projectForTask, rankProjectConnections } from "../server/project-connections.js";

test("normalizes HTTPS and SSH GitHub remotes", () => {
  assert.equal(normalizeGithubSlug("https://github.com/ZachHersick/anomalyops-copilot.git"), "zachhersick/anomalyops-copilot");
  assert.equal(normalizeGithubSlug("git@github.com:ZachHersick/anomalyops-copilot.git"), "zachhersick/anomalyops-copilot");
  assert.equal(normalizeGithubSlug("https://example.com/zach/repo.git"), "");
});

test("requires an exact configured task mapping", () => {
  const projects = [
    { id: "anomalyops", matchTerms: ["anomalyops-copilot"] },
    { id: "anomaly-detection", matchTerms: ["anomaly-detection", "anomaly detection"] },
    { id: "sample-project", matchTerms: ["sample-project", "sample project"] }
  ];
  assert.equal(projectForTask(projects, { title: "AnomalyOps-Copilot feature slice" }).id, "anomalyops");
  assert.equal(projectForTask(projects, { title: "Generic anomaly detection work" }).id, "anomaly-detection");
  assert.equal(projectForTask(projects, { title: "Sample-project model cleanup" }).id, "sample-project");
  assert.equal(projectForTask(projects, { title: "Generic anomaly work" }), null);
});

test("blocks mismatched repository connections", () => {
  const project = { id: "anomalyops", displayName: "AnomalyOps-Copilot", path: "C:/Dev/anomalyops-copilot", slug: "zachhersick/anomalyops-copilot" };
  const valid = projectConnection(project, { exists: true, git: true, remote: "git@github.com:zachhersick/anomalyops-copilot.git", branch: "feature/test" });
  assert.equal(valid.connected, true);
  const mismatch = projectConnection(project, { exists: true, git: true, remote: "https://github.com/zachhersick/anomaly-detection.git" });
  assert.equal(mismatch.connected, false);
  assert.match(mismatch.reason, /Expected zachhersick\/anomalyops-copilot, found zachhersick\/anomaly-detection/);
});

test("matches pull requests and workflows to the active branch", () => {
  const connection = enrichProjectConnection({ id: "current", connected: true, branch: "feature/current", dirtyCount: 0, expectedSlug: "zach/current" }, {
    url: "https://github.com/zach/current",
    prs: [{ number: 1, headRefName: "feature/other" }, { number: 2, headRefName: "feature/current" }],
    workflows: [{ id: 1, headBranch: "main" }, { id: 2, headBranch: "feature/current", conclusion: "failure" }],
    dependabot: [{ url: "https://github.com/zach/current/security/dependabot/1" }]
  });
  assert.equal(connection.pullRequest.number, 2);
  assert.equal(connection.workflow.id, 2);
  assert.equal(connection.dependabotCount, 1);
  assert.equal(connection.attentionRank, 300);
});

test("ranks configured project blockers before dirty and clear worktrees", () => {
  const projects = [
    { id: "clear", displayName: "Clear", attentionRank: 0 },
    { id: "dirty", displayName: "Dirty", attentionRank: 100 },
    { id: "review", displayName: "Review", attentionRank: 200 },
    { id: "ci", displayName: "CI", attentionRank: 300 },
    { id: "offline", displayName: "Offline", attentionRank: 400 }
  ];
  assert.deepEqual(rankProjectConnections(projects).map((project) => project.id), ["offline", "ci", "review", "dirty", "clear"]);
});
