"""Reveal existing, identity-bound workspace files with Finder. No shell strings."""
import fcntl
import os
import stat
import subprocess
import sys
from pathlib import Path
from local_projects import LocalProjectError


def reveal_file(projects, store, payload, launch=None):
    if sys.platform != 'darwin': raise LocalProjectError('在 Finder 中显示仅适用于 macOS。', 400)
    def reveal(fd, allow_directory=False):
        if not (stat.S_ISREG(os.fstat(fd).st_mode) or allow_directory and stat.S_ISDIR(os.fstat(fd).st_mode)): raise LocalProjectError('原件不可用。', 404)
        # F_GETPATH returns the actual opened file, including Unicode and spaces.
        path = os.fsdecode(fcntl.fcntl(fd, 50, bytes(1024)).split(b'\0',1)[0])
        if not (Path(path).is_file() or allow_directory and Path(path).is_dir()): raise LocalProjectError('原件已移动或删除。', 404)
        try: (launch or subprocess.run)(['/usr/bin/open','-R',path], check=True, timeout=10, capture_output=True)
        except (subprocess.SubprocessError,OSError): raise LocalProjectError('Finder 暂时无法打开，请重试。', 503)
        return {'ok':True}
    if payload.get('type')=='local':
        parts=projects._parts(payload.get('path'))
        if not parts: raise LocalProjectError('请选择文件。')
        with projects._connected_folder(payload.get('candidateId')) as folder:
            parent=projects._open_below(folder,'/'.join(parts[:-1]))
            try:
                fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
                try: return reveal(fd, True)
                finally: os.close(fd)
            finally: os.close(parent)
    if payload.get('type')=='note':
        snapshot=store.load(); identifier=payload.get('id')
        note=next((n for n in snapshot.get('notes',[]) if n.get('id')==identifier and not any(n.get(k) for k in ('deletedAt','deleted','archived','archivedAt'))),None)
        entry=snapshot.get('_wikiFiles',{}).get(identifier)
        if not note or not entry: raise LocalProjectError('此笔记尚未存为 Wiki Markdown。',404)
        if note.get('projectId') and not any(p.get('id')==note['projectId'] and not any(p.get(k) for k in ('deletedAt','deleted','archived','archivedAt')) for p in snapshot.get('projects',[])):
            raise LocalProjectError('所属项目已归档或删除。',404)
        path=store.wiki.path(entry['path'])
        store.wiki.read(entry['path'])
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try: return reveal(fd)
        finally: os.close(fd)
    if payload.get('type')!='import': raise LocalProjectError('此内容没有可定位的本机原件。')
    identifier=payload.get('id')
    snapshot=store.load()
    item=next((x for x in snapshot.get('imports',[]) if x.get('id')==identifier and not any(x.get(k) for k in ('deletedAt','deleted','archived','archivedAt'))),None)
    if not item or item.get('url'): raise LocalProjectError('此资料没有可定位的本机原件。',404)
    if item.get('projectId') and not any(p.get('id')==item['projectId'] and not any(p.get(k) for k in ('deletedAt','deleted','archived','archivedAt')) for p in snapshot.get('projects',[])):
        raise LocalProjectError('所属项目已归档或删除。',404)
    path=store.file_path(identifier)
    parent=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        fd=os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
        try: return reveal(fd)
        finally: os.close(fd)
    except OSError: raise LocalProjectError('保存的原件已不存在，请重新导入。',404)
    finally: os.close(parent)
