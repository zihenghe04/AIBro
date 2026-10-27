import json,os,subprocess,tempfile,time,unittest,unittest.mock
from datetime import datetime,timezone
host=tempfile.TemporaryDirectory(prefix='aibro-scheduler-host-');os.environ.setdefault('AI_WORKSTATION_DATA_DIR',host.name)
from server import WorkspaceStore
from project_jobs import ProjectJobs
import scheduler as S
from scheduler import Scheduler,ScopeConfirmation
iso=lambda t:datetime.fromtimestamp(t,timezone.utc).isoformat()

class Clock:
 def __init__(self,t):self.t=t
 def __call__(self):return self.t

class Base(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.store=WorkspaceStore(self.tmp.name)
  self.store.save({'projects':[{'id':'p','name':'Synthetic','workspace':'科研'}],'conversations':[],'tasks':[],'notes':[],'imports':[],'trash':[],'agentRuns':[]})
  self.clock=Clock(time.time());self.sch=Scheduler(self.store,'inst-a',clock=self.clock)
  self.path=self.store.directory/'project-jobs.json'
 def auto(self,**kw):
  return self.sch.upsert({'kind':'auto','name':'Digest','prompt':'Summarise synthetic notes','dueAt':iso(self.clock.t+60),'scope':{'access':'read'},**kw})
 def remind(self,**kw):
  return self.sch.upsert({'kind':'reminder','name':'Submit form','dueAt':iso(self.clock.t+60),**kw})
 def doc(self):return json.loads(self.path.read_text())
 def rows(self,task_id=None):return [e for e in self.doc()['executions'] if task_id is None or e['taskId']==task_id]
 def task(self,task_id):return next(t for t in self.doc()['tasks'] if t['id']==task_id)

class DataModel(Base):
 def test_two_kinds_and_minimal_scope_default(self):
  a=self.auto(scope={});r=self.remind()
  self.assertEqual(a['kind'],'auto');self.assertEqual(a['scope'],{'declared':True,'access':'read','tools':[],'computerUse':False})
  self.assertEqual(r['kind'],'reminder');self.assertNotIn('scope',r)
  d=self.doc();self.assertEqual(d['schemaVersion'],2);self.assertEqual(len(d['tasks']),2);self.assertEqual(d['jobs'],[])
 def test_undeclared_scope_needs_confirmation(self):
  with self.assertRaises(ScopeConfirmation):self.sch.upsert({'kind':'auto','name':'x','prompt':'y','dueAt':iso(self.clock.t)})
  self.assertEqual(self.doc()['tasks'],[])
  t=self.sch.upsert({'kind':'auto','name':'x','prompt':'y','dueAt':iso(self.clock.t),'confirmUndeclared':True})
  self.assertEqual(t['scope']['access'],'read');self.assertFalse(t['scope']['declared']);self.assertTrue(t['needsScopeConfirmation'])
  self.assertRaises(ValueError,self.sch.change,t['id'],'now')
 def test_invalid_scope_and_model(self):
  for bad in ({'access':'full'},{'tools':['a b']},{'computerUse':'yes'},'read'):self.assertRaises(ValueError,self.auto,scope=bad)
  self.assertRaises(ValueError,self.auto,modelOverride={'model':''})
  t=self.auto(modelOverride={'model':'synthetic-model','connectionId':'conn_1'})
  self.assertEqual(t['modelOverride'],{'model':'synthetic-model','connectionId':'conn_1'})
 def test_dependencies_validate_and_reject_cycles(self):
  a=self.auto();b=self.auto(dependsOn=[a['id']])
  self.assertRaises(ValueError,self.auto,dependsOn=['sch_missing'])
  self.assertRaises(ValueError,self.sch.upsert,{**{k:a[k] for k in ('id','version','kind','name','prompt')},'dueAt':iso(a['dueAt']),'scope':a['scope'],'dependsOn':[b['id']]})
  self.assertEqual(b['dependsOn'],[a['id']])
 def test_version_conflict_and_kind_is_fixed(self):
  a=self.auto()
  self.assertRaises(ValueError,self.sch.upsert,{'id':a['id'],'version':a['version']+1,'kind':'auto','name':'n','prompt':'p','dueAt':iso(a['dueAt']),'scope':{}})
  self.assertRaises(ValueError,self.sch.upsert,{'id':a['id'],'version':a['version'],'kind':'reminder','name':'n','dueAt':iso(a['dueAt'])})

class Migration(Base):
 def test_schema1_file_migrates_losslessly_with_backup(self):
  job={'id':'job_1','projectId':'p','workspace':'科研','name':'Old','prompt':'old goal','dueAt':1.0,'intervalMinutes':1440,'budgetMinutes':15,'permissionMode':'request','skillIds':['skill_a'],'skillId':'skill_a','status':'paused','version':3,'updatedAt':2.0,'custom':{'kept':True},
   'attempt':{'id':'attempt_2','token':'secret-token','status':'completed','instanceId':'x','startedAt':5,'finishedAt':6,'runId':'r2','conversationId':'c'},
   'history':[{'id':'attempt_1','status':'failed','startedAt':3,'finishedAt':4,'error':'boom'}]}
  raw=json.dumps({'jobs':[job]});self.path.write_text(raw)
  listed=self.sch.list()
  d=self.doc();self.assertEqual(d['schemaVersion'],2)
  self.assertEqual((self.store.directory/S.BACKUP_NAME).read_text(),raw)
  migrated=d['jobs'][0]
  for k,v in job.items():self.assertEqual(migrated[k],v,k)
  self.assertEqual((migrated['kind'],migrated['executor']),('auto','window'))
  rows=sorted(d['executions'],key=lambda e:e['startedAt']);self.assertEqual([r['attemptId'] for r in rows],['attempt_1','attempt_2'])
  self.assertEqual([r['status'] for r in rows],['failed','completed']);self.assertTrue(all(r['legacy'] for r in rows))
  self.assertNotIn('secret-token',json.dumps(listed));self.assertEqual(listed['jobs'][0]['executor'],'window');self.assertFalse(listed['jobs'][0]['scopeDeclared'])
  # A second load changes nothing and the old reader still finds its jobs.
  before=self.path.read_text();self.sch.list();self.assertEqual(self.path.read_text(),before)
  self.assertEqual(ProjectJobs(self.store,'inst-a').list()[0]['skillIds'],['skill_a'])
 def test_project_job_attempts_get_execution_rows_with_owner_pid(self):
  jobs=ProjectJobs(self.store,'inst-a')
  j=jobs.upsert({'projectId':'p','name':'Review','prompt':'Review notes','dueAt':iso(time.time()-60),'intervalMinutes':0,'budgetMinutes':1,'permissionMode':'request'})
  c=jobs.claim(j['id']);row=[e for e in self.doc()['executions'] if e['attemptId']==c['job']['attempt']['id']][0]
  self.assertEqual((row['status'],row['ownerPid'],row['kind']),('running',os.getpid(),'window'))
  ProjectJobs(self.store,'inst-b').list()
  row=[e for e in self.doc()['executions'] if e['id']==row['id']][0];self.assertEqual(row['status'],'interrupted')
 def test_symlink_store_refused(self):
  target=self.store.directory/'elsewhere.json';target.write_text('{"jobs":[]}');self.path.symlink_to(target)
  self.assertRaises(ValueError,self.sch.list)

from kernel_runs import KernelRuns
import kernel_runs as K
DAY=86400

class Execution(Base):
 def setUp(self):
  # The first service's process is gone by the time a second one starts.
  gone=subprocess.Popen(['true']);gone.wait()
  super().setUp();self.runs=KernelRuns(self.tmp.name,clock=self.clock);self.sch=Scheduler(self.store,'inst-a',runs=self.runs,clock=self.clock,pid=gone.pid)
 def later(self,seconds):self.clock.t+=seconds
 def host_finish(self,status='completed',marked=True,effect=False):
  claim=self.runs.claim('test-host');run=claim['run'];lease=claim['leaseToken']
  if effect:self.runs.add_effect(run['id'],lease,{'id':'call-1','tool':'create_note','args':{'title':'t','content':'c'}});self.runs.claim_effects()
  self.runs.finish(run['id'],lease,{'status':status,'result':{'final':'done','stop':'final','steps':2,**({'markedDone':{'summary':'Synthetic summary'}} if marked else {})}})
  return run
 def test_startup_delay_then_one_kernel_run_with_scope(self):
  t=self.auto(dueAt=iso(self.clock.t-1),scope={'access':'ask','tools':['ext.read']},modelOverride={'model':'m-1'})
  self.assertEqual(self.sch.tick(),[]);self.assertEqual(self.runs.list(),[])
  self.later(S.STARTUP_DELAY);self.sch.tick();self.sch.tick()
  runs=self.runs.list();self.assertEqual(len(runs),1);run=runs[0]
  self.assertEqual(run['source'],{'kind':'scheduler','id':t['id']});self.assertEqual(run['request']['permissionMode'],'request')
  sch=run['request']['schedule'];self.assertEqual(sch['scope'],{'declared':True,'access':'ask','tools':['ext.read'],'computerUse':False});self.assertEqual(sch['modelOverride'],{'model':'m-1'})
  row=self.rows(t['id'])[0];self.assertEqual((row['status'],row['runId'],row['ownerPid']),('queued',run['id'],self.sch.pid));self.assertEqual(sch['executionId'],row['id'])
 def test_completion_needs_mark_task_done(self):
  t=self.auto(dueAt=iso(self.clock.t-1));self.later(S.STARTUP_DELAY);self.sch.tick();self.host_finish();self.sch.tick()
  row=self.rows(t['id'])[0];self.assertEqual(row['status'],'completed');self.assertEqual(row['summary'],'Synthetic summary');self.assertEqual(self.task(t['id'])['status'],'completed')
  u=self.auto(dueAt=iso(self.clock.t-1));self.sch.tick();self.host_finish(marked=False);self.sch.tick()
  row=self.rows(u['id'])[0];self.assertEqual(row['status'],'unverified');self.assertIn('标记完成',row['error']);self.assertEqual(self.task(u['id'])['status'],'paused')
 def test_missed_occurrences_collapse_to_latest_once(self):
  start=self.clock.t-10*DAY-3600
  t=self.auto(dueAt=iso(start),intervalMinutes=1440);self.later(S.STARTUP_DELAY);self.sch.tick();self.sch.tick()
  rows=self.rows(t['id']);self.assertEqual(len(rows),1);self.assertTrue(rows[0]['catchUp'])
  self.assertAlmostEqual(rows[0]['scheduledFor'],start+10*DAY,delta=1);self.assertGreater(self.task(t['id'])['dueAt'],self.clock.t)
  self.assertEqual(len(self.runs.list()),1)
 def test_within_grace_is_on_time(self):
  t=self.auto(dueAt=iso(self.clock.t-60));self.later(S.STARTUP_DELAY);self.sch.tick();self.assertFalse(self.rows(t['id'])[0]['catchUp'])
 def test_restart_before_submit_is_interrupted_and_retried_once(self):
  t=self.auto(dueAt=iso(self.clock.t-1));self.later(S.STARTUP_DELAY)
  with unittest.mock.patch.object(self.runs,'create',side_effect=SystemExit('crash')):
   self.assertRaises(SystemExit,self.sch.tick)
  self.assertEqual(self.rows(t['id'])[0]['status'],'starting')
  self.clock.t+=S.STARTUP_DELAY;other=Scheduler(self.store,'inst-b',runs=self.runs,clock=self.clock,pid=999999);other.started-=S.STARTUP_DELAY;other.tick()
  rows=sorted(self.rows(t['id']),key=lambda e:e['startedAt']);self.assertEqual([r['status'] for r in rows],['interrupted','queued']);self.assertTrue(rows[1].get('retryOf'))
 def test_restart_with_side_effects_is_not_resent(self):
  t=self.auto(dueAt=iso(self.clock.t-1),intervalMinutes=1440);self.later(S.STARTUP_DELAY);self.sch.tick()
  claim=self.runs.claim('host');self.runs.add_effect(claim['run']['id'],claim['leaseToken'],{'id':'call-1','tool':'create_note','args':{'title':'t'}});self.runs.claim_effects()
  # The app quits: a new service process loads the same data.
  runs2=KernelRuns(self.tmp.name,clock=self.clock);self.assertEqual(runs2.get(claim['run']['id'])['status'],'interrupted')
  other=Scheduler(self.store,'inst-b',runs=runs2,clock=self.clock,pid=999999);other.started-=S.STARTUP_DELAY;other.tick();other.tick()
  rows=self.rows(t['id']);self.assertEqual(len(rows),1);self.assertEqual(rows[0]['status'],'interrupted');self.assertTrue(rows[0]['sideEffects'])
  self.assertEqual(self.task(t['id'])['status'],'paused');self.assertEqual(len(runs2.list()),1)
 def test_restart_without_effects_kernel_requeues_same_run(self):
  t=self.auto(dueAt=iso(self.clock.t-1));self.later(S.STARTUP_DELAY);self.sch.tick();self.runs.claim('host')
  runs2=KernelRuns(self.tmp.name,clock=self.clock);other=Scheduler(self.store,'inst-b',runs=runs2,clock=self.clock,pid=999999);other.started-=S.STARTUP_DELAY;other.tick()
  rows=self.rows(t['id']);self.assertEqual(len(rows),1);self.assertEqual(rows[0]['status'],'queued');self.assertEqual(len(runs2.list()),1)
 def test_app_closed_for_days_catches_up_latest_once_and_state_is_consistent(self):
  t=self.auto(dueAt=iso(self.clock.t+60),intervalMinutes=1440);self.later(60+S.STARTUP_DELAY);self.sch.tick();self.host_finish();self.sch.tick()
  self.assertEqual(self.rows(t['id'])[0]['status'],'completed');next_due=self.task(t['id'])['dueAt']
  self.clock.t+=3*DAY+3600  # closed for three days
  runs2=KernelRuns(self.tmp.name,clock=self.clock);other=Scheduler(self.store,'inst-b',runs=runs2,clock=self.clock,pid=999999)
  self.assertEqual(other.tick(),[])  # startup delay
  self.clock.t+=S.STARTUP_DELAY;other.tick()
  rows=sorted(self.rows(t['id']),key=lambda e:e['startedAt']);self.assertEqual(len(rows),2);self.assertTrue(rows[1]['catchUp'])
  self.assertAlmostEqual(rows[1]['scheduledFor'],next_due+2*DAY,delta=1)
  self.runs=runs2;self.host_finish();other.tick()
  listed=other.list();task=listed['tasks'][0];self.assertEqual(task['status'],'active');self.assertIsNone(task['openExecution'])
  self.assertGreater(task['dueAt'],self.clock.t);self.assertEqual(sorted(r['status'] for r in listed['executions']),['completed','completed'])
 def test_dependencies_wait_for_completion(self):
  a=self.auto(dueAt=iso(self.clock.t+3600));b=self.auto(dueAt=iso(self.clock.t-1),dependsOn=[a['id']])
  self.later(S.STARTUP_DELAY);self.sch.tick();self.assertEqual(self.rows(b['id']),[])
  self.assertEqual(self.sch.list()['tasks'][1]['waiting'],'dependencies')
  self.sch.change(a['id'],'now');self.sch.tick();self.host_finish();self.sch.tick();self.sch.tick()
  self.assertEqual(len(self.rows(b['id'])),1)
 def test_failed_kernel_submit_pauses_task(self):
  t=self.auto(dueAt=iso(self.clock.t-1));self.later(S.STARTUP_DELAY)
  with unittest.mock.patch.object(self.runs,'create',side_effect=ValueError('bad')):self.sch.tick()
  self.assertEqual(self.rows(t['id'])[0]['status'],'failed');self.assertEqual(self.task(t['id'])['status'],'paused')

class Priority(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.clock=Clock(1_800_000_000.0);self.runs=KernelRuns(self.tmp.name,clock=self.clock)
 def make(self,kind,title):
  self.clock.t+=1;return self.runs.create({'prompt':title,'title':title,'source':{'kind':kind}},source_kind=kind)[0]['id']
 def test_foreground_before_background(self):
  b=self.make('scheduler','bg');f=self.make('user','fg');self.assertEqual(self.runs.claim('h')['run']['id'],f);self.assertEqual(self.runs.claim('h')['run']['id'],b)
 def test_background_limit_and_waiting_for_a_person_does_not_count(self):
  a=self.make('scheduler','a');b=self.make('scheduler','b');claim=self.runs.claim('h');self.assertEqual(claim['run']['id'],a)
  self.assertIsNone(self.runs.claim('h'))
  f=self.make('external','f');self.assertEqual(self.runs.claim('h')['run']['id'],f)  # foreground is never capped by background
  self.runs.ask(a,claim['leaseToken'],{'callId':'c1','tool':'create_task','args':{}})
  self.assertEqual(self.runs.claim('h')['run']['id'],b)
 def test_foreground_hint_defers_background_but_not_forever(self):
  b=self.make('scheduler','bg');self.runs.foreground(True);self.assertIsNone(self.runs.claim('h'))
  self.clock.t+=K.FOREGROUND_HINT_SECONDS+1;self.runs.foreground(True);self.assertIsNone(self.runs.claim('h'))
  self.clock.t+=K.STARVE_SECONDS;self.runs.foreground(True);self.assertEqual(self.runs.claim('h')['run']['id'],b)
 def test_starving_background_goes_before_new_foreground(self):
  b=self.make('scheduler','bg');self.clock.t+=K.STARVE_SECONDS+1;f=self.make('user','fg');self.assertEqual(self.runs.claim('h')['run']['id'],b)
 def test_hint_expires_by_itself(self):
  b=self.make('scheduler','bg');self.runs.foreground(True);self.clock.t+=K.FOREGROUND_HINT_SECONDS+1;self.assertEqual(self.runs.claim('h')['run']['id'],b)
 def test_schedule_field_only_from_scheduler_and_marked_done_kept(self):
  from kernel_runs import KernelError
  self.assertRaises(KernelError,self.runs.create,{'prompt':'x','schedule':{'taskId':'t','executionId':'e'}},'external')
  run,_=self.runs.create({'prompt':'x','schedule':{'taskId':'sch_1','executionId':'exe_1','scope':{'access':'nope','tools':['ok.tool','bad tool']}}},'scheduler')
  self.assertEqual(run['request']['schedule']['scope'],{'declared':False,'access':'read','tools':['ok.tool'],'computerUse':False})
  claim=self.runs.claim('h');done=self.runs.finish(run['id'],claim['leaseToken'],{'status':'completed','result':{'final':'f','markedDone':{'summary':'s'*3000}}})
  self.assertEqual(len(done['result']['markedDone']['summary']),2000)

class Reminders(Base):
 def test_reminded_done_and_next_occurrence(self):
  r=self.remind(dueAt=iso(self.clock.t-10),intervalMinutes=1440);self.sch.tick()
  rows=self.rows(r['id']);self.assertEqual(rows[0]['status'],'reminded');self.assertEqual(self.sch.list()['reminders'][0]['taskId'],r['id'])
  self.sch.change(r['id'],'done');self.assertEqual(self.rows(r['id'])[0]['status'],'done');self.assertGreater(self.task(r['id'])['dueAt'],self.clock.t)
 def test_two_hours_later_expired(self):
  r=self.remind(dueAt=iso(self.clock.t-10));self.sch.tick();self.clock.t+=2*3600+11;self.sch.tick()
  self.assertEqual(self.rows(r['id'])[0]['status'],'expired');self.assertEqual(self.task(r['id'])['status'],'expired')
 def test_missed_while_closed_beyond_two_hours_is_expired_without_reminding(self):
  r=self.remind(dueAt=iso(self.clock.t-3*3600));self.sch.tick();self.assertEqual([e['status'] for e in self.rows(r['id'])],['expired'])
 def test_notifications_for_native_prescheduling(self):
  a=self.remind(dueAt=iso(self.clock.t+600),intervalMinutes=10080);b=self.remind(dueAt=iso(self.clock.t+40*DAY))
  plan=self.sch.notifications();self.assertEqual({p['taskId'] for p in plan},{a['id']});self.assertEqual(len(plan),5)
  self.assertEqual(plan[0]['id'],a['id']+'-'+str(int(a['dueAt'])));self.sch.change(a['id'],'pause');self.assertEqual(self.sch.notifications(),[])
  self.auto(dueAt=iso(self.clock.t+60));self.assertEqual(self.sch.notifications(),[])
  self.store.directory.joinpath('kernel').mkdir(exist_ok=True)
  runs=KernelRuns(self.tmp.name,clock=self.clock);runs.extra_pending=lambda:{'reminders':self.sch.notifications()};self.assertEqual(runs.pending()['reminders'],[])

if __name__=='__main__':unittest.main()
