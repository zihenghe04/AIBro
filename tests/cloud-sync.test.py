"""Isolated network/session tests: never inspect or reuse a real account."""
from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str((Path(__file__).resolve().parents[1] / 'app')))
from cloud_sync import CloudClient, CloudSync, CloudSyncError, CredentialStore, server_url
from sync_store import SyncStore

TOKEN = 'test-only-not-a-real-token'


class TestHTTP(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def reply(self, value, status=200, raw=False):
        payload = value if raw else json.dumps(value).encode()
        self.send_response(status); self.send_header('Content-Length', str(len(payload))); self.end_headers()
        if self.command != 'HEAD': self.wfile.write(payload)
    def do_GET(self):
        self.server.requests.append((self.command, self.path, self.headers.get('Authorization')))
        if self.path == '/v1/health': return self.reply({'protocol': 1})
        if self.path == '/v1/redirect':
            self.send_response(302); self.send_header('Location', self.server.other_url + '/v1/capture'); self.end_headers(); return
        if self.path == '/v1/error': return self.reply({'error': TOKEN + ' password=private'}, 500)
        if self.path.startswith('/v1/blobs/'):
            data = self.server.blobs.get(self.path.rsplit('/', 1)[1])
            return self.reply(data if data is not None else b'not found', 200 if data is not None else 404, raw=True)
        return self.reply({'error': 'missing'}, 404)
    def do_HEAD(self): return self.do_GET()
    def do_PUT(self):
        self.server.requests.append((self.command, self.path, self.headers.get('Authorization')))
        data = self.rfile.read(int(self.headers['Content-Length']))
        self.server.blobs[self.path.rsplit('/', 1)[1]] = data
        self.reply({'ok': True})


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.http = ThreadingHTTPServer(('127.0.0.1', 0), TestHTTP)
        self.http.requests, self.http.blobs, self.http.other_url = [], {}, ''
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True); self.thread.start()
        self.addCleanup(self.http.server_close); self.addCleanup(self.http.shutdown)
        self.url = 'http://127.0.0.1:' + str(self.http.server_port)
    def test_only_https_or_loopback_http_and_no_embedded_credentials_query_or_fragment(self):
        for url in ['http://example.com', 'https://u:p@example.com', 'https://example.com?q=secret', 'https://example.com/#x', 'https://example.com?', 'file:///tmp/a', 'https://example.com/../private', 'https://example.com\\@evil', ' https://example.com', 'https://example.com\n']:
            with self.subTest(url=url), self.assertRaises(CloudSyncError): server_url(url)
        self.assertEqual(server_url('HTTPS://Example.com/base/'), 'https://example.com/base')
        self.assertEqual(server_url('http://[::1]:8765'), 'http://[::1]:8765')
    def test_redirect_does_not_forward_bearer_token(self):
        other = ThreadingHTTPServer(('127.0.0.1', 0), TestHTTP); other.requests, other.blobs = [], {}
        thread = threading.Thread(target=other.serve_forever, daemon=True); thread.start()
        self.addCleanup(other.server_close); self.addCleanup(other.shutdown)
        self.http.other_url = 'http://127.0.0.1:' + str(other.server_port)
        with self.assertRaisesRegex(CloudSyncError, '重定向'): CloudClient(self.url, TOKEN).request('GET', '/v1/redirect')
        self.assertEqual(other.requests, [])
    def test_remote_error_body_never_exposes_password_or_token(self):
        with self.assertRaises(CloudSyncError) as caught: CloudClient(self.url, TOKEN).request('GET', '/v1/error')
        self.assertNotIn(TOKEN, str(caught.exception)); self.assertNotIn('private', str(caught.exception))
        self.assertEqual(caught.exception.code, 'HTTP_500')
    def test_blob_dedup_download_and_hash_validation(self):
        client = CloudClient(self.url, TOKEN); self.assertEqual(client.health(), {'protocol': 1})
        raw = b'PDF fixture original bytes'; digest = client.upload_blob(raw)
        self.assertEqual(client.upload_blob(raw), digest)
        self.assertEqual([method for method, path, _ in self.http.requests if method == 'PUT'], ['PUT'])
        self.assertEqual(client.download_blob(digest), raw)
        self.http.blobs[digest] = b'corrupt'
        with self.assertRaisesRegex(CloudSyncError, '校验失败'): client.download_blob(digest)


