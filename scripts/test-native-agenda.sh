#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/aibro-agenda-check.XXXXXX")
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
cd "$ROOT"
xcrun swiftc native/Sources/AIBro/AgendaCore.swift tests/agenda-core.swift -o "$TEST_DIR/core"
"$TEST_DIR/core"
xcrun swiftc native/Sources/AIBro/AgendaCore.swift native/Sources/AIBro/AgendaStore.swift native/Sources/AIBro/AgendaSync.swift tests/agenda-store.swift -o "$TEST_DIR/store" -framework SwiftUI -framework UserNotifications
"$TEST_DIR/store"
node --test tests/native-agenda-ai.test.cjs tests/native-bridge.test.cjs tests/native-glass-regions.test.cjs tests/workspace-layout.test.js tests/reading-pane.test.js tests/planning-workbench.test.js tests/note-editor.test.js
