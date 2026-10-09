#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
fixture_dir=$(mktemp -d "${TMPDIR:-/tmp}/aibro-ios-stream.XXXXXX")
fixture_pid=""
cleanup() {
  if [[ -n "$fixture_pid" ]]; then kill "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true; fi
  rm -rf "$fixture_dir"
}
trap cleanup EXIT
xcrun swiftc ios/App/App/NativeRequestStream.swift ios/Tests/NativeStreamFixture.swift -o "$fixture_dir/stream-test"
python3 ios/Tests/stream_fixture.py "$fixture_dir/port" &
fixture_pid=$!
for ((attempt=0; attempt<100; attempt++)); do
  if [[ -s "$fixture_dir/port" ]]; then break; fi
  sleep 0.05
done
[[ -s "$fixture_dir/port" ]] || { printf 'Fixture did not start\n' >&2; exit 1; }
"$fixture_dir/stream-test" "http://127.0.0.1:$(cat "$fixture_dir/port")"
