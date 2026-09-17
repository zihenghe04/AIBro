#!/usr/bin/env python3
"""Loopback service for the workstation's durable store, files and AI requests."""
import base64, fcntl, hashlib, html, http.client, ipaddress, json, math, mimetypes, os, re, secrets, select, shutil, socket, stat, subprocess, tempfile, threading, time, urllib.parse, urllib.request
from contextlib import contextmanager
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from socketserver import TCPServer
from urllib.error import HTTPError
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile
from codex_bridge import BridgeError, CodexBridge
from local_projects import LocalProjectError, LocalProjects
from local_file_edits import LocalFileEdits
from local_commands import LocalCommands
from file_reveal import reveal_file
from wiki_migration import WikiMigration
from wiki_bundle import WikiBundle
from wiki_vault import WikiVault, WikiVaultError
from project_jobs import ProjectJobs
from sync_store import SyncStore, all_imports, DIGEST
from sync_merge import merge_local_snapshot, MergeConflict
from cloud_sync import CloudSync, CloudSyncError
from public_url_fetch import PublicFetchError, fetch_public_url, extract_feishu_mindnote

ASSET_DIR = Path(os.environ.get('AI_WORKSTATION_ASSET_DIR', Path(__file__).resolve().parent)).resolve()
ASSET_MANIFEST = json.loads((ASSET_DIR / 'asset-manifest.json').read_text())
OPTIONAL_ASSETS = ASSET_MANIFEST.get('optionalRuntime', [])
DECLARED_ASSETS = ASSET_MANIFEST['web'] + ASSET_MANIFEST['runtime'] + OPTIONAL_ASSETS + ['asset-manifest.json']
if ASSET_MANIFEST.get('schemaVersion') != 1 or len(DECLARED_ASSETS) != len(set(DECLARED_ASSETS)) or any(not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', value) for value in DECLARED_ASSETS):
    raise ValueError('Invalid application asset manifest')
STATIC_PATHS = {'/' + filename: filename for filename in ASSET_MANIFEST['web']}
STATIC_PATHS['/'] = 'index.html'
VERSION = json.loads((ASSET_DIR / 'package.json').read_text())['version']

def asset_fingerprint(directory=ASSET_DIR):
    digest = hashlib.sha256()
    files = ASSET_MANIFEST['web'] + ASSET_MANIFEST['runtime'] + [name for name in OPTIONAL_ASSETS if (Path(directory) / name).is_file()] + ['asset-manifest.json']
    for filename in sorted(files):
        digest.update(filename.encode()); digest.update(b'\0'); digest.update((Path(directory) / filename).read_bytes()); digest.update(b'\0')
    return digest.hexdigest()

# Capture this at startup: a process from a previous build cannot claim that
# its in-memory code matches files replaced while it was running.
ASSET_FINGERPRINT = asset_fingerprint()
DATA_DIR = Path(os.environ.get('AI_WORKSTATION_DATA_DIR', Path.home() / 'Library' / 'Application Support' / 'ai-workstation'))
PORT = int(os.environ.get('AI_WORKSTATION_PORT', '8766'))
MAX_FILE = 64 * 1024 * 1024
MAX_PREVIEW_PIXELS = 8_000_000
PDF_PREVIEW_LOCK = threading.Lock()
MAX_RECOVERY_SNAPSHOT_BYTES = 25_000_000
MAX_RECOVERY_SNAPSHOTS = 50
MAX_RECOVERY_TOTAL_BYTES = 250_000_000
PROXY_CONNECT_TIMEOUT = 30

class LoopbackHTTPServer(ThreadingHTTPServer):
    def server_bind(self):
        # HTTPServer resolves a display hostname synchronously after binding.
        # This numeric loopback service must start even when reverse DNS stalls.
        TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

def proxy_opener(on_connected):
    """Bound connection/TLS setup only; generation reads have no deadline."""
    class HTTPConnection(http.client.HTTPConnection):
        def connect(self):
            super().connect()
            self.sock.settimeout(None)
            on_connected(self.sock)
    class HTTPSConnection(http.client.HTTPSConnection):
        def connect(self):
            super().connect()
            self.sock.settimeout(None)
            on_connected(self.sock)
    class HTTPHandler(urllib.request.HTTPHandler):
        def http_open(self, request): return self.do_open(HTTPConnection, request)
    class HTTPSHandler(urllib.request.HTTPSHandler):
        def https_open(self, request): return self.do_open(HTTPSConnection, request, context=self._context)
    class SameOriginRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, response, code, message, headers, new_url):
            def origin(value):
                url = urllib.parse.urlsplit(value)
                return url.scheme.lower(), url.hostname, url.port or (443 if url.scheme.lower() == 'https' else 80)
            target = urllib.parse.urlsplit(new_url)
            if target.username or target.password or origin(request.full_url) != origin(new_url):
                response.close()
                raise ValueError('API 服务重定向到了其他来源，已停止转发。请在设置中填写最终服务地址。')
            return super().redirect_request(request, response, code, message, headers, new_url)
    return urllib.request.build_opener(HTTPHandler(), HTTPSHandler(), SameOriginRedirect())

class ConflictError(ValueError):
    def __init__(self, message, current_revision=None, recovery=None):
        super().__init__(message)
        self.current_revision = current_revision
        self.recovery = recovery or {}

class TrashPurgeError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status

