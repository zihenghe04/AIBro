"""Headless kernel runs (P8b): the registry behind ``/__kernel/runs``.

A run is created by a client (a scheduler, a phone bridge, a local tool, or
the main window), executed by the headless kernel host (a hidden WKWebView the
native shell creates on demand), and watched through the run's event stream
(``run:<id>`` in the event log). Human steps never happen here: when the
ApprovalBroker asks, the host registers an approval and the run waits
(``awaiting-approval``) until a person answers in the main window or from a
notification. Approved workspace writes are not applied by the host either:
they become effects that the main window (the single writer of the workspace
snapshot) claims, applies and acknowledges with a receipt.

Authentication (loopback only, Host header pinned to the loopback port, a
foreign Origin or a cross-site fetch is refused):
- client API: ``Authorization: Bearer <token>``; the token is created on first
  start in ``<data>/kernel/api-token`` (0600). The main window may use the
  same routes without it (same-origin). Clients can create, list, read,
  follow and cancel runs; they cannot answer approvals or apply effects;
- human decisions (approvals) and effect application: same-origin main window
  or the native shell (``X-AIBro-Native-Token``), never a bearer client, so
  whoever starts a run cannot approve its own steps;
- host routes: ``X-AIBro-Kernel-Host`` with the per-launch token the native
  shell passes to this process and injects into the hidden kernel page.
Same-user processes can read the token file, as they can drive /__proxy
today; the boundary is other websites and other users of the Mac.

Records hold no credentials. One JSON file per run under ``<data>/kernel/runs``.
"""
import hmac, ipaddress, json, os, re, secrets, tempfile, threading, time, urllib.parse
from pathlib import Path

# paused (P9b): the model's usage limit was hit; the run waits for a person (or its scheduler) to resume it.
STATUSES = ('queued', 'running', 'awaiting-approval', 'paused', 'completed', 'failed', 'cancelled', 'interrupted')
TERMINAL = {'completed', 'failed', 'cancelled', 'interrupted'}
SOURCES = ('external', 'scheduler', 'mobile', 'user')
MODES = ('request', 'smart', 'full')
DECISIONS = ('allowed-once', 'rejected')
RUN_ID = re.compile(r'^krun_[a-z0-9]{6,40}$')
ITEM_ID = re.compile(r'^[A-Za-z0-9_.:-]{1,256}$')
PROMPT_MAX, TITLE_MAX, SUMMARY_MAX, ARGS_MAX, RESULT_MAX = 8000, 120, 2000, 64 * 1024, 20000
LEASE_SECONDS, EFFECT_DEADLINE, MAX_REQUEUE, KEEP_RUNS, WAIT_MAX = 45, 600, 2, 500, 25
# Foreground first: runs a person started (main window, phone, a local client)
# go before scheduled ones; at most BACKGROUND_LIMIT scheduled runs work at
# once (waiting for a person does not count); while the main window reports a
# conversation in progress, scheduled runs wait, but never longer than
# STARVE_SECONDS after they were queued.
PAUSE_HOLDS = ('CODEX_QUOTA', 'CODEX_RATE_LIMIT', 'CODEX_LOGIN')
BACKGROUND_SOURCES, BACKGROUND_LIMIT, STARVE_SECONDS, FOREGROUND_HINT_SECONDS = ('scheduler',), 1, 120, 20
SECRET_KEY = re.compile(r'(api[-_]?key|apikey|secret|token|password|passwd|authorization|cookie|credential|headers?)$', re.I)


class KernelError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _text(value, limit, field, required=False):
    if value is None and not required: return None
    if not isinstance(value, str) or (required and not value.strip()): raise KernelError(400, 'INVALID_REQUEST', f'{field} 无效')
    if len(value) > limit: raise KernelError(413, 'TOO_LARGE', f'{field} 过长（上限 {limit} 字）')
    return value


def _clean(value, depth=0):
    """Approval previews and effect arguments never carry credential-like keys."""
    if depth > 8: return '[depth]'
    if isinstance(value, dict): return {str(k)[:120]: ('[redacted]' if SECRET_KEY.search(str(k)) else _clean(v, depth + 1)) for k, v in list(value.items())[:200]}
    if isinstance(value, list): return [_clean(v, depth + 1) for v in value[:200]]
    if value is None or isinstance(value, (bool, int, float, str)): return value
    return str(value)[:200]


def _schedule(value):
    """A scheduler task's run context: ids, declared scope, reserved model override."""
    if not isinstance(value, dict): raise KernelError(400, 'INVALID_REQUEST', 'schedule 无效')
    scope = value.get('scope') if isinstance(value.get('scope'), dict) else {}
    tools = [t for t in scope.get('tools', []) if isinstance(t, str) and ITEM_ID.match(t)][:50] if isinstance(scope.get('tools'), list) else []
    return {'taskId': _text(value.get('taskId'), 64, 'schedule.taskId', True), 'executionId': _text(value.get('executionId'), 64, 'schedule.executionId', True),
            'scope': {'declared': scope.get('declared') is True, 'access': scope.get('access') if scope.get('access') in ('read', 'ask', 'write') else 'read',
                      'tools': tools, 'computerUse': scope.get('computerUse') is True},
            'modelOverride': _clean(value.get('modelOverride')) if isinstance(value.get('modelOverride'), dict) else None,
            'budgetMinutes': value.get('budgetMinutes') if isinstance(value.get('budgetMinutes'), int) and 1 <= value.get('budgetMinutes') <= 120 else 15,
            'catchUp': value.get('catchUp') is True}


