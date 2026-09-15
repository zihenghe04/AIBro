#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT=${AIBRO_NATIVE_OUT:?Set AIBRO_NATIVE_OUT to a staging .app path}
PYTHON_SOURCE=${AIBRO_PYTHON_SOURCE:-$ROOT/AI Bro.app/Contents/Resources/python}
[ ! -e "$OUT" ] || { echo 'Staging destination must not exist.' >&2; exit 1; }
[ -x "$PYTHON_SOURCE/bin/python3" ]
"$ROOT/scripts/run-native-preview.sh" --build-only
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources/native/Resources"
cp "$ROOT/../.aibro-native-preview.noindex/build/AIBroNative" "$OUT/Contents/MacOS/AIBroNative"
node "$ROOT/app/app-assets.js" --copy "$OUT/Contents/Resources/app"
ditto "$PYTHON_SOURCE" "$OUT/Contents/Resources/python"
cp "$ROOT"/native/Resources/*.js "$ROOT"/native/Resources/*.css "$OUT/Contents/Resources/native/Resources/"
cp "$ROOT/app/ai-bro-icon.icns" "$OUT/Contents/Resources/ai-bro-icon.icns"
cp "$ROOT/LICENSE" "$OUT/Contents/Resources/LICENSE"
python3 - "$OUT" "$ROOT/package.json" <<'PY'
import plistlib,sys,pathlib,json
p=pathlib.Path(sys.argv[1])/'Contents'/'Info.plist'
version=json.loads(pathlib.Path(sys.argv[2]).read_text())['version']
major,minor,patch=map(int,version.split('.'))
build=str(major*10000+minor*100+patch)
plistlib.dump(dict(CFBundleExecutable='AIBroNative',CFBundleIdentifier='app.ai-workstation.studio',CFBundleName='AI Bro',CFBundleDisplayName='AI Bro',CFBundlePackageType='APPL',CFBundleShortVersionString=version,CFBundleVersion=build,CFBundleIconFile='ai-bro-icon',LSMinimumSystemVersion='14.0',NSHighResolutionCapable=True,AIBroProduction=True),p.open('wb'))
PY
codesign --force --deep --sign - "$OUT"
codesign --verify --deep --strict "$OUT"
echo "Built native application: $OUT"
