"""Local official Claude Code adapter; not an API/OAuth-token proxy.

No constructor/import launches a process. The CLI alone owns authentication.
The loopback HTTP host exposes only these bounded operations, never credential
files or a dynamic-tool executor.
"""
import json
import os
from pathlib import Path
import queue
import re
import shutil
import signal
import subprocess
import threading
import time


MAX_LINE = 1024 * 1024
MAX_OUTPUT = 16 * 1024 * 1024
AUTH_METHODS = {'none', 'claude.ai', 'oauth_token', 'api_key', 'api_key_helper', 'third_party'}
REQUIRED_FLAGS = ('--safe-mode', '--tools', '--strict-mcp-config', '--setting-sources',
                  '--permission-mode', '--no-session-persistence', '--include-partial-messages',
                  '--output-format', '--verbose', '--print')


class BridgeError(Exception):
    def __init__(self, code, message='Claude Code 操作未完成。'):
        super().__init__(message)
        self.code = code


def invalid():
    return BridgeError('unsupported_protocol', 'Claude Code 返回了未支持或不完整的协议，请检查 CLI 版本。')


def text(value, limit=MAX_LINE):
    if not isinstance(value, str) or len(value.encode('utf-8')) > limit:
        raise invalid()
    return value


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}', value):
        raise invalid()
    return value


def clean_environment(source=None):
    """Do not inherit API keys, token overrides, alternate routes or SDK flags.

    HOME remains unchanged so the *official CLI* can use its own login. This
    module never opens its files. Project/user customizations are disabled by
    supported CLI flags; managed organizational policy still applies.
    """
    source = os.environ if source is None else source
    allowed = ('HOME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'SYSTEMROOT')
    return {key: source[key] for key in allowed if key in source}


def runtime_command(environment=None):
    """Find a local installation even with Finder's minimal PATH; never a shell."""
    env = os.environ if environment is None else environment
    home = env.get('HOME')
    path = os.pathsep.join(p for p in env.get('PATH', '').split(os.pathsep) if p and Path(p).is_absolute())
    found = shutil.which('claude', path=path)
    candidates = [found] if found else []
    if home and Path(home).is_absolute(): candidates.append(str(Path(home) / '.local/bin/claude'))
    candidates += ['/opt/homebrew/bin/claude', '/usr/local/bin/claude']
    return next((p for p in candidates if Path(p).is_file() and os.access(p, os.X_OK)), None)


class SubprocessRunner:
    """Injectable runner contract: run(argv, cwd, env, stdin, cancel, timeout, on_line).

    Returns an exit code. stdout is bounded NDJSON/text, stderr is deliberately
    not retained: CLI diagnostics can contain login URLs/codes or local secrets.
    Cancellation terminates only the new process group owned by this call.
    """
    def run(self, argv, *, cwd, env, stdin, cancel, timeout, on_line):
        if cancel.is_set():
            raise BridgeError('cancelled', '已停止 Claude Code 操作。')
        try:
            process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                       start_new_session=True)
        except OSError:
            raise BridgeError('cli_unavailable', '找不到可运行的官方 Claude Code CLI。') from None
        lines = queue.Queue(maxsize=32)
        stopping = threading.Event()

        def offer(value):
            while not cancel.is_set() and not stopping.is_set():
                try:
                    lines.put(value, timeout=.05)
                    return
                except queue.Full:
                    pass

        def read():
            total = 0
            try:
                while True:
                    raw = process.stdout.readline(MAX_LINE + 1)
                    if not raw:
                        break
                    total += len(raw)
                    if len(raw) > MAX_LINE or total > MAX_OUTPUT:
                        offer(BridgeError('output_limit', 'Claude Code 输出超出本地适配器限制。'))
                        return
                    try:
                        offer(raw.decode('utf-8'))
                    except UnicodeDecodeError:
                        offer(invalid())
                        return
            finally:
                offer(None)

        def write():
            try:
                process.stdin.write(stdin.encode('utf-8'))
                process.stdin.close()
            except (BrokenPipeError, OSError, ValueError):
                pass

        reader = threading.Thread(target=read, daemon=True)
        writer = threading.Thread(target=write, daemon=True)
        reader.start()
        writer.start()
        deadline = time.monotonic() + timeout
        try:
            while True:
                if cancel.is_set():
                    raise BridgeError('cancelled', '已停止 Claude Code 操作。')
                if time.monotonic() >= deadline:
                    raise BridgeError('timeout', 'Claude Code 操作超时，进程已停止。')
                try:
                    line = lines.get(timeout=.05)
                except queue.Empty:
                    continue
                if line is None:
                    while process.poll() is None:
                        if cancel.wait(.05):
                            raise BridgeError('cancelled', '已停止 Claude Code 操作。')
                        if time.monotonic() >= deadline:
                            raise BridgeError('timeout', 'Claude Code 操作超时，进程已停止。')
                    return process.returncode
                if isinstance(line, Exception):
                    raise line
                on_line(line)
        except subprocess.TimeoutExpired:
            raise BridgeError('timeout', 'Claude Code 操作超时，进程已停止。') from None
        finally:
            # Also terminate on parser/callback failure, not just user cancel.
            stopping.set()
            # A group can outlive its leader (for example a child retaining
            # stdout). Clean that group too, without touching other CLI jobs.
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=1)
            reader.join(timeout=.2)
            writer.join(timeout=.2)
            process.stdout.close()
            if not process.stdin.closed:
                process.stdin.close()