class MemoryStore:
    def __init__(self): self.target = None; self.cursor = 0; self.operations = []; self.manifest = []; self.acknowledged = []; self.conflict_rows = []
    def status(self): return {'target': self.target, 'cursor': self.cursor, 'pending': len(self.operations), 'conflicts': len(self.conflict_rows), 'remoteAppliedRevision': 2}
    def bind_target(self, target):
        if self.target and self.target != target: raise ValueError('Target mismatch')
        self.target = dict(target)
    def pending(self, limit=100): return list(self.operations[:limit])
    def blob_manifest(self): return list(self.manifest)
    def ack(self, accepted, conflicts=None):
        assert self.workspace.depth > 0
        self.acknowledged.extend(accepted)
        done = {item['opId'] for item in accepted}; self.operations = [item for item in self.operations if item['opId'] not in done]
    def conflicts(self): return list(self.conflict_rows)


class Workspace:
    def __init__(self, directory, store): self.directory, self.store, self.depth = Path(directory), store, 0; self.applied = []; self.resolved = []; self.before_apply = None
    @contextmanager
    def lock(self):
        self.depth += 1
        try: yield
        finally: self.depth -= 1
    def file_path(self, file_id): return self.directory / 'files' / file_id
    def apply_cloud_changes(self, changes, cursor, blobs=None):
        if self.before_apply: self.before_apply()
        with self.lock():
            self.applied.append((changes, cursor, {digest: path.read_bytes() for digest, path in (blobs or {}).items()}))
            self.store.cursor = cursor
    def resolve_cloud_conflict(self, conflict_id, choice, blobs=None):
        with self.lock(): self.resolved.append((conflict_id, choice)); self.store.conflict_rows = []


class Remote:
    def __init__(self):
        self.calls = []; self.account_id = 'account-one'; self.blobs = {}; self.pull = {'changes': [], 'cursor': 0, 'hasMore': False}; self.push_wait = None; self.push_started = threading.Event()
    def factory(self, url, token=None):
        remote = self
        class Client:
            def health(self): remote.calls.append(('health', url)); return {'protocol': 1}
            def request(self, method, path, payload=None, **kwargs):
                remote.calls.append((method, path, payload))
                if path == '/v1/auth/login': return {'accessToken': TOKEN, 'account': {'id': remote.account_id, 'username': 'student', 'accessToken': 'discard'}, 'device': {'id': 'device-one', 'name': 'Test desktop', 'password': 'discard'}}
                if path == '/v1/devices': return {'devices': [{'id': 'device-one', 'name': 'Test desktop', 'accessToken': TOKEN}]}
                if path in ('/v1/auth/logout', '/v1/devices/device-one'): return {'ok': True}
                if method == 'HEAD': return path.rsplit('/', 1)[1] in remote.blobs
                if path == '/v1/sync/push':
                    remote.push_started.set()
                    if remote.push_wait: remote.push_wait.wait(3)
                    return {'accepted': [{'opId': item['opId'], 'entityType': item['entityType'], 'entityId': item['entityId'], 'version': 1} for item in payload['operations']], 'conflicts': []}
                if path.startswith('/v1/sync/pull?'): return remote.pull
                raise AssertionError(path)
            def upload_blob(self, raw):
                digest = hashlib.sha256(raw).hexdigest(); remote.calls.append(('upload', digest)); remote.blobs[digest] = raw; return digest
            def download_blob(self, digest): remote.calls.append(('download', digest)); return remote.blobs[digest]
        return Client()


