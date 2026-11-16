// Date helpers for the plan engine. Date keys are "YYYY-MM-DD" strings and are
// handled at noon UTC so daylight-saving changes never shift a day.

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function isDateKey(value) {
  return typeof value === "string" && DATE_KEY.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
}

export function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function daysBetween(later, earlier) {
  return Math.round((Date.parse(`${later}T12:00:00Z`) - Date.parse(`${earlier}T12:00:00Z`)) / 86_400_000);
}

// 0 = Monday … 6 = Sunday
export function weekdayIndex(dateKey) {
  return (new Date(`${dateKey}T12:00:00Z`).getUTCDay() + 6) % 7;
}

export function weekStartMonday(dateKey) {
  return addDays(dateKey, -weekdayIndex(dateKey));
}

export function getLocalDateKey(date = new Date(), timeZone = "UTC") {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (values.year && values.month && values.day) return `${values.year}-${values.month}-${values.day}`;
  } catch {
    // Fall through to UTC when the configured timezone is unavailable.
  }
  return date.toISOString().slice(0, 10);
}

export function localMinutes(date = new Date(), timeZone = "UTC") {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return Number(values.hour) * 60 + Number(values.minute);
  } catch {
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }
}

export function minutesToClock(minutes) {
  return `${Math.floor(minutes / 60) % 12 || 12}:${String(minutes % 60).padStart(2, "0")} ${minutes < 720 ? "AM" : "PM"}`;
}
