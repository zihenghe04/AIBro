"""Backend-only self-hosted sync transport and account/session management.

Passwords are used only by the login request. Sessions are never included in
workspace snapshots, model context, exported data, or returned status objects.
"""
import hashlib
import base64
import hmac
import secrets
from contextlib import contextmanager
from cloud_session_file import SessionFile
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
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
CONNECTION_LIMIT = 2 * 1024 * 1024
CONNECTION_OPERATIONS = frozenset(('initialize', 'register', 'status', 'read', 'owner_state', 'commit', 'approve', 'rotate_and_revoke', 'operation_result'))


def _connection_b64(value):
    if not isinstance(value, str) or not re.fullmatch('[A-Za-z0-9_-]{43}', value): return False
    try: return base64.urlsafe_b64encode(base64.urlsafe_b64decode(value + '=')).decode().rstrip('=') == value
    except ValueError: return False


def _connection_origin(value):
    normalized = server_url(value)
    parsed = urllib.parse.urlsplit(normalized)
    if parsed.path: raise CloudSyncError('连接配置公开地址必须为 origin。', 'INVALID_CONNECTION_ORIGIN')
    host = parsed.hostname
    host = '[' + host + ']' if ':' in host else host
    port = parsed.port
    if port is not None and (parsed.scheme, port) not in (('https', 443), ('http', 80)): host += ':' + str(port)
    return parsed.scheme + '://' + host


class CloudSyncError(ValueError):
    def __init__(self, message, code='SYNC_ERROR', status=400, retryable=False):
        super().__init__(message)
        self.code, self.status, self.retryable = code, status, retryable


def grouped_pull_supported(capabilities):
    if capabilities is False:  # A v1 server without the additive endpoint.
        return False
    if not isinstance(capabilities, dict) or type(capabilities.get('protocol')) is not int or capabilities['protocol'] != 1:
        raise CloudSyncError('同步服务能力响应无效。', 'INVALID_RESPONSE')
    feature = capabilities.get('atomicGroupPull')
    if feature is None:
        return False
    if (not isinstance(feature, dict) or type(feature.get('version')) is not int or feature['version'] != 1
            or type(feature.get('maxGroupBytes')) is not int or not 0 < feature['maxGroupBytes'] <= MAX_JSON):
        raise CloudSyncError('云端整组同步协议不兼容，未拆分操作组。', 'PROTOCOL_MISMATCH')
    return True


