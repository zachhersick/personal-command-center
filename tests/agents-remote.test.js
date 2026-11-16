import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteAgents } from "../server/agents/remote.js";
import { createCloudSync } from "../server/cloud-sync.js";
import { removeTempDir } from "./helpers.js";

function stubAgents() {
  const calls = [];
  const run = { id: "run-1", events: [] };
  return {
    calls,
    api: {
      startRequest: (body) => ({ ...body }),
      startOrQueue: async (request, options) => { calls.push(["start", request, options]); return { run, queued: true, position: 2 }; },
      stopRun: (id) => { calls.push(["stop", id]); },
      remoteInfo: async () => ({ projects: [{ id: "jarvis", name: "Jarvis" }], providers: {} }),
      launcher: {
        message: async (id) => { calls.push(["message", id]); throw Object.assign(new Error("This agent is still working."), { status: 409 }); },
        cancelQueued: (id) => { calls.push(["cancel", id]); },
        pushEvents: (target, events) => target.events.push(...events),
        touch: () => {}
      }
    }
  };
}

test("phone commands run once, through the same start path, and always get an answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-remote-"));
  try {
    const { api, calls } = stubAgents();
    const remote = createRemoteAgents({ agentsApi: api, dataRoot: () => root });
    const started = await remote.run({ id: "c1", type: "start", projectId: "jarvis", provider: "claude", prompt: "Explain" });
    assert.deepEqual(started, { id: "c1", ok: true, runId: "run-1", queued: true, position: 2 });
    assert.equal(calls[0][1].requestedFrom, "phone");
    assert.deepEqual(calls[0][2], { queue: true }, "a busy desktop queues the phone's request");
    assert.deepEqual(await remote.run({ id: "c1", type: "start", prompt: "Explain" }), { id: "c1", ok: false, error: "Already handled." });
    assert.equal(calls.filter(([kind]) => kind === "start").length, 1);
    // A restarted desktop still remembers what it already did.
    const again = createRemoteAgents({ agentsApi: api, dataRoot: () => root });
    assert.equal((await again.run({ id: "c1", type: "start" })).error, "Already handled.");
    assert.deepEqual(await remote.run({ id: "c2", type: "message", runId: "r", prompt: "hi" }), { id: "c2", ok: false, error: "This agent is still working." });
    assert.equal((await remote.run({ id: "c3", type: "keep", runId: "r" })).ok, false, "only start, reply, stop and cancel");
    assert.equal((await remote.run({ id: "c4", type: "cancel", runId: "r" })).ok, true);
    assert.equal((await remote.run({})).ok, false);
  } finally { await removeTempDir(root); }
});

// The cloud strips these too, but the desktop is what runs the command, so it
// can't trust whoever wrote the cloud record.
test("a phone start can't run a check command, pick a base or set anything else", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-remote-strip-"));
  try {
    const { api, calls } = stubAgents();
    const remote = createRemoteAgents({ agentsApi: api, dataRoot: () => root });
    await remote.run({
      id: "c1", type: "start", projectId: "jarvis", provider: "claude", prompt: "Fix it", mode: "yolo",
      loop: { check: "calc.exe", maxIterations: 9 }, base: "--output=x", retryOf: "r", requestedFrom: "desktop", extra: 1
    });
    const request = calls[0][1];
    assert.equal(request.loop, undefined);
    assert.equal(request.base, undefined);
    assert.equal(request.retryOf, undefined);
    assert.equal(request.extra, undefined);
    assert.equal(request.requestedFrom, "phone");
    assert.equal(request.mode, "edit");
    assert.equal(request.prompt, "Fix it");
  } finally { await removeTempDir(root); }
});

test("the desktop asks for phone commands only when phone control is on, and reports back", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-remote-sync-"));
  try {
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "cloud-sync.local.json"), JSON.stringify({ url: "https://jarvis.example.com", token: `jvs_${"a".repeat(30)}` }));
    const bodies = [];
    let reply = {};
    const fetchImpl = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ ok: true, ...reply }) };
    };
    const ran = [];
    const sync = createCloudSync({
      dataRoot: () => root,
      loadRuntimeState: async () => ({}),
      saveRuntimeState: async () => {},
      serializeTaskMutation: (work) => work(),
      boardSnapshot: async () => ({ generatedAt: "now", counts: {}, sessions: [] }),
      remoteAgents: { info: async () => ({ projects: [{ id: "jarvis", name: "Jarvis" }], providers: {} }), run: async (command) => { ran.push(command.id); return { id: command.id, ok: true, runId: "run-9" }; } },
      fetchImpl
    });

    // Off by default: the board says so, and commands in a reply are ignored.
    reply = { agentCommands: [{ id: "c1", type: "start" }] };
    await sync.pushBoard();
    assert.deepEqual(bodies[0].agentsBoard.remote, { enabled: false });
    assert.equal(bodies[0].acceptAgentCommands, undefined);
    assert.deepEqual(ran, []);
    assert.equal((await sync.status()).phoneAgents, false);

    await sync.setPhoneAgents(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const on = bodies.at(-1);
    assert.equal(on.acceptAgentCommands, true);
    assert.deepEqual(on.agentsBoard.remote, { enabled: true, projects: [{ id: "jarvis", name: "Jarvis" }], providers: {} });
    assert.deepEqual(ran, ["c1"]);

    // The next push carries the answer, then forgets it.
    reply = {};
    await sync.pushBoard();
    assert.deepEqual(bodies.at(-1).agentResults, [{ id: "c1", ok: true, runId: "run-9" }]);
    assert.equal(bodies.at(-1).agentsBoard, undefined, "an unchanged board isn't sent again");
    await sync.pushBoard();
    assert.equal(bodies.at(-1).agentResults, undefined);
    assert.equal(bodies.at(-1).acceptAgentCommands, true, "still checking for commands while on");
    sync.stop();
  } finally { await removeTempDir(root); }
});
