#!/usr/bin/env python3
"""Run isolated cloud tests with an already installed scrypt-capable Python."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
PROBE = 'import hashlib, sys; raise SystemExit(not (sys.version_info >= (3, 9) and callable(getattr(hashlib, "scrypt", None))))'


def python_with_scrypt():
    candidates = [sys.executable]
    for name in ('python3.12', 'python3.13', 'python3.14', 'python3.11', 'python3.10', 'python3.9', 'python3'):
        executable = shutil.which(name)
        if executable: candidates.append(executable)
    # macOS GUI launch environments may omit Homebrew from PATH.
    for prefix in ('/opt/homebrew/bin', '/usr/local/bin'):
        candidates.extend(str(Path(prefix) / name) for name in ('python3.12', 'python3.13', 'python3.11', 'python3'))
    seen = set()
    for executable in candidates:
        if not executable or executable in seen: continue
        seen.add(executable)
        try:
            if subprocess.run([executable, '-c', PROBE], stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=10).returncode == 0:
                return executable
        except (OSError, subprocess.TimeoutExpired):
            continue
    raise SystemExit('Cloud tests require an installed Python with hashlib.scrypt, such as Python 3.12. No dependencies were installed.')


def main():
    executable = python_with_scrypt()
    print('Cloud test runtime: ' + executable, flush=True)
    passed = 0
    for test in ('tests/cloud-server.test.py', 'tests/cloud-sync.test.py'):
        print('Running ' + test, flush=True)
        with tempfile.TemporaryDirectory(prefix='ai-bro-cloud-test-') as temporary:
            environment = os.environ.copy()
            environment.update({
                'PYTHONPATH': str(ROOT),
                'PYTHONDONTWRITEBYTECODE': '1',
                'AI_WORKSTATION_DATA_DIR': str(Path(temporary) / 'workspace'),
                'AI_WORKSTATION_ASSET_DIR': str(ROOT),
                'AI_WORKSTATION_PORT': '0',
                'CLOUD_DATA_DIR': str(Path(temporary) / 'cloud'),
            })
            result = subprocess.run([executable, str(ROOT / test)], cwd=ROOT, env=environment)
        if result.returncode:
            return result.returncode if result.returncode > 0 else 1
        passed += 1
    print(f'Cloud test files: {passed}/2 passed', flush=True)
    return 0


if __name__ == '__main__': raise SystemExit(main())
