"""Web search for the built-in ``websearch`` plugin (off by default).

Only the search terms leave the device. The user picks the search service in
Settings > Plugins > Web search; the choice and any service address are kept
with the on/off switch in plugins.json (device-local, never synced). A key, if
the service takes one, goes to the keychain (plugin_secrets.py); plugins.json
only records that one is set. Titles, links and short excerpts come back;
they are web material, not instructions.

Services: Keenable (the default: no key needed, an optional key only lifts the
keyless rate limits) and SearXNG (your own instance, by its address). To add
one, such as Brave or Tavily: subclass Backend with its id, name, whether it
needs an address (``endpoint``) or a key (``key``), ``request()`` and
``results()``; list it in BACKENDS here and in BACKENDS in plugin-websearch.js
(the labels on the settings page). Validation, limits, errors and the result
shape stay in ``search()``.
"""
import json, subprocess, urllib.error, urllib.parse, urllib.request
from plugin_secrets import default_secrets, SecretError

APP_TITLE = 'AI Bro'
TIMEOUT = 20
MAX_QUERY = 2000
MAX_RESULTS = 10
DEFAULT_RESULTS = 5
TITLE_CHARS = 200
EXCERPT_CHARS = 600
MAX_RESPONSE = 2_000_000
MAX_ENDPOINT = 500
MAX_KEY = 500


class WebSearchError(Exception):
    def __init__(self, message, status=502, code='websearch_failed'):
        super().__init__(message); self.status = status; self.code = code
    @property
    def payload(self): return {'error': str(self), 'code': self.code}


class Backend:
    """One search service.

    request(query, limit, endpoint, key) returns the urllib Request for one
    query; results(data) yields (title, url, text) from the decoded JSON
    answer. ``errors`` maps an HTTP status to (message, code) where the
    generic message would mislead.
    """
    id = name = ''
    endpoint = False  # True: the user gives the service address (self-hosted)
    key = 'none'      # 'none', 'optional' or 'required'
    errors = {}
    def request(self, query, limit, endpoint, key): raise NotImplementedError
    def results(self, data): raise NotImplementedError


class Keenable(Backend):
    id, name, key = 'keenable', 'Keenable', 'optional'
    PUBLIC = 'https://api.keenable.ai/v1/search/public'
    KEYED = 'https://api.keenable.ai/v1/search'

    def request(self, query, limit, endpoint, key):
        headers = {'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Keenable-Title': APP_TITLE}
        if key: headers['X-API-Key'] = key
        return urllib.request.Request(self.KEYED if key else self.PUBLIC, method='POST', headers=headers,
                                      data=json.dumps({'query': query, 'max_results': limit}).encode())

    def results(self, data):
        # The page text is in "snippet"; "description" is kept as a fallback.
        for item in data.get('results') or []:
            if isinstance(item, dict): yield item.get('title'), item.get('url'), item.get('snippet') or item.get('description')


class SearXNG(Backend):
    id, name, endpoint = 'searxng', 'SearXNG', True
    errors = {403: ('SearXNG 拒绝了 JSON 请求：请在它的 settings.yml 里把 json 加入 search.formats。', 'websearch_format'),
              429: ('SearXNG 拦下了这次请求（limiter）：自用实例可在 settings.yml 里关闭 limiter 或放行本机地址。', 'websearch_rate_limited')}

    def request(self, query, limit, endpoint, key):
        # The address may be the instance root or its /search page. SearXNG has
        # no result-count parameter; search() cuts the list to the limit.
        base = endpoint.rstrip('/')
        if not base.endswith('/search'): base += '/search'
        return urllib.request.Request(base + '?' + urllib.parse.urlencode({'q': query, 'format': 'json'}),
                                      headers={'Accept': 'application/json', 'User-Agent': APP_TITLE})

    def results(self, data):
        for item in data.get('results') or []:
            if isinstance(item, dict): yield item.get('title'), item.get('url'), item.get('content')


BACKENDS = {backend.id: backend for backend in (Keenable(), SearXNG())}
DEFAULT_BACKEND = 'keenable'
ERRORS = {401: ('{name} 不接受这个 Key，请在插件设置里更换或清除。', 'websearch_key'),
          429: ('网页搜索太频繁，请稍后再试。', 'websearch_rate_limited')}


def _text(value, limit):
    text = ' '.join(str(value or '').split())
    return text if len(text) <= limit else text[:limit - 1].rstrip() + '…'


def endpoint_of(value):
    """A service address: http(s), a host, an optional path; no account, query or fragment."""
    if not isinstance(value, str): return None
    value = value.strip()
    if not value or len(value) > MAX_ENDPOINT or any(ch.isspace() for ch in value): return None
    try: parts = urllib.parse.urlsplit(value); parts.port
    except ValueError: return None
    if parts.scheme not in ('http', 'https') or not parts.hostname or '@' in parts.netloc or parts.query or parts.fragment: return None
    return value.rstrip('/')


