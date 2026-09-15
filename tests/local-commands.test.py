"""Real subprocesses: approvals, identity, stdout, failure, timeout, cancellation and grants."""
import json,os,sys,tempfile,time
from pathlib import Path
from local_projects import LocalProjects,LocalProjectError
from local_commands import LocalCommands

def reject(fn,status=None):
    try:fn()
    except LocalProjectError as e:
        if status:assert e.status==status,(str(e),e.status)
    else:raise AssertionError('should reject')

def wait(service,id):
    deadline=time.monotonic()+8
    while time.monotonic()<deadline:
        e=service.access(id)
        if e['status'] not in ('pending','running'):return e
        time.sleep(.05)
    raise AssertionError('command did not finish')

with tempfile.TemporaryDirectory(prefix='aibro-command-test-') as tmp:
    base=Path(tmp);folder=base/'project';folder.mkdir();projects=LocalProjects(base/'data');link=projects.connect(str(folder));cid=link['candidate']['id'];service=LocalCommands(projects)
    def propose(argv,**kw):return service.propose(dict(candidateId=cid,projectId='p',runId='r',argv=argv,**kw))
    e=propose([sys.executable,'-c','print("actual output")']);assert e['status']=='pending' and not service.running
    reject(lambda:service.access(e['id'],'start',automatic=True),403)
    reject(lambda:service.access(e['id'],'start',remember=True),403)
    service.access(e['id'],'start');result=wait(service,e['id']);assert result['exitCode']==0 and result['output']=='actual output\n'
    assert service.access(e['id'],'start')['status']=='succeeded' # no duplicate execution
    e=propose([sys.executable,'-c','import os;print(os.getcwd());print(os.getenv("AIBRO_SECRET_TEST"));print("; touch HACK")']);os.environ['AIBRO_SECRET_TEST']='private';service.access(e['id'],'start');result=wait(service,e['id']);assert str(folder) in result['output'] and 'None' in result['output'];assert not (folder/'HACK').exists()
    e=propose(['/bin/echo','$(touch HACK)','a; b']);service.access(e['id'],'start');assert '$(touch HACK)' in wait(service,e['id'])['output'];assert not (folder/'HACK').exists()
    e=propose([sys.executable,'-c','import sys;print("failed");sys.exit(7)']);service.access(e['id'],'start');assert wait(service,e['id'])['exitCode']==7
    e=propose([sys.executable,'-c','import time;time.sleep(10)'],timeout=1);service.access(e['id'],'start');timed=wait(service,e['id']);assert timed['status']=='timed_out',timed
    e=propose([sys.executable,'-c','import time;time.sleep(10)']);service.access(e['id'],'start');second=propose(['/bin/pwd']);reject(lambda:service.access(second['id'],'start'),409);service.access(e['id'],'cancel');cancelled=wait(service,e['id']);assert cancelled['status']=='cancelled',cancelled;service.access(second['id'],'deny')
    e=propose([sys.executable,'-c','print("x"*100000)']);service.access(e['id'],'start');result=wait(service,e['id']);assert result['truncated'] and len(result['output'])==65536
    e=propose(['/bin/pwd']);service.access(e['id'],'start',remember=True);assert wait(service,e['id'])['trusted'];again=propose(['/bin/pwd']);assert again['trusted'];service.access(again['id'],'start',automatic=True);assert wait(service,again['id'])['status']=='succeeded';service.access(e['id'],'forget');assert not propose(['/bin/pwd'])['trusted']
    e=propose(['/bin/pwd']);(folder/'sub').mkdir();reject(lambda:propose(['/bin/pwd'],cwd='../outside'));(folder/'link').symlink_to(base);reject(lambda:propose(['/bin/pwd'],cwd='link'))
    # The cwd descriptor rejects a replacement between proposal and approval.
    renamed=base/'original';folder.rename(renamed);folder.mkdir();reject(lambda:service.access(e['id'],'start'),409);folder.rmdir();renamed.rename(folder)
    e=propose([sys.executable,'-c','import time;time.sleep(10)']);service.access(e['id'],'start');projects.disconnect(link['root']['id']);assert wait(service,e['id'])['status']=='cancelled'
    reject(lambda:service.access(propose(['/bin/pwd'])['id'],'start'))
    # Restart retains the actual output and never replays a pending request.
    restarted=LocalCommands(projects);assert restarted.access(result['id'])['output']==result['output']
    assert restarted.access(again['id'])['status']=='succeeded'
    service.close();restarted.close()
