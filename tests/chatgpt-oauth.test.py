"""ChatGPT OAuth sign-in against a local fake OAuth server. No real account, network or keychain is used."""
import base64
import json
from pathlib import Path
import socket
import sys
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import chatgpt_oauth as oauth


def jwt(**claims):
    enc = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b'=').decode()
    return enc({'alg': 'none'}) + '.' + enc(claims) + '.sig'


def token_set(n=1, account='acct-1', email='me@example.com'):
    return {'access_token': jwt(exp=9999999999, n=n), 'refresh_token': f'refresh-{n}', 'expires_in': 3600,
            'id_token': jwt(email=email, **{'https://api.openai.com/auth': {'chatgpt_account_id': account, 'chatgpt_plan_type': 'plus'}})}


class Fake:
    def __init__(self):
        self.calls, self.lock = [], threading.Lock()
        self.token_status, self.token_body, self.token_delay = 200, None, 0
        self.device_polls_before_ok = 1
        self.device_status = None
        self.generation = 0
        self.oversize = False
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.0'
            def log_message(self, *args): pass
            def reply(self, status, body):
                data = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(status); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get('Content-Length') or 0))
                path = self.path
                with fake.lock: fake.calls.append((path, raw.decode()))
                if path == '/oauth/token':
                    if fake.token_delay: time.sleep(fake.token_delay)
                    if fake.oversize: return self.reply(200, b'x' * (oauth.MAX_BODY + 10))
                    if fake.token_status != 200: return self.reply(fake.token_status, fake.token_body or {'error': 'boom', 'secret': 'UPSTREAM-SECRET'})
                    with fake.lock: fake.generation += 1; n = fake.generation
                    return self.reply(200, fake.token_body or token_set(n))
                if path == '/api/accounts/deviceauth/usercode':
                    return self.reply(200, {'device_auth_id': 'dev-1', 'user_code': 'ABCD-1234', 'interval': 0, 'expires_in': 900})
                if path == '/api/accounts/deviceauth/token':
                    with fake.lock:
                        fake.device_polls_before_ok -= 1
                        pending = fake.device_polls_before_ok > 0
                    if fake.device_status: return self.reply(fake.device_status, {})
                    if pending: return self.reply(403, {})
                    return self.reply(200, {'authorization_code': 'dcode', 'code_verifier': 'dverifier'})
                self.reply(404, {})

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.origin = f'http://127.0.0.1:{self.server.server_address[1]}'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def token_forms(self):
        return [dict(urllib.parse.parse_qsl(body)) for path, body in self.calls if path == '/oauth/token']

    def close(self): self.server.shutdown(); self.server.server_close()


def wait_for(check, timeout=5):
    end = time.time() + timeout
    while time.time() < end:
        if check(): return True
        time.sleep(0.02)
    return False


class Base(unittest.TestCase):
    def setUp(self):
        self.fake = Fake()
        self.vault = oauth.MemoryVault()
        self.addCleanup(self.fake.close)

    def make(self, **kw):
        kw.setdefault('callback_port', 0)
        kw.setdefault('poll_floor', 0)
        kw.setdefault('min_interval', 0)
        client = oauth.ChatGPTOAuth(self.vault, auth_origin=self.fake.origin, api_origin=self.fake.origin, **kw)
        self.addCleanup(client.cancel_login)
        return client

    def callback(self, url, **override):
        query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
        redirect = urllib.parse.urlsplit(query['redirect_uri'])
        params = {'code': 'auth-code', 'state': query['state']}
        params.update(override)
        params = {k: v for k, v in params.items() if v is not None}
        target = f'http://127.0.0.1:{redirect.port}{redirect.path}?{urllib.parse.urlencode(params)}'
        try:
            with urllib.request.urlopen(target, timeout=5) as response: return response.status
        except urllib.error.HTTPError as error: return error.code