class WorkspaceStore:
    def __init__(self, directory):
        self.directory, self.path = Path(directory), Path(directory) / 'workspace.json'
        self._thread_lock = threading.RLock()
        self._lock_state = threading.local()
        self.wiki = WikiVault(directory)
        self.sync = SyncStore(directory)
        if any(self.directory.glob('.cloud-undo-*')): self.recover_cloud_files()
    @contextmanager
    def lock(self):
        with self._thread_lock:
            if getattr(self._lock_state, 'held', False):
                yield
                return
            self.directory.mkdir(parents=True, exist_ok=True)
            with (self.directory / '.workspace.lock').open('a') as handle:
                fcntl.flock(handle, fcntl.LOCK_EX)
                self._lock_state.held = True
                try: yield
                finally:
                    self._lock_state.held = False
                    fcntl.flock(handle, fcntl.LOCK_UN)
    @staticmethod
    def atomic_write(path, data):
        path.parent.mkdir(parents=True, exist_ok=True); descriptor, temporary = tempfile.mkstemp(prefix='.write-', dir=path.parent)
        try:
            with os.fdopen(descriptor, 'wb') as handle: handle.write(data); handle.flush(); os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary): os.unlink(temporary)
    def _load_cached(self):
        snapshot = self.sync.snapshot()
        return snapshot if snapshot is not None else json.loads(self.path.read_text()) if self.path.exists() else {}
    def load(self):
        with self.lock():
            current = self._load_cached()
            try:
                self.wiki.recover(current)
                if not current.get('_wikiEnabled'): return current
                updated, changed, errors = self.wiki.reconcile(current)
            except (WikiVaultError, OSError, ValueError) as exc:
                return {**current, '_wikiError': str(exc)}
            if changed:
                updated['_revision'] = int(current.get('_revision', 0)) + 1
                updated['_savedAt'] = int(time.time() * 1000)
                self.sync.capture(updated, before_commit=self._mirror)
            if errors:
                updated['_wikiErrors'] = errors
                by_id = {e['id']: e['message'] for e in errors}
                for note in self.wiki.notes(updated):
                    if note['id'] in by_id: note['wikiFileError'] = by_id[note['id']]
            return updated
    def enable_wiki(self):
        with self.lock():
            current = self.load()
            if current.get('_wikiError'): raise WikiVaultError(current['_wikiError'])
            payload = json.loads(json.dumps(current))
            for key in ('projects', 'tasks', 'notes', 'imports', 'conversations', 'trash', 'agentRuns'): payload.setdefault(key, [])
            payload['_wikiEnabled'] = True
            return self.save(payload, enable_wiki=True)
    def restore_wiki_file(self, identifier):
        with self.lock():
            previous = self._load_cached(); self.wiki.recover(previous)
            note = next((n for n in self.wiki.notes(previous) if n.get('id') == identifier), None)
            entry = previous.get('_wikiFiles', {}).get(identifier)
            if not note or not entry: raise WikiVaultError('Wiki 条目不存在')
            raw = self.wiki.read(entry['path'], missing=True)
            if raw is not None:
                try:
                    self.wiki.decode(raw, identifier)
                except WikiVaultError: pass
                else: raise WikiVaultError('文件仍可读取，请刷新并审阅外部修改，无需恢复缓存')
                recovery = self.directory/'recovery'/('wiki-'+str(identifier)+'-'+self.wiki.digest(raw)+'.md')
                if recovery.is_symlink() or recovery.parent.is_symlink(): raise WikiVaultError('恢复目录不可用')
                self.atomic_write(recovery, raw)
            payload = json.loads(json.dumps(previous))
            # Force a journaled repair from the cached approved version. The
            # original invalid bytes remain in the recovery directory.
            basis = json.loads(json.dumps(previous))
            basis['_wikiFiles'][identifier]['hash'] = self.wiki.digest(raw) if raw is not None else None
            payload['_revision'] = int(previous.get('_revision', 0)) + 1
            def publish(snapshot):
                self.wiki.publish(basis, snapshot, force_ids=(identifier,)); self._mirror(snapshot)
            try: self.sync.capture(payload, before_commit=publish)
            finally:
                self.wiki.recover(self._load_cached())
            return {'ok': True}
    def _mirror(self, snapshot):
        self.atomic_write(self.path, json.dumps(snapshot, ensure_ascii=False, separators=(',', ':')).encode())
    def _backup_legacy(self):
        destination = self.directory / 'workspace.pre-sqlite.json'
        if self.sync.snapshot() is None and self.path.exists() and not destination.exists():
            self.atomic_write(destination, self.path.read_bytes())
    def ensure_sync(self):
        with self.lock():
            current = self.load()
            for key in ('projects','tasks','notes','imports','papers','conversations','trash','agentRuns','links','attachments'): current.setdefault(key, [])
            current.setdefault('_revision', 0)
            self._backup_legacy()
            self.sync.capture(current, before_commit=self._mirror)
    @staticmethod
    def _sync_directory(path):
        descriptor=os.open(path,os.O_RDONLY)
        try: os.fsync(descriptor)
        finally: os.close(descriptor)
    def _finish_cloud_files(self, quarantine, committed):
        # The journal is durable before each rename. Missing backup + existed
        # means the rename had not happened when the process stopped.
        journal=quarantine/'journal.json'; files=self.directory/'files'
        if quarantine.is_symlink() or journal.is_symlink() or files.is_symlink():
            raise ValueError('附件恢复目录不能包含符号链接。')
        # atomic_write only creates journal scratch files in this private
        # directory; originals have validated IDs and never begin with a dot.
        for scratch in quarantine.glob('.write-*'):
            if not re.fullmatch(r'\.write-[A-Za-z0-9_-]+',scratch.name) or scratch.is_symlink() or not scratch.is_file():
                raise ValueError('无效的附件事务暂存文件。')
            scratch.unlink()
        if not journal.is_file():
            if not any(quarantine.iterdir()): quarantine.rmdir(); return
            raise ValueError('附件恢复记录缺失，已保留现场。')
        if journal.stat().st_size>1024*1024: raise ValueError('附件恢复记录过大。')
        manifest=json.loads(journal.read_text())
        if not isinstance(manifest,dict) or manifest.get('version')!=1 or not isinstance(manifest.get('entries'),list):
            raise ValueError('无效的附件恢复记录。')
        entries=manifest['entries']; seen=set()
        for entry in entries:
            name=entry.get('name') if isinstance(entry,dict) else None
            if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}(?:\.meta\.json)?',name) or name in seen or type(entry.get('existed')) is not bool:
                raise ValueError('无效的附件恢复路径。')
            seen.add(name)
            if (quarantine/name).is_symlink() or (files/name).is_symlink(): raise ValueError('附件恢复路径不能是符号链接。')
        files.mkdir(parents=True,exist_ok=True)
        for entry in reversed(entries):
            target=files/entry['name']; saved=quarantine/entry['name']
            if committed: saved.unlink(missing_ok=True)
            elif entry['existed']:
                if saved.exists(): os.replace(saved,target)
            else: target.unlink(missing_ok=True)
        self._sync_directory(files); self._sync_directory(quarantine)
        journal.unlink(); self._sync_directory(quarantine)
        quarantine.rmdir(); self._sync_directory(self.directory)
        if committed: self.sync.forget_file_transaction(quarantine.name)
    def _recover_cloud_files_locked(self):
        for quarantine in sorted(self.directory.glob('.cloud-undo-*')):
            if not re.fullmatch(r'\.cloud-undo-[A-Za-z0-9_-]+',quarantine.name): raise ValueError('无效的附件事务目录。')
            self._finish_cloud_files(quarantine,self.sync.file_transaction_committed(quarantine.name))
    def recover_cloud_files(self):
        with self.lock(): self._recover_cloud_files_locked()
    def _cloud_transaction(self, apply, blobs):
        # File undo is journaled before replacement; the matching commit marker
        # lives in the same SQLite transaction as the snapshot and sync cursor.
        self._recover_cloud_files_locked()
        previous = self.load()
        if previous.get('_wikiError'): raise WikiVaultError(previous['_wikiError'])
        undo=[]; quarantine=None; committed=False; cleanup_warning=None
        def publish_files(snapshot):
            nonlocal quarantine
            self.wiki.publish(previous, snapshot)
            hashes={}
            for item in all_imports(snapshot):
                if not item.get('blobHash'): continue
                prior=hashes.setdefault(item['id'],item['blobHash'])
                if prior!=item['blobHash']: raise ValueError('同一资料 ID 存在不同原件版本，请保留为独立资料后再同步。')
            files=self.directory/'files'
            if files.is_symlink(): raise ValueError('附件目录不能是符号链接。')
            for item in all_imports(snapshot):
                digest=item.get('blobHash')
                if not isinstance(digest,str) or not DIGEST.fullmatch(digest): continue
                source=(blobs or {}).get(digest)
                if source is None: continue
                if isinstance(source,(str,Path)):
                    source=Path(source)
                    if source.is_symlink() or not source.resolve().is_relative_to(self.directory.resolve()): raise ValueError('无效的同步下载路径。')
                    if source.stat().st_size>MAX_FILE: raise ValueError('同步附件过大。')
                    data=source.read_bytes()
                else: data=bytes(source)
                if len(data)>MAX_FILE or hashlib.sha256(data).hexdigest()!=digest: raise ValueError('同步附件校验失败。')
                path=self.file_path(item['id']); meta=path.with_suffix('.meta.json')
                if path.is_symlink() or meta.is_symlink(): raise ValueError('原件路径不能是符号链接。')
                if path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest()==digest: continue
                files.mkdir(parents=True,exist_ok=True)
                if quarantine is None:
                    quarantine=Path(tempfile.mkdtemp(prefix='.cloud-undo-',dir=self.directory))
                    self._sync_directory(self.directory)
                for target in (path,meta):
                    if any(entry['name']==target.name for entry in undo): continue
                    entry={'name':target.name,'existed':target.exists()}; undo.append(entry)
                    self.atomic_write(quarantine/'journal.json',json.dumps({'version':1,'entries':undo}).encode())
                    self._sync_directory(quarantine)
                    if entry['existed']: os.replace(target,quarantine/target.name)
                    self._sync_directory(quarantine); self._sync_directory(files)
                self.save_file(item['id'],data,item.get('name',''),item.get('mimeType','application/octet-stream'))
                self._sync_directory(files)
            return quarantine.name if quarantine else None
        try:
            result=apply(publish_files); committed=True
        except Exception:
            if quarantine is not None: self._finish_cloud_files(quarantine,False)
            self.wiki.recover(self._load_cached())
            raise
        finally:
            if committed and quarantine is not None:
                try: self._finish_cloud_files(quarantine,True)
                except (OSError,ValueError): cleanup_warning='知识库已同步，本机暂存备份将在下次启动时清理。'
        # These are regenerable projections, never the canonical transaction.
        if cleanup_warning: result['warning']=cleanup_warning
        self.wiki.recover(self._load_cached())
        try:
            if result['changed']:
                self.materialize_papers(result['snapshot']); self._mirror(result['snapshot'])
        except OSError:
            result['warning']='知识库已同步，导出目录稍后需要重新生成。'
        return result
    def apply_cloud_changes(self, changes, cursor, blobs=None):
        with self.lock():
            return self._cloud_transaction(lambda publish:self.sync.apply_changes(changes,cursor,before_commit=publish),blobs)
    def resolve_cloud_conflict(self, identifier, choice, blobs=None):
        with self.lock():
            return self._cloud_transaction(lambda publish:self.sync.resolve_conflict(identifier,choice,before_commit=publish),blobs)
    def file_path(self, file_id):
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', file_id): raise ValueError('无效的资料 ID')
        return self.directory / 'files' / file_id
    def save_file(self, file_id, data, name='', mime='application/octet-stream'):
        if len(data) > MAX_FILE: raise ValueError('单个附件不能超过 64 MB')
        path = self.file_path(file_id); self.atomic_write(path, data)
        metadata = {'name': Path(name).name, 'mimeType': mime, 'size': len(data)}
        self.atomic_write(path.with_suffix('.meta.json'), json.dumps(metadata, ensure_ascii=False).encode()); return metadata
    def migrate_files(self, payload):
        collections = [payload.get('imports', [])]
        collections.extend(entry.get('data', {}).get('imports', []) for entry in payload.get('trash', []))
        for collection in collections:
            for item in collection:
                value = item.get('dataUrl')
                if isinstance(value, str) and value.startswith('data:') and ';base64,' in value:
                    mime, encoded = value[5:].split(';base64,', 1)
                    try:
                        self.save_file(item['id'], base64.b64decode(encoded, validate=True), item.get('name', ''), item.get('mimeType') or mime); item['fileStored'] = True; item.pop('dataUrl', None)
                    except (ValueError, KeyError): pass
    @staticmethod
    def _slug(value, fallback='paper'):
        text = re.sub(r'[^\w\u4e00-\u9fff.-]+', '-', str(value or '').strip(), flags=re.UNICODE).strip('- .')
        return (text[:100] or fallback)
    @staticmethod
    def _paper_year(paper):
        raw = paper.get('year') or paper.get('publishedAt') or paper.get('date') or ''
        match = re.search(r'(19|20)\d{2}', str(raw))
        return match.group(0) if match else 'undated'
    @staticmethod
    def _paper_id(paper):
        value = paper.get('id')
        if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', value):
            raise ValueError('无效的论文 ID')
        return value
    def _paper_vault(self):
        return self.directory / 'vault' / 'research' / 'sources' / 'papers'
    def _safe_paper_path(self, candidate):
        vault = self._paper_vault()
        try: relative = candidate.relative_to(vault)
        except ValueError: raise ValueError('无效的论文资料路径')
        current = vault
        for part in relative.parts:
            current = current / part
            if current.is_symlink(): raise ValueError('论文资料路径不能包含符号链接')
        if not candidate.resolve().is_relative_to(vault.resolve()): raise ValueError('无效的论文资料路径')
        return candidate
    def _paper_directory_index(self):
        # Recognize legacy title-based folders by their persisted paper ID.
        # When previous builds already left duplicates, keep the newest record
        # in place. Never delete an older folder or a user's extra files.
        matches = {}
        for metadata_path in self._paper_vault().glob('*/*/paper.json'):
            try:
                self._safe_paper_path(metadata_path)
                metadata = json.loads(metadata_path.read_text())
                paper_id = self._paper_id(metadata)
                stamp = float(metadata.get('updatedAt') or 0)
                candidate = (stamp, str(metadata_path.parent), metadata_path.parent)
                if paper_id not in matches or candidate[:2] > matches[paper_id][:2]: matches[paper_id] = candidate
            except (ValueError, OSError, TypeError): continue
        return {paper_id: entry[2] for paper_id, entry in matches.items()}
    def paper_directory(self, paper, index=None):
        paper_id = self._paper_id(paper)
        directories = self._paper_directory_index() if index is None else index
        folder = directories.get(paper_id) or self._paper_vault() / self._paper_year(paper) / paper_id
        self._safe_paper_path(folder)
        metadata_path = self._safe_paper_path(folder / 'paper.json')
        if metadata_path.exists():
            existing = json.loads(metadata_path.read_text())
            if existing.get('id') != paper_id: raise ValueError('论文目录属于另一条文献，未覆盖原资料')
        return folder
    @staticmethod
    def _research_section_text(value):
        if value is None: return ''
        if isinstance(value, str): return value.strip()
        if isinstance(value, list): return '\n'.join('- ' + text for item in value if (text := WorkspaceStore._research_section_text(item)).strip())
        if isinstance(value, dict):
            for key in ('text', 'content', 'summary'):
                if key in value: return WorkspaceStore._research_section_text(value[key])
            return ''
        return str(value)
    @staticmethod
    def _research_paper_type(paper):
        metadata = paper.get('metadata') if isinstance(paper.get('metadata'), dict) else {}
        value = str(paper.get('paperType') or metadata.get('paperType') or '').strip().lower()
        return value if value in ('method', 'survey', 'benchmark', 'system', 'theory', 'other') else 'other'
    @staticmethod
    def _research_confidence(value):
        levels = ('high', 'medium', 'low', 'uncertain')
        if isinstance(value, str): return {'overall': value.strip().lower() if value.strip().lower() in levels else 'uncertain', 'reason': ''}
        result = dict(value) if isinstance(value, dict) else {}
        if isinstance(result.get('overall'), str):
            overall = result['overall'].strip().lower()
            result['overall'] = overall if overall in levels else 'uncertain'
            result.setdefault('reason', '')
        if 'reason' in result: result['reason'] = result['reason'].strip() if isinstance(result['reason'], str) else ''
        return result
    @staticmethod
    def _research_section_labels(paper_type):
        labels = dict(tldr='一句话概览', abstract='摘要', motivation='研究动机', methods='方法',
            derivations='公式与推导', training='损失函数与训练策略', experiments='实验', ablations='消融实验',
            relatedWork='与现有知识的关联', limitations='局限性', implications='启示', criticalAnalysis='批判性分析',
            counterArguments='反方观点', dataGaps='证据与数据缺口', reproduction='复现要点', openQuestions='待解决问题')
        overrides = {
            'method': dict(methods='核心方法', experiments='实验结果与分析'),
            'survey': dict(methods='分类体系与覆盖范围', training='文献检索与筛选策略', derivations='概念与理论基础', experiments='证据比较与覆盖分析', ablations='分类与覆盖敏感性', reproduction='文献筛选复核'),
            'benchmark': dict(methods='数据集构建与设计', training='基线训练与评测设置', derivations='指标定义与形式化', experiments='数据统计与基准结果', ablations='评测消融与敏感性', reproduction='数据与评测复现'),
            'system': dict(methods='系统架构', training='系统实现与优化', experiments='性能与可扩展性评估', ablations='组件与工程权衡', reproduction='系统部署与复现'),
            'theory': dict(methods='理论框架', derivations='定理与证明', training='假设与推导条件', experiments='理论验证与示例', ablations='假设敏感性', reproduction='证明核验与复现'),
        }
        labels.update(overrides.get(paper_type, {}))
        return labels
    def materialize_papers(self, payload):
        """Mirror complete analysis into stable, portable research folders.

        Existing folders are found by paper ID, even after title/year edits.
        New folders use ID rather than title so similarly named papers cannot
        overwrite one another. Workspace JSON remains the source of truth.
        """
        papers = payload.get('papers', [])
        if not isinstance(papers, list): return
        active = [paper for paper in papers if isinstance(paper, dict) and not paper.get('archived')]
        for paper in active: self._paper_id(paper)
        directories = self._paper_directory_index()
        for paper in active:
            title = str(paper.get('title') or paper.get('name') or 'Untitled paper').strip()
            folder = self.paper_directory(paper, directories)
            folder.mkdir(parents=True, exist_ok=True)
            directories[paper['id']] = folder
            notes = payload.get('notes') if isinstance(payload.get('notes'), list) else []
            main_notes = [note for note in notes if isinstance(note, dict) and note.get('id') == paper.get('noteId')]
            main_note = main_notes[0] if len(main_notes) == 1 else None
            manual_note = main_note if (main_note and main_note.get('userEdited') is True
                and not any(main_note.get(key) for key in ('archived', 'archivedAt', 'deleted', 'deletedAt'))
                and main_note.get('status') not in ('archived', 'deleted')
                and main_note.get('paperId') in (None, paper['id'])
                and main_note.get('projectId') == paper.get('projectId')
                and main_note.get('workspace', '科研') == paper.get('workspace', '科研')
                and isinstance(main_note.get('content'), str)) else None
            source_values = list(paper.get('sourceAttachmentIds') or []) + [paper.get('sourceAttachmentId')]
            if manual_note:
                source_values += list(manual_note.get('sourceAttachmentIds') or []) + [manual_note.get('sourceAttachmentId')]
            sources = list(dict.fromkeys(value for value in source_values if isinstance(value, str) and value))
            metadata = {
                'id': paper['id'], 'title': title,
                'authors': paper.get('authors') or [], 'year': paper.get('year'),
                'venue': paper.get('venue'), 'doi': paper.get('doi'),
                'arxivId': paper.get('arxivId') or paper.get('arxiv'),
                'url': paper.get('url'), 'workspace': paper.get('workspace', '科研'),
                'projectId': paper.get('projectId'), 'tags': paper.get('tags') or [],
                'sourceAttachmentIds': sources, 'confidence': self._research_confidence(paper.get('confidence')),
                'paperType': self._research_paper_type(paper),
                'reviewed': paper.get('reviewed') is True, 'reviewedAt': paper.get('reviewedAt'),
                'updatedAt': paper.get('updatedAt'),
            }
            sections = dict(paper.get('sections') or {}) if isinstance(paper.get('sections'), dict) else {}
            if isinstance(paper.get('structured'), dict): sections.update(paper['structured'])
            user_edits = paper.get('userEdits') if isinstance(paper.get('userEdits'), dict) else {}
            def section_value(name, aliases=()):
                base = next((sections[key] for key in (name, *aliases) if key in sections), None)
                if base is None: base = next((paper[key] for key in (name, *aliases) if key in paper), None)
                edit_name = next((key for key in (name, *aliases) if key in user_edits), None)
                return base, user_edits[edit_name] if edit_name is not None else base, edit_name
            def section(name, aliases=()):
                base, value, edit_name = section_value(name, aliases)
                text = self._research_section_text(value)
                citations = value.get('citations') if isinstance(value, dict) else None
                if citations is None and isinstance(base, dict): citations = base.get('citations')
                if edit_name is not None: text += '\n\n> 本节含人工修订；来源依据请结合修订内容复核。'
                if isinstance(value, dict) and value.get('verified') is False: text += '\n\n> 核验状态：未核验。'
                if isinstance(citations, list) and citations:
                    text += '\n\n### 来源依据\n'
                    for citation in citations:
                        if not isinstance(citation, dict): continue
                        attachment_id = citation.get('attachmentId') or citation.get('sourceAttachmentId') or (sources[0] if sources else '未注明')
                        page = f' · 第 {citation["page"]} 页' if citation.get('page') is not None else ''
                        text += f'- 来源附件：`{attachment_id}`{page}\n'
                        if citation.get('quote'): text += '\n' + '\n'.join('> ' + line for line in str(citation['quote']).splitlines()) + '\n'
                return text.strip()
            frontmatter = ['---'] + [f'{key}: {json.dumps(value if value is not None else "", ensure_ascii=False)}' for key, value in metadata.items()] + ['---', '']
            status = '已审阅' if metadata['reviewed'] else '待审阅'
            body = [f'# {title}', '', f'> 状态：{status}', '']
            aliases_by_key = dict(tldr=('summary',), motivation=('background',), methods=('method',),
                derivations=('math', 'equations'), experiments=('results',), implications=('researchImplications',), openQuestions=('questions',))
            optional = ('training', 'relatedWork', 'criticalAnalysis', 'counterArguments', 'dataGaps', 'reproduction')
            for key, heading in self._research_section_labels(metadata['paperType']).items():
                aliases = aliases_by_key.get(key, ())
                if key in optional and not self._research_section_text(section_value(key, aliases)[1]).strip(): continue
                body += [f'## {heading}', section(key, aliases) or '尚未记录。', '']
            body += ['## 来源与关联', f'- 原始资料 ID: `{", ".join(str(value) for value in sources)}`', f'- 项目 ID: `{paper.get("projectId") or "未归属"}`', '']
            if manual_note:
                # The full Markdown saved by the user is canonical, including
                # deliberate blank text. Structured AI fields remain in JSON.
                metadata.update(noteId=manual_note['id'], noteTitle=manual_note.get('title') or '',
                    userEdited=True, userEditedAt=manual_note.get('userEditedAt'),
                    noteUpdatedAt=manual_note.get('updatedAt'))
                frontmatter = ['---'] + [f'{key}: {json.dumps(value if value is not None else "", ensure_ascii=False)}' for key, value in metadata.items()] + ['---', '']
                body = [manual_note['content']]
            # Keep full structured data, citations and user edits recoverable,
            # rather than exporting just the bibliographic metadata.
            self.atomic_write(self._safe_paper_path(folder / 'note.md'), '\n'.join(frontmatter + body).encode())
            self.atomic_write(self._safe_paper_path(folder / 'paper.json'), json.dumps({**paper, **metadata}, ensure_ascii=False, indent=2).encode())
            for source_id in sources:
                try:
                    source = self.file_path(str(source_id)); meta_path = source.with_suffix('.meta.json')
                    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
                    if source.exists() and str(meta.get('mimeType', '')).lower() == 'application/pdf':
                        target = self._safe_paper_path(folder / 'source.pdf')
                        if not target.exists(): shutil.copyfile(source, target)
                        # Preserve every source revision alongside the stable
                        # compatibility copy, without overwriting either one.
                        source_folder = self._safe_paper_path(folder / 'sources'); source_folder.mkdir(exist_ok=True)
                        revision = self._safe_paper_path(source_folder / f'{source_id}.pdf')
                        if not revision.exists(): shutil.copyfile(source, revision)
                except (ValueError, OSError): continue
            self._safe_paper_path(folder / 'figures').mkdir(exist_ok=True)
    @staticmethod
    def _recovery_redact(value):
        """Recovery data must not become a second credential store."""
        sensitive = {'apikey', 'accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'bearertoken', 'sessiontoken', 'authorization', 'password', 'passwd', 'secret', 'clientsecret', 'token', 'credentials', 'credential', 'auth'}
        def is_sensitive(key):
            normalized = re.sub(r'[^a-z0-9]', '', str(key).lower())
            return normalized in sensitive or normalized.endswith(('apikey', 'accesstoken', 'refreshtoken', 'authtoken', 'password', 'clientsecret'))
        if isinstance(value, dict):
            return {key: WorkspaceStore._recovery_redact(item) for key, item in value.items() if not is_sensitive(key) and key != '_pendingLocalSave'}
        if isinstance(value, list): return [WorkspaceStore._recovery_redact(item) for item in value]
        return value
    def _recovery_files(self):
        directory = self.directory / 'recovery'
        if directory.is_symlink(): raise ValueError('恢复目录不能是符号链接')
        return [path for path in directory.glob('conflict_*.json') if re.fullmatch(r'conflict_[a-f0-9]{24}\.json', path.name) and path.is_file() and not path.is_symlink()]
    def preserve_conflict(self, payload, current_revision):
        """Called inside the store lock; never changes workspace.json or files."""
        try:
            snapshot = self._recovery_redact(payload)
            raw = json.dumps(snapshot, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
            if len(raw) > MAX_RECOVERY_SNAPSHOT_BYTES:
                return {'saved': False, 'error': '冲突稿超过备份大小限制，请从当前窗口导出本地稿。'}
            recovery_id = 'conflict_' + hashlib.sha256(raw).hexdigest()[:24]
            directory = self.directory / 'recovery'
            existing = self._recovery_files()
            destination = directory / (recovery_id + '.json')
            if destination.is_symlink(): raise ValueError('无效的恢复文件')
            if destination.is_file(): return {'saved': True, 'id': recovery_id}
            metadata = {
                'id': recovery_id, 'createdAt': int(time.time() * 1000),
                'baseRevision': int(payload.get('_revision', 0)), 'currentRevision': current_revision,
                'size': len(raw), 'counts': {key: len(snapshot.get(key, [])) for key in ('projects', 'tasks', 'notes', 'papers', 'imports', 'conversations') if isinstance(snapshot.get(key, []), list)},
            }
            metadata_bytes = json.dumps(metadata, ensure_ascii=False, separators=(',', ':')).encode()
            used_bytes = sum(path.stat().st_size + (path.with_suffix('.meta.json').stat().st_size if path.with_suffix('.meta.json').is_file() else 0) for path in existing)
            if len(existing) >= MAX_RECOVERY_SNAPSHOTS or used_bytes + len(raw) + len(metadata_bytes) > MAX_RECOVERY_TOTAL_BYTES:
                # Older drafts are user data. Never rotate or delete them just
                # to make space for a new conflict.
                return {'saved': False, 'error': '恢复备份空间已满，旧备份已保留，请从当前窗口导出本地稿。'}
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.atomic_write(destination, raw)
            self.atomic_write(destination.with_suffix('.meta.json'), metadata_bytes)
            return {'saved': True, 'id': recovery_id}
        except (OSError, ValueError, TypeError):
            return {'saved': False, 'error': '无法写入冲突备份，请从当前窗口导出本地稿。'}
    def recovery_path(self, recovery_id):
        if not re.fullmatch(r'conflict_[a-f0-9]{24}', recovery_id): raise ValueError('无效的恢复记录 ID')
        directory = self.directory / 'recovery'
        candidate = directory / (recovery_id + '.json')
        if directory.is_symlink() or candidate.is_symlink(): raise ValueError('无效的恢复路径')
        return candidate
    def list_recoveries(self):
        items = []
        for path in self._recovery_files():
            metadata_path = path.with_suffix('.meta.json')
            metadata = {}
            if metadata_path.is_file() and not metadata_path.is_symlink():
                try:
                    loaded = json.loads(metadata_path.read_text())
                    if isinstance(loaded, dict): metadata = loaded
                except (ValueError, OSError): pass
            metadata = {key: metadata.get(key) for key in ('createdAt', 'baseRevision', 'currentRevision', 'counts')}
            metadata.update({'id': path.stem, 'size': path.stat().st_size, 'downloadUrl': '/__recovery/' + path.stem})
            if not isinstance(metadata.get('createdAt'), (int, float)) or not math.isfinite(metadata['createdAt']):
                metadata['createdAt'] = int(path.stat().st_mtime * 1000)
            items.append(metadata)
        return {'items': sorted(items, key=lambda item: item['createdAt'], reverse=True), 'limits': {'snapshots': MAX_RECOVERY_SNAPSHOTS, 'snapshotBytes': MAX_RECOVERY_SNAPSHOT_BYTES, 'totalBytes': MAX_RECOVERY_TOTAL_BYTES}}
    def save(self, payload, enable_wiki=False):
        if not isinstance(payload, dict): raise ValueError('工作站数据格式无效')
        for key in ('projects', 'tasks', 'notes', 'imports', 'conversations', 'trash', 'agentRuns'):
            if not isinstance(payload.get(key), list): raise ValueError(f'工作站数据缺少有效的 {key}')
        with self.lock():
            current, revision = self.load(), 0
            if current.get('_wikiError'):
                recovery = self.preserve_conflict(payload, current.get('_revision', 0))
                raise ConflictError(current['_wikiError'], current.get('_revision', 0), recovery)
            revision = int(current.get('_revision', 0))
            merged = False
            if int(payload.get('_revision', 0)) != revision:
                base = self.sync.snapshot_at(int(payload.get('_revision',0))) if self.sync.path.exists() else None
                try:
                    if base is None: raise MergeConflict(['_revision'], '缺少旧版本基线。')
                    payload = merge_local_snapshot(base,payload,current); merged = True
                except (MergeConflict,ValueError):
                    recovery = self.preserve_conflict(payload, revision)
                    raise ConflictError('同一内容在另一窗口或设备上也被修改。当前修改已保留，请比较版本后继续。', revision, recovery)
            self.migrate_files(payload); self.materialize_papers(payload); payload.pop('_apiKey', None); payload.pop('_pendingLocalSave', None); payload['_revision'] = revision + 1; payload['_savedAt'] = int(time.time() * 1000)
            if self.path.exists(): self.atomic_write(self.directory / 'workspace.previous.json', self.path.read_bytes())
            self._backup_legacy()
            payload['_wikiEnabled'] = bool(current.get('_wikiEnabled') or enable_wiki)
            payload.pop('_wikiError', None)
            payload.pop('_wikiErrors', None)
            for note in self.wiki.notes(payload): note.pop('wikiFileError', None)
            def publish(snapshot):
                self.wiki.publish(current, snapshot)
                self._mirror(snapshot)
            try:
                self.sync.capture(payload, before_commit=publish)
            except Exception:
                self.wiki.recover(self._load_cached())
                try: self._mirror(self._load_cached())
                except OSError: pass
                raise
            self.wiki.recover(self._load_cached())
            return {'ok': True, 'revision': payload['_revision'], 'savedAt': payload['_savedAt'], **({'mergedSnapshot': self.load()} if merged else {})}
    @staticmethod
    def _purge_references(payload, candidates):
        references = set()
        pending = [(payload, 0, '')]
        visited = 0
        while pending:
            value, depth, field = pending.pop()
            visited += 1
            if visited > 200000 or depth > 64:
                raise TrashPurgeError('工作站引用记录过多或层级过深，本次未永久删除任何内容。')
            if isinstance(value, (dict, list)) and visited + len(pending) + len(value) > 200000:
                raise TrashPurgeError('工作站引用记录过多，本次未永久删除任何内容。')
            if isinstance(value, dict):
                pending.extend((child, depth + 1, key) for key, child in value.items())
            elif isinstance(value, list):
                pending.extend((child, depth + 1, field) for child in value)
            elif isinstance(value, str) and value in candidates:
                normalized = re.sub(r'[^a-z]', '', field.lower())
                if normalized == 'attachments' or normalized.endswith(('id', 'ids')):
                    references.add(value)
        return references
    def purge_trash(self, trash_id, revision):
        """Preserve the single-item API while using the batch transaction."""
        result = self.purge_trash_many([trash_id], revision)
        result.pop('purgedIds', None)
        return result
    def purge_trash_many(self, trash_ids, revision):
        """One CAS/capture for selected entries and their shared attachment GC."""
        if not isinstance(trash_ids, list) or not 1 <= len(trash_ids) <= 2000:
            raise TrashPurgeError('每次请选择 1 至 2000 条回收站记录。')
        trash_ids = list(trash_ids)
        if any(not isinstance(identifier, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', identifier) for identifier in trash_ids):
            raise TrashPurgeError('回收站记录 ID 无效。')
        selected_ids = set(trash_ids)
        if len(selected_ids) != len(trash_ids):
            raise TrashPurgeError('所选回收站记录 ID 重复，本次未永久删除。')
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
            raise TrashPurgeError('工作站版本无效，请刷新后重试。')
        with self.lock():
            if self.path.is_symlink() or self.path.stat().st_size > 25000000:
                raise TrashPurgeError('工作站数据路径或大小异常，本次未永久删除任何内容。')
            before = self.path.read_bytes()
            current = self.load()
            current_revision = int(current.get('_revision', 0))
            wiki_previous = json.loads(json.dumps(current))
            if revision != current_revision:
                raise ConflictError('另一窗口已更新工作站，请先同步再永久删除。', current_revision)
            trash = current.get('trash')
            if not isinstance(trash, list): raise TrashPurgeError('回收站数据无效。')
            matches = {}
            for entry in trash:
                identifier = entry.get('id') if isinstance(entry, dict) else None
                if not isinstance(identifier, str) or identifier not in selected_ids: continue
                if identifier in matches: raise TrashPurgeError('回收站记录 ID 重复，本次未永久删除。')
                matches[identifier] = entry
            if len(matches) != len(selected_ids):
                raise TrashPurgeError('部分所选回收站记录已不存在，本次未永久删除；请刷新后重试。', 404)
            candidates = set()
            import_count = 0
            for entry in matches.values():
                imports = entry.get('data', {}).get('imports', []) if isinstance(entry.get('data'), dict) else []
                if not isinstance(imports, list) or len(imports) > 2000:
                    raise TrashPurgeError('待清理附件数量或格式无效，请缩小选择范围。')
                import_count += len(imports)
                if import_count > 20000:
                    raise TrashPurgeError('本次关联资料超过 20000 条，请缩小选择范围；本次未永久删除。')
                for item in imports:
                    if not isinstance(item, dict) or not isinstance(item.get('id'), str): raise TrashPurgeError('回收站附件 ID 无效，本次未永久删除。')
                    self.file_path(item['id'])
                    candidates.add(item['id'])
            selected_objects = {id(entry) for entry in matches.values()}
            current['trash'] = [entry for entry in trash if id(entry) not in selected_objects]
            retained = self._purge_references(current, candidates)
            removable = candidates - retained
            current['_revision'] = current_revision + 1
            current['_savedAt'] = int(time.time() * 1000)
            current.pop('_pendingLocalSave', None)
            current.pop('_apiKey', None)
            files = self.directory / 'files'
            previous = self.directory / 'workspace.previous.json'
            if previous.is_symlink(): raise TrashPurgeError('工作站备份路径异常，本次未永久删除。')
            previous_bytes = previous.read_bytes() if previous.exists() else None
            quarantine = None
            files_fd = quarantine_fd = None
            moved = []
            previous_written = False
            workspace_written = False
            committed = False
            cleanup_warning = None
            def publish_snapshot(snapshot):
                nonlocal workspace_written
                self.wiki.publish(wiki_previous, snapshot)
                self.atomic_write(self.path, json.dumps(snapshot, ensure_ascii=False, separators=(',', ':')).encode())
                workspace_written = True
            try:
                if files.is_symlink(): raise TrashPurgeError('附件目录不能是符号链接，本次未永久删除。')
                if files.exists() and removable:
                    files_fd = os.open(files, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                    quarantine = Path(tempfile.mkdtemp(prefix='.purge-', dir=self.directory))
                    quarantine_fd = os.open(quarantine, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                    for file_id in sorted(removable):
                        for name in (file_id, file_id + '.meta.json'):
                            try: metadata = os.stat(name, dir_fd=files_fd, follow_symlinks=False)
                            except FileNotFoundError: continue
                            if not stat.S_ISREG(metadata.st_mode): raise TrashPurgeError('待清理附件不是普通文件，本次未永久删除。')
                            os.replace(name, name, src_dir_fd=files_fd, dst_dir_fd=quarantine_fd)
                            moved.append(name)
                self.atomic_write(previous, before)
                previous_written = True
                self._backup_legacy()
                self.sync.capture(current, before_commit=publish_snapshot)
                committed = True
            except Exception:
                rollback_errors = []
                try: self.wiki.recover(self._load_cached())
                except (OSError, ValueError): rollback_errors.append('Wiki Markdown')
                for name in reversed(moved):
                    try:
                        # A concurrent import must not be overwritten while
                        # restoring the original. Keep its old copy isolated.
                        try: os.stat(name, dir_fd=files_fd, follow_symlinks=False)
                        except FileNotFoundError: pass
                        else: raise OSError('Attachment changed during rollback')
                        os.replace(name, name, src_dir_fd=quarantine_fd, dst_dir_fd=files_fd)
                    except OSError: rollback_errors.append(name)
                if previous_written:
                    try:
                        if previous_bytes is None: previous.unlink(missing_ok=True)
                        else: self.atomic_write(previous, previous_bytes)
                    except OSError: rollback_errors.append('workspace.previous.json')
                if workspace_written:
                    try: self.atomic_write(self.path, before)
                    except OSError: rollback_errors.append('workspace.json')
                if rollback_errors:
                    raise TrashPurgeError('永久删除未提交，部分文件的恢复遇到冲突；副本仍保留在本地暂存目录，请勿再次永久清理。', 503)
                raise
            finally:
                if committed: self.wiki.recover(self._load_cached())
                if committed and quarantine_fd is not None:
                    for name in moved:
                        try: os.unlink(name, dir_fd=quarantine_fd)
                        except OSError: cleanup_warning = '回收站记录已永久移除，但部分附件暂存副本尚未清理。'
                if quarantine_fd is not None: os.close(quarantine_fd)
                if files_fd is not None: os.close(files_fd)
                if quarantine is not None:
                    try: quarantine.rmdir()
                    except OSError:
                        if committed: cleanup_warning = '回收站记录已永久移除，但部分附件暂存副本尚未清理。'
            result = {'ok': True, 'purgedIds': list(trash_ids), 'revision': current['_revision'], 'savedAt': current['_savedAt'], 'removedImportIds': sorted(removable), 'retainedImportIds': sorted(retained), 'retainedVault': True}
            if cleanup_warning: result['cleanupWarning'] = cleanup_warning
            return result

SERVICE_INSTANCE = secrets.token_hex(16)
STORE = WorkspaceStore(DATA_DIR)
PROJECT_JOBS = ProjectJobs(STORE, SERVICE_INSTANCE)
CODEX_BRIDGE = CodexBridge(DATA_DIR)
LOCAL_PROJECTS = LocalProjects(DATA_DIR)
LOCAL_FILE_EDITS = LocalFileEdits(LOCAL_PROJECTS)
LOCAL_COMMANDS = LocalCommands(LOCAL_PROJECTS)
_CLOUD = None
_CLOUD_LOCK = threading.Lock()
def cloud_service():
    global _CLOUD
    with _CLOUD_LOCK:
        if _CLOUD is None or _CLOUD.workspace is not STORE:
            if _CLOUD: _CLOUD.close()
            _CLOUD = CloudSync(STORE.directory, STORE.sync, STORE)
        return _CLOUD

class Handler(SimpleHTTPRequestHandler):
    def serve_asset(self, request_path, head=False):
        filename = STATIC_PATHS.get(request_path)
        if filename is None:
            self.send_error(404); return
        file_path = ASSET_DIR / filename
        if not file_path.is_file():
            self.send_error(404, 'Missing application resource'); return
        self.send_response(200)
        self.send_header('Content-Type', mimetypes.guess_type(filename)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(file_path.stat().st_size))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        if not head:
            with file_path.open('rb') as source: shutil.copyfileobj(source, self.wfile)
    def do_HEAD(self):
        # SimpleHTTPRequestHandler's default HEAD bypasses do_GET's allowlist.
        self.serve_asset(urllib.parse.urlsplit(self.path).path, head=True)
    def send_json(self, payload, status=200):
        data = json.dumps(payload, ensure_ascii=False).encode(); self.send_response(status); self.send_header('Content-Type', 'application/json; charset=utf-8'); self.send_header('Cache-Control', 'no-store'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
    def read_body(self, limit=25_000_000):
        length = int(self.headers.get('Content-Length', '0'))
        if length < 0 or length > limit: raise ValueError('上传内容过大')
        return self.rfile.read(length)
    def valid_origin(self):
        origin = self.headers.get('Origin'); return not origin or origin in (f'http://127.0.0.1:{PORT}', f'http://localhost:{PORT}')
    def valid_auth_origin(self, mutation=False):
        """Auth and generation accept only this exact loopback application."""
        try:
            if not ipaddress.ip_address(self.client_address[0]).is_loopback: return False
            port = self.server.server_port
            allowed_hosts = {f'127.0.0.1:{port}', f'localhost:{port}', f'[::1]:{port}'}
            if self.headers.get('Host') not in allowed_hosts: return False
            origin = self.headers.get('Origin')
            allowed_origins = {'http://' + host for host in allowed_hosts}
            if origin is not None and origin not in allowed_origins: return False
            if mutation and origin not in allowed_origins: return False
            if self.headers.get('Sec-Fetch-Site') in ('cross-site', 'same-site'): return False
            return True
        except (ValueError, AttributeError): return False
    def do_cloud(self, path):
        if not self.valid_auth_origin(mutation=self.command != 'GET'):
            self.send_json({'error':'仅允许当前工作站管理云同步。'},403); return
        try:
            service = cloud_service()
            if self.command == 'GET':
                if path == '/__cloud/status': result = service.status()
                elif path == '/__cloud/devices': result = service.devices()
                elif path == '/__cloud/conflicts': result = service.conflicts()
                elif path == '/__cloud/ssh': result = service.ssh.status()
                else: self.send_error(404); return
            else:
                payload=json.loads(self.read_body(16384) or b'{}')
                if not isinstance(payload,dict): raise ValueError('云同步请求格式无效。')
                if path == '/__cloud/connect':
                    STORE.ensure_sync(); result=service.connect(payload)
                elif path == '/__cloud/sync': result=service.sync_now()
                elif path == '/__cloud/settings': result=service.settings(payload)
                elif path == '/__cloud/ssh/inspect': result=service.ssh.inspect(payload)
                elif path == '/__cloud/ssh/save': result=service.ssh.save(payload)
                elif path == '/__cloud/ssh/move': result=service.ssh.move(payload)
                elif path == '/__cloud/disconnect': result=service.disconnect()
                elif path == '/__cloud/revoke': result=service.revoke(payload.get('deviceId'))
                elif path == '/__cloud/resolve': result=service.resolve(payload.get('id'),payload.get('choice'))
                else: self.send_error(404); return
            self.send_json(result)
        except CloudSyncError as error: self.send_json({'error':str(error),'code':error.code},error.status)
        except (ValueError,TypeError,KeyError): self.send_json({'error':'云同步请求或本地数据无效，请检查配置。'},400)
        except Exception: self.send_json({'error':'云同步暂时不可用，本机数据已保留。'},503)
    def do_auth(self, action):
        if not self.valid_auth_origin(mutation=self.command == 'POST'):
            self.send_json({'error': {'message': '仅允许当前工作站访问账号连接。'}}, 403); return
        try:
            if action == 'status': result = CODEX_BRIDGE.status()
            elif action == 'models': result = CODEX_BRIDGE.models()
            elif action == 'login': result = CODEX_BRIDGE.login_start()
            elif action == 'cancel': result = CODEX_BRIDGE.cancel_login()
            elif action == 'logout': result = CODEX_BRIDGE.logout()
            else: self.send_error(404); return
            self.send_json(result)
        except BridgeError as error:
            self.send_json({'error': {'message': str(error), 'code': error.code}}, error.status)
        except Exception:
            self.send_json({'error': {'message': '账号连接暂时不可用，请重试。'}}, 503)
    def do_local(self, path):
        if not self.valid_auth_origin(mutation=self.command != 'GET'):
            self.send_json({'error': '仅允许当前工作站访问本机目录。'}, 403); return
        try:
            if self.command == 'GET' and path == '/__local/roots':
                self.send_json(LOCAL_PROJECTS.roots()); return
            if self.command == 'DELETE' and path.startswith('/__local/roots/'):
                self.send_json(LOCAL_PROJECTS.disconnect(path.removeprefix('/__local/roots/'))); return
            if self.command != 'POST' or path not in ('/__local/roots', '/__local/search', '/__local/snapshot', '/__local/files', '/__local/read', '/__local/reveal', *('/__local/commands/'+action for action in ('propose','get','start','deny','cancel','forget')), *('/__local/edits/'+action for action in ('propose','get','apply','undo','dismiss'))):
                self.send_json({'error': '找不到本机目录接口。'}, 404); return
            payload = json.loads(self.read_body(25_000_000 if path == '/__local/edits/propose' else 16384) or b'{}')
            if not isinstance(payload, dict): raise LocalProjectError('本机目录请求格式无效。')
            if path == '/__local/roots':
                result = LOCAL_PROJECTS.connect_preset(payload['preset']) if 'preset' in payload else LOCAL_PROJECTS.connect(payload.get('path'))
            elif path == '/__local/commands/propose': result = LOCAL_COMMANDS.propose(payload)
            elif path.startswith('/__local/commands/'): result = LOCAL_COMMANDS.access(payload.get('id'),path.rsplit('/',1)[-1],remember=payload.get('remember') is True,automatic=payload.get('automatic') is True)
            elif path == '/__local/reveal': result = reveal_file(LOCAL_PROJECTS, STORE, payload)
            elif path == '/__local/edits/propose': result = LOCAL_FILE_EDITS.propose(payload)
            elif path.startswith('/__local/edits/'): result = LOCAL_FILE_EDITS.access(payload.get('id'),path.rsplit('/',1)[-1])
            elif path == '/__local/search': result = LOCAL_PROJECTS.search(payload.get('query', ''), payload.get('limit', 20))
            elif path == '/__local/files': result = LOCAL_PROJECTS.browse_files(payload.get('candidateId'), payload.get('path', ''), payload.get('offset', 0))
            elif path == '/__local/read': result = LOCAL_PROJECTS.read_file(payload.get('candidateId'), payload.get('path'), payload.get('offset', 0), payload.get('version'))
            else: result = LOCAL_PROJECTS.snapshot(payload.get('candidateId'))
            self.send_json(result)
        except LocalProjectError as error:
            self.send_json({'error': str(error)}, error.status)
        except (ValueError, TypeError):
            self.send_json({'error': '本机目录请求格式无效。'}, 400)
        except OSError:
            self.send_json({'error': '本机目录暂时无法读取或保存连接，请检查文件夹权限。'}, 503)
    def do_codex_respond(self):
        if not self.valid_auth_origin(mutation=True):
            self.send_json({'error': {'message': '仅允许当前工作站发起生成请求。'}}, 403); return
        try:
            request = json.loads(self.read_body() or b'{}')
            model, inputs, effort = CODEX_BRIDGE.prepare(request)
        except BridgeError as error:
            self.send_json({'error': {'message': str(error), 'code': error.code}}, error.status); return
        except (ValueError, TypeError):
            self.send_json({'error': {'message': '请求格式无效。'}}, 400); return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        self.send_header('X-Accel-Buffering', 'no')
        self.end_headers(); self.close_connection = True
        stream = CODEX_BRIDGE.respond(model, inputs, effort, web_search=True) if request.get('webSearch') is True else CODEX_BRIDGE.respond(model, inputs, effort)
        try:
            for event in stream:
                self.wfile.write(('data: ' + json.dumps(event, ensure_ascii=False) + '\n\n').encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, socket.timeout): pass
        finally: stream.close()
    def do_state_post(self):
        try: self.send_json(STORE.save(json.loads(self.read_body() or b'{}')))
        except ConflictError as exc:
            recovery_id = exc.recovery.get('id')
            self.send_json({'error': str(exc), 'code': 'state_conflict', 'currentRevision': exc.current_revision, 'recoverySaved': bool(exc.recovery.get('saved')), 'recoveryId': recovery_id, 'recoveryUrl': '/__recovery/' + recovery_id if recovery_id else None, 'recoveryError': exc.recovery.get('error')}, 409)
        except Exception as exc: self.send_json({'error': str(exc)}, 400)
    def do_trash_purge(self):
        if not self.valid_auth_origin(mutation=True):
            self.send_json({'error': '仅允许当前工作站永久清理回收站。'}, 403); return
        try:
            payload = json.loads(self.read_body(512 * 1024) or b'{}')
            if not isinstance(payload, dict): raise TrashPurgeError('永久删除请求格式无效。')
            if 'ids' in payload:
                if set(payload) - {'ids', 'revision'}: raise TrashPurgeError('永久删除请求格式无效，请只指定 ids 和 revision。')
                result = STORE.purge_trash_many(payload.get('ids'), payload.get('revision'))
            else:
                if set(payload) - {'id', 'revision'}: raise TrashPurgeError('永久删除请求格式无效，请只指定 id 和 revision。')
                result = STORE.purge_trash(payload.get('id'), payload.get('revision'))
            self.send_json(result)
        except ConflictError as error:
            self.send_json({'error': str(error), 'code': 'state_conflict', 'currentRevision': error.current_revision}, 409)
        except TrashPurgeError as error:
            self.send_json({'error': str(error)}, error.status)
        except (ValueError, TypeError):
            self.send_json({'error': '永久删除请求或数据格式无效。'}, 400)
        except Exception:
            self.send_json({'error': '永久删除未完成，已保留工作站记录；请检查本地文件权限后重试。'}, 503)
    def do_recovery_get(self, recovery_id=None):
        if not self.valid_auth_origin():
            self.send_json({'error': '仅允许当前工作站访问恢复备份。'}, 403); return
        try:
            if recovery_id is None:
                self.send_json(STORE.list_recoveries()); return
            path = STORE.recovery_path(recovery_id)
            if not path.is_file(): self.send_json({'error': '找不到恢复备份'}, 404); return
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(path.stat().st_size))
            self.send_header('Content-Disposition', f'attachment; filename="{recovery_id}.json"')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            with path.open('rb') as source: shutil.copyfileobj(source, self.wfile)
        except (BrokenPipeError, ConnectionResetError): pass
        except (ValueError, OSError): self.send_json({'error': '无法读取恢复备份'}, 400)
    def do_file_get(self, file_id):
        try:
            path = STORE.file_path(file_id)
            if not path.exists(): self.send_json({'error': '找不到附件原件'}, 404); return
            metadata_path = path.with_suffix('.meta.json'); metadata = json.loads(metadata_path.read_text()) if metadata_path.exists() else {}
            self.send_response(200); self.send_header('Content-Type', metadata.get('mimeType', 'application/octet-stream')); self.send_header('Content-Length', str(path.stat().st_size)); self.send_header('Content-Disposition', "inline; filename*=UTF-8''" + urllib.parse.quote(metadata.get('name') or file_id)); self.send_header('X-Content-Type-Options', 'nosniff'); self.end_headers()
            with path.open('rb') as handle: shutil.copyfileobj(handle, self.wfile)
        except (BrokenPipeError, ConnectionResetError): pass
        except Exception as exc: self.send_json({'error': str(exc)}, 400)
    def do_pdf_preview(self, file_id, info=False):
        """Render preserved PDF bytes for hosts without a native PDF plugin."""
        try:
            source = STORE.file_path(file_id)
            if not source.is_file(): self.send_json({'error': '找不到附件原件'}, 404); return
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query, keep_blank_values=True)
            def parameter(name, default):
                values = query.get(name, [default])
                if len(values) != 1: raise ValueError(f'{name} 参数只能指定一次')
                return values[0]
            page_value = parameter('page', '1')
            if not re.fullmatch(r'[0-9]{1,8}', page_value): raise ValueError('页码必须是从 1 开始的整数')
            page_number = int(page_value)
            scale = float(parameter('scale', '1.5'))
            if not math.isfinite(scale) or not 0.5 <= scale <= 2:
                raise ValueError('预览缩放比例必须在 0.5 到 2 之间')
            fit = parameter('fit', '0')
            if fit not in ('0', '1'): raise ValueError('fit 参数只能为 0 或 1')
            image_format = parameter('format', 'png')
            if image_format not in ('png', 'jpeg'):
                raise ValueError('预览格式只支持 png 或 jpeg')
            try: import fitz
            except ImportError:
                self.send_json({'error': 'PDF 预览组件不可用，请安装 PyMuPDF'}, 503); return
            # Serialize page rendering to avoid concurrent large pixmaps and
            # sharing the native PDF renderer between HTTP worker threads.
            with PDF_PREVIEW_LOCK:
                with fitz.open(source) as document:
                    if not document.is_pdf: raise ValueError('该附件不是 PDF 文件')
                    if document.needs_pass: raise ValueError('该 PDF 已加密，请先上传解密后的文件')
                    if document.page_count < 1: raise ValueError('PDF 没有可预览的页面')
                    if not 1 <= page_number <= document.page_count:
                        self.send_json({'error': '请求的 PDF 页码不存在'}, 404); return
                    page = document.load_page(0 if info else page_number - 1)
                    width, height = page.rect.width, page.rect.height
                    if not all(math.isfinite(value) and value > 0 for value in (width, height)):
                        raise ValueError('PDF 页面尺寸无效')
                    if info:
                        self.send_json({'pageCount': document.page_count, 'width': width, 'height': height}); return
                    # Fit the complete page into the rendering budget; never crop or
                    # discard oversized pages from scanner/export applications.
                    if fit == '1':
                        scale = min(scale, math.sqrt((MAX_PREVIEW_PIXELS - 20000) / (width * height)), 16382 / width, 16382 / height)
                    pixel_width, pixel_height = math.ceil(width * scale), math.ceil(height * scale)
                    if pixel_width * pixel_height > MAX_PREVIEW_PIXELS or max(pixel_width, pixel_height) > 16384:
                        raise ValueError('PDF 页面尺寸过大，请降低缩放比例后重试')
                    pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csRGB, alpha=False)
                    image = pixmap.tobytes('jpeg', jpg_quality=85) if image_format == 'jpeg' else pixmap.tobytes('png')
                    del pixmap
            self.send_response(200)
            self.send_header('Content-Type', f'image/{image_format}')
            self.send_header('Content-Length', str(len(image)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers(); self.wfile.write(image)
        except (BrokenPipeError, ConnectionResetError): pass
        except Exception as exc:
            # Native renderer exceptions can contain the private storage path.
            # Expose actionable document errors, never raw filesystem details.
            detail = str(exc)
            safe = {'页码必须是从 1 开始的整数', '预览缩放比例必须在 0.5 到 2 之间', 'fit 参数只能为 0 或 1',
                    '预览格式只支持 png 或 jpeg', '该附件不是 PDF 文件', '该 PDF 已加密，请先上传解密后的文件',
                    'PDF 没有可预览的页面', 'PDF 页面尺寸无效', 'PDF 页面尺寸过大，请降低缩放比例后重试'}
            if detail not in safe and not re.fullmatch(r'(page|scale|fit|format) 参数只能指定一次', detail):
                detail = '文件可能损坏或尚未完整下载，请重新添加完整的 PDF 原件'
            self.send_json({'error': f'无法预览 PDF：{detail}'}, 400)
    def do_fetch(self):
        if not self.valid_auth_origin(mutation=True):
            self.send_json({'error': '仅允许当前工作站下载链接资料。', 'code': 'INVALID_ORIGIN'}, 403); return
        try:
            request = json.loads(self.read_body(32768) or b'{}')
            if not isinstance(request, dict) or ('native' in request and not isinstance(request['native'], bool)):
                raise PublicFetchError('链接请求格式无效。', 'INVALID_REQUEST', 400)
            fetched = fetch_public_url(request.get('url'), max_bytes=MAX_FILE, user_agent='AI-Workstation/' + VERSION)
            raw, mime = fetched['raw'], fetched['mimeType']
            result = {key: fetched[key] for key in ('name', 'url', 'finalUrl', 'mimeType', 'size')}
            result.update({'content': '', 'pages': [], 'parser': 'web-original', 'truncated': False})
            if mime == 'application/pdf' and not request.get('native', False):
                pages, text, warning = [], '', ''
                executable = shutil.which('pdftotext', path=os.environ.get('PATH', '') + ':/opt/homebrew/bin:/usr/local/bin')
                with tempfile.NamedTemporaryFile(suffix='.pdf') as handle:
                    handle.write(raw); handle.flush()
                    if executable:
                        try:
                            parsed_pdf = subprocess.run([executable, '-layout', handle.name, '-'], capture_output=True, text=True, timeout=60)
                            chunks = parsed_pdf.stdout.split('\f') if parsed_pdf.returncode == 0 else []
                            if parsed_pdf.returncode != 0: warning = '文字索引未完成，已保留完整 PDF 原件。'
                            pages = [{'page': i + 1, 'text': c.strip()[:12000]} for i, c in enumerate(chunks) if c.strip()]
                            text = '\n\n'.join(f'[第 {p["page"]} 页]\n{p["text"]}' for p in pages)
                            result['truncated'] = len(text) > 60000 or len(pages) > 500 or any(len(c.strip()) > 12000 for c in chunks)
                        except (subprocess.TimeoutExpired, OSError): warning = '文字索引未完成，已保留完整 PDF 原件。'
                    else: warning = '未安装 pdftotext，原始 PDF 仍会保留。'
                result.update({'content': text[:60000], 'pages': pages[:500], 'parser': 'web-pdf', 'rawBase64': base64.b64encode(raw).decode(), 'warning': warning})
            elif mime.startswith('text/') or mime in ('application/xhtml+xml', 'application/json', 'application/xml'):
                try: source = raw.decode(fetched['charset'], 'replace')
                except LookupError: source = raw.decode('utf-8', 'replace')
                if mime in ('text/html', 'application/xhtml+xml'):
                    title = re.search(r'<title[^>]*>(.*?)</title>', source, re.I | re.S)
                    text = re.sub(r'<(script|style|noscript)[^>]*>[\s\S]*?</\1>', ' ', source, flags=re.I)
                    text = re.sub(r'<(?:/p|/div|br|/h[1-6])[^>]*>', '\n', text, flags=re.I)
                    text = html.unescape(re.sub(r'<[^>]+>', ' ', text))
                    text = '\n'.join(re.sub(r'\s+', ' ', line).strip() for line in text.splitlines() if line.strip())
                    if title: result['name'] = html.unescape(re.sub(r'<[^>]+>', '', title[1])).strip()[:180] or result['name']
                else: text = source
                mindnote = extract_feishu_mindnote(source, fetched['url']) if mime in ('text/html', 'application/xhtml+xml') else None
                if mindnote:
                    text = mindnote['content']
                    result.update(mindnote)
                result.update({'content': text[:60000], 'parser': 'feishu-mindnote' if mindnote else 'web', 'truncated': len(text) > 60000})
            # The original is independent of workspace records. The caller
            # commits this generated ID only after its own scope checks pass.
            identifier = 'att_' + secrets.token_hex(16)
            with STORE.lock():
                try: STORE.save_file(identifier, raw, result['name'], mime)
                except Exception:
                    for path in (STORE.file_path(identifier), STORE.file_path(identifier).with_suffix('.meta.json')):
                        try: path.unlink(missing_ok=True)
                        except OSError: pass
                    raise PublicFetchError('原件未能完整保存，请检查本地磁盘后重试。', 'STORE_FAILED', 503) from None
            result.update({'id': identifier, 'storedLocally': True, 'fileStored': True})
            self.send_json(result)
        except PublicFetchError as exc: self.send_json({'error': str(exc), 'code': exc.code}, exc.status)
        except (ValueError, TypeError): self.send_json({'error': '链接请求格式无效。', 'code': 'INVALID_REQUEST'}, 400)
        except (BrokenPipeError, ConnectionResetError): pass
        except Exception: self.send_json({'error': '链接读取未完成，请稍后重试。', 'code': 'FETCH_FAILED'}, 502)
    def do_paper(self, paper_id, action):
        try:
            state = STORE.load(); paper = next((p for p in state.get('papers', []) if p.get('id') == paper_id), None)
            if not paper: self.send_json({'error': '找不到论文'}, 404); return
            ids = paper.get('sourceAttachmentIds') or ([paper.get('sourceAttachmentId')] if paper.get('sourceAttachmentId') else []); source_id = next((sid for sid in ids if STORE.file_path(str(sid)).exists()), None)
            if not source_id: self.send_json({'error': '论文没有可用的本地 PDF 来源'}, 422); return
            source = STORE.file_path(str(source_id)); vault = STORE.paper_directory(paper); figure_dir = STORE._safe_paper_path(vault / 'figures'); figure_dir.mkdir(parents=True, exist_ok=True)
            if action == 'figures':
                figures = []
                try:
                    import fitz; doc = fitz.open(source); count = 0
                    for page_no, page in enumerate(doc, 1):
                        for image in page.get_images(full=True):
                            if count >= 40: break
                            data = doc.extract_image(image[0]); filename = f'page-{page_no}-figure-{count + 1}.{data.get("ext", "png")}'; (figure_dir / filename).write_bytes(data['image']); figures.append({'name': filename, 'label': f'第 {page_no} 页图表 {count + 1}', 'page': page_no, 'url': f'/__papers/{urllib.parse.quote(paper_id)}/figures/{urllib.parse.quote(filename)}'}); count += 1
                except Exception as exc: self.send_json({'figures': [], 'warning': f'图表提取不可用：{exc}'}); return
                self.send_json({'figures': figures, 'warning': '' if figures else '未发现嵌入式图表；扫描版或矢量图需要视觉模型解析。'}); return
            if action == 'bundle':
                import io; payload = io.BytesIO()
                with ZipFile(payload, 'w') as archive:
                    if vault.exists():
                        for path in vault.rglob('*'):
                            if path.is_file() and not path.is_symlink() and path.name not in ('paper.json', 'source.pdf') and path.resolve().is_relative_to(vault.resolve()): archive.write(path, path.relative_to(vault))
                    archive.writestr('paper.json', json.dumps(paper, ensure_ascii=False, indent=2)); archive.writestr('source.pdf', source.read_bytes())
                data = payload.getvalue(); self.send_response(200); self.send_header('Content-Type', 'application/zip'); self.send_header('Content-Length', str(len(data))); self.send_header('Content-Disposition', 'attachment; filename="research-bundle.zip"'); self.end_headers(); self.wfile.write(data)
        except Exception as exc: self.send_json({'error': str(exc)}, 422)
    def do_paper_figure(self, paper_id, filename):
        try:
            if not filename or filename in ('.', '..') or Path(filename).name != filename or '\\' in filename:
                self.send_json({'error': '无效的图表文件名'}, 400); return
            paper = next((entry for entry in STORE.load().get('papers', []) if entry.get('id') == paper_id), None)
            if paper is None:
                self.send_json({'error': '找不到论文'}, 404); return
            vault = (STORE.directory / 'vault' / 'research' / 'sources' / 'papers').resolve()
            paper_directory = STORE.paper_directory(paper)
            figures = paper_directory / 'figures'
            candidate = figures / filename
            # Identical extraction filenames occur in different papers. Scope
            # lookup to this paper and reject links escaping its own directory.
            if not paper_directory.resolve().is_relative_to(vault) or paper_directory.is_symlink() or figures.is_symlink() or candidate.is_symlink() or not candidate.resolve().is_relative_to(figures.resolve()):
                self.send_json({'error': '无效的图表路径'}, 400); return
            if not candidate.is_file():
                self.send_json({'error': '找不到图表'}, 404); return
            self.send_response(200)
            self.send_header('Content-Type', mimetypes.guess_type(filename)[0] or 'application/octet-stream')
            self.send_header('Content-Length', str(candidate.stat().st_size))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            with candidate.open('rb') as source: shutil.copyfileobj(source, self.wfile)
        except (BrokenPipeError, ConnectionResetError): pass
        except Exception: self.send_json({'error': '无法读取论文图表'}, 400)
    def do_parse(self):
        name = urllib.parse.unquote(self.headers.get('X-Filename', 'upload.bin')); suffix = Path(name).suffix.lower()
        try:
            data, text, pages, warning = self.read_body(MAX_FILE), '', [], ''
            if suffix == '.pdf':
                executable = shutil.which('pdftotext', path=os.environ.get('PATH', '') + ':/opt/homebrew/bin:/usr/local/bin')
                if not executable: warning = '未安装 PDF 文本解析器；原始 PDF 已保留，可预览或交给支持文件的模型读取。'
                else:
                    with tempfile.NamedTemporaryFile(suffix='.pdf') as handle:
                        handle.write(data); handle.flush(); parsed = subprocess.run([executable, '-layout', handle.name, '-'], capture_output=True, text=True, timeout=60)
                    if parsed.returncode: warning = 'PDF 可能已加密或无法提取文本；原始文件仍然保留。'
                    else:
                        chunks = parsed.stdout.split('\f'); pages = [{'page': index + 1, 'text': chunk.strip()[:12000]} for index, chunk in enumerate(chunks) if chunk.strip()]; text = '\n\n'.join(f"[第 {p['page']} 页]\n{p['text']}" for p in pages)
                        if not text.strip(): warning = '这是扫描版 PDF，需要支持视觉的模型读取。'
            elif suffix in ('.docx', '.pptx', '.xlsx'):
                import io
                with ZipFile(io.BytesIO(data)) as archive:
                    if sum(info.file_size for info in archive.infolist()) > 160_000_000: raise ValueError('Office 文件解压后过大')
                    if suffix == '.docx':
                        root = ET.fromstring(archive.read('word/document.xml')); ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}; text = '\n'.join(''.join(t.text or '' for t in p.findall('.//w:t', ns)) for p in root.findall('.//w:p', ns))
                    elif suffix == '.pptx':
                        slides = sorted((n for n in archive.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml', n)), key=lambda n: int(re.search(r'(\d+)\.xml', n)[1]))
                        for index, filename in enumerate(slides, 1):
                            root = ET.fromstring(archive.read(filename)); pages.append({'page': index, 'text': ' '.join(x.text for x in root.iter() if x.tag.endswith('}t') and x.text)})
                        text = '\n\n'.join(f"[幻灯片 {p['page']}]\n{p['text']}" for p in pages)
                    else:
                        # Keep spreadsheet parsing dependency-free. This is a
                        # lightweight text view for planning and search; the
                        # original workbook is still retained for preview or
                        # download.
                        shared = []
                        if 'xl/sharedStrings.xml' in archive.namelist():
                            root = ET.fromstring(archive.read('xl/sharedStrings.xml'))
                            shared = [''.join(x.text or '' for x in si.iter() if x.tag.endswith('}t')) for si in root if si.tag.endswith('}si')]
                        sheets = sorted((n for n in archive.namelist() if re.fullmatch(r'xl/worksheets/sheet\d+\.xml', n)), key=lambda n: int(re.search(r'(\d+)\.xml', n)[1]))
                        for index, filename in enumerate(sheets, 1):
                            root = ET.fromstring(archive.read(filename)); rows = []
                            for row in (x for x in root.iter() if x.tag.endswith('}row')):
                                values = []
                                for cell in (x for x in row if x.tag.endswith('}c')):
                                    value = next((x.text for x in cell if x.tag.endswith('}v')), '') or ''
                                    if cell.attrib.get('t') == 's' and value.isdigit() and int(value) < len(shared): value = shared[int(value)]
                                    values.append(value)
                                if values: rows.append(' | '.join(values))
                            page_text = '\n'.join(rows)
                            if page_text.strip(): pages.append({'page': index, 'text': page_text[:12000]})
                        text = '\n\n'.join(f"[工作表 {p['page']}]\n{p['text']}" for p in pages)
            elif suffix in ('.png', '.jpg', '.jpeg', '.webp', '.gif'): warning = '图片原件已保留，支持视觉的模型可直接读取。'
            elif suffix in ('.txt', '.md', '.csv', '.json', '.log', '.html', '.yaml', '.yml', '.toml'): text = data.decode('utf-8-sig', 'replace')
            else: warning = '该格式已保存原件。旧版 PPT/DOC 请另存为 PPTX/DOCX 后再解析。'
            self.send_json({'name': name, 'content': text[:60000], 'pages': pages[:500], 'parser': 'local', 'warning': warning})
        except Exception as exc: self.send_json({'error': str(exc)}, 422)
    def proxy(self, method):
        if not self.valid_auth_origin(mutation=method == 'POST'):
            self.send_json({'error': {'message': '仅允许当前工作站访问 API 代理。'}}, 403); return
        raw = self.headers.get('X-Target-URL') or urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get('url', [''])[0]
        try:
            target = urllib.parse.urlsplit(raw)
            if target.scheme not in ('http', 'https') or not target.hostname or target.username or target.password or not target.port and target.netloc.endswith(':'): raise ValueError()
        except ValueError:
            self.send_json({'error': {'message': 'API 地址无效，请使用不含账号密码的 HTTP(S) 服务地址。'}}, 400); return
        headers_sent = False; event_stream = False
        finished = threading.Event(); disconnected = threading.Event(); sockets = []; sockets_lock = threading.Lock(); watcher = None
        def shutdown(upstream):
            try: upstream.shutdown(socket.SHUT_RDWR)
            except OSError: pass
        def connected(upstream):
            with sockets_lock: sockets.append(upstream)
            if disconnected.is_set(): shutdown(upstream); raise ConnectionAbortedError('client disconnected')
        def watch_client():
            # Waiting for a token or response headers may last indefinitely.
            # Observe the local socket, not a generation deadline, to interrupt
            # the upstream read when the user presses Stop/closes the request.
            while not finished.wait(0.1):
                try:
                    ready, _, _ = select.select([self.connection], [], [], 0)
                    gone = bool(ready) and not self.connection.recv(1, socket.MSG_PEEK)
                except OSError: gone = True
                if gone:
                    disconnected.set()
                    with sockets_lock: upstreams = list(sockets)
                    for upstream in upstreams: shutdown(upstream)
                    return
        def stream_failure():
            self.close_connection = True
            if event_stream and not disconnected.is_set():
                event = {'type': 'error', 'error': {'code': 'UPSTREAM_STREAM_INTERRUPTED', 'message': '上游 API 连接中断，未能确认完整响应。本次未执行操作，请重试。'}}
                try: self.wfile.write(('data: ' + json.dumps(event, ensure_ascii=False) + '\n\n').encode()); self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError): pass
        try:
            body = self.read_body(MAX_FILE) if method == 'POST' else None; request = urllib.request.Request(raw, data=body, method=method)
            for name in ('Authorization', 'Content-Type', 'Accept'):
                if self.headers.get(name): request.add_header(name, self.headers[name])
            watcher = threading.Thread(target=watch_client, daemon=True); watcher.start()
            with proxy_opener(connected).open(request, timeout=PROXY_CONNECT_TIMEOUT) as response:
                content_type = response.headers.get('Content-Type', 'application/json'); event_stream = 'text/event-stream' in content_type.lower()
                self.send_response(response.status); self.send_header('Content-Type', content_type); self.send_header('Cache-Control', 'no-store'); self.send_header('Connection', 'close'); self.close_connection = True; self.end_headers(); headers_sent = True
                while True:
                    chunk = response.read1(8192)
                    if not chunk: break
                    self.wfile.write(chunk); self.wfile.flush()
        except HTTPError as exc:
            if headers_sent: stream_failure()
            elif not disconnected.is_set():
                try:
                    data = exc.read(1_000_001)
                    if len(data) > 1_000_000: data = json.dumps({'error': {'message': f'API 返回 HTTP {exc.code}，错误详情过长，请检查服务状态。'}}).encode()
                    self.send_response(exc.code); self.send_header('Content-Type', exc.headers.get('Content-Type', 'application/json')); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError, OSError): self.close_connection = True
                finally: exc.close()
        except (BrokenPipeError, ConnectionResetError): pass
        except Exception as exc:
            if headers_sent: stream_failure()
            elif not disconnected.is_set():
                message = str(exc) if isinstance(exc, ValueError) else '连接 API 服务失败。请检查服务地址、网络和 TLS 配置；连接握手有等待限制，模型生成没有自动截止时间。'
                try: self.send_json({'error': {'message': message}}, 502)
                except (BrokenPipeError, ConnectionResetError, OSError): pass
        finally:
            finished.set()
            with sockets_lock: upstreams = list(sockets)
            for upstream in upstreams: shutdown(upstream)
            if watcher: watcher.join(0.3)
    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == '/__health': self.send_json({'app': 'ai-workstation', 'version': VERSION, 'assetFingerprint': ASSET_FINGERPRINT, 'port': self.server.server_port, 'instanceId': SERVICE_INSTANCE})
        elif path.startswith('/__cloud/'): self.do_cloud(path)
        elif path.startswith('/__local/'): self.do_local(path)
        elif path in ('/__auth/status', '/__auth/models'): self.do_auth(path.rsplit('/', 1)[1])
        elif path == '/__recovery': self.do_recovery_get()
        elif path.startswith('/__recovery/'): self.do_recovery_get(urllib.parse.unquote(path.removeprefix('/__recovery/')))
        elif path == '/__wiki/migration':
            try:self.send_json(WikiMigration(STORE).preview())
            except Exception as exc:self.send_json({'error':str(exc)},400)
        elif path == '/__project/jobs':
            try: self.send_json({'jobs':PROJECT_JOBS.list()})
            except Exception as exc:self.send_json({'error':str(exc)},400)
        elif path == '/__state':
            try: self.send_json(STORE.load())
            except Exception as exc: self.send_json({'error': str(exc)}, 500)
        elif path == '/__proxy': self.proxy('GET')
        elif path.startswith('/__files/'):
            file_parts = path.removeprefix('/__files/').split('/')
            if len(file_parts) == 2 and file_parts[1] in ('preview', 'preview-info'):
                self.do_pdf_preview(urllib.parse.unquote(file_parts[0]), info=file_parts[1] == 'preview-info')
            else: self.do_file_get(path.removeprefix('/__files/'))
        elif path.startswith('/__papers/'):
            parts = path.split('/'); paper_id = urllib.parse.unquote(parts[2]) if len(parts) > 2 else ''; action = parts[3] if len(parts) > 3 else ''
            if action == 'figures' and len(parts) > 4:
                if len(parts) == 5: self.do_paper_figure(paper_id, urllib.parse.unquote(parts[4]))
                else: self.send_json({'error': '无效的图表路径'}, 400)
            else: self.do_paper(paper_id, action)
        elif path in STATIC_PATHS: self.serve_asset(path)
        else: self.send_error(404)
    def do_POST(self):
        auth_path = urllib.parse.urlsplit(self.path).path
        if auth_path.startswith('/__cloud/'):
            self.do_cloud(auth_path); return
        if auth_path == '/__trash/purge':
            self.do_trash_purge(); return
        if auth_path.startswith('/__local/'):
            self.do_local(auth_path); return
        if auth_path in ('/__auth/login', '/__auth/cancel', '/__auth/logout'):
            self.do_auth(auth_path.rsplit('/', 1)[1]); return
        if auth_path == '/__codex/respond':
            self.do_codex_respond(); return
        if auth_path == '/__proxy':
            self.proxy('POST'); return
        if not self.valid_origin(): self.send_json({'error': '不允许来自其他网站的写入请求'}, 403); return
        path = urllib.parse.urlsplit(self.path).path
        if path == '/__state': self.do_state_post()
        elif path.startswith('/__project/jobs/'):
            try:
                body=json.loads(self.read_body() or b'{}');action=path.rsplit('/',1)[-1]
                if action=='upsert': result=PROJECT_JOBS.upsert(body)
                elif action=='claim': result=PROJECT_JOBS.claim(body.get('id'))
                elif action=='check': result=PROJECT_JOBS.check(body.get('id'),body.get('token'))
                elif action=='finish': result=PROJECT_JOBS.finish(body.get('id'),body.get('token'),body.get('runId'),body.get('error'))
                else: result=PROJECT_JOBS.change(body.get('id'),action)
                self.send_json(result)
            except Exception as exc:self.send_json({'error':str(exc)},400)
        elif path == '/__wiki/bundle-preview':
            try:self.send_json(WikiBundle(STORE).preview(json.loads(self.read_body() or b'{}').get('ids')))
            except Exception as exc:self.send_json({'error':str(exc)},400)
        elif path == '/__wiki/bundle':
            try:
                raw=WikiBundle(STORE).build(json.loads(self.read_body() or b'{}'))
                self.send_response(200);self.send_header('Content-Type','application/zip');self.send_header('Content-Disposition','attachment; filename="research-wiki.zip"');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
            except Exception as exc:self.send_json({'error':str(exc)},400)
        elif path in ('/__wiki/migrate','/__wiki/import-markdown'):
            try:
                body=json.loads(self.read_body(110*1024*1024) or b'{}');migration=WikiMigration(STORE)
                self.send_json(migration.adopt(body) if path.endswith('/migrate') else migration.import_markdown(body))
            except Exception as exc:self.send_json({'error':str(exc)},400)
        elif path == '/__wiki/enable':
            try: self.send_json(STORE.enable_wiki())
            except Exception as exc: self.send_json({'error': str(exc)}, 400)
        elif path == '/__wiki/restore':
            try: self.send_json(STORE.restore_wiki_file(json.loads(self.read_body() or b'{}').get('id')))
            except Exception as exc: self.send_json({'error': str(exc)}, 400)
        elif path == '/__parse': self.do_parse()
        elif path == '/__fetch': self.do_fetch()
        elif path.startswith('/__papers/'):
            parts = path.split('/'); self.do_paper(urllib.parse.unquote(parts[2]) if len(parts) > 2 else '', parts[3] if len(parts) > 3 else '')
        elif path.startswith('/__files/'):
            try:
                body = self.read_body(MAX_FILE)
                with STORE.lock(): result = STORE.save_file(path.removeprefix('/__files/'), body, urllib.parse.unquote(self.headers.get('X-Filename', '')), self.headers.get('Content-Type', 'application/octet-stream'))
                self.send_json(result)
            except Exception as exc: self.send_json({'error': str(exc)}, 400)
        else: self.send_error(405)

    def do_DELETE(self):
        local_path = urllib.parse.urlsplit(self.path).path
        if local_path.startswith('/__local/'):
            self.do_local(local_path); return
        if not self.valid_origin():
            self.send_json({'error': '不允许来自其他网站的写入请求'}, 403); return
        path = urllib.parse.urlsplit(self.path).path
        if not path.startswith('/__files/'):
            self.send_error(405); return
        try:
            with STORE.lock():
                file_id = path.removeprefix('/__files/')
                file_path = STORE.file_path(file_id)
                metadata_path = file_path.with_suffix('.meta.json')
                file_path.unlink(missing_ok=True); metadata_path.unlink(missing_ok=True)
            self.send_json({'ok': True})
        except Exception as exc:
            self.send_json({'error': str(exc)}, 400)

if __name__ == '__main__':
    http_server = LoopbackHTTPServer(('127.0.0.1', PORT), Handler)
    PORT = http_server.server_port
    if os.environ.get('AI_WORKSTATION_PARENT_PIPE') == '1':
        # The native owner retains the write end. EOF also covers abrupt app
        # exit, when applicationWillTerminate cannot run. CLI servers opt out.
        def owner_lifetime():
            try:
                while os.read(0, 1): pass
            finally: http_server.shutdown()
        threading.Thread(target=owner_lifetime,daemon=True).start()
    print(f'AI Workstation {VERSION}: http://127.0.0.1:{PORT}', flush=True)
    try: http_server.serve_forever()
    finally: http_server.server_close()