def validate_pull_page(result, cursor, grouped=False):
    """Validate a complete page before staging files or changing local state.

    Group envelopes stay intact for SyncStore's conflict transaction. In
    particular, a legacy cursor inside a group replays all its members.
    """
    changes, new_cursor = result.get('changes'), result.get('cursor')
    if (not isinstance(changes, list) or len(changes) > 100 or type(new_cursor) is not int
            or new_cursor < cursor or new_cursor > 9007199254740991 or type(result.get('hasMore')) is not bool
            or result['hasMore'] and new_cursor <= cursor):
        raise CloudSyncError('云端增量响应无效，未推进同步位置。', 'INVALID_RESPONSE')
    if not grouped:
        if any(isinstance(item, dict) and item.get('type') == 'atomic-group' for item in changes):
            raise CloudSyncError('云端返回未协商的操作组，未推进同步位置。', 'INVALID_RESPONSE')
        return changes, new_cursor
    if type(result.get('version')) is not int or result['version'] != 1:
        raise CloudSyncError('云端整组响应版本无效。', 'INVALID_RESPONSE')
    previous, count = cursor, 0
    def invalid():
        raise CloudSyncError('云端操作组或顺序不完整，未推进同步位置。', 'INVALID_RESPONSE')
    def check(change, seq):
        if (not isinstance(change, dict) or type(change.get('seq')) is not int or change['seq'] != seq
                or not isinstance(change.get('entityType'), str) or not re.fullmatch('[a-z]+', change['entityType'])
                or not isinstance(change.get('entityId'), str) or not SAFE_ID.fullmatch(change['entityId'])
                or type(change.get('version')) is not int or not 1 <= change['version'] <= 9007199254740991
                or type(change.get('deleted')) is not bool
                or (change['deleted'] and change.get('data') is not None)
                or (not change['deleted'] and not isinstance(change.get('data'), dict))):
            invalid()
    for item in changes:
        if isinstance(item, dict) and item.get('type') == 'atomic-group':
            first, last, members = item.get('firstSeq'), item.get('lastSeq'), item.get('changes')
            if (not isinstance(item.get('groupId'), str) or not re.fullmatch('[A-Za-z0-9_-]{1,200}', item['groupId'])
                    or type(first) is not int or type(last) is not int or first < 1
                    or not isinstance(members, list) or not 1 <= len(members) <= 100
                    or last != first + len(members) - 1 or not first <= previous + 1 <= last):
                invalid()
            keys = set()
            for index, member in enumerate(members):
                check(member, first + index)
                key = (member['entityType'], member['entityId'])
                if key in keys: invalid()
                keys.add(key)
            previous = last; count += len(members)
        else:
            check(item, previous + 1); previous += 1; count += 1
        if previous > new_cursor or count > 100: invalid()
    if previous != new_cursor: invalid()
    return changes, new_cursor


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

    def request(self, method, path, payload=None, *, binary=None, limit=MAX_JSON, allow_missing=False, connection_credentials=None):
        if not isinstance(path, str) or not path.startswith('/v1/') or '\\' in path or '#' in path:
            raise CloudSyncError('同步请求路径无效。', 'INVALID_REQUEST')
        headers = {'Accept': 'application/json'}
        if connection_credentials is not None:
            if method != 'POST' or path not in ('/v1/connections/' + op for op in CONNECTION_OPERATIONS):
                raise CloudSyncError('连接配置操作无效。', 'INVALID_REQUEST')
            device, secret = connection_credentials
            if not _connection_b64(device) or not _connection_b64(secret):
                raise CloudSyncError('连接设备凭据格式无效。', 'INVALID_REQUEST')
            headers.update({'X-AIBro-Connection-Device': device, 'X-AIBro-Connection-Secret': secret})
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
    """Backend-only session in a private local 0600 file inside a 0700 directory.

    No Keychain access occurs during startup, connection or disconnect. Existing
    Keychain-only sessions require explicit SSH reauthorization or account login;
    their old Keychain entries are left untouched.
    """
    def __init__(self, directory):
        self.directory = Path(directory) / 'cloud-sync'
        if self.directory.is_symlink(): raise CloudSyncError('云端会话目录不能是符号链接。', 'UNSAFE_SESSION_PATH')
        self._file = SessionFile(self.directory, CloudSyncError)
        self.path = self.directory / 'cloud-session.json'
        self.service = 'AIWorkstation.CloudSync.' + hashlib.sha256(str(self.directory.resolve()).encode()).hexdigest()[:24]
        self._keyring = None

    @contextmanager
    def locked(self):
        with self._file.locked(): yield

    def _write(self, value):
        self._file.write(value)

    @staticmethod
    def metadata(origin=None, usable=False):
        return {'version': 1, 'generation': secrets.token_urlsafe(32), 'usable': usable, 'serverOrigin': origin}

    def save(self, session):
        data = dict(session)
        token = data.get('accessToken')
        if not isinstance(token, str) or not token or len(token) > 32768 or any(ord(char) < 33 for char in token):
            raise CloudSyncError('云端登录响应无效。', 'INVALID_SESSION')
        data['credentialStorage'] = 'protected-file'
        self._write(data)
        return 'protected-file'

    def load(self):
        value = self._file.read()
        if value and value.get('credentialStorage') == 'macos-keychain' and not value.get('accessToken'):
            raise CloudSyncError('旧云会话保存在钥匙串中。请通过 SSH 重新授权本机，或重新登录云账号；不会再弹出钥匙串窗口。', 'SSH_REAUTH_REQUIRED')
        return value

    def clear(self):
        self._file.clear()


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
        self._adopting_session = None
        try: self._session = self.credentials.load()
        except CloudSyncError as error: self._last_error, self._last_code = str(error), error.code
        self._auto = bool(self._session and self._session.get('autoSync', True))
        self._thread = None
        from cloud_ssh import CloudSSH
        self.ssh = CloudSSH(self)
        if self.ssh.job and self.ssh.job.get('state') in ('running', 'uncertain'):
            self._auto = False
            self._last_error = self.ssh.job['message']; self._last_code = 'SSH_MOVE_PENDING'
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

    @staticmethod
    def _same_session(a, b):
        if a is None or b is None: return a is b
        if not isinstance(a, dict) or not isinstance(b, dict): return False
        def identity(value):
            return (value.get('serverUrl'), value.get('account', {}).get('id'), value.get('device', {}).get('id'),
                    (value.get('connectionSession') or {}).get('generation'))
        return identity(a) == identity(b) and hmac.compare_digest(str(a.get('accessToken', '')).encode(), str(b.get('accessToken', '')).encode())

    def _persisted_session(self, expected):
        current = self.credentials.load()
        if not self._same_session(expected, current):
            raise CloudSyncError('云端登录状态已变化，请重新读取连接。', 'CONNECTION_SESSION_CHANGED', 409)
        return current

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
        operation = None
        try:
            operation = self.ssh._acquire_operation()
            with self._lock:
                epoch = self._epoch
                self._check_epoch(epoch)
            target = self.store.status().get('target')
            if target and target.get('serverUrl') != url:
                raise CloudSyncError('此本地工作区已绑定其他同步服务。请使用独立本地工作区连接新目标。', 'TARGET_MISMATCH', 409)
            client = self._client_factory(url); client.health()
            self._check_epoch(epoch)
            result = client.request('POST', '/v1/auth/login', {'username': username.strip(), 'password': password, 'deviceName': name})
            account = self._identity(result.get('account'), ('username',)); device = self._identity(result.get('device'), ('name',))
            session = {'serverUrl': url, 'account': account, 'device': device, 'accessToken': result.get('accessToken'), 'autoSync': payload.get('autoSync', True) is not False}
            new_target = {'serverUrl': url, 'accountId': account['id']}
            if target and target != new_target:
                try: self._client_factory(url, session['accessToken']).request('POST', '/v1/auth/logout')
                except Exception: pass
                raise CloudSyncError('此本地工作区已绑定其他账号，未混合两个账号的数据。请使用独立本地工作区。', 'TARGET_MISMATCH', 409)
            self._adopt_ssh_session(session, epoch)
            if self._auto: self._wake.set()
            return self.status()
        finally:
            if operation is not None: os.close(operation)
            self._sync_lock.release()

    def _adopt_ssh_session(self, session, epoch):
        """Commit a verified session while the sync and operation locks are held."""
        with self._lock, self.credentials.locked():
            self._check_epoch(epoch)
            target = {'serverUrl': session['serverUrl'], 'accountId': session['account']['id']}
            old_target = self.store.status().get('target')
            if old_target and old_target != target:
                raise CloudSyncError('工作区绑定已变化，未采用本次 SSH 授权。', 'TARGET_MISMATCH', 409)
            previous = dict(self._session) if self._session else None
            self._persisted_session(previous)
            same_target = previous and previous.get('serverUrl') == session['serverUrl'] and previous.get('account', {}).get('id') == session['account']['id']
            origin = (previous.get('connectionSession') or {}).get('serverOrigin') if same_target else None
            session['connectionSession'] = self.credentials.metadata(origin)
            self._adopting_session = session
            try:
                session['credentialStorage'] = self.credentials.save(session)
                # Re-check even with a reentrant lock: injected persistence hooks
                # and future cancellation code must not reattach after disconnect.
                self._check_epoch(epoch)
                with self.workspace.lock(): self.store.bind_target(target)
            except Exception:
                current = self.credentials.load()
                if epoch == self._epoch and (self._same_session(current, session) or self._same_session(current, previous)):
                    if previous:
                        previous['connectionSession'] = self.credentials.metadata((previous.get('connectionSession') or {}).get('serverOrigin'))
                        self.credentials.save(previous); self._session = previous
                    else: self.credentials.clear()
                    self._epoch += 1
                elif self._same_session(current, session):
                    self.credentials.clear()
                raise
            finally:
                self._adopting_session = None
            self._session = session; self._auto = session['autoSync']; self._epoch += 1
            self._last_error = self._last_code = None

    def _set_auto(self, enabled):
        """Internal preference write; caller owns the necessary operation locks."""
        with self._lock, self.credentials.locked():
            if enabled: self._check_epoch(self._epoch)
            if self._session:
                self._persisted_session(self._session)
                session = dict(self._session); session['autoSync'] = enabled
                session['credentialStorage'] = self.credentials.save(session); self._session = session
            self._auto = enabled
            if not enabled: self._requested = False
        self._wake.set()

    def _clear_maintenance_error(self):
        with self._lock:
            if self._last_code in ('SSH_MOVE_PENDING', 'SSH_JOURNAL_INVALID', 'SSH_BUSY'):
                self._last_error = self._last_code = None

    def settings(self, payload):
        if not isinstance(payload, dict) or type(payload.get('autoSync')) is not bool:
            raise CloudSyncError('自动同步设置无效。', 'INVALID_SETTINGS')
        if payload['autoSync']:
            if not self._sync_lock.acquire(blocking=False): raise CloudSyncError('正在同步或维护服务器，请稍后再启用自动同步。', 'SYNC_BUSY', 409)
            try:
                with self.ssh.operation_guard(): self._set_auto(True)
            finally: self._sync_lock.release()
        else: self._set_auto(False)
        return self.status()

    def sync_now(self):
        if not self._sync_lock.acquire(blocking=False): raise CloudSyncError('同步或服务器维护正在进行。', 'SYNC_BUSY', 409)
        try:
            with self.ssh.operation_guard():
                _, epoch = self._session_copy()
                self._check_epoch(epoch)
                with self._lock: self._requested = True
        finally: self._sync_lock.release()
        self._wake.set(); return self.status()

    def disconnect(self):
        with self._lock, self.credentials.locked():
            session = self._session
            current = self.credentials.load()
            expected = self._adopting_session if self._adopting_session and self._same_session(current, self._adopting_session) else session
            self._persisted_session(expected)
            if current:
                invalidated = {**current, 'connectionSession': self.credentials.metadata((current.get('connectionSession') or {}).get('serverOrigin'))}
                self.credentials._write(invalidated)
            self._epoch += 1; self._session = None; self._auto = False; self._requested = False
            self.credentials.clear()
        if session:
            try: self._client_factory(session['serverUrl'], session['accessToken']).request('POST', '/v1/auth/logout')
            except CloudSyncError: pass
        return self.status()

    @staticmethod
    def _connection_view(session):
        metadata = session.get('connectionSession')
        if (not isinstance(metadata, dict) or set(metadata) != {'version', 'generation', 'usable', 'serverOrigin'}
                or type(metadata['version']) is not int or metadata['version'] != 1
                or not _connection_b64(metadata['generation']) or type(metadata['usable']) is not bool):
            raise CloudSyncError('连接配置会话尚未准备，请重新读取能力。', 'CONNECTION_SESSION_CHANGED', 409)
        if metadata['serverOrigin'] is not None and _connection_origin(metadata['serverOrigin']) != metadata['serverOrigin']:
            raise CloudSyncError('连接配置会话地址无效。', 'CONNECTION_SESSION_CHANGED', 409)
        return {'serverUrl': session['serverUrl'], 'accountId': session['account']['id'],
                'sessionId': session['device']['id'], 'sessionGeneration': metadata['generation']}

    def _connection_capture(self, expected=None, usable=False):
        with self._lock, self.credentials.locked():
            session, epoch = self._session_copy()
            self._check_epoch(epoch)
            session = self._persisted_session(session)
            if 'connectionSession' not in session:
                session = {**session, 'connectionSession': self.credentials.metadata()}
                self.credentials.save(session); self._session = session
            view = self._connection_view(session)
            if expected is not None and expected != view:
                raise CloudSyncError('云端登录状态已变化，未执行连接配置请求。', 'CONNECTION_SESSION_CHANGED', 409)
            if usable and (not session['connectionSession']['usable'] or not session['connectionSession']['serverOrigin']):
                raise CloudSyncError('请先核对并启用连接配置服务。', 'CONNECTION_NOT_READY', 409)
            return dict(session), epoch

    def _connection_check(self, session, epoch):
        with self._lock, self.credentials.locked():
            self._check_epoch(epoch)
            self._persisted_session(session)

    def _connection_unauthorized(self, session, epoch):
        with self._lock, self.credentials.locked():
            self._check_epoch(epoch)
            self._persisted_session(session)
            invalidated = {**session, 'connectionSession': self.credentials.metadata((session.get('connectionSession') or {}).get('serverOrigin'))}
            self.credentials.save(invalidated); self._session = invalidated; self._epoch += 1
            self._last_code, self._last_error = 'HTTP_401', '云端登录已失效，请重新登录。'

    def _authenticated_client(self, session, epoch):
        client, owner = self._client_factory(session['serverUrl'], session['accessToken']), self
        class Client:
            def __getattr__(self, name):
                original = getattr(client, name)
                if not callable(original): return original
                def call(*args, **kwargs):
                    try: return original(*args, **kwargs)
                    except CloudSyncError as error:
                        if error.status == 401: owner._connection_unauthorized(session, epoch)
                        raise
                return call
        return Client()

    def connections_capabilities(self, payload):
        if (type(payload) is not dict or set(payload) - {'confirmedOrigin', 'session'}
                or ('confirmedOrigin' in payload) != ('session' in payload)):
            raise CloudSyncError('连接配置能力请求无效。', 'INVALID_REQUEST')
        expected = payload.get('session')
        if 'session' in payload and (type(expected) is not dict or set(expected) != {'serverUrl', 'accountId', 'sessionId', 'sessionGeneration'}
                or type(payload['confirmedOrigin']) is not str):
            raise CloudSyncError('连接配置会话快照无效。', 'INVALID_REQUEST')
        session, epoch = self._connection_capture(expected)
        client = self._client_factory(session['serverUrl'], session['accessToken'])
        try: capabilities = client.request('GET', '/v1/sync/capabilities', allow_missing=True)
        except CloudSyncError as error:
            if error.status == 401: self._connection_unauthorized(session, epoch)
            else: self._connection_check(session, epoch)
            raise
        self._connection_check(session, epoch)
        feature = capabilities.get('encryptedConnectionProfiles') if isinstance(capabilities, dict) else None
        supported = feature is not None and type(capabilities.get('protocol')) is int and capabilities['protocol'] == 1
        if supported:
            if (type(feature) is not dict or type(feature.get('version')) is not int or feature['version'] != 1
                    or type(feature.get('maxProfiles')) is not int or not 1 <= feature['maxProfiles'] <= 32
                    or type(feature.get('maxDevices')) is not int or not 1 <= feature['maxDevices'] <= 16
                    or type(feature.get('maxBytes')) is not int or not 0 < feature['maxBytes'] <= CONNECTION_LIMIT):
                raise CloudSyncError('连接配置协议不兼容。', 'CONNECTION_UNSUPPORTED', 409)
            origin = _connection_origin(feature.get('origin'))
        else: origin = None
        with self._lock, self.credentials.locked():
            self._check_epoch(epoch); self._persisted_session(session)
            current = session['connectionSession']
            confirmed = payload.get('confirmedOrigin')
            if confirmed is not None and (not supported or confirmed != origin):
                raise CloudSyncError('公开服务地址已变化，请重新核对。', 'CONNECTION_ORIGIN_CHANGED', 409)
            trusted = supported and (confirmed == origin or current['serverOrigin'] == origin)
            # Never silently replace the pinned public origin, including after
            # a server capability change or a downgrade to an old server.
            chosen = origin if confirmed is not None else current['serverOrigin']
            if current['usable'] != trusted or current['serverOrigin'] != chosen:
                session = {**session, 'connectionSession': self.credentials.metadata(chosen, trusted)}
                self.credentials.save(session); self._session = session
            return {'supported': supported, 'origin': origin, 'requiresConfirmation': bool(supported and not trusted),
                    'usable': trusted, 'session': self._connection_view(session)}

    def connections_transport(self, payload):
        if (type(payload) is not dict or set(payload) != {'session', 'operation', 'deviceId', 'deviceSecret', 'payload'}
                or type(payload.get('operation')) is not str or payload['operation'] not in CONNECTION_OPERATIONS or type(payload.get('payload')) is not dict
                or not _connection_b64(payload.get('deviceId')) or not _connection_b64(payload.get('deviceSecret'))):
            raise CloudSyncError('连接配置请求格式无效。', 'INVALID_REQUEST')
        expected = payload['session']
        if type(expected) is not dict or set(expected) != {'serverOrigin', 'serverUrl', 'accountId', 'sessionId', 'sessionGeneration'}:
            raise CloudSyncError('连接配置会话快照无效。', 'INVALID_REQUEST')
        try:
            if len(json.dumps(payload['payload'], ensure_ascii=False, allow_nan=False).encode()) > CONNECTION_LIMIT:
                raise ValueError()
        except (ValueError, TypeError, UnicodeError, RecursionError):
            raise CloudSyncError('连接配置请求超过限制或格式无效。', 'INVALID_REQUEST') from None
        session, epoch = self._connection_capture({k: v for k, v in expected.items() if k != 'serverOrigin'}, usable=True)
        if session['connectionSession']['serverOrigin'] != expected['serverOrigin']:
            raise CloudSyncError('连接配置服务身份已变化。', 'CONNECTION_SESSION_CHANGED', 409)
        client = self._client_factory(session['serverUrl'], session['accessToken'])
        try:
            result = client.request('POST', '/v1/connections/' + payload['operation'], payload['payload'],
                                    limit=CONNECTION_LIMIT, connection_credentials=(payload['deviceId'], payload['deviceSecret']))
        except CloudSyncError as error:
            if error.status == 401: self._connection_unauthorized(session, epoch)
            else: self._connection_check(session, epoch)
            return {'status': error.status, 'body': {}}
        self._connection_check(session, epoch)
        return {'status': 200, 'body': result}

    def devices(self):
        session, epoch = self._session_copy()
        result = self._authenticated_client(session, epoch).request('GET', '/v1/devices')
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
        self._authenticated_client(session, epoch).request('DELETE', '/v1/devices/' + device_id)
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
        operation_fd = None
        try:
            operation_fd = self.ssh._acquire_operation()
            session, epoch = self._session_copy()
            self._check_epoch(epoch)
            target = {'serverUrl': session['serverUrl'], 'accountId': session['account']['id']}
            if self.store.status().get('target') != target: raise CloudSyncError('同步账号与本地绑定不一致，已停止。', 'TARGET_MISMATCH', 409)
            client = self._authenticated_client(session, epoch)
            grouped = grouped_pull_supported(client.request('GET', '/v1/sync/capabilities', allow_missing=True))
            self._check_epoch(epoch)
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
                route = '/v1/sync/pull-group?' if grouped else '/v1/sync/pull?'
                result = client.request('GET', route + urllib.parse.urlencode({'cursor': cursor, 'limit': 100}))
                changes, new_cursor = validate_pull_page(result, cursor, grouped)
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
            if operation_fd is not None: os.close(operation_fd)
            self._sync_lock.release()

    def resolve(self, conflict_id, choice, revision=None):
        from sync_store import ConflictRevisionError, validate_conflict_revision
        if choice not in ('local', 'remote'): raise CloudSyncError('请选择保留本机版本或云端版本。', 'INVALID_RESOLUTION')
        if not self._sync_lock.acquire(blocking=False): raise CloudSyncError('正在同步，请稍后处理冲突。', 'SYNC_BUSY', 409)
        operation = None
        try:
            operation = self.ssh._acquire_operation()
            validate_conflict_revision(revision)
            conflict = next((item for item in self.store.conflicts() if item.get('id') == conflict_id), None)
            if not conflict: raise CloudSyncError('冲突已不存在。', 'CONFLICT_MISSING', 404)
            if conflict.get('revision') != revision:
                raise ConflictRevisionError(changed=True)
            stage, blobs = None, {}
            try:
                if choice == 'remote':
                    session, epoch = self._session_copy()
                    client = self._authenticated_client(session, epoch)
                    remote_content = [member.get('remote') for member in conflict['groupMembers']] if conflict.get('groupId') else conflict.get('remote')
                    stage, blobs = self._stage_blobs(client, remote_content, epoch); self._check_epoch(epoch)
                self.workspace.resolve_cloud_conflict(conflict_id, choice, revision=revision, blobs=blobs)
            finally:
                if stage: self._clear_stage(stage, blobs)
            self._wake.set(); return self.status()
        except ConflictRevisionError as error:
            raise CloudSyncError(str(error), error.code, error.status) from None
        finally:
            if operation is not None: os.close(operation)
            self._sync_lock.release()

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