class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aw-cloud-sync-test-'); self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name); self.store = MemoryStore(); self.workspace = Workspace(self.directory, self.store); self.store.workspace = self.workspace
        self.remote = Remote(); self.manager = CloudSync(self.directory, self.store, self.workspace, client_factory=self.remote.factory, start_worker=False)
        self.manager.credentials._keyring = None; self.addCleanup(self.manager.close)
    def connect(self, **extra):
        return self.manager.connect({'serverUrl': 'https://sync.example.test', 'username': 'student', 'password': 'test-password', 'deviceName': 'Test desktop', 'mergeConfirmed': True, 'autoSync': False, **extra})
    def test_merge_confirmation_required_before_any_remote_login_or_upload(self):
        with self.assertRaises(CloudSyncError): self.connect(mergeConfirmed=False)
        self.assertEqual(self.remote.calls, []); self.assertIsNone(self.store.target)
    def test_credentials_are_private_backend_only_and_password_is_not_saved(self):
        info = self.connect(); file = self.manager.credentials.path
        self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(file.parent.stat().st_mode), 0o700)
        self.assertEqual(info['credentialStorage'], 'protected-file')
        self.assertNotIn(TOKEN, json.dumps(info)); self.assertNotIn('test-password', file.read_text())
        self.assertEqual(CredentialStore(self.directory).load()['accessToken'], TOKEN)
        self.assertNotIn(TOKEN, json.dumps(self.manager.devices()))
    def test_session_symlink_cannot_write_outside_credential_directory(self):
        victim = self.directory / 'outside'; victim.write_text('keep')
        self.manager.credentials.path.symlink_to(victim)
        with self.assertRaises(CloudSyncError): self.connect()
        self.assertEqual(victim.read_text(), 'keep')
    def test_switching_account_or_service_does_not_reuse_bound_outbox_or_cursor(self):
        self.connect(); self.store.cursor = 27; self.store.operations = [{'opId': 'pending'}]
        with self.assertRaises(CloudSyncError): self.connect(serverUrl='https://other.example.test')
        self.remote.account_id = 'account-two'
        with self.assertRaises(CloudSyncError): self.connect()
        self.assertEqual(self.store.target['accountId'], 'account-one'); self.assertEqual(self.store.cursor, 27)
        self.assertEqual(self.store.operations, [{'opId': 'pending'}]); self.assertEqual(self.manager.status()['account']['id'], 'account-one')
        self.assertTrue(any(call[:2] == ('POST', '/v1/auth/logout') for call in self.remote.calls))
    def test_disconnect_removes_session_but_preserves_bound_local_library(self):
        self.connect(); self.store.cursor = 8; self.manager.disconnect()
        self.assertFalse(self.manager.credentials.path.exists()); self.assertFalse(self.manager.status()['connected'])
        self.assertEqual(self.store.target['accountId'], 'account-one'); self.assertEqual(self.store.cursor, 8)
        with self.assertRaises(CloudSyncError): self.manager.sync_now()
    def test_local_blob_is_uploaded_before_the_referencing_operation_is_pushed(self):
        self.connect(); raw = b'own original PDF'; digest = hashlib.sha256(raw).hexdigest()
        (self.directory / 'files').mkdir(); self.workspace.file_path('pdf').write_bytes(raw)
        self.store.manifest = [{'id': 'pdf', 'hash': digest}]
        self.store.operations = [{'opId': 'op-one', 'entityType': 'import', 'entityId': 'pdf', 'baseVersion': 0, 'deleted': False, 'data': {'id': 'pdf', 'blobHash': digest}}]
        self.manager.sync_once()
        self.assertLess(next(i for i, call in enumerate(self.remote.calls) if call[0] == 'upload'), next(i for i, call in enumerate(self.remote.calls) if call[:2] == ('POST', '/v1/sync/push')))
        self.assertEqual(self.store.operations, []); self.assertEqual(len(self.store.acknowledged), 1)
    def test_remote_blob_is_staged_and_never_overwrites_local_original_before_conflict_resolution(self):
        self.connect(); raw = b'remote alternative'; digest = hashlib.sha256(raw).hexdigest(); self.remote.blobs[digest] = raw
        (self.directory / 'files').mkdir(); self.workspace.file_path('pdf').write_bytes(b'local edited original')
        change = {'seq': 1, 'entityType': 'import', 'entityId': 'pdf', 'version': 2, 'deleted': False, 'data': {'id': 'pdf', 'blobHash': digest}}
        self.remote.pull = {'changes': [change], 'cursor': 1, 'hasMore': False}
        self.workspace.before_apply = lambda: self.assertEqual(self.workspace.file_path('pdf').read_bytes(), b'local edited original')
        self.manager.sync_once()
        self.assertEqual(self.workspace.applied[0][2][digest], raw)
        self.assertEqual(self.workspace.file_path('pdf').read_bytes(), b'local edited original')
        self.assertEqual(list((self.directory / 'cloud-downloads').iterdir()), [])
    def stage_fixture(self, local, remote=None, manifest_hash=None, local_id='pdf', remote_id='pdf'):
        self.connect(); remote = local if remote is None else remote
        local_digest, digest = hashlib.sha256(local).hexdigest(), hashlib.sha256(remote).hexdigest()
        (self.directory / 'files').mkdir(); self.workspace.file_path(local_id).write_bytes(local)
        self.store.manifest = [{'id': local_id, 'hash': manifest_hash or local_digest}]
        self.remote.blobs.update({digest: remote, local_digest: local})
        self.remote.pull = {'changes': [{'seq': 1, 'entityType': 'imports', 'entityId': remote_id, 'version': 2, 'deleted': False, 'data': {'id': remote_id, 'name': 'Renamed.pdf', 'blobHash': digest}}], 'cursor': 1, 'hasMore': False}
        return digest
    def test_metadata_only_update_reuses_actual_matching_bytes_without_download(self):
        raw = b'unchanged original'; digest = self.stage_fixture(raw)
        self.manager.sync_once()
        self.assertFalse(any(call[0] == 'download' for call in self.remote.calls))
        self.assertEqual(self.workspace.applied[0][2][digest], raw)
        self.assertEqual(list((self.directory / 'cloud-downloads').iterdir()), [])
    def test_a_stale_manifest_hash_cannot_substitute_different_local_bytes(self):
        remote = b'cloud source revision'; digest = hashlib.sha256(remote).hexdigest()
        self.stage_fixture(b'locally changed source', remote, manifest_hash=digest)
        self.manager.sync_once()
        self.assertEqual([call for call in self.remote.calls if call[0] == 'download'], [('download', digest)])
        self.assertEqual(self.workspace.applied[0][2][digest], remote)
        self.assertEqual(self.workspace.file_path('pdf').read_bytes(), b'locally changed source')
    def test_different_conflict_version_is_downloaded_even_when_same_id_is_present(self):
        remote = b'cloud version'; digest = self.stage_fixture(b'local conflict version', remote)
        self.manager.sync_once()
        self.assertEqual([call for call in self.remote.calls if call[0] == 'download'], [('download', digest)])
        self.assertEqual(self.workspace.applied[0][2][digest], remote)
    def test_exact_hash_can_reuse_another_original_id_without_confusing_identity(self):
        raw = b'identical bytes under different IDs'; digest = self.stage_fixture(raw, local_id='local-id', remote_id='remote-id')
        self.manager.sync_once()
        self.assertFalse(any(call[0] == 'download' for call in self.remote.calls))
        self.assertEqual(self.workspace.applied[0][0][0]['entityId'], 'remote-id')
        self.assertEqual(self.workspace.applied[0][2][digest], raw)
        self.assertFalse(self.workspace.file_path('remote-id').exists(), 'Manager stages bytes; only workspace commit may assign them')
    def test_reused_original_is_a_verified_snapshot_not_a_live_path_reference(self):
        raw = b'original at verification'; digest = self.stage_fixture(raw)
        self.workspace.before_apply = lambda: self.workspace.file_path('pdf').write_bytes(b'later local edit')
        self.manager.sync_once()
        self.assertEqual(self.workspace.applied[0][2][digest], raw)
        self.assertEqual(self.workspace.file_path('pdf').read_bytes(), b'later local edit')
    def test_symlink_original_and_parent_cannot_be_reused(self):
        for parent_link in (False, True):
            with self.subTest(parent=parent_link), tempfile.TemporaryDirectory(prefix='aw-cloud-link-test-') as temporary:
                root = Path(temporary); store = MemoryStore(); workspace = Workspace(root, store); store.workspace = workspace
                manager = CloudSync(root, store, workspace, client_factory=self.remote.factory, start_worker=False); manager.credentials._keyring = None
                try:
                    manager.connect({'serverUrl': 'https://sync.example.test', 'username': 'student', 'password': 'test-password', 'mergeConfirmed': True, 'autoSync': False})
                    foreign = root / 'external'; foreign.mkdir(); raw = b'do not use redirected path'; (foreign / 'pdf').write_bytes(raw)
                    digest = hashlib.sha256(raw).hexdigest(); self.remote.blobs[digest] = raw
                    if parent_link: (root / 'files').symlink_to(foreign, target_is_directory=True)
                    else: (root / 'files').mkdir(); (root / 'files' / 'pdf').symlink_to(foreign / 'pdf')
                    store.manifest = [{'id': 'pdf', 'hash': digest}]
                    self.remote.pull = {'changes': [{'data': {'id': 'pdf', 'blobHash': digest}}], 'cursor': 1, 'hasMore': False}
                    with self.assertRaises(CloudSyncError) as error: manager.sync_once()
                    self.assertEqual(error.exception.code, 'UNSAFE_BLOB_PATH')
                    self.assertEqual((foreign / 'pdf').read_bytes(), raw)
                    self.assertEqual(store.cursor, 0)
                finally: manager.close()
    def test_invalid_pull_response_never_advances_cursor(self):
        self.connect(); self.remote.pull = {'changes': [], 'cursor': 0, 'hasMore': True}
        with self.assertRaises(CloudSyncError): self.manager.sync_once()
        self.assertEqual(self.store.cursor, 0); self.assertEqual(self.workspace.applied, [])
    def test_revoking_this_device_disconnects_without_erasing_local_data(self):
        self.connect(); self.manager.revoke('device-one')
        self.assertFalse(self.manager.status()['connected']); self.assertIsNotNone(self.store.target)
    def test_background_manual_sync_is_nonblocking_and_disconnect_invalidates_pending_ack(self):
        self.connect(); self.store.operations = [{'opId': 'pending', 'entityType': 'task', 'entityId': 'task', 'data': {'id': 'task'}}]
        self.remote.push_wait = threading.Event()
        self.manager._thread = threading.Thread(target=self.manager._worker, daemon=True); self.manager._thread.start()
        self.assertFalse(self.manager.sync_now()['autoSync'])
        self.assertTrue(self.remote.push_started.wait(2)); self.assertTrue(self.manager.status()['syncing'])
        self.manager.disconnect(); self.remote.push_wait.set(); self.manager.close()
        self.assertEqual(self.store.acknowledged, []); self.assertEqual(len(self.store.operations), 1)


