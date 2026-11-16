import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { homedir } from "node:os";
import { mergePlanState } from "./plan/state.js";

const VERSION = 1;
let status = { available: false, connected: false, pending: false, lastSyncedAt: null, retryAt: null, error: "" };
let queuedSharedWrite = null;
let sharedWriteRunning = false;
let sharedRetryTimer = null;

function timestamp(value = {}) {
  return Date.parse(value.updatedAt || value.completedAt || value.scheduledAt || value.resumeUpdatedAt || value.createdAt || value.at || value.startedAt || 0) || 0;
}

function itemId(value = {}) {
  return String(value.id || value.taskId || value.sourceCaptureId || "");
}

function mergeItems(local = [], shared = [], limit = Infinity) {
  const merged = new Map(local.map((item) => [itemId(item), item]).filter(([id]) => id));
  for (const item of shared) {
    const id = itemId(item);
    if (!id) continue;
    const current = merged.get(id);
    if (!current || timestamp(item) >= timestamp(current)) merged.set(id, item);
  }
  return [...merged.values()].sort((a, b) => timestamp(b) - timestamp(a)).slice(0, limit);
}

function mergeRecordMap(local = {}, shared = {}) {
  const merged = { ...(local || {}) };
  for (const [id, value] of Object.entries(shared || {})) {
    if (!merged[id] || timestamp(value) > timestamp(merged[id])) merged[id] = value;
  }
  return merged;
}

function pauseOlderActiveTasks(tasks, now) {
  const active = Object.entries(tasks).filter(([, entry]) => entry.status === "active");
  if (active.length < 2) return tasks;
  active.sort(([, a], [, b]) => timestamp(b) - timestamp(a));
  const keep = active[0][0];
  return Object.fromEntries(Object.entries(tasks).map(([id, entry]) => {
    if (id === keep || entry.status !== "active") return [id, entry];
    const elapsed = entry.startedAt ? Math.max(0, Math.floor((Date.parse(now) - Date.parse(entry.startedAt)) / 1000)) : 0;
    return [id, {
      ...entry,
      status: "paused",
      accumulatedSeconds: Number(entry.accumulatedSeconds || 0) + elapsed,
      startedAt: null,
      updatedAt: now
    }];
  }));
}

function mergeExecution(local = {}, shared = {}, now) {
  const tasks = { ...(local.tasks || {}) };
  for (const [id, entry] of Object.entries(shared.tasks || {})) {
    if (!tasks[id] || timestamp(entry) > timestamp(tasks[id])) tasks[id] = entry;
  }
  const trackingDates = [local.trackingStartedDate, shared.trackingStartedDate].filter(Boolean).sort();
  return {
    ...local,
    ...shared,
    revision: Math.max(Number(local.revision || 0), Number(shared.revision || 0)),
    recentMutationIds: [...new Set([...(local.recentMutationIds || []), ...(shared.recentMutationIds || [])])].slice(-100),
    trackingStartedDate: trackingDates[0],
    tasks: pauseOlderActiveTasks(tasks, now)
  };
}

export function portableRuntimeState(state = {}, updatedAt = new Date().toISOString()) {
  return {
    version: VERSION,
    updatedAt,
    taskExecution: state.taskExecution || {},
    captureInbox: state.captureInbox || [],
    adHocTasks: state.adHocTasks || [],
    dailyReviews: state.dailyReviews || [],
    dailyPriorities: state.dailyPriorities || {},
    weeklyReviews: state.weeklyReviews || [],
    jobProgress: state.jobProgress || {},
    jobApplications: state.jobApplications || {},
    manualJobs: state.manualJobs || [],
    careerPlanningWeeks: state.careerPlanningWeeks || {},
    roadmapTaskCatalog: state.roadmapTaskCatalog || {},
    archivedRoadmapTasks: state.archivedRoadmapTasks || {},
    retainedRoadmapTasks: state.retainedRoadmapTasks || {},
    dismissedAttentionIds: [...new Set(state.dismissedAttentionIds || [])],
    plan: state.plan || {}
  };
}

