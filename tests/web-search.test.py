import io, json, os, tempfile, threading, unittest, urllib.error, urllib.parse, urllib.request
from pathlib import Path
from unittest import mock

host = tempfile.TemporaryDirectory(prefix='aibro-websearch-host-'); os.environ.setdefault('AI_WORKSTATION_DATA_DIR', host.name)
import web_search
from plugin_secrets import MemorySecrets
from plugin_store import PluginStore


class FakeOpener:
    """Records the outgoing request and answers with a canned body or error."""
    def __init__(self, body=None, error=None):
        self.body, self.error, self.requests = body, error, []
    def __call__(self, request, timeout=None):
        self.requests.append((request, timeout))
        if self.error: raise self.error
        return io.BytesIO(json.dumps(self.body).encode())
    @property
    def last(self):
        request = self.requests[-1][0]
        return request.get_method(), request.full_url, {k.lower(): v for k, v in request.header_items()}, json.loads(request.data) if request.data else None


def http_error(status):
    return urllib.error.HTTPError('https://search.example', status, 'error', {}, io.BytesIO(b''))


class BackendInterfaceTests(unittest.TestCase):
    def test_a_backend_added_the_documented_way_runs_through_search(self):
        class Echo(web_search.Backend):
            id, name, key = 'echo', 'Echo', 'required'
            def request(self, query, limit, endpoint, key):
                return urllib.request.Request('https://echo.example/s?' + urllib.parse.urlencode({'q': query, 'n': limit}), headers={'Authorization': 'Bearer ' + key})
            def results(self, data):
                for item in data['hits']: yield item['name'], item['link'], item['text']
        opener = FakeOpener({'hits': [{'name': 'E', 'link': 'https://e.example/1', 'text': 'body'}, {'name': 'F', 'link': 'https://e.example/2', 'text': 'more'}]})
        with mock.patch.dict(web_search.BACKENDS, {'echo': Echo()}):
            with self.assertRaises(web_search.WebSearchError) as missing: web_search.search('q', backend='echo', opener=opener)
            self.assertEqual((missing.exception.status, missing.exception.code), (400, 'websearch_not_configured'))
            value = web_search.search('q', 1, backend='echo', key='k1', opener=opener)
        self.assertEqual(opener.last[1:3], ('https://echo.example/s?q=q&n=1', {'authorization': 'Bearer k1'}))
        self.assertEqual(value, {'query': 'q', 'backend': 'echo', 'results': [{'title': 'E', 'url': 'https://e.example/1', 'excerpt': 'body'}]})
        with self.assertRaises(web_search.WebSearchError) as unknown: web_search.search('q', backend='nope', opener=opener)
        self.assertEqual((unknown.exception.status, unknown.exception.code), (400, 'websearch_backend'))

    def test_the_two_services(self):
        self.assertEqual(list(web_search.BACKENDS), ['keenable', 'searxng'])
        self.assertEqual(web_search.DEFAULT_BACKEND, 'keenable')
        keenable, searxng = web_search.BACKENDS['keenable'], web_search.BACKENDS['searxng']
        self.assertEqual((keenable.endpoint, keenable.key), (False, 'optional'))
        self.assertEqual((searxng.endpoint, searxng.key), (True, 'none'))


