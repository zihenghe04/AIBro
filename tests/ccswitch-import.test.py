"""CC Switch import: synthetic fixtures only. The real ~/.cc-switch is never read."""
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
import ccswitch_import as imp

SCHEMA = '''CREATE TABLE providers (id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL, settings_config TEXT NOT NULL,
 website_url TEXT, category TEXT, created_at INTEGER, sort_index INTEGER, notes TEXT, icon TEXT, icon_color TEXT,
 meta TEXT NOT NULL DEFAULT '{}', is_current BOOLEAN NOT NULL DEFAULT 0, in_failover_queue BOOLEAN NOT NULL DEFAULT 0, PRIMARY KEY (id, app_type))'''
KEY_A, KEY_B, KEY_C = 'sk-fixture-aaaaaaaaaaaa1111', 'sk-fixture-bbbbbbbbbbbb2222', 'sk-fixture-cccccccccccc3333'


def codex_config(base, model='demo-model', wire='responses', provider='custom'):
    return f'model_provider = "{provider}"\nmodel = "{model}"\n\n[model_providers.{provider}]\nname = "{provider}"\nbase_url = "{base}"\nwire_api = "{wire}"\n'


ROWS = [
    ('c1', 'codex', 'Relay A', json.dumps({'auth': {'OPENAI_API_KEY': KEY_A}, 'config': codex_config('https://relay-a.example.invalid/v1', 'a-model')}), 'https://relay-a.example.invalid', 'third_party', 1, '{}'),
    ('c2', 'codex', 'Relay B', json.dumps({'auth': {'OPENAI_API_KEY': KEY_B}, 'config': codex_config('https://relay-b.example.invalid/v1/chat/completions', 'b-model', 'chat')}), None, 'aggregator', 2, '{}'),
    ('k1', 'claude', 'Claude Relay', json.dumps({'env': {'ANTHROPIC_BASE_URL': 'https://claude-relay.example.invalid/anthropic', 'ANTHROPIC_AUTH_TOKEN': KEY_C, 'ANTHROPIC_MODEL': 'c-opus', 'ANTHROPIC_DEFAULT_SONNET_MODEL': 'c-sonnet'}}), None, 'third_party', 3, '{}'),
    ('o1', 'codex', 'OpenAI Official', json.dumps({'auth': {}, 'config': ''}), None, 'official', 4, json.dumps({'providerType': 'codex_oauth'})),
    ('x1', 'codex', 'Grok OAuth', json.dumps({'auth': {}, 'config': codex_config('https://api.x.ai/v1')}), None, 'third_party', 5, json.dumps({'providerType': 'xai_oauth'})),
    ('g1', 'gemini', 'Gemini One', json.dumps({'env': {'GEMINI_API_KEY': 'gem-fixture-key-000000'}}), None, 'third_party', 6, '{}'),
    ('b1', 'codex', 'Broken', '{not json', None, None, 7, '{}'),
    ('n1', 'codex', 'No address', json.dumps({'auth': {'OPENAI_API_KEY': 'sk-fixture-dddddddddddd4444'}, 'config': 'model = "x"\n'}), None, None, 8, '{}'),
    ('e1', 'claude', 'Official Claude', json.dumps({'env': {}}), None, 'official', 9, '{}'),
    ('p1', 'codex', 'Local no key', json.dumps({'auth': {}, 'config': codex_config('http://127.0.0.1:11434/v1', 'llama')}), None, 'local', 10, '{}'),
]


def make_db(path):
    connection = sqlite3.connect(path)
    connection.execute(SCHEMA)
    for row_id, app, name, config, site, category, sort, meta in ROWS:
        connection.execute('INSERT INTO providers (id, app_type, name, settings_config, website_url, category, sort_index, meta) VALUES (?,?,?,?,?,?,?,?)', (row_id, app, name, config, site, category, sort, meta))
    connection.commit(); connection.close()


class Headers(dict):
    def get(self, key, default=None): return super().get(key, default)
    def get_all(self, key, default=None): return [self[key]] if key in self else (default or [])


