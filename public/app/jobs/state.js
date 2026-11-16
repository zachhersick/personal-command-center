// Job pipeline state for the Jobs page, the Today card and Settings.
import { signal, computed } from "@preact/signals";
import { get, post } from "../api.js";
import { reportError, toast } from "../store.js";

export const jobs = signal(null);
export const selectedJob = signal(null);
// Quick add: null when closed, otherwise the form's starting values.
export const addDraft = signal(null);

export const STAGE_LABELS = {
  saved: "Saved",
  applied: "Applied",
  assessment: "Assessment",
  screen: "Screen",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn"
};
export const BOARD_STAGES = ["applied", "assessment", "screen", "interview", "offer"];
export const SOURCE_LABELS = { linkedin: "LinkedIn", runway: "Runway", ats: "Job site", bookmark: "Bookmark", manual: "Added", import: "Old Jarvis", email: "Email" };
export const EVENT_LABELS = {
  applied: "Applied",
  viewed: "Viewed by the company",
  assessment: "Assessment",
  screen: "Recruiter screen",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  followed_up: "You followed up",
  note: "Note",
  stage: "Moved",
  imported: "Imported"
};

export const followUpIds = computed(() => new Set(jobs.value?.followUps || []));
export const openReviews = computed(() => jobs.value?.reviews || []);

export async function loadJobs() {
  try {
    jobs.value = await get("/api/jobs");
  } catch (error) {
    reportError(error);
  }
  return jobs.value;
}

export async function jobAction(path, body, message) {
  try {
    const result = await post(`/api/jobs/${path}`, body);
    await loadJobs();
    if (message) toast(typeof message === "function" ? message(result) : message);
    return result;
  } catch (error) {
    reportError(error);
    return null;
  }
}

export async function parseLink(url, title = "") {
  try {
    return await get(`/api/jobs/parse-link?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}`);
  } catch {
    return null;
  }
}

// "Log an application": open Quick add, prefilled from a link when given.
export async function openQuickAdd({ url = "", title = "" } = {}) {
  addDraft.value = { url, company: "", role: "", location: "", source: url ? "bookmark" : "manual", stage: "applied", loading: Boolean(url) };
  if (!url) return;
  const parsed = await parseLink(url, title);
  if (addDraft.value) addDraft.value = { ...addDraft.value, ...(parsed || {}), source: parsed?.source || "bookmark", loading: false };
}

// The "I applied" bookmark opens #jobs?add=1&url=…&title=…
export function takeBookmarkFromHash() {
  const [, query] = location.hash.split("?");
  if (!query) return false;
  const params = new URLSearchParams(query);
  if (params.get("add") !== "1") return false;
  history.replaceState(null, "", `${location.pathname}${location.search}#jobs`);
  openQuickAdd({ url: params.get("url") || "", title: params.get("title") || "" });
  return true;
}

export function gmailLink(messageId, email) {
  if (!messageId) return "";
  const account = email ? `?authuser=${encodeURIComponent(email)}` : "";
  return `https://mail.google.com/mail/u/${account}#search/rfc822msgid:${encodeURIComponent(messageId.replace(/^<|>$/g, ""))}`;
}

export function ago(iso) {
  if (!iso) return "";
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function shortWhen(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}
