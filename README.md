# Jarvis

Zach's personal desktop app for the September 2026 – May 2027 job-search roadmap: a day planner, a roadmap you can steer, fullscreen focus sessions, a job pipeline, a board for coding agents and Spotify listening stats. It runs on Windows and macOS (Electron), and on the phone at [jarvis.example.com](https://jarvis.example.com), which uses the same interface against a cloud copy of the plan.

| Page | What it's for | Details |
| --- | --- | --- |
| Today | The day as a timeline around classes, gym and meals; carried-over work | [pages](docs/pages.md) |
| Focus | Fullscreen timer over an animated scene or wallpaper, with notes and Spotify | [pages](docs/pages.md) |
| Roadmap | 34 weeks, the week board, portfolio repairs, the interview library, NeetCode | [pages](docs/pages.md) |
| Jobs | Applications from applied to offer, filled in from Gmail and a bookmark | [jobs](docs/jobs.md) |
| Agents | Claude Code and Codex runs in their own worktrees: a sidebar of runs, each with its conversation and changes, plus a task board | [agents](docs/agents.md) |
| Music | Listening stats, per-artist stats and auto-updating Spotify playlists | [music](docs/music.md) |
| Projects | Your repos with branch, last commit, CI, PRs and Open in VS Code | [pages](docs/pages.md) |

## Use it

- **Installed app:** every merge to `main` publishes a release; the app updates itself from **Settings → Updates**. Install, Mac, login startup and CI: [docs/install.md](docs/install.md).
- **Phone:** sign in at the website and add it to the home screen; connect each desktop under **Settings → Cloud sync**: [docs/cloud.md](docs/cloud.md).
- **Integrations** (GitHub, Spotify, VS Code): [docs/connectors.md](docs/connectors.md).

From source:

```sh
npm ci
npm run desktop
```

## Where things live

- **Your data:** `%APPDATA%/Jarvis/workspace` (Windows) or `~/Library/Application Support/Jarvis/workspace` (macOS) for the installed app; the checkout itself for a source run. Progress is in `data/runtime-state.local.json`, kept apart from the roadmap definition in `data/plan/roadmap-plan.v1.json`.
- **Code map, commands and rules for agents:** [AGENTS.md](AGENTS.md).
