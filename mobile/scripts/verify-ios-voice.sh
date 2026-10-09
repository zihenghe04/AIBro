#!/bin/bash
# Pure Swift lifecycle fixtures: no Simulator, microphone, network, or accounts.
set -euo pipefail
cd "$(dirname "$0")/.."
fixture_dir=$(mktemp -d "${TMPDIR:-/tmp}/aibro-voice-check.XXXXXX")
trap 'rm -rf "$fixture_dir"' EXIT
xcrun swiftc ios/App/App/VoiceCaptureCore.swift ios/App/App/VoiceShortcutInbox.swift \
  ios/Tests/VoiceCaptureFixture.swift -o "$fixture_dir/voice-test"
"$fixture_dir/voice-test"
