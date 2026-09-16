#!/bin/zsh
# Run after Xcode has resolved/built Capacitor. This is NOT an app/runtime acceptance test.
set -euo pipefail
cd "${0:A:h}/.."
xcrun swiftc ios/App/App/WorkspaceDatabase.swift tests/native-storage.swift -o "${TMPDIR:-/tmp}/aibro-mobile-storage-test"
"${TMPDIR:-/tmp}/aibro-mobile-storage-test"
xcodebuild -project ios/App/App.xcodeproj -target ShareExtension -configuration Debug -sdk iphoneos CODE_SIGNING_ALLOWED=NO SYMROOT="${TMPDIR:-/tmp}/aibro-mobile-share-build" build