class KernelRuns:
    def __init__(self, data_dir, events=None, host_token='', clock=time.time):
        self.dir = Path(data_dir) / 'kernel'
        self.runs_dir = self.dir / 'runs'
        self.events, self.clock = events, clock
        self.host_token = host_token if isinstance(host_token, str) and len(host_token) >= 32 else ''
        self.cond = threading.Condition()
        self.runs = {}
        self._token = None
        self.foreground_until = 0
        self.extra_pending = None  # callable adding fields to the host's pending view (scheduler reminders)
        self._load()
        # Clients read the token file; create it at startup, not on first use.
        try: self.api_token()
        except (OSError, KernelError): pass

    # -- storage ---------------------------------------------------------
    def _write(self, path, data):
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix='.write-', dir=path.parent)
        try:
            with os.fdopen(fd, 'wb') as handle: handle.write(data); handle.flush(); os.fsync(handle.fileno())
            os.chmod(temporary, 0o600); os.replace(temporary, path)
        finally:
            if os.path.exists(temporary): os.unlink(temporary)

    def api_token(self):
        if self._token: return self._token
        path = self.dir / 'api-token'
        try:
            if path.is_symlink(): raise KernelError(500, 'UNSAFE_STORE', 'kernel token 不能是符号链接')
            value = path.read_text().strip()
            if re.fullmatch(r'[0-9a-f]{64}', value): self._token = value; return value
        except FileNotFoundError: pass
        self._token = secrets.token_hex(32)
        self._write(path, self._token.encode())
        return self._token

    def _save(self, run):
        run['updatedAt'] = int(self.clock() * 1000)
        self._write(self.runs_dir / (run['id'] + '.json'), json.dumps(run, ensure_ascii=False).encode())

    def _load(self):
        if not self.runs_dir.is_dir(): return
        for path in sorted(self.runs_dir.glob('krun_*.json')):
            try: run = json.loads(path.read_text())
            except (OSError, ValueError): continue
            if isinstance(run, dict) and RUN_ID.match(str(run.get('id', ''))) and run.get('status') in STATUSES: self.runs[run['id']] = run
        # A previous process held these leases; nobody is executing them now.
        with self.cond:
            for run in list(self.runs.values()):
                if run['status'] in ('running', 'awaiting-approval'): self._lost(run, 'service-restarted')

    def _emit(self, run, type, data=None):
        if not self.events: return
        try: self.events.emit(run['id'], type, data or {}, source={'kind': 'native', 'id': 'kernel-runs'})
        except Exception: pass  # the event log never blocks a run

    # -- views -----------------------------------------------------------
    @staticmethod
    def public(run):
        value = json.loads(json.dumps(run))
        value.pop('lease', None)
        for effect in value.get('effects', []): effect.pop('claimToken', None)
        return value

    def _get(self, run_id):
        run = self.runs.get(run_id) if isinstance(run_id, str) else None
        if not run: raise KernelError(404, 'NOT_FOUND', '找不到这个后台运行')
        return run

    def _sweep(self):
        now = self.clock() * 1000
        for run in list(self.runs.values()):
            lease = run.get('lease')
            if run['status'] in ('running', 'awaiting-approval') and lease and lease.get('expiresAt', 0) < now: self._lost(run, 'host-lease-expired')
            for effect in run.get('effects', []):
                if effect['status'] == 'pending' and effect.get('deadline', 0) < now:
                    effect['status'] = 'expired'; effect['receipt'] = {'ok': False, 'code': 'NOT_APPLIED', 'message': '主窗口未在期限内应用，未执行。', 'outcome': 'not-started'}
                    self._save(run)

    def _lost(self, run, reason):
        """The host is gone. A run with no effect yet may start over; otherwise it stops."""
        effects = [e for e in run.get('effects', []) if e['status'] in ('claimed', 'applied', 'failed')]
        for approval in run.get('approvals', []):
            if approval['status'] == 'pending': approval['status'] = 'cancelled'
        for effect in run.get('effects', []):
            if effect['status'] == 'pending': effect['status'] = 'expired'
        run['lease'] = None
        if run.get('cancelRequested'):
            run.update(status='cancelled', finishedAt=int(self.clock() * 1000))
            self._emit(run, 'run/finished', {'status': 'cancelled', 'reason': reason})
        elif not effects and run.get('requeues', 0) < MAX_REQUEUE:
            run.update(status='queued', requeues=run.get('requeues', 0) + 1, startedAt=None)
            self._emit(run, 'run/interrupted', {'status': 'requeued', 'reason': reason, 'effects': 0})
        else:
            run.update(status='interrupted', finishedAt=int(self.clock() * 1000), error=reason)
            self._emit(run, 'run/interrupted', {'status': 'interrupted', 'reason': reason, 'effects': len(effects)})
        self._save(run)
        self.cond.notify_all()

    def _trim(self):
        done = sorted((r for r in self.runs.values() if r['status'] in TERMINAL), key=lambda r: r.get('updatedAt', 0))
        for run in done[:max(0, len(self.runs) - KEEP_RUNS)]:
            self.runs.pop(run['id'], None)
            try: (self.runs_dir / (run['id'] + '.json')).unlink()
            except OSError: pass

    # -- client API ------------------------------------------------------
    def create(self, payload, source_kind='external'):
        if not isinstance(payload, dict): raise KernelError(400, 'INVALID_REQUEST', '请求必须是 JSON 对象')
        allowed = {'prompt', 'title', 'source', 'projectId', 'workspace', 'permissionMode', 'idempotencyKey', 'maxSteps', 'model'}
        # Only the in-process scheduler attaches a task's declared scope (scheduler.py).
        if source_kind == 'scheduler': allowed.add('schedule')
        extra = set(payload) - allowed
        if extra: raise KernelError(400, 'INVALID_REQUEST', '不支持的字段：' + ','.join(sorted(extra))[:200])
        prompt = _text(payload.get('prompt'), PROMPT_MAX, 'prompt', True)
        title = _text(payload.get('title'), TITLE_MAX, 'title') or prompt.strip().splitlines()[0][:TITLE_MAX]
        source = payload.get('source') or {}
        if not isinstance(source, dict): raise KernelError(400, 'INVALID_REQUEST', 'source 无效')
        kind = source.get('kind', source_kind)
        if kind not in SOURCES: raise KernelError(400, 'INVALID_REQUEST', 'source.kind 无效')
        source = {'kind': kind, 'id': _text(source.get('id'), 64, 'source.id') or kind}
        mode = payload.get('permissionMode')
        if mode is not None and mode not in MODES: raise KernelError(400, 'INVALID_REQUEST', 'permissionMode 无效')
        steps = payload.get('maxSteps')
        if steps is not None and (not isinstance(steps, int) or isinstance(steps, bool) or not 1 <= steps <= 60): raise KernelError(400, 'INVALID_REQUEST', 'maxSteps 无效（1–60）')
        key = _text(payload.get('idempotencyKey'), 128, 'idempotencyKey')
        # The run's model, overriding the user's kernel setting (a schedule or a conversation picks it):
        # {connection: "codex-cli" | "api:<service>", model?, effort?}. Never a key.
        model = payload.get('model')
        if model is not None:
            if not isinstance(model, dict) or set(model) - {'connection', 'model', 'effort'}: raise KernelError(400, 'INVALID_REQUEST', 'model 无效')
            model = {'connection': _text(model.get('connection'), 300, 'model.connection', True), 'model': _text(model.get('model'), 200, 'model.model'), 'effort': _text(model.get('effort'), 20, 'model.effort')}
        with self.cond:
            if key:
                for run in self.runs.values():
                    if run.get('idempotencyKey') == key and run['source'] == source: return self.public(run), False
            now = int(self.clock() * 1000)
            run = {'id': 'krun_' + format(now, 'x') + secrets.token_hex(5), 'version': 1, 'status': 'queued', 'createdAt': now, 'updatedAt': now,
                   'startedAt': None, 'finishedAt': None, 'source': source, 'idempotencyKey': key, 'cancelRequested': False, 'requeues': 0,
                   # The host freezes the strictest of this and the user's current mode.
                   'request': {'prompt': prompt, 'title': title, 'projectId': _text(payload.get('projectId'), 512, 'projectId'),
                               'workspace': _text(payload.get('workspace'), 64, 'workspace'), 'permissionMode': mode, 'maxSteps': steps, 'model': model,
                               **({'schedule': _schedule(payload['schedule'])} if 'schedule' in payload else {})},
                   'approvals': [], 'effects': [], 'result': None, 'error': None, 'lease': None}
            self.runs[run['id']] = run
            self._save(run); self._trim()
            self._emit(run, 'run/queued', {'source': source, 'title': title})
            self.cond.notify_all()
            return self.public(run), True

    def list(self, statuses=None, limit=50, attention=False):
        with self.cond:
            self._sweep()
            rows = [r for r in self.runs.values() if (not statuses or r['status'] in statuses) and (not attention or any(a['status'] == 'pending' for a in r.get('approvals', [])))]
            rows.sort(key=lambda r: r['createdAt'], reverse=True)
            return [self.public(r) for r in rows[:max(1, min(200, limit))]]

    def find_by_key(self, key):
        with self.cond:
            run = next((r for r in self.runs.values() if r.get('idempotencyKey') == key), None)
            return self.public(run) if run else None

    def get(self, run_id):
        with self.cond:
            self._sweep()
            return self.public(self._get(run_id))

    def cancel(self, run_id):
        with self.cond:
            run = self._get(run_id)
            if run['status'] in TERMINAL: return self.public(run)
            run['cancelRequested'] = True
            for approval in run.get('approvals', []):
                if approval['status'] == 'pending': approval.update(status='cancelled', decidedAt=int(self.clock() * 1000))
            for effect in run.get('effects', []):
                if effect['status'] == 'pending':
                    effect.update(status='expired', receipt={'ok': False, 'code': 'CANCELLED', 'message': '运行已取消，未执行。', 'outcome': 'not-started'})
            if run['status'] in ('queued', 'paused'):
                reason = 'before-start' if run['status'] == 'queued' else 'while-paused'
                run.update(status='cancelled', finishedAt=int(self.clock() * 1000))
                self._emit(run, 'run/finished', {'status': 'cancelled', 'reason': reason})
            elif run['status'] == 'awaiting-approval': run['status'] = 'running'
            self._save(run); self.cond.notify_all()
            return self.public(run)

    # -- human decisions and effects (main window / native only) ---------
    def decide(self, run_id, approval_id, decision, answerer):
        if decision not in DECISIONS: raise KernelError(400, 'INVALID_REQUEST', 'decision 只能是 allowed-once 或 rejected')
        with self.cond:
            run = self._get(run_id)
            approval = next((a for a in run.get('approvals', []) if a['id'] == approval_id), None)
            if not approval: raise KernelError(404, 'NOT_FOUND', '找不到这项审批')
            if approval['status'] != 'pending': raise KernelError(409, 'ALREADY_DECIDED', '这项审批已经结束：' + approval['status'])
            # A destructive step is approved in the main window, after the person has seen
            # its arguments; the notification only offers 查看 / 拒绝.
            if approval.get('destructive') and answerer == 'native' and decision == 'allowed-once':
                raise KernelError(403, 'REVIEW_IN_WINDOW', '删除等风险步骤需要在 AI Bro 主窗口查看后批准')
            approval.update(status=decision, decidedAt=int(self.clock() * 1000), answerer=answerer)
            if run['status'] == 'awaiting-approval' and not any(a['status'] == 'pending' for a in run['approvals']): run['status'] = 'running'
            self._save(run)
            self.cond.notify_all()
            return self.public(run)

    def claim_effects(self, limit=20):
        with self.cond:
            self._sweep()
            out = []
            for run in sorted(self.runs.values(), key=lambda r: r['createdAt']):
                for effect in run.get('effects', []):
                    if effect['status'] != 'pending' or len(out) >= limit: continue
                    effect.update(status='claimed', claimToken=secrets.token_hex(16), claimedAt=int(self.clock() * 1000))
                    out.append({'runId': run['id'], 'id': effect['id'], 'tool': effect['tool'], 'args': effect['args'], 'claimToken': effect['claimToken'],
                                'projectId': run['request'].get('projectId'), 'workspace': run['request'].get('workspace'), 'title': run['request']['title']})
                    self._save(run)
            if out: self.cond.notify_all()
            return out

    def effect_receipt(self, run_id, effect_id, claim_token, receipt):
        if not isinstance(receipt, dict) or not isinstance(receipt.get('ok'), bool): raise KernelError(400, 'INVALID_REQUEST', 'receipt 无效')
        with self.cond:
            run = self._get(run_id)
            effect = next((e for e in run.get('effects', []) if e['id'] == effect_id), None)
            if not effect: raise KernelError(404, 'NOT_FOUND', '找不到这项写入')
            if effect['status'] != 'claimed' or not isinstance(claim_token, str) or not hmac.compare_digest(claim_token, effect.get('claimToken') or ''):
                raise KernelError(409, 'NOT_CLAIMED', '这项写入不是由当前窗口领取的')
            clean = _clean(receipt)
            text = json.dumps(clean, ensure_ascii=False)
            if len(text) > ARGS_MAX: clean = {'ok': receipt['ok'], 'truncated': True}
            effect.update(status='applied' if receipt['ok'] else 'failed', receipt=clean, settledAt=int(self.clock() * 1000))
            effect.pop('claimToken', None)
            self._save(run); self.cond.notify_all()
            return {'ok': True}

    # -- host API ----------------------------------------------------------
    def _leased(self, run_id, lease_token):
        run = self._get(run_id)
        lease = run.get('lease') or {}
        if run['status'] in TERMINAL or not isinstance(lease_token, str) or not hmac.compare_digest(lease_token, lease.get('token') or ''):
            raise KernelError(409, 'LEASE_LOST', '运行租约已失效')
        return run

    def _extend(self, run):
        run['lease']['expiresAt'] = int((self.clock() + LEASE_SECONDS) * 1000)

    def pending(self):
        with self.cond:
            self._sweep()
            waiting = [{'runId': r['id'], 'approvalId': a['id'], 'title': r['request']['title'], 'tool': a['tool'],
                        'scheduled': r['source'].get('kind') == 'scheduler', 'outOfScope': 'out-of-scope' in a.get('reasons', []), 'destructive': a.get('destructive') is True}
                       for r in self.runs.values() for a in r.get('approvals', []) if a['status'] == 'pending']
            view = {'queued': sum(r['status'] == 'queued' for r in self.runs.values()),
                    'active': sum(r['status'] in ('running', 'awaiting-approval') for r in self.runs.values()), 'approvals': waiting}
        if self.extra_pending:
            try: view.update(self.extra_pending())
            except Exception: pass  # reminders never block the host's view of runs
        return view

    def foreground(self, busy):
        """The main window's hint: a conversation is running now (expires by itself)."""
        with self.cond:
            self.foreground_until = self.clock() + FOREGROUND_HINT_SECONDS if busy else 0
            return {'busy': bool(busy)}

    def _next(self):
        now = self.clock()
        queued = sorted((r for r in self.runs.values() if r['status'] == 'queued'), key=lambda r: r['createdAt'])
        background = lambda r: r['source'].get('kind') in BACKGROUND_SOURCES
        working = sum(r['status'] == 'running' and background(r) for r in self.runs.values())
        front = [r for r in queued if not background(r)]
        # A model connection whose usage limit paused a run holds the other scheduled runs on it (each would only pause and notify again);
        # a run someone resumed goes anyway. An unnamed model (the kernel default) is one connection of its own.
        key = lambda r: ((r['request'].get('model') or {}).get('connection') or '')
        held = {key(r) for r in self.runs.values() if r['status'] == 'paused' and (r.get('pause') or {}).get('code') in PAUSE_HOLDS}
        back = [r for r in queued if background(r) and (key(r) not in held or r.get('resumes'))] if working < BACKGROUND_LIMIT else []
        starving = [r for r in back if now * 1000 - r['createdAt'] >= STARVE_SECONDS * 1000]
        if starving: return starving[0]
        if front: return front[0]
        if back and now >= self.foreground_until: return back[0]
        return None

    def claim(self, host_id):
        with self.cond:
            self._sweep()
            run = self._next()
            if not run: return None
            run.update(status='running', startedAt=int(self.clock() * 1000), lease={'token': secrets.token_hex(24), 'host': str(host_id)[:64]})
            self._extend(run); self._save(run)
            self._emit(run, 'run/started', {'host': 'headless', 'attempt': run.get('requeues', 0) + 1})
            self.cond.notify_all()
            return {'run': self.public(run), 'leaseToken': run['lease']['token']}

    def heartbeat(self, run_id, lease_token):
        with self.cond:
            run = self._leased(run_id, lease_token)
            self._extend(run); self._save(run)
            return {'cancelRequested': bool(run.get('cancelRequested'))}

    def ask(self, run_id, lease_token, payload):
        with self.cond:
            run = self._leased(run_id, lease_token)
            if run.get('cancelRequested'): raise KernelError(409, 'CANCELLED', '运行已取消')
            call_id = payload.get('callId')
            if not isinstance(call_id, str) or not ITEM_ID.match(call_id): raise KernelError(400, 'INVALID_REQUEST', 'callId 无效')
            existing = next((a for a in run['approvals'] if a['callId'] == call_id), None)
            if existing: return existing
            summary = json.dumps(_clean(payload.get('args', {})), ensure_ascii=False)
            approval = {'id': 'appr_' + secrets.token_hex(6), 'callId': call_id, 'tool': _text(payload.get('tool'), 64, 'tool', True),
                        'effect': payload.get('effect') if payload.get('effect') in ('none', 'view', 'local', 'external') else 'external',
                        'destructive': payload.get('destructive') is True, 'reasons': [str(x)[:80] for x in (payload.get('reasons') or [])][:6],
                        'summary': summary[:SUMMARY_MAX], 'askedAt': int(self.clock() * 1000), 'status': 'pending'}
            run['approvals'].append(approval)
            run['status'] = 'awaiting-approval'
            self._extend(run); self._save(run); self.cond.notify_all()
            return approval

    def wait_approval(self, run_id, lease_token, approval_id, timeout=WAIT_MAX):
        deadline = self.clock() + max(0, min(WAIT_MAX, timeout))
        with self.cond:
            while True:
                run = self._leased(run_id, lease_token)
                approval = next((a for a in run['approvals'] if a['id'] == approval_id), None)
                if not approval: raise KernelError(404, 'NOT_FOUND', '找不到这项审批')
                if approval['status'] != 'pending' or run.get('cancelRequested'): break
                left = deadline - self.clock()
                if left <= 0: break
                self._extend(run)
                self.cond.wait(min(left, 5))
            self._extend(run); self._save(run)
            return {'approval': approval, 'cancelRequested': bool(run.get('cancelRequested'))}

    def add_effect(self, run_id, lease_token, payload):
        with self.cond:
            run = self._leased(run_id, lease_token)
            if run.get('cancelRequested'): raise KernelError(409, 'CANCELLED', '运行已取消')
            effect_id = payload.get('id')
            if not isinstance(effect_id, str) or not ITEM_ID.match(effect_id): raise KernelError(400, 'INVALID_REQUEST', 'id 无效')
            existing = next((e for e in run['effects'] if e['id'] == effect_id), None)
            if existing: return {k: v for k, v in existing.items() if k != 'claimToken'}
            args = _clean(payload.get('args'))
            if not isinstance(args, dict) or len(json.dumps(args, ensure_ascii=False)) > ARGS_MAX: raise KernelError(400, 'INVALID_REQUEST', 'args 无效或过大')
            effect = {'id': effect_id, 'tool': _text(payload.get('tool'), 64, 'tool', True), 'args': args, 'status': 'pending',
                      'createdAt': int(self.clock() * 1000), 'deadline': int((self.clock() + EFFECT_DEADLINE) * 1000), 'receipt': None}
            run['effects'].append(effect)
            self._extend(run); self._save(run); self.cond.notify_all()
            return dict(effect)

    def wait_effect(self, run_id, lease_token, effect_id, timeout=WAIT_MAX):
        deadline = self.clock() + max(0, min(WAIT_MAX, timeout))
        with self.cond:
            while True:
                self._sweep()
                run = self._leased(run_id, lease_token)
                effect = next((e for e in run['effects'] if e['id'] == effect_id), None)
                if not effect: raise KernelError(404, 'NOT_FOUND', '找不到这项写入')
                if effect['status'] in ('applied', 'failed', 'expired'): break
                left = deadline - self.clock()
                if left <= 0: break
                self._extend(run)
                self.cond.wait(min(left, 5))
            self._extend(run); self._save(run)
            return {'effect': {k: v for k, v in effect.items() if k != 'claimToken'}, 'cancelRequested': bool(run.get('cancelRequested'))}

    def pause(self, run_id, lease_token, payload):
        """The host stops a run it cannot continue now (the model's usage limit). It keeps its effects and waits."""
        with self.cond:
            run = self._leased(run_id, lease_token)
            for approval in run['approvals']:
                if approval['status'] == 'pending': approval['status'] = 'cancelled'
            if run.get('cancelRequested'):
                run.update(status='cancelled', finishedAt=int(self.clock() * 1000), lease=None)
                self._emit(run, 'run/finished', {'status': 'cancelled', 'reason': 'paused-after-cancel'})
            else:
                # Never refuse a pause over its fields: a refused pause would leave the run to be re-run.
                pause = {'code': re.sub(r'[^A-Z0-9_]', '', str(payload.get('code') or ''))[:40] or 'PAUSED', 'message': str(payload.get('message') or '运行已暂停')[:300],
                         'at': int(self.clock() * 1000), 'steps': int(payload.get('steps') or 0) if isinstance(payload.get('steps'), int) else 0}
                run.update(status='paused', pause=pause, lease=None)
                run.setdefault('pauses', []).append(pause)
                self._emit(run, 'run/paused', pause)
            self._save(run); self.cond.notify_all()
            return self.public(run)

    def resume(self, run_id):
        """A paused run goes back to the queue; the host starts it over and is told which writes already happened."""
        with self.cond:
            run = self._get(run_id)
            if run['status'] != 'paused': raise KernelError(409, 'NOT_PAUSED', '这个运行没有暂停')
            run.update(status='queued', startedAt=None, resumes=run.get('resumes', 0) + 1, pause=None)
            self._emit(run, 'run/resumed', {'resumes': run['resumes']})
            self._save(run); self.cond.notify_all()
            return self.public(run)

    def finish(self, run_id, lease_token, payload):
        status = payload.get('status')
        if status not in ('completed', 'failed', 'cancelled'): raise KernelError(400, 'INVALID_REQUEST', 'status 无效')
        with self.cond:
            run = self._leased(run_id, lease_token)
            result = payload.get('result')
            if result is not None:
                if not isinstance(result, dict): raise KernelError(400, 'INVALID_REQUEST', 'result 无效')
                # Never refuse a finish over its size: a refused finish would leave the run to be re-run.
                final = result.get('final') if isinstance(result.get('final'), str) else None
                if final and len(final) > RESULT_MAX: final = final[:RESULT_MAX] + '…'
                done = result.get('markedDone')
                result = {'final': final, 'stop': str(result.get('stop', ''))[:32], 'steps': int(result.get('steps') or 0), 'compactions': int(result.get('compactions') or 0),
                          # The scheduler's completion check: the model called mark_task_done.
                          **({'markedDone': {'summary': str(done.get('summary') or '')[:2000]}} if isinstance(done, dict) else {})}
            for approval in run['approvals']:
                if approval['status'] == 'pending': approval['status'] = 'cancelled'
            # A run the user stopped ends as stopped, whatever the host concluded.
            if run.get('cancelRequested') and status == 'completed': status = 'cancelled'
            run.update(status=status, result=result, error=str(payload.get('error') or '')[:500] or None, finishedAt=int(self.clock() * 1000), lease=None)
            self._save(run); self.cond.notify_all()
            return self.public(run)