class Primitives(unittest.TestCase):
    def test_pkce_and_url(self):
        verifier, challenge = oauth.pkce_pair()
        self.assertEqual(challenge, oauth.b64url(__import__('hashlib').sha256(verifier.encode()).digest()))
        self.assertGreaterEqual(len(verifier), 43)
        url = oauth.authorize_url(challenge, 'st', 'http://localhost:1455/auth/callback')
        parts = urllib.parse.urlsplit(url); query = dict(urllib.parse.parse_qsl(parts.query))
        self.assertEqual((parts.scheme, parts.netloc, parts.path), ('https', 'auth.openai.com', '/oauth/authorize'))
        self.assertEqual((query['code_challenge_method'], query['redirect_uri'], query['client_id']), ('S256', 'http://localhost:1455/auth/callback', oauth.CLIENT_ID))

    def test_callback_parsing(self):
        self.assertEqual(oauth.parse_callback('code=c&state=s', 's'), ('code', 'c'))
        self.assertEqual(oauth.parse_callback('error=access_denied&state=s', 's'), ('denied', None))
        for bad in ('code=c&state=other', 'code=c', 'code=c&code=d&state=s', 'code=c&error=x&state=s', 'state=s', 'code=&state=s'):
            self.assertIsNone(oauth.parse_callback(bad, 's'), bad)

    def test_identity_from_claims(self):
        self.assertEqual(oauth.identity(token_set(account='a1', email='x@y.z')), ('a1', 'x@y.z', 'plus'))
        only_access = {'access_token': jwt(chatgpt_account_id='a2')}
        self.assertEqual(oauth.identity(only_access)[0], 'a2')
        self.assertEqual(oauth.identity({'access_token': 'garbage'}), (None, None, None))

    def test_origin_pinning_and_no_redirects(self):
        for url in ('https://evil.example/x', 'http://auth.openai.com/x', 'https://auth.openai.com@evil.example/x', 'https://auth.openai.com:8443/x'):
            with self.assertRaises(oauth.OAuthError) as caught: oauth.http_call(url, oauth.AUTH_ORIGIN)
            self.assertEqual(caught.exception.code, 'origin')


class BrowserLogin(Base):
    def test_full_browser_login(self):
        client = self.make()
        started = client.login_start()
        self.assertEqual((started['method'], started['fallback']), ('browser', False))
        self.assertTrue(started['authUrl'].startswith(self.fake.origin + '/oauth/authorize?'))
        self.assertTrue(client.status()['login']['pending'])
        self.assertEqual(self.callback(started['authUrl']), 200)
        self.assertTrue(wait_for(lambda: client.status()['authenticated']))
        form = self.fake.token_forms()[0]
        query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(started['authUrl']).query))
        self.assertEqual(form['grant_type'], 'authorization_code')
        self.assertEqual(oauth.b64url(__import__('hashlib').sha256(form['code_verifier'].encode()).digest()), query['code_challenge'])
        self.assertEqual(form['redirect_uri'], query['redirect_uri'])
        status = client.status()
        self.assertEqual(status['account'], {'email': 'me@example.com', 'planType': 'plus'})
        self.assertFalse(status['login']['pending'])
        self.assertEqual(self.vault.value['account_id'], 'acct-1')
        self.assertEqual(self.vault.value['refresh_token'], 'refresh-1')
        text = json.dumps(status)
        self.assertNotIn('refresh-1', text); self.assertNotIn('access_token', text)
        token, account = client.access()
        self.assertEqual(account, 'acct-1'); self.assertTrue(token)
        self.assertEqual(len(self.fake.token_forms()), 1)

    def test_wrong_state_and_duplicates_do_not_consume_login(self):
        client = self.make()
        url = client.login_start()['authUrl']
        self.assertEqual(self.callback(url, state='forged'), 400)
        self.assertEqual(self.callback(url, state=None), 400)
        self.assertTrue(client.status()['login']['pending'])
        self.assertEqual(self.fake.token_forms(), [])
        self.assertEqual(self.callback(url), 200)
        self.assertTrue(wait_for(lambda: client.status()['authenticated']))

    def test_denied_authorization(self):
        client = self.make()
        url = client.login_start()['authUrl']
        self.assertEqual(self.callback(url, code=None, error='access_denied'), 200)
        self.assertTrue(wait_for(lambda: not client.status()['login']['pending']))
        status = client.status()
        self.assertFalse(status['authenticated']); self.assertIn('拒绝', status['login']['error'])

    def test_cancel_before_callback_releases_port_and_blocks_late_code(self):
        client = self.make()
        url = client.login_start()['authUrl']
        redirect = urllib.parse.urlsplit(dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))['redirect_uri'])
        client.cancel_login()
        with self.assertRaises(OSError): urllib.request.urlopen(f'http://127.0.0.1:{redirect.port}/auth/callback?code=x&state=y', timeout=2)
        self.assertFalse(client.status()['authenticated']); self.assertFalse(client.status()['login']['pending'])

    def test_cancel_while_exchanging_does_not_resurrect_account(self):
        self.fake.token_delay = 0.4
        client = self.make()
        url = client.login_start()['authUrl']
        self.assertEqual(self.callback(url), 200)
        self.assertTrue(wait_for(lambda: self.fake.token_forms()))
        client.cancel_login()
        time.sleep(0.8)
        self.assertFalse(client.status()['authenticated']); self.assertIsNone(self.vault.value)

    def test_newer_login_replaces_older(self):
        client = self.make()
        first = client.login_start()['authUrl']
        second = client.login_start()['authUrl']
        self.assertNotEqual(first, second)
        self.assertEqual(self.callback(second), 200)
        self.assertTrue(wait_for(lambda: client.status()['authenticated']))

    def test_account_missing_in_token_is_an_error(self):
        self.fake.token_body = {'access_token': 'opaque', 'refresh_token': 'r', 'expires_in': 10}
        client = self.make()
        self.assertEqual(self.callback(client.login_start()['authUrl']), 200)
        self.assertTrue(wait_for(lambda: client.status()['login']['error']))
        self.assertFalse(client.status()['authenticated']); self.assertIsNone(self.vault.value)


