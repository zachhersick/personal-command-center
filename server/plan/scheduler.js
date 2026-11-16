// Day scheduling: fixed blocks (classes, gym, meals) first, then tasks are
// placed greedily on a 5-minute grid starting from each task's preferred time.
// Ported from the hosted roadmap site, with one deliberate fix: on days with no
// classes, lunch no longer overlaps a gym session that starts at noon.
import { addDays, daysBetween, weekStartMonday, weekdayIndex } from "./dates.js";

export const GYM_CYCLE = ["Push", "Pull", "Legs", "Rest"];
const GRID = 5;
const BUFFER = 10;
const DAY = 1440;
// How far past the spread's window bumped work can land, so it always has somewhere to go.
const BUMP_REACH = 28;
// Job search, coursework and paid work keep their time even for a backlog ticket.
const BUMPABLE = new Set(["Build", "Review"]);

export function gymPhaseFor(dateKey, settings) {
  return (((daysBetween(dateKey, settings.gymAnchor) + Number(settings.gymPhase || 0)) % 4) + 4) % 4;
}

export function classTimesFor(dateKey, settings) {
  const onBreak = (settings.breakWeeks || []).includes(weekStartMonday(dateKey));
  return settings.classMode && !onBreak ? settings.classTimes?.[weekdayIndex(dateKey)] ?? [] : [];
}

export function fixedBlocks(dateKey, settings) {
  const weekday = weekdayIndex(dateKey);
  const classes = classTimesFor(dateKey, settings);
  const blocks = [];
  for (let index = 0; index < classes.length; index += 2) {
    blocks.push({
      id: `class-${index}`,
      title: index === 2 ? "Lab + commute" : "Classes + commute",
      start: classes[index],
      end: classes[index + 1],
      kind: "class"
    });
  }

  const phase = gymPhaseFor(dateKey, settings);
  const gymDay = !settings.gymConfirmed || phase !== 3;
  const gymStart = classes.length ? Math.max(...classes.filter((_, index) => index % 2 === 1)) : settings.weekendGym;
  if (gymDay) {
    blocks.push({
      id: "gym",
      title: settings.gymConfirmed ? `${GYM_CYCLE[phase]} workout` : "Gym (cycle not set)",
      start: gymStart,
      end: gymStart + 120,
      kind: "gym"
    });
  }

  const tueThu = weekday === 1 || weekday === 3;
  let lunch = tueThu ? 705 : weekday === 2 ? 835 : classes.length ? (gymDay ? gymStart + 120 : gymStart) + 10 : 720;
  if (!classes.length && gymDay && lunch < gymStart + 120 && lunch + 35 > gymStart) lunch = gymStart + 120 + 10;
  const dinner = tueThu && gymDay && classes.length ? 1200 : weekday === 2 && gymDay && classes.length ? 1170 : 1110;
  blocks.push(
    { id: "lunch", title: "Meal / reset", start: lunch, end: lunch + 35, kind: "meal" },
    { id: "dinner", title: "Dinner / reset", start: dinner, end: dinner + 40, kind: "meal" }
  );
  return blocks.sort((a, b) => a.start - b.start);
}

function placementRank(task, dateKey) {
  if (task.date < dateKey) return 3;
  if (task.category === "Homework") return 0;
  if (task.category === "PaidWork") return 1;
  return 2;
}

export function scheduleDay(dateKey, tasks, settings) {
  const fixed = fixedBlocks(dateKey, settings);
  const occupied = fixed.map(({ start, end }) => ({ start, end }));
  const placed = [];
  const unscheduled = [];
  const fits = (start, minutes) => start >= settings.dayStart
    && start + minutes <= settings.dayEnd
    && !occupied.some((block) => start < block.end && start + minutes > block.start);

  const ordered = tasks.filter((task) => !(task.done && task.timelineReleased))
    .sort((a, b) => placementRank(a, dateKey) - placementRank(b, dateKey) || a.preferred - b.preferred);
  // Tasks the user pinned to a time go first so they keep their slot.
  const priority = (task) => Number(Number.isFinite(task.pinnedStart)) * 2 + Number(task.schedulePlacement?.date === dateKey);
  ordered.sort((a, b) => priority(b) - priority(a));
  for (const task of ordered) {
    const minutes = Number(task.minutes) || 30;
    let slot = -1;
    const reservation = task.schedulePlacement?.date === dateKey ? task.schedulePlacement : null;
    if (reservation) {
      if (Number.isInteger(reservation.start) && reservation.start % GRID === 0 && reservation.end === reservation.start + minutes && fits(reservation.start, minutes)) slot = reservation.start;
      else {
        unscheduled.push(task);
        continue;
      }
    }
    if (slot < 0 && Number.isFinite(task.pinnedStart) && fits(task.pinnedStart, minutes)) slot = task.pinnedStart;
    for (let start = Math.max(settings.dayStart, task.preferred); slot < 0 && start + minutes <= settings.dayEnd; start += GRID) {
      if (fits(start, minutes)) slot = start;
    }
    for (let start = settings.dayStart; slot < 0 && start + minutes <= Math.min(task.preferred, settings.dayEnd); start += GRID) {
      if (fits(start, minutes)) slot = start;
    }
    if (slot < 0) {
      unscheduled.push(task);
      continue;
    }
    placed.push({ id: task.id, title: task.title, start: slot, end: slot + minutes, kind: "task", task });
    occupied.push({ start: slot, end: slot + minutes + BUFFER });
  }
  return { blocks: [...fixed, ...placed].sort((a, b) => a.start - b.start), unscheduled };
}

