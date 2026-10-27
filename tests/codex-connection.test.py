"""Codex CLI connection: detection, availability test, shared/private modes and the per-version model cache.

A stub `codex` executable stands in for the CLI. Nothing here signs in, reads a credential file or sends a model request.
"""
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1] / 'app'
sys.path.insert(0, str(ROOT))
from codex_bridge import BridgeError, CodexBridge, runtime_command, runtime_config, shared_config
from codex_connection import CodexConnection, parse_version

STUB = r'''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
log = os.environ.get('STUB_LOG')
def note(entry):
    if log:
        with open(log, 'a') as f: f.write(json.dumps(entry) + '\n')
env = {'CODEX_HOME': os.environ.get('CODEX_HOME'), 'OPENAI_API_KEY': os.environ.get('OPENAI_API_KEY'), 'CODEX_API_KEY': os.environ.get('CODEX_API_KEY')}
if args == ['--version']:
    note({'argv': args, 'env': env}); print('codex-cli ' + os.environ.get('STUB_VERSION', '9.9.9')); sys.exit(0)
if args[:2] == ['login', 'status']:
    note({'argv': args, 'env': env}); print('Logged in using ChatGPT (secret-sentinel-token)'); sys.exit(int(os.environ.get('STUB_LOGIN_EXIT', '0')))
if args and args[0] == 'app-server':
    startup = {}
    for index, arg in enumerate(args[:-1]):
        if arg == '-c':
            key, value = args[index + 1].split('=', 1); startup[key] = json.loads(value)
    note({'argv': ['app-server'], 'env': env, 'startup': startup, 'cwd': os.getcwd()})
    for line in sys.stdin:
        m = json.loads(line); method = m.get('method'); i = m.get('id')
        if i is None or not method: continue
        note({'rpc': method})
        result = {}
        if method == 'account/read':
            result = {'account': {'type': os.environ.get('STUB_ACCOUNT', 'chatgpt'), 'email': 'user@example.invalid', 'planType': 'plus'}}
        elif method == 'model/list':
            result = {'data': [{'id': 'm-1', 'model': 'm-1', 'displayName': 'Model 1', 'isDefault': True, 'inputModalities': ['text'], 'hidden': False,
                                'supportedReasoningEfforts': [{'reasoningEffort': 'low', 'description': ''}, {'reasoningEffort': 'high', 'description': ''}], 'defaultReasoningEffort': 'low'}]}
        print(json.dumps({'id': i, 'result': result}), flush=True)
    sys.exit(0)
sys.exit(2)
'''


def make_stub(directory):
    path = Path(directory) / 'codex'
    path.write_text(STUB); path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


class CodexConnectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='codex-connection-'); self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / 'data'; self.data.mkdir()
        self.bin = Path(self.temp.name) / 'bin'; self.bin.mkdir()
        self.stub = make_stub(self.bin)
        self.log = Path(self.temp.name) / 'stub.log'
        env = {'STUB_LOG': str(self.log), 'STUB_VERSION': '9.9.9', 'STUB_LOGIN_EXIT': '0', 'OPENAI_API_KEY': 'sk-must-not-pass', 'CODEX_API_KEY': 'must-not-pass'}
        patcher = patch.dict(os.environ, env); patcher.start(); self.addCleanup(patcher.stop)
        os.environ.pop('CODEX_HOME', None)
        self.bridges = {}
        self.connection = CodexConnection(self.data, self.bridge, command=[str(self.stub)])
        self.addCleanup(lambda: [b.close() for b in self.bridges.values()])

    def bridge(self, mode):
        if mode not in self.bridges: self.bridges[mode] = CodexBridge(self.data, command=[str(self.stub)], mode=mode)
        return self.bridges[mode]

    def entries(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_not_installed(self):
        connection = CodexConnection(self.data, self.bridge, command=[])
        self.assertEqual(connection.detect('shared'), {'mode': 'shared', 'installed': False, 'version': None, 'loggedIn': False, 'loginExitCode': None})
        self.assertEqual(connection.test('shared')['stage'], 'install')
        with self.assertRaises(BridgeError): connection.models('shared')

    def test_runtime_command_finds_the_cli_on_path(self):
        with patch.dict(os.environ, {'PATH': str(self.bin) + os.pathsep + os.environ.get('PATH', ''), 'AI_WORKSTATION_CODEX_BIN': ''}):
            self.assertIn(str(self.stub), (runtime_command() or [''])[0] if runtime_command() else '')

    def test_version_parsing(self):
        self.assertEqual(parse_version('codex-cli 0.163.0\n'), '0.163.0')
        self.assertEqual(parse_version('codex 1.2.3-beta.1'), '1.2.3-beta.1')
        self.assertIsNone(parse_version('no version here'))

    def test_shared_detection_records_only_exit_codes_and_drops_api_keys(self):
        result = self.connection.detect('shared')
        self.assertEqual((result['installed'], result['version'], result['loggedIn'], result['loginExitCode']), (True, '9.9.9', True, 0))
        self.assertNotIn('secret-sentinel-token', json.dumps(result))
        for entry in self.entries():
            self.assertIsNone(entry['env']['OPENAI_API_KEY']); self.assertIsNone(entry['env']['CODEX_API_KEY'])
            self.assertIsNone(entry['env']['CODEX_HOME'])  # the user's usual account, found by the CLI itself
        os.environ['STUB_LOGIN_EXIT'] = '1'
        result = self.connection.detect('shared')
        self.assertEqual((result['installed'], result['loggedIn'], result['loginExitCode']), (True, False, 1))

    def test_private_detection_uses_the_private_home_and_skips_login_check_before_first_login(self):
        before = self.connection.detect('private')
        self.assertEqual((before['installed'], before['loggedIn'], before['loginExitCode']), (True, False, None))
        self.assertFalse(any(e['argv'][:1] == ['login'] for e in self.entries()))
        (self.data / 'codex-auth').mkdir()
        after = self.connection.detect('private')
        self.assertTrue(after['loggedIn'])
        login = [e for e in self.entries() if e['argv'][:1] == ['login']][-1]
        self.assertEqual(login['env']['CODEX_HOME'], str((self.data / 'codex-auth').resolve()))

    def test_detection_never_opens_credential_files(self):
        home = Path(self.temp.name) / 'user-codex-home'; home.mkdir(); (home / 'auth.json').write_text('{"tokens":"sentinel"}')
        opened = []
        def hook(event, args):
            if event == 'open' and args and isinstance(args[0], (str, bytes, os.PathLike)) and str(args[0]).endswith(('auth.json', 'config.toml')): opened.append(str(args[0]))
        with patch.dict(os.environ, {'CODEX_HOME': str(home)}):
            sys.addaudithook(hook)
            self.connection.detect('shared'); self.connection.test('shared'); self.connection.models('shared', refresh=True)
        self.assertEqual(opened, [])

    def test_shared_runtime_is_locked_down_and_keeps_the_users_credential_store(self):
        config = shared_config()
        self.assertNotIn('cli_auth_credentials_store', config)
        self.assertEqual((config['sandbox_mode'], config['approval_policy']), ('read-only', 'never'))
        for key, value in runtime_config().items():
            if key != 'cli_auth_credentials_store': self.assertEqual(config[key], value, key)
        self.assertTrue(self.connection.test('shared')['ok'])
        started = next(e for e in self.entries() if e['argv'] == ['app-server'])
        self.assertEqual(started['startup']['sandbox_mode'], 'read-only'); self.assertEqual(started['startup']['features.shell_tool'], False)
        self.assertNotIn('cli_auth_credentials_store', started['startup'])
        self.assertTrue(started['cwd'].endswith('codex-shared/empty-workspace'))
        self.assertIsNone(started['env']['OPENAI_API_KEY'])
        self.assertFalse((self.data / 'codex-auth').exists())

    def test_private_runtime_still_forces_file_credentials(self):
        self.assertTrue(self.connection.detect('private')['installed'])
        (self.data / 'codex-auth').mkdir()
        self.assertTrue(self.connection.test('private')['ok'])
        started = next(e for e in self.entries() if e['argv'] == ['app-server'])
        self.assertEqual(started['startup']['cli_auth_credentials_store'], 'file')

    def test_shared_mode_never_signs_the_users_account_in_or_out(self):
        bridge = self.bridge('shared')
        with self.assertRaises(BridgeError) as login: bridge.login_start()
        self.assertEqual(login.exception.code, 'shared_login_refused')
        with self.assertRaises(BridgeError) as logout: bridge.logout()
        self.assertEqual(logout.exception.code, 'shared_logout_refused')
        self.assertEqual([e for e in self.entries() if 'rpc' in e], [])

    def test_availability_stages(self):
        os.environ['STUB_LOGIN_EXIT'] = '1'
        result = self.connection.test('shared')
        self.assertEqual((result['ok'], result['stage']), (False, 'login')); self.assertIn('codex login', result['message'])
        os.environ['STUB_LOGIN_EXIT'] = '0'; os.environ['STUB_ACCOUNT'] = 'apikey'
        self.bridge('shared').close(); self.bridges.clear()
        result = self.connection.test('shared')
        self.assertEqual((result['ok'], result['stage']), (False, 'login')); self.assertIn('ChatGPT', result['message'])
        os.environ['STUB_ACCOUNT'] = 'chatgpt'
        self.bridge('shared').close(); self.bridges.clear()
        result = self.connection.test('shared')
        self.assertEqual((result['ok'], result['stage'], result['modelCount']), (True, 'ok', 1))
        self.assertNotIn('user@example.invalid', json.dumps(result))

    def test_model_list_is_cached_per_cli_version_and_mode(self):
        calls = lambda: len([e for e in self.entries() if e.get('rpc') == 'model/list'])
        first = self.connection.models('shared')
        self.assertEqual((first['cached'], first['cliVersion'], calls()), (False, '9.9.9', 1))
        second = self.connection.models('shared')
        self.assertEqual((second['cached'], second['data'], calls()), (True, first['data'], 1))
        self.assertEqual(first['data'][0]['supportedReasoningEfforts'][1]['reasoningEffort'], 'high')
        os.environ['STUB_VERSION'] = '9.10.0'
        third = self.connection.models('shared')
        self.assertEqual((third['cached'], third['cliVersion'], calls()), (False, '9.10.0', 2))
        self.assertEqual(self.connection.models('shared', refresh=True)['cached'], False)
        self.assertEqual(calls(), 3)
        (self.data / 'codex-auth').mkdir()
        self.assertEqual(self.connection.models('private')['cached'], False)
        cache = json.loads((self.data / 'codex-models-cache.json').read_text())
        self.assertEqual(sorted(cache['entries']), ['private', 'shared'])
        self.assertNotIn('user@example.invalid', json.dumps(cache))

    def test_cache_only_listing_never_starts_the_runtime(self):
        empty = self.connection.cached_models('shared')
        self.assertEqual((empty['data'], empty['cached'], empty['stale']), ([], False, True))
        self.assertEqual([e for e in self.entries() if e.get('rpc') or e['argv'] == ['app-server']], [])
        self.connection.models('shared')
        os.environ['STUB_VERSION'] = '9.9.9'
        warm = self.connection.cached_models('shared')
        self.assertEqual((warm['cached'], len(warm['data'])), (True, 1))
        os.environ['STUB_VERSION'] = '10.0.0'
        self.assertTrue(self.connection.cached_models('shared')['stale'])

    def test_corrupt_cache_is_ignored(self):
        (self.data / 'codex-models-cache.json').write_text('{not json')
        self.assertEqual(self.connection.models('shared')['cached'], False)

    def test_http_routes_pick_the_mode_and_keep_origin_checks(self):
        with patch.dict(os.environ, {'AI_WORKSTATION_DATA_DIR': str(Path(self.temp.name) / 'http-store')}):
            import server
        saved = (server.CODEX_BRIDGE, server.CODEX_SHARED, server.CODEX_CONNECTION)
        self.addCleanup(lambda: setattr(server, 'CODEX_BRIDGE', saved[0]) or setattr(server, 'CODEX_SHARED', saved[1]) or setattr(server, 'CODEX_CONNECTION', saved[2]))
        server.CODEX_BRIDGE, server.CODEX_SHARED = self.bridge('private'), self.bridge('shared')
        server.CODEX_CONNECTION = self.connection
        class Quiet(server.Handler):
            def log_message(self, *args): pass
        httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), Quiet); thread = threading.Thread(target=httpd.serve_forever, daemon=True); thread.start()
        self.addCleanup(lambda: (httpd.shutdown(), httpd.server_close()))
        origin = f'http://127.0.0.1:{httpd.server_port}'
        def call(route, body=None, headers=None):
            headers = dict(headers or {})
            if body is not None: headers['Content-Type'] = 'application/json'
            try:
                with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(urllib.request.Request(origin + route, data=json.dumps(body).encode() if body is not None else None, headers=headers), timeout=15) as r:
                    return r.status, json.loads(r.read())
            except urllib.error.HTTPError as error:
                return error.code, json.loads(error.read())
        code, detected = call('/__codex/detect?mode=shared')
        self.assertEqual((code, detected['installed'], detected['mode']), (200, True, 'shared'))
        self.assertEqual(call('/__codex/detect?mode=shared', headers={'Origin': 'https://evil.invalid'})[0], 403)
        self.assertEqual(call('/__codex/test?mode=shared', {})[0], 403)
        code, tested = call('/__codex/test?mode=shared', {}, headers={'Origin': origin})
        self.assertEqual((code, tested['ok']), (200, True))
        code, models = call('/__auth/models?mode=shared&cache=1')
        self.assertEqual((code, models['cached']), (200, True))
        code, error = call('/__auth/logout?mode=shared', {}, headers={'Origin': origin})
        self.assertEqual((code, error['error']['code']), (409, 'shared_logout_refused'))
        code, error = call('/__auth/login?mode=shared', {}, headers={'Origin': origin})
        self.assertEqual((code, error['error']['code']), (409, 'shared_login_refused'))
        self.assertEqual(call('/__auth/status?mode=shared')[1]['authenticated'], True)


if __name__ == '__main__':
    unittest.main()
