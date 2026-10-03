const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
test('file shelf copies a complete checked URL batch, owns Cmd-C and rejects stale work', {skip: process.platform !== 'darwin', timeout: 100000}, () => {
  const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-shelf-copy-'));
  try {
    const binary = path.join(dir, 'checks');
    const sources = ['NativeQuickFileShelf', 'NativeQuickFileShelfView', 'NativeQuickFileShelfPreview', 'NativeQuickClipboard', 'NativeQuickClipboardArchive'].map(name => path.join(root, 'native/Sources/AIBro', name + '.swift'));
    const build = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', ...sources, path.join(__dirname, 'native-quick-file-shelf-copy.swift'), '-o', binary], {encoding:'utf8', timeout:65000});
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const run = spawnSync(binary, [dir], {encoding:'utf8', timeout:30000});
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /PASS: \d+ shelf copy checks/);
    console.log(run.stdout.trim());
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});
