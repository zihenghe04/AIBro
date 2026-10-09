"""On-host deployer tests: fake systemctl, real temporary SQLite and HTTP only.

No SSH, production files, real credentials, App, renderer or native build.
"""
import contextlib
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'mobile/scripts/deploy-connection-sync.py'
spec = importlib.util.spec_from_file_location('connection_deployment', SCRIPT)
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
TOKEN = 'q' * 43  # Synthetic pre-existing token, never a login or a real credential.


FAKE_SYSTEMCTL = r'''
import json,os,pathlib,re,signal,subprocess,sys,time,socket,shlex
directory=pathlib.Path(__file__).parent
state_path=directory/'service-state.json'
state=json.loads(state_path.read_text())
command=sys.argv[2]
with (directory/'systemctl-calls.jsonl').open('a') as f:f.write(json.dumps({'command':command,'all':'--all' in sys.argv})+'\n')
def write():state_path.write_text(json.dumps(state))
def origin():
 path=pathlib.Path(state['drop'])
 if not path.exists():return ''
 m=re.search('CLOUD_CONNECTION_ORIGIN=([^"\n]+)',path.read_text())
 return m.group(1) if m else ''
if command=='show':
 values=dict(state['properties'])
 values['DropInPaths']=' '.join(shlex.quote(str(p)) for p in sorted(pathlib.Path(state['drop']).parent.glob('*.conf')))
 values['Environment']=state['properties']['Environment']+(' CLOUD_CONNECTION_ORIGIN='+origin() if origin() else '')
 values.update(ActiveState='active' if state['active'] else 'inactive',MainPID=str(state['pid']),ControlPID='0')
 if state.get('omitEnvEvenAll'):values.pop('EnvironmentFiles',None)
 if state.get('omitMainPID'):values.pop('MainPID',None)
 for k,v in values.items():
  if v or '--all' in sys.argv:print(k+'='+v)
elif command=='stop':
 if state['pid']:
  try:os.kill(state['pid'],signal.SIGTERM)
  except ProcessLookupError:pass
 state.update(active=False,pid=0);write()
 for _ in range(100):
  s=socket.socket();s.settimeout(.05)
  try:s.connect(('127.0.0.1',state['port']))
  except OSError:break
  finally:s.close()
  time.sleep(.02)
elif command=='start':
 if state.get('failNewStartOnce') and origin():
  state['failNewStartOnce']=False;write();sys.exit(1)
 env=dict(os.environ);env['FIXTURE_ORIGIN']=origin()
 env['FIXTURE_BAD_CAPABILITIES']='1' if state.get('badCapabilities') and origin() else ''
 child=subprocess.Popen([state['python'],'-B',str(directory/'fixture-http.py'),str(directory)],
   env=env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
 state.update(active=True,pid=child.pid);write()
elif command!='daemon-reload':sys.exit(2)
'''