class DeviceLogin(Base):
    def test_port_conflict_falls_back_to_device_code(self):
        blocker = socket.socket(); blocker.bind(('127.0.0.1', 0)); blocker.listen(1)
        self.addCleanup(blocker.close)
        client = self.make(callback_port=blocker.getsockname()[1])
        started = client.login_start()
        self.assertEqual((started['method'], started['fallback']), ('device', True))
        self.assertEqual(started['userCode'], 'ABCD-1234'); self.assertIn('1455', started['note'])
        self.assertTrue(client.status()['login']['pending'])
        self.assertTrue(wait_for(lambda: client.status()['authenticated']))
        form = self.fake.token_forms()[0]
        self.assertEqual((form['code'], form['code_verifier'], form['redirect_uri']), ('dcode', 'dverifier', oauth.DEVICE_REDIRECT_URI))
        self.assertEqual(self.vault.value['account_id'], 'acct-1')

    def test_device_polls_while_pending_then_expires(self):
        self.fake.device_polls_before_ok = 99; self.fake.device_status = 410
        client = self.make()
        client.login_start(prefer='device')
        self.assertTrue(wait_for(lambda: client.status()['login']['error']))
        self.assertIn('超时', client.status()['login']['error']); self.assertFalse(client.status()['authenticated'])

    def test_cancel_stops_device_polling(self):
        self.fake.device_polls_before_ok = 10 ** 6
        client = self.make(poll_floor=0.05)
        client.login_start(prefer='device')
        time.sleep(0.2); client.cancel_login()
        seen = len([c for c in self.fake.calls if c[0].endswith('/token') and 'deviceauth' in c[0]])
        time.sleep(0.3)
        after = len([c for c in self.fake.calls if c[0].endswith('/token') and 'deviceauth' in c[0]])
        self.assertLessEqual(after - seen, 1)
        self.assertFalse(client.status()['authenticated'])

    def test_cancel_during_device_exchange_does_not_resurrect(self):
        self.fake.token_delay = 0.4
        client = self.make()
        client.login_start(prefer='device')
        self.assertTrue(wait_for(lambda: self.fake.token_forms()))
        client.cancel_login(); time.sleep(0.8)
        self.assertIsNone(self.vault.value); self.assertFalse(client.status()['authenticated'])


