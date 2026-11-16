// App-wide state (Preact signals) and the actions that change it.
import { signal, computed, batch } from "@preact/signals";
import { get, post } from "./api.js";
import { normalizeRoute } from "../routes.js";
import { isWeb, loadSession, signedIn } from "./platform.js";

const storage = {
  get(key, fallback = null) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Storage can be unavailable; preferences just won't persist.
    }
  }
};
export { storage };

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [head, ...rest] = raw.split("/");
  return { route: normalizeRoute(head), param: decodeURIComponent(rest.join("/") || "") };
}

const initial = parseHash();
export const route = signal(initial.route);
export const routeParam = signal(initial.param);
export const meta = signal(null);
export const day = signal(null);
export const viewDate = signal(null);
export const focusState = signal(null);
export const spotify = signal(null);
export const revision = signal(0);
export const spreadPreview = signal(null);
export const toasts = signal([]);
export const sheetTaskId = signal(null);
export const paletteOpen = signal(false);
export const settingsOpen = signal(false);
export const neetcodePrompt = signal(null);
export const focusTarget = signal(null);
export const loadError = signal("");
export const theme = signal(storage.get("jarvis-theme", "dark"));
export const appUpdate = signal(null);

export const todayKey = computed(() => meta.value?.todayKey || null);
export const currentWeek = computed(() => {
  const m = meta.value;
  return m && m.currentWeekIndex >= 0 ? m.weeks[m.currentWeekIndex] : null;
});

window.addEventListener("hashchange", () => {
  const next = parseHash();
  batch(() => {
    route.value = next.route;
    routeParam.value = next.param;
  });
});

export function navigate(next, param = "") {
  const hash = `#${next}${param ? `/${encodeURIComponent(param)}` : ""}`;
  if (location.hash !== hash) location.hash = hash;
  else {
    route.value = normalizeRoute(next);
    routeParam.value = param;
  }
}

export function setTheme(next) {
  theme.value = next;
  document.documentElement.dataset.theme = next;
  storage.set("jarvis-theme", next);
}

// ---------- toasts ----------
let toastId = 0;
export function toast(message, options = {}) {
  const id = ++toastId;
  const entry = { id, message, tone: options.tone || "info", action: options.action || null };
  toasts.value = [...toasts.value, entry].slice(-4);
  setTimeout(() => dismissToast(id), options.duration || (options.action ? 6500 : 3800));
  return id;
}

export function dismissToast(id) {
  toasts.value = toasts.value.filter((entry) => entry.id !== id);
}

export function reportError(error) {
  console.error(error);
  toast(error?.message || String(error), { tone: "danger" });
}

// ---------- loading ----------
export async function loadMeta() {
  const data = await get("/api/plan/meta");
  meta.value = data;
  loadError.value = "";
  return data;
}

export async function loadDay(date = viewDate.value || meta.value?.todayKey) {
  const data = await get(`/api/plan/day${date ? `?date=${date}` : ""}`);
  if (!viewDate.value || viewDate.value === data.date) day.value = data;
  return data;
}

export async function loadFocus() {
  try {
    focusState.value = await get("/api/focus/state");
  } catch (error) {
    console.error(error);
  }
  return focusState.value;
}

export async function loadSpotify() {
  try {
    spotify.value = await get("/api/integrations/spotify/status");
  } catch (error) {
    spotify.value = { connected: false, error: error.message };
  }
  return spotify.value;
}

let refreshTimer = null;
export function refresh({ immediate = false } = {}) {
  clearTimeout(refreshTimer);
  const run = async () => {
    revision.value += 1;
    try {
      await Promise.all([loadMeta(), loadDay()]);
    } catch (error) {
      reportError(error);
    }
  };
  if (immediate) return run();
  refreshTimer = setTimeout(run, 60);
  return null;
}

// Desktop self-update status. Outside the installed app this stays
// { desktop: false } and the UI hides the update controls.
export async function loadAppUpdate() {
  try {
    appUpdate.value = { desktop: true, ...(await get("/api/app/update")) };
  } catch (error) {
    appUpdate.value = { desktop: error.status !== 409, state: "error", error: error.message };
  }
  return appUpdate.value;
}

