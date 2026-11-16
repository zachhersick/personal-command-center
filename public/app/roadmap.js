import { useEffect, useMemo, useState } from "preact/hooks";
import { html } from "./html.js";
import { Icon } from "./icons.js";
import { Bar, Button, Check, Empty, Field, IconButton, Modal, Ring, Skeleton, Tabs } from "./ui.js";
import { TaskRow } from "./task-bits.js";
import { get, post } from "./api.js";
import {
  addDays, categoryColor, CATEGORY_META, CATEGORY_ORDER, formatDate, formatMinutes, percent, plural, rangeLabel, shortDate, weekStart, weekday
} from "./format.js";
import { meta, moveTask, navigate, neetcodePrompt, openTask, refresh, reportError, revision, routeParam, setTaskDone, toast, todayKey, triage } from "./store.js";
import { renderMarkdown } from "./task-sheet.js";

const TAB_KEY = "jarvis-roadmap-tab";

// ---------- 34-week timeline ----------
function PhaseTimeline({ info, selected, onSelect }) {
  return html`<div class="phase-timeline" role="list">
    ${info.phases.map((phase) => html`<div class="phase" role="listitem" style=${{ flex: phase.endIndex - phase.startIndex + 1 }}>
      <div class="phase-label" title=${phase.name}>${phase.name}</div>
      <div class="phase-weeks">
        ${info.weeks.slice(phase.startIndex, phase.endIndex + 1).map((week) => {
          const ratio = week.total ? week.done / week.total : 0;
          const past = week.end < info.todayKey;
          const current = week.index === info.currentWeekIndex;
          return html`<button type="button" class=${`wk ${current ? "is-current" : ""} ${week.start === selected ? "is-selected" : ""} ${past ? "is-past" : ""}`}
            onClick=${() => onSelect(week.start)} title=${`Week ${week.number}: ${week.title} · ${week.done}/${week.total}`}
            aria-label=${`Week ${week.number}, ${week.title}, ${percent(week.done, week.total)}% done`}>
            <span class="wk-fill" style=${{ height: `${Math.max(ratio * 100, ratio ? 6 : 0)}%` }}></span>
            <span class="wk-num">${week.number}</span>
          </button>`;
        })}
      </div>
    </div>`)}
  </div>`;
}

