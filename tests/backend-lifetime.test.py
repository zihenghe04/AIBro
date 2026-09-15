import os,select,subprocess,sys,tempfile,time,unittest
from pathlib import Path

class LifetimeTests(unittest.TestCase):
 def start(self,owned):
  folder=tempfile.TemporaryDirectory(prefix='aibro-lifetime-');self.addCleanup(folder.cleanup)
  env={**os.environ,'AI_WORKSTATION_DATA_DIR':folder.name,'AI_WORKSTATION_PORT':'0'}
  if owned:env['AI_WORKSTATION_PARENT_PIPE']='1'
  else:env.pop('AI_WORKSTATION_PARENT_PIPE',None)
  p=subprocess.Popen([sys.executable,'-u',str(Path(__file__).resolve().parents[1]/'app/server.py')],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  def cleanup():
   if p.poll() is None:p.terminate();p.wait(timeout=5)
   for stream in (p.stdin,p.stdout,p.stderr):stream.close()
  self.addCleanup(cleanup)
  self.assertTrue(select.select([p.stdout],[],[],20)[0],'backend startup timed out');self.assertIn(b'http://127.0.0.1:',p.stdout.readline());return p
 def test_owned_backend_lives_with_pipe_then_exits_on_owner_eof(self):
  p=self.start(True);time.sleep(.2);self.assertIsNone(p.poll());p.stdin.write(b'keepalive');p.stdin.flush();time.sleep(.1);self.assertIsNone(p.poll());p.stdin.close();self.assertEqual(p.wait(timeout=5),0)
 def test_standalone_backend_does_not_treat_closed_stdin_as_shutdown(self):
  p=self.start(False);p.stdin.close();time.sleep(.7);self.assertIsNone(p.poll())
if __name__=='__main__':unittest.main()
