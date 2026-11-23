#!/bin/bash
# Reproducible WKWebView harness run. Everything is derived from the repo; the only
# temp files are created under a fresh mktemp dir and removed on exit.
# usage: tests/harness/run.sh <steps.json> <outDir> [html]   (html defaults to app/index.html)
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
steps="$1"; out="$2"; html="${3:-$repo/app/index.html}"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$out"
cat "$repo/tests/harness/pre.js" "$repo/tests/fixtures/native-settings-stub.js" > "$work/stub-all.js"
swiftc -O "$repo/tests/harness/webview-harness.swift" -o "$work/h" 2>&1 | grep -v warning || true
"$work/h" "$html" "$repo" "$work/stub-all.js" "$steps" "$out"
