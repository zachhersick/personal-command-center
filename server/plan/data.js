import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDateKey } from "./dates.js";

export const PLAN_FILE = "roadmap-plan.v1.json";
const cache = new Map();

export function planDataPath({ resourceRoot, dataRoot } = {}) {
  const override = dataRoot ? join(dataRoot, "data", "plan", "roadmap-plan.json") : "";
  if (override && existsSync(override)) return override;
  const workspaceCopy = dataRoot ? join(dataRoot, "data", "plan", PLAN_FILE) : "";
  if (workspaceCopy && existsSync(workspaceCopy)) return workspaceCopy;
  return join(resourceRoot, "data", "plan", PLAN_FILE);
}

export function validatePlanData(data) {
  const problems = [];
  if (!data || typeof data !== "object") return ["Plan data is not an object."];
  if (!Array.isArray(data.weeks) || !data.weeks.length) problems.push("weeks must be a non-empty array.");
  for (const [index, week] of (data.weeks || []).entries()) {
    if (!isDateKey(week.start)) problems.push(`weeks[${index}].start is not a date.`);
    if (!Array.isArray(week.study) || !Array.isArray(week.build)) problems.push(`weeks[${index}] needs study and build arrays.`);
  }
  const weekCount = data.weeks?.length || 0;
  if (data.library?.systems?.length !== weekCount) problems.push("library.systems must have one entry per week.");
  if (data.library?.behavioral?.length !== weekCount) problems.push("library.behavioral must have one entry per week.");
  if (!data.recurring || typeof data.recurring !== "object") problems.push("recurring templates are missing.");
  const itemIds = new Set((data.audit?.items || []).map((item) => item.id));
  for (const session of data.audit?.sessions || []) {
    if (!/^w\d+-build\d+$/.test(session.slot)) problems.push(`audit session slot ${session.slot} is invalid.`);
    for (const ref of session.refs || []) if (!itemIds.has(ref)) problems.push(`audit session ${session.slot} references unknown item ${ref}.`);
  }
  if (!data.defaults || !Array.isArray(data.defaults.classTimes)) problems.push("defaults.classTimes is missing.");
  return problems;
}

export async function loadPlanData(roots = {}) {
  const path = planDataPath(roots);
  const mtime = statSync(path).mtimeMs;
  const cached = cache.get(path);
  if (cached && cached.mtime === mtime) return cached.data;
  const data = JSON.parse(await readFile(path, "utf8"));
  const problems = validatePlanData(data);
  if (problems.length) throw new Error(`Invalid roadmap plan (${path}): ${problems.slice(0, 3).join(" ")}`);
  cache.set(path, { mtime, data });
  return data;
}