class KeenableTests(unittest.TestCase):
    def test_keyless_request_sends_only_the_query_with_the_app_label(self):
        opener = FakeOpener({'results': [
            {'title': 'A', 'url': 'https://a.example/x', 'description': '', 'snippet': 'line one\n\nline two'},
            {'title': '', 'url': 'https://b.example/', 'description': '', 'snippet': 'x' * 5000},
            {'title': 'bad', 'url': 'javascript:alert(1)', 'snippet': 'dropped'},
        ]})
        value = web_search.search('  长上下文 benchmark  ', 3, opener=opener)
        method, url, headers, body = opener.last
        self.assertEqual((method, url), ('POST', 'https://api.keenable.ai/v1/search/public'))
        self.assertEqual(headers['x-keenable-title'], 'AI Bro')
        self.assertNotIn('x-api-key', headers)
        self.assertEqual(body, {'query': '长上下文 benchmark', 'max_results': 3})
        self.assertEqual(opener.requests[-1][1], web_search.TIMEOUT)
        self.assertEqual((value['query'], value['backend']), ('长上下文 benchmark', 'keenable'))
        self.assertEqual([r['url'] for r in value['results']], ['https://a.example/x', 'https://b.example/'])
        self.assertEqual(value['results'][0], {'title': 'A', 'url': 'https://a.example/x', 'excerpt': 'line one line two'})
        self.assertEqual(value['results'][1]['title'], 'https://b.example/')
        self.assertEqual(len(value['results'][1]['excerpt']), web_search.EXCERPT_CHARS)

    def test_optional_key_uses_the_keyed_endpoint(self):
        opener = FakeOpener({'results': []})
        web_search.search('q', backend='keenable', key='unit-test-key', opener=opener)
        method, url, headers, body = opener.last
        self.assertEqual((url, headers['x-api-key'], body), ('https://api.keenable.ai/v1/search', 'unit-test-key', {'query': 'q', 'max_results': 5}))

    def test_limits_and_errors(self):
        opener = FakeOpener({'results': []})
        for limit, expected in ((0, 1), (50, 10), (True, 5), ('3', 5), (None, 5)):
            web_search.search('q', limit, opener=opener)
            self.assertEqual(opener.last[3]['max_results'], expected, limit)
        for query in ('', '   ', None, 'x' * 2001):
            with self.assertRaises(web_search.WebSearchError) as invalid: web_search.search(query, opener=opener)
            self.assertEqual(invalid.exception.status, 400)
        for status, expected in ((429, (429, 'websearch_rate_limited')), (401, (502, 'websearch_key')), (500, (502, 'websearch_http'))):
            with self.assertRaises(web_search.WebSearchError) as failed: web_search.search('q', opener=FakeOpener(error=http_error(status)))
            self.assertEqual((failed.exception.status, failed.exception.code), expected, status)
        self.assertIn('Keenable', str(failed.exception))
        with self.assertRaises(web_search.WebSearchError) as offline: web_search.search('q', opener=FakeOpener(error=urllib.error.URLError('down')))
        self.assertEqual((offline.exception.status, offline.exception.code), (502, 'websearch_unreachable'))
        self.assertEqual(web_search.search('q', opener=FakeOpener(['not', 'a', 'dict']))['results'], [])


