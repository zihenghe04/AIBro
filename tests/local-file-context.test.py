"""Explicit file context is readonly, grant-bound, versioned and paginated."""
import json, tempfile, os
from pathlib import Path
from local_projects import LocalProjects, LocalProjectError

def rejects(fn,status=None):
    try: fn()
    except LocalProjectError as e:
        if status: assert e.status == status, (e.status,str(e))
    else: raise AssertionError('unsafe read accepted')

with tempfile.TemporaryDirectory(prefix='aibro-reference-') as directory:
    base=Path(directory); project=base/'project';project.mkdir()
    (project/'README.md').write_text('Evidence\n' * 3000)
    (project/'src').mkdir(); (project/'src/main.swift').write_text('print("Hello")')
    (project/'.env').write_text('not for context');(project/'private-key.pem').write_text('not for context')
    (project/'database.sqlite').write_bytes(b'SQLite format 3\0')
    outside=base/'outside';outside.mkdir();(outside/'hidden.txt').write_text('outside')
    (project/'escape').symlink_to(outside,target_is_directory=True)
    (project/'linked.md').symlink_to(outside/'hidden.txt')
    service=LocalProjects(base/'data');conn=service.connect(str(project));cid=conn['candidate']['id']
    listing=service.browse_files(cid);names=[r['name'] for r in listing['entries']]
    assert '.env' not in names and 'escape' not in names and 'linked.md' not in names and 'private-key.pem' not in names
    assert not next(r for r in listing['entries'] if r['name']=='database.sqlite')['supported']
    first=service.read_file(cid,'README.md');second=service.read_file(cid,'README.md',first['nextOffset'],first['version'])
    third=service.read_file(cid,'README.md',second['nextOffset'],first['version'])
    assert first['text']+second['text']+third['text']==(project/'README.md').read_text()
    assert third['nextOffset'] is None
    assert service.read_file(cid,'src/main.swift')['text']=='print("Hello")'
    for path in ['../outside/hidden.txt','/etc/passwd','escape/hidden.txt','linked.md','.env','private-key.pem']:
        rejects(lambda:service.read_file(cid,path))
    rejects(lambda:service.read_file(cid,'database.sqlite'),415)
    (project/'README.md').write_text('updated')
    rejects(lambda:service.read_file(cid,'README.md',version=first['version']),409)
    (project/'large.txt').write_bytes(b'a'*(4*1024*1024+1));rejects(lambda:service.read_file(cid,'large.txt'),413)
    (project/'binary.txt').write_bytes(b'a\0b');rejects(lambda:service.read_file(cid,'binary.txt'),415)
    rejects(lambda:service.read_file(cid,'README.md',-1),400)
    for i in range(110): (project/f'part-{i}.txt').write_text('x')
    a=service.browse_files(cid);b=service.browse_files(cid,offset=a['nextOffset'])
    assert len({r['path'] for r in a['entries']+b['entries']})==a['total']
    service.disconnect(conn['root']['id'])
    rejects(lambda:service.read_file(cid,'README.md'),403)
    rejects(lambda:service.browse_files(cid),403)
print('PASS local file context: grants, symlinks, pagination, versions, formats and revocation')
