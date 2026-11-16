// The agents worth a glance during lock-in: ones waiting on you first, then
// ones working, then queued. Pure, so it's tested in Node.
const ORDER = { "needs-you": 0, working: 1, starting: 1, queued: 2 };

export function agentSummary(board, limit = 6) {
  const sessions = (board?.sessions || []).filter((session) => session.status in ORDER);
  const count = (statuses) => sessions.filter((session) => statuses.includes(session.status)).length;
  const counts = { needsYou: count(["needs-you"]), working: count(["working", "starting"]), queued: count(["queued"]) };
  const sorted = [...sessions].sort((a, b) => ORDER[a.status] - ORDER[b.status] || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return { ...counts, total: sessions.length, shown: sorted.slice(0, limit), more: Math.max(0, sorted.length - limit) };
}

// "1 needs you · 2 working", or "" when nothing is running.
export function summaryLabel({ needsYou, working, queued }) {
  return [needsYou && `${needsYou} need${needsYou === 1 ? "s" : ""} you`, working && `${working} working`, queued && `${queued} queued`].filter(Boolean).join(" · ");
}
