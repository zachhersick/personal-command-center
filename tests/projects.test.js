import test from "node:test";
import assert from "node:assert/strict";
import { createProjects, PROJECTS_FRESH_MS } from "../server/projects.js";

const config = {
  integrations: { github: { enabled: true, sideProjects: [] } },
  workspace: { trackedRepos: [], projects: [{ id: "jarvis", slug: "zachhersick/jarvis", path: "C:/nowhere/jarvis" }] }
};

function fakeRun() {
  const calls = [];
  let release = null;
  const run = async (command, args) => {
    calls.push(`${command} ${args[0]}`);
    if (release) await release.promise;
    return { ok: true, stdout: command === "gh" && args[0] !== "auth" ? "[]" : "", stderr: "" };
  };
  return {
    run,
    calls,
    hold() {
      let resolve;
      release = { promise: new Promise((done) => { resolve = done; }), resolve };
    },
    letGo() {
      release?.resolve();
      release = null;
    }
  };
}

test("projects answer from the last check, recheck in the background once it ages, and refresh on demand", async () => {
  let clock = Date.parse("2026-11-12T12:00:00Z");
  const fake = fakeRun();
  const projects = createProjects({ run: fake.run, now: () => clock });

  const first = await projects.list(config);
  assert.equal(first.projects.length, 1);
  assert.equal(first.checkedAt, "2026-11-12T12:00:00.000Z");
  const checks = fake.calls.length;
  assert.ok(checks > 0);

  // Inside a minute nothing runs again.
  clock += PROJECTS_FRESH_MS - 1;
  assert.equal((await projects.list(config)).checkedAt, first.checkedAt);
  assert.equal(fake.calls.length, checks);

  // An older answer comes back straight away while a new check starts behind it.
  clock += 1;
  fake.hold();
  const stale = await projects.list(config);
  assert.equal(stale.checkedAt, first.checkedAt);
  assert.equal(stale.refreshing, true);
  // A second visit during that check doesn't start another one.
  await projects.list(config);
  fake.letGo();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fake.calls.length, checks * 2);
  assert.equal((await projects.list(config)).checkedAt, new Date(clock).toISOString());

  // Asking for a refresh waits for a new check even when the last one is fresh.
  clock += 1000;
  const forced = await projects.list(config, { force: true });
  assert.equal(forced.checkedAt, new Date(clock).toISOString());
  assert.equal(fake.calls.length, checks * 3);
});
