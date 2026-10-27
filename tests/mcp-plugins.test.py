import json, os, stat, subprocess, sys, tempfile, threading, time, unittest
from pathlib import Path

host = tempfile.TemporaryDirectory(prefix='aibro-mcp-host-'); os.environ.setdefault('AI_WORKSTATION_DATA_DIR', host.name)
from plugin_store import PluginStore
from plugin_secrets import MemorySecrets
import mcp_plugins
from mcp_plugins import McpPlugins, McpError, validate_transport

FIXTURE = str(Path(__file__).resolve().parent / 'fixtures' / 'mcp-fixture-server.py')
os.chmod(FIXTURE, os.stat(FIXTURE).st_mode | stat.S_IXUSR)


class Clock:
    def __init__(self): self.now = 1000.0
    def __call__(self): return self.now


class McpPluginTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.store = PluginStore(self.tmp.name); self.clock = Clock()
        self.mcp = McpPlugins(self.store, idle_seconds=30, call_timeout=5, clock=self.clock, reaper=False, secrets=MemorySecrets())
        self.addCleanup(self.mcp.shutdown)

    def add(self, args=None, **extra):
        probe = self.mcp.probe({'kind': 'stdio', 'command': FIXTURE, 'args': args or []})
        return self.mcp.add({'probeId': probe['probeId'], 'name': 'Vocab', **extra})

    def run_call(self, plugin_id, tool, arguments=None, approve=True, **extra):
        call = self.mcp.propose({'pluginId': plugin_id, 'tool': tool, 'arguments': arguments or {}, 'runId': 'run1', **extra})
        if call['needsApproval']:
            if approve is None: return call
            self.mcp.decide(call['id'], approve)
            if not approve: return call
        return self.mcp.run(call['id'])

    def test_refuses_package_runners_and_non_loopback(self):
        for transport in [{'kind': 'stdio', 'command': '/usr/bin/env', 'args': ['python3']},
                          {'kind': 'stdio', 'command': sys.executable, 'args': ['-c', 'import os; os.system("npx some-server")']},
                          {'kind': 'stdio', 'command': '/bin/sh', 'args': ['-c', 'uvx tool']},
                          {'kind': 'stdio', 'command': 'npx', 'args': []},
                          {'kind': 'stdio', 'command': '/no/such/server', 'args': []},
                          {'kind': 'http', 'url': 'http://example.com:80/mcp'},
                          {'kind': 'http', 'url': 'https://127.0.0.1:443/mcp'},
                          {'kind': 'http', 'url': 'http://user:pw@127.0.0.1:9/mcp'},
                          {'kind': 'ws', 'url': 'ws://127.0.0.1:9'}]:
            with self.assertRaises(McpError, msg=json.dumps(transport)): validate_transport(transport)
        npx = Path(self.tmp.name, 'npx'); npx.write_text('#!/bin/sh\n'); npx.chmod(0o755)
        with self.assertRaises(McpError) as refused: validate_transport({'kind': 'stdio', 'command': str(npx)})
        self.assertEqual(refused.exception.code, 'mcp_installer_refused')
        self.assertEqual(validate_transport({'kind': 'http', 'url': 'http://localhost:8765/mcp'})['url'], 'http://localhost:8765/mcp')

    def test_probe_lists_tools_and_add_defaults_every_tool_to_ask(self):
        probe = self.mcp.probe({'kind': 'stdio', 'command': FIXTURE, 'args': []})
        self.assertEqual([t['name'] for t in probe['tools']][:2], ['lookup_word', 'add_word'])
        self.assertIn('无法强制', probe['notice'])
        self.assertEqual(self.mcp.running(), [], 'testing the connection leaves nothing running')
        # A read-only tier the user did not confirm for that tool stays "ask".
        entry = self.mcp.add({'probeId': probe['probeId'], 'name': 'Vocab', 'tiers': {'lookup_word': 'readonly', 'add_word': 'readonly'}, 'confirmReadonly': ['lookup_word']})
        tiers = {t['name']: t['tier'] for t in entry['tools']}
        self.assertEqual(tiers['lookup_word'], 'readonly'); self.assertEqual(tiers['add_word'], 'ask'); self.assertEqual(tiers['env_report'], 'ask')
        self.assertEqual(entry['id'], 'vocab'); self.assertEqual(entry['tools'][1]['localName'], 'vocab__add_word')
        with self.assertRaises(McpError): self.mcp.add({'probeId': probe['probeId']})  # a probe is used once
        saved = json.loads(Path(self.tmp.name, 'plugins', 'plugins.json').read_text())
        self.assertEqual(saved['mcp'][0]['transport'], {'kind': 'stdio', 'command': FIXTURE, 'args': []})

    def test_lazy_start_write_needs_approval_and_idle_stop(self):
        entry = self.add()
        self.assertEqual(self.mcp.running(), [], 'nothing starts until the first call')
        call = self.run_call(entry['id'], 'vocab__add_word', {'word': 'ephemeral', 'meaning': '短暂的'}, approve=None)
        self.assertTrue(call['needsApproval']); self.assertEqual(call['status'], 'pending')
        self.assertEqual(self.mcp.running(), ['vocab'])
        with self.assertRaises(McpError) as refused: self.mcp.run(call['id'])
        self.assertEqual(refused.exception.code, 'mcp_not_approved')
        self.mcp.decide(call['id'], True)
        result = self.mcp.run(call['id'])
        self.assertEqual((result['text'], result['untrusted']), ('saved ephemeral', True))
        with self.assertRaises(McpError): self.mcp.run(call['id'])  # once only
        self.assertTrue(Path(self.tmp.name, 'plugins', 'data', 'vocab', 'words.json').exists(), 'the server works in its own data directory')
        rejected = self.run_call(entry['id'], 'vocab__add_word', {'word': 'x'}, approve=False)
        with self.assertRaises(McpError): self.mcp.run(rejected['id'])
        self.clock.now += 31
        self.assertEqual(self.mcp.reap(), ['vocab']); self.assertEqual(self.mcp.running(), [])
        # Starts again on the next call.
        self.mcp.set_tier('vocab', 'lookup_word', 'readonly', confirm=True)
        self.assertIn('短暂的', self.run_call('vocab', 'vocab__lookup_word', {'word': 'ephemeral'})['text'])

    def test_readonly_needs_explicit_confirmation_and_disabled_tools_are_refused(self):
        self.add()
        with self.assertRaises(McpError) as unconfirmed: self.mcp.set_tier('vocab', 'lookup_word', 'readonly')
        self.assertEqual(unconfirmed.exception.code, 'mcp_confirm_required')
        self.mcp.set_tier('vocab', 'lookup_word', 'readonly', confirm=True)
        self.assertFalse(self.mcp.propose({'pluginId': 'vocab', 'tool': 'vocab__lookup_word', 'arguments': {'word': 'a'}})['needsApproval'])
        self.assertTrue(self.mcp.propose({'pluginId': 'vocab', 'tool': 'vocab__lookup_word', 'arguments': {'word': 'a'}, 'forceApproval': True})['needsApproval'], 'request-approval mode asks anyway')
        self.mcp.set_tier('vocab', 'add_word', 'disabled')
        with self.assertRaises(McpError): self.mcp.propose({'pluginId': 'vocab', 'tool': 'vocab__add_word', 'arguments': {}})

    def test_default_tier_applies_to_followers_only(self):
        entry = self.add()
        self.assertEqual(entry['defaultTier'], 'ask')
        with self.assertRaises(McpError) as unconfirmed: self.mcp.set_default_tier('vocab', 'readonly')
        self.assertEqual(unconfirmed.exception.code, 'mcp_confirm_required')
        self.mcp.set_tier('vocab', 'env_report', 'disabled')
        done = self.mcp.set_default_tier('vocab', 'readonly', confirm=True)
        tiers = {t['name']: t['tier'] for t in done['tools']}
        self.assertEqual(done['defaultTier'], 'readonly')
        self.assertEqual(tiers['lookup_word'], 'readonly', 'a tool that follows the default moves with it')
        self.assertEqual(tiers['add_word'], 'ask', 'a tool that declares writes never gets blanket no-approval')
        self.assertEqual(tiers['slow'], 'ask', 'nor does a tool that declares nothing')
        self.assertEqual(tiers['env_report'], 'disabled', 'a tool set by hand keeps its own tier')
        back = self.mcp.set_default_tier('vocab', 'ask')
        tiers = {t['name']: t['tier'] for t in back['tools']}
        self.assertEqual((back['defaultTier'], tiers['lookup_word'], tiers['env_report']), ('ask', 'ask', 'disabled'))
        gone = self.mcp.set_default_tier('vocab', 'disabled')
        self.assertEqual({t['tier'] for t in gone['tools']}, {'disabled'})
        with self.assertRaises(McpError): self.mcp.set_default_tier('vocab', 'bogus')

    def test_add_with_default_tier_needs_confirmation(self):
        probe = self.mcp.probe({'kind': 'stdio', 'command': FIXTURE, 'args': []})
        entry = self.mcp.add({'probeId': probe['probeId'], 'name': 'Vocab', 'defaultTier': 'readonly'})
        self.assertEqual({t['tier'] for t in entry['tools']}, {'ask'}, 'readonly default without confirmation falls back to ask')
        self.mcp.remove('vocab')
        probe = self.mcp.probe({'kind': 'stdio', 'command': FIXTURE, 'args': []})
        entry = self.mcp.add({'probeId': probe['probeId'], 'name': 'Vocab', 'defaultTier': 'readonly', 'confirmDefault': True})
        tiers = {t['name']: t['tier'] for t in entry['tools']}
        self.assertEqual((tiers['lookup_word'], tiers['add_word']), ('readonly', 'ask'))

    def test_env_secrets_go_to_keychain_store_and_only_into_that_server(self):
        secret = 'sk-live-ABCDEFGH1234'
        probe = self.mcp.probe({'kind': 'stdio', 'command': FIXTURE, 'args': []}, env={'MY_API_KEY': secret, 'OTHER': 'x'})
        entry = self.mcp.add({'probeId': probe['probeId'], 'name': 'Vocab', 'includeEnv': ['MY_API_KEY'], 'source': {'kind': 'paste'}})
        self.assertEqual(entry['env'], ['MY_API_KEY'])
        self.assertEqual(self.mcp.secrets.get('vocab', 'MY_API_KEY'), secret)
        self.assertIsNone(self.mcp.secrets.get('vocab', 'OTHER'), 'unticked variables are dropped')
        self.assertNotIn(secret, Path(self.tmp.name, 'plugins', 'plugins.json').read_text())
        self.assertNotIn(secret, json.dumps(self.mcp.snapshot()))
        report = json.loads(self.run_call('vocab', 'vocab__env_report')['text'])
        self.assertIn('MY_API_KEY', report['names']); self.assertNotIn('OTHER', report['names'])
        self.mcp.remove('vocab')
        self.assertIsNone(self.mcp.secrets.get('vocab', 'MY_API_KEY'), 'removing the plugin removes its keychain items')

    def test_import_flow_text_to_probe(self):
        parsed = self.mcp.import_parse('text', {'text': json.dumps({'mcpServers': {'vocab': {'command': FIXTURE, 'env': {'K': 'secret-value-9'}}, 'search': {'command': 'npx', 'args': ['-y', 'x-mcp']}}})})
        self.assertNotIn('secret-value-9', json.dumps(parsed))
        self.assertEqual([s['status'] for s in parsed['servers']], ['ready', 'needs_install'])
        with self.assertRaises(McpError) as refused: self.mcp.import_probe(parsed['importId'], 1)
        self.assertEqual(refused.exception.code, 'mcp_installer_refused')
        probe = self.mcp.import_probe(parsed['importId'], 0)
        self.assertEqual(probe['candidate']['env'], ['K'])
        entry = self.mcp.add({'probeId': probe['probeId'], 'name': 'Vocab', 'includeEnv': ['K']})
        self.assertEqual(self.mcp.secrets.get(entry['id'], 'K'), 'secret-value-9')
        # After installing, the user supplies the real command line for the second one.
        fixed = self.mcp.import_probe(parsed['importId'], 1, command_line=FIXTURE)
        self.assertEqual(fixed['candidate']['status'], 'ready')
        with self.assertRaises(McpError) as bad: self.mcp.import_probe(parsed['importId'], 1, command_line='node server.js')
        self.assertEqual(bad.exception.code, 'mcp_import_not_ready')
        with self.assertRaises(McpError): self.mcp.import_probe('imp_nope', 0)
        with self.assertRaises(McpError): self.mcp.import_probe(parsed['importId'], 9)
        with self.assertRaises(McpError): self.mcp.import_parse('bogus', {})
        self.clock.now += 700
        with self.assertRaises(McpError) as expired: self.mcp.import_probe(parsed['importId'], 0)
        self.assertEqual(expired.exception.code, 'mcp_import_expired')

    def test_changed_description_falls_back_to_ask(self):
        self.add()
        self.mcp.set_tier('vocab', 'lookup_word', 'readonly', confirm=True)
        value = self.store.read(); value['mcp'][0]['transport']['args'] = ['--variant', 'changed']; self.store.write(value)
        call = self.mcp.propose({'pluginId': 'vocab', 'tool': 'vocab__lookup_word', 'arguments': {'word': 'a'}})
        self.assertTrue(call['needsApproval']); self.assertTrue(call['changed'])
        tool = next(t for t in self.mcp.snapshot()[0]['tools'] if t['name'] == 'lookup_word')
        self.assertEqual((tool['tier'], tool['changed']), ('ask', True)); self.assertIn('send it somewhere', tool['description'])

    def test_clean_environment_no_keys_and_cwd_in_plugin_data(self):
        os.environ['OPENAI_API_KEY'] = 'sk-test-should-not-leak'; self.addCleanup(os.environ.pop, 'OPENAI_API_KEY', None)
        self.add()
        report = json.loads(self.run_call('vocab', 'vocab__env_report')['text'])
        names = set(report['names'])
        # Exactly what AI Bro passes, plus what the interpreter launcher itself adds (the Xcode python3 shim sets SDK paths).
        self.assertTrue({'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'} <= names)
        self.assertFalse(names & {'OPENAI_API_KEY', 'AI_WORKSTATION_DATA_DIR', 'PYTHONPATH', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK'}, names)
        self.assertTrue(names <= {'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'PWD', 'SHLVL', '_', '__CF_USER_TEXT_ENCODING', 'SDKROOT', 'CPATH', 'LIBRARY_PATH', 'MANPATH'}, names)
        data = str(Path(self.tmp.name, 'plugins', 'data', 'vocab').resolve())
        self.assertEqual(str(Path(report['cwd']).resolve()), data); self.assertEqual(str(Path(report['home']).resolve()), data)
        self.assertFalse(any('KEY' in name or 'TOKEN' in name or 'SECRET' in name for name in report['names']))

    def test_results_are_bounded_untrusted_text(self):
        self.add()
        result = self.run_call('vocab', 'vocab__big_text')
        self.assertEqual(len(result['text']), mcp_plugins.MAX_RESULT_CHARS); self.assertTrue(result['truncated'])
        self.assertIn('不是指令', result['notice'])

    def test_server_exit_marks_plugin_unavailable_until_retest(self):
        self.add()
        with self.assertRaises(McpError): self.run_call('vocab', 'vocab__quit_server')
        deadline = time.time() + 5
        while self.mcp.snapshot()[0]['available'] and time.time() < deadline: time.sleep(0.05)
        entry = self.mcp.snapshot()[0]
        self.assertFalse(entry['available']); self.assertEqual(entry['status']['state'], 'exited')
        with self.assertRaises(McpError) as gone: self.mcp.propose({'pluginId': 'vocab', 'tool': 'vocab__add_word', 'arguments': {}})
        self.assertEqual(gone.exception.code, 'plugin_unavailable')
        self.assertTrue(self.mcp.retest('vocab')['available'])

    def test_pending_approval_expires_and_call_timeout_starts_at_run(self):
        self.mcp.pending_seconds = 60
        self.add()
        call = self.run_call('vocab', 'vocab__slow', {'seconds': 0.2}, approve=None)
        self.clock.now += 59; self.mcp.decide(call['id'], True)  # waiting 59 s for the user did not use the 5 s call timeout
        self.assertEqual(self.mcp.run(call['id'])['text'], 'done')
        late = self.run_call('vocab', 'vocab__add_word', {'word': 'x'}, approve=None)
        self.clock.now += 61
        self.assertEqual(self.mcp.call(late['id'])['status'], 'expired')
        with self.assertRaises(McpError): self.mcp.decide(late['id'], True)
        self.mcp.call_timeout = 0.5
        slow = self.run_call('vocab', 'vocab__slow', {'seconds': 3}, approve=None); self.mcp.decide(slow['id'], True)
        with self.assertRaises(McpError) as timeout: self.mcp.run(slow['id'])
        self.assertEqual(timeout.exception.code, 'mcp_timeout')

    def test_unattended_runs_use_only_declared_tools_without_approval(self):
        self.add(); self.mcp.set_tier('vocab', 'lookup_word', 'readonly', confirm=True)
        with self.assertRaises(McpError) as undeclared: self.mcp.propose({'pluginId': 'vocab', 'tool': 'vocab__lookup_word', 'arguments': {'word': 'a'}, 'unattended': True, 'declaredTools': []})
        self.assertEqual(undeclared.exception.code, 'mcp_not_declared')
        with self.assertRaises(McpError) as person: self.mcp.propose({'pluginId': 'vocab', 'tool': 'vocab__add_word', 'arguments': {}, 'unattended': True, 'declaredTools': ['vocab__add_word']})
        self.assertEqual(person.exception.code, 'mcp_needs_person')
        self.assertFalse(self.mcp.propose({'pluginId': 'vocab', 'tool': 'vocab__lookup_word', 'arguments': {'word': 'a'}, 'unattended': True, 'declaredTools': ['vocab__lookup_word']})['needsApproval'])

    def test_disable_and_remove_stop_the_server(self):
        self.add(); self.mcp.set_tier('vocab', 'lookup_word', 'readonly', confirm=True)
        self.run_call('vocab', 'vocab__lookup_word', {'word': 'a'}); self.assertEqual(self.mcp.running(), ['vocab'])
        self.mcp.set_enabled('vocab', False); self.assertEqual(self.mcp.running(), [])
        with self.assertRaises(McpError) as disabled: self.mcp.propose({'pluginId': 'vocab', 'tool': 'vocab__lookup_word', 'arguments': {}})
        self.assertEqual(disabled.exception.code, 'plugin_disabled')
        self.mcp.set_enabled('vocab', True)
        pending = self.run_call('vocab', 'vocab__add_word', {'word': 'x'}, approve=None)
        self.mcp.remove('vocab')
        self.assertEqual((self.mcp.snapshot(), self.mcp.running()), ([], []))
        with self.assertRaises(McpError): self.mcp.decide(pending['id'], True)
        self.assertTrue(Path(self.tmp.name, 'plugins', 'data', 'vocab').is_dir(), 'data stays on disk')

    def test_loopback_http_transport(self):
        process = subprocess.Popen([sys.executable, FIXTURE, '--http', '0'], stdout=subprocess.PIPE, text=True)
        self.addCleanup(process.wait); self.addCleanup(process.terminate)
        url = process.stdout.readline().strip()
        probe = self.mcp.probe({'kind': 'http', 'url': url})
        self.assertEqual(probe['serverInfo']['name'], 'vocab-fixture')
        entry = self.mcp.add({'probeId': probe['probeId'], 'name': 'Remote vocab', 'tiers': {'lookup_word': 'readonly'}, 'confirmReadonly': ['lookup_word']})
        self.assertEqual(entry['id'], 'remotevocab')
        self.assertIn('"word": "w"', self.run_call('remotevocab', 'remotevocab__lookup_word', {'word': 'w'})['text'])


class McpHttpEndpointTests(unittest.TestCase):
    def setUp(self):
        import server, urllib.request
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        server.PLUGIN_STORE = PluginStore(self.tmp.name)
        server.MCP_PLUGINS = McpPlugins(server.PLUGIN_STORE, reaper=False); self.addCleanup(server.MCP_PLUGINS.shutdown)
        self.httpd = server.LoopbackHTTPServer(('127.0.0.1', 0), server.Handler)
        server.PORT = self.port = self.httpd.server_port
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close); self.addCleanup(self.httpd.shutdown)

    def call(self, path, body=None, origin='self'):
        import urllib.request, urllib.error
        origin = f'http://127.0.0.1:{self.port}' if origin == 'self' else origin
        headers = {'Content-Type': 'application/json', **({'Origin': origin} if origin else {})}
        req = urllib.request.Request(f'http://127.0.0.1:{self.port}{path}', data=json.dumps(body).encode() if body is not None else None, headers=headers, method='POST' if body is not None else 'GET')
        try:
            with urllib.request.urlopen(req, timeout=20) as r: return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')

    def test_add_flow_and_call_over_http(self):
        status, probe = self.call('/__plugins/mcp/probe', {'transport': {'kind': 'stdio', 'command': FIXTURE, 'args': []}})
        self.assertEqual(status, 200, probe)
        status, added = self.call('/__plugins/mcp/add', {'probeId': probe['probeId'], 'name': 'Vocab'})
        self.assertEqual(status, 200, added)
        listed = self.call('/__plugins', origin=None)[1]['mcp']
        self.assertEqual([p['id'] for p in listed], ['vocab'])
        status, call = self.call('/__plugins/mcp/propose', {'pluginId': 'vocab', 'tool': 'vocab__add_word', 'arguments': {'word': 'a'}})
        self.assertTrue(call['needsApproval'])
        self.assertEqual(self.call('/__plugins/mcp/calls/run', {'callId': call['id']})[0], 403)
        self.assertEqual(self.call('/__plugins/mcp/calls/decide', {'callId': call['id'], 'approve': True}, origin='https://evil.example')[0], 403)
        self.assertEqual(self.call('/__plugins/mcp/calls/decide', {'callId': call['id'], 'approve': True})[0], 200)
        status, result = self.call('/__plugins/mcp/calls/run', {'callId': call['id']})
        self.assertEqual((status, result['text']), (200, 'saved a'))
        self.assertEqual(self.call('/__plugins/mcp/probe', {'transport': {'kind': 'stdio', 'command': '/usr/bin/env', 'args': ['npx', 'x']}})[1]['code'], 'mcp_installer_refused')
        status, parsed = self.call('/__plugins/import/parse', {'kind': 'text', 'text': 'claude mcp add v -- ' + FIXTURE})
        self.assertEqual((status, parsed['servers'][0]['status']), (200, 'ready'))
        self.assertEqual(self.call('/__plugins/import/parse', {'kind': 'text', 'text': '{bad'})[0], 400)
        self.assertEqual(self.call('/__plugins/import/parse', {'kind': 'text', 'text': '{}'}, origin='https://evil.example')[0], 403)
        status, probed = self.call('/__plugins/import/probe', {'importId': parsed['importId'], 'index': 0})
        self.assertEqual(status, 200, probed)
        self.assertEqual(self.call('/__plugins/mcp/default-tier', {'id': 'vocab', 'tier': 'readonly'})[1]['code'], 'mcp_confirm_required')
        status, snap = self.call('/__plugins/mcp/default-tier', {'id': 'vocab', 'tier': 'readonly', 'confirm': True})
        self.assertEqual((status, snap['mcp'][0]['defaultTier']), (200, 'readonly'))
        self.assertEqual(self.call('/__plugins/mcp/remove', {'id': 'vocab'})[0], 200)


if __name__ == '__main__':
    unittest.main()
