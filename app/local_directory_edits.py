"""Reviewed empty-directory creation. Undo never removes a populated directory."""
import os
import stat
import time
import uuid
from local_projects import LocalProjectError


class DirectoryEdits:
    def __init__(self, edits): self.edits = edits

    def public(self, entry, full=False):
        result = {k: entry[k] for k in ('id','candidateId','projectId','runId','path','status','createdAt','beforeVersion','afterVersion')}
        result['directory'] = True
        if full: result.update(creating=True, before='', after='Create directory: '+entry['path']+'\nUndo is available only while this directory remains empty.')
        return result

    def propose(self, payload):
        e = self.edits
        parts = e.projects._parts(payload.get('path'))
        if not parts: raise LocalProjectError('请指定新文件夹的相对路径。')
        with e.projects._connected_folder(payload.get('candidateId')) as folder:
            parent = e.projects._open_below(folder, '/'.join(parts[:-1]))
            try:
                if self.identity(parent, parts[-1]) is not None: raise LocalProjectError('目标已存在，未覆盖。', 409)
                entry = dict(id='edit_'+uuid.uuid4().hex, candidateId=payload['candidateId'], projectId=str(payload.get('projectId','')),runId=str(payload.get('runId','')),path='/'.join(parts),status='pending',createdAt=int(time.time()*1000),folderIdentity=e._identity(folder),parentIdentity=e._identity(parent),directory=True,createdIdentity=None,beforeVersion=None,afterVersion=None)
                e._save(entry)
                return self.public(entry)
            finally: os.close(parent)

    @staticmethod
    def identity(parent, name):
        try: value = os.stat(name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError: return None
        if not stat.S_ISDIR(value.st_mode): raise LocalProjectError('目标已存在且不是普通文件夹。',409)
        return [value.st_dev,value.st_ino]

    def access(self, cached, action):
        e = self.edits
        if action=='get' and cached['status'] not in ('applying','undoing'): return self.public(cached,True)
        with e.projects._connected_folder(cached['candidateId']) as folder:
            entry=e._load(cached['id']);parts=e.projects._parts(entry['path']);parent=e.projects._open_below(folder,'/'.join(parts[:-1]))
            try:
                if e._identity(folder)!=entry['folderIdentity'] or e._identity(parent)!=entry['parentIdentity']: raise LocalProjectError('目标文件夹已被替换，请重新生成提案。',409)
                current=self.identity(parent,parts[-1])
                if entry['status'] in ('applying','undoing'):
                    if current is None: entry['status']='undone' if entry['status']=='undoing' else 'pending'
                    elif current==entry['createdIdentity']: entry['status']='applied'
                    else: entry['status']='interrupted'
                    e._save(entry)
                if action=='get': return self.public(entry,True)
                if action not in ('apply','undo'): raise LocalProjectError('无效的文件夹审阅操作。')
                expected='pending' if action=='apply' else 'applied';target='applied' if action=='apply' else 'undone'
                if entry['status']==target: return self.public(entry,True)
                if entry['status']!=expected: raise LocalProjectError('此提案目前无法执行，请核对当前目录。',409)
                if action=='apply':
                    if current is not None: raise LocalProjectError('目标文件夹已存在，未覆盖。',409)
                    entry['status']='applying';e._save(entry)
                    try: os.mkdir(parts[-1],mode=0o755,dir_fd=parent)
                    except FileExistsError: raise LocalProjectError('目标刚被其他程序创建，未覆盖。',409)
                    entry['createdIdentity']=self.identity(parent,parts[-1]);e._save(entry)
                else:
                    if current!=entry['createdIdentity']: raise LocalProjectError('文件夹已被替换或移走，未删除。',409)
                    # rmdir is atomic and refuses a nonempty directory, including hidden files.
                    entry['status']='undoing';e._save(entry)
                    try: os.rmdir(parts[-1],dir_fd=parent)
                    except OSError:
                        entry['status']='applied';e._save(entry)
                        raise LocalProjectError('文件夹中已有内容或正在使用；请先移走内容再撤销。',409)
                os.fsync(parent);entry['status']=target;e._save(entry)
                return self.public(entry,True)
            finally: os.close(parent)
