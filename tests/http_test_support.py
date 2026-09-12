"""Bounded readiness for isolated Python HTTP fixtures, with useful failures."""
from collections import deque
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request


@contextmanager
def python_http_service(script, *, cwd, env, startup_timeout=30):
    # Hosted macOS runners can need more than five seconds for a fresh Python
    # process. This is test setup only; it does not impose a model deadline.
    process = subprocess.Popen(
        [sys.executable, '-u', str(Path(script).resolve())], cwd=cwd,
        env={**os.environ, **env, 'PYTHONUNBUFFERED': '1'},
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding='utf-8', errors='replace',
    )
    output = deque(maxlen=80)
    addresses = []
    changed = threading.Event()

    def drain(stream, name):
        for line in stream:
            output.append(f'{name}: {line.rstrip()[:1000]}')
            if name == 'stdout':
                match = re.search(r'http://127\.0\.0\.1:([0-9]{1,5})(?![0-9])', line)
                if match and 0 < int(match.group(1)) <= 65535:
                    addresses.append(match.group(0))
            changed.set()
        changed.set()

    readers = [threading.Thread(target=drain, args=(stream, name), daemon=True)
               for stream, name in ((process.stdout, 'stdout'), (process.stderr, 'stderr'))]
    for reader in readers:
        reader.start()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + startup_timeout
    last_health_error = 'No loopback startup address was reported.'
    try:
        while True:
            if process.poll() is not None:
                for reader in readers:
                    reader.join(timeout=1)
                raise AssertionError(f'HTTP fixture exited before readiness (exit {process.returncode}).\n' + '\n'.join(output))
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(
                    f'HTTP fixture was not ready after {startup_timeout}s (pid {process.pid}, still running). '
                    + last_health_error + '\n' + '\n'.join(output))
            if addresses:
                origin = addresses[-1]
                try:
                    with opener.open(origin + '/__health', timeout=min(1, remaining)) as response:
                        health = json.loads(response.read(65537))
                        if response.status == 200 and isinstance(health, dict) and health.get('app') == 'ai-workstation' and health.get('port') == int(origin.rsplit(':', 1)[1]):
                            break
                        last_health_error = 'The health response did not identify this workspace service.'
                except (OSError, ValueError, urllib.error.URLError) as error:
                    last_health_error = 'Health probe: ' + str(error)[:300]
            changed.wait(min(0.1, max(0, deadline - time.monotonic())))
            changed.clear()
        yield origin
    finally:
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        for reader in readers:
            reader.join(timeout=1)
        process.stdout.close()
        process.stderr.close()
