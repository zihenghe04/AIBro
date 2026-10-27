"""Import API providers from a CC Switch database, SQL export or ccswitch:// link.

Logic ported from CC Switch (https://github.com/farion1231/cc-switch, MIT).
Copyright (c) 2025 Jason Young. The licence text is in docs/THIRD_PARTY.md.

Rules:
- Nothing is read until the user clicks "Import from CC Switch". Then the default database
  (~/.cc-switch/cc-switch.db, HOME-relative) is read if it exists, or the user picks a file in the native
  file dialog and the page uploads that one file. Either way it is opened read-only from a private
  temporary copy (database and WAL side files), and the copy is deleted.
- No other application directory is ever listed or read; the default location is a single fixed file path.
- A preview carries only the last four characters of each key. The full keys stay in memory under a
  one-time import id (10 minutes) and are handed to the window once, for the keychain write.
- Keys are never logged and never written to disk by this module.
"""
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import tempfile
import threading
import time
import urllib.parse

from window_only import is_settings_window

PREFIX = '/__providers/ccswitch/'
MAX_UPLOAD = 512 * 1024 * 1024
MAX_ROWS = 500
MAX_CONFIG = 256 * 1024
TTL = 600
MAX_SESSIONS = 4
MANAGED_TYPES = {'codex_oauth', 'xai_oauth', 'github_copilot'}
PROTOCOLS = {'responses', 'chat', 'anthropic'}
DEFAULT_DIR, DEFAULT_NAME = '.cc-switch', 'cc-switch.db'


class ImportError_(Exception):
    def __init__(self, message, status=400, code='ccswitch_invalid'):
        super().__init__(message)
        self.status, self.code = status, code


def default_db_path():
    """The default CC Switch database location. Follows HOME so tests can redirect it; only this one file is ever read."""
    return Path(os.path.expanduser('~')) / DEFAULT_DIR / DEFAULT_NAME


def snapshot_default(folder):
    """Copy the default database (plus WAL side files, so recent writes are seen) into `folder` and return the copy's path, or None when it is absent."""
    source = default_db_path()
    try:
        if not source.is_file():
            return None
        if source.stat().st_size > MAX_UPLOAD:
            raise ImportError_('数据库文件太大（上限 512 MB）。请先在原应用里导出 SQL，再选择导出文件。', 413, 'ccswitch_too_large')
        copy = Path(folder) / 'default.db'
        for suffix in ('', '-wal', '-shm'):
            part = Path(str(source) + suffix)
            if part.is_file():
                fd = os.open(str(copy) + suffix, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, 'wb') as out, open(part, 'rb') as handle:
                    while True:
                        chunk = handle.read(1 << 20)
                        if not chunk:
                            break
                        out.write(chunk)
        with open(copy, 'rb') as handle:
            if handle.read(16) != b'SQLite format 3\x00':
                raise ImportError_('默认位置的文件不是有效的数据库。')
        return copy
    except OSError:
        raise ImportError_('无法读取默认位置的数据库。')


def _text(value, limit=200):
    return re.sub(r'[\x00-\x1f\x7f]', ' ', str(value if value is not None else '')).strip()[:limit]


def mask_key(token):
    """Last four characters only; short keys reveal nothing."""
    token = str(token or '')
    return token[-4:] if len(token) >= 12 else ''


def normalize_base(value):
    """https/http address without credentials, query or fragment; '' when unusable."""
    try:
        url = urllib.parse.urlsplit(str(value or '').strip())
    except ValueError:
        return ''
    if url.scheme not in ('https', 'http') or not url.hostname or url.username or url.password:
        return ''
    path = re.sub(r'/+$', '', url.path)
    for tail in ('/chat/completions', '/responses', '/messages', '/models'):
        if path.lower().endswith(tail):
            path = path[: -len(tail)]
            break
    host = url.hostname.lower()
    if ':' in host:
        host = f'[{host}]'
    port = f':{url.port}' if url.port else ''
    return f'{url.scheme}://{host}{port}{path}'


