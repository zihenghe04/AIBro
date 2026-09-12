"""Protocol v1 integration tests: isolated accounts, data and loopback server."""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from unittest.mock import patch

import cloud_server as cloud

# Apple's bundled Python may omit OpenSSL scrypt. Exercise the real password
# algorithm using an already installed capable interpreter, never a fallback
# hash or an installed dependency. The production image uses Python 3.12.
if not hasattr(hashlib, 'scrypt'):
    for candidate in ('python3.13', 'python3.12', 'python3.11'):
        executable = shutil.which(candidate)
        if executable and subprocess.run([executable, '-c', 'import hashlib; raise SystemExit(not hasattr(hashlib,"scrypt"))'], capture_output=True).returncode == 0:
            os.execv(executable, [executable, *sys.argv])
    raise SystemExit('Cloud tests require a Python build with hashlib.scrypt (for example Python 3.12).')

ROOT = Path(__file__).resolve().parents[1]
PASSWORD = 'fixture-password-42!'


def request(origin, route, token=None, payload=None, method=None, raw=None, headers=None):
    supplied = {'Content-Type': 'application/json', **(headers or {})}
    if token is not None: supplied['Authorization'] = 'Bearer ' + token
    data = raw if raw is not None else json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(origin + route, data=data, method=method, headers=supplied)
    try:
        response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=10)
    except urllib.error.HTTPError as error:
        body = error.read()
        return error.code, error.headers, json.loads(body) if body and error.headers.get('Content-Type', '').startswith('application/json') else body
    with response:
        body = response.read()
        return response.status, response.headers, json.loads(body) if body and response.headers.get('Content-Type', '').startswith('application/json') else body


def operation(op_id, entity_id='same-id', kind='notes', version=0, deleted=False, data=None):
    return {'opId': op_id, 'entityType': kind, 'entityId': entity_id, 'baseVersion': version, 'deleted': deleted, 'data': None if deleted else data if data is not None else {'id': entity_id, 'title': op_id}}


def rejected(action, status):
    try: action()
    except cloud.APIError as error:
        assert error.status == status, (error.status, error.code)
        return error
    raise AssertionError('request should have failed')