class _EventDelivery:
    """One bounded callback worker; never call host code on the runner/state lock.

    A callback already entered cannot be forcibly unwound by Python. Cancellation
    stops waiting for it and drops future data deliveries; process cleanup keeps
    advancing. A bridge-wide slot remains occupied until that callback returns,
    preventing unlimited blocked host callbacks from creating unlimited threads.
    """
    def __init__(self, callback, cancel, deadline, slots):
        if not slots.acquire(blocking=False):
            raise BridgeError('busy', 'Claude Code 事件接收器尚未释放，请稍后再试。')
        self.callback, self.cancel, self.deadline = callback, cancel, deadline
        self.items = queue.Queue(maxsize=1)
        self.closed = threading.Event()

        def work():
            try:
                while not self.closed.is_set() or not self.items.empty():
                    try:
                        item = self.items.get(timeout=.02)
                    except queue.Empty:
                        continue
                    try:
                        if item['terminal'] or (not self.cancel.is_set() and time.monotonic() < self.deadline):
                            self.callback(item['event'])
                    except Exception:
                        item['failed'] = True
                    finally:
                        item['done'].set()
            finally:
                slots.release()
        threading.Thread(target=work, daemon=True).start()

    def _check(self):
        if self.cancel.is_set():
            raise BridgeError('cancelled', '已停止 Claude Code 操作。')
        if time.monotonic() >= self.deadline:
            raise BridgeError('timeout', 'Claude Code 操作超时，进程已停止。')

    def emit(self, event):
        self._check()
        item = {'event': event, 'terminal': False, 'done': threading.Event(), 'failed': False}
        self.items.put_nowait(item)
        while not item['done'].wait(.01):
            self._check()
        self._check()
        if item['failed']:
            raise BridgeError('callback_failed', 'Claude Code 事件接收失败，已停止。')

    def terminal(self, event):
        # Failure reporting must not re-enter a blocked callback on the caller
        # thread. Keep the last terminal item queued, without waiting forever.
        item = {'event': event, 'terminal': True, 'done': threading.Event(), 'failed': False}
        try:
            self.items.put_nowait(item)
        except queue.Full:
            return
        item['done'].wait(.03)

    def close(self):
        self.closed.set()


