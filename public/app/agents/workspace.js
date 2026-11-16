import { useEffect, useRef, useState } from "preact/hooks";
import { html } from "../html.js";
import { Icon } from "../icons.js";
import { Button, Skeleton, Tabs } from "../ui.js";
import { get } from "../api.js";
import { toast, reportError, storage } from "../store.js";
import { agentAction, board, composer, openComposer, phoneCommand, remote, selectedAgent, waitingCommands } from "./state.js";
import { isWeb } from "../platform.js";
import { ago, lastOpened, PrChip, projectName, ProviderBadge, tokens, useNarrow } from "./board.js";
import { Changes } from "./changes.js";
import { awaitingApproval, conversationItems, retryPrompt } from "./logic.js";

const KIND_ICON = { command: "bolt", edit: "note", read: "book", search: "search", prompt: "send", message: "bot", plan: "flag", tool: "layers", result: "check", error: "x", status: "clock" };
const APPROVAL = "Approved. Go ahead and implement the plan.";

const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
const otherProvider = (provider) => (provider === "claude" ? "codex" : "claude");
const providerName = (provider) => (provider === "codex" ? "Codex" : "Claude");

function Timeline({ events }) {
  if (!events?.length) return html`<p class="muted small">No activity recorded yet.</p>`;
  return html`<ol class="agent-timeline">
    ${events.map((item) => html`<li class=${`tl-${item.kind} ${item.ok === false ? "is-bad" : item.ok === true ? "is-ok" : ""}`}>
      <span class="tl-icon"><${Icon} name=${KIND_ICON[item.kind] || "more"} size=${13} /></span>
      <div class="tl-body">
        <div class="tl-line"><span class="tl-title">${item.title}</span>${item.at ? html`<time>${clock(item.at)}</time>` : null}</div>
        ${item.detail && item.detail !== item.title ? html`<details><summary class="muted small">More</summary><pre class="tl-detail">${item.detail}</pre></details>` : null}
      </div>
    </li>`)}
  </ol>`;
}

function LoopPanel({ loop }) {
  // The phone's board carries only the number of iterations, not the list.
  const iterations = Array.isArray(loop.iterations) ? loop.iterations : [];
  return html`<div class="loop-panel">
    <div class="row space-between"><strong><${Icon} name="loop" size=${14} /> ${loop.check ? html`Loop until <code>${loop.check}</code> passes` : "Loop"}</strong><span class=${`pill ${loop.status === "passed" ? "pill-good" : loop.status === "running" ? "pill-accent" : "pill-warn"}`}>${loop.status}</span></div>
    <ol class="loop-iterations">
      ${iterations.map((iteration) => html`<li class=${iteration.checkOk ? "is-ok" : "is-bad"}>
        <span>#${iteration.n}</span>
        <span>${iteration.checkOk ? "check passed" : `check failed (exit ${iteration.checkCode})`}</span>
        <span class="muted">${iteration.diff.files} files · +${iteration.diff.added} −${iteration.diff.removed}</span>
        ${!iteration.checkOk && iteration.tail ? html`<details><summary class="muted small">Output fed back</summary><pre class="tl-detail">${iteration.tail.slice(-1500)}</pre></details>` : null}
      </li>`)}
    </ol>
    ${loop.status === "running" ? html`<p class="muted small">Iteration ${iterations.length + 1} of ${loop.maxIterations} in progress…</p>` : null}
  </div>`;
}

