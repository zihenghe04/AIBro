"""Usage log: counts, latency and outcome only; no prompts, answers, URLs or keys."""
import io
import json
import os
from pathlib import Path
import sqlite3
import stat
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import usage_log as ul


class Headers(dict):
    def get(self, key, default=None): return super().get(key, default)
    def get_all(self, key, default=None): return [self[key]] if key in self else (default or [])


class FakeHandler:
    def __init__(self, command, path, body=None, port=8800, origin=True, host='127.0.0.1'):
        self.command, self.path = command, path
        raw = json.dumps(body).encode() if body is not None else b''
        headers = {'Host': f'127.0.0.1:{port}', 'Content-Length': str(len(raw)), 'Content-Type': 'application/json'}
        if origin: headers['Origin'] = f'http://127.0.0.1:{port}'
        self.headers = Headers(headers)
        self.rfile, self.client_address = io.BytesIO(raw), (host, 50000)
        self.server = type('S', (), {'server_port': port})()
        self.sent = None
    def send_json(self, payload, status=200): self.sent = (status, payload)


class UsageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.clock = [1_800_000_000.0]
        self.log = ul.UsageLog(Path(self.tmp.name) / 'data' / 'usage.sqlite', now=lambda: self.clock[0])
    def tearDown(self): self.tmp.cleanup()

    def add(self, **kw):
        entry = {'providerId': 'api:https://a.example.invalid/v1', 'providerKind': 'api', 'model': 'm-1', 'role': 'qa', 'input': 100, 'output': 20, 'cacheRead': 40, 'latencyMs': 900, 'status': 200, 'outcome': 'completed', 'ts': self.clock[0] - 60}
        entry.update(kw); return self.log.record(entry)

    def test_record_and_summarise(self):
        self.add(); self.add(input=300, output=50, cacheRead=0, model='m-2')
        self.add(outcome='failed', status=402, input=0, output=0, cacheRead=None, providerId='codex-cli', providerKind='account', model='gpt-x', role='kernel')
        out = self.log.query('24h')
        self.assertEqual(out['cards']['requests'], 3)
        self.assertEqual((out['cards']['input'], out['cards']['output'], out['cards']['cacheRead'], out['cards']['failed']), (400, 70, 40, 1))
        self.assertAlmostEqual(out['cards']['cacheHitRate'], 40 / 400)
        self.assertEqual({p['provider_id'] for p in out['byProvider']}, {'api:https://a.example.invalid/v1', 'codex-cli'})
        self.assertEqual(sorted(m['model'] for m in out['byModel']), ['gpt-x', 'm-1', 'm-2'])
        self.assertEqual(out['rows'][0]['model'], 'gpt-x' if out['rows'][0]['ts'] == out['rows'][1]['ts'] else out['rows'][0]['model'])
        self.assertEqual(len(out['rows']), 3)

    def test_ranges_and_retention(self):
        self.add(ts=self.clock[0] - 3600); self.add(ts=self.clock[0] - 3 * 86400); self.add(ts=self.clock[0] - 20 * 86400); self.add(ts=self.clock[0] - 60 * 86400)
        self.assertEqual([self.log.query(r)['cards']['requests'] for r in ('24h', '7d', '30d', 'all')], [1, 2, 3, 4])
        self.assertEqual(self.log.retention_days(), 90)
        self.add(ts=self.clock[0] - 120 * 86400)
        self.assertEqual(self.log.prune(), 1)
        self.assertEqual(self.log.set_retention(30), 30)
        self.assertEqual(self.log.query('all')['cards']['requests'], 3, 'the 60-day-old row went with the shorter window')
        with self.assertRaises(ul.UsageError): self.log.set_retention(5)
        with self.assertRaises(ul.UsageError): self.log.query('forever')

    def test_inputs_are_validated_and_nothing_secret_can_be_stored(self):
        with self.assertRaises(ul.UsageError): self.log.record({'model': 'x'})
        with self.assertRaises(ul.UsageError): self.log.record('nope')
        self.add(input=-5, output='7', cacheRead=float('nan'), latencyMs=True, status=99999, role='weird', outcome='weird', providerKind='weird', ts=self.clock[0] + 10 ** 6)
        self.add(prompt='my secret prompt', answer='secret answer', apiKey='sk-secret-0000', url='https://x.example.invalid/?key=sk-secret', model='m\x00-ctl')
        db = sqlite3.connect(self.log.path); text = json.dumps(db.execute('SELECT * FROM requests').fetchall()); db.close()
        for secret in ('secret prompt', 'secret answer', 'sk-secret', 'x.example.invalid/?key'): self.assertNotIn(secret, text)
        row = self.log.query('all')['rows'][0]
        self.assertEqual((row['input'], row['output'], row['cache_read'], row['latency_ms'], row['status'], row['role'], row['outcome'], row['provider_kind']), (None, None, None, None, None, 'other', 'failed', 'api'))
        columns = {r[1] for r in sqlite3.connect(self.log.path).execute('PRAGMA table_info(requests)')}
        self.assertFalse(columns & {'prompt', 'answer', 'text', 'content', 'url', 'key', 'token'})

    def test_file_is_private_and_clear_empties_it(self):
        self.assertEqual(stat.S_IMODE(os.stat(self.log.path).st_mode), 0o600)
        self.add(); self.add()
        self.assertEqual(self.log.clear(), 2)
        self.assertEqual(self.log.query('all')['cards']['requests'], 0)
        self.assertIsNone(self.log.query('all')['cards']['cacheHitRate'])

    def test_http_window_only_batch_and_errors(self):
        post = lambda path, body, **kw: self._call('POST', path, body, **kw)
        status, body = post(ul.PREFIX + 'record', {'entries': [{'providerId': 'p', 'model': 'm', 'role': 'qa', 'outcome': 'completed', 'input': 5, 'output': 6}, {'bad': True}]})
        self.assertEqual((status, body), (200, {'saved': 1}))
        status, body = self._call('GET', ul.PREFIX + 'query?range=24h')
        self.assertEqual((status, body['cards']['requests']), (200, 1))
        self.assertEqual(self._call('GET', ul.PREFIX + 'query?range=bogus')[0], 400)
        self.assertEqual(self._call('POST', ul.PREFIX + 'record', {'x': 1}, origin=False)[0], 403)
        self.assertEqual(self._call('GET', ul.PREFIX + 'query', host='10.1.1.1')[0], 403)
        self.assertEqual(self._call('POST', ul.PREFIX + 'settings', {'retentionDays': 7})[1], {'retentionDays': 7})
        self.assertEqual(self._call('POST', ul.PREFIX + 'settings', {'retentionDays': 3})[0], 400)
        self.assertEqual(self._call('POST', ul.PREFIX + 'clear', {})[1], {'cleared': 1})
        self.assertEqual(self._call('GET', ul.PREFIX + 'nothing')[0], 404)
        handler = FakeHandler('GET', '/__health')
        self.assertFalse(ul.handle_request(handler, self.log))

    def _call(self, command, path, body=None, **kw):
        handler = FakeHandler(command, path, body, **kw)
        self.assertTrue(ul.handle_request(handler, self.log))
        return handler.sent


if __name__ == '__main__':
    unittest.main()