with tempfile.TemporaryDirectory(prefix='workstation-cloud-test-') as temporary:
    base = Path(temporary).resolve()
    directory = base / 'service'
    synced_directories = []
    original_fsync = os.fsync
    def observe_initial_fsync(descriptor):
        metadata = os.fstat(descriptor)
        if stat.S_ISDIR(metadata.st_mode): synced_directories.append((metadata.st_dev, metadata.st_ino))
        return original_fsync(descriptor)
    with patch.object(cloud.os, 'fsync', side_effect=observe_initial_fsync):
        store = cloud.CloudStore(directory)
    metadata = directory.stat()
    assert (metadata.st_dev, metadata.st_ino) in synced_directories, 'The new blobs directory entry must be durable in its parent'
    alice = store.add_user('Alice', PASSWORD, initial=True)
    bob = store.add_user('Bob', PASSWORD)
    rejected(lambda: store.add_user('alice', PASSWORD), 409)
    rejected(lambda: store.add_user('third', PASSWORD, initial=True), 409)
    rejected(lambda: store.add_user('short', 'tiny'), 400)
    rejected(lambda: store.login({'username': 'alice', 'password': 'wrong'}, 'fixture-wrong'), 401)
    rejected(lambda: store.login({'username': 'nonexistent', 'password': 'wrong'}, 'fixture-unknown'), 401)
    rejected(lambda: store.login({'username': 'alice', 'password': PASSWORD, 'deviceName': '\nmalformed'}, 'fixture-bad'), 400)
    first = store.login({'username': 'ALICE', 'password': PASSWORD, 'deviceName': 'Alice Mac'}, 'fixture-a')
    second = store.login({'username': 'alice', 'password': PASSWORD, 'deviceName': 'Alice Laptop'}, 'fixture-a2')
    other = store.login({'username': 'bob', 'password': PASSWORD, 'deviceName': 'Bob Mac'}, 'fixture-b')
    token = first['accessToken']; other_token = other['accessToken']
    assert len(token) == 43 and token != second['accessToken']
    identity = store.authenticate('Bearer ' + token)
    assert identity['accountId'] == alice['id']
    with store.db() as db:
        stored = db.execute('SELECT token_hash FROM tokens').fetchall()
        assert len(stored) == 3 and all(len(item['token_hash']) == 64 for item in stored)
        row = db.execute('SELECT salt,password_hash FROM accounts WHERE id=?', (alice['id'],)).fetchone()
        assert len(row['salt']) == 16 and len(row['password_hash']) == 32
        assert row['password_hash'] != PASSWORD.encode()
    for path in directory.glob('cloud.sqlite3*'):
        content = path.read_bytes()
        assert token.encode() not in content and other_token.encode() not in content and PASSWORD.encode() not in content

    with patch.object(cloud.socket, 'getfqdn', side_effect=AssertionError('Unexpected reverse DNS')), \
         patch.object(cloud.socket, 'gethostbyaddr', side_effect=AssertionError('Unexpected reverse DNS')):
        httpd = cloud.CloudHTTPServer(('127.0.0.1', 0), store)
    assert httpd.server_name == '127.0.0.1'
    assert httpd.server_port == httpd.socket.getsockname()[1] > 0
    assert httpd.daemon_threads and httpd.allow_reuse_address
    thread = threading.Thread(target=httpd.serve_forever, daemon=True); thread.start()
    origin = f'http://127.0.0.1:{httpd.server_port}'
    try:
        assert request(origin, '/v1/health')[2] == {'protocol': 1}
        assert request(origin, '/v1/sync/pull')[0] == 401
        assert request(origin, '/v1/auth/register', payload={'username': 'intruder', 'password': PASSWORD})[0] != 200
        assert request(origin, '/__local/roots', token)[0] == 404
        assert request(origin, '/server.py', token)[0] == 404
        status, _, login = request(origin, '/v1/auth/login', payload={'username': 'bob', 'password': PASSWORD, 'deviceName': 'Browser'})
        assert status == 200 and login['account']['id'] == bob['id']
        status, _, devices = request(origin, '/v1/devices', token)
        assert status == 200 and {item['name'] for item in devices['devices']} == {'Alice Mac', 'Alice Laptop'}
        assert not any('token' in key.lower() for item in devices['devices'] for key in item)
        assert request(origin, '/v1/devices/' + other['device']['id'], token, method='DELETE')[0] == 404

        op = operation('create-note')
        status, _, result = request(origin, '/v1/sync/push', token, {'operations': [op]})
        assert status == 200 and result['accepted'][0]['version'] == 1 and result['conflicts'] == []
        assert request(origin, '/v1/sync/push', token, {'operations': [copy.deepcopy(op)]})[2] == result
        assert request(origin, '/v1/sync/pull', token)[2]['cursor'] == 1, 'retries cannot append duplicate events'
        changed = copy.deepcopy(op); changed['data']['title'] = 'changed body'
        assert request(origin, '/v1/sync/push', token, {'operations': [changed]})[0] == 409
        assert request(origin, '/v1/sync/pull', other_token)[2] == {'changes': [], 'cursor': 0, 'hasMore': False}
        bob_result = request(origin, '/v1/sync/push', other_token, {'operations': [operation('create-note', data={'title': 'Bob private'})]})
        assert bob_result[0] == 200 and bob_result[2]['accepted'][0]['version'] == 1
        assert request(origin, '/v1/sync/pull', token)[2]['changes'][0]['data']['title'] == 'create-note'
        assert request(origin, '/v1/sync/pull', other_token)[2]['changes'][0]['seq'] == 1, 'account cursors must not expose other accounts activity'

        conflict_op = operation('stale-edit', version=0)
        conflict = request(origin, '/v1/sync/push', token, {'operations': [conflict_op]})[2]
        assert conflict['accepted'] == [] and conflict['conflicts'][0]['remote']['version'] == 1
        updated = operation('update-note', version=1, data={'title': 'latest'})
        assert request(origin, '/v1/sync/push', token, {'operations': [updated]})[2]['accepted'][0]['version'] == 2
        assert request(origin, '/v1/sync/push', token, {'operations': [conflict_op]})[2] == conflict, 'a conflict retry must return its original saved outcome'
        deletion = operation('delete-note', version=2, deleted=True)
        assert request(origin, '/v1/sync/push', token, {'operations': [deletion]})[2]['accepted'][0]['version'] == 3
        stale_create = request(origin, '/v1/sync/push', token, {'operations': [operation('long-offline-create')]})[2]
        assert stale_create['conflicts'][0]['remote'] == {'version': 3, 'deleted': True, 'data': None}
        assert request(origin, '/v1/sync/push', token, {'operations': [operation('explicit-restore', version=3)]})[2]['accepted'][0]['version'] == 4
        # Identical IDs in distinct entity kinds remain independent.
        typed = operation('task-with-same-id', kind='tasks')
        assert request(origin, '/v1/sync/push', token, {'operations': [typed]})[2]['accepted'][0]['version'] == 1
        association = operation('attachment-row', entity_id='attachment', kind='attachments', data={'id': 'native-id', 'name': 'linked PDF'})
        assert request(origin, '/v1/sync/push', token, {'operations': [association]})[0] == 200
        absent_blob = operation('pending-import', entity_id='source', kind='imports', data={'id': 'source', 'blobHash': 'a' * 64, 'blobPending': True})
        assert request(origin, '/v1/sync/push', token, {'operations': [absent_blob]})[0] == 200

        cursor = 0; changes = []
        while True:
            status, _, page = request(origin, f'/v1/sync/pull?cursor={cursor}&limit=2', token)
            assert status == 200 and len(page['changes']) <= 2
            assert all(item['seq'] > cursor for item in page['changes'])
            changes.extend(page['changes']); cursor = page['cursor']
            if not page['hasMore']: break
        assert [item['seq'] for item in changes] == list(range(1, len(changes) + 1))
        assert any(item['deleted'] and item['data'] is None for item in changes)
        for route in ('/v1/sync/pull?cursor=-1', '/v1/sync/pull?limit=501', '/v1/sync/pull?cursor=0&cursor=1', '/v1/sync/pull?cursor=nan'):
            assert request(origin, route, token)[0] == 400, route
        assert request(origin, '/v1/sync/pull?cursor=99999', token)[0] == 409
        malformed = [
            {'operations': [operation('wrong-type', kind='settings')]},
            {'operations': [operation('wrong-version', version=True)]},
            {'operations': [operation('wrong-deletion', deleted=True, data={'should': 'not appear'}) | {'data': {'not': 'empty'}}]},
            {'operations': [operation('wrong-data') | {'data': 'text'}]},
            {'operations': [operation('too-large') | {'data': {'content': 'x' * cloud.MAX_ENTITY}}]},
            {'operations': [operation(str(index), entity_id=str(index)) for index in range(101)]},
        ]
        for payload in malformed:
            assert request(origin, '/v1/sync/push', token, payload)[0] in (400, 413)
        assert request(origin, '/v1/sync/push', token, raw=b'{"operations":[NaN]}')[0] == 400
        assert request(origin, '/v1/sync/push', token, raw=b'', headers={'Content-Length': str(cloud.MAX_JSON + 1)})[0] == 413

        content = b'private fixture PDF bytes\0\x01'; digest = hashlib.sha256(content).hexdigest()
        route = '/v1/blobs/' + digest
        assert request(origin, route, token, raw=b'', method='PUT', headers={'Content-Length': str(cloud.MAX_BLOB + 1)})[0] == 413
        assert request(origin, route, token, method='HEAD')[0] == 404
        upload_flushes = []
        def observe_upload_fsync(descriptor):
            metadata = os.fstat(descriptor)
            if stat.S_ISREG(metadata.st_mode): upload_flushes.append('file')
            elif metadata.st_ino == store.blobs.stat().st_ino:
                assert (store.blobs / alice['id']).is_dir()
                upload_flushes.append('account-parent')
            elif metadata.st_ino == (store.blobs / alice['id']).stat().st_ino:
                assert (store.blobs / alice['id'] / digest).read_bytes() == content
                upload_flushes.append('final-name')
            return original_fsync(descriptor)
        with patch.object(cloud.os, 'fsync', side_effect=observe_upload_fsync):
            assert request(origin, route, token, raw=content, method='PUT')[2] == {'hash': digest, 'size': len(content), 'existed': False}
        assert upload_flushes == ['account-parent', 'file', 'final-name'], upload_flushes
        assert request(origin, route, token, raw=content, method='PUT')[2]['existed'] is True
        status, headers, body = request(origin, route, token, method='HEAD')
        assert status == 200 and body == b'' and int(headers['Content-Length']) == len(content)
        assert request(origin, route, token)[2] == content
        # A failed directory flush must never acknowledge a durable upload.
        # Its already linked bytes remain safe for an idempotent retry, which
        # must attempt the directory flush again even if the name exists.
        retry_content = b'fixture directory durability failure'
        retry_hash = hashlib.sha256(retry_content).hexdigest()
        account_inode = (store.blobs / alice['id']).stat().st_ino
        def fail_final_name_flush(descriptor):
            metadata = os.fstat(descriptor)
            if stat.S_ISDIR(metadata.st_mode) and metadata.st_ino == account_inode:
                raise OSError('fixture directory fsync failure')
            return original_fsync(descriptor)
        retry_route = '/v1/blobs/' + retry_hash
        with patch.object(cloud.os, 'fsync', side_effect=fail_final_name_flush):
            assert request(origin, retry_route, token, raw=retry_content, method='PUT')[0] == 503
            assert request(origin, retry_route, token, raw=retry_content, method='PUT')[0] == 503
        assert request(origin, retry_route, token, raw=retry_content, method='PUT')[2]['existed'] is True
        assert request(origin, retry_route, token)[2] == retry_content
        assert request(origin, route, other_token)[0] == 404, 'knowing another account hash must not grant blob access'
        assert request(origin, route, token, raw=b'wrong', method='PUT')[0] == 422
        assert request(origin, route, token)[2] == content
        assert not list((store.blobs / alice['id']).glob('.upload-*'))
        for invalid in ('../cloud.sqlite3', '%2e%2e%2fcloud.sqlite3', 'a' * 63, digest + '/extra'):
            assert request(origin, '/v1/blobs/' + invalid, token)[0] in (400, 404)
        empty_digest = hashlib.sha256(b'').hexdigest()
        assert request(origin, '/v1/blobs/' + empty_digest, token, raw=b'', method='PUT')[0] == 200
        rejected(lambda: store.put_blob(identity, 'a' * 64, io.BytesIO(), cloud.MAX_BLOB + 1), 413)
        rejected(lambda: store.put_blob(identity, 'a' * 64, io.BytesIO(b'short'), 10), 400)
        assert not list((store.blobs / alice['id']).glob('.upload-*'))
        external = base / 'external-file'; external.write_bytes(b'keep me')
        symlink_hash = hashlib.sha256(b'keep me').hexdigest()
        (store.blobs / alice['id'] / symlink_hash).symlink_to(external)
        assert request(origin, '/v1/blobs/' + symlink_hash, token)[0] == 404
        assert request(origin, '/v1/blobs/' + symlink_hash, token, raw=b'keep me', method='PUT')[0] == 409
        assert external.read_bytes() == b'keep me'
        (store.blobs / bob['id']).symlink_to(base, target_is_directory=True)
        assert request(origin, '/v1/blobs/' + symlink_hash, other_token, raw=b'keep me', method='PUT')[0] == 503
        assert not (base / symlink_hash).exists(), 'a symlinked account directory must never redirect upload writes'

        # Entity + change + operation are rolled back together on storage
        # failure, and retrying the same operation then succeeds once.
        with store.db() as db:
            db.execute("CREATE TRIGGER fixture_fail BEFORE INSERT ON changes WHEN NEW.entity_id='transaction-failure' BEGIN SELECT RAISE(ABORT,'fixture'); END")
        failure = operation('atomic-failure', entity_id='transaction-failure')
        assert request(origin, '/v1/sync/push', token, {'operations': [failure]})[0] == 503
        with store.db() as db:
            assert not db.execute("SELECT 1 FROM entities WHERE entity_id='transaction-failure'").fetchone()
            assert not db.execute("SELECT 1 FROM operations WHERE op_id='atomic-failure'").fetchone()
            db.execute('DROP TRIGGER fixture_fail')
        assert request(origin, '/v1/sync/push', token, {'operations': [failure]})[2]['accepted'][0]['version'] == 1

        assert request(origin, '/v1/devices/' + second['device']['id'], token, method='DELETE')[0] == 200
        assert request(origin, '/v1/sync/pull', second['accessToken'])[0] == 401
        assert request(origin, '/v1/sync/pull', token)[0] == 200
        assert request(origin, '/v1/auth/logout', token, payload={})[0] == 200
        assert request(origin, '/v1/sync/pull', token)[0] == 401
        with store.db() as db:
            db.execute('UPDATE tokens SET expires_at=? WHERE device_id=?', (int(time.time()) - 1, other['device']['id']))
        assert request(origin, '/v1/sync/pull', other_token)[0] == 401
    finally:
        httpd.shutdown(); httpd.server_close(); thread.join(timeout=3)

    # Persisted tokens, entities, history, and idempotency survive a restart.
    restarted = cloud.CloudStore(directory)
    identity = restarted.authenticate('Bearer ' + login['accessToken'])
    assert restarted.pull(identity)['changes'][0]['data']['title'] == 'Bob private'
    assert restarted.push(identity, {'operations': [operation('create-note', data={'title': 'Bob private'})]})['accepted'][0]['version'] == 1
    outcomes = []
    def race(op_id):
        outcomes.append(restarted.push(identity, {'operations': [operation(op_id, entity_id='concurrent')]}))
    racers = [threading.Thread(target=race, args=(op_id,)) for op_id in ('race-one', 'race-two')]
    for racer in racers: racer.start()
    for racer in racers: racer.join(timeout=5)
    assert sum(len(item['accepted']) for item in outcomes) == 1
    assert sum(len(item['conflicts']) for item in outcomes) == 1

    limiter = cloud.LoginLimiter()
    for _ in range(10): limiter.check('test-address', 'account')
    rejected(lambda: limiter.check('another-address', 'account'), 429)
    with patch.object(cloud.time, 'monotonic', return_value=time.monotonic() + 61):
        limiter.check('test-address', 'account')

    # CLI passwords travel over stdin, never arguments/environment/output.
    cli_data = base / 'cli'
    command = [sys.executable, str(ROOT / 'cloud_server.py'), '--data-dir', str(cli_data), 'init', '--username', 'cli-user', '--password-stdin']
    created = subprocess.run(command, input=PASSWORD + '\n', capture_output=True, text=True)
    assert created.returncode == 0, created.stderr
    assert json.loads(created.stdout)['account']['username'] == 'cli-user'
    assert PASSWORD not in created.stdout + created.stderr
    repeated = subprocess.run(command, input=PASSWORD + '\n', capture_output=True, text=True)
    assert repeated.returncode != 0 and PASSWORD not in repeated.stdout + repeated.stderr
    assert 'COPY --chown=10001:10001 cloud_server.py /app/cloud_server.py' in (ROOT / 'cloud' / 'Dockerfile').read_text()
    assert 'server.py /app/server.py' not in (ROOT / 'cloud' / 'Dockerfile').read_text()

print('Cloud protocol v1 accounts, token hashes, CAS/idempotency/tombstones, atomic changes, private blobs, limits, revocation, CLI and restart tests passed')
