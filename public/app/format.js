// Pure formatting helpers and category metadata. No DOM access.

export const CATEGORY_META = {
  Study: { key: "study", label: "Study", short: "Study" },
  Build: { key: "build", label: "Build", short: "Build" },
  NeetCode: { key: "neetcode", label: "NeetCode", short: "Code" },
  Applications: { key: "applications", label: "Applications", short: "Apply" },
  Interview: { key: "interview", label: "Interview prep", short: "Interview" },
  Behavioral: { key: "behavioral", label: "Behavioral", short: "Behavioral" },
  Review: { key: "review", label: "Review", short: "Review" },
  Capstone: { key: "capstone", label: "Capstone", short: "Capstone" },
  PaidWork: { key: "paidwork", label: "PaidWork", short: "Paid" },
  Homework: { key: "homework", label: "Homework", short: "Homework" },
  Personal: { key: "personal", label: "Personal", short: "Personal" }
};

export const CATEGORY_ORDER = Object.keys(CATEGORY_META);

export function categoryKey(category) {
  return CATEGORY_META[category]?.key || "personal";
}

export function categoryColor(category) {
  return `var(--cat-${categoryKey(category)})`;
}

export function formatMinutes(minutes) {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  if (value < 60) return `${value}m`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function formatSeconds(seconds) {
  return formatMinutes(Math.round((Number(seconds) || 0) / 60));
}

export function clock(minutes) {
  const value = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const hour = Math.floor(value / 60);
  return `${hour % 12 || 12}:${String(value % 60).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

export function shortClock(minutes) {
  const value = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const hour = Math.floor(value / 60);
  const mins = value % 60;
  return `${hour % 12 || 12}${mins ? `:${String(mins).padStart(2, "0")}` : ""}${hour < 12 ? "a" : "p"}`;
}

export function timer(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const mins = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  const mm = String(mins).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

const dateAt = (key) => new Date(`${key}T12:00:00Z`);

export function addDays(key, days) {
  const date = dateAt(key);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function daysBetween(later, earlier) {
  return Math.round((dateAt(later) - dateAt(earlier)) / 86_400_000);
}

export function weekStart(key) {
  return addDays(key, -((dateAt(key).getUTCDay() + 6) % 7));
}

export function formatDate(key, options = { weekday: "long", month: "long", day: "numeric" }) {
  if (!key) return "";
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(dateAt(key));
}

export function shortDate(key) {
  return formatDate(key, { month: "short", day: "numeric" });
}

export function weekday(key, style = "short") {
  return formatDate(key, { weekday: style });
}

// How long ago a timestamp was: "just now", "5m ago", "3h ago", "2d ago".
export function ago(iso) {
  if (!iso) return "";
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function relativeDay(key, todayKey) {
  const diff = daysBetween(key, todayKey);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff < 0 && diff > -7) return `${-diff} days ago`;
  if (diff > 0 && diff < 7) return weekday(key, "long");
  return shortDate(key);
}

export function rangeLabel(start, end) {
  const a = dateAt(start);
  const b = dateAt(end);
  const sameMonth = a.getUTCMonth() === b.getUTCMonth();
  return `${shortDate(start)} – ${sameMonth ? b.getUTCDate() : shortDate(end)}`;
}

export function percent(part, total) {
  return total ? Math.round((part / total) * 100) : 0;
}

export function plural(count, word, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`;
}
