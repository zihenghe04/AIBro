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
import plistlib,sys,pathlib,json,os
p=pathlib.Path(sys.argv[1])/'Contents'/'Info.plist'
package=json.loads(pathlib.Path(sys.argv[2]).read_text())
version=package['version']
major,minor,patch=map(int,version.split('.'))
build_number=package.get('nativeBuild',major*10000+minor*100+patch)
if type(build_number) is not int or build_number<1:
    raise SystemExit('nativeBuild must be a positive integer.')
build=str(build_number)
# AIBRO_DEV_IDENTITY=1 builds a test copy with its own bundle id, name, data folder and Keychain service.
dev=os.environ.get('AIBRO_DEV_IDENTITY')=='1'
ident=dict(CFBundleIdentifier='app.ai-workstation.studio.dev',CFBundleName='AI Bro Dev',CFBundleDisplayName='AI Bro Dev',AIBroDevIdentity=True) if dev else dict(CFBundleIdentifier='app.ai-workstation.studio',CFBundleName='AI Bro',CFBundleDisplayName='AI Bro')
plistlib.dump(dict(CFBundleExecutable='AIBroNative',**ident,CFBundlePackageType='APPL',CFBundleShortVersionString=version,CFBundleVersion=build,CFBundleIconFile='ai-bro-icon',LSMinimumSystemVersion='14.0',NSHighResolutionCapable=True,AIBroProduction=True,NSCameraUsageDescription='主动打开快捷工作台的镜子时使用摄像头；关闭镜子或收起后立即释放。',NSMicrophoneUsageDescription='主动开始录音时使用麦克风，并把音频保存在此 Mac。',NSSpeechRecognitionUsageDescription='主动选择转写录音时使用本机语音识别。',NSAppleEventsUsageDescription='主动连接 Spotify 后，读取正在播放的歌曲与艺人，并通过你点击的按钮控制播放、暂停和切歌。'),p.open('wb'))
PY
# Only the main App receives automation permission. Do not replace entitlements
# or signatures on the already signed embedded runtime with the App's rights.
# A stable local identity keeps the designated requirement unchanged between
# builds, so privacy grants (Accessibility, microphone) survive updates. Create
# it once with scripts/setup-local-signing.sh; without it, sign ad-hoc.
SIGN_IDENTITY=${AIBRO_SIGN_IDENTITY:-}
if [ -z "$SIGN_IDENTITY" ]; then
  if /usr/bin/security find-identity -v -p codesigning 2>/dev/null | grep -q '"AI Bro Local Signing"'; then SIGN_IDENTITY="AI Bro Local Signing"; else SIGN_IDENTITY=-; fi
fi
codesign --force --sign "$SIGN_IDENTITY" --entitlements "$ROOT/native/Entitlements.plist" "$OUT"
codesign --verify --deep --strict "$OUT"
echo "Built native application: $OUT (signed with: $SIGN_IDENTITY)"
