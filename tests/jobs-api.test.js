import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeConfigPaths } from "../server/platform.js";
import { startServer } from "../server.js";
import { createJobsInbox } from "../server/jobs/gmail.js";
import { applySignals } from "../server/jobs/signals.js";
import { ensurePlanState } from "../server/plan/state.js";
import { createCloudApp } from "../server/cloud/app.js";
import { createSession, SESSION_COOKIE } from "../server/cloud/auth.js";
import { MemoryStore } from "../server/cloud/store.js";
import { removeTempDir } from "./helpers.js";

const NOW = "2026-10-18T17:00:00.000Z";
const PASSWORD = "abcd efgh ijkl mnop";

const INBOX = [
  { messageId: "<li-1@linkedin.com>", date: "2026-10-01T16:00:00.000Z", from: "LinkedIn <jobs-noreply@linkedin.com>", subject: "Zach, your application was sent to Acme Robotics", text: "Your application was sent to Acme Robotics\n\nBackend Software Engineer\nAcme Robotics · Springfield, CA\n" },
  { messageId: "<gh-1@greenhouse>", date: "2026-10-02T16:00:00.000Z", from: "Fabrikam <no-reply@us.greenhouse-mail.io>", subject: "Thank you for applying to Fabrikam!", text: "Thanks for applying for the Software Engineer role at Fabrikam." },
  { messageId: "<hr-1@hackerrank>", date: "2026-10-05T16:00:00.000Z", from: "HackerRank <support@hackerrank.com>", subject: "Assessment for Acme Robotics", text: "Acme Robotics invited you to complete a coding challenge." },
  { messageId: "<rej-1@lever>", date: "2026-10-08T16:00:00.000Z", from: "Fabrikam <no-reply@hire.lever.co>", subject: "Your application to Fabrikam", text: "Unfortunately, we have decided to move forward with other candidates." },
  { messageId: "<int-1@unknown>", date: "2026-10-09T16:00:00.000Z", from: "Sam <sam@tailspin.dev>", subject: "Next steps with Tailspin", text: "We'd love to schedule a technical interview. Share your availability." },
  { messageId: "<news-1@runway>", date: "2026-10-09T16:00:00.000Z", from: "Runway <hello@tower.joinrunway.io>", subject: "Adatum just posted a role you'd be great for", text: "93% match" }
];

function memoryInbox(root, { messages = INBOX, sealed = true } = {}) {
  let plan = ensurePlanState({});
  const logins = [];
  const inbox = createJobsInbox({
    dataRoot: () => root,
    now: () => NOW,
    desktopActions: () => (sealed ? { encryptSecret: (text) => Buffer.from(`sealed:${text}`).toString("base64"), decryptSecret: (value) => Buffer.from(value, "base64").toString().slice(7) } : null),
    transport: async ({ email, password, query }) => {
      logins.push({ email, password, query });
      return query ? messages : [];
    },
    applySignals: async (signals, { preview }) => {
      const { plan: next, result } = applySignals(plan, signals, NOW);
      if (!preview) plan = next;
      return result;
    }
  });
  return { inbox, logins, plan: () => plan, setPlan: (next) => { plan = next; } };
}

test("the inbox connects, previews, then imports without duplicates", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-jobs-inbox-"));
  try {
    const { inbox, logins, plan } = memoryInbox(root);
    await assert.rejects(inbox.connect({ email: "me@gmail.com", password: "short" }), /16 letters/);
    await assert.rejects(inbox.scan(), /Connect your job Gmail/);
    const status = await inbox.connect({ email: "Me@Gmail.com", password: PASSWORD });
    assert.equal(status.configured, true);
    assert.equal(status.encrypted, true);
    assert.equal(logins[0].password, "abcdefghijklmnop", "spaces are removed before logging in");
    const saved = readFileSync(join(root, "config", "jobs-inbox.local.json"), "utf8");
    assert.ok(!saved.includes("abcdefghijklmnop"), "the App Password is not stored in plain text");
    assert.ok(!JSON.stringify(status).includes("abcdefghijklmnop"), "status never returns it");

    const preview = await inbox.scan({ preview: true });
    assert.equal(preview.preview, true);
    assert.equal(preview.created, 2, "LinkedIn and Greenhouse confirmations");
    assert.equal(plan().jobs.length, 0, "preview changes nothing");
    assert.equal((await inbox.status()).firstScanDone, false);
    assert.match(logins.at(-1).query, /^newer_than:120d /);

    const first = await inbox.scan();
    assert.deepEqual([first.created, first.updated, first.review], [2, 2, 1]);
    const acme = plan().jobs.find((job) => job.company === "Acme Robotics");
    assert.equal(acme.role, "Backend Software Engineer");
    assert.equal(acme.stage, "assessment");
    assert.equal(plan().jobs.find((job) => job.company === "Fabrikam").stage, "rejected");
    assert.equal(plan().jobInbox[0].company, "Tailspin", "an interview for an unknown job waits for review");
    assert.equal((await inbox.status()).firstScanDone, true);

    const second = await inbox.scan();
    assert.equal(second.signals, 0, "seen messages are skipped");
    assert.equal(plan().jobs.length, 2);
  } finally {
    await removeTempDir(root);
  }
});

