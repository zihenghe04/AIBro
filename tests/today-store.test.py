import json, os, tempfile, threading, unittest, urllib.request, urllib.error
from pathlib import Path

host = tempfile.TemporaryDirectory(prefix='aibro-today-host-'); os.environ.setdefault('AI_WORKSTATION_DATA_DIR', host.name)
from today_store import TodayStore, MAX_BYTES


class TodayStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.store = TodayStore(self.tmp.name, clock=lambda: 1000.0)

    def test_write_then_read_one_file_per_day(self):
        self.assertIsNone(self.store.read('2026-10-30'))
        saved = self.store.write('2026-10-30', {'lines': ['10月30日 星期五'], 'date': 'ignored'})
        self.assertEqual(saved, {'lines': ['10月30日 星期五'], 'date': '2026-10-30', 'savedAt': 1000.0})
        self.assertEqual(TodayStore(self.tmp.name).read('2026-10-30'), saved)
        self.assertEqual([p.name for p in Path(self.tmp.name, 'today', 'briefs').iterdir()], ['2026-10-30.json'])
        self.store.write('2026-10-30', {'lines': []})
        self.assertEqual(self.store.read('2026-10-30')['lines'], [])

    def test_rejects_bad_days_bodies_and_links(self):
        for day in ('2026-02-30', '../x', '2026-1-1', None, '2026-10-30/../a'):
            with self.assertRaises(ValueError): self.store.write(day, {})
            with self.assertRaises(ValueError): self.store.read(day)
        for body in ([], 'x', None):
            with self.assertRaises(ValueError): self.store.write('2026-10-30', body)
        with self.assertRaises(ValueError): self.store.write('2026-10-30', {'text': 'x' * MAX_BYTES})
        folder = Path(self.tmp.name, 'today', 'briefs'); folder.mkdir(parents=True)
        (folder / '2026-10-31.json').symlink_to(Path(self.tmp.name, 'elsewhere.json'))
        with self.assertRaises(ValueError): self.store.write('2026-10-31', {})
        self.assertFalse(Path(self.tmp.name, 'elsewhere.json').exists())

    def test_unreadable_file_reads_as_missing(self):
        folder = Path(self.tmp.name, 'today', 'briefs'); folder.mkdir(parents=True)
        (folder / '2026-10-30.json').write_text('{broken')
        self.assertIsNone(self.store.read('2026-10-30'))


class TodayHttpTests(unittest.TestCase):
    def setUp(self):
        import server
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        server.TODAY_STORE = TodayStore(self.tmp.name)
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

    def test_save_and_read_brief(self):
        self.assertEqual(self.call('/__today/brief?date=2026-10-30'), (200, {'brief': None}))
        status, body = self.call('/__today/brief', {'date': '2026-10-30', 'brief': {'lines': ['a']}})
        self.assertEqual((status, body['brief']['lines']), (200, ['a']))
        self.assertEqual(self.call('/__today/brief?date=2026-10-30')[1]['brief']['lines'], ['a'])
        self.assertEqual(self.call('/__today/brief', {'date': 'today', 'brief': {}})[0], 400)
        self.assertEqual(self.call('/__today/brief?date=x')[0], 400)

    def test_other_sites_cannot_read_or_write(self):
        self.assertEqual(self.call('/__today/brief', {'date': '2026-10-30', 'brief': {}}, origin='https://evil.example')[0], 403)
        self.assertEqual(self.call('/__today/brief?date=2026-10-30', origin='https://evil.example')[0], 403)


if __name__ == '__main__':
    unittest.main()
