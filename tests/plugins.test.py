import json, os, tempfile, threading, unittest, urllib.request, urllib.error
from pathlib import Path

host = tempfile.TemporaryDirectory(prefix='aibro-plugins-host-'); os.environ.setdefault('AI_WORKSTATION_DATA_DIR', host.name)
from plugin_store import PluginStore, PluginStoreError


class PluginStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.store = PluginStore(self.tmp.name)

    def test_defaults_and_builtin_switch_are_device_local_file(self):
        self.assertEqual(self.store.read(), {'version': 1, 'builtin': {}, 'mcp': []})
        self.store.set_builtin('browser', False)
        path = Path(self.tmp.name, 'plugins', 'plugins.json')
        self.assertEqual(oct(path.stat().st_mode & 0o777), '0o600')
        self.assertEqual(PluginStore(self.tmp.name).read()['builtin'], {'browser': {'enabled': False}})
        self.store.set_builtin('browser', True)
        self.assertEqual(self.store.read()['builtin']['browser'], {'enabled': True})

    def test_rejects_unknown_plugin_and_non_boolean(self):
        with self.assertRaises(PluginStoreError) as unknown: self.store.set_builtin('shell', True)
        self.assertEqual(unknown.exception.status, 404)
        with self.assertRaises(PluginStoreError): self.store.set_builtin('browser', 'no')
        self.assertEqual(self.store.read()['builtin'], {})

    def test_browser_site_lists_and_unknown_site_setting(self):
        self.store.browser_site('https://a.org', 'allow')
        self.store.browser_site('https://b.org:8443', 'deny')
        self.store.browser_site('https://a.org', 'deny')  # moving between lists
        self.assertEqual(self.store.read()['builtin']['browser']['sites'], {'allow': [], 'deny': ['https://b.org:8443', 'https://a.org']})
        self.store.browser_site('https://a.org', 'remove')
        self.assertEqual(self.store.read()['builtin']['browser']['sites']['deny'], ['https://b.org:8443'])
        for bad in ('https://a.org/path', 'javascript:alert(1)', 'https://u@a.org', 'ftp://a.org', None):
            with self.assertRaises(PluginStoreError): self.store.browser_site(bad, 'allow')
        with self.assertRaises(PluginStoreError): self.store.browser_site('https://a.org', 'maybe')
        self.store.set_builtin('browser', False)
        entry = self.store.read()['builtin']['browser']
        self.assertEqual((entry['enabled'], entry['sites']['deny']), (False, ['https://b.org:8443']), 'switching keeps the lists')
        self.store.browser_settings('ask'); self.assertEqual(self.store.read()['builtin']['browser']['unknownSites'], 'ask')
        self.store.browser_settings('auto'); self.assertNotIn('unknownSites', self.store.read()['builtin']['browser'])
        with self.assertRaises(PluginStoreError): self.store.browser_settings('never')

    def test_unreadable_file_is_kept_aside_and_defaults_apply(self):
        root = Path(self.tmp.name, 'plugins'); root.mkdir()
        (root / 'plugins.json').write_text('{broken')
        self.assertEqual(self.store.read()['builtin'], {})
        self.assertTrue(list(root.glob('plugins.unreadable-*.json')))


class PluginHttpTests(unittest.TestCase):
    def setUp(self):
        import server
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        server.PLUGIN_STORE = PluginStore(self.tmp.name)
        self.httpd = server.LoopbackHTTPServer(('127.0.0.1', 0), server.Handler)
        server.PORT = self.port = self.httpd.server_port
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close); self.addCleanup(self.httpd.shutdown)

    def call(self, path, body=None, origin='self'):
        origin = f'http://127.0.0.1:{self.port}' if origin == 'self' else origin
        headers = {'Content-Type': 'application/json', **({'Origin': origin} if origin else {})}
        req = urllib.request.Request(f'http://127.0.0.1:{self.port}{path}', data=json.dumps(body).encode() if body is not None else None, headers=headers, method='POST' if body is not None else 'GET')
        try:
            with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')

    def test_get_and_toggle_builtin(self):
        self.assertEqual(self.call('/__plugins', origin=None), (200, {'version': 1, 'builtin': {}, 'mcp': []}))
        status, body = self.call('/__plugins/builtin', {'id': 'browser', 'enabled': False})
        self.assertEqual((status, body['builtin']), (200, {'browser': {'enabled': False}}))

    def test_browser_site_endpoint(self):
        status, body = self.call('/__plugins/browser/sites', {'origin': 'https://a.org', 'decision': 'deny'})
        self.assertEqual((status, body['builtin']['browser']['sites']['deny']), (200, ['https://a.org']))
        self.assertEqual(self.call('/__plugins/browser/sites', {'origin': 'https://a.org/x', 'decision': 'deny'})[0], 400)
        self.assertEqual(self.call('/__plugins/browser/sites', {'origin': 'https://b.org', 'decision': 'allow'}, origin='https://evil.example')[0], 403)
        self.assertEqual(self.call('/__plugins/browser/settings', {'unknownSites': 'ask'})[1]['builtin']['browser']['unknownSites'], 'ask')

    def test_other_sites_and_missing_origin_cannot_change_plugins(self):
        self.assertEqual(self.call('/__plugins/builtin', {'id': 'browser', 'enabled': False}, origin='https://evil.example')[0], 403)
        self.assertEqual(self.call('/__plugins/builtin', {'id': 'browser', 'enabled': False}, origin=None)[0], 403)
        self.assertEqual(self.call('/__plugins', origin=None)[1]['builtin'], {})


if __name__ == '__main__':
    unittest.main()
