"""Backend-only self-hosted sync transport and account/session management.

Passwords are used only by the login request. Sessions are never included in
workspace snapshots, model context, exported data, or returned status objects.
"""
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

MAX_BLOB = 64 * 1024 * 1024
MAX_JSON = 16 * 1024 * 1024
SAFE_ID = re.compile(r'[A-Za-z0-9_-]{1,160}')
SHA256 = re.compile(r'[a-f0-9]{64}')


class CloudSyncError(ValueError):
    def __init__(self, message, code='SYNC_ERROR', status=400, retryable=False):
        super().__init__(message)
        self.code, self.status, self.retryable = code, status, retryable


def server_url(value):
    """Accept verified HTTPS endpoints or explicit loopback development hosts."""
    if not isinstance(value, str) or len(value) > 2048 or value != value.strip() or any(ord(c) < 33 for c in value):
        raise CloudSyncError('同步服务地址格式无效。', 'INVALID_URL')
    try:
        parsed = urllib.parse.urlsplit(value)
        host, port = parsed.hostname, parsed.port
    except ValueError:
        raise CloudSyncError('同步服务地址格式无效。', 'INVALID_URL') from None
    if parsed.username is not None or parsed.password is not None or '?' in value or '#' in value or '\\' in value or not host:
        raise CloudSyncError('同步服务地址不能含账号、查询参数或片段。', 'INVALID_URL')
    loopback = host.lower() == 'localhost'
    try: loopback = loopback or ipaddress.ip_address(host).is_loopback
    except ValueError: pass
    if parsed.scheme != 'https' and not (parsed.scheme == 'http' and loopback):
        raise CloudSyncError('同步服务必须使用 HTTPS；仅本机回环地址允许 HTTP。', 'INSECURE_URL')
    if not re.fullmatch(r'/[A-Za-z0-9._~/-]*|', parsed.path) or any(part in ('.', '..') for part in parsed.path.split('/')):
        raise CloudSyncError('同步服务路径格式无效。', 'INVALID_URL')
    authority = '[' + host.lower() + ']' if ':' in host else host.lower()
    if port is not None: authority += ':' + str(port)
    return urllib.parse.urlunsplit((parsed.scheme, authority, parsed.path.rstrip('/'), '', ''))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        return None


