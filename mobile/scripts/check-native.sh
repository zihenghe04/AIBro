#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${AIBRO_IOS_SKIP_SYNC:-0}" != "1" ]]; then npm run ios:sync; fi
derived_data="${AIBRO_IOS_DERIVED_DATA:-$PWD/build/ios/DerivedData}"
action="${AIBRO_IOS_ACTION:-build}"
if [[ "$action" != "build" && "$action" != "build-for-testing" ]]; then
  printf 'AIBRO_IOS_ACTION must be build or build-for-testing. This script never starts a simulator.\n' >&2
  exit 2
fi
xcodebuild -project ios/App/App.xcodeproj -scheme App \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$derived_data" -jobs "${AIBRO_IOS_JOBS:-2}" \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- "$action"
printf '\nSimulator app: %s/Build/Products/Debug-iphonesimulator/App.app\n' "$derived_data"
