"""The 'oauth' login mode through the real HTTP handler, backed by a fake ChatGPT service."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'app'))
import chatgpt_oauth as oauth
from chatgpt_bridge import ChatGPTBridge

spec = importlib.util.spec_from_file_location('chatgpt_bridge_test', ROOT / 'tests' / 'chatgpt-bridge.test.py')
fake_module = importlib.util.module_from_spec(spec); spec.loader.exec_module(fake_module)


class Http(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        with patch.dict(os.environ, {'AI_WORKSTATION_DATA_DIR': cls.directory.name}):
            import server
        cls.server = server
        cls.svc = fake_module.Service()
        cls.vault = oauth.MemoryVault()
        cls.vault.value = {'refresh_token': 'r0', 'account_id': 'acct-9', 'email': 'a@b.c', 'plan': 'pro'}
        client = oauth.ChatGPTOAuth(cls.vault, auth_origin=cls.svc.origin, api_origin=cls.svc.origin)
        cls.originals = (server.CHATGPT_OAUTH, server.CHATGPT_BRIDGE)
        server.CHATGPT_OAUTH, server.CHATGPT_BRIDGE = client, ChatGPTBridge(client, api_origin=cls.svc.origin)
        class Quiet(server.Handler):
            def log_message(self, *args): pass
        cls.httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), Quiet)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.origin = f'http://127.0.0.1:{cls.httpd.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown(); cls.httpd.server_close(); cls.svc.close()
        cls.server.CHATGPT_OAUTH, cls.server.CHATGPT_BRIDGE = cls.originals
        cls.directory.cleanup()

    def call(self, path, body=None, origin=True):
        headers = {'Content-Type': 'application/json'}
        if origin: headers['Origin'] = self.origin
        request = urllib.request.Request(self.origin + path, data=None if body is None else json.dumps(body).encode(), headers=headers, method='GET' if body is None else 'POST')
        try:
            with urllib.request.urlopen(request, timeout=10) as response: return response.status, response.read()
        except urllib.error.HTTPError as error: return error.code, error.read()

    def test_status_models_detect_test_usage(self):
        self.svc.reject_tokens = set()
        self.server.CHATGPT_BRIDGE._models = None
        self.svc.models_body = {'models': [{'slug': 'gpt-x', 'display_name': 'GPT X', 'supported_reasoning_levels': [{'effort': 'low'}]}]}
        self.svc.usage_body = {'rate_limit': {'primary_window': {'used_percent': 3, 'limit_window_seconds': 18000, 'reset_at': 1800000000}}}
        code, data = self.call('/__auth/status?mode=oauth')
        status = json.loads(data)
        self.assertEqual((code, status['authenticated'], status['account']['email'], status['runtime']), (200, True, 'a@b.c', 'chatgpt-oauth'))
        self.assertNotIn('r0', data.decode())
        self.assertEqual(json.loads(self.call('/__auth/models?mode=oauth')[1])['data'][0]['id'], 'gpt-x')
        detect = json.loads(self.call('/__codex/detect?mode=oauth')[1])
        self.assertEqual((detect['installed'], detect['loggedIn']), (True, True))
        test = json.loads(self.call('/__codex/test?mode=oauth', {})[1])
        self.assertTrue(test['ok']); self.assertEqual(test['modelCount'], 1)
        self.assertEqual(json.loads(self.call('/__auth/usage?mode=oauth')[1])['windows'][0]['name'], 'five_hour')

    def test_origin_is_enforced_and_respond_streams(self):
        self.svc.reject_tokens = set()
        self.assertEqual(self.call('/__auth/login?mode=oauth', {}, origin=False)[0], 403)
        self.assertEqual(self.call('/__codex/respond', {'mode': 'oauth', 'input': 'hi'}, origin=False)[0], 403)
        self.svc.responses_script = lambda h: self.svc.sse(h, [{'type': 'response.output_text.delta', 'delta': 'yo'}, {'type': 'response.completed', 'response': {}}])
        code, data = self.call('/__codex/respond', {'mode': 'oauth', 'model': 'gpt-x', 'input': 'hi'})
        text = data.decode()
        self.assertEqual(code, 200); self.assertIn('response.output_text.delta', text); self.assertIn('response.completed', text)
        code, data = self.call('/__codex/respond', {'mode': 'oauth', 'input': [{'role': 'user', 'content': [{'type': 'input_file', 'file_data': 'x'}]}]})
        self.assertEqual((code, json.loads(data)['error']['code']), (400, 'unsupported_file_input'))


    def test_kernel_channel_relays_sse_with_sanitised_body(self):
        self.svc.reject_tokens = set()
        self.svc.responses_script = lambda h: self.svc.sse(h, [{'type': 'response.output_text.delta', 'delta': 'k'}, {'type': 'response.completed', 'response': {}}])
        body = {'model': 'gpt-x', 'temperature': 0.2, 'stream': False, 'store': True, 'max_output_tokens': 5,
                'input': [{'role': 'system', 'content': 'rules'}, {'role': 'user', 'content': [{'type': 'input_text', 'text': 'go'}]},
                          {'type': 'function_call_output', 'call_id': 'c1', 'output': '{}'}],
                'tools': [{'type': 'function', 'name': 't', 'parameters': {'type': 'object'}}]}
        code, data = self.call('/__chatgpt/responses', body)
        self.assertEqual(code, 200); self.assertIn('response.completed', data.decode())
        sent = json.loads([r for r in self.svc.requests if r['path'] == '/backend-api/codex/responses'][-1]['body'])
        self.assertEqual((sent['store'], sent['stream'], sent['instructions']), (False, True, 'rules'))
        self.assertNotIn('temperature', sent); self.assertNotIn('max_output_tokens', sent)
        self.assertEqual([i.get('role') or i['type'] for i in sent['input']], ['user', 'function_call_output'])
        self.assertEqual(sent['tools'][0]['name'], 't')
        self.assertEqual(self.call('/__chatgpt/responses', body, origin=False)[0], 403)

    def test_kernel_channel_reports_quota_without_upstream_text(self):
        self.svc.reject_tokens = set()
        def limited(h):
            data = b'{"error":"usage_limit_reached","secret":"ACCOUNT-SECRET"}'
            h.send_response(429); h.send_header('Content-Length', str(len(data))); h.end_headers(); h.wfile.write(data)
        self.svc.responses_script = limited
        code, data = self.call('/__chatgpt/responses', {'model': 'gpt-x', 'input': [{'role': 'user', 'content': 'x'}]})
        self.assertEqual((code, json.loads(data)['error']['code']), (429, 'chatgpt_quota'))
        self.assertNotIn('ACCOUNT-SECRET', data.decode())


if __name__ == '__main__':
    unittest.main()