# -- HTTP ----------------------------------------------------------------
def _loopback(handler):
    try:
        if not ipaddress.ip_address(handler.client_address[0]).is_loopback: return None
        port = handler.server.server_port
        hosts = {f'127.0.0.1:{port}', f'localhost:{port}', f'[::1]:{port}'}
        if handler.headers.get('Host') not in hosts: return None
        if handler.headers.get('Sec-Fetch-Site') in ('cross-site', 'same-site'): return None
        origin = handler.headers.get('Origin')
        if origin is not None and origin not in {'http://' + h for h in hosts}: return None
        return origin is not None or handler.headers.get('Sec-Fetch-Site') == 'same-origin'
    except (ValueError, AttributeError, TypeError): return None


def _body(handler, limit=256 * 1024):
    lengths = handler.headers.get_all('Content-Length', []) if hasattr(handler.headers, 'get_all') else [handler.headers.get('Content-Length', '0')]
    if handler.headers.get('Transfer-Encoding') or len(lengths) > 1: raise KernelError(400, 'INVALID_REQUEST', '请求长度无效')
    length = int(lengths[0]) if lengths else 0
    if length < 0 or length > limit: raise KernelError(413, 'TOO_LARGE', '请求过大')
    if length and handler.headers.get('Content-Type', '').split(';', 1)[0].strip().lower() != 'application/json':
        raise KernelError(415, 'JSON_REQUIRED', '请求必须是 application/json')
    raw = handler.rfile.read(length) if length else b'{}'
    try: value = json.loads(raw.decode('utf-8') or '{}')
    except (ValueError, UnicodeError): raise KernelError(400, 'INVALID_REQUEST', '请求不是有效 JSON')
    if not isinstance(value, dict): raise KernelError(400, 'INVALID_REQUEST', '请求必须是 JSON 对象')
    return value