test("a confirmation for a different role at the same company is a new application", () => {
  let plan = ensurePlanState({});
  const at = "2026-10-01T16:00:00.000Z";
  const signal = (messageId, kind, role) => ({ messageId, at, from: "LinkedIn <jobs-noreply@linkedin.com>", subject: "x", kind, company: "Litware", role, confidence: 0.95 });
  ({ plan } = applySignals(plan, [signal("<a>", "applied", "Early Career Software Engineer")], NOW));
  ({ plan } = applySignals(plan, [signal("<b>", "applied", "Software Engineer, New Grad")], NOW));
  assert.equal(plan.jobs.length, 2);
  ({ plan } = applySignals(plan, [signal("<c>", "applied", "Software Engineer New Grad")], NOW));
  assert.equal(plan.jobs.length, 2, "same role, different punctuation");
  const { result } = applySignals(plan, [signal("<d>", "rejected", "")], NOW);
  assert.equal(result.review.length, 1, "a rejection without a role can't pick between two Litware applications");
});

test("two desktops reading the same mail produce one record", async () => {
  const pcRoot = await mkdtemp(join(tmpdir(), "jarvis-jobs-pc-"));
  const macRoot = await mkdtemp(join(tmpdir(), "jarvis-jobs-mac-"));
  try {
    const pc = memoryInbox(pcRoot);
    await pc.inbox.connect({ email: "me@gmail.com", password: PASSWORD });
    await pc.inbox.scan();
    const mac = memoryInbox(macRoot, { sealed: false });
    mac.setPlan(pc.plan());
    await mac.inbox.connect({ email: "me@gmail.com", password: PASSWORD });
    assert.equal((await mac.inbox.status()).encrypted, false, "without the desktop keychain it says so");
    const result = await mac.inbox.scan();
    assert.deepEqual([result.created, result.updated, result.review], [0, 0, 0]);
    assert.deepEqual(mac.plan().jobs, pc.plan().jobs);
  } finally {
    await removeTempDir(pcRoot);
    await removeTempDir(macRoot);
  }
});

