import { useEffect, useState } from "preact/hooks";
import { html } from "../html.js";
import { Icon } from "../icons.js";
import { Button, Field, Modal } from "../ui.js";
import { get } from "../api.js";
import { toast } from "../store.js";
import { isWeb } from "../platform.js";
import { agentAction, agentPreferences, rememberAgentPreferences, refreshProviders, board, composer, phoneCommand, providers, remote, selectedAgent, useRemoteProviders } from "./state.js";

const TEMPLATES = [
  { label: "Fix a failing test", mode: "edit", prompt: "The test `<test name or command>` fails. Find the root cause and fix the code (not the test). Run the test to confirm, and summarize the cause and the fix.", check: "npm test" },
  { label: "Feature behind tests", mode: "plan", prompt: "Add <feature>. First write tests that describe the behavior, then implement until they pass. Keep the change small and follow the existing patterns." },
  { label: "Explain a module", mode: "plan", prompt: "Explain how <file or folder> works: its responsibilities, the main data flow, and anything surprising. Don't change any files." },
  { label: "Review my changes", mode: "plan", prompt: "Review the uncommitted changes and recent commits on this branch for bugs, missing tests and risky edits. Rank findings by severity. Don't change any files." },
  { label: "Write CLAUDE.md", mode: "edit", prompt: "Read this repository and draft a concise CLAUDE.md: exact install/run/test commands, the directory layout, conventions, and things an agent must not do here. Under 60 lines. Then copy it to AGENTS.md." }
];

