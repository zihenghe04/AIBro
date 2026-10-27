"""Only disposable loopback upstreams; never access credentials or real APIs."""
import contextlib
import errno
import http.client
import importlib.util
import json
import os
from pathlib import Path
import socket
import ssl
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.parse
import urllib.request
from urllib.error import URLError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = (Path(__file__).resolve().parents[1] / 'app')
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
        self.server.received.append({'path': self.path, 'authorization': self.headers.get('Authorization'), 'x_api_key': self.headers.get('X-Api-Key'), 'anthropic_version': self.headers.get('Anthropic-Version'), 'cookie': self.headers.get('Cookie'), 'body': body})
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

    def request(self, path='/response', method='POST', origin=True, target=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.app.server_port, timeout=3)
        self.addCleanup(connection.close)
        headers = {'Authorization': 'Bearer synthetic-fixture-token', 'Content-Type': 'application/json'}
        if origin: headers['Origin'] = self.origin if origin is True else origin
        url = '/__proxy?url=' + urllib.parse.quote(target or self.upstream_url + path, safe='')
        connection.request(method, url, body=b'{"fixture":true}' if method == 'POST' else None, headers=headers)
        response = connection.getresponse(); self.addCleanup(response.close)
        return response.status, response.read()

    def test_anthropic_headers_are_forwarded_and_unlisted_headers_are_not(self):
        connection = http.client.HTTPConnection('127.0.0.1', self.app.server_port, timeout=3); self.addCleanup(connection.close)
        headers = {'X-Api-Key': 'synthetic-fixture-key', 'Anthropic-Version': '2023-06-01', 'Cookie': 'session=synthetic', 'Content-Type': 'application/json', 'Origin': self.origin}
        connection.request('POST', '/__proxy?url=' + urllib.parse.quote(self.upstream_url + '/v1/messages', safe=''), body=b'{}', headers=headers)
        response = connection.getresponse(); self.addCleanup(response.close); response.read()
        self.assertEqual(response.status, 200)
        seen = self.upstream.received[-1]
        self.assertEqual((seen['x_api_key'], seen['anthropic_version'], seen['cookie']), ('synthetic-fixture-key', '2023-06-01', None))

    def test_connection_deadline_does_not_limit_response_headers_or_generation_body(self):
        opened = []
        real_opener = server.proxy_opener
        def opener(on_connected, on_connecting=None):
            def capture(upstream):
                opened.append(upstream.gettimeout()); on_connected(upstream)
            return real_opener(capture, on_connecting)
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
            sock = FakeSocket(); observed = []; stages = []
            opener = server.proxy_opener(lambda sock: (stages.append('connected'), observed.append(sock)), lambda: stages.append('connecting'))
            handler = next(item for item in opener.handlers if item.__class__.__name__ == ('HTTPSHandler' if scheme == 'https' else 'HTTPHandler'))
            handler.do_open = lambda connection, request, **kwargs: connection
            connection_class = getattr(handler, scheme + '_open')(urllib.request.Request(f'{scheme}://fixture.invalid'))
            with patch.object(base, 'connect', lambda connection: setattr(connection, 'sock', sock)):
                connection_class('fixture.invalid', timeout=30).connect()
            self.assertEqual(sock.timeouts, [None]); self.assertEqual(observed, [sock])
            self.assertEqual(stages, ['connecting', 'connected'])

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
                raise self.failure
        class FakeOpener:
            def open(self, *args, **kwargs): return BrokenResponse()
        for failure in (OSError('secret synthetic read interruption'), ConnectionResetError('secret reset'), BrokenPipeError('secret pipe')):
            with self.subTest(failure=type(failure).__name__):
                BrokenResponse.failure = failure
                with patch.object(server, 'proxy_opener', lambda *callbacks: FakeOpener()): status, body = self.request()
                self.assertEqual(status, 200); self.assertIn(b'UPSTREAM_STREAM_INTERRUPTED', body)
                event = json.loads(body.decode().strip().split('\n\n')[-1].removeprefix('data: '))
                self.assertEqual(event['error']['phase'], 'stream')
                self.assertNotIn(b'response.completed', body); self.assertNotIn(b'synthetic-fixture-token', body)
                self.assertNotIn(b'secret', body); self.assertNotIn('未执行操作', body.decode())

    def test_clean_upstream_eof_is_not_rewritten_as_success_or_a_fake_completion(self):
        original = b'data: {"type":"response.output_text.delta","delta":"{\\"actions\\":[]}"}\n\n'
        self.upstream.route = lambda handler: reply(handler, original, content_type='text/event-stream')
        status, body = self.request(); self.assertEqual(status, 200); self.assertEqual(body, original)

    def test_json_and_http_errors_remain_compatible(self):
        for code in (200, 401, 403, 404, 429, 500, 503):
            original = json.dumps({'output_text': 'ok'} if code == 200 else {'error': {'message': f'Fixture HTTP {code}'}}).encode()
            self.upstream.route = lambda handler: reply(handler, original, code)
            status, body = self.request(); self.assertEqual(status, code); self.assertEqual(body, original)

    def test_redirects_cannot_forward_authorization_to_a_different_origin(self):
        def redirect(handler):
            handler.send_response(302); handler.send_header('Location', f'http://localhost:{self.upstream.server_port}/target'); handler.end_headers()
        self.upstream.route = redirect
        status, body = self.request(method='GET')
        self.assertEqual(status, 502); self.assertIn('重定向到了其他来源', body.decode())
        self.assertEqual(json.loads(body)['error']['code'], 'UPSTREAM_REDIRECT_REJECTED')
        self.assertEqual(json.loads(body)['error']['phase'], 'response')
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

    def assert_public_failure(self, body, code, phase='connection'):
        error = json.loads(body)['error']
        self.assertEqual(set(error), {'code', 'phase', 'message'})
        self.assertEqual(error['code'], code); self.assertEqual(error['phase'], phase)
        self.assertTrue(error['message'])
        for private in ('secret', 'synthetic-fixture-token', 'fixture.invalid', '/private/', self.upstream_url, 'fixture":true'):
            self.assertNotIn(private, body.decode())

    def test_connection_refusal_is_identified_through_a_real_loopback_connection(self):
        # Some kernels silently drop packets to a bound-but-not-listening
        # socket, so close the temporary reservation before the connect.
        with socket.socket() as reserved:
            reserved.bind(('127.0.0.1', 0))
            target = f'http://127.0.0.1:{reserved.getsockname()[1]}/secret?key=secret'
        status, body = self.request(target=target)
        self.assertEqual(status, 502)
        self.assert_public_failure(body, 'UPSTREAM_CONNECTION_REFUSED')

    def test_dns_failure_is_identified_through_the_real_opener(self):
        real_lookup = socket.getaddrinfo
        def lookup(host, *args, **kwargs):
            if host == 'fixture.invalid': raise socket.gaierror(socket.EAI_NONAME, 'secret fixture.invalid')
            return real_lookup(host, *args, **kwargs)
        with patch.object(socket, 'getaddrinfo', lookup):
            status, body = self.request(target='http://fixture.invalid/secret?key=secret')
        self.assertEqual(status, 502); self.assert_public_failure(body, 'UPSTREAM_DNS_ERROR')

    def test_tls_and_timeout_failures_keep_the_real_connection_stage(self):
        cases = ((ssl.SSLCertVerificationError(1, 'secret certificate /private/cert'), 'UPSTREAM_TLS_ERROR'),
                 (ssl.SSLError(1, 'secret handshake'), 'UPSTREAM_TLS_ERROR'),
                 (socket.timeout('secret timed out'), 'UPSTREAM_CONNECT_TIMEOUT'))
        for failure, code in cases:
            with self.subTest(code=code, failure=type(failure).__name__):
                # Patch only the HTTPS handshake; the local HTTP client stays real.
                with patch.object(http.client.HTTPSConnection, 'connect', side_effect=failure):
                    status, body = self.request(target='https://fixture.invalid/secret?key=secret')
                self.assertEqual(status, 502); self.assert_public_failure(body, code)

    def test_nested_url_errors_and_unknown_failures_do_not_echo_private_text(self):
        cases = ((URLError(URLError(OSError(errno.ECONNREFUSED, 'secret refused'))), 'UPSTREAM_CONNECTION_REFUSED'),
                 (URLError(OSError(errno.ETIMEDOUT, 'secret timeout')), 'UPSTREAM_CONNECT_TIMEOUT'),
                 (URLError('secret is not a typed cause'), 'UPSTREAM_CONNECTION_ERROR'),
                 (ValueError('secret synthetic-fixture-token /private/path'), 'UPSTREAM_CONNECTION_ERROR'),
                 (ConnectionResetError('secret reset'), 'UPSTREAM_CONNECTION_ERROR'))
        for failure, code in cases:
            class FakeOpener:
                def open(self, *args, **kwargs): raise failure
            with self.subTest(code=code, failure=type(failure).__name__):
                with patch.object(server, 'proxy_opener', lambda *callbacks: FakeOpener()):
                    status, body = self.request('/secret?key=secret')
                self.assertEqual(status, 502); self.assert_public_failure(body, code)

    def test_upstream_close_before_headers_is_a_response_phase_failure(self):
        def close(handler):
            handler.connection.shutdown(socket.SHUT_RDWR)
            handler.connection.close()
        self.upstream.route = close
        status, body = self.request()
        self.assertEqual(status, 502); self.assert_public_failure(body, 'UPSTREAM_CONNECTION_ERROR', 'response')

    def test_a_timeout_after_connection_is_not_called_a_connect_timeout(self):
        class FakeSocket:
            def shutdown(self, *args): pass
        class FakeOpener:
            def open(self, *args, **kwargs): raise socket.timeout('secret response timeout')
        def opener(on_connected, on_connecting):
            on_connecting(); on_connected(FakeSocket()); return FakeOpener()
        with patch.object(server, 'proxy_opener', opener): status, body = self.request()
        self.assertEqual(status, 502); self.assert_public_failure(body, 'UPSTREAM_CONNECTION_ERROR', 'response')

    def test_redirect_reconnection_reports_its_own_connect_timeout(self):
        real_connect = http.client.HTTPConnection.connect
        connection_count = 0
        def connect(connection):
            nonlocal connection_count
            if connection.port == self.upstream.server_port:
                connection_count += 1
                if connection_count == 2: raise socket.timeout('secret second connection')
            return real_connect(connection)
        def redirect(handler):
            handler.send_response(302); handler.send_header('Location', '/target'); handler.end_headers()
        self.upstream.route = redirect
        with patch.object(http.client.HTTPConnection, 'connect', connect):
            status, body = self.request('/redirect', method='GET')
        self.assertEqual(status, 502); self.assert_public_failure(body, 'UPSTREAM_CONNECT_TIMEOUT')
        self.assertEqual(connection_count, 2)
        self.assertEqual(len(self.upstream.received), 1)

    def test_only_explicit_exception_causes_are_diagnostic_evidence(self):
        outer = RuntimeError('secret wrapper')
        outer.__cause__ = URLError(socket.gaierror(socket.EAI_NONAME, 'secret DNS'))
        self.assertEqual(server.proxy_failure(outer)['code'], 'UPSTREAM_DNS_ERROR')
        outer.__cause__ = None
        outer.__context__ = ssl.SSLError('secret unrelated caught exception')
        self.assertEqual(server.proxy_failure(outer)['code'], 'UPSTREAM_CONNECTION_ERROR')
        outer.__cause__ = outer
        self.assertEqual(server.proxy_failure(outer)['code'], 'UPSTREAM_CONNECTION_ERROR', 'cyclic causes terminate safely')

    def test_untrusted_or_missing_mutation_origin_never_contacts_upstream(self):
        for origin in (False, 'https://untrusted.invalid'):
            status, _ = self.request(origin=origin); self.assertEqual(status, 403)
        self.assertEqual(self.upstream.received, [])


if __name__ == '__main__': unittest.main()
