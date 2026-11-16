import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { checkOAuthState, createSession, hashToken, newDeviceToken, newOAuthState, parseCookies, readSession, sign } from "../server/cloud/auth.js";
import { cloudConfig, createCloudApp, savePlanDoc } from "../server/cloud/app.js";
import { MemoryStore } from "../server/cloud/store.js";

const SECRET = "s".repeat(40);
const ENV = { APP_URL: "https://jarvis.example.com", GITHUB_CLIENT_ID: "cid", GITHUB_CLIENT_SECRET: "csecret", SESSION_SECRET: SECRET, ALLOWED_GITHUB_ID: "42", TIME_ZONE: "America/Los_Angeles" };

test("sessions are signed, expire, and reject tampering", () => {
  const token = createSession({ id: 42, login: "zach" }, SECRET, 1_000);
  assert.equal(readSession(token, SECRET, 2_000).sub, "42");
  assert.equal(readSession(token, "x".repeat(40), 2_000), null, "wrong secret");
  const [payload] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ sub: "42", login: "zach", exp: 9e15 })).toString("base64url");
  assert.equal(readSession(`${forged}.${token.split(".")[1]}`, SECRET), null, "payload swapped");
  assert.equal(readSession(`${payload}.${sign(payload, SECRET)}`, SECRET, 40 * 86_400_000), null, "expired");
  assert.equal(readSession("garbage", SECRET), null);
});

test("OAuth state and device tokens", () => {
  const state = newOAuthState(SECRET);
  assert.equal(checkOAuthState(state.cookieValue, state.nonce, SECRET), true);
  assert.equal(checkOAuthState(state.cookieValue, "other", SECRET), false);
  assert.equal(checkOAuthState("", state.nonce, SECRET), false);
  const token = newDeviceToken();
  assert.match(token, /^jvs_[A-Za-z0-9_-]{40,}$/);
  assert.equal(hashToken(token).length, 64);
  assert.notEqual(hashToken(token), token);
  assert.deepEqual(parseCookies("a=1; jarvis_session=x%3Dy"), { a: "1", jarvis_session: "x=y" });
});

test("cloud config refuses to run half-configured or with dev login on Vercel", () => {
  assert.deepEqual(cloudConfig({}).missing.sort(), ["allowedGithubId", "appUrl", "clientId", "clientSecret", "sessionSecret"]);
  assert.ok(cloudConfig({ ...ENV, SESSION_SECRET: "short" }).missing.includes("sessionSecret (32+ characters)"));
  assert.equal(cloudConfig({ ...ENV, JARVIS_CLOUD_DEV_LOGIN: "1", VERCEL: "1" }).devLogin, false);
  // A real address, a production build or a real database never gets the
  // shortcut, even if the variable leaks into that environment.
  assert.equal(cloudConfig({ ...ENV, JARVIS_CLOUD_DEV_LOGIN: "1" }).devLogin, false);
  const local = { ...ENV, APP_URL: "http://localhost:4320", JARVIS_CLOUD_DEV_LOGIN: "1" };
  assert.equal(cloudConfig(local).devLogin, true);
  assert.equal(cloudConfig({ ...local, NODE_ENV: "production" }).devLogin, false);
  assert.equal(cloudConfig({ ...local, DATABASE_URL: "postgres://db.example/jarvis" }).devLogin, false);
  assert.equal(cloudConfig({ ...local, APP_URL: "http://localhost.evil.example" }).devLogin, false);
});