# ---- minimal TOML reader: only what a Codex config.toml needs (strings, bare keys, [a.b] tables) ----
def parse_codex_toml(source):
    root = {}
    table = root
    for raw in str(source or '').splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        header = re.fullmatch(r'\[\s*([A-Za-z0-9_.\-"\' ]+?)\s*\]', line)
        if header:
            table = root
            for part in [p.strip().strip('"\'') for p in header.group(1).split('.')]:
                table = table.setdefault(part, {})
                if not isinstance(table, dict):
                    table = {}
            continue
        pair = re.fullmatch(r'([A-Za-z0-9_\-]+|"[^"]*")\s*=\s*(.+?)\s*(?:#.*)?', line)
        if not pair:
            continue
        key, value = pair.group(1).strip('"'), pair.group(2).strip()
        quoted = re.fullmatch(r'"((?:[^"\\]|\\.)*)"|\'([^\']*)\'', value)
        if quoted:
            if quoted.group(1) is not None:
                try:
                    table[key] = json.loads('"' + quoted.group(1) + '"')
                except ValueError:
                    table[key] = quoted.group(1)
            else:
                table[key] = quoted.group(2)
        elif value in ('true', 'false'):
            table[key] = value == 'true'
    return root


def _candidate(app, name, base, protocol, model, models, token, website, category, row_id=''):
    base = normalize_base(base)
    host = urllib.parse.urlsplit(base).hostname or '' if base else ''
    return {'app': app, 'name': _text(name, 80) or host, 'base': base, 'host': host, 'protocol': protocol if protocol in PROTOCOLS else 'auto',
            'model': _text(model), 'models': [m for m in dict.fromkeys(_text(x) for x in models) if m][:50], 'token': str(token or ''),
            'website': _text(website, 300), 'category': _text(category, 40), 'id': _text(row_id, 120)}


def parse_provider_row(app, name, settings_config, website, category, meta, row_id='', current=False, notes=''):
    """One providers row → {status, reason?, ...candidate}. Never raises on bad content."""
    skipped = lambda reason: {'status': 'skipped', 'reason': reason, 'app': app, 'name': _text(name, 80), 'host': '', 'base': '', 'protocol': 'auto', 'models': [], 'token': '', 'current': bool(current), 'notes': _text(notes, 80)}
    item = _parse_provider(app, name, settings_config, website, category, meta, row_id, skipped)
    item['current'], item['notes'] = bool(current), _text(notes, 80)
    return item


def _parse_provider(app, name, settings_config, website, category, meta, row_id, skipped):
    try:
        meta_value = json.loads(meta) if meta else {}
    except (TypeError, ValueError):
        meta_value = {}
    if isinstance(meta_value, dict) and meta_value.get('providerType') in MANAGED_TYPES:
        return skipped('account')
    if app not in ('codex', 'claude'):
        return skipped('unsupported')
    if not isinstance(settings_config, str) or len(settings_config) > MAX_CONFIG:
        return skipped('invalid')
    try:
        config = json.loads(settings_config)
    except ValueError:
        return skipped('invalid')
    if not isinstance(config, dict):
        return skipped('invalid')
    if app == 'codex':
        auth = config.get('auth') if isinstance(config.get('auth'), dict) else {}
        toml = parse_codex_toml(config.get('config') if isinstance(config.get('config'), str) else '')
        provider_id = toml.get('model_provider') if isinstance(toml.get('model_provider'), str) else ''
        providers = toml.get('model_providers') if isinstance(toml.get('model_providers'), dict) else {}
        section = providers.get(provider_id) if isinstance(providers.get(provider_id), dict) else (next(iter(providers.values())) if providers and isinstance(next(iter(providers.values())), dict) else {})
        base = section.get('base_url') if isinstance(section.get('base_url'), str) else ''
        wire = section.get('wire_api') if isinstance(section.get('wire_api'), str) else ''
        model = toml.get('model') if isinstance(toml.get('model'), str) else ''
        token = auth.get('OPENAI_API_KEY') if isinstance(auth.get('OPENAI_API_KEY'), str) else ''
        if not normalize_base(base):
            return skipped('no_address' if not str(base).strip() else 'invalid')
        item = _candidate('codex', name or section.get('name'), base, 'chat' if wire == 'chat' else 'responses', model, [model], token, website, category, row_id)
    else:
        env = config.get('env') if isinstance(config.get('env'), dict) else {}
        base = env.get('ANTHROPIC_BASE_URL') if isinstance(env.get('ANTHROPIC_BASE_URL'), str) else ''
        token = env.get('ANTHROPIC_AUTH_TOKEN') or env.get('ANTHROPIC_API_KEY') or ''
        models = [env.get(k) for k in ('ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL') if isinstance(env.get(k), str)]
        if not normalize_base(base):
            # 官方 Claude 账号等没有自定义地址：没有可导入的静态密钥。
            return skipped('no_usable_key' if not token else 'no_address')
        item = _candidate('claude', name, base, 'anthropic', models[0] if models else '', models, token if isinstance(token, str) else '', website, category, row_id)
    item['status'] = 'ready' if item['token'] else 'no_key'
    return item