// Open steps either side of a task in the ordered sets it belongs to. Done and
// skipped steps no longer hold anything back.
function sequenceLinks(allTasks) {
  const sets = new Map();
  for (const task of allTasks) {
    if (task.done || task.skipped) continue;
    for (const { key, step } of task.sequences || []) sets.set(key, [...(sets.get(key) || []), { task, step }]);
  }
  const around = (task, direction) => {
    const found = new Map();
    for (const { key, step } of task.sequences || []) {
      for (const entry of sets.get(key) || []) {
        if ((entry.step - step) * direction > 0) found.set(entry.task.id, entry.task);
      }
    }
    return [...found.values()];
  };
  return { earlier: (task) => around(task, -1), later: (task) => around(task, 1) };
}

const spreadRank = (task) => (task.spreadFirst ? 0 : 1);

// Places tasks through a board that knows how to find room, keeping ordered
// sets in order: earlier carried steps come along, later steps that would end
// up ahead move back, and pinned or in-focus steps stay put. If a step pulled
// along doesn't fit, the task that pulled it stays behind and we start again,
// so a spread never leaves a chain half moved. A backlog ticket with no free room
// can bump work out of the way; if that work has nowhere to go it stays, and we
// start again without it.
function placeInOrder({ tasks, allTasks, todayKey, isFixed, compare, begin }) {
  const links = sequenceLinks(allTasks);
  const leftBehind = new Set();
  const staysPut = new Set();
  const mayBump = (task) => !staysPut.has(task.id) && !links.earlier(task).some((step) => step.date < todayKey);
  for (;;) {
    const moving = new Map(tasks.map((task) => [task.id, task]));
    const pulled = new Set();
    for (const task of tasks) {
      for (const step of links.earlier(task)) {
        if (step.date >= todayKey || isFixed(step) || moving.has(step.id)) continue;
        moving.set(step.id, step);
        pulled.add(step.id);
      }
    }
    const board = begin(moving);
    const placed = new Map();
    const unplaced = [];
    const pulledBy = new Map();
    const displaced = new Map();
    const pending = [...moving.values()].sort(compare);
    let restart = false;
    while (pending.length && !restart) {
      const waiting = new Set(pending.map((task) => task.id));
      const [task] = pending.splice(pending.findIndex((entry) => !links.earlier(entry).some((step) => waiting.has(step.id))), 1);
      const before = links.earlier(task).map((step) => placed.get(step.id) || (moving.has(step.id) ? null : board.locate(step)));
      const stranded = before.some((spot) => !spot || spot.date < todayKey);
      const floor = [...before, displaced.get(task.id)?.from].filter(Boolean).reduce((latest, spot) => (!latest || spot.date > latest.date || (spot.date === latest.date && spot.end > latest.end) ? spot : latest), null);
      const soonest = (steps) => steps.map((step) => board.locate(step))
        .reduce((first, spot) => (!first || spot.date < first.date || (spot.date === first.date && spot.start < first.start) ? spot : first), null);
      const settled = links.later(task).filter((step) => !moving.has(step.id));
      const ceiling = soonest(settled.filter(isFixed));
      // A ticket tries to fit ahead of the next one, so it doesn't push the rest of the backlog back.
      const next = task.spreadFirst ? soonest(settled) : null;
      const spot = stranded || leftBehind.has(task.id) ? null : board.place(task, floor, ceiling, { overflow: displaced.has(task.id) || (task.spreadFirst && pulled.has(task.id)), mayBump, next });
      if (!spot) {
        if (displaced.has(task.id)) {
          staysPut.add(displaced.get(task.id).root);
          restart = true;
        } else if (pulledBy.has(task.id)) {
          leftBehind.add(pulledBy.get(task.id));
          restart = true;
        } else unplaced.push(task.id);
        continue;
      }
      placed.set(task.id, spot);
      for (const { task: step, ...from } of spot.bumped || []) {
        moving.set(step.id, step);
        displaced.set(step.id, { root: step.id, from });
        pending.push(step);
        pending.sort(compare);
      }
      for (const step of links.later(task)) {
        if (moving.has(step.id) || isFixed(step)) continue;
        const where = board.locate(step);
        if (where.date > spot.date || (where.date === spot.date && where.start >= spot.end)) continue;
        moving.set(step.id, step);
        pulled.add(step.id);
        pulledBy.set(step.id, pulledBy.get(task.id) || task.id);
        if (displaced.has(task.id)) displaced.set(step.id, { root: displaced.get(task.id).root });
        board.release(step);
        pending.push(step);
        pending.sort(compare);
      }
    }
    if (!restart) return { moving, placed, pulled, displaced, unplaced };
  }
}

