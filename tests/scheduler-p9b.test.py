"""Scheduler x P9b (Codex in the background kernel): the task's model reaches the run, a usage-limit pause holds the others, and nothing is announced twice."""
import json,os,subprocess,tempfile,time,unittest
from datetime import datetime,timezone
host=tempfile.TemporaryDirectory(prefix='aibro-scheduler-p9b-host-');os.environ.setdefault('AI_WORKSTATION_DATA_DIR',host.name)
from server import WorkspaceStore
import scheduler as S
import kernel_runs as K
from kernel_runs import KernelRuns,KernelError
from scheduler import Scheduler
iso=lambda t:datetime.fromtimestamp(t,timezone.utc).isoformat()

class Clock:
 def __init__(self,t):self.t=t
 def __call__(self):return self.t

class Cross(unittest.TestCase):
 def setUp(self):
  gone=subprocess.Popen(['true']);gone.wait()
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.clock=Clock(time.time())
  self.store=WorkspaceStore(self.tmp.name)
  self.store.save({'projects':[],'conversations':[],'tasks':[],'notes':[],'imports':[],'trash':[],'agentRuns':[]})
  self.runs=KernelRuns(self.tmp.name,clock=self.clock);self.sch=Scheduler(self.store,'inst-a',runs=self.runs,clock=self.clock,pid=gone.pid)
  self.path=self.store.directory/'project-jobs.json'
 def doc(self):return json.loads(self.path.read_text())
 def auto(self,**kw):
  return self.sch.upsert({'kind':'auto','name':'Digest','prompt':'Summarise synthetic notes','dueAt':iso(self.clock.t-1),'scope':{'access':'read'},**kw})
 def fire(self):
  self.clock.t+=S.STARTUP_DELAY;self.sch.tick();self.sch.tick()
 def pause(self,claim,code='CODEX_QUOTA'):
  return self.runs.pause(claim['run']['id'],claim['leaseToken'],{'code':code,'message':'Synthetic usage limit','steps':3})

 def test_task_model_becomes_the_runs_own_model(self):
  self.auto(modelOverride={'connectionId':'codex-cli','model':'synthetic-codex'});self.fire()
  run=self.runs.list()[0]
  self.assertEqual(run['request']['model'],{'connection':'codex-cli','model':'synthetic-codex','effort':None})
  self.assertEqual(run['request']['schedule']['modelOverride'],{'connectionId':'codex-cli','model':'synthetic-codex'})
 def test_connection_alone_and_no_model_and_model_without_connection(self):
  self.assertEqual(self.sch.parse_model({'connectionId':'api:example.test'}),{'connectionId':'api:example.test'})
  self.assertRaises(ValueError,self.sch.parse_model,{})
  self.auto(modelOverride={'connectionId':'api:example.test'});self.fire()
  self.assertEqual(self.runs.list()[0]['request']['model'],{'connection':'api:example.test','model':None,'effort':None})
  other=self.auto(name='Plain');self.assertIsNone(other.get('modelOverride'))
 def test_model_without_connection_has_nothing_to_attach_to(self):
  self.auto(modelOverride={'model':'m-1'});self.fire()
  self.assertIsNone(self.runs.list()[0]['request']['model'])
 def test_run_level_model_is_not_allowed_from_outside_garbage(self):
  self.assertRaises(KernelError,self.runs.create,{'prompt':'x','model':{'connection':'codex-cli','key':'nope'}},'scheduler')

 def test_pause_frees_the_slot_and_the_execution_stays_open(self):
  t=self.auto(modelOverride={'connectionId':'codex-cli'});self.fire()
  claim=self.runs.claim('h');self.pause(claim);self.sch.tick()
  row=self.doc()['executions'][0];self.assertEqual(row['status'],'paused');self.assertIsNone(row['finishedAt'])
  self.assertEqual(self.sch.list()['attention'],[])  # a pause is not an approval request
  # resumed and finished: the same row settles
  self.runs.resume(claim['run']['id']);claim=self.runs.claim('h')
  self.runs.finish(claim['run']['id'],claim['leaseToken'],{'status':'completed','result':{'final':'ok','stop':'final','steps':2,'markedDone':{'summary':'S'}}});self.sch.tick()
  row=self.doc()['executions'][0];self.assertEqual(row['status'],'completed')
 def test_paused_run_does_not_take_a_background_slot_and_does_not_block_other_connections(self):
  a=self.runs.create({'prompt':'a','model':{'connection':'codex-cli'}},'scheduler')[0]['id']
  claim=self.runs.claim('h');self.assertEqual(claim['run']['id'],a);self.pause(claim)
  api=self.runs.create({'prompt':'b','model':{'connection':'api:example.test'}},'scheduler')[0]['id']
  self.assertEqual(self.runs.claim('h')['run']['id'],api)
 def test_usage_limit_holds_other_scheduled_runs_on_the_same_connection(self):
  a=self.runs.create({'prompt':'a','model':{'connection':'codex-cli'}},'scheduler')[0]['id']
  b=self.runs.create({'prompt':'b','model':{'connection':'codex-cli'}},'scheduler')[0]['id']
  claim=self.runs.claim('h');self.assertEqual(claim['run']['id'],a);self.pause(claim)
  self.assertIsNone(self.runs.claim('h'))  # b waits: it would only pause and notify again
  fg=self.runs.create({'prompt':'f','model':{'connection':'codex-cli'}},'user')[0]['id']
  self.assertEqual(self.runs.claim('h')['run']['id'],fg)  # a person's own run is never held
 def test_resuming_a_paused_run_lets_it_go_even_while_others_stay_paused(self):
  a=self.runs.create({'prompt':'a','model':{'connection':'codex-cli'}},'scheduler')[0]['id']
  claim=self.runs.claim('h');self.pause(claim);self.runs.resume(a)
  self.assertEqual(self.runs.claim('h')['run']['id'],a)
 def test_non_limit_pause_codes_do_not_hold(self):
  a=self.runs.create({'prompt':'a','model':{'connection':'codex-cli'}},'scheduler')[0]['id']
  b=self.runs.create({'prompt':'b','model':{'connection':'codex-cli'}},'scheduler')[0]['id']
  claim=self.runs.claim('h');self.pause(claim,'SOMETHING_ELSE');self.assertEqual(self.runs.claim('h')['run']['id'],b)

 def test_notifications_are_not_duplicated(self):
  # An approval is announced from the approval (attention); a pause only from the pause. The scheduler adds neither.
  t=self.auto();self.fire();claim=self.runs.claim('h')
  self.runs.ask(claim['run']['id'],claim['leaseToken'],{'callId':'c1','tool':'create_task','args':{},'reasons':['out-of-scope']});self.sch.tick()
  rows=self.doc()['executions'];self.assertEqual(rows[0]['status'],'awaiting-approval')
  self.assertEqual(self.sch.notifications(),[])  # native reminders are for reminder tasks only
if __name__=='__main__':unittest.main()
