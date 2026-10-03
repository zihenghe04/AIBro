"""Opt-in, local-only completion notifications. Never executes payload content.

Protocol reference: TO-DO Panel 1deb3cac, main.js:465-610,882-969 and
scripts/{codex,claude}-notify.js (MIT; docs/licenses/to-do-panel-MIT.txt).
This implementation does not read transcripts or install third-party hooks.
"""
import copy
import hashlib
import hmac
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import secrets
import stat
import threading
import time
import urllib.parse

SOURCES = ('codex', 'claude', 'gpt')
MAX_BODY = 64 * 1024
MAX_DISK = 1024 * 1024
HISTORY_LIMIT = 20
PENDING_LIMIT = 100
SEEN_LIMIT = 512
STABLE_TTL = 7 * 86400


class NotificationError(Exception):
    def __init__(self, code, status=400):
        self.code, self.status = code, status
        super().__init__(code)


class NotificationCommitUncertain(OSError):
    """The rename happened but directory durability could not be confirmed."""


def text(value, limit):
    if not isinstance(value, str): return ''
    lines = [line.strip() for line in value.splitlines() if line.strip()]
    value = lines[0] if lines else ''
    value = ''.join(c for c in value if ord(c) >= 32 and not 127 <= ord(c) <= 159
                    and not 0x202a <= ord(c) <= 0x202e and not 0x2066 <= ord(c) <= 0x2069)
    return re.sub(r'\s+', ' ', value).strip()[:limit]


def pick(payload, names):
    return next((payload[name] for name in names if isinstance(payload.get(name), str) and payload[name].strip()), '')


def normalize(source, payload, now):
    if source not in SOURCES: raise NotificationError('unknown_source', 404)
    if not isinstance(payload, dict): raise NotificationError('invalid_payload')
    agent = pick(payload, ('agent_id', 'agent-id', 'agentId'))
    hook = pick(payload, ('hook_event_name', 'hook-event-name', 'hookEventName')).lower()
    if agent or 'subagent' in hook or payload.get('is_subagent') is True or payload.get('isSubagent') is True:
        return None
    kind = pick(payload, ('type', 'event', 'status')).lower()
    if kind and kind not in ('agent-turn-complete', 'turn-complete', 'completed', 'complete', 'stop', 'failed', 'error'):
        return None
    if hook and hook not in ('stop', 'taskcompleted', 'task-completed'): return None
    title = text(pick(payload, ('title', 'task_title', 'task-title', 'taskTitle', 'last_assistant_message',
                                'last-assistant-message', 'lastAssistantMessage', 'message')), 160)
    source_name = {'codex': 'Codex', 'claude': 'Claude', 'gpt': 'GPT'}[source]
    title = title or (source_name + (' 任务未完成' if kind in ('failed', 'error') else ' 已完成任务'))
    detail = text(pick(payload, ('detail', 'summary')), 240)
    project = text(pick(payload, ('project', 'project_name', 'project-name', 'projectName')), 48)
    if not project:
        cwd = pick(payload, ('cwd', 'working_directory', 'working-directory'))
        if cwd.startswith('/'): project = text(cwd.rstrip('/').rsplit('/', 1)[-1], 48)
    stable = pick(payload, ('event_id', 'event-id', 'eventId', 'turn_id', 'turn-id', 'turnId'))
    session = pick(payload, ('thread_id', 'thread-id', 'threadId', 'session_id', 'session-id', 'sessionId'))
    if len(stable) > 512 or len(session) > 512: raise NotificationError('identity_too_long')
    fingerprint = [source, stable, session] if stable else [source, session, title, detail, project]
    dedupe = hashlib.sha256(json.dumps(fingerprint, ensure_ascii=False).encode()).hexdigest()
    # Receive time is authoritative. External paths, IDs and timestamps cannot
    # become native navigation, file access or trusted execution receipts.
    return {'id': 'external_' + secrets.token_hex(16), 'source': source, 'title': title,
            'detail': detail, 'project': project, 'occurredAt': int(now * 1000),
            'outcome': 'failed' if kind in ('failed', 'error') else 'completed',
            'delivery': 'pending'}, dedupe, STABLE_TTL if stable else 2


