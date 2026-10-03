"""Synthetic-only external notification protocol, persistence and host routing."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

APP = Path(__file__).resolve().parents[1] / 'app'
sys.path.insert(0,str(APP))
from external_notifications import ExternalNotifications, NotificationError, normalize, MAX_BODY
sys.path.insert(0,str(Path(__file__).parent))
from http_test_support import python_http_service
TOKEN='n'*64


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.folder=Path(self.tmp.name).resolve()/'notifications'
        self.now=1000.0
        self.store=ExternalNotifications(self.folder,TOKEN,lambda:self.now)
        self.store.port=8765
    def tearDown(self):
        self.store.close();self.tmp.cleanup()
    def configure(self,enabled=True,available=True):
        return self.store.configure({'enabled':enabled,'available':available,'revision':self.store.revision+1})
    def send(self,index=1,**extra):
        return self.store.receive('codex',{'type':'agent-turn-complete','turn_id':str(index),'title':'Synthetic completion',**extra},self.store.producer_token)
    def test_default_off_distinct_tokens_and_stale_configuration(self):
        self.assertFalse(self.folder.exists())
        self.assertFalse(self.store.status()['enabled'])
        with self.assertRaisesRegex(NotificationError,'paused'):self.send()
        self.configure()
        descriptor=json.loads((self.folder/'endpoint.json').read_text())
        self.assertNotEqual(TOKEN,descriptor['token'])
        self.assertEqual(0o600,stat.S_IMODE((self.folder/'endpoint.json').stat().st_mode))
        with self.assertRaisesRegex(NotificationError,'token_required'):self.store.receive('codex',{},TOKEN)
        with self.assertRaisesRegex(NotificationError,'stale'):self.store.configure({'enabled':True,'available':True,'revision':0})
        self.configure(False,False)
        self.assertFalse((self.folder/'endpoint.json').exists())
    def test_persistent_ack_private_epoch_restart_and_retry(self):
        self.configure();first=self.send();gen=self.store.generation
        self.store.acknowledge({'generation':gen,'ids':[first['eventId']]})
        self.assertEqual([],self.store.events()['events'])
        self.send(2)
        self.configure(True,False)
        self.assertEqual([],self.store.events(True)['events'])
        with self.assertRaisesRegex(NotificationError,'paused'):self.send(3)
        self.configure()
        self.assertEqual([],self.store.events()['events'])
        with self.assertRaisesRegex(NotificationError,'stale'):self.store.acknowledge({'generation':gen,'ids':[first['eventId']]})
        self.assertEqual('duplicate',self.send()['result'])
        self.store.close()
        restart=ExternalNotifications(self.folder,TOKEN,lambda:self.now)
        self.assertTrue(restart.status()['enabled']);self.assertFalse(restart.status()['available'])
        restart.port=8765;restart.configure({'enabled':True,'available':True,'revision':0})
        self.assertEqual([],restart.events()['events'])
        self.assertEqual('duplicate',restart.receive('codex',{'turn_id':'1','title':'Synthetic completion'},restart.producer_token)['result'])
        restart.close()
    def test_dedupe_new_turn_history_bound_clear_and_rate(self):
        self.configure()
        for index in range(25):
            self.now+=3
            receipt=self.send(index)
            self.store.acknowledge({'generation':self.store.generation,'ids':[receipt['eventId']]})
        self.assertEqual(20,len(self.store.events(True)['events']))
        self.assertEqual('duplicate',self.send(24)['result'])
        # Retried ACK after its event aged out is still safe/idempotent.
        self.store.acknowledge({'generation':self.store.generation,'ids':[receipt['eventId']]})
        self.store.acknowledge({'generation':self.store.generation},clear=True)
        self.assertEqual([],self.store.events(True)['events'])
        self.assertEqual('duplicate',self.send(24)['result'])
        # Session-only hooks can repeat a genuine identical next turn after 2s.
        p={'session_id':'session','title':'Same title'}
        self.assertEqual('accepted',self.store.receive('claude',p,self.store.producer_token)['result'])
        self.assertEqual('duplicate',self.store.receive('claude',p,self.store.producer_token)['result'])
        self.now+=3
        self.assertEqual('accepted',self.store.receive('claude',p,self.store.producer_token)['result'])
        self.now+=61
        for index in range(30):self.send('burst'+str(index))
        with self.assertRaisesRegex(NotificationError,'rate_limited'):self.send('overflow')
    def test_normalization_is_display_only_and_subagents_ignored(self):
        self.configure()
        payload={'title':'\u202e# Result\nsecret second line','detail':'hello\x00\u2066 world',
                 'cwd':'/private/person/research/project','turn_id':'demo','recordId':'private-note',
                 'command':'rm -rf anything','url':'file:///private/secret','completed_at':999999999999999}
        self.store.receive('gpt',payload,self.store.producer_token)
        event=self.store.events()['events'][0]
        self.assertEqual('# Result',event['title']);self.assertEqual('project',event['project'])
        self.assertEqual(1000000,event['occurredAt'])
        self.assertNotIn('command',event);self.assertNotIn('recordId',event);self.assertNotIn('cwd',event)
        self.assertNotIn('/private/person', (self.folder/'history.json').read_text())
        failed=normalize('codex',{'type':'failed'},self.now)[0]
        self.assertEqual('failed',failed['outcome']);self.assertEqual('Codex 任务未完成',failed['title'])
        for p in ({'agent_id':'child'},{'hook_event_name':'SubagentStop'},{'type':'tool-call'}):
            self.assertEqual('ignored',self.store.receive('claude',p,self.store.producer_token)['result'])
    def test_failed_write_does_not_ack_or_publish_and_pause_revokes_before_io(self):
        self.configure();receipt=self.send()
        before=copy.deepcopy(self.store.state)
        with patch.object(self.store,'_write',side_effect=OSError('injected')):
            with self.assertRaises(OSError):self.store.acknowledge({'generation':self.store.generation,'ids':[receipt['eventId']]})
            self.assertEqual(before,self.store.state)
            with self.assertRaises(OSError):self.send(2)
        self.assertEqual(before,self.store.state)
        with patch.object(self.store,'_remove_endpoint',side_effect=OSError('injected')):
            with self.assertRaises(OSError):self.configure(True,False)
        self.assertFalse(self.store.available)
        with self.assertRaisesRegex(NotificationError,'paused'):self.send(2)
    def test_post_rename_failure_blocks_old_projection_until_restart(self):
        self.configure()
        real_fsync=os.fsync
        failed=False
        def after_rename(fd):
            nonlocal failed
            if stat.S_ISDIR(os.fstat(fd).st_mode) and not failed:
                failed=True
                raise OSError('injected directory sync failure after rename')
            return real_fsync(fd)
        with patch('external_notifications.os.fsync',side_effect=after_rename):
            with self.assertRaisesRegex(NotificationError,'commit_uncertain'):self.send('uncertain')
        written=(self.folder/'history.json').read_bytes()
        self.assertEqual(1,len(json.loads(written)['events']))
        self.assertFalse(self.store.available)
        self.assertEqual('notification_commit_uncertain',self.store.status()['error'])
        # The initiating sender sees 503; the already-loaded Native poller also
        # has to learn that storage requires a restart rather than spin empty.
        with self.assertRaisesRegex(NotificationError,'commit_uncertain'):self.store.events()
        with self.assertRaisesRegex(NotificationError,'commit_uncertain'):self.store.events(history=True)
        self.assertFalse((self.folder/'endpoint.json').exists())
        with self.assertRaisesRegex(NotificationError,'paused'):self.send('must-not-overwrite')
        with self.assertRaisesRegex(NotificationError,'commit_uncertain'):self.configure()
        self.assertEqual(written,(self.folder/'history.json').read_bytes())
        self.store.close()
        restored=ExternalNotifications(self.folder,TOKEN,lambda:self.now)
        restored.port=8765;restored.configure({'enabled':True,'available':True,'revision':0})
        self.assertEqual([],restored.events()['events'])
        restored.receive('codex',{'turn_id':'after-restart'},restored.producer_token)
        self.assertEqual(2,len(restored.events(True)['events']))
        restored.close()
    def test_pending_bounded_no_silent_drop_and_disk_permissions(self):
        self.configure()
        for index in range(100):self.now+=3;self.send(index)
        self.now+=61
        with self.assertRaisesRegex(NotificationError,'queue_full'):self.send('overflow')
        self.assertEqual(100,len(self.store.events()['events']))
        self.assertEqual(20,len(self.store.events(True)['events']))
        self.assertLess((self.folder/'history.json').stat().st_size,1024*1024)
        self.assertEqual(0o600,stat.S_IMODE((self.folder/'history.json').stat().st_mode))
        self.assertEqual(0o700,stat.S_IMODE(self.folder.stat().st_mode))
    def test_symlink_and_corrupt_archive_fail_closed(self):
        target=Path(self.tmp.name).resolve()/'untouched';target.mkdir()
        self.folder.symlink_to(target,target_is_directory=True)
        unsafe=ExternalNotifications(self.folder,TOKEN)
        self.assertEqual('notification_storage_unavailable',unsafe.status()['error'])
        with self.assertRaises(NotificationError):unsafe.configure({'enabled':True,'available':True,'revision':0})
        self.assertEqual([],list(target.iterdir()))
        self.folder.unlink();self.folder.mkdir();(self.folder/'history.json').write_text('{broken')
        broken=ExternalNotifications(self.folder,TOKEN)
        self.assertEqual('notification_storage_unavailable',broken.status()['error'])
        self.assertEqual('{broken',(self.folder/'history.json').read_text())


class ActualServerTests(unittest.TestCase):
    def test_http_auth_bounds_manual_hooks_and_no_workspace_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp).resolve();folder=base/'notifications'
            env={'AI_WORKSTATION_PORT':'0','AI_WORKSTATION_DATA_DIR':str(base/'workspace'),
                 'AI_WORKSTATION_NOTIFICATION_DIR':str(folder),'AI_WORKSTATION_NATIVE_NOTIFICATION_TOKEN':TOKEN,'PYTHONDONTWRITEBYTECODE':'1'}
            with python_http_service(APP/'server.py',cwd=APP,env=env) as origin:
                opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
                def request(path,body=None,headers=None,method=None):
                    raw=json.dumps(body).encode() if body is not None else None
                    h={'Content-Type':'application/json',**(headers or {})}
                    req=urllib.request.Request(origin+path,data=raw,headers=h,method=method)
                    try:
                        with opener.open(req,timeout=4) as response:return response.status,json.loads(response.read())
                    except urllib.error.HTTPError as error:return error.code,json.loads(error.read())
                native={'X-AIBro-Native-Token':TOKEN}
                before=request('/__state')[1]
                self.assertEqual(403,request('/__external-notifications/status')[0])
                self.assertEqual(403,request('/__external-notifications/status',headers={**native,'Origin':origin})[0])
                self.assertEqual(403,request('/__external-notifications/status',headers={**native,'Host':'evil.test'})[0])
                self.assertFalse(request('/__external-notifications/status',headers=native)[1]['enabled'])
                self.assertEqual(200,request('/__external-notifications/config',{'enabled':True,'available':True,'revision':0},native)[0])
                desc=json.loads((folder/'endpoint.json').read_text());producer={'X-AIBro-Notification-Token':desc['token']}
                self.assertEqual(origin,desc['url'])
                self.assertEqual(403,request('/notify/codex',{'title':'not accepted'})[0])
                self.assertEqual(403,request('/notify/codex',{}, {**producer,'Origin':'https://evil.test'})[0])
                self.assertEqual(404,request('/notify/unknown',{},producer)[0])
                self.assertEqual(413,request('/notify/gpt',{'title':'a'*(MAX_BODY+1)},producer)[0])
                self.assertEqual(415,request('/notify/gpt',{}, {**producer,'Content-Type':'text/plain'})[0])
                # Execute the actual opt-in script; it reads only its supplied descriptor.
                hook=APP/'external-notification-hook.cjs'
                codex={'type':'agent-turn-complete','turn-id':'test-turn','last-assistant-message':'Synthetic finished',
                       'cwd':'/synthetic/private/course','transcript_path':'/must/not/read'}
                result=subprocess.run(['node',str(hook),'--endpoint',str(folder/'endpoint.json'),'--source','codex',json.dumps(codex)],capture_output=True,text=True,timeout=5)
                self.assertEqual(0,result.returncode);self.assertEqual('',result.stdout+result.stderr)
                rows=request('/__external-notifications/poll',headers=native)[1]
                self.assertEqual(1,len(rows['events']));self.assertEqual('Synthetic finished',rows['events'][0]['title'])
                self.assertEqual('course',rows['events'][0]['project'])
                self.assertEqual(200,request('/__external-notifications/ack',{'generation':rows['generation'],'ids':[rows['events'][0]['id']]},native)[0])
                self.assertEqual([],request('/__external-notifications/poll',headers=native)[1]['events'])
                claude={'hook_event_name':'Stop','session_id':'test-session','transcript_path':'/must/not/read'}
                result=subprocess.run(['node',str(hook),'--endpoint',str(folder/'endpoint.json'),'--source','claude'],input=json.dumps(claude),capture_output=True,text=True,timeout=5)
                self.assertEqual(0,result.returncode)
                self.assertEqual('Claude 已完成任务',request('/__external-notifications/poll',headers=native)[1]['events'][0]['title'])
                self.assertEqual(before,request('/__state')[1])
                self.assertEqual(200,request('/__external-notifications/config',{'enabled':True,'available':False,'revision':1},native)[0])
                self.assertEqual([],request('/__external-notifications/history',headers=native)[1]['events'])
                self.assertEqual(409,request('/notify/codex',codex,producer)[0])
                self.assertFalse((folder/'endpoint.json').exists())


if __name__ == '__main__': unittest.main(verbosity=2)
