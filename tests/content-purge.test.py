"""Atomic, scoped permanent deletion; all state and files are temporary."""
import copy
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import urllib.error
import urllib.request
from unittest.mock import patch

import server


def state_with(ids=('unused',), revision=7):
    return {
        '_revision': revision, 'projects': [], 'tasks': [], 'notes': [], 'papers': [],
        'imports': [], 'attachments': [], 'conversations': [], 'agentRuns': [], 'links': [],
        'trash': [{'id': 'trash-one', 'type': 'content', 'data': {'imports': [{'id': item, 'name': item + '.pdf'} for item in ids]}}],
        'settings': {'apiKey': 'private-token-not-returned'},
    }


def store_at(directory, data, migrated=False):
    store = server.WorkspaceStore(directory)
    store.atomic_write(store.path, json.dumps(data).encode())
    for entry in data['trash']:
        for item in entry.get('data', {}).get('imports', []):
            store.save_file(item['id'], ('source:' + item['id']).encode(), item['id'] + '.pdf', 'application/pdf')
    if migrated: store.ensure_sync()
    return store


def rejected(action, kind=server.TrashPurgeError):
    try:
        action()
    except kind as error:
        return error
    raise AssertionError('request should have been rejected')


def disk_snapshot(directory):
    return {str(path.relative_to(directory)): path.read_bytes() for path in Path(directory).rglob('*') if path.is_file() and path.name != '.workspace.lock'}


SQL_TABLES = ('meta', 'entities', 'outbox', 'sent', 'conflicts')
SQL_FILES = {'workspace.sqlite3', 'workspace.sqlite3-wal', 'workspace.sqlite3-shm', 'workspace.sqlite3-journal'}


def sql_snapshot(store):
    """Compare committed rows, not SQLite pages/WAL checkpoint bookkeeping."""
    result = {name: [] for name in SQL_TABLES}
    if not store.sync.path.exists(): return result
    with sqlite3.connect('file:' + str(store.sync.path) + '?mode=ro', uri=True) as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for name in SQL_TABLES:
            if name in tables:
                result[name] = sorted(tuple(row) for row in db.execute('SELECT * FROM ' + name))
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    return result


def rollback_snapshot(store):
    return {'canonical': copy.deepcopy(store.load()), 'sql': sql_snapshot(store),
            'disk': {name: data for name, data in disk_snapshot(store.directory).items() if name not in SQL_FILES}}


def assert_rolled_back(store, before):
    after = rollback_snapshot(store)
    assert after['canonical'] == before['canonical'], 'Canonical workspace changed on rollback'
    assert after['sql'] == before['sql'], 'Committed snapshot/entities/outbox/history changed on rollback'
    legacy_backup = 'workspace.pre-sqlite.json'
    if legacy_backup not in before['disk'] and legacy_backup in after['disk']:
        # The first migration may create its empty schema and immutable backup
        # before the content transaction starts. The backup must be an exact
        # copy of the ORIGINAL legacy JSON, never a partially purged snapshot.
        assert after['disk'].pop(legacy_backup) == before['disk']['workspace.json']
    assert after['disk'] == before['disk'], 'Attachment, metadata, mirror, or previous backup changed on rollback'
    assert not list(store.directory.glob('.purge-*'))


def batch_state():
    data = state_with(('shared', 'only-one', 'active-source', 'other-trash-source'))
    data['tasks'] = [{'id': 'active-task', 'sourceAttachmentIds': ['active-source']}]
    data['trash'].extend([
        {'id': 'trash-two', 'type': 'content', 'data': {
            'imports': [{'id': 'shared'}, {'id': 'only-two'}],
            'notes': [{'id': 'selected-note', 'sourceAttachmentIds': ['only-one', 'shared']}]}},
        {'id': 'trash-keep', 'type': 'content', 'data': {
            'notes': [{'id': 'retained-note', 'sourceAttachmentIds': ['other-trash-source']}]}}
    ])
    return data


def http(origin, payload, source='same-origin', host=None):
    headers = {'Content-Type': 'application/json'}
    if source is not None:
        headers['Origin'] = origin if source == 'same-origin' else source
    if host is not None:
        headers['Host'] = host
    request = urllib.request.Request(origin + '/__trash/purge', data=json.dumps(payload).encode(), headers=headers)
    try:
        response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=5)
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())
    with response:
        return response.status, json.loads(response.read())


