"""Opt-in local client interface: loopback plus a random bearer token, four operations only
(status, models, ask, cancel). Nothing here reads or returns an API key; asking is served by the
Codex CLI runtime the app already manages. Off until the user switches it on in settings."""
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import threading
import urllib.parse

PREFIX = '/__client/'
MAX_BODY = 256 * 1024
MAX_PROMPT = 100000
REQUEST_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}')


class ClientApiError(Exception):
    def __init__(self, status, code, message):
        self.status, self.code = status, code
        super().__init__(message)


class LocalClientApi:
    def __init__(self, data_dir, detect, models, bridge, port_of=None):
        self.dir = Path(data_dir)
        self.marker = self.dir / 'client-api.enabled'
        self.info = self.dir / 'client-api.json'
        self.detect, self.models, self.bridge = detect, models, bridge
        self.lock = threading.Lock()
        self.active = {}

    # ---- enable / token ----
    def enabled(self):
        return self.marker.is_file() and not self.marker.is_symlink()

    def _write(self, path, data):
        self.dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = path.with_name(path.name + '.tmp')
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, 'wb') as handle: handle.write(data)
        os.replace(temporary, path)

    def token(self):
        try:
            if self.info.is_symlink(): raise ClientApiError(500, 'unsafe_store', '接口文件不能是符号链接')
            value = json.loads(self.info.read_text()).get('token', '')
            if re.fullmatch(r'[0-9a-f]{64}', value): return value
        except (FileNotFoundError, ValueError, AttributeError): pass
        return None

    def set_enabled(self, enabled, port):
        if enabled:
            token = self.token() or secrets.token_hex(32)
            self._write(self.info, json.dumps({'port': port, 'token': token}).encode())
            self._write(self.marker, b'1')
        else:
            for path in (self.marker, self.info):
                try: path.unlink()
                except FileNotFoundError: pass
            self.cancel_all()
        return self.admin_view(port)

    def rotate(self, port):
        if not self.enabled(): raise ClientApiError(409, 'disabled', '本机客户端接口未开启')
        self._write(self.info, json.dumps({'port': port, 'token': secrets.token_hex(32)}).encode())
        self.cancel_all()
        return self.admin_view(port)

    def admin_view(self, port):
        return {'enabled': self.enabled(), 'host': '127.0.0.1', 'port': port, 'infoFile': str(self.info) if self.enabled() else '',
                'operations': ['status', 'models', 'ask', 'cancel']}

    def cancel_all(self):
        with self.lock:
            for event in self.active.values(): event.set()

    # ---- operations ----
    def status(self):
        detected = self.detect('shared')
        return {'connections': [{'id': 'codex-cli', 'kind': 'codex-cli', 'installed': detected.get('installed', False), 'version': detected.get('version'), 'loggedIn': detected.get('loggedIn', False)}]}

    def model_list(self):
        listing = self.models('shared')
        return {'connection': 'codex-cli', 'cliVersion': listing.get('cliVersion'), 'data': [
            {'model': entry.get('model') or entry.get('id'), 'label': entry.get('displayName') or entry.get('model'), 'efforts': [o.get('reasoningEffort') if isinstance(o, dict) else o for o in entry.get('supportedReasoningEfforts', [])]}
            for entry in listing.get('data', []) if isinstance(entry, dict)]}

    def ask(self, payload):
        if not isinstance(payload, dict) or set(payload) - {'requestId', 'prompt', 'model', 'effort', 'connection'}:
            raise ClientApiError(400, 'invalid_request', '请求格式无效')
        if payload.get('connection', 'codex-cli') != 'codex-cli':
            raise ClientApiError(400, 'unsupported_connection', '本机客户端接口目前只能使用 Codex CLI 连接')
        request_id, prompt = payload.get('requestId'), payload.get('prompt')
        if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id): raise ClientApiError(400, 'invalid_request_id', 'requestId 无效')
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > MAX_PROMPT: raise ClientApiError(400, 'invalid_prompt', 'prompt 无效或过长')
        bridge = self.bridge('shared')
        model, inputs, effort = bridge.prepare({'input': [{'role': 'user', 'content': [{'type': 'input_text', 'text': prompt}]}], 'model': payload.get('model'), 'effort': payload.get('effort')})
        event = threading.Event()
        with self.lock:
            if request_id in self.active: raise ClientApiError(409, 'duplicate_request', 'requestId 正在使用')
            self.active[request_id] = event
        text, stream = [], None
        try:
            stream = bridge.respond(model, inputs, effort)
            for item in stream:
                if event.is_set(): break
                if isinstance(item, dict) and item.get('type') == 'response.output_text.delta' and isinstance(item.get('delta'), str): text.append(item['delta'])
        finally:
            if stream is not None: stream.close()
            with self.lock: self.active.pop(request_id, None)
        return {'requestId': request_id, 'cancelled': event.is_set(), 'text': ''.join(text)}

    def cancel(self, payload):
        request_id = payload.get('requestId') if isinstance(payload, dict) else None
        if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id): raise ClientApiError(400, 'invalid_request_id', 'requestId 无效')
        with self.lock: event = self.active.get(request_id)
        if event: event.set()
        return {'requestId': request_id, 'cancelled': bool(event)}


