const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('compact automatic canvas and home editor wheel have one real owner', {skip: process.platform !== 'darwin', timeout: 90000}, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-home-scroll-'));
  try {
    const binary = path.join(temp, 'checks');
    const sources = ['NativeQuickBentoGeometry.swift', 'NativeQuickCaptureScrollView.swift', 'NativeQuickCaptureTextEditor.swift', 'NativeQuickCaptureMarkup.swift']
      .map(name => path.join(root, 'native/Sources/AIBro', name));
    const build = spawnSync('xcrun', ['swiftc', '-swift-version', '5', ...sources,
      path.join(root, 'tests/native-quick-home-scroll.swift'), '-o', binary], {encoding: 'utf8', timeout: 60000});
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const run = spawnSync(binary, [], {encoding: 'utf8', timeout: 15000});
    process.stdout.write(run.stdout);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /real AppKit routing checks/);
  } finally { fs.rmSync(temp, {recursive: true, force: true}); }
});