class SearxngTests(unittest.TestCase):
    def test_get_with_only_the_query_and_json_format(self):
        opener = FakeOpener({'query': 'q', 'results': [
            {'title': 'S1', 'url': 'https://s.example/1', 'content': 'first\nresult', 'engine': 'x'},
            {'title': 'S2', 'url': 'https://s.example/2', 'content': ''},
            {'title': 'S3', 'url': 'https://s.example/3', 'content': 'third'},
        ], 'infoboxes': [], 'suggestions': []})
        value = web_search.search('rust async 运行时', 2, backend='searxng', endpoint='http://127.0.0.1:8888', key='ignored', opener=opener)
        method, url, headers, body = opener.last
        self.assertEqual((method, body), ('GET', None))
        parts = urllib.parse.urlsplit(url)
        self.assertEqual((parts.scheme, parts.netloc, parts.path), ('http', '127.0.0.1:8888', '/search'))
        self.assertEqual(urllib.parse.parse_qs(parts.query), {'q': ['rust async 运行时'], 'format': ['json']})
        self.assertEqual(set(headers), {'accept', 'user-agent'}, 'no key, no app label')
        self.assertEqual(value, {'query': 'rust async 运行时', 'backend': 'searxng', 'results': [
            {'title': 'S1', 'url': 'https://s.example/1', 'excerpt': 'first result'}, {'title': 'S2', 'url': 'https://s.example/2', 'excerpt': ''}]})
        for endpoint, expected in (('https://searx.example/', 'https://searx.example/search'), ('https://example.org/searx', 'https://example.org/searx/search'), ('https://searx.example/search', 'https://searx.example/search')):
            web_search.search('q', backend='searxng', endpoint=endpoint, opener=opener)
            self.assertEqual(opener.last[1].split('?')[0], expected)

    def test_needs_an_address_and_explains_its_errors(self):
        with self.assertRaises(web_search.WebSearchError) as missing: web_search.search('q', backend='searxng', opener=FakeOpener({}))
        self.assertEqual((missing.exception.status, missing.exception.code), (400, 'websearch_not_configured'))
        for status, expected in ((403, (502, 'websearch_format')), (429, (429, 'websearch_rate_limited')), (502, (502, 'websearch_http'))):
            with self.assertRaises(web_search.WebSearchError) as failed: web_search.search('q', backend='searxng', endpoint='http://127.0.0.1:8888', opener=FakeOpener(error=http_error(status)))
            self.assertEqual((failed.exception.status, failed.exception.code), expected, status)
        with self.assertRaises(web_search.WebSearchError) as offline: web_search.search('q', backend='searxng', endpoint='http://127.0.0.1:9', opener=FakeOpener(error=urllib.error.URLError('refused')))
        self.assertEqual(offline.exception.code, 'websearch_unreachable')
        self.assertIn('SearXNG', str(offline.exception))

    def test_addresses(self):
        for good, saved in (('http://127.0.0.1:8888/', 'http://127.0.0.1:8888'), ('https://searx.example/sub', 'https://searx.example/sub'), (' http://[::1]:8080 ', 'http://[::1]:8080')):
            self.assertEqual(web_search.endpoint_of(good), saved)
        for bad in ('', 'searx.example', 'ftp://searx.example', 'https://u:p@searx.example', 'https://searx.example/?q=1', 'https://searx.example/#x', 'https://searx .example', 'http://h:99999', None, 5, 'https://' + 'a' * 600):
            self.assertIsNone(web_search.endpoint_of(bad), bad)


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.store, self.secrets = PluginStore(self.tmp.name), MemorySecrets()
        self.opener = FakeOpener({'results': [{'title': 'T', 'url': 'https://t.example/', 'snippet': 's', 'content': 'c'}]})
        self.search = web_search.WebSearch(self.store, secrets=self.secrets, opener=self.opener)

    def test_off_by_default_and_nothing_is_sent(self):
        self.assertEqual(self.store.read()['builtin'], {})
        with self.assertRaises(web_search.WebSearchError) as off: self.search.search('q')
        self.assertEqual((off.exception.status, off.exception.code), (403, 'plugin_disabled'))
        self.search.configure({'backend': 'searxng', 'endpoint': 'http://127.0.0.1:8888'})
        self.assertIs(self.store.read()['builtin']['websearch']['enabled'], False, 'choosing a service does not switch it on')
        with self.assertRaises(web_search.WebSearchError): self.search.search('q')
        self.assertEqual(self.opener.requests, [])

    def test_service_address_and_key_are_device_local_and_the_key_stays_in_the_keychain(self):
        self.store.set_builtin('websearch', True)
        self.assertEqual(self.search.search('q', 2)['backend'], 'keenable')
        self.assertEqual(self.opener.last[1], 'https://api.keenable.ai/v1/search/public')
        self.search.configure({'backend': 'keenable', 'key': ' kn-test-key '})
        self.assertEqual(self.secrets.get('websearch', 'keenable'), 'kn-test-key')
        text = Path(self.tmp.name, 'plugins', 'plugins.json').read_text()
        self.assertNotIn('kn-test-key', text)
        self.assertEqual(self.store.read()['builtin']['websearch'], {'enabled': True, 'backend': 'keenable', 'keys': ['keenable']})
        self.search.search('q')
        self.assertEqual((self.opener.last[1], self.opener.last[2]['x-api-key']), ('https://api.keenable.ai/v1/search', 'kn-test-key'))
        self.search.configure({'backend': 'searxng', 'endpoint': 'http://127.0.0.1:8888/'})
        self.assertEqual(self.search.search('q'), {'query': 'q', 'backend': 'searxng', 'results': [{'title': 'T', 'url': 'https://t.example/', 'excerpt': 'c'}]})
        self.assertTrue(self.opener.last[1].startswith('http://127.0.0.1:8888/search?'))
        self.assertNotIn('x-api-key', self.opener.last[2])
        self.store.set_builtin('websearch', False); self.store.set_builtin('websearch', True)
        self.assertEqual(self.store.read()['builtin']['websearch'], {'enabled': True, 'backend': 'searxng', 'endpoints': {'searxng': 'http://127.0.0.1:8888'}, 'keys': ['keenable']}, 'switching keeps the settings')
        self.search.configure({'backend': 'keenable', 'key': ''})
        self.assertIsNone(self.secrets.get('websearch', 'keenable'))
        self.assertNotIn('keys', self.store.read()['builtin']['websearch'])
        self.search.search('q')
        self.assertEqual(self.opener.last[1], 'https://api.keenable.ai/v1/search/public')

    def test_rejects_what_a_service_does_not_take(self):
        bad = ({'backend': 'brave'}, {'backend': None}, {'backend': ['keenable']}, {'backend': 'keenable', 'endpoint': 'http://x.example'},
               {'backend': 'searxng', 'key': 'k'}, {'backend': 'searxng', 'endpoint': 'searx.example'}, {'backend': 'keenable', 'key': 'a\nb'}, {'backend': 'keenable', 'key': 5})
        for payload in bad:
            with self.assertRaises(web_search.WebSearchError, msg=payload) as rejected: self.search.configure(payload)
            self.assertEqual(rejected.exception.status, 400)
        self.assertEqual(self.store.read()['builtin'], {})
        self.store.write({'version': 1, 'builtin': {'websearch': {'enabled': 'yes', 'backend': 'nope', 'endpoints': {'searxng': 'ftp://x', 'keenable': 'http://x.example'}, 'keys': ['searxng', {}, 'keenable', 'keenable']}}, 'mcp': []})
        self.assertEqual(self.store.read()['builtin']['websearch'], {'enabled': False, 'keys': ['keenable']})


