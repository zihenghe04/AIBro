#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT_APP="${AI_WORKSTATION_OUT_APP:-$ROOT_DIR/AI Bro.app}"
# This is an existing application's display-name update, not a new identity.
APP_ID="app.ai-workstation.studio"

# Fail before touching an existing app if an HTML dependency is missing or
# absent from the shared HTTP/build manifest.
node "$ROOT_DIR/build-native-glass.js" --optional
node "$ROOT_DIR/app-assets.js"

# Validate both icon inputs before replacing an existing application bundle.
node - "$ROOT_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
for (const [name, signature] of [
  ['ai-bro-icon.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
  ['ai-bro-icon.icns', Buffer.from('icns')]
]) {
  let bytes;
  try { bytes = fs.readFileSync(path.join(root, name)); } catch (_) {
    console.error(`AI Bro 缺少应用图标：${name}；现有 App 未被改动。`);
    process.exit(1);
  }
  if (bytes.length < 8 || !bytes.subarray(0, signature.length).equals(signature) || (name.endsWith('.icns') && bytes.readUInt32BE(4) !== bytes.length)) {
    console.error(`AI Bro 应用图标格式无效：${name}；现有 App 未被改动。`);
    process.exit(1);
  }
}
NODE

if [ -n "${ELECTRON_APP:-}" ] && [ -d "$ELECTRON_APP" ]; then
  SOURCE_APP="$ELECTRON_APP"
elif [ -d "$ROOT_DIR/node_modules/electron/dist/Electron.app" ]; then
  SOURCE_APP="$ROOT_DIR/node_modules/electron/dist/Electron.app"
else
  echo "找不到 Electron.app。请设置 ELECTRON_APP=/path/to/Electron.app 后重试。" >&2
  exit 1
fi

# Replacing a live bundle unlinks the Python server's working directory and
# leaves the old renderer paired with broken/new assets. Quit before building.
node - "$OUT_APP" <<'NODE'
const path = require('path');
const { execFileSync } = require('child_process');
const executable = path.join(path.resolve(process.argv[2]), 'Contents/MacOS/Electron');
const commands = execFileSync('/bin/ps', ['-ax', '-o', 'command='], { encoding: 'utf8' }).split('\n');
if (commands.some(command => command.trim() === executable || command.trim().startsWith(executable + ' '))) {
  console.error('请先正常退出 AI Bro 再构建；运行中的 App 未被改动。');
  process.exit(1);
}
NODE

echo "复制 Electron runtime: $SOURCE_APP"
rm -rf "$OUT_APP"
ditto "$SOURCE_APP" "$OUT_APP"

# Electron expects the application entrypoint under Contents/Resources/app.
APP_DIR="$OUT_APP/Contents/Resources/app"
mkdir -p "$APP_DIR"
node "$ROOT_DIR/app-assets.js" --copy "$APP_DIR"
APP_VERSION=$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$ROOT_DIR/package.json")
cp "$ROOT_DIR/ai-bro-icon.icns" "$OUT_APP/Contents/Resources/ai-bro-icon.icns"

# Keep the runtime executable name used by Electron. Changing this filename
# makes LaunchServices reject some copied Electron bundles as executable-less.
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable Electron" "$OUT_APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName AI Bro" "$OUT_APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName AI Bro" "$OUT_APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile ai-bro-icon.icns" "$OUT_APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $APP_ID" "$OUT_APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $APP_VERSION" "$OUT_APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $APP_VERSION" "$OUT_APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity dict" "$OUT_APP/Contents/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true" "$OUT_APP/Contents/Info.plist" 2>/dev/null || true

# Ad-hoc signing is enough for a local developer build and prevents Finder
# from treating the copied bundle as damaged.
codesign --force --deep --sign - "$OUT_APP" >/dev/null

echo "Built: $OUT_APP"
echo "双击该文件即可启动；命令行也可运行：open \"$OUT_APP\""
