"""Approved Wiki bodies on disk; SQLite holds metadata, drafts and read cache.

All methods run under WorkspaceStore.lock. The file journal is resolved against
the transaction token in the committed SQLite snapshot before another operation.
"""
import copy
import wiki_links
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile
import time
import uuid
from contextlib import contextmanager


class WikiVaultError(ValueError):
    pass


class WikiVault:
    LIMIT = 4 * 1024 * 1024
    TYPES = {'paper': 'sources/papers', 'method': 'methods', 'concept': 'concepts',
             'dataset': 'datasets', 'benchmark': 'benchmarks', 'experiment': 'experiments',
             'failure': 'failures', 'review': 'reviews', 'idea': 'questions', 'output': 'outputs'}

    def __init__(self, directory):
        self.directory = Path(directory)
        self.root = self.directory / 'vault' / 'research'
        self.journal = self.directory / '.wiki-transaction'

    @staticmethod
    def digest(raw):
        return hashlib.sha256(raw).hexdigest()

    @staticmethod
    def sync_dir(path):
        fd = os.open(path, os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)

    @classmethod
    def atomic(cls, path, raw):
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp = tempfile.mkstemp(prefix='.wiki-write-', dir=path.parent)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(raw); stream.flush(); os.fsync(stream.fileno())
            os.replace(temp, path); cls.sync_dir(path.parent)
        finally:
            if os.path.exists(temp): os.unlink(temp)

    def path(self, relative):
        p = PurePosixPath(relative)
        if not relative or p.is_absolute() or '\\' in relative or any(x in ('', '.', '..') for x in relative.split('/')):
            raise WikiVaultError('无效的 Wiki 相对路径')
        target = self.root.joinpath(*p.parts)
        current = self.directory
        for part in target.relative_to(self.directory).parts:
            current /= part
            if current.is_symlink(): raise WikiVaultError('Wiki 路径不能包含符号链接')
        return target

    @contextmanager
    def parent(self, relative, create=False):
        target = self.path(relative)
        fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for part in target.parent.relative_to(self.directory).parts:
                if create:
                    try: os.mkdir(part, 0o700, dir_fd=fd); os.fsync(fd)
                    except FileExistsError: pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd); fd = child
            yield fd, target.name
        finally: os.close(fd)

    def replace_body(self, relative, raw):
        with self.parent(relative, create=True) as (parent, name):
            if raw is None:
                os.unlink(name, dir_fd=parent); os.fsync(parent); return
            mode = 0o600
            try: mode = stat.S_IMODE(os.stat(name, dir_fd=parent, follow_symlinks=False).st_mode)
            except FileNotFoundError: pass
            temporary = '.wiki-write-' + uuid.uuid4().hex
            fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, mode, dir_fd=parent)
            try:
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(raw); stream.flush(); os.fsync(stream.fileno())
                os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent); os.fsync(parent)
            finally:
                try: os.unlink(temporary, dir_fd=parent)
                except FileNotFoundError: pass

    def read(self, relative, missing=False):
        try:
            with self.parent(relative) as (parent, name):
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        except FileNotFoundError:
            if missing: return None
            raise WikiVaultError('Wiki 文件已移走或删除，请恢复原路径后刷新')
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > self.LIMIT:
                raise WikiVaultError('Wiki 需要独立的普通 UTF-8 文件，单文件最多 4 MiB')
            with os.fdopen(fd, 'rb', closefd=False) as stream: raw = stream.read(self.LIMIT + 1)
            after = os.fstat(fd)
            if len(raw) > self.LIMIT or (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size):
                raise WikiVaultError('读取期间 Wiki 文件有变化，请刷新重试')
            return raw
        finally: os.close(fd)

    @staticmethod
    def notes(snapshot):
        return list(snapshot.get('notes', [])) + [n for t in snapshot.get('trash', [])
                                                for n in t.get('data', {}).get('notes', [])]

    @staticmethod
    def eligible(snapshot):
        projects = {p['id'] for p in snapshot.get('projects', []) if p.get('workspace') == '科研'}
        # Paper guides opt in explicitly; their old paper directory remains an
        # export of the canonical Markdown, never an alternate input.
        return [n for n in WikiVault.notes(snapshot) if (n.get('wikiFileBacked') is True or not n.get('paperId') and
                str(n.get('kind', '')).startswith('科研 Wiki/')) and
                (n.get('workspace') == '科研' or n.get('projectId') in projects)]

    @classmethod
    def relative(cls, note):
        identifier = note.get('id', '')
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', identifier): raise WikiVaultError('无效的 Wiki ID')
        slug = re.sub(r'[^\w\u4e00-\u9fff.-]+', '-', str(note.get('title') or ''), flags=re.UNICODE).strip('.-')[:60]
        if note.get('projectMemoryType') and re.fullmatch(r'[A-Za-z0-9_-]{1,160}', str(note.get('projectId', ''))):
            return f'meta/projects/{note["projectId"]}/{identifier}.md'
        folder = cls.TYPES.get(note.get('wikiCategory') or str(note.get('kind', '')).split('/')[-1], 'notes')
        if note.get('wikiImportBatch'):
            batch = str(note['wikiImportBatch']); name = str(note.get('wikiOriginalName', ''))
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', batch) or not name.lower().endswith(('.md','.markdown')) or any(c in name for c in ('/', '\\', '\0')) or name in ('.','..'):
                raise WikiVaultError('Markdown 导入路径无效')
            # Keep a batch in one physical folder so relative Markdown links
            # work in Finder/external editors as well as in the app.
            relative=str(note.get('wikiOriginalPath') or name)
            if relative.startswith('/') or '\\' in relative or '\0' in relative or len(relative)>1000 or len(relative.split('/'))>12 or any(not p or p.startswith('.') for p in relative.split('/')) or relative.split('/')[-1]!=name:raise WikiVaultError('Markdown 目录路径无效')
            return f'{folder}/import-{batch}/{relative}'
        return f'{folder}/{slug or "entry"}--{identifier}.md'

    @staticmethod
    def encode(note):
        # JSON quoted values are also YAML scalars. Reserved identity metadata
        # is intentionally small; editable body is ordinary Markdown.
        header = '\n'.join(f'{key}: {json.dumps(value, ensure_ascii=False)}' for key, value in
                           [('aibro_id', note['id']), ('title', note.get('title', ''))])
        return ('---\n' + header + '\n---\n' + str(note.get('content') or '')).encode('utf-8')

    @staticmethod
    def decode(raw, identifier):
        try:
            text = raw.decode('utf-8-sig')
            match = re.match(r'\A---\r?\n(.*?)\r?\n---\r?\n', text, re.S)
            if not match: raise ValueError()
            head, content = match[1], text[match.end():]
            values = {}
            for line in head.splitlines():
                key, value = line.split(': ', 1)
                if key not in ('aibro_id', 'title') or key in values: raise ValueError()
                values[key] = json.loads(value)
            if values.get('aibro_id') != identifier or not isinstance(values.get('title'), str): raise ValueError()
            if not values['title'].strip() or len(values['title']) > 240: raise ValueError()
            return values['title'], content
        except (ValueError, UnicodeError):
            raise WikiVaultError('Wiki 文件头无效；保留 aibro_id 与 JSON 引号格式的 title 后刷新')

    def recover(self, snapshot):
        if not self.journal.exists(): return
        if self.journal.is_symlink(): raise WikiVaultError('Wiki 恢复目录不能是符号链接')
        manifest = self.journal / 'journal.json'
        if not manifest.exists():
            # No journal means publication never started. Leave staging for
            # inspection rather than guessing which files might be originals.
            raise WikiVaultError('Wiki 暂存记录不完整，请保留目录并恢复备份')
        if manifest.is_symlink(): raise WikiVaultError('无效的 Wiki 恢复记录')
        plan = json.loads(manifest.read_text())
        if plan.get('version') != 1 or not isinstance(plan.get('files'), list): raise WikiVaultError('Wiki 恢复记录无效')
        if not re.fullmatch(r'[a-f0-9]{32}', str(plan.get('id'))): raise WikiVaultError('Wiki 事务 ID 无效')
        for i, item in enumerate(plan['files']):
            if not isinstance(item, dict) or item.get('backup') != f'{i}.old': raise WikiVaultError('Wiki 恢复路径无效')
            self.path(item['path'])
            for key in ('oldHash', 'newHash'):
                if item.get(key) is not None and not re.fullmatch(r'[a-f0-9]{64}', item[key]): raise WikiVaultError('Wiki 恢复校验值无效')
        committed = snapshot.get('_wikiCommit') == plan['id']
        if not committed:
            for item in reversed(plan['files']):
                raw = self.read(item['path'], missing=True)
                digest = self.digest(raw) if raw is not None else None
                if digest == item['oldHash']: continue
                if digest != item['newHash']:
                    raise WikiVaultError('中断后 Wiki 又被外部修改，已保留文件与恢复备份，未覆盖')
                target = self.path(item['path'])
                if item['oldHash'] is None:
                    self.replace_body(item['path'], None)
                else:
                    saved = self.journal / item['backup']
                    if saved.is_symlink(): raise WikiVaultError('无效的 Wiki 恢复文件')
                    old = saved.read_bytes()
                    if self.digest(old) != item['oldHash']: raise WikiVaultError('Wiki 备份校验失败')
                    self.replace_body(item['path'], old)
        for item in self.journal.iterdir():
            if item.is_symlink() or not item.is_file(): raise WikiVaultError('无效的 Wiki 事务文件')
            item.unlink()
        self.journal.rmdir(); self.sync_dir(self.directory)

    def reconcile(self, snapshot):
        """Read external edits into the cache; never changes a Markdown file."""
        result = copy.deepcopy(snapshot)
        mapping = result.get('_wikiFiles', {})
        changed = False; errors = []
        changed = wiki_links.update(result) or changed
        moved = None
        for note in self.notes(result):
            entry = mapping.get(note.get('id'))
            if not entry: continue
            try:
                if not self.path(entry['path']).exists():
                    if moved is None:
                        moved = {}
                        # Only recover known identities, never ingest unknown
                        # Markdown or infer ownership from a folder name.
                        for candidate in self.root.rglob('*.md'):
                            relative = candidate.relative_to(self.root).as_posix()
                            try:
                                candidate_raw = self.read(relative)
                                head = candidate_raw.decode('utf-8-sig').splitlines()[:4]
                                line = next(x for x in head if x.startswith('aibro_id: '))
                                identifier = json.loads(line.split(': ', 1)[1])
                                if identifier not in mapping: continue
                                self.decode(candidate_raw, identifier)
                                moved.setdefault(identifier, []).append(relative)
                            except (ValueError, OSError, StopIteration): continue
                    locations = moved.get(note['id'], [])
                    if len(locations) > 1: raise WikiVaultError('同一 Wiki ID 有多份文件，请保留唯一文件后刷新')
                    if len(locations) == 1:
                        entry['path'] = locations[0]; changed = True
                raw = self.read(entry['path'])
                title, content = self.decode(raw, note['id'])
            except (WikiVaultError, OSError, ValueError) as exc:
                errors.append({'id': note['id'], 'path': entry['path'], 'message': str(exc)})
                continue
            digest = self.digest(raw)
            if digest == entry['hash']: continue
            note.setdefault('revisionHistory', []).append({
                'title': note.get('title'), 'content': note.get('content'),
                'savedAt': int(time.time() * 1000), 'reason': 'wiki-external-edit'})
            note.update(title=title, content=content, userEdited=True,
                        updatedAt=max(int(time.time() * 1000), (note.get('updatedAt') or 0) + 1))
            entry['hash'] = digest
            changed = True
        changed = wiki_links.update(result) or changed
        return result, changed, errors

    def publish(self, previous, snapshot, force_ids=()):
        """Journal and publish accepted bodies before the SQLite commit."""
        # A client cannot substitute file paths or claim a newer body hash.
        mapping = copy.deepcopy(previous.get('_wikiFiles', {}))
        snapshot['_wikiFiles'] = mapping
        if previous.get('_wikiCommit'): snapshot['_wikiCommit'] = previous['_wikiCommit']
        else: snapshot.pop('_wikiCommit', None)
        if not previous.get('_wikiEnabled') and not snapshot.get('_wikiEnabled'):
            return
        snapshot['_wikiEnabled'] = True
        writes = []
        notes = self.eligible(snapshot)
        present = {n['id'] for n in self.notes(snapshot)}
        for identifier in list(mapping):
            if identifier in present: continue
            old = mapping[identifier]; raw = self.read(old['path'], missing=True)
            if raw is not None and self.digest(raw) != old['hash']:
                raise WikiVaultError('待删除 Wiki 文件有外部修改，请刷新后核对')
            if raw is not None: writes.append((old['path'], raw, None))
            del mapping[identifier]
        for note in notes:
            identifier = note['id']; old = mapping.get(identifier)
            relative = old['path'] if old else self.relative(note)
            prior = next((n for n in self.notes(previous) if n.get('id') == identifier), {})
            if old and identifier not in force_ids and all(note.get(k) == prior.get(k) for k in ('title', 'content')):
                continue
            raw = self.read(relative, missing=not old or identifier in force_ids and old.get('hash') is None)
            old_hash = self.digest(raw) if raw is not None else None
            if old and old_hash != old['hash']:
                raise WikiVaultError('Wiki 已被外部编辑，请刷新后比较版本，未覆盖外部内容')
            if not old and raw is not None: raise WikiVaultError('Wiki 目标已有文件，未覆盖')
            # Keep external line endings/BOM untouched for metadata-only saves.
            body = self.encode(note)
            if len(body) > self.LIMIT: raise WikiVaultError('Wiki 文件超过 4 MiB')
            mapping[identifier] = {**(old or {}), 'path': relative, 'hash': self.digest(body)}
            if body != raw: writes.append((relative, raw, body))
        wiki_links.update(snapshot)
        if not writes: return
        if self.journal.exists(): raise WikiVaultError('Wiki 有待恢复的文件事务')
        self.journal.mkdir(mode=0o700); self.sync_dir(self.directory)
        plan = {'version': 1, 'id': uuid.uuid4().hex, 'files': []}
        try:
            for i, (relative, old, new) in enumerate(writes):
                backup = f'{i}.old'
                if old is not None: self.atomic(self.journal / backup, old)
                if new is not None: self.atomic(self.journal / f'{i}.new', new)
                plan['files'].append({'path': relative, 'oldHash': self.digest(old) if old is not None else None,
                                      'newHash': self.digest(new) if new is not None else None, 'backup': backup})
            self.atomic(self.journal / 'journal.json', json.dumps(plan).encode())
            for relative, old, new in writes:
                if self.read(relative, missing=True) != old: raise WikiVaultError('写入前 Wiki 文件发生变化，未覆盖')
                self.replace_body(relative, new)
            snapshot['_wikiCommit'] = plan['id']
        except Exception:
            if not (self.journal / 'journal.json').exists():
                for p in self.journal.iterdir(): p.unlink()
                self.journal.rmdir()
            else: self.recover(previous)
            raise
