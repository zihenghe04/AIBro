const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
test('pure multi-display selection preserves anchors and follows explicit collapsed summons', {skip: process.platform !== 'darwin', timeout: 60000}, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-screen-selection-'));
  try {
    const binary = path.join(temporary, 'checks');
    const sources = ['NativeQuickScreenSelection.swift', 'NativeQuickPresentation.swift'].map(name => path.join(root, 'native/Sources/AIBro', name));
    const compiled = spawnSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', ...sources, path.join(root, 'tests/native-quick-screen-selection.swift'), '-o', binary], {encoding: 'utf8', timeout: 45000});
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const result = spawnSync(binary, [], {encoding: 'utf8', timeout: 10000});
    process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /32 screen selection assertions passed/);
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
});
