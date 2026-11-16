import { useEffect, useRef, useState } from "preact/hooks";
import { html } from "./html.js";
import { Icon } from "./icons.js";
import { Button, CategoryTag, IconButton, Sheet, Skeleton } from "./ui.js";
import { MoveMenu } from "./task-bits.js";
import { get, post } from "./api.js";
import { categoryColor, formatDate, formatMinutes, relativeDay } from "./format.js";
import { logApplication } from "./jobs/jobs.js";
import { board, loadWebBoard, openComposer, openRun, remote } from "./agents/state.js";
import { canAskAgent, taskAgentDraft } from "./agents/task-request.js";
import { isWeb } from "./platform.js";
import { navigate, patchTask, refresh, reportError, revision, setTaskDone, sheetTaskId, skipTask, startFocusOn, toast, todayKey } from "./store.js";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

// Minimal, escape-first markdown for audit notes: bullets, **bold**, `code`.
export function renderMarkdown(text) {
  const lines = escapeHtml(text || "").split(/\n/);
  const inline = (line) => line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  let out = "";
  let inList = false;
  for (const line of lines) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!inList) out += "<ul>";
      inList = true;
      out += `<li>${inline(bullet[1])}</li>`;
      continue;
    }
    if (inList) out += "</ul>";
    inList = false;
    if (line.trim()) out += `<p>${inline(line)}</p>`;
  }
  if (inList) out += "</ul>";
  return out;
}

function useDebounced(callback, delay) {
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (...args) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => callback(...args), delay);
  };
}