// This explicit spread reserves the displayed layout; ordinary scheduling stays unchanged.
export function spreadCarried({ tasks, allTasks, settings, from, days, todayKey, nowMinutes, activeTaskId }) {
  const candidates = tasks.filter((task) => task.date < todayKey && task.id !== activeTaskId && !Number.isFinite(task.pinnedStart));
  const layouts = new Map();
  const reclaimed = [];
  const placements = [];
  const touched = new Set();
  const begin = (moving) => {
    layouts.clear();
    reclaimed.length = 0;
    touched.clear();
    const reach = days + ([...moving.values()].some((task) => task.spreadFirst) ? BUMP_REACH : 0);
    for (let offset = 0; offset < reach; offset++) {
      const date = addDays(from, offset);
      const { blocks } = scheduleDay(date, tasksForDay(allTasks, date, todayKey).filter((task) => !task.skipped), settings);
      layouts.set(date, blocks.filter((block) => !moving.has(block.id)).map((block) => ({
        ...block,
        reclaimable: Boolean(block.task?.done && !Number.isFinite(block.task.pinnedStart) && block.id !== activeTaskId && (date > todayKey || block.start > nowMinutes))
      })));
    }
    const locate = (task) => {
      for (const [date, blocks] of layouts) {
        const block = blocks.find((entry) => entry.id === task.id);
        if (block) return { date, start: block.start, end: block.end, block };
      }
      return { date: task.date, start: 0, end: DAY };
    };
    const release = (task) => {
      const { date, block } = locate(task);
      if (!block) return;
      layouts.get(date).splice(layouts.get(date).indexOf(block), 1);
      touched.add(date);
    };
    const place = (task, floor, ceiling, { overflow, mayBump, next }) => {
      const minutes = Number(task.minutes) || 30;
      const canBump = (block, date) => block.kind === "task" && block.task && !block.task.done && !block.task.spreadFirst
        && BUMPABLE.has(block.task.category) && !Number.isFinite(block.task.pinnedStart) && block.id !== activeTaskId
        && block.task.date >= todayKey && (date > todayKey || block.start > nowMinutes) && mayBump(block.task);
      const search = (limit, modes, until = ceiling) => {
        let offset = 0;
        for (const [date, blocks] of layouts) {
          if (offset++ >= limit) break;
          if (floor && date < floor.date) continue;
          if (until && date > until.date) break;
          const first = Math.ceil(Math.max(settings.dayStart, date === todayKey ? nowMinutes : 0, floor?.date === date ? floor.end : 0) / GRID) * GRID;
          const last = Math.min(settings.dayEnd, until?.date === date ? until.start : DAY);
          for (const allowed of modes) {
            for (let start = first; start + minutes <= last; start += GRID) {
              const end = start + minutes;
              const conflicts = blocks.filter((block) => start < block.end + (block.kind === "task" ? BUFFER : 0) && end + (block.kind === "task" ? BUFFER : 0) > block.start);
              if (conflicts.every((block) => allowed(block, date))) return { date, start, end, conflicts };
            }
          }
        }
        return null;
      };
      const free = [() => false, (block) => block.reclaimable];
      const bumping = [(block, date) => block.reclaimable || canBump(block, date)];
      const allocation = (next && (search(days, free, next) || search(days, bumping, next)))
        || search(overflow ? layouts.size : days, free)
        || (task.spreadFirst ? search(days, bumping) : null);
      if (!allocation) return null;
      const { date, start, end, conflicts } = allocation;
      const blocks = layouts.get(date);
      const bumped = [];
      for (const block of conflicts) {
        if (block.reclaimable) reclaimed.push({ id: block.id, title: block.title, date, start: block.start, end: block.end });
        else bumped.push({ task: block.task, date, end: block.start });
        blocks.splice(blocks.indexOf(block), 1);
      }
      blocks.push({ id: task.id, start, end, kind: "task", reclaimable: false });
      touched.add(date);
      return { date, start, end, bumped };
    };
    return { locate, release, place };
  };
  const compare = (a, b) => spreadRank(a) - spreadRank(b) || placementRank(a, todayKey) - placementRank(b, todayKey) || a.date.localeCompare(b.date) || a.preferred - b.preferred || a.id.localeCompare(b.id);
  const isFixed = (task) => Number.isFinite(task.pinnedStart) || task.id === activeTaskId;
  const { moving, placed, pulled, displaced, unplaced } = placeInOrder({ tasks: candidates, allTasks, todayKey, isFixed, compare, begin });
  const moves = [...placed].map(([id, { date, start, end }]) => ({ id, title: moving.get(id).title, category: moving.get(id).category, from: moving.get(id).date, to: date, start, end, ...(displaced.get(id)?.from ? { bumped: true } : pulled.has(id) ? { keepOrder: true } : {}) }));
  for (const date of touched) {
    for (const block of layouts.get(date)) {
      if (block.kind === "task") placements.push({ id: block.id, date, start: block.start, end: block.end });
    }
  }
  return { moves, unplaced, reclaimed, placements, protected: tasks.filter((task) => !moving.has(task.id)).map((task) => task.id) };
}

