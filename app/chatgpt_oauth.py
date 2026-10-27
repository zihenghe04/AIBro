"""AI Bro's own ChatGPT account sign-in (OAuth), independent of any local Codex login.

Two ways to sign in, both ending in the same token set:
  * browser: PKCE authorization code with a loopback callback on localhost:1455;
  * device code: used automatically when port 1455 is taken (Codex CLI or another tool is signing in).

Only the refresh token and a few non-secret identity fields are persisted, in the macOS keychain
(``plugin_secrets.KeychainSecrets``). Access and id tokens live in memory. Tokens are never logged,
never put in events, and upstream response bodies are never echoed into errors.

The protocol constants and the overall flow follow CC Switch's Codex OAuth module.

Portions adapted from CC Switch (https://github.com/farion1231/cc-switch), MIT License,
Copyright (c) 2025 Jason Young. See docs/THIRD_PARTY.md.
"""
import base64
import hashlib
import http.client
import json
import secrets
import socket
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
AUTH_ORIGIN = 'https://auth.openai.com'
API_ORIGIN = 'https://chatgpt.com'
CALLBACK_PORT = 1455
DEVICE_VERIFICATION_URL = AUTH_ORIGIN + '/codex/device'
DEVICE_REDIRECT_URI = AUTH_ORIGIN + '/deviceauth/callback'
SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke'
ORIGINATOR = 'codex_cli_rs'
CLIENT_VERSION = '0.159.0'
USER_AGENT = 'ai-bro-chatgpt-oauth'
MAX_BODY = 64 * 1024
HTTP_TIMEOUT = 30
REFRESH_MARGIN = 60
LOGIN_LIFETIME = 900
DEFAULT_ACCOUNT = 'default'
REAUTH_CODES = {'refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated', 'invalid_grant'}


class OAuthError(Exception):
    """Carries a stable code and a fixed, safe message; never upstream text."""
    MESSAGES = {
        'not_logged_in': '请先登录 ChatGPT 账号。',
        'needs_reauth': 'ChatGPT 登录已失效，请重新登录。',
        'logged_out': '已退出登录。',
        'network': '无法连接 ChatGPT 登录服务，请检查网络后重试。',
        'upstream': 'ChatGPT 登录服务返回了无法识别的响应，请稍后重试。',
        'denied': '授权被拒绝或已取消，请重试。',
        'expired': '登录已超时，请重新登录。',
        'origin': '登录地址未通过验证，已拒绝请求。',
        'storage': '无法把登录信息保存到钥匙串。',
        'no_account': '登录结果里没有 ChatGPT 账号信息，请换一个账号重试。',
    }

    def __init__(self, code, message=None, status=503):
        super().__init__(message or self.MESSAGES.get(code, 'ChatGPT 登录失败。'))
        self.code, self.status = code, status


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def pkce_pair():
    verifier = b64url(secrets.token_bytes(64))
    return verifier, b64url(hashlib.sha256(verifier.encode()).digest())


def jwt_claims(token):
    """Unverified payload of a JWT (identity hints only; the server validates the token)."""
    try:
        payload = token.split('.')[1]
        value = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
        return value if isinstance(value, dict) else {}
    except (AttributeError, IndexError, ValueError):
        return {}


def identity(tokens):
    """(chatgpt account id, email, plan) from the id token, falling back to the access token."""
    account, email, plan = None, None, None
    for key in ('id_token', 'access_token'):
        claims = jwt_claims(tokens.get(key) or '')
        auth = claims.get('https://api.openai.com/auth')
        auth = auth if isinstance(auth, dict) else {}
        account = account or claims.get('chatgpt_account_id') or auth.get('chatgpt_account_id')
        plan = plan or auth.get('chatgpt_plan_type')
        profile = claims.get('https://api.openai.com/profile')
        email = email or claims.get('email') or (profile.get('email') if isinstance(profile, dict) else None)
    clean = lambda v: v if isinstance(v, str) and 0 < len(v) <= 320 else None
    return clean(account), clean(email), clean(plan)