class FakeHandler:
    def __init__(self, path, body=b'', content_type='application/octet-stream', port=8800, origin=True, host='127.0.0.1', command='POST'):
        self.command, self.path = command, path
        headers = {'Host': f'127.0.0.1:{port}', 'Content-Length': str(len(body)), 'Content-Type': content_type}
        if origin: headers['Origin'] = f'http://127.0.0.1:{port}'
        self.headers = Headers(headers)
        self.rfile, self.client_address = io.BytesIO(body), (host, 50000)
        self.server = type('S', (), {'server_port': port})()
        self.sent = None
    def send_json(self, payload, status=200): self.sent = (status, payload)


class ParseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / 'cc-switch.db'
        make_db(self.db)
    def tearDown(self): self.tmp.cleanup()

    def by_name(self, items): return {item['name']: item for item in items}

    def test_codex_and_claude_rows_become_candidates(self):
        items = self.by_name(imp.parse_database(self.db))
        a, b, k = items['Relay A'], items['Relay B'], items['Claude Relay']
        self.assertEqual((a['status'], a['base'], a['protocol'], a['model'], a['token']), ('ready', 'https://relay-a.example.invalid/v1', 'responses', 'a-model', KEY_A))
        self.assertEqual((b['base'], b['protocol'], b['models']), ('https://relay-b.example.invalid/v1', 'chat', ['b-model']))
        self.assertEqual((k['protocol'], k['base'], k['models']), ('anthropic', 'https://claude-relay.example.invalid/anthropic', ['c-opus', 'c-sonnet']))
        self.assertEqual(items['Local no key']['status'], 'no_key')

    def test_managed_accounts_unsupported_apps_and_broken_rows_are_skipped_with_reasons(self):
        items = self.by_name(imp.parse_database(self.db))
        self.assertEqual((items['OpenAI Official']['status'], items['OpenAI Official']['reason']), ('skipped', 'account'))
        self.assertEqual(items['Grok OAuth']['reason'], 'account')
        self.assertEqual(items['Gemini One']['reason'], 'unsupported')
        self.assertEqual(items['Broken']['reason'], 'invalid')
        self.assertEqual(items['No address']['reason'], 'no_address')
        self.assertEqual(items['Official Claude']['status'], 'skipped')
        for skipped in (items['OpenAI Official'], items['Grok OAuth'], items['Gemini One'], items['Broken']):
            self.assertEqual(skipped['token'], '')

    def test_preview_has_only_the_last_four_characters(self):
        previews = [imp.preview_item(i, c) for i, c in enumerate(imp.parse_database(self.db))]
        text = json.dumps(previews)
        for key in (KEY_A, KEY_B, KEY_C):
            self.assertNotIn(key, text)
            self.assertNotIn(key[:-4], text)
        self.assertIn(KEY_A[-4:], text)
        self.assertEqual(imp.mask_key('short'), '')
        self.assertTrue(all('token' not in p for p in previews))

    def test_the_database_is_opened_read_only_and_left_untouched(self):
        before = self.db.read_bytes(); mtime = self.db.stat().st_mtime_ns
        imp.parse_database(self.db)
        self.assertEqual(self.db.read_bytes(), before)
        self.assertEqual(self.db.stat().st_mtime_ns, mtime)
        self.assertEqual(sorted(p.name for p in Path(self.tmp.name).iterdir()), ['cc-switch.db'], 'no -wal/-shm/journal side files')
        os.chmod(self.db, 0o444); os.chmod(self.tmp.name, 0o555)
        try: self.assertTrue(imp.parse_database(self.db))
        finally: os.chmod(self.tmp.name, 0o755); os.chmod(self.db, 0o644)

    def test_wrong_files_are_refused_politely(self):
        other = Path(self.tmp.name) / 'other.db'
        sqlite3.connect(other).execute('CREATE TABLE t (a)').connection.close()
        with self.assertRaises(imp.ImportError_): imp.parse_database(other)
        with self.assertRaises(imp.ImportError_): imp.parse_bytes(b'\x00\x01 binary junk')
        with self.assertRaises(imp.ImportError_): imp.parse_bytes(b'just some text')
        with self.assertRaises(imp.ImportError_): imp.parse_database(Path(self.tmp.name) / 'missing.db')

    def test_sql_export_only_runs_the_providers_statements(self):
        dump = '\n'.join(['PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;', SCHEMA + ';',
                          "INSERT INTO providers (id, app_type, name, settings_config, meta) VALUES ('s1','codex','From SQL'," + "'" + json.dumps({'auth': {'OPENAI_API_KEY': KEY_A}, 'config': codex_config('https://sql.example.invalid/v1')}).replace("'", "''") + "','{}');",
                          "DROP TABLE providers;", "ATTACH DATABASE '/tmp/should-not-exist-ccswitch.db' AS evil;", "CREATE TABLE evil.x (a);", 'COMMIT;'])
        items = imp.parse_bytes(dump.encode())
        self.assertEqual([i['name'] for i in items], ['From SQL'])
        self.assertEqual(items[0]['base'], 'https://sql.example.invalid/v1')
        self.assertFalse(Path('/tmp/should-not-exist-ccswitch.db').exists())

    def test_ccswitch_link(self):
        link = 'ccswitch://v1/import?resource=provider&app=codex&name=Linked&endpoint=https%3A%2F%2Flink.example.invalid%2Fv1%2Cb&apiKey=' + KEY_A + '&model=m-1&apiFormat=openai_chat'
        item = imp.parse_link(link)[0]
        self.assertEqual((item['name'], item['base'], item['protocol'], item['model'], item['token']), ('Linked', 'https://link.example.invalid/v1', 'chat', 'm-1', KEY_A))
        for bad in ('https://x.example.invalid', 'ccswitch://v1/import?resource=skill&app=codex', 'ccswitch://v2/other', ''):
            with self.assertRaises(imp.ImportError_): imp.parse_link(bad)
        self.assertEqual(imp.parse_link('ccswitch://v1/import?resource=provider&app=gemini&name=G&endpoint=https://g.example.invalid')[0]['reason'], 'unsupported')

    def test_unsafe_addresses_are_not_importable(self):
        self.assertEqual(imp.normalize_base('https://user:pw@evil.example.invalid/v1'), '')
        self.assertEqual(imp.normalize_base('ftp://x.example.invalid'), '')
        self.assertEqual(imp.normalize_base('https://X.example.invalid/v1/?q=1#f'), 'https://x.example.invalid/v1')