async function withServer(fn) {
  const previous = { shared: process.env.JARVIS_SHARED_DIR, now: process.env.JARVIS_PLAN_NOW, inbox: process.env.JARVIS_JOBS_FAKE_INBOX };
  const sharedDir = await mkdtemp(join(tmpdir(), "jarvis-jobs-api-"));
  const dataRoot = join(sharedDir, "app");
  await mkdir(join(dataRoot, "config"), { recursive: true });
  await mkdir(join(dataRoot, "data"), { recursive: true });
  const config = normalizeConfigPaths(JSON.parse(await readFile(join(process.cwd(), "config", "jarvis.config.json"), "utf8")), { baseDir: process.cwd() });
  await writeFile(join(dataRoot, "config", "jarvis.config.json"), JSON.stringify(config));
  await writeFile(join(dataRoot, "data", "job-board-cache.local.json"), `﻿${JSON.stringify({ jobs: [{ company: "Old Co", title: "Engineer", applied: true, appliedDate: "2026-07-20" }, { company: "Acme Robotics", title: "Backend Software Engineer", applied: true }] })}`);
  await writeFile(join(dataRoot, "data", "runway-cache.local.json"), JSON.stringify({ jobs: [{ company: "Runway Co", title: "SWE", applied: true }] }));
  const inboxFile = join(sharedDir, "inbox.json");
  await writeFile(inboxFile, JSON.stringify(INBOX));
  process.env.JARVIS_SHARED_DIR = sharedDir;
  process.env.JARVIS_PLAN_NOW = NOW;
  process.env.JARVIS_JOBS_FAKE_INBOX = inboxFile;
  const handle = await startServer({ host: "127.0.0.1", port: 0, dataRoot, cloudSync: false, jobsInbox: false });
  try {
    return await fn(`http://${handle.host}:${handle.port}`, { dataRoot });
  } finally {
    await new Promise((resolve) => handle.server.close(resolve));
    for (const [key, value] of [["JARVIS_SHARED_DIR", previous.shared], ["JARVIS_PLAN_NOW", previous.now], ["JARVIS_JOBS_FAKE_INBOX", previous.inbox]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeTempDir(sharedDir);
  }
}

const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const json = async (response) => {
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${body.error}`);
  return body;
};

test("desktop: add, edit, import old data, scan the inbox, review and prep", async () => {
  await withServer(async (base) => {
    let overview = await json(await fetch(`${base}/api/jobs`));
    assert.deepEqual(overview.jobs, []);
    assert.deepEqual(overview.legacy, { available: true, importedAt: null, count: 3 });
    assert.equal(overview.inbox.configured, false);
    assert.equal(overview.settings.weeklyTarget, 10);

    const imported = await json(await post(`${base}/api/jobs/import-legacy`, {}));
    assert.deepEqual([imported.added, imported.withoutDate], [3, 2]);
    assert.equal((await post(`${base}/api/jobs/import-legacy`, {})).status, 409, "only once");

    await json(await post(`${base}/api/jobs/inbox/connect`, { email: "me@gmail.com", password: PASSWORD }));
    const preview = await json(await post(`${base}/api/jobs/inbox/scan`, { preview: true }));
    assert.equal(preview.scan.preview, true);
    const scanned = await json(await post(`${base}/api/jobs/inbox/scan`, {}));
    assert.equal(scanned.scan.created, 1, "Fabrikam is new; Acme Robotics was imported");
    assert.equal(scanned.inbox.firstScanDone, true);

    overview = await json(await fetch(`${base}/api/jobs`));
    const acme = overview.jobs.find((job) => job.company === "Acme Robotics");
    assert.equal(acme.stage, "assessment");
    assert.ok(acme.events.some((event) => event.messageId === "<hr-1@hackerrank>"));
    assert.equal(overview.reviews.length, 1, "an interview from a company not in the pipeline waits for review");
    assert.equal(overview.reviews[0].company, "Tailspin");

    // Logged afterwards with the bookmark, then the review is assigned to it.
    const parsed = await json(await fetch(`${base}/api/jobs/parse-link?url=${encodeURIComponent("https://jobs.lever.co/tailspin/1")}&title=${encodeURIComponent("Tailspin - Platform Engineer")}`));
    assert.deepEqual([parsed.company, parsed.role, parsed.source], ["Tailspin", "Platform Engineer", "ats"]);
    const added = await json(await post(`${base}/api/jobs/upsert`, { company: parsed.company, role: parsed.role, url: parsed.url, source: "bookmark" }));
    assert.equal(added.created, true);

    const tailspin = added.job;

    await json(await post(`${base}/api/jobs/review`, { id: overview.reviews[0].id, action: "assign", jobId: tailspin.id }));
    overview = await json(await fetch(`${base}/api/jobs`));
    assert.equal(overview.jobs.find((job) => job.id === tailspin.id).stage, "interview");
    assert.equal(overview.reviews.length, 0);

    const prep = await json(await post(`${base}/api/jobs/prep-task`, { id: tailspin.id, date: "2026-10-19", minutes: 45 }));
    assert.match(prep.id, /^custom:/);
    const day = await json(await fetch(`${base}/api/plan/day?date=2026-10-19`));
    assert.ok(day.tasks.some((task) => task.title === "Prep: Tailspin Platform Engineer interview"));

    await json(await post(`${base}/api/jobs/settings`, { weeklyTarget: 15 }));
    await json(await post(`${base}/api/jobs/event`, { id: tailspin.id, kind: "note", note: "Ask about on-call" }));
    overview = await json(await fetch(`${base}/api/jobs`));
    assert.equal(overview.settings.weeklyTarget, 15);
    assert.equal(overview.metrics.byStage.interview, 1);

    const textPost = await fetch(`${base}/api/jobs/upsert`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    assert.equal(textPost.status, 415);
    await json(await post(`${base}/api/jobs/inbox/disconnect`, {}));
  });
});

test("cloud: the pipeline works from the phone, the inbox does not", async () => {
  const env = { APP_URL: "https://jarvis.example.com", GITHUB_CLIENT_ID: "cid", GITHUB_CLIENT_SECRET: "cs", SESSION_SECRET: "s".repeat(40), ALLOWED_GITHUB_ID: "42", TIME_ZONE: "America/Los_Angeles" };
  const app = createCloudApp({ store: new MemoryStore(), env, resourceRoot: process.cwd() });
  const server = createServer((req, res) => app.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(createSession({ id: 42, login: "zach" }, env.SESSION_SECRET))}`;
  const call = (path, body, origin = env.APP_URL) => fetch(`${base}${path}`, body === undefined ? { headers: { cookie } } : { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${base}/api/jobs`)).status, 401);
    const added = await json(await call("/api/jobs/upsert", { company: "Acme", role: "SWE", url: "https://www.linkedin.com/jobs/view/1/", source: "bookmark" }));
    assert.equal(added.created, true);
    const overview = await json(await call("/api/jobs"));
    assert.equal(overview.jobs.length, 1);
    assert.equal(overview.inbox, null);
    assert.equal(overview.legacy, null);
    assert.equal(overview.appUrl, env.APP_URL);
    assert.equal((await call("/api/jobs/inbox/scan", {})).status, 409);
    assert.equal((await call("/api/jobs/import-legacy", {})).status, 409);
    assert.equal((await call("/api/jobs/upsert", { company: "Evil" }, "https://evil.example.com")).status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the cloud bundle never loads the Gmail reader", () => {
  const sources = ["server/cloud/app.js", "server/jobs/routes.js", "server/jobs/signals.js", "server/jobs/model.js"].map((file) => readFileSync(file, "utf8"));
  assert.ok(sources.every((text) => !/jobs\/gmail|from "\.\/gmail\.js"|imapflow|mailparser/.test(text)));
  assert.ok(existsSync("server/jobs/gmail.js"));
});
