import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { html } from "./html.js";
import { Icon } from "./icons.js";
import { Bar, Button, Check, Empty, IconButton, Modal, Ring, Skeleton } from "./ui.js";
import { MoveMenu, TaskRow } from "./task-bits.js";
import { SpotifyPlayer } from "./spotify.js";
import { JobsCard } from "./jobs/jobs.js";
import { can } from "./platform.js";
import { get } from "./api.js";
import {
  addDays, categoryColor, CATEGORY_META, CATEGORY_ORDER, clock, formatDate, formatMinutes, percent, plural, relativeDay, shortClock
} from "./format.js";
import {
  day, focusState, loadDay, meta, moveTask, navigate, neetcodePrompt, openTask, patchTask, previewSpread, revision, setTaskDone, spreadPreview, startFocusOn, todayKey, triage, viewDate
} from "./store.js";

const PX_PER_MIN = 1.3;

function useNowMinutes() {
  const read = () => {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  };
  const [now, setNow] = useState(read);
  useEffect(() => {
    const timer = setInterval(() => setNow(read()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function blockIcon(kind) {
  return kind === "class" ? "school" : kind === "gym" ? "dumbbell" : kind === "meal" ? "meal" : "clock";
}

// ---------- timeline ----------
function Timeline({ data, nowMinutes }) {
  const { dayStart, dayEnd } = data.settings;
  const [drag, setDrag] = useState(null);
  const dragRef = useRef(null);
  const ref = useRef(null);
  const hours = [];
  for (let minute = Math.ceil(dayStart / 60) * 60; minute <= dayEnd; minute += 60) hours.push(minute);
  const top = (minute) => (minute - dayStart) * PX_PER_MIN;
  const showNow = data.isToday && nowMinutes >= dayStart && nowMinutes <= dayEnd;

  useEffect(() => {
    if (!showNow || !ref.current) return;
    const scroller = ref.current.closest(".timeline-scroll");
    if (scroller) scroller.scrollTop = Math.max(0, top(nowMinutes) - 160);
  }, [data.date]);

  const startDrag = (event, block) => {
    // Buttons inside the block (checkbox, play) handle their own clicks.
    if (event.button !== 0 || event.target.closest("button")) return;
    if (block.task.done) {
      openTask(block.task.id);
      return;
    }
    const startY = event.clientY;
    const origin = block.start;
    let moved = false;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const onMove = (moveEvent) => {
      const delta = (moveEvent.clientY - startY) / PX_PER_MIN;
      if (Math.abs(delta) > 4) moved = true;
      const snapped = Math.round((origin + delta) / 5) * 5;
      const length = block.end - block.start;
      const start = Math.max(dayStart, Math.min(dayEnd - length, snapped));
      dragRef.current = { id: block.id, start, end: start + length };
      setDrag(dragRef.current);
    };
    const onUp = async () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      const current = dragRef.current;
      dragRef.current = null;
      if (!moved) {
        setDrag(null);
        openTask(block.task.id);
        return;
      }
      if (!current || current.start === origin) {
        setDrag(null);
        return;
      }
      const patch = { pinnedStart: current.start };
      if (block.task.date !== data.date) patch.date = data.date;
      await patchTask(block.task.id, patch);
      await loadDay(data.date);
      setDrag(null);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  };

  return html`<div class="timeline" ref=${ref} style=${{ height: `${(dayEnd - dayStart) * PX_PER_MIN + 24}px` }}>
    ${hours.map((minute) => html`<div class="timeline-hour" style=${{ top: `${top(minute)}px` }}><span>${shortClock(minute)}</span></div>`)}
    ${data.blocks.map((block) => {
      if (block.kind !== "task") {
        // Meals can run a timer too, so you know when to get back to it.
        const timed = block.kind === "meal";
        return html`<div class=${`tl-fixed tl-${block.kind}`} style=${{ top: `${top(block.start)}px`, height: `${Math.max(18, (block.end - block.start) * PX_PER_MIN - 3)}px` }}>
          <${Icon} name=${blockIcon(block.kind)} size=${14} /><span>${block.title}</span><em>${clock(block.start)}</em>
          ${timed ? html`<button type="button" class="tl-play" aria-label=${`Lock in for ${block.title}`} title="Lock in"
            onClick=${() => startFocusOn({ title: block.title, minutes: block.end - block.start, kind: "break" })}>
            <${Icon} name="play" size=${12} />
          </button>` : null}
        </div>`;
      }
      const task = block.task;
      const live = drag?.id === block.id ? drag : block;
      const height = Math.max(26, (live.end - live.start) * PX_PER_MIN - 4);
      const active = focusState.value?.session?.taskId === task.id;
      const past = data.isToday && live.end < nowMinutes && !task.done;
      return html`<div class=${`tl-task ${task.done ? "is-done" : ""} ${height < 46 ? "is-short" : ""} ${drag?.id === block.id ? "is-dragging" : ""} ${active ? "is-active" : ""} ${past ? "is-past" : ""} ${task.date < data.date ? "is-carried" : ""}`}
        style=${{ top: `${top(live.start)}px`, height: `${height}px`, "--cat": categoryColor(task.category) }}
        onPointerDown=${(event) => startDrag(event, block)}
        onKeyDown=${(event) => event.key === "Enter" && openTask(task.id)}
        role="button" tabindex="0" aria-label=${`${task.title}, ${clock(live.start)}, ${formatMinutes(task.minutes)}`}>
        <${Check} checked=${task.done} onChange=${(value) => setTaskDone(task, value)} label=${`Mark ${task.title} done`} color=${categoryColor(task.category)} />
        <div class="tl-task-main">
          <strong>${task.title}</strong>
          <span>${clock(live.start)} · ${formatMinutes(task.minutes)}${task.date < data.date ? " · carried" : ""}${task.pinnedStart !== null ? " · pinned" : ""}</span>
        </div>
        ${!task.done ? html`<button type="button" class="tl-play" aria-label=${`Focus on ${task.title}`}
          onPointerDown=${(event) => event.stopPropagation()} onClick=${(event) => { event.stopPropagation(); startFocusOn(task); }}>
          <${Icon} name="play" size=${12} />
        </button>` : null}
      </div>`;
    })}
    ${showNow ? html`<div class="timeline-now" style=${{ top: `${top(nowMinutes)}px` }}><span>${clock(Math.floor(nowMinutes))}</span></div>` : null}
  </div>`;
}

// ---------- rail cards ----------
function UpNext({ data, nowMinutes }) {
  const session = focusState.value?.session;
  const taskBlocks = data.blocks.filter((block) => block.kind === "task" && !block.task.done);
  const upcoming = data.isToday ? taskBlocks.find((block) => block.end > nowMinutes) || taskBlocks[0] : taskBlocks[0];
  if (session) {
    return html`<section class="card card-hero is-live">
      <div class="card-eyebrow"><span class="live-dot"></span>In a focus session</div>
      <h3>${session.label || data.tasks.find((task) => task.id === session.taskId)?.title || "Focus session"}</h3>
      <p class="muted">${formatMinutes(session.elapsedSeconds / 60)} of ${formatMinutes(session.plannedMinutes)} · ${session.status === "paused" ? "paused" : "running"}</p>
      <${Button} variant="primary" icon="focus" onClick=${() => navigate("focus")}>Return to focus</${Button}>
    </section>`;
  }
  if (!upcoming) {
    return html`<section class="card card-hero">
      <div class="card-eyebrow">Up next</div>
      <h3>${data.tasks.length ? "Everything here is done." : "Nothing planned."}</h3>
      <p class="muted">${data.isToday ? "Take the win, or pull something forward from the roadmap." : "A clear day."}</p>
      <${Button} icon="roadmap" onClick=${() => navigate("roadmap")}>Open roadmap</${Button}>
    </section>`;
  }
  const task = upcoming.task;
  const startsIn = Math.round(upcoming.start - nowMinutes);
  return html`<section class="card card-hero" style=${{ "--cat": categoryColor(task.category) }}>
    <div class="card-eyebrow"><span class="dot" style=${{ background: "var(--cat)" }}></span>
      ${data.isToday ? (startsIn > 0 ? `Up next · ${clock(upcoming.start)}` : "Now") : `First up · ${clock(upcoming.start)}`}</div>
    <h3 onClick=${() => openTask(task.id)} class="clickable">${task.title}</h3>
    <p class="muted">${CATEGORY_META[task.category]?.label} · ${formatMinutes(task.minutes)}${task.date < data.date ? ` · from ${relativeDay(task.date, data.date).toLowerCase()}` : ""}</p>
    <div class="row gap-2">
      <${Button} variant="primary" icon="focus" onClick=${() => startFocusOn(task)}>Lock in</${Button}>
      <${Button} icon="check" onClick=${() => setTaskDone(task, true)}>Done</${Button}>
    </div>
  </section>`;
}

function WeekOutcome({ week }) {
  if (!week) return null;
  return html`<section class="card">
    <div class="card-head">
      <div><div class="card-eyebrow">Week ${week.number} outcome</div><h3>${week.title}</h3></div>
      <${IconButton} icon="arrow" label="Open week" onClick=${() => navigate("roadmap", week.start)} />
    </div>
    <p class="outcome">${week.goal}</p>
    <div class="checkpoint"><${Icon} name="flag" size=${14} /><p>${week.checkpoint}</p></div>
    <div class="row space-between small muted"><span>${week.done}/${week.total} tasks</span><span>${percent(week.done, week.total)}%</span></div>
    <${Bar} value=${week.total ? week.done / week.total : 0} />
  </section>`;
}

function CategoryMinutes({ tasks, date }) {
  const totals = useMemo(() => {
    const map = new Map();
    for (const task of tasks) {
      if (task.date !== date || task.skipped) continue;
      const entry = map.get(task.category) || { minutes: 0, done: 0 };
      entry.minutes += task.minutes;
      if (task.done) entry.done += task.minutes;
      map.set(task.category, entry);
    }
    return CATEGORY_ORDER.filter((category) => map.has(category)).map((category) => ({ category, ...map.get(category) }));
  }, [tasks, date]);
  if (!totals.length) return null;
  const max = Math.max(...totals.map((entry) => entry.minutes));
  return html`<section class="card">
    <div class="card-eyebrow">Today by category</div>
    <div class="cat-bars">
      ${totals.map((entry) => html`<div class="cat-bar" style=${{ "--cat": categoryColor(entry.category) }}>
        <span class="cat-bar-label">${CATEGORY_META[entry.category]?.short}</span>
        <div class="cat-bar-track"><span class="cat-bar-planned" style=${{ width: `${(entry.minutes / max) * 100}%` }}></span><span class="cat-bar-done" style=${{ width: `${(entry.done / max) * 100}%` }}></span></div>
        <span class="cat-bar-value">${formatMinutes(entry.done)}<em>/${formatMinutes(entry.minutes)}</em></span>
      </div>`)}
    </div>
  </section>`;
}

function NeetcodeCard({ date }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    get(`/api/plan/neetcode?date=${date}`).then(setData).catch(() => setData(null));
  }, [date, revision.value]);
  if (!data) return null;
  const { stats, reviews } = data;
  return html`<section class="card">
    <div class="card-head">
      <div><div class="card-eyebrow">NeetCode</div><h3>${stats.total} solved${stats.streakDays ? html` · <span class="accent">${stats.streakDays}-day streak</span>` : ""}</h3></div>
      <${IconButton} icon="plus" label="Log a problem" onClick=${() => { neetcodePrompt.value = { taskId: null, title: "Log a problem" }; }} />
    </div>
    ${stats.total ? html`<div class="nc-split">
      ${["independent", "hinted", "studied"].map((result) => html`<span class=${`nc-${result}`} style=${{ flex: stats.counts[result] || 0.0001 }} title=${`${stats.counts[result]} ${result}`}></span>`)}
    </div>
    <div class="nc-legend small muted"><span><i class="nc-independent"></i>${stats.counts.independent} solo</span><span><i class="nc-hinted"></i>${stats.counts.hinted} hinted</span><span><i class="nc-studied"></i>${stats.counts.studied} studied</span></div>` : html`<p class="muted small">Log each problem when you finish a NeetCode block. Misses come back for review after 7 and 21 days.</p>`}
    ${reviews.length ? html`<div class="nc-reviews">
      <div class="card-eyebrow">Due for review</div>
      ${reviews.slice(0, 4).map((item) => html`<a class="nc-review" href=${item.entry.url || "https://neetcode.io/practice"} target="_blank" rel="noreferrer">
        <span class=${`nc-badge nc-${item.entry.result}`}>${item.interval}d</span><span>${item.entry.problem}</span><${Icon} name="external" size=${13} />
      </a>`)}
    </div>` : null}
  </section>`;
}

// ---------- carried-over triage ----------
function Triage({ data }) {
  const carried = data.carried.filter((task) => !task.done);
  const [selected, setSelected] = useState(() => new Set());
  const [open, setOpen] = useState(carried.length <= 6);
  useEffect(() => setSelected(new Set()), [data.date, carried.length]);
  if (!data.isToday || !carried.length) return null;

  const groups = CATEGORY_ORDER.map((category) => ({ category, tasks: carried.filter((task) => task.category === category) })).filter((group) => group.tasks.length);
  const ids = [...selected];
  const scope = ids.length ? ids : carried.map((task) => task.id);
  const toggle = (id, value) => {
    const next = new Set(selected);
    if (value) next.add(id);
    else next.delete(id);
    setSelected(next);
  };
  const run = async (action, extra = {}) => {
    const result = await triage({ action, ids: scope, ...extra });
    if (result) setSelected(new Set());
  };
  const spread = () => previewSpread(scope);
  const nextMonday = addDays(data.date, 7 - ((new Date(`${data.date}T12:00:00Z`).getUTCDay() + 6) % 7));
  const minutes = carried.reduce((sum, task) => sum + task.minutes, 0);

  return html`<section class="card triage">
    <div class="card-head">
      <div>
        <div class="card-eyebrow warn"><${Icon} name="undo" size=${13} /> Carried over</div>
        <h3>${plural(carried.length, "unfinished task")} · ${formatMinutes(minutes)}</h3>
      </div>
      <${IconButton} icon=${open ? "down" : "right"} label=${open ? "Collapse" : "Expand"} onClick=${() => setOpen(!open)} />
    </div>
    <p class="muted small">Decide what happens to these before adding new work. Actions apply to ${ids.length ? `the ${ids.length} selected` : "all of them"}.</p>
    <div class="triage-actions">
      <${Button} size="sm" variant="primary" icon="sparkles" onClick=${spread}>Spread over the week</${Button}>
      <${Button} size="sm" icon="skip" onClick=${() => run("move", { date: nextMonday })}>Next week</${Button}>
      <${Button} size="sm" icon="check" onClick=${() => run("done")}>Done</${Button}>
      <${Button} size="sm" icon="x" variant="ghost" onClick=${() => run("skip")}>Skip</${Button}>
    </div>
    ${open ? html`<div class="triage-groups">
      ${groups.map((group) => html`<div class="triage-group">
        <div class="triage-group-head" style=${{ "--cat": categoryColor(group.category) }}>
          <span class="dot" style=${{ background: "var(--cat)" }}></span>${CATEGORY_META[group.category]?.label}<em>${group.tasks.length}</em>
          <button type="button" class="link" onClick=${() => {
            const next = new Set(selected);
            const all = group.tasks.every((task) => next.has(task.id));
            group.tasks.forEach((task) => (all ? next.delete(task.id) : next.add(task.id)));
            setSelected(next);
          }}>${group.tasks.every((task) => selected.has(task.id)) ? "Clear" : "Select"}</button>
        </div>
        ${group.tasks.map((task) => html`<${TaskRow} task=${task} compact selectable selected=${selected.has(task.id)} onSelect=${(value) => toggle(task.id, value)} />`)}
      </div>`)}
    </div>` : null}
  </section>`;
}

function SpreadPreview({ data }) {
  const preview = spreadPreview.value;
  const [busy, setBusy] = useState(false);
  const tasks = new Map(data.tasks.map((task) => [task.id, task]));
  return html`<${Modal} open=${Boolean(preview)} onClose=${() => { if (!busy) spreadPreview.value = null; }} title="Spread carried work over the week">
      ${preview ? html`<div class="modal-body">
        ${preview.stale ? html`<p class="warn" role="status">Your schedule or available time changed. Review this updated preview and confirm again.</p>` : null}
        <p class="muted">From ${formatDate(preview.from, { weekday: "long" })} to ${formatDate(preview.to, { weekday: "long", month: "short", day: "numeric" })}, using time still ahead of you. Past blocks and existing unfinished work keep their times, unless a later step has to follow an earlier one or an AN- ticket needs the time.</p>
        <div class="move-preview">
          ${preview.moves.map((move) => {
            const task = tasks.get(move.id);
            return html`<div class="move-row" style=${{ "--cat": categoryColor(task?.category || move.category) }}><span class="dot" style=${{ background: "var(--cat)" }}></span><span>${task?.title || move.title || move.id}${move.keepOrder ? html` <small class="muted">keeps order</small>` : null}${move.bumped ? html` <small class="muted">makes room</small>` : null}</span><em>${relativeDay(move.to, data.date)} · ${clock(move.start)}–${clock(move.end)}</em></div>`;
          })}
        </div>
        ${preview.reclaimed?.length ? html`<h4>Completed tasks whose time will be reused</h4><p class="muted small">These stay completed and move to the Completed list.</p><div class="move-preview">
          ${preview.reclaimed.map((entry) => html`<div class="move-row"><span>${tasks.get(entry.id)?.title || entry.title || entry.id}</span><em>${relativeDay(entry.date, data.date)} · ${clock(entry.start)}–${clock(entry.end)}</em></div>`)}
        </div>` : null}
        ${preview.unplaced.length ? html`<p class="warn small">${plural(preview.unplaced.length, "task")} won't fit this week in order and will stay in Today.</p>` : null}
        ${preview.protected?.length ? html`<p class="muted small">${plural(preview.protected.length, "selected task")} will keep its current placement, including any task in a focus session.</p>` : null}
        ${!preview.moves.length ? html`<p class="muted">No carried tasks can be moved into the available time.</p>` : null}
      </div>
      <footer class="modal-foot">
        <${Button} variant="ghost" disabled=${busy} onClick=${() => { spreadPreview.value = null; }}>Cancel</${Button}>
        <${Button} variant="primary" icon="check" disabled=${busy || !preview.moves.length} onClick=${async () => {
          setBusy(true);
          try {
            const result = await triage({ action: "rebalance", reclaimCompleted: true, ids: preview.ids, days: preview.days, previewToken: preview.previewToken });
            if (result?.stale) spreadPreview.value = result;
            else if (result) spreadPreview.value = null;
          } finally { setBusy(false); }
        }}>${busy ? "Moving…" : `Move ${plural(preview.moves.length, "task")}`}</${Button}>
      </footer>` : null}
    </${Modal}>`;
}

function Unscheduled({ tasks }) {
  const [all, setAll] = useState(false);
  if (!tasks.length) return null;
  const shown = all ? tasks : tasks.slice(0, 5);
  return html`<div class="unscheduled">
    <div class="row space-between">
      <div class="card-eyebrow warn">Doesn't fit today · ${tasks.length} · ${formatMinutes(tasks.reduce((sum, task) => sum + task.minutes, 0))}</div>
      ${tasks.length > 5 ? html`<button type="button" class="link small" onClick=${() => setAll(!all)}>${all ? "Show less" : `Show all ${tasks.length}`}</button>` : null}
    </div>
    ${shown.map((task) => html`<${TaskRow} task=${task} compact />`)}
  </div>`;
}

// ---------- page ----------
export function TodayPage() {
  const data = day.value;
  const info = meta.value;
  const nowMinutes = useNowMinutes();
  const today = todayKey.value;

  const go = async (date) => {
    viewDate.value = date;
    await loadDay(date);
  };

  if (!data || !info) return html`<div class="page"><${Skeleton} lines=${6} /></div>`;
  const own = data.tasks.filter((task) => task.date === data.date);
  const done = own.filter((task) => task.done).length;
  const week = data.week;
  const over = data.plannedMinutes - data.availableMinutes;
  const remaining = own.filter((task) => !task.done).reduce((sum, task) => sum + task.minutes, 0);

  return html`<div class="page page-today">
    <header class="today-head">
      <div class="today-title">
        <div class="eyebrow">
          ${week ? html`<span>Week ${week.number} of ${info.weeks.length}</span><span class="sep"></span><span>${week.phase}</span>` : html`<span>Outside the roadmap window</span>`}
        </div>
        <h1>${formatDate(data.date, { weekday: "long" })}<span class="muted">, ${formatDate(data.date, { month: "long", day: "numeric" })}</span></h1>
        ${week ? html`<p class="today-sub">This week: <strong>${week.title}</strong></p>` : null}
      </div>
      <div class="today-tools">
        <div class="date-nav">
          <${IconButton} icon="left" label="Previous day" onClick=${() => go(addDays(data.date, -1))} />
          <button type="button" class=${`date-nav-label ${data.isToday ? "is-today" : ""}`} onClick=${() => go(today)}>${data.isToday ? "Today" : relativeDay(data.date, today)}</button>
          <${IconButton} icon="right" label="Next day" onClick=${() => go(addDays(data.date, 1))} />
        </div>
        <${Button} variant="primary" icon="focus" onClick=${() => startFocusOn(null)}>Lock in</${Button}>
      </div>
    </header>

    <section class="today-stats">
      <div class="stat stat-ring">
        <${Ring} value=${own.length ? done / own.length : 0} size=${58} stroke=${6} label="Today's progress"><strong>${percent(done, own.length)}<small>%</small></strong></${Ring}>
        <div><strong>${done} of ${own.length}</strong><span>tasks done today</span></div>
      </div>
      <div class="stat"><strong>${formatMinutes(remaining)}</strong><span>left on today's plan</span></div>
      <div class=${`stat ${over > 0 ? "stat-warn" : ""}`}><strong>${formatMinutes(data.availableMinutes)}</strong><span>${over > 0 ? `free · ${formatMinutes(over)} over` : "free between fixed blocks"}</span></div>
      <div class="stat"><strong>${formatMinutes((focusState.value?.today?.seconds || 0) / 60)}</strong><span>focused today${focusState.value?.streakDays ? ` · ${focusState.value.streakDays}-day streak` : ""}</span></div>
    </section>

    <div class="today-grid">
      <section class="card card-flush timeline-card">
        <div class="card-head padded">
          <div><div class="card-eyebrow">Schedule</div><h3>${formatDate(data.date, { weekday: "long", month: "short", day: "numeric" })}</h3></div>
          <span class="muted small">Drag to re-slot · click to open</span>
        </div>
        <div class="timeline-scroll"><${Timeline} data=${data} nowMinutes=${nowMinutes} /></div>
        <${Unscheduled} tasks=${data.unscheduled} />
        ${data.completed?.length ? html`<section class="unscheduled"><h3>Completed — time reused</h3><p class="muted small">Your completed work is saved; its scheduled time was used for unfinished work.</p>${data.completed.map((task) => html`<${TaskRow} task=${task} compact />`)}</section>` : null}

      </section>

      <aside class="today-rail">
        <${UpNext} data=${data} nowMinutes=${nowMinutes} />
        <${Triage} data=${data} />
        <${WeekOutcome} week=${week} />
        <${JobsCard} />
        ${can.value.spotify ? html`<section class="card card-tight"><${SpotifyPlayer} variant="rail" /></section>` : null}
        <${CategoryMinutes} tasks=${data.tasks} date=${data.date} />
        <${NeetcodeCard} date=${data.date} />
        ${!own.length && !data.carried.length ? html`<${Empty} icon="sparkles" title="Nothing scheduled">Use the roadmap to pull work into this day.</${Empty}>` : null}
      </aside>
    </div>
    <${SpreadPreview} data=${data} />
  </div>`;
}

export { MoveMenu };
