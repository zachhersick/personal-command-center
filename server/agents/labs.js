// Hands-on labs for learning agentic coding. Each lab is checked automatically
// from things that actually happened on this machine: files in your repos, runs
// launched from Jarvis, loops that passed, hooks that fired.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeWriteJson } from "../shared-state.js";
import { claudeHome } from "./paths.js";

export const PLAYBOOK = [
  { title: "Scope tight", body: "One task, one outcome, one worktree. Small asks give reviewable diffs; vague asks give sprawling ones." },
  { title: "Give it a way to check itself", body: "Tests, a type check, a linter or a script it can run. An agent that can verify its work fixes its own mistakes; one that can't guesses." },
  { title: "Plan before it types", body: "Ask for a plan first, fix the plan, then let it execute. Correcting a plan costs a minute; correcting code costs an hour." },
  { title: "Read every diff", body: "You're the reviewer and the owner. If you can't explain a change, it doesn't ship." },
  { title: "Write the context down", body: "CLAUDE.md / AGENTS.md hold the build commands, conventions and don'ts, so you stop repeating them in every prompt." },
  { title: "Automate the guardrails", body: "Hooks run your formatter, block dangerous commands and tell you when an agent needs you, every time, without you remembering." },
  { title: "Parallelize with worktrees", body: "Independent tasks can run at once in separate checkouts. Coordinate them; don't let two agents edit the same files." },
  { title: "Keep sessions short", body: "Long sessions drift and get expensive. Start fresh per task; put durable knowledge in context files, not in chat history." }
];

