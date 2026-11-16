import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { enrichProjectConnection, normalizeGithubSlug, projectConnection, rankProjectConnections } from "./project-connections.js";

// Checking every repo takes several seconds of git and gh calls, so a result is
// reused for a while and refreshed in the background once it ages.
export const PROJECTS_FRESH_MS = 60 * 1000;

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

function uniqBy(items, keyFn) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function summarizeCommandError(message, fallback = "Command is not available right now.") {
  const text = String(message || "").trim();
  if (!text) return fallback;
  if (/access is denied/i.test(text)) return "Access is denied for the local CLI configuration.";
  return text.split(/\r?\n/)[0].slice(0, 180);
}

export function createProjects({ run, now = () => Date.now() }) {
  async function repoSnapshot(repoPath) {
    if (!existsSync(repoPath)) return { path: repoPath, exists: false };
    if (!existsSync(join(repoPath, ".git"))) return { path: repoPath, exists: true, git: false };

    const [branch, status, log, remote] = await Promise.all([
      run("git", ["branch", "--show-current"], { cwd: repoPath }),
      run("git", ["status", "--short"], { cwd: repoPath }),
      run("git", ["log", "-1", "--pretty=%h|%cr|%s"], { cwd: repoPath }),
      run("git", ["remote", "get-url", "origin"], { cwd: repoPath, timeout: 2500 })
    ]);

    const changed = status.stdout ? status.stdout.split(/\r?\n/).filter(Boolean) : [];
    const [hash = "", relativeTime = "", subject = ""] = log.stdout.split("|");
    return {
      path: repoPath,
      exists: true,
      git: true,
      remote: remote.ok ? remote.stdout : "",
      slug: remote.ok ? normalizeGithubSlug(remote.stdout) : "",
      branch: branch.stdout || "detached",
      dirtyCount: changed.length,
      dirtyFiles: changed.slice(0, 8),
      latestCommit: log.ok ? { hash, relativeTime, subject } : null
    };
  }

  async function githubProjects(config, repos) {
    const gh = config.integrations.github;
    if (!gh.enabled) return [];
    const configured = (gh.sideProjects || []).map((slug) => ({ nameWithOwner: slug, source: "config" }));
    const local = repos.filter((repo) => repo.slug).map((repo) => ({ nameWithOwner: repo.slug, source: "local", path: repo.path }));
    let discovered = [];
    if (gh.username) {
      const result = await run("gh", ["repo", "list", gh.username, "--limit", String(gh.discoverLimit || 20), "--json", "nameWithOwner,description,isPrivate,pushedAt,url"], { timeout: 9000 });
      discovered = result.ok ? parseJson(result.stdout, []).map((repo) => ({ ...repo, source: "github" })) : [];
    }
    return uniqBy([...configured, ...local, ...discovered], (repo) => repo.nameWithOwner).slice(0, gh.discoverLimit || 20);
  }

  async function githubDetails(project) {
    const slug = project.nameWithOwner;
    const [prs, issues, dependabot, workflows] = await Promise.all([
      run("gh", ["pr", "list", "--repo", slug, "--limit", "8", "--json", "number,title,url,author,headRefName,reviewDecision,updatedAt"], { timeout: 7000 }),
      run("gh", ["issue", "list", "--repo", slug, "--limit", "8", "--json", "number,title,url,labels,updatedAt"], { timeout: 7000 }),
      run("gh", ["api", `repos/${slug}/dependabot/alerts`, "--paginate"], { timeout: 9000 }),
      run("gh", ["run", "list", "--repo", slug, "--limit", "8", "--json", "conclusion,status,displayTitle,workflowName,headBranch,createdAt,url"], { timeout: 7000 })
    ]);
    const alerts = dependabot.ok ? parseJson(dependabot.stdout, []) : [];
    const openAlerts = Array.isArray(alerts) ? alerts.filter((alert) => alert.state === "open").slice(0, 8) : [];
    return {
      ...project,
      prs: prs.ok ? parseJson(prs.stdout, []) : [],
      issues: issues.ok ? parseJson(issues.stdout, []) : [],
      dependabot: openAlerts.map((alert) => ({
        number: alert.number,
        severity: alert.security_advisory?.severity || "unknown",
        package: alert.dependency?.package?.name || "unknown package",
        ecosystem: alert.dependency?.package?.ecosystem || "",
        url: alert.html_url
      })),
      dependabotNote: dependabot.ok ? "" : dependabot.stderr,
      workflows: workflows.ok ? parseJson(workflows.stdout, []) : []
    };
  }

  async function githubIntelligence(config, repos) {
    const auth = await run("gh", ["auth", "status"], { timeout: 3000 });
    if (!auth.ok) return { connected: false, note: summarizeCommandError(auth.stderr, "GitHub CLI is not authenticated."), projects: [] };
    const projects = await githubProjects(config, repos);
    return { connected: true, projects: await Promise.all(projects.slice(0, 8).map(githubDetails)) };
  }

  async function build(config) {
    const repos = await Promise.all(config.workspace.trackedRepos.map((repo) => repoSnapshot(repo)));
    const base = (config.workspace.projects || []).map((project) => projectConnection(
      project,
      repos.find((repo) => resolve(repo.path).toLowerCase() === resolve(project.path).toLowerCase()) || { path: project.path, exists: false }
    ));
    const github = await githubIntelligence(config, repos);
    return rankProjectConnections(base.map((connection) => {
      const match = github.projects?.find((project) => String(project.nameWithOwner || "").toLowerCase() === connection.expectedSlug);
      return enrichProjectConnection(connection, match);
    }));
  }

  let cached = null;
  let pending = null;

  function refresh(config) {
    pending ||= build(config)
      .then((projects) => {
        cached = { projects, checkedAt: new Date(now()).toISOString(), at: now() };
        return cached;
      })
      .finally(() => { pending = null; });
    return pending;
  }

  // Answers from the last check when there is one, and starts a new check in
  // the background once it is a minute old, so the page opens instantly. A
  // forced refresh, or the very first call, waits for the new check.
  async function list(config, { force = false } = {}) {
    if (force || !cached) {
      const fresh = await refresh(config);
      return { projects: fresh.projects, checkedAt: fresh.checkedAt, refreshing: false };
    }
    const stale = now() - cached.at >= PROJECTS_FRESH_MS;
    if (stale) refresh(config).catch(() => {});
    return { projects: cached.projects, checkedAt: cached.checkedAt, refreshing: Boolean(pending) };
  }

  return { list, repoSnapshot };
}