class StreamJSONAdapter:
    """Strict observer for the documented main-session stream-json subset.

    tool_input means a complete proposed invocation, not execution. Only an
    observed tool_result means completion. Thinking/signature bytes are never
    copied into public events: the CLI does not identify them as public summaries.
    This observer is not a mechanism for sending tool results back to the CLI.
    """
    def __init__(self, emit, *, allow_tools=False):
        self.emit = emit
        self.allow_tools = allow_tools
        self.session = None
        self.message = None
        self.blocks = {}
        self.snapshots = {}
        self.tools = {}
        self.has_text = False
        self.result = None
        self.initialized = False
        self.seen_messages = set()
        self.last_message = None

    def _session(self, item):
        if item.get('parent_tool_use_id') is not None:
            raise BridgeError('unsupported_subagent', '当前连接不支持子代理协议。')
        if 'session_id' in item:
            value = identifier(item['session_id'])
            if self.session is not None and self.session != value:
                raise invalid()
            self.session = value

    def _text(self, value):
        value = text(value)
        if value:
            self.has_text = True
            self.emit({'type': 'text', 'text': value})

    def _block(self, value):
        if not isinstance(value, dict):
            raise invalid()
        kind = value.get('type')
        if kind == 'text':
            return {'type': kind, 'text': text(value.get('text', ''))}
        if kind in ('thinking', 'redacted_thinking'):
            return {'type': kind}
        if kind == 'tool_use':
            if not self.allow_tools:
                raise BridgeError('unexpected_tool', '无工具模式下收到工具调用，已停止。')
            args = value.get('input', {})
            if not isinstance(args, dict):
                raise invalid()
            return {'type': kind, 'id': identifier(value.get('id')),
                    'name': identifier(value.get('name')), 'input': args, 'json': ''}
        raise invalid()

    def _tool(self, block):
        key = block['id']
        if key in self.tools:
            if self.tools[key]['input'] != block['input'] or self.tools[key]['name'] != block['name']:
                raise invalid()
            return
        self.tools[key] = {'name': block['name'], 'input': block['input'], 'done': False}
        self.emit({'type': 'tool_input', 'id': key, 'name': block['name'], 'input': block['input']})

    def line(self, raw):
        if not raw.strip():
            return
        if len(raw.encode('utf-8')) > MAX_LINE:
            raise invalid()
        try:
            item = json.loads(raw)
        except (ValueError, RecursionError):
            raise invalid() from None
        if not isinstance(item, dict) or self.result is not None:
            raise invalid()
        self._session(item)
        kind = item.get('type')
        is_init = kind == 'system' and item.get('subtype') == 'init'
        if not self.initialized and not is_init:
            raise invalid()
        if kind == 'system':
            subtype = item.get('subtype')
            if subtype == 'init':
                if self.initialized or not isinstance(item.get('session_id'), str):
                    raise invalid()
                if item.get('mcp_server_errors') or item.get('mcp_servers'):
                    raise BridgeError('unexpected_mcp', '当前连接不加载 MCP 服务。')
                if not isinstance(item.get('tools'), list) or (item['tools'] and not self.allow_tools) or item.get('permissionMode') != 'dontAsk':
                    raise BridgeError('unsafe_runtime', 'Claude Code 未按限制配置启动，已停止。')
                self.initialized = True
                self.emit({'type': 'started'})
            elif subtype == 'api_retry':
                attempt = item.get('attempt')
                if type(attempt) is not int or not 1 <= attempt <= 100:
                    raise invalid()
                self.emit({'type': 'retry', 'attempt': attempt})
            else:
                raise invalid()
        elif kind == 'stream_event':
            self._stream(item.get('event'))
        elif kind == 'assistant':
            if item.get('error'):
                raise BridgeError('model_error', 'Claude Code 模型请求失败。')
            msg = item.get('message')
            if not isinstance(msg, dict) or not isinstance(msg.get('content'), list):
                raise invalid()
            key = identifier(msg.get('id'))
            if self.message is not None and self.message != key:
                raise invalid()
            blocks = [self._block(block) for block in msg['content']]
            previous = (list(self.blocks.values()) if self.message == key else self.snapshots.get(key))
            if previous is not None:
                # Complete assistant messages repeat the streamed content.
                if len(previous) != len(blocks):
                    raise invalid()
                if self.message == key and any(not block.get('closed') for block in previous):
                    raise invalid()
                for old, new in zip(previous, blocks):
                    if {k: v for k, v in old.items() if k not in ('closed', 'json')} != {k: v for k, v in new.items() if k != 'json'}:
                        raise invalid()
                return
            if key in self.seen_messages or not blocks:
                raise invalid()
            self.seen_messages.add(key)
            for block in blocks:
                if block['type'] == 'text':
                    self._text(block['text'])
                elif block['type'] == 'tool_use':
                    self._tool(block)
                else:
                    self.emit({'type': 'reasoning', 'status': 'observed', 'text': '正在思考'})
            self.snapshots[key] = blocks
            self.last_message = key
        elif kind == 'user':
            msg = item.get('message')
            if not isinstance(msg, dict) or not isinstance(msg.get('content'), list):
                raise invalid()
            for block in msg['content']:
                if not isinstance(block, dict) or block.get('type') != 'tool_result':
                    raise invalid()
                key = identifier(block.get('tool_use_id'))
                if key not in self.tools or self.tools[key]['done']:
                    raise invalid()
                content = block.get('content', '')
                if isinstance(content, list):
                    if any(not isinstance(part, dict) or part.get('type') != 'text' for part in content):
                        raise BridgeError('unsupported_tool_result', '暂不支持此工具结果格式。')
                    content = '\n'.join(text(part.get('text')) for part in content)
                error = block.get('is_error', False)
                if type(error) is not bool:
                    raise invalid()
                self.tools[key]['done'] = True
                self.emit({'type': 'tool_result', 'id': key, 'text': text(content), 'isError': error})
        elif kind == 'result':
            if item.get('permission_denials'):
                raise BridgeError('permission_denied', 'Claude Code 拒绝了需要额外权限的操作。')
            if item.get('is_error') is not False or item.get('subtype') != 'success':
                raise BridgeError('model_error', 'Claude Code 未成功完成请求。')
            if self.message is not None or self.last_message is None or any(not tool['done'] for tool in self.tools.values()):
                raise invalid()
            final_text = text(item.get('result'))
            visible = ''.join(block['text'] for block in self.snapshots[self.last_message] if block['type'] == 'text')
            # The CLI result describes the final assistant message, not prior
            # tool-turn commentary. Only an exact answer or append-only suffix
            # is compatible with text already delivered for that message.
            if not final_text.startswith(visible):
                raise invalid()
            if len(final_text) > len(visible):
                self._text(final_text[len(visible):])
            self.result = {'type': 'done', 'sessionId': self.session}
        else:
            # In particular: control_request is not an approval we silently grant.
            raise invalid()

    def _stream(self, event):
        if not isinstance(event, dict):
            raise invalid()
        kind = event.get('type')
        if kind == 'ping':
            return
        if kind == 'message_start':
            if self.message is not None or not isinstance(event.get('message'), dict):
                raise invalid()
            key = identifier(event['message'].get('id'))
            if key in self.seen_messages:
                raise invalid()
            self.seen_messages.add(key)
            self.message = key
            self.blocks = {}
        elif kind == 'content_block_start':
            index = event.get('index')
            if self.message is None or type(index) is not int or index != len(self.blocks):
                raise invalid()
            block = self._block(event.get('content_block'))
            self.blocks[index] = block
            if block['type'] == 'text':
                self._text(block['text'])
            elif block['type'] in ('thinking', 'redacted_thinking'):
                self.emit({'type': 'reasoning', 'status': 'observed', 'text': '正在思考'})
            else:
                self.emit({'type': 'tool_start', 'id': block['id'], 'name': block['name']})
        elif kind in ('content_block_delta', 'content_block_stop'):
            index = event.get('index')
            if type(index) is not int or index not in self.blocks or self.blocks[index].get('closed'):
                raise invalid()
            block = self.blocks[index]
            if kind == 'content_block_stop':
                if block['type'] == 'tool_use':
                    if block['json']:
                        try:
                            block['input'] = json.loads(block['json'])
                        except (ValueError, RecursionError):
                            raise invalid() from None
                        if not isinstance(block['input'], dict):
                            raise invalid()
                    self._tool(block)
                block['closed'] = True
                return
            delta = event.get('delta')
            if not isinstance(delta, dict):
                raise invalid()
            subtype = delta.get('type')
            if subtype == 'text_delta' and block['type'] == 'text':
                chunk = text(delta.get('text'))
                block['text'] += chunk
                self._text(chunk)
            elif subtype == 'input_json_delta' and block['type'] == 'tool_use':
                block['json'] += text(delta.get('partial_json'))
                text(block['json'])
            elif subtype in ('thinking_delta', 'signature_delta') and block['type'] == 'thinking':
                pass  # Never label private thinking or signatures as a public summary.
            else:
                raise invalid()
        elif kind == 'message_delta':
            if self.message is None:
                raise invalid()
        elif kind == 'message_stop':
            if self.message is None or not self.blocks or any(not block.get('closed') for block in self.blocks.values()):
                raise invalid()
            self.snapshots[self.message] = list(self.blocks.values())
            self.last_message = self.message
            self.message = None
            self.blocks = {}
        elif kind == 'error':
            raise BridgeError('model_error', 'Claude Code 流式请求失败。')
        else:
            raise invalid()

    def finish(self):
        if self.result is None:
            raise BridgeError('incomplete_stream', 'Claude Code 未返回完整结束事件。')
        return dict(self.result)


