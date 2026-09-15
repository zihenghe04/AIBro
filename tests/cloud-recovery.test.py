"""Real process-exit recovery tests. All files and databases are disposable."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT = (Path(__file__).resolve().parents[1] / 'app')
sys.path.insert(0, str(ROOT))

# WorkspaceStore now performs startup recovery. Even server's module-level
# default store must therefore point to a fixture, never the user's data.
IS_WORKER = len(sys.argv) == 5 and sys.argv[1] == '--crash'
DEFAULT_FIXTURE = None if IS_WORKER else tempfile.TemporaryDirectory(prefix='cloud-recovery-module-test-')
DEFAULT_DIRECTORY = Path(sys.argv[2]) if IS_WORKER else Path(DEFAULT_FIXTURE.name)
os.environ['AI_WORKSTATION_DATA_DIR'] = str(DEFAULT_DIRECTORY / 'unused-default-store')
import server
from sync_store import COLLECTIONS

OLD_BYTES = b'original fixture PDF bytes'
NEW_BYTES = b'new cloud fixture PDF bytes'
NEW_HASH = hashlib.sha256(NEW_BYTES).hexdigest()
CRASH_EXIT = 87


def remote_change(existing):
    return {'seq': 6, 'entityType': 'imports', 'entityId': 'i', 'version': 2 if existing else 1,
            'deleted': False, 'data': {'id': 'i', 'name': 'new.pdf', 'mimeType': 'application/pdf',
                                     'blobHash': NEW_HASH, 'size': len(NEW_BYTES)}}


def crash_worker(directory, stage, existing):
    if stage == 'during-recovery':
        original_replace = server.os.replace
        def replace(source, target, *args, **kwargs):
            result = original_replace(source, target, *args, **kwargs)
            if Path(source).parent.name.startswith('.cloud-undo-') and Path(target).parent.name == 'files':
                os._exit(CRASH_EXIT)
            return result
        server.os.replace = replace
        server.WorkspaceStore(directory)
        raise AssertionError('Recovery crash hook was not reached')

    store = server.WorkspaceStore(directory)
    if stage == 'before-commit':
        real_connect = sqlite3.connect
        class ExitBeforeCommit(sqlite3.Connection):
            def commit(self):
                # Wiki reconciliation now reads the cache before publication.
                # Crash only at the commit which follows actual file staging.
                if list(Path(directory).glob('.cloud-undo-*')): os._exit(CRASH_EXIT)
                return super().commit()
        def connect(*args, **kwargs): return real_connect(*args, **kwargs, factory=ExitBeforeCommit)
        sqlite3.connect = connect
        # sqlite3 is shared with sync_store; readonly preflight commits may occur
        # before the remote file publication transaction.
    elif stage == 'after-commit':
        def finish(quarantine, committed):
            assert committed
            os._exit(CRASH_EXIT)
        store._finish_cloud_files = finish
    elif stage in ('first-manifest', 'second-manifest', 'after-blob-write'):
        atomic_write = store.atomic_write
        manifest_count = 0
        def write(path, data):
            nonlocal manifest_count
            result = atomic_write(path, data)
            path = Path(path)
            if path.name == 'journal.json':
                manifest_count += 1
                if stage == 'first-manifest' and manifest_count == 1 or stage == 'second-manifest' and manifest_count == 2:
                    os._exit(CRASH_EXIT)
            if stage == 'after-blob-write' and path.name == 'i' and path.parent.name == 'files': os._exit(CRASH_EXIT)
            return result
        store.atomic_write = write
    elif stage in ('first-journal-temp', 'second-journal-temp'):
        original_replace = server.os.replace
        manifest_count = 0
        def replace(source, target, *args, **kwargs):
            nonlocal manifest_count
            target = Path(target)
            if target.name == 'journal.json' and target.parent.name.startswith('.cloud-undo-'):
                manifest_count += 1
                if manifest_count == (1 if stage == 'first-journal-temp' else 2): os._exit(CRASH_EXIT)
            return original_replace(source, target, *args, **kwargs)
        server.os.replace = replace
    elif stage == 'during-cleanup':
        original_unlink = Path.unlink
        def unlink(path, *args, **kwargs):
            result = original_unlink(path, *args, **kwargs)
            if path.parent.name.startswith('.cloud-undo-') and path.name == 'i.meta.json': os._exit(CRASH_EXIT)
            return result
        Path.unlink = unlink
    else:
        raise AssertionError('Unknown fixture crash stage')
    store.apply_cloud_changes([remote_change(existing)], 6, blobs={NEW_HASH: NEW_BYTES})
    raise AssertionError('Transaction crash hook was not reached: ' + stage)


class CloudRecoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='workstation-crash-recovery-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def prepare(self, existing=True):
        directory = self.root / ('existing' if existing else 'new')
        store = server.WorkspaceStore(directory)
        state = {kind: [] for kind in COLLECTIONS}
        state.update(_revision=3, folders={'projects': [], 'conversations': []}, agentRuns=[])
        if existing:
            store.save_file('i', OLD_BYTES, 'original.pdf', 'application/pdf')
            state['imports'] = [{'id': 'i', 'name': 'original.pdf', 'mimeType': 'application/pdf'}]
        store.sync.capture(state)
        store.sync.ack([{'opId': op['opId'], 'entityType': op['entityType'], 'entityId': op['entityId'], 'version': 1}
                        for op in store.sync.pending()])
        store.sync.apply_changes([], 5)
        store._mirror(store.load())
        return directory, store.load(), self.sql_rows(directory), self.file_rows(directory)

    def crash(self, directory, stage, existing=True):
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--crash', str(directory), stage,
                                 'existing' if existing else 'new'], cwd=ROOT, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, CRASH_EXIT, msg=result.stdout + result.stderr)
        self.assertTrue(list(directory.glob('.cloud-undo-*')), 'Crash must leave a real pending file journal')

    def sql_rows(self, directory):
        with sqlite3.connect(directory / 'workspace.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            return {name: sorted(tuple(row) for row in db.execute('SELECT * FROM ' + name))
                    for name in ('meta', 'entities', 'outbox', 'sent', 'conflicts')}

    def file_rows(self, directory):
        files = directory / 'files'
        return {path.name: path.read_bytes() for path in files.iterdir() if path.is_file()} if files.exists() else {}

    def assert_uncommitted_recovered(self, prepared):
        directory, before_snapshot, before_sql, before_files = prepared
        recovered = server.WorkspaceStore(directory)
        self.assertEqual(recovered.load(), before_snapshot)
        self.assertEqual(recovered.sync.status()['cursor'], 5)
        self.assertEqual(self.sql_rows(directory), before_sql)
        self.assertEqual(self.file_rows(directory), before_files)
        self.assertEqual(list(directory.glob('.cloud-undo-*')), [])
        # Recovery is safe to repeat after another ordinary startup.
        self.assertEqual(server.WorkspaceStore(directory).load(), before_snapshot)

    def assert_committed_recovered(self, prepared):
        directory, before_snapshot, _, _ = prepared
        recovered = server.WorkspaceStore(directory)
        current = recovered.load()
        self.assertEqual(current['_revision'], before_snapshot['_revision'] + 1)
        self.assertEqual(current['imports'], [remote_change(bool(before_snapshot['imports']))['data']])
        self.assertEqual(recovered.sync.status()['cursor'], 6)
        self.assertEqual(recovered.sync.pending(), [])
        self.assertEqual(recovered.file_path('i').read_bytes(), NEW_BYTES)
        metadata = json.loads(recovered.file_path('i').with_suffix('.meta.json').read_text())
        self.assertEqual(metadata, {'name': 'new.pdf', 'mimeType': 'application/pdf', 'size': len(NEW_BYTES)})
        self.assertEqual(list(directory.glob('.cloud-undo-*')), [])
        self.assertFalse(any(row[0].startswith('filetx:') for row in self.sql_rows(directory)['meta']))
        self.assertEqual(server.WorkspaceStore(directory).load(), current)

    def test_exit_before_sql_commit_restores_existing_original_and_metadata(self):
        prepared = self.prepare()
        self.crash(prepared[0], 'before-commit')
        self.assert_uncommitted_recovered(prepared)

    def test_exit_before_sql_commit_removes_uncommitted_new_original_and_metadata(self):
        prepared = self.prepare(False)
        self.crash(prepared[0], 'before-commit', False)
        self.assert_uncommitted_recovered(prepared)

    def test_exit_after_commit_preserves_existing_replacement_and_cursor(self):
        prepared = self.prepare()
        self.crash(prepared[0], 'after-commit')
        self.assert_committed_recovered(prepared)

    def test_exit_after_commit_preserves_new_original_and_cursor(self):
        prepared = self.prepare(False)
        self.crash(prepared[0], 'after-commit', False)
        self.assert_committed_recovered(prepared)

    def test_manifest_before_first_rename_keeps_existing_file_untouched(self):
        prepared = self.prepare()
        self.crash(prepared[0], 'first-manifest')
        self.assert_uncommitted_recovered(prepared)

    def test_manifest_before_first_rename_does_not_invent_new_file(self):
        prepared = self.prepare(False)
        self.crash(prepared[0], 'first-manifest', False)
        self.assert_uncommitted_recovered(prepared)

    def test_manifest_written_before_metadata_rename_restores_partially_moved_pair(self):
        prepared = self.prepare()
        self.crash(prepared[0], 'second-manifest')
        self.assert_uncommitted_recovered(prepared)

    def test_exit_after_blob_write_before_metadata_write_restores_both(self):
        prepared = self.prepare()
        self.crash(prepared[0], 'after-blob-write')
        self.assert_uncommitted_recovered(prepared)

    def test_exit_during_committed_cleanup_resumes_without_rolling_back(self):
        prepared = self.prepare()
        self.crash(prepared[0], 'during-cleanup')
        self.assert_committed_recovered(prepared)

    def test_exit_during_recovery_can_be_recovered_again(self):
        prepared = self.prepare()
        self.crash(prepared[0], 'before-commit')
        self.crash(prepared[0], 'during-recovery')
        self.assert_uncommitted_recovered(prepared)

    def test_exit_before_first_journal_atomic_rename_does_not_block_startup(self):
        prepared = self.prepare()
        self.crash(prepared[0], 'first-journal-temp')
        self.assert_uncommitted_recovered(prepared)

    def test_exit_before_second_journal_atomic_rename_cleans_its_private_temporary(self):
        prepared = self.prepare()
        self.crash(prepared[0], 'second-journal-temp')
        self.assert_uncommitted_recovered(prepared)


if __name__ == '__main__':
    if IS_WORKER: crash_worker(sys.argv[2], sys.argv[3], sys.argv[4] == 'existing')
    else: unittest.main()
