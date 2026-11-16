// Applies classified emails ("signals") to the pipeline. Confident signals that
// match one job update it; everything else becomes a review item the user can
// accept, assign to a job, or ignore from any device.
import { createHash } from "node:crypto";
import { addEvent, advanceStage, jobId, liveJobs, normalizeCompany, normalizeRole, STAGES } from "./model.js";
import { AUTO_APPLY_CONFIDENCE } from "./mail-rules.js";

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const shortHash = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
export const reviewId = (messageId) => `review:${shortHash(messageId)}`;
const mailEventId = (messageId) => `mail:${shortHash(messageId)}`;

const STAGE_FOR_KIND = { applied: "applied", assessment: "assessment", screen: "screen", interview: "interview", offer: "offer", rejected: "rejected" };

function sourceFor(signal) {
  return /linkedin\.com/i.test(signal.from || "") ? "linkedin" : signal.ats ? "ats" : "email";
}

function seenMessage(plan, messageId) {
  if (!messageId) return false;
  if ((plan.jobInbox || []).some((item) => item.messageId === messageId)) return true;
  return liveJobs(plan).some((job) => (job.events || []).some((event) => event.messageId === messageId));
}

function similarRoles(a, b) {
  const x = normalizeRole(a);
  const y = normalizeRole(b);
  if (!x || !y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  const words = (text) => new Set(text.split(" ").filter((word) => word.length > 2));
  const left = words(x);
  const right = words(y);
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / Math.max(left.size, right.size, 1) >= 0.75;
}

// The jobs a signal could be about: an exact company + role match first, then
// open jobs at the same company.
export function matchJobs(plan, { company, role }) {
  const jobs = liveJobs(plan);
  if (!company) return [];
  if (role) {
    const exact = jobs.find((job) => job.id === jobId(company, role));
    if (exact) return [exact];
  }
  const target = normalizeCompany(company);
  const sameCompany = jobs.filter((job) => normalizeCompany(job.company) === target);
  if (role && sameCompany.length > 1) {
    const wanted = normalizeRole(role);
    const close = sameCompany.filter((job) => normalizeRole(job.role).includes(wanted) || wanted.includes(normalizeRole(job.role)));
    if (close.length) return close;
  }
  return sameCompany;
}

function applyToJob(job, signal, now) {
  const kind = signal.kind;
  let next = addEvent(job, { id: mailEventId(signal.messageId), at: signal.at, kind: kind || "note", source: "email", subject: String(signal.subject || "").slice(0, 300), messageId: signal.messageId });
  if (STAGE_FOR_KIND[kind]) next = { ...next, stage: advanceStage(job.stage, STAGE_FOR_KIND[kind]) };
  if (kind === "applied" && (!job.appliedAt || Date.parse(signal.at) < Date.parse(job.appliedAt))) next.appliedAt = signal.at;
  if (!job.lastActivityAt || Date.parse(signal.at) > Date.parse(job.lastActivityAt)) next.lastActivityAt = signal.at;
  if (!job.role && signal.role) next.role = signal.role;
  return { ...next, updatedAt: now };
}

function newJobFromSignal(signal, now) {
  const stage = STAGE_FOR_KIND[signal.kind] || "applied";
  const job = {
    id: jobId(signal.company, signal.role),
    company: String(signal.company).slice(0, 120),
    role: String(signal.role || "").slice(0, 200),
    location: "",
    url: "",
    source: sourceFor(signal),
    stage,
    appliedAt: signal.kind === "applied" ? signal.at : null,
    lastActivityAt: signal.at,
    nextAction: "",
    nextActionDate: null,
    notes: "",
    events: [],
    createdAt: now,
    updatedAt: now
  };
  return applyToJob(job, signal, now);
}

function reviewItem(signal, why, candidates, now) {
  return {
    id: reviewId(signal.messageId),
    messageId: signal.messageId,
    at: signal.at,
    from: String(signal.from || "").slice(0, 200),
    subject: String(signal.subject || "").slice(0, 300),
    kind: signal.kind || null,
    company: signal.company || "",
    role: signal.role || "",
    confidence: signal.confidence,
    why,
    candidates: candidates.map((job) => job.id).slice(0, 10),
    status: "open",
    updatedAt: now
  };
}

function upsert(list, item) {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index < 0) return [item, ...list];
  const next = [...list];
  next[index] = item;
  return next;
}

