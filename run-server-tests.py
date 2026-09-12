#!/usr/bin/env python3
"""Run each backend test with an isolated workspace, including import side effects."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parent
SERVER_TESTS = (
    'tests/server.test.py',
    'tests/assets-http.test.py',
    'tests/api-proxy.test.py',
    'tests/pdf-preview.test.py',
    'tests/codex-auth.test.py',
    'tests/paper-figures.test.py',
    'tests/research-vault.test.py',
    'tests/recovery.test.py',
    'tests/local-projects.test.py',
    'tests/content-purge.test.py',
    'tests/sync-store.test.py',
    'tests/sync-merge.test.py',
    'tests/cloud-sync.test.py',
    'tests/server-sync.test.py',
    'tests/cloud-recovery.test.py',
    'tests/url-fetch.test.py',
)


def main():
    passed = 0
    for test in SERVER_TESTS:
        # server.py constructs its global WorkspaceStore during import. Set
        # this before starting Python, not after the test has imported it.
        with tempfile.TemporaryDirectory(prefix='ai-bro-server-test-') as temporary:
            environment = os.environ.copy()
            environment.update({
                'PYTHONPATH': str(ROOT),
                'PYTHONDONTWRITEBYTECODE': '1',
                'AI_WORKSTATION_DATA_DIR': str(Path(temporary) / 'workspace'),
                'AI_WORKSTATION_ASSET_DIR': str(ROOT),
                'AI_WORKSTATION_PORT': '0',
                'CLOUD_DATA_DIR': str(Path(temporary) / 'cloud'),
            })
            print(f'[{passed + 1}/{len(SERVER_TESTS)}] Running {test} with isolated data', flush=True)
            result = subprocess.run([sys.executable, str(ROOT / test)], cwd=ROOT, env=environment)
            if result.returncode:
                print(f'Backend tests: {passed}/{len(SERVER_TESTS)} passed; failed: {test}', flush=True)
                return result.returncode if result.returncode > 0 else 1
            passed += 1
    print(f'Backend tests: {passed}/{len(SERVER_TESTS)} passed', flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
