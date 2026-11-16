export function normalizeGithubSlug(remote = "") {
  const value = String(remote).trim().replace(/\\/g, "/");
  const match = value.match(/github\.com(?::|\/)([^/]+\/[^/]+?)(?:\.git)?$/i);
  return match ? match[1].replace(/\.git$/i, "").toLowerCase() : "";
}

export function projectForTask(projects, task, assignedProjectId = "") {
  if (assignedProjectId) return projects.find((project) => project.id === assignedProjectId) || null;
  const title = String(task?.title || "").toLowerCase();
  return projects.find((project) => (project.matchTerms || []).some((term) => title.includes(String(term).toLowerCase()))) || null;
}

export function projectConnection(project, repo = {}) {
  const expectedSlug = normalizeGithubSlug(`https://github.com/${project.slug}`);
  const actualSlug = normalizeGithubSlug(repo.remote || (repo.slug ? `https://github.com/${repo.slug}` : ""));
  let reason = "";
  if (!repo.exists) reason = "Project folder was not found.";
  else if (!repo.git) reason = "Project folder is not a Git repository.";
  else if (!actualSlug) reason = "Project origin is missing or is not a GitHub remote.";
  else if (actualSlug !== expectedSlug) reason = `Expected ${expectedSlug}, found ${actualSlug}.`;
  return {
    id: project.id,
    displayName: project.displayName || project.id,
    path: project.path,
    expectedSlug,
    actualSlug,
    connected: !reason,
    reason,
    branch: repo.branch || "",
    dirtyCount: Number(repo.dirtyCount || 0),
    dirtyFiles: repo.dirtyFiles || [],
    latestCommit: repo.latestCommit || null
  };
}

export function enrichProjectConnection(connection, githubProject) {
  const pullRequest = githubProject?.prs?.find((pr) => pr.headRefName === connection.branch) || null;
  const workflow = githubProject?.workflows?.find((item) => item.headBranch === connection.branch) || null;
  const attentionRank = !connection.connected
    ? 400
    : workflow?.conclusion === "failure"
      ? 300
      : pullRequest?.reviewDecision === "CHANGES_REQUESTED"
        ? 200
        : connection.dirtyCount
          ? 100
          : 0;
  return {
    ...connection,
    pullRequest,
    workflow,
    repositoryUrl: githubProject?.url || (connection.expectedSlug ? `https://github.com/${connection.expectedSlug}` : ""),
    dependabotCount: githubProject?.dependabot?.length || 0,
    dependabotUrl: githubProject?.dependabot?.[0]?.url || "",
    attentionRank
  };
}

export function rankProjectConnections(connections = []) {
  return [...connections].sort((a, b) => Number(b.attentionRank || 0) - Number(a.attentionRank || 0) || a.displayName.localeCompare(b.displayName));
}