class ExternalNotifications:
    def __init__(self, directory=None, native_token='', clock=time.time):
        self.directory = Path(directory) if directory else None
        self.native_token = native_token if isinstance(native_token, str) and len(native_token) >= 32 else ''
        self.clock = clock
        self.lock = threading.RLock()
        self.port = 0
        self.generation = secrets.token_hex(16)
        self.revision = -1
        self.available = False
        self.producer_token = secrets.token_hex(32)
        self._rate = []
        self.error = None
        self.state = {'version': 1, 'enabled': False, 'events': [], 'seen': []}
        if self.directory and self.native_token:
            try:
                self.state = self._load()
                for event in self.state['events']:
                    if event['delivery'] == 'pending': event['delivery'] = 'suspended'
                self._remove_endpoint()
            except (OSError, ValueError, TypeError, KeyError, NotificationError):
                self.error = 'notification_storage_unavailable'

    def _directory_fd(self, create=False):
        if not self.directory or not self.directory.is_absolute(): raise NotificationError('notification_not_configured', 503)
        # The dedicated app-owned directory cannot redirect through a symlink.
        for parent in [*reversed(self.directory.parents), self.directory]:
            if parent.exists() or parent.is_symlink():
                if parent.is_symlink(): raise NotificationError('unsafe_notification_directory', 503)
        if create: self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        info = os.fstat(fd)
        if info.st_uid != os.getuid():
            os.close(fd); raise NotificationError('unsafe_notification_directory', 503)
        os.fchmod(fd, 0o700)
        return fd

    def _load(self):
        if not self.directory.exists(): return self.state
        directory = self._directory_fd()
        try:
            try: fd = os.open('history.json', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
            except FileNotFoundError: return self.state
            with os.fdopen(fd, 'rb') as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_DISK: raise ValueError('invalid archive')
                value = json.loads(stream.read(MAX_DISK + 1))
            if not isinstance(value, dict) or value.get('version') != 1 or type(value.get('enabled')) is not bool: raise ValueError('invalid archive')
            events, seen = value.get('events'), value.get('seen')
            if not isinstance(events, list) or len(events) > PENDING_LIMIT + HISTORY_LIMIT: raise ValueError('invalid archive')
            if not isinstance(seen, list) or len(seen) > SEEN_LIMIT: raise ValueError('invalid archive')
            for event in events:
                if not isinstance(event, dict) or set(event) != {'id','source','title','detail','project','occurredAt','outcome','delivery'}: raise ValueError('invalid event')
                if not re.fullmatch(r'external_[0-9a-f]{32}', event['id']) or event['source'] not in SOURCES: raise ValueError('invalid event')
                if any(not isinstance(event[k], str) or len(event[k]) > n for k,n in [('title',160),('detail',240),('project',48)]): raise ValueError('invalid event')
                if event['delivery'] not in ('pending','acknowledged','suspended') or event['outcome'] not in ('completed','failed'): raise ValueError('invalid event')
                if type(event['occurredAt']) not in (int,float) or not math.isfinite(event['occurredAt']): raise ValueError('invalid event')
            for entry in seen:
                if not isinstance(entry, dict) or set(entry) != {'key','until'} or not isinstance(entry['key'],str) or not re.fullmatch('[0-9a-f]{64}',entry['key']) or type(entry['until']) not in (int,float) or not math.isfinite(entry['until']): raise ValueError('invalid dedupe')
            return value
        finally: os.close(directory)

    def _write(self, name, value):
        data = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
        if len(data) > MAX_DISK: raise NotificationError('notification_storage_limit', 503)
        directory = self._directory_fd(create=True)
        temporary = '.write-' + secrets.token_hex(12)
        replaced = False
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data); stream.flush(); os.fsync(stream.fileno())
            # Do not commit into a directory moved/replaced during the write.
            current, opened = os.stat(self.directory, follow_symlinks=False), os.fstat(directory)
            if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino): raise OSError('directory changed')
            os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
            replaced = True
            os.fsync(directory)
        except OSError as error:
            if replaced: raise NotificationCommitUncertain('notification commit uncertain') from error
            raise
        finally:
            try: os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError: pass
            os.close(directory)

    def _remove_endpoint(self):
        if not self.directory or not self.directory.exists(): return
        directory = self._directory_fd()
        try:
            try: os.unlink('endpoint.json', dir_fd=directory)
            except FileNotFoundError: pass
        finally: os.close(directory)

    @staticmethod
    def _trim(state):
        # Retain every not-yet-ACKed event; public history is only the newest 20.
        state['events'] = [event for index,event in enumerate(state['events'])
                           if index < HISTORY_LIMIT or event['delivery'] == 'pending']

    def _commit(self, state):
        self._trim(state)
        try:
            self._write('history.json', state)
        except NotificationCommitUncertain:
            # Continuing from the old projection could overwrite events which
            # are already on disk. Reopen/reload on restart; do not retry writes
            # from this in-memory state or claim an accepted receipt.
            self.error = 'notification_commit_uncertain'
            self.available = False
            self.generation = secrets.token_hex(16)
            try: self._remove_endpoint()
            except (OSError, NotificationError): pass
            raise NotificationError(self.error, 503)
        self.state = state

    def status(self):
        with self.lock:
            return {'enabled': self.state['enabled'], 'available': self.available,
                    'generation': self.generation, 'revision': self.revision,
                    'pendingCount': sum(e['delivery'] == 'pending' for e in self.state['events']) if self.available else 0,
                    'historyCount': min(HISTORY_LIMIT, len(self.state['events'])) if self.available else 0,
                    'endpointFile': str(self.directory / 'endpoint.json') if self.directory else '',
                    'error': self.error}

    def configure(self, payload):
        if not isinstance(payload, dict) or set(payload) != {'enabled','available','revision'} or type(payload['enabled']) is not bool or type(payload['available']) is not bool or type(payload['revision']) is not int or not 0 <= payload['revision'] <= 2**53-1:
            raise NotificationError('invalid_configuration')
        with self.lock:
            if payload['revision'] <= self.revision: raise NotificationError('stale_configuration', 409)
            self.revision = payload['revision']
            active = payload['enabled'] and payload['available']
            changed = active != self.available or payload['enabled'] != self.state['enabled']
            if not active:
                # Revoke before any fallible disk IO, including on private mode.
                self.available = False
                self.generation = secrets.token_hex(16)
                self._remove_endpoint()
            if self.error: raise NotificationError(self.error, 503)
            state = copy.deepcopy(self.state)
            state['enabled'] = payload['enabled']
            if changed or not active:
                for event in state['events']:
                    if event['delivery'] == 'pending': event['delivery'] = 'suspended'
                self.generation = secrets.token_hex(16)
            self._commit(state)
            if active:
                self.available = False
                try:
                    if changed: self.producer_token = secrets.token_hex(32)
                    self._write('endpoint.json', {'version': 1, 'url': f'http://127.0.0.1:{self.port}', 'token': self.producer_token})
                    self.available = True
                except Exception:
                    self.available = False
                    raise
            return self.status()

    def receive(self, source, payload, token):
        with self.lock:
            if not self.available or not self.state['enabled']: raise NotificationError('notifications_paused', 409)
            if not isinstance(token,str) or not hmac.compare_digest(token, self.producer_token): raise NotificationError('notification_token_required', 403)
            now = self.clock()
            normalized = normalize(source,payload,now)
            if normalized is None: return {'ok':True,'result':'ignored'}
            event,key,ttl = normalized
            if any(entry['key'] == key and entry['until'] > now for entry in self.state['seen']):
                return {'ok':True,'result':'duplicate'}
            self._rate = [instant for instant in self._rate if now-instant < 60]
            if len(self._rate) >= 30: raise NotificationError('notification_rate_limited',429)
            if sum(e['delivery']=='pending' for e in self.state['events']) >= PENDING_LIMIT: raise NotificationError('notification_queue_full',429)
            state=copy.deepcopy(self.state)
            state['events'].insert(0,event)
            state['seen'] = [e for e in state['seen'] if e['until'] > now][-SEEN_LIMIT+1:] + [{'key':key,'until':now+ttl}]
            self._commit(state)
            self._rate.append(now)
            return {'ok':True,'result':'accepted','eventId':event['id']}

    def events(self, history=False):
        with self.lock:
            if self.error: raise NotificationError(self.error, 503)
            rows = self.state['events'][:HISTORY_LIMIT] if history else list(reversed([e for e in self.state['events'] if e['delivery']=='pending']))
            return {'generation':self.generation,'events':copy.deepcopy(rows) if self.available else []}

    def acknowledge(self, payload, clear=False):
        with self.lock:
            if not self.available: raise NotificationError('notifications_paused',409)
            if not isinstance(payload,dict) or payload.get('generation') != self.generation: raise NotificationError('stale_generation',409)
            state=copy.deepcopy(self.state)
            if clear:
                if set(payload) != {'generation'}: raise NotificationError('invalid_clear')
                state['events']=[]  # Keep dedupe: clearing history must not replay senders.
            else:
                ids=payload.get('ids')
                if set(payload) != {'generation','ids'} or not isinstance(ids,list) or len(ids)>PENDING_LIMIT or any(not isinstance(i,str) or not re.fullmatch('external_[0-9a-f]{32}',i) for i in ids): raise NotificationError('invalid_ack')
                # A successful prior ACK may already have evicted an old item
                # from the 20-row history. Repeating that ACK is a no-op.
                for event in state['events']:
                    if event['id'] in ids: event['delivery']='acknowledged'
            self._commit(state)
            return {'ok':True,'generation':self.generation}

    def close(self):
        with self.lock:
            self.available=False
            self.generation=secrets.token_hex(16)
            try:self._remove_endpoint()
            except (OSError, NotificationError):pass