class SessionTests(unittest.TestCase):
    def test_one_time_ids_expire_and_are_bounded(self):
        clock = [1000.0]
        sessions = imp.ImportSessions(now=lambda: clock[0])
        cands = [{'status': 'ready', 'app': 'codex', 'name': 'A', 'base': 'https://a.example.invalid', 'host': 'a.example.invalid', 'protocol': 'chat', 'model': 'm', 'models': ['m'], 'token': KEY_A}, {'status': 'skipped', 'token': ''}]
        first = sessions.create(cands)
        taken = sessions.take(first, [0, 1, 5, True, 'x'])
        self.assertEqual([i['name'] for i in taken], ['A']); self.assertEqual(taken[0]['token'], KEY_A)
        with self.assertRaises(imp.ImportError_): sessions.take(first, [0])
        second = sessions.create(cands); clock[0] += imp.TTL + 1
        with self.assertRaises(imp.ImportError_) as raised: sessions.take(second, [0])
        self.assertEqual(raised.exception.status, 410)
        ids = [sessions.create(cands) for _ in range(imp.MAX_SESSIONS + 2)]
        with self.assertRaises(imp.ImportError_): sessions.take(ids[0], [0])
        self.assertEqual(sessions.take(ids[-1], [0], include_keys=False)[0]['token'], '')


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.db = Path(self.tmp.name) / 'cc-switch.db'; make_db(self.db)
        self.sessions = imp.ImportSessions()
    def tearDown(self): self.tmp.cleanup()

    def test_preview_then_commit_hands_over_keys_exactly_once(self):
        handler = FakeHandler(imp.PREFIX + 'preview', self.db.read_bytes())
        self.assertTrue(imp.handle_request(handler, self.sessions))
        status, body = handler.sent
        self.assertEqual(status, 200)
        text = json.dumps(body)
        for key in (KEY_A, KEY_B, KEY_C): self.assertNotIn(key, text)
        wanted = [i['index'] for i in body['items'] if i['name'] in ('Relay A', 'Claude Relay')]
        commit = FakeHandler(imp.PREFIX + 'commit', json.dumps({'importId': body['importId'], 'selected': wanted}).encode(), 'application/json')
        imp.handle_request(commit, self.sessions)
        self.assertEqual(commit.sent[0], 200)
        self.assertEqual(sorted(i['token'] for i in commit.sent[1]['items']), sorted([KEY_A, KEY_C]))
        again = FakeHandler(imp.PREFIX + 'commit', json.dumps({'importId': body['importId'], 'selected': wanted}).encode(), 'application/json')
        imp.handle_request(again, self.sessions)
        self.assertEqual(again.sent[0], 410)

    def test_only_the_settings_window_may_call(self):
        for kwargs in ({'origin': False}, {'host': '10.0.0.5'}):
            handler = FakeHandler(imp.PREFIX + 'preview', b'x', **kwargs)
            imp.handle_request(handler, self.sessions)
            self.assertEqual(handler.sent[0], 403)
        get = FakeHandler(imp.PREFIX + 'preview', command='GET')
        imp.handle_request(get, self.sessions); self.assertEqual(get.sent[0], 403)
        other = FakeHandler('/__health'); self.assertFalse(imp.handle_request(other, self.sessions))

    def test_link_preview_cancel_and_bad_input(self):
        link = 'ccswitch://v1/import?resource=provider&app=claude&name=L&endpoint=https://l.example.invalid&apiKey=' + KEY_B
        handler = FakeHandler(imp.PREFIX + 'preview', json.dumps({'link': link}).encode(), 'application/json')
        imp.handle_request(handler, self.sessions)
        self.assertEqual(handler.sent[1]['items'][0]['keyLast4'], KEY_B[-4:])
        cancel = FakeHandler(imp.PREFIX + 'cancel', json.dumps({'importId': handler.sent[1]['importId']}).encode(), 'application/json')
        imp.handle_request(cancel, self.sessions)
        late = FakeHandler(imp.PREFIX + 'commit', json.dumps({'importId': handler.sent[1]['importId'], 'selected': [0]}).encode(), 'application/json')
        imp.handle_request(late, self.sessions); self.assertEqual(late.sent[0], 410)
        junk = FakeHandler(imp.PREFIX + 'preview', b'not a database at all')
        imp.handle_request(junk, self.sessions); self.assertEqual(junk.sent[0], 400)
        chunked = FakeHandler(imp.PREFIX + 'preview', b'x'); chunked.headers['Transfer-Encoding'] = 'chunked'
        imp.handle_request(chunked, self.sessions); self.assertEqual(chunked.sent[0], 400)
        huge = FakeHandler(imp.PREFIX + 'preview', b'x'); huge.headers['Content-Length'] = str(imp.MAX_UPLOAD + 1)
        imp.handle_request(huge, self.sessions); self.assertEqual(huge.sent[0], 413)

    def test_no_temporary_copy_is_left_behind(self):
        before = {p for p in Path(tempfile.gettempdir()).glob('aibro-ccswitch-*')}
        imp.handle_request(FakeHandler(imp.PREFIX + 'preview', self.db.read_bytes()), self.sessions)
        after = {p for p in Path(tempfile.gettempdir()).glob('aibro-ccswitch-*')}
        self.assertEqual(before, after)

    def test_the_module_reads_only_the_one_default_file_through_home(self):
        source = (Path(__file__).resolve().parents[1] / 'app' / 'ccswitch_import.py').read_text()
        code = '\n'.join(line for line in source.splitlines() if not line.lstrip().startswith(('#', '"""')))
        self.assertNotIn('Path.home', code); self.assertNotIn('/Users/', code)
        self.assertEqual(code.count('expanduser'), 1, 'only default_db_path resolves HOME')
        for call in ('listdir', 'scandir', 'glob(', 'iterdir', 'walk('): self.assertNotIn(call, code)


