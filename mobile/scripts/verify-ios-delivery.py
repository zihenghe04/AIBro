#!/usr/bin/env python3
"""Verify unsigned release contents against the exact current synced frontend."""
import argparse
import hashlib
import json
import pathlib
import plistlib
import re
import struct
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument('archive', type=pathlib.Path)
parser.add_argument('--version', required=True)
parser.add_argument('--build', required=True)
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[1]
archive = args.archive.resolve()
report = json.loads(subprocess.check_output([sys.executable, str(root / 'scripts/verify-ios-archive.py'), str(archive)]))
app = archive / 'Products/Applications/App.app'
assert report['version'] == args.version and report['build'] == args.build
assert json.loads((root / 'package.json').read_text())['version'] == args.version
bundles = [app, *sorted((app / 'PlugIns').glob('*.appex'))]
targets = []
for bundle in bundles:
    info = plistlib.loads((bundle / 'Info.plist').read_bytes())
    binary = (bundle / info['CFBundleExecutable']).read_bytes()
    count = struct.unpack_from('<I', binary, 16)[0]
    offset = 32
    for _ in range(count):
        command, size = struct.unpack_from('<II', binary, offset)
        assert command != 0x1D, 'Unexpected LC_CODE_SIGNATURE'
        offset += size
    assert not (bundle / '_CodeSignature').exists() and not (bundle / 'embedded.mobileprovision').exists()
    targets.append({'bundleIdentifier': info['CFBundleIdentifier'], 'version': info['CFBundleShortVersionString'], 'build': info['CFBundleVersion'], 'minimumIOS': info['MinimumOSVersion'], 'architecture': 'arm64', 'signed': False})

def hashes(folder):
    return {str(p.relative_to(folder)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(folder.rglob('*')) if p.is_file()}

dist = hashes(root / 'dist')
public = hashes(root / 'ios/App/App/public')
archived = hashes(app / 'public')
assert public == archived, 'Synced public differs from archive (including stale files)'
assert all(archived.get(name) == sha for name, sha in dist.items()), 'dist file content differs'
assert {name for name in dist if name.startswith('assets/')} == {name for name in archived if name.startswith('assets/')}, 'Stale assets found'
qa_markers = [b'NativeUIFixture', b'__fixture_seed', b'synthetic-session-only', b'synthetic-test-token', b'aibro-real-agent-040']
checked = 0
for file in app.rglob('*'):
    if not file.is_file():
        continue
    assert file.suffix.lower() not in {'.pem', '.key', '.p12', '.pfx', '.jks', '.keystore'}, 'Signing/test key file leaked into archive'
    assert '.xctest' not in str(file.relative_to(app)), 'XCTest leaked into archive'
    content = file.read_bytes()
    assert not re.search(rb'-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----', content), 'Private key data leaked into archive'
    assert not any(marker in content for marker in qa_markers), 'Known QA fixture code leaked into archive'
    checked += 1
info = plistlib.loads((app / 'Info.plist').read_bytes())
assert info.get('NSMicrophoneUsageDescription')
metadata = app / 'Metadata.appintents/extract.actionsdata'
assert b'OpenVoiceCaptureIntent' in metadata.read_bytes()
locales = ['en', 'zh-Hans']
compiled = []
for locale in locales:
    assert (app / f'{locale}.lproj/AppShortcuts.strings').is_file()
    resource = app / f'{locale}.lproj/nlu.appintents/nlu.lzfse'
    assert resource.is_file()
    compiled.append(str(resource.relative_to(archive)))
report.update(targets=targets, unsigned=True, frontendMatchesBuild=True, frontendFileCount=len(dist), frontendSHA256=dist,
              synchronizedPublicMatchesArchive=True, synchronizedPublicFileCount=len(public), synchronizedPublicSHA256=public,
              appIntentsMetadata=str(metadata.relative_to(archive)), shortcutLocales=locales,
              compiledShortcutLanguageAssets=compiled, microphoneUsageDescriptionPresent=True,
              qaAndPrivateKeyScan={'passed': True, 'filesChecked': checked, 'scope': 'Known QA markers, XCTest bundles, private-key headers and signing-key file types'},
              archiveBytes=sum(p.stat().st_size for p in archive.rglob('*') if p.is_file()))
print(json.dumps(report, ensure_ascii=False, indent=2))
