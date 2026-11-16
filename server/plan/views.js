// Read models for the UI. Everything here is derived from plan data + state.
import { addDays, daysBetween, weekStartMonday } from "./dates.js";
import { OBLIGATION_CATEGORIES } from "./generator.js";
import { planSettings, planTasks } from "./state.js";
import { minutesAvailable, scheduleDay, tasksForDay } from "./scheduler.js";
import { neetcodeStats, reviewCandidates, liveEntries } from "./neetcode.js";

export function compactTask(task) {
  return {
    id: task.id,
    title: task.title,
    date: task.date,
    plannedDate: task.plannedDate || task.date,
    minutes: task.minutes,
    category: task.category,
    preferred: task.preferred,
    pinnedStart: Number.isFinite(task.pinnedStart) ? task.pinnedStart : null,
    week: task.week,
    weekIndex: task.weekIndex ?? null,
    phase: task.phase || null,
    done: Boolean(task.done),
    skipped: Boolean(task.skipped),
    custom: Boolean(task.custom),
    previousPlan: Boolean(task.previousPlan),
    repair: Boolean(task.fixIds?.length),
    hasNotes: Boolean(task.notes),
    accumulatedSeconds: Number(task.accumulatedSeconds || 0)
  };
}

function weekIndexFor(data, dateKey) {
  const start = weekStartMonday(dateKey);
  return data.weeks.findIndex((week) => week.start === start);
}

function summarize(tasks) {
  const live = tasks.filter((task) => !task.skipped);
  const career = live.filter((task) => !OBLIGATION_CATEGORIES.has(task.category));
  return {
    total: live.length,
    done: live.filter((task) => task.done).length,
    skipped: tasks.length - live.length,
    minutes: live.reduce((sum, task) => sum + task.minutes, 0),
    doneMinutes: live.filter((task) => task.done).reduce((sum, task) => sum + task.minutes, 0),
    careerMinutes: career.reduce((sum, task) => sum + task.minutes, 0),
    careerDoneMinutes: career.filter((task) => task.done).reduce((sum, task) => sum + task.minutes, 0)
  };
}

function byCategory(tasks) {
  const totals = {};
  for (const task of tasks) {
    if (task.skipped) continue;
    const entry = totals[task.category] || (totals[task.category] = { total: 0, done: 0, minutes: 0, doneMinutes: 0 });
    entry.total += 1;
    entry.minutes += task.minutes;
    if (task.done) {
      entry.done += 1;
      entry.doneMinutes += task.minutes;
    }
  }
  return totals;
}

export function weekMeta(data, index, tasks) {
  const week = data.weeks[index];
  if (!week) return null;
  return {
    index,
    number: index + 1,
    start: week.start,
    end: addDays(week.start, 6),
    title: week.title,
    phase: week.phase,
    goal: week.goal,
    checkpoint: week.checkpoint,
    ...summarize(tasks.filter((task) => task.week === week.start))
  };
}

export function planMeta(data, plan, todayKey) {
  const tasks = planTasks(data, plan);
  const currentWeekIndex = weekIndexFor(data, todayKey);
  const weeks = data.weeks.map((_, index) => weekMeta(data, index, tasks));
  const phases = [];
  for (const week of weeks) {
    const last = phases.at(-1);
    if (last && last.name === week.phase) last.endIndex = week.index;
    else phases.push({ name: week.phase, startIndex: week.index, endIndex: week.index });
  }
  const repairs = tasks.filter((task) => task.fixIds?.length);
  return {
    todayKey,
    startDate: data.startDate,
    endDate: addDays(data.weeks.at(-1).start, 6),
    currentWeekIndex,
    weeks,
    phases,
    totals: summarize(tasks),
    overdue: tasks.filter((task) => task.date < todayKey && !task.done && !task.skipped).length,
    repairs: { total: repairs.length, done: repairs.filter((task) => task.done).length },
    settings: planSettings(data, plan),
    importedAt: plan.importedAt,
    importSource: plan.importSource
  };
}