def authorize_url(challenge, state, redirect_uri, origin=AUTH_ORIGIN):
    query = urllib.parse.urlencode([
        ('response_type', 'code'), ('client_id', CLIENT_ID), ('redirect_uri', redirect_uri), ('scope', SCOPE),
        ('code_challenge', challenge), ('code_challenge_method', 'S256'), ('state', state),
        ('id_token_add_organizations', 'true'), ('codex_cli_simplified_flow', 'true'), ('originator', ORIGINATOR)])
    return origin + '/oauth/authorize?' + query


def parse_callback(query, expected_state):
    """('code', value) | ('denied', None) | None for anything malformed, duplicated or with another state."""
    pairs = urllib.parse.parse_qsl(query or '', keep_blank_values=True)
    values = {}
    for key, value in pairs:
        if key in values: return None
        values[key] = value
    if not secrets.compare_digest(values.get('state', ''), expected_state): return None
    if values.get('code') and 'error' not in values: return ('code', values['code'])
    if 'error' in values and 'code' not in values: return ('denied', None)
    return None


def check_origin(url, origin):
    """The URL must be exactly on the expected origin: no userinfo, no other host, scheme or port."""
    parts = urllib.parse.urlsplit(url)
    expected = urllib.parse.urlsplit(origin)
    if parts.scheme != expected.scheme or parts.netloc != expected.netloc or parts.username or parts.password:
        raise OAuthError('origin')
    return parts


def http_call(url, origin, method='GET', headers=None, body=None, timeout=HTTP_TIMEOUT, limit=MAX_BODY, stream=False):
    """One request, no redirects, origin pinned. Returns (status, bytes) or (status, open response, connection) when streaming."""
    parts = check_origin(url, origin)
    cls = http.client.HTTPSConnection if parts.scheme == 'https' else http.client.HTTPConnection
    connection = cls(parts.hostname, parts.port, timeout=timeout)
    try:
        connection.request(method, parts.path + ('?' + parts.query if parts.query else ''), body=body, headers=headers or {})
        response = connection.getresponse()
        if stream and 200 <= response.status < 300:
            return response.status, response, connection
        data = response.read(limit + 1)
        if len(data) > limit: raise OAuthError('upstream')
        return response.status, data
    except (OSError, http.client.HTTPException):
        connection.close()
        raise OAuthError('network')
    except OAuthError:
        connection.close()
        raise


def json_body(data):
    try:
        value = json.loads(data.decode('utf-8'))
    except (ValueError, UnicodeDecodeError):
        raise OAuthError('upstream')
    if not isinstance(value, dict): raise OAuthError('upstream')
    return value


class MemoryVault:
    """Test double and non-macOS fallback (nothing persists)."""
    def __init__(self): self.value = None
    def load(self): return self.value
    def save(self, record): self.value = dict(record)
    def delete(self): self.value = None


class KeychainVault:
    """One small JSON record in the keychain. ``account`` separates data directories."""
    SERVICE = 'app.ai-workstation.studio.chatgpt-oauth'

    def __init__(self, account=DEFAULT_ACCOUNT, secrets_store=None):
        from plugin_secrets import KeychainSecrets, SecretError
        self.account, self.error = account, SecretError
        self.store = secrets_store or KeychainSecrets(self.SERVICE)

    def load(self):
        raw = self.store.get(self.account, 'tokens')
        try:
            value = json.loads(raw) if raw else None
        except ValueError:
            return None
        return value if isinstance(value, dict) and isinstance(value.get('refresh_token'), str) else None

    def save(self, record):
        try: self.store.set(self.account, 'tokens', json.dumps(record, separators=(',', ':')))
        except self.error: raise OAuthError('storage')

    def delete(self):
        self.store.delete(self.account, 'tokens')


def default_vault(data_directory=None):
    import sys
    if sys.platform != 'darwin': return MemoryVault()
    account = hashlib.sha256(str(data_directory).encode()).hexdigest()[:16] if data_directory else DEFAULT_ACCOUNT
    return KeychainVault(account)


class _Flow:
    def __init__(self, method, epoch):
        self.id = secrets.token_urlsafe(12)
        self.method, self.epoch = method, epoch
        self.started = time.monotonic()
        self.status, self.error = 'pending', None
        self.cancelled = threading.Event()
        self.server = None
        self.verifier = self.state = self.url = None
        self.user_code = self.device_auth_id = None
        self.interval = 5
        self.code = self.redirect = None


