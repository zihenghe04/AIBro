"""Append-only run event log (JSONL), written alongside the workspace snapshot.

One file per run, ``<data>/runs/<yyyy-mm>/<runId>.jsonl``, plus one file per day
for the ``app`` stream, ``<data>/events/app-<yyyy-mm-dd>.jsonl``. Events carry a
per-stream ``seq``; a batch must continue the stream exactly (a resent batch is
accepted once and ignored afterwards). Ephemeral events are not stored.

Nothing secret is stored: keys that look like credentials or request headers
are dropped and token-like strings are masked, whatever the client sent.
Retention: files older than 90 days go first, then the oldest files until the
log is under 300 MB. The snapshot stays the source of truth while this log is
written alongside it.
"""
import json, os, re, threading, time
from collections import deque
from pathlib import Path

RETENTION_DAYS = 90
MAX_BYTES = 300 * 1024 * 1024
MAX_BATCH = 500
MAX_LINE = 64 * 1024
PRUNE_INTERVAL = 3600
FSYNC_TYPES = {'tool/dispatched', 'approval/decided', 'run/finished', 'run/interrupted'}
TYPE = re.compile(r'^(run|step|tool|approval|model|artifact|reminder|data|plugin|tools)/[a-z][a-z-]{0,31}$')
RUN_ID = re.compile(r'^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$')
SECRET_KEY = re.compile(r'(api[-_]?key|apikey|secret|token|password|passwd|authorization|cookie|credential|headers?)$', re.I)
SECRET_TEXT = re.compile(r'(Bearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{8,}|\b(?:api[-_]?key|token|secret)\s*[=:]\s*[A-Za-z0-9._~+/-]{8,})', re.I)
FIELDS = ('v', 'id', 'stream', 'seq', 'ts', 'type', 'runId', 'parentId', 'callId', 'source', 'durability', 'model', 'data')


class EventLogError(Exception):
    def __init__(self, status, payload):
        super().__init__(payload.get('error', 'event log error'))
        self.status, self.payload = status, payload


def redact(value, depth=0):
    if depth > 12: return '[depth]'
    if isinstance(value, dict):
        return {str(k)[:120]: ('[redacted]' if SECRET_KEY.search(str(k)) else redact(v, depth + 1)) for k, v in value.items()}
    if isinstance(value, list): return [redact(v, depth + 1) for v in value[:500]]
    if isinstance(value, str): return SECRET_TEXT.sub('[redacted]', value)
    if value is None or isinstance(value, (bool, int, float)): return value
    return str(value)[:200]


