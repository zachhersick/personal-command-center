// Small task building blocks shared by Today, Roadmap and the palette.
import { useEffect, useRef, useState } from "preact/hooks";
import { html } from "./html.js";
import { Icon } from "./icons.js";
import { Check, IconButton } from "./ui.js";
import { addDays, categoryColor, CATEGORY_META, formatMinutes, relativeDay, weekStart } from "./format.js";
import { moveTask, openTask, setTaskDone, skipTask, startFocusOn, todayKey } from "./store.js";

export function MoveMenu({ task, onDone, align = "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const today = todayKey.value;
  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (!ref.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const go = async (date) => {
    setOpen(false);
    await moveTask(task, date);
    onDone?.();
  };
  const nextMonday = addDays(weekStart(today), 7);
  return html`<div class="menu-anchor" ref=${ref} onClick=${(event) => event.stopPropagation()}>
    <${IconButton} icon="calendar" label="Reschedule" size=${16} class="ghost" onClick=${() => setOpen(!open)} aria-expanded=${open ? "true" : "false"} />
    ${open ? html`<div class=${`menu menu-${align}`} role="menu">
      <button role="menuitem" onClick=${() => go(today)}><${Icon} name="today" size=${15} />Today</button>
      <button role="menuitem" onClick=${() => go(addDays(today, 1))}><${Icon} name="right" size=${15} />Tomorrow</button>
      <button role="menuitem" onClick=${() => go(nextMonday)}><${Icon} name="skip" size=${15} />Next week</button>
      <label class="menu-date"><span>Pick a day</span><input type="date" value=${task.date} min=${addDays(today, -60)}
        onChange=${(event) => event.currentTarget.value && go(event.currentTarget.value)} /></label>
      <hr />
      <button role="menuitem" onClick=${() => { setOpen(false); skipTask(task); }}><${Icon} name="x" size=${15} />Skip it</button>
    </div>` : null}
  </div>`;
}

export function TaskRow({ task, showDate = false, selectable = false, selected = false, onSelect, compact = false }) {
  const color = categoryColor(task.category);
  const late = !task.done && task.date < todayKey.value;
  return html`<div class=${`task-row ${task.done ? "is-done" : ""} ${task.skipped ? "is-skipped" : ""} ${compact ? "is-compact" : ""}`}
    style=${{ "--cat": color }} onClick=${() => openTask(task.id)} role="button" tabindex="0"
    onKeyDown=${(event) => event.key === "Enter" && openTask(task.id)}>
    ${selectable
      ? html`<${Check} checked=${selected} onChange=${(value) => onSelect?.(value)} label=${`Select ${task.title}`} color="var(--accent)" />`
      : html`<${Check} checked=${task.done} onChange=${(value) => setTaskDone(task, value)} label=${`Mark ${task.title} done`} color=${color} />`}
    <div class="task-row-main">
      <span class="task-row-title">${task.title}</span>
      <span class="task-row-meta">
        <span class="dot" style=${{ background: color }}></span>${CATEGORY_META[task.category]?.short || task.category}
        <span>·</span>${formatMinutes(task.minutes)}
        ${showDate || late ? html`<span>·</span><span class=${late ? "late" : ""}>${late ? `from ${relativeDay(task.date, todayKey.value).toLowerCase()}` : relativeDay(task.date, todayKey.value)}</span>` : null}
        ${task.repair ? html`<span class="pill pill-repair">repair</span>` : null}
        ${task.accumulatedSeconds >= 60 ? html`<span>·</span><span>${formatMinutes(task.accumulatedSeconds / 60)} focused</span>` : null}
      </span>
    </div>
    ${!task.done && !selectable ? html`<div class="task-row-actions">
      <${IconButton} icon="play" label=${`Focus on ${task.title}`} size=${14} class="ghost play" onClick=${(event) => { event.stopPropagation(); startFocusOn(task); }} />
      <${MoveMenu} task=${task} />
    </div>` : null}
  </div>`;
}
