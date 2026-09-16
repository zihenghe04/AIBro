#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."
npm run build
npx cap sync ios
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath "${TMPDIR:-/tmp}/aibro-mobile-build" CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- build