export const LABS = [
  {
    id: "context-file",
    title: "Write the context file",
    minutes: 20,
    why: "Agents start every session knowing nothing about your repo. A short context file with the build and test commands, the layout and your rules is the highest-leverage thing you can write.",
    steps: [
      "Pick a repo (Jarvis is a good first one).",
      "Ask an agent to draft CLAUDE.md from the code, then edit it down to what's true and useful: how to install, run, test; where things live; conventions; things it must never do.",
      "Copy the same content to AGENTS.md so Codex reads it too.",
      "Start a fresh session and ask a question the file answers. Notice the agent doesn't have to explore."
    ],
    prompt: "Read this repository and draft a concise CLAUDE.md: how to install, run and test it (exact commands), the directory layout, coding conventions, and a short list of things an agent must not do here. Under 60 lines. Don't invent anything you can't see in the code.",
    mode: "edit"
  },
  {
    id: "plan-first",
    title: "Plan, then execute",
    minutes: 25,
    why: "Most agent mistakes are decided in the first minute: the wrong approach, the wrong files. Reviewing a plan is the cheapest point to catch them.",
    steps: [
      "Launch a run in Plan mode with a small feature request.",
      "Read the plan. Push back on one thing: scope, approach or a missing test.",
      "Send a follow-up in Edit mode: \"Go ahead with the revised plan.\"",
      "Compare what it built with the plan."
    ],
    prompt: "Plan how you would add a small, useful improvement to this repo (pick one from the open TODOs or tests). List the files you'd change, the approach, and how you'd verify it. Don't edit anything yet.",
    mode: "plan"
  },
  {
    id: "verification-loop",
    title: "The verification loop",
    minutes: 30,
    why: "This is the core of agentic coding: work, check, fix, repeat. With a check it can run, an agent converges on correct code instead of plausible code.",
    steps: [
      "Write (or pick) a failing test for a small bug or feature.",
      "Start a Loop with that test command as the check, max 5 iterations.",
      "Watch each iteration: the diff, the check output, what it fed back.",
      "When it passes, read the final diff. Did it fix the cause, or game the test?"
    ],
    prompt: "Make the failing test pass by fixing the underlying code. Keep the change minimal.",
    mode: "edit",
    loop: true
  },
  {
    id: "small-diffs",
    title: "Small diffs, read every one",
    minutes: 20,
    why: "You own every line an agent writes. Small diffs are the only kind you can genuinely review, and reviewing is where you learn.",
    steps: [
      "Launch a run with a deliberately small task (under ~100 changed lines).",
      "Open its Diff tab and read all of it. Ask a follow-up about anything you can't explain.",
      "Keep the branch only once you could defend each change yourself."
    ],
    prompt: "Make one small, self-contained improvement: add input validation and a test for one function that lacks it. Keep the diff under 100 lines.",
    mode: "edit"
  },
  {
    id: "hooks-format",
    title: "Hooks I: automatic formatting",
    minutes: 20,
    why: "Hooks run your rules every time, deterministically, instead of hoping the agent remembers. The classic first hook formats or lints a file right after the agent edits it.",
    steps: [
      "In a repo, add .claude/settings.json with a PostToolUse hook (matcher \"Edit|Write\") that runs your formatter or linter.",
      "Have an agent make an edit and confirm the hook ran (its output shows in the transcript).",
      "Bonus: a PreToolUse hook that blocks `rm -rf` or `git push --force`."
    ],
    prompt: "Add a .claude/settings.json to this repo with a PostToolUse hook (matcher \"Edit|Write\") that runs the project's formatter or linter on changed files. Explain how it works.",
    mode: "edit"
  },
  {
    id: "hooks-jarvis",
    title: "Hooks II: agents report to Jarvis",
    minutes: 10,
    why: "The same mechanism powers this hub. With Jarvis's hooks installed, agents tell you the instant they need input instead of you checking on them.",
    steps: [
      "Open Hooks on the Agents page and preview the change to your Claude settings.",
      "Apply it, then start any Claude Code session and give it a task that needs a permission prompt.",
      "Watch its card jump to Needs you."
    ]
  },
  {
    id: "parallel-worktrees",
    title: "Parallel agents in worktrees",
    minutes: 30,
    why: "Agents work while you think. Independent tasks can run side by side in separate worktrees without stepping on each other. That's where the leverage multiplies.",
    steps: [
      "Pick two independent tasks in the same repo (different files).",
      "Launch one with Claude and one with Codex at the same time.",
      "Watch both on the board; review each diff separately.",
      "Notice what made them independent. That's how you'll split bigger work."
    ]
  },
  {
    id: "writer-reviewer",
    title: "Writer and reviewer",
    minutes: 25,
    why: "A second agent with fresh context catches what the first one rationalized. Using a different model family as the reviewer catches even more.",
    steps: [
      "Let one agent finish a run.",
      "From that run, click Review with the other provider. It reviews the branch's diff for bugs, missing tests and risky changes.",
      "Send the useful findings back to the writer as a follow-up."
    ]
  },
  {
    id: "custom-command",
    title: "Turn a prompt into a command",
    minutes: 15,
    why: "When you type the same instructions twice, make them a slash command or skill. Your best prompts become reusable tools.",
    steps: [
      "Find a prompt you repeat (e.g. \"review this diff for bugs and missing tests\").",
      "Save it as .claude/commands/review.md in a repo (or ~/.claude/commands for everywhere).",
      "Run /review in a Claude Code session."
    ],
    prompt: "Create .claude/commands/review.md: a reusable slash command that reviews the current git diff for bugs, missing tests, risky changes and unclear naming, and reports findings ranked by severity.",
    mode: "edit"
  },
  {
    id: "context-hygiene",
    title: "Context hygiene",
    minutes: 15,
    why: "Every message carries the whole conversation. Long sessions cost more and drift. Short, focused sessions with good context files beat one marathon chat.",
    steps: [
      "On the Agents page, compare token counts of your longest sessions with your focused ones.",
      "Next time a session drifts, stop: write down what you learned in the context file, and start fresh with a tight prompt.",
      "Check this off when you've done it once on purpose."
    ],
    manual: true
  }
];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function listFiles(dir, predicate) {
  try {
    return readdirSync(dir).filter(predicate);
  } catch {
    return [];
  }
}

