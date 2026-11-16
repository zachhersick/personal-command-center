// Pure route table for the UI's navigation and URL handling.
export const ROUTES = [
  { id: "today", label: "Today", aliases: ["home", "day", "productivity"] },
  { id: "focus", label: "Focus", aliases: ["lock-in", "lockin", "timer", "pomodoro"] },
  { id: "roadmap", label: "Roadmap", aliases: ["plan", "weekly", "career", "week"] },
  { id: "jobs", label: "Jobs", aliases: ["applications", "pipeline", "apply", "job"] },
  { id: "agents", label: "Agents", aliases: ["hub", "vibe", "agent", "codex", "claude"] },
  { id: "music", label: "Music", aliases: ["stats", "spotify", "playlists", "listening"] },
  { id: "projects", label: "Projects", aliases: ["build", "project", "repos"] }
];

export function normalizeRoute(value) {
  const next = String(value || "").replace(/^#\/?/, "").split(/[/?]/)[0].trim().toLowerCase();
  const route = ROUTES.find((item) => item.id === next || item.aliases.includes(next));
  return route?.id || "today";
}

export function routeLabel(id) {
  return ROUTES.find((route) => route.id === id)?.label || "Today";
}
