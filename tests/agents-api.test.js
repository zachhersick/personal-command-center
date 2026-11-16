import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeConfigPaths } from "../server/platform.js";
import { startServer } from "../server.js";
import { claudeProjectSlug } from "../server/agents/paths.js";
import { removeTempDir } from "./helpers.js";

async function withServer(fn) {
  const keys = ["JARVIS_SHARED_DIR", "JARVIS_CLAUDE_HOME", "JARVIS_CODEX_HOME"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const root = await mkdtemp(join(tmpdir(), "jarvis-agents-api-"));
  process.env.JARVIS_SHARED_DIR = join(root, "shared");
  process.env.JARVIS_CLAUDE_HOME = join(root, "claude");
  process.env.JARVIS_CODEX_HOME = join(root, "codex-missing");
  const dataRoot = join(root, "app");
  await mkdir(join(dataRoot, "config"), { recursive: true });
  await mkdir(join(dataRoot, "data"), { recursive: true });
  const config = normalizeConfigPaths(JSON.parse(await readFile(join(process.cwd(), "config", "jarvis.config.json"), "utf8")), { baseDir: process.cwd() });
  await writeFile(join(dataRoot, "config", "jarvis.config.json"), JSON.stringify(config));

  // One live Claude session: this test process stands in for its pid.
  const cwd = join(root, "repo");
  await mkdir(join(process.env.JARVIS_CLAUDE_HOME, "sessions"), { recursive: true });
  await writeFile(join(process.env.JARVIS_CLAUDE_HOME, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "sess-1", cwd, status: "busy", name: "Demo session", updatedAt: Date.now() - 60_000 }));
  await mkdir(join(process.env.JARVIS_CLAUDE_HOME, "projects", claudeProjectSlug(cwd)), { recursive: true });
  await writeFile(join(process.env.JARVIS_CLAUDE_HOME, "projects", claudeProjectSlug(cwd), "sess-1.jsonl"), `${JSON.stringify({ type: "user", timestamp: new Date().toISOString(), cwd, gitBranch: "main", message: { content: "Do the thing" } })}\n`);

  const handle = await startServer({ host: "127.0.0.1", port: 0, dataRoot });
  try {
    return await fn(`http://${handle.host}:${handle.port}`, handle);
  } finally {
    await new Promise((resolve) => handle.server.close(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeTempDir(root);
  }
}

const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("agents API lists sessions, takes hook events and guards writes", async () => {
  await withServer(async (base, handle) => {
    const board = await (await fetch(`${base}/api/agents`)).json();
    assert.equal(board.ok, true);
    const session = board.sessions.find((entry) => entry.id === "claude:sess-1");
    assert.equal(session.status, "working");
    assert.equal(session.title, "Demo session");
    assert.equal(board.sources.codex, false);

    assert.equal((await post(`${base}/api/agents/hook`, { provider: "claude", event: { session_id: "sess-1", hook_event_name: "Notification", message: "Needs approval" } })).status, 200);
    const after = await (await fetch(`${base}/api/agents`)).json();
    const updated = after.sessions.find((entry) => entry.id === "claude:sess-1");
    assert.equal(updated.status, "needs-you");
    assert.equal(updated.waitingFor, "Needs approval");
    assert.equal(after.counts["needs-you"], 1);

    const detail = await (await fetch(`${base}/api/agents/session?id=claude:sess-1`)).json();
    assert.equal(detail.session.recent[0].kind, "prompt");
    assert.equal((await fetch(`${base}/api/agents/session?id=nope`)).status, 404);

    const projects = await (await fetch(`${base}/api/agents/projects`)).json();
    assert.ok(projects.projects.some((project) => project.id === "jarvis"));
    const labs = await (await fetch(`${base}/api/agents/labs`)).json();
    assert.equal(labs.labs.length, 10);
    assert.ok(labs.playbook.length >= 5);

    const preview = await (await fetch(`${base}/api/agents/hooks?scope=user`)).json();
    assert.equal(preview.changed, true);
    assert.match(preview.path, /settings\.json$/);

    assert.equal((await post(`${base}/api/agents/runs`, { projectId: "nope", provider: "claude", prompt: "x" })).status, 404);
    assert.equal((await fetch(`${base}/api/agents/hook`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
    const forbidden = await new Promise((resolve, reject) => {
      const req = request({ host: handle.host, port: handle.port, path: "/api/agents/runs/stop", method: "POST", headers: { host: "evil.example", "content-type": "application/json" } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.end("{}");
    });
    assert.equal(forbidden, 403);
  });
});

test("the agents stream sends a snapshot", async () => {
  await withServer(async (base) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/agents/stream`, { signal: controller.signal });
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const reader = response.body.getReader();
    let text = "";
    while (!text.includes("\n\n")) text += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    assert.match(text, /^event: snapshot/);
    assert.ok(JSON.parse(text.split("data: ")[1]).sessions.some((entry) => entry.id === "claude:sess-1"));
  });
});
