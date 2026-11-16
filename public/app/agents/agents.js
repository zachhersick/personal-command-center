import { useEffect, useRef, useState } from "preact/hooks";
import { html } from "../html.js";
import { Icon } from "../icons.js";
import { Button } from "../ui.js";
import { ago, Board, useNarrow } from "./board.js";
import { Composer } from "./composer.js";
import { Workspace } from "./workspace.js";
import { HooksPanel, Labs } from "./labs.js";
import { Usage } from "./usage.js";
import { ThreadSidebar } from "./sidebar.js";
import { board, boardSource, connected, loadAgents, loadPhoneCommands, loadWebBoard, phoneCommands, remote, selectedAgent, waitingCommands } from "./state.js";
import { navigate, route, routeParam } from "../store.js";
import { isWeb } from "../platform.js";

const MORE_VIEWS = [
  { id: "usage", label: "Usage", icon: "bolt" },
  { id: "labs", label: "Labs", icon: "book" },
  { id: "hooks", label: "Hooks", icon: "hook" }
];

const COMMAND_LABEL = { start: "Start", message: "Reply", stop: "Stop", cancel: "Cancel" };

function commandStatus(command) {
  if (command.status === "pending") return "Sent, waiting for your desktop";
  if (command.status === "claimed") return "Your desktop is on it";
  if (command.status === "failed") return command.error;
  if (command.type === "start") return command.queued ? "Queued on your desktop" : "Started";
  return "Done";
}

// The last few things sent from this phone, so a start that hasn't shown up
// on the board yet isn't a mystery.
function PhoneCommands() {
  const recent = phoneCommands.value.filter((command) => Date.now() - Date.parse(command.createdAt) < 30 * 60_000).slice(0, 4);
  if (!recent.length) return null;
  return html`<ul class="phone-commands">
    ${recent.map((command) => html`<li class=${`is-${command.status}`}>
      <strong>${COMMAND_LABEL[command.type]}</strong>
      <span class="muted">${command.title || command.preview}</span>
      <span class=${command.status === "failed" ? "danger" : command.status === "done" ? "good" : "muted"}>${commandStatus(command)}</span>
    </li>`)}
  </ul>`;
}