export function dayView(data, plan, dateKey, todayKey) {
  const settings = planSettings(data, plan);
  const all = planTasks(data, plan);
  const shown = tasksForDay(all, dateKey, todayKey).filter((task) => !task.skipped);
  const schedule = scheduleDay(dateKey, shown, settings);
  const weekIndex = weekIndexFor(data, dateKey);
  const carried = shown.filter((task) => task.date < dateKey);
  return {
    date: dateKey,
    isToday: dateKey === todayKey,
    isPast: dateKey < todayKey,
    week: weekIndex >= 0 ? weekMeta(data, weekIndex, all) : null,
    blocks: schedule.blocks.map((block) => (block.task ? { ...block, task: compactTask(block.task) } : block)),
    completed: shown.filter((task) => task.done && task.timelineReleased).map(compactTask),
    unscheduled: schedule.unscheduled.map(compactTask),
    carried: carried.map(compactTask),
    tasks: shown.map(compactTask),
    summary: summarize(shown.filter((task) => task.date === dateKey)),
    availableMinutes: minutesAvailable(dateKey, settings),
    plannedMinutes: shown.filter((task) => task.date === dateKey).reduce((sum, task) => sum + task.minutes, 0),
    settings: { dayStart: settings.dayStart, dayEnd: settings.dayEnd }
  };
}

export function weekView(data, plan, dateKey, todayKey) {
  const settings = planSettings(data, plan);
  const all = planTasks(data, plan);
  const start = weekStartMonday(dateKey);
  const weekIndex = weekIndexFor(data, start);
  const inWeek = all.filter((task) => task.week === start);
  const days = Array.from({ length: 7 }, (_, offset) => {
    const date = addDays(start, offset);
    const tasks = inWeek.filter((task) => task.date === date).sort((a, b) => Number(a.done) - Number(b.done) || a.preferred - b.preferred);
    const live = tasks.filter((task) => !task.skipped && !task.done);
    const schedule = scheduleDay(date, live, settings);
    return {
      date,
      isToday: date === todayKey,
      isPast: date < todayKey,
      tasks: tasks.map(compactTask),
      plannedMinutes: tasks.filter((task) => !task.skipped).reduce((sum, task) => sum + task.minutes, 0),
      remainingMinutes: live.reduce((sum, task) => sum + task.minutes, 0),
      availableMinutes: minutesAvailable(date, settings),
      unscheduled: schedule.unscheduled.map((task) => task.id)
    };
  });
  return {
    start,
    end: addDays(start, 6),
    week: weekIndex >= 0 ? weekMeta(data, weekIndex, all) : null,
    days,
    categories: byCategory(inWeek),
    summary: summarize(inWeek)
  };
}

export function rangeView(data, plan, from, to) {
  return planTasks(data, plan).filter((task) => task.date >= from && task.date <= to).map(compactTask);
}

export function searchTasks(data, plan, { q = "", category = "", status = "", limit = 200 } = {}, todayKey) {
  const needle = q.trim().toLowerCase();
  const matches = planTasks(data, plan).filter((task) => {
    if (category && task.category !== category) return false;
    if (status === "open" && (task.done || task.skipped)) return false;
    if (status === "done" && !task.done) return false;
    if (status === "overdue" && !(task.date < todayKey && !task.done && !task.skipped)) return false;
    if (status === "skipped" && !task.skipped) return false;
    if (!needle) return true;
    return `${task.title} ${task.detail || ""} ${task.notes || ""} ${(task.fixIds || []).join(" ")}`.toLowerCase().includes(needle);
  });
  return { total: matches.length, tasks: matches.slice(0, limit).map(compactTask) };
}

function sequenceLabel(key, task) {
  const [kind, name] = key.split(":");
  if (kind === "behavioral") return "Behavioral lessons";
  if (kind === "systems") return "Hello Interview lessons";
  if (kind === "repair") return `${name} repairs`;
  if (kind === "backlog") return `${name} backlog`;
  if (kind === "series") return `${/^(.+?) \d+\//.exec(task.title)?.[1] || name} series`;
  return kind === "study" ? "This week's study" : "This week's build";
}

