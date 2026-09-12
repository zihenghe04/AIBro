"""Exercise the shipped resources over HTTP with an isolated data directory."""
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path
from http_test_support import python_http_service

ROOT = (Path(__file__).resolve().parents[1] / 'app')


def node(script, *arguments):
    return subprocess.check_output(['node', '-e', script, *map(str, arguments)], cwd=ROOT, text=True).strip()


@contextmanager
def serve(assets, working_directory):
    # Exercise the shipped __main__ path with an unavailable DNS resolver, not
    # just a substitute HTTP fixture. No real network lookup is performed.
    bootstrap = working_directory / 'dns-blocked-server.py'
    bootstrap.write_text(f'''import runpy, socket, sys
def unexpected_dns(*args, **kwargs):
    raise AssertionError('Loopback startup must not perform reverse DNS')
socket.getfqdn = socket.gethostbyaddr = unexpected_dns
sys.path.insert(0, {str(assets)!r})
runpy.run_path({str(assets / 'server.py')!r}, run_name='__main__')
''')
    with python_http_service(bootstrap, cwd=working_directory,
        env={**os.environ, 'AI_WORKSTATION_PORT': '0', 'AI_WORKSTATION_ASSET_DIR': str(assets), 'AI_WORKSTATION_DATA_DIR': str(working_directory / 'data')},
    ) as origin:
        yield origin


def get(origin, url, method='GET'):
    try:
        response = urllib.request.urlopen(urllib.request.Request(origin + url, method=method), timeout=3)
    except urllib.error.HTTPError as response:
        return response.code, response.headers, response.read()
    with response:
        return response.status, response.headers, response.read()


with tempfile.TemporaryDirectory(prefix='workstation-http-startup-test-') as temporary:
    fixture_directory = Path(temporary)
    script = fixture_directory / 'fixture.py'
    environment = {'AI_WORKSTATION_DATA_DIR': str(fixture_directory / 'data')}
    # A real cold process can take longer than the old five-second pipe wait.
    # Readiness must ignore pre-banner output and confirm the HTTP service.
    script.write_text('''import json, socket, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import TCPServer
print('Preparing the isolated fixture')
time.sleep(5.25)
def unexpected_dns(*args, **kwargs):
    raise AssertionError('Readiness fixture must not perform reverse DNS')
socket.getfqdn = socket.gethostbyaddr = unexpected_dns
class NumericHTTPServer(HTTPServer):
    def server_bind(self):
        TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.health_probes = getattr(self.server, 'health_probes', 0) + 1
        payload = json.dumps({
            'app': 'wrong-service' if self.server.health_probes == 1 else 'ai-workstation',
            'port': self.server.server_port, 'probes': self.server.health_probes,
        }).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
    def log_message(self, *arguments): pass
server = NumericHTTPServer(('127.0.0.1', 0), Handler)
print('Fixture: http://127.0.0.1:' + str(server.server_port))
server.serve_forever()
''')
    started = time.monotonic()
    with python_http_service(script, cwd=fixture_directory, env=environment) as origin:
        assert time.monotonic() - started >= 5.25
        health = json.loads(get(origin, '/__health')[2])
        assert health['app'] == 'ai-workstation'
        assert health['port'] == int(origin.rsplit(':', 1)[1])
        assert health['probes'] >= 3, 'A banner or unrelated health response is not readiness'

    script.write_text("import sys\nprint('fixture setup began')\nprint('synthetic initialization failure', file=sys.stderr)\nsys.exit(7)\n")
    try:
        with python_http_service(script, cwd=fixture_directory, env=environment):
            raise AssertionError('A failed child must not be reported as ready')
    except AssertionError as error:
        diagnostic = str(error)
        assert 'exit 7' in diagnostic
        assert 'stdout: fixture setup began' in diagnostic
        assert 'stderr: synthetic initialization failure' in diagnostic

    script.write_text('import time\ntime.sleep(60)\n')
    try:
        with python_http_service(script, cwd=fixture_directory, env=environment, startup_timeout=0.4):
            raise AssertionError('A silent child must not be reported as ready')
    except AssertionError as error:
        diagnostic = str(error)
        assert 'not ready after 0.4s' in diagnostic
        assert 'No loopback startup address was reported' in diagnostic
        child = re.search(r'pid ([0-9]+)', diagnostic)
        assert child
        try:
            os.kill(int(child.group(1)), 0)
        except ProcessLookupError:
            pass
        else:
            raise AssertionError('A timed-out fixture child was not reaped')


