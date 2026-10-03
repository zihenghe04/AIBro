const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('Spotify status is unverified until passive discovery completes', {
  skip: process.platform !== 'darwin', timeout: 65000,
}, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-spotify-status-'));
  try {
    const source = process.env.AIBRO_SPOTIFY_STATUS_SOURCE || path.join(root, 'native/Sources/AIBro/NativeQuickNowPlaying.swift');
    const binary = path.join(temp, 'status-tests');
    const compiled = spawnSync('xcrun', ['swiftc', '-swift-version', '5', '-target', 'arm64-apple-macosx14.0',
      '-parse-as-library', source, path.join(__dirname, 'native-quick-spotify-status.swift'), '-o', binary],
    { encoding: 'utf8', timeout: 50000 });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 8000 });
    console.log(result.stdout.trim());
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
