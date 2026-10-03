const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('clipboard feedback uses a local typed route with owner/privacy revocation', { skip: process.platform !== 'darwin', timeout: 90000 }, () => {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-clipboard-notification-'));
  try {
    const binary = path.join(temp, 'check');
    const sources = ['NativeQuickNotificationQueue.swift', 'NativeQuickNotificationSources.swift', 'NativeQuickNotificationPanel.swift']
      .map(name => path.join(root, 'native/Sources/AIBro', name));
    const build = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', ...sources,
      path.join(__dirname, 'native-quick-clipboard-notification.swift'), '-o', binary], { encoding: 'utf8', timeout: 70000 });
    assert.equal(build.status, 0, build.stdout + build.stderr + (build.error?.message || ''));
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, run.stdout + run.stderr + (run.error?.message || ''));
    assert.match(run.stdout, /PASS: \d+ clipboard feedback assertions/);
    console.log(run.stdout.trim());
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
