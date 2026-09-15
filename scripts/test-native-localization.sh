#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/aibro-l10n-check.XXXXXX")
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
cd "$ROOT"
xcrun swiftc native/Sources/AIBro/NativeL10n.swift tests/native-localization.swift -o "$TEST_DIR/localization"
"$TEST_DIR/localization"
