#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Distribution is explicit: re-signable unsigned package or a developer-signed archive.
# Never copy provisioning profiles or certificates into the repository.
mode="${1:-unsigned}"
output="${AIBRO_IOS_OUTPUT:-$PWD/build/ios}"
version=$(node -p "require('./package.json').version")
ipa_name="AI-Bro-${version}-unsigned.ipa"
mkdir -p "$output"
npm run ios:sync
if [[ "$mode" == "signed" ]]; then
  : "${AIBRO_TEAM_ID:?Set AIBRO_TEAM_ID to the selected Apple Developer team}"
  : "${AIBRO_EXPORT_OPTIONS:?Set AIBRO_EXPORT_OPTIONS to the export options plist}"
  xcodebuild -project ios/App/App.xcodeproj -scheme App -jobs 2 -configuration Release -destination 'generic/platform=iOS' -archivePath "$output/AI-Bro.xcarchive" DEVELOPMENT_TEAM="$AIBRO_TEAM_ID" -allowProvisioningUpdates archive
  xcodebuild -exportArchive -archivePath "$output/AI-Bro.xcarchive" -exportOptionsPlist "$AIBRO_EXPORT_OPTIONS" -exportPath "$output/signed" -allowProvisioningUpdates
elif [[ "$mode" == "unsigned" ]]; then
  xcodebuild -project ios/App/App.xcodeproj -scheme App -jobs 2 -configuration Release -destination 'generic/platform=iOS' -archivePath "$output/AI-Bro-unsigned.xcarchive" CODE_SIGNING_ALLOWED=NO archive
  staging=$(mktemp -d "${TMPDIR:-/tmp}/aibro-ipa.XXXXXX")
  trap 'rm -rf "$staging"' EXIT
  mkdir -p "$staging/Payload"
  ditto "$output/AI-Bro-unsigned.xcarchive/Products/Applications/App.app" "$staging/Payload/AI Bro.app"
  (cd "$staging" && /usr/bin/zip -qry "$staging/${ipa_name}" Payload)
  # Replace the archive; updating an existing ZIP would retain obsolete JS bundles.
  mv "$staging/${ipa_name}" "$output/${ipa_name}"
  /usr/bin/shasum -a 256 "$output/${ipa_name}" > "$output/SHA256SUMS.txt"
  python3 scripts/verify-ipa.py "$output/${ipa_name}" > "$output/verification.json"
  mkdir -p "$output/Signing"
  cp ios/App/App/App.entitlements "$output/Signing/App.entitlements"
  cp ios/App/ShareExtension/ShareExtension.entitlements "$output/Signing/ShareExtension.entitlements"
  cp ios/App/TodayWidget/TodayWidget.entitlements "$output/Signing/TodayWidget.entitlements"
  cp docs/INSTALL.md "$output/INSTALL.md"
  printf 'Unsigned IPA prepared for external signing: %s\n' "$output/${ipa_name}"
else
  printf 'Usage: %s unsigned|signed\n' "$0" >&2
  exit 2
fi
