"""Save-path retention, VACUUM INTO backups and startup recovery on disposable fixtures."""
import copy
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

_host = tempfile.TemporaryDirectory(prefix='aibro-backup-test-host-')
os.environ.setdefault('AI_WORKSTATION_DATA_DIR', _host.name)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from server import WorkspaceStore
import sync_store
from sync_store import SyncStore, history_retained
import workspace_backup

DAY = 86400000


def fixture(text='Original evidence'):
    value = {key: [] for key in ('projects', 'tasks', 'notes', 'imports', 'conversations', 'trash', 'agentRuns', 'papers', 'links', 'attachments')}
    value.update(_revision=0, ui={})
    value['notes'] = [dict(id='note', title='Synthetic note', content=text, workspace='日常')]
    value['conversations'] = [dict(id='chat', title='Synthetic chat', messages=[dict(id=f'm{i}', text='Preserved transcript ' * 20, role='user') for i in range(20)])]
    return value


def stamp(seconds):
    return time.strftime('%Y%m%d-%H%M%S', time.localtime(seconds))


class HistoryRetentionTests(unittest.TestCase):
    def test_recent_window_then_one_per_day_within_the_daily_range(self):
        now = int(time.mktime((2026, 10, 22, 12, 0, 0, 0, 0, -1)) * 1000)
        entries = [('history:%d' % (100 - i), now - i * 60000, 10) for i in range(10)]          # today, recent
        entries += [('history:%d' % (90 - i), now - DAY - i * 60000, 10) for i in range(3)]      # yesterday x3
        entries += [('history:%d' % (87 - i), now - 2 * DAY - i * 60000, 10) for i in range(2)]  # two days ago x2
        entries += [('history:80', now - 5 * DAY, 10), ('history:79', None, 10)]               # too old, unknown time
        kept = history_retained(entries, now, recent=4, days=3, max_bytes=10**9, minimum=2)
        self.assertEqual(kept, {'history:100', 'history:99', 'history:98', 'history:97', 'history:90', 'history:87'})

    def test_defaults_keep_only_the_newest_four(self):
        self.assertEqual((sync_store.HISTORY_RECENT, sync_store.HISTORY_DAILY_DAYS, sync_store.HISTORY_MIN_KEEP), (4, 0, 3))
        now = int(time.time() * 1000)
        entries = [('history:%d' % (20 - i), now - i * DAY // 2, 10) for i in range(10)]
        self.assertEqual(history_retained(entries, now), {'history:20', 'history:19', 'history:18', 'history:17'})

    def test_byte_cap_drops_daily_first_then_recent_down_to_the_minimum(self):
        now = int(time.time() * 1000)
        entries = [('history:%d' % (10 - i), now - i * 1000, 10) for i in range(4)]
        entries += [('history:5', now - DAY, 10), ('history:4', now - 2 * DAY, 10)]
        self.assertEqual(history_retained(entries, now, recent=4, days=3, max_bytes=50, minimum=2), {'history:10', 'history:9', 'history:8', 'history:7', 'history:5'})
        self.assertEqual(history_retained(entries, now, recent=4, days=3, max_bytes=30, minimum=2), {'history:10', 'history:9', 'history:8'})
        self.assertEqual(history_retained(entries, now, recent=4, days=3, max_bytes=1, minimum=2), {'history:10', 'history:9'})

    def test_store_prunes_by_archive_time_and_backfills_legacy_rows_from_saved_at(self):
        import sync_store
        wide = lambda entries, now_ms: history_retained(entries, now_ms, recent=8, days=3)
        with tempfile.TemporaryDirectory() as temporary, patch.object(sync_store, 'history_retained', wide):
            store = SyncStore(Path(temporary))
            for revision in range(1, 13):
                store.capture({**fixture(str(revision)), '_revision': revision, '_savedAt': revision})
            now = int(time.time() * 1000)
            with store.db() as db:
                # Simulate rows written before historyTimes existed.
                db.execute("DELETE FROM meta WHERE key='historyTimes'")
                for revision in (1, 2):
                    db.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", ('history:%d' % revision, json.dumps({'_revision': revision, '_savedAt': now - DAY})))
            # Defaults keep only the newest four; widen the daily range for this
            # test so the legacy-row time backfill is still exercised.
            store.prune_history()
            with store.db() as db:
                kept = sorted(int(row[0][8:]) for row in db.execute("SELECT key FROM meta WHERE key LIKE 'history:%'"))
                times = store._get(db, 'historyTimes')
            # Eight recent baselines plus yesterday's newest legacy row.
            self.assertEqual(kept, [2] + list(range(4, 12)))
            self.assertEqual(times['history:2'], now - DAY)
            self.assertEqual(set(times), {'history:%d' % revision for revision in kept})


class StoreFixture(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='aibro-backup-test-')
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.store = WorkspaceStore(self.directory)
        self.store.ensure_sync()
        self.store.save(fixture())
        log = patch.object(workspace_backup, 'LOG_PATH', self.directory / 'backups' / 'backup.log')
        log.start(); self.addCleanup(log.stop)

    def backup_snapshot(self, path):
        connection = sqlite3.connect(path)
        try: return json.loads(connection.execute("SELECT value FROM meta WHERE key='snapshot'").fetchone()[0])
        finally: connection.close()


class BackupTests(StoreFixture):
    def test_vacuum_into_backup_is_verified_consistent_and_leaves_no_partial_file(self):
        path = workspace_backup.create(self.store)
        self.assertRegex(path.name, r'^workspace-\d{8}-\d{6}-r1-daily\.sqlite3$')
        self.assertTrue(workspace_backup.verify(path))
        self.assertEqual(self.backup_snapshot(path), self.store.sync.snapshot())
        self.assertEqual(oct(path.stat().st_mode & 0o777), '0o600')
        self.assertEqual([item.name for item in path.parent.iterdir() if item.name.startswith('.partial')], [])
        with patch.object(workspace_backup, 'verify', return_value=False):
            with self.assertRaises(sqlite3.DatabaseError): workspace_backup.create(self.store, now=time.time() + 5)
        self.assertEqual(len(workspace_backup.backups(path.parent)), 1, 'a backup that fails verification never counts')
        self.assertEqual([item.name for item in path.parent.iterdir() if item.name.startswith('.partial')], [])

    def test_low_disk_space_skips_the_backup(self):
        with patch.object(workspace_backup.shutil, 'disk_usage', return_value=type('Usage', (), {'free': 1})()):
            with self.assertRaises(OSError): workspace_backup.create(self.store)
        self.assertEqual(workspace_backup.backups(self.directory / 'backups'), [])

    def test_rotation_keeps_seven_daily_four_weekly_and_every_pre_migration_backup(self):
        folder = self.directory / 'backups'; folder.mkdir(exist_ok=True)
        base = time.mktime((2026, 10, 22, 3, 0, 0, 0, 0, -1))
        names = []
        for day in range(60):
            for hour in (0, 5):
                name = f'workspace-{stamp(base - day * 86400 + hour * 3600)}-r{1000 - day}-daily.sqlite3'
                (folder / name).write_bytes(b'x'); names.append(name)
        permanent = f'workspace-{stamp(base - 90 * 86400)}-r1-pre-migration.sqlite3'
        (folder / permanent).write_bytes(b'x')
        (folder / 'notes.txt').write_text('foreign file is never touched')
        removed, _ = workspace_backup.rotate(folder)
        kept = {path.name: created for path, created, _ in workspace_backup.backups(folder)}
        self.assertIn(permanent, kept)
        self.assertTrue((folder / 'notes.txt').exists())
        daily = sorted((c for n, c in kept.items() if n.endswith('-daily.sqlite3')), reverse=True)
        self.assertEqual(len(daily), 11)
        # The newest of each of the last seven days ...
        self.assertEqual(daily[:7], [base - day * 86400 + 5 * 3600 for day in range(7)])
        # ... then one per ISO week, four distinct weeks older than those days.
        weeks = [time.strftime('%G-W%V', time.localtime(c)) for c in daily[7:]]
        self.assertEqual(len(set(weeks)), 4)
        recent_weeks = {time.strftime('%G-W%V', time.localtime(c)) for c in daily[:7]}
        self.assertFalse(set(weeks) & recent_weeks)
        self.assertEqual(len(removed), len(names) - 11)

    def test_size_guideline_is_logged(self):
        with patch.object(workspace_backup, 'SIZE_WARNING_BYTES', 1):
            workspace_backup.create(self.store)
            workspace_backup.rotate(self.directory / 'backups')
        self.assertIn('above the', (self.directory / 'backups' / 'backup.log').read_text())

    def test_automatic_backup_runs_once_per_interval(self):
        now = time.time()
        first = workspace_backup.automatic(self.store, now)
        self.assertIsNotNone(first)
        self.assertIsNone(workspace_backup.automatic(self.store, now + 3600))
        self.assertIsNotNone(workspace_backup.automatic(self.store, now + workspace_backup.BACKUP_INTERVAL_SECONDS + 1))


class StartupRecoveryTests(StoreFixture):
    def corrupt(self):
        with self.store.sync.maintenance() as db: db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        data = bytearray(self.store.sync.path.read_bytes())
        data[100:4096 * 2] = b'\xff' * (4096 * 2 - 100)
        self.store.sync.path.write_bytes(bytes(data))
        return bytes(data)

    def test_healthy_database_is_left_alone(self):
        before = self.store.sync.path.read_bytes()
        self.assertEqual(self.store.startup_check(), {'status': 'ok'})
        self.assertEqual(self.store.sync.path.read_bytes(), before)

    def test_corrupt_database_without_backup_is_reported_and_kept_in_place(self):
        damaged = self.corrupt()
        result = self.store.startup_check()
        self.assertEqual(result['status'], 'corrupt')
        self.assertEqual(self.store.sync.path.read_bytes(), damaged)
        self.assertFalse((self.directory / 'recovery').exists())
        self.assertIn('quick_check failed', (self.directory / 'backups' / 'backup.log').read_text())

    def test_corrupt_database_restores_newest_verified_backup_and_keeps_the_damaged_original(self):
        good = workspace_backup.create(self.store, now=time.time() - 7200)
        # A newer backup that is itself damaged must be skipped.
        bad = self.directory / 'backups' / f'workspace-{stamp(time.time() - 60)}-r9-daily.sqlite3'
        bad.write_bytes(b'not a database')
        newer = fixture('Edited after the backup'); newer['_revision'] = 1
        self.store.save(newer)
        damaged = self.corrupt()
        result = self.store.startup_check()
        self.assertEqual(result['status'], 'restored')
        self.assertEqual(result['backup'], good.name)
        quarantine = Path(result['quarantine'])
        self.assertEqual((quarantine / 'workspace.sqlite3').read_bytes(), damaged)
        self.assertEqual(json.loads((quarantine / 'restore.json').read_text())['restoredFrom'], good.name)
        self.assertTrue(workspace_backup.quick_check(self.store.sync.path)[0])
        # The workspace.json mirror was newer than the backup and is replayed.
        self.assertEqual(result['replayedMirrorRevision'], 2)
        loaded = self.store.load()
        self.assertEqual(loaded['notes'][0]['content'], 'Edited after the backup')
        self.assertEqual(loaded['_revision'], 2)
        self.assertTrue(bad.exists(), 'a damaged backup is skipped, not deleted')

    def test_malformed_mirror_is_not_replayed(self):
        workspace_backup.create(self.store)
        self.corrupt()
        self.store.path.write_text('{broken')
        result = self.store.startup_check()
        self.assertEqual(result['status'], 'restored')
        self.assertNotIn('replayedMirrorRevision', result)
        self.assertEqual(self.store.sync.snapshot()['notes'][0]['content'], 'Original evidence')


class MaintenanceTests(StoreFixture):
    def history_count(self):
        with self.store.sync.db() as db:
            return db.execute("SELECT count(*) FROM meta WHERE key LIKE 'history:%'").fetchone()[0]

    def seed_history(self, count=20):
        with self.store.sync.db() as db:
            for revision in range(100, 100 + count):
                db.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", ('history:%d' % revision, json.dumps({'_revision': revision, 'pad': 'x' * 50000})))

    def test_cleanup_and_vacuum_only_after_a_verified_backup(self):
        self.seed_history()
        before = self.history_count()
        with patch.object(workspace_backup, 'verify', return_value=False), \
             patch.object(self.store.sync, 'prune_history', side_effect=AssertionError('pruned without a backup')):
            self.store.upkeep()
        self.assertEqual(self.history_count(), before)
        self.assertIsNone(self.store.sync.meta('maintenance:historyRetentionV1'))
        self.assertIn('maintenance skipped', (self.directory / 'backups' / 'backup.log').read_text())

    def test_one_time_cleanup_backs_up_prunes_vacuums_and_records_completion(self):
        self.seed_history()
        before = self.history_count()
        snapshot = self.store.sync.snapshot()
        size = self.store.sync.path.stat().st_size
        self.store.upkeep()
        marker = self.store.sync.meta('maintenance:historyRetentionV1')
        # Only the newest four (the merge window) stay; no extra daily restore points.
        self.assertEqual(marker['removedHistory'], before - sync_store.HISTORY_RECENT)
        permanent = self.directory / 'backups' / marker['backup']
        self.assertTrue(permanent.name.endswith('-pre-migration.sqlite3') and workspace_backup.verify(permanent))
        with sqlite3.connect(permanent) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM meta WHERE key LIKE 'history:%'").fetchone()[0], before)
        self.assertEqual(self.history_count(), sync_store.HISTORY_RECENT)
        self.assertLess(self.store.sync.path.stat().st_size, size)
        self.assertEqual(self.store.sync.snapshot(), snapshot)
        # The fresh pre-migration copy also stands in for today's daily backup.
        kinds = sorted(kind for _, _, kind in workspace_backup.backups(self.directory / 'backups'))
        self.assertEqual(kinds, ['pre-migration'])
        # Later runs neither repeat the cleanup nor make a second daily backup.
        with patch.object(self.store.sync, 'prune_history', side_effect=AssertionError('cleanup repeated')):
            self.store.upkeep()
        self.assertEqual(len(workspace_backup.backups(self.directory / 'backups')), 1)


class SavePathTests(unittest.TestCase):
    def test_save_writes_no_previous_copy_and_keeps_snapshot_mirror_and_history_identical(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = WorkspaceStore(Path(temporary))
            store.ensure_sync()
            payload = fixture()
            first = store.save(copy.deepcopy(payload))
            baseline = store.load()
            edited = copy.deepcopy(baseline); edited['notes'][0]['content'] = 'Second revision'
            second = store.save(edited)
            self.assertFalse((Path(temporary) / 'workspace.previous.json').exists())
            current = store.load()
            self.assertEqual(json.loads(store.path.read_text()), current, 'workspace.json mirror matches the committed snapshot')
            self.assertEqual(store.sync.snapshot_at(first['revision']), baseline, 'the previous revision stays recoverable from history')
            expected = copy.deepcopy(edited); expected.update(_revision=second['revision'], _savedAt=second['savedAt'])
            for key in ('_wikiEnabled', '_mergeBase'): current.pop(key, None); expected.pop(key, None)
            self.assertEqual(current, expected)


if __name__ == '__main__':
    unittest.main(verbosity=2)