def handle_request(handler, service):
    """Return True only for owned routes. Tokens never appear in responses/logs."""
    route = urllib.parse.urlsplit(handler.path)
    path = route.path
    if not (path.startswith('/__external-notifications/') or path.startswith('/notify/')): return False
    try:
        host = handler.headers.get('Host')
        if not ipaddress.ip_address(handler.client_address[0]).is_loopback or host not in (f'127.0.0.1:{handler.server.server_port}',f'localhost:{handler.server.server_port}',f'[::1]:{handler.server.server_port}'):
            raise NotificationError('loopback_required',403)
        if handler.headers.get('Origin') is not None or handler.headers.get('Sec-Fetch-Site') not in (None,'none') or route.query or route.fragment:
            raise NotificationError('native_or_hook_request_required',403)
        control=path.startswith('/__external-notifications/')
        if control:
            if not service.native_token: raise NotificationError('notification_not_configured',503)
            supplied=handler.headers.get('X-AIBro-Native-Token','')
            if not hmac.compare_digest(supplied,service.native_token): raise NotificationError('native_token_required',403)
        if handler.command == 'GET' and control:
            if path=='/__external-notifications/status':result=service.status()
            elif path=='/__external-notifications/poll':result=service.events()
            elif path=='/__external-notifications/history':result=service.events(history=True)
            else:raise NotificationError('not_found',404)
            handler.send_json(result);return True
        if handler.command != 'POST':raise NotificationError('method_not_allowed',405)
        if handler.headers.get('Content-Type','').split(';',1)[0].strip().lower() != 'application/json':raise NotificationError('application_json_required',415)
        lengths=handler.headers.get_all('Content-Length',[])
        if handler.headers.get('Transfer-Encoding') or len(lengths)!=1 or not re.fullmatch('[0-9]{1,8}',lengths[0]):raise NotificationError('invalid_content_length')
        length=int(lengths[0])
        if length>MAX_BODY:raise NotificationError('body_too_large',413)
        handler.connection.settimeout(2)
        raw=handler.rfile.read(length)
        if len(raw)!=length:raise NotificationError('incomplete_body')
        payload=json.loads(raw.decode('utf-8'),parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite')))
        service.port=handler.server.server_port
        if control:
            if path=='/__external-notifications/config':result=service.configure(payload)
            elif path=='/__external-notifications/ack':result=service.acknowledge(payload)
            elif path=='/__external-notifications/clear':result=service.acknowledge(payload,clear=True)
            else:raise NotificationError('not_found',404)
            handler.send_json(result)
        else:
            source=path.removeprefix('/notify/')
            if source not in SOURCES:raise NotificationError('unknown_source',404)
            result=service.receive(source,payload,handler.headers.get('X-AIBro-Notification-Token',''))
            handler.send_json(result,202)
    except NotificationError as error:handler.send_json({'ok':False,'error':error.code},error.status)
    except (ValueError,TypeError,UnicodeError,RecursionError,OverflowError):handler.send_json({'ok':False,'error':'invalid_json'},400)
    except (OSError,MemoryError):handler.send_json({'ok':False,'error':'notification_storage_unavailable'},503)
    return True
