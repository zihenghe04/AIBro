"""Reveal existing, identity-bound workspace files with Finder. No shell strings."""
import fcntl
import hashlib
import json
import mimetypes
import os
import re
import stat
import subprocess
import sys
from pathlib import Path
from local_projects import LocalProjectError


def named_export(store, item, source_fd):
    """Make a user-facing copy; ID-addressed originals remain stable for sync/recovery."""
    path = store.file_path(item['id'])
    metadata_path = path.with_suffix('.meta.json')
    metadata = {}
    if metadata_path.is_file() and not metadata_path.is_symlink():
        try: metadata = json.loads(metadata_path.read_text())
        except (ValueError, OSError): pass
    name = str(item.get('name') or item.get('originalName') or metadata.get('name') or item['id'])
    name = re.sub(r'[\\/:\x00-\x1f\x7f]', '_', name).strip(' .') or 'attachment'
    # PDF magic is authoritative even if a prior AI rename dropped the extension.
    header = os.pread(source_fd, 8, 0)
    extension = '.pdf' if header.startswith(b'%PDF-') else mimetypes.guess_extension(item.get('mimeType') or metadata.get('mimeType') or '')
    if extension and (not Path(name).suffix or header.startswith(b'%PDF-') and not name.lower().endswith('.pdf')):
        name = (Path(name).stem if Path(name).suffix else name) + extension
    while len(name.encode('utf-8')) > 200:
        name = Path(name).stem[:-1] + Path(name).suffix
    parent = store.directory
    for part in ('exports', item['id']):
        parent = parent / part
        parent.mkdir(mode=0o700, exist_ok=True)
        if parent.is_symlink() or not parent.is_dir(): raise LocalProjectError('导出目录不可用。', 409)
    directory_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        # Never overwrite an exported file that the user has subsequently edited.
        for index in range(1000):
            candidate = name if index == 0 else f'{Path(name).stem} ({index + 1}){Path(name).suffix}'
            try: target = os.open(candidate, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
            except FileExistsError:
                existing = os.open(candidate, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
                try:
                    if not stat.S_ISREG(os.fstat(existing).st_mode): raise LocalProjectError('导出文件路径不可用。', 409)
                    def digest(fd):
                        value = hashlib.sha256(); offset = 0
                        while chunk := os.pread(fd, 1024 * 1024, offset): value.update(chunk); offset += len(chunk)
                        return value.digest()
                    if digest(existing) == digest(source_fd): return os.dup(existing)
                finally: os.close(existing)
                continue
            try:
                offset = 0
                with os.fdopen(os.dup(target), 'wb') as output:
                    while chunk := os.pread(source_fd, 1024 * 1024, offset): output.write(chunk); offset += len(chunk)
                    output.flush(); os.fsync(output.fileno())
                return target
            except Exception:
                os.close(target); os.unlink(candidate, dir_fd=directory_fd); raise
        raise LocalProjectError('同名导出文件过多，请整理导出目录。', 409)
    finally: os.close(directory_fd)


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
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode): raise LocalProjectError('原件不可用。', 404)
            exported = named_export(store, item, fd)
            try: return {**reveal(exported), 'exported': True}
            finally: os.close(exported)
        finally: os.close(fd)
    except OSError: raise LocalProjectError('保存的原件已不存在，请重新导入。',404)
    finally: os.close(parent)
