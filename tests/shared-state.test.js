import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadSyncedRuntimeState,
  mergeRuntimeStates,
  portableRuntimeState,
  readJsonWithBackup,
  safeWriteJson,
  saveSyncedRuntimeState,
  sharedCachePaths,
  sharedJarvisDirectory
} from "../server/shared-state.js";

test("resolves the portable iCloud directory on macOS and Windows", () => {
  assert.equal(sharedJarvisDirectory({ platform: "darwin", home: "/Users/alex", exists: () => true }), "/Users/alex/Library/Mobile Documents/com~apple~CloudDocs/Jarvis");
  assert.equal(sharedJarvisDirectory({ platform: "win32", home: "C:\\Users\\Alex", env: { USERPROFILE: "C:\\Users\\Alex" }, exists: () => true }), "C:\\Users\\Alex\\iCloudDrive\\Jarvis");
  assert.equal(sharedJarvisDirectory({ platform: "darwin", env: { JARVIS_SHARED_DIR: "/shared/jarvis" } }), "/shared/jarvis");
  assert.equal(sharedJarvisDirectory({ platform: "win32", env: { JARVIS_SHARED_DIR: "D:\\Shared\\Jarvis" } }), "D:\\Shared\\Jarvis");
  assert.equal(sharedCachePaths({ platform: "darwin", home: "/Users/alex", exists: () => true }).runtime, "/Users/alex/Library/Mobile Documents/com~apple~CloudDocs/Jarvis/runtime-state.json");
  assert.equal(sharedCachePaths({ platform: "win32", home: "C:\\Users\\Alex", env: { USERPROFILE: "C:\\Users\\Alex" }, exists: () => true }).gmail, "C:\\Users\\Alex\\iCloudDrive\\Jarvis\\gmail-context.json");
});

test("merges newest task state and leaves only the newest task active", () => {
  const merged = mergeRuntimeStates({
    taskExecution: {
      trackingStartedDate: "2026-07-10",
      tasks: {
        first: { status: "active", startedAt: "2026-07-15T10:00:00.000Z", updatedAt: "2026-07-15T10:00:00.000Z" },
        done: { status: "complete", updatedAt: "2026-07-15T09:00:00.000Z" }
      }
    },
    activeRoadmapPath: "/mac/roadmap.html"
  }, {
    taskExecution: {
      trackingStartedDate: "2026-07-12",
      tasks: {
        second: { status: "active", startedAt: "2026-07-15T11:00:00.000Z", updatedAt: "2026-07-15T11:00:00.000Z" },
        done: { status: "todo", scheduledDate: "2026-07-16", updatedAt: "2026-07-15T12:00:00.000Z" }
      }
    },
    activeRoadmapPath: "C:\\roadmap.html"
  }, "2026-07-15T12:30:00.000Z");

  assert.equal(merged.taskExecution.trackingStartedDate, "2026-07-10");
  assert.equal(merged.taskExecution.tasks.first.status, "paused");
  assert.equal(merged.taskExecution.tasks.second.status, "active");
  assert.equal(merged.taskExecution.tasks.done.status, "todo");
  assert.equal(merged.activeRoadmapPath, "/mac/roadmap.html");
});

test("runtime merge preserves the highest task revision and mutation ids", () => {
  const merged = mergeRuntimeStates(
    { taskExecution: { revision: 4, recentMutationIds: ["local"], tasks: {} } },
    { taskExecution: { revision: 7, recentMutationIds: ["shared"], tasks: {} } },
    "2026-08-12T12:00:00.000Z"
  );
  assert.equal(merged.taskExecution.revision, 7);
  assert.deepEqual(merged.taskExecution.recentMutationIds, ["local", "shared"]);
});

test("Windows publishes local progress to shared storage and keeps local fallback current", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-state-root-"));
  const shared = await mkdtemp(join(tmpdir(), "jarvis-state-shared-"));
  await mkdir(join(root, "data"));
  await writeFile(join(root, "data", "runtime-state.local.json"), JSON.stringify({
    activeRoadmapPath: "/local/roadmap.html",
    taskExecution: { trackingStartedDate: "2026-07-10", tasks: { one: { status: "complete", updatedAt: "2026-07-15T10:00:00.000Z" } } }
  }));
  const options = { env: { JARVIS_SHARED_DIR: shared }, platform: "win32" };
  const loaded = await loadSyncedRuntimeState(root, options);
  assert.equal(loaded.taskExecution.tasks.one.status, "complete");
  const sharedState = JSON.parse(await readFile(join(shared, "runtime-state.json"), "utf8"));
  assert.equal(sharedState.taskExecution.tasks.one.status, "complete");
  assert.equal(sharedState.activeRoadmapPath, undefined);

  await saveSyncedRuntimeState(root, { ...loaded, taskExecution: { ...loaded.taskExecution, tasks: { ...loaded.taskExecution.tasks, two: { status: "todo", updatedAt: "2026-07-15T11:00:00.000Z" } } } }, options);
  const localState = JSON.parse(await readFile(join(root, "data", "runtime-state.local.json"), "utf8"));
  assert.equal(localState.taskExecution.tasks.two.status, "todo");
});