def _rows(connection):
    columns = {row[1] for row in connection.execute('PRAGMA table_info(providers)')}
    if not {'app_type', 'name', 'settings_config'} <= columns:
        raise ImportError_('这个文件里没有可导入的供应商表。')
    pick = lambda c, default='NULL': c if c in columns else default
    query = f"SELECT id, app_type, name, settings_config, {pick('website_url')}, {pick('category')}, {pick('meta', chr(39) + '{}' + chr(39))}, {pick('sort_index', '0')}, {pick('is_current', '0')}, {pick('notes', chr(39) + chr(39))} FROM providers ORDER BY COALESCE({pick('sort_index', '0')}, 0), name LIMIT {MAX_ROWS}"
    return connection.execute(query).fetchall()


def parse_database(path, immutable=True):
    """Open read-only (immutable unless WAL side files were copied next to it). The file is only read; nothing in or next to it changes."""
    uri = 'file:' + urllib.parse.quote(str(path)) + ('?mode=ro&immutable=1' if immutable else '?mode=ro')
    try:
        connection = sqlite3.connect(uri, uri=True, timeout=2)
    except sqlite3.Error:
        raise ImportError_('无法以只读方式打开这个文件。')
    try:
        connection.text_factory = lambda raw: raw.decode('utf-8', 'replace')
        rows = _rows(connection)
    except sqlite3.Error:
        raise ImportError_('这不是有效的供应商数据库。')
    finally:
        connection.close()
    return [parse_provider_row(app, name, config, website, category, meta, row_id, current, notes) for row_id, app, name, config, website, category, meta, _, current, notes in rows]


def parse_sql_export(text):
    """An exported .sql dump: only the providers table is created and filled; every other statement is ignored."""
    memory = sqlite3.connect(':memory:')
    try:
        buffer = ''
        for line in str(text).splitlines(keepends=True):
            buffer += line
            if not sqlite3.complete_statement(buffer):
                continue
            statement, buffer = buffer.strip(), ''
            head = re.sub(r'\s+', ' ', statement[:80]).upper()
            if re.match(r'^CREATE TABLE (IF NOT EXISTS )?["`\[]?PROVIDERS["`\]]? ?\(', head) or re.match(r'^INSERT INTO ["`\[]?PROVIDERS["`\]]? ', head):
                try:
                    memory.execute(statement)
                except sqlite3.Error:
                    continue
        return [parse_provider_row(app, name, config, website, category, meta, row_id, current, notes) for row_id, app, name, config, website, category, meta, _, current, notes in _rows(memory)]
    except sqlite3.Error:
        raise ImportError_('这个 SQL 文件里没有供应商数据。')
    finally:
        memory.close()