function MoreMenu({ onChoose }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    ref.current?.querySelector("[role=menuitem]")?.focus();
    const close = (event) => {
      if (!ref.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      ref.current?.querySelector("button")?.focus();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return html`<div class="menu-anchor" ref=${ref}>
    <${Button} icon="more" aria-haspopup="menu" aria-expanded=${open ? "true" : "false"} onClick=${() => setOpen(!open)}>More</${Button}>
    ${open ? html`<div class="menu menu-right" role="menu">
      ${MORE_VIEWS.map((view) => html`<button type="button" role="menuitem" onClick=${() => { setOpen(false); onChoose(view.id); }}><${Icon} name=${view.icon} size=${15} />${view.label}</button>`)}
    </div>` : null}
  </div>`;
}

function Kpis() {
  const counts = board.value?.counts || {};
  const slots = board.value?.slots;
  return html`<div class="agent-kpi-row">
    <div class=${`kpi ${counts["needs-you"] ? "kpi-warn" : ""}`}><strong>${counts["needs-you"] || 0}</strong><span>need you</span></div>
    <div class="kpi"><strong>${counts.working || 0}</strong><span>working</span></div>
    ${slots && !isWeb.value ? html`<div class="kpi"><strong>${slots.used}/${slots.max}</strong><span>slots</span></div>` : null}
  </div>`;
}

function Intro() {
  if (!isWeb.value) {
    return html`<p class="muted">Plan tasks, start them in their own worktrees, and see each one through review to a merged pull request.</p>`;
  }
  const source = boardSource.value;
  return html`<p class="muted">${source ? `From ${source.device}, synced ${ago(source.receivedAt)}.` : "Connect a desktop in Settings → Devices to see its agents here."}${source && !remote.value ? " To start or steer agents from here, turn on phone control in Jarvis on that computer (Settings → Devices)." : ""}</p>`;
}

// What the main pane shows with no run open: the counts, the full board, and
// on the desktop the Usage, Labs and Hooks views.
function Overview({ view, setView, narrow }) {
  const web = isWeb.value;
  const [list, setList] = useState("list");
  return html`<div class="agents-overview-pane">
    <header class="page-head">
      <div>
        <div class="eyebrow">Agents ${web ? null : html`<span class=${`conn ${connected.value ? "is-on" : ""}`} title=${connected.value ? "Live" : "Reconnecting"}></span>`}</div>
        <h1>${web ? "Your agents" : "Your agents, in one place"}</h1>
        <${Intro} />
      </div>
      <div class="agent-kpis">
        <${Kpis} />
        ${web ? null : html`<${MoreMenu} onChoose=${setView} />`}
      </div>
    </header>
    ${web ? html`<${PhoneCommands} />` : null}
    ${view !== "board" ? html`<div class="hub-back"><${Button} size="sm" variant="ghost" icon="left" onClick=${() => setView("board")}>Board</${Button}><strong>${MORE_VIEWS.find((entry) => entry.id === view)?.label}</strong></div>` : null}
    ${view === "board" && narrow ? html`<div class="seg agents-list-switch" role="tablist" aria-label="Show">
      ${[["list", "Runs"], ["board", "Board"]].map(([id, label]) => html`<button type="button" role="tab" aria-selected=${list === id ? "true" : "false"} class=${list === id ? "is-active" : ""} onClick=${() => setList(id)}>${label}</button>`)}
    </div>` : null}
    ${view === "board" && narrow && list === "list" ? html`<${ThreadSidebar} canStart=${!web || Boolean(remote.value)} />` : null}
    ${view === "board" && (!narrow || list === "board") ? html`<${Board} inShell=${!narrow} />` : null}
    ${view === "usage" ? html`<${Usage} />` : null}
    ${view === "labs" ? html`<${Labs} onHooks=${() => setView("hooks")} />` : null}
    ${view === "hooks" ? html`<${HooksPanel} />` : null}
  </div>`;
}

export function AgentsPage() {
  const [view, setView] = useState("board");
  const narrow = useNarrow(960);
  // While a command from the phone is in flight, look more often.
  const waiting = waitingCommands.value.length > 0;
  // The open run lives in the address (#agents/<id>), so back and forward
  // work and a run can be linked to. The hash wins when it changes; a click
  // that changes the selection writes the hash.
  const param = route.value === "agents" ? routeParam.value : "";
  useEffect(() => {
    if (param !== (selectedAgent.value || "")) selectedAgent.value = param || null;
  }, [param]);
  const selected = selectedAgent.value;
  useEffect(() => {
    // Read the signal, not this render's copy: the effect above may have just
    // taken the run from the address.
    const current = selectedAgent.value || "";
    if (route.value === "agents" && current !== routeParam.value) navigate("agents", current);
  }, [selected]);
  useEffect(() => {
    if (isWeb.value) {
      const load = () => Promise.all([loadWebBoard(), loadPhoneCommands()]);
      load();
      const timer = setInterval(load, waiting ? 5_000 : 30_000);
      return () => clearInterval(timer);
    }
    return undefined;
  }, [waiting]);
  useEffect(() => {
    if (isWeb.value) return;
    loadAgents();
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
  }, []);
  const web = isWeb.value;
  const canStart = !web || Boolean(remote.value);
  const composer = canStart ? html`<${Composer} />` : null;
  const main = selected ? html`<${Workspace} id=${selected} />` : html`<${Overview} view=${view} setView=${setView} narrow=${narrow} />`;
  // A phone or a narrow window shows one pane at a time: the runs, or a run.
  if (narrow) return html`<div class="page page-agents is-narrow">${main}${composer}</div>`;
  return html`<div class="page page-agents agents-shell">
    <${ThreadSidebar} canStart=${canStart} overview=${!selected} onOverview=${() => { selectedAgent.value = null; setView("board"); }} />
    <main class="agents-main" aria-label=${selected ? "Agent run" : "Agents overview"}>${main}</main>
    ${composer}
  </div>`;
}