def _sse(handler, runs, events, run_id, after):
    """Event stream of one run: replays from ``after`` (Last-Event-ID wins), then
    follows until the run has ended and everything is sent."""
    last = handler.headers.get('Last-Event-ID')
    if last and last.isdigit(): after = int(last)
    runs.get(run_id)  # 404 before headers
    handler.send_response(200)
    handler.send_header('Content-Type', 'text/event-stream; charset=utf-8')
    handler.send_header('Cache-Control', 'no-store')
    handler.send_header('X-Content-Type-Options', 'nosniff')
    handler.end_headers()
    handler.close_connection = True
    idle, status = 0.0, None
    try:
        while True:
            batch = events.read('run:' + run_id, after, 500) if events else []
            for event in batch:
                after = event.get('seq', after)
                handler.wfile.write(f"id: {after}\nevent: {event.get('type', 'message')}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n".encode())
            run = runs.get(run_id)
            if run['status'] != status:
                status = run['status']
                handler.wfile.write(f"event: status\ndata: {json.dumps({'status': status, 'cancelRequested': run.get('cancelRequested')}, ensure_ascii=False)}\n\n".encode())
            handler.wfile.flush()
            if status in TERMINAL and not batch: return
            with runs.cond: runs.cond.wait(0.5)
            idle += 0.5
            if idle >= 15: handler.wfile.write(b': keepalive\n\n'); handler.wfile.flush(); idle = 0
    except (BrokenPipeError, ConnectionResetError, OSError): return