def parse_link(link):
    """ccswitch://v1/import?resource=provider&app=…&name=…&endpoint=…&apiKey=…&model=… (parsed only, never registered)."""
    try:
        url = urllib.parse.urlsplit(str(link or '').strip())
    except ValueError:
        raise ImportError_('链接格式无效。')
    if url.scheme.lower() != 'ccswitch' or url.hostname != 'v1' or url.path.strip('/') != 'import':
        raise ImportError_('这不是有效的导入链接。')
    params = {key: values[0] for key, values in urllib.parse.parse_qs(url.query, keep_blank_values=True).items()}
    if params.get('resource') != 'provider':
        raise ImportError_('这个链接不是供应商。')
    app = params.get('app', '')
    endpoint = (params.get('endpoint') or '').split(',')[0].strip()
    models = [params.get(k) for k in ('model', 'opusModel', 'sonnetModel', 'haikuModel') if params.get(k)]
    api_format = params.get('apiFormat', '')
    protocol = {'openai_chat': 'chat', 'openai_responses': 'responses', 'anthropic': 'anthropic'}.get(api_format) or ('anthropic' if app == 'claude' else 'responses')
    if app not in ('codex', 'claude') or not normalize_base(endpoint):
        return [{'status': 'skipped', 'reason': 'unsupported' if app not in ('codex', 'claude') else 'no_address', 'app': app, 'name': _text(params.get('name'), 80), 'host': '', 'base': '', 'protocol': 'auto', 'models': [], 'token': ''}]
    item = _candidate(app, params.get('name'), endpoint, protocol, models[0] if models else '', models, params.get('apiKey'), params.get('homepage'), '')
    item['status'] = 'ready' if item['token'] else 'no_key'
    return [item]