with tempfile.TemporaryDirectory(prefix='workstation-assets-test-') as temporary:
    working_directory = Path(temporary)
    assets = working_directory / 'app'
    copied_count = node("process.stdout.write(String(require('./app-assets').copyAssets(process.argv[1])))", assets)
    manifest = json.loads((assets / 'asset-manifest.json').read_text())
    optional = [name for name in manifest.get('optionalRuntime', []) if (assets / name).is_file()]
    assert int(copied_count) == len(manifest['web']) + len(manifest['runtime']) + len(optional) + 1
    expected_fingerprint = node("process.stdout.write(require('./app-assets').fingerprint(process.argv[1]))", assets)
    config = json.loads(node("const c=require('../scripts/electron-builder.config.cjs'); process.stdout.write(JSON.stringify({files:c.files, asar:c.asar}))"))
    assert config['asar'] is False, 'Python must receive unpacked application resources'
    assert set(config['files']) == set(manifest['web'] + manifest['runtime'] + optional + ['asset-manifest.json'])

    with serve(assets, working_directory) as origin:
        health = json.loads(get(origin, '/__health')[2])
        assert health['assetFingerprint'] == expected_fingerprint, 'Node and Python must agree on the exact build'
        assert health['port'] == int(origin.rsplit(':', 1)[1])
        for resource in manifest.get('optionalRuntime', []):
            assert get(origin, '/' + resource)[0] == 404, 'Native binaries must never be exposed by the web server'
        for resource in manifest['web']:
            status, headers, body = get(origin, '/' + resource + '?test=cache')
            assert status == 200, f'{resource} returned HTTP {status}'
            assert body == (assets / resource).read_bytes(), f'{resource} is stale or incorrectly served'
            assert headers['Cache-Control'] == 'no-store'
            assert headers['X-Content-Type-Options'] == 'nosniff'
            head_status, head_headers, head_body = get(origin, '/' + resource, method='HEAD')
            assert head_status == 200 and not head_body
            assert int(head_headers['Content-Length']) == len(body)
        assert get(origin, '/')[2] == (assets / 'index.html').read_bytes()
        for private in ('/server.py', '/package.json', '/asset-manifest.json', '/tests/', '/%2e%2e/package.json', '/unknown.js'):
            for method in ('GET', 'HEAD'):
                assert get(origin, private, method=method)[0] == 404, f'{method} exposed {private}'
        # Replacing assets while an old process is alive must not allow it to
        # masquerade as the rebuilt application, even with the same version.
        with (assets / 'styles.css').open('a') as handle: handle.write('\n/* next-build */\n')
        new_fingerprint = node("process.stdout.write(require('./app-assets').fingerprint(process.argv[1]))", assets)
        assert new_fingerprint != expected_fingerprint
        assert json.loads(get(origin, '/__health')[2])['assetFingerprint'] == expected_fingerprint

    with serve(assets, working_directory) as origin:
        assert json.loads(get(origin, '/__health')[2])['assetFingerprint'] == new_fingerprint

    # A platform fallback ships the same sources but no optional native addon.
    # Node and Python must still agree, and the native route stays unavailable.
    for resource in optional:
        (assets / resource).unlink()
    fallback_fingerprint = node("process.stdout.write(require('./app-assets').fingerprint(process.argv[1]))", assets)
    if optional:
        assert fallback_fingerprint != new_fingerprint
    with serve(assets, working_directory) as origin:
        assert json.loads(get(origin, '/__health')[2])['assetFingerprint'] == fallback_fingerprint
        for resource in manifest.get('optionalRuntime', []) + ['native-glass.mm', 'native-liquid-glass.js']:
            assert get(origin, '/' + resource)[0] == 404, 'Native implementation must remain private in fallback builds'

    (assets / 'index.html').write_text('<script src="unpublished.js"></script>')
    validation = subprocess.run(['node', str(assets / 'app-assets.js')], capture_output=True, text=True)
    assert validation.returncode != 0 and 'unpublished resource' in validation.stderr
    (assets / 'icons.js').unlink()
    validation = subprocess.run(['node', str(assets / 'app-assets.js')], capture_output=True, text=True)
    assert validation.returncode != 0 and 'Missing application resource: icons.js' in validation.stderr

print('HTTP cold startup, crash diagnostics, bounded cleanup, asset manifest, private routes and build identity tests passed')
