# Repository instructions

## Working with Zach

- Zach doesn't write code here; agents do. Explain in plain, concise terms: what changed, what you verified, what you didn't.
- Never read `.env` files or secret-bearing `.env.*` variants. Ask Zach for a sanitized `.env.example` if configuration is needed.
- He uses Windows (`C:\Dev\jarvis`) mostly, plus a Mac and an iPhone. Changes must hold up on all three; you can only test Windows here.

### If you are Codex

- Begin the first response after each user prompt with "Okay, Zach", once per prompt.
- When usage information is available, warn Zach before the session allowance runs out and usage switches to Codex credits. Never invent usage numbers.

## How to work here

- Understand before changing: find the callers, tests, fixtures and packaging entries a change touches, and fix the cause, not the symptom. Keep the diff to the task; mention unrelated finds instead of folding them in.
- **Verify by running it.** `npm test` covers logic; UI work needs the app open at desktop and phone width (`npm run dev`, or `npm run build:web` then `npm run cloud:dev`). A passing suite says nothing about layout.
- When fixing a bug, watch the test fail without the fix first.
- Measure rather than eyeball: element positions, API responses, file contents. Screenshots can lag a frame.
- Report honestly what you ran, what failed, and what you couldn't check (macOS, the phone, anything needing Zach's accounts).
- Clean up servers, Electron instances and temporary data roots you started.

## Map

One npm package: JavaScript ES modules, Node.js, Electron, Preact + HTM + Signals with no bundler. The desktop and the cloud app share the frontend.

