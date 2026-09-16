"""Real filesystem transactions, persisted recovery, grant enforcement and Finder targets."""
import hashlib, json, os, subprocess, sys, tempfile, urllib.request, urllib.error
from pathlib import Path
from local_projects import LocalProjects, LocalProjectError
from local_file_edits import LocalFileEdits
from file_reveal import reveal_file
from http_test_support import python_http_service

def reject(fn,status=None):
    try: fn()
    except LocalProjectError as e:
        if status: assert e.status==status,(str(e),e.status,status)
    else: raise AssertionError('invalid operation accepted')

with tempfile.TemporaryDirectory(prefix='aibro-file-edits-') as tmp:
    base=Path(tmp);project=base/'项目 with spaces';project.mkdir();target=project/'路线.md';original=b'\xef\xbb\xbf# Plan\r\nKeep me\r\n';target.write_bytes(original);target.chmod(0o640)
    projects=LocalProjects(base/'data');connection=projects.connect(str(project));cid=connection['candidate']['id'];service=LocalFileEdits(projects)
    def proposal(**overrides):return service.propose(dict(candidateId=cid,projectId='p',runId='r',path='路线.md',operation='update',version=hashlib.sha256(target.read_bytes()).hexdigest(),content='# Plan\nKeep me\nNew line\n',**overrides))
    entry=proposal();eid=entry['id'];assert target.read_bytes()==original
    service=LocalFileEdits(LocalProjects(base/'data'));assert service.access(eid)['before']=='# Plan\r\nKeep me\r\n'
    service.access(eid,'apply');changed=target.read_bytes();assert changed==original+b'New line\r\n';assert target.stat().st_mode&0o777==0o640
    service.access(eid,'apply');assert target.read_bytes()==changed
    target.write_text('external edit');reject(lambda:service.access(eid,'undo'),409);assert target.read_text()=='external edit'
    target.write_bytes(changed);service.access(eid,'undo');assert target.read_bytes()==original
    entry=proposal();target.write_text('new external');reject(lambda:service.access(entry['id'],'apply'),409);assert target.read_text()=='new external';target.write_bytes(original)
    create=service.propose(dict(candidateId=cid,path='new.md',projectId='p',runId='r',operation='create',content='# New'))
    assert not (project/'new.md').exists();service.access(create['id'],'apply');assert (project/'new.md').read_text()=='# New';service.access(create['id'],'undo');assert not (project/'new.md').exists()
    code=service.propose(dict(candidateId=cid,path='main.py',projectId='p',runId='r',operation='create',content='raise RuntimeError("must not execute")'))
    service.access(code['id'],'apply');assert (project/'main.py').read_text().startswith('raise RuntimeError');service.access(code['id'],'undo');assert not (project/'main.py').exists()
    mkdir=service.propose(dict(candidateId=cid,path='outputs',projectId='p',runId='r',operation='mkdir'))
    assert mkdir['directory'] and not (project/'outputs').exists()
    service.access(mkdir['id'],'apply');assert (project/'outputs').is_dir()
    (project/'outputs'/'keep.txt').write_text('keep')
    reject(lambda:service.access(mkdir['id'],'undo'),409);assert (project/'outputs'/'keep.txt').read_text()=='keep'
    (project/'outputs'/'keep.txt').unlink();service.access(mkdir['id'],'undo');assert not (project/'outputs').exists()
    mkdir=service.propose(dict(candidateId=cid,path='recover-dir',projectId='p',runId='r',operation='mkdir'))
    interrupted=service._load(mkdir['id']);interrupted['status']='applying';service._save(interrupted);(project/'recover-dir').mkdir()
    assert service.access(mkdir['id'])['status']=='interrupted';reject(lambda:service.access(mkdir['id'],'undo'),409)
    for path in ('../escape','nested/missing/child','.hidden','路线.md'):
        reject(lambda:service.propose(dict(candidateId=cid,path=path,operation='mkdir')))
    # Recovery after a crash between physical write and recording its outcome.
    entry=proposal();raw=service._load(entry['id']);raw['status']='applying';service._save(raw);target.write_bytes(service._raw(raw,'after'));service.access(entry['id'],'apply');assert service.access(entry['id'])['status']=='applied';service.access(entry['id'],'undo');assert target.read_bytes()==original
    # Two proposals from the same base do not overwrite each other.
    a=proposal();b=proposal();service.access(a['id'],'apply');reject(lambda:service.access(b['id'],'apply'),409);service.access(a['id'],'undo')
    for path in ('../outside.md','.env.md','secret/token.md','a.exe','/tmp/escape.md'):
        reject(lambda:service.propose(dict(candidateId=cid,path=path,operation='create',content='x')))
    outside=base/'outside.md';outside.write_text('outside');(project/'link.md').symlink_to(outside)
    reject(lambda:service.propose(dict(candidateId=cid,path='link.md',operation='update',version='x',content='y')))
    os.link(outside,project/'hard.md');reject(lambda:service.propose(dict(candidateId=cid,path='hard.md',operation='update',version='x',content='y')),403)
    # Finder gets an argv array and the actual opened file; never a shell command.
    if sys.platform == 'darwin':
        calls=[]
        def launch(args,**kwargs):calls.append(args)
        assert reveal_file(projects,None,dict(type='local',candidateId=cid,path='路线.md'),launch)['ok']
        assert calls[-1]==['/usr/bin/open','-R',str(target.resolve())]
        reject(lambda:reveal_file(projects,None,dict(type='local',candidateId=cid,path='../outside.md'),launch),403)
        reject(lambda:reveal_file(projects,None,dict(type='local',candidateId=cid,path='link.md'),launch))
        class Store:
            directory=base
            def load(self):return {'imports':[{'id':'fixture','name':'原件.pdf'}]}
            def file_path(self,id):return base/'files'/id
        store=Store();(base/'files').mkdir();store.file_path('fixture').write_bytes(b'%PDF synthetic')
        reveal_file(projects,store,dict(type='import',id='fixture'),launch)
        exported=Path(calls[-1][-1]);assert exported.name=='原件.pdf';assert exported.read_bytes()==store.file_path('fixture').read_bytes()
        assert exported != store.file_path('fixture');assert exported.is_relative_to((base/'exports').resolve())
        reveal_file(projects,store,dict(type='import',id='fixture'),launch);assert calls[-1][-1]==str(exported)
        exported.write_bytes(b'user edited copy')
        reveal_file(projects,store,dict(type='import',id='fixture'),launch);assert Path(calls[-1][-1]).name=='原件 (2).pdf'
        assert exported.read_bytes()==b'user edited copy';assert store.file_path('fixture').read_bytes()==b'%PDF synthetic'
        store.file_path('fixture').write_bytes(b'%PDF-1.7\nsynthetic original')
        store.load=lambda:{'imports':[{'id':'fixture','name':'../../renamed without extension'}]}
        reveal_file(projects,store,dict(type='import',id='fixture'),launch)
        safe_export=Path(calls[-1][-1]);assert safe_export.suffix=='.pdf';assert safe_export.parent==(base/'exports'/'fixture').resolve()
        assert safe_export.read_bytes()==store.file_path('fixture').read_bytes()
        (base/'exports').rename(base/'old-exports');(base/'exports').symlink_to(project,target_is_directory=True)
        reject(lambda:reveal_file(projects,store,dict(type='import',id='fixture'),launch),409)
        reject(lambda:reveal_file(projects,store,dict(type='import',id='../../outside'),launch),404)
    pending=proposal();projects.disconnect(connection['root']['id']);reject(lambda:service.access(pending['id'],'apply'),403);assert service.access(pending['id'])['before'];assert target.read_bytes()==original
    assert service.access(pending['id'],'dismiss')['status']=='dismissed'
    assert service.access(pending['id'],'dismiss')['status']=='dismissed'
    assert target.read_bytes()==original
    # Same-origin HTTP boundary and durable review across separate requests.
    root=Path(__file__).resolve().parents[1]
    with python_http_service(root/'app/server.py',cwd=root/'app',env={**os.environ,'AI_WORKSTATION_DATA_DIR':str(base/'http'),'AI_WORKSTATION_PORT':'0'}) as origin:
        def request(path,payload,source=True):
            headers={'Content-Type':'application/json'}
            if source:headers['Origin']=origin if source is True else source
            req=urllib.request.Request(origin+path,data=json.dumps(payload).encode(),headers=headers,method='POST')
            try:
                with urllib.request.urlopen(req) as response:return response.status,json.load(response)
            except urllib.error.HTTPError as e:return e.code,json.load(e)
        _,con=request('/__local/roots',{'path':str(project)})
        payload=dict(candidateId=con['candidate']['id'],path='http.md',operation='create',content='# HTTP',runId='r',projectId='p')
        for path in ('/__local/edits/propose','/__local/edits/apply','/__local/reveal'):
            assert request(path,payload,False)[0]==403
            assert request(path,payload,'https://invalid.example')[0]==403
        code,result=request('/__local/edits/propose',payload);assert code==200,result;assert not (project/'http.md').exists()
        code,result=request('/__local/edits/apply',{'id':result['id']});assert code==200,result;assert (project/'http.md').read_text()=='# HTTP'
        code,result=request('/__local/edits/undo',{'id':result['id']});assert code==200,result;assert not (project/'http.md').exists()
print('PASS: durable proposals, save/undo/conflicts, BOM/CRLF, recovery, revocation, links, Finder identity, HTTP origin boundary')