class CloudClient:
    def __init__(self, base_url, token=None, timeout=25):
        self.base_url = server_url(base_url)
        self._token = token
        self.timeout = timeout
        self._opener = urllib.request.build_opener(_NoRedirect())

    def request(self, method, path, payload=None, *, binary=None, limit=MAX_JSON, allow_missing=False):
        if not isinstance(path, str) or not path.startswith('/v1/') or '\\' in path or '#' in path:
            raise CloudSyncError('同步请求路径无效。', 'INVALID_REQUEST')
        headers = {'Accept': 'application/json'}
        if self._token: headers['Authorization'] = 'Bearer ' + self._token
        if binary is not None:
            if not isinstance(binary, bytes) or len(binary) > MAX_BLOB: raise CloudSyncError('附件超过 64 MB 限制。', 'BLOB_LIMIT')
            data = binary; headers['Content-Type'] = 'application/octet-stream'
        elif payload is not None:
            data = json.dumps(payload, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
            if len(data) > MAX_JSON: raise CloudSyncError('同步请求超过大小限制。', 'REQUEST_LIMIT')
            headers['Content-Type'] = 'application/json'
        else: data = None
        request = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with self._opener.open(request, timeout=self.timeout) as result:
                raw = result.read(limit + 1)
                if len(raw) > limit: raise CloudSyncError('同步服务返回的数据过大。', 'RESPONSE_LIMIT')
                if method == 'HEAD': return True
                if binary is None and limit == MAX_BLOB: return raw
                if not raw: return {}
                try: decoded = json.loads(raw)
                except (ValueError, UnicodeError): raise CloudSyncError('同步服务返回了无效数据。', 'INVALID_RESPONSE') from None
                if not isinstance(decoded, dict): raise CloudSyncError('同步服务返回格式无效。', 'INVALID_RESPONSE')
                return decoded
        except urllib.error.HTTPError as error:
            status = error.code
            if status == 404 and allow_missing: return False
            if 300 <= status < 400: raise CloudSyncError('同步服务重定向已拒绝，请使用最终服务地址。', 'REDIRECT_REFUSED', 400) from None
            messages = {401: '云端登录已失效，请重新登录。', 403: '云端拒绝访问。', 404: '云端资源不存在。', 409: '云端数据存在冲突，请先处理冲突。', 413: '同步内容超过服务端大小限制。', 429: '云端请求过于频繁，请稍后重试。'}
            raise CloudSyncError(messages.get(status, '同步服务暂时不可用。'), 'HTTP_' + str(status), status, status >= 500 or status == 429) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise CloudSyncError('无法连接同步服务，请检查网络和服务地址。', 'NETWORK_ERROR', 503, True) from None

    def health(self):
        info = self.request('GET', '/v1/health')
        if type(info.get('protocol')) is not int or info['protocol'] != 1:
            raise CloudSyncError('同步服务协议不兼容。', 'PROTOCOL_MISMATCH')
        return {'protocol': 1}

    def upload_blob(self, raw):
        if not isinstance(raw, bytes) or len(raw) > MAX_BLOB: raise CloudSyncError('附件超过 64 MB 限制。', 'BLOB_LIMIT')
        digest = hashlib.sha256(raw).hexdigest(); path = '/v1/blobs/' + digest
        if not self.request('HEAD', path, allow_missing=True): self.request('PUT', path, binary=raw)
        return digest

    def download_blob(self, digest):
        if not isinstance(digest, str) or not SHA256.fullmatch(digest): raise CloudSyncError('附件校验值无效。', 'INVALID_BLOB')
        raw = self.request('GET', '/v1/blobs/' + digest, limit=MAX_BLOB)
        if hashlib.sha256(raw).hexdigest() != digest: raise CloudSyncError('云端附件校验失败，未写入本地原件。', 'BLOB_MISMATCH')
        return raw


class CredentialStore:
    """Prefer an installed macOS keychain backend; otherwise private local file.

    The keyring package is optional. Other-platform/plaintext/chained backends
    are not silently trusted. A fallback is explicitly reported to the UI.
    """
    def __init__(self, directory):
        self.directory = Path(directory) / 'cloud-sync'
        if self.directory.is_symlink(): raise CloudSyncError('云端会话目录不能是符号链接。', 'UNSAFE_SESSION_PATH')
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True); self.directory.chmod(0o700)
        self.path = self.directory / 'cloud-session.json'
        self.service = 'AIWorkstation.CloudSync.' + hashlib.sha256(str(self.directory.resolve()).encode()).hexdigest()[:24]
        self._keyring = None
        if sys.platform == 'darwin':
            try:
                import keyring
                backend = keyring.get_keyring()
                if type(backend).__module__ in ('keyring.backends.macOS', 'keyring.backends.OS_X') and backend.priority > 0: self._keyring = backend
            except Exception: pass

    def _write(self, value):
        if self.directory.is_symlink() or self.path.is_symlink(): raise CloudSyncError('云端会话路径异常。', 'UNSAFE_SESSION_PATH')
        fd, name = tempfile.mkstemp(prefix='.session-', dir=self.directory)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, 'wb') as output:
                output.write(json.dumps(value, ensure_ascii=False, allow_nan=False).encode()); output.flush(); os.fsync(output.fileno())
            os.replace(name, self.path)
        finally:
            if os.path.exists(name): os.unlink(name)

    def save(self, session):
        data = dict(session)
        token = data.pop('accessToken', None)
        if not isinstance(token, str) or not token or len(token) > 32768 or any(ord(char) < 33 for char in token): raise CloudSyncError('云端登录响应无效。', 'INVALID_SESSION')
        storage = 'protected-file'
        if self._keyring:
            try: self._keyring.set_password(self.service, 'access-token', token); storage = 'macos-keychain'
            except Exception: pass
        if storage == 'protected-file': data['accessToken'] = token
        data['credentialStorage'] = storage
        self._write(data)
        return storage

    def load(self):
        if not self.path.exists(): return None
        if self.directory.is_symlink() or self.path.is_symlink(): raise CloudSyncError('云端会话路径异常。', 'UNSAFE_SESSION_PATH')
        fd = os.open(self.path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        try:
            metadata = os.fstat(fd)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 65536 or metadata.st_uid != os.getuid(): raise CloudSyncError('云端会话文件异常。', 'UNSAFE_SESSION_PATH')
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, 'rb', closefd=False) as stream: value = json.load(stream)
        except (ValueError, UnicodeError): raise CloudSyncError('云端会话无法读取，请重新登录。', 'INVALID_SESSION') from None
        finally: os.close(fd)
        if not isinstance(value, dict): raise CloudSyncError('云端会话无法读取，请重新登录。', 'INVALID_SESSION')
        if value.get('credentialStorage') == 'macos-keychain':
            try: token = self._keyring.get_password(self.service, 'access-token') if self._keyring else None
            except Exception: token = None
            if not token: return None
            value['accessToken'] = token
        return value

    def clear(self):
        if self.directory.is_symlink() or self.path.is_symlink(): raise CloudSyncError('云端会话路径异常。', 'UNSAFE_SESSION_PATH')
        self.path.unlink(missing_ok=True)
        if self._keyring:
            try: self._keyring.delete_password(self.service, 'access-token')
            except Exception: pass