function Conversation({ items, working, current, onRetry }) {
  const ref = useRef(null);
  const stuck = useRef(true);
  // Follow new messages, unless you've scrolled up to read something.
  useEffect(() => {
    if (stuck.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [items.length, working, current]);
  const onScroll = (event) => {
    const box = event.currentTarget;
    stuck.current = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  };
  return html`<div class="ws-conversation" ref=${ref} onScroll=${onScroll} tabindex="0" aria-label="Conversation">
    ${!items.length && !working ? html`<p class="muted small">Nothing yet.</p>` : null}
    ${items.map((item) => {
      if (item.type === "activity") {
        const last = item.events[item.events.length - 1];
        return html`<details class="ws-activity"><summary><${Icon} name=${KIND_ICON[last.kind] || "more"} size=${13} /><span>${item.events.length} ${item.events.length === 1 ? "step" : "steps"}</span><span class="muted ws-activity-last">${last.title}</span></summary><${Timeline} events=${item.events} /></details>`;
      }
      if (item.type === "you") {
        return html`<div class="ws-msg ws-msg-you">
          <div class="ws-bubble">${item.text}</div>
          <div class="ws-msg-foot"><time>${clock(item.at)}</time>${onRetry ? html`<button type="button" class="link-btn" onClick=${() => onRetry(item.index)}>Retry from here</button>` : null}</div>
        </div>`;
      }
      return html`<div class=${`ws-msg ws-msg-${item.type}`}><div class="ws-bubble">${item.text}</div><div class="ws-msg-foot"><time>${clock(item.at)}</time></div></div>`;
    })}
    ${working ? html`<p class="ws-working"><span class="live-dot"></span><span>${current || "Working…"}</span></p>` : null}
  </div>`;
}

function PlanCard({ onApprove, onChanges }) {
  return html`<div class="ws-plan-card" role="group" aria-label="Plan approval">
    <div><strong>The plan is ready</strong><p class="muted small">Approving lets the agent edit files in its worktree.</p></div>
    <div class="row gap-2 wrap">
      <${Button} size="sm" variant="primary" icon="check" onClick=${onApprove}>Approve</${Button}>
      <${Button} size="sm" onClick=${onChanges}>Request changes</${Button}>
    </div>
  </div>`;
}

function ReplyBox({ session, text, setText, mode, setMode, inputRef, onSend, disabledNote }) {
  const working = ["working", "starting", "checking"].includes(session.status);
  if (disabledNote) return html`<p class="muted small">${disabledNote}</p>`;
  return html`<div class="follow-up">
    <textarea ref=${inputRef} class="input" rows="3" aria-label="Message the agent" placeholder=${working ? "Queue a message for when this turn ends…" : session.mode === "plan" ? "Revise the plan, or ask a question…" : "Follow up: what should it do next?"} value=${text} onInput=${(event) => setText(event.currentTarget.value)}
      onKeyDown=${(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) onSend(); }}></textarea>
    <div class="row space-between">
      <div class="seg" role="radiogroup" aria-label="Mode for this message">${[["plan", "Plan"], ["edit", "Edit"]].map(([id, label]) => html`<button type="button" role="radio" aria-checked=${mode === id ? "true" : "false"} class=${mode === id ? "is-active" : ""} onClick=${() => setMode(id)}>${label}</button>`)}</div>
      <${Button} size="sm" variant="primary" icon="send" disabled=${!text.trim()} onClick=${onSend}>${working ? "Queue" : "Send"}</${Button}>
    </div>
  </div>`;
}

function PendingMessages({ session, onRemove, onSendNow }) {
  const waiting = session.pendingMessages || [];
  if (typeof waiting === "number") return waiting ? html`<p class="muted small">${waiting} ${waiting === 1 ? "message" : "messages"} queued on your desktop.</p>` : null;
  if (!waiting.length) return null;
  const working = ["working", "starting", "checking"].includes(session.status);
  return html`<div class="ws-pending">
    <div class="row space-between"><strong class="small">${working ? "Goes out when this turn ends" : "Waiting to be sent"}</strong>${!working ? html`<${Button} size="sm" icon="send" onClick=${onSendNow}>Send now</${Button}>` : null}</div>
    <ul>${waiting.map((message) => html`<li key=${message.id}><span>${message.text}</span><button type="button" class="link-btn" aria-label=${`Remove queued message: ${message.text}`} onClick=${() => onRemove(message.id)}>Remove</button></li>`)}</ul>
  </div>`;
}

function RunActions({ session, detail, onFixChecks }) {
  const working = ["working", "starting", "checking"].includes(session.status);
  const removed = detail.worktreeRemoved || !detail.worktree;
  const kept = session.outcome === "kept";
  if (session.status === "queued") {
    return html`<footer class="ws-actions"><${Button} size="sm" icon="x" onClick=${async () => { if (await agentAction("runs/cancel", { id: session.runId }, "Removed from the queue")) selectedAgent.value = null; }}>Cancel</${Button}></footer>`;
  }
  const commit = async () => {
    const data = await agentAction("runs/keep", { id: session.runId });
    if (data) toast(data.committed ? `Committed to ${data.branch}` : `Kept ${data.branch} (nothing new to commit)`, { tone: "good" });
  };
  const openPr = async () => {
    if (!window.confirm(`Commit any open work, push ${session.branch} to GitHub and open a pull request?`)) return;
    const data = await agentAction("runs/pr", { id: session.runId }, "Pull request opened");
    if (data?.url) window.open(data.url, "_blank");
  };
  const push = async () => {
    if (!window.confirm(`Commit the agent's new work and push it to ${session.branch}?`)) return;
    await agentAction("runs/push", { id: session.runId }, "Pushed to the pull request");
  };
  const discard = async () => {
    if (!window.confirm(kept ? "Remove the worktree folder? The branch is kept." : "Discard this run? Its worktree and branch are deleted.")) return;
    if (await agentAction("runs/discard", { id: session.runId }, kept ? "Worktree removed" : "Discarded")) selectedAgent.value = null;
  };
  if (removed && !session.prUrl) return null;
  return html`<footer class="ws-actions">
    ${!working && !removed && (!kept || session.unsaved) && !session.prUrl ? html`<${Button} size="sm" icon="check" onClick=${commit}>Commit to branch</${Button}>` : null}
    ${!working && !removed && !session.prUrl ? html`<${Button} size="sm" icon="github" onClick=${openPr}>${kept && !session.unsaved ? "Open PR" : "Commit and open PR"}</${Button}>` : null}
    ${!working && !removed && session.prUrl && session.unsaved ? html`<${Button} size="sm" variant="primary" icon="github" onClick=${push}>Push fixes</${Button}>` : null}
    ${!working && !removed && session.pr?.checks?.failing ? html`<${Button} size="sm" icon="wrench" onClick=${onFixChecks}>Fix failing checks</${Button}>` : null}
    ${!working && !removed && session.kind !== "review" ? html`<${Button} size="sm" variant="ghost" icon="eye" onClick=${() => openComposer({ provider: otherProvider(session.provider), reviewId: session.runId, projectId: session.project?.id, title: session.title, mode: "plan" })}>Review with ${providerName(otherProvider(session.provider))}</${Button}>` : null}
    ${session.prUrl ? html`<${Button} size="sm" variant="ghost" icon="wave" onClick=${() => agentAction("runs/pr/refresh", { id: session.runId })}>Refresh PR</${Button}>` : null}
    <span class="ws-actions-gap"></span>
    ${!removed ? html`<${Button} size="sm" variant="ghost" icon="external" onClick=${() => agentAction("open", { path: detail.worktree })}>VS Code</${Button}>` : null}
    ${!removed ? html`<${Button} size="sm" variant="ghost" icon="trash" onClick=${discard}>${kept ? "Remove worktree" : "Discard"}</${Button}>` : null}
  </footer>`;
}

function resumeCommand(session) {
  if (session.provider === "codex") return `codex resume ${session.sessionId}`;
  return `claude --resume ${session.sessionId}`;
}

function OutsideNote({ session }) {
  return html`<footer class="ws-actions ws-outside">
    <p class="muted small">Started outside Jarvis${session.entrypoint ? ` (${session.entrypoint})` : ""}. Jarvis watches it; steer it where it's running.</p>
    ${!isWeb.value && session.sessionId ? html`<${Button} size="sm" icon="note" onClick=${async () => { await navigator.clipboard?.writeText(resumeCommand(session)); toast("Resume command copied"); }}>Copy resume command</${Button}>` : null}
    ${!isWeb.value && session.cwd ? html`<${Button} size="sm" variant="ghost" icon="external" onClick=${() => agentAction("open", { path: session.cwd })}>Open folder in VS Code</${Button}>` : null}
  </footer>`;
}

export function Workspace({ id }) {
  const [detail, setDetail] = useState(null);
  const [tab, setTab] = useState("changes");
  const [text, setText] = useState("");
  const [mode, setMode] = useState("edit");
  const inputRef = useRef(null);
  const headRef = useRef(null);
  const narrow = useNarrow(960);
  // The side panel (Changes, Logs, Prompt) stays open or shut across runs.
  const [panelOpen, setPanelOpen] = useState(() => storage.get("jarvis-agents-panel", "open") === "open");
  const togglePanel = () => setPanelOpen((open) => {
    storage.set("jarvis-agents-panel", open ? "closed" : "open");
    return !open;
  });
  const phone = isWeb.value;
  const live = board.value?.sessions.find((session) => session.id === id);
  const close = () => {
    lastOpened.id = id;
    selectedAgent.value = null;
  };
  // The web only has the synced snapshot, not the live session files.
  const load = () => (phone
    ? Promise.resolve(setDetail(live ? { ...live } : null))
    : get(`/api/agents/session?id=${encodeURIComponent(id)}`).then((data) => setDetail(data.session)).catch(reportError));
  useEffect(() => {
    setDetail(null);
    setText("");
    // One pane at a time opens on the conversation; side by side, the panel
    // starts on the changes.
    setTab(narrow ? "chat" : id.startsWith("run:") && !phone ? "changes" : "logs");
    load();
    window.scrollTo?.({ top: 0 });
  }, [id]);
  const session = detail ? { ...detail, ...(live || {}) } : live;
  // Waits for the heading to exist, since a new run isn't on the board straight away.
  const ready = Boolean(session);
  useEffect(() => {
    if (ready) headRef.current?.focus();
  }, [id, ready]);
  useEffect(() => {
    if (detail) load();
  }, [live?.updatedAt, live?.status, live?.recent?.length]);
  useEffect(() => {
    if (live?.mode) setMode(live.mode);
  }, [id, live?.mode]);
  useEffect(() => {
    const onKey = (event) => {
      if (composer.value) return;
      // Ctrl+D (Cmd+D on a Mac) shows or hides the side panel, as in T3 Code.
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "d" && !narrow) {
        event.preventDefault();
        togglePanel();
        return;
      }
      if (event.key !== "Escape" || event.target.closest?.("textarea, input, select, [role=dialog]")) return;
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [id, narrow]);

  if (!session) {
    return html`<div class="workspace">
      <div><${Button} size="sm" variant="ghost" icon="left" onClick=${close}>Agents</${Button}></div>
      ${detail === null && board.value ? html`<${Skeleton} lines=${8} />` : html`<p class="muted">This agent is no longer on the board.</p>`}
    </div>`;
  }

  const isRun = Boolean(session.runId);
  const working = ["working", "starting", "checking"].includes(session.status);
  const looping = session.loop?.status === "running";
  const items = conversationItems(detail?.recent || session.recent || []);
  const hasWorktree = phone ? !session.worktreeRemoved : Boolean(detail?.worktree) && !detail?.worktreeRemoved;
  const canControl = isRun && (!phone || Boolean(remote.value));
  const waitingCommand = phone ? waitingCommands.value.find((command) => command.runId === session.runId) : null;

  const message = async (body, success) => {
    if (phone) return phoneCommand("message", { runId: session.runId, prompt: body.text, mode: body.mode });
    return agentAction("runs/message", { id: session.runId, ...body }, success);
  };
  const send = async () => {
    if (!text.trim()) return;
    const sent = await message({ text, mode }, working ? "Queued for when this turn ends" : "Sent to the agent");
    if (sent) setText("");
  };
  const requestChanges = () => {
    setMode("plan");
    setTimeout(() => inputRef.current?.focus());
  };
  const fixChecks = async () => {
    try {
      const data = await get(`/api/agents/runs/pr/failures?id=${encodeURIComponent(session.runId)}`);
      setText(data.prompt);
      setMode("edit");
      if (narrow) setTab("chat");
      setTimeout(() => inputRef.current?.focus());
    } catch (error) {
      reportError(error);
    }
  };
  const retry = (index) => openComposer({
    provider: session.provider,
    model: session.model,
    effort: session.effort,
    projectId: session.project?.id,
    title: `Retry: ${session.title}`.slice(0, 120),
    prompt: retryPrompt(items, index),
    mode: session.mode,
    base: detail.baseSha,
    retryOf: session.runId,
    taskId: session.taskId,
    taskTitle: session.taskTitle
  });

  const panels = [
    ...(narrow ? [{ id: "chat", label: "Conversation", icon: "bot" }] : []),
    ...(isRun && !phone && session.status !== "queued" ? [{ id: "changes", label: "Changes", icon: "branch" }] : []),
    { id: "logs", label: phone ? "Recent" : "Logs", icon: "list" },
    ...(isRun && !phone ? [{ id: "prompt", label: "Prompt", icon: "send" }] : [])
  ];
  // The queued state has no Changes tab, and the wide layout has no Conversation one.
  const active = panels.some((panel) => panel.id === tab) ? tab : narrow ? "chat" : "logs";

  const chat = html`<section class="ws-chat" aria-label="Conversation with the agent">
    <${Conversation} items=${items} working=${working} current=${session.current} onRetry=${!phone && isRun && session.kind === "task" && detail?.baseSha ? retry : null} />
    ${phone && isRun ? html`<p class="muted small">Showing recent activity. The full history is on your desktop.</p>` : null}
    <div class="ws-dock">
    ${awaitingApproval(session) && hasWorktree && canControl && !waitingCommand ? html`<${PlanCard} onApprove=${() => message({ text: APPROVAL, mode: "edit" }, "Approved. The agent is starting")} onChanges=${requestChanges} />` : null}
    ${canControl ? html`<${PendingMessages} session=${session}
      onRemove=${(messageId) => agentAction("runs/message/remove", { id: session.runId, messageId })}
      onSendNow=${() => agentAction("runs/message", { id: session.runId, text: "" }, "Sent to the agent")} />` : null}
    ${waitingCommand ? html`<p class="muted small"><span class="live-dot"></span> ${waitingCommand.status === "claimed" ? "Your desktop is on it…" : "Sent. Waiting for your desktop…"}</p>` : null}
    ${canControl && !waitingCommand && session.status !== "queued" ? html`<${ReplyBox} session=${session} text=${text} setText=${setText} mode=${mode} setMode=${setMode} inputRef=${inputRef} onSend=${send}
      disabledNote=${!hasWorktree ? "This run's worktree was removed, so it can't continue." : looping ? "The loop is running. Stop it to reply." : ""} />` : null}
    ${phone && isRun && !remote.value ? html`<p class="muted small">Synced from your desktop. Turn on phone control in Jarvis on that computer (Settings → Devices) to steer it from here.</p>` : null}
    </div>
  </section>`;

  const actions = phone
    ? (isRun ? html`<p class="muted small ws-note">Commit, discard and pull requests stay on your desktop.</p>` : html`<${OutsideNote} session=${session} />`)
    : isRun ? (detail ? html`<${RunActions} session=${session} detail=${detail} onFixChecks=${fixChecks} />` : null) : html`<${OutsideNote} session=${session} />`;
  const showSide = narrow || panelOpen;

  return html`<div class=${`workspace ${narrow ? "is-narrow" : "is-wide"}`}>
    <header class="ws-head">
      ${narrow ? html`<${Button} size="sm" variant="ghost" icon="left" onClick=${close}>Agents</${Button}>` : null}
      <div class="ws-title">
        <h2 ref=${headRef} tabindex="-1">${session.title}</h2>
        <div class="ws-facts">
          <${ProviderBadge} provider=${session.provider} />
          <span class=${`pill status-pill status-${session.status}`}>${session.status.replace("-", " ")}</span>
          ${session.model ? html`<span class="pill">${session.model}</span>` : null}
          <span class="ws-where"><${Icon} name="branch" size=${13} />${projectName(session) || "—"}${session.branch ? html` · <code>${session.branch}</code>` : null}</span>
          ${session.taskTitle ? html`<span class="ws-where"><${Icon} name="flag" size=${13} />${session.taskTitle}</span>` : null}
          ${session.tokens ? html`<span class="muted small">${tokens(session.tokens, session.tokensKind)}</span>` : null}
          <span class="muted small">Updated ${ago(session.updatedAt)}</span>
          ${session.prUrl ? html`<a class="ws-pr" href=${session.prUrl} target="_blank" rel="noreferrer"><${PrChip} pr=${session.pr} /></a>` : null}
        </div>
      </div>
      ${canControl && working ? html`<${Button} size="sm" icon="stop" onClick=${() => (phone ? phoneCommand("stop", { runId: session.runId }, "Stop sent to your desktop") : agentAction("runs/stop", { id: session.runId }, "Stopping…"))}>Stop</${Button}>` : null}
      ${phone && canControl && session.status === "queued" ? html`<${Button} size="sm" icon="x" onClick=${() => phoneCommand("cancel", { runId: session.runId }, "Cancel sent to your desktop")}>Cancel</${Button}>` : null}
      ${narrow ? null : html`<button type="button" class=${`icon-btn ws-panel-toggle ${panelOpen ? "is-on" : ""}`} aria-pressed=${panelOpen ? "true" : "false"} aria-label=${panelOpen ? "Hide side panel" : "Show side panel"} title=${`${panelOpen ? "Hide" : "Show"} changes and logs (Ctrl+D)`} onClick=${togglePanel}><${Icon} name="layers" size=${17} /></button>`}
    </header>
    ${actions}
    ${session.status === "needs-you" && session.waitingFor && !awaitingApproval(session) ? html`<div class="agent-callout"><${Icon} name="flag" size=${15} /><span>${session.waitingFor}</span></div>` : null}
    ${session.settingsDiffer ? html`<p class="warn small">The provider reported different settings than requested. The Prompt tab has both.</p>` : null}
    ${detail?.error ? html`<p class="danger small">${detail.error}</p>` : null}
    ${session.pr?.error ? html`<p class="warn small">Couldn't update the pull request's status: ${session.pr.error}</p>` : null}
    <div class=${`ws-body ${narrow ? "is-narrow" : ""} ${showSide ? "" : "is-solo"}`}>
      ${narrow ? null : chat}
      ${showSide ? html`<section class="ws-side" aria-label="Changes and logs">
        <${Tabs} value=${active} onChange=${setTab} tabs=${panels} />
        <div class="ws-panel">
          ${active === "chat" ? chat : null}
          ${active === "changes" ? html`<${Changes} runId=${session.runId} version=${`${session.status}:${session.turns}:${session.outcome}:${session.unsaved}`} />` : null}
          ${active === "logs" ? html`${session.loop ? html`<${LoopPanel} loop=${session.loop} />` : null}<${Timeline} events=${[...(detail?.recent || session.recent || [])].reverse()} />` : null}
          ${active === "prompt" ? html`
            ${session.origin === "jarvis" ? html`<p class="muted small">Requested: ${session.model || "provider default"} · ${session.effort || "default"} strength. Reported: ${session.effectiveModel || "model not reported"} · ${session.effectiveEffort || "strength not reported"}.</p>` : null}
            <pre class="tl-detail">${detail?.prompt}</pre>
            ${(detail?.turnsDetail || []).length > 1 ? html`<h4>Turns</h4><ol class="turns">${detail.turnsDetail.map((turn) => html`<li><span class=${turn.ok ? "good" : turn.ok === false ? "danger" : "muted"}>${turn.mode}</span> ${turn.prompt}</li>`)}</ol>` : null}` : null}
        </div>
      </section>` : null}
    </div>
  </div>`;
}