export function mergeRuntimeStates(local = {}, shared = {}, now = new Date().toISOString()) {
  return {
    ...local,
    taskExecution: mergeExecution(local.taskExecution, shared.taskExecution, now),
    captureInbox: mergeItems(local.captureInbox, shared.captureInbox, 100),
    adHocTasks: mergeItems(local.adHocTasks, shared.adHocTasks),
    dailyReviews: mergeItems(local.dailyReviews, shared.dailyReviews, 60),
    dailyPriorities: mergeRecordMap(local.dailyPriorities, shared.dailyPriorities),
    weeklyReviews: mergeItems(local.weeklyReviews, shared.weeklyReviews, 60),
    jobProgress: mergeRecordMap(local.jobProgress, shared.jobProgress),
    jobApplications: mergeRecordMap(local.jobApplications, shared.jobApplications),
    manualJobs: mergeItems(local.manualJobs, shared.manualJobs, 2000),
    careerPlanningWeeks: mergeRecordMap(local.careerPlanningWeeks, shared.careerPlanningWeeks),
    roadmapTaskCatalog: mergeRecordMap(local.roadmapTaskCatalog, shared.roadmapTaskCatalog),
    archivedRoadmapTasks: mergeRecordMap(local.archivedRoadmapTasks, shared.archivedRoadmapTasks),
    retainedRoadmapTasks: mergeRecordMap(local.retainedRoadmapTasks, shared.retainedRoadmapTasks),
    dismissedAttentionIds: [...new Set([...(local.dismissedAttentionIds || []), ...(shared.dismissedAttentionIds || [])])],
    plan: mergePlanState(local.plan, shared.plan)
  };
}

function importPcBootstrap(local = {}, shared = {}) {
  return {
    ...local,
    taskExecution: shared.taskExecution || {},
    captureInbox: shared.captureInbox || [],
    adHocTasks: shared.adHocTasks || [],
    dailyReviews: shared.dailyReviews || [],
    dailyPriorities: shared.dailyPriorities || {},
    weeklyReviews: shared.weeklyReviews || [],
    jobProgress: shared.jobProgress || {},
    jobApplications: shared.jobApplications || {},
    manualJobs: shared.manualJobs || [],
    careerPlanningWeeks: shared.careerPlanningWeeks || {},
    roadmapTaskCatalog: shared.roadmapTaskCatalog || {},
    archivedRoadmapTasks: shared.archivedRoadmapTasks || {},
    retainedRoadmapTasks: shared.retainedRoadmapTasks || {},
    dismissedAttentionIds: [...new Set(shared.dismissedAttentionIds || [])],
    plan: mergePlanState(local.plan, shared.plan),
    pcStateImportedAt: shared.updatedAt || new Date().toISOString()
  };
}

function hasSharedRuntimeState(path, value) {
  return Boolean(path && (existsSync(path) || existsSync(`${path}.bak`)) && value?.version === VERSION && value?.updatedAt);
}

function waitingForPcStatus() {
  return {
    available: true,
    connected: false,
    pending: false,
    lastSyncedAt: null,
    retryAt: null,
    error: "Waiting for the PC to publish Jarvis state."
  };
}

function sharedPathApi(platform, value = "") {
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(value)) return win32;
  if (value.startsWith("/")) return posix;
  return platform === "win32" ? win32 : posix;
}

export function sharedJarvisDirectory(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const home = options.home || homedir();
  const exists = options.exists || existsSync;
  const override = String(env.JARVIS_SHARED_DIR || "");
  const paths = sharedPathApi(platform, override);
  if (override) return paths.isAbsolute(override) ? paths.normalize(override) : resolve(override);
  const root = platform === "darwin"
    ? paths.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs")
    : platform === "win32"
      ? paths.join(env.USERPROFILE || home, "iCloudDrive")
      : "";
  return root && exists(root) ? paths.join(root, "Jarvis") : "";
}

export function sharedCachePaths(options = {}) {
  const directory = sharedJarvisDirectory(options);
  const paths = sharedPathApi(options.platform || process.platform, directory);
  return directory ? {
    directory,
    runtime: paths.join(directory, "runtime-state.json"),
    gmail: paths.join(directory, "gmail-context.json"),
    jobs: paths.join(directory, "job-board-results.json")
  } : { directory: "", runtime: "", gmail: "", jobs: "" };
}

