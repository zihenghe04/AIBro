"""Canonical SQLite/outbox regression tests, using only disposable fixtures."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sync_store import COLLECTIONS, SyncStore, copy, project


def workspace(**values):
    state = {kind: [] for kind in COLLECTIONS}
    state.update(folders={'projects': [], 'conversations': []}, agentRuns=[], _revision=1)
    state.update(values)
    return state


def note(text='first', identifier='shared'):
    return {'id': identifier, 'title': 'Fixture note', 'content': text, 'workspace': '日常'}


def change(data=None, version=1, kind='notes', identifier='shared', deleted=False):
    return {'seq': version, 'entityType': kind, 'entityId': identifier,
            'version': version, 'deleted': deleted, 'data': data}


def accepted(operation, version):
    return {key: operation[key] for key in ('opId', 'entityType', 'entityId')} | {'version': version}


def explode(_):
    raise OSError('fixture before_commit failure')


class SyncStoreTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='workstation-sync-store-test-')
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.store = SyncStore(self.directory / 'device-a')

    def test_task_schedule_survives_outbox_and_second_device(self):
        task = {'id': 'scheduled-task', 'title': 'Review course notes', 'workspace': '课程',
                'status': 'todo', 'startAt': '2026-09-12', 'dueAt': '2026-09-15',
                'sourceAttachmentIds': ['lecture-pdf']}
        self.store.capture(workspace(tasks=[task]))
        operations = self.store.pending()
        peer = SyncStore(self.directory / 'device-b')
        peer.capture(workspace())
        peer.apply_changes([{**operation, 'version': 1, 'seq': index + 1}
                            for index, operation in enumerate(operations)], len(operations))
        received = peer.snapshot()['tasks'][0]
        self.assertEqual(received['startAt'], task['startAt'])
        self.assertEqual(received['dueAt'], task['dueAt'])
        self.assertEqual(received['sourceAttachmentIds'], ['lecture-pdf'])

    def test_attachment_analysis_provenance_survives_sync_without_local_run_logs(self):
        material = {'id': 'lecture', 'name': 'lecture.pdf', 'workspace': '课程',
                    'importOrigin': 'project', 'analysis': {'status': 'analyzed', 'runId': 'ai-run',
                    'analyzedAt': 123456, 'noteIds': ['analysis-note'], 'paperIds': []}}
        self.store.capture(workspace(imports=[material], notes=[note('Structured review', 'analysis-note')]))
        operations = self.store.pending()
        peer = SyncStore(self.directory / 'analysis-peer')
        peer.capture(workspace())
        peer.apply_changes([{**op, 'version': 1, 'seq': index + 1}
                            for index, op in enumerate(operations)], len(operations))
        received = peer.snapshot()['imports'][0]
        self.assertEqual(received['analysis'], material['analysis'])
        self.assertEqual(received['importOrigin'], 'project')
        self.assertEqual(peer.snapshot()['agentRuns'], [])

    def test_consolidated_markdown_aliases_backlinks_and_recoverable_originals_sync_without_secrets(self):
        master = {**note('Human consolidated body', 'master'), 'userEdited': True, 'userEditedAt': 100,
            'mergedNoteIds': ['fragment'], 'sourceNoteIds': ['prior'], 'relatedNoteIds': ['sibling'],
            'sourceAttachmentIds': ['source-a', 'source-b'],
            'consolidatedSections': [{'noteId': 'fragment', 'title': 'Methods', 'sourceAttachmentIds': ['source-b'], 'userEdited': False}],
            'revisionHistory': [{'content': 'Original main body', 'savedAt': 100}],
            'aiDraft': {'title': 'Suggested', 'content': 'Pending suggestion', 'createdAt': 200}}
        original = {**note('Complete recoverable original', 'fragment'), 'userEdited': True,
                    'revisionHistory': [{'content': 'Earlier fragment'}], 'aiDraft': {'content': 'Unaccepted fragment draft'}}
        consolidation = {'canonicalId': 'master', 'mergedAt': 100, 'sections': master['consolidatedSections'],
            'linkHistory': [{'id': 'old-link', 'sourceId': 'source-b', 'targetId': 'fragment'}],
            'rewired': [{'collection': 'tasks', 'id': 'task', 'field': 'sourceNoteIds', 'before': ['fragment']}],
            'credentials': 'must not leave device', 'localFolder': {'path': '/private/local/path'}}
        trashed = {'id': 'merged-trash', 'type': 'content', 'title': 'Original fragments', 'deletedAt': 100,
            'data': {'notes': [original], 'consolidation': consolidation}}
        self.store.capture(workspace(notes=[master], tasks=[{'id': 'task', 'sourceNoteIds': ['master']}], trash=[trashed]))
        operations = self.store.pending()
        self.assertNotIn('must not leave device', json.dumps(operations))
        self.assertNotIn('/private/local/path', json.dumps(operations))
        peer = SyncStore(self.directory / 'consolidation-peer'); peer.capture(workspace())
        peer.apply_changes([{**op, 'version': 1, 'seq': index + 1} for index, op in enumerate(operations)], len(operations))
        received = peer.snapshot()
        self.assertEqual(received['notes'][0], master)
        self.assertEqual(received['tasks'][0]['sourceNoteIds'], ['master'])
        self.assertEqual(received['trash'][0]['data']['notes'], [original])
        self.assertEqual(received['trash'][0]['data']['consolidation'],
                         {key: value for key, value in consolidation.items() if key not in ('credentials', 'localFolder')})

    def test_extended_paper_analysis_and_per_section_confidence_survive_outbox_and_second_device(self):
        paper = {'id': 'typed-paper', 'title': 'A benchmark study', 'paperType': 'benchmark',
                 'workspace': '科研', 'noteId': 'master', 'reviewed': False,
                 'sourceAttachmentIds': ['pdf'],
                 'structured': {key: {'text': f'EVIDENCE_{key}', 'citations': [{'attachmentId': 'pdf', 'page': 2}]}
                     for key in ('training', 'relatedWork', 'criticalAnalysis', 'counterArguments', 'dataGaps', 'reproduction')},
                 'confidence': {'overall': 'medium', 'reason': 'Missing code', 'training': {'level': 'low'}, 'experiments': 0.6}}
        self.store.capture(workspace(papers=[paper], notes=[note('One complete master note', 'master')]))
        operations = self.store.pending()
        peer = SyncStore(self.directory / 'typed-paper-peer'); peer.capture(workspace())
        peer.apply_changes([{**op, 'version': 1, 'seq': index + 1} for index, op in enumerate(operations)], len(operations))
        self.assertEqual(peer.snapshot()['papers'], [paper])
        self.assertEqual(len(peer.snapshot()['notes']), 1)

    def database_rows(self, store=None):
        target = store or self.store
        with target.db() as db:
            return {table: sorted(tuple(row) for row in db.execute('SELECT * FROM ' + table))
                    for table in ('meta', 'entities', 'outbox', 'sent', 'conflicts')}

    def synced(self, data=None, store=None):
        target = store or self.store
        target.capture(workspace(notes=[data or note()]))
        operation = target.pending()[0]
        target.ack([accepted(operation, 1)])
        return operation

    def test_capture_and_outbox_rollback_together_when_callback_fails(self):
        self.synced()
        before = self.database_rows()
        with self.assertRaises(OSError):
            self.store.capture(workspace(notes=[note('uncommitted')], tasks=[{'id': 'new-task'}]), before_commit=explode)
        self.assertEqual(self.database_rows(), before)
        self.assertEqual(SyncStore(self.store.directory).snapshot()['notes'][0]['content'], 'first')

    def test_first_capture_failure_does_not_publish_snapshot_or_operations(self):
        with self.assertRaises(OSError): self.store.capture(workspace(notes=[note()]), before_commit=explode)
        self.assertIsNone(self.store.snapshot())
        self.assertEqual(self.store.pending(), [])

    def test_remote_application_rolls_back_snapshot_cursor_and_entities(self):
        self.synced()
        before = self.database_rows()
        with self.assertRaises(OSError):
            self.store.apply_changes([change(note('remote'), 2)], 9, before_commit=explode)
        self.assertEqual(self.database_rows(), before)
        result = self.store.apply_changes([change(note('remote'), 2)], 9)
        self.assertTrue(result['changed'])
        self.assertEqual(self.store.snapshot()['notes'][0]['content'], 'remote')
        self.assertEqual(self.store.status()['cursor'], 9)
        self.assertEqual(self.store.pending(), [])

    def test_conflict_resolution_callback_failure_rolls_back_choice(self):
        self.synced()
        self.store.capture(workspace(notes=[note('local')]))
        self.store.apply_changes([change(note('remote'), 2)], 2)
        conflict = self.store.conflicts()[0]
        before = self.database_rows()
        with self.assertRaises(OSError): self.store.resolve_conflict(conflict['id'], 'remote', before_commit=explode)
        self.assertEqual(self.database_rows(), before)
        self.store.resolve_conflict(conflict['id'], 'remote')
        self.assertEqual(self.store.snapshot()['notes'][0]['content'], 'remote')
        self.assertEqual(self.store.status()['conflicts'], 0)

    def test_ids_are_typed_and_message_and_folder_wire_ids_are_stable(self):
        state = workspace(notes=[note(identifier='same')], tasks=[{'id': 'same'}],
                          conversations=[{'id': 'c1', 'messages': [{'id': 'same', 'text': 'one'}]},
                                         {'id': 'c2', 'messages': [{'id': 'same', 'text': 'two'}]}],
                          folders={'projects': [{'id': 'same', 'name': 'P'}], 'conversations': [{'id': 'same', 'name': 'C'}]})
        self.store.capture(state)
        first = self.store.pending()
        projected = project(state)
        self.assertIn(('notes', 'same'), projected)
        self.assertIn(('tasks', 'same'), projected)
        self.assertEqual(len([key for key in projected if key[0] == 'messages']), 2)
        self.assertEqual(len([key for key in projected if key[0] == 'folders']), 2)
        self.store.capture(copy(state))
        self.assertEqual(SyncStore(self.store.directory).pending(), first)

    def test_legacy_ids_are_assigned_once_and_survive_restart(self):
        state = workspace(notes=[{'title': 'legacy'}], conversations=[{'messages': [{'text': 'legacy message'}]}],
                          folders={'projects': [{'name': 'legacy folder'}], 'conversations': []})
        captured = self.store.capture(state)
        self.assertNotIn('id', state['notes'][0])
        pending = self.store.pending()
        restarted = SyncStore(self.store.directory)
        restarted.capture(restarted.snapshot())
        self.assertEqual(restarted.snapshot(), captured)
        self.assertEqual(restarted.pending(), pending)

    def test_duplicate_record_ids_fail_without_partial_changes(self):
        self.synced()
        before = self.database_rows()
        with self.assertRaises(ValueError): self.store.capture(workspace(notes=[note(), note('duplicate')]))
        self.assertEqual(self.database_rows(), before)

    def test_duplicate_message_ids_are_rejected_instead_of_silently_dropping_text(self):
        with self.assertRaises(ValueError):
            self.store.capture(workspace(conversations=[{'id': 'c', 'messages': [
                {'id': 'm', 'text': 'first'}, {'id': 'm', 'text': 'second'}]}]))

    def test_duplicate_folder_ids_are_rejected_instead_of_silently_dropping_folders(self):
        with self.assertRaises(ValueError):
            self.store.capture(workspace(folders={'projects': [{'id': 'f', 'name': 'first'},
                                                              {'id': 'f', 'name': 'second'}], 'conversations': []}))

    def test_device_only_fields_stay_local_and_nested_secrets_never_enter_outbox(self):
        secret = 'fixture-secret-value'
        local = {'id': 'p', 'name': 'Personal site', 'localFolder': {'path': '/private/fixture'},
                 'permissions': {'write': True}, 'apiKey': secret}
        state = workspace(projects=[local], notes=[{**note(), 'revisionHistory': [
            {'content': 'retained text', 'authorization': secret, 'client_secret': secret, 'rootPath': '/private/fixture'}]}],
            imports=[{'id': 'i', 'name': 'fixture.pdf', 'content': 'Extracted text', 'dataUrl': 'data:fixture-base64',
                      'rawBase64': 'fixture-base64', 'localPath': '/private/fixture'}],
            trash=[{'id': 'bin', 'type': 'project', 'data': {'projects': [local]}}],
            credentials={'token': secret}, permissionMode='full-access', agentRuns=[{'id': 'run', 'token': secret}])
        captured = self.store.capture(state)
        self.assertEqual(captured['credentials']['token'], secret)
        self.assertEqual(captured['projects'][0]['localFolder'], local['localFolder'])
        encoded = json.dumps(self.store.pending(), ensure_ascii=False)
        for forbidden in (secret, '/private/fixture', 'fixture-base64', 'localFolder', 'permissionMode', 'rawBase64'):
            self.assertNotIn(forbidden, encoded)
        self.assertIn('Extracted text', encoded)
        self.assertIn('retained text', encoded)

    def test_incoming_projection_cannot_change_local_credentials_or_directory_binding(self):
        state = workspace(projects=[{'id': 'p', 'name': 'before', 'localFolder': {'path': '/local/fixture'}}],
                          credentials={'token': 'device-only'})
        self.store.capture(state)
        operation = self.store.pending()[0]; self.store.ack([accepted(operation, 1)])
        self.store.apply_changes([change({'id': 'p', 'name': 'after', 'localFolder': {'path': '/remote/evil'},
                                         'credentials': {'token': 'remote'}}, 2, 'projects', 'p')], 2)
        saved = self.store.snapshot()
        self.assertEqual(saved['projects'][0]['name'], 'after')
        self.assertEqual(saved['projects'][0]['localFolder']['path'], '/local/fixture')
        self.assertEqual(saved['credentials'], {'token': 'device-only'})

    def test_real_message_time_and_attachment_references_survive_remote_assembly(self):
        message = {'id': 'm', 'role': 'user', 'text': 'Discuss attachment', 'at': 1234, 'attachmentIds': ['i']}
        self.store.capture(workspace(conversations=[{'id': 'c', 'messages': [message]}]))
        operations = self.store.pending()
        for operation in operations: self.store.ack([accepted(operation, 1)])
        self.store.apply_changes([change(note('unrelated'), 1)], 3)
        saved_message = self.store.snapshot()['conversations'][0]['messages'][0]
        self.assertEqual(saved_message.get('at'), 1234)
        self.assertEqual(saved_message.get('attachmentIds'), ['i'])
        peer = SyncStore(self.directory / 'peer')
        peer.capture(workspace())
        peer.apply_changes([{**operation, 'version': 1, 'seq': index + 1} for index, operation in enumerate(operations)], 2)
        peer_message = peer.snapshot()['conversations'][0]['messages'][0]
        self.assertEqual(peer_message.get('attachmentIds'), ['i'])

    def test_remote_assembly_preserves_device_only_message_run_fields(self):
        local_fields = {'runId': 'local-run', 'modelConfig': {'model': 'fixture'}, 'steps': [{'label': 'fixture step'}]}
        message = {'id': 'm', 'role': 'agent', 'text': 'Result', **local_fields}
        self.store.capture(workspace(conversations=[{'id': 'c', 'messages': [message]}]))
        operations = self.store.pending()
        self.store.ack([accepted(operation, 1) for operation in operations])
        self.store.apply_changes([change(note('unrelated update'))], 3)
        saved = self.store.snapshot()['conversations'][0]['messages'][0]
        for key, value in local_fields.items(): self.assertEqual(saved.get(key), value)
        projected = next(operation for operation in operations if operation['entityType'] == 'messages')['data']
        self.assertNotIn('runId', projected)
        self.assertNotIn('steps', projected)

    def test_history_is_bounded_and_callback_failure_does_not_keep_uncommitted_revision(self):
        for revision in range(1, 36):
            self.store.capture(workspace(notes=[note(str(revision))], _revision=revision))
        self.assertIsNone(self.store.snapshot_at(1))
        self.assertEqual(self.store.snapshot_at(34)['notes'][0]['content'], '34')
        before = self.database_rows()
        with self.assertRaises(OSError): self.store.capture(workspace(notes=[note('bad')], _revision=36), before_commit=explode)
        self.assertIsNone(self.store.snapshot_at(36))
        self.assertEqual(self.database_rows(), before)

    def test_project_trash_preserves_shared_import_restore_metadata(self):
        moves = [{'id': 'i', 'ownerProjectId': 'p', 'before': {'projectId': 'p', 'workspace': '日常'},
                  'after': {'projectId': None, 'workspace': '日常'}, 'projectLinkIds': ['l']}]
        self.store.capture(workspace(trash=[{'id': 'bin', 'type': 'project', 'data': {'sharedImportMoves': moves}}]))
        self.assertEqual(self.store.pending()[0]['data']['data'].get('sharedImportMoves'), moves)

    def test_ack_of_inflight_edit_does_not_delete_a_newer_local_edit(self):
        self.synced()
        self.store.capture(workspace(notes=[note('sent edit')]))
        sent = self.store.pending()[0]
        self.store.capture(workspace(notes=[note('newer local edit')]))
        self.store.ack([accepted(sent, 2)])
        pending = self.store.pending()
        self.assertEqual(len(pending), 1)
        self.assertNotEqual(pending[0]['opId'], sent['opId'])
        self.assertEqual(pending[0]['data']['content'], 'newer local edit')
        self.assertEqual(pending[0]['baseVersion'], 2)
        self.assertEqual(self.store.snapshot()['notes'][0]['content'], 'newer local edit')
        before = self.database_rows()
        self.store.ack([accepted(sent, 2)])
        self.assertEqual(self.database_rows(), before)

    def test_two_devices_keep_both_versions_and_require_explicit_conflict_resolution(self):
        second = SyncStore(self.directory / 'device-b')
        self.synced()
        second.capture(workspace()); second.apply_changes([change(note(), 1)], 1)
        self.store.capture(workspace(notes=[note('device A')]))
        a_sent = self.store.pending()[0]; self.store.ack([accepted(a_sent, 2)])
        second.capture(workspace(notes=[note('device B')]))
        outcome = second.apply_changes([change(note('device A'), 2)], 2)
        self.assertFalse(outcome['changed'])
        self.assertEqual(second.snapshot()['notes'][0]['content'], 'device B')
        conflict = second.conflicts()[0]
        self.assertEqual(conflict['remote']['content'], 'device A')
        self.assertEqual(conflict['local']['content'], 'device B')
        self.assertEqual(second.pending(), [])
        second.resolve_conflict(conflict['id'], 'local')
        operation = second.pending()[0]
        self.assertEqual(operation['baseVersion'], 2)
        self.assertEqual(operation['data']['content'], 'device B')

    def test_late_conflict_response_cannot_replace_a_newer_remote_conflict(self):
        self.synced()
        self.store.capture(workspace(notes=[note('local edit')]))
        sent = self.store.pending()[0]
        self.store.apply_changes([change(note('newest remote'), 3)], 3)
        conflict_id = self.store.conflicts()[0]['id']
        self.store.ack([], [{'opId': sent['opId'], 'remote': {
            'version': 2, 'data': note('older response'), 'deleted': False}}])
        conflict = self.store.conflicts()[0]
        self.assertEqual(conflict['id'], conflict_id)
        self.assertEqual(conflict['remoteVersion'], 3)
        self.assertEqual(conflict['remote']['content'], 'newest remote')
        self.assertEqual(self.store.pending(), [])

    def test_delete_and_restore_generate_versioned_tombstone_then_explicit_restore(self):
        self.synced()
        self.store.capture(workspace())
        deletion = self.store.pending()[0]
        self.assertTrue(deletion['deleted']); self.assertIsNone(deletion['data'])
        self.assertEqual(deletion['baseVersion'], 1)
        self.store.ack([accepted(deletion, 2)])
        self.store.apply_changes([change(None, 2, deleted=True)], 2)
        self.store.capture(workspace(notes=[note('restored')]))
        restored = self.store.pending()[0]
        self.assertFalse(restored['deleted']); self.assertEqual(restored['baseVersion'], 2)

    def test_old_offline_device_cannot_automatically_resurrect_remote_deletion(self):
        self.synced()
        self.store.capture(workspace(notes=[note('old offline edit')]))
        self.store.apply_changes([change(None, 2, deleted=True)], 2)
        self.assertEqual(self.store.pending(), [])
        conflict = self.store.conflicts()[0]
        self.assertIsNone(conflict['remote'])
        self.store.resolve_conflict(conflict['id'], 'remote')
        self.assertEqual(self.store.snapshot()['notes'], [])
        self.assertEqual(self.store.pending(), [])
        self.store.apply_changes([change(note('stale history'), 1)], 3)
        self.assertEqual(self.store.snapshot()['notes'], [])

    def test_target_binding_is_durable_and_cannot_switch_account_or_server(self):
        target = {'server': 'https://fixture.invalid', 'accountId': 'a'}
        self.store.bind_target(target)
        restarted = SyncStore(self.store.directory)
        restarted.bind_target(copy(target))
        for other in ({**target, 'accountId': 'b'}, {**target, 'server': 'https://other.invalid'}):
            with self.subTest(other=other), self.assertRaises(ValueError): restarted.bind_target(other)
        self.assertEqual(restarted.status()['target'], target)

    def test_file_hash_is_stable_until_bytes_change_and_outbox_contains_no_blob_body(self):
        files = self.store.directory / 'files'; files.mkdir(parents=True)
        raw = b'fixture unique bytes not uploaded in metadata'
        (files / 'i').write_bytes(raw)
        captured = self.store.capture(workspace(imports=[{'id': 'i', 'name': 'fixture.pdf'}]))
        first = self.store.pending()
        digest = hashlib.sha256(raw).hexdigest()
        self.assertEqual(captured['imports'][0]['blobHash'], digest)
        self.assertEqual(self.store.blob_manifest()[0]['hash'], digest)
        self.store.capture(captured)
        self.assertEqual(self.store.pending(), first)
        self.assertNotIn(raw.decode(), json.dumps(first))
        (files / 'i').write_bytes(b'new fixture contents')
        changed = self.store.capture(captured)
        self.assertNotEqual(changed['imports'][0]['blobHash'], digest)
        self.assertNotEqual(self.store.pending()[0]['opId'], first[0]['opId'])

    def test_symlink_blob_is_not_read_or_hashed(self):
        files = self.store.directory / 'files'; files.mkdir(parents=True)
        outside = self.directory / 'outside-fixture'; outside.write_bytes(b'outside fixture')
        (files / 'i').symlink_to(outside)
        captured = self.store.capture(workspace(imports=[{'id': 'i'}]))
        self.assertNotIn('blobHash', captured['imports'][0])
        self.assertEqual(self.store.blob_manifest(), [])

    def test_multiple_threads_use_separate_transactions_without_duplicate_operations(self):
        state = workspace(notes=[note()])
        self.store.capture(state)
        def worker(index):
            for _ in range(5):
                if index % 3 == 0: self.store.capture(copy(state))
                elif index % 3 == 1: self.store.pending()
                else: self.store.status(); self.store.snapshot()
        with ThreadPoolExecutor(max_workers=8) as pool: list(pool.map(worker, range(16)))
        self.assertEqual(self.store.snapshot(), state)
        self.assertEqual(len(self.store.pending()), 1)
        with sqlite3.connect(self.store.path) as db:
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM sent').fetchone()[0], 1)

    def test_invalid_remote_batch_rolls_back_earlier_valid_rows_and_cursor(self):
        self.store.capture(workspace())
        before = self.database_rows()
        with self.assertRaises(ValueError):
            self.store.apply_changes([change(note()), change({'id': 'evil'}, 2, kind='credentials', identifier='evil')], 2)
        self.assertEqual(self.database_rows(), before)

    def test_pending_batch_has_count_and_byte_budgets_and_retries_same_ids(self):
        self.store.capture(workspace(notes=[note('x' * (1024 * 1024), identifier='n' + str(i)) for i in range(12)]))
        first = self.store.pending(1000)
        self.assertGreater(len(first), 1); self.assertLess(len(first), 12)
        self.assertLess(len(json.dumps(first).encode()), 8 * 1024 * 1024)
        self.assertEqual(self.store.pending(1000), first)
        self.assertEqual(len(self.store.pending(1)), 1)


class WorkspaceSyncTransactionTests(unittest.TestCase):
    def setUp(self):
        # Importing the module only defines its lazy services. Every operation
        # below uses this temporary store, never the default user's directory.
        from server import WorkspaceStore
        temporary = tempfile.TemporaryDirectory(prefix='workstation-cloud-transaction-test-')
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.workspace = WorkspaceStore(self.directory)
        self.original = b'original fixture attachment'
        self.next_bytes = b'new remote fixture attachment'
        self.next_hash = hashlib.sha256(self.next_bytes).hexdigest()
        self.workspace.save_file('i', self.original, 'original.pdf', 'application/pdf')
        self.workspace.sync.capture(workspace(imports=[{'id': 'i', 'name': 'original.pdf'}]))
        self.workspace.sync.ack([accepted(op, 1) for op in self.workspace.sync.pending()])
        self.workspace._mirror(self.workspace.load())
        self.original_meta = self.workspace.file_path('i').with_suffix('.meta.json').read_bytes()

    def remote_import(self, identifier='i', digest=None, name='remote.pdf'):
        return change({'id': identifier, 'name': name, 'blobHash': digest or self.next_hash}, 2, 'imports', identifier)

    def assert_original_retained(self):
        self.assertEqual(self.workspace.file_path('i').read_bytes(), self.original)
        self.assertEqual(self.workspace.file_path('i').with_suffix('.meta.json').read_bytes(), self.original_meta)
        self.assertEqual(self.workspace.load()['imports'][0]['name'], 'original.pdf')
        self.assertEqual(self.workspace.sync.status()['cursor'], 0)
        self.assertEqual(list(self.directory.glob('.cloud-undo-*')), [])

    def test_invalid_later_blob_restores_already_replaced_original_and_metadata(self):
        wrong_hash = hashlib.sha256(b'expected second contents').hexdigest()
        with self.assertRaises(ValueError):
            self.workspace.apply_cloud_changes([self.remote_import(), self.remote_import('j', wrong_hash)], 2,
                                               {self.next_hash: self.next_bytes, wrong_hash: b'invalid actual bytes'})
        self.assert_original_retained()
        self.assertFalse(self.workspace.file_path('j').exists())

    def test_metadata_write_failure_restores_original_bytes_metadata_and_sqlite(self):
        original_write = self.workspace.atomic_write
        failed = False
        def write(path, data):
            nonlocal failed
            if Path(path).name == 'i.meta.json' and not failed:
                failed = True
                raise OSError('fixture metadata write failure')
            return original_write(path, data)
        with patch.object(self.workspace, 'atomic_write', side_effect=write):
            with self.assertRaises(OSError):
                self.workspace.apply_cloud_changes([self.remote_import()], 2, {self.next_hash: self.next_bytes})
        self.assert_original_retained()

    def test_sqlite_commit_failure_restores_original_files(self):
        real_connect = sqlite3.connect
        class CommitFailure(sqlite3.Connection):
            def commit(self): raise sqlite3.OperationalError('fixture commit failure')
        def connect(*args, **kwargs): return real_connect(*args, **kwargs, factory=CommitFailure)
        with patch('sync_store.sqlite3.connect', side_effect=connect):
            with self.assertRaises(sqlite3.OperationalError):
                self.workspace.apply_cloud_changes([self.remote_import()], 2, {self.next_hash: self.next_bytes})
        self.assert_original_retained()

    def test_derived_export_failure_does_not_undo_committed_sqlite_or_original(self):
        with patch.object(self.workspace, 'materialize_papers', side_effect=OSError('fixture export failure')):
            result = self.workspace.apply_cloud_changes([self.remote_import()], 2, {self.next_hash: self.next_bytes})
        self.assertTrue(result['changed'])
        self.assertTrue(result.get('warning'))
        self.assertEqual(self.workspace.load()['imports'][0]['name'], 'remote.pdf')
        self.assertEqual(self.workspace.file_path('i').read_bytes(), self.next_bytes)
        self.assertEqual(self.workspace.sync.status()['cursor'], 2)

    def test_post_commit_quarantine_cleanup_failure_reports_warning_without_rejecting_commit(self):
        unlink = Path.unlink
        def fail_cleanup(path, *args, **kwargs):
            if path.parent.name.startswith('.cloud-undo-'): raise OSError('fixture cleanup failure')
            return unlink(path, *args, **kwargs)
        with patch.object(Path, 'unlink', fail_cleanup):
            result = self.workspace.apply_cloud_changes([self.remote_import()], 2, {self.next_hash: self.next_bytes})
        self.assertTrue(result['changed'])
        self.assertTrue(result.get('cleanupWarning') or result.get('warning'))
        self.assertEqual(self.workspace.load()['imports'][0]['name'], 'remote.pdf')
        self.assertEqual(self.workspace.file_path('i').read_bytes(), self.next_bytes)

    def test_active_and_trashed_same_id_with_different_hashes_cannot_overwrite_each_other(self):
        old_hash = hashlib.sha256(self.original).hexdigest()
        trash = change({'id': 'bin', 'type': 'content', 'data': {'imports': [
            {'id': 'i', 'name': 'archived version.pdf', 'blobHash': old_hash}]}}, 1, 'trash', 'bin')
        with self.assertRaises(ValueError):
            self.workspace.apply_cloud_changes([self.remote_import(), trash], 3,
                                               {self.next_hash: self.next_bytes, old_hash: self.original})
        self.assert_original_retained()


if __name__ == '__main__': unittest.main()