class SQLiteWorkspace(Workspace):
    def _publish(self, snapshot, blobs):
        for item in snapshot.get('imports', []):
            digest = item.get('blobHash')
            if digest in (blobs or {}):
                destination = self.file_path(item['id']); destination.parent.mkdir(exist_ok=True)
                destination.write_bytes(blobs[digest].read_bytes())
    def apply_cloud_changes(self, changes, cursor, blobs=None):
        with self.lock(): return self.store.apply_changes(changes, cursor, before_commit=lambda snapshot: self._publish(snapshot, blobs))
    def resolve_cloud_conflict(self, conflict_id, choice, blobs=None):
        with self.lock(): return self.store.resolve_conflict(conflict_id, choice, before_commit=lambda snapshot: self._publish(snapshot, blobs))


@unittest.skipUnless(hasattr(hashlib, 'scrypt'), 'Real server authentication requires the bundled OpenSSL Python runtime')
class ProtocolIntegrationTests(unittest.TestCase):
    def setUp(self):
        from cloud_server import CloudStore, CloudHTTPServer
        self.temp = tempfile.TemporaryDirectory(prefix='aw-cloud-protocol-test-'); self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.remote = CloudStore(self.directory / 'remote'); self.remote.add_user('student', 'isolated-test-password')
        self.http = CloudHTTPServer(('127.0.0.1', 0), self.remote)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True); self.thread.start()
        self.addCleanup(self.http.server_close); self.addCleanup(self.http.shutdown)
        self.url = 'http://127.0.0.1:' + str(self.http.server_port)
    def device(self, name, snapshot=None):
        directory = self.directory / name; store = SyncStore(directory); workspace = SQLiteWorkspace(directory, store)
        if snapshot is not None:
            with workspace.lock(): store.capture(snapshot)
        manager = CloudSync(directory, store, workspace, start_worker=False); manager.credentials._keyring = None; self.addCleanup(manager.close)
        manager.connect({'serverUrl': self.url, 'username': 'student', 'password': 'isolated-test-password', 'deviceName': name, 'mergeConfirmed': True, 'autoSync': False})
        return manager, store, workspace
    def test_two_sqlite_devices_exchange_notes_and_keep_concurrent_edits_as_a_resolvable_conflict(self):
        a, first, _ = self.device('first', {'_revision': 1, 'notes': [{'id': 'note-one', 'title': 'Reading note', 'content': 'Original'}], '_apiKey': 'never-upload-this-fixture'})
        a.sync_once(); self.assertEqual(first.status()['pending'], 0)
        b, second, _ = self.device('second', {'_revision': 1})
        b.sync_once(); self.assertEqual(second.snapshot()['notes'][0]['content'], 'Original')
        self.assertNotIn('_apiKey', second.snapshot())
        first_edit = first.snapshot(); first_edit['notes'][0]['content'] = 'Device A revision'; first.capture(first_edit)
        second_edit = second.snapshot(); second_edit['notes'][0]['content'] = 'Device B revision'; second.capture(second_edit)
        a.sync_once(); b.sync_once()
        self.assertEqual(second.snapshot()['notes'][0]['content'], 'Device B revision')
        self.assertEqual(b.status()['state'], 'conflict')
        conflict = b.conflicts()['conflicts'][0]; b.resolve(conflict['id'], 'remote')
        self.assertEqual(second.snapshot()['notes'][0]['content'], 'Device A revision')
        self.assertEqual(second.status()['conflicts'], 0)
    def test_binary_attachment_transfers_with_original_name_and_real_hash_verification(self):
        a, first, workspace = self.device('first', {'_revision': 1})
        raw = b'%PDF-1.4\nIsolated durable attachment fixture\n%%EOF'
        workspace.file_path('pdf-one').parent.mkdir(exist_ok=True); workspace.file_path('pdf-one').write_bytes(raw)
        snapshot = first.snapshot(); snapshot['imports'] = [{'id': 'pdf-one', 'name': 'Lecture.pdf', 'mimeType': 'application/pdf', 'content': 'Lecture text'}]; first.capture(snapshot)
        a.sync_once()
        b, second, target = self.device('second', {'_revision': 1}); b.sync_once()
        self.assertEqual(target.file_path('pdf-one').read_bytes(), raw)
        self.assertEqual(second.snapshot()['imports'][0]['name'], 'Lecture.pdf')
        self.assertEqual(second.snapshot()['imports'][0]['blobHash'], hashlib.sha256(raw).hexdigest())
        self.assertEqual(list((target.directory / 'cloud-downloads').iterdir()), [])
        renamed = first.snapshot(); renamed['imports'][0]['name'] = 'Renamed lecture.pdf'; first.capture(renamed); a.sync_once()
        downloads = []
        class CountingClient(CloudClient):
            def download_blob(self, digest): downloads.append(digest); return super().download_blob(digest)
        b._client_factory = CountingClient; b.sync_once()
        self.assertEqual(downloads, [], 'A real metadata update must not redownload the already verified PDF')
        self.assertEqual(second.snapshot()['imports'][0]['name'], 'Renamed lecture.pdf')
        self.assertEqual(target.file_path('pdf-one').read_bytes(), raw)


if __name__ == '__main__': unittest.main()
