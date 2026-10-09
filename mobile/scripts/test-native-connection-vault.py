#!/usr/bin/env python3
"""Run exact Swift production CAS/session code with deterministic synthetic storage, no simulator."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
source = (root / 'ios/App/App/MobileBridge.swift').read_text()
helper = source.split('// BEGIN CONNECTION_NATIVE_VAULT\n', 1)[1].split('// END CONNECTION_NATIVE_VAULT', 1)[0]
tests = (root / 'tests/native-connection-vault.swift').read_text()
with tempfile.TemporaryDirectory(prefix='aibro-connection-vault-') as folder:
    main = Path(folder) / 'main.swift'
    main.write_text('import Foundation\nimport Security\nimport CryptoKit\n' + helper + '\n' + tests)
    binary = Path(folder) / 'vault-tests'
    subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', str(main), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