export async function readJsonWithBackup(path, fallback = {}) {
  for (const candidate of [path, path && `${path}.bak`].filter(Boolean)) {
    if (!existsSync(candidate)) continue;
    // Files written by Windows tools can start with a byte-order mark.
    try { return JSON.parse((await readFile(candidate, "utf8")).replace(/^﻿/, "")); } catch { /* use the backup */ }
  }
  return fallback;
}

export async function safeWriteJson(path, value) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const backup = `${path}.bak`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  JSON.parse(serialized);
  await writeFile(temp, serialized, "utf8");
  if (existsSync(path)) await copyFile(path, backup);
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(path, { force: true });
    try { await rename(temp, path); } catch {
      if (existsSync(backup)) await copyFile(backup, path);
      throw error;
    }
  } finally {
    await rm(temp, { force: true });
  }
}

function portableComparable(state) {
  const { updatedAt, ...value } = portableRuntimeState(state, "");
  return JSON.stringify(value);
}

// The runtime state is several megabytes, mostly old roadmap catalogs carried
// for older installs, and every plan, jobs and music request loads it. Reading,
// parsing and merging both copies costs 100-200 ms, so the merged result is
// kept until either file changes on disk or this module writes one.
let loadCache = null;
let writeGeneration = 0;

async function fileStamp(path) {
  if (!path) return "-";
  try {
    const info = await stat(path);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "missing";
  }
}

async function loadCacheKey(localPath, sharedPath, platform) {
  const stamps = await Promise.all([localPath, `${localPath}.bak`, sharedPath, sharedPath && `${sharedPath}.bak`].map(fileStamp));
  return [platform, localPath, sharedPath, ...stamps].join("|");
}

// Callers get their own plan to change; the other sections are only read or
// replaced, never edited in place, so they can be shared with the cache.
function fromCache(value) {
  return { ...value, plan: value.plan ? structuredClone(value.plan) : value.plan };
}

function forgetLoadedState() {
  loadCache = null;
  writeGeneration += 1;
}

export function clearRuntimeStateCache() {
  forgetLoadedState();
}

export async function loadSyncedRuntimeState(rootDir, options = {}) {
  const localPath = join(rootDir, "data", "runtime-state.local.json");
  const paths = sharedCachePaths(options);
  const platform = options.platform || process.platform;
  // Stamped before reading: a file that changes mid-read gets a new stamp, so
  // the next load reads it again instead of trusting what this one saw.
  const key = await loadCacheKey(localPath, paths.runtime, platform);
  if (loadCache?.key === key) return fromCache(loadCache.value);
  const generation = writeGeneration;
  const merged = await loadSyncedRuntimeStateFromDisk(localPath, paths, platform, options);
  // A save or background iCloud write during the read may have changed what
  // the files hold, so only a quiet read is kept.
  if (generation === writeGeneration) loadCache = { key, value: merged };
  return fromCache(merged);
}

async function loadSyncedRuntimeStateFromDisk(localPath, paths, platform, options) {
  const [local, shared] = await Promise.all([
    readJsonWithBackup(localPath),
    readJsonWithBackup(paths.runtime)
  ]);
  if (!paths.runtime) {
    status = { available: false, connected: false, pending: false, lastSyncedAt: null, retryAt: null, error: "iCloud Drive is unavailable." };
    return local;
  }

  const hasShared = hasSharedRuntimeState(paths.runtime, shared);
  if (!hasShared && platform !== "win32") {
    status = waitingForPcStatus();
    return local;
  }

  const importingPcState = platform === "darwin" && !local.pcStateImportedAt;
  const merged = importingPcState ? importPcBootstrap(local, shared) : mergeRuntimeStates(local, shared);
  try {
    if (!hasShared || (!importingPcState && portableComparable(merged) !== portableComparable(shared))) {
      const portable = portableRuntimeState(merged);
      if (platform === "win32" && options.localFirst) queueSharedRuntimeWrite(paths.runtime, portable);
      else await safeWriteJson(paths.runtime, portable);
    }
    if (portableComparable(merged) !== portableComparable(local)) await safeWriteJson(localPath, merged);
    else if (importingPcState) await safeWriteJson(localPath, merged);
    const synced = await readJsonWithBackup(paths.runtime);
    status = { available: true, connected: true, pending: Boolean(queuedSharedWrite), lastSyncedAt: synced.updatedAt || null, retryAt: null, error: "" };
  } catch (error) {
    status = { available: true, connected: false, pending: false, lastSyncedAt: shared.updatedAt || null, retryAt: null, error: error.message };
  }
  return merged;
}