function TaskSheetBody({ id, onClose }) {
  const [task, setTask] = useState(null);
  const [notes, setNotes] = useState("");
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const load = async () => {
    try {
      const data = await get(`/api/plan/task?id=${encodeURIComponent(id)}`);
      setTask(data.task);
      setNotes((current) => (current && current !== data.task.notes ? current : data.task.notes));
    } catch (loadError) {
      setError(loadError.message);
    }
  };
  useEffect(() => {
    setTask(null);
    setNotes("");
    load();
    // The phone only has the agent board once the Agents page has loaded it.
    if (isWeb.value && !board.value) loadWebBoard();
  }, [id]);
  useEffect(() => {
    if (task) load();
  }, [revision.value]);

  const saveNotes = useDebounced(async (value) => {
    const ok = await patchTask(id, { notes: value }, { quiet: true });
    setSaved(ok ? "Saved" : "Couldn't save");
  }, 600);

  if (error) return html`<div class="sheet-body"><p class="danger">${error}</p></div>`;
  if (!task) return html`<div class="sheet-body"><${Skeleton} lines=${8} /></div>`;
  const today = todayKey.value;
  const color = categoryColor(task.category);
  const moved = task.plannedDate !== task.date;
  const overdue = !task.done && task.date < today;
  const linked = (board.value?.sessions || []).filter((session) => session.taskId && session.taskId === task.id).slice(0, 3);

  return html`<div class="sheet-body" style=${{ "--cat": color }}>
    <header class="sheet-head">
      <div class="row gap-2 wrap">
        <${CategoryTag} category=${task.category} />
        ${task.repair ? html`<span class="pill pill-repair">Portfolio repair</span>` : null}
        ${task.custom ? html`<span class="pill">Custom</span>` : null}
        ${task.done ? html`<span class="pill pill-good">Done ${task.completedAt ? relativeDay(task.completedAt.slice(0, 10), today).toLowerCase() : ""}</span>` : null}
        ${task.skipped ? html`<span class="pill">Skipped</span>` : null}
        ${overdue ? html`<span class="pill pill-warn">Overdue</span>` : null}
        ${linked.map((session) => html`<button type="button" class=${`pill pill-accent status-${session.status}`} title="Open this agent" onClick=${() => { onClose(); openRun(session.id); }}><${Icon} name="bot" size=${12} /> Agent ${session.status.replace("-", " ")}</button>`)}
      </div>
      <${IconButton} icon="x" label="Close" onClick=${onClose} />
    </header>
    <h2 class="sheet-title">${task.title}</h2>
    <div class="sheet-facts">
      <span><${Icon} name="calendar" size=${14} />${formatDate(task.date, { weekday: "short", month: "short", day: "numeric" })}${moved ? html` <em>(planned ${formatDate(task.plannedDate, { month: "short", day: "numeric" })})</em>` : null}</span>
      <span><${Icon} name="clock" size=${14} />${formatMinutes(task.minutes)} block</span>
      ${task.accumulatedSeconds >= 60 ? html`<span><${Icon} name="focus" size=${14} />${formatMinutes(task.accumulatedSeconds / 60)} focused</span>` : null}
      ${task.phase ? html`<span><${Icon} name="roadmap" size=${14} />Week ${task.weekIndex + 1} · ${task.phase}</span>` : null}
    </div>

    <div class="sheet-actions">
      ${task.done
        ? html`<${Button} icon="undo" onClick=${() => setTaskDone(task, false)}>Mark not done</${Button}>`
        : html`<${Button} variant="primary" icon="focus" onClick=${() => { onClose(); startFocusOn(task); }}>Lock in</${Button}>
          <${Button} icon="check" onClick=${() => setTaskDone(task, true)}>Done</${Button}>`}
      <${MoveMenu} task=${task} align="left" />
      ${canAskAgent(task) && (!isWeb.value || remote.value) ? html`<${Button} size="sm" icon="bot" onClick=${() => { onClose(); navigate("agents"); openComposer(taskAgentDraft(task)); }}>Ask an agent</${Button}>` : null}
      ${task.category === "Applications" ? html`<${Button} size="sm" icon="briefcase" onClick=${() => { onClose(); logApplication(); }}>Log an application</${Button}>
        <${Button} size="sm" variant="ghost" onClick=${() => { onClose(); navigate("jobs"); }}>Open Jobs</${Button}>` : null}
      ${!task.done && !task.skipped ? html`<${IconButton} icon="x" label="Skip" onClick=${() => skipTask(task)} />` : null}
      ${task.skipped ? html`<${Button} size="sm" onClick=${() => skipTask(task, false)}>Unskip</${Button}>` : null}
      ${task.custom ? html`<${IconButton} icon="trash" label="Delete task" onClick=${async () => {
        try {
          await post("/api/plan/custom/delete", { id: task.id });
          toast("Task deleted");
          onClose();
          refresh();
        } catch (deleteError) {
          reportError(deleteError);
        }
      }} />` : null}
      ${moved || task.pinnedStart !== null ? html`<${Button} size="sm" variant="ghost" icon="undo" onClick=${async () => {
        const ok = await patchTask(task.id, { date: task.plannedDate, pinnedStart: null });
        if (ok) toast("Back on its planned day and slot.");
      }}>Back to plan</${Button}>` : null}
    </div>

    ${task.detail ? html`<section class="sheet-section"><h4>What to do</h4><p class="prose">${task.detail}</p></section>` : null}
    ${task.doneWhen ? html`<section class="sheet-section done-when"><h4><${Icon} name="flag" size=${14} /> Done when</h4><p>${task.doneWhen}</p></section>` : null}

    ${task.order.map((set) => html`<section class="sheet-section">
      <div class="row space-between"><h4>${set.label}</h4><span class="muted small">Step ${set.position} of ${set.total}</span></div>
      <ol class="order-steps">
        ${set.steps.map((step) => html`<li class=${step.done ? "is-done" : step.skipped ? "is-skipped" : ""}>
          ${step.current
            ? html`<div class="order-step" aria-current="step"><${Icon} name="right" size=${14} /><span>${step.title}</span><em>This task</em></div>`
            : html`<button type="button" class="order-step" onClick=${() => { sheetTaskId.value = step.id; }}><${Icon} name=${step.done ? "check" : step.skipped ? "skip" : "clock"} size=${14} /><span>${step.title}</span><em>${step.done ? "Done" : step.skipped ? "Skipped" : relativeDay(step.date, today)}</em></button>`}
        </li>`)}
      </ol>
    </section>`)}

    ${task.resources.length ? html`<section class="sheet-section"><h4>Resources</h4>
      <div class="resources">
        ${task.resources.map((resource) => html`<a class="resource" href=${resource.url} target="_blank" rel="noreferrer">
          <span class="resource-kind">${resource.kind || "Link"}</span>
          <span class="resource-main"><strong>${resource.title}</strong>${resource.assignment ? html`<span>${resource.assignment}</span>` : null}</span>
          <${Icon} name="external" size=${14} />
        </a>`)}
      </div>
    </section>` : null}

    ${task.auditItems.length ? html`<section class="sheet-section"><h4>Audit items in this session</h4>
      <p class="muted small">Historical findings, not a fresh audit. Verify the current code first and record evidence for each ID.</p>
      ${task.auditItems.map((item) => html`<details class="audit-item">
        <summary><span class="audit-id">${item.id}</span><span>${item.title}</span></summary>
        <div class="prose md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(item.detail) }}></div>
        <a class="link" href=${item.url} target="_blank" rel="noreferrer">Open ${item.repo} fix list <${Icon} name="external" size=${12} /></a>
      </details>`)}
    </section>` : null}

    <section class="sheet-section">
      <div class="row space-between"><h4>Notes</h4><span class="muted small">${saved}</span></div>
      <textarea class="notes" rows="6" placeholder="What you did, what blocked you, what to remember…" value=${notes}
        onInput=${(event) => { setNotes(event.currentTarget.value); setSaved("Saving…"); saveNotes(event.currentTarget.value); }}></textarea>
      <label class="field inline">
        <span class="field-label">Evidence link</span>
        <input type="url" placeholder="https://github.com/…" value=${task.evidenceUrl}
          onChange=${(event) => patchTask(task.id, { evidenceUrl: event.currentTarget.value.trim() })} />
      </label>
      <label class="field inline">
        <span class="field-label">Block length</span>
        <select value=${task.minutes} onChange=${(event) => patchTask(task.id, { minutes: Number(event.currentTarget.value) })}>
          ${[...new Set([15, 20, 25, 30, 40, 45, 60, 75, 90, 120, 150, 180, task.minutes])].sort((a, b) => a - b).map((minutes) => html`<option value=${minutes}>${formatMinutes(minutes)}</option>`)}
        </select>
      </label>
    </section>

    ${task.sessions.length ? html`<section class="sheet-section"><h4>Focus sessions</h4>
      <div class="sessions">
        ${task.sessions.map((session) => html`<div class="session-row">
          <span>${formatDate(session.startedAt.slice(0, 10), { month: "short", day: "numeric" })}</span>
          <span>${formatMinutes(session.accumulatedSeconds / 60)}</span>
          <span class=${session.earlyExit ? "warn" : "muted"}>${session.earlyExit ? `left early${session.earlyExit.reason ? `: ${session.earlyExit.reason}` : ""}` : session.status}</span>
        </div>`)}
      </div>
    </section>` : null}
    ${task.neetcode.length ? html`<section class="sheet-section"><h4>Logged problems</h4>
      ${task.neetcode.map((entry) => html`<div class="session-row"><span>${entry.problem}</span><span class=${`nc-badge nc-${entry.result}`}>${entry.result}</span></div>`)}
    </section>` : null}
  </div>`;
}

export function TaskSheet() {
  const id = sheetTaskId.value;
  const close = () => {
    sheetTaskId.value = null;
  };
  return html`<${Sheet} open=${Boolean(id)} onClose=${close} title="Task details">${id ? html`<${TaskSheetBody} id=${id} onClose=${close} />` : null}</${Sheet}>`;
}