// ---------- week board ----------
function DayColumn({ dayData, filter, hideDone, onDropTask, selection, onToggle }) {
  const [over, setOver] = useState(false);
  const tasks = dayData.tasks.filter((task) => (!filter.size || filter.has(task.category)) && (!hideDone || (!task.done && !task.skipped)));
  const load = dayData.availableMinutes ? dayData.remainingMinutes / dayData.availableMinutes : 0;
  return html`<div class=${`day-col ${dayData.isToday ? "is-today" : ""} ${dayData.isPast ? "is-past" : ""} ${over ? "is-over" : ""}`}
    onDragOver=${(event) => { event.preventDefault(); setOver(true); }}
    onDragLeave=${() => setOver(false)}
    onDrop=${(event) => { event.preventDefault(); setOver(false); const id = event.dataTransfer.getData("text/task-id"); if (id) onDropTask(id, dayData.date); }}>
    <header class="day-col-head">
      <div><strong>${weekday(dayData.date)}</strong><span>${shortDate(dayData.date)}</span></div>
      ${dayData.isToday ? html`<span class="pill pill-accent">Today</span>` : null}
    </header>
    <div class="day-load" title=${`${formatMinutes(dayData.remainingMinutes)} left of ${formatMinutes(dayData.availableMinutes)} free`}>
      <${Bar} value=${Math.min(1, load)} color=${load > 1 ? "var(--danger)" : load > 0.85 ? "var(--warn)" : "var(--accent)"} />
      <span class=${load > 1 ? "danger" : "muted"}>${formatMinutes(dayData.plannedMinutes)}${dayData.unscheduled.length ? ` · ${dayData.unscheduled.length} won't fit` : ""}</span>
    </div>
    <div class="day-col-tasks">
      ${tasks.map((task) => html`<div class=${`board-card ${task.done ? "is-done" : ""} ${task.skipped ? "is-skipped" : ""} ${selection.has(task.id) ? "is-selected" : ""} ${dayData.unscheduled.includes(task.id) ? "is-unfit" : ""}`}
        style=${{ "--cat": categoryColor(task.category) }} draggable=${!task.done}
        onDragStart=${(event) => { event.dataTransfer.setData("text/task-id", task.id); event.dataTransfer.effectAllowed = "move"; }}
        onClick=${(event) => (event.shiftKey || event.ctrlKey || event.metaKey ? onToggle(task.id) : openTask(task.id))}
        role="button" tabindex="0" onKeyDown=${(event) => event.key === "Enter" && openTask(task.id)}>
        <${Check} checked=${task.done} onChange=${(value) => setTaskDone(task, value)} label=${`Mark ${task.title} done`} color=${categoryColor(task.category)} />
        <div class="board-card-main">
          <span class="board-card-title">${task.title}</span>
          <span class="board-card-meta">${CATEGORY_META[task.category]?.short} · ${formatMinutes(task.minutes)}${task.date !== task.plannedDate ? " · moved" : ""}${task.repair ? " · repair" : ""}</span>
        </div>
      </div>`)}
      ${!tasks.length ? html`<div class="day-col-empty">${dayData.tasks.length ? "All filtered" : "Free"}</div>` : null}
    </div>
  </div>`;
}

function AddTaskModal({ open, onClose, defaultDate }) {
  const [form, setForm] = useState({ title: "", date: defaultDate, category: "Personal", minutes: 30, detail: "" });
  useEffect(() => setForm((current) => ({ ...current, date: defaultDate })), [defaultDate, open]);
  const set = (key) => (event) => setForm({ ...form, [key]: key === "minutes" ? Number(event.currentTarget.value) : event.currentTarget.value });
  const submit = async (event) => {
    event.preventDefault();
    try {
      await post("/api/plan/custom", form);
      toast(`Added "${form.title}"`);
      setForm({ ...form, title: "", detail: "" });
      onClose();
      refresh();
    } catch (error) {
      reportError(error);
    }
  };
  return html`<${Modal} open=${open} onClose=${onClose} title="Add a task">
    <form class="modal-body form" onSubmit=${submit}>
      <${Field} label="Title"><input class="input" autofocus required maxlength="200" value=${form.title} onInput=${set("title")} placeholder="e.g. Follow up with the recruiter" /></${Field}>
      <div class="form-row">
        <${Field} label="Day"><input class="input" type="date" required value=${form.date} onInput=${set("date")} /></${Field}>
        <${Field} label="Length"><select class="input" value=${form.minutes} onChange=${set("minutes")}>${[15, 20, 30, 45, 60, 90, 120].map((value) => html`<option value=${value}>${formatMinutes(value)}</option>`)}</select></${Field}>
      </div>
      <${Field} label="Category"><select class="input" value=${form.category} onChange=${set("category")}>${CATEGORY_ORDER.map((category) => html`<option value=${category}>${CATEGORY_META[category].label}</option>`)}</select></${Field}>
      <${Field} label="Notes (optional)"><textarea class="input" rows="3" value=${form.detail} onInput=${set("detail")}></textarea></${Field}>
      <footer class="modal-foot flush"><${Button} variant="ghost" onClick=${onClose}>Cancel</${Button}><${Button} variant="primary" type="submit" icon="plus">Add task</${Button}></footer>
    </form>
  </${Modal}>`;
}

function WeekBoard({ start, info }) {
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState(() => new Set());
  const [hideDone, setHideDone] = useState(false);
  const [selection, setSelection] = useState(() => new Set());
  const [adding, setAdding] = useState(false);
  const load = () => get(`/api/plan/week?date=${start}`).then(setData).catch(reportError);
  useEffect(() => {
    setData(null);
    setSelection(new Set());
    load();
  }, [start]);
  useEffect(() => {
    if (data) load();
  }, [revision.value]);

  if (!data) return html`<${Skeleton} lines=${8} />`;
  const week = data.week;
  const index = info.weeks.findIndex((entry) => entry.start === start);
  const categories = CATEGORY_ORDER.filter((category) => data.categories[category]);
  const toggleFilter = (category) => {
    const next = new Set(filter);
    if (next.has(category)) next.delete(category);
    else next.add(category);
    setFilter(next);
  };
  const toggleSelect = (id) => {
    const next = new Set(selection);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelection(next);
  };
  const drop = async (id, date) => {
    const task = data.days.flatMap((entry) => entry.tasks).find((entry) => entry.id === id);
    if (!task || task.date === date) return;
    const ids = selection.has(id) && selection.size > 1 ? [...selection] : null;
    if (ids) {
      await triage({ action: "move", ids, date });
      setSelection(new Set());
    } else await moveTask(task, date);
  };
  const bulk = async (action, extra = {}) => {
    await triage({ action, ids: [...selection], ...extra });
    setSelection(new Set());
  };

  return html`<section class="week-board">
    <header class="week-head">
      <div class="week-head-nav">
        <${IconButton} icon="left" label="Previous week" disabled=${index <= 0} onClick=${() => navigate("roadmap", info.weeks[index - 1].start)} />
        <div>
          <div class="eyebrow">${week ? html`Week ${week.number} · ${week.phase}` : "Outside the plan"} <span class="sep"></span> ${rangeLabel(data.start, data.end)}</div>
          <h2>${week?.title || "Free week"}</h2>
        </div>
        <${IconButton} icon="right" label="Next week" disabled=${index < 0 || index >= info.weeks.length - 1} onClick=${() => navigate("roadmap", info.weeks[index + 1].start)} />
      </div>
      <div class="week-head-stats">
        <${Ring} value=${data.summary.total ? data.summary.done / data.summary.total : 0} size=${52} stroke=${5}><strong>${percent(data.summary.done, data.summary.total)}<small>%</small></strong></${Ring}>
        <div><strong>${data.summary.done}/${data.summary.total} done</strong><span class="muted">${formatMinutes(data.summary.careerDoneMinutes)} of ${formatMinutes(data.summary.careerMinutes)} career prep</span></div>
      </div>
    </header>
    ${week ? html`<div class="week-brief">
      <div class="brief-block"><span class="eyebrow">Outcome</span><p>${week.goal}</p></div>
      <div class="brief-block"><span class="eyebrow"><${Icon} name="flag" size=${12} /> Checkpoint</span><p>${week.checkpoint}</p></div>
    </div>` : null}
    <div class="board-toolbar">
      <div class="chips">
        ${categories.map((category) => html`<button type="button" class=${`chip chip-cat ${filter.has(category) ? "is-active" : ""}`} style=${{ "--cat": categoryColor(category) }} onClick=${() => toggleFilter(category)}>
          <i></i>${CATEGORY_META[category].short}<em>${data.categories[category].done}/${data.categories[category].total}</em>
        </button>`)}
        ${filter.size ? html`<button type="button" class="link small" onClick=${() => setFilter(new Set())}>Clear</button>` : null}
      </div>
      <div class="row gap-2">
        <label class="toggle"><input type="checkbox" checked=${hideDone} onChange=${(event) => setHideDone(event.currentTarget.checked)} /><span>Hide done</span></label>
        <${Button} size="sm" icon="plus" onClick=${() => setAdding(true)}>Add task</${Button}>
      </div>
    </div>
    ${selection.size ? html`<div class="bulk-bar">
      <strong>${plural(selection.size, "task")} selected</strong>
      <${Button} size="sm" icon="check" onClick=${() => bulk("done")}>Done</${Button}>
      <${Button} size="sm" icon="skip" onClick=${() => bulk("move", { date: addDays(data.start, 7) })}>Next week</${Button}>
      <${Button} size="sm" icon="sparkles" onClick=${() => bulk("rebalance", { from: todayKey.value > data.start ? todayKey.value : data.start })}>Spread out</${Button}>
      <${Button} size="sm" icon="x" variant="ghost" onClick=${() => bulk("skip")}>Skip</${Button}>
      <button type="button" class="link small" onClick=${() => setSelection(new Set())}>Clear</button>
    </div>` : html`<p class="muted small board-hint">Drag cards between days. Shift-click to select several.</p>`}
    <div class="board">
      ${data.days.map((entry) => html`<${DayColumn} dayData=${entry} filter=${filter} hideDone=${hideDone} onDropTask=${drop} selection=${selection} onToggle=${toggleSelect} />`)}
    </div>
    <${AddTaskModal} open=${adding} onClose=${() => setAdding(false)} defaultDate=${todayKey.value >= data.start && todayKey.value <= data.end ? todayKey.value : data.start} />
  </section>`;
}

// ---------- portfolio repair track ----------
function RepairTrack() {
  const [data, setData] = useState(null);
  useEffect(() => {
    get("/api/plan/portfolio").then(setData).catch(reportError);
  }, [revision.value]);
  if (!data) return html`<${Skeleton} lines=${8} />`;
  const done = data.sessions.filter((session) => session.done).length;
  const minutes = data.sessions.reduce((sum, session) => sum + session.minutes, 0);
  return html`<section class="repair">
    <div class="repair-intro card">
      <div>
        <div class="eyebrow">Portfolio repair track</div>
        <h2>Fix the evidence behind the claims</h2>
        <p class="muted">${data.items.length} audit items mapped to ${data.sessions.length} weekend sessions (${formatMinutes(minutes)}). Verify current code first, fix only what remains, and record evidence. Unfinished sessions carry into Today.</p>
      </div>
      <div class="repair-repos">
        ${data.repos.map((repo) => html`<div class="repo-progress">
          <div class="row space-between"><strong>${repo.repo}</strong><span class="muted small">${repo.closed}/${repo.items}</span></div>
          <${Bar} value=${repo.items ? repo.closed / repo.items : 0} color="var(--cat-build)" />
        </div>`)}
        <div class="muted small">${done}/${data.sessions.length} sessions complete</div>
      </div>
    </div>
    <div class="repair-list">
      ${data.sessions.map((session) => html`<button type="button" class=${`repair-row ${session.done ? "is-done" : ""} ${session.date < todayKey.value && !session.done ? "is-late" : ""}`} onClick=${() => openTask(session.id)}>
        <span class="repair-date"><strong>${weekday(session.date)}</strong>${shortDate(session.date)}</span>
        <span class="repair-main">
          <strong>${session.title}</strong>
          <span class="repair-ids">${session.fixIds.map((id) => html`<code>${id}</code>`)}</span>
        </span>
        <span class="repair-meta">${session.done ? html`<span class="pill pill-good">Done</span>` : html`${formatMinutes(session.minutes)}`}</span>
      </button>`)}
    </div>
    <details class="card audit-index">
      <summary><strong>All ${data.items.length} audit items</strong><span class="muted small"> · source fix lists as of ${data.asOf}</span></summary>
      <p class="muted small">${data.sourceNote}</p>
      <div class="audit-grid">
        ${data.items.map((item) => html`<a class=${`audit-chip ${item.closed ? "is-closed" : ""}`} href=${item.url} target="_blank" rel="noreferrer" title=${item.title}><code>${item.id}</code><span>${item.title}</span></a>`)}
      </div>
    </details>
  </section>`;
}

// ---------- library ----------
function Library() {
  const [weeks, setWeeks] = useState(null);
  const [kind, setKind] = useState("systems");
  useEffect(() => {
    get("/api/plan/library").then((data) => setWeeks(data.weeks)).catch(reportError);
  }, [revision.value]);
  if (!weeks) return html`<${Skeleton} lines=${8} />`;
  return html`<section class="library">
    <div class="seg">
      <button type="button" class=${kind === "systems" ? "is-active" : ""} onClick=${() => setKind("systems")}>Hello Interview</button>
      <button type="button" class=${kind === "behavioral" ? "is-active" : ""} onClick=${() => setKind("behavioral")}>Behavioral</button>
      <button type="button" class=${kind === "study" ? "is-active" : ""} onClick=${() => setKind("study")}>Study & build</button>
    </div>
    <div class="library-list">
      ${weeks.map((week) => {
        if (kind === "study") {
          return html`<div class="lib-row">
            <span class="lib-week">W${week.index + 1}</span>
            <div class="lib-main">
              <strong>${week.title}</strong>
              ${[...week.study, ...week.build].map((item) => html`<button type="button" class=${`lib-sub ${item.task?.done ? "is-done" : ""}`} disabled=${!item.task} onClick=${() => item.task && openTask(item.task.id)}>
                <${Icon} name=${item.task?.done ? "check" : "right"} size=${13} />${item.title}<em>${formatMinutes(item.minutes)}</em>
              </button>`)}
            </div>
          </div>`;
        }
        const item = week[kind];
        if (!item) return null;
        return html`<div class=${`lib-row ${item.task?.done ? "is-done" : ""}`}>
          <span class="lib-week">W${week.index + 1}</span>
          <div class="lib-main">
            <button type="button" class="lib-title" disabled=${!item.task} onClick=${() => item.task && openTask(item.task.id)}>
              ${item.task?.done ? html`<${Icon} name="check" size=${14} />` : null}${item.title}
            </button>
            <p class="muted small">${item.detail}</p>
            <div class="lib-resources">
              ${(item.resources || []).map((resource) => html`<a href=${resource.url} target="_blank" rel="noreferrer" title=${resource.assignment || ""}><span class="resource-kind">${resource.kind}</span>${resource.title}</a>`)}
            </div>
          </div>
          <span class="muted small">${item.task ? shortDate(item.task.date) : ""}</span>
        </div>`;
      })}
    </div>
  </section>`;
}

// ---------- NeetCode ----------
function NeetcodeTab() {
  const [data, setData] = useState(null);
  useEffect(() => {
    get(`/api/plan/neetcode?date=${todayKey.value}`).then(setData).catch(reportError);
  }, [revision.value]);
  if (!data) return html`<${Skeleton} lines=${6} />`;
  const { stats, entries, reviews } = data;
  return html`<section class="neetcode">
    <div class="nc-top">
      <div class="card nc-stat"><strong>${stats.total}</strong><span>problems logged</span></div>
      <div class="card nc-stat"><strong>${percent(stats.counts.independent, stats.total)}%</strong><span>solved independently</span></div>
      <div class="card nc-stat"><strong>${stats.streakDays}</strong><span>day streak</span></div>
      <div class="card nc-stat"><strong>${reviews.length}</strong><span>due for review</span></div>
      <${Button} variant="primary" icon="plus" onClick=${() => { neetcodePrompt.value = { taskId: null, title: "Log a problem" }; }}>Log a problem</${Button}>
    </div>
    ${reviews.length ? html`<div class="card"><div class="card-eyebrow">Spaced review · due now</div>
      ${reviews.map((item) => html`<div class="nc-row">
        <span class=${`nc-badge nc-${item.entry.result}`}>${item.interval}d</span>
        <a href=${item.entry.url || "https://neetcode.io/practice"} target="_blank" rel="noreferrer">${item.entry.problem}</a>
        <span class="muted small">${item.entry.pattern || ""}</span>
        <${Button} size="sm" onClick=${() => { neetcodePrompt.value = { taskId: null, title: `Review: ${item.entry.problem}`, review: { id: item.entry.id, interval: item.interval, problem: item.entry.problem, url: item.entry.url } }; }}>Log review</${Button}>
      </div>`)}
    </div>` : null}
    <div class="card card-flush">
      ${entries.length ? html`<table class="table">
        <thead><tr><th>Date</th><th>Problem</th><th>Pattern</th><th>Result</th><th></th></tr></thead>
        <tbody>${entries.map((entry) => html`<tr>
          <td class="muted">${shortDate(entry.date)}</td>
          <td>${entry.url ? html`<a href=${entry.url} target="_blank" rel="noreferrer">${entry.problem}</a>` : entry.problem}${entry.reviewOf ? html` <span class="pill">review</span>` : null}</td>
          <td class="muted">${entry.pattern}</td>
          <td><span class=${`nc-badge nc-${entry.result}`}>${entry.result}</span></td>
          <td><${IconButton} icon="trash" label="Delete entry" size=${14} onClick=${async () => { try { await post("/api/plan/neetcode/delete", { id: entry.id }); refresh(); } catch (error) { reportError(error); } }} /></td>
        </tr>`)}</tbody>
      </table>` : html`<${Empty} icon="list" title="No problems logged yet">When you finish a NeetCode block, log the problem and whether you solved it alone, with hints, or by studying the answer. Misses come back on day 7 and 21.</${Empty}>`}
    </div>
  </section>`;
}

// ---------- search ----------
function Search() {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("open");
  const [data, setData] = useState(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q, category, status, limit: "150" });
      get(`/api/plan/search?${params}`).then(setData).catch(reportError);
    }, 180);
    return () => clearTimeout(timer);
  }, [q, category, status, revision.value]);
  return html`<section class="search">
    <div class="search-bar">
      <div class="input-icon"><${Icon} name="search" size=${16} /><input class="input" placeholder="Search all tasks, notes and audit IDs" value=${q} onInput=${(event) => setQ(event.currentTarget.value)} /></div>
      <select class="input" value=${category} onChange=${(event) => setCategory(event.currentTarget.value)}>
        <option value="">All categories</option>${CATEGORY_ORDER.map((entry) => html`<option value=${entry}>${CATEGORY_META[entry].label}</option>`)}
      </select>
      <select class="input" value=${status} onChange=${(event) => setStatus(event.currentTarget.value)}>
        <option value="">Any status</option><option value="open">Open</option><option value="overdue">Overdue</option><option value="done">Done</option><option value="skipped">Skipped</option>
      </select>
    </div>
    ${data ? html`<p class="muted small">${plural(data.total, "match", "matches")}${data.total > data.tasks.length ? ` · showing ${data.tasks.length}` : ""}</p>
      <div class="card card-flush list">${data.tasks.map((task) => html`<${TaskRow} task=${task} showDate />`)}</div>` : html`<${Skeleton} />`}
  </section>`;
}

// ---------- page ----------
export function RoadmapPage() {
  const info = meta.value;
  const [tab, setTabState] = useState(() => {
    try {
      return localStorage.getItem(TAB_KEY) || "weeks";
    } catch {
      return "weeks";
    }
  });
  const setTab = (next) => {
    setTabState(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      // Not persisted; fine.
    }
  };
  if (!info) return html`<div class="page"><${Skeleton} lines=${6} /></div>`;
  const param = routeParam.value;
  const selected = /^\d{4}-\d{2}-\d{2}$/.test(param) ? weekStart(param) : info.weeks[Math.max(0, info.currentWeekIndex)]?.start;
  const total = info.totals;
  const daysLeft = Math.max(0, Math.round((Date.parse(`${info.endDate}T12:00:00Z`) - Date.parse(`${info.todayKey}T12:00:00Z`)) / 86_400_000));

  return html`<div class="page page-roadmap">
    <header class="page-head">
      <div>
        <div class="eyebrow">Roadmap · ${formatDate(info.startDate, { month: "short", day: "numeric" })} – ${formatDate(info.endDate, { month: "short", day: "numeric", year: "numeric" })}</div>
        <h1>The path to May</h1>
        <p class="muted">Progress means you can explain it, reproduce it, and change it.</p>
      </div>
      <div class="roadmap-kpis">
        <div class="kpi"><strong>${percent(total.done, total.total)}%</strong><span>${total.done} of ${total.total} tasks</span></div>
        <div class=${`kpi ${info.overdue ? "kpi-warn" : ""}`}><strong>${info.overdue}</strong><span>overdue</span></div>
        <div class="kpi"><strong>${info.repairs.done}/${info.repairs.total}</strong><span>repair sessions</span></div>
        <div class="kpi"><strong>${daysLeft}</strong><span>days left</span></div>
      </div>
    </header>
    <${PhaseTimeline} info=${info} selected=${selected} onSelect=${(start) => { setTab("weeks"); navigate("roadmap", start); }} />
    <${Tabs} value=${tab} onChange=${setTab} tabs=${[
      { id: "weeks", label: "Week board", icon: "calendar" },
      { id: "repair", label: "Repair track", icon: "wrench", count: `${info.repairs.done}/${info.repairs.total}` },
      { id: "library", label: "Library", icon: "book" },
      { id: "neetcode", label: "NeetCode", icon: "list" },
      { id: "search", label: "All tasks", icon: "search" }
    ]} />
    ${tab === "weeks" ? html`<${WeekBoard} start=${selected} info=${info} />` : null}
    ${tab === "repair" ? html`<${RepairTrack} />` : null}
    ${tab === "library" ? html`<${Library} />` : null}
    ${tab === "neetcode" ? html`<${NeetcodeTab} />` : null}
    ${tab === "search" ? html`<${Search} />` : null}
  </div>`;
}

export { renderMarkdown };