FIXTURE_HTTP = r'''
import json,os,pathlib,sys
root=pathlib.Path(sys.argv[1]);state=json.loads((root/'service-state.json').read_text())
sys.path.insert(0,state['current'])
import cloud_server
store=cloud_server.CloudStore(state['data'],connection_origin=os.environ.get('FIXTURE_ORIGIN') or None)
if os.environ.get('FIXTURE_BAD_CAPABILITIES'):
 original=store.capabilities
 def bad():
  # A real write AFTER the deployment's pre-start row proof. Rollback must retain it.
  with store.db() as db:
   db.execute("INSERT OR IGNORE INTO entities VALUES('fixture-account','notes','arrived-after-restart',1,0,'new client write')")
  value=original();value['encryptedConnectionProfiles']['origin']='https://wrong.example';return value
 store.capabilities=bad
server=cloud_server.CloudHTTPServer(('127.0.0.1',state['port']),store)
server.serve_forever()
'''


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='deploy-contract-', suffix='.noindex', dir=ROOT / 'mobile/build')
        self.root = Path(self.temp.name)
        self.base = self.root / 'cloud'
        self.current = self.base / 'current'
        self.data = self.base / 'data'
        self.stage = self.root / 'stage'
        self.units = self.root / 'systemd/user'
        self.service = 'aibro-fixture.service'
        self.drop_dir = self.units / (self.service + '.d')
        self.drop = self.drop_dir / '60-connection-sync.conf'
        for path in (self.current, self.data, self.stage, self.drop_dir):
            path.mkdir(parents=True, mode=0o700)
        for name in deploy.FILES:
            shutil.copyfile(ROOT / 'app' / name, self.stage / name)
            (self.stage / name).chmod(0o600)
        shutil.copyfile(ROOT / 'app/cloud_server.py', self.current / 'cloud_server.py')
        shutil.copyfile(ROOT / 'app/cloud_web.py', self.current / 'cloud_web.py')
        (self.current / 'cloud_server.py').chmod(0o600)
        cloud_spec = importlib.util.spec_from_file_location('deployment_fixture_cloud', self.current / 'cloud_server.py')
        cloud = importlib.util.module_from_spec(cloud_spec)
        cloud_spec.loader.exec_module(cloud)
        cloud.CloudStore(self.data)
        self.db = self.data / 'cloud.sqlite3'
        with sqlite3.connect(self.db) as db:
            db.execute('INSERT INTO accounts VALUES(?,?,?,?,?,?)',
                       ('fixture-account', 'synthetic-user', bytes(range(16)), bytes(range(32)), 1, 1))
            db.execute('INSERT INTO devices VALUES(?,?,?,?,?,?)', ('fixture-device', 'fixture-account', 'Synthetic', 1, 1, None))
            db.execute('INSERT INTO tokens VALUES(?,?,?,?)',
                       (hashlib.sha256(TOKEN.encode()).hexdigest(), 'fixture-account', 'fixture-device', int(time.time()) + 3600))
            db.execute('INSERT INTO entities VALUES(?,?,?,?,?,?)', ('fixture-account', 'notes', 'legacy', 1, 0, 'private fixture text'))
            db.execute('CREATE TABLE legacy_extension(id INTEGER PRIMARY KEY AUTOINCREMENT, value BLOB, score REAL)')
            db.execute('INSERT INTO legacy_extension(value,score) VALUES(?,?)', (b'\x00\x01\xff', 1.25))
        self.unit = self.units / self.service
        self.unit.write_text('[Service]\n# Existing unrelated unit is never changed\n')
        self.unit.chmod(0o600)
        self.web_drop = self.drop_dir / '30-web.conf'
        self.web_drop.write_text('[Service]\nEnvironment="EXISTING_FEATURE=kept"\n')
        self.web_drop.chmod(0o600)
        self.fake = self.root / 'systemctl'
        self.fake.write_text('#!' + sys.executable + '\n' + FAKE_SYSTEMCTL)
        self.fake.chmod(0o700)
        (self.root / 'fixture-http.py').write_text(FIXTURE_HTTP)
        with contextlib.closing(socket.socket()) as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]
        argv = [sys.executable, str(self.current / 'cloud_server.py'), '--data-dir', str(self.data),
                'serve', '--host', '127.0.0.1', '--port', str(self.port)]
        props = {'ExecStart': '{ path=' + sys.executable + ' ; argv[]=' + ' '.join(__import__('shlex').quote(x) for x in argv)
                 + ' ; ignore_errors=no ; pid=1 ; }', 'Environment': 'EXISTING_FEATURE=kept', 'EnvironmentFiles': '',
                 'FragmentPath': str(self.unit)}
        self.state_path = self.root / 'service-state.json'
        self.state = {'active': False, 'pid': 0, 'properties': props, 'python': sys.executable,
                      'current': str(self.current), 'data': str(self.data), 'port': self.port, 'drop': str(self.drop)}
        self.save_state()
        self.ctl('start')
        self.wait_health()
        self.manifest = {'format': deploy.FORMAT, 'ownerUid': os.geteuid(), 'baseDir': str(self.base),
            'currentLink': None, 'service': self.service, 'python': sys.executable, 'systemctl': str(self.fake),
            'allowOwnerGroupWritePaths': [], 'origin': 'https://sync.example.test',
            'healthBase': 'http://127.0.0.1:' + str(self.port), 'dropIn': str(self.drop), 'execArgv': argv,
            'expected': {'files': {'cloud_server.py': deploy.sha((self.current / 'cloud_server.py').read_bytes()),
                                  'connection_sync_store.py': None},
                         'unitFiles': [{'path': str(p), 'sha256': deploy.sha(p.read_bytes())} for p in (self.unit, self.web_drop)],
                         'properties': {k: deploy.sha(props[k].encode()) for k in deploy.PROPERTY_NAMES},
                         'dropInSha256': None},
            'payload': {'directory': str(self.stage), 'files': {name: deploy.sha((self.stage / name).read_bytes()) for name in deploy.FILES}}}
        self.manifest_path = self.root / 'manifest.json'
        self.save_manifest()

    def tearDown(self):
        try:
            self.ctl('stop')
        finally:
            self.temp.cleanup()

    def save_state(self):
        self.state_path.write_text(json.dumps(self.state))

    def change_state(self, **kw):
        self.state = json.loads(self.state_path.read_text())
        self.state.update(kw)
        self.save_state()

    def save_manifest(self):
        self.manifest_path.write_text(json.dumps(self.manifest))
        self.manifest_path.chmod(0o600)

    def ctl(self, command):
        subprocess.run([str(self.fake), '--user', command, self.service], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)

    def wait_health(self):
        for _ in range(50):
            try:
                with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
                        'http://127.0.0.1:' + str(self.port) + '/v1/health', timeout=.3) as response:
                    if json.load(response) == {'protocol': 1}:
                        return
            except OSError:
                time.sleep(.03)
        self.fail('isolated HTTP fixture failed to start')

    def run_cli(self, apply=False, token=TOKEN):
        args = [sys.executable, '-B', str(SCRIPT), '--manifest', str(self.manifest_path)]
        if apply:
            args += ['--apply', '--token-fd', '0']
        else:
            args += ['--preflight']
        result = subprocess.run(args, input=token if apply else '', text=True, capture_output=True, timeout=25)
        for forbidden in (TOKEN, 'synthetic-user', 'private fixture text'):
            self.assertNotIn(forbidden, result.stdout + result.stderr)
        return result, json.loads(result.stdout if result.returncode == 0 else result.stderr)

    def reports(self):
        return list((self.base / 'releases').glob('connection-sync-*/deployment.json'))

    def test_preflight_is_read_only_and_rejects_stale_hash_or_extra_dropin(self):
        protected = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in (self.db, self.unit, self.web_drop, self.current / 'cloud_server.py')}
        result, value = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(value['readOnly'])
        self.assertFalse(value['databaseOpened'])
        self.assertFalse((self.base / 'releases').exists())
        self.assertFalse((self.base / '.connection-deploy.lock').exists())
        shows = [json.loads(line) for line in (self.root / 'systemctl-calls.jsonl').read_text().splitlines()
                 if json.loads(line)['command'] == 'show']
        self.assertTrue(shows)
        self.assertTrue(all(call['all'] for call in shows))
        self.assertEqual(protected, {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in protected})
        self.manifest['expected']['files']['cloud_server.py'] = '0' * 64
        self.save_manifest()
        self.assertEqual(self.run_cli()[1]['error'], 'BASELINE_HASH_CHANGED')
        self.manifest['expected']['files']['cloud_server.py'] = deploy.sha(protected[self.current / 'cloud_server.py'][0])
        self.save_manifest()
        (self.drop_dir / '99-unreviewed.conf').write_text('[Service]\n')
        self.assertEqual(self.run_cli()[1]['error'], 'UNIT_INVENTORY_CHANGED')

    def test_real_additive_migration_preserves_all_legacy_tables_and_native_capabilities(self):
        before = deploy.fingerprint(self.db)
        result, report = self.run_cli(apply=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(report['applied'])
        self.assertTrue(report['authenticatedCapabilitiesVerified'])
        self.assertTrue(report['allExistingRowsUnchanged'])
        self.assertEqual(report['addedTables'], sorted(deploy.NEW_TABLES))
        backup = Path(report['backup'])
        self.assertEqual(deploy.fingerprint(backup / 'cloud.sqlite3'), before)
        after = deploy.fingerprint(self.db)
        # Live authentication updates last_seen_at by design; all other old rows
        # incl. extension/SQLite sequence survived (not just the legacy six).
        for name in before['tables']:
            if name != 'devices':
                self.assertEqual(after['tables'][name], before['tables'][name], name)
        self.assertIn('legacy_extension', before['tables'])
        self.assertIn('sqlite_sequence', before['tables'])
        self.assertEqual(self.web_drop.read_text(), '[Service]\nEnvironment="EXISTING_FEATURE=kept"\n')
        self.assertEqual((self.current / 'cloud_web.py').read_bytes(), (ROOT / 'app/cloud_web.py').read_bytes())
        self.assertEqual(self.drop.read_text(), '[Service]\nEnvironment="CLOUD_CONNECTION_ORIGIN=https://sync.example.test"\n')
        self.assertEqual((backup / 'cloud.sqlite3').stat().st_mode & 0o777, 0o600)
        commands = [json.loads(line)['command'] for line in (self.root / 'systemctl-calls.jsonl').read_text().splitlines()]
        self.assertIn('stop', commands)
        self.assertTrue(json.loads(self.state_path.read_text())['active'])

    def test_mutating_migration_rolls_back_before_start_and_restores_exact_snapshot(self):
        before = deploy.fingerprint(self.db)
        source = self.stage / 'cloud_server.py'
        text = source.read_text().replace('self.connections = ConnectionSyncStore(',
            "with self.db() as mutation_db: mutation_db.execute(\"DELETE FROM legacy_extension\")\n            self.connections = ConnectionSyncStore(")
        # Keep this fixture anchored to the actual constructor, not a mocked result.
        self.assertNotEqual(text, source.read_text())
        source.write_text(text)
        self.manifest['payload']['files']['cloud_server.py'] = deploy.sha(source.read_bytes())
        self.save_manifest()
        result, value = self.run_cli(apply=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(value['error'], 'EXISTING_ROWS_CHANGED')
        self.assertEqual(deploy.fingerprint(self.db), before)
        self.assertFalse(self.drop.exists())
        self.assertFalse((self.current / 'connection_sync_store.py').exists())
        report = json.loads(self.reports()[0].read_text())
        self.assertTrue(report['rolledBack'])
        self.assertTrue(report['databaseRestored'])
        self.assertFalse(report['additiveDatabaseRetained'])

    def test_capability_failure_rolls_back_code_but_never_erases_postrestart_writes(self):
        self.change_state(badCapabilities=True)
        original = (self.current / 'cloud_server.py').read_bytes()
        result, value = self.run_cli(apply=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(value['error'], 'CAPABILITIES_MISMATCH')
        self.assertEqual((self.current / 'cloud_server.py').read_bytes(), original)
        self.assertFalse(self.drop.exists())
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute("SELECT data FROM entities WHERE entity_id='arrived-after-restart'").fetchone(), ('new client write',))
        report = json.loads(self.reports()[0].read_text())
        self.assertTrue(report['rolledBack'])
        self.assertTrue(report['additiveDatabaseRetained'])
        self.assertFalse(report['databaseRestored'])
        self.assertTrue(json.loads(self.state_path.read_text())['active'])

    def test_start_failure_restores_code_config_and_keeps_additive_database(self):
        self.change_state(failNewStartOnce=True)
        result, value = self.run_cli(apply=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(value['error'], 'SERVICE_COMMAND_FAILED')
        report = json.loads(self.reports()[0].read_text())
        self.assertTrue(report['rolledBack'])
        self.assertTrue(report['additiveDatabaseRetained'])
        self.assertFalse(self.drop.exists())
        self.assertFalse((self.current / 'connection_sync_store.py').exists())

    def test_paths_and_token_preconditions_fail_before_service_stop(self):
        target = self.current / 'cloud_server.py'
        original = target.read_bytes()
        target.unlink()
        target.symlink_to(self.stage / 'cloud_server.py')
        self.assertEqual(self.run_cli()[1]['error'], 'SYMLINK_PATH')
        target.unlink()
        target.write_bytes(original)
        target.chmod(0o600)
        self.manifest['ownerUid'] += 1
        self.save_manifest()
        self.assertEqual(self.run_cli()[1]['error'], 'WRONG_RUN_USER')
        self.manifest['ownerUid'] -= 1
        self.save_manifest()
        self.assertEqual(self.run_cli(apply=True, token='invalid')[1]['error'], 'EXISTING_SESSION_TOKEN_REQUIRED')
        commands = [json.loads(line)['command'] for line in (self.root / 'systemctl-calls.jsonl').read_text().splitlines()]
        self.assertNotIn('stop', commands)

    def test_exact_release_alias_is_allowed_but_retarget_or_nested_alias_is_rejected(self):
        self.ctl('stop')
        releases = self.base / 'releases'
        releases.mkdir(mode=0o700)
        real = releases / 'legacy-release'
        self.current.rename(real)
        self.current.symlink_to(real)
        link = self.current.lstat()
        self.manifest['currentLink'] = {'target': str(real), 'inode': link.st_ino, 'device': link.st_dev}
        self.save_manifest()
        self.ctl('start')
        self.wait_health()
        result, _ = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        result, _ = self.run_cli(apply=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.current.is_symlink())
        self.assertEqual(self.current.lstat().st_ino, link.st_ino)
        # Same path text with a different link inode is still a changed release.
        replacement = self.base / 'replacement'
        replacement.symlink_to(real)
        replacement.replace(self.current)
        self.assertEqual(self.run_cli()[1]['error'], 'CURRENT_LINK_CHANGED')

    def test_group_write_is_explicit_and_cannot_admit_foreign_or_world_writable_paths(self):
        uid = os.geteuid()
        value = type('Info', (), {'st_gid': 123, 'st_uid': uid, 'st_mode': 0o100664})()
        owner = type('User', (), {'pw_gid': 123, 'pw_uid': uid})()
        group = type('Group', (), {'gr_mem': []})()
        with patch.object(deploy.pwd, 'getpwuid', return_value=owner), patch.object(deploy.grp, 'getgrgid', return_value=group), \
             patch.object(deploy.pwd, 'getpwall', return_value=[owner]), patch.object(deploy, 'GROUP_WRITE_PATHS', frozenset([str(self.web_drop)])):
            self.assertTrue(deploy.permitted_mode(self.web_drop, value, uid))
            self.assertFalse(deploy.permitted_mode(self.unit, value, uid))
            value.st_mode = 0o100666
            self.assertFalse(deploy.permitted_mode(self.web_drop, value, uid))
            value.st_mode = 0o100664
            foreign = type('User', (), {'pw_gid': 123, 'pw_uid': uid + 1})()
            with patch.object(deploy.pwd, 'getpwall', return_value=[owner, foreign]):
                self.assertFalse(deploy.permitted_mode(self.web_drop, value, uid))

    def test_systemd249_missing_property_requires_explicit_dbus_empty_array(self):
        self.change_state(omitEnvEvenAll=True)
        actual_run = subprocess.run
        calls = []
        reply = {'object': b'o "/org/freedesktop/systemd1/unit/aibro_2dfixture_2eservice"\n',
                 'property': b'a(sb) 0\n', 'code': 0}
        def bus_or_real(arguments, *args, **kwargs):
            if arguments[0] != '/usr/bin/busctl':
                return actual_run(arguments, *args, **kwargs)
            calls.append(arguments)
            body = reply['object'] if arguments[2] == 'call' else reply['property']
            return subprocess.CompletedProcess(arguments, reply['code'], body, b'')
        with patch.object(deploy, 'root_busctl', return_value='/usr/bin/busctl'), \
             patch.object(deploy.subprocess, 'run', side_effect=bus_or_real):
            self.assertTrue(deploy.Deployment(self.manifest).preflight()['readOnly'])
            self.assertEqual(calls[0], ['/usr/bin/busctl', '--user', 'call', 'org.freedesktop.systemd1',
                             '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', 'GetUnit', 's', self.service])
            self.assertEqual(calls[1], ['/usr/bin/busctl', '--user', 'get-property', 'org.freedesktop.systemd1',
                             '/org/freedesktop/systemd1/unit/aibro_2dfixture_2eservice',
                             'org.freedesktop.systemd1.Service', 'EnvironmentFiles'])
            for value in (b'', b'a(sb) 1 "/private.env" false\n', b'unknown\n'):
                reply['property'] = value
                with self.assertRaisesRegex(deploy.DeployError, '^ENVIRONMENT_FILES_REQUIRE_AUDIT$'):
                    deploy.Deployment(self.manifest).preflight()
            reply.update(property=b'a(sb) 0\n', object=b'o "/unexpected/path"\n')
            with self.assertRaisesRegex(deploy.DeployError, '^ENVIRONMENT_FILES_DBUS_OBJECT$'):
                deploy.Deployment(self.manifest).preflight()
            reply['code'] = 1
            with self.assertRaisesRegex(deploy.DeployError, '^ENVIRONMENT_FILES_DBUS_UNAVAILABLE$'):
                deploy.Deployment(self.manifest).preflight()
            self.change_state(omitMainPID=True)
            count = len(calls)
            with self.assertRaisesRegex(deploy.DeployError, '^SERVICE_STATE_INCOMPLETE$'):
                deploy.Deployment(self.manifest).preflight()
            self.assertEqual(len(calls), count)  # Never guess other missing fields.
        self.assertFalse((self.base / 'releases').exists())

    def test_dbus_binary_must_be_real_root_owned_and_not_writable(self):
        info = type('Stat', (), {'st_mode': 0o100755, 'st_uid': 0})()
        with patch.object(deploy.os, 'stat', return_value=info), patch.object(deploy.os, 'access', return_value=True):
            self.assertEqual(deploy.root_busctl(), '/usr/bin/busctl')
            for uid, mode in ((os.geteuid(), 0o100755), (0, 0o100775), (0, 0o120777)):
                info.st_uid, info.st_mode = uid, mode
                with self.assertRaisesRegex(deploy.DeployError, '^ENVIRONMENT_FILES_DBUS_UNTRUSTED$'):
                    deploy.root_busctl()


if __name__ == '__main__':
    unittest.main()
