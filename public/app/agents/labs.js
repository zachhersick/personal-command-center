import { useEffect, useState } from "preact/hooks";
import { html } from "../html.js";
import { Icon } from "../icons.js";
import { Bar, Button, Check, Field, Skeleton } from "../ui.js";
import { get, post } from "../api.js";
import { reportError, revision, toast } from "../store.js";
import { board, openComposer } from "./state.js";

export function Labs({ onHooks }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const load = () => get("/api/agents/labs").then(setData).catch(reportError);
  useEffect(() => {
    load();
  }, [revision.value, board.value?.sessions?.length, board.value?.hooks?.counts?.claude]);
  if (!data) return html`<${Skeleton} lines=${8} />`;
  const done = data.labs.filter((lab) => lab.done).length;
  const next = data.labs.find((lab) => !lab.done);
  return html`<div class="labs">
    <section class="card labs-hero">
      <div>
        <div class="eyebrow">Learn agentic coding</div>
        <h2>${done === data.labs.length ? "You've done every lab" : `${done} of ${data.labs.length} labs done`}</h2>
        <p class="muted">Each lab is a short exercise on a real repo. Jarvis notices when you've done it: from your files, your runs, your loops and your hooks.</p>
        <${Bar} value=${done / data.labs.length} />
      </div>
      <div class="playbook">
        ${data.playbook.map((item, index) => html`<div class="playbook-item"><span>${index + 1}</span><div><strong>${item.title}</strong><p>${item.body}</p></div></div>`)}
      </div>
    </section>
    <div class="lab-list">
      ${data.labs.map((lab, index) => {
        const expanded = open === lab.id || (open === null && lab === next);
        return html`<article class=${`lab ${lab.done ? "is-done" : ""} ${expanded ? "is-open" : ""}`}>
          <button type="button" class="lab-head" onClick=${() => setOpen(expanded ? "" : lab.id)} aria-expanded=${expanded ? "true" : "false"}>
            <span class="lab-num">${lab.done ? html`<${Icon} name="check" size=${15} />` : index + 1}</span>
            <span class="lab-title"><strong>${lab.title}</strong><span class="muted small">${lab.minutes} min${lab.evidence ? ` · ${lab.evidence}` : ""}</span></span>
            <${Icon} name=${expanded ? "down" : "right"} size=${16} />
          </button>
          ${expanded ? html`<div class="lab-body">
            <p>${lab.why}</p>
            <ol class="lab-steps">${lab.steps.map((step) => html`<li>${step}</li>`)}</ol>
            <div class="row gap-2 wrap">
              ${lab.prompt ? html`<${Button} variant="primary" size="sm" icon=${lab.loop ? "loop" : "bot"} onClick=${() => openComposer({ prompt: lab.prompt, mode: lab.mode, loop: Boolean(lab.loop), title: lab.title, projectId: "jarvis" })}>Do it with an agent</${Button}>` : null}
              ${lab.id === "hooks-jarvis" ? html`<${Button} variant="primary" size="sm" icon="hook" onClick=${onHooks}>Open hooks</${Button}>` : null}
              ${lab.id === "parallel-worktrees" ? html`<${Button} size="sm" icon="bot" onClick=${() => openComposer({ provider: "claude" })}>Start a Claude run</${Button}><${Button} size="sm" icon="bot" onClick=${() => openComposer({ provider: "codex" })}>Start a Codex run</${Button}>` : null}
              ${lab.manual ? html`<label class="toggle"><input type="checkbox" checked=${lab.done} onChange=${async (event) => { try { setData(await post("/api/agents/labs/manual", { id: lab.id, done: event.currentTarget.checked })); } catch (error) { reportError(error); } }} /><span>I did this</span></label>` : null}
            </div>
            ${lab.done ? html`<p class="good small"><${Icon} name="check" size=${13} /> ${lab.evidence}</p>` : !lab.manual ? html`<p class="muted small">Jarvis checks this automatically.</p>` : null}
          </div>` : null}
        </article>`;
      })}
    </div>
  </div>`;
}