async function withCloud(fn, { env = ENV, githubId = 42, store = new MemoryStore() } = {}) {
  const fetchImpl = async (url) => {
    if (String(url).includes("access_token")) return { json: async () => ({ access_token: "gho_test" }) };
    return { ok: true, json: async () => ({ id: githubId, login: "zach", avatar_url: "" }) };
  };
  const app = createCloudApp({ store, env, fetchImpl, resourceRoot: process.cwd() });
  const server = createServer((req, res) => app.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({ base, store });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const call = (base, path, { method = "GET", body, cookie = "", origin = ENV.APP_URL, token } = {}) => fetch(`${base}${path}`, {
  method,
  redirect: "manual",
  headers: {
    ...(body !== undefined ? { "content-type": "application/json" } : {}),
    ...(cookie ? { cookie } : {}),
    ...(origin ? { origin } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {})
  },
  body: body !== undefined ? JSON.stringify(body) : undefined
});

async function signIn(base) {
  const login = await call(base, "/api/auth/login");
  assert.equal(login.status, 302);
  assert.match(login.headers.get("location"), /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  const stateCookie = login.headers.get("set-cookie").split(";")[0];
  const state = new URL(login.headers.get("location")).searchParams.get("state");
  const callback = await call(base, `/api/auth/callback?code=abc&state=${state}`, { cookie: stateCookie });
  return { callback, cookie: (callback.headers.get("set-cookie") || "").split(/,(?=\s*jarvis_)/)[0].split(";")[0] };
}

test("only the allowed GitHub account can sign in", async () => {
  await withCloud(async ({ base }) => {
    assert.equal((await call(base, "/api/session")).status, 401);
    assert.equal((await call(base, "/api/plan/meta")).status, 401);
    const { callback, cookie } = await signIn(base);
    assert.equal(callback.headers.get("location"), "/");
    assert.match(cookie, /^jarvis_session=/);
    const session = await (await call(base, "/api/session", { cookie })).json();
    assert.deepEqual(session, { ok: true, mode: "web", user: { login: "zach" } });
    // A forged state is rejected.
    const forged = await call(base, "/api/auth/callback?code=abc&state=nope", { cookie: "jarvis_oauth_state=abc.def" });
    assert.equal(forged.headers.get("location"), "/?signin=expired");
  });
  await withCloud(async ({ base }) => {
    const { callback } = await signIn(base);
    assert.equal(callback.headers.get("location"), "/?signin=denied");
  }, { githubId: 7 });
});

test("signed-in web use: plan reads and same-origin writes", async () => {
  await withCloud(async ({ base }) => {
    const { cookie } = await signIn(base);
    const meta = await (await call(base, "/api/plan/meta", { cookie })).json();
    assert.equal(meta.weeks.length, 34);
    const patch = await call(base, "/api/plan/tasks/patch", { method: "POST", cookie, body: { id: "w1-study0", done: true } });
    assert.equal(patch.status, 200);
    const detail = await (await call(base, "/api/plan/task?id=w1-study0", { cookie })).json();
    assert.equal(detail.task.done, true);
    assert.equal((await call(base, "/api/plan/tasks/patch", { method: "POST", cookie, origin: "https://evil.example", body: { id: "w1-study0", done: false } })).status, 403);
    assert.equal((await call(base, "/api/plan/tasks/patch", { method: "POST", cookie, origin: "", body: { id: "w1-study0", done: false } })).status, 403);
    assert.equal((await call(base, "/api/focus/window", { method: "POST", cookie, body: { on: true } })).status, 409);
  });
});

test("desktops sync with a device token, and revoked tokens stop working", async () => {
  await withCloud(async ({ base }) => {
    const { cookie } = await signIn(base);
    const created = await (await call(base, "/api/devices", { method: "POST", cookie, body: { name: "PC" } })).json();
    assert.match(created.token, /^jvs_/);
    const listed = await (await call(base, "/api/devices", { cookie })).json();
    assert.deepEqual(listed.devices.map((device) => device.name), ["PC"]);
    assert.equal(JSON.stringify(listed).includes(created.token), false, "token is never listed");

    // Desktop pushes a record; the web sees it.
    const desktopPlan = { records: { "task:w2-code0": { done: true, updatedAt: "2026-10-20T10:00:00.000Z" } }, focusSessions: [], neetcodeLog: [] };
    const synced = await (await call(base, "/api/sync", { method: "POST", token: created.token, origin: "", body: { plan: desktopPlan, agentsBoard: { counts: { working: 1 }, sessions: [] } } })).json();
    assert.equal(synced.plan.records["task:w2-code0"].done, true);
    assert.equal((await (await call(base, "/api/plan/task?id=w2-code0", { cookie })).json()).task.done, true);
    const board = await (await call(base, "/api/agents/board", { cookie })).json();
    assert.equal(board.board.device, "PC");

    // The web changes something; the next desktop sync gets it back.
    await call(base, "/api/plan/tasks/patch", { method: "POST", cookie, body: { id: "w2-code1", done: true } });
    const next = await (await call(base, "/api/sync", { method: "POST", token: created.token, origin: "", body: { plan: desktopPlan } })).json();
    assert.equal(next.plan.records["task:w2-code1"].done, true);
    assert.equal(next.plan.records["task:w2-code0"].done, true);

    assert.equal((await call(base, "/api/devices/revoke", { method: "POST", cookie, body: { id: created.device.id } })).status, 200);
    assert.equal((await call(base, "/api/sync", { method: "POST", token: created.token, origin: "", body: { plan: desktopPlan } })).status, 401);
    assert.equal((await call(base, "/api/sync", { method: "POST", token: "jvs_wrong", origin: "", body: {} })).status, 401);
  });
});

test("concurrent saves retry and keep both changes", async () => {
  const store = new MemoryStore();
  await savePlanDoc(store, { records: { "task:a": { done: true, updatedAt: "2026-10-20T10:00:00.000Z" } } });
  // Simulate another device writing between our read and write.
  const realPut = store.putDoc.bind(store);
  let raced = false;
  store.putDoc = async (id, doc, version) => {
    if (!raced) {
      raced = true;
      await realPut(id, { ...(await store.getDoc("plan")).doc, records: { ...(await store.getDoc("plan")).doc.records, "task:b": { done: true, updatedAt: "2026-10-20T11:00:00.000Z" } } }, version);
    }
    return realPut(id, doc, version);
  };
  const merged = await savePlanDoc(store, { records: { "task:c": { done: true, updatedAt: "2026-10-20T12:00:00.000Z" } } });
  assert.deepEqual(Object.keys(merged.records).sort(), ["task:a", "task:b", "task:c"]);
});

test("a misconfigured deployment says what's missing", async () => {
  await withCloud(async ({ base }) => {
    const response = await call(base, "/api/session");
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /APP_URL|appUrl/);
  }, { env: {} });
});

test("the phone's agent commands reach only a desktop that accepts them, once, and expire", async () => {
  await withCloud(async ({ base }) => {
    const { cookie } = await signIn(base);
    const made = await (await call(base, "/api/devices", { method: "POST", body: { name: "PC" }, cookie })).json();
    const other = await (await call(base, "/api/devices", { method: "POST", body: { name: "Laptop" }, cookie })).json();
    const start = { type: "start", projectId: "jarvis", provider: "claude", prompt: "Explain server.js", mode: "plan" };
    const sync = (token, body) => call(base, "/api/sync", { method: "POST", body, token, origin: "" }).then((response) => response.json());

    assert.equal((await call(base, "/api/agents/commands", { method: "POST", body: start })).status, 401, "no session");
    assert.equal((await call(base, "/api/agents/commands", { method: "POST", body: start, cookie, origin: "https://evil.example" })).status, 403, "wrong origin");
    // No desktop has said it takes commands yet.
    assert.equal((await call(base, "/api/agents/commands", { method: "POST", body: start, cookie })).status, 409);
    await sync(made.token, { agentsBoard: { sessions: [], remote: { enabled: false } } });
    assert.equal((await call(base, "/api/agents/commands", { method: "POST", body: start, cookie })).status, 409, "a desktop with phone control off");

    await sync(made.token, { agentsBoard: { sessions: [], remote: { enabled: true, projects: [] } } });
    for (const bad of [{ ...start, type: "keep" }, { ...start, prompt: " " }, { ...start, projectId: "../x" }, { ...start, provider: "gpt" }, { type: "stop", runId: "not-a-run" }]) {
      assert.equal((await call(base, "/api/agents/commands", { method: "POST", body: bad, cookie })).status, 400, JSON.stringify(bad));
    }
    const sent = await (await call(base, "/api/agents/commands", { method: "POST", body: start, cookie })).json();
    assert.equal(sent.command.status, "pending");

    // Another desktop, or one not accepting, gets nothing.
    assert.equal((await sync(other.token, { acceptAgentCommands: true })).agentCommands.length, 0);
    assert.equal((await sync(made.token, { agentsBoard: { sessions: [], remote: { enabled: true } } })).agentCommands, undefined, "a push that does not ask for commands gets none");
    const claimed = (await sync(made.token, { acceptAgentCommands: true })).agentCommands;
    assert.deepEqual(claimed.map((command) => [command.id, command.prompt]), [[sent.command.id, "Explain server.js"]]);
    assert.equal((await sync(made.token, { acceptAgentCommands: true })).agentCommands.length, 0, "handed out once");

    const runId = "11111111-2222-3333-4444-555555555555";
    await sync(made.token, { acceptAgentCommands: true, agentResults: [{ id: sent.command.id, ok: true, runId, queued: true }] });
    let list = (await (await call(base, "/api/agents/commands", { cookie })).json()).commands;
    assert.deepEqual([list[0].status, list[0].runId, list[0].queued], ["done", runId, true]);
    assert.equal(list[0].prompt, undefined, "the list carries a preview, not the prompt");

    const failing = await (await call(base, "/api/agents/commands", { method: "POST", body: { type: "stop", runId }, cookie })).json();
    const [stop] = (await sync(made.token, { acceptAgentCommands: true })).agentCommands;
    await sync(made.token, { agentResults: [{ id: stop.id, ok: false, error: "Run not found." }] });
    list = (await (await call(base, "/api/agents/commands", { cookie })).json()).commands;
    assert.deepEqual([list[0].id, list[0].status, list[0].error], [failing.command.id, "failed", "Run not found."]);
  });
});

test("unanswered agent commands fail with a reason instead of hanging", async () => {
  const { settle, PENDING_MS, CLAIMED_MS } = await import("../server/cloud/agent-commands.js");
  const now = Date.parse("2026-10-25T12:00:00Z");
  const at = (ms) => new Date(now - ms).toISOString();
  const [stale, lost, fresh] = settle([
    { id: "a", status: "pending", createdAt: at(PENDING_MS + 1000) },
    { id: "b", status: "claimed", createdAt: at(60_000), claimedAt: at(CLAIMED_MS + 1000) },
    { id: "c", status: "pending", createdAt: at(1000) }
  ], now);
  assert.equal(stale.status, "failed");
  assert.match(stale.error, /didn't pick this up/);
  assert.equal(lost.status, "failed");
  assert.match(lost.error, /didn't confirm/);
  assert.equal(fresh.status, "pending");
});
