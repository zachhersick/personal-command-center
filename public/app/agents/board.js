import { useEffect, useState } from "preact/hooks";
import { html } from "../html.js";
import { Icon } from "../icons.js";
import { Button, Empty, Skeleton } from "../ui.js";
import { agentAction, agentFilter, board, openDraft, selectedAgent } from "./state.js";
import { isWeb } from "../platform.js";
import { boardColumns, COLUMNS, prLabel } from "./logic.js";
import { toast } from "../store.js";

const DONE_SHOWN = 12;
const OUTSIDE_SHOWN = 8;

import { ago } from "../format.js";

export { ago };

export function tokens(count, kind = "used") {
  const value = Number(count) || 0;
  if (!value) return "";
  const amount = value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
  return kind === "context" ? `${amount} context` : `${amount} tokens`;
}

export function projectName(session) {
  return typeof session.project === "string" ? session.project : session.project?.name || "";
}

export function ProviderBadge({ provider }) {
  return html`<span class=${`prov prov-${provider}`}>${provider === "codex" ? "Codex" : "Claude"}</span>`;
}

export function PrChip({ pr }) {
  const { text, tone } = prLabel(pr);
  return html`<span class=${`pill ${tone ? `pill-${tone}` : ""}`}><${Icon} name="github" size=${12} /> ${text}</span>`;
}

export function useNarrow(width = 720) {
  const query = `(max-width: ${width}px)`;
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(query).matches === true);
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return undefined;
    const update = () => setNarrow(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return narrow;
}

// The phone's board carries only the number of iterations, not the list.
const loopCount = (loop) => (typeof loop.iterations === "number" ? loop.iterations : loop.iterations?.length || 0);

const KIND_LABEL = { loop: "Loop", review: "Review" };

function AgentCard({ session }) {
  const live = session.status === "working";
  const pending = typeof session.pendingMessages === "number" ? session.pendingMessages : session.pendingMessages?.length || 0;
  return html`<button type="button" data-agent=${session.id} class=${`agent-card status-${session.status}`} onClick=${() => { selectedAgent.value = session.id; }}>
    <div class="agent-card-top">
      <${ProviderBadge} provider=${session.provider} />
      ${KIND_LABEL[session.kind] ? html`<span class="pill pill-accent">${KIND_LABEL[session.kind]}</span>` : null}
      ${session.mode === "plan" ? html`<span class="pill">Plan</span>` : null}
      ${session.retryOf ? html`<span class="pill">Retry</span>` : null}
      ${session.requestedFrom === "phone" ? html`<span class="pill">From phone</span>` : null}
      <span class="agent-ago">${live ? html`<span class="live-dot"></span>` : null}${ago(session.updatedAt)}</span>
    </div>
    <strong class="agent-title">${session.title}</strong>
    <span class="agent-where"><${Icon} name="branch" size=${13} />${projectName(session) || (session.cwd || "").split(/[\\/]/).pop() || "unknown"}${session.branch ? html` · <code>${session.branch}</code>` : null}</span>
    ${session.taskTitle ? html`<span class="agent-where"><${Icon} name="flag" size=${13} />Task: ${session.taskTitle}</span>` : null}
    ${(session.status === "needs-you" || session.status === "queued") && session.waitingFor ? html`<span class="agent-waiting">${session.waitingFor}</span>` : null}
    ${session.status === "failed" ? html`<span class="agent-failed">Failed</span>` : null}
    ${session.status === "stopped" && !session.outcome ? html`<span class="muted small">Stopped</span>` : null}
    ${live && session.current ? html`<span class="agent-current">${session.current}</span>` : null}
    ${session.loop ? html`<span class="agent-loop"><${Icon} name="loop" size=${13} />Iteration ${loopCount(session.loop)}/${session.loop.maxIterations} · ${session.loop.status}</span>` : null}
    ${pending ? html`<span class="muted small">${pending} ${pending === 1 ? "message" : "messages"} queued</span>` : null}
    ${session.prUrl ? html`<div><${PrChip} pr=${session.pr} /></div>` : null}
  </button>`;
}

function DraftCard({ draft }) {
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    const data = await agentAction("drafts/start", { id: draft.id });
    setBusy(false);
    if (data?.runId) {
      toast(data.queued ? `Queued, #${data.position} in line. It starts when a slot frees.` : "Agent started", { tone: "good" });
      selectedAgent.value = `run:${data.runId}`;
    }
  };
  const top = html`<div class="agent-card-top">
    <${ProviderBadge} provider=${draft.provider} />
    <span class="pill">Draft</span>
    ${draft.mode === "plan" ? html`<span class="pill">Plan</span>` : null}
    <span class="agent-ago">${ago(draft.updatedAt)}</span>
  </div>`;
  const where = html`<span class="agent-where"><${Icon} name="branch" size=${13} />${draft.projectId}</span>`;
  // The phone only gets titles, so there's nothing to edit or start from there.
  if (isWeb.value) return html`<div class="agent-card agent-draft is-static">${top}<strong class="agent-title">${draft.title}</strong>${where}</div>`;
  return html`<div class="agent-card agent-draft">
    <button type="button" class="agent-draft-open" aria-label=${`Edit draft: ${draft.title}`} onClick=${() => openDraft(draft)}>${top}<strong class="agent-title">${draft.title}</strong>${where}</button>
    <${Button} size="sm" icon="send" disabled=${busy} onClick=${start}>Start</${Button}>
  </div>`;
}