def _loopback_host(handler):
    try:
        if not ipaddress.ip_address(handler.client_address[0]).is_loopback: return False
        port = handler.server.server_port
        return handler.headers.get('Host') in {f'127.0.0.1:{port}', f'localhost:{port}', f'[::1]:{port}'}
    except (ValueError, AttributeError, TypeError): return False


def _body(handler):
    try: length = int(handler.headers.get('Content-Length', '0'))
    except ValueError: raise ClientApiError(400, 'invalid_request', '请求格式无效')
    if length < 0 or length > MAX_BODY: raise ClientApiError(413, 'too_large', '请求过大')
    try: return json.loads(handler.rfile.read(length) or b'{}')
    except ValueError: raise ClientApiError(400, 'invalid_request', '请求格式无效')


def handle_request(handler, api):
    """True when the path belongs to this interface. Tokens never appear in responses."""
    path = urllib.parse.urlsplit(handler.path).path
    if not path.startswith(PREFIX): return False
    port = handler.server.server_port
    try:
        if not _loopback_host(handler): raise ClientApiError(403, 'loopback_only', '只接受本机请求')
        if path.startswith(PREFIX + 'admin'):
            # Settings page only: same-origin window, never a bearer client.
            origin = handler.headers.get('Origin')
            same = handler.headers.get('Sec-Fetch-Site') == 'same-origin' or origin in {f'http://127.0.0.1:{port}', f'http://localhost:{port}'}
            if handler.headers.get('Authorization') or not same or handler.headers.get('Sec-Fetch-Site') in ('cross-site', 'same-site'):
                raise ClientApiError(403, 'window_only', '只有设置页可以管理本机客户端接口')
            if handler.command == 'GET' and path == PREFIX + 'admin': handler.send_json(api.admin_view(port)); return True
            if handler.command == 'POST' and path == PREFIX + 'admin':
                body = _body(handler)
                if not isinstance(body, dict) or not isinstance(body.get('enabled'), bool) or set(body) - {'enabled'}: raise ClientApiError(400, 'invalid_request', '请求格式无效')
                handler.send_json(api.set_enabled(body['enabled'], port)); return True
            if handler.command == 'POST' and path == PREFIX + 'admin/rotate': handler.send_json(api.rotate(port)); return True
            raise ClientApiError(404, 'not_found', '找不到接口')
        if not api.enabled(): raise ClientApiError(403, 'disabled', '本机客户端接口未开启')
        bearer, token = handler.headers.get('Authorization', ''), api.token()
        if not token or not bearer.startswith('Bearer ') or not hmac.compare_digest(bearer[7:].strip(), token):
            raise ClientApiError(401, 'token_required', 'token 无效')
        routes = {'v1/status': 'GET', 'v1/models': 'GET', 'v1/ask': 'POST', 'v1/cancel': 'POST'}
        name = path[len(PREFIX):]
        if name not in routes: raise ClientApiError(404, 'not_found', '找不到接口')
        if handler.command != routes[name]: raise ClientApiError(405, 'invalid_method', '请求方法无效')
        if name == 'v1/status': result = api.status()
        elif name == 'v1/models': result = api.model_list()
        elif name == 'v1/ask': result = api.ask(_body(handler))
        else: result = api.cancel(_body(handler))
        handler.send_json(result)
    except ClientApiError as error:
        handler.send_json({'error': {'code': error.code, 'message': str(error)}}, error.status)
    except Exception as error:
        code = getattr(error, 'code', 'unavailable')
        handler.send_json({'error': {'code': code if isinstance(code, str) else 'unavailable', 'message': str(error)[:200] if getattr(error, 'status', None) else '模型运行时暂时不可用'}}, getattr(error, 'status', 503) if isinstance(getattr(error, 'status', None), int) else 503)
    return True
