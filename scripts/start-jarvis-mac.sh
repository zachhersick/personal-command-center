#!/usr/bin/env sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"

pkill -f "$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" >/dev/null 2>&1 || true
sleep 1

if [ -x "$ROOT/node_modules/.bin/electron" ]; then
  exec "$ROOT/node_modules/.bin/electron" "$ROOT"
fi

if command -v npm >/dev/null 2>&1; then
  exec npm run desktop
fi

echo "Jarvis cannot start: Electron is not installed and npm is not available on PATH." >&2
echo "Run npm install from $ROOT, then try again." >&2
exit 1