def parse_bytes(data, name=''):
    """Pick the format from the content, not the file name."""
    if data[:16] == b'SQLite format 3\x00':
        with tempfile.TemporaryDirectory(prefix='aibro-ccswitch-') as folder:
            os.chmod(folder, 0o700)
            copy = Path(folder) / 'copy.db'
            fd = os.open(copy, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as handle:
                handle.write(data)
            return parse_database(copy)
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        raise ImportError_('这个文件不是可导入的数据库或 SQL 导出。')
    if re.search(r'\bINSERT\s+INTO\b', text, re.I) and re.search(r'providers', text, re.I):
        return parse_sql_export(text)
    raise ImportError_('这个文件不是可导入的数据库或 SQL 导出。')


def preview_item(index, item):
    """What the window may see: no key, only the last four characters."""
    return {'index': index, 'app': item.get('app', ''), 'name': item.get('name', ''), 'host': item.get('host', ''), 'base': item.get('base', ''), 'protocol': item.get('protocol', 'auto'),
            'models': list(item.get('models') or []), 'model': item.get('model', ''), 'keyLast4': mask_key(item.get('token')), 'hasKey': bool(item.get('token')),
            'status': item.get('status', 'skipped'), 'reason': item.get('reason', ''), 'current': bool(item.get('current')), 'notes': item.get('notes', '')}


class ImportSessions:
    """Parsed candidates (with keys) kept in memory under a random one-time id."""

    def __init__(self, now=time.time):
        self._now, self._lock, self._items = now, threading.Lock(), {}

    def _sweep(self):
        for key in [k for k, v in self._items.items() if v['expires'] <= self._now()]:
            del self._items[key]

    def create(self, candidates):
        with self._lock:
            self._sweep()
            while len(self._items) >= MAX_SESSIONS:
                del self._items[min(self._items, key=lambda k: self._items[k]['expires'])]
            import_id = secrets.token_urlsafe(18)
            self._items[import_id] = {'candidates': candidates, 'expires': self._now() + TTL}
            return import_id

    def take(self, import_id, indices, include_keys=True):
        """One-time: returns the chosen candidates (with keys when asked) and discards the session."""
        with self._lock:
            self._sweep()
            entry = self._items.pop(str(import_id), None)
        if not entry:
            raise ImportError_('导入已过期，请重新选择文件。', 410, 'ccswitch_expired')
        out = []
        for index in indices:
            if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < len(entry['candidates']):
                continue
            item = entry['candidates'][index]
            if item.get('status') in ('ready', 'no_key'):
                out.append({**{k: item[k] for k in ('app', 'name', 'base', 'protocol', 'model', 'models', 'host')}, 'token': item['token'] if include_keys else ''})
        return out

    def discard(self, import_id):
        with self._lock:
            self._items.pop(str(import_id), None)


def handle_request(handler, sessions):
    """True when the path is ours. Only the settings window (same loopback origin) may call it."""
    path = urllib.parse.urlsplit(handler.path).path
    if not path.startswith(PREFIX):
        return False
    try:
        if handler.command != 'POST' or not is_settings_window(handler):
            raise ImportError_('只有设置页可以导入供应商。', 403, 'ccswitch_window_only')
        name = path[len(PREFIX):]
        lengths = handler.headers.get_all('Content-Length', []) if hasattr(handler.headers, 'get_all') else [handler.headers.get('Content-Length')]
        if handler.headers.get('Transfer-Encoding') or len(lengths) != 1 or not re.fullmatch(r'[0-9]+', str(lengths[0] or '')):
            raise ImportError_('请求长度无效。')
        length = int(lengths[0])
        if name == 'default':
            # Read on click only: the one fixed default path, via a private copy.
            with tempfile.TemporaryDirectory(prefix='aibro-ccswitch-') as folder:
                os.chmod(folder, 0o700)
                copy = snapshot_default(folder)
                if copy is None:
                    handler.send_json({'found': False, 'path': str(default_db_path())})
                    return True
                candidates = parse_database(copy, immutable=False)
            import_id = sessions.create(candidates)
            handler.send_json({'found': True, 'path': str(default_db_path()), 'importId': import_id, 'expiresIn': TTL, 'items': [preview_item(i, c) for i, c in enumerate(candidates)]})
            return True
        if name == 'preview':
            if length > MAX_UPLOAD:
                raise ImportError_('文件太大（上限 512 MB）。请先在原应用里导出 SQL，再选择导出文件。', 413, 'ccswitch_too_large')
            kind = (handler.headers.get('Content-Type') or '').split(';', 1)[0].strip().lower()
            if kind == 'application/json':
                body = json.loads(handler.rfile.read(min(length, 65536)) or b'{}')
                candidates = parse_link(body.get('link') if isinstance(body, dict) else '')
            else:
                with tempfile.TemporaryDirectory(prefix='aibro-ccswitch-') as folder:
                    os.chmod(folder, 0o700)
                    upload = Path(folder) / 'upload'
                    fd = os.open(upload, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    remaining = length
                    with os.fdopen(fd, 'wb') as handle:
                        while remaining > 0:
                            chunk = handler.rfile.read(min(1 << 20, remaining))
                            if not chunk:
                                raise ImportError_('文件没有完整收到。')
                            handle.write(chunk)
                            remaining -= len(chunk)
                    with open(upload, 'rb') as handle:
                        head = handle.read(16)
                    if head == b'SQLite format 3\x00':
                        candidates = parse_database(upload)
                    else:
                        if length > 64 * 1024 * 1024:
                            raise ImportError_('这个文件不是可导入的数据库或 SQL 导出。')
                        candidates = parse_bytes(upload.read_bytes())
            import_id = sessions.create(candidates)
            handler.send_json({'importId': import_id, 'expiresIn': TTL, 'items': [preview_item(i, c) for i, c in enumerate(candidates)]})
            return True
        if name in ('commit', 'cancel'):
            body = json.loads(handler.rfile.read(min(length, 65536)) or b'{}')
            if not isinstance(body, dict):
                raise ImportError_('请求格式无效。')
            if name == 'cancel':
                sessions.discard(body.get('importId'))
                handler.send_json({'ok': True})
                return True
            indices = body.get('selected') if isinstance(body.get('selected'), list) else []
            handler.send_json({'items': sessions.take(body.get('importId'), indices[:MAX_ROWS], body.get('includeKeys') is not False)})
            return True
        raise ImportError_('找不到接口。', 404, 'not_found')
    except ImportError_ as error:
        handler.send_json({'error': str(error), 'code': error.code}, error.status)
    except (ValueError, UnicodeError):
        handler.send_json({'error': '请求格式无效。', 'code': 'ccswitch_invalid'}, 400)
    return True