class DefaultLocationTests(unittest.TestCase):
    """HOME is redirected to a temporary folder; the real ~/.cc-switch is never read."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved = os.environ.get('HOME')
        os.environ['HOME'] = self.tmp.name
        self.sessions = imp.ImportSessions()
        self.folder = Path(self.tmp.name) / '.cc-switch'
    def tearDown(self):
        if self.saved is None: os.environ.pop('HOME', None)
        else: os.environ['HOME'] = self.saved
        self.tmp.cleanup()

    def call(self, **kwargs):
        handler = FakeHandler(imp.PREFIX + 'default', b'{}', 'application/json', **kwargs)
        imp.handle_request(handler, self.sessions)
        return handler.sent

    def install(self, current='k1'):
        self.folder.mkdir(); make_db(self.folder / 'cc-switch.db')
        connection = sqlite3.connect(self.folder / 'cc-switch.db')
        connection.execute('UPDATE providers SET is_current = 1 WHERE id = ?', (current,)); connection.execute("UPDATE providers SET notes = 'cc desktop' WHERE id = 'c1'")
        connection.commit(); connection.close()

    def test_default_path_follows_home(self):
        self.assertEqual(imp.default_db_path(), self.folder / 'cc-switch.db')

    def test_missing_default_database_reports_not_found_without_creating_anything(self):
        status, body = self.call()
        self.assertEqual(status, 200); self.assertFalse(body['found']); self.assertEqual(body['path'], str(self.folder / 'cc-switch.db'))
        self.assertFalse(self.folder.exists())

    def test_default_database_is_listed_with_current_marker_and_masked_keys(self):
        self.install()
        status, body = self.call()
        self.assertEqual(status, 200); self.assertTrue(body['found'])
        text = json.dumps(body)
        for key in (KEY_A, KEY_B, KEY_C): self.assertNotIn(key, text)
        items = {i['name']: i for i in body['items']}
        self.assertTrue(items['Claude Relay']['current']); self.assertFalse(items['Relay A']['current'])
        self.assertEqual(items['Relay A']['notes'], 'cc desktop')
        self.assertEqual(items['Official Claude']['status'], 'skipped'); self.assertEqual(items['Official Claude']['reason'], 'no_usable_key')
        self.assertEqual(items['Local no key']['status'], 'no_key')
        commit = FakeHandler(imp.PREFIX + 'commit', json.dumps({'importId': body['importId'], 'selected': [items['Relay A']['index']]}).encode(), 'application/json')
        imp.handle_request(commit, self.sessions)
        self.assertEqual(commit.sent[1]['items'][0]['token'], KEY_A)

    def test_default_database_is_left_untouched_and_no_copy_remains(self):
        self.install()
        path = self.folder / 'cc-switch.db'; before = path.read_bytes(); names = sorted(p.name for p in self.folder.iterdir())
        stale = {p for p in Path(tempfile.gettempdir()).glob('aibro-ccswitch-*')}
        self.call()
        self.assertEqual(path.read_bytes(), before); self.assertEqual(sorted(p.name for p in self.folder.iterdir()), names)
        self.assertEqual({p for p in Path(tempfile.gettempdir()).glob('aibro-ccswitch-*')}, stale)

    def test_wal_side_file_is_included_so_recent_changes_show(self):
        self.install()
        live = sqlite3.connect(self.folder / 'cc-switch.db'); live.execute('PRAGMA journal_mode=WAL')
        live.execute("INSERT INTO providers (id, app_type, name, settings_config) VALUES ('w1', 'claude', 'Fresh WAL', ?)", (json.dumps({'env': {'ANTHROPIC_BASE_URL': 'https://wal.example.invalid', 'ANTHROPIC_AUTH_TOKEN': KEY_C}}),))
        live.commit()
        try:
            status, body = self.call()
            self.assertIn('Fresh WAL', [i['name'] for i in body['items']])
        finally: live.close()

    def test_default_endpoint_is_window_only_and_refuses_non_databases(self):
        self.install()
        self.assertEqual(self.call(origin=False)[0], 403); self.assertEqual(self.call(host='10.0.0.5')[0], 403)
        (self.folder / 'cc-switch.db').write_bytes(b'not a database at all')
        self.assertEqual(self.call()[0], 400)


if __name__ == '__main__':
    unittest.main()