class Refresh(Base):
    def signed_in(self, **kw):
        client = self.make(**kw)
        self.assertEqual(self.callback(client.login_start()['authUrl']), 200)
        self.assertTrue(wait_for(lambda: client.status()['authenticated']))
        return client

    def test_expiring_token_refreshes_and_rotates(self):
        now = [1000.0]
        client = self.signed_in(clock=lambda: now[0])
        client.access()
        now[0] += 3600 - 30
        token, account = client.access()
        forms = self.fake.token_forms()
        self.assertEqual([f['grant_type'] for f in forms], ['authorization_code', 'refresh_token'])
        self.assertEqual(forms[1]['refresh_token'], 'refresh-1')
        self.assertEqual(self.vault.value['refresh_token'], 'refresh-2')
        self.assertEqual(account, 'acct-1')

    def test_concurrent_callers_share_one_refresh(self):
        now = [1000.0]
        client = self.signed_in(clock=lambda: now[0])
        now[0] += 4000
        self.fake.token_delay = 0.2
        results = []
        threads = [threading.Thread(target=lambda: results.append(client.access())) for _ in range(8)]
        [t.start() for t in threads]; [t.join() for t in threads]
        self.assertEqual(len(results), 8); self.assertEqual(len({r[0] for r in results}), 1)
        self.assertEqual(len([f for f in self.fake.token_forms() if f['grant_type'] == 'refresh_token']), 1)

    def test_restart_uses_stored_refresh_token(self):
        self.signed_in()
        again = self.make()
        self.assertTrue(again.status()['authenticated'])
        again.access()
        self.assertEqual(self.fake.token_forms()[-1]['grant_type'], 'refresh_token')

    def test_invalid_grant_marks_needs_reauth_and_is_sticky(self):
        now = [1000.0]
        client = self.signed_in(clock=lambda: now[0]); now[0] += 4000
        self.fake.token_status, self.fake.token_body = 400, {'error': 'invalid_grant'}
        with self.assertRaises(oauth.OAuthError) as caught: client.access()
        self.assertEqual(caught.exception.code, 'needs_reauth')
        status = client.status()
        self.assertTrue(status['needsReauth']); self.assertFalse(status['authenticated'])
        self.assertTrue(self.vault.value['needs_reauth'])
        before = len(self.fake.calls)
        with self.assertRaises(oauth.OAuthError): client.access()
        self.assertEqual(len(self.fake.calls), before)  # no more attempts with a dead token
        self.assertEqual(oauth.ChatGPTOAuth(self.vault, auth_origin=self.fake.origin).status()['needsReauth'], True)

    def test_server_error_does_not_mark_needs_reauth(self):
        now = [1000.0]
        client = self.signed_in(clock=lambda: now[0]); now[0] += 4000
        self.fake.token_status = 503
        with self.assertRaises(oauth.OAuthError) as caught: client.access()
        self.assertEqual(caught.exception.code, 'upstream')
        self.assertTrue(client.status()['authenticated'])
        self.assertNotIn('UPSTREAM-SECRET', str(caught.exception))

    def test_logout_during_refresh_does_not_resurrect(self):
        now = [1000.0]
        client = self.signed_in(clock=lambda: now[0]); now[0] += 4000
        self.fake.token_delay = 0.4
        outcome = []
        thread = threading.Thread(target=lambda: outcome.append(self.try_access(client)))
        thread.start(); time.sleep(0.15)
        client.logout(); thread.join()
        self.assertEqual(outcome, ['logged_out'])
        self.assertIsNone(self.vault.value); self.assertFalse(client.status()['authenticated'])

    @staticmethod
    def try_access(client):
        try: client.access(); return 'ok'
        except oauth.OAuthError as error: return error.code

    def test_logout_clears_everything(self):
        client = self.signed_in()
        client.logout()
        self.assertIsNone(self.vault.value)
        with self.assertRaises(oauth.OAuthError) as caught: client.access()
        self.assertEqual(caught.exception.code, 'not_logged_in')

    def test_force_refresh_after_401(self):
        client = self.signed_in()
        first, _ = client.access()
        second, _ = client.access(force=True)
        self.assertNotEqual(first, second)


class Limits(Base):
    def test_oversized_response_rejected_without_echo(self):
        self.fake.oversize = True
        client = self.make()
        self.assertEqual(self.callback(client.login_start()['authUrl']), 200)
        self.assertTrue(wait_for(lambda: client.status()['login']['error']))
        self.assertNotIn('xxxx', client.status()['login']['error'])
        self.assertIsNone(self.vault.value)

    def test_upstream_error_body_never_surfaces(self):
        self.fake.token_status = 500
        client = self.make()
        self.callback(client.login_start()['authUrl'])
        self.assertTrue(wait_for(lambda: client.status()['login']['error']))
        self.assertNotIn('UPSTREAM-SECRET', json.dumps(client.status()))


if __name__ == '__main__':
    unittest.main()