let updateNoticeShown = false;
async function watchAppUpdate() {
  const status = await loadAppUpdate();
  if (status?.justUpdated && !updateNoticeShown) {
    updateNoticeShown = true;
    toast(`Updated to Jarvis ${status.justUpdated.to}`, { tone: "good", duration: 9000, action: { label: "What's new", run: () => { settingsOpen.value = true; } } });
  }
}

export async function boot() {
  try {
    await loadSession();
    if (!signedIn.value) return;
    const data = await loadMeta();
    viewDate.value = data.todayKey;
    await Promise.all([loadDay(data.todayKey), loadFocus()]);
    if (!isWeb.value) {
      void watchAppUpdate();
      setInterval(() => void loadAppUpdate(), 10 * 60 * 1000);
    }
  } catch (error) {
    loadError.value = error.message;
  }
}

// Roll over to the new day if the app stays open past midnight.
setInterval(async () => {
  if (document.hidden || !meta.value) return;
  const before = meta.value.todayKey;
  try {
    const data = await loadMeta();
    if (data.todayKey !== before && viewDate.value === before) {
      viewDate.value = data.todayKey;
      await loadDay(data.todayKey);
    }
  } catch {
    // Offline for a moment; try again next tick.
  }
}, 5 * 60 * 1000);

// ---------- task actions ----------
function patchLocalTask(id, patch) {
  const current = day.value;
  if (!current) return;
  const apply = (task) => (task.id === id ? { ...task, ...patch } : task);
  day.value = {
    ...current,
    tasks: current.tasks.map(apply),
    carried: current.carried.map(apply),
    unscheduled: current.unscheduled.map(apply),
    completed: current.completed?.map(apply),
    blocks: current.blocks.map((block) => (block.task?.id === id ? { ...block, task: apply(block.task) } : block))
  };
}

export async function patchTask(id, patch, { quiet = false } = {}) {
  try {
    await post("/api/plan/tasks/patch", { id, ...patch });
    refresh();
    return true;
  } catch (error) {
    if (!quiet) reportError(error);
    refresh();
    return false;
  }
}

export async function setTaskDone(task, done) {
  patchLocalTask(task.id, { done });
  const ok = await patchTask(task.id, { done });
  if (!ok) return;
  if (done) {
    toast(`Done: ${task.title}`, {
      tone: "good",
      action: { label: "Undo", run: () => setTaskDone(task, false) }
    });
    if (task.category === "NeetCode") neetcodePrompt.value = { taskId: task.id, title: task.title };
  }
}

export async function skipTask(task, skipped = true) {
  patchLocalTask(task.id, { skipped });
  const ok = await patchTask(task.id, { skipped });
  if (ok && skipped) toast(`Skipped: ${task.title}`, { action: { label: "Undo", run: () => skipTask(task, false) } });
}

export async function moveTask(task, date, { pinnedStart } = {}) {
  const patch = { date };
  if (pinnedStart !== undefined) patch.pinnedStart = pinnedStart;
  const ok = await patchTask(task.id, patch);
  if (ok && task.date !== date) {
    toast(`Moved to ${new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`))}`, {
      action: { label: "Undo", run: () => patchTask(task.id, { date: task.date }) }
    });
  }
  return ok;
}

export async function triage(body) {
  try {
    const data = await post("/api/plan/triage", body);
    if (!body.dryRun && !data.result?.stale) refresh();
    return data.result;
  } catch (error) {
    reportError(error);
    return null;
  }
}

export async function previewSpread(ids) {
  const result = await triage({ action: "rebalance", reclaimCompleted: true, ids, dryRun: true });
  if (result) spreadPreview.value = result;
}

export function openTask(id) {
  sheetTaskId.value = id;
}

// A task, or anything else worth timing: a meal passes kind "break" so the
// session stays out of the focused-time totals.
export function startFocusOn(task) {
  focusTarget.value = task ? { id: task.id || null, title: task.title, minutes: task.minutes, category: task.category, kind: task.kind || "work" } : null;
  navigate("focus");
}
