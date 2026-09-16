#!/usr/bin/env python3
"""Dedicated, self-hosted sync protocol v1. No local-machine or model APIs."""
import argparse
import collections
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import socket
import sqlite3
import stat
import sys
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from socketserver import TCPServer
from urllib.parse import parse_qs, urlsplit
import uuid

PROTOCOL = 1
MAX_JSON = 16 * 1024 * 1024
MAX_ENTITY = 4 * 1024 * 1024
MAX_BLOB = 64 * 1024 * 1024
MAX_OPERATIONS = 100
MAX_PULL = 500
MAX_PULL_BYTES = 4 * 1024 * 1024
TOKEN_LIFETIME = 30 * 24 * 60 * 60
ENTITY_TYPES = frozenset(('projects', 'tasks', 'notes', 'imports', 'attachments', 'papers', 'conversations', 'messages', 'links', 'trash', 'folders', 'skills'))
PASSWORD_N = 32768


class APIError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def identifier(value, label='ID'):
    if not isinstance(value, str) or not 1 <= len(value) <= 200 or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise APIError(400, 'invalid_request', label + '无效。')
    return value


def username(value):
    if not isinstance(value, str) or not re.fullmatch(r'[^\s\x00-\x1f\x7f/\\:]{1,80}', value):
        raise APIError(400, 'invalid_request', '用户名格式无效。')
    return value.casefold()


def password_hash(password, salt):
    return hashlib.scrypt(password.encode('utf-8'), salt=salt, n=PASSWORD_N, r=8, p=1, dklen=32, maxmem=64 * 1024 * 1024)


class LoginLimiter:
    """Bounded per-address, per-account and global login attempt windows."""
    def __init__(self):
        self.lock = threading.Lock()
        self.events = {}

    def check(self, address, account):
        now = time.monotonic()
        keys = [('ip:' + address, 20), ('user:' + account, 10), ('global', 200)]
        with self.lock:
            for key in list(self.events):
                queue = self.events[key]
                while queue and queue[0] <= now - 60:
                    queue.popleft()
                if not queue:
                    del self.events[key]
            if len(self.events) > 10000 or any(len(self.events.get(key, ())) >= limit for key, limit in keys):
                raise APIError(429, 'rate_limited', '登录尝试过于频繁，请稍后重试。')
            for key, _ in keys:
                self.events.setdefault(key, collections.deque()).append(now)


