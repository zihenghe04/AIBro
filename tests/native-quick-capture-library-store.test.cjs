const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');

// This compiles the production controller and changes only its workspace
// request callback. Every scenario owns an isolated temporary draft directory.
// It does not launch the app or read/write any real user's notes.
test('production capture library keeps edits durable, versioned, and separate from published notes', {
  skip: process.platform !== 'darwin', timeout: 180000,
}, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-capture-library-store-'));
  try {
    const binary = path.join(temporary, 'library-tests');
    const compiled = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5',
      path.join(root, 'native/Sources/AIBro/NativeQuickRecordFocus.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickCaptureStore.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickCaptureLibraryStore.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickCaptureMarkup.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickCaptureScrollView.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickCaptureTextEditor.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickCaptureLibraryView.swift'),
      path.join(__dirname, 'native-quick-capture-library-store.swift'), '-o', binary,
    ], {encoding: 'utf8', timeout: 90000});
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    for (const name of [
      'draft-restart', 'pending-before-request', 'lost-ack-restart', 'wrong-ack',
      'conflict-retains-draft', 'disk-error-before-request', 'disk-error-after-ack',
      'privacy-during-read', 'privacy-during-save', 'stale-query',
      'corrupt-file-readonly', 'workspace-rebind', 'no-second-notes-database',
      'independent-title-restart', 'title-validation-and-ack', 'legacy-title-free-retry', 'invalid-title-draft-restart',
      'delete-durable-before-request', 'delete-lost-ack-restart', 'restore-exact-ack',
      'lifecycle-disk-failures', 'dirty-editor-delete-guard', 'privacy-during-delete',
      'lifecycle-recovery-record', 'stale-trash-read',
    ]) {
      await t.test(name, () => {
        const result = spawnSync(binary, [name, path.join(temporary, name)], {encoding: 'utf8', timeout: 15000});
        assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message ?? ''));
        assert.ok(result.stdout.includes('PASS: ' + name), result.stdout);
      });
    }
  } finally {
    fs.rmSync(temporary, {recursive: true, force: true});
  }
});
