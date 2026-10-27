"""Local client interface: loopback + bearer token, four operations, no key, off by default."""
import io
import json
from pathlib import Path
import stat
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import local_client_api as client_api
from codex_bridge import BridgeError


class Headers(dict):
    def get(self, key, default=None): return super().get(key, default)


class FakeHandler:
    def __init__(self, command, path, body=None, headers=None, host='127.0.0.1', port=8800):
        self.command, self.path = command, path
        raw = json.dumps(body).encode() if body is not None else b''
        self.headers = Headers({'Host': f'127.0.0.1:{port}', 'Content-Length': str(len(raw)), **(headers or {})})
        self.rfile, self.client_address = io.BytesIO(raw), (host, 50000)
        self.server = type('S', (), {'server_port': port})()
        self.sent = None
    def send_json(self, payload, status=200): self.sent = (status, payload)


class Bridge:
    def __init__(self): self.gate = threading.Event(); self.closed = False
    def prepare(self, request):
        if request.get('effort') == 'bad': raise BridgeError('推理强度格式无效', 400, 'invalid_effort')
        return request.get('model'), request['input'], request.get('effort')
    def respond(self, model, inputs, effort=None):
        try:
            yield {'type': 'response.in_progress'}
            yield {'type': 'response.output_text.delta', 'delta': 'hel'}
            self.gate.wait(2)
            yield {'type': 'response.output_text.delta', 'delta': 'lo'}
        finally: self.closed = True


class ClientApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.bridge = Bridge()
        self.api = client_api.LocalClientApi(Path(self.tmp.name), lambda mode: {'installed': True, 'version': '1.2.3', 'loggedIn': True, 'path': '/secret/path', 'loginExitCode': 0},
            lambda mode: {'data': [{'model': 'm1', 'displayName': 'M1', 'supportedReasoningEfforts': [{'reasoningEffort': 'low'}]}], 'cliVersion': '1.2.3'}, lambda mode: self.bridge)
    def tearDown(self): self.tmp.cleanup()
    def call(self, command, path, body=None, **kw):
        handler = FakeHandler(command, path, body, **kw)
        self.assertTrue(client_api.handle_request(handler, self.api)); return handler.sent
    def window(self, command, path, body=None, **kw):
        return self.call(command, path, body, headers={'Sec-Fetch-Site': 'same-origin', 'Origin': 'http://127.0.0.1:8800'}, **kw)
    def enable(self):
        self.window('POST', '/__client/admin', {'enabled': True})
        return json.loads((Path(self.tmp.name) / 'client-api.json').read_text())['token']
    def auth(self, token): return {'Authorization': 'Bearer ' + token}

    def test_off_by_default_and_other_paths_ignored(self):
        self.assertEqual(self.call('GET', '/__client/v1/status')[0], 403)
        handler = FakeHandler('GET', '/__health'); self.assertFalse(client_api.handle_request(handler, self.api))
        self.assertFalse((Path(self.tmp.name) / 'client-api.json').exists())

    def test_enable_writes_private_token_file_and_view_never_contains_it(self):
        status, view = self.window('POST', '/__client/admin', {'enabled': True})
        self.assertEqual(status, 200); self.assertTrue(view['enabled'])
        info = Path(self.tmp.name) / 'client-api.json'
        self.assertEqual(stat.S_IMODE(info.stat().st_mode), 0o600)
        token = json.loads(info.read_text())['token']
        self.assertEqual(len(token), 64); self.assertNotIn(token, json.dumps(view))
        self.assertEqual(self.window('GET', '/__client/admin')[1]['port'], 8800)

    def test_admin_is_window_only(self):
        self.assertEqual(self.call('POST', '/__client/admin', {'enabled': True})[0], 403)
        self.assertEqual(self.call('POST', '/__client/admin', {'enabled': True}, headers={'Origin': 'http://evil.example', 'Sec-Fetch-Site': 'cross-site'})[0], 403)
        token = self.enable()
        self.assertEqual(self.window('POST', '/__client/admin', {'enabled': True})[0], 200)
        self.assertEqual(self.call('POST', '/__client/admin', {'enabled': False}, headers={**self.auth(token), 'Sec-Fetch-Site': 'same-origin'})[0], 403)

    def test_token_loopback_and_methods(self):
        token = self.enable()
        self.assertEqual(self.call('GET', '/__client/v1/status')[0], 401)
        self.assertEqual(self.call('GET', '/__client/v1/status', headers=self.auth('0' * 64))[0], 401)
        self.assertEqual(self.call('GET', '/__client/v1/status', headers=self.auth(token), host='192.168.1.5')[0], 403)
        self.assertEqual(self.call('GET', '/__client/v1/status', headers={**self.auth(token), 'Host': 'evil.example'})[0], 403)
        self.assertEqual(self.call('POST', '/__client/v1/status', {}, headers=self.auth(token))[0], 405)
        self.assertEqual(self.call('GET', '/__client/v1/other', headers=self.auth(token))[0], 404)

    def test_status_and_models_are_public_metadata_only(self):
        token = self.enable()
        status, body = self.call('GET', '/__client/v1/status', headers=self.auth(token))
        self.assertEqual(status, 200); self.assertEqual(body['connections'][0]['version'], '1.2.3')
        self.assertNotIn('/secret/path', json.dumps(body)); self.assertNotIn(token, json.dumps(body))
        status, body = self.call('GET', '/__client/v1/models', headers=self.auth(token))
        self.assertEqual(body['data'], [{'model': 'm1', 'label': 'M1', 'efforts': ['low']}])

    def test_ask_returns_text_and_validates(self):
        token = self.enable(); self.bridge.gate.set()
        status, body = self.call('POST', '/__client/v1/ask', {'requestId': 'r1', 'prompt': 'hi', 'model': 'm1'}, headers=self.auth(token))
        self.assertEqual((status, body['text'], body['cancelled']), (200, 'hello', False)); self.assertTrue(self.bridge.closed)
        for payload in ({'prompt': 'x'}, {'requestId': 'r', 'prompt': ''}, {'requestId': 'r', 'prompt': 'x', 'extra': 1}, {'requestId': 'r', 'prompt': 'x', 'connection': 'api:https://x'}):
            self.assertEqual(self.call('POST', '/__client/v1/ask', payload, headers=self.auth(token))[0], 400)
        status, body = self.call('POST', '/__client/v1/ask', {'requestId': 'r2', 'prompt': 'x', 'effort': 'bad'}, headers=self.auth(token))
        self.assertEqual((status, body['error']['code']), (400, 'invalid_effort'))

    def test_cancel_stops_a_running_ask(self):
        token = self.enable(); result = {}
        def run(): result['value'] = self.call('POST', '/__client/v1/ask', {'requestId': 'r3', 'prompt': 'hi'}, headers=self.auth(token))
        thread = threading.Thread(target=run); thread.start()
        while 'r3' not in self.api.active: threading.Event().wait(0.01)
        status, body = self.call('POST', '/__client/v1/cancel', {'requestId': 'r3'}, headers=self.auth(token))
        self.assertEqual((status, body['cancelled']), (200, True)); self.bridge.gate.set(); thread.join(3)
        self.assertEqual(result['value'][1]['text'], 'hel'); self.assertTrue(result['value'][1]['cancelled'])
        self.assertEqual(self.call('POST', '/__client/v1/cancel', {'requestId': 'nope'}, headers=self.auth(token))[1]['cancelled'], False)

    def test_rotate_and_disable_revoke_access(self):
        old = self.enable()
        self.window('POST', '/__client/admin/rotate'); new = json.loads((Path(self.tmp.name) / 'client-api.json').read_text())['token']
        self.assertNotEqual(old, new)
        self.assertEqual(self.call('GET', '/__client/v1/status', headers=self.auth(old))[0], 401)
        self.assertEqual(self.call('GET', '/__client/v1/status', headers=self.auth(new))[0], 200)
        self.window('POST', '/__client/admin', {'enabled': False})
        self.assertEqual(self.call('GET', '/__client/v1/status', headers=self.auth(new))[0], 403)
        self.assertFalse((Path(self.tmp.name) / 'client-api.json').exists())


if __name__ == '__main__': unittest.main()