def search(query, limit=DEFAULT_RESULTS, backend=DEFAULT_BACKEND, endpoint=None, key='', opener=urllib.request.urlopen):
    """Return {'query', 'backend', 'results': [{'title', 'url', 'excerpt'}]} for one query."""
    if not isinstance(query, str) or not query.strip() or len(query) > MAX_QUERY:
        raise WebSearchError('搜索词不能为空，且不超过 2000 个字符。', 400, 'websearch_invalid')
    service = BACKENDS.get(backend)
    if service is None: raise WebSearchError('没有这个搜索服务。', 400, 'websearch_backend')
    if service.endpoint and not endpoint:
        raise WebSearchError(f'请先在 设置 → 插件 → 网页搜索 里填写 {service.name} 的地址。', 400, 'websearch_not_configured')
    if service.key == 'required' and not key:
        raise WebSearchError(f'请先在 设置 → 插件 → 网页搜索 里填写 {service.name} 的 Key。', 400, 'websearch_not_configured')
    query = query.strip()
    limit = limit if isinstance(limit, int) and not isinstance(limit, bool) else DEFAULT_RESULTS
    limit = max(1, min(MAX_RESULTS, limit))
    request = service.request(query, limit, endpoint, key or '')
    try:
        with opener(request, timeout=TIMEOUT) as response:
            data = json.loads(response.read(MAX_RESPONSE) or b'{}')
    except urllib.error.HTTPError as error:
        message, code = service.errors.get(error.code) or ERRORS.get(error.code) or (f'{{name}} 返回 HTTP {error.code}。', 'websearch_http')
        raise WebSearchError(message.format(name=service.name), 429 if code == 'websearch_rate_limited' else 502, code) from None
    except (urllib.error.URLError, OSError, ValueError):
        raise WebSearchError(f'无法连接 {service.name}，请检查网络或服务地址。', 502, 'websearch_unreachable') from None
    results = []
    for title, url, text in service.results(data if isinstance(data, dict) else {}):
        if not isinstance(url, str) or not url.startswith(('https://', 'http://')): continue
        results.append({'title': _text(title, TITLE_CHARS) or url, 'url': url, 'excerpt': _text(text, EXCERPT_CHARS)})
        if len(results) >= limit: break
    return {'query': query, 'backend': service.id, 'results': results}


def settings_entry(value):
    """plugins.json ``builtin.websearch``: off unless switched on; the service, the
    service addresses, and which services have a key in the keychain (never the key)."""
    known = lambda k: isinstance(k, str) and k in BACKENDS
    entry = {'enabled': value.get('enabled') is True}
    if known(value.get('backend')): entry['backend'] = value['backend']
    endpoints = value.get('endpoints') if isinstance(value.get('endpoints'), dict) else {}
    endpoints = {k: endpoint_of(v) for k, v in endpoints.items() if known(k) and BACKENDS[k].endpoint and endpoint_of(v)}
    if endpoints: entry['endpoints'] = endpoints
    keys = list(dict.fromkeys(k for k in value.get('keys') if known(k) and BACKENDS[k].key != 'none')) if isinstance(value.get('keys'), list) else []
    if keys: entry['keys'] = keys
    return entry


class WebSearch:
    """The plugin's settings and searches over the device-local plugin store."""
    def __init__(self, store, secrets=None, opener=urllib.request.urlopen):
        self.store, self._secrets, self.opener = store, secrets, opener

    @property
    def secrets(self):
        if self._secrets is None: self._secrets = default_secrets()
        return self._secrets

    def configure(self, payload):
        """Choose the service; optionally set its address, or its key ('' clears the key)."""
        backend = payload.get('backend')
        service = BACKENDS.get(backend) if isinstance(backend, str) else None
        if service is None: raise WebSearchError('没有这个搜索服务。', 400, 'websearch_backend')
        endpoint, key = payload.get('endpoint'), payload.get('key')
        if endpoint is not None:
            if not service.endpoint: raise WebSearchError(f'{service.name} 不需要服务地址。', 400, 'websearch_invalid')
            if endpoint != '' and endpoint_of(endpoint) is None:
                raise WebSearchError('服务地址无效：只接受 http/https 地址，不含账号、密码或查询参数。', 400, 'websearch_invalid')
        if key is not None:
            if service.key == 'none': raise WebSearchError(f'{service.name} 不使用 Key。', 400, 'websearch_invalid')
            if not isinstance(key, str) or len(key) > MAX_KEY or any(ch in key for ch in '\r\n\0'):
                raise WebSearchError('Key 格式无效。', 400, 'websearch_invalid')
        with self.store.lock():
            value = self.store.read(); entry = value['builtin'].setdefault('websearch', {'enabled': False})
            entry['backend'] = service.id
            if endpoint is not None:
                endpoints = entry.setdefault('endpoints', {})
                if endpoint: endpoints[service.id] = endpoint_of(endpoint)
                else: endpoints.pop(service.id, None)
                if not endpoints: entry.pop('endpoints')
            if key is not None:
                keys = [k for k in entry.get('keys', []) if k != service.id]
                try:
                    if key.strip(): self.secrets.set('websearch', service.id, key.strip()); keys.append(service.id)
                    else: self.secrets.delete('websearch', service.id)
                except (SecretError, OSError, subprocess.SubprocessError):
                    raise WebSearchError('无法写入钥匙串。', 500, 'websearch_secret_store') from None
                if keys: entry['keys'] = keys
                else: entry.pop('keys', None)
            self.store.write(value); return value

    def search(self, query, limit=None):
        entry = self.store.read()['builtin'].get('websearch', {})
        if entry.get('enabled') is not True: raise WebSearchError('网页搜索插件未开启。', 403, 'plugin_disabled')
        backend = entry.get('backend') or DEFAULT_BACKEND
        key = ''
        # The keychain is read only when the user saved a key for this service.
        if backend in entry.get('keys', []):
            try: key = self.secrets.get('websearch', backend) or ''
            except (OSError, subprocess.SubprocessError): key = ''
        return search(query, limit, backend, (entry.get('endpoints') or {}).get(backend), key, self.opener)