| Location | Responsibility |
| --- | --- |
| `server.js` | Local HTTP server: composes the APIs, Spotify routes, static files |
| `server/plan/` | Roadmap generation, scheduling, progress state, mutations, focus sessions, routes |
| `server/agents/` | Agent discovery, runs, drafts, queue, worktrees, loops, hooks, usage, PR status, phone commands |
| `server/jobs/` | Application pipeline, Gmail ingestion, matching, routes |
| `server/music/`, `server/cloud/music.js` | Listening history, imports, song identity, ranking, synced playlists, the cloud tick |
| `server/projects.js`, `server/project-connections.js` | Projects page: git and `gh` checks (cached a minute) and how they're ranked |
| `server/shared-state.js`, `server/cloud-sync.js` | Runtime state on disk (cached until a file changes), iCloud and cloud sync |
| `server/cloud/`, `api/index.js` | Cloud API, GitHub sign-in, memory/Neon storage |
| `desktop/` | Electron lifecycle, windows, user data, updater |
| `public/app/` | Preact UI: `ui.js` components, `icons.js`, `api.js`, `format.js`, signals, feature folders and CSS |
| `public/routes.js`, `public/app/platform.js` | Navigation and what's desktop-only |
| `data/plan/roadmap-plan.v1.json` | The roadmap definition (large; search it, don't read it whole) |
| `config/` | `desktop.defaults.json` (packaged defaults), `jarvis.config.json` |
| `tests/` | `node:test` suite and fixtures |
| `scripts/`, `.github/workflows/` | Startup, builds, CI and releases |
| `docs/` | How each feature behaves, for Zach and for you |

Feature behavior lives in `docs/`; read the one you need rather than all of them: [pages](docs/pages.md) (Today, Focus, Roadmap, Projects), [agents](docs/agents.md), [music](docs/music.md), [jobs](docs/jobs.md), [cloud](docs/cloud.md) (phone, sync, hosting), [install](docs/install.md) (installers, updates, login, CI), [connectors](docs/connectors.md). When behavior changes, update its doc in the same change. Keep this file current when commands or architecture change, and keep `CLAUDE.md` a pointer to it.

## Commands

Node.js 22 (CI) or 20+. Use npm and `package-lock.json` from the repo root; in PowerShell call `npm.cmd`/`npx.cmd`. Pin new dependencies to an exact version at least two weeks old and check `npm audit --omit=dev` first.

| Task | Command |
| --- | --- |
| Install | `npm ci` |
| Electron from source | `npm run desktop` |
| Local HTTP server | `npm run dev` |
| Tests: all / one file / one test | `npm test` / `node --test tests/x.test.js` / add `--test-name-pattern="name"` |
| Electron entry syntax | `node --check desktop/main.mjs` |
| Web assets, then local cloud app | `npm run build:web`, `npm run cloud:dev` (http://localhost:4320) |
| Windows unpacked / installer | `npm run build:dir` / `npm run build:win` |
| macOS DMG/ZIP (on a Mac) | `npm run build:mac` |

No watch or HMR: reload the UI after frontend edits, restart after server or Electron edits, rebuild web assets for the cloud preview. The local cloud app uses memory storage unless `DATABASE_URL` is set and has a development sign-in; keep it local. Production settings are listed in `docs/cloud.md`; never inspect secret files for them.

## Code conventions

- Two-space indent, double quotes, semicolons, named exports, explicit `.js`/`.mjs` in relative imports, `node:` built-ins.
- Comments say why, in plain sentences like the existing code.
- UI stays in the Preact + `html` template style (`public/app/html.js`). Reuse `ui.js` (`Field`, `Button`, `IconButton`, `Modal` for create and confirm, `Sheet` for details), `icons.js`, `api.js`, `format.js` and store notifications. Keep keyboard focus, Escape, labels and phone layouts working.
- Look and feel: a dense, quiet dashboard with plain labels. `theme.css` owns colors, type, spacing and motion (dark default, light supported); `app.css` owns shared layout; feature CSS only adds feature geometry. At phone width, controls wrap and modals scroll.
- Check `platform.js` before adding shared UI; desktop-only features stay off the web.
- Reuse helpers and dependencies; no new frameworks or abstractions for small changes. There are no lint or type-check scripts; don't invent them.
- Shell heredocs mangle backslashes and `${...}`. Edit with the editing tools, or a script file in a scratch directory.

## Tests

- `node:test` and `node:assert/strict`, `*.test.js` under `tests/`. Add focused regression coverage for behavior changes; docs-only edits need their paths and links checked.
- Integration tests use temporary data roots, isolated shared-state directories and ephemeral ports. Restore env vars, close servers, and use `removeTempDir` from `tests/helpers.js` on Windows.
- Kill every child process a test spawns, on the failure path too; an orphan holding a pipe hangs the suite.
- Keep task IDs stable in `tests/fixtures/plan-site-snapshot.json`; investigate snapshot differences instead of replacing them.
- Derive paths, drive letters and `%APPDATA%` the way the code does, or the test fails on the macOS runner.
- CI runs Windows (and macOS when `ENABLE_MACOS_CI` is on) on Node 22. Local passes don't prove macOS or a deployment. A macOS job pending with no log is runner capacity.
- Before handing off: review the diff, run `git diff --check`, and report the checks you ran.

## Data and security

- Preserve user progress, credentials, runtime state, backups, logs and others' local work. Never reset real data to make something pass.
- Data root: the checkout for source runs; `%APPDATA%/Jarvis/workspace` or `~/Library/Application Support/Jarvis/workspace` for the installed app; `JARVIS_DATA_DIR` overrides. The desktop port is in the data root's `desktop-runtime.local.json`. Source runs are **Jarvis Dev**, with their own Electron profile, and can run beside the installed **Jarvis**; confirm which one you're testing.
- Roadmap definitions and progress are separate. Preserve task identity, merge and deletion behavior and import precedence in `server/plan/` and sync code. Plan state syncs between devices: new fields must merge cleanly and older records must keep working.
- Keep the local host checks, JSON validation, body limits and path containment in `server/http.js`, and the cloud's session, origin and device-token checks. Never serve private plan data or a user's media from the cloud; read a user's own media and exports in place.
- Never commit secrets, `*.local.json`, transcripts, caches, `node_modules/`, `dist/`, `web-dist/`, `.claude/` or `.agents/`. Respect `.gitignore` and the packaging allowlist in `package.json`.

## Git and releases

- One branch per change, `claude/<topic>` or `codex/<topic>`; never commit to `main`. Don't push or open a PR unless Zach asks; say what you committed and where.
- **Several agents share this checkout.** Check `git status` and the branch before switching; for parallel work use `git worktree add` (the agents hub uses `.agent-worktrees/`).
- Merging to `main` runs `release.yml`, which publishes a release the installed apps offer as an update. Treat a merge as a real side effect, and verify a deployment separately from a passing build. Desktop builds are unsigned.
- PR descriptions explain the behavior change and the validation actually done, including what wasn't checked.
