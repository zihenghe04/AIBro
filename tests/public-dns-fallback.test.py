"""Offline regression coverage for the narrow fake-DNS compatibility path."""
import copy
import io
import json
import os
import socket
import ssl
import threading
import time
import unittest
from unittest import mock
import urllib.parse

import public_url_fetch as fetcher


HOST = 'example.com'
PUBLIC_V4 = '93.184.216.34'
PUBLIC_V6 = '2606:4700:4700::1111'


def system_answer(address, port=443):
    family = socket.AF_INET6 if ':' in address else socket.AF_INET
    target = (address, port, 0, 0) if family == socket.AF_INET6 else (address, port)
    return (family, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', target)


def record(address, owner=HOST, kind=None):
    kind = kind if kind is not None else (28 if ':' in address else 1)
    return {'name': owner + '.', 'type': kind, 'TTL': 60, 'data': address}


def answer(kind=1, records=None, host=HOST):
    return {'Status': 0, 'TC': False, 'CD': False,
            'Question': [{'name': host + '.', 'type': kind}],
            'Answer': records if records is not None else [record(PUBLIC_V4)]}


class FakeDNSTriggerTests(unittest.TestCase):
    def test_only_nonempty_entirely_recognized_fake_answers_trigger(self):
        for addresses in ([system_answer('198.18.0.56')],
                          [system_answer('198.19.255.254')],
                          [system_answer('2001:2::37')],
                          [system_answer('198.18.0.56'), system_answer('2001:2::37')]):
            with self.subTest(addresses=addresses):
                self.assertTrue(fetcher._fake_dns_answers(HOST, addresses))
        for addresses in ([], [system_answer(PUBLIC_V4)],
                          [system_answer('198.18.0.56'), system_answer(PUBLIC_V4)],
                          [system_answer('198.18.0.56'), system_answer('10.0.0.1')],
                          [system_answer('2001:2::37'), system_answer('fc00::1')],
                          [system_answer('198.20.0.1')], [system_answer('2001:3::37')],
                          [(socket.AF_UNIX, socket.SOCK_STREAM, 0, '', ('198.18.0.56', 443))]):
            with self.subTest(addresses=addresses):
                self.assertFalse(fetcher._fake_dns_answers(HOST, addresses))

    def test_literal_numeric_single_label_and_special_use_names_never_trigger(self):
        fake = [system_answer('198.18.0.56')]
        for host in ('198.18.0.56', '2001:2::37', '127.1', '0177.0.0.1',
                     '2130706433', '0x7f000001', 'localhost', 'printer',
                     'service.localhost', 'service.local', 'metadata.google.internal',
                     'router.home.arpa', 'service.invalid', 'service.test',
                     'service.onion', '-bad.example.com', 'bad_.example.com',
                     'bad..example.com', 'a' * 64 + '.com'):
            with self.subTest(host=host):
                self.assertFalse(fetcher._fake_dns_answers(host, fake))

    def test_mixed_answers_remain_blocked_without_contacting_doh(self):
        for extra in (PUBLIC_V4, '10.0.0.1', '127.0.0.1', 'fc00::1'):
            with self.subTest(extra=extra), \
                    mock.patch.object(socket, 'getaddrinfo', return_value=[
                        system_answer('198.18.0.56'), system_answer(extra)]), \
                    mock.patch.object(fetcher, '_doh_addresses') as doh:
                with self.assertRaises(fetcher.PublicFetchError) as caught:
                    fetcher._resolve(HOST, 443)
                self.assertEqual(caught.exception.code, 'NON_PUBLIC_URL')
                doh.assert_not_called()

    def test_ordinary_public_resolution_does_not_use_doh(self):
        records = [system_answer(PUBLIC_V4), system_answer(PUBLIC_V4)]
        with mock.patch.object(socket, 'getaddrinfo', return_value=records), \
                mock.patch.object(fetcher, '_doh_addresses') as doh:
            resolved = fetcher._resolve(HOST, 443)
        self.assertEqual(len(resolved), 1)
        self.assertEqual(resolved[0][3], (PUBLIC_V4, 443))
        doh.assert_not_called()

    def test_system_dns_error_and_empty_answer_do_not_activate_fallback(self):
        for config in ({'side_effect': socket.gaierror('fixture DNS failure')},
                       {'return_value': []}):
            with self.subTest(config=config), mock.patch.object(socket, 'getaddrinfo', **config), \
                    mock.patch.object(fetcher, '_doh_addresses') as doh:
                with self.assertRaises(fetcher.PublicFetchError):
                    fetcher._resolve(HOST, 443)
                doh.assert_not_called()


class DoHAnswerTests(unittest.TestCase):
    def assert_rejected(self, payload, kind=1):
        with self.assertRaises(fetcher.PublicFetchError):
            fetcher._parse_doh_answer(payload, HOST, kind)

    def test_direct_and_cname_terminal_addresses_are_accepted(self):
        self.assertEqual(fetcher._parse_doh_answer(answer(), HOST, 1), [PUBLIC_V4])
        payload = answer(records=[record('cdn.example.net.', kind=5),
                                  record(PUBLIC_V4, owner='cdn.example.net')])
        self.assertEqual(fetcher._parse_doh_answer(payload, HOST, 1), [PUBLIC_V4])
        payload = answer(28, [record(PUBLIC_V6)])
        self.assertEqual(fetcher._parse_doh_answer(payload, HOST, 28), [PUBLIC_V6])
        self.assertEqual(fetcher._parse_doh_answer(answer(28, []), HOST, 28), [])

    def test_private_fake_and_malformed_addresses_never_become_targets(self):
        for address in ('127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1',
                        '198.18.0.56', '2001:2::37', 'fc00::1', '::ffff:127.0.0.1',
                        'not-an-address', '93.184.216.34:443'):
            kind = 28 if ':' in address and address != '93.184.216.34:443' else 1
            with self.subTest(address=address):
                self.assert_rejected(answer(kind, [record(address, kind=kind)]), kind)
        self.assert_rejected(answer(records=[record(PUBLIC_V4), record('10.0.0.1')]))

    def test_wrong_question_status_types_truncation_and_disabled_validation_reject(self):
        changes = [
            ('Status', 2), ('Status', False), ('TC', True), ('TC', 0),
            ('CD', True), ('CD', 0), ('Question', []),
            ('Question', [{'name': 'unrelated.example.', 'type': 1}]),
            ('Question', [{'name': HOST + '.', 'type': 28}]),
            ('Question', [{'name': HOST + '.', 'type': True}]),
            ('Question', [{'name': HOST + '.', 'type': 1}] * 2),
            ('Answer', {}), ('Answer', [None]),
            ('Answer', [dict(record(PUBLIC_V4), type=True)]),
            ('Answer', [dict(record(PUBLIC_V4), type='1')]),
            ('Answer', [dict(record(PUBLIC_V4), data=123)]),
        ]
        for key, value in changes:
            payload = answer()
            payload[key] = value
            with self.subTest(key=key, value=value):
                self.assert_rejected(payload)
        for key in ('Status', 'TC', 'CD', 'Question'):
            payload = answer()
            del payload[key]
            with self.subTest(missing=key):
                self.assert_rejected(payload)
        for payload in (None, [], 'not a DNS response'):
            with self.subTest(payload=payload):
                self.assert_rejected(payload)

    def test_cname_loops_conflicts_unrelated_addresses_and_overlong_chains_reject(self):
        payloads = [
            answer(records=[record('cdn.example.net.', kind=5),
                            record(HOST + '.', owner='cdn.example.net', kind=5)]),
            answer(records=[record('cdn.example.net.', kind=5),
                            record('other.example.net.', kind=5),
                            record(PUBLIC_V4, owner='cdn.example.net')]),
            answer(records=[record(PUBLIC_V4, owner='unrelated.example.net')]),
            answer(records=[record(PUBLIC_V4), record(PUBLIC_V4, owner='unrelated.example.net')]),
        ]
        chain = [record('alias0.example.net.', kind=5)]
        chain.extend(record(f'alias{i + 1}.example.net.', owner=f'alias{i}.example.net', kind=5)
                     for i in range(8))
        chain.append(record(PUBLIC_V4, owner='alias8.example.net'))
        payloads.append(answer(records=chain))
        for payload in payloads:
            with self.subTest(payload=payload):
                self.assert_rejected(payload)

    def test_record_count_limit_rejects_oversized_answer(self):
        self.assert_rejected(answer(records=[record(PUBLIC_V4)] * 129))

    def test_private_aaaa_aborts_even_when_a_is_public(self):
        payloads = {1: answer(), 28: answer(28, [record('fc00::1')])}
        with mock.patch.object(fetcher, '_doh_query', side_effect=lambda host, kind, deadline: copy.deepcopy(payloads[kind])) as query:
            with self.assertRaises(fetcher.PublicFetchError):
                fetcher._doh_addresses(HOST, 8443, time.monotonic() + 20)
        self.assertEqual({call.args[1] for call in query.call_args_list}, {1, 28})

    def test_failed_aaaa_is_not_treated_as_successful_empty_answer(self):
        def query(host, kind, deadline):
            if kind == 28:
                raise fetcher.PublicFetchError('fixture AAAA failure', 'DNS_FAILED', 502)
            return answer()
        with mock.patch.object(fetcher, '_doh_query', side_effect=query):
            with self.assertRaises(fetcher.PublicFetchError):
                fetcher._doh_addresses(HOST, 443, time.monotonic() + 20)

    def test_successful_empty_family_is_allowed_but_no_addresses_is_not(self):
        with mock.patch.object(fetcher, '_doh_query', side_effect=lambda host, kind, deadline: answer(kind, [] if kind == 28 else [record(PUBLIC_V4)])):
            result = fetcher._doh_addresses(HOST, 8443, time.monotonic() + 20)
        self.assertEqual([(entry[3][0], entry[3][1]) for entry in result], [(PUBLIC_V4, 8443)])
        with mock.patch.object(fetcher, '_doh_query', side_effect=lambda host, kind, deadline: answer(kind, [])):
            with self.assertRaises(fetcher.PublicFetchError):
                fetcher._doh_addresses(HOST, 443, time.monotonic() + 20)

    def test_fallback_resolves_both_families_and_pins_original_destination(self):
        payloads = {1: answer(), 28: answer(28, [record(PUBLIC_V6)])}
        fake = [system_answer('198.18.0.56', 8443), system_answer('2001:2::37', 8443)]
        with mock.patch.object(socket, 'getaddrinfo', return_value=fake) as system_dns, \
                mock.patch.object(fetcher, '_doh_query', side_effect=lambda host, kind, deadline: copy.deepcopy(payloads[kind])) as query:
            resolved = fetcher._resolve(HOST, 8443, deadline=time.monotonic() + 20)
        system_dns.assert_called_once()
        self.assertEqual({call.args[1] for call in query.call_args_list}, {1, 28})
        self.assertEqual({entry[3][0] for entry in resolved}, {PUBLIC_V4, PUBLIC_V6})
        self.assertTrue(all(entry[3][1] == 8443 for entry in resolved))
        raw_socket = mock.Mock()
        tls = mock.Mock()
        tls.wrap_socket.return_value = raw_socket
        with mock.patch.object(socket, 'getaddrinfo', side_effect=AssertionError('second DNS lookup')), \
                mock.patch.object(socket, 'socket', return_value=raw_socket), \
                mock.patch.object(fetcher.ssl, 'create_default_context', return_value=tls):
            connection = fetcher._PinnedConnection(HOST, 8443, resolved, 10, True)
            connection.connect()
            connection.close()
        self.assertIn(raw_socket.connect.call_args.args[0][0], {PUBLIC_V4, PUBLIC_V6})
        self.assertEqual(raw_socket.connect.call_args.args[0][1], 8443)
        tls.wrap_socket.assert_called_once_with(raw_socket, server_hostname=HOST)


class DoHTransportTests(unittest.TestCase):
    def query(self, body=None, status=200, headers=None):
        body = json.dumps(answer()).encode() if body is None else body
        fields = {'Content-Type': 'application/dns-json', 'Content-Length': str(len(body))}
        fields.update(headers or {})
        response = (f'HTTP/1.1 {status} Fixture\r\n' + ''.join(f'{key}: {value}\r\n' for key, value in fields.items()) + '\r\n').encode() + body
        raw_socket = mock.Mock()
        raw_socket.makefile.side_effect = lambda *args, **kwargs: io.BytesIO(response)
        tls = mock.Mock()
        tls.wrap_socket.return_value = raw_socket
        with mock.patch.dict(os.environ, {'HTTPS_PROXY': 'http://127.0.0.1:9999', 'HTTP_PROXY': 'http://127.0.0.1:9999'}), \
                mock.patch.object(socket, 'getaddrinfo', side_effect=AssertionError('provider DNS lookup')), \
                mock.patch.object(socket, 'socket', return_value=raw_socket), \
                mock.patch.object(fetcher.ssl, 'create_default_context', return_value=tls):
            payload = fetcher._doh_query(HOST, 1, time.monotonic() + 20)
        return payload, raw_socket, tls

    def test_provider_transport_uses_fixed_public_bootstrap_tls_and_no_proxy_credentials(self):
        payload, raw_socket, tls = self.query()
        self.assertEqual(payload, answer())
        for call in raw_socket.connect.call_args_list:
            self.assertIn(call.args[0][0], {'1.1.1.1', '1.0.0.1'})
            self.assertEqual(call.args[0][1], 443)
        self.assertGreaterEqual(raw_socket.connect.call_count, 1)
        tls.wrap_socket.assert_called_once_with(raw_socket, server_hostname='cloudflare-dns.com')
        request = b''.join(call.args[0] for call in raw_socket.sendall.call_args_list)
        request_line = request.split(b'\r\n', 1)[0].decode()
        method, target, version = request_line.split(' ')
        self.assertEqual(method, 'GET')
        parsed = urllib.parse.urlsplit(target)
        self.assertEqual(parsed.path, '/dns-query')
        query = urllib.parse.parse_qs(parsed.query)
        self.assertEqual(query['name'], [HOST])
        self.assertIn(query['type'], (['1'], ['A']))
        self.assertIn(b'Host: cloudflare-dns.com\r\n', request)
        self.assertIn(b'Accept: application/dns-json\r\n', request)
        self.assertIn(b'Accept-Encoding: identity\r\n', request)
        for forbidden in (b'Cookie:', b'Authorization:', b'Proxy-Authorization:', b'CONNECT '):
            self.assertNotIn(forbidden, request)
        raw_socket.close.assert_called()

    def test_redirect_compression_wrong_type_and_oversize_responses_reject(self):
        cases = [
            {'status': 302, 'headers': {'Location': 'http://127.0.0.1/private'}},
            {'headers': {'Content-Encoding': 'gzip'}},
            {'headers': {'Content-Type': 'text/html'}},
            {'headers': {'Content-Length': '9' * 5000}},
            {'body': b'x' * (64 * 1024 + 1)},
            {'body': b'{not JSON'},
            {'body': b'\xff\xfe'},
        ]
        for case in cases:
            with self.subTest(case={key: value if key != 'body' else len(value) for key, value in case.items()}):
                with self.assertRaises(fetcher.PublicFetchError):
                    self.query(**case)

    def test_duplicate_json_keys_nonfinite_and_unbounded_nesting_fail_closed(self):
        for body in (b'{"Status":2,"Status":0}', b'{"Status":NaN}', b'[' * 1100 + b']' * 1100):
            with self.subTest(body=body[:30]), self.assertRaises(fetcher.PublicFetchError):
                self.query(body=body)

    def test_bad_tls_certificate_never_downgrades_or_queries_system_dns(self):
        raw = mock.Mock()
        tls = mock.Mock()
        tls.wrap_socket.side_effect = ssl.SSLCertVerificationError('fixture untrusted certificate')
        with mock.patch.object(socket, 'socket', return_value=raw), \
                mock.patch.object(socket, 'getaddrinfo', side_effect=AssertionError('Unexpected provider DNS')), \
                mock.patch.object(fetcher.ssl, 'create_default_context', return_value=tls), \
                self.assertRaises(fetcher.PublicFetchError) as caught:
            fetcher._doh_query(HOST, 1, time.monotonic() + 5)
        self.assertEqual(caught.exception.code, 'DNS_FALLBACK_FAILED')
        self.assertEqual(raw.sendall.call_count, 0)
        self.assertEqual(tls.wrap_socket.call_count, 2)
        for call in tls.wrap_socket.call_args_list:
            self.assertEqual(call.kwargs, {'server_hostname': 'cloudflare-dns.com'})
        self.assertEqual({call.args[0][0] for call in raw.connect.call_args_list}, {'1.1.1.1', '1.0.0.1'})

    def test_absolute_deadline_interrupts_stalled_headers_and_closes_the_same_socket(self):
        released = threading.Event()
        connection = mock.Mock()
        connection.sock.shutdown.side_effect = lambda _: released.set()

        def stalled_headers():
            if not released.wait(1):
                raise AssertionError('DNS deadline did not interrupt the stalled socket')
            raise OSError('socket closed by deadline')

        connection.getresponse.side_effect = stalled_headers
        started = time.monotonic()
        with mock.patch.object(fetcher, '_PinnedConnection', return_value=connection), self.assertRaises(fetcher.PublicFetchError) as caught:
            fetcher._doh_query(HOST, 1, started + .05)
        self.assertEqual(caught.exception.code, 'DNS_FALLBACK_TIMEOUT')
        self.assertLess(time.monotonic() - started, .5)
        connection.sock.shutdown.assert_called_once_with(socket.SHUT_RDWR)
        connection.close.assert_called_once()

    def test_both_queries_share_short_dns_budget_and_expired_total_budget_does_not_open(self):
        deadlines = []

        def query(host, kind, deadline):
            deadlines.append(deadline)
            return answer(kind, [] if kind == 28 else [record(PUBLIC_V4)])

        now = time.monotonic()
        with mock.patch.object(fetcher, '_doh_query', side_effect=query):
            fetcher._doh_addresses(HOST, 443, now + 60)
        self.assertEqual(deadlines[0], deadlines[1])
        self.assertGreater(deadlines[0], now)
        self.assertLessEqual(deadlines[0], now + fetcher.DOH_TIMEOUT + .1)
        with mock.patch.object(fetcher, '_doh_query') as queried, self.assertRaises(fetcher.PublicFetchError):
            fetcher._doh_addresses(HOST, 443, now - 1)
        queried.assert_not_called()
        with mock.patch.object(fetcher, '_resolve') as resolved, self.assertRaises(fetcher.PublicFetchError) as caught:
            fetcher.fetch_public_url('https://example.com/', total_timeout=0)
        self.assertEqual(caught.exception.code, 'DOWNLOAD_TIMEOUT')
        resolved.assert_not_called()


if __name__ == '__main__':
    unittest.main()
