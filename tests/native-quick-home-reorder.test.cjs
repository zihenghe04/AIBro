const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('home long-press cancellation, target exchange, persistence and AppKit control passthrough', {skip: process.platform !== 'darwin', timeout: 90000}, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-home-reorder-'));
  try {
    const binary = path.join(temporary, 'checks');
    const files = ['NativeQuickHomeReorder.swift', 'NativeQuickHomeReorderSurface.swift', 'NativeQuickPanelPreferences.swift'].map(file => path.join(root, 'native/Sources/AIBro', file));
    const compiled = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', ...files, path.join(root, 'tests/native-quick-home-reorder.swift'), '-o', binary], {encoding: 'utf8', timeout: 60000});
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const run = spawnSync(binary, [], {encoding: 'utf8', timeout: 15000});
    process.stdout.write(run.stdout);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /home reorder assertions; hidden-window checks/);
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
});
