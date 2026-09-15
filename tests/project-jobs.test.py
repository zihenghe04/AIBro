import os,tempfile,unittest,time,copy
from unittest.mock import patch
from datetime import datetime,timezone
host=tempfile.TemporaryDirectory(prefix='aibro-jobs-host-');os.environ.setdefault('AI_WORKSTATION_DATA_DIR',host.name)
from server import WorkspaceStore
from project_jobs import ProjectJobs
class JobsTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.store=WorkspaceStore(self.tmp.name)
  self.store.save({'projects':[{'id':'p','name':'Synthetic','workspace':'科研'}],'conversations':[{'id':'c','projectId':'p','workspace':'科研','messages':[]}],'tasks':[],'notes':[],'imports':[],'trash':[],'agentRuns':[]})
  self.jobs=ProjectJobs(self.store,'instance-a');self.payload={'projectId':'p','name':'Review','prompt':'Review synthetic notes','dueAt':datetime.fromtimestamp(time.time()-3600,timezone.utc).isoformat(),'intervalMinutes':0,'budgetMinutes':1,'permissionMode':'request'}
 def create(self,**kw):return self.jobs.upsert({**self.payload,**kw})
 def finish(self,j,c,status='completed'):
  s=self.store.load();r={'id':'r-'+c['job']['attempt']['id'],'conversationId':'c','automaticJobId':j['id'],'automaticAttemptId':c['job']['attempt']['id'],'status':status};s['agentRuns'].append(r);self.store.save(s);return self.jobs.finish(j['id'],c['token'],r['id'])
 def test_claim_is_once_and_token_is_private(self):
  j=self.create();c=self.jobs.claim(j['id']);self.assertTrue(c['claimed']);self.assertFalse(self.jobs.claim(j['id'])['claimed']);self.assertNotIn('token',str(self.jobs.list()));self.assertTrue(self.jobs.check(j['id'],c['token'])['valid']);self.assertFalse(self.jobs.check(j['id'],'wrong')['valid']);self.assertEqual(self.finish(j,c)['status'],'completed')
 def test_pause_revokes_and_late_result_does_not_reactivate(self):
  j=self.create();c=self.jobs.claim(j['id']);self.jobs.change(j['id'],'pause');self.assertFalse(self.jobs.check(j['id'],c['token'])['valid']);self.assertEqual(self.finish(j,c)['status'],'paused')
 def test_restart_pauses_and_records_late_result(self):
  j=self.create();c=self.jobs.claim(j['id']);other=ProjectJobs(self.store,'new-instance');self.assertEqual(other.list()[0]['attempt']['status'],'interrupted');done=self.finish(j,c);self.assertEqual(done['status'],'paused');self.assertEqual(done['attempt']['status'],'interrupted');self.assertIn('runId',done['attempt'])
 def test_repeat_skips_missed_ticks_and_keeps_history(self):
  j=self.create(intervalMinutes=1440,dueAt='2020-01-01T00:00:00Z');c=self.jobs.claim(j['id']);done=self.finish(j,c);self.assertGreater(done['dueAt'],time.time());self.assertLess(done['dueAt'],time.time()+86401);self.jobs.change(j['id'],'now');second=self.jobs.claim(j['id']);self.assertTrue(second['claimed']);self.assertEqual(len(second['job']['history']),1);self.assertNotIn('token',str(second['job']));self.finish(j,second,'failed');self.assertEqual(self.jobs.list()[0]['status'],'paused')
 def test_old_run_cannot_fulfill_new_attempt(self):
  j=self.create();c=self.jobs.claim(j['id']);old=self.finish(j,c);self.jobs.change(j['id'],'now');new=self.jobs.claim(j['id']);done=self.jobs.finish(j['id'],new['token'],old['attempt']['runId']);self.assertEqual(done['attempt']['status'],'failed')
 def test_project_change_invalidates_live_claim(self):
  j=self.create();c=self.jobs.claim(j['id']);s=self.store.load();s['projects'][0]['workspace']='日常';self.store.save(s);self.assertFalse(self.jobs.check(j['id'],c['token'])['valid']);self.assertEqual(self.jobs.list()[0]['status'],'paused')
 def test_archive_restore_versions_and_future_time(self):
  j=self.create(dueAt='2099-01-01T00:00:00Z');self.assertFalse(self.jobs.claim(j['id'])['claimed']);self.jobs.change(j['id'],'delete');self.assertEqual(self.jobs.list()[0]['status'],'deleted');restored=self.jobs.change(j['id'],'resume');self.assertEqual(restored['status'],'active');self.assertRaises(ValueError,self.jobs.upsert,{**self.payload,'id':j['id'],'version':j['version']})
 def test_invalid_inputs_and_deadline(self):
  for value in ({'permissionMode':'full'},{'budgetMinutes':0},{'intervalMinutes':10},{'dueAt':'2026-09-14T12:00'}):self.assertRaises(ValueError,self.create,**value)
  j=self.create();c=self.jobs.claim(j['id']);
  with patch('project_jobs.time.time',return_value=time.time()+65):self.assertFalse(self.jobs.check(j['id'],c['token'])['valid'])
  self.assertEqual(self.jobs.list()[0]['status'],'paused')
 def test_calendar_repeat_keeps_wall_time_across_dst(self):
  from zoneinfo import ZoneInfo
  z=ZoneInfo('America/New_York')
  for start,now,expected in [('2026-03-07T09:00:00-05:00','2026-03-07T12:00:00-05:00','2026-03-08T09:00:00-04:00'),('2026-10-31T09:00:00-04:00','2026-10-31T12:00:00-04:00','2026-11-01T09:00:00-05:00')]:
   j=self.create(intervalMinutes=1440,dueAt=start,timeZone='America/New_York')
   result=ProjectJobs.next_due(j,datetime.fromisoformat(now).timestamp())
   self.assertEqual(datetime.fromtimestamp(result,z).isoformat(),expected)
 def test_dst_gap_fold_and_run_now_keep_anchor(self):
  from zoneinfo import ZoneInfo
  z=ZoneInfo('America/New_York')
  j=self.create(intervalMinutes=1440,dueAt='2026-03-07T02:30:00-05:00',timeZone='America/New_York')
  gap=ProjectJobs.next_due(j,datetime.fromisoformat('2026-03-07T12:00:00-05:00').timestamp())
  self.assertEqual(datetime.fromtimestamp(gap,z).isoformat(),'2026-03-08T03:30:00-04:00')
  self.assertEqual(datetime.fromtimestamp(ProjectJobs.next_due(j,gap+1),z).hour,2)
  j=self.create(intervalMinutes=1440,dueAt='2026-10-31T01:30:00-04:00',timeZone='America/New_York')
  fold=datetime.fromisoformat('2026-11-01T01:45:00-04:00').timestamp()
  self.assertEqual(datetime.fromtimestamp(ProjectJobs.next_due(j,fold),z).day,2)
  changed=self.jobs.change(j['id'],'now');self.assertEqual(changed['wallAnchor'],j['wallAnchor'])
  self.assertRaises(ValueError,self.create,timeZone='Mars/Olympus')
if __name__=='__main__':unittest.main()
