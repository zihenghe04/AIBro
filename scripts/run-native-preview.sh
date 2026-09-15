#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT="$ROOT/../.aibro-native-preview.noindex/build"
mkdir -p "$OUT"
xcrun swiftc -parse-as-library -swift-version 5 -target "$(uname -m)-apple-macosx14.0" -O "$ROOT"/native/Sources/AIBro/*.swift -o "$OUT/AIBroNative" -framework SwiftUI -framework AppKit -framework WebKit -framework Charts
if [ "${1:-}" != '--build-only' ]; then
  AIBRO_SOURCE_ROOT="$ROOT" "$OUT/AIBroNative"
fi