with tempfile.TemporaryDirectory(prefix='workstation-content-purge-') as temporary:
    base = Path(temporary).resolve()
    store = store_at(base / 'normal', state_with())
    before = store.path.read_bytes()
    result = store.purge_trash('trash-one', 7)
    assert result['ok'] and result['revision'] == 8 and result['savedAt'] > 0
    assert result['removedImportIds'] == ['unused'] and result['retainedImportIds'] == []
    assert result['retainedVault'] is True
    assert not store.file_path('unused').exists()
    assert not store.file_path('unused').with_suffix('.meta.json').exists()
    assert store.load()['trash'] == [] and store.load()['_revision'] == 8
    assert (store.directory / 'workspace.previous.json').read_bytes() == before
    assert not list(store.directory.glob('.purge-*'))
    assert 'private-token' not in json.dumps(result) and 'state' not in result

    store = store_at(base / 'cas', state_with())
    before = disk_snapshot(store.directory)
    error = rejected(lambda: store.purge_trash('trash-one', 6), server.ConflictError)
    assert error.current_revision == 7 and disk_snapshot(store.directory) == before
    assert rejected(lambda: store.purge_trash('missing', 7)).status == 404
    for bad_id, revision in [('../outside', 7), ('trash-one', True), ('trash-one', '7'), ('trash-one', -1)]:
        rejected(lambda: store.purge_trash(bad_id, revision))
    assert disk_snapshot(store.directory) == before
    duplicate = store.load(); duplicate['trash'].append(copy.deepcopy(duplicate['trash'][0]))
    store.atomic_write(store.path, json.dumps(duplicate).encode())
    rejected(lambda: store.purge_trash('trash-one', 7))
    assert len(store.load()['trash']) == 2

    # Remove both selected bundles before calculating reachability. Their
    # references to one another no longer keep shared originals alive, while
    # active records and an unselected trash bundle must retain their sources.
    store = store_at(base / 'batch-references', batch_state(), migrated=True)
    initial_ops = store.sync.pending()
    store.sync.ack([{'opId': item['opId'], 'version': 1} for item in initial_ops])
    before = store.path.read_bytes()
    with patch.object(store.sync, 'capture', wraps=store.sync.capture) as capture:
        result = store.purge_trash_many(['trash-two', 'trash-one'], 7)
        assert capture.call_count == 1, 'A batch must commit one snapshot/outbox transaction'
    assert result['purgedIds'] == ['trash-two', 'trash-one'] and result['revision'] == 8
    assert result['removedImportIds'] == ['only-one', 'only-two', 'shared']
    assert result['retainedImportIds'] == ['active-source', 'other-trash-source']
    assert [entry['id'] for entry in store.load()['trash']] == ['trash-keep']
    assert (store.directory / 'workspace.previous.json').read_bytes() == before
    assert all(not store.file_path(item).exists() and not store.file_path(item).with_suffix('.meta.json').exists() for item in result['removedImportIds'])
    assert all(store.file_path(item).exists() for item in result['retainedImportIds'])
    pending = store.sync.pending()
    assert {(item['entityType'], item['entityId'], item['deleted'], item['baseVersion']) for item in pending} == {
        ('trash', 'trash-one', True, 1), ('trash', 'trash-two', True, 1)}
    assert all(item['data'] is None for item in pending), 'All removed synced entries need versioned tombstones'

    store = store_at(base / 'batch-validation', batch_state(), migrated=True)
    before = rollback_snapshot(store)
    rejected(lambda: store.purge_trash_many(['trash-one', 'missing'], 7))
    for invalid in ([], None, 'trash-one', ['trash-one', 'trash-one'], ['trash-one', '../outside'],
                    ['trash-one', None], ['x' * 161], ['item-' + str(index) for index in range(2001)]):
        rejected(lambda: store.purge_trash_many(invalid, 7))
    rejected(lambda: store.purge_trash_many(['trash-one', 'trash-two'], 6), server.ConflictError)
    assert_rolled_back(store, before)
    duplicate = batch_state(); duplicate['trash'].append(copy.deepcopy(duplicate['trash'][0]))
    store = store_at(base / 'batch-duplicate-record', duplicate)
    before = rollback_snapshot(store)
    rejected(lambda: store.purge_trash_many(['trash-one', 'trash-two'], 7))
    assert_rolled_back(store, before)
    store = store_at(base / 'batch-import-budget', state_with(()))
    excessive = state_with(())
    excessive['trash'] = [{'id': 'bin-' + str(index), 'type': 'content', 'data': {
        'imports': [{'id': 'shared-source'} for _ in range(2000)]}} for index in range(11)]
    store.atomic_write(store.path, json.dumps(excessive).encode())
    before = rollback_snapshot(store)
    rejected(lambda: store.purge_trash_many([item['id'] for item in excessive['trash']], 7))
    assert_rolled_back(store, before)

    ids = ('active-import', 'active-attachment', 'by-task', 'by-note', 'by-paper', 'by-conversation', 'by-other-trash', 'by-link', 'by-membership', 'same-id-task', 'unused')
    data = state_with(ids)
    data['imports'] = [{'id': 'active-import'}]
    data['attachments'] = [{'id': 'active-attachment'}]
    data['tasks'] = [{'id': 'task', 'sourceAttachmentIds': ['by-task']}, {'id': 'same-id-task'}]
    data['notes'] = [{'id': 'note', 'sourceAttachmentIds': ['by-note']}]
    data['papers'] = [{'id': 'paper', 'sourceAttachmentId': 'by-paper'}]
    data['conversations'] = [{'id': 'chat', 'attachments': ['by-conversation']}]
    data['links'] = [{'id': 'link', 'sourceId': 'by-link', 'targetId': 'task'}]
    data['trash'].append({'id': 'other-trash', 'data': {'notes': [{'id': 'old-note', 'sourceAttachmentIds': ['by-other-trash']}], 'attachmentMemberships': [{'conversationId': 'gone-chat', 'attachmentId': 'by-membership'}]}})
    store = store_at(base / 'references', data)
    result = store.purge_trash('trash-one', 7)
    assert result['removedImportIds'] == ['unused']
    assert set(result['retainedImportIds']) == set(ids) - {'unused'}
    assert all(store.file_path(item).exists() for item in result['retainedImportIds'])
    assert store.load()['trash'][0]['id'] == 'other-trash'

    # The file store is the only mutable filesystem namespace. Source paths,
    # localFolder bindings, and research vault exports are retained untouched.
    outside = base / 'personal-homepage'; outside.mkdir(); source = outside / 'index.html'; source.write_text('original website')
    data = state_with(); data['trash'][0]['data']['projects'] = [{'id': 'project', 'localFolder': {'path': str(outside)}}]
    data['trash'][0]['data']['imports'][0]['path'] = str(source)
    store = store_at(base / 'vault', data)
    vault = store.directory / 'vault' / 'research' / 'sources' / 'papers' / '2026' / 'paper'
    vault.mkdir(parents=True); (vault / 'source.pdf').write_bytes(b'vault-copy'); (vault / 'my-note.md').write_text('user extra')
    result = store.purge_trash('trash-one', 7)
    assert source.read_text() == 'original website'
    assert (vault / 'source.pdf').read_bytes() == b'vault-copy' and (vault / 'my-note.md').read_text() == 'user extra'
    assert result['retainedVault']
    data['trash'].append({'id': 'trash-two', 'type': 'content', 'data': {}})
    store = store_at(base / 'batch-vault', data)
    batch_vault = store.directory / 'vault' / 'research' / 'fixture'
    batch_vault.mkdir(parents=True); (batch_vault / 'source.pdf').write_bytes(b'batch-vault-copy')
    result = store.purge_trash_many(['trash-one', 'trash-two'], 7)
    assert result['retainedVault'] and source.read_text() == 'original website'
    assert (batch_vault / 'source.pdf').read_bytes() == b'batch-vault-copy'

    # A symlink cannot redirect a purge into an external folder or file.
    store = store_at(base / 'symlink', state_with())
    store.file_path('unused').unlink(); store.file_path('unused').symlink_to(source)
    before = store.path.read_bytes()
    rejected(lambda: store.purge_trash('trash-one', 7))
    assert store.path.read_bytes() == before and source.read_text() == 'original website'
    assert store.file_path('unused').is_symlink()
    store.file_path('unused').unlink(); store.file_path('unused').write_bytes(b'original')
    moved_files = store.directory / 'old-files'; (store.directory / 'files').rename(moved_files)
    (store.directory / 'files').symlink_to(moved_files, target_is_directory=True)
    rejected(lambda: store.purge_trash('trash-one', 7))
    assert store.path.read_bytes() == before and (moved_files / 'unused').read_bytes() == b'original'

    # A failure while moving the second file restores the first one and leaves
    # both the canonical state and its previous backup unchanged.
    original_replace = os.replace
    def fail_second_move(source_name, target_name, **kwargs):
        if source_name == 'one.meta.json' and kwargs.get('src_dir_fd') is not None:
            raise OSError('fixture move failure')
        return original_replace(source_name, target_name, **kwargs)
    for migrated in (False, True):
        store = store_at(base / ('move-failure-sqlite' if migrated else 'move-failure-legacy'), state_with(('one', 'two')), migrated=migrated)
        store.atomic_write(store.directory / 'workspace.previous.json', b'old backup')
        before = rollback_snapshot(store)
        with patch.object(server.os, 'replace', side_effect=fail_second_move):
            rejected(lambda: store.purge_trash('trash-one', 7), OSError)
        assert_rolled_back(store, before)

    # Cross-bundle move and mirror failures restore every original and all
    # committed SQLite rows. A valid first selection must never be partially
    # purged because processing a later selection fails.
    for failure_mode in ('move', 'write', 'commit'):
        store = store_at(base / ('batch-failure-' + failure_mode), batch_state(), migrated=True)
        store.atomic_write(store.directory / 'workspace.previous.json', b'old batch backup')
        before = rollback_snapshot(store)
        if failure_mode == 'move':
            def fail_batch_move(source_name, target_name, **kwargs):
                if source_name == 'only-two.meta.json' and kwargs.get('src_dir_fd') is not None:
                    raise OSError('fixture later bundle move failure')
                return original_replace(source_name, target_name, **kwargs)
            with patch.object(server.os, 'replace', side_effect=fail_batch_move):
                rejected(lambda: store.purge_trash_many(['trash-one', 'trash-two'], 7), OSError)
        elif failure_mode == 'write':
            atomic_write = store.atomic_write
            def fail_batch_write(path, data):
                if path == store.path: raise OSError('fixture batch mirror failure')
                return atomic_write(path, data)
            with patch.object(store, 'atomic_write', side_effect=fail_batch_write):
                rejected(lambda: store.purge_trash_many(['trash-one', 'trash-two'], 7), OSError)
        else:
            real_connect = sqlite3.connect
            class CommitFailure(sqlite3.Connection):
                def commit(self):
                    # Read-only load()/backup checks also open transactions;
                    # fail specifically after capture has staged the purge.
                    raw = self.execute("SELECT value FROM meta WHERE key='snapshot'").fetchone()
                    if raw and json.loads(raw[0]).get('_revision') == 8:
                        raise sqlite3.OperationalError('fixture batch commit failure')
                    return super().commit()
            def connect(*args, **kwargs): return real_connect(*args, **kwargs, factory=CommitFailure)
            with patch.object(sqlite3, 'connect', side_effect=connect):
                rejected(lambda: store.purge_trash_many(['trash-one', 'trash-two'], 7), sqlite3.OperationalError)
        assert_rolled_back(store, before)

    # An atomic workspace write failure rolls blob moves and previous backup
    # back. No revision or source disappears on this uncommitted result.
    for migrated in (False, True):
        store = store_at(base / ('write-failure-sqlite' if migrated else 'write-failure-legacy'), state_with(), migrated=migrated)
        store.atomic_write(store.directory / 'workspace.previous.json', b'old backup')
        before = rollback_snapshot(store)
        if migrated:
            assert before['sql']['entities'] and before['sql']['outbox'], 'Fixture must exercise existing sync rows'
        atomic_write = store.atomic_write
        def fail_workspace(path, data):
            if path == store.path:
                raise OSError('fixture workspace failure')
            return atomic_write(path, data)
        with patch.object(store, 'atomic_write', side_effect=fail_workspace):
            rejected(lambda: store.purge_trash('trash-one', 7), OSError)
        assert_rolled_back(store, before)

    # Cleanup occurs after commit. A cleanup error is not returned as a failed
    # deletion and cannot make a UI blindly retry an already committed write.
    store = store_at(base / 'cleanup-failure', state_with())
    original_unlink = os.unlink
    def fail_cleanup(path, **kwargs):
        if kwargs.get('dir_fd') is not None:
            raise OSError('fixture cleanup failure')
        return original_unlink(path, **kwargs)
    with patch.object(server.os, 'unlink', side_effect=fail_cleanup):
        result = store.purge_trash('trash-one', 7)
    assert result['ok'] and result['revision'] == 8 and result['cleanupWarning']
    assert store.load()['trash'] == [] and not store.file_path('unused').exists()
    quarantine = next(store.directory.glob('.purge-*'))
    assert (quarantine / 'unused').read_bytes() == b'source:unused'

    # Reference scans fail closed at their bounded depth budget.
    store = store_at(base / 'limits', state_with())
    current = store.load(); current['extra'] = nested = {}
    for _ in range(66):
        nested['next'] = {}; nested = nested['next']
    store.atomic_write(store.path, json.dumps(current).encode())
    before = store.path.read_bytes(); rejected(lambda: store.purge_trash('trash-one', 7))
    assert store.path.read_bytes() == before and store.file_path('unused').exists()

    store = store_at(base / 'http', state_with())
    old_store = server.STORE; server.STORE = store
    class QuietHandler(server.Handler):
        def log_message(self, *args): pass
    httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True); thread.start()
    origin = f'http://127.0.0.1:{httpd.server_port}'
    try:
        payload = {'id': 'trash-one', 'revision': 7}
        for source_origin in (None, 'null', 'https://attacker.invalid'):
            assert http(origin, payload, source=source_origin)[0] == 403
        assert http(origin, payload, host='attacker.invalid')[0] == 403
        status, result = http(origin, {'id': 'trash-one', 'revision': 6})
        assert status == 409 and result['currentRevision'] == 7
        assert 'private-token' not in json.dumps(result) and store.file_path('unused').exists()
        assert http(origin, {'id': 'missing', 'revision': 7})[0] == 404
        assert http(origin, ['invalid'])[0] == 400
        status, result = http(origin, payload)
        assert status == 200 and result['ok'] and result['revision'] == 8
        assert set(result) <= {'ok', 'revision', 'savedAt', 'removedImportIds', 'retainedImportIds', 'retainedVault', 'cleanupWarning'}
        assert http(origin, payload)[0] == 409

        store = store_at(base / 'http-batch', batch_state(), migrated=True); server.STORE = store
        before = rollback_snapshot(store)
        batch_payload = {'ids': ['trash-one', 'trash-two'], 'revision': 7}
        for source_origin in (None, 'null', 'https://attacker.invalid'):
            assert http(origin, batch_payload, source=source_origin)[0] == 403
        for invalid in ({'ids': [], 'revision': 7}, {'ids': ['trash-one', 'trash-one'], 'revision': 7},
                        {'ids': ['trash-one'], 'id': 'trash-two', 'revision': 7},
                        {'ids': ['item-' + str(index) for index in range(2001)], 'revision': 7}):
            assert http(origin, invalid)[0] == 400
        assert http(origin, {'ids': ['trash-one', 'missing'], 'revision': 7})[0] == 404
        assert http(origin, {**batch_payload, 'revision': 6})[0] == 409
        assert_rolled_back(store, before)
        status, result = http(origin, batch_payload)
        assert status == 200 and result['purgedIds'] == batch_payload['ids'] and result['revision'] == 8
        assert len(store.load()['trash']) == 1

        # The advertised maximum fits within the endpoint body budget, even
        # with long valid IDs; clearing is one revision, not many partial calls.
        data = state_with(())
        ids = [('trash-' + str(index) + '-').ljust(160, 'x') for index in range(2000)]
        data['trash'] = [{'id': identifier, 'type': 'content', 'data': {}} for identifier in ids]
        store = store_at(base / 'http-batch-maximum', data); server.STORE = store
        request_body = {'ids': ids, 'revision': 7}
        assert len(json.dumps(request_body).encode()) < 512 * 1024
        status, result = http(origin, request_body)
        assert status == 200 and result['purgedIds'] == ids and result['revision'] == 8
        assert store.load()['trash'] == []
    finally:
        httpd.shutdown(); httpd.server_close(); thread.join(timeout=3); server.STORE = old_store

print('Single/batch content purge CAS, shared references, sync tombstones, rollback, cleanup, vault preservation, limits and same-origin HTTP tests passed')
