#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/aibro-vectors-check.XXXXXX")
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
xcrun swiftc "$ROOT/native/Sources/AIBro/NativeVectorStore.swift" "$ROOT/tests/native-vector-store.swift" -o "$TEST_DIR/vectors"
"$TEST_DIR/vectors" "$TEST_DIR/data" write
"$TEST_DIR/vectors" "$TEST_DIR/data" reopen
