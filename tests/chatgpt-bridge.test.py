"""ChatGPT account requests (Responses protocol) against a local fake service. No real account or network."""
import base64
import json
from pathlib import Path
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import chatgpt_oauth as oauth
from chatgpt_bridge import ChatGPTBridge, BUILTIN_MODELS, to_responses_input
from codex_bridge import BridgeError


def jwt(**claims):
    enc = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b'=').decode()
    return enc({'alg': 'none'}) + '.' + enc(claims) + '.sig'


class Service:
    """Token endpoint plus the ChatGPT backend on one origin."""
    def __init__(self):
        self.requests, self.lock = [], threading.Lock()
        self.responses_script = None  # callable(handler) for /codex/responses
        self.models_body, self.models_status = None, 200
        self.usage_body = None
        self.tokens_issued = 0
        self.reject_tokens = {1}  # access token generations answered with 401
        svc = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.0'
            def log_message(self, *args): pass
            def send_json(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
            def handle_any(self):
                raw = self.rfile.read(int(self.headers.get('Content-Length') or 0)) if self.command == 'POST' else b''
                with svc.lock: svc.requests.append({'path': self.path, 'headers': dict(self.headers), 'body': raw.decode()})
                if self.path == '/oauth/token':
                    with svc.lock: svc.tokens_issued += 1; n = svc.tokens_issued
                    return self.send_json(200, {'access_token': jwt(n=n), 'refresh_token': f'r{n}', 'expires_in': 3600,
                                                'id_token': jwt(email='a@b.c', **{'https://api.openai.com/auth': {'chatgpt_account_id': 'acct-9', 'chatgpt_plan_type': 'pro'}})})
                token = (self.headers.get('Authorization') or '').removeprefix('Bearer ')
                generation = json.loads(base64.urlsafe_b64decode(token.split('.')[1] + '==')).get('n') if token.count('.') == 2 else None
                if generation in svc.reject_tokens: return self.send_json(401, {'error': 'expired'})
                if self.path.startswith('/backend-api/codex/models'):
                    return self.send_json(svc.models_status, svc.models_body or {})
                if self.path == '/backend-api/wham/usage': return self.send_json(200, svc.usage_body or {})
                if self.path == '/backend-api/codex/responses': return svc.responses_script(self)
                self.send_json(404, {})
            do_GET = do_POST = handle_any

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.origin = f'http://127.0.0.1:{self.server.server_address[1]}'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def sse(self, handler, events, delay=0):
        handler.send_response(200); handler.send_header('Content-Type', 'text/event-stream'); handler.end_headers()
        for event in events:
            handler.wfile.write(('event: x\ndata: ' + json.dumps(event) + '\n\n').encode()); handler.wfile.flush()
            if delay: time.sleep(delay)

    def close(self): self.server.shutdown(); self.server.server_close()


class Base(unittest.TestCase):
    def setUp(self):
        self.svc = Service(); self.addCleanup(self.svc.close)
        self.vault = oauth.MemoryVault()
        self.vault.value = {'refresh_token': 'r0', 'account_id': 'acct-9', 'email': 'a@b.c', 'plan': 'pro'}
        self.client = oauth.ChatGPTOAuth(self.vault, auth_origin=self.svc.origin, api_origin=self.svc.origin)
        self.bridge = ChatGPTBridge(self.client, api_origin=self.svc.origin)

    def run_events(self, model='m1', text='hi', effort=None, web=False):
        model, inputs, effort = self.bridge.prepare({'model': model, 'input': text, 'effort': effort})
        return list(self.bridge.respond(model, inputs, effort, web))

    def last_responses(self):
        return [r for r in self.svc.requests if r['path'] == '/backend-api/codex/responses'][-1]


class Conversion(unittest.TestCase):
    def test_messages_roles_and_system(self):
        items, system = to_responses_input([
            {'role': 'system', 'content': 'be brief'},
            {'role': 'user', 'content': [{'type': 'input_text', 'text': 'q'}, {'type': 'input_image', 'image_url': 'https://x.example/a.png'}]},
            {'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'a'}]}])
        self.assertEqual(system, ['be brief'])
        self.assertEqual([i['role'] for i in items], ['user', 'assistant'])
        self.assertEqual(items[0]['content'][1], {'type': 'input_image', 'image_url': 'https://x.example/a.png'})
        self.assertEqual(items[1]['content'][0]['type'], 'output_text')

    def test_rejections(self):
        for bad in ('', '  ', [], [{'role': 'tool', 'content': 'x'}], [{'role': 'user', 'content': [{'type': 'input_file', 'file_data': 'x'}]}],
                    [{'role': 'user', 'content': [{'type': 'input_image', 'image_url': 'http://insecure.example/a.png'}]}]):
            with self.assertRaises(BridgeError, msg=repr(bad)): to_responses_input(bad)


class Models(Base):
    def test_models_from_service_sorted_and_hidden_skipped(self):
        self.svc.models_body = {'models': [
            {'slug': 'b-model', 'display_name': 'B', 'priority': 5, 'supported_reasoning_levels': [{'effort': 'low', 'description': 'd'}, {'effort': 'high'}], 'default_reasoning_level': 'low'},
            {'slug': 'a-model', 'display_name': 'A', 'priority': 1, 'input_modalities': ['text', 'image']},
            {'slug': 'secret', 'visibility': 'hide'}, {'slug': 'bad slug!'}]}
        self.svc.reject_tokens = set()
        data = self.bridge.models()['data']
        self.assertEqual([m['id'] for m in data], ['a-model', 'b-model'])
        self.assertTrue(data[0]['isDefault'])
        self.assertEqual([e['reasoningEffort'] for e in data[1]['supportedReasoningEfforts']], ['low', 'high'])
        request = [r for r in self.svc.requests if r['path'].startswith('/backend-api/codex/models')][0]
        self.assertIn('client_version=', request['path'])
        self.assertEqual(request['headers']['chatgpt-account-id'], 'acct-9')

    def test_real_sized_list_over_64kb_is_read_and_unknown_model_is_refused_with_a_specific_error(self):
        self.svc.reject_tokens = set()
        padding = 'x' * 120000  # the real list carries long per-model instructions
        self.svc.models_body = {'models': [{'slug': 'gpt-6-luna', 'display_name': 'L', 'priority': 5, 'visibility': 'list', 'base_instructions': padding, 'supported_reasoning_levels': [{'effort': 'low'}]},
                                           {'slug': 'hidden-one', 'visibility': 'hide', 'priority': 1}]}
        listing = self.bridge.models()
        self.assertEqual((listing['source'], [m['id'] for m in listing['data']]), ('live', ['gpt-6-luna']))
        with self.assertRaises(BridgeError) as caught: self.bridge.prepare({'model': 'gpt-6.1-sol', 'input': 'hi'})
        self.assertEqual((caught.exception.status, caught.exception.code), (400, 'model_not_found'))
        self.assertIn('gpt-6.1-sol', str(caught.exception))
        model, _, _ = self.bridge.prepare({'model': 'gpt-6-luna', 'input': 'hi', 'effort': 'low'})
        self.assertEqual(model, 'gpt-6-luna')
        self.assertEqual(self.bridge.cached_models()['source'], 'live')

    def test_builtin_table_when_service_fails(self):
        self.svc.models_status = 500
        listing = self.bridge.models()
        self.assertEqual((listing['data'][0]['id'], listing['source']), (BUILTIN_MODELS[0]['id'], 'builtin'))
        self.assertNotIn('gpt-6.1-sol', [m['id'] for m in listing['data']])
        self.svc.reject_tokens = set()
        model, _, _ = self.bridge.prepare({'model': 'anything-else', 'input': 'hi'})  # a failed list is not proof the model is wrong
        self.assertEqual(model, 'anything-else')

    def test_requires_login(self):
        self.vault.value = None
        fresh = ChatGPTBridge(oauth.ChatGPTOAuth(self.vault, auth_origin=self.svc.origin, api_origin=self.svc.origin), api_origin=self.svc.origin)
        with self.assertRaises(BridgeError) as caught: fresh.models()
        self.assertEqual(caught.exception.status, 401)


class Respond(Base):
    def test_streams_text_reasoning_and_completes(self):
        self.svc.reject_tokens = set()
        self.svc.responses_script = lambda h: self.svc.sse(h, [
            {'type': 'response.created'},
            {'type': 'response.reasoning_summary_text.delta', 'delta': 'thinking', 'item_id': 'rs1', 'summary_index': 0},
            {'type': 'response.output_text.delta', 'delta': 'Hel'}, {'type': 'response.output_text.delta', 'delta': 'lo'},
            {'type': 'response.completed', 'response': {'output': []}}])
        events = self.run_events(effort='high')
        kinds = [e['type'] for e in events]
        self.assertEqual(kinds[-1], 'response.completed')
        self.assertEqual(events[-1]['response']['output_text'], 'Hello')
        self.assertEqual(''.join(e['delta'] for e in events if e['type'] == 'response.output_text.delta'), 'Hello')
        reasoning = [e for e in events if e['type'] == 'response.reasoning_summary_text.delta'][0]
        self.assertEqual((reasoning['delta'], reasoning['source']), ('thinking', 'summary'))
        sent = self.last_responses()
        body = json.loads(sent['body'])
        self.assertEqual((body['model'], body['stream'], body['store'], body['reasoning']['effort']), ('m1', True, False, 'high'))
        self.assertEqual(body['input'][0]['content'][0], {'type': 'input_text', 'text': 'hi'})
        self.assertEqual(sent['headers']['chatgpt-account-id'], 'acct-9')
        self.assertTrue(sent['headers']['Authorization'].startswith('Bearer '))
        self.assertEqual(sent['headers']['originator'], 'codex_cli_rs')

    def test_web_search_adds_tool(self):
        self.svc.reject_tokens = set()
        self.svc.responses_script = lambda h: self.svc.sse(h, [{'type': 'response.completed', 'response': {'output': [{'type': 'message', 'content': [{'text': 'done'}]}]}}])
        events = self.run_events(web=True)
        self.assertEqual(json.loads(self.last_responses()['body'])['tools'], [{'type': 'web_search'}])
        self.assertEqual(events[-1]['response']['output_text'], 'done')

    def test_401_triggers_one_forced_refresh_then_succeeds(self):
        self.svc.responses_script = lambda h: self.svc.sse(h, [{'type': 'response.output_text.delta', 'delta': 'ok'}, {'type': 'response.completed', 'response': {}}])
        events = self.run_events()  # token generation 1 is rejected, 2 accepted
        self.assertEqual(events[-1]['type'], 'response.completed')
        self.assertEqual(len([r for r in self.svc.requests if r['path'] == '/oauth/token']), 2)

    def test_model_not_supported_and_quota_are_categorised_without_echo(self):
        self.svc.reject_tokens = set()
        def fail(status, body):
            def script(h):
                data = json.dumps(body).encode()
                h.send_response(status); h.send_header('Content-Length', str(len(data))); h.end_headers(); h.wfile.write(data)
            return script
        self.svc.responses_script = fail(400, {'detail': {'code': 'model_not_found', 'secret': 'ACCOUNT-SECRET'}})
        failed = self.run_events()[-1]
        self.assertEqual(failed['type'], 'response.failed'); self.assertEqual(failed['error']['code'], 'chatgpt_modelNotSupported')
        self.assertNotIn('ACCOUNT-SECRET', json.dumps(failed))
        self.svc.responses_script = fail(429, {'error': 'usage_limit_reached', 'secret': 'ACCOUNT-SECRET'})
        failed = self.run_events()[-1]
        self.assertEqual(failed['error']['code'], 'chatgpt_quota'); self.assertNotIn('ACCOUNT-SECRET', json.dumps(failed))

    def test_failed_event_not_echoed(self):
        self.svc.reject_tokens = set()
        self.svc.responses_script = lambda h: self.svc.sse(h, [{'type': 'response.failed', 'response': {'error': {'message': 'ACCOUNT-SECRET'}}}])
        failed = self.run_events()[-1]
        self.assertEqual(failed['type'], 'response.failed'); self.assertNotIn('ACCOUNT-SECRET', json.dumps(failed))

    def test_stream_cut_without_completion_fails(self):
        self.svc.reject_tokens = set()
        self.svc.responses_script = lambda h: self.svc.sse(h, [{'type': 'response.output_text.delta', 'delta': 'part'}])
        self.assertEqual(self.run_events()[-1]['type'], 'response.failed')

    def test_closing_the_generator_drops_the_upstream_connection(self):
        self.svc.reject_tokens = set()
        dropped = threading.Event()
        def script(h):
            h.send_response(200); h.send_header('Content-Type', 'text/event-stream'); h.end_headers()
            try:
                for i in range(200):
                    h.wfile.write(b'data: ' + json.dumps({'type': 'response.output_text.delta', 'delta': 'x'}).encode() + b'\n\n'); h.wfile.flush(); time.sleep(0.05)
            except OSError: dropped.set()
        self.svc.responses_script = script
        model, inputs, effort = self.bridge.prepare({'model': 'm1', 'input': 'hi'})
        stream = self.bridge.respond(model, inputs, effort)
        for event in stream:
            if event['type'] == 'response.output_text.delta': break
        stream.close()
        self.assertTrue(dropped.wait(3))

    def test_logout_stops_active_generation(self):
        self.svc.reject_tokens = set()
        def script(h):
            h.send_response(200); h.send_header('Content-Type', 'text/event-stream'); h.end_headers()
            try:
                for i in range(200):
                    h.wfile.write(b'data: ' + json.dumps({'type': 'response.output_text.delta', 'delta': 'x'}).encode() + b'\n\n'); h.wfile.flush(); time.sleep(0.05)
            except OSError: pass
        self.svc.responses_script = script
        model, inputs, effort = self.bridge.prepare({'model': 'm1', 'input': 'hi'})
        stream = self.bridge.respond(model, inputs, effort)
        seen = []
        for event in stream:
            seen.append(event['type'])
            if event['type'] == 'response.output_text.delta' and len(seen) < 5: threading.Timer(0, self.bridge.logout).start()
            if event['type'] in ('response.failed', 'response.completed'): break
        self.assertEqual(seen[-1], 'response.failed')
        self.assertIsNone(self.vault.value)

    def test_needs_reauth_is_reported_before_any_request(self):
        self.vault.value = dict(self.vault.value, needs_reauth=True)
        fresh = ChatGPTBridge(oauth.ChatGPTOAuth(self.vault, auth_origin=self.svc.origin, api_origin=self.svc.origin), api_origin=self.svc.origin)
        with self.assertRaises(BridgeError) as caught: fresh.prepare({'model': 'm1', 'input': 'hi'})
        self.assertEqual(caught.exception.code, 'needs_reauth')
        self.assertEqual(self.svc.requests, [])


class Usage(Base):
    def test_windows(self):
        self.svc.reject_tokens = set()
        self.svc.usage_body = {'rate_limit': {
            'primary_window': {'used_percent': 12.5, 'limit_window_seconds': 18000, 'reset_at': 1800000000},
            'secondary_window': {'used_percent': 0, 'limit_window_seconds': 604800, 'reset_at': 1800500000}}, 'credits': {'balance': '5'}}
        windows = self.bridge.usage()['windows']
        self.assertEqual([w['name'] for w in windows], ['five_hour', 'seven_day'])
        self.assertEqual(windows[0]['usedPercent'], 12.5); self.assertEqual(windows[0]['resetsAt'], 1800000000)
        self.assertIsNone(windows[1]['resetsAt'])  # unused window: placeholder reset hidden
        sent = [r for r in self.svc.requests if r['path'] == '/backend-api/wham/usage'][0]
        self.assertEqual(sent['headers']['chatgpt-account-id'], 'acct-9')

    def test_malformed_usage_gives_empty_windows(self):
        self.svc.reject_tokens = set(); self.svc.usage_body = {'rate_limit': 'nope'}
        self.assertEqual(self.bridge.usage()['windows'], [])


if __name__ == '__main__':
    unittest.main()
