"""Explicitly connected local code folders, with bounded, read-only snapshots."""
import fcntl
import office_documents
import hashlib
import json
import os
import re
import stat
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path


class LocalProjectError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class LocalProjects:
    MAX_DEPTH = 6
    MAX_DIRS = 1500
    MAX_SECONDS = 4
    MAX_TREE = 300
    MAX_CHARS = 60000
    MAX_FILE_CHARS = 12000
    MAX_READ_FILES = 12
    # Hidden files, credentials and generated trees never enter either the
    # candidate index or a model snapshot, even under an explicitly added root.
    EXCLUDED = frozenset({
        'node_modules', 'bower_components', 'vendor', 'build', 'dist', 'coverage',
        'target', '__pycache__', 'venv', 'env', 'site-packages', 'library',
        'credentials', 'credential', 'secrets', 'secret', 'tokens', 'token',
        'private_keys', 'private-keys', 'keychain', 'keychains',
    })
    TEXT_SUFFIXES = frozenset({
        '.md', '.mdx', '.txt', '.json', '.html', '.htm', '.css', '.scss', '.sass',
        '.less', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte',
        '.swift', '.sql', '.csv', '.xml', '.sh', '.c', '.h', '.cpp', '.py', '.toml', '.yaml', '.yml', '.go', '.rs', '.rb', '.php', '.java',
    })
    CODE_MARKERS = frozenset({'package.json', 'index.html', 'pyproject.toml', 'cargo.toml', 'go.mod', 'src'})

    def __init__(self, directory, home_directory=None):
        self.directory = Path(directory)
        self.path = self.directory / 'local-roots.json'
        self.home_directory = Path(home_directory) if home_directory is not None else Path.home()
        self._thread_lock = threading.RLock()

    @contextmanager
    def _lock(self):
        with self._thread_lock:
            self.directory.mkdir(parents=True, exist_ok=True)
            with (self.directory / '.local-roots.lock').open('a') as handle:
                fcntl.flock(handle, fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(handle, fcntl.LOCK_UN)

    def _load(self):
        if not self.path.exists():
            return {'version': 1, 'roots': [], 'candidates': {}}
        try:
            data = json.loads(self.path.read_text())
            if data.get('version') != 1 or not isinstance(data.get('roots'), list) or not isinstance(data.get('candidates'), dict):
                raise ValueError()
            return data
        except (OSError, ValueError, TypeError):
            raise LocalProjectError('本机目录连接记录无法读取，请检查本地数据文件。', 503)

    def _save(self, data):
        descriptor, temporary = tempfile.mkstemp(prefix='.local-roots-', dir=self.directory)
        try:
            with os.fdopen(descriptor, 'w') as handle:
                json.dump(data, handle, ensure_ascii=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    @classmethod
    def _excluded(cls, name):
        name = name.lower()
        if name.startswith('.') or name in cls.EXCLUDED:
            return True
        if name in {'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'}:
            return True
        stem = re.split(r'[.]', name)[0]
        return bool(re.search(r'(^|[-_])(credentials?|secrets?|tokens?|private[-_]?key|id_rsa|id_ed25519)([-_]|$)', stem)) or name.endswith(('.pem', '.key', '.p12', '.pfx', '.keystore')) or name in {'auth.json', 'accounts.json', 'cookies.json'}

    @classmethod
    def _parts(cls, relative):
        if not isinstance(relative, str) or '\x00' in relative or '\\' in relative or '%' in relative:
            raise LocalProjectError('无效的本机项目路径。')
        if not relative:
            return ()
        parts = tuple(relative.split('/'))
        if any(part in ('', '.', '..') or cls._excluded(part) for part in parts):
            raise LocalProjectError('本机项目路径越界或包含不允许访问的目录。', 403)
        return parts

    @staticmethod
    def _dir_flags():
        return os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

    @classmethod
    def _open_root(cls, root):
        path = Path(root['path'])
        if not path.is_absolute() or any(part in ('.', '..') or cls._excluded(part) for part in path.parts[1:]):
            raise LocalProjectError('已连接目录的路径无效。', 403)
        descriptor = os.open('/', cls._dir_flags())
        try:
            for part in path.parts[1:]:
                next_descriptor = os.open(part, cls._dir_flags(), dir_fd=descriptor)
                os.close(descriptor)
                descriptor = next_descriptor
            return descriptor
        except OSError:
            os.close(descriptor)
            raise LocalProjectError('已连接目录不存在、不可访问或已变为符号链接，请重新连接。', 404)

    @classmethod
    def _open_below(cls, root_fd, relative):
        descriptor = os.dup(root_fd)
        try:
            for part in cls._parts(relative):
                next_descriptor = os.open(part, cls._dir_flags(), dir_fd=descriptor)
                os.close(descriptor)
                descriptor = next_descriptor
            return descriptor
        except (OSError, LocalProjectError):
            os.close(descriptor)
            raise

    @staticmethod
    def _public_root(root):
        return {key: root[key] for key in ('id', 'name', 'path')}

    def roots(self):
        with self._lock():
            return {'roots': [self._public_root(root) for root in self._load()['roots']], 'suggestedRoots': self.suggested_roots()}

    def suggested_roots(self):
        """List only the existence of common locations, without scanning files."""
        suggested = []
        for name, label in [('Documents', '文稿'), ('Desktop', '桌面'), ('Developer', 'Developer'), ('Projects', 'Projects'), ('Code', 'Code'), ('Sites', 'Sites')]:
            path = self.home_directory / name
            if path.is_dir() and not path.is_symlink():
                suggested.append({'id': 'common-' + name.lower(), 'name': label, 'path': str(path.resolve()), 'preset': 'common-projects'})
        return suggested

    def connect_preset(self, preset):
        if preset != 'common-projects':
            raise LocalProjectError('不支持这个本机搜索范围。')
        suggested = self.suggested_roots()
        if not suggested:
            raise LocalProjectError('未找到常用项目目录，请选择一个要搜索的文件夹。', 404)
        connected, candidates, warnings = [], [], []
        for item in suggested:
            try:
                result = self.connect(item['path'])
                connected.append(result['root'])
                candidates.append(result['candidate'])
            except LocalProjectError as error:
                warnings.append({'path': item['path'], 'message': str(error)})
        if not connected:
            raise LocalProjectError('常用项目目录均无法访问，请检查文件夹权限或选择其他目录。', 403)
        return {**self.roots(), 'connectedRoots': connected, 'candidates': candidates, 'warnings': warnings}

    def _candidate(self, root, relative, reason):
        self._parts(relative)
        candidate_id = 'local_' + hashlib.sha256((root['id'] + '\0' + relative).encode()).hexdigest()[:40]
        return {'id': candidate_id, 'rootId': root['id'], 'name': Path(relative).name if relative else root['name'], 'path': str(Path(root['path']) / relative), 'relativePath': relative, 'reason': reason}

    @staticmethod
    def _remember(data, candidate):
        data['candidates'][candidate['id']] = {key: candidate[key] for key in ('rootId', 'relativePath')}

    def connect(self, raw_path):
        if not isinstance(raw_path, str) or not raw_path.strip() or len(raw_path) > 4096 or any(char in raw_path for char in ('\x00', '%', '\\')):
            raise LocalProjectError('请提供有效的本机文件夹绝对路径。')
        path = Path(raw_path.strip()).expanduser()
        if not path.is_absolute() or '..' in path.parts:
            raise LocalProjectError('请选择本机文件夹，或输入绝对路径。')
        if path.is_symlink():
            raise LocalProjectError('不能连接符号链接，请选择原始文件夹。', 403)
        current = Path('/')
        for part in path.parts[1:]:
            current /= part
            if current.is_symlink() and str(current) not in ('/var', '/tmp', '/etc'):
                raise LocalProjectError('路径包含符号链接，请选择原始文件夹。', 403)
        # Canonicalize system aliases such as macOS /var -> /private/var once,
        # then use O_NOFOLLOW on every component for all subsequent reads.
        try:
            path = path.resolve(strict=True)
        except (OSError, RuntimeError):
            raise LocalProjectError('找不到这个文件夹，请检查路径。', 404)
        if not path.is_dir():
            raise LocalProjectError('请选择文件夹，不能连接单个文件。')
        if path == Path('/') or any(self._excluded(part) for part in path.parts[1:]):
            raise LocalProjectError('不能连接系统根目录、隐私目录或依赖生成目录。', 403)
        with self._lock():
            data = self._load()
            root = next((item for item in data['roots'] if item['path'] == str(path)), None)
            if root is None:
                if len(data['roots']) >= 64:
                    raise LocalProjectError('最多连接 64 个目录，请先断开不再使用的目录。')
                root = {'id': 'root_' + uuid.uuid4().hex, 'name': path.name, 'path': str(path)}
                descriptor = self._open_root(root)
                os.close(descriptor)
                data['roots'].append(root)
            candidate = self._candidate(root, '', '已连接的本机文件夹')
            self._remember(data, candidate)
            self._save(data)
            return {'root': self._public_root(root), 'candidate': candidate}

    def disconnect(self, root_id):
        if not isinstance(root_id, str) or not re.fullmatch(r'root_[a-f0-9]{32}', root_id):
            raise LocalProjectError('无效的目录连接 ID。')
        with self._lock():
            data = self._load()
            data['roots'] = [root for root in data['roots'] if root['id'] != root_id]
            data['candidates'] = {key: item for key, item in data['candidates'].items() if item['rootId'] != root_id}
            self._save(data)
        return {'ok': True}

    def _entries(self, descriptor, deadline):
        entries = []
        capped = False
        with os.scandir(descriptor) as iterator:
            for inspected, entry in enumerate(iterator):
                if inspected >= 2000 or time.monotonic() >= deadline:
                    capped = True
                    break
                if self._excluded(entry.name):
                    continue
                try:
                    metadata = entry.stat(follow_symlinks=False)
                    if stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode):
                        entries.append((entry.name, metadata))
                except OSError:
                    continue
        return sorted(entries, key=lambda entry: entry[0].lower()), capped

    def search(self, query='', limit=20):
        if not isinstance(query, str) or len(query) > 500:
            raise LocalProjectError('搜索内容过长或格式无效。')
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 50:
            raise LocalProjectError('搜索数量必须是 1 到 50 的整数。')
        normalized = query.strip().lower()
        homepage = any(word in normalized for word in ('主页', '个人网站', 'homepage', 'portfolio', 'personal', 'website'))
        terms = [term for term in re.split(r'\s+', normalized) if term]
        quoted_names = [match[1].strip() for match in re.findall(r'(["“「『\x27‘])([^"“”「」『』\x27‘’\n]{1,100})["”」』\x27’]', normalized) if match[1].strip()]
        # The conversational agent supplies the user's sentence, while the
        # directory dialog supplies plain keywords. Preserve the exact query
        # and also remove common request scaffolding for name matching.
        search_terms = []
        if re.search(r'找|搜|查|看看|读取|发现|\b(find|search|locate|look)\b', normalized):
            cleaned = re.sub(r'帮我|请你|请|本机|本地|电脑|硬盘|搜索|搜寻|查找|寻找|找到|找找|看看|查看|读取|发现|代码项目|代码|文件夹|目录|项目|保存着|保存|存放着|存放|存着|我的|一个|一下|找|搜|的|在|里|上', ' ', normalized)
            stopwords = {'find', 'search', 'locate', 'look', 'for', 'my', 'the', 'a', 'an', 'please', 'can', 'you', 'on', 'in', 'at', 'computer', 'mac', 'local', 'code', 'project', 'projects', 'folder', 'folders', 'repository', 'repo', 'files'}
            search_terms = [term for term in re.findall(r'[a-z0-9_][a-z0-9_.-]*|[\u4e00-\u9fff]+', cleaned) if term not in stopwords]
        aliases = ('homepage', 'home-page', 'portfolio', 'personal', 'website', 'github.io', '主页', '网站')
        found, warnings, scanned, truncated = [], [], 0, False
        deadline = time.monotonic() + self.MAX_SECONDS
        with self._lock():
            data = self._load()
            for root_index, root in enumerate(data['roots']):
                if scanned >= self.MAX_DIRS or time.monotonic() >= deadline:
                    truncated = True
                    break
                # A large Documents tree must not exhaust the whole request
                # before an explicitly connected Code/Sites root is searched.
                roots_remaining = len(data['roots']) - root_index
                root_limit = max(1, (self.MAX_DIRS - scanned) // roots_remaining)
                root_deadline = time.monotonic() + max(0, deadline - time.monotonic()) / roots_remaining
                root_scanned = 0
                try:
                    root_fd = self._open_root(root)
                except LocalProjectError as error:
                    warnings.append({'rootId': root['id'], 'message': str(error)})
                    continue
                try:
                    pending = [('', 0)]
                    while pending:
                        if root_scanned >= root_limit or time.monotonic() >= root_deadline:
                            truncated = True
                            break
                        relative, depth = pending.pop(0)
                        scanned += 1
                        root_scanned += 1
                        try:
                            descriptor = self._open_below(root_fd, relative)
                            try:
                                entries, capped = self._entries(descriptor, root_deadline)
                            finally:
                                os.close(descriptor)
                        except (OSError, LocalProjectError):
                            continue
                        truncated = truncated or capped
                        names = {name.lower() for name, _ in entries}
                        markers = sorted(names & self.CODE_MARKERS)
                        has_readme = any(name.startswith('readme') for name in names)
                        label = (root['name'] + '/' + relative).lower()
                        exact = (bool(terms) and all(term in label for term in terms)) or (bool(search_terms) and all(term in label for term in search_terms)) or any(name in label for name in quoted_names)
                        alias = homepage and any(term in label for term in aliases)
                        website = homepage and ('index.html' in names or 'package.json' in names)
                        code_folder = bool(markers) or has_readme
                        if code_folder and (not normalized or exact or alias or website):
                            score = (100 if exact else 0) + (70 if alias else 0) + (25 if website else 0) + len(markers) * 3 - depth
                            reason = '目录名称符合搜索' if exact or alias else '发现网站代码入口' if website else '发现代码项目标记'
                            if markers:
                                reason += '：' + '、'.join(markers)
                            found.append((score, self._candidate(root, relative, reason)))
                        directories = [(name, meta) for name, meta in entries if stat.S_ISDIR(meta.st_mode)]
                        if depth >= self.MAX_DEPTH:
                            truncated = truncated or bool(directories)
                        else:
                            pending.extend(((relative + '/' if relative else '') + name, depth + 1) for name, _ in directories)
                finally:
                    os.close(root_fd)
            unique = {}
            for _, item in sorted(found, key=lambda item: (-item[0], item[1]['path'])):
                unique.setdefault(item['path'], item)
            candidates = list(unique.values())[:limit]
            for candidate in candidates:
                self._remember(data, candidate)
            if candidates:
                self._save(data)
        return {'candidates': candidates, 'truncated': truncated or len(unique) > limit, 'scannedDirectories': scanned, 'warnings': warnings}

    @staticmethod
    def _priority(relative):
        path = Path(relative)
        name = path.name.lower()
        depth = len(path.parts)
        if name.startswith('readme'):
            return (0, depth, relative)
        if name == 'package.json':
            return (1, depth, relative)
        if name == 'index.html':
            return (2, depth, relative)
        if name in ('app.tsx', 'app.jsx', 'app.vue', 'page.tsx', 'page.jsx', 'index.tsx', 'index.jsx', 'main.ts', 'main.js'):
            return (3, depth, relative)
        return (4 if path.parts[0] in ('src', 'app', 'pages') else 5, depth, relative)

    @contextmanager
    def _connected_folder(self, candidate_id):
        """Revalidate grants and traverse using descriptors, never resolved paths."""
        with self._lock():
            data = self._load()
            candidate = data['candidates'].get(candidate_id) if isinstance(candidate_id, str) else None
            root = next((r for r in data['roots'] if candidate and r['id'] == candidate.get('rootId')), None)
            if root is None:
                raise LocalProjectError('目录连接已撤销，请重新连接本机项目。', 403)
            relative = candidate['relativePath']
            if self._candidate(root, relative, '')['id'] != candidate_id:
                raise LocalProjectError('无效的目录连接。', 403)
            root_fd = self._open_root(root)
            try:
                folder_fd = self._open_below(root_fd, relative)
                try:
                    yield folder_fd
                finally:
                    os.close(folder_fd)
            except OSError:
                raise LocalProjectError('文件不存在、无法读取或已变为符号链接。', 404)
            finally:
                os.close(root_fd)

    def browse_files(self, candidate_id, path='', offset=0):
        self._parts(path)
        if type(offset) is not int or offset < 0:
            raise LocalProjectError('无效的目录页码。')
        with self._connected_folder(candidate_id) as folder_fd:
            descriptor = self._open_below(folder_fd, path)
            try:
                entries = []
                # One directory at a time; browsing never reads file contents.
                with os.scandir(descriptor) as scan:
                    for entry in scan:
                        if self._excluded(entry.name) or entry.is_symlink():
                            continue
                        metadata = entry.stat(follow_symlinks=False)
                        directory = stat.S_ISDIR(metadata.st_mode)
                        if not directory and not stat.S_ISREG(metadata.st_mode):
                            continue
                        name = entry.name
                        supported = directory or Path(name).suffix.lower() in self.TEXT_SUFFIXES | office_documents.SUFFIXES or name.lower() in ('readme', 'license')
                        entries.append({'name': name, 'path': (path + '/' if path else '') + name,
                            'type': 'directory' if directory else 'file', 'size': metadata.st_size,
                            'supported': supported})
                entries.sort(key=lambda e: (e['type'] != 'directory', e['name'].casefold(), e['name']))
                return {'entries': entries[offset:offset + 100], 'offset': offset, 'total': len(entries),
                    'nextOffset': offset + 100 if offset + 100 < len(entries) else None}
            finally:
                os.close(descriptor)

    def read_file(self, candidate_id, path, offset=0, version=None):
        parts = self._parts(path)
        if not parts or type(offset) is not int or offset < 0:
            raise LocalProjectError('无效的文件路径或读取位置。')
        if Path(parts[-1]).suffix.lower() not in self.TEXT_SUFFIXES | office_documents.SUFFIXES and parts[-1].lower() not in ('readme', 'license'):
            raise LocalProjectError('此格式请通过附件导入；本机引用当前支持 Markdown、代码和文本。', 415)
        with self._connected_folder(candidate_id) as folder_fd:
            parent = self._open_below(folder_fd, '/'.join(parts[:-1]))
            try:
                descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                with os.fdopen(descriptor, 'rb') as handle:
                    before = os.fstat(handle.fileno())
                    if not stat.S_ISREG(before.st_mode):
                        raise LocalProjectError('只能读取普通文件。', 403)
                    if before.st_size > 4 * 1024 * 1024:
                        raise LocalProjectError('此文本超过 4 MB，请拆分或通过附件导入。', 413)
                    raw = handle.read(4 * 1024 * 1024 + 1)
                    after = os.fstat(handle.fileno())
                    if len(raw) > 4 * 1024 * 1024 or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                        raise LocalProjectError('读取期间文件发生变化，请更新引用后重试。', 409)
                digest = hashlib.sha256(raw).hexdigest()
                if version and version != digest:
                    raise LocalProjectError('文件已修改，请在输入框上方更新引用后继续。', 409)
                try:
                    content = office_documents.inspect(raw,Path(path).suffix.lower()) if Path(path).suffix.lower() in office_documents.SUFFIXES else raw.decode('utf-8-sig')
                except UnicodeDecodeError:
                    raise LocalProjectError('此文件不是 UTF-8 文本，请通过附件导入。', 415)
                if '\x00' in content:
                    raise LocalProjectError('检测到二进制内容，请通过附件导入。', 415)
                excerpt = content[offset:offset + 12000]
                return {'path': path, 'version': digest, 'size': len(raw), 'offset': offset,
                    'text': excerpt, 'totalChars': len(content),
                    'nextOffset': offset + len(excerpt) if offset + len(excerpt) < len(content) else None}
            finally:
                os.close(parent)

    def snapshot(self, candidate_id):
        if not isinstance(candidate_id, str) or not re.fullmatch(r'local_[a-f0-9]{40}', candidate_id):
            raise LocalProjectError('无效的本机项目 ID。')
        with self._lock():
            data = self._load()
            candidate = data['candidates'].get(candidate_id)
            root = next((item for item in data['roots'] if candidate and item['id'] == candidate.get('rootId')), None)
            if root is None:
                raise LocalProjectError('这个本机项目尚未连接或连接已撤销，请重新连接文件夹。', 403)
            relative = candidate['relativePath']
            self._parts(relative)
            expected = self._candidate(root, relative, '')
            if expected['id'] != candidate_id:
                raise LocalProjectError('本机项目连接记录无效，请重新连接。', 403)
            root_fd = self._open_root(root)
            try:
                try:
                    folder_fd = self._open_below(root_fd, relative)
                except OSError:
                    raise LocalProjectError('本机项目文件夹不存在或已变为符号链接，请重新连接。', 404)
                try:
                    tree, text_paths, files = [], [], []
                    total_files, scanned, characters, truncated = 0, 0, 0, False
                    deadline = time.monotonic() + self.MAX_SECONDS
                    pending = [('', 0)]
                    while pending:
                        if len(tree) >= self.MAX_TREE or scanned >= self.MAX_DIRS or time.monotonic() >= deadline:
                            truncated = True
                            break
                        current, depth = pending.pop(0)
                        scanned += 1
                        try:
                            descriptor = self._open_below(folder_fd, current)
                            try:
                                entries, capped = self._entries(descriptor, deadline)
                            finally:
                                os.close(descriptor)
                        except (OSError, LocalProjectError):
                            continue
                        truncated = truncated or capped
                        ordered = sorted(entries, key=lambda entry: (-1, 0 if entry[0] in ('src', 'app', 'pages') else 1, entry[0]) if stat.S_ISDIR(entry[1].st_mode) else self._priority(entry[0]))
                        # Reserve room for nested source folders instead of
                        # letting hundreds of assets beside index.html consume
                        # the entire tree before src/ can be visited.
                        if any(stat.S_ISDIR(metadata.st_mode) for _, metadata in entries) and len(ordered) > 100:
                            ordered = ordered[:100]
                            truncated = True
                        for name, metadata in ordered:
                            if len(tree) >= self.MAX_TREE:
                                truncated = True
                                break
                            path = (current + '/' if current else '') + name
                            is_directory = stat.S_ISDIR(metadata.st_mode)
                            tree.append({'path': path, 'type': 'directory' if is_directory else 'file', 'size': metadata.st_size if not is_directory else 0, 'mtime': int(metadata.st_mtime * 1000)})
                            if is_directory:
                                if depth < self.MAX_DEPTH:
                                    pending.append((path, depth + 1))
                                else:
                                    truncated = True
                            else:
                                total_files += 1
                                if Path(name).suffix.lower() in self.TEXT_SUFFIXES or name.lower() in ('readme', 'license'):
                                    text_paths.append(path)
                    for path in sorted(text_paths, key=self._priority):
                        if len(files) >= self.MAX_READ_FILES or characters >= self.MAX_CHARS or time.monotonic() >= deadline:
                            truncated = True
                            break
                        descriptor = None
                        try:
                            parts = self._parts(path)
                            parent_fd = self._open_below(folder_fd, '/'.join(parts[:-1]))
                            try:
                                descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
                            finally:
                                os.close(parent_fd)
                            metadata = os.fstat(descriptor)
                            if not stat.S_ISREG(metadata.st_mode):
                                continue
                            available = min(self.MAX_FILE_CHARS, self.MAX_CHARS - characters)
                            with os.fdopen(descriptor, 'rb') as handle:
                                descriptor = None
                                raw = handle.read(available * 4 + 4)
                            if b'\0' in raw:
                                continue
                            content = raw.decode('utf-8', errors='replace')
                            # Non-text blobs should not be pushed into model context.
                            if content and content.count('\ufffd') > max(3, len(content) // 50):
                                continue
                            clipped = len(content) > available or metadata.st_size > len(raw)
                            content = content[:available]
                            files.append({'path': path, 'content': content, 'truncated': clipped})
                            characters += len(content)
                            truncated = truncated or clipped
                        except (OSError, LocalProjectError):
                            truncated = True
                        finally:
                            if descriptor is not None:
                                os.close(descriptor)
                    folder = {key: expected[key] for key in ('id', 'rootId', 'name', 'path')}
                    summary = f'已读取 {len(files)} 个代码或说明文件，目录中已列出 {total_files} 个文件。'
                    if truncated:
                        summary += '内容已按大小、数量或扫描范围限制截取。'
                    return {'folder': folder, 'tree': tree, 'files': files, 'totalFiles': total_files, 'truncated': truncated, 'summary': summary}
                finally:
                    os.close(folder_fd)
            finally:
                os.close(root_fd)
