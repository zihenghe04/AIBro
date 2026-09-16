"""SSH management tests use only temporary directories and synthetic service runners."""
import contextlib
import json
import os
from pathlib import Path
import plistlib
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from cloud_ssh import config, read_tunnel, ssh_args, CloudSSH, LABEL
import cloud_ssh_remote as remote
from cloud_sync import CloudSyncError


class SSHTests(unittest.TestCase):
    def test_config_and_ssh_argv_do_not_accept_commands(self):
        for target in ['-oProxyCommand=x', 'host;touch x', 'host\n', 'a@@b', '$(id)', 'host/dir']:
            if target == 'host\n': continue  # surrounding whitespace is trimmed like the UI
            with self.subTest(target=target), self.assertRaises(CloudSyncError): config({'target':target})
        args=ssh_args({'target':'research-alias','sshPort':2222})
        self.assertIn('StrictHostKeyChecking=yes',args); self.assertIn('BatchMode=yes',args)
        self.assertEqual(args[-2:],['-p','2222'])
        self.assertNotIn('-i',args)

    def test_existing_launchagent_is_read_without_changes(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d).resolve()/'tunnel.plist'
            raw=plistlib.dumps({'Label':LABEL,'ProgramArguments':['/usr/bin/ssh','-N','-T','-L','127.0.0.1:18787:127.0.0.1:8787','user@host']})
            path.write_bytes(raw)
            self.assertEqual(read_tunnel(path),{'target':'user@host','sshPort':0,'localPort':18787,'remotePort':8787})
            self.assertEqual(path.read_bytes(),raw)

    def test_identity_and_cursor_checks_reject_another_or_stale_database(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d).resolve();self.database(root)
            remote.account_check(root,'account',5)
            for account,cursor in [('other',0),('account',7)]:
                with self.assertRaises(ValueError):remote.account_check(root,account,cursor)

    def test_target_cannot_overwrite_or_contain_original_or_follow_symlinks(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d).resolve()/'source';root.mkdir()
            link=Path(d).resolve()/'link';link.symlink_to(root,target_is_directory=True)
            for target in [str(root),str(root/'nested'),d,str(link/'new'),'../relative']:
                with self.subTest(target=target),self.assertRaises(ValueError):remote.destination(root,target)
            self.assertEqual(remote.destination(root,str(Path(d).resolve()/'new')),Path(d).resolve()/'new')

    @staticmethod
    def database(path):
        path.mkdir(exist_ok=True)
        with sqlite3.connect(path/'cloud.sqlite3') as db:
            db.execute('CREATE TABLE accounts (id TEXT, change_seq INTEGER)')
            db.execute('INSERT INTO accounts VALUES (?,?)',('account',6))
        (path/'attachment').write_bytes(b'synthetic file content')

    def run_move(self,fail_health=False):
        with tempfile.TemporaryDirectory() as d:
            home=Path(d).resolve();source=home/'source';target=home/'new';self.database(source)
            before=remote.manifest(source)
            folder=home/'.config/systemd/user'/f'{remote.UNIT}.d';folder.mkdir(parents=True)
            override=folder/'90-aibro-storage.conf';old=b'[Service]\n# previous config\n';override.write_bytes(old)
            commands=[]
            def control(*args):commands.append(args);return '0' if args[0]=='show' else ''
            def deployment(*args):
                current=target if str(target).encode() in override.read_bytes() else source
                return {'dataPath':str(current),'databasePath':str(current/'cloud.sqlite3'),'remotePort':8787,'active':True,'argv':['/usr/bin/python3','/opt/cloud_server.py','--data-dir',str(source),'serve','--host','127.0.0.1','--port','8787']}
            class Opener:
                def open(self,*a,**k):
                    if fail_health:raise OSError('simulated')
                    from io import BytesIO
                    return BytesIO(b'{"protocol":1}')
            with patch.object(remote.Path,'home',return_value=home),patch.object(remote,'control',side_effect=control),patch.object(remote,'deployment',side_effect=deployment),patch.object(remote.urllib.request,'build_opener',return_value=Opener()):
                payload={'accountId':'account','cursor':5,'expectedPath':str(source),'dataPath':str(target)}
                if fail_health:
                    with self.assertRaisesRegex(ValueError,'恢复旧服务'):remote.relocate(payload)
                    self.assertEqual(override.read_bytes(),old)
                else:
                    result=remote.relocate(payload);self.assertEqual(result['dataPath'],str(target));self.assertEqual(result['previousPath'],str(source))
                self.assertEqual(remote.manifest(source),before)
                self.assertEqual((target/'attachment').read_bytes(),b'synthetic file content')
                self.assertIn(('stop',remote.UNIT),commands)
                self.assertEqual(commands[-1],('start',remote.UNIT))

    def test_copy_checksum_and_switch_preserves_original(self):self.run_move()
    def test_failed_health_restores_old_override_and_keeps_both_copies(self):self.run_move(True)

    def test_systemd_quoting_is_not_shell_interpolation(self):
        self.assertEqual(remote.systemd_arg('/home/u/a%$b'), '"/home/u/a%%$$b"')

    def test_failed_tunnel_reconnect_restores_previous_configuration(self):
        from types import SimpleNamespace
        import threading
        with tempfile.TemporaryDirectory() as d:
            service=SimpleNamespace(_sync_lock=threading.Lock())
            launches=[]
            def runner(args,**kwargs):
                launches.append(args[1]);return SimpleNamespace(returncode=1 if launches==['bootout','bootstrap'] else 0)
            manager=CloudSSH(service,home=Path(d).resolve(),runner=runner)
            manager.path.parent.mkdir(parents=True)
            original=plistlib.dumps({'Label':LABEL,'ProgramArguments':['/usr/bin/ssh','-N','-L','127.0.0.1:18787:127.0.0.1:8787','old-host']})
            manager.path.write_bytes(original)
            with patch.object(manager,'_bound',return_value={'accountId':'fixture'}),patch.object(manager,'_remote',return_value={'remotePort':8787}):
                with self.assertRaisesRegex(CloudSyncError,'还原旧配置'):manager.save({'config':{'target':'new-host'}})
            self.assertEqual(manager.path.read_bytes(),original)
            self.assertEqual(launches,['bootout','bootstrap','bootout','bootstrap'])
            self.assertFalse(service._sync_lock.locked());self.assertFalse(manager.lock.locked())
            self.assertEqual(len(list(manager.path.parent.glob('*.backup-*'))),1)

    def test_move_requires_confirmation_before_any_action(self):
        with tempfile.TemporaryDirectory() as d:
            ssh=CloudSSH(None,home=d,runner=lambda *a,**k:self.fail('must not run commands'))
            with self.assertRaisesRegex(CloudSyncError,'确认'):ssh.move({})

if __name__=='__main__':unittest.main()
