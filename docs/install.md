# Install, update and run

## Windows desktop installer

Every merge to `main` publishes a new version as a GitHub release in the author's private repo (`.github/workflows/release.yml` builds `Jarvis-Setup-<version>-x64.exe` on Windows and the Mac app on macOS, numbered `0.3.<run>`, with one `SHA256SUMS.txt` for both). The installed app checks on launch and every four hours; when a newer version exists, a dot appears on the Settings icon and the tray offers it. **Settings → Updates → Update and restart** downloads it with your `gh` login, checks its SHA-256, installs it silently and reopens Jarvis. It asks first if a focus session or an agent run is going. The GitHub CLI must be installed and signed in (`gh auth login`) with access to the repo.

To build an installer by hand, run `npm ci` followed by `npm run build:win`; the setup file is `dist/Jarvis-Setup-<version>-x64.exe`. Versions installed before 0.3.1 don't have the updater, so install one release by hand to switch over. Install it for your Windows account, then open **Jarvis** from the desktop or Start menu. Node.js is not required to run the installed app. Local builds are unsigned.

The installed app saves configuration, task history, and credentials in `%APPDATA%/Jarvis/workspace`. On first launch it imports an existing `C:/Dev/jarvis` workspace without changing the source and saves a backup under `workspace/backups/initial-import`. Reinstalling and uninstalling preserve your data. The installer contains application code and defaults only, with no personal configuration or credentials.

Checking a task saves it immediately on this device and syncs through iCloud Drive when it is available. Use **Settings** (gear icon) for your class schedule, gym cycle, Spotify, theme and focus wallpapers.

Closing the window keeps Jarvis in the system tray; the desktop shortcut brings back the same instance. Choose **Quit** from the tray to exit completely.

## Mac app

Each release also carries `Jarvis-<version>-universal-mac.dmg` (first install) and `Jarvis-<version>-universal-mac.zip` (used by the updater). The app is universal (Apple silicon and Intel) and **unsigned**, so macOS asks once:

1. Download the `.dmg` from the latest release (`gh release download --repo zachhersick/jarvis --pattern '*-mac.dmg'`), open it and drag **Jarvis** to Applications.
2. In Applications, right-click **Jarvis → Open → Open**. After that it opens normally.
3. Install the tools it uses with Homebrew (`brew install gh git node`) and run `gh auth login`; the updater needs `gh`.

**Update and restart** works the same as on Windows: it downloads the `.zip`, checks it against `SHA256SUMS.txt`, and a small helper swaps the app in `/Applications` once Jarvis quits, clears the download quarantine flag and reopens it (rolling back if the copy fails). Jarvis must live somewhere you can write to, such as `/Applications`.

Apps opened from Finder get a bare `PATH`, so on launch Jarvis reads your login shell's `PATH` and adds `/opt/homebrew/bin` and `/usr/local/bin`. It finds Claude Code at `claude` on the `PATH`, `~/.claude/local/claude` or the newest copy bundled with the Claude desktop app, and Codex at `codex` on the `PATH` or in Homebrew. The menu-bar icon is a template image, so it follows light and dark menu bars. Data lives in `~/Library/Application Support/Jarvis/workspace`, and on first launch it imports `~/Dev/jarvis` if that checkout exists.

Build it yourself on a Mac with `npm ci && npm run build:mac` (output in `dist/`).

## Run from source

```sh
npm ci
npm run desktop
```

Jarvis opens as a desktop app window. The local HTTP service is only an internal bridge for the UI and integrations.

Source launches identify as **Jarvis Dev** and use a separate Electron profile (`%APPDATA%/Jarvis Dev` on Windows), so they can run alongside the installed **Jarvis** release without intercepting its shortcuts. Source data still lives in the checkout. Use the installed app for personal use and updates; `scripts/install-shortcut.ps1` creates shortcuts named **Jarvis Dev** for source development.

Use Node.js 20 or newer. On macOS, install Git, GitHub CLI, and VS Code first; Homebrew is the simplest route. The checked-in paths are repository-relative, so the project cards connect automatically when these repositories are cloned beside one another:

```text
Dev/
  jarvis/
  anomalyops-copilot/
  anomaly-detection/
  sample-project/
```

Missing sibling repositories stay visible as disconnected cards and do not prevent Jarvis from starting. Paths beginning with `~`, `%NAME%`, `$NAME`, or `${NAME}` are expanded before use.

## Start On Login

The installed app opens itself at login. It registers the first time it runs, on Windows and macOS. A copy run from source (`npm run desktop`) never registers, so only the real app starts with your computer.

Older builds, and the `startup:install` script this replaces, could add a login entry that started the source checkout instead. On a PC or Mac that might have one, run this once from the checkout:

```sh
npm run startup:clean
```

What it removes:
- **Windows:** login entries that run this checkout or the development Electron binary.
- **macOS:** the old `~/Library/LaunchAgents/com.zachhersick.jarvis.plist`, if it runs this checkout.

It leaves the installed app's own entry alone. Run `npm run startup:run` to launch the source copy now, without touching login.

## macOS First-Run Check

1. Install the app as in [Mac app](#mac-app) (or, from source, run `npm ci`, `npm test`, and `npm run desktop`).
2. Confirm Today, Focus, Roadmap and Projects load and the expected repositories connect.
3. Test **Open in VS Code**, a short focus session and the Agents board.
4. Connect it under **Settings → Cloud sync** and check a task off on the phone.
5. The packaged app registers itself to open at login. If this Mac ever ran the source copy at login, run `npm run startup:clean` once. Sign out and in, and confirm Jarvis launches once.

Cloud sync is the way the plan moves between the PC, the Mac and the phone. The older iCloud sync (`iCloud Drive/Jarvis`) still carries the rest of the runtime state when both computers use it; OAuth credentials and machine-specific diagnostics remain local. With iCloud, start the Windows Jarvis first so it publishes the authoritative PC history; the Mac waits for that initial import. Set `JARVIS_SHARED_DIR` only when iCloud Drive uses a nonstandard location.

## CI checks

The Cross-platform checks workflow runs Windows checks by default. macOS checks are temporarily off to avoid hosted-runner queue delays; their tests and packaging steps remain configured. To turn them on, set the repository Actions variable `ENABLE_MACOS_CI` to `true` in GitHub **Settings → Secrets and variables → Actions → Variables**. Set it to `false` or remove it to turn them off again. This toggle does not change the separate release workflow, which still builds both desktop platforms after merges to `main`.
