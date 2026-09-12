"""Only disposable loopback upstreams; never access credentials or real APIs."""
import contextlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
IMPORT_HOME = tempfile.TemporaryDirectory(prefix='workstation-proxy-import-')
with patch.dict(os.environ, {'AI_WORKSTATION_DATA_DIR': IMPORT_HOME.name}):
    spec = importlib.util.spec_from_file_location('proxy_test_server', ROOT / 'server.py')
    server = importlib.util.module_from_spec(spec); spec.loader.exec_module(server)


class QuietApp(server.Handler):
    def log_message(self, *args): pass


class Upstream(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self): self.serve()
    def do_POST(self): self.serve()
    def serve(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        self.server.received.append({'path': self.path, 'authorization': self.headers.get('Authorization'), 'body': body})
        self.server.route(self)


def reply(handler, body=b'{"output_text":"ok"}', status=200, content_type='application/json'):
    handler.send_response(status); handler.send_header('Content-Type', content_type)
    handler.send_header('Content-Length', str(len(body))); handler.end_headers()
    handler.wfile.write(body); handler.wfile.flush()


class ApiProxyTests(unittest.TestCase):
    def setUp(self):
        # Environment proxies must not receive even synthetic fixture headers.
        self.env = patch.dict(os.environ, {'no_proxy': '*', 'NO_PROXY': '*'})
        self.env.start(); self.addCleanup(self.env.stop)
        self.upstream = self.start_server(Upstream)
        self.upstream.received = []; self.upstream.route = lambda handler: reply(handler)
        self.app = self.start_server(QuietApp)
        self.origin = f'http://127.0.0.1:{self.app.server_port}'
        self.upstream_url = f'http://127.0.0.1:{self.upstream.server_port}'

    def start_server(self, handler):
        httpd = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        thread = threading.Thread(target=httpd.serve_forever, kwargs={'poll_interval': .02}, daemon=True); thread.start()
        def cleanup():
            httpd.shutdown(); httpd.server_close(); thread.join(1)
        self.addCleanup(cleanup)
        return httpd

    def request(self, path='/response', method='POST', origin=True):
        connection = http.client.HTTPConnection('127.0.0.1', self.app.server_port, timeout=3)
        self.addCleanup(connection.close)
        headers = {'Authorization': 'Bearer synthetic-fixture-token', 'Content-Type': 'application/json'}
        if origin: headers['Origin'] = self.origin if origin is True else origin
        url = '/__proxy?url=' + urllib.parse.quote(self.upstream_url + path, safe='')
        connection.request(method, url, body=b'{"fixture":true}' if method == 'POST' else None, headers=headers)
        response = connection.getresponse(); self.addCleanup(response.close)
        return response.status, response.read()

    def test_connection_deadline_does_not_limit_response_headers_or_generation_body(self):
        opened = []
        real_opener = server.proxy_opener
        def opener(on_connected):
            def capture(upstream):
                opened.append(upstream.gettimeout()); on_connected(upstream)
            return real_opener(capture)
        def delayed(handler):
            time.sleep(.10)  # Generation may begin before response headers.
            handler.send_response(200); handler.send_header('Content-Type', 'text/event-stream'); handler.end_headers()
            handler.wfile.write(b'data: {"type":"response.output_text.delta","delta":"ok"}\n\n'); handler.wfile.flush()
            time.sleep(.10)
            handler.wfile.write(b'data: {"type":"response.completed"}\n\n'); handler.wfile.flush()
        self.upstream.route = delayed
        with patch.object(server, 'PROXY_CONNECT_TIMEOUT', .02), patch.object(server, 'proxy_opener', opener):
            status, body = self.request()
        self.assertEqual(status, 200); self.assertIn(b'response.completed', body)
        self.assertEqual(opened, [None], 'only socket connect/TLS setup has a timeout')
        self.assertEqual(self.upstream.received[0]['authorization'], 'Bearer synthetic-fixture-token')

    def test_http_and_https_connections_clear_timeout_only_after_successful_handshake(self):
        for scheme, base in [('http', http.client.HTTPConnection), ('https', http.client.HTTPSConnection)]:
            class FakeSocket:
                def __init__(self): self.timeouts = []
                def settimeout(self, value): self.timeouts.append(value)
            sock = FakeSocket(); observed = []
            opener = server.proxy_opener(observed.append)
            handler = next(item for item in opener.handlers if item.__class__.__name__ == ('HTTPSHandler' if scheme == 'https' else 'HTTPHandler'))
            handler.do_open = lambda connection, request, **kwargs: connection
            connection_class = getattr(handler, scheme + '_open')(urllib.request.Request(f'{scheme}://fixture.invalid'))
            with patch.object(base, 'connect', lambda connection: setattr(connection, 'sock', sock)):
                connection_class('fixture.invalid', timeout=30).connect()
            self.assertEqual(sock.timeouts, [None]); self.assertEqual(observed, [sock])

    def test_stop_before_response_headers_interrupts_the_upstream_generation(self):
        started = threading.Event(); interrupted = threading.Event()
        def stalled(handler):
            started.set(); handler.connection.settimeout(2)
            try:
                if handler.connection.recv(1) == b'': interrupted.set()
            except ConnectionResetError: interrupted.set()
        self.upstream.route = stalled
        client = socket.create_connection(('127.0.0.1', self.app.server_port), timeout=2)
        self.addCleanup(client.close)
        path = '/__proxy?url=' + urllib.parse.quote(self.upstream_url + '/wait', safe='')
        client.sendall(f'POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{self.app.server_port}\r\nOrigin: {self.origin}\r\nContent-Length: 2\r\nContent-Type: application/json\r\n\r\n{{}}'.encode())
        self.assertTrue(started.wait(1)); client.close()
        self.assertTrue(interrupted.wait(1), 'cancel must interrupt an upstream read with no generation timeout')

    def test_stop_during_a_silent_stream_interrupts_and_closes_the_upstream(self):
        interrupted = threading.Event()
        def stalled(handler):
            handler.send_response(200); handler.send_header('Content-Type', 'text/event-stream'); handler.end_headers()
            handler.wfile.write(b': keep-alive\n\n'); handler.wfile.flush(); handler.connection.settimeout(2)
            try:
                if handler.connection.recv(1) == b'': interrupted.set()
            except ConnectionResetError: interrupted.set()
        self.upstream.route = stalled
        client = http.client.HTTPConnection('127.0.0.1', self.app.server_port, timeout=2)
        self.addCleanup(client.close)
        client.request('POST', '/__proxy?url=' + urllib.parse.quote(self.upstream_url + '/wait', safe=''), '{}', {'Origin': self.origin})
        response = client.getresponse(); self.assertEqual(response.read(len(b': keep-alive\n\n')), b': keep-alive\n\n')
        response.close(); client.close()
        self.assertTrue(interrupted.wait(1), 'stopping the local reader must stop the remote stream')

    def test_upstream_read_failure_after_headers_sends_an_explicit_sse_error(self):
        class BrokenResponse:
            status = 200; headers = {'Content-Type': 'text/event-stream'}
            def __enter__(self): self.first = True; return self
            def __exit__(self, *args): pass
            def read1(self, size):
                if self.first: self.first = False; return b'data: {"type":"response.output_text.delta","delta":"looks complete"}\n\n'
                raise OSError('synthetic read interruption')
        class FakeOpener:
            def open(self, *args, **kwargs): return BrokenResponse()
        with patch.object(server, 'proxy_opener', lambda on_connected: FakeOpener()): status, body = self.request()
        self.assertEqual(status, 200); self.assertIn(b'UPSTREAM_STREAM_INTERRUPTED', body)
        self.assertNotIn(b'response.completed', body); self.assertNotIn(b'synthetic-fixture-token', body)

    def test_clean_upstream_eof_is_not_rewritten_as_success_or_a_fake_completion(self):
        original = b'data: {"type":"response.output_text.delta","delta":"{\\"actions\\":[]}"}\n\n'
        self.upstream.route = lambda handler: reply(handler, original, content_type='text/event-stream')
        status, body = self.request(); self.assertEqual(status, 200); self.assertEqual(body, original)

    def test_json_and_http_errors_remain_compatible(self):
        for code in (200, 401, 404):
            original = json.dumps({'output_text': 'ok'} if code == 200 else {'error': {'message': f'Fixture HTTP {code}'}}).encode()
            self.upstream.route = lambda handler: reply(handler, original, code)
            status, body = self.request(); self.assertEqual(status, code); self.assertEqual(body, original)

    def test_redirects_cannot_forward_authorization_to_a_different_origin(self):
        def redirect(handler):
            handler.send_response(302); handler.send_header('Location', f'http://localhost:{self.upstream.server_port}/target'); handler.end_headers()
        self.upstream.route = redirect
        status, body = self.request(method='GET')
        self.assertEqual(status, 502); self.assertIn('重定向到了其他来源', body.decode())
        self.assertEqual(len(self.upstream.received), 1); self.assertNotIn(b'synthetic-fixture-token', body)

    def test_same_origin_redirect_preserves_the_existing_authorized_request(self):
        def redirect(handler):
            if handler.path == '/redirect':
                handler.send_response(302); handler.send_header('Location', '/target'); handler.end_headers()
            else: reply(handler)
        self.upstream.route = redirect
        status, body = self.request('/redirect', method='GET'); self.assertEqual(status, 200)
        self.assertEqual([request['path'] for request in self.upstream.received], ['/redirect', '/target'])
        self.assertTrue(all(request['authorization'] == 'Bearer synthetic-fixture-token' for request in self.upstream.received))

    def test_untrusted_or_missing_mutation_origin_never_contacts_upstream(self):
        for origin in (False, 'https://untrusted.invalid'):
            status, _ = self.request(origin=origin); self.assertEqual(status, 403)
        self.assertEqual(self.upstream.received, [])


if __name__ == '__main__': unittest.main()