class WebSearchHttpTests(unittest.TestCase):
    def setUp(self):
        import server
        self.server = server
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        server.PLUGIN_STORE = PluginStore(self.tmp.name)
        self.opener = FakeOpener({'results': [{'title': 'T', 'url': 'https://t.example/', 'snippet': 's'}]})
        self.secrets = MemorySecrets()
        original = server.WEB_SEARCH
        server.WEB_SEARCH = web_search.WebSearch(server.PLUGIN_STORE, secrets=self.secrets, opener=self.opener)
        self.addCleanup(setattr, server, 'WEB_SEARCH', original)
        self.httpd = server.LoopbackHTTPServer(('127.0.0.1', 0), server.Handler)
        server.PORT = self.port = self.httpd.server_port
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close); self.addCleanup(self.httpd.shutdown)

    def call(self, path, body, origin='self'):
        origin = f'http://127.0.0.1:{self.port}' if origin == 'self' else origin
        headers = {'Content-Type': 'application/json', **({'Origin': origin} if origin else {})}
        req = urllib.request.Request(f'http://127.0.0.1:{self.port}{path}', data=json.dumps(body).encode(), headers=headers, method='POST')
        try:
            with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')

    def test_search_runs_only_after_the_user_turns_the_plugin_on(self):
        status, body = self.call('/__plugins/websearch/search', {'query': 'q'})
        self.assertEqual((status, body['code']), (403, 'plugin_disabled'))
        self.assertEqual(self.opener.requests, [])
        self.assertEqual(self.call('/__plugins/builtin', {'id': 'websearch', 'enabled': True})[1]['builtin']['websearch'], {'enabled': True})
        status, body = self.call('/__plugins/websearch/search', {'query': 'q', 'limit': 3})
        self.assertEqual((status, body), (200, {'query': 'q', 'backend': 'keenable', 'results': [{'title': 'T', 'url': 'https://t.example/', 'excerpt': 's'}]}))
        self.assertEqual(self.opener.last[3], {'query': 'q', 'max_results': 3})
        self.assertEqual(self.call('/__plugins/websearch/search', {'query': 'q'}, origin='https://evil.example')[0], 403)
        self.call('/__plugins/builtin', {'id': 'websearch', 'enabled': False})
        self.assertEqual(self.call('/__plugins/websearch/search', {'query': 'q'})[0], 403)
        self.assertEqual(len(self.opener.requests), 1)

    def test_settings_route_never_returns_the_key(self):
        status, body = self.call('/__plugins/websearch/settings', {'backend': 'keenable', 'key': 'kn-route-key'})
        self.assertEqual((status, body['builtin']['websearch']), (200, {'enabled': False, 'backend': 'keenable', 'keys': ['keenable']}))
        self.assertNotIn('kn-route-key', json.dumps(body))
        self.assertEqual(self.call('/__plugins/websearch/settings', {'backend': 'searxng', 'endpoint': 'nope'})[1]['code'], 'websearch_invalid')
        self.assertEqual(self.call('/__plugins/websearch/settings', {'backend': 'searxng'}, origin='https://evil.example')[0], 403)
        self.call('/__plugins/websearch/settings', {'backend': 'searxng'})
        self.call('/__plugins/builtin', {'id': 'websearch', 'enabled': True})
        self.assertEqual(self.call('/__plugins/websearch/search', {'query': 'q'})[1]['code'], 'websearch_not_configured')
        self.opener.error = http_error(403)
        self.call('/__plugins/websearch/settings', {'backend': 'searxng', 'endpoint': 'http://127.0.0.1:8888'})
        status, body = self.call('/__plugins/websearch/search', {'query': 'q'})
        self.assertEqual((status, body['code']), (502, 'websearch_format'))


if __name__ == '__main__':
    unittest.main()