// ctx: { projects: [{id, path}], runs, sessions, hookStats, env }
export function evaluateLabs(ctx, progress = {}) {
  const projects = ctx.projects || [];
  const runs = ctx.runs || [];
  const checks = {
    "context-file": () => {
      const hit = projects.find((project) => {
        const claude = join(project.path, "CLAUDE.md");
        const agents = join(project.path, "AGENTS.md");
        if (!existsSync(claude) || !existsSync(agents)) return false;
        return /\b(test|npm|pytest|node --test)\b/i.test(readFileSync(claude, "utf8"));
      });
      return hit ? `CLAUDE.md and AGENTS.md in ${hit.id}` : null;
    },
    "plan-first": () => {
      const run = runs.find((entry) => entry.turns?.[0]?.mode === "plan" && entry.turns.some((turn, index) => index > 0 && turn.mode === "edit"));
      if (run) return `Planned, then executed: ${run.title}`;
      const session = (ctx.sessions || []).find((entry) => {
        const plan = (entry.recent || []).findIndex((item) => item.kind === "plan");
        return plan >= 0 && (entry.recent || []).slice(plan + 1).some((item) => item.kind === "edit");
      });
      return session ? `Planned, then edited in "${session.title}"` : null;
    },
    "verification-loop": () => {
      const run = runs.find((entry) => entry.loop?.status === "passed" && entry.loop.iterations.length >= 2);
      return run ? `Loop passed on iteration ${run.loop.iterations.length}` : null;
    },
    "small-diffs": () => {
      const run = runs.find((entry) => entry.diffViewed && entry.outcome === "kept" && Number(entry.diffLines) > 0 && Number(entry.diffLines) < 100);
      return run ? `Reviewed and kept a ${run.diffLines}-line change` : null;
    },
    "hooks-format": () => {
      const hit = projects.find((project) => {
        const settings = readJson(join(project.path, ".claude", "settings.json"));
        return (settings?.hooks?.PostToolUse || []).some((entry) => (entry.hooks || []).some((hook) => !String(hook.command || "").includes("agent-hook.mjs")));
      });
      return hit ? `PostToolUse hook in ${hit.id}` : null;
    },
    "hooks-jarvis": () => (ctx.hookStats?.counts?.claude || ctx.hookStats?.counts?.codex ? `${ctx.hookStats.counts.claude + ctx.hookStats.counts.codex} hook events received` : null),
    "parallel-worktrees": () => {
      const spans = runs.filter((entry) => entry.startedAt).map((entry) => ({ entry, start: Date.parse(entry.startedAt), end: Date.parse(entry.endedAt || entry.updatedAt) }));
      for (const a of spans) {
        for (const b of spans) {
          if (a.entry.id >= b.entry.id || a.entry.worktree === b.entry.worktree) continue;
          if (a.start < b.end && b.start < a.end) return `${a.entry.provider} and ${b.entry.provider} ran at the same time`;
        }
      }
      return null;
    },
    "writer-reviewer": () => {
      const run = runs.find((entry) => entry.kind === "review" && entry.reviewOf);
      return run ? `${run.provider} reviewed another run` : null;
    },
    "custom-command": () => {
      const dirs = [join(claudeHome(ctx.env), "commands"), ...projects.map((project) => join(project.path, ".claude", "commands"))];
      for (const dir of dirs) if (listFiles(dir, (name) => name.endsWith(".md")).length) return `Command in ${dir}`;
      for (const project of projects) {
        const skills = join(project.path, ".claude", "skills");
        if (listFiles(skills, () => true).some((name) => existsSync(join(skills, name, "SKILL.md")))) return `Skill in ${project.id}`;
      }
      return null;
    },
    "context-hygiene": () => null
  };
  return LABS.map((lab) => {
    const saved = progress[lab.id] || {};
    let evidence = null;
    try {
      evidence = lab.manual ? null : checks[lab.id]?.() || null;
    } catch {
      evidence = null;
    }
    const done = Boolean(evidence || saved.manualDone);
    return { ...lab, done, evidence: evidence || (saved.manualDone ? "Checked off by you" : null), completedAt: saved.completedAt || null };
  });
}

export class LabProgress {
  constructor(dataRoot) {
    this.dataRoot = dataRoot;
    this.cache = null;
  }

  get file() {
    return join(this.dataRoot(), "data", "agent-labs.local.json");
  }

  read() {
    if (!this.cache) this.cache = readJson(this.file)?.labs || {};
    return this.cache;
  }

  async record(labs) {
    const progress = this.read();
    let changed = false;
    for (const lab of labs) {
      if (lab.done && !progress[lab.id]?.completedAt) {
        progress[lab.id] = { ...progress[lab.id], completedAt: new Date().toISOString() };
        changed = true;
      }
    }
    if (changed) await safeWriteJson(this.file, { version: 1, labs: progress });
    return progress;
  }

  async setManual(id, done) {
    if (!LABS.some((lab) => lab.id === id)) throw Object.assign(new Error("Unknown lab."), { status: 404 });
    const progress = this.read();
    progress[id] = { ...progress[id], manualDone: Boolean(done), completedAt: done ? progress[id]?.completedAt || new Date().toISOString() : null };
    await safeWriteJson(this.file, { version: 1, labs: progress });
    return progress;
  }
}
