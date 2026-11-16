// Keeps the pull requests agents opened up to date through the gh CLI: state,
// review and checks. Only looks while someone is watching the hub, and stops
// looking at a PR once it's merged or closed.
const FIELDS = "state,isDraft,mergedAt,reviewDecision,statusCheckRollup,url";
const POLL_MS = 60_000;
const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const LOG_CHARS = 6000;

// gh returns CheckRuns (name, conclusion) and StatusContexts (context, state) in one list.
export function summarizePr(raw = {}) {
  const checks = { passing: 0, failing: 0, pending: 0, failed: [] };
  for (const check of raw.statusCheckRollup || []) {
    const result = check.conclusion || check.state || "";
    if (FAILED.has(result)) {
      checks.failing += 1;
      checks.failed.push({ name: check.name || check.context || "Check", url: check.detailsUrl || check.targetUrl || "" });
    } else if (PASSED.has(result)) checks.passing += 1;
    else checks.pending += 1;
  }
  return { state: raw.state || "OPEN", draft: Boolean(raw.isDraft), mergedAt: raw.mergedAt || null, review: raw.reviewDecision || "", checks };
}

export const prResolved = (pr) => pr?.state === "MERGED" || pr?.state === "CLOSED";

export function createPrWatcher({ launcher, run, isWatched = () => true }) {
  const inFlight = new Map();
  let timer = null;

  async function look(target) {
    const result = await run("gh", ["pr", "view", target.prUrl, "--json", FIELDS], { cwd: target.repo, timeout: 20_000 });
    const checkedAt = new Date().toISOString();
    // A failed look keeps what we knew, so a network blip doesn't blank the card.
    if (!result.ok) return launcher.setPr(target, { ...target.pr, error: result.stderr || "gh pr view failed.", checkedAt });
    try {
      return launcher.setPr(target, { ...summarizePr(JSON.parse(result.stdout)), error: "", checkedAt });
    } catch {
      return launcher.setPr(target, { ...target.pr, error: "gh returned something unreadable.", checkedAt });
    }
  }

  function refresh(target) {
    if (!run || !target.prUrl) return Promise.resolve();
    if (inFlight.has(target.id)) return inFlight.get(target.id);
    const pending = look(target).catch((error) => console.error("Agent PR status:", error.message)).finally(() => inFlight.delete(target.id));
    inFlight.set(target.id, pending);
    return pending;
  }

  async function tick() {
    if (!run || !isWatched()) return;
    for (const target of launcher.list()) {
      if (target.prUrl && !prResolved(target.pr)) await refresh(target);
    }
  }

  return {
    refresh,
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => { tick().catch(() => {}); }, POLL_MS);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    }
  };
}

// A follow-up for the agent, written for you to read and edit before sending.
export async function failurePrompt(target, run) {
  const failed = target.pr?.checks?.failed || [];
  if (!failed.length) return "";
  const lines = ["These checks are failing on the pull request:", ...failed.map((check) => `- ${check.name}`)];
  const ids = [...new Set(failed.map((check) => /\/actions\/runs\/(\d+)/.exec(check.url)?.[1]).filter(Boolean))].slice(0, 2);
  for (const id of ids) {
    const result = await run("gh", ["run", "view", id, "--log-failed"], { cwd: target.repo, timeout: 60_000 }).catch(() => ({ ok: false }));
    if (result.ok && result.stdout) lines.push("", `End of the failed log for run ${id}:`, "```", result.stdout.slice(-LOG_CHARS), "```");
  }
  lines.push("", "Find the cause and fix it. Run the failing check locally if you can. Don't push: I'll review your changes and push them from Jarvis.");
  return lines.join("\n");
}
