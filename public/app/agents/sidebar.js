import { useEffect, useState } from "preact/hooks";
import { html } from "../html.js";
import { Icon } from "../icons.js";
import { Button, Skeleton } from "../ui.js";
import { agentAction, agentFilter, board, openComposer, openDraft, selectedAgent } from "./state.js";
import { isWeb } from "../platform.js";
import { THREAD_GROUPS, threadGroups } from "./logic.js";
import { ago, lastOpened, PrChip, projectName } from "./board.js";
import { toast } from "../store.js";

const DONE_SHOWN = 12;
const OUTSIDE_SHOWN = 8;
const PROVIDER = { claude: "Claude", codex: "Codex" };

const where = (session) => projectName(session) || (session.cwd || "").split(/[\\/]/).pop() || "unknown";
const pendingCount = (session) => (typeof session.pendingMessages === "number" ? session.pendingMessages : session.pendingMessages?.length || 0);

function ThreadRow({ session }) {
  const active = selectedAgent.value === session.id;
  const pending = pendingCount(session);
  return html`<li>
    <button type="button" data-agent=${session.id} aria-current=${active ? "true" : undefined} class=${`thread status-${session.status} ${active ? "is-active" : ""}`} onClick=${() => { selectedAgent.value = session.id; }}>
      <span class="thread-dot" aria-hidden="true"></span>
      <span class="thread-main">
        <span class="thread-title">${session.title}</span>
        <span class="thread-meta"><span class=${`thread-prov is-${session.provider}`}>${PROVIDER[session.provider] || session.provider}</span><span>${where(session)}</span>${session.kind === "review" ? html`<span>Review</span>` : null}${session.kind === "loop" ? html`<span>Loop</span>` : null}</span>
        ${session.status === "needs-you" && session.waitingFor ? html`<span class="thread-note">${session.waitingFor}</span>` : null}
        ${session.status === "working" && session.current ? html`<span class="thread-current">${session.current}</span>` : null}
      </span>
      <span class="thread-side">
        <time>${ago(session.updatedAt)}</time>
        ${pending ? html`<span class="thread-badge" title=${`${pending} queued`}>${pending}</span>` : null}
      </span>
    </button>
    ${session.prUrl ? html`<div class="thread-pr"><${PrChip} pr=${session.pr} /></div>` : null}
  </li>`;
}

function DraftRow({ draft }) {
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
  const body = html`<span class="thread-dot" aria-hidden="true"></span>
    <span class="thread-main">
      <span class="thread-title">${draft.title}</span>
      <span class="thread-meta"><span class=${`thread-prov is-${draft.provider}`}>${PROVIDER[draft.provider] || draft.provider}</span><span>Draft</span><span>${draft.projectId}</span></span>
    </span>`;
  // The phone only gets titles, so there's nothing to edit or start from there.
  if (isWeb.value) return html`<li><div class="thread status-draft is-static">${body}<span class="thread-side"><time>${ago(draft.updatedAt)}</time></span></div></li>`;
  return html`<li class="thread-draft">
    <button type="button" class="thread status-draft" aria-label=${`Edit draft: ${draft.title}`} onClick=${() => openDraft(draft)}>${body}<span class="thread-side"><time>${ago(draft.updatedAt)}</time></span></button>
    <button type="button" class="icon-btn ghost thread-start" aria-label=${`Start ${draft.title}`} title="Start" disabled=${busy} onClick=${start}><${Icon} name="send" size=${14} /></button>
  </li>`;
}

function Group({ id, label, sessions, drafts = [] }) {
  const [all, setAll] = useState(false);
  const total = sessions.length + drafts.length;
  if (!total) return null;
  const capped = id === "done" && !all;
  const shown = capped ? sessions.slice(0, DONE_SHOWN) : sessions;
  return html`<section class=${`thread-group group-${id}`} aria-label=${label}>
    <h3 class="thread-group-head"><span>${label}</span><em>${total}</em></h3>
    <ul class="thread-list">
      ${shown.map((session) => html`<${ThreadRow} key=${session.id} session=${session} />`)}
      ${drafts.map((draft) => html`<${DraftRow} key=${draft.id} draft=${draft} />`)}
    </ul>
    ${capped && sessions.length > shown.length ? html`<button type="button" class="thread-more" onClick=${() => setAll(true)}>Show ${sessions.length - shown.length} more</button>` : null}
  </section>`;
}

function OutsideGroup({ sessions }) {
  const [all, setAll] = useState(false);
  if (!sessions.length) return null;
  const active = sessions.filter((session) => session.status === "working" || session.status === "needs-you").length;
  const shown = all ? sessions : sessions.slice(0, OUTSIDE_SHOWN);
  return html`<details class="thread-group group-outside" open=${active > 0}>
    <summary class="thread-group-head"><span>Started outside Jarvis</span><em>${sessions.length}</em></summary>
    <p class="thread-hint">Watched here, steered where they're running.</p>
    <ul class="thread-list">${shown.map((session) => html`<${ThreadRow} key=${session.id} session=${session} />`)}</ul>
    ${sessions.length > shown.length ? html`<button type="button" class="thread-more" onClick=${() => setAll(true)}>Show ${sessions.length - shown.length} more</button>` : null}
  </details>`;
}

// The left column on wide screens, and the whole page on a phone: every run
// grouped by what it needs from you, newest first within each group.
export function ThreadSidebar({ canStart, onOverview, overview }) {
  const data = board.value;
  const filter = agentFilter.value;
  const setFilter = (value) => { agentFilter.value = value; };
  useEffect(() => {
    if (!lastOpened.id) return;
    document.querySelector(`.agents-side [data-agent="${CSS.escape(lastOpened.id)}"]`)?.focus();
    lastOpened.id = "";
  }, [selectedAgent.value]);
  const groups = data ? threadGroups(data, filter) : null;
  const empty = groups && !data.sessions.length && !data.drafts?.length;
  return html`<nav class="agents-side" aria-label="Agent runs">
    <div class="agents-side-head">
      ${canStart ? html`<${Button} variant="primary" icon="plus" class="agents-new" onClick=${() => openComposer()}>New task</${Button}>` : null}
      ${onOverview ? html`<button type="button" class=${`agents-overview ${overview ? "is-active" : ""}`} aria-current=${overview ? "page" : undefined} onClick=${onOverview}><${Icon} name="layers" size=${15} />Board</button>` : null}
      <div class="seg agent-filter" role="radiogroup" aria-label="Provider">
        ${[["all", "All"], ["claude", "Claude"], ["codex", "Codex"]].map(([id, label]) => html`<button type="button" role="radio" aria-checked=${filter === id ? "true" : "false"} class=${filter === id ? "is-active" : ""} onClick=${() => setFilter(id)}>${label}</button>`)}
      </div>
    </div>
    <div class="agents-side-body">
      ${!groups ? html`<${Skeleton} lines=${6} />` : null}
      ${empty ? html`<p class="thread-hint">${isWeb.value ? "Agents running on a connected desktop show up here within a minute." : "No agents yet. Start a task, or open Claude Code or Codex anywhere on this computer."}</p>` : null}
      ${groups && !empty ? THREAD_GROUPS.map((group) => html`<${Group} key=${group.id} id=${group.id} label=${group.label} sessions=${groups[group.id]} drafts=${group.id === "todo" ? groups.drafts : []} />`) : null}
      ${groups ? html`<${OutsideGroup} sessions=${groups.outside} />` : null}
    </div>
  </nav>`;
}
