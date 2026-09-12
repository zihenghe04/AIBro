#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

# Prefer a project-local Electron. A system runtime or an explicit
# ELECTRON_BIN can be used when dependencies are not installed locally.
if [ -n "${ELECTRON_BIN:-}" ] && [ -x "$ELECTRON_BIN" ]; then
  :
elif [ -x "$ROOT_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ]; then
  ELECTRON_BIN="$ROOT_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
elif command -v electron >/dev/null 2>&1; then
  ELECTRON_BIN=$(command -v electron)
elif [ -x "/Applications/Electron.app/Contents/MacOS/Electron" ]; then
  ELECTRON_BIN="/Applications/Electron.app/Contents/MacOS/Electron"
else
  cat >&2 <<'EOF'
AI Bro could not find an Electron executable.

Install dependencies when network access is available:
  npm install --save-dev electron electron-builder

Or point to an existing copy explicitly:
  ELECTRON_BIN=/path/to/Electron npm start
EOF
  exit 127
fi

if [ "$#" -eq 0 ]; then
  set -- "$ROOT_DIR"
fi

node "$ROOT_DIR/app/build-native-glass.js" --optional
echo "AI Bro: using Electron runtime: $ELECTRON_BIN" >&2
exec "$ELECTRON_BIN" "$@"