function Column({ column, items, drafts = [], needs }) {
  const [all, setAll] = useState(false);
  const capped = column.id === "done" && !all;
  const shown = capped ? items.slice(0, DONE_SHOWN) : items;
  const total = items.length + drafts.length;
  return html`<section class=${`lane lane-${column.id} ${needs ? "has-needs" : ""}`} aria-label=${column.label}>
    <header class="lane-head"><strong>${column.label}</strong><em>${total}</em><span class="muted small">${column.hint}</span></header>
    <div class="lane-cards">
      ${drafts.map((draft) => html`<${DraftCard} key=${draft.id} draft=${draft} />`)}
      ${shown.map((session) => html`<${AgentCard} key=${session.id} session=${session} />`)}
      ${!total ? html`<div class="lane-empty">${column.id === "review" ? "Nothing waiting on you" : "None"}</div>` : null}
      ${capped && items.length > shown.length ? html`<${Button} size="sm" variant="ghost" onClick=${() => setAll(true)}>Show ${items.length - shown.length} more</${Button}>` : null}
    </div>
  </section>`;
}

function OutsideStrip({ sessions }) {
  const [all, setAll] = useState(false);
  if (!sessions.length) return null;
  const shown = all ? sessions : sessions.slice(0, OUTSIDE_SHOWN);
  const active = sessions.filter((session) => session.status === "working" || session.status === "needs-you").length;
  return html`<details class="agent-outside" open=${active > 0}>
    <summary><strong>Started outside Jarvis</strong><em>${sessions.length}</em><span class="muted small">${active ? `${active} active. ` : ""}Watched here, steered where they're running.</span></summary>
    <div class="outside-cards">
      ${shown.map((session) => html`<button type="button" key=${session.id} data-agent=${session.id} class=${`outside-card status-${session.status}`} onClick=${() => { selectedAgent.value = session.id; }}>
        <${ProviderBadge} provider=${session.provider} />
        <span class="outside-title"><strong class="agent-title">${session.title}</strong><span class="muted small">${projectName(session) || (session.cwd || "").split(/[\\/]/).pop() || "unknown"} · ${session.status === "needs-you" ? session.waitingFor || "Needs you" : session.status}</span></span>
        <span class="agent-ago">${session.status === "working" ? html`<span class="live-dot"></span>` : null}${ago(session.updatedAt)}</span>
      </button>`)}
    </div>
    ${sessions.length > shown.length ? html`<${Button} size="sm" variant="ghost" onClick=${() => setAll(true)}>Show ${sessions.length - shown.length} more</${Button}>` : null}
  </details>`;
}

// Where focus returns when a workspace closes.
export const lastOpened = { id: "" };

// inShell: the sidebar beside it already has the filter and the outside
// sessions, so the board shows only its columns.
export function Board({ inShell = false }) {
  const data = board.value;
  const filter = agentFilter.value;
  const setFilter = (value) => { agentFilter.value = value; };
  const [column, setColumn] = useState("review");
  const narrow = useNarrow();
  useEffect(() => {
    if (!lastOpened.id) return;
    document.querySelector(`[data-agent="${CSS.escape(lastOpened.id)}"]`)?.focus();
    lastOpened.id = "";
  }, []);
  if (!data) return html`<${Skeleton} lines=${6} />`;
  if (!data.sessions.length && !data.drafts?.length) {
    return isWeb.value
      ? html`<${Empty} icon="bot" title="No agents yet">Agents running on a connected desktop show up here within a minute.</${Empty}>`
      : html`<${Empty} icon="bot" title="No agents yet">Add a task from here, or open Claude Code or Codex anywhere on this computer. They show up automatically.</${Empty}>`;
  }
  const { columns, drafts, outside } = boardColumns(data, filter);
  const count = (id) => columns[id].length + (id === "todo" ? drafts.length : 0);
  const shown = narrow ? COLUMNS.filter((entry) => entry.id === column) : COLUMNS;
  return html`<div class="agent-board-wrap">
    ${inShell ? null : html`<div class="seg agent-filter">
      ${[["all", "All"], ["claude", "Claude"], ["codex", "Codex"]].map(([id, label]) => html`<button type="button" class=${filter === id ? "is-active" : ""} onClick=${() => setFilter(id)}>${label}</button>`)}
    </div>`}
    ${narrow ? html`<div class="seg column-switch" role="tablist" aria-label="Board columns">
      ${COLUMNS.map((entry) => html`<button type="button" role="tab" aria-selected=${column === entry.id ? "true" : "false"} class=${column === entry.id ? "is-active" : ""} onClick=${() => setColumn(entry.id)}>${entry.label} <em>${count(entry.id)}</em></button>`)}
    </div>` : null}
    <div class=${`agent-board ${narrow ? "is-single" : ""}`}>
      ${shown.map((entry) => html`<${Column} key=${entry.id} column=${entry} items=${columns[entry.id]} drafts=${entry.id === "todo" ? drafts : []} needs=${entry.id === "review" && columns.review.some((session) => session.status === "needs-you")} />`)}
    </div>
    ${inShell ? null : html`<${OutsideStrip} sessions=${outside} />`}
  </div>`;
}