class EventLog:
    def __init__(self, directory, retention_days=RETENTION_DAYS, max_bytes=MAX_BYTES, clock=time.time):
        self.directory = Path(directory)
        self.runs, self.app = self.directory / 'runs', self.directory / 'events'
        self.retention, self.max_bytes, self.clock = retention_days * 86400, max_bytes, clock
        self.lock = threading.Lock()
        self.streams = {}  # stream -> {'last': int, 'ids': deque, 'path': Path|None}
        self.pruned_at = 0

    # -- paths -----------------------------------------------------------
    def _run_path(self, run_id, ts):
        for existing in sorted(self.runs.glob('*/' + run_id + '.jsonl')): return existing
        month = time.strftime('%Y-%m', time.localtime(ts / 1000))
        return self.runs / month / (run_id + '.jsonl')

    def _app_path(self, ts):
        return self.app / ('app-' + time.strftime('%Y-%m-%d', time.localtime(ts / 1000)) + '.jsonl')

    @staticmethod
    def _last_line(path):
        try:
            with path.open('rb') as source:
                source.seek(0, os.SEEK_END); size = source.tell(); source.seek(max(0, size - MAX_LINE - 2))
                lines = [line for line in source.read().splitlines() if line.strip()]
            return json.loads(lines[-1]) if lines else None
        except (OSError, ValueError, IndexError): return None

    def _stream(self, stream, ts):
        state = self.streams.get(stream)
        if state is None:
            if stream == 'app':
                files = sorted(self.app.glob('app-*.jsonl'))
                last = self._last_line(files[-1]) if files else None
                path = None
            else:
                path = self._run_path(stream[4:], ts)
                last = self._last_line(path) if path.exists() else None
            state = {'last': int(last.get('seq', 0)) if isinstance(last, dict) else 0, 'ids': deque(maxlen=2000), 'path': path}
            self.streams[stream] = state
        return state

    # -- validation ------------------------------------------------------
    @staticmethod
    def _valid(event):
        if not isinstance(event, dict) or event.get('v') != 1: return 'v'
        if not isinstance(event.get('id'), str) or not 1 <= len(event['id']) <= 80: return 'id'
        stream = event.get('stream')
        if not isinstance(stream, str) or not (stream == 'app' or (stream.startswith('run:') and RUN_ID.match(stream[4:]))): return 'stream'
        if stream != 'app' and event.get('runId') != stream[4:]: return 'runId'
        for key in ('seq', 'ts'):
            if not isinstance(event.get(key), int) or isinstance(event.get(key), bool) or event[key] < (1 if key == 'seq' and event.get('durability') == 'durable' else 0): return key
        if not isinstance(event.get('type'), str) or not TYPE.match(event['type']): return 'type'
        if event.get('durability') not in ('durable', 'ephemeral'): return 'durability'
        return None

    def _line(self, event):
        record = {key: redact(event[key]) for key in FIELDS if key in event}
        line = json.dumps(record, ensure_ascii=False, separators=(',', ':'))
        if len(line.encode()) > MAX_LINE:
            record['data'] = {'truncated': True}
            line = json.dumps(record, ensure_ascii=False, separators=(',', ':'))
        return line

    # -- API -------------------------------------------------------------
    def append(self, events):
        if not isinstance(events, list) or len(events) > MAX_BATCH: raise EventLogError(400, {'error': '事件批次无效'})
        for index, event in enumerate(events):
            problem = self._valid(event)
            if problem: raise EventLogError(400, {'error': '事件格式无效', 'field': problem, 'index': index})
        with self.lock:
            writes, conflicts = {}, {}
            for event in events:
                if event['durability'] != 'durable': continue
                stream = event['stream']; state = self._stream(stream, event['ts'])
                planned = writes.get(stream)
                last = planned[-1]['seq'] if planned else state['last']
                if event['seq'] <= state['last'] and event['id'] in state['ids']: continue  # resent
                if event['seq'] != last + 1: conflicts[stream] = state['last']; continue
                writes.setdefault(stream, []).append(event)
            if conflicts: raise EventLogError(409, {'error': 'SEQ', 'last': conflicts})
            for stream, batch in writes.items():
                state = self.streams[stream]
                if stream == 'app': path = self._app_path(batch[0]['ts'])
                else: path = state['path']
                path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                text = ''.join(self._line(event) + '\n' for event in batch)
                fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
                try:
                    os.write(fd, text.encode())
                    if any(event['type'] in FSYNC_TYPES for event in batch): os.fsync(fd)
                finally: os.close(fd)
                state['last'] = batch[-1]['seq']; state['ids'].extend(event['id'] for event in batch)
            last = {stream: self.streams[stream]['last'] for stream in {e['stream'] for e in events} if stream in self.streams}
        if self.clock() - self.pruned_at > PRUNE_INTERVAL: self.prune()
        return {'ok': True, 'last': last}

    def emit(self, run_id, type, data=None, source=None, call_id=None):
        """Server-side event on a run stream (kernel run registry). Takes the next
        seq; a page appending to the same stream at the same moment wins and
        this event follows it (the page's own SEQ retry renumbers likewise)."""
        stream = 'run:' + run_id
        for _ in range(4):
            ts = int(self.clock() * 1000)
            with self.lock: last = self._stream(stream, ts)['last']
            event = {'v': 1, 'id': 'evt_srv_' + format(ts, 'x') + '_' + os.urandom(4).hex(), 'stream': stream, 'seq': last + 1, 'ts': ts, 'type': type,
                     'runId': run_id, 'source': source or {'kind': 'native', 'id': 'server'}, 'durability': 'durable', 'model': False, 'data': data or {}}
            if call_id: event['callId'] = call_id
            try: return self.append([event])
            except EventLogError as error:
                if error.status != 409: raise
        raise EventLogError(409, {'error': 'SEQ'})

    def read(self, stream, after=0, limit=1000):
        if not isinstance(stream, str) or not (stream == 'app' or (stream.startswith('run:') and RUN_ID.match(stream[4:]))):
            raise EventLogError(400, {'error': '无效的事件流'})
        files = sorted(self.app.glob('app-*.jsonl')) if stream == 'app' else sorted(self.runs.glob('*/' + stream[4:] + '.jsonl'))
        out = []
        for path in files:
            try:
                with path.open(encoding='utf-8') as source:
                    for line in source:
                        try: event = json.loads(line)
                        except ValueError: continue  # a torn last line after a crash
                        if event.get('seq', 0) > after: out.append(event)
                        if len(out) >= limit: return out
            except OSError: continue
        return out

    def prune(self):
        with self.lock:
            self.pruned_at = self.clock()
            files = []
            for path in [*self.runs.glob('*/*.jsonl'), *self.app.glob('app-*.jsonl')]:
                try: info = path.stat()
                except OSError: continue
                files.append((info.st_mtime, info.st_size, path))
            files.sort()
            cutoff, total, removed = self.clock() - self.retention, sum(size for _, size, _ in files), 0
            for mtime, size, path in files:
                if mtime >= cutoff and total <= self.max_bytes: break
                try: path.unlink(); removed += 1; total -= size
                except OSError: continue
                self.streams = {key: value for key, value in self.streams.items() if value.get('path') != path}
                if path.parent.parent == self.runs:
                    try: path.parent.rmdir()
                    except OSError: pass
            if removed: self.streams.pop('app', None)
            return {'removed': removed, 'bytes': total}