test("local-first saves make the durable local state visible before shared sync", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-local-first-root-"));
  const shared = await mkdtemp(join(tmpdir(), "jarvis-local-first-shared-"));
  await mkdir(join(root, "data"));
  const next = { taskExecution: { revision: 2, tasks: { one: { status: "active", updatedAt: "2026-08-12T10:00:00.000Z" } } } };
  await saveSyncedRuntimeState(root, next, { env: { JARVIS_SHARED_DIR: shared }, platform: "win32", localFirst: true });
  const local = JSON.parse(await readFile(join(root, "data", "runtime-state.local.json"), "utf8"));
  assert.equal(local.taskExecution.revision, 2);
  assert.equal(local.taskExecution.tasks.one.status, "active");
});

test("Mac waits for the PC instead of publishing its local state", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-state-root-"));
  const shared = await mkdtemp(join(tmpdir(), "jarvis-state-shared-"));
  await mkdir(join(root, "data"));
  await writeFile(join(root, "data", "runtime-state.local.json"), JSON.stringify({
    taskExecution: { tasks: { mac: { status: "complete", updatedAt: "2026-07-15T12:00:00.000Z" } } }
  }));

  const options = { env: { JARVIS_SHARED_DIR: shared }, platform: "darwin" };
  const loaded = await loadSyncedRuntimeState(root, options);
  assert.equal(loaded.taskExecution.tasks.mac.status, "complete");
  await assert.rejects(access(join(shared, "runtime-state.json")));

  await saveSyncedRuntimeState(root, {
    ...loaded,
    taskExecution: { tasks: { mac: { status: "todo", updatedAt: "2026-07-15T13:00:00.000Z" } } }
  }, options);
  await assert.rejects(access(join(shared, "runtime-state.json")));
});

test("Mac first import takes the PC portable state even when Mac timestamps are newer", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-state-root-"));
  const shared = await mkdtemp(join(tmpdir(), "jarvis-state-shared-"));
  await mkdir(join(root, "data"));
  await writeFile(join(root, "data", "runtime-state.local.json"), JSON.stringify({
    activeRoadmapPath: "/mac/roadmap.html",
    taskExecution: { tasks: { same: { status: "todo", updatedAt: "2026-07-15T13:00:00.000Z" } } },
    captureInbox: [{ id: "mac-only", updatedAt: "2026-07-15T13:00:00.000Z" }]
  }));
  await writeFile(join(shared, "runtime-state.json"), JSON.stringify(portableRuntimeState({
    taskExecution: { trackingStartedDate: "2026-07-01", tasks: { same: { status: "complete", updatedAt: "2026-07-15T10:00:00.000Z" } } },
    captureInbox: [{ id: "pc-only", updatedAt: "2026-07-15T10:00:00.000Z" }]
  }, "2026-07-15T10:00:00.000Z")));

  const loaded = await loadSyncedRuntimeState(root, { env: { JARVIS_SHARED_DIR: shared }, platform: "darwin" });
  assert.equal(loaded.taskExecution.tasks.same.status, "complete");
  assert.equal(loaded.taskExecution.trackingStartedDate, "2026-07-01");
  assert.deepEqual(loaded.captureInbox.map(({ id }) => id), ["pc-only"]);
  assert.equal(loaded.activeRoadmapPath, "/mac/roadmap.html");
  assert.equal(loaded.pcStateImportedAt, "2026-07-15T10:00:00.000Z");
});

test("Mac uses normal newest-update merging after the PC bootstrap", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-state-root-"));
  const shared = await mkdtemp(join(tmpdir(), "jarvis-state-shared-"));
  await mkdir(join(root, "data"));
  await writeFile(join(root, "data", "runtime-state.local.json"), JSON.stringify({
    pcStateImportedAt: "2026-07-15T10:00:00.000Z",
    taskExecution: { tasks: { same: { status: "complete", updatedAt: "2026-07-15T13:00:00.000Z" } } }
  }));
  await writeFile(join(shared, "runtime-state.json"), JSON.stringify(portableRuntimeState({
    taskExecution: { tasks: { same: { status: "todo", updatedAt: "2026-07-15T12:00:00.000Z" } } }
  }, "2026-07-15T12:00:00.000Z")));

  const loaded = await loadSyncedRuntimeState(root, { env: { JARVIS_SHARED_DIR: shared }, platform: "darwin" });
  assert.equal(loaded.taskExecution.tasks.same.status, "complete");
  const sharedState = JSON.parse(await readFile(join(shared, "runtime-state.json"), "utf8"));
  assert.equal(sharedState.taskExecution.tasks.same.status, "complete");
});

