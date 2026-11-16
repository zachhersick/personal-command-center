// One-time import of the job data the old Jarvis left in data/: the Google
// Sheets job board cache, Runway's Applied tab, and the old application
// records in runtime state. Pure: the caller reads the files.
import { jobId, normalizeCompany, normalizeRole } from "./model.js";

const OLD_STAGES = {
  applied: "applied",
  "online assessment": "assessment",
  assessment: "assessment",
  "phone screen": "screen",
  screen: "screen",
  "recruiter screen": "screen",
  interview: "interview",
  "technical interview": "interview",
  onsite: "interview",
  offer: "offer",
  rejected: "rejected",
  withdrawn: "withdrawn"
};

function stageFrom(value) {
  return OLD_STAGES[String(value || "").trim().toLowerCase()] || "applied";
}

function urlKey(value) {
  try {
    const url = new URL(String(value || ""));
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|ref|source|gh_src|lever-)/i.test(key)) url.searchParams.delete(key);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}${url.search}`.toLowerCase();
  } catch {
    return "";
  }
}

function isoDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T12:00:00.000Z`;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function earliest(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

const RANK = { applied: 1, assessment: 2, screen: 3, interview: 4, offer: 5, rejected: 6, withdrawn: 7 };

// Collect candidates from each file, then fold duplicates together by link,
// then by company + role.
export function legacyCandidates({ board, runway, runtime } = {}) {
  const rows = [];
  for (const job of board?.jobs || []) {
    if (!job?.applied || !job.company) continue;
    rows.push({ company: job.company, role: job.title || "", location: job.location || "", url: job.applicationUrl || job.link || "", appliedAt: isoDate(job.appliedDate), stage: "applied", source: "import", from: "job board" });
  }
  for (const job of runway?.jobs || []) {
    if (!job?.applied || !job.company) continue;
    rows.push({ company: job.company, role: job.title || "", location: job.location || "", url: job.applicationUrl || job.runwayUrl || "", appliedAt: isoDate(job.appliedDate), stage: "applied", source: "runway", from: "Runway" });
  }
  const progress = runtime?.jobProgress || {};
  for (const [id, record] of Object.entries(runtime?.jobApplications || {})) {
    const task = record?.task || {};
    if (!task.company) continue;
    const stage = progress[id]?.stage ? stageFrom(progress[id].stage) : record.appliedDate ? "applied" : null;
    if (!stage) continue;
    rows.push({ company: task.company, role: task.jobTitle || "", location: task.location || "", url: task.applicationUrl || task.link || "", appliedAt: isoDate(record.appliedDate), stage, source: "import", from: "old tracker" });
  }

  const byUrl = new Map();
  const byName = new Map();
  const merged = [];
  for (const row of rows) {
    const link = urlKey(row.url);
    const name = `${normalizeCompany(row.company)}|${normalizeRole(row.role)}`;
    const existing = (link && byUrl.get(link)) || byName.get(name);
    if (existing) {
      existing.appliedAt = earliest(existing.appliedAt, row.appliedAt);
      existing.location ||= row.location;
      existing.url ||= row.url;
      existing.role ||= row.role;
      if ((RANK[row.stage] || 0) > (RANK[existing.stage] || 0)) existing.stage = row.stage;
      if (!existing.from.includes(row.from)) existing.from.push(row.from);
      if (row.source === "runway") existing.source = "runway";
      if (link) byUrl.set(link, existing);
      byName.set(name, existing);
      continue;
    }
    const entry = { ...row, from: [row.from] };
    merged.push(entry);
    if (link) byUrl.set(link, entry);
    byName.set(name, entry);
  }
  return merged;
}

// Add imported jobs to the plan. Jobs already in the pipeline keep their data.
export function importLegacyJobs(plan, sources, now) {
  const candidates = legacyCandidates(sources);
  const jobs = [...(plan.jobs || [])];
  const known = new Set(jobs.filter((job) => !job.deleted).map((job) => job.id));
  const added = [];
  for (const row of candidates) {
    const id = jobId(row.company, row.role);
    if (known.has(id)) continue;
    known.add(id);
    const job = {
      id,
      company: row.company.slice(0, 120),
      role: row.role.slice(0, 200),
      location: row.location.slice(0, 200),
      url: /^https?:\/\//i.test(row.url) ? row.url.slice(0, 2000) : "",
      source: row.source,
      stage: row.stage,
      appliedAt: row.appliedAt,
      lastActivityAt: row.appliedAt,
      nextAction: "",
      nextActionDate: null,
      notes: "",
      events: [{ id: `imported:${id}`, at: row.appliedAt || now, kind: "imported", source: "import", note: `From the old Jarvis ${row.from.join(" and ")}` }],
      createdAt: now,
      updatedAt: now
    };
    jobs.push(job);
    added.push(job);
  }
  return { plan: { ...plan, jobs, legacyJobsImportedAt: plan.legacyJobsImportedAt || now }, result: { added: added.length, skipped: candidates.length - added.length, withoutDate: added.filter((job) => !job.appliedAt).length } };
}