class CloudSync:
    def __init__(self, directory, store, workspaceStore, *, interval=30, client_factory=CloudClient, start_worker=True):
        self.directory, self.store, self.workspace = Path(directory), store, workspaceStore
        self.credentials = CredentialStore(directory)
        self._client_factory, self._interval = client_factory, max(1, interval)
        self._lock, self._sync_lock = threading.RLock(), threading.Lock()
        self._wake, self._closed = threading.Event(), threading.Event()
        self._requested, self._busy, self._epoch = False, False, 0
        self._last_sync, self._last_error, self._last_code = None, None, None
        self._session = None
        try: self._session = self.credentials.load()
        except CloudSyncError as error: self._last_error, self._last_code = str(error), error.code
        self._auto = bool(self._session and self._session.get('autoSync', True))
        self._thread = None
        from cloud_ssh import CloudSSH
        self.ssh = CloudSSH(self)
        if start_worker:
            self._thread = threading.Thread(target=self._worker, name='workstation-cloud-sync', daemon=True)
            self._thread.start()

    @staticmethod
    def _identity(value, fields):
        if not isinstance(value, dict) or not isinstance(value.get('id'), str) or not SAFE_ID.fullmatch(value['id']):
            raise CloudSyncError('云端账号或设备信息无效。', 'INVALID_SESSION')
        result = {'id': value['id']}
        for field in fields:
            text = value.get(field, '')
            if not isinstance(text, str) or len(text) > 256: raise CloudSyncError('云端账号或设备信息无效。', 'INVALID_SESSION')
            result[field] = text
        return result

    def status(self):
        with self._lock:
            session = self._session
            info = self.store.status()
            phase = ('syncing' if self._busy else 'local' if not session else
                     'auth_required' if self._last_code == 'HTTP_401' else 'conflict' if info.get('conflicts', 0) else
                     'offline' if self._last_error else 'paused' if not self._auto else
                     'pending' if info.get('pending', 0) or not self._last_sync else 'synced')
            return {
                'state': phase,
                'connected': bool(session), 'autoSync': self._auto, 'syncing': self._busy,
                'serverUrl': session.get('serverUrl') if session else (info.get('target') or {}).get('serverUrl'),
                'account': dict(session['account']) if session else None,
                'device': dict(session['device']) if session else None,
                'credentialStorage': session.get('credentialStorage') if session else None,
                'pending': info.get('pending', 0), 'conflicts': info.get('conflicts', 0), 'cursor': info.get('cursor', 0),
                'target': info.get('target'), 'remoteAppliedRevision': info.get('remoteAppliedRevision', 0),
                'lastSyncAt': self._last_sync, 'error': self._last_error, 'errorCode': self._last_code,
            }

    def _session_copy(self):
        with self._lock:
            if not self._session: raise CloudSyncError('请先连接云端账号。', 'NOT_CONNECTED', 401)
            return dict(self._session), self._epoch

    def _check_epoch(self, epoch):
        if self._closed.is_set() or epoch != self._epoch:
            raise CloudSyncError('云端连接已更改，本次同步已取消。', 'CANCELLED')

    def connect(self, payload):
        if not isinstance(payload, dict) or payload.get('mergeConfirmed') is not True:
            raise CloudSyncError('首次连接前，请明确确认合并本机与云端内容。', 'MERGE_CONFIRMATION_REQUIRED')
        url = server_url(payload.get('serverUrl'))
        username, password = payload.get('username'), payload.get('password')
        name = payload.get('deviceName') or 'AI Workstation'
        if not isinstance(username, str) or not username.strip() or len(username) > 256 or not isinstance(password, str) or not password or len(password) > 16384 or not isinstance(name, str) or len(name) > 128:
            raise CloudSyncError('请输入有效的账号、密码和设备名称。', 'INVALID_LOGIN')
        if not self._sync_lock.acquire(blocking=False): raise CloudSyncError('正在同步，请稍后再更改连接。', 'SYNC_BUSY', 409)
        try:
            target = self.store.status().get('target')
            if target and target.get('serverUrl') != url:
                raise CloudSyncError('此本地工作区已绑定其他同步服务。请使用独立本地工作区连接新目标。', 'TARGET_MISMATCH', 409)
            client = self._client_factory(url); client.health()
            result = client.request('POST', '/v1/auth/login', {'username': username.strip(), 'password': password, 'deviceName': name})
            account = self._identity(result.get('account'), ('username',)); device = self._identity(result.get('device'), ('name',))
            session = {'serverUrl': url, 'account': account, 'device': device, 'accessToken': result.get('accessToken'), 'autoSync': payload.get('autoSync', True) is not False}
            new_target = {'serverUrl': url, 'accountId': account['id']}
            if target and target != new_target:
                try: self._client_factory(url, session['accessToken']).request('POST', '/v1/auth/logout')
                except Exception: pass
                raise CloudSyncError('此本地工作区已绑定其他账号，未混合两个账号的数据。请使用独立本地工作区。', 'TARGET_MISMATCH', 409)
            with self.workspace.lock(): self.store.bind_target(new_target)
            storage = self.credentials.save(session); session['credentialStorage'] = storage
            with self._lock:
                self._session = session; self._auto = session['autoSync']; self._epoch += 1
                self._last_error = self._last_code = None
            if self._auto: self._wake.set()
            return self.status()
        finally: self._sync_lock.release()

    def settings(self, payload):
        if not isinstance(payload, dict) or type(payload.get('autoSync')) is not bool:
            raise CloudSyncError('自动同步设置无效。', 'INVALID_SETTINGS')
        with self._lock:
            if self._session:
                session = dict(self._session); session['autoSync'] = payload['autoSync']
                session['credentialStorage'] = self.credentials.save(session); self._session = session
            self._auto = payload['autoSync']
        self._wake.set(); return self.status()

    def sync_now(self):
        self._session_copy()
        with self._lock: self._requested = True
        self._wake.set(); return self.status()

    def disconnect(self):
        with self._lock:
            session = self._session
            self._epoch += 1; self._session = None; self._auto = False; self._requested = False
            self.credentials.clear()
        if session:
            try: self._client_factory(session['serverUrl'], session['accessToken']).request('POST', '/v1/auth/logout')
            except CloudSyncError: pass
        return self.status()

    def devices(self):
        session, epoch = self._session_copy()
        result = self._client_factory(session['serverUrl'], session['accessToken']).request('GET', '/v1/devices')
        self._check_epoch(epoch)
        if not isinstance(result.get('devices'), list) or len(result['devices']) > 1000:
            raise CloudSyncError('云端设备列表无效。', 'INVALID_RESPONSE')
        devices = []
        for item in result['devices']:
            device = self._identity(item, ('name',))
            for field in ('createdAt', 'lastSeenAt', 'revokedAt'):
                value = item.get(field)
                device[field] = (int(value * 1000) if value < 100000000000 else int(value)) if type(value) in (int, float) and 0 <= value < 100000000000000 else None
            device['current'] = item.get('current') is True or device['id'] == session['device']['id']
            devices.append(device)
        return {'devices': devices}

    def revoke(self, device_id):
        if not isinstance(device_id, str) or not SAFE_ID.fullmatch(device_id): raise CloudSyncError('设备 ID 无效。', 'INVALID_DEVICE')
        session, epoch = self._session_copy()
        self._client_factory(session['serverUrl'], session['accessToken']).request('DELETE', '/v1/devices/' + device_id)
        self._check_epoch(epoch)
        if session['device']['id'] == device_id: return self.disconnect()
        return self.devices()

    def conflicts(self):
        return {'conflicts': self.store.conflicts()}

    @staticmethod
    def _blob_references(value):
        found = {}; pending = [(value, 0)]; count = 0
        while pending:
            item, depth = pending.pop(); count += 1
            if count > 200000 or depth > 64: raise CloudSyncError('云端内容层级或数量超过限制。', 'RESPONSE_LIMIT')
            if isinstance(item, dict):
                digest = item.get('blobHash')
                if digest is not None:
                    if not isinstance(digest, str) or not SHA256.fullmatch(digest) or not isinstance(item.get('id'), str) or not SAFE_ID.fullmatch(item['id']):
                        raise CloudSyncError('云端附件索引无效。', 'INVALID_BLOB')
                    found[digest] = item['id']
                pending.extend((child, depth + 1) for child in item.values())
            elif isinstance(item, list): pending.extend((child, depth + 1) for child in item)
        return found

    def _stage_blobs(self, client, value, epoch):
        parent = self.directory / 'cloud-downloads'
        if parent.is_symlink(): raise CloudSyncError('同步暂存目录异常。', 'UNSAFE_BLOB_PATH')
        parent.mkdir(mode=0o700, parents=True, exist_ok=True); parent.chmod(0o700)
        stage = Path(tempfile.mkdtemp(prefix='batch-', dir=parent)); staged = {}
        try:
            with self.workspace.lock(): manifest = self.store.blob_manifest()
            for digest in self._blob_references(value):
                self._check_epoch(epoch)
                path = stage / digest
                staged[digest] = path
                if self._stage_local_blob(digest, path, manifest): continue
                raw = client.download_blob(digest)
                self._check_epoch(epoch)
                with path.open('xb') as output:
                    os.chmod(path, 0o600); output.write(raw)
            return stage, staged
        except Exception:
            self._clear_stage(stage, staged); raise

    def _stage_local_blob(self, digest, destination, manifest):
        """Reuse verified bytes, never a filename or stale manifest alone.

        A private staged copy keeps verification valid if the local original
        changes while other remote records are downloading. The workspace's
        transaction still decides which version actually becomes canonical.
        """
        candidates = [item for item in manifest if isinstance(item, dict) and item.get('hash') == digest and isinstance(item.get('id'), str) and SAFE_ID.fullmatch(item['id'])]
        if not candidates: return False
        with self.workspace.lock():
            folder = self.directory / 'files'
            if folder.is_symlink(): raise CloudSyncError('本机附件目录异常，未复用原件。', 'UNSAFE_BLOB_PATH')
            if not folder.exists(): return False
            directory_fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | getattr(os, 'O_NOFOLLOW', 0))
            try:
                for item in candidates:
                    path = self.workspace.file_path(item['id'])
                    if path.parent.resolve() != folder.resolve() or path.name != item['id'] or path.is_symlink():
                        raise CloudSyncError('本机附件路径异常，未复用原件。', 'UNSAFE_BLOB_PATH')
                    try: source_fd = os.open(item['id'], os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0), dir_fd=directory_fd)
                    except FileNotFoundError: continue
                    try:
                        metadata = os.fstat(source_fd)
                        if not stat.S_ISREG(metadata.st_mode): raise CloudSyncError('本机附件不是普通文件。', 'UNSAFE_BLOB_PATH')
                        if metadata.st_size > MAX_BLOB: continue
                        digestor, copied = hashlib.sha256(), 0
                        with os.fdopen(source_fd, 'rb', closefd=False) as source, destination.open('xb') as output:
                            os.chmod(destination, 0o600)
                            while True:
                                chunk = source.read(min(1024 * 1024, MAX_BLOB + 1 - copied))
                                if not chunk: break
                                copied += len(chunk)
                                if copied > MAX_BLOB: break
                                digestor.update(chunk); output.write(chunk)
                        if copied <= MAX_BLOB and digestor.hexdigest() == digest: return True
                        destination.unlink(missing_ok=True)
                    finally: os.close(source_fd)
            finally: os.close(directory_fd)
        return False

    @staticmethod
    def _clear_stage(stage, staged):
        for path in staged.values():
            try: path.unlink(missing_ok=True)
            except OSError: pass
        try: stage.rmdir()
        except OSError: pass

    def _upload_manifest(self, client, manifest, epoch):
        seen = set()
        for item in manifest:
            digest, file_id = item.get('hash'), item.get('id')
            if not isinstance(digest, str) or not SHA256.fullmatch(digest) or not isinstance(file_id, str) or not SAFE_ID.fullmatch(file_id):
                raise CloudSyncError('本机附件索引无效。', 'INVALID_BLOB')
            if digest in seen: continue
            self._check_epoch(epoch)
            if client.request('HEAD', '/v1/blobs/' + digest, allow_missing=True): seen.add(digest); continue
            with self.workspace.lock():
                folder = self.directory / 'files'; path = self.workspace.file_path(file_id)
                if folder.is_symlink() or path.is_symlink() or path.parent.resolve() != folder.resolve(): raise CloudSyncError('本机附件路径异常。', 'UNSAFE_BLOB_PATH')
                try:
                    with path.open('rb') as source: raw = source.read(MAX_BLOB + 1)
                except OSError: raise CloudSyncError('同步原件暂时不可用，请恢复原件后重试。', 'MISSING_BLOB') from None
                if len(raw) > MAX_BLOB or hashlib.sha256(raw).hexdigest() != digest:
                    raise CloudSyncError('本机附件在同步前已变化，稍后将重新读取。', 'LOCAL_BLOB_CHANGED', 409, True)
            if client.upload_blob(raw) != digest: raise CloudSyncError('附件上传校验失败。', 'BLOB_MISMATCH')
            seen.add(digest)

    def sync_once(self):
        if not self._sync_lock.acquire(blocking=False): raise CloudSyncError('同步正在进行。', 'SYNC_BUSY', 409)
        with self._lock: self._busy = True
        try:
            session, epoch = self._session_copy()
            target = {'serverUrl': session['serverUrl'], 'accountId': session['account']['id']}
            if self.store.status().get('target') != target: raise CloudSyncError('同步账号与本地绑定不一致，已停止。', 'TARGET_MISMATCH', 409)
            client = self._client_factory(session['serverUrl'], session['accessToken'])
            with self.workspace.lock(): operations, manifest = self.store.pending(limit=100), self.store.blob_manifest()
            bounded = []
            size = 32
            for operation in operations:
                operation_size = len(json.dumps(operation, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()) + 1
                if operation_size > MAX_JSON - 32: raise CloudSyncError('单条记录超过同步大小限制，请缩减其解析文本后重试。', 'ENTITY_LIMIT')
                if size + operation_size > MAX_JSON: break
                bounded.append(operation); size += operation_size
            operations = bounded
            self._upload_manifest(client, manifest, epoch); self._check_epoch(epoch)
            if operations:
                result = client.request('POST', '/v1/sync/push', {'operations': operations})
                self._check_epoch(epoch)
                if not isinstance(result.get('accepted'), list) or not isinstance(result.get('conflicts'), list): raise CloudSyncError('云端写入确认无效，未清除本地待同步记录。', 'INVALID_RESPONSE')
                answered = result['accepted'] + result['conflicts']
                expected = {item['opId']: (item['entityType'], item['entityId']) for item in operations}
                if len(answered) != len(expected) or len({item.get('opId') for item in answered if isinstance(item, dict)}) != len(expected) or any(not isinstance(item, dict) or expected.get(item.get('opId')) != (item.get('entityType'), item.get('entityId')) for item in answered):
                    raise CloudSyncError('云端未完整确认这一批操作，本地待同步记录已保留。', 'INVALID_RESPONSE')
                with self.workspace.lock():
                    self._check_epoch(epoch); self.store.ack(result['accepted'], result['conflicts'])
            pages = 0
            while pages < 100:
                self._check_epoch(epoch)
                cursor = self.store.status().get('cursor', 0)
                result = client.request('GET', '/v1/sync/pull?' + urllib.parse.urlencode({'cursor': cursor, 'limit': 100}))
                changes, new_cursor = result.get('changes'), result.get('cursor')
                if not isinstance(changes, list) or len(changes) > 100 or type(new_cursor) is not int or new_cursor < cursor or type(result.get('hasMore')) is not bool:
                    raise CloudSyncError('云端增量响应无效，未推进同步位置。', 'INVALID_RESPONSE')
                if result['hasMore'] and new_cursor <= cursor: raise CloudSyncError('云端增量游标未前进。', 'INVALID_RESPONSE')
                stage, blobs = self._stage_blobs(client, changes, epoch)
                try:
                    self._check_epoch(epoch)
                    self.workspace.apply_cloud_changes(changes, new_cursor, blobs=blobs)
                finally: self._clear_stage(stage, blobs)
                pages += 1
                if not result['hasMore']: break
            with self._lock: self._last_sync = int(time.time() * 1000); self._last_error = self._last_code = None
            # One manual/automatic request drains subsequent bounded batches.
            # Blocked conflict rows are excluded by pending(), so they cannot
            # turn this continuation into an unproductive retry loop.
            if (operations and self.store.pending(limit=1)) or result.get('hasMore'):
                with self._lock: self._requested = True
                self._wake.set()
            with self._lock: self._busy = False
            return self.status()
        except CloudSyncError as error:
            with self._lock: self._last_error, self._last_code = str(error), error.code
            raise
        except Exception:
            with self._lock: self._last_error, self._last_code = '本地同步处理失败，原有内容与待同步记录已保留。', 'LOCAL_SYNC_ERROR'
            raise CloudSyncError(self._last_error, self._last_code, 500, True) from None
        finally:
            with self._lock: self._busy = False
            self._sync_lock.release()

    def resolve(self, conflict_id, choice):
        if choice not in ('local', 'remote'): raise CloudSyncError('请选择保留本机版本或云端版本。', 'INVALID_RESOLUTION')
        if not self._sync_lock.acquire(blocking=False): raise CloudSyncError('正在同步，请稍后处理冲突。', 'SYNC_BUSY', 409)
        try:
            conflict = next((item for item in self.store.conflicts() if item.get('id') == conflict_id), None)
            if not conflict: raise CloudSyncError('冲突已不存在。', 'CONFLICT_MISSING', 404)
            stage, blobs = None, {}
            if choice == 'remote':
                session, epoch = self._session_copy()
                client = self._client_factory(session['serverUrl'], session['accessToken'])
                stage, blobs = self._stage_blobs(client, conflict.get('remote'), epoch); self._check_epoch(epoch)
            try: self.workspace.resolve_cloud_conflict(conflict_id, choice, blobs=blobs)
            finally:
                if stage: self._clear_stage(stage, blobs)
            self._wake.set(); return self.status()
        finally: self._sync_lock.release()

    def _worker(self):
        while not self._closed.is_set():
            self._wake.wait(self._interval); self._wake.clear()
            if self._closed.is_set(): break
            with self._lock:
                requested = self._requested; self._requested = False
                eligible = self._session and (self._auto or requested)
            if eligible:
                try: self.sync_once()
                except CloudSyncError: pass

    def close(self):
        self._closed.set(); self._wake.set()
        with self._lock: self._epoch += 1
        if self._thread and self._thread is not threading.current_thread(): self._thread.join(timeout=1)