class ClaudeBridge:
    def __init__(self, working_directory, *, command=None, runner=None, environment=None):
        self.cwd = str(Path(working_directory).resolve())
        self.command = command
        self.runner = runner or SubprocessRunner()
        self.env = clean_environment(environment)
        self.lock = threading.RLock()
        self.jobs = {}
        # Completed result retention is bounded independently of ID reuse.
        # Never let a delayed cancel for an evicted job cancel a new job.
        self.used_ids = set()
        self.logging_out = False
        self.closed = False
        self.callback_slots = threading.BoundedSemaphore(4)

    def _argv(self, *args):
        command = self.command or runtime_command(self.env)
        if not isinstance(command, str) or not command:
            raise BridgeError('cli_unavailable', '请先安装官方 Claude Code CLI。')
        return [command, *args]

    def _collect(self, argv, cancel, timeout=10):
        output = []
        size = 0
        def line(value):
            nonlocal size
            size += len(value.encode('utf-8'))
            if size > MAX_LINE:
                raise invalid()
            output.append(value)
        code = self.runner.run(argv, cwd=self.cwd, env=self.env, stdin='',
                               cancel=cancel, timeout=timeout, on_line=line)
        return code, ''.join(output)

    def _probe(self, cancel):
        code, help_text = self._collect(self._argv('--help'), cancel)
        if code or any(flag not in help_text for flag in REQUIRED_FLAGS):
            raise BridgeError('unsupported_cli', '当前 Claude Code CLI 缺少必需的隔离或流式选项。')

    def status(self):
        with self.lock:
            if self.closed or self.logging_out:
                raise BridgeError('busy', 'Claude Code 账号正在切换，请稍后刷新。')
        return self._status(threading.Event())

    def _status(self, cancel):
        self._probe(cancel)
        code, raw = self._collect(self._argv('--safe-mode', '--setting-sources', '', 'auth', 'status', '--json'), cancel)
        try:
            value = json.loads(raw)
        except (ValueError, RecursionError):
            raise invalid() from None
        if not isinstance(value, dict) or type(value.get('loggedIn')) is not bool or value.get('authMethod') not in AUTH_METHODS:
            raise invalid()
        if code != (0 if value['loggedIn'] else 1):
            raise BridgeError('auth_status_failed', '无法确认 Claude Code 登录状态。')
        return {'loggedIn': value['loggedIn'], 'authMethod': value['authMethod'],
                'localCLIOnly': True, 'dynamicTools': False}

    def _job(self, request_id, *, kind='print', cancel=None):
        identifier(request_id)
        with self.lock:
            if self.closed or self.logging_out:
                raise BridgeError('busy', 'Claude Code 账号正在切换，请稍后重试。')
            if request_id in self.used_ids:
                raise BridgeError('duplicate_request', '该请求编号已经使用。')
            active = [job for job in self.jobs.values() if job['status'] == 'running']
            if len(active) >= 4 or (active and (kind == 'login' or any(job['kind'] == 'login' for job in active))):
                raise BridgeError('busy', 'Claude Code 本地操作过多，请稍后再试。')
            if len(self.used_ids) >= 4096:
                raise BridgeError('request_limit', '本次运行的 Claude 请求数量已达上限，请重启 AI Bro。')
            while len(self.jobs) >= 64:
                done = next((key for key, job in self.jobs.items() if job['status'] != 'running'), None)
                if done is None:
                    break
                del self.jobs[done]
            job = {'status': 'running', 'cancel': cancel if cancel is not None else threading.Event(),
                   'done': threading.Event(), 'kind': kind}
            self.jobs[request_id] = job
            self.used_ids.add(request_id)
            return job

    def operation_status(self, request_id):
        identifier(request_id)
        with self.lock:
            job = self.jobs.get(request_id)
            if job is None:
                raise BridgeError('unknown_request', '找不到此本地请求。')
            return {'requestId': request_id, **{key: job[key] for key in ('status', 'code') if key in job}}

    def cancel(self, request_id):
        identifier(request_id)
        with self.lock:
            job = self.jobs.get(request_id)
            if not job or job['status'] != 'running':
                return False
            job['cancel'].set()
            return True

    def _stop_jobs(self, jobs):
        deadline = time.monotonic() + 4
        for job in jobs:
            job['cancel'].set()
        for job in jobs:
            if not job['done'].wait(max(0, deadline - time.monotonic())):
                raise BridgeError('busy', 'Claude Code 请求尚未停止，请稍后重试。')

    def logout(self):
        """Explicit host confirmation only. Do not terminate unrelated CLI jobs."""
        with self.lock:
            if self.closed or self.logging_out:
                raise BridgeError('busy', 'Claude Code 账号正在切换，请稍后重试。')
            self.logging_out = True
            active = [job for job in self.jobs.values() if job['status'] == 'running']
        try:
            self._stop_jobs(active)
            cancel = threading.Event()
            self._probe(cancel)
            code, _ = self._collect(self._argv('--safe-mode', '--setting-sources', '', 'auth', 'logout'), cancel)
            if code:
                raise BridgeError('logout_failed', 'Claude Code 退出未完成，请刷新状态后重试。')
            result = self._status(cancel)
            if result['loggedIn'] or result['authMethod'] != 'none':
                raise BridgeError('logout_failed', '无法确认 Claude Code 已退出，请刷新状态。')
            return result
        finally:
            with self.lock:
                self.logging_out = False

    def close(self):
        with self.lock:
            self.closed = True
            active = [job for job in self.jobs.values() if job['status'] == 'running']
        self._stop_jobs(active)

    def login_start(self, request_id):
        """Explicit caller action only. CLI opens its own official browser login.

        No login URL/code/stdout/stderr is returned or retained. Cancellation
        stops our process; it is not logout or rollback of a completed login.
        """
        job = self._job(request_id, kind='login')
        def work():
            try:
                self._probe(job['cancel'])
                code = self.runner.run(self._argv('--safe-mode', '--setting-sources', '', 'auth', 'login', '--claudeai'),
                                       cwd=self.cwd, env=self.env, stdin='', cancel=job['cancel'],
                                       timeout=180, on_line=lambda _: None)
                if code:
                    raise BridgeError('login_failed', 'Claude Code 登录未完成，请在官方 CLI 重试。')
                with self.lock:
                    job['status'] = 'cancelled' if job['cancel'].is_set() else 'completed'
            except BridgeError as error:
                with self.lock:
                    job.update(status='cancelled' if error.code == 'cancelled' else 'failed', code=error.code)
            except Exception:
                with self.lock:
                    job.update(status='failed', code='login_failed')
            finally:
                job['done'].set()
        threading.Thread(target=work, daemon=True).start()
        return {'requestId': request_id, 'status': 'started', 'localCLIOnly': True}

    def print_stream(self, request_id, prompt, on_event, *, model=None, tools=None, timeout=120, cancel=None):
        if tools is not None and tools != []:
            raise BridgeError('unsupported_dynamic_tools', '现有动态工具不能直接交给 Claude CLI；需要单独的本地 MCP 适配。')
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt.encode('utf-8')) > MAX_LINE:
            raise BridgeError('invalid_prompt', '请输入有效且大小合适的文本。')
        if model is not None and (not isinstance(model, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}', model)):
            raise BridgeError('invalid_model', '模型标识无效。')
        if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or not 0 < timeout <= 600:
            raise BridgeError('invalid_timeout', '请求时限无效。')
        argv = self._argv('--safe-mode', '--setting-sources', '', '--print', '--output-format', 'stream-json',
                          '--verbose', '--include-partial-messages', '--no-session-persistence',
                          '--tools', '', '--strict-mcp-config', '--permission-mode', 'dontAsk')
        if model is not None:
            argv += ['--model', model]
        job = self._job(request_id, cancel=cancel)
        delivery = None
        deadline = time.monotonic() + timeout
        try:
            delivery = _EventDelivery(on_event, job['cancel'], deadline, self.callback_slots)
            def emit(event):
                delivery.emit({'requestId': request_id, **event})
            parser = StreamJSONAdapter(emit)
            state = self._status(job['cancel'])
            if not state['loggedIn'] or state['authMethod'] != 'claude.ai':
                raise BridgeError('subscription_login_required', '请先在本机官方 Claude Code CLI 完成 Claude 账号登录。')
            if job['cancel'].is_set():
                raise BridgeError('cancelled', '已停止 Claude Code 操作。')
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise BridgeError('timeout', 'Claude Code 操作超时，进程已停止。')
            code = self.runner.run(argv, cwd=self.cwd, env=self.env, stdin=prompt,
                                   cancel=job['cancel'], timeout=remaining, on_line=parser.line)
            if code:
                raise BridgeError('cli_failed', 'Claude Code 进程未成功退出。')
            result = parser.finish()
            emit(result)
            with self.lock:
                job['status'] = 'completed'
            return result
        except BridgeError as error:
            with self.lock:
                job.update(status='cancelled' if error.code == 'cancelled' else 'failed', code=error.code)
            # Errors contain fixed adapter messages, never the raw CLI payload.
            if delivery:
                delivery.terminal({'requestId': request_id, 'type': 'cancelled' if error.code == 'cancelled' else 'error',
                                   'code': error.code, 'message': str(error)})
            raise
        except Exception:
            with self.lock:
                job.update(status='failed', code='adapter_failed')
            raise BridgeError('adapter_failed', 'Claude Code 本地适配失败。') from None
        finally:
            if delivery:
                delivery.close()
            job['done'].set()
