// Reads the job-hunting Gmail over IMAP with an App Password. Desktop only:
// the cloud never imports this file. The mailbox is opened read-only, so
// nothing is marked read, moved or changed. Only sender, subject, date and
// Message-ID leave this file; bodies are classified here and dropped.
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { readJsonWithBackup, safeWriteJson } from "../shared-state.js";
import { classifyMail, gmailSearchQuery, parseAddress, ATS_DOMAINS } from "./mail-rules.js";

const FIRST_SCAN_DAYS = 120;
const SCAN_EVERY_MS = 15 * 60_000;
const MAX_MESSAGES = 400;
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_SEEN = 5000;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function cleanAppPassword(value) {
  return String(value || "").replace(/\s+/g, "");
}

// Default transport: imapflow + mailparser, loaded only when a scan runs.
export async function fetchGmail({ email, password, query, limit = MAX_MESSAGES }) {
  const { ImapFlow } = await import("imapflow");
  const { simpleParser } = await import("mailparser");
  const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user: email, pass: password }, logger: false, connectionTimeout: 20_000 });
  try {
    await client.connect();
  } catch (error) {
    throw fail(401, /auth|credentials|login/i.test(`${error.message} ${error.responseText || ""}`) ? "Gmail didn't accept that address and App Password." : `Couldn't reach Gmail: ${error.message}`);
  }
  const messages = [];
  try {
    const boxes = await client.list();
    const allMail = boxes.find((box) => box.specialUse === "\\All")?.path || "[Gmail]/All Mail";
    const lock = await client.getMailboxLock(allMail, { readOnly: true });
    try {
      if (!query) return messages;
      const uids = (await client.search({ gmraw: query }, { uid: true })) || [];
      const wanted = uids.slice(-limit);
      if (!wanted.length) return messages;
      for await (const message of client.fetch(wanted, { uid: true, internalDate: true, source: { start: 0, maxLength: MAX_SOURCE_BYTES } }, { uid: true })) {
        try {
          const parsed = await simpleParser(message.source, { skipHtmlToText: false, skipImageLinks: true, skipTextLinks: true });
          messages.push({
            messageId: parsed.messageId || `uid:${message.uid}@${email}`,
            from: parsed.from?.text || "",
            subject: parsed.subject || "",
            text: (parsed.text || "").slice(0, 20_000),
            date: (parsed.date || message.internalDate || new Date()).toISOString()
          });
        } catch {
          // A message that won't parse is skipped; the next scan won't retry it.
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return messages;
}

// Local test transport: JARVIS_JOBS_FAKE_INBOX points at a JSON list of messages.
export function fakeTransport(path) {
  return async () => {
    const list = await readJsonWithBackup(path, []);
    return (Array.isArray(list) ? list : []).map((message, index) => ({ messageId: message.messageId || `<fake-${index}@jarvis>`, date: message.date || new Date().toISOString(), ...message }));
  };
}

export function toSignal(message) {
  const verdict = classifyMail(message);
  const sender = parseAddress(message.from);
  return {
    messageId: message.messageId,
    at: message.date,
    from: message.from,
    subject: message.subject,
    ats: ATS_DOMAINS.some((domain) => sender.domain === domain || sender.domain.endsWith(`.${domain}`)),
    ...verdict
  };
}

export function createJobsInbox({ dataRoot, desktopActions = () => null, transport, now = () => new Date().toISOString(), applySignals, env = process.env }) {
  const settingsFile = () => join(dataRoot(), "config", "jobs-inbox.local.json");
  const scanFile = () => join(dataRoot(), "data", "jobs-scan.local.json");
  const fetchMessages = (options) => (transport || (env.JARVIS_JOBS_FAKE_INBOX ? fakeTransport(env.JARVIS_JOBS_FAKE_INBOX) : fetchGmail))(options);
  let timer = null;
  let scanning = false;
  let lastResult = null;

  async function readSettings() {
    return readJsonWithBackup(settingsFile(), null);
  }

  async function readScan() {
    return readJsonWithBackup(scanFile(), { lastScanAt: null, lastError: "", firstScanDone: false, seen: [] });
  }

  // App Passwords are encrypted with the OS keychain (Electron safeStorage)
  // when the desktop app provides it.
  function sealPassword(password) {
    const actions = desktopActions();
    if (actions?.encryptSecret) {
      const sealed = actions.encryptSecret(password);
      if (sealed) return { encrypted: true, value: sealed };
    }
    return { encrypted: false, value: password };
  }

  function openPassword(stored) {
    if (!stored) return "";
    if (!stored.encrypted) return stored.value;
    const actions = desktopActions();
    if (!actions?.decryptSecret) throw fail(409, "The saved App Password can only be read by the Jarvis desktop app.");
    return actions.decryptSecret(stored.value);
  }

  async function credentials() {
    const settings = await readSettings();
    if (!settings?.email) throw fail(409, "Connect your job Gmail in Settings first.");
    return { email: settings.email, password: openPassword(settings.password) };
  }

  async function status() {
    const settings = await readSettings();
    const scan = await readScan();
    return {
      configured: Boolean(settings?.email),
      email: settings?.email || "",
      encrypted: Boolean(settings?.password?.encrypted),
      connectedAt: settings?.connectedAt || null,
      firstScanDone: Boolean(scan.firstScanDone),
      lastScanAt: scan.lastScanAt,
      lastError: scan.lastError || "",
      scanning,
      lastResult
    };
  }

  async function connect({ email, password } = {}) {
    const address = String(email || "").trim().toLowerCase();
    const secret = cleanAppPassword(password);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw fail(400, "Enter the Gmail address you use for job applications.");
    if (!/^[a-z]{16}$/i.test(secret)) throw fail(400, "An App Password is 16 letters (spaces are fine). Create one at myaccount.google.com/apppasswords.");
    // Log in once (no search) so a typo fails here, not on the first scan.
    await fetchMessages({ email: address, password: secret, query: null, limit: 0 });
    await safeWriteJson(settingsFile(), { email: address, password: sealPassword(secret), connectedAt: now() });
    return status();
  }

  async function disconnect() {
    for (const file of [settingsFile(), scanFile()]) if (existsSync(file)) await rm(file, { force: true });
    lastResult = null;
    return status();
  }

  // preview: classify and report without changing anything.
  async function scan({ preview = false, days } = {}) {
    if (scanning) throw fail(409, "A scan is already running.");
    scanning = true;
    const scanState = await readScan();
    try {
      const { email, password } = await credentials();
      const sinceDays = days || (scanState.firstScanDone && scanState.lastScanAt ? Math.ceil((Date.parse(now()) - Date.parse(scanState.lastScanAt)) / 86_400_000) + 2 : FIRST_SCAN_DAYS);
      const messages = await fetchMessages({ email, password, query: gmailSearchQuery(Math.min(sinceDays, 365)), limit: MAX_MESSAGES });
      const seen = new Set(scanState.seen || []);
      const fresh = messages.filter((message) => !seen.has(message.messageId));
      const signals = fresh.map(toSignal).filter((signal) => signal.kind || (signal.confidence >= 0.3 && signal.company));
      const outcome = await applySignals(signals, { preview });
      lastResult = { at: now(), preview, messages: messages.length, signals: signals.length, ...summarize(outcome) };
      if (!preview) {
        const nextSeen = [...seen, ...fresh.map((message) => message.messageId)].slice(-MAX_SEEN);
        await safeWriteJson(scanFile(), { lastScanAt: now(), lastError: "", firstScanDone: true, seen: nextSeen });
      }
      return { ...lastResult, details: outcome };
    } catch (error) {
      if (!preview) await safeWriteJson(scanFile(), { ...scanState, lastError: error.message, lastAttemptAt: now() });
      throw error;
    } finally {
      scanning = false;
    }
  }

  function start() {
    stop();
    timer = setInterval(async () => {
      const current = await status().catch(() => null);
      if (!current?.configured || !current.firstScanDone || scanning) return;
      await scan().catch((error) => console.error("Job inbox scan:", error.message));
    }, SCAN_EVERY_MS);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { status, connect, disconnect, scan, start, stop };
}

function summarize(outcome = {}) {
  return { created: outcome.created?.length || 0, updated: outcome.updated?.length || 0, review: outcome.review?.length || 0, skipped: outcome.skipped || 0 };
}
