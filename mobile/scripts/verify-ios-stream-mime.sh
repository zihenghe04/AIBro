#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
fixture_dir=$(mktemp -d "${TMPDIR:-/tmp}/aibro-ios-stream-mime.XXXXXX")
trap 'rm -rf "$fixture_dir"' EXIT
xcrun swiftc ios/App/App/NativeRequestStream.swift ios/Tests/NativeStreamMIMEFixture.swift -o "$fixture_dir/mime-test"
"$fixture_dir/mime-test"
