// One-time import of progress from the hosted roadmap site. The site stores
// records as { revision, value }; the local plan stores flat records with
// updatedAt. Import never overwrites a record the user already has locally.
import { ensurePlanState } from "./state.js";

export function siteRecordToPlanRecord(key, entry, now) {
  const value = entry && typeof entry === "object" && "value" in entry ? entry.value : entry;
  if (!value || typeof value !== "object") return null;
  if (key === "settings" || key.startsWith("task:") || key.startsWith("custom:")) {
    const record = { ...value, importedFrom: "site", updatedAt: now };
    if (key.startsWith("task:") && record.done && !record.completedAt) record.completedAt = now;
    return record;
  }
  return null;
}

export function importSiteRecords(planState, siteExport = {}, now = new Date().toISOString(), { dryRun = false } = {}) {
  const plan = ensurePlanState(planState);
  const siteRecords = siteExport.records || siteExport;
  const added = [];
  const skipped = [];
  const ignored = [];
  for (const [key, entry] of Object.entries(siteRecords || {})) {
    const record = siteRecordToPlanRecord(key, entry, now);
    if (!record) {
      ignored.push(key);
      continue;
    }
    if (plan.records[key]) {
      skipped.push(key);
      continue;
    }
    plan.records[key] = record;
    added.push(key);
  }
  if (!plan.importedAt && (added.length || skipped.length)) {
    plan.importedAt = now;
    plan.importSource = siteExport.source || "roadmap-site";
  }
  const result = { added, skipped, ignored, importedAt: plan.importedAt };
  return { plan: dryRun ? ensurePlanState(planState) : plan, result };
}