class CloudStore:
    def __init__(self, directory, token_lifetime=TOKEN_LIFETIME):
        if not hasattr(hashlib, 'scrypt'):
            raise APIError(503, 'unsupported_runtime', '此 Python 不支持 scrypt，请使用带 OpenSSL 的 Python 3.12 或所附 Docker 镜像。')
        raw = Path(directory).expanduser()
        if raw.is_symlink():
            raise ValueError('Cloud data directory cannot be a symbolic link')
        self.directory = raw.resolve()
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = self.directory / 'cloud.sqlite3'
        self.blobs = self.directory / 'blobs'
        if self.path.is_symlink() or self.blobs.is_symlink():
            raise ValueError('Cloud storage paths cannot be symbolic links')
        self.blobs.mkdir(mode=0o700, exist_ok=True)
        parent_fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(parent_fd)
        finally: os.close(parent_fd)
        self.token_lifetime = token_lifetime
        self.limiter = LoginLimiter()
        self.hash_slots = threading.BoundedSemaphore(4)
        # Unknown usernames perform the same expensive password derivation.
        self.dummy_salt = secrets.token_bytes(16)
        with self.db() as db:
            if db.execute('PRAGMA user_version').fetchone()[0] not in (0, 1):
                raise ValueError('Unsupported cloud database version')
            db.execute('PRAGMA journal_mode=WAL')
            db.executescript('''
                CREATE TABLE IF NOT EXISTS accounts (
                    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
                    salt BLOB NOT NULL, password_hash BLOB NOT NULL,
                    created_at INTEGER NOT NULL, change_seq INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS devices (
                    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
                    name TEXT NOT NULL, created_at INTEGER NOT NULL,
                    last_seen_at INTEGER NOT NULL, revoked_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS devices_account ON devices(account_id);
                CREATE TABLE IF NOT EXISTS tokens (
                    token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
                    device_id TEXT NOT NULL REFERENCES devices(id), expires_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS tokens_device ON tokens(device_id);
                CREATE TABLE IF NOT EXISTS entities (
                    account_id TEXT NOT NULL REFERENCES accounts(id), entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL, version INTEGER NOT NULL, deleted INTEGER NOT NULL,
                    data TEXT, PRIMARY KEY(account_id, entity_type, entity_id)
                );
                CREATE TABLE IF NOT EXISTS changes (
                    account_id TEXT NOT NULL REFERENCES accounts(id), seq INTEGER NOT NULL,
                    entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
                    version INTEGER NOT NULL, deleted INTEGER NOT NULL, data TEXT,
                    PRIMARY KEY(account_id, seq)
                );
                CREATE TABLE IF NOT EXISTS operations (
                    account_id TEXT NOT NULL REFERENCES accounts(id), op_id TEXT NOT NULL,
                    request_hash TEXT NOT NULL, result TEXT NOT NULL,
                    PRIMARY KEY(account_id, op_id)
                );
                PRAGMA user_version=1;
            ''')
        os.chmod(self.path, 0o600)

    @contextmanager
    def db(self):
        connection = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA foreign_keys=ON')
        connection.execute('PRAGMA busy_timeout=10000')
        connection.execute('PRAGMA synchronous=FULL')
        try:
            yield connection
        finally:
            connection.close()

    def add_user(self, name, password, initial=False):
        name = username(name)
        if not isinstance(password, str) or len(password) < 12 or len(password.encode('utf-8')) > 1024:
            raise APIError(400, 'invalid_password', '密码需至少 12 个字符，且不超过 1024 字节。')
        salt = secrets.token_bytes(16)
        derived = password_hash(password, salt)
        account_id = uuid.uuid4().hex
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if initial and db.execute('SELECT 1 FROM accounts LIMIT 1').fetchone():
                raise APIError(409, 'already_initialized', '账号库已初始化，请使用 add-user 添加账号。')
            try:
                db.execute('INSERT INTO accounts(id,username,salt,password_hash,created_at) VALUES(?,?,?,?,?)', (account_id, name, salt, derived, int(time.time())))
            except sqlite3.IntegrityError:
                raise APIError(409, 'username_exists', '这个用户名已存在。')
            db.commit()
        return {'id': account_id, 'username': name}

    def login(self, payload, address):
        if not isinstance(payload, dict):
            raise APIError(400, 'invalid_request', '登录请求格式无效。')
        name = username(payload.get('username'))
        password = payload.get('password')
        if not isinstance(password, str) or len(password.encode('utf-8')) > 1024:
            raise APIError(400, 'invalid_request', '登录请求格式无效。')
        device_name = payload.get('deviceName', '未命名设备')
        if not isinstance(device_name, str) or not 1 <= len(device_name.strip()) <= 100 or any(ord(char) < 32 for char in device_name):
            raise APIError(400, 'invalid_request', '设备名称无效。')
        self.limiter.check(address, name)
        if not self.hash_slots.acquire(blocking=False):
            raise APIError(429, 'rate_limited', '登录服务繁忙，请稍后重试。')
        try:
            with self.db() as db:
                account = db.execute('SELECT * FROM accounts WHERE username=?', (name,)).fetchone()
            derived = password_hash(password, account['salt'] if account else self.dummy_salt)
            if not account or not hmac.compare_digest(derived, account['password_hash']):
                raise APIError(401, 'invalid_credentials', '用户名或密码不正确。')
        finally:
            self.hash_slots.release()
        token = secrets.token_urlsafe(32)
        device_id = uuid.uuid4().hex
        now = int(time.time())
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('DELETE FROM tokens WHERE expires_at<=?', (now,))
            db.execute('INSERT INTO devices(id,account_id,name,created_at,last_seen_at) VALUES(?,?,?,?,?)', (device_id, account['id'], device_name.strip(), now, now))
            db.execute('INSERT INTO tokens VALUES(?,?,?,?)', (hashlib.sha256(token.encode()).hexdigest(), account['id'], device_id, now + self.token_lifetime))
            db.commit()
        return {'accessToken': token, 'account': {'id': account['id'], 'username': account['username']}, 'device': {'id': device_id, 'name': device_name.strip()}}

    def authenticate(self, authorization):
        if not isinstance(authorization, str) or not re.fullmatch(r'Bearer [A-Za-z0-9_-]{43}', authorization):
            raise APIError(401, 'unauthorized', '请先登录云同步账号。')
        digest = hashlib.sha256(authorization[7:].encode()).hexdigest()
        now = int(time.time())
        with self.db() as db:
            token = db.execute('SELECT t.account_id,t.device_id FROM tokens t JOIN devices d ON d.id=t.device_id WHERE t.token_hash=? AND t.expires_at>? AND d.revoked_at IS NULL', (digest, now)).fetchone()
            if not token:
                raise APIError(401, 'unauthorized', '登录已失效，请重新登录。')
            db.execute('UPDATE devices SET last_seen_at=? WHERE id=? AND last_seen_at<?', (now, token['device_id'], now - 60))
        return {'accountId': token['account_id'], 'deviceId': token['device_id'], 'tokenHash': digest}

    def devices(self, identity):
        with self.db() as db:
            rows = db.execute('SELECT id,name,created_at,last_seen_at,revoked_at FROM devices WHERE account_id=? ORDER BY created_at,id', (identity['accountId'],)).fetchall()
        return {'devices': [{'id': row['id'], 'name': row['name'], 'createdAt': row['created_at'], 'lastSeenAt': row['last_seen_at'], 'revokedAt': row['revoked_at'], 'current': row['id'] == identity['deviceId']} for row in rows]}

    def logout(self, identity):
        with self.db() as db:
            db.execute('DELETE FROM tokens WHERE token_hash=? AND account_id=?', (identity['tokenHash'], identity['accountId']))
        return {'ok': True}

    def revoke_device(self, identity, device_id):
        if not re.fullmatch(r'[a-f0-9]{32}', device_id):
            raise APIError(404, 'not_found', '设备不存在。')
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT id FROM devices WHERE id=? AND account_id=?', (device_id, identity['accountId'])).fetchone()
            if not row:
                raise APIError(404, 'not_found', '设备不存在。')
            db.execute('UPDATE devices SET revoked_at=? WHERE id=?', (int(time.time()), device_id))
            db.execute('DELETE FROM tokens WHERE device_id=?', (device_id,))
            db.commit()
        return {'ok': True}

    @staticmethod
    def validate_operation(operation):
        if not isinstance(operation, dict) or set(operation) - {'opId', 'entityType', 'entityId', 'baseVersion', 'deleted', 'data'}:
            raise APIError(400, 'invalid_operation', '同步操作格式无效。')
        op_id = identifier(operation.get('opId'), '操作 ID')
        kind = operation.get('entityType')
        if not isinstance(kind, str) or kind not in ENTITY_TYPES:
            raise APIError(400, 'invalid_operation', '不支持这种同步实体。')
        entity_id = identifier(operation.get('entityId'), '实体 ID')
        version = operation.get('baseVersion')
        if isinstance(version, bool) or not isinstance(version, int) or not 0 <= version <= 9007199254740991:
            raise APIError(400, 'invalid_operation', '实体版本无效。')
        deleted = operation.get('deleted')
        if not isinstance(deleted, bool):
            raise APIError(400, 'invalid_operation', '删除标记必须为布尔值。')
        data = operation.get('data')
        if not deleted and not isinstance(data, dict):
            raise APIError(400, 'invalid_operation', '实体内容必须为 JSON 对象。')
        if deleted and data is not None:
            raise APIError(400, 'invalid_operation', '删除操作的内容必须为空。')
        payload = {'opId': op_id, 'entityType': kind, 'entityId': entity_id, 'baseVersion': version, 'deleted': deleted, 'data': data}
        if len(encoded(data)) > MAX_ENTITY:
            raise APIError(413, 'entity_too_large', '单个同步实体不能超过 4 MiB。')
        pending = [(data, 0)]; count = 0
        while pending:
            value, depth = pending.pop(); count += 1
            if depth > 32 or count > 20000:
                raise APIError(400, 'invalid_operation', '实体内容层级或字段数量超出限制。')
            children = list(value.values()) if isinstance(value, dict) else value if isinstance(value, list) else []
            if len(pending) + len(children) + count > 20000:
                raise APIError(400, 'invalid_operation', '实体内容字段过多。')
            pending.extend((child, depth + 1) for child in children)
        return payload

    def push(self, identity, payload):
        if not isinstance(payload, dict) or set(payload) != {'operations'} or not isinstance(payload['operations'], list) or len(payload['operations']) > MAX_OPERATIONS:
            raise APIError(400, 'invalid_request', '每批最多提交 100 个同步操作。')
        operations = [self.validate_operation(item) for item in payload['operations']]
        hashes = {}; accepted = []; conflicts = []
        for operation in operations:
            digest = hashlib.sha256(encoded(operation)).hexdigest()
            if operation['opId'] in hashes and hashes[operation['opId']] != digest:
                raise APIError(409, 'op_id_reuse', '同一个操作 ID 不能用于不同内容。')
            hashes[operation['opId']] = digest
        for operation in operations:
            account_id = identity['accountId']; kind = operation['entityType']; entity_id = operation['entityId']; op_id = operation['opId']
            with self.db() as db:
                db.execute('BEGIN IMMEDIATE')
                # A revoked device cannot continue a long batch after its
                # credentials have been withdrawn between operations.
                if not db.execute('SELECT 1 FROM tokens t JOIN devices d ON d.id=t.device_id WHERE t.token_hash=? AND t.account_id=? AND t.expires_at>? AND d.revoked_at IS NULL', (identity['tokenHash'], account_id, int(time.time()))).fetchone():
                    raise APIError(401, 'unauthorized', '登录已失效，请重新登录。')
                previous = db.execute('SELECT request_hash,result FROM operations WHERE account_id=? AND op_id=?', (account_id, op_id)).fetchone()
                if previous:
                    if previous['request_hash'] != hashes[op_id]:
                        raise APIError(409, 'op_id_reuse', '同一个操作 ID 不能用于不同内容。')
                    result = json.loads(previous['result'])
                else:
                    remote = db.execute('SELECT version,deleted,data FROM entities WHERE account_id=? AND entity_type=? AND entity_id=?', (account_id, kind, entity_id)).fetchone()
                    remote_version = remote['version'] if remote else 0
                    if operation['baseVersion'] != remote_version:
                        result = {'conflict': {'opId': op_id, 'entityType': kind, 'entityId': entity_id, 'remote': {'version': remote_version, 'deleted': bool(remote['deleted']) if remote else False, 'data': json.loads(remote['data']) if remote and remote['data'] is not None else None}}}
                    else:
                        version = remote_version + 1
                        content = encoded(operation['data']).decode() if not operation['deleted'] else None
                        db.execute('INSERT INTO entities VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,entity_type,entity_id) DO UPDATE SET version=excluded.version,deleted=excluded.deleted,data=excluded.data', (account_id, kind, entity_id, version, int(operation['deleted']), content))
                        db.execute('UPDATE accounts SET change_seq=change_seq+1 WHERE id=?', (account_id,))
                        sequence = db.execute('SELECT change_seq FROM accounts WHERE id=?', (account_id,)).fetchone()[0]
                        db.execute('INSERT INTO changes VALUES(?,?,?,?,?,?,?)', (account_id, sequence, kind, entity_id, version, int(operation['deleted']), content))
                        result = {'accepted': {'opId': op_id, 'entityType': kind, 'entityId': entity_id, 'version': version}}
                    db.execute('INSERT INTO operations VALUES(?,?,?,?)', (account_id, op_id, hashes[op_id], encoded(result).decode()))
                db.commit()
            if 'accepted' in result: accepted.append(result['accepted'])
            else: conflicts.append(result['conflict'])
        return {'accepted': accepted, 'conflicts': conflicts}

    def pull(self, identity, cursor=0, limit=100):
        if isinstance(cursor, bool) or not isinstance(cursor, int) or not 0 <= cursor <= 9007199254740991 or isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_PULL:
            raise APIError(400, 'invalid_cursor', '同步游标或分页数量无效。')
        changes = []; size = 0; next_cursor = cursor
        with self.db() as db:
            db.execute('BEGIN')
            maximum = db.execute('SELECT change_seq FROM accounts WHERE id=?', (identity['accountId'],)).fetchone()[0]
            if cursor > maximum:
                raise APIError(409, 'cursor_ahead', '同步游标超出账号历史，请重新初始化同步。')
            for row in db.execute('SELECT * FROM changes WHERE account_id=? AND seq>? ORDER BY seq LIMIT ?', (identity['accountId'], cursor, limit)):
                change = {'seq': row['seq'], 'entityType': row['entity_type'], 'entityId': row['entity_id'], 'version': row['version'], 'deleted': bool(row['deleted']), 'data': json.loads(row['data']) if row['data'] is not None else None}
                length = len(encoded(change))
                if changes and size + length > MAX_PULL_BYTES:
                    break
                changes.append(change); size += length; next_cursor = row['seq']
        return {'changes': changes, 'cursor': next_cursor, 'hasMore': next_cursor < maximum}

    def blob_directory(self, account_id, create=False):
        if not re.fullmatch(r'[a-f0-9]{32}', account_id):
            raise APIError(404, 'not_found', '文件不存在。')
        root_fd = os.open(self.blobs, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            if create:
                try: os.mkdir(account_id, mode=0o700, dir_fd=root_fd)
                except FileExistsError: pass
                # Persist the account directory even when retrying a previous
                # upload whose directory flush failed after mkdir succeeded.
                os.fsync(root_fd)
            return os.open(account_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        finally:
            os.close(root_fd)

    @staticmethod
    def blob_hash(value):
        if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value):
            raise APIError(400, 'invalid_hash', '附件摘要无效。')
        return value

    def open_blob(self, identity, digest):
        self.blob_hash(digest)
        try:
            directory_fd = self.blob_directory(identity['accountId'])
            try: descriptor = os.open(digest, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
            finally: os.close(directory_fd)
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_BLOB:
                os.close(descriptor)
                raise APIError(404, 'not_found', '文件不存在。')
            return descriptor, metadata.st_size
        except OSError:
            raise APIError(404, 'not_found', '文件不存在。')

    def put_blob(self, identity, digest, source, length):
        self.blob_hash(digest)
        if isinstance(length, bool) or not isinstance(length, int) or not 0 <= length <= MAX_BLOB:
            raise APIError(413, 'blob_too_large', '单个附件不能超过 64 MB。')
        directory_fd = self.blob_directory(identity['accountId'], create=True)
        temporary = '.upload-' + uuid.uuid4().hex
        descriptor = None
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
            remaining = length; actual = hashlib.sha256()
            with os.fdopen(descriptor, 'wb') as destination:
                descriptor = None
                while remaining:
                    chunk = source.read(min(1024 * 1024, remaining))
                    if not chunk: raise APIError(400, 'incomplete_upload', '附件上传未完成，请重试。')
                    remaining -= len(chunk); actual.update(chunk); destination.write(chunk)
                destination.flush(); os.fsync(destination.fileno())
            if not hmac.compare_digest(actual.hexdigest(), digest):
                raise APIError(422, 'hash_mismatch', '附件内容与摘要不一致，未保存。')
            existed = False
            try:
                os.link(temporary, digest, src_dir_fd=directory_fd, dst_dir_fd=directory_fd, follow_symlinks=False)
            except FileExistsError:
                metadata = os.stat(digest, dir_fd=directory_fd, follow_symlinks=False)
                if not stat.S_ISREG(metadata.st_mode) or metadata.st_size != length:
                    raise APIError(409, 'blob_conflict', '已存附件状态异常，未覆盖原记录。')
                existed = True
            # fsync(file) does not persist its newly linked directory entry.
            # Do this on retries too: an earlier fsync failure may have left
            # the final name present without having acknowledged durability.
            os.fsync(directory_fd)
            return {'hash': digest, 'size': length, 'existed': existed}
        finally:
            if descriptor is not None: os.close(descriptor)
            try: os.unlink(temporary, dir_fd=directory_fd)
            except FileNotFoundError: pass
            finally: os.close(directory_fd)


class CloudHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    def server_bind(self):
        # A display hostname is not required by the protocol. Avoid blocking
        # startup on HTTPServer's implicit reverse lookup of the bound address.
        TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

    def __init__(self, address, store, web_origins=None):
        from cloud_web import origins
        self.web_origins = origins(os.environ.get('CLOUD_WEB_ORIGINS', '')) if web_origins is None else origins(','.join(web_origins))
        self.store = store
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(address, CloudHandler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            try: request.sendall(b'HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            finally: self.shutdown_request(request)
            return
        try: super().process_request(request, client_address)
        except Exception:
            self.slots.release(); raise

    def process_request_thread(self, request, client_address):
        try: super().process_request_thread(request, client_address)
        finally: self.slots.release()


class CloudHandler(BaseHTTPRequestHandler):
    server_version = 'WorkstationSync/1'
    sys_version = ''
    protocol_version = 'HTTP/1.1'

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def log_message(self, *args):
        # No headers, request bodies, URLs with credentials, or access tokens.
        pass

    def end_headers(self):
        origin = self.headers.get('Origin')
        if origin and origin in self.server.web_origins:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Expose-Headers', 'ETag, Content-Length')
        super().end_headers()

    def do_OPTIONS(self):
        if self.headers.get('Origin') not in self.server.web_origins:
            self.send_json({'error': '当前网页尚未获准连接此服务。', 'code': 'origin_denied'}, 403); return
        method = self.headers.get('Access-Control-Request-Method', '')
        headers = {h.strip().lower() for h in self.headers.get('Access-Control-Request-Headers', '').split(',') if h.strip()}
        if method not in ('GET', 'HEAD', 'POST', 'PUT', 'DELETE') or headers - {'authorization', 'content-type'}:
            self.send_json({'error': '跨域请求无效。', 'code': 'cors_denied'}, 403); return
        self.send_response(204)
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        self.send_header('Access-Control-Max-Age', '600')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def send_json(self, payload, status=200):
        data = encoded(payload)
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if status >= 400:
            self.close_connection = True
            self.send_header('Connection', 'close')
        if status == 429: self.send_header('Retry-After', '60')
        self.end_headers()
        if self.command != 'HEAD': self.wfile.write(data)

    def send_error(self, code, message=None, explain=None):
        self.send_json({'error': '请求无法处理。', 'code': 'http_error'}, code)

    def content_length(self, maximum):
        values = self.headers.get_all('Content-Length', [])
        if self.headers.get('Transfer-Encoding') or len(values) != 1 or not re.fullmatch(r'[0-9]{1,12}', values[0]):
            raise APIError(411, 'length_required', '请提供有效的 Content-Length。')
        length = int(values[0])
        if length > maximum: raise APIError(413, 'body_too_large', '请求内容过大。')
        return length

    def json_body(self):
        length = self.content_length(MAX_JSON)
        raw = self.rfile.read(length)
        if len(raw) != length: raise APIError(400, 'invalid_json', '请求内容不完整。')
        try:
            def invalid_constant(_): raise ValueError()
            return json.loads(raw, parse_constant=invalid_constant)
        except (ValueError, UnicodeError, RecursionError):
            raise APIError(400, 'invalid_json', '请求必须为有效 JSON。')

    def route(self):
        if self.headers.get('Origin') and self.headers.get('Origin') not in self.server.web_origins:
            raise APIError(403, 'origin_denied', '当前网页尚未获准连接此服务。')
        request_url = urlsplit(self.path); path = request_url.path; store = self.server.store
        if path == '/v1/health' and self.command in ('GET', 'HEAD'):
            self.send_json({'protocol': PROTOCOL}); return
        if path == '/v1/auth/login' and self.command == 'POST':
            self.send_json(store.login(self.json_body(), self.client_address[0])); return
        identity = store.authenticate(self.headers.get('Authorization'))
        if path == '/v1/web/relay' and self.command == 'POST':
            from cloud_web import relay
            self.send_json(relay(self.json_body(), APIError))
        elif path == '/v1/devices' and self.command == 'GET':
            self.send_json(store.devices(identity))
        elif path == '/v1/auth/logout' and self.command == 'POST':
            # Consume only an optional empty/object body; its content is unused.
            if self.headers.get('Content-Length') not in (None, '0'): self.json_body()
            self.send_json(store.logout(identity))
        elif path.startswith('/v1/devices/') and self.command == 'DELETE':
            self.send_json(store.revoke_device(identity, path.removeprefix('/v1/devices/')))
        elif path == '/v1/sync/push' and self.command == 'POST':
            self.send_json(store.push(identity, self.json_body()))
        elif path == '/v1/sync/pull' and self.command == 'GET':
            query = parse_qs(request_url.query, keep_blank_values=True)
            if set(query) - {'cursor', 'limit'} or any(len(values) != 1 for values in query.values()):
                raise APIError(400, 'invalid_cursor', '同步分页参数无效。')
            cursor = query.get('cursor', ['0'])[0]; limit = query.get('limit', ['100'])[0]
            if not re.fullmatch(r'[0-9]{1,16}', cursor) or not re.fullmatch(r'[0-9]{1,3}', limit):
                raise APIError(400, 'invalid_cursor', '同步分页参数无效。')
            self.send_json(store.pull(identity, int(cursor), int(limit)))
        elif path.startswith('/v1/blobs/') and self.command in ('HEAD', 'PUT', 'GET'):
            digest = path.removeprefix('/v1/blobs/')
            if self.command == 'PUT':
                self.send_json(store.put_blob(identity, digest, self.rfile, self.content_length(MAX_BLOB)))
            else:
                descriptor, size = store.open_blob(identity, digest)
                with os.fdopen(descriptor, 'rb') as source:
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/octet-stream')
                    self.send_header('Content-Length', str(size))
                    self.send_header('Content-Disposition', 'attachment')
                    self.send_header('Cache-Control', 'private, no-store')
                    self.send_header('ETag', '"' + digest + '"')
                    self.send_header('X-Content-Type-Options', 'nosniff')
                    self.end_headers()
                    if self.command != 'HEAD':
                        while True:
                            chunk = source.read(1024 * 1024)
                            if not chunk: break
                            self.wfile.write(chunk)
        else:
            raise APIError(404, 'not_found', '接口不存在。')

    def dispatch(self):
        try: self.route()
        except APIError as error:
            self.send_json({'error': error.message, 'code': error.code}, error.status)
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            self.close_connection = True
        except (ValueError, TypeError, RecursionError, UnicodeError):
            self.send_json({'error': '请求格式无效。', 'code': 'invalid_request'}, 400)
        except (OSError, sqlite3.Error):
            self.send_json({'error': '同步服务暂时不可用，请稍后重试。', 'code': 'storage_unavailable'}, 503)
        except Exception:
            self.send_json({'error': '同步服务暂时不可用。', 'code': 'internal_error'}, 500)

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = dispatch


def main(argv=None):
    parser = argparse.ArgumentParser(description='Workstation dedicated sync server, protocol v1')
    parser.add_argument('--data-dir', default=os.environ.get('CLOUD_DATA_DIR', './cloud-data'))
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('init', 'add-user'):
        command = commands.add_parser(name)
        command.add_argument('--username', required=True)
        command.add_argument('--password-stdin', action='store_true', required=True)
    serve = commands.add_parser('serve')
    serve.add_argument('--host', default=os.environ.get('CLOUD_HOST', '127.0.0.1'))
    serve.add_argument('--port', type=int, default=int(os.environ.get('CLOUD_PORT', '8787')))
    args = parser.parse_args(argv)
    try:
        store = CloudStore(args.data_dir)
        if args.command in ('init', 'add-user'):
            raw = sys.stdin.buffer.read(4097)
            if len(raw) > 4096: raise APIError(400, 'invalid_password', '密码输入过长。')
            password = raw.decode('utf-8').rstrip('\r\n')
            if '\n' in password or '\r' in password: raise APIError(400, 'invalid_password', '密码必须为单行文本。')
            account = store.add_user(args.username, password, initial=args.command == 'init')
            print(json.dumps({'account': account}, ensure_ascii=False))
            return 0
        if not 0 <= args.port <= 65535: raise ValueError('Invalid port')
        httpd = CloudHTTPServer((args.host, args.port), store)
        print(f'Workstation sync protocol 1 listening on {args.host}:{httpd.server_port}', flush=True)
        try: httpd.serve_forever()
        except KeyboardInterrupt: pass
        finally: httpd.server_close()
        return 0
    except APIError as error:
        print(error.message, file=sys.stderr); return 1
    except (OSError, ValueError, UnicodeError, sqlite3.Error):
        print('无法初始化云同步服务，请检查配置和存储权限。', file=sys.stderr); return 1


if __name__ == '__main__':
    raise SystemExit(main())