export function HooksPanel() {
  const [scope, setScope] = useState("user");
  const [projectId, setProjectId] = useState("jarvis");
  const [projects, setProjects] = useState([]);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = (remove = false) => {
    const params = new URLSearchParams({ scope, projectId, ...(remove ? { remove: "1" } : {}) });
    return get(`/api/agents/hooks?${params}`).then((data) => setPreview({ ...data, remove })).catch(reportError);
  };
  useEffect(() => {
    get("/api/agents/projects").then((data) => setProjects(data.projects)).catch(() => {});
  }, []);
  useEffect(() => {
    load();
  }, [scope, projectId]);
  const apply = async () => {
    setBusy(true);
    try {
      await post("/api/agents/hooks", { scope, projectId, remove: preview.remove });
      toast(preview.remove ? "Jarvis hooks removed" : "Hooks installed. New Claude sessions will report here.", { tone: "good" });
      await load();
    } catch (error) {
      reportError(error);
    }
    setBusy(false);
  };
  const stats = board.value?.hooks || preview?.stats;
  return html`<div class="hooks-panel">
    <section class="card">
      <div class="eyebrow"><${Icon} name="hook" size=${13} /> Hooks</div>
      <h2>Let agents tell you what they're doing</h2>
      <p class="muted">A hook is a command Claude Code runs at a lifecycle event: a session starting, a tool call finishing, a prompt needing your input, a turn ending. Jarvis's hook forwards those events here, so cards update instantly and "Needs you" fires the moment an agent is blocked. It always exits within a second and never blocks the agent.</p>
      <div class="row gap-2 wrap">
        <div class="seg">${[["user", "All my projects"], ["project", "One project"]].map(([id, label]) => html`<button type="button" class=${scope === id ? "is-active" : ""} onClick=${() => setScope(id)}>${label}</button>`)}</div>
        ${scope === "project" ? html`<select class="input input-sm" value=${projectId} onChange=${(event) => setProjectId(event.currentTarget.value)}>${projects.map((project) => html`<option value=${project.id}>${project.displayName}</option>`)}</select>` : null}
        <span class="muted small">${stats ? `${stats.counts.claude} Claude · ${stats.counts.codex} Codex events received${stats.lastAt ? `, last ${new Date(stats.lastAt).toLocaleTimeString()}` : ""}` : ""}</span>
      </div>
    </section>
    ${preview ? html`<section class="card">
      <div class="row space-between wrap gap-2">
        <div><strong>${preview.installed && !preview.remove ? "Installed" : preview.remove ? "Remove Jarvis hooks" : "Preview"}</strong><div class="muted small"><code>${preview.path}</code></div></div>
        <div class="row gap-2">
          ${preview.installed && !preview.remove ? html`<${Button} size="sm" variant="ghost" onClick=${() => load(true)}>Remove…</${Button}>` : null}
          <${Button} size="sm" variant="primary" icon="check" disabled=${busy || !preview.changed} onClick=${apply}>${preview.remove ? "Remove hooks" : preview.changed ? "Apply" : "Up to date"}</${Button}>
        </div>
      </div>
      <p class="muted small">Jarvis backs up the file first and only touches its own entries. Your other hooks stay as they are.</p>
      <div class="hook-diff">
        <div><span class="eyebrow">Before</span><pre>${preview.before}</pre></div>
        <div><span class="eyebrow">After</span><pre>${preview.after}</pre></div>
      </div>
    </section>
    <section class="card">
      <strong>Codex</strong>
      <p class="muted small">Codex supports the same hook format, but it asks you to trust each hook the first time it runs. Add this to a Codex hooks file and approve it when Codex prompts you:</p>
      <pre class="tl-detail">${preview.codexSnippet}</pre>
    </section>` : html`<${Skeleton} lines=${4} />`}
  </div>`;
}

export { Field, Check };
