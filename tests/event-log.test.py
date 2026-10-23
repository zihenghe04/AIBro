import json, os, tempfile, threading, time, unittest, urllib.request, urllib.error
from pathlib import Path
from unittest.mock import patch

host = tempfile.TemporaryDirectory(prefix='aibro-events-host-'); os.environ.setdefault('AI_WORKSTATION_DATA_DIR', host.name)
import event_log
from event_log import EventLog, EventLogError


def ev(seq, type='tool/requested', run='run_a', **extra):
    return {'v': 1, 'id': f'evt_{run}_{seq}_{extra.pop("tag", "")}', 'stream': 'run:' + run, 'seq': seq, 'ts': int(time.time() * 1000), 'type': type,
            'runId': run, 'callId': 'tool_1', 'source': {'kind': 'kernel', 'id': 'main'}, 'durability': 'durable', 'model': False, 'data': extra.pop('data', {}), **extra}


class EventLogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.log = EventLog(self.tmp.name)

    def lines(self, run='run_a'):
        files = sorted(Path(self.tmp.name, 'runs').glob(f'*/{run}.jsonl'))
        return [json.loads(line) for f in files for line in f.read_text().splitlines()]

    def test_appends_one_file_per_run_under_month(self):
        self.log.append([ev(1), ev(2, 'tool/dispatched')])
        files = list(Path(self.tmp.name, 'runs').glob('*/run_a.jsonl'))
        self.assertEqual(len(files), 1)
        self.assertRegex(files[0].parent.name, r'^\d{4}-\d{2}$')
        self.assertEqual([e['seq'] for e in self.lines()], [1, 2])
        self.assertEqual(oct(files[0].stat().st_mode & 0o777), '0o600')

    def test_seq_must_continue_and_resend_is_idempotent(self):
        batch = [ev(1), ev(2)]
        self.log.append(batch)
        self.assertEqual(self.log.append(batch)['last'], {'run:run_a': 2})  # resent: ignored
        self.assertEqual(len(self.lines()), 2)
        with self.assertRaises(EventLogError) as gap: self.log.append([ev(4)])
        self.assertEqual((gap.exception.status, gap.exception.payload['last']), (409, {'run:run_a': 2}))
        with self.assertRaises(EventLogError) as stale: self.log.append([ev(1, tag='other-page')])
        self.assertEqual(stale.exception.status, 409)
        # A fresh process continues the stream from the file.
        again = EventLog(self.tmp.name)
        again.append([ev(3, 'run/finished', data={'status': 'completed'})])
        self.assertEqual([e['seq'] for e in self.lines()], [1, 2, 3])

    def test_rejects_malformed_events_without_writing(self):
        for bad in ({**ev(1), 'type': 'shell/exec'}, {**ev(1), 'stream': 'run:../x', 'runId': '../x'}, {**ev(1), 'runId': 'other'}, {**ev(1), 'seq': 0}, {**ev(1), 'v': 2}, 'x'):
            with self.assertRaises(EventLogError): self.log.append([ev(1), bad])
        self.assertEqual(self.lines(), [])
        with self.assertRaises(EventLogError): self.log.append([ev(i + 1) for i in range(event_log.MAX_BATCH + 1)])

    def test_ephemeral_events_are_not_stored(self):
        self.log.append([{**ev(0, 'tool/progress'), 'durability': 'ephemeral'}, ev(1)])
        self.assertEqual([e['type'] for e in self.lines()], ['tool/requested'])

    def test_never_stores_secrets_or_headers(self):
        secret = 'sk-' + 'A1b2C3d4E5f6G7h8'
        data = {'request': {'url': 'https://x', 'headers': {'Authorization': 'Bearer ' + 'z' * 20}, 'apiKey': secret, 'note': 'token=' + 'q' * 16 + ' and ' + secret},
                'Authorization': 'Bearer abcdefghijkl'}
        self.log.append([ev(1, data=data)])
        text = next(Path(self.tmp.name, 'runs').glob('*/run_a.jsonl')).read_text()
        for leaked in (secret, 'Bearer ', 'z' * 20, 'q' * 16, 'abcdefghijkl'): self.assertNotIn(leaked, text)
        stored = self.lines()[0]['data']
        self.assertEqual(stored['request']['headers'], '[redacted]'); self.assertEqual(stored['request']['url'], 'https://x')

    def test_fsync_only_for_durable_boundaries(self):
        calls = []
        with patch('event_log.os.fsync', side_effect=lambda fd: calls.append(fd)):
            self.log.append([ev(1)])
            self.assertEqual(calls, [])
            self.log.append([ev(2, 'tool/dispatched')])
            self.assertEqual(len(calls), 1)

    def test_oversized_event_keeps_envelope(self):
        self.log.append([ev(1, data={'text': 'x' * 80, 'items': ['y' * 3000] * 40})])
        self.assertEqual(self.lines()[0]['data'], {'truncated': True})

    def test_read_after_cursor_and_torn_line(self):
        self.log.append([ev(1), ev(2), ev(3)])
        path = next(Path(self.tmp.name, 'runs').glob('*/run_a.jsonl'))
        with path.open('a') as f: f.write('{"v":1,"seq":4,"ty')  # crash mid-write
        self.assertEqual([e['seq'] for e in self.log.read('run:run_a', after=1)], [2, 3])
        with self.assertRaises(EventLogError): self.log.read('run:../../etc')

    def test_retention_90_days_then_300mb(self):
        now = time.time()
        log = EventLog(self.tmp.name, max_bytes=2000, clock=lambda: now)
        for name in ('old', 'mid', 'new'): log.append([ev(1, run=name, data={'pad': 'p' * 700})])
        paths = {name: next(Path(self.tmp.name, 'runs').glob(f'*/{name}.jsonl')) for name in ('old', 'mid', 'new')}
        os.utime(paths['old'], (now - 91 * 86400,) * 2)
        os.utime(paths['mid'], (now - 10 * 86400,) * 2)
        result = log.prune()
        self.assertFalse(paths['old'].exists())  # older than 90 days
        self.assertTrue(paths['new'].exists())
        self.assertLessEqual(result['bytes'], 2000)
        self.assertEqual(event_log.RETENTION_DAYS, 90); self.assertEqual(event_log.MAX_BYTES, 300 * 1024 * 1024)
        # A pruned run starts a new file from seq 1 again.
        log.append([ev(1, run='old')])

    def test_http_endpoint_same_origin_only(self):
        import server
        server.EVENT_LOG = EventLog(self.tmp.name)
        httpd = server.LoopbackHTTPServer(('127.0.0.1', 0), server.Handler)
        server.PORT = port = httpd.server_port
        thread = threading.Thread(target=httpd.serve_forever, daemon=True); thread.start()
        self.addCleanup(httpd.server_close); self.addCleanup(httpd.shutdown)
        def post(body, origin=None):
            headers = {'Content-Type': 'application/json', **({'Origin': origin} if origin else {})}
            req = urllib.request.Request(f'http://127.0.0.1:{port}/__events/append', data=json.dumps(body).encode(), headers=headers, method='POST')
            try:
                with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
            except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')
        self.assertEqual(post({'events': [ev(1)]})[0], 200)
        self.assertEqual(post({'events': [ev(2)]}, origin='https://evil.example')[0], 403)
        status, body = post({'events': [ev(5)]})
        self.assertEqual((status, body.get('error'), body.get('last')), (409, 'SEQ', {'run:run_a': 1}))
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/__events?stream=run:run_a&after=0') as r:
            self.assertEqual([e['seq'] for e in json.loads(r.read())['events']], [1])


if __name__ == '__main__':
    unittest.main()