test("loads reuse the merged state until a file changes, and each caller gets its own plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-state-cache-"));
  const shared = join(root, "shared");
  await mkdir(join(root, "data"), { recursive: true });
  const localPath = join(root, "data", "runtime-state.local.json");
  const write = (title) => writeFile(localPath, JSON.stringify({ plan: { records: { a: { title } } } }));
  const options = { platform: "win32", env: { JARVIS_SHARED_DIR: shared }, localFirst: true };
  await write("one");
  const first = await loadSyncedRuntimeState(root, options);
  assert.equal(first.plan.records.a.title, "one");
  // Loading publishes to the shared copy; let that settle so the next read is a quiet one.
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Whole seconds, so the timestamp can be put back exactly below.
  const mtime = new Date(Math.floor(Date.now() / 1000) * 1000 - 60000);
  await utimes(localPath, mtime, mtime);
  await loadSyncedRuntimeState(root, options);

  first.plan.records.a.title = "changed by a caller";
  assert.equal((await loadSyncedRuntimeState(root, options)).plan.records.a.title, "one");

  // Same size and the same timestamp look unchanged, so the cached copy is used.
  await writeFile(localPath, (await readFile(localPath, "utf8")).replace('"one"', '"two"'));
  await utimes(localPath, mtime, mtime);
  assert.equal((await loadSyncedRuntimeState(root, options)).plan.records.a.title, "one");

  // A new timestamp is a change, and the file is read again.
  const later = new Date(mtime.getTime() + 5000);
  await utimes(localPath, later, later);
  assert.equal((await loadSyncedRuntimeState(root, options)).plan.records.a.title, "two");
});

test("safe JSON writes retain a readable backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-json-"));
  const path = join(root, "state.json");
  await safeWriteJson(path, { value: 1 });
  await safeWriteJson(path, { value: 2 });
  await writeFile(path, "not json");
  assert.deepEqual(await readJsonWithBackup(path), { value: 1 });
});
test("syncs daily priorities and job pipeline progress by their newest update", () => {
  const merged = mergeRuntimeStates({
    dailyPriorities: { "2026-09-07": { dateKey: "2026-09-07", taskIds: ["first"], updatedAt: "2026-09-07T09:00:00.000Z" } },
    jobProgress: { "job-1": { id: "job-1", stage: "Saved", updatedAt: "2026-09-07T09:00:00.000Z" } },
    manualJobs: [{ id: "manual-local", company: "Local", updatedAt: "2026-09-07T09:00:00.000Z" }]
  }, {
    dailyPriorities: { "2026-09-07": { dateKey: "2026-09-07", taskIds: ["second"], updatedAt: "2026-09-07T10:00:00.000Z" } },
    jobProgress: { "job-1": { id: "job-1", stage: "Interviewing", updatedAt: "2026-09-07T10:00:00.000Z" } },
    manualJobs: [{ id: "manual-shared", company: "Shared", updatedAt: "2026-09-07T10:00:00.000Z" }]
  }, "2026-09-07T11:00:00.000Z");
  assert.deepEqual(merged.dailyPriorities["2026-09-07"].taskIds, ["second"]);
  assert.equal(merged.jobProgress["job-1"].stage, "Interviewing");
  assert.deepEqual(merged.manualJobs.map((job) => job.id), ["manual-shared", "manual-local"]);
  const portable = portableRuntimeState(merged, "2026-09-07T11:00:00.000Z");
  assert.equal(portable.jobProgress["job-1"].stage, "Interviewing");
  assert.equal(portable.dailyPriorities["2026-09-07"].taskIds[0], "second");
});
test("merges task history from local and shared runtime state by newest update", () => {
  const merged = mergeRuntimeStates(
    {
      taskExecution: {
        trackingStartedDate: "2026-07-10",
        tasks: {
          shared: { status: "todo", updatedAt: "2026-07-14T10:00:00.000Z" },
          local: { status: "complete", updatedAt: "2026-07-15T10:00:00.000Z" }
        }
      }
    },
    {
      taskExecution: {
        trackingStartedDate: "2026-07-12",
        tasks: {
          shared: { status: "carried", updatedAt: "2026-07-15T11:00:00.000Z" }
        }
      }
    }
  );

  assert.equal(merged.taskExecution.trackingStartedDate, "2026-07-10");
  assert.equal(merged.taskExecution.tasks.local.status, "complete");
  assert.equal(merged.taskExecution.tasks.shared.status, "carried");
});
