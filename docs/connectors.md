# Connectors

Configuration lives in `config/jarvis.config.json`.

GitHub:
- Install and authenticate GitHub CLI with `gh auth login`, or set `GH_TOKEN`.
- Add your active repositories to `workspace.trackedRepos` and `workspace.projects`.
- Add important portfolio repos to `integrations.github.sideProjects`; Jarvis also discovers recent repos from your GitHub account. The Projects page shows their open PRs, issues, Dependabot alerts and CI runs.

Spotify:
- Connect from **Settings**. The OAuth callback must use the `127.0.0.1` loopback address.
- Music tracking needs playlist and listening-history access that older connections don't have; Settings and the Music tab show **Reconnect** until you do. Spotify ends a grant after six months, and Jarvis asks you to reconnect then too.

VS Code:
- **Open in VS Code** launches `code` against the project's path.
- On macOS it also detects the standard `/Applications/Visual Studio Code.app` command automatically.
- Change `workspace.vscodeCommand` if your command is different.