def handle_request(handler, runs, events=None, native_token=''):
    """Returns True for owned routes. Tokens never appear in responses or logs."""
    split = urllib.parse.urlsplit(handler.path)
    path = split.path
    if not path.startswith('/__kernel/'): return False
    query = urllib.parse.parse_qs(split.query)
    method = handler.command
    try:
        same_origin = _loopback(handler)
        if same_origin is None: raise KernelError(403, 'LOOPBACK_ONLY', '只接受本机 AI Bro 的请求')
        bearer = handler.headers.get('Authorization', '')
        has_bearer = bearer.startswith('Bearer ')
        client = has_bearer and hmac.compare_digest(bearer[7:].strip(), runs.api_token())
        if has_bearer and not client: raise KernelError(401, 'TOKEN_REQUIRED', 'kernel token 无效')
        native = bool(native_token) and hmac.compare_digest(handler.headers.get('X-AIBro-Native-Token', ''), native_token)
        host_header = handler.headers.get('X-AIBro-Kernel-Host', '')
        host = bool(runs.host_token) and bool(host_header) and hmac.compare_digest(host_header, runs.host_token)
        window = same_origin and not has_bearer  # the main window (same-origin page, no bearer)
        parts = [urllib.parse.unquote(p) for p in path.split('/')[2:]]  # after '/__kernel/'

        def need(ok, code='FORBIDDEN', message='没有权限执行这个操作'):
            if not ok: raise KernelError(403 if code != 'TOKEN_REQUIRED' else 401, code, message)

        if parts[0] == 'host':
            need(host, 'HOST_ONLY', '只允许内核宿主调用')
            if parts[1:] == ['pending'] and method == 'GET': handler.send_json(runs.pending()); return True
            if parts[1:] == ['claim'] and method == 'POST': handler.send_json(runs.claim(_body(handler).get('host', 'headless')) or {'run': None}); return True
            if len(parts) >= 4 and parts[1] == 'runs':
                run_id, action = parts[2], parts[3]
                if method == 'POST':
                    body = _body(handler)
                    lease = body.get('leaseToken')
                    if action == 'heartbeat': result = runs.heartbeat(run_id, lease)
                    elif action == 'ask': result = {'approval': runs.ask(run_id, lease, body)}
                    elif action == 'effects': result = {'effect': runs.add_effect(run_id, lease, body)}
                    elif action == 'finish': result = {'run': runs.finish(run_id, lease, body)}
                    elif action == 'pause': result = {'run': runs.pause(run_id, lease, body)}
                    else: raise KernelError(404, 'NOT_FOUND', '未知接口')
                    handler.send_json(result); return True
                if method == 'GET' and len(parts) == 5:
                    lease = (query.get('leaseToken') or [''])[0]
                    timeout = float((query.get('wait') or [str(WAIT_MAX)])[0])
                    if action == 'approvals': handler.send_json(runs.wait_approval(run_id, lease, parts[4], timeout)); return True
                    if action == 'effects': handler.send_json(runs.wait_effect(run_id, lease, parts[4], timeout)); return True
            raise KernelError(404, 'NOT_FOUND', '未知接口')

        if parts == ['foreground'] and method == 'POST':
            need(window, 'WINDOW_ONLY', '只有主窗口能报告前台对话')
            handler.send_json(runs.foreground(_body(handler).get('busy') is True)); return True

        if parts[0] == 'effects':
            need(window or native, 'WINDOW_ONLY', '写入只能由主窗口应用')
            if parts[1:] == ['claim'] and method == 'POST': _body(handler); handler.send_json({'effects': runs.claim_effects()}); return True
            if len(parts) == 4 and parts[3] == 'receipt' and method == 'POST':
                body = _body(handler)
                handler.send_json(runs.effect_receipt(parts[1], parts[2], body.get('claimToken'), body.get('receipt'))); return True
            raise KernelError(404, 'NOT_FOUND', '未知接口')

        if parts[0] != 'runs': raise KernelError(404, 'NOT_FOUND', '未知接口')
        need(client or window or native, 'TOKEN_REQUIRED', '需要 kernel token')
        if len(parts) == 1:
            if method == 'POST':
                run, created = runs.create(_body(handler, 64 * 1024), 'user' if window else 'external')
                handler.send_json({'run': run, 'created': created}, 201 if created else 200); return True
            if method == 'GET':
                statuses = [s for s in (query.get('status') or [''])[0].split(',') if s in STATUSES]
                attention = (query.get('attention') or ['0'])[0] == '1'
                handler.send_json({'runs': runs.list(statuses, int((query.get('limit') or ['50'])[0]), attention)}); return True
        run_id = parts[1]
        if len(parts) == 2 and method == 'GET': handler.send_json({'run': runs.get(run_id)}); return True
        if len(parts) == 3 and parts[2] == 'cancel' and method == 'POST': _body(handler); handler.send_json({'run': runs.cancel(run_id)}); return True
        if len(parts) == 3 and parts[2] == 'resume' and method == 'POST': _body(handler); handler.send_json({'run': runs.resume(run_id)}); return True
        if len(parts) == 3 and parts[2] == 'events' and method == 'GET':
            runs.get(run_id)
            after = int((query.get('after') or ['0'])[0]); limit = max(1, min(1000, int((query.get('limit') or ['500'])[0])))
            batch = events.read('run:' + run_id, after, limit) if events else []
            handler.send_json({'events': batch, 'next': batch[-1]['seq'] if batch else after}); return True
        if len(parts) == 4 and parts[2:] == ['events', 'stream'] and method == 'GET':
            _sse(handler, runs, events, run_id, int((query.get('after') or ['0'])[0])); return True
        if len(parts) == 4 and parts[2] == 'approvals' and method == 'POST':
            # People answer; a bearer client (whoever started the run) cannot.
            need(window or native, 'HUMAN_ONLY', '审批只能在 AI Bro 主窗口或系统通知里由本人处理')
            body = _body(handler)
            handler.send_json({'run': runs.decide(run_id, parts[3], body.get('decision'), 'native' if native else 'user')}); return True
        raise KernelError(404, 'NOT_FOUND', '未知接口')
    except KernelError as error:
        handler.send_json({'error': error.message, 'code': error.code}, error.status)
    except (ValueError, TypeError) as error:
        handler.send_json({'error': '请求无效', 'code': 'INVALID_REQUEST'}, 400)
    return True
