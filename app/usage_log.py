"""Per-request usage log for the Models page statistics.

One row per model request: when, which provider and model, which purpose, token counts, latency and outcome.
Prompts, answers, URLs and keys are never stored; unknown fields in a record are dropped. Rows older than the
retention window (90 days by default) are removed. The file lives in the private data folder (0600).
"""
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
import urllib.parse

from window_only import is_settings_window

PREFIX = '/__usage/'
RETENTION_DEFAULT = 90
RETENTION_CHOICES = (7, 30, 90, 365)
ROLES = ('qa', 'translate', 'vision', 'kernel', 'other')
OUTCOMES = ('completed', 'failed', 'cancelled', 'interrupted')
KINDS = ('api', 'account')
RANGES = {'24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400, 'all': None}
MAX_ROWS = 200
MAX_COUNT = 2 ** 40


class UsageError(Exception):
    def __init__(self, message, status=400, code='usage_invalid'):
        super().__init__(message)
        self.status, self.code = status, code


def _count(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
        return None
    number = int(value)
    return number if 0 <= number <= MAX_COUNT else None


def _text(value, limit):
    return re.sub(r'[\x00-\x1f\x7f]', ' ', str(value if value is not None else '')).strip()[:limit]


class UsageLog:
    def __init__(self, path, now=time.time):
        self.path, self._now, self._lock = Path(path), now, threading.Lock()
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with self._lock, self._connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, provider_id TEXT NOT NULL, provider_kind TEXT NOT NULL,
                model TEXT NOT NULL, role TEXT NOT NULL, input INTEGER, output INTEGER, cache_read INTEGER, latency_ms INTEGER,
                first_token_ms INTEGER, status INTEGER, outcome TEXT NOT NULL, run_id TEXT NOT NULL DEFAULT '')''')
            db.execute('CREATE INDEX IF NOT EXISTS requests_ts ON requests (ts)')
            db.execute('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    def _connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        return db

    # ---- retention ----
    def retention_days(self):
        with self._lock, self._connect() as db:
            row = db.execute("SELECT value FROM meta WHERE key='retention_days'").fetchone()
        try:
            value = int(row['value']) if row else RETENTION_DEFAULT
        except ValueError:
            value = RETENTION_DEFAULT
        return value if value in RETENTION_CHOICES else RETENTION_DEFAULT

    def set_retention(self, days):
        if days not in RETENTION_CHOICES:
            raise UsageError('保留天数无效。')
        with self._lock, self._connect() as db:
            db.execute("INSERT INTO meta (key, value) VALUES ('retention_days', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(days),))
        self.prune()
        return days

    def prune(self):
        cutoff = int(self._now()) - self.retention_days() * 86400
        with self._lock, self._connect() as db:
            return db.execute('DELETE FROM requests WHERE ts < ?', (cutoff,)).rowcount

    def clear(self):
        with self._lock, self._connect() as db:
            return db.execute('DELETE FROM requests').rowcount

    # ---- write ----
    def record(self, entry):
        if not isinstance(entry, dict):
            raise UsageError('用量记录格式无效。')
        provider = _text(entry.get('providerId'), 300)
        model = _text(entry.get('model'), 200)
        if not provider or not model:
            raise UsageError('用量记录缺少供应商或模型。')
        kind = entry.get('providerKind') if entry.get('providerKind') in KINDS else 'api'
        role = entry.get('role') if entry.get('role') in ROLES else 'other'
        outcome = entry.get('outcome') if entry.get('outcome') in OUTCOMES else 'failed'
        ts = _count(entry.get('ts'))
        now = int(self._now())
        # 时间戳由客户端给出（毫秒或秒都接受），但不能是未来或早于保留期。
        if ts is not None and ts > 10 ** 11:
            ts //= 1000
        if ts is None or ts > now + 60:
            ts = now
        status = _count(entry.get('status'))
        row = (ts, provider, kind, model, role, _count(entry.get('input')), _count(entry.get('output')), _count(entry.get('cacheRead')),
               _count(entry.get('latencyMs')), _count(entry.get('firstTokenMs')), status if status is not None and status <= 999 else None, outcome, _text(entry.get('runId'), 120))
        with self._lock, self._connect() as db:
            cursor = db.execute('INSERT INTO requests (ts, provider_id, provider_kind, model, role, input, output, cache_read, latency_ms, first_token_ms, status, outcome, run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', row)
            return cursor.lastrowid

    # ---- read ----
    def query(self, range_name='7d', limit=MAX_ROWS):
        if range_name not in RANGES:
            raise UsageError('时间范围无效。')
        span = RANGES[range_name]
        since = int(self._now()) - span if span else 0
        limit = max(1, min(MAX_ROWS, int(limit)))
        with self._lock, self._connect() as db:
            card = db.execute('''SELECT COUNT(*) AS requests, COALESCE(SUM(input),0) AS input, COALESCE(SUM(output),0) AS output, COALESCE(SUM(cache_read),0) AS cache_read,
                COALESCE(SUM(CASE WHEN cache_read IS NOT NULL THEN input ELSE 0 END),0) AS cache_basis,
                COALESCE(SUM(CASE WHEN outcome != 'completed' THEN 1 ELSE 0 END),0) AS failed FROM requests WHERE ts >= ?''', (since,)).fetchone()
            groups = lambda sql: [dict(row) for row in db.execute(sql, (since,))]
            by_provider = groups('SELECT provider_id, provider_kind, COUNT(*) AS requests, COALESCE(SUM(input),0) AS input, COALESCE(SUM(output),0) AS output, COALESCE(SUM(cache_read),0) AS cache_read FROM requests WHERE ts >= ? GROUP BY provider_id, provider_kind ORDER BY requests DESC')
            by_model = groups('SELECT provider_id, provider_kind, model, COUNT(*) AS requests, COALESCE(SUM(input),0) AS input, COALESCE(SUM(output),0) AS output, COALESCE(SUM(cache_read),0) AS cache_read FROM requests WHERE ts >= ? GROUP BY provider_id, provider_kind, model ORDER BY requests DESC')
            rows = [dict(row) for row in db.execute('SELECT ts, provider_id, provider_kind, model, role, input, output, cache_read, latency_ms, status, outcome FROM requests WHERE ts >= ? ORDER BY ts DESC, id DESC LIMIT ?', (since, limit))]
        cache_rate = (card['cache_read'] / card['cache_basis']) if card['cache_basis'] else None
        return {'range': range_name, 'since': since, 'retentionDays': self.retention_days(),
                'cards': {'requests': card['requests'], 'input': card['input'], 'output': card['output'], 'cacheRead': card['cache_read'], 'cacheHitRate': cache_rate, 'failed': card['failed']},
                'byProvider': by_provider, 'byModel': by_model, 'rows': rows}


def _json_body(handler, limit=65536):
    lengths = handler.headers.get_all('Content-Length', []) if hasattr(handler.headers, 'get_all') else [handler.headers.get('Content-Length')]
    if handler.headers.get('Transfer-Encoding') or len(lengths) != 1 or not re.fullmatch(r'[0-9]+', str(lengths[0] or '')) or int(lengths[0]) > limit:
        raise UsageError('请求长度无效。')
    value = json.loads(handler.rfile.read(int(lengths[0])) or b'{}')
    if not isinstance(value, dict):
        raise UsageError('请求格式无效。')
    return value


def handle_request(handler, log):
    """True when the path is ours. Only the settings window may read or write the log."""
    parts = urllib.parse.urlsplit(handler.path)
    if not parts.path.startswith(PREFIX):
        return False
    try:
        if not is_settings_window(handler, mutation=handler.command != 'GET'):
            raise UsageError('只有应用窗口可以访问用量记录。', 403, 'usage_window_only')
        name = parts.path[len(PREFIX):]
        if handler.command == 'GET' and name == 'query':
            query = urllib.parse.parse_qs(parts.query)
            handler.send_json(log.query((query.get('range') or ['7d'])[0], int((query.get('limit') or [MAX_ROWS])[0])))
        elif handler.command == 'POST' and name == 'record':
            body = _json_body(handler)
            entries = body.get('entries') if isinstance(body.get('entries'), list) else [body]
            saved = 0
            for entry in entries[:50]:
                try:
                    log.record(entry); saved += 1
                except UsageError:
                    continue
            handler.send_json({'saved': saved})
        elif handler.command == 'POST' and name == 'settings':
            handler.send_json({'retentionDays': log.set_retention(_json_body(handler).get('retentionDays'))})
        elif handler.command == 'POST' and name == 'clear':
            _json_body(handler)
            handler.send_json({'cleared': log.clear()})
        else:
            raise UsageError('找不到接口。', 404, 'not_found')
    except UsageError as error:
        handler.send_json({'error': str(error), 'code': error.code}, error.status)
    except (ValueError, UnicodeError):
        handler.send_json({'error': '请求格式无效。', 'code': 'usage_invalid'}, 400)
    except sqlite3.Error:
        handler.send_json({'error': '用量记录暂时不可用。', 'code': 'usage_unavailable'}, 503)
    return True
