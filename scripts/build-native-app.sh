#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT=${AIBRO_NATIVE_OUT:?Set AIBRO_NATIVE_OUT to a staging .app path}
PYTHON_SOURCE=${AIBRO_PYTHON_SOURCE:-/Applications/AI Bro.app/Contents/Resources/python}
[ ! -e "$OUT" ] || { echo 'Staging destination must not exist.' >&2; exit 1; }
[ -x "$PYTHON_SOURCE/bin/python3" ]
"$ROOT/scripts/run-native-preview.sh" --build-only
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources/native/Resources"
cp "$ROOT/../.aibro-native-preview.noindex/build/AIBroNative" "$OUT/Contents/MacOS/AIBroNative"
node "$ROOT/scripts/copy-native-assets.js" "$OUT/Contents/Resources/app"
ditto "$PYTHON_SOURCE" "$OUT/Contents/Resources/python"
cp "$ROOT"/native/Resources/*.js "$ROOT"/native/Resources/*.css "$OUT/Contents/Resources/native/Resources/"
cp "$ROOT/app/ai-bro-icon.icns" "$OUT/Contents/Resources/ai-bro-icon.icns"
cp "$ROOT/LICENSE" "$OUT/Contents/Resources/LICENSE"
python3 - "$OUT" "$ROOT/package.json" <<'PY'
import plistlib,sys,pathlib,json
p=pathlib.Path(sys.argv[1])/'Contents'/'Info.plist'
package=json.loads(pathlib.Path(sys.argv[2]).read_text())
version=package['version']
major,minor,patch=map(int,version.split('.'))
build_number=package.get('nativeBuild',major*10000+minor*100+patch)
if type(build_number) is not int or build_number<1:
    raise SystemExit('nativeBuild must be a positive integer.')
build=str(build_number)
plistlib.dump(dict(CFBundleExecutable='AIBroNative',CFBundleIdentifier='app.ai-workstation.studio',CFBundleName='AI Bro',CFBundleDisplayName='AI Bro',CFBundlePackageType='APPL',CFBundleShortVersionString=version,CFBundleVersion=build,CFBundleIconFile='ai-bro-icon',LSMinimumSystemVersion='14.0',NSHighResolutionCapable=True,AIBroProduction=True,NSCameraUsageDescription='主动打开快捷工作台的镜子时使用摄像头；关闭镜子或收起后立即释放。',NSMicrophoneUsageDescription='主动开始录音时使用麦克风，并把音频保存在此 Mac。',NSSpeechRecognitionUsageDescription='主动选择转写录音时使用本机语音识别。',NSAppleEventsUsageDescription='主动连接 Spotify 后，读取正在播放的歌曲与艺人，并通过你点击的按钮控制播放、暂停和切歌。'),p.open('wb'))
PY
# Only the main App receives automation permission. Do not replace entitlements
# or signatures on the already signed embedded runtime with the App's rights.
codesign --force --sign - --entitlements "$ROOT/native/Entitlements.plist" "$OUT"
codesign --verify --deep --strict "$OUT"
echo "Built native application: $OUT"
