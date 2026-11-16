import { useEffect, useState } from "preact/hooks";
import { html } from "./html.js";
import { Icon } from "./icons.js";
import { Button, Empty, IconButton, Skeleton } from "./ui.js";
import { get, post } from "./api.js";
import { navigate, reportError, toast } from "./store.js";
import { ago } from "./format.js";
import { openComposer } from "./agents/state.js";

// Starts a task for an agent in this repo. The prompt says what's wrong when
// the card shows something, so a failing build or open review is one click away.
function agentDraft(project) {
  const name = project.displayName || project.id;
  const problems = [];
  if (project.workflow?.conclusion === "failure") problems.push(`The latest "${project.workflow.name || "CI"}" run on ${project.branch} failed: ${project.workflow.url}`);
  if (project.pullRequest?.reviewDecision === "CHANGES_REQUESTED") problems.push(`The pull request "${project.pullRequest.title}" has changes requested: ${project.pullRequest.url}`);
  if (project.dependabotCount) problems.push(`There are ${project.dependabotCount} open Dependabot alerts.`);
  const prompt = problems.length
    ? `In ${name}:\n${problems.map((line) => `- ${line}`).join("\n")}\n\nFind the cause, propose a fix, and say how you verified it.`
    : "";
  return { projectId: project.id, mode: "plan", title: problems.length ? `Fix ${name}` : "", prompt };
}

function status(project) {
  if (!project.connected) return { tone: "warn", label: "Not connected" };
  if (project.workflow?.conclusion === "failure") return { tone: "danger", label: "CI failing" };
  if (project.pullRequest?.reviewDecision === "CHANGES_REQUESTED") return { tone: "warn", label: "Changes requested" };
  if (project.dirtyCount) return { tone: "accent", label: `${project.dirtyCount} uncommitted` };
  return { tone: "good", label: "Clean" };
}

function ProjectCard({ project }) {
  const open = async () => {
    try {
      const data = await post("/api/project/open", { projectId: project.id });
      toast(data.note || "Opening in VS Code…");
    } catch (error) {
      reportError(error);
    }
  };
  const badge = status(project);
  return html`<article class=${`project card ${project.connected ? "" : "is-disconnected"}`}>
    <header class="project-head">
      <div class="project-mark">${(project.displayName || project.id).slice(0, 1)}</div>
      <div class="project-name">
        <h3>${project.displayName}</h3>
        <span class="muted small">${project.expectedSlug}</span>
      </div>
      <span class=${`pill pill-${badge.tone}`}>${badge.label}</span>
    </header>
    <div class="project-facts">
      ${project.branch ? html`<span><${Icon} name="github" size=${14} />${project.branch}</span>` : null}
      ${project.latestCommit ? html`<span title=${project.latestCommit.subject}><${Icon} name="clock" size=${14} />${project.latestCommit.relativeTime}</span>` : null}
      ${project.dependabotCount ? html`<span class="warn">${project.dependabotCount} Dependabot alerts</span>` : null}
    </div>
    ${project.latestCommit ? html`<p class="project-commit"><code>${project.latestCommit.hash?.slice(0, 7)}</code> ${project.latestCommit.subject}</p>` : null}
    ${project.pullRequest ? html`<a class="project-link" href=${project.pullRequest.url} target="_blank" rel="noreferrer"><${Icon} name="link" size=${14} />PR: ${project.pullRequest.title}</a>` : null}
    ${project.workflow ? html`<a class=${`project-link ${project.workflow.conclusion === "failure" ? "danger" : ""}`} href=${project.workflow.url} target="_blank" rel="noreferrer"><${Icon} name="bolt" size=${14} />${project.workflow.name || "Workflow"}: ${project.workflow.conclusion || project.workflow.status || "running"}</a>` : null}
    ${project.dirtyFiles?.length ? html`<details class="project-dirty"><summary class="muted small">${project.dirtyFiles.length} changed files</summary><ul>${project.dirtyFiles.slice(0, 12).map((file) => html`<li><code>${file}</code></li>`)}</ul></details>` : null}
    ${!project.connected && project.reason ? html`<p class="warn small">${project.reason}</p>` : null}
    <footer class="row gap-2 wrap">
      <${Button} size="sm" variant="primary" icon="external" disabled=${!project.connected} onClick=${open}>Open in VS Code</${Button}>
      <${Button} size="sm" icon="bot" disabled=${!project.connected} onClick=${() => { navigate("agents"); openComposer(agentDraft(project)); }}>Ask an agent</${Button}>
      ${project.repositoryUrl ? html`<a class="btn btn-ghost btn-sm" href=${project.repositoryUrl} target="_blank" rel="noreferrer"><${Icon} name="github" size=${15} /><span>GitHub</span></a>` : null}
    </footer>
  </article>`;
}

export function ProjectsPage() {
  const [projects, setProjects] = useState(null);
  const [checkedAt, setCheckedAt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // The server answers from its last check and rechecks in the background, so
  // this button is the way to wait for a fresh look at every repo.
  const load = async (force = false) => {
    setLoading(true);
    try {
      const data = await get(force ? "/api/projects?refresh=1" : "/api/projects");
      setProjects(data.projects);
      setCheckedAt(data.checkedAt || "");
      setError("");
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);
  return html`<div class="page page-projects">
    <header class="page-head">
      <div><div class="eyebrow">Projects</div><h1>The evidence behind the resume</h1><p class="muted">Your repos, their state, and a fast way back into each one.${checkedAt ? ` Checked ${ago(checkedAt)}.` : ""}</p></div>
      <div class="agent-kpis"><${IconButton} icon="loop" label=${loading ? "Checking…" : "Check again"} disabled=${loading} onClick=${() => load(true)} /></div>
    </header>
    ${error ? html`<${Empty} icon="projects" title="Couldn't load projects">${error}</${Empty}>`
      : !projects ? html`<${Skeleton} lines=${6} />`
      : !projects.length ? html`<${Empty} icon="projects" title="No projects configured">Add projects under workspace.projects in config/jarvis.config.json.</${Empty}>`
      : html`<div class="project-grid">${projects.map((project) => html`<${ProjectCard} project=${project} />`)}</div>`}
  </div>`;
}
