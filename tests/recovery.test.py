"""CAS failures retain sanitized drafts without replacing canonical state."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from unittest.mock import patch

ROOT = (Path(__file__).resolve().parents[1] / 'app')
sys.path.insert(0, str(ROOT))
import server


def conflict(store, payload):
    try: store.save(copy.deepcopy(payload))
    except server.ConflictError as error: return error
    raise AssertionError('Stale state must return a conflict')


def get(origin, route, data=None, headers=None):
    payload = json.dumps(data).encode() if data is not None else None
    headers = {'Content-Type': 'application/json', **(headers or {})}
    try:
        response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(urllib.request.Request(origin + route, data=payload, headers=headers), timeout=3)
    except urllib.error.HTTPError as error: return error.code, error.headers, error.read()
    with response: return response.status, response.headers, response.read()


with tempfile.TemporaryDirectory(prefix='workstation-recovery-test-') as temporary:
    store = server.WorkspaceStore(temporary)
    initial = {key: [] for key in ('projects', 'tasks', 'notes', 'imports', 'conversations', 'trash', 'agentRuns')}
    initial['_revision'] = 0
    store.save(copy.deepcopy(initial))
    main_before = store.path.read_bytes()
    stale = {**copy.deepcopy(initial), '_pendingLocalSave': True, '_apiKey': 'top-level-secret', 'openaiApiKey': 'provider-secret'}
    stale['tasks'] = [{'id': 'unsynced-task', 'title': 'My unsynced task', 'metadata': {'api_key': 'nested-secret', 'Authorization': 'Bearer secret', 'keep': 'valuable data'}}]
    stale['settings'] = {'providers': [{'refresh_token': 'refresh-secret', 'password': 'password-secret', 'model': 'model-name'}], 'deep': {'another': {'clientSecret': 'client-secret', 'token': 'token-secret'}}, 'apiBase': 'https://example.invalid/v1'}
    original_stale = copy.deepcopy(stale)
    rejected = conflict(store, stale)
    assert rejected.current_revision == 1 and rejected.recovery['saved']
    recovery_id = rejected.recovery['id']
    path = store.recovery_path(recovery_id)
    snapshot_bytes = path.read_bytes()
    snapshot = json.loads(snapshot_bytes)
    assert snapshot['tasks'][0]['title'] == 'My unsynced task'
    assert snapshot['tasks'][0]['metadata'] == {'keep': 'valuable data'}
    assert snapshot['settings']['providers'] == [{'model': 'model-name'}]
    assert snapshot['settings']['deep'] == {'another': {}}
    assert snapshot['settings']['apiBase'] == 'https://example.invalid/v1'
    for value in ('top-level-secret', 'provider-secret', 'nested-secret', 'Bearer secret', 'refresh-secret', 'password-secret', 'client-secret', 'token-secret'):
        assert value.encode() not in snapshot_bytes
    assert '_pendingLocalSave' not in snapshot
    assert original_stale == stale, 'Recovery sanitization must not mutate the live local draft'
    assert store.path.read_bytes() == main_before, 'A rejected write must not change canonical state'
    assert not (Path(temporary) / 'files').exists(), 'Recovery must not migrate or alter attachment originals'
    assert conflict(store, stale).recovery['id'] == recovery_id
    assert len(store.list_recoveries()['items']) == 1, 'Identical retries must not grow the recovery directory'
    item = store.list_recoveries()['items'][0]
    assert item['id'] == recovery_id and item['baseRevision'] == 0 and item['currentRevision'] == 1
    assert item['counts']['tasks'] == 1 and item['downloadUrl'] == '/__recovery/' + recovery_id
    backup_before = {file.name: file.read_bytes() for file in path.parent.iterdir()}
    changed = copy.deepcopy(stale)
    changed['tasks'][0]['title'] = 'Another unsynced draft'
    for setting, value in (('MAX_RECOVERY_SNAPSHOTS', 1), ('MAX_RECOVERY_TOTAL_BYTES', 1), ('MAX_RECOVERY_SNAPSHOT_BYTES', 1)):
        with patch.object(server, setting, value):
            error = conflict(store, changed)
            assert error.recovery['saved'] is False and error.recovery.get('error')
            assert store.path.read_bytes() == main_before
            assert {file.name: file.read_bytes() for file in path.parent.iterdir()} == backup_before, 'Quota pressure must never delete or replace earlier drafts'

    old_store = server.STORE
    server.STORE = store
    class QuietHandler(server.Handler):
        def log_message(self, *args): pass
    httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    origin = f'http://127.0.0.1:{httpd.server_port}'
    try:
        status, _, body = get(origin, '/__state', stale)
        result = json.loads(body)
        assert status == 409 and result['recoverySaved'] and result['currentRevision'] == 1
        assert result['recoveryId'] == recovery_id
        status, _, body = get(origin, '/__recovery')
        assert status == 200 and json.loads(body)['items'][0]['id'] == recovery_id
        status, headers, body = get(origin, result['recoveryUrl'])
        assert status == 200 and body == snapshot_bytes
        assert headers['Cache-Control'] == 'no-store' and 'attachment;' in headers['Content-Disposition']
        assert get(origin, '/__recovery', headers={'Origin': 'https://evil.invalid'})[0] == 403
        assert get(origin, result['recoveryUrl'], headers={'Host': 'evil.invalid'})[0] == 403
        assert get(origin, '/__recovery/..%2Fworkspace.json')[0] == 400
        assert get(origin, '/__recovery/conflict_' + '0' * 24)[0] == 404
        linked = store.recovery_path('conflict_' + '1' * 24)
        linked.symlink_to(store.path)
        assert get(origin, '/__recovery/' + linked.stem)[0] == 400
        assert len(json.loads(get(origin, '/__recovery')[2])['items']) == 1
        # An interrupted metadata write must not make its intact data draft
        # inaccessible; fallback listing obtains file time and size.
        path.with_suffix('.meta.json').write_text('[]')
        assert json.loads(get(origin, '/__recovery')[2])['items'][0]['id'] == recovery_id
        assert get(origin, result['recoveryUrl'])[2] == snapshot_bytes
    finally:
        httpd.shutdown(); httpd.server_close(); thread.join(timeout=3)
        server.STORE = old_store

print('Conflict recovery, recursive credential redaction, deduplication, quotas, canonical preservation and HTTP download tests passed')
