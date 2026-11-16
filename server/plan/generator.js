// Generates the base roadmap task list from the plan data file and the user's
// schedule settings. This is a readable port of the generator on the hosted
// roadmap site; tests/plan-generator.test.js checks it against a snapshot of
// the site's own output.
import { addDays } from "./dates.js";

export const CATEGORY_KIND = {
  Study: "study",
  Build: "build",
  NeetCode: "code",
  Applications: "apply",
  Interview: "review",
  Behavioral: "review",
  Review: "review",
  Capstone: "capstone",
  PaidWork: "paid",
  Homework: "homework",
  Personal: "homework"
};

export const CATEGORIES = Object.keys(CATEGORY_KIND);

// Categories that are obligations rather than career prep.
export const OBLIGATION_CATEGORIES = new Set(["Homework", "PaidWork", "Capstone", "Personal"]);

export function effectiveSettings(data, override = {}) {
  const { updatedAt, ...values } = override || {};
  return { ...data.defaults, ...values };
}

function weekTasks(data, settings, week, weekIndex) {
  const tasks = [];
  const text = data.recurring;
  const firstWeek = weekIndex === 0;
  const add = (key, dayOffset, title, minutes, category, preferred, detail, doneWhen, resources = []) => {
    const date = addDays(week.start, dayOffset);
    if (date < data.startDate) return;
    tasks.push({
      id: `w${weekIndex}-${key}`,
      slot: `w${weekIndex}-${key}`,
      weekIndex,
      planWeek: week.start,
      phase: week.phase,
      date,
      title,
      minutes,
      category,
      preferred,
      detail,
      doneWhen,
      resources: resources || []
    });
  };

  week.study.forEach((item, index) => {
    const day = firstWeek ? (index === 0 ? 4 : 5) : (index === 0 ? 1 : 3);
    add(`study${index}`, day, item.title, item.minutes - 15, "Study", firstWeek ? 990 : 480, item.detail, item.doneWhen, item.resources);
  });
  week.build.forEach((item, index) => {
    add(`build${index}`, index === 0 ? 5 : 6, item.title, item.minutes, "Build", 870, item.detail, item.doneWhen, item.resources);
  });

  for (let day = 0; day < 7; day += 1) {
    const codePreferred = firstWeek && day === 3 ? 745 : day === 1 || day === 3 ? 585 : 510;
    add(`code${day}`, day, day === 6 ? "NeetCode: spaced review" : "NeetCode: next problem", day === 2 ? 25 : 40, "NeetCode", codePreferred, text.neetcode.detail, text.neetcode.doneWhen);
    const homePreferred = day === 2 ? 1200 : day === 1 || day === 3 ? 750 : day > 4 ? 960 : 1020;
    add(`home${day}`, day, "Homework", 60, "Homework", homePreferred, text.homework.detail, text.homework.doneWhen);
  }

  (firstWeek ? [4, 5, 6] : [1, 4, 6]).forEach((day, index) => {
    const preferred = day === 1 ? 640 : day === 4 || day === 6 ? 480 : 1020;
    add(`paid${index}`, day, "PaidWork", 90, "PaidWork", preferred, text.paid.detail, text.paid.doneWhen);
  });

  if (!firstWeek) {
    add("apply0", 0, "Applications + follow-ups", 45, "Applications", 1125, text.apply.detail, text.apply.doneWhen);
    add("apply1", 4, "Networking + role search", 45, "Applications", 1140, weekIndex < 3 ? text.networking.earlyDetail : text.networking.detail, text.networking.doneWhen);
    const system = data.library.systems[weekIndex];
    add("systems", 3, `Hello Interview: ${system.title}`, 60, "Interview", 645, system.detail, text.systems.doneWhen, system.resources);
    add("sql", 0, "SQL: one practical query", 30, "Interview", 1155, text.sql.detail, text.sql.doneWhen);
    add("mock", 5, "Timed coding mock", 45, "Interview", 1020, text.mock.detail, text.mock.doneWhen);
  } else {
    add("contact", 4, "Ask a contact about graduate eligibility", 30, "Applications", 1110, text.contact.detail, text.contact.doneWhen);
  }

  const behavioral = data.library.behavioral[weekIndex];
  add("behavioral", firstWeek ? 3 : 4, `Behavioral: ${behavioral.title}`, 30, "Behavioral", firstWeek ? 480 : 1065, behavioral.detail, text.behavioral.doneWhen, behavioral.resources);
  add("review", 6, "Weekly review + next week", 30, "Review", 1110, text.review.detail, text.review.doneWhen);

  if (settings.capstoneMinutes > 0) {
    [5, 6].forEach((day, index) => {
      const note = text.capstone.weekNotes?.[String(weekIndex)] || "";
      add(`capstone${index}`, day, "Capstone", Math.round(settings.capstoneMinutes / 2), "Capstone", 765, text.capstone.detail + note, text.capstone.doneWhen);
    });
  }
  return tasks;
}

function reposFor(data, refs) {
  return [...new Set(refs.map((ref) => data.audit.items.find((item) => item.id === ref)?.repo).filter(Boolean))];
}

function applyAuditSession(data, task) {
  const session = data.audit.sessions.find((entry) => entry.slot === task.id);
  if (!session) return task;
  const text = data.recurring.portfolio;
  const repos = reposFor(data, session.refs);
  return {
    ...task,
    id: `portfolio-${task.id}`,
    title: session.title,
    fixIds: session.refs,
    detail: session.detail + text.detailSuffix,
    doneWhen: session.doneWhen,
    replaced: { title: task.title, detail: task.detail, doneWhen: task.doneWhen, resources: task.resources },
    resources: repos.map((repo) => ({
      title: `${repo}: source fix list`,
      url: text.fixListUrl.replace("{repo}", repo),
      kind: "Read",
      assignment: text.assignment
    }))
  };
}

// The sets a task belongs to, where later lessons or repairs build on earlier
// ones. Repeating blocks like NeetCode and homework are interchangeable.
function sequenceKeys(data, task) {
  const kind = task.slot.slice(task.slot.indexOf("-") + 1).replace(/\d+$/, "");
  if (kind === "behavioral" || kind === "systems") return [kind];
  if (kind === "study") return [`study:w${task.weekIndex}`];
  if (kind !== "build") return [];
  if (task.fixIds) return reposFor(data, task.fixIds).map((repo) => `repair:${repo}`);
  const series = /^(.+?) \d+\/\d+:/.exec(task.title);
  return [series ? `series:${series[1].toLowerCase()}` : `build:w${task.weekIndex}`];
}

export function generateBaseTasks(data, settings, { applyAudit = true } = {}) {
  const generated = data.weeks.flatMap((week, index) => weekTasks(data, settings, week, index));
  const tasks = applyAudit ? generated.map((task) => applyAuditSession(data, task)) : generated;
  // Derived on every run and never saved, so sync and old records aren't involved.
  return tasks.map((task, step) => ({ ...task, sequences: sequenceKeys(data, task).map((key) => ({ key, step })) }));
}
