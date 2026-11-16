# Agents hub

The Agents page is a task board for coding agents, in the style of [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) and [Conductor](https://www.conductor.build/). Runs sit in four columns, and they move on their own as things happen:

| Column | What's in it |
| --- | --- |
| To do | Saved drafts, then runs waiting for a slot |
| Running | Agents working right now |
| In review | Finished with no decision yet, failed or stopped with work to decide on, or a pull request still open |
| Done | Committed with no pull request, pull request merged or closed, or discarded |

The layout follows [T3 Code](https://github.com/pingdotgg/t3code). A sidebar on the left lists every run, grouped by what it needs from you:
- **Needs you** first, then **Running**, **Up next** (the queue and drafts), **In review** and **Done**.
- Sessions **started outside Jarvis** are in a collapsible group at the bottom.
- **New task** and the All / Claude / Codex filter sit at the top.
- **Board** shows the four columns above, with the counts and **More** (Usage, Labs and Hooks).

Opening a run fills the rest of the window:
- **Header:** the title, its facts and pull request, and the actions (Commit, Open PR, Push fixes, Fix failing checks, Review, VS Code, Discard).
- **Conversation:** fills the height. The plan approval, queued messages and the reply box are docked under it.
- **Side panel:** Changes, Logs and Prompt on the right. `Ctrl+D` (`Cmd+D` on a Mac) or the panel button shows or hides it.

The open run is part of the address (`#agents/<id>`), so back and forward work, and a link opens that run. `Esc` closes it. On a phone or a narrow window you get one pane at a time: the list of runs (with a Runs / Board switch), then the run itself, opening on the conversation.

- **To do.** **New task** can **Start now** or **Save to To do**. A draft keeps everything you chose, including a roadmap task link, and stays on this computer. Starting one goes through the normal validation and queue, and a draft that can't start stays where it is.
- **Steering.** A message sent while an agent is working waits and goes out when the turn ends. After a stop, a failed turn or a restart, it waits for you to send it. Loops take no queued messages. A finished plan shows **Approve** and **Request changes**. **Retry from here** on one of your messages starts a separate run from the original commit, with your messages up to that point, and leaves the first run alone until you discard it.
- **Pull requests.** Cards show a PR's state, review and checks, read with `gh pr view` about once a minute while the page is open, and only until it's merged or closed. **Fix failing checks** writes the failing check names and a capped log tail into the reply box for you to read and send. **Push fixes** commits the agent's new work and pushes it to the PR's branch. Merging stays on GitHub, because merging to `main` publishes a release.

- **Watching.** Jarvis reads Claude Code's live session registry (`~/.claude/sessions`) and transcripts (`~/.claude/projects`), and Codex's thread database (`~/.codex/state_5.sqlite`, `thread_history_1.sqlite`), read-only. They sit in a **Started outside Jarvis** strip under the board, with the repo and status, and open in a read-only workspace. The rail badge and a desktop notification tell you when something is waiting on you.
- **Starting runs.** A task runs Claude Code (`-p --output-format stream-json`) or Codex (`exec --json`) on a task in a fresh git worktree under `<repo>/.agent-worktrees/`, on an `agent/…` branch, so your checkout is never touched. Choose Plan first (read-only) or Let it edit. Claude runs may edit files in the worktree and run test and git-read commands; Codex runs in its `workspace-write` sandbox. Permissions are never bypassed. From a run you can send follow-ups (same session), stop it, read the diff, commit to the branch, ask the other agent to review it, open a PR (only after you confirm) or discard it. At most `agents.maxConcurrent` runs (default 3) at once, each capped at `agents.timeoutMinutes` (45).
- **Loops.** Tick *Loop until a check passes* and give a command like `npm test`. After each turn Jarvis runs the check in the worktree; if it fails, the tail of its output goes back to the agent, up to the iteration limit.
- **Hooks.** **More → Hooks** previews and installs Claude Code hooks (SessionStart, UserPromptSubmit, PostToolUse, Notification, Stop) that forward events to Jarvis, so "Needs you" fires the moment an agent is blocked. The hook script lives in the workspace's `hooks/` folder, gives up within a second and never blocks the agent. Your existing hooks are kept and the settings file is backed up first.
- **Labs.** Ten short exercises with a playbook: context files, plan-then-execute, verification loops, small diffs, hooks, parallel worktrees, writer and reviewer, custom commands, context hygiene. Jarvis checks them off from what actually happened.

**Setup.** Codex uses your existing login; Jarvis picks the newest runnable Codex install it finds, including versioned desktop installations (override with `agents.codexCommand`). Claude uses the standalone [Claude Code CLI](https://code.claude.com/docs/en/setup), or a compatible bundled CLI (override with `agents.claudeCommand`); Claude Desktop's GUI executable cannot run agents. Sign in once with `claude auth login` using your subscription, or `codex login`, then click **Refresh setup** in the composer. Setup failures are shown before creating a worktree; Jarvis does not bypass provider configuration or permissions. Run records and logs stay local in `data/agent-runs.local.json` and `data/agent-logs/`.

Choose **Model** and **Reasoning strength** for each agent, loop, or cross-provider review. Codex choices come from its local model catalog; open Codex to refresh that catalog if missing, then refresh setup. Claude lists each family's **latest** alias, which follows new releases, and pinned releases such as Opus 5.5 and Opus 5; the release list lives in `server/agents/providers.js` because Claude Code cannot list models. Effort choices are the ones the installed CLI supports. **Provider default** preserves provider settings. Jarvis remembers the last successful choices separately for Claude and Codex; follow-ups and loop iterations retain their run's settings. Details distinguish requested settings from those actually reported by the provider. Stop also cancels a loop's running check; discarding waits for processes to exit before removing their worktree.

- **Queue.** When every slot (`agents.maxConcurrent`) is busy, **Add to queue** saves the request and starts it on its own when a slot frees, oldest first, keeping its place across restarts. A queued agent has no worktree yet and can be cancelled from its workspace. One that can no longer start, because its project is gone or the provider is signed out, fails on its own card without holding up the rest. Reviews aren't queued.
- **Usage.** **More → Usage** shows tokens per day for the last two weeks, read from Claude Code's transcripts and Codex's thread totals on this computer.
  - Claude counts new tokens (input, cache writes, output) separately from re-read context.
  - Codex reports one running total per thread, so its numbers aren't comparable with Claude's, and each provider is compared only with its own usual day.
  - Jarvis can't see plan limits, so it shows amounts, not a share of your allowance.
- **From your phone.** In Jarvis on the computer, **Settings → Devices → Let my phone start and steer agents** (off by default) lets jarvis.example.com start agents, reply to them, approve plans, stop them and cancel queued ones. To do shows there too, by title and read-only.
  - Each command waits in the cloud until this computer's next board push picks it up, usually within 30 seconds. Results come back on the push after that.
  - A command nobody picks up fails after 10 minutes with a reason. So does one picked up but never answered within 5 minutes.
  - Phone runs go through the same start path as the composer, so they get the same validation, worktrees, permissions and queue. They're marked "From phone".
  - Keeping, discarding, pull requests and hooks stay on the computer, and the cloud only accepts commands for the desktop whose board it holds.
- **From the roadmap.** **Ask an agent** on a Build, portfolio-repair or custom task opens the composer with the task written up as a Plan-first prompt in the audited repo. The run links back to the task, and the task sheet shows its status. Repair prompts ask for an explanation rather than the fix, as the roadmap expects.