async function flushQueuedSharedWrite() {
  if (sharedWriteRunning || !queuedSharedWrite) return;
  forgetLoadedState();
  sharedWriteRunning = true;
  const queued = queuedSharedWrite;
  queuedSharedWrite = null;
  try {
    await safeWriteJson(queued.path, queued.value);
    status = { available: true, connected: true, pending: Boolean(queuedSharedWrite), lastSyncedAt: queued.value.updatedAt || null, retryAt: null, error: "" };
  } catch (error) {
    queuedSharedWrite = queuedSharedWrite || queued;
    const retryAt = new Date(Date.now() + 2000).toISOString();
    status = { ...status, available: true, connected: false, pending: true, retryAt, error: error.message };
    if (!sharedRetryTimer) {
      sharedRetryTimer = setTimeout(() => {
        sharedRetryTimer = null;
        void flushQueuedSharedWrite();
      }, 2000);
      sharedRetryTimer.unref?.();
    }
  } finally {
    sharedWriteRunning = false;
    if (queuedSharedWrite && !sharedRetryTimer) queueMicrotask(() => void flushQueuedSharedWrite());
  }
}

function queueSharedRuntimeWrite(path, value) {
  queuedSharedWrite = { path, value };
  status = { ...status, available: true, pending: true, retryAt: null, error: "" };
  queueMicrotask(() => void flushQueuedSharedWrite());
}

export async function saveSyncedRuntimeState(rootDir, nextState, options = {}) {
  forgetLoadedState();
  const localPath = join(rootDir, "data", "runtime-state.local.json");
  const paths = sharedCachePaths(options);
  const platform = options.platform || process.platform;
  const shared = await readJsonWithBackup(paths.runtime);
  if (!paths.runtime) {
    await safeWriteJson(localPath, nextState);
    status = { available: false, connected: false, pending: false, lastSyncedAt: null, retryAt: null, error: "iCloud Drive is unavailable; progress is saved locally." };
    return nextState;
  }

  if (options.localFirst) {
    await safeWriteJson(localPath, nextState);
    queueSharedRuntimeWrite(paths.runtime, portableRuntimeState(nextState));
    return nextState;
  }

  const hasShared = hasSharedRuntimeState(paths.runtime, shared);
  if (!hasShared && platform !== "win32") {
    await safeWriteJson(localPath, nextState);
    status = waitingForPcStatus();
    return nextState;
  }

  const importingPcState = platform === "darwin" && !nextState.pcStateImportedAt;
  const merged = importingPcState ? importPcBootstrap(nextState, shared) : mergeRuntimeStates(nextState, shared);
  await safeWriteJson(localPath, merged);
  try {
    const portable = portableRuntimeState(merged);
    const changed = portableComparable(merged) !== portableComparable(shared);
    if (!importingPcState && changed) await safeWriteJson(paths.runtime, portable);
    status = {
      available: true,
      connected: true,
      pending: false,
      lastSyncedAt: importingPcState ? shared.updatedAt : changed ? portable.updatedAt : shared.updatedAt || null,
      retryAt: null,
      error: ""
    };
  } catch (error) {
    status = { available: true, connected: false, pending: false, lastSyncedAt: shared.updatedAt || null, retryAt: null, error: error.message };
  }
  return merged;
}

// Resolves once background iCloud writes have landed (or are only waiting on a
// retry), so callers can safely move or delete the shared folder.
export async function settleSharedWrites({ timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while ((sharedWriteRunning || (queuedSharedWrite && !sharedRetryTimer)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function runtimeSyncStatus() {
  return { ...status };
}
