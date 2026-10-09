#!/bin/bash
# Isolated Swift regression fixtures, without Simulator or Apple signing.
set -euo pipefail
cd "$(dirname "$0")/.."
fixture_dir=$(mktemp -d "${TMPDIR:-/tmp}/aibro-ios-source.XXXXXX")
trap 'rm -rf "$fixture_dir"' EXIT
xcrun swiftc ios/App/App/WorkspaceDatabase.swift tests/native-storage.swift -o "$fixture_dir/storage-test"
"$fixture_dir/storage-test"
xcrun swiftc ios/App/App/SharedInbox.swift ios/Tests/SharedInboxFixture.swift -o "$fixture_dir/inbox-test"
"$fixture_dir/inbox-test"
