"""Public URL security, complete downloads, and isolated native-file HTTP tests."""
import base64
import email.message
import gzip
import http.client
import io
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest import mock
import urllib.error
import urllib.request

import public_url_fetch as fetcher


PUBLIC = [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, ('93.184.216.34', 443))]
PDF = b'%PDF-1.7\nfixture original bytes\n%%EOF\n'


class Response:
    def __init__(self, body=PDF, headers=None, status=200):
        self.status, self.stream, self.closed, self.reads = status, io.BytesIO(body), False, 0
        self.headers = email.message.Message()
        for key, value in (headers or {'Content-Type': 'application/pdf'}).items():
            self.headers[key] = value

    def read1(self, size):
        self.reads += 1
        return self.stream.read(size)

    def close(self):
        self.closed = True


class Connection:
    closed = False

    def close(self):
        self.closed = True


class PublicDownloadTests(unittest.TestCase):
    def fetch(self, responses, url='https://example.com/paper.pdf', **kwargs):
        opened = []

        def open_response(*args):
            connection, response = Connection(), responses[len(opened)]
            opened.append((args, connection, response))
            return connection, response

        with mock.patch.object(fetcher, '_resolve', return_value=PUBLIC), mock.patch.object(fetcher, '_open', side_effect=open_response):
            result = fetcher.fetch_public_url(url, **kwargs)
        self.assertTrue(all(connection.closed and response.closed for _, connection, response in opened))
        return result, opened

    def test_url_rejects_credentials_invalid_schemes_control_characters_and_zone_ids(self):
        for url in ('file:///etc/passwd', 'ftp://example.com/f', 'https://user:password@example.com/f',
                    'https://example.com\r\nHost:localhost', 'https://example.com\\@localhost/f',
                    'http://[fe80::1%25en0]/', 'http://example.com:99999/', None, 7, ''):
            with self.subTest(url=url), self.assertRaises(fetcher.PublicFetchError):
                fetcher._url(url)
        self.assertEqual(fetcher._url('HTTPS://Example.com./课程?a=1#fragment')[0], 'https://example.com/%E8%AF%BE%E7%A8%8B?a=1')

    def test_every_resolved_address_must_be_public(self):
        blocked = ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254',
                   '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', 'fe80::1', 'fc00::1', 'fec0::1', '::ffff:127.0.0.1']
        for address in blocked:
            family = socket.AF_INET6 if ':' in address else socket.AF_INET
            records = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 80)),
                       (family, socket.SOCK_STREAM, 6, '', (address, 80))]
            with self.subTest(address=address), mock.patch.object(socket, 'getaddrinfo', return_value=records), self.assertRaises(fetcher.PublicFetchError) as caught:
                fetcher._resolve('example.com', 80)
            self.assertEqual(caught.exception.code, 'NON_PUBLIC_URL')
        for host in ('localhost', 'service.local', 'metadata.google.internal'):
            with self.assertRaises(fetcher.PublicFetchError): fetcher._resolve(host, 80)

    def test_connection_pins_validated_ip_and_preserves_tls_hostname_without_second_dns_lookup(self):
        connection = mock.Mock()
        tls = mock.Mock(); tls.wrap_socket.return_value = connection
        with mock.patch.object(socket, 'socket', return_value=connection), mock.patch.object(socket, 'getaddrinfo', side_effect=AssertionError('DNS rebinding')), mock.patch.object(fetcher.ssl, 'create_default_context', return_value=tls):
            pinned = fetcher._PinnedConnection('example.com', 443, PUBLIC, 30, True)
            pinned.connect()
        connection.connect.assert_called_once_with(('93.184.216.34', 443))
        tls.wrap_socket.assert_called_once_with(connection, server_hostname='example.com')

    def test_transport_never_forwards_credentials_or_uses_environment_proxy(self):
        raw_socket = mock.Mock()
        raw_socket.makefile.return_value = io.BytesIO(b'HTTP/1.1 200 OK\r\nContent-Length: 3\r\nContent-Type: text/plain\r\n\r\nabc')
        tls = mock.Mock(); tls.wrap_socket.return_value = raw_socket
        with mock.patch.dict(os.environ, {'HTTPS_PROXY': 'http://127.0.0.1:9999', 'HTTP_PROXY': 'http://127.0.0.1:9999'}), mock.patch.object(socket, 'socket', return_value=raw_socket), mock.patch.object(fetcher.ssl, 'create_default_context', return_value=tls):
            connection, response = fetcher._open('https://example.com/paper?version=1', 'example.com', 443, PUBLIC, 30, 'Fixture')
            self.assertEqual(response.read1(10), b'abc')
            response.close(); connection.close()
        request = b''.join(call.args[0] for call in raw_socket.sendall.call_args_list)
        self.assertIn(b'GET /paper?version=1 HTTP/1.1', request)
        self.assertIn(b'Host: example.com', request)
        for forbidden in (b'Authorization:', b'Cookie:', b'Proxy-Authorization:', b'CONNECT '): self.assertNotIn(forbidden, request)

    def test_public_relative_redirect_retains_final_url_and_download_name(self):
        final = Response(headers={'Content-Type': 'application/octet-stream', 'Content-Disposition': "attachment; filename*=UTF-8''%E7%AC%94%E8%AE%B0.pdf", 'Content-Length': str(len(PDF))})
        result, calls = self.fetch([Response(status=302, headers={'Location': '/download/v1'}), final])
        self.assertEqual(result['url'], 'https://example.com/paper.pdf')
        self.assertEqual(result['finalUrl'], 'https://example.com/download/v1')
        self.assertEqual(result['name'], '笔记.pdf'); self.assertEqual(result['mimeType'], 'application/pdf')
        self.assertEqual(result['raw'], PDF); self.assertEqual(result['size'], len(PDF)); self.assertEqual(len(calls), 2)

    def test_redirect_to_private_address_is_rechecked_before_connecting(self):
        response = Response(status=302, headers={'Location': 'http://127.0.0.1/private'})
        # Start with HTTP so the private-address rejection, not downgrade
        # protection, is the reason the second connection never occurs.
        answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 80))]
        private = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 80))]
        with mock.patch.object(socket, 'getaddrinfo', side_effect=[answers, private]), mock.patch.object(fetcher, '_open', return_value=(Connection(), response)) as opened, self.assertRaises(fetcher.PublicFetchError) as caught:
            fetcher.fetch_public_url('http://example.com/paper')
        self.assertEqual(caught.exception.code, 'NON_PUBLIC_URL'); self.assertEqual(opened.call_count, 1); self.assertTrue(response.closed)

    def test_redirect_loops_downgrades_and_excessive_hops_fail_explicitly(self):
        for responses, code in [([Response(status=302, headers={'Location': '/paper.pdf'})], 'REDIRECT_LOOP'),
                                ([Response(status=302, headers={'Location': 'http://example.com/paper'})], 'INSECURE_REDIRECT'),
                                ([Response(status=302, headers={'Location': f'/hop{i}'}) for i in range(6)], 'TOO_MANY_REDIRECTS')]:
            with self.subTest(code=code), self.assertRaises(fetcher.PublicFetchError) as caught: self.fetch(responses)
            self.assertEqual(caught.exception.code, code)

    def test_exact_byte_limit_succeeds_and_both_declared_and_streamed_oversize_reject(self):
        result, _ = self.fetch([Response()], max_bytes=len(PDF)); self.assertEqual(result['raw'], PDF)
        for headers in ({'Content-Type': 'application/pdf', 'Content-Length': str(len(PDF))}, {'Content-Type': 'application/pdf'}):
            response = Response(headers=headers)
            with self.assertRaises(fetcher.PublicFetchError) as caught: self.fetch([response], max_bytes=len(PDF)-1)
            self.assertEqual(caught.exception.code, 'FILE_TOO_LARGE'); self.assertEqual(caught.exception.status, 413); self.assertTrue(response.closed)
            if 'Content-Length' in headers: self.assertEqual(response.reads, 0)

    def test_incomplete_partial_or_html_instead_of_pdf_never_pass_as_original(self):
        for response, code in [(Response(headers={'Content-Length': str(len(PDF)+5)}), 'INCOMPLETE_DOWNLOAD'),
                               (Response(status=206), 'UPSTREAM_HTTP'), (Response(status=404), 'UPSTREAM_HTTP'),
                               (Response(body=b'<html>Access denied</html>', headers={'Content-Type': 'text/html'}), 'NOT_PDF'),
                               (Response(body=b'', headers={'Content-Length': '0'}), 'EMPTY_RESPONSE')]:
            with self.subTest(code=code), self.assertRaises(fetcher.PublicFetchError) as caught: self.fetch([response])
            self.assertEqual(caught.exception.code, code)

    def test_compressed_body_is_complete_and_decompression_expansion_is_bounded(self):
        zipped = gzip.compress(PDF)
        result, _ = self.fetch([Response(zipped, {'Content-Type': 'application/pdf', 'Content-Encoding': 'gzip', 'Content-Length': str(len(zipped))})])
        self.assertEqual(result['raw'], PDF)
        with self.assertRaises(fetcher.PublicFetchError) as caught:
            self.fetch([Response(gzip.compress(b'x'*10000), {'Content-Encoding':'gzip'})], max_bytes=100)
        self.assertEqual(caught.exception.code, 'FILE_TOO_LARGE')

    def test_timeout_is_explicit_and_closes_the_download(self):
        response = Response(); response.read1 = mock.Mock(side_effect=TimeoutError())
        with self.assertRaises(fetcher.PublicFetchError) as caught: self.fetch([response])
        self.assertEqual(caught.exception.code, 'DOWNLOAD_TIMEOUT'); self.assertTrue(response.closed)

    def test_remote_names_and_folded_mime_headers_cannot_become_paths_or_local_response_headers(self):
        response = Response(body=b'original', headers={'Content-Type':'text/plain\r\n X-Injected: true', 'Content-Disposition':'attachment; filename="../../secret.txt"'})
        result, _ = self.fetch([response], url='https://example.com/download')
        self.assertEqual(result['name'], 'secret.txt'); self.assertEqual(result['mimeType'], 'application/octet-stream')


class FetchHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='workstation-fetch-test-')
        cls.environment = mock.patch.dict(os.environ, {'AI_WORKSTATION_DATA_DIR': cls.temp.name, 'AI_WORKSTATION_PORT': '0'})
        cls.environment.start()
        import server
        cls.module = server
        cls.httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.origin = f'http://127.0.0.1:{cls.httpd.server_port}'
        cls.port_patch = mock.patch.object(server, 'PORT', cls.httpd.server_port); cls.port_patch.start()
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True); cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown(); cls.httpd.server_close(); cls.thread.join()
        cls.port_patch.stop()
        cls.environment.stop(); cls.temp.cleanup()

    def setUp(self):
        self.store_temp = tempfile.TemporaryDirectory(dir=self.temp.name)
        self.store = self.module.WorkspaceStore(self.store_temp.name)
        self.store_patch = mock.patch.object(self.module, 'STORE', self.store); self.store_patch.start()
        self.store.save({key: [] for key in ('projects','tasks','notes','imports','conversations','trash','agentRuns')})
        self.before = self.store.load()

    def tearDown(self):
        self.store_patch.stop(); self.store_temp.cleanup()

    def post(self, payload, origin=True, host=None):
        headers = {'Content-Type': 'application/json'}
        if origin is not False: headers['Origin'] = self.origin if origin is True else origin
        if host: headers['Host'] = host
        connection = http.client.HTTPConnection('127.0.0.1', self.httpd.server_port, timeout=5)
        try:
            connection.request('POST', '/__fetch', body=json.dumps(payload).encode(), headers=headers)
            response = connection.getresponse(); body = response.read()
            try: parsed = json.loads(body)
            except ValueError: parsed = {'error': body.decode('utf-8', 'replace')}
            return response.status, parsed
        finally: connection.close()

    def downloaded(self, raw=PDF, mime='application/pdf'):
        return {'raw':raw,'size':len(raw),'mimeType':mime,'name':'fixture.pdf' if mime=='application/pdf' else 'fixture.txt',
                'url':'https://example.com/paper','finalUrl':'https://example.com/paper/v1','charset':'utf-8'}

    def test_native_pdf_saves_original_without_parser_base64_or_workspace_mutation(self):
        with mock.patch.object(self.module, 'fetch_public_url', return_value=self.downloaded()) as fetch, mock.patch.object(self.module.subprocess, 'run', side_effect=AssertionError('Native PDF must not extract text')):
            status, result = self.post({'url':'https://example.com/paper','native':True})
        self.assertEqual(status, 200); self.assertRegex(result['id'], r'^att_[0-9a-f]{32}$')
        self.assertTrue(result['storedLocally']); self.assertTrue(result['fileStored']); self.assertNotIn('rawBase64', result)
        self.assertEqual(result['content'], ''); self.assertEqual(result['pages'], []); self.assertEqual(result['parser'], 'web-original')
        self.assertEqual(result['size'], len(PDF)); self.assertEqual(self.store.file_path(result['id']).read_bytes(), PDF)
        self.assertEqual(json.loads(self.store.file_path(result['id']).with_suffix('.meta.json').read_text())['mimeType'], 'application/pdf')
        self.assertEqual(self.store.load(), self.before); fetch.assert_called_once()

    def test_legacy_pdf_still_returns_original_base64_and_index_metadata(self):
        with mock.patch.object(self.module, 'fetch_public_url', return_value=self.downloaded()), mock.patch.object(self.module.shutil, 'which', return_value=None):
            status, result = self.post({'url':'https://example.com/paper'})
        self.assertEqual(status, 200); self.assertEqual(base64.b64decode(result['rawBase64']), PDF); self.assertEqual(result['parser'], 'web-pdf')
        self.assertEqual(self.store.file_path(result['id']).read_bytes(), PDF); self.assertEqual(self.store.load(), self.before)

    def test_native_html_and_text_keep_readable_content_and_report_index_truncation(self):
        html = b'<html><title>Course &amp; Notes</title><script>hidden code</script><p>Readable paragraph</p></html>'
        with mock.patch.object(self.module, 'fetch_public_url', return_value=self.downloaded(html, 'text/html')):
            status, result = self.post({'url':'https://example.com/page','native':True})
        self.assertEqual(status, 200); self.assertEqual(result['name'], 'Course & Notes'); self.assertIn('Readable paragraph', result['content']); self.assertNotIn('hidden code', result['content'])
        self.assertEqual(self.store.file_path(result['id']).read_bytes(), html)
        text = ('Plain <not markup>\n' + '文'*60001).encode()
        with mock.patch.object(self.module, 'fetch_public_url', return_value=self.downloaded(text, 'text/plain')):
            status, result = self.post({'url':'https://example.com/file','native':True})
        self.assertEqual(status, 200); self.assertTrue(result['truncated']); self.assertEqual(len(result['content']), 60000); self.assertIn('<not markup>', result['content']); self.assertEqual(result['size'], len(text))
        self.assertEqual(self.store.file_path(result['id']).read_bytes(), text); self.assertEqual(self.store.load(), self.before)

    def test_origin_host_and_request_shape_are_checked_before_download(self):
        with mock.patch.object(self.module, 'fetch_public_url') as fetch:
            for origin, host in [(False,None),('https://attacker.invalid',None),(True,'attacker.invalid')]:
                self.assertEqual(self.post({'url':'https://example.com'}, origin=origin, host=host)[0], 403)
            for payload in ([], {'url':'https://example.com','native':'true'}): self.assertEqual(self.post(payload)[0], 400)
            fetch.assert_not_called()

    def test_download_error_keeps_status_code_and_does_not_write_partial_files(self):
        with mock.patch.object(self.module, 'fetch_public_url', side_effect=fetcher.PublicFetchError('过大，未截断', 'FILE_TOO_LARGE', 413)):
            status, result = self.post({'url':'https://example.com/file','native':True})
        self.assertEqual(status, 413); self.assertEqual(result['code'], 'FILE_TOO_LARGE'); self.assertFalse((Path(self.store_temp.name)/'files').exists()); self.assertEqual(self.store.load(), self.before)

    def test_failed_metadata_save_removes_only_new_download_bytes(self):
        self.store.save_file('existing', b'keep', 'existing.txt', 'text/plain')

        def failed(identifier, raw, *args):
            self.store.atomic_write(self.store.file_path(identifier), raw)
            raise OSError('Fixture metadata failure')

        with mock.patch.object(self.module, 'fetch_public_url', return_value=self.downloaded()), mock.patch.object(self.store, 'save_file', side_effect=failed):
            status, result = self.post({'url':'https://example.com/file','native':True})
        self.assertEqual(status, 503); self.assertEqual(result['code'], 'STORE_FAILED')
        self.assertEqual(sorted(path.name for path in (Path(self.store_temp.name)/'files').iterdir()), ['existing','existing.meta.json'])
        self.assertEqual(self.store.load(), self.before)


if __name__ == '__main__':
    unittest.main(verbosity=2)