class _Server(HTTPServer):
    # Strict: never share 1455 with another listener, so a busy port is detected and we fall back to the device code.
    allow_reuse_address = False


class ChatGPTOAuth:
    def __init__(self, vault, auth_origin=AUTH_ORIGIN, api_origin=API_ORIGIN, callback_port=CALLBACK_PORT, clock=time.time, poll_floor=3, min_interval=1):
        self.vault, self.auth_origin, self.api_origin = vault, auth_origin, api_origin
        self.callback_port, self.clock, self.poll_floor, self.min_interval = callback_port, clock, poll_floor, min_interval
        self._lock = threading.RLock()
        self._refresh_lock = threading.Lock()
        self._epoch = 0
        self._record = None
        self._loaded = False
        self._access = self._id_token = None
        self._expires = 0.0
        self._flow = None

    # state -------------------------------------------------------------
    def _load(self):
        with self._lock:
            if not self._loaded:
                try: self._record = self.vault.load()
                except Exception: self._record = None
                self._loaded = True
            return self._record

    def status(self):
        record = self._load()
        with self._lock:
            flow = self._flow
            if flow and flow.status == 'pending' and time.monotonic() - flow.started > LOGIN_LIFETIME:
                self._finish(flow, 'error', 'expired')
            login = {'pending': bool(flow and flow.status == 'pending'), 'loginId': flow.id if flow else None,
                     'error': OAuthError.MESSAGES.get(flow.error, flow.error) if flow and flow.error else None,
                     'method': flow.method if flow else None}
            if flow and flow.status == 'pending':
                login.update({'authUrl': flow.url, 'userCode': flow.user_code, 'verificationUrl': DEVICE_VERIFICATION_URL if flow.method == 'device' else None})
            authenticated = bool(record) and not record.get('needs_reauth')
            return {'available': True, 'authenticated': authenticated, 'needsReauth': bool(record and record.get('needs_reauth')),
                    'account': {'email': record.get('email'), 'planType': record.get('plan')} if record else None,
                    'login': login, 'runtime': 'chatgpt-oauth'}

    def account_id(self):
        record = self._load()
        return record.get('account_id') if record else None

    # sign-in -------------------------------------------------------------
    def login_start(self, prefer='browser'):
        with self._lock:
            self._cancel_locked()
            self._epoch += 1
            flow = _Flow('browser', self._epoch)
            self._flow = flow
            fallback = False
            if prefer != 'device':
                try: self._start_browser(flow)
                except OSError: fallback = True
            if flow.url is None:
                flow.method = 'device'
                try:
                    self._start_device(flow)
                except OAuthError:
                    self._flow = None
                    raise
            result = {'loginId': flow.id, 'method': flow.method, 'fallback': fallback}
            if flow.method == 'browser': result['authUrl'] = flow.url
            else:
                result.update({'userCode': flow.user_code, 'verificationUrl': DEVICE_VERIFICATION_URL})
                if fallback: result['note'] = '本机 1455 端口正被其他程序占用（可能是 Codex CLI 或 CC Switch 正在登录），已改用设备码登录。'
            return result

    def _start_browser(self, flow):
        flow.verifier, challenge = pkce_pair()
        flow.state = b64url(secrets.token_bytes(32))
        oauth = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.0'
            def log_message(self, *args): pass
            def _reply(self, status, text):
                body = text.encode()
                self.send_response(status)
                self.send_header('Content-Type', 'text/plain; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Referrer-Policy', 'no-referrer')
                self.end_headers(); self.wfile.write(body)
            def do_GET(self):
                parts = urllib.parse.urlsplit(self.path)
                if parts.path != '/auth/callback': return self._reply(404, 'Not found')
                result = parse_callback(parts.query, flow.state)
                if result is None: return self._reply(400, 'Invalid login callback. Return to AI Bro and try again.')
                with oauth._lock:
                    if flow.code is not None or flow.status != 'pending': return self._reply(409, 'This login callback has already been received.')
                    flow.code = result[0]
                if result[0] == 'denied':
                    oauth._finish(flow, 'error', 'denied')
                    return self._reply(200, 'Authorization was denied. Return to AI Bro to try again.')
                code = result[1]
                threading.Thread(target=oauth._exchange_browser, args=(flow, code), daemon=True).start()
                self._reply(200, 'Authorization received. Return to AI Bro to finish signing in.')

        server = _Server(('127.0.0.1', self.callback_port), Handler)
        server.timeout = 0.5
        flow.server = server
        redirect = f'http://localhost:{server.server_address[1]}/auth/callback'
        flow.redirect = redirect
        flow.url = authorize_url(challenge, flow.state, redirect, self.auth_origin)
        threading.Thread(target=self._serve, args=(flow,), daemon=True).start()

    def _serve(self, flow):
        server = flow.server
        try:
            while flow.status == 'pending' and flow.code is None and not flow.cancelled.is_set() and time.monotonic() - flow.started < LOGIN_LIFETIME:
                server.handle_request()
        except (OSError, ValueError):
            pass  # the socket was closed by a cancel
        finally:
            try: server.server_close()
            except OSError: pass
            if flow.status == 'pending' and flow.code is None and not flow.cancelled.is_set():
                self._finish(flow, 'error', 'expired')

    def _exchange_browser(self, flow, code):
        try:
            tokens = self._token_request({'grant_type': 'authorization_code', 'code': code, 'redirect_uri': flow.redirect,
                                          'client_id': CLIENT_ID, 'code_verifier': flow.verifier})
            self._commit(flow, tokens)
        except OAuthError as error:
            self._finish(flow, 'error', error.code)

    def _start_device(self, flow):
        status, data = http_call(self.auth_origin + '/api/accounts/deviceauth/usercode', self.auth_origin, 'POST',
                                 {'Content-Type': 'application/json', 'User-Agent': USER_AGENT}, json.dumps({'client_id': CLIENT_ID}).encode())
        if not 200 <= status < 300: raise OAuthError('upstream')
        body = json_body(data)
        device_id, user_code = body.get('device_auth_id'), body.get('user_code')
        if not isinstance(device_id, str) or not isinstance(user_code, str) or not user_code.strip() or len(user_code) > 64 or len(device_id) > 512:
            raise OAuthError('upstream')
        interval = body.get('interval')
        try: interval = int(interval)
        except (TypeError, ValueError): interval = 5
        flow.device_auth_id, flow.user_code = device_id, user_code
        flow.interval = min(max(interval, self.min_interval), 30)
        flow.url = DEVICE_VERIFICATION_URL
        threading.Thread(target=self._poll_device, args=(flow,), daemon=True).start()

    def _poll_device(self, flow):
        try:
            while not flow.cancelled.wait(flow.interval + self.poll_floor):
                if time.monotonic() - flow.started > LOGIN_LIFETIME: raise OAuthError('expired')
                if flow.status != 'pending': return
                status, data = http_call(self.auth_origin + '/api/accounts/deviceauth/token', self.auth_origin, 'POST',
                                         {'Content-Type': 'application/json', 'User-Agent': USER_AGENT},
                                         json.dumps({'device_auth_id': flow.device_auth_id, 'user_code': flow.user_code}).encode())
                if status in (403, 404): continue
                if status == 410: raise OAuthError('expired')
                if not 200 <= status < 300: raise OAuthError('upstream')
                body = json_body(data)
                code, verifier = body.get('authorization_code'), body.get('code_verifier')
                if not isinstance(code, str) or not isinstance(verifier, str): raise OAuthError('upstream')
                tokens = self._token_request({'grant_type': 'authorization_code', 'code': code, 'redirect_uri': DEVICE_REDIRECT_URI,
                                              'client_id': CLIENT_ID, 'code_verifier': verifier})
                self._commit(flow, tokens)
                return
        except OAuthError as error:
            self._finish(flow, 'error', error.code)

    def _finish(self, flow, status, error=None):
        with self._lock:
            if flow.status == 'pending':
                flow.status, flow.error = status, error
            flow.cancelled.set()

    def _commit(self, flow, tokens):
        account_id, email, plan = identity(tokens)
        if not account_id: raise OAuthError('no_account')
        refresh = tokens.get('refresh_token')
        if not isinstance(refresh, str) or not refresh.strip(): raise OAuthError('upstream')
        with self._lock:
            # A cancelled, replaced or signed-out flow must never bring an account back.
            if flow.status != 'pending' or flow.epoch != self._epoch or self._flow is not flow:
                return
            record = {'refresh_token': refresh, 'account_id': account_id, 'email': email, 'plan': plan, 'updated': int(self.clock())}
            self.vault.save(record)
            self._record, self._loaded = record, True
            self._set_access(tokens)
            self._finish(flow, 'done')

    def cancel_login(self):
        with self._lock:
            self._cancel_locked()
            self._epoch += 1
        return {'ok': True}

    def _cancel_locked(self):
        flow = self._flow
        if flow:
            if flow.status == 'pending': flow.status, flow.error = 'cancelled', None
            flow.cancelled.set()
            if flow.server is not None:
                try: flow.server.server_close()
                except OSError: pass
        self._flow = None

    def logout(self):
        with self._lock:
            self._cancel_locked()
            self._epoch += 1
            self._record, self._loaded = None, True
            self._access = self._id_token = None
            self._expires = 0.0
            self.vault.delete()
        return {'ok': True}

    # tokens --------------------------------------------------------------
    def _token_request(self, form):
        status, data = http_call(self.auth_origin + '/oauth/token', self.auth_origin, 'POST',
                                 {'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT, 'Accept': 'application/json'},
                                 urllib.parse.urlencode(form).encode())
        if not 200 <= status < 300:
            code = None
            try:
                body = json_body(data)
                code = body.get('error') if isinstance(body.get('error'), str) else (body.get('error') or {}).get('code') if isinstance(body.get('error'), dict) else body.get('code')
            except OAuthError: pass
            if form.get('grant_type') == 'refresh_token' and (status in (401, 403) or code in REAUTH_CODES or (status == 400 and code == 'invalid_grant')):
                raise OAuthError('needs_reauth', status=401)
            raise OAuthError('upstream')
        body = json_body(data)
        if not isinstance(body.get('access_token'), str) or not body['access_token']: raise OAuthError('upstream')
        return body

    def _set_access(self, tokens):
        try: lifetime = float(tokens.get('expires_in') or 3600)
        except (TypeError, ValueError): lifetime = 3600.0
        self._access, self._id_token = tokens['access_token'], tokens.get('id_token')
        self._expires = self.clock() + max(lifetime, 0)

    def _fresh(self):
        return self._access is not None and self._expires - self.clock() > REFRESH_MARGIN

    def access(self, force=False):
        """(access token, ChatGPT account id), refreshing once when needed. Concurrent callers share one refresh."""
        record = self._load()
        if not record: raise OAuthError('not_logged_in', status=401)
        if record.get('needs_reauth'): raise OAuthError('needs_reauth', status=401)
        with self._lock:
            if not force and self._fresh(): return self._access, record['account_id']
            seen = self._access
        with self._refresh_lock:
            with self._lock:
                record, epoch = self._record, self._epoch
                if not record: raise OAuthError('not_logged_in', status=401)
                if record.get('needs_reauth'): raise OAuthError('needs_reauth', status=401)
                if self._fresh() and (not force or self._access != seen): return self._access, record['account_id']
                refresh = record['refresh_token']
            try:
                tokens = self._token_request({'grant_type': 'refresh_token', 'refresh_token': refresh, 'client_id': CLIENT_ID, 'scope': 'openid profile email'})
            except OAuthError as error:
                if error.code == 'needs_reauth':
                    with self._lock:
                        if epoch == self._epoch and self._record is record:
                            marked = dict(record, needs_reauth=True)
                            try: self.vault.save(marked)
                            except OAuthError: pass
                            self._record, self._access, self._expires = marked, None, 0.0
                raise
            with self._lock:
                if epoch != self._epoch or self._record is None:
                    raise OAuthError('logged_out', status=401)
                new_refresh = tokens.get('refresh_token')
                updated = dict(self._record)
                if isinstance(new_refresh, str) and new_refresh.strip(): updated['refresh_token'] = new_refresh
                fresh_id, fresh_email, fresh_plan = identity(tokens)
                if fresh_email: updated['email'] = fresh_email
                if fresh_plan: updated['plan'] = fresh_plan
                if fresh_id and fresh_id != updated['account_id']:
                    updated['account_id'] = fresh_id
                updated['updated'] = int(self.clock())
                self.vault.save(updated)
                self._record = updated
                self._set_access(tokens)
                return self._access, updated['account_id']