// Tasks shown on a day. Today also pulls in every unfinished task from earlier
// days ("carried over"), oldest first.
export function tasksForDay(allTasks, dateKey, todayKey) {
  const onDay = allTasks.filter((task) => task.date === dateKey);
  if (dateKey !== todayKey) return onDay;
  const carried = allTasks
    .filter((task) => task.date < dateKey && !task.done && !task.skipped)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return [...carried, ...onDay];
}

export function minutesAvailable(dateKey, settings) {
  const span = settings.dayEnd - settings.dayStart;
  const fixed = fixedBlocks(dateKey, settings).reduce((total, block) => {
    const start = Math.max(block.start, settings.dayStart);
    const end = Math.min(block.end, settings.dayEnd);
    return total + Math.max(0, end - start);
  }, 0);
  return Math.max(0, span - fixed);
}

// Spread unfinished tasks into days that still have room. Returns the moves
// without applying them; mutations.js writes them as date overrides.
export function rebalance({ tasks, allTasks, settings, from, days = 7, todayKey, activeTaskId }) {
  const begin = (moving) => {
    const assigned = new Map();
    const dayTasks = (dateKey) => [
      ...allTasks.filter((task) => task.date === dateKey && !task.done && !task.skipped && !moving.has(task.id)),
      ...(assigned.get(dateKey) || [])
    ];
    const place = (task, floor, ceiling) => {
      let target = null;
      for (let offset = 0; offset < days && !target; offset += 1) {
        const dateKey = addDays(from, offset);
        // This works in whole days, so a later step needs a later day.
        if (floor && dateKey <= floor.date) continue;
        if (ceiling && dateKey >= ceiling.date) break;
        const existing = dayTasks(dateKey);
        const before = scheduleDay(dateKey, existing, settings).unscheduled.length;
        const result = scheduleDay(dateKey, [...existing, { ...task, date: dateKey }], settings);
        const fits = !result.unscheduled.some((entry) => entry.id === task.id);
        if (fits && result.unscheduled.length <= before) target = dateKey;
      }
      if (!target) return null;
      assigned.set(target, [...(assigned.get(target) || []), { ...task, date: target }]);
      return { date: target, start: 0, end: DAY };
    };
    return { locate: (task) => ({ date: task.date, start: 0, end: DAY }), release: () => {}, place };
  };
  const compare = (a, b) => spreadRank(a) - spreadRank(b) || placementRank(a, todayKey) - placementRank(b, todayKey) || a.date.localeCompare(b.date) || a.preferred - b.preferred;
  const isFixed = (task) => Number.isFinite(task.pinnedStart) || task.id === activeTaskId;
  const { moving, placed, pulled, unplaced } = placeInOrder({ tasks, allTasks, todayKey, isFixed, compare, begin });
  const moves = [...placed].filter(([id, { date }]) => date !== moving.get(id).date)
    .map(([id, { date }]) => ({ id, from: moving.get(id).date, to: date, ...(pulled.has(id) ? { keepOrder: true } : {}) }));
  return { moves, unplaced };
}