// Decide what one signal does: { action: "update" | "create" | "review" | "skip", ... }.
export function planSignal(plan, signal) {
  if (!signal?.messageId || seenMessage(plan, signal.messageId)) return { action: "skip", why: "already seen" };
  if (!signal.kind && !(signal.confidence >= 0.3 && signal.company)) return { action: "skip", why: "not about an application" };
  const candidates = matchJobs(plan, signal);
  if (!signal.kind) return { action: "review", why: "Couldn't tell what this email means", candidates };
  if (!signal.company) return { action: "review", why: "Couldn't tell which company sent this", candidates };
  if (signal.confidence < AUTO_APPLY_CONFIDENCE) return { action: "review", why: "Not sure this is about an application", candidates };
  // A confirmation for a different role at the same company is a new application.
  if (signal.kind === "applied" && signal.role && candidates.length === 1 && candidates[0].role && !similarRoles(candidates[0].role, signal.role)) return { action: "create" };
  if (candidates.length === 1) return { action: "update", job: candidates[0] };
  if (candidates.length > 1 && !(signal.kind === "applied" && signal.role)) return { action: "review", why: `You have ${candidates.length} applications at ${signal.company}`, candidates };
  if (signal.kind === "applied") return { action: "create" };
  return { action: "review", why: `No application to ${signal.company} in your pipeline yet`, candidates };
}

export function applySignals(plan, signals, now) {
  let next = { ...plan, jobs: [...(plan.jobs || [])], jobInbox: [...(plan.jobInbox || [])] };
  const result = { created: [], updated: [], review: [], skipped: 0 };
  for (const signal of [...signals].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const decision = planSignal(next, signal);
    if (decision.action === "skip") {
      result.skipped += 1;
    } else if (decision.action === "update") {
      const job = applyToJob(decision.job, signal, now);
      next.jobs = next.jobs.map((entry) => (entry.id === job.id ? job : entry));
      result.updated.push({ id: job.id, company: job.company, role: job.role, kind: signal.kind, stage: job.stage, subject: signal.subject });
    } else if (decision.action === "create") {
      const job = newJobFromSignal(signal, now);
      next.jobs = [job, ...next.jobs.filter((entry) => entry.id !== job.id)];
      result.created.push({ id: job.id, company: job.company, role: job.role, kind: signal.kind, stage: job.stage, subject: signal.subject });
    } else {
      const item = reviewItem(signal, decision.why, decision.candidates, now);
      next.jobInbox = upsert(next.jobInbox, item);
      result.review.push({ id: item.id, company: item.company, kind: item.kind, subject: item.subject, why: item.why });
    }
  }
  return { plan: next, result };
}

// Resolve a review item. accept: create or update by the (possibly edited)
// company and role; assign: apply to a chosen job; ignore: dismiss.
export function resolveReview(plan, input = {}, now) {
  const item = (plan.jobInbox || []).find((entry) => entry.id === input.id);
  if (!item) throw fail(404, "Review item not found.");
  if (item.status !== "open") throw fail(409, "That item was already handled.");
  const action = input.action;
  if (!["accept", "assign", "ignore"].includes(action)) throw fail(400, "action must be accept, assign or ignore.");
  const kind = input.kind ?? item.kind ?? "applied";
  if (kind && !STAGES.includes(kind) && kind !== "viewed" && kind !== "note") throw fail(400, "Unknown kind.");
  const closed = { ...item, status: action === "ignore" ? "ignored" : "resolved", updatedAt: now };
  let next = { ...plan, jobInbox: plan.jobInbox.map((entry) => (entry.id === item.id ? closed : entry)) };
  if (action === "ignore") return { plan: next, result: { id: item.id } };

  const signal = { messageId: item.messageId, at: item.at, from: item.from, subject: item.subject, kind, company: String(input.company ?? item.company).trim(), role: String(input.role ?? item.role).trim(), confidence: 1 };
  if (action === "assign") {
    const job = liveJobs(next).find((entry) => entry.id === input.jobId);
    if (!job) throw fail(404, "Job not found.");
    const updated = applyToJob(job, signal, now);
    next = { ...next, jobs: next.jobs.map((entry) => (entry.id === job.id ? updated : entry)) };
    return { plan: next, result: { id: item.id, jobId: job.id } };
  }
  if (!signal.company) throw fail(400, "Add the company first.");
  const existing = liveJobs(next).find((entry) => entry.id === jobId(signal.company, signal.role));
  const job = existing ? applyToJob(existing, signal, now) : newJobFromSignal(signal, now);
  next = { ...next, jobs: [job, ...next.jobs.filter((entry) => entry.id !== job.id)] };
  return { plan: next, result: { id: item.id, jobId: job.id } };
}

export function openReviews(plan) {
  return (plan.jobInbox || []).filter((item) => item.status === "open").sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