print('PASS: real command approvals, cwd identity, sanitized environment, literal argv, return codes, timeout, cancel, bounded output, exact allowlist, revocation, durable logs')
# Real loopback endpoint enforces same-origin writes and exact immutable ids.
from http_test_support import python_http_service
import urllib.request,urllib.error
with tempfile.TemporaryDirectory(prefix='aibro-command-http-') as tmp:
    base=Path(tmp);(base/'project').mkdir();repo=Path(__file__).resolve().parents[1]
    with python_http_service(repo/'app/server.py',cwd=repo/'app',env={**os.environ,'AI_WORKSTATION_DATA_DIR':str(base/'data'),'AI_WORKSTATION_PORT':'0'}) as origin:
        def post(path,payload,source=None):
            req=urllib.request.Request(origin+path,data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','Origin':source or origin})
            with urllib.request.urlopen(req) as result:return json.load(result)
        cid=post('/__local/roots',{'path':str(base/'project')})['candidate']['id']
        e=post('/__local/commands/propose',{'candidateId':cid,'argv':['/bin/pwd'],'projectId':'p','runId':'r'})
        try:post('/__local/commands/start',{'id':e['id']},'https://foreign.invalid')
        except urllib.error.HTTPError as err:assert err.code==403
        else:raise AssertionError('foreign origin approved')
        assert post('/__local/commands/get',{'id':e['id']})['status']=='pending'
        post('/__local/commands/start',{'id':e['id'],'argv':['/bin/echo','forged']})
        for _ in range(60):
            result=post('/__local/commands/get',{'id':e['id']})
            if result['status']=='succeeded':break
            time.sleep(.05)
        assert result['exitCode']==0 and result['argv']==['/bin/pwd'] and str(base/'project') in result['output']
print('PASS: loopback command origin, immutable approval and real HTTP result')

# Host hard-exit cannot leave the supervised command writing later.
import subprocess
with tempfile.TemporaryDirectory(prefix='aibro-command-orphan-') as tmp:
    base=Path(tmp);marker=base/'should-not-appear';repo=Path(__file__).resolve().parents[1]
    child_code='import time;from pathlib import Path;print("ready",flush=True);time.sleep(2);Path('+repr(str(marker))+').write_text("orphan")'
    host_code="""
import os,sys,time
from pathlib import Path
from local_projects import LocalProjects
from local_commands import LocalCommands
base=Path(sys.argv[1]);(base/'project').mkdir();p=LocalProjects(base/'data');cid=p.connect(str(base/'project'))['candidate']['id'];s=LocalCommands(p)
e=s.propose({'candidateId':cid,'argv':[sys.executable,'-c',sys.argv[2]],'timeout':10});s.access(e['id'],'start')
for _ in range(100):
 if 'ready' in s.access(e['id'])['output']:os._exit(0)
 time.sleep(.03)
os._exit(5)
"""
    result=subprocess.run([sys.executable,'-c',host_code,str(base),child_code],env={**os.environ,'PYTHONPATH':str(repo/'app')},timeout=8)
    assert result.returncode==0;time.sleep(2.2);assert not marker.exists()
print('PASS: host hard-exit terminates supervised command group')

# A pipe error during cancellation must not replace cancelled with failed.
from unittest.mock import patch,MagicMock
import threading,types
with tempfile.TemporaryDirectory(prefix='aibro-cancel-pipe-') as tmp:
    base=Path(tmp);folder=base/'project';folder.mkdir();projects=LocalProjects(base/'data');link=projects.connect(str(folder));service=LocalCommands(projects)
    entry=service.propose({'candidateId':link['candidate']['id'],'projectId':'p','runId':'r','argv':['/bin/pwd']});entry['status']='running'
    readfd,writefd=os.pipe();os.close(writefd);stream=os.fdopen(readfd,'rb');process=types.SimpleNamespace(stdout=stream,pid=99999999,returncode=-9,wait=lambda:None)
    cancelled=threading.Event();cancelled.set();control={'process':process,'cancel':cancelled};service.running[entry['id']]=control
    selector=MagicMock();selector.select.return_value=[(types.SimpleNamespace(fd=-1,fileobj=stream),None)]
    with patch('local_commands.selectors.DefaultSelector',return_value=selector),patch.object(service,'_kill'):
        service._watch(entry,control,types.SimpleNamespace(cleanup=lambda:None))
    assert service.access(entry['id'])['status']=='cancelled'
    service.close()
print('PASS: cancellation remains terminal when the output pipe raises during drain')

# Timeout reason survives the same output-drain exception.
with tempfile.TemporaryDirectory(prefix='aibro-timeout-pipe-') as tmp:
    base=Path(tmp);folder=base/'project';folder.mkdir();projects=LocalProjects(base/'data');link=projects.connect(str(folder));service=LocalCommands(projects)
    entry=service.propose({'candidateId':link['candidate']['id'],'argv':['/bin/pwd']});entry['status']='running';entry['timeout']=-1
    readfd,writefd=os.pipe();os.close(writefd);stream=os.fdopen(readfd,'rb');process=types.SimpleNamespace(stdout=stream,pid=99999999,returncode=-9,wait=lambda:None)
    control={'process':process,'cancel':threading.Event()};service.running[entry['id']]=control
    selector=MagicMock();selector.select.return_value=[(types.SimpleNamespace(fd=-1,fileobj=stream),None)]
    with patch('local_commands.selectors.DefaultSelector',return_value=selector),patch.object(service,'_kill'):
        service._watch(entry,control,types.SimpleNamespace(cleanup=lambda:None))
    assert service.access(entry['id'])['status']=='timed_out'
    service.close()