export function Composer() {
  const draft = composer.value;
  const [projects, setProjects] = useState([]);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState("");
  // On the phone, the desktop's last board push says what it can run.
  const phone = isWeb.value;
  const refresh = async () => {
    if (phone) return useRemoteProviders();
    setSetupBusy(true);
    setSetupError("");
    try { await refreshProviders(); } catch (error) { setSetupError(error.message); }
    finally { setSetupBusy(false); }
  };
  const useProjects = (usable) => {
    setProjects(usable);
    // A task can name a repo that isn't set up on this computer.
    setForm((current) => (current && usable.length && !usable.some((project) => project.id === current.projectId) ? { ...current, projectId: usable.some((project) => project.id === "jarvis") ? "jarvis" : usable[0].id } : current));
  };
  useEffect(() => {
    if (!draft) return;
    refresh();
    if (phone) Promise.resolve().then(() => useProjects((remote.value?.projects || []).map((project) => ({ id: project.id, displayName: project.name }))));
    else get("/api/agents/projects").then((data) => useProjects(data.projects.filter((project) => project.exists))).catch(() => setProjects([]));
    setForm({ projectId: "jarvis", provider: "claude", model: "", effort: "", mode: "edit", prompt: "", title: "", base: "HEAD", loop: false, check: "npm test", maxIterations: 5, ...draft });
  }, [draft]);
  const close = () => {
    if (busy) return;
    composer.value = null;
  };
  if (!draft || !form) return null;
  const set = (key, value) => setForm({ ...form, [key]: value });
  const portfolio = form.projectId && form.projectId !== "jarvis" && form.mode === "edit";
  const reviewing = Boolean(form.reviewId);
  const retrying = Boolean(form.retryOf);
  const editing = Boolean(form.draftId);
  const info = providers.value?.[form.provider];
  const models = info?.models || [{ id: "", label: "Provider default", efforts: [] }];
  const selectedModel = models.find((model) => model.id === form.model);
  const efforts = selectedModel?.efforts || [];
  const validSelection = Boolean(selectedModel) && (!form.effort || efforts.includes(form.effort));
  // A remembered choice is only "unavailable" once a fresh catalog says so.
  const checked = Boolean(info) && !setupBusy;
  const groups = [];
  for (const model of models) {
    const last = groups[groups.length - 1];
    if (model.family && last?.family === model.family) last.models.push(model);
    else groups.push({ family: model.family, models: [model] });
  }
  const option = (model) => html`<option value=${model.id}>${model.label}</option>`;
  const slots = board.value?.slots;
  const waiting = board.value?.counts?.queued || 0;
  // Reviews can't queue: they need the original run as it is right now.
  const full = !reviewing && Boolean(slots) && (slots.used >= slots.max || waiting > 0);
  const requestBody = () => ({ projectId: form.projectId, provider: form.provider, model: form.model, effort: form.effort, mode: form.loop ? "edit" : form.mode, prompt: form.prompt, title: form.title, base: form.base || "HEAD", taskId: form.taskId || "", taskTitle: form.taskTitle || "", retryOf: form.retryOf || "", ...(form.loop ? { loop: { check: form.check, maxIterations: Number(form.maxIterations) } } : {}) });
  const saveDraft = async () => {
    if (busy || !form.prompt.trim()) return;
    setBusy(true);
    const saved = await agentAction("drafts", { ...requestBody(), id: form.draftId || "" }, editing ? "Draft saved" : "Saved to To do");
    setBusy(false);
    if (saved) {
      rememberAgentPreferences(form.provider, form);
      composer.value = null;
    }
  };
  const deleteDraft = async () => {
    if (busy || !window.confirm("Delete this draft?")) return;
    setBusy(true);
    const removed = await agentAction("drafts/delete", { id: form.draftId }, "Draft deleted");
    setBusy(false);
    if (removed) composer.value = null;
  };
  const submit = async (event) => {
    event.preventDefault();
    if (busy || !info?.ready || !validSelection) return;
    setBusy(true);
    const body = requestBody();
    if (phone) {
      // The desktop queues it if every slot is busy.
      const sent = await phoneCommand("start", body);
      setBusy(false);
      if (sent) {
        rememberAgentPreferences(form.provider, form);
        composer.value = null;
      }
      return;
    }
    if (reviewing) body.id = form.reviewId;
    else body.queue = true;
    // A draft saves your edits first, so a start that fails doesn't lose them.
    const saved = editing ? await agentAction("drafts", { ...body, id: form.draftId }) : true;
    const data = !saved ? null : editing ? await agentAction("drafts/start", { id: form.draftId }) : await agentAction(reviewing ? "runs/review" : "runs", body);
    setBusy(false);
    if (data?.runId) {
      toast(data.queued ? `Queued, #${data.position} in line. It starts when a slot frees.` : reviewing ? "Review started" : form.loop ? "Loop started" : "Agent started", { tone: "good" });
      rememberAgentPreferences(form.provider, form);
      composer.value = null;
      selectedAgent.value = `run:${data.runId}`;
    }
  };
  return html`<${Modal} open=${true} onClose=${close} title=${reviewing ? "Start a review" : retrying ? "Retry as a new task" : editing ? "Edit draft" : "New task"} wide>
    <form class="modal-body form composer" onSubmit=${submit} aria-busy=${busy}>
      <fieldset disabled=${busy} class="composer-fields">
      <div class="composer-row">
        <div class="seg provider-seg" role="radiogroup" aria-label="Agent">
          ${[["claude", "Claude Code"], ["codex", "Codex"]].map(([id, label]) => html`<button type="button" role="radio" aria-checked=${form.provider === id ? "true" : "false"} class=${`${form.provider === id ? "is-active" : ""} prov-${id}`} onClick=${() => setForm({ ...form, provider: id, model: "", effort: "", ...agentPreferences(id) })}>${label}</button>`)}
        </div>
        <${Field} label="Repository">
          <select class="input" disabled=${reviewing} value=${form.projectId} onChange=${(event) => set("projectId", event.currentTarget.value)}>
            ${projects.map((project) => html`<option value=${project.id}>${project.displayName}</option>`)}
          </select>
        </${Field}>
        ${!reviewing && !phone ? html`<${Field} label="Start from"><input class="input" value=${form.base} onInput=${(event) => set("base", event.currentTarget.value)} placeholder="HEAD, main, a branch…" /></${Field}>` : null}
      </div>
      <div class="composer-row">
        <${Field} label="Model">
          <select class="input" value=${form.model} onChange=${(event) => setForm({ ...form, model: event.currentTarget.value, effort: "" })}>
            ${!selectedModel ? html`<option value=${form.model} disabled=${checked}>${checked ? `${form.model} (unavailable — choose again)` : form.model}</option>` : null}
            ${groups.map((group) => group.family ? html`<optgroup label=${group.family}>${group.models.map(option)}</optgroup>` : group.models.map(option))}
          </select>
        </${Field}>
        <${Field} label="Reasoning strength" hint=${efforts.length ? "Higher levels can take longer and use more allowance." : form.provider === "claude" && form.model ? "Update Claude Code and refresh setup to check strength support for this model." : "Choose a model with known effort support to set its strength."}>
          <select class="input" value=${form.effort} onChange=${(event) => set("effort", event.currentTarget.value)}>
            ${form.effort && !efforts.includes(form.effort) ? html`<option value=${form.effort} disabled=${checked}>${checked ? `${form.effort} (unavailable — choose again)` : form.effort}</option>` : null}
            <option value="">Provider default</option>
            ${efforts.map((effort) => html`<option value=${effort}>${effort[0].toUpperCase() + effort.slice(1)}</option>`)}
          </select>
        </${Field}>
      </div>
      ${form.provider === "codex" && info?.ready && models.length === 1 ? html`<p class="muted small">Open Codex once to refresh its model list, then choose Refresh setup here. You can also start with Provider default.</p>` : null}
      <div class="provider-setup" role="status">
        <p class=${info?.ready ? "muted small" : "warn small"}>${setupError || (setupBusy ? "Checking provider setup…" : info?.error || (phone ? `${form.provider === "claude" ? "Claude Code" : "Codex"} is ready on your desktop.` : `${form.provider === "claude" ? "Claude Code" : "Codex"} ${info?.version || ""} is ready.`))}</p>
        ${phone ? null : html`<${Button} size="sm" variant="ghost" disabled=${setupBusy} onClick=${refresh}>Refresh setup</${Button}>`}
      </div>
      ${reviewing ? html`<p>Review <strong>${form.title}</strong> without editing. Starting the review keeps the original work on its branch.</p>` : html`
      <div class="chips">${TEMPLATES.map((template) => html`<button type="button" class="chip" onClick=${() => setForm({ ...form, prompt: template.prompt, mode: template.mode, loop: Boolean(template.check) && form.loop, check: template.check || form.check })}>${template.label}</button>`)}</div>
      <${Field} label="Task" hint="Be specific: the outcome, the files if you know them, and how to verify it.">
        <textarea class="input" rows="7" required autofocus value=${form.prompt} onInput=${(event) => set("prompt", event.currentTarget.value)} placeholder="e.g. The roadmap search ignores audit IDs like AD-P0-1. Make search match them, add a test, and run npm test."></textarea>
      </${Field}>
      <div class="composer-row">
        <div class="seg" role="radiogroup" aria-label="Mode">
          ${[["plan", "Plan first"], ["edit", "Let it edit"]].map(([id, label]) => html`<button type="button" class=${!form.loop && form.mode === id ? "is-active" : ""} disabled=${form.loop} onClick=${() => set("mode", id)}>${label}</button>`)}
        </div>
        ${phone ? null : html`<label class="toggle"><input type="checkbox" checked=${form.loop} onChange=${(event) => set("loop", event.currentTarget.checked)} /><span><${Icon} name="loop" size=${14} /> Loop until a check passes</span></label>`}
      </div>
      ${form.loop ? html`<div class="composer-row">
        <${Field} label="Check command" hint="Runs in the agent's worktree after each turn."><input class="input" value=${form.check} onInput=${(event) => set("check", event.currentTarget.value)} /></${Field}>
        <${Field} label="Max iterations"><input class="input" type="number" min="1" max="10" value=${form.maxIterations} onInput=${(event) => set("maxIterations", event.currentTarget.value)} /></${Field}>
      </div>` : null}
      ${portfolio ? html`<p class="warn small">Heads up: your roadmap asks you to explain portfolio repairs without notes. Consider Plan first, or have the agent review and explain instead of writing the fix.</p>` : null}
      `}
      ${slots && !reviewing ? html`<p class=${full ? "warn small" : "muted small"}>${slots.used} of ${slots.max} agent slots busy${waiting ? `, ${waiting} queued` : ""}.${full ? " This one will wait in the queue and start on its own." : ""}</p>` : null}
      ${retrying ? html`<p class="muted small">This starts a separate run from the original commit. The original stays as it is until you discard it.</p>` : null}
      <p class="muted small">Runs in a fresh git worktree on its own <code>agent/…</code> branch. ${reviewing || (!form.loop && form.mode === "plan") ? "This agent can read and plan; it cannot edit files." : form.provider === "claude" ? "Claude can edit files there and run tests and git read commands; anything else is denied." : "Codex runs in its workspace-write sandbox."} Nothing is pushed unless you click Open PR.</p>
      <footer class="modal-foot flush">
        ${editing ? html`<${Button} variant="ghost" icon="trash" onClick=${deleteDraft}>Delete</${Button}>` : null}
        <${Button} variant="ghost" onClick=${close}>Cancel</${Button}>
        ${!phone && !reviewing && !retrying ? html`<${Button} icon="note" disabled=${busy || !form.prompt.trim()} onClick=${saveDraft}>${editing ? "Save changes" : "Save to To do"}</${Button}>` : null}
        <${Button} variant="primary" type="submit" icon=${form.loop ? "loop" : "bot"} disabled=${busy || setupBusy || !info?.ready || !validSelection || (!reviewing && !form.prompt.trim())}>${reviewing ? "Start review" : full ? "Add to queue" : form.loop ? "Start loop" : form.mode === "plan" && !form.loop ? "Ask for a plan" : "Start now"}</${Button}>
      </footer>
      </fieldset>
    </form>
  </${Modal}>`;
}
