const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('Spotify cold start uses exact installation, explicit open, callback identity and cancellable readback', {
  skip: process.platform !== 'darwin', timeout: 65000,
}, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-spotify-launch-'));
  try {
    const binary = path.join(temp, 'launch-tests');
    const built = spawnSync('xcrun', ['swiftc', '-swift-version', '5', '-target', 'arm64-apple-macosx14.0',
      '-parse-as-library', path.join(root, 'native/Sources/AIBro/NativeQuickNowPlaying.swift'),
      path.join(__dirname, 'native-quick-spotify-launch.swift'), '-o', binary], { encoding: 'utf8', timeout: 50000 });
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    console.log(result.stdout.trim());
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /RESULT: (\d+)\/\1 Spotify launch checks passed/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
