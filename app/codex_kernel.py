"""Codex CLI as the kernel's model (P9b).

The kernel (AIBroRunLoop.toolLoop, in the headless host and the bench) keeps
its own transcript, text tool protocol, tools, approvals and compaction. Codex
is only the model behind ``request()``:

- one locked-down runtime per login mode (CodexBridge with ``lockdown``: every
  CLI tool and the hosted JS host off, read-only sandbox, approvals never), a
  separate process from chat; one ephemeral thread per run. Each step sends
  only the messages the thread has not seen. When the transcript no longer
  extends what the thread holds (run-internal compaction rewrote it, the
  runtime restarted), the run moves to a new thread with the whole transcript;
- before a run's first step the CLI version must be in the verified range and
  the new thread must report approvals ``never`` and a read-only sandbox
  without network; otherwise the step is refused with a clear message;
- any tool, command, file or approval event from the CLI ends the step at
  once (the turn is interrupted, the thread dropped) with the reason;
- token usage comes from ``thread/tokenUsage/updated``; without it the step
  returns an estimate flagged ``estimated`` so the kernel compacts earlier;
- usage limits end the step with ``pause``: the host pauses the run and
  notifies, nothing here retries;
- cancel interrupts the running turn.

No credential file is read; the official runtime reads its own account.
Run as a script it serves the same steps to the kernel bench:
  python3 app/codex_kernel.py serve --port 0 --logdir <dir> --data <dir> [--mode shared|private] [--model m] [--effort e]
"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import queue
import re
import sys
import threading
import time
import urllib.parse

from codex_bridge import BridgeError, CodexBridge, kernel_config, provider_choice

MIN_VERSION, MAX_VERSION = (0, 163, 0), (0, 170, 0)  # verified range; MAX is exclusive
ALLOWED_ITEMS = frozenset({'userMessage', 'agentMessage', 'reasoning', 'contextCompaction'})
QUOTA = {'usageLimitExceeded': 'CODEX_QUOTA', 'sessionBudgetExceeded': 'CODEX_QUOTA', 'rateLimitExceeded': 'CODEX_RATE_LIMIT'}
STEP_TIMEOUT, IDLE_SECONDS, CHECK_SECONDS = 600, 1800, 600
MESSAGES_MAX, CHARS_MAX = 400, 2_000_000
KEY = re.compile(r'^[A-Za-z0-9_.:-]{1,160}$')
PREAMBLE = ('You are the model behind the AI Bro kernel. You have no tools of your own here: no shell, files, '
            'network, web search, plan, apps or skills, and you must not try to use any. The host application '
            'executes tools for you through the text protocol described below; reply only in that protocol.\n\n')


class KernelModelError(Exception):
    def __init__(self, status, code, message, pause=False, detail=None):
        super().__init__(message)
        self.status, self.code, self.message, self.pause, self.detail = status, code, message, pause, detail

    def public(self):
        return {'error': {'code': self.code, 'message': self.message, 'pause': self.pause, **({'detail': self.detail} if self.detail else {})}}


def version_tuple(text):
    match = re.match(r'^(\d+)\.(\d+)\.(\d+)', text or '')
    return tuple(int(part) for part in match.groups()) if match else None


def range_text():
    return f'{MIN_VERSION[0]}.{MIN_VERSION[1]}–{MAX_VERSION[0]}.{MAX_VERSION[1] - 1}'


def estimate(text):
    """Same estimate as kernel-compaction.js tokens(): wide chars 1.5, others 1/3."""
    wide = sum(1 for char in text if ord(char) > 127)
    return int(wide * 1.5 + (len(text) - wide) / 3 + 0.999)


def digest(role, content):
    return hashlib.sha256((role + '\0' + content).encode('utf-8', 'surrogatepass')).hexdigest()


def render(messages):
    """The input of one turn: a single new user message as is, otherwise a labelled transcript."""
    if len(messages) == 1 and messages[0]['role'] == 'user': return messages[0]['content']
    labels = {'user': '[用户 / 宿主]', 'assistant': '[你之前的回复]'}
    body = '\n\n'.join(labels[m['role']] + '\n' + m['content'] for m in messages)
    return '以下是本次运行到目前为止的记录（按顺序，你的回复已经发出过，不要重复）：\n\n' + body + '\n\n请接着回复最后这条。'


class Inbox:
    """Subscriber queue for one thread (the bridge calls put/close)."""
    def __init__(self): self.items, self.closed = queue.Queue(), False
    def put(self, item): self.items.put(item)
    def get(self, timeout): return self.items.get(timeout=timeout)
    def close(self): self.closed = True; self.items.put({'method': '_runtime_closed', 'params': {}})


class Session:
    def __init__(self, key, mode):
        self.key, self.mode = key, mode
        self.lock = threading.Lock()
        self.thread_id = self.process = self.turn_id = None
        self.system = None
        self.known = []
        self.cancel = threading.Event()
        self.steps = self.threads = 0
        self.version = None
        self.used = time.monotonic()


class CodexKernel:
    def __init__(self, data_directory, detect, command=None, bridge_factory=None, step_timeout=STEP_TIMEOUT):
        self.directory = Path(data_directory).resolve()
        self.detect, self.command, self.step_timeout = detect, command, step_timeout
        # Same Codex home as chat (same login), but its own locked-down process.
        self.bridge_factory = bridge_factory or (lambda mode: CodexBridge(self.directory, command=command, mode=mode, lockdown=True))
        self.bridges, self.sessions, self.checked = {}, {}, {}
        self.lock = threading.Lock()

    def bridge(self, mode):
        with self.lock:
            if mode not in self.bridges: self.bridges[mode] = self.bridge_factory(mode)
            return self.bridges[mode]

    # ---- version and login ------------------------------------------------
    def check(self, mode, force=False):
        if mode not in ('shared', 'private'): raise KernelModelError(400, 'INVALID_REQUEST', 'Codex 登录方式无效。')
        cached = self.checked.get(mode)
        if cached and not force and time.monotonic() - cached[0] < CHECK_SECONDS: return cached[1]
        found = self.detect(mode)
        if not found.get('installed'):
            raise KernelModelError(409, 'CODEX_UNAVAILABLE', '未找到 Codex CLI。请安装官方 Codex CLI，或在设置里把内核的模型来源改回 API。')
        version = found.get('version')
        parsed = version_tuple(version)
        if parsed is None or not MIN_VERSION <= parsed < MAX_VERSION:
            raise KernelModelError(409, 'CODEX_VERSION', f'Codex CLI {version or "版本未知"} 没有经过内核验证（支持 {range_text()}）。为确保它不会自己执行工具，内核拒绝在这个版本上运行；请换用已验证的版本，或改用 API。', detail={'version': version})
        if not found.get('loggedIn'):
            hint = '请在终端运行 codex login。' if mode == 'shared' else '请在设置里登录 OpenAI 账号。'
            raise KernelModelError(409, 'CODEX_LOGIN', 'Codex CLI 尚未登录，内核无法使用它。' + hint)
        self.checked[mode] = (time.monotonic(), version)
        return version

    # ---- sessions ---------------------------------------------------------
    def _session(self, key, mode):
        with self.lock:
            self._sweep()
            session = self.sessions.get(key)
            if session is None or session.mode != mode:
                if session is not None: self._drop(session)
                session = self.sessions[key] = Session(key, mode)
            session.used = time.monotonic()
            return session

    def _sweep(self):
        now = time.monotonic()
        for key, session in list(self.sessions.items()):
            if now - session.used > IDLE_SECONDS and not session.lock.locked():
                self.sessions.pop(key, None); self._drop(session)

    def _drop(self, session):
        """Forget the run's thread (unsubscribe; the thread is ephemeral)."""
        thread_id, session.thread_id, session.known, session.system = session.thread_id, None, [], None
        if not thread_id: return
        bridge = self.bridges.get(session.mode)
        if bridge is None: return
        with bridge.state_lock: bridge.subscribers.pop(thread_id, None)
        if bridge.process is not None and bridge.process is session.process:
            try: bridge._request('thread/unsubscribe', {'threadId': thread_id}, timeout=3)
            except BridgeError: pass

    def cancel(self, key):
        with self.lock: session = self.sessions.get(key)
        if session is None: return False
        session.cancel.set()
        return True

    def close(self, key):
        with self.lock: session = self.sessions.pop(key, None)
        if session is None: return False
        session.cancel.set()
        with session.lock: self._drop(session)
        return True

    def shutdown(self):
        for key in list(self.sessions): self.close(key)
        for bridge in list(self.bridges.values()): bridge.close()

    # ---- one step -----------------------------------------------------------
    @staticmethod
    def _messages(messages):
        if not isinstance(messages, list) or not messages or len(messages) > MESSAGES_MAX:
            raise KernelModelError(400, 'INVALID_REQUEST', 'messages 无效')
        out, total = [], 0
        for message in messages:
            if not isinstance(message, dict) or message.get('role') not in ('system', 'developer', 'user', 'assistant'):
                raise KernelModelError(400, 'INVALID_REQUEST', '只接受 system / user / assistant 文本消息（内核走文本协议）')
            content = message.get('content')
            if not isinstance(content, str): raise KernelModelError(400, 'INVALID_REQUEST', '消息内容必须是文本')
            total += len(content)
            out.append({'role': 'system' if message['role'] == 'developer' else message['role'], 'content': content})
        if total > CHARS_MAX: raise KernelModelError(413, 'TOO_LARGE', '上下文过大')
        if out[-1]['role'] != 'user': raise KernelModelError(400, 'INVALID_REQUEST', '最后一条必须是用户或工具结果')
        return out

    def step(self, key, messages, mode='shared', model=None, effort=None):
        if not isinstance(key, str) or not KEY.match(key): raise KernelModelError(400, 'INVALID_REQUEST', 'runId 无效')
        if model is not None and (not isinstance(model, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}', model)):
            raise KernelModelError(400, 'INVALID_REQUEST', '模型名称无效')
        if effort is not None and (not isinstance(effort, str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,31}', effort)):
            raise KernelModelError(400, 'INVALID_REQUEST', '推理强度无效')
        messages = self._messages(messages)
        session = self._session(key, mode)
        if not session.lock.acquire(timeout=5): raise KernelModelError(409, 'BUSY', '这个运行已有一步在进行')
        try:
            if session.cancel.is_set(): raise KernelModelError(409, 'CANCELLED', '运行已取消。')
            session.version = self.check(mode)
            return self._step(session, messages, model, effort)
        finally:
            session.used = time.monotonic()
            session.lock.release()

    def _start_thread(self, session, bridge, system, model):
        self._drop(session)
        parameters = {
            'model': model, **provider_choice(bridge.mode), 'cwd': str(bridge.cwd), 'allowProviderModelFallback': False,
            'approvalPolicy': 'never', 'sandbox': 'read-only', 'ephemeral': True,
            'environments': [], 'dynamicTools': [], 'runtimeWorkspaceRoots': [], 'selectedCapabilityRoots': [],
            'config': kernel_config(bridge.home is not None), 'developerInstructions': PREAMBLE + system,
        }
        started = bridge.rpc('thread/start', parameters)
        thread = started.get('thread') if isinstance(started.get('thread'), dict) else {}
        thread_id = thread.get('id')
        if not isinstance(thread_id, str) or not thread_id: raise KernelModelError(502, 'CODEX_FAILED', 'Codex 未能创建对话。')
        sandbox = started.get('sandbox') if isinstance(started.get('sandbox'), dict) else {}
        if started.get('approvalPolicy') != 'never' or sandbox.get('type') != 'readOnly' or sandbox.get('networkAccess') not in (None, False):
            try: bridge._request('thread/unsubscribe', {'threadId': thread_id}, timeout=3)
            except BridgeError: pass
            raise KernelModelError(409, 'CODEX_NOT_LOCKED', 'Codex CLI 没有按要求进入“只读、无审批、无网络”的状态（实际：审批 '
                                   + str(started.get('approvalPolicy'))[:40] + '，沙箱 ' + str(sandbox.get('type'))[:40] + '），内核拒绝使用它。')
        session.thread_id, session.process = thread_id, bridge.process
        session.threads += 1
        return thread_id

    def _step(self, session, messages, model, effort):
        bridge = self.bridge(session.mode)
        t0 = time.monotonic()
        system = '\n\n'.join(m['content'] for m in messages if m['role'] == 'system')
        rest = [m for m in messages if m['role'] != 'system']
        hashes = [digest(m['role'], m['content']) for m in rest]
        try:
            bridge.ensure()
        except BridgeError as error:
            raise KernelModelError(503, 'CODEX_UNAVAILABLE', str(error)) from None
        reuse = (session.thread_id and session.process is bridge.process and bridge.process is not None and bridge.process.poll() is None
                 and session.system == digest('system', system) and len(hashes) > len(session.known) and hashes[:len(session.known)] == session.known)
        new_thread = not reuse
        try:
            if new_thread:
                thread_id = self._start_thread(session, bridge, system, model)
                session.system = digest('system', system)
                delta = rest
            else:
                thread_id, delta = session.thread_id, rest[len(session.known):]
            inbox = Inbox()
            with bridge.state_lock: bridge.subscribers[thread_id] = inbox
            turn = {'threadId': thread_id, 'input': [{'type': 'text', 'text': render(delta)}], 'model': model,
                    'approvalPolicy': 'never', 'sandboxPolicy': {'type': 'readOnly', 'networkAccess': False},
                    'environments': [], 'runtimeWorkspaceRoots': []}
            if effort: turn['effort'] = effort
            started = bridge.rpc('turn/start', turn)
            turn_id = (started.get('turn') or {}).get('id') if isinstance(started.get('turn'), dict) else None
            if not isinstance(turn_id, str) or not turn_id: raise KernelModelError(502, 'CODEX_FAILED', 'Codex 未能开始这一步。')
            session.turn_id = turn_id
            content, usage = self._collect(session, bridge, inbox, thread_id, turn_id)
        except BridgeError as error:
            self._drop(session)
            raise KernelModelError(503, 'CODEX_UNAVAILABLE', str(error)) from None
        except KernelModelError:
            self._drop(session)
            raise
        finally:
            session.turn_id = None
        session.known = hashes + [digest('assistant', content)]
        session.steps += 1
        estimated = usage is None
        if estimated:
            # No usage from the CLI: estimate the thread's context (its own instructions included) on the high side.
            usage = {'inputTokens': estimate(system + ''.join(m['content'] for m in rest)) + 4000, 'outputTokens': estimate(content), 'cachedInputTokens': 0}
        return {'content': content, 'finish': 'stop', 'ms': int((time.monotonic() - t0) * 1000), 'newThread': new_thread,
                'thread': session.threads, 'version': session.version, 'sent': len(delta),
                'usage': {'prompt_tokens': usage.get('inputTokens'), 'completion_tokens': usage.get('outputTokens'),
                          'prompt_tokens_details': {'cached_tokens': usage.get('cachedInputTokens') or 0},
                          'context_window': usage.get('modelContextWindow'), 'estimated': estimated}}

    def _interrupt(self, bridge, thread_id, turn_id):
        try: bridge._request('turn/interrupt', {'threadId': thread_id, 'turnId': turn_id}, timeout=3)
        except BridgeError: pass

    def _collect(self, session, bridge, inbox, thread_id, turn_id):
        deadline = time.monotonic() + self.step_timeout
        texts, order, usage = {}, [], None
        while True:
            if session.cancel.is_set():
                self._interrupt(bridge, thread_id, turn_id)
                raise KernelModelError(409, 'CANCELLED', '运行已取消，这一步已中止。')
            if time.monotonic() > deadline:
                self._interrupt(bridge, thread_id, turn_id)
                raise KernelModelError(504, 'CODEX_TIMEOUT', f'Codex 在 {self.step_timeout} 秒内没有完成这一步。')
            try: event = inbox.get(timeout=0.2)
            except queue.Empty: continue
            method, params = event.get('method'), event.get('params') or {}
            if method == '_runtime_closed': raise KernelModelError(503, 'CODEX_CLOSED', 'Codex 运行时已退出，这一步未完成。')
            if params.get('threadId') != thread_id: continue
            if method == '_server_request':
                self._interrupt(bridge, thread_id, turn_id)
                raise KernelModelError(502, 'CODEX_TOOL_EVENT', f'Codex CLI 请求了自带的工具或审批（{params.get("request")}），已拒绝并中止这一步。内核只把 Codex 当模型用。', detail={'event': params.get('request')})
            event_turn = params.get('turnId') or (params.get('turn') or {}).get('id')
            if event_turn is not None and event_turn != turn_id: continue
            if method in ('item/started', 'item/completed'):
                item = params.get('item') or {}
                kind = item.get('type')
                if kind not in ALLOWED_ITEMS:
                    self._interrupt(bridge, thread_id, turn_id)
                    raise KernelModelError(502, 'CODEX_TOOL_EVENT', f'Codex CLI 回报了自带工具事件（{kind}），已中止这一步。内核只把 Codex 当模型用。', detail={'event': str(kind)[:40]})
                if kind == 'agentMessage':
                    identifier = item.get('id') or '_'
                    if identifier not in texts: order.append(identifier); texts[identifier] = {'text': '', 'phase': None}
                    if item.get('phase'): texts[identifier]['phase'] = item['phase']
                    if isinstance(item.get('text'), str) and item['text']: texts[identifier]['text'] = item['text']
            elif method == 'item/agentMessage/delta':
                identifier = params.get('itemId') or '_'
                if identifier not in texts: order.append(identifier); texts[identifier] = {'text': '', 'phase': None}
                texts[identifier]['text'] += params.get('delta') or ''
            elif method == 'thread/tokenUsage/updated':
                last = (params.get('tokenUsage') or {}).get('last')
                if isinstance(last, dict) and isinstance(last.get('inputTokens'), int):
                    usage = {**last, 'modelContextWindow': (params.get('tokenUsage') or {}).get('modelContextWindow')}
            elif method == 'error':
                kind = (params.get('error') or {}).get('kind')
                if kind in ('usageLimitExceeded', 'sessionBudgetExceeded') or (kind == 'rateLimitExceeded' and not params.get('willRetry')):
                    self._interrupt(bridge, thread_id, turn_id)
                    raise self._quota(kind)
            elif method == 'turn/completed':
                turn = params.get('turn') or {}
                status, kind = turn.get('status'), (turn.get('error') or {}).get('kind')
                if status == 'completed':
                    finals = [texts[i]['text'] for i in order if texts[i]['phase'] == 'final_answer' and texts[i]['text']]
                    plain = [texts[i]['text'] for i in order if texts[i]['phase'] is None and texts[i]['text']]
                    content = (finals or plain or [''])[-1]
                    if not content: raise KernelModelError(502, 'CODEX_EMPTY', 'Codex 这一步没有给出回复。')
                    return content, usage
                if kind in QUOTA: raise self._quota(kind)
                if status == 'interrupted' and session.cancel.is_set(): raise KernelModelError(409, 'CANCELLED', '运行已取消，这一步已中止。')
                if kind == 'contextWindowExceeded': raise KernelModelError(413, 'CODEX_CONTEXT', '上下文超过了模型窗口，需要先压缩。')
                if kind == 'unauthorized': raise KernelModelError(401, 'CODEX_LOGIN', 'Codex 登录已失效，请重新登录后继续。', pause=True)
                raise KernelModelError(502, 'CODEX_TURN_FAILED', 'Codex 未能完成这一步' + (f'（{kind}）' if kind else '') + '。', detail={'kind': kind} if kind else None)

    @staticmethod
    def _quota(kind):
        if QUOTA.get(kind) == 'CODEX_RATE_LIMIT':
            return KernelModelError(429, 'CODEX_RATE_LIMIT', 'Codex 订阅触发了速率限制。运行已暂停，稍后在“后台运行”里继续。', pause=True, detail={'kind': kind})
        return KernelModelError(429, 'CODEX_QUOTA', 'Codex 订阅额度已用尽。运行已暂停，额度恢复后在“后台运行”里继续，或改用 API。', pause=True, detail={'kind': kind})


# -- HTTP (the headless host: /__kernel/host/codex/*) ----------------------
def handle_request(handler, kernel, host_token):
    """POST /__kernel/host/codex/{step,cancel,close}. Kernel host token only."""
    path = urllib.parse.urlsplit(handler.path).path
    if not path.startswith('/__kernel/host/codex/'): return False
    import kernel_runs
    try:
        if kernel_runs._loopback(handler) is None: raise KernelModelError(403, 'LOOPBACK_ONLY', '只接受本机 AI Bro 的请求')
        header = handler.headers.get('X-AIBro-Kernel-Host', '')
        if not (host_token and header and hmac.compare_digest(header, host_token)): raise KernelModelError(403, 'HOST_ONLY', '只允许内核宿主调用')
        if handler.command != 'POST': raise KernelModelError(405, 'METHOD', '只接受 POST')
        try: body = kernel_runs._body(handler, 4 * 1024 * 1024)
        except kernel_runs.KernelError as error: raise KernelModelError(error.status, error.code, error.message) from None
        action = path.rsplit('/', 1)[1]
        if action == 'step':
            result = kernel.step(body.get('runId'), body.get('messages'), body.get('mode') or 'shared', body.get('model') or None, body.get('effort') or None)
        elif action == 'cancel': result = {'ok': kernel.cancel(str(body.get('runId')))}
        elif action == 'close': result = {'ok': kernel.close(str(body.get('runId')))}
        elif action == 'check':
            result = {'version': kernel.check(body.get('mode') or 'shared', force=True), 'range': range_text()}
        else: raise KernelModelError(404, 'NOT_FOUND', '未知接口')
        handler.send_json(result)
    except KernelModelError as error:
        handler.send_json(error.public(), error.status)
    except (BrokenPipeError, ConnectionResetError): pass
    return True


# -- bench server ------------------------------------------------------------
def serve(arguments):
    """Kernel-bench endpoint: /r/<tag>/{step,cancel,close}; per-tag usage rows like llm-proxy.cjs."""
    from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
    from codex_connection import CodexConnection
    options = dict(zip(arguments[::2], arguments[1::2]))
    data, logdir = Path(options['--data']), Path(options['--logdir'])
    mode, model, effort = options.get('--mode', 'shared'), options.get('--model') or None, options.get('--effort') or None
    logdir.mkdir(parents=True, exist_ok=True)
    kernel = None
    connection = CodexConnection(data, lambda m: kernel.bridge(m))
    kernel = CodexKernel(data, connection.detect)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass

        def do_POST(self):
            match = re.match(r'^/r/([A-Za-z0-9_.-]{1,120})/(step|cancel|close)$', self.path)
            if not match: self.send_response(404); self.end_headers(); return
            tag, action = match.groups()
            length = int(self.headers.get('Content-Length') or 0)
            try: body = json.loads(self.rfile.read(length) or b'{}')
            except ValueError: body = {}
            t0 = time.time()
            row = {'t': int(t0 * 1000), 'endpoint': '/codex/' + action, 'requested': model, 'stream': False}
            try:
                if action == 'step':
                    result = kernel.step(tag, body.get('messages'), mode, model, effort)
                    usage = result['usage']
                    row.update(status=200, usage={'input': usage['prompt_tokens'] or 0, 'output': usage['completion_tokens'] or 0, 'cached': usage['prompt_tokens_details']['cached_tokens']},
                               codex={'newThread': result['newThread'], 'sent': result['sent'], 'estimated': usage['estimated'], 'version': result['version']})
                else:
                    result = {'ok': kernel.cancel(tag) if action == 'cancel' else kernel.close(tag)}
                    row.update(status=200)
                status, payload = 200, result
            except KernelModelError as error:
                status, payload = error.status, error.public()
                row.update(status=status, error=error.code + ' ' + error.message[:200])
            row['ms'] = int((time.time() - t0) * 1000)
            raw = json.dumps(payload, ensure_ascii=False).encode()
            try:
                self.send_response(status); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(raw))); self.end_headers(); self.wfile.write(raw)
            except (BrokenPipeError, ConnectionResetError): pass
            if action == 'step' or status != 200:
                with open(logdir / (tag + '.jsonl'), 'a', encoding='utf-8') as file: file.write(json.dumps(row, ensure_ascii=False) + '\n')

    server = ThreadingHTTPServer(('127.0.0.1', int(options.get('--port', '0'))), Handler)
    server.daemon_threads = True
    sys.stdout.write(f'port {server.server_address[1]}\n'); sys.stdout.flush()
    try: server.serve_forever()
    finally: kernel.shutdown()


if __name__ == '__main__' and len(sys.argv) > 1 and sys.argv[1] == 'serve':
    serve(sys.argv[2:])