// The steps around a task in each ordered set it belongs to. Some sets run for
// months, so this shows the neighbours rather than the whole list.
function orderedSets(tasks, task, around = 2) {
  return (task.sequences || []).map(({ key }) => {
    const stepIn = (entry) => entry.sequences.find((sequence) => sequence.key === key).step;
    const members = tasks.filter((entry) => entry.sequences?.some((sequence) => sequence.key === key)).sort((a, b) => stepIn(a) - stepIn(b));
    const index = members.findIndex((entry) => entry.id === task.id);
    return {
      key,
      label: sequenceLabel(key, task),
      position: index + 1,
      total: members.length,
      steps: members.slice(Math.max(0, index - around), index + around + 1).map((entry) => ({
        id: entry.id,
        title: entry.title,
        date: entry.date,
        done: entry.done,
        skipped: entry.skipped,
        current: entry.id === task.id
      }))
    };
  }).filter((set) => set.total > 1);
}

export function taskDetail(data, plan, id) {
  const tasks = planTasks(data, plan);
  const task = tasks.find((entry) => entry.id === id);
  if (!task) return null;
  const auditItems = (task.fixIds || []).map((ref) => data.audit.items.find((item) => item.id === ref)).filter(Boolean);
  const sessions = plan.focusSessions.filter((session) => session.taskId === id).slice(0, 20);
  const neetcode = liveEntries(plan.neetcodeLog).filter((entry) => entry.taskId === id);
  return {
    ...compactTask(task),
    detail: task.detail || "",
    doneWhen: task.doneWhen || "",
    resources: task.resources || [],
    notes: task.notes || "",
    evidenceUrl: task.evidenceUrl || "",
    completedAt: task.completedAt || null,
    fixIds: task.fixIds || [],
    auditItems,
    order: orderedSets(tasks, task),
    sessions,
    neetcode,
    daysLate: task.done ? 0 : Math.max(0, daysBetween(task.date, task.plannedDate || task.date))
  };
}

export function portfolioView(data, plan) {
  const tasks = planTasks(data, plan).filter((task) => task.fixIds?.length).sort((a, b) => a.date.localeCompare(b.date));
  const repos = {};
  for (const item of data.audit.items) {
    const entry = repos[item.repo] || (repos[item.repo] = { repo: item.repo, items: 0, closed: 0 });
    entry.items += 1;
  }
  const closedItems = new Set();
  for (const task of tasks) if (task.done) for (const ref of task.fixIds) closedItems.add(ref);
  for (const item of data.audit.items) if (closedItems.has(item.id)) repos[item.repo].closed += 1;
  return {
    asOf: data.audit.asOf,
    sourceNote: data.audit.sourceNote,
    sessions: tasks.map((task) => ({ ...compactTask(task), fixIds: task.fixIds })),
    items: data.audit.items.map(({ id, repo, sourceId, title, url }) => ({ id, repo, sourceId, title, url, closed: closedItems.has(id) })),
    repos: Object.values(repos)
  };
}

export function libraryView(data, plan) {
  const tasks = planTasks(data, plan);
  const status = (id) => {
    const task = tasks.find((entry) => entry.id === id);
    return task ? { id: task.id, date: task.date, done: task.done } : null;
  };
  return data.weeks.map((week, index) => ({
    index,
    start: week.start,
    title: week.title,
    phase: week.phase,
    systems: data.library.systems[index] ? { ...data.library.systems[index], task: status(`w${index}-systems`) } : null,
    behavioral: data.library.behavioral[index] ? { ...data.library.behavioral[index], task: status(`w${index}-behavioral`) } : null,
    study: week.study.map((item, i) => ({ ...item, task: status(`w${index}-study${i}`) })),
    build: week.build.map((item, i) => ({ ...item, task: status(`w${index}-build${i}`) || status(`portfolio-w${index}-build${i}`) }))
  }));
}

export function neetcodeView(plan, dateKey) {
  return {
    entries: liveEntries(plan.neetcodeLog).slice(0, 500),
    reviews: reviewCandidates(plan.neetcodeLog, dateKey),
    stats: neetcodeStats(plan.neetcodeLog, dateKey)
  };
}
