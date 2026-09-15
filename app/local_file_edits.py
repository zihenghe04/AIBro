"""Durable, explicitly accepted Markdown/text proposals. Never execute file contents."""
import base64
import office_documents
import hashlib
import json
import os
import re
import stat
import tempfile
import time
import uuid
from pathlib import Path
from local_projects import LocalProjectError
from local_directory_edits import DirectoryEdits


class LocalFileEdits:
    LIMIT = 4 * 1024 * 1024

    def __init__(self, projects):
        self.projects = projects
        self.directory = projects.directory / 'local-file-edits'
        self.directories = DirectoryEdits(self)

    @staticmethod
    def digest(raw):
        return None if raw is None else hashlib.sha256(raw).hexdigest()

    def _path(self, identifier):
        if not isinstance(identifier, str) or not re.fullmatch(r'edit_[a-f0-9]{32}', identifier):
            raise LocalProjectError('无效的文件修改提案。')
        return self.directory / (identifier + '.json')

    def _save(self, entry):
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, temp = tempfile.mkstemp(prefix='.edit-', dir=self.directory)
        try:
            with os.fdopen(fd, 'w') as out:
                json.dump(entry, out, ensure_ascii=False)
                out.flush(); os.fsync(out.fileno())
            os.replace(temp, self._path(entry['id']))
            directory_fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY)
            try: os.fsync(directory_fd)
            finally: os.close(directory_fd)
        finally:
            if os.path.exists(temp): os.unlink(temp)

    def _load(self, identifier):
        try:
            entry = json.loads(self._path(identifier).read_text())
            if entry['id'] != identifier: raise ValueError()
            return entry
        except (FileNotFoundError, ValueError, KeyError):
            raise LocalProjectError('此本机没有这份提案，请在创建提案的设备查看。', 404)

    def _read(self, parent, name):
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        except FileNotFoundError:
            return None, None
        with os.fdopen(fd, 'rb') as handle:
            before = os.fstat(handle.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                raise LocalProjectError('只能修改普通文件，不支持链接或特殊文件。', 403)
            if before.st_size > self.LIMIT: raise LocalProjectError('文件超过 4 MB，暂不支持整文件审阅。', 413)
            raw = handle.read(self.LIMIT + 1)
            after = os.fstat(handle.fileno())
            if len(raw) > self.LIMIT or (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size):
                raise LocalProjectError('文件正在被其他程序修改，请稍后重试。', 409)
            return raw, after

    @staticmethod
    def _text(raw):
        if raw is None: return ''
        try: value = raw.decode('utf-8-sig')
        except UnicodeDecodeError: raise LocalProjectError('只支持 UTF-8 文本。', 415)
        if '\0' in value: raise LocalProjectError('不支持二进制文件。', 415)
        return value

    @staticmethod
    def _identity(fd):
        value = os.fstat(fd)
        return [value.st_dev, value.st_ino]

    @staticmethod
    def _raw(entry, key):
        value = entry[key]
        return None if value is None else base64.b64decode(value)

    def _public(self, entry, full=False):
        if entry.get('directory'): return self.directories.public(entry, full)
        result = {k: entry[k] for k in ['id','candidateId','projectId','runId','path','status','createdAt','beforeVersion','afterVersion']}
        if full:
            view=lambda raw:office_documents.inspect(raw,Path(entry['path']).suffix.lower()) if entry.get('office') else self._text(raw)
            result.update(before=view(self._raw(entry,'before')), after=view(self._raw(entry,'after')), creating=entry['before'] is None, office=entry.get('office',False))
        return result

    def propose(self, payload):
        if payload.get('operation') == 'mkdir': return self.directories.propose(payload)
        candidate = payload.get('candidateId'); path = payload.get('path'); content = payload.get('content')
        if not isinstance(path, str) or not path or Path(path).suffix.lower() not in self.projects.TEXT_SUFFIXES | office_documents.SUFFIXES:
            raise LocalProjectError('不支持该类型的文件改写；请使用 Markdown、代码或配置文本。', 415)
        parts = self.projects._parts(path)
        if not isinstance(content, str) or '\0' in content: raise LocalProjectError('文件内容必须为文本。')
        if len(content.encode('utf-8')) > self.LIMIT: raise LocalProjectError('修改内容超过 4 MB。', 413)
        if payload.get('operation') not in ('create','update'): raise LocalProjectError('无效的文件修改方式。')
        with self.projects._connected_folder(candidate) as folder:
            parent = self.projects._open_below(folder, '/'.join(parts[:-1]))
            try:
                raw, metadata = self._read(parent, parts[-1]); office=Path(path).suffix.lower() in office_documents.SUFFIXES; before='' if office else self._text(raw)
                if payload['operation']=='create' and raw is not None:
                    raise LocalProjectError('目标文件已经存在，请引用当前文件后生成修改提案。', 409)
                if payload['operation']=='update' and (raw is None or not payload.get('version') or self.digest(raw)!=payload['version']):
                    raise LocalProjectError('文件版本已变化，请更新引用后重新生成提案。', 409)
                # Preserve the original BOM and line endings when rewriting text.
                if '\r\n' in before and '\n' not in before.replace('\r\n',''):
                    content = content.replace('\r\n','\n').replace('\n','\r\n')
                try: after = office_documents.transform(raw,Path(path).suffix.lower(),content) if office else (b'\xef\xbb\xbf' if raw and raw.startswith(b'\xef\xbb\xbf') else b'') + content.encode('utf-8')
                except (ValueError,KeyError,TypeError) as exc: raise LocalProjectError('Office 提案无效：'+str(exc),415)
                if len(after)>self.LIMIT: raise LocalProjectError('生成文件超过 4 MB。',413)
                if raw == after: raise LocalProjectError('文件内容没有变化。')
                entry = dict(id='edit_'+uuid.uuid4().hex, candidateId=candidate, projectId=str(payload.get('projectId','')), runId=str(payload.get('runId','')),
                    path=path, office=office, status='pending', createdAt=int(time.time()*1000), folderIdentity=self._identity(folder), parentIdentity=self._identity(parent),
                    before=None if raw is None else base64.b64encode(raw).decode(), after=base64.b64encode(after).decode(),
                    beforeVersion=self.digest(raw), afterVersion=self.digest(after), mode=stat.S_IMODE(metadata.st_mode) & 0o777 if metadata else 0o644)
                self._save(entry)
                return self._public(entry)
            finally: os.close(parent)

    def _recover(self, entry, current):
        # Journal reconciliation is read-only with respect to the user's file.
        if entry['status'] not in ('applying','undoing'): return
        digest = self.digest(current); undo = entry['status']=='undoing'
        if digest==entry['afterVersion']: entry['status']='applied'
        elif digest==entry['beforeVersion']: entry['status']='undone' if undo else 'pending'
        else: entry['status']='interrupted'
        self._save(entry)

    def access(self, identifier, action='get'):
        # Same lock as directory grants: disconnect cannot interleave a write.
        cached = self._load(identifier)
        if cached.get('directory') and action != 'dismiss':
            try: return self.directories.access(cached, action)
            except (LocalProjectError, OSError):
                if action == 'get': return self._public(cached, True)
                raise
        if action == 'get':
            if cached['status'] in ('applying','undoing'):
                try:
                    with self.projects._connected_folder(cached['candidateId']) as folder:
                        cached = self._load(identifier)
                        parts = self.projects._parts(cached['path'])
                        parent = self.projects._open_below(folder, '/'.join(parts[:-1]))
                        try:
                            if self._identity(folder)==cached['folderIdentity'] and self._identity(parent)==cached['parentIdentity']:
                                current,_ = self._read(parent,parts[-1]); self._recover(cached,current)
                        finally: os.close(parent)
                except (LocalProjectError,OSError): pass
            return self._public(cached, True)
        if action == 'dismiss':
            # Shares the write lock, but does not require a still-connected grant.
            # Dismissing a proposal never touches the user's original file.
            with self.projects._lock():
                entry = self._load(identifier)
                if entry['status'] == 'pending':
                    entry['status'] = 'dismissed'; self._save(entry)
                return self._public(entry, True)
        candidate = cached['candidateId']
        with self.projects._connected_folder(candidate) as folder:
            entry = self._load(identifier)
            parts = self.projects._parts(entry['path']); parent = self.projects._open_below(folder,'/'.join(parts[:-1]))
            try:
                if self._identity(folder)!=entry['folderIdentity'] or self._identity(parent)!=entry['parentIdentity']:
                    raise LocalProjectError('目标文件夹已被替换，请重新生成提案。', 409)
                current, metadata = self._read(parent,parts[-1]); self._recover(entry,current)
                if action=='get': return self._public(entry,True)
                if action not in ('apply','undo'): raise LocalProjectError('无效的审阅操作。')
                target_status = 'applied' if action=='apply' else 'undone'
                if entry['status']==target_status: return self._public(entry,True)
                if entry['status']!=('pending' if action=='apply' else 'applied'):
                    raise LocalProjectError('此提案目前不能执行该操作，请查看当前文件。', 409)
                expected=entry['beforeVersion'] if action=='apply' else entry['afterVersion']
                if self.digest(current)!=expected:
                    raise LocalProjectError('文件已有其他修改，未覆盖。请更新引用后重新生成提案；本轮 Diff 仍保留。', 409)
                raw=self._raw(entry,'after' if action=='apply' else 'before')
                entry['status']='applying' if action=='apply' else 'undoing';self._save(entry)
                self._replace(parent,parts[-1],raw,expected,entry['mode'])
                entry['status']=target_status;self._save(entry)
                return self._public(entry,True)
            finally: os.close(parent)

    def _replace(self, parent, name, raw, expected, mode):
        temp='.aibro-edit-'+uuid.uuid4().hex
        try:
            if raw is not None:
                fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
                with os.fdopen(fd,'wb') as out:
                    out.write(raw);out.flush();os.fchmod(out.fileno(),mode);os.fsync(out.fileno())
            # Recheck after staging. The file itself is replaced atomically; editors
            # that ignore advisory locks may still race the final filesystem call.
            current,_=self._read(parent,name)
            if self.digest(current)!=expected: raise LocalProjectError('保存期间文件发生变化，未覆盖。',409)
            if raw is None: os.unlink(name,dir_fd=parent)
            elif expected is None:
                # Atomic no-clobber creation, even if another app creates it now.
                try: os.link(temp,name,src_dir_fd=parent,dst_dir_fd=parent,follow_symlinks=False)
                except FileExistsError: raise LocalProjectError('目标文件刚被创建，未覆盖。',409)
            else: os.replace(temp,name,src_dir_fd=parent,dst_dir_fd=parent)
            os.fsync(parent)
        finally:
            try: os.unlink(temp,dir_fd=parent)
            except FileNotFoundError: pass
