#!/usr/bin/env python3
"""Loopback service for the workstation's durable store, files and AI requests."""
import base64, errno, fcntl, hashlib, html, http.client, ipaddress, json, math, mimetypes, os, queue, re, secrets, select, shutil, socket, ssl, stat, subprocess, tempfile, threading, time, unicodedata, urllib.parse, urllib.request
from contextlib import contextmanager
from collections import OrderedDict
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from socketserver import TCPServer
from urllib.error import HTTPError, URLError
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile
from codex_bridge import BridgeError, CodexBridge
from claude_bridge import ClaudeBridge, BridgeError as ClaudeBridgeError, MAX_LINE as CLAUDE_MAX_PROMPT
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
from comparison_drafts import ComparisonDraftStore, DraftError, MAX_BYTES as MAX_COMPARISON_DRAFT_BYTES
from note_drafts import NoteDraftStore, MAX_BYTES as MAX_NOTE_DRAFT_BYTES, decode_json as decode_note_draft_json
from local_document_drafts import LocalDocumentDraftStore
from document_media import DocumentMedia, MediaError, MAX_UPLOAD_BODY as MAX_IMAGE_UPLOAD_BODY
from local_document_media import LocalDocumentMedia
from public_url_fetch import PublicFetchError, fetch_public_url, extract_feishu_mindnote
import bookmark_fetch
import bookmark_metadata
from external_notifications import ExternalNotifications, handle_request as handle_external_notifications

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
MAX_PDF_TEXT_WORDS = 5000
MAX_PDF_TEXT_BYTES = 256 * 1024
MAX_PDF_TEXT_RESPONSE_BYTES = 1024 * 1024
MAX_PDF_SEARCH_MATCHES = 200
MAX_PDF_SEARCH_RECTS = 256
MAX_PDF_SEARCH_RESPONSE_BYTES = 1024 * 1024
MAX_PDF_READ_TEXT_CHARS = 12000
MAX_PDF_INDEX_BATCH_CHARS = 100000
MAX_PDF_INDEX_BATCH_PAGES = 10
PDF_PREVIEW_LOCK = threading.Lock()

class PDFResponseCache:
    """Bounded, short-lived response bytes; never retains MuPDF objects or sources."""
    def __init__(self, max_bytes=16 * 1024 * 1024, max_entries=128,
                 max_item_bytes=2 * 1024 * 1024, idle_seconds=45, clock=time.monotonic):
        self.max_bytes, self.max_entries = max_bytes, max_entries
        self.max_item_bytes, self.idle_seconds, self.clock = max_item_bytes, idle_seconds, clock
        self.entries = OrderedDict()
        self.bytes = 0
        self.lock = threading.Lock()

    def _remove(self, key):
        _, body, _ = self.entries.pop(key)
        self.bytes -= len(body)

    def _expire(self, now):
        # Accesses move entries to the end, so oldest access is always first.
        while self.entries:
            key = next(iter(self.entries))
            if now - self.entries[key][2] < self.idle_seconds:
                break
            self._remove(key)

    def get(self, key):
        with self.lock:
            now = self.clock()
            self._expire(now)
            value = self.entries.get(key)
            if value is None:
                return None
            content_type, body, _ = value
            self.entries[key] = (content_type, body, now)
            self.entries.move_to_end(key)
            return content_type, body

    def put(self, key, content_type, body):
        if not isinstance(body, bytes) or not isinstance(content_type, str):
            raise TypeError('PDF cache accepts immutable response bytes only')
        with self.lock:
            now = self.clock()
            self._expire(now)
            if key in self.entries:
                self._remove(key)
            if len(body) > min(self.max_item_bytes, self.max_bytes) or self.max_entries < 1:
                return
            while self.entries and (len(self.entries) >= self.max_entries or self.bytes + len(body) > self.max_bytes):
                self._remove(next(iter(self.entries)))
            self.entries[key] = (content_type, body, now)
            self.bytes += len(body)

PDF_RESPONSE_CACHE = PDFResponseCache()
MAX_RECOVERY_SNAPSHOT_BYTES = 25_000_000
MAX_RECOVERY_SNAPSHOTS = 50
MAX_RECOVERY_TOTAL_BYTES = 250_000_000
PROXY_CONNECT_TIMEOUT = 30

def pdf_preview_text(page, fitz, for_search=False):
    """Current visible page only; points match get_pixmap with CSS top-left rotation."""
    # One TextPage keeps block/line identities identical in both representations.
    # WORDS flags exclude image payloads: this is extraction, never OCR.
    textpage = page.get_textpage(flags=fitz.TEXTFLAGS_WORDS & ~fitz.TEXT_PRESERVE_IMAGES)
    supported = set()
    for block in textpage.extractDICT().get('blocks', []):
        if block.get('type') != 0: continue
        for index, line in enumerate(block.get('lines', [])):
            direction = line.get('dir', ())
            if (line.get('wmode') == 0 and len(direction) == 2
                    and abs(direction[0] - 1) < 0.00001 and abs(direction[1]) < 0.00001):
                supported.add((block['number'], index))
    words, text_bytes, response_bytes, partial, truncated = [], 0, 0, False, False
    bounds = fitz.Rect(0, 0, page.cropbox.width, page.cropbox.height)
    rotation = page.rotation_matrix
    for sequence, (x0, y0, x1, y1, text, block, line, _) in enumerate(textpage.extractWORDS()):
        if (block, line) not in supported:
            partial = True; continue
        values = (x0, y0, x1, y1)
        if not all(math.isfinite(value) for value in values) or x1 <= x0 or y1 <= y0:
            partial = True; continue
        rect = fitz.Rect(values)
        # A clipped word cannot offer truthful whole-word selection geometry.
        if not bounds.contains(rect): partial = True; continue
        if not text: continue
        size = len(text.encode('utf-8'))
        point = rect.tl * rotation
        item = {'text': text, 'x': round(point.x, 4), 'y': round(point.y, 4),
                'width': round(rect.width, 4), 'height': round(rect.height, 4),
                'angle': page.rotation, 'line': f'{block}:{line}'}
        encoded_size = len(json.dumps(item, ensure_ascii=False).encode('utf-8')) + 2
        if (len(words) >= MAX_PDF_TEXT_WORDS or text_bytes + size > MAX_PDF_TEXT_BYTES
                or response_bytes + encoded_size > MAX_PDF_TEXT_RESPONSE_BYTES - 2048):
            truncated = True; break
        if for_search: item['_sequence'] = sequence
        words.append(item); text_bytes += size; response_bytes += encoded_size
    result = {'page': page.number + 1, 'pageCount': page.parent.page_count,
              'width': page.rect.width, 'height': page.rect.height, 'rotation': page.rotation,
              'words': words, 'truncated': truncated, 'partial': partial}
    if partial:
        result.update(code='PDF_TEXT_PARTIAL', warning='部分旋转、竖排或裁切文字无法准确对齐，已保留原图并省略其文字层。')
    if truncated:
        result.update(code='PDF_TEXT_TRUNCATED', warning='本页文字较多，选择文字层已达到上限；原图仍完整显示。')
    return result

def pdf_search_query(value):
    if (not isinstance(value, str) or len(value) > 256 or len(value.encode('utf-8')) > 2048
            or any(unicodedata.category(char) in ('Cc', 'Cs') and not char.isspace() for char in value)):
        raise ValueError('查找内容必须为 1 到 256 个字符，且不能含控制字符')
    normalized = ' '.join(unicodedata.normalize('NFKC', value).casefold().split())
    if not normalized or len(normalized) > 256:
        raise ValueError('查找内容必须为 1 到 256 个字符，且不能含控制字符')
    return normalized

def pdf_search_cjk(char):
    # Avoid inventing spaces between adjacent CJK characters / wrapped lines.
    return any(low <= ord(char) <= high for low, high in ((0x3400, 0x4dbf), (0x4e00, 0x9fff),
               (0xf900, 0xfaff), (0x20000, 0x323af), (0x3040, 0x30ff), (0xac00, 0xd7af)))

def pdf_preview_search(page, fitz, query, normalized):
    extracted = pdf_preview_text(page, fitz, for_search=True)
    words, chunks, segments, length, previous = extracted['words'], [], [], 0, None
    for index, word in enumerate(words):
        value = ' '.join(unicodedata.normalize('NFKC', word['text']).casefold().split())
        if not value: continue
        if previous is not None:
            # Never invent a phrase across omitted text or separate text blocks.
            separator = ' '
            if word['_sequence'] != previous['_sequence'] + 1 or word['line'].split(':')[0] != previous['line'].split(':')[0]:
                separator = '\0'
            elif pdf_search_cjk(previous['_normalized'][-1]) and pdf_search_cjk(value[0]):
                same_line = word['line'] == previous['line']
                same_block = word['line'].split(':')[0] == previous['line'].split(':')[0]
                angle = math.radians(word['angle'])
                gap = (word['x'] - previous['x']) * math.cos(angle) + (word['y'] - previous['y']) * math.sin(angle) - previous['width']
                if (same_line and gap <= min(word['height'], previous['height']) * 0.2) or (not same_line and same_block):
                    separator = ''
            chunks.append(separator); length += len(separator)
        chunks.append(value); segments.append((length, length + len(value), index)); length += len(value)
        previous = {**word, '_normalized': value}
    haystack, matches, cursor, response_bytes = ''.join(chunks), [], 0, 0
    truncated = extracted['truncated']
    while True:
        start = haystack.find(normalized, cursor)
        if start < 0: break
        end = start + len(normalized); cursor = end
        touched = [words[index] for left, right, index in segments if left < end and right > start]
        if not touched: continue
        if len(matches) >= MAX_PDF_SEARCH_MATCHES or len(touched) > MAX_PDF_SEARCH_RECTS:
            truncated = True; break
        hit = {'index': len(matches), 'precision': 'word',
               'rects': [{key: word[key] for key in ('x', 'y', 'width', 'height', 'angle', 'line')} for word in touched],
               'snippet': ' '.join(word['text'] for word in touched)[:160]}
        size = len(json.dumps(hit, ensure_ascii=False).encode('utf-8')) + 2
        if response_bytes + size > MAX_PDF_SEARCH_RESPONSE_BYTES - 8192:
            truncated = True; break
        matches.append(hit); response_bytes += size
    result = {key: extracted[key] for key in ('page', 'pageCount', 'width', 'height', 'rotation', 'partial')}
    result.update(query=query, normalizedQuery=normalized, matches=matches, truncated=truncated,
                  unsearchable=not bool(segments), geometry='word')
    if extracted['partial']:
        result.update(code='PDF_SEARCH_PARTIAL', warning='部分旋转、竖排或裁切文字无法准确定位，查找结果可能不完整。')
    if truncated:
        result.update(code='PDF_SEARCH_TRUNCATED', warning='本页查找已达到文字量、命中数或响应上限，结果可能不完整。')
    return result

class LoopbackHTTPServer(ThreadingHTTPServer):
    def server_bind(self):
        # HTTPServer resolves a display hostname synchronously after binding.
        # This numeric loopback service must start even when reverse DNS stalls.
        TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

class ProxyRedirectRejected(ValueError):
    """A redirect that cannot safely receive this request's authorization."""


def proxy_failure(exc, phase='connection'):
    """Return only fixed, public diagnostics; exception text may contain secrets."""
    phase = phase if phase in ('connection', 'response', 'stream') else 'connection'
    if phase == 'stream':
        return {'code': 'UPSTREAM_STREAM_INTERRUPTED', 'phase': phase,
                'message': '上游 API 连接中断，未能确认完整响应。请检查连接后重试。'}
    # urllib wraps socket/SSL failures in URLError.reason. Follow explicit
    # causes only: an unrelated exception context is not a proven root cause.
    causes, pending, seen = [], [exc], set()
    while pending and len(causes) < 16:
        current = pending.pop(0)
        if not isinstance(current, BaseException) or id(current) in seen: continue
        seen.add(id(current)); causes.append(current)
        if isinstance(current, URLError): pending.append(current.reason)
        if current.__cause__ is not None: pending.append(current.__cause__)
    if any(isinstance(item, ProxyRedirectRejected) for item in causes):
        code = 'UPSTREAM_REDIRECT_REJECTED'
        message = 'API 服务重定向到了其他来源，已停止转发。请在设置中填写最终服务地址。'
    elif any(isinstance(item, socket.gaierror) for item in causes):
        code = 'UPSTREAM_DNS_ERROR'
        message = '无法解析 API 服务地址。请检查服务地址、DNS 和网络连接。'
    elif any(isinstance(item, ssl.SSLError) for item in causes):
        code = 'UPSTREAM_TLS_ERROR'
        message = '无法建立安全的 API 连接。请检查服务证书、HTTPS 地址和本机时间。'
    elif phase == 'connection' and any(isinstance(item, (TimeoutError, socket.timeout)) or
                                     isinstance(item, OSError) and item.errno == errno.ETIMEDOUT for item in causes):
        code = 'UPSTREAM_CONNECT_TIMEOUT'
        message = '连接 API 服务超时。请检查服务地址和网络连接；模型生成没有自动截止时间。'
    elif any(isinstance(item, ConnectionRefusedError) or
             isinstance(item, OSError) and item.errno == errno.ECONNREFUSED for item in causes):
        code = 'UPSTREAM_CONNECTION_REFUSED'
        message = 'API 服务拒绝连接。请检查服务是否启动及地址、端口是否正确。'
    else:
        code = 'UPSTREAM_CONNECTION_ERROR'
        message = '连接 API 服务失败。请检查服务地址、网络连接和服务状态。'
    return {'code': code, 'phase': phase, 'message': message}


def proxy_opener(on_connected, on_connecting=None):
    """Bound connection/TLS setup only; generation reads have no deadline."""
    class HTTPConnection(http.client.HTTPConnection):
        def connect(self):
            if on_connecting: on_connecting()
            super().connect()
            self.sock.settimeout(None)
            on_connected(self.sock)
    class HTTPSConnection(http.client.HTTPSConnection):
        def connect(self):
            if on_connecting: on_connecting()
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
                raise ProxyRedirectRejected()
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
        if self.path.exists() and not destination.exists() and not self.sync.has_snapshot():
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
    def resolve_cloud_conflict(self, identifier, choice, revision=None, blobs=None):
        with self.lock():
            return self._cloud_transaction(lambda publish:self.sync.resolve_conflict(identifier,choice,revision=revision,before_commit=publish),blobs)
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
        if not active: return
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
            for filename, data in [('note.md', '\n'.join(frontmatter + body).encode()), ('paper.json', json.dumps({**paper, **metadata}, ensure_ascii=False, indent=2, sort_keys=True).encode())]:
                target = self._safe_paper_path(folder / filename)
                # Portable exports remain repairable after external changes or
                # deletion, but an unrelated autosave need not fsync every paper.
                if not target.is_file() or target.read_bytes() != data: self.atomic_write(target, data)
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
                committed = self.sync.capture(payload, before_commit=publish)
            except Exception:
                canonical = self._load_cached()
                self.wiki.recover(canonical)
                try: self._mirror(canonical)
                except OSError: pass
                raise
            # capture only returns after its FULL SQLite commit. The returned
            # snapshot includes publication mappings and is the exact recovery
            # basis; rereading and decoding the entire DB snapshot adds no check.
            self.wiki.recover(committed)
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
EXTERNAL_NOTIFICATIONS = ExternalNotifications(
    os.environ.get('AI_WORKSTATION_NOTIFICATION_DIR'),
    os.environ.get('AI_WORKSTATION_NATIVE_NOTIFICATION_TOKEN', ''))
STORE = WorkspaceStore(DATA_DIR)
COMPARISON_DRAFTS = ComparisonDraftStore(DATA_DIR, STORE.load)
NOTE_DRAFTS = NoteDraftStore(DATA_DIR, STORE.load)
PROJECT_JOBS = ProjectJobs(STORE, SERVICE_INSTANCE)
CODEX_BRIDGE = CodexBridge(DATA_DIR)
_CLAUDE = None
_CLAUDE_DIRECTORY = None
_CLAUDE_LOCK = threading.Lock()
def claude_service():
    # Lazy, app-owned empty cwd; no CLI/auth process during server startup.
    global _CLAUDE, _CLAUDE_DIRECTORY
    with _CLAUDE_LOCK:
        if _CLAUDE is None:
            DATA_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
            _CLAUDE_DIRECTORY = tempfile.TemporaryDirectory(prefix='claude-runtime-', dir=DATA_DIR)
            _CLAUDE = ClaudeBridge(_CLAUDE_DIRECTORY.name)
        return _CLAUDE

def close_claude_service():
    with _CLAUDE_LOCK:
        if _CLAUDE is not None:
            _CLAUDE.close()
        if _CLAUDE_DIRECTORY is not None:
            _CLAUDE_DIRECTORY.cleanup()

CLAUDE_ERRORS = {
    'cli_unavailable': (503, '请先安装官方 Claude Code CLI，再重新检测。'),
    'unsupported_cli': (409, '当前 Claude Code CLI 缺少必需的隔离或流式选项，请更新官方 CLI。'),
    'subscription_login_required': (401, '请先在本机官方 Claude Code 完成 Claude 账号登录。'),
    'busy': (409, 'Claude Code 操作尚未结束，请稍后重试。'),
    'duplicate_request': (409, '该 Claude 请求编号已经使用，请使用新请求编号。'),
    'request_limit': (409, '本次运行的 Claude 请求数量已达上限，请重启 AI Bro。'),
    'unknown_request': (404, '找不到此 Claude 本机请求。'),
    'login_failed': (503, 'Claude Code 登录未完成，请在官方 CLI 重试。'),
    'logout_failed': (503, '无法确认 Claude Code 已退出，请刷新状态。'),
    'auth_status_failed': (503, '无法确认 Claude Code 登录状态，请刷新后重试。'),
    'cancelled': (409, '已停止 Claude Code 操作。'),
    'timeout': (504, 'Claude Code 操作超时，已停止自有进程。'),
    'permission_denied': (403, 'Claude Code 拒绝了需要额外权限的操作。'),
    'output_limit': (503, 'Claude Code 输出超出本地限制。'),
    'incomplete_stream': (503, 'Claude Code 未返回完整结束事件，本次未确认完成。'),
    'cli_failed': (503, 'Claude Code 进程未成功退出，本次未确认完成。'),
    'model_error': (503, 'Claude Code 模型请求未成功完成。'),
    'callback_failed': (503, 'Claude Code 事件接收失败，已停止。'),
    'unsupported_protocol': (503, 'Claude Code 返回了未支持或不完整的协议。'),
    'unsafe_runtime': (503, 'Claude Code 未按无工具限制启动，已停止。'),
    'unexpected_mcp': (503, '当前 Claude 连接不加载 MCP 服务，已停止。'),
    'unexpected_tool': (503, '当前 Claude 连接不执行 CLI 工具，已停止。'),
    'unsupported_dynamic_tools': (400, '当前 Claude 连接尚未接入动态工具。'),
    'unsupported_subagent': (503, '当前 Claude 连接尚不支持子代理协议。'),
    'unsupported_tool_result': (503, '当前 Claude 连接尚不支持此工具结果格式。'),
    'invalid_request': (400, 'Claude 请求格式无效。'),
    'adapter_failed': (503, 'Claude Code 本机调用未完成，请重试。'),
}
def claude_error(error):
    code = getattr(error, 'code', 'adapter_failed')
    if code not in CLAUDE_ERRORS: code = 'adapter_failed'
    status, message = CLAUDE_ERRORS[code]
    return status, {'code': code, 'message': message}
LOCAL_PROJECTS = LocalProjects(DATA_DIR)
LOCAL_DOCUMENT_DRAFTS = LocalDocumentDraftStore(DATA_DIR, STORE.load, LOCAL_PROJECTS)
DOCUMENT_MEDIA = DocumentMedia(STORE)
LOCAL_DOCUMENT_MEDIA = LocalDocumentMedia(LOCAL_PROJECTS, STORE.load)
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
            if path.startswith('/__cloud/connections/'):
                if path not in ('/__cloud/connections/capabilities', '/__cloud/connections/transport'):
                    self.send_json({'error':'找不到连接配置接口。','code':'NOT_FOUND'},404); return
                if self.command != 'POST' or '?' in self.path or self.headers.get('Content-Type','').split(';',1)[0].strip().lower() != 'application/json':
                    self.send_json({'error':'连接配置请求必须使用 JSON POST。','code':'INVALID_REQUEST'},400); return
                lengths = self.headers.get_all('Content-Length', [])
                if self.headers.get('Transfer-Encoding') is not None or len(lengths) != 1 or not re.fullmatch(r'[0-9]+', lengths[0]):
                    self.send_json({'error':'连接配置请求长度无效。','code':'INVALID_REQUEST'},400); return
                def strict_pairs(items):
                    result = {}
                    for key, value in items:
                        if key in result: raise ValueError('duplicate key')
                        result[key] = value
                    return result
                def invalid_constant(_): raise ValueError('invalid constant')
                payload = json.loads(self.read_body(2 * 1024 * 1024 + 8192) or b'{}', object_pairs_hook=strict_pairs, parse_constant=invalid_constant)
                if not isinstance(payload,dict): raise ValueError('invalid request')
                result = service.connections_capabilities(payload) if path.endswith('/capabilities') else service.connections_transport(payload)
                self.send_json(result); return
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
                elif path == '/__cloud/ssh/probe': result=service.ssh.probe(payload)
                elif path == '/__cloud/ssh/connect':
                    STORE.ensure_sync(); result=service.ssh.connect(payload)
                elif path == '/__cloud/ssh/save': result=service.ssh.save(payload)
                elif path == '/__cloud/ssh/move': result=service.ssh.move(payload)
                elif path == '/__cloud/ssh/reconcile': result=service.ssh.reconcile(payload)
                elif path == '/__cloud/disconnect': result=service.disconnect()
                elif path == '/__cloud/revoke': result=service.revoke(payload.get('deviceId'))
                elif path == '/__cloud/resolve': result=service.resolve(payload.get('id'),payload.get('choice'),payload.get('revision'))
                else: self.send_error(404); return
            self.send_json(result)
        except CloudSyncError as error: self.send_json({'error':str(error),'code':error.code},error.status)
        except (ValueError,TypeError,KeyError,RecursionError): self.send_json({'error':'云同步请求或本地数据无效，请检查配置。'},400)
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
    def do_claude(self, path):
        # Browser same-origin GET does not normally carry Origin. Its exact
        # workspace Referer is the read-only alternative; POST requires Origin.
        trusted = self.valid_auth_origin(mutation=self.command == 'POST')
        if len(self.headers.get_all('Origin', [])) > 1 or len(self.headers.get_all('Host', [])) != 1:
            trusted = False
        if self.command == 'GET' and self.headers.get('Origin') is None:
            refs = self.headers.get_all('Referer', [])
            try:
                ref = urllib.parse.urlsplit(refs[0]) if len(refs) == 1 else None
                hosts = {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}', f'[::1]:{self.server.server_port}'}
                trusted = trusted and ref is not None and ref.scheme == 'http' and ref.netloc in hosts and not ref.username and not ref.password
            except ValueError: trusted = False
        if not trusted:
            self.send_json({'error': {'code': 'origin_denied', 'message': '仅允许当前工作站使用 Claude 本机连接。'}}, 403); return
        routes = {'/__claude/status': 'GET', '/__claude/operation': 'GET', '/__claude/login': 'POST',
                  '/__claude/cancel': 'POST', '/__claude/logout': 'POST', '/__claude/respond': 'POST'}
        if path not in routes:
            self.send_json({'error': {'code': 'not_found', 'message': '找不到 Claude 本机接口。'}}, 404); return
        if self.command != routes[path]:
            self.send_json({'error': {'code': 'invalid_method', 'message': 'Claude 接口请求方法无效。'}}, 405); return
        try:
            def invalid(): raise ClaudeBridgeError('invalid_request')
            def request_id(value):
                if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}', value): invalid()
                return value
            if '#' in self.path: invalid()
            query = urllib.parse.urlsplit(self.path).query
            if path == '/__claude/operation':
                values = urllib.parse.parse_qs(query, keep_blank_values=True, strict_parsing=True)
                if set(values) != {'requestId'} or len(values['requestId']) != 1 or len(query) > 512: invalid()
                payload = {'requestId': request_id(values['requestId'][0])}
            elif '?' in self.path or '#' in self.path: invalid()
            else: payload = {}
            if self.command == 'POST':
                if len(self.headers.get_all('Content-Type', [])) != 1 or self.headers.get('Content-Type', '').split(';', 1)[0].strip().lower() != 'application/json': invalid()
                lengths = self.headers.get_all('Content-Length', [])
                if self.headers.get('Transfer-Encoding') is not None or len(lengths) != 1 or not re.fullmatch(r'[0-9]{1,10}', lengths[0]): invalid()
                length = int(lengths[0])
                limit = CLAUDE_MAX_PROMPT + 16384 if path == '/__claude/respond' else 2048
                if not 0 < length <= limit: invalid()
                # A partial/slow body cannot occupy this route indefinitely.
                self.connection.settimeout(10)
                raw = self.rfile.read(length)
                if len(raw) != length: invalid()
                def pairs(items):
                    result = {}
                    for key, value in items:
                        if key in result: invalid()
                        result[key] = value
                    return result
                payload = json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: invalid())
                if not isinstance(payload, dict): invalid()
                allowed = {'requestId', 'prompt', 'model'} if path.endswith('/respond') else {'confirmation'} if path.endswith('/logout') else {'requestId'}
                required = allowed - {'model'} if path.endswith('/respond') else allowed
                if not required <= set(payload) or set(payload) - allowed: invalid()
                if 'requestId' in payload: request_id(payload['requestId'])
                if path.endswith('/logout') and payload['confirmation'] is not True: invalid()
                if path.endswith('/respond'):
                    prompt, model = payload['prompt'], payload.get('model')
                    if not isinstance(prompt, str) or not prompt.strip() or len(prompt.encode('utf-8')) > CLAUDE_MAX_PROMPT or '\x00' in prompt: invalid()
                    if 'model' in payload and (not isinstance(model, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}', model)): invalid()
            service = claude_service()
            if path.endswith('/status'):
                try: result = {'available': True, **service.status()}
                except ClaudeBridgeError as error:
                    if error.code != 'cli_unavailable': raise
                    result = {'available': False, 'loggedIn': False, 'authMethod': 'none', 'localCLIOnly': True, 'dynamicTools': False}
            elif path.endswith('/operation'): result = service.operation_status(payload['requestId'])
            elif path.endswith('/login'): result = service.login_start(payload['requestId'])
            elif path.endswith('/cancel'): result = {'requestId': payload['requestId'], 'cancelled': service.cancel(payload['requestId'])}
            elif path.endswith('/logout'): result = service.logout()
            else:
                self.do_claude_respond(service, payload); return
            # Operation errors are identifiers only, never arbitrary CLI data.
            if 'code' in result: result['code'] = claude_error(ClaudeBridgeError(result['code']))[1]['code']
            self.send_json(result)
        except (ValueError, TypeError, UnicodeError, RecursionError, OverflowError, socket.timeout):
            self.send_json({'error': claude_error(ClaudeBridgeError('invalid_request'))[1]}, 400)
        except Exception as error:
            status, failure = claude_error(error)
            self.send_json({'error': failure}, status)

    def do_claude_respond(self, service, payload):
        request_id = payload['requestId']
        cancel, finished, closed = threading.Event(), threading.Event(), threading.Event()
        events = queue.Queue(maxsize=2)
        terminal, delivery_lock = [False], threading.Lock()
        def emit(event):
            # The bridge only exposes this subset. Keep an explicit HTTP
            # projection so future CLI fields cannot accidentally become public.
            kind = event.get('type')
            result = {'requestId': request_id, 'type': kind}
            if kind == 'text': result['text'] = event['text']
            elif kind == 'reasoning': result.update(status='observed', text='正在思考')
            elif kind == 'retry': result['attempt'] = event['attempt']
            elif kind == 'done': result['sessionId'] = event['sessionId']
            elif kind in ('error', 'cancelled'): result.update(claude_error(ClaudeBridgeError(event.get('code')))[1])
            elif kind != 'started': raise ClaudeBridgeError('unsupported_protocol')
            with delivery_lock:
                if closed.is_set() or terminal[0]: return
                while not closed.is_set():
                    try: events.put(result, timeout=.05); break
                    except queue.Full:
                        if cancel.is_set(): return
                if kind in ('done', 'error', 'cancelled'): terminal[0] = True
        def run():
            try:
                service.print_stream(request_id, payload['prompt'], emit, model=payload.get('model'), cancel=cancel)
            except Exception as error:
                _, failure = claude_error(error)
                emit({'type': 'cancelled' if failure['code'] == 'cancelled' else 'error', **failure})
            finally: finished.set()
        worker = threading.Thread(target=run, daemon=True)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        self.send_header('X-Accel-Buffering', 'no')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers(); self.close_connection = True
        self.connection.settimeout(2)
        worker.start()
        try:
            while not finished.is_set() or not events.empty():
                # Also detect a disconnect while the CLI has not emitted data.
                if select.select([self.connection], [], [], 0)[0] and not self.connection.recv(1, socket.MSG_PEEK): break
                try: event = events.get(timeout=.1)
                except queue.Empty: continue
                self.wfile.write(('data: ' + json.dumps(event, ensure_ascii=False) + '\n\n').encode('utf-8'))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError): pass
        finally:
            closed.set(); cancel.set()
            # This per-call event cannot cancel another run, even if a duplicate
            # request ID was rejected by the bridge before registering a job.
            worker.join(timeout=4)
    def do_document_media(self, path):
        if not self.valid_auth_origin(mutation=self.command != 'GET'):
            self.send_json({'error': '仅允许当前工作站访问文档图片。', 'code': 'document_image_origin_denied'}, 403); return
        try:
            if self.command == 'GET' and path == '/__local/document-images/read':
                query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query, keep_blank_values=True, strict_parsing=True)
                if set(query) - {'candidateId','path','image','projectId','sourceConversationId'} or any(len(values) != 1 for values in query.values()) or not {'candidateId','path','image'} <= set(query):
                    raise MediaError('本机文档图片地址无效。')
                with STORE.lock():
                    result = LOCAL_DOCUMENT_MEDIA.read(query['candidateId'][0], query['path'][0], query['image'][0], query.get('projectId',[None])[0], query.get('sourceConversationId',[None])[0])
            elif self.command == 'POST' and path in ('/__document-images/upload','/__document-images/export','/__local/document-images/upload','/__local/document-images/export'):
                if self.headers.get('Content-Type','').split(';',1)[0].strip().lower() != 'application/json':
                    raise MediaError('文档图片请求必须使用 JSON。',415)
                lengths = self.headers.get_all('Content-Length', [])
                if self.headers.get('Transfer-Encoding') or len(lengths) != 1 or not re.fullmatch(r'[0-9]+',lengths[0]):
                    raise MediaError('文档图片请求长度无效。')
                payload = decode_note_draft_json(self.read_body(MAX_IMAGE_UPLOAD_BODY) or b'{}')
                service = LOCAL_DOCUMENT_MEDIA if path.startswith('/__local/') else DOCUMENT_MEDIA
                if path.startswith('/__local/'):
                    with STORE.lock():
                        result = service.upload(payload) if path.endswith('/upload') else service.export(payload)
                else:
                    result = service.upload(payload) if path.endswith('/upload') else service.export(payload)
            else:
                self.send_json({'error':'找不到文档图片接口。'},404); return
            if isinstance(result,dict) and isinstance(result.get('data'),bytes):
                raw = result['data']
                self.send_response(200); self.send_header('Content-Type',result['mimeType']); self.send_header('Cache-Control','no-store'); self.send_header('Content-Length',str(len(raw))); self.send_header('X-Content-Type-Options','nosniff'); self.send_header('Content-Disposition',('attachment' if path.endswith('/export') else 'inline') + "; filename*=UTF-8''" + urllib.parse.quote(result['name'])); self.end_headers(); self.wfile.write(raw)
            else:
                self.send_json(result)
        except (MediaError,LocalProjectError) as error:
            self.send_json({'error':str(error),'code':getattr(error,'code','document_image_invalid')},error.status)
        except (ValueError,TypeError,UnicodeError,RecursionError) as error:
            large = str(error) == '上传内容过大'
            self.send_json({'error':'图片请求超过 24 MiB 上限，未保存。' if large else '文档图片请求格式无效。','code':'document_image_too_large' if large else 'document_image_invalid'},413 if large else 400)
        except OSError:
            self.send_json({'error':'图片原件无法读取或保存，请保留当前文档后重试。','code':'document_image_storage_unavailable'},503)

    def do_local(self, path):
        if not self.valid_auth_origin(mutation=self.command != 'GET'):
            self.send_json({'error': '仅允许当前工作站访问本机目录。'}, 403); return
        try:
            if self.command == 'GET' and path == '/__local/roots':
                self.send_json(LOCAL_PROJECTS.roots()); return
            if self.command == 'DELETE' and path.startswith('/__local/roots/'):
                self.send_json(LOCAL_PROJECTS.disconnect(path.removeprefix('/__local/roots/'))); return
            if self.command != 'POST' or path not in ('/__local/roots', '/__local/search', '/__local/snapshot', '/__local/files', '/__local/read', '/__local/reveal', *('/__local/commands/'+action for action in ('propose','get','start','deny','cancel','forget')), *('/__local/edits/'+action for action in ('propose','get','apply','undo','dismiss','accept-hunk','reject-hunk','undo-hunk'))):
                self.send_json({'error': '找不到本机目录接口。'}, 404); return
            payload = json.loads(self.read_body(25_000_000 if path == '/__local/edits/propose' else 16384) or b'{}')
            if not isinstance(payload, dict): raise LocalProjectError('本机目录请求格式无效。')
            if path == '/__local/roots':
                result = LOCAL_PROJECTS.connect_preset(payload['preset']) if 'preset' in payload else LOCAL_PROJECTS.connect(payload.get('path'))
            elif path == '/__local/commands/propose': result = LOCAL_COMMANDS.propose(payload)
            elif path.startswith('/__local/commands/'): result = LOCAL_COMMANDS.access(payload.get('id'),path.rsplit('/',1)[-1],remember=payload.get('remember') is True,automatic=payload.get('automatic') is True)
            elif path == '/__local/reveal': result = reveal_file(LOCAL_PROJECTS, STORE, payload)
            elif path == '/__local/edits/propose': result = LOCAL_FILE_EDITS.propose(payload)
            elif path.startswith('/__local/edits/'): result = LOCAL_FILE_EDITS.access(payload.get('id'),path.rsplit('/',1)[-1],payload)
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
    def do_pdf_preview(self, file_id, info=False, text=False, search=False, read_text=False):
        """Render or extract one page from preserved PDF bytes without a PDF plugin."""
        if read_text and not self.valid_auth_origin():
            self.send_json({'error': '仅允许当前工作站读取 PDF 文字。', 'code': 'INVALID_ORIGIN'}, 403); return
        try:
            source = STORE.file_path(file_id)
            if source.is_symlink() or source.parent.is_symlink(): raise ValueError('附件路径不可用')
            if not source.is_file(): self.send_json({'error': '找不到附件原件'}, 404); return
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query, keep_blank_values=True, errors='strict')
            def parameter(name, default):
                values = query.get(name, [default])
                if len(values) != 1: raise ValueError(f'{name} 参数只能指定一次')
                return values[0]
            page_value = parameter('page', '1')
            if not re.fullmatch(r'[0-9]{1,8}', page_value): raise ValueError('页码必须是从 1 开始的整数')
            page_number = int(page_value)
            text_offset = 0
            expected_source = parameter('source', '') if read_text else ''
            batch_value = parameter('batch', '0') if read_text else '0'
            if batch_value not in ('0', '1'):
                self.send_json({'error': 'PDF 批量读取参数无效', 'code': 'INVALID_BATCH'}, 400); return
            index_batch = batch_value == '1'
            if expected_source and not re.fullmatch(r'[0-9a-f]{64}', expected_source):
                self.send_json({'error': 'PDF 原件版本参数无效', 'code': 'INVALID_SOURCE_VERSION'}, 400); return
            if read_text:
                offset_value = parameter('offset', '0')
                if not re.fullmatch(r'[0-9]{1,16}', offset_value) or int(offset_value) > 9007199254740991:
                    raise ValueError('文字游标必须是从 0 开始的安全整数')
                text_offset = int(offset_value)
            search_query = parameter('q', '') if search else None
            normalized_query = pdf_search_query(search_query) if search else None
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
            def json_response(payload, status=200):
                return status, 'application/json; charset=utf-8', json.dumps(payload, ensure_ascii=False).encode('utf-8')
            def render_response(source_bytes):
                with fitz.open(stream=source_bytes, filetype='pdf') as document:
                    if not document.is_pdf: raise ValueError('该附件不是 PDF 文件')
                    if document.needs_pass: raise ValueError('该 PDF 已加密，请先上传解密后的文件')
                    if document.page_count < 1: raise ValueError('PDF 没有可预览的页面')
                    if not 1 <= page_number <= document.page_count:
                        return json_response({'error': '请求的 PDF 页码不存在'}, 404)
                    if (text or search or read_text) and not document.permissions & fitz.PDF_PERM_COPY:
                        return json_response({'error': '此 PDF 的权限禁止复制文字，可继续查看原图。', 'code': 'PDF_COPY_RESTRICTED'}, 403)
                    page = document.load_page(0 if info else page_number - 1)
                    width, height = page.rect.width, page.rect.height
                    if not all(math.isfinite(value) and value > 0 for value in (width, height)):
                        raise ValueError('PDF 页面尺寸无效')
                    if info:
                        return json_response({'pageCount': document.page_count, 'width': width, 'height': height})
                    if read_text and index_batch:
                        parts, remaining = [], MAX_PDF_INDEX_BATCH_CHARS
                        next_page, next_offset = page_number, text_offset
                        while next_page <= document.page_count and len(parts) < MAX_PDF_INDEX_BATCH_PAGES and remaining > 0:
                            source_page = document.load_page(next_page - 1)
                            content = source_page.get_text('text', sort=True, flags=fitz.TEXTFLAGS_TEXT & ~fitz.TEXT_PRESERVE_IMAGES)
                            total_chars = len(content)
                            if next_offset > total_chars: raise ValueError('文字游标超过本页文字长度')
                            chunk = content[next_offset:next_offset + remaining]
                            end = next_offset + len(chunk)
                            continuation = end if end < total_chars else None
                            parts.append({'page': next_page, 'offset': next_offset, 'text': chunk,
                                          'totalChars': total_chars, 'nextOffset': continuation})
                            remaining -= len(chunk)
                            if continuation is not None:
                                next_offset = continuation; break
                            next_page += 1; next_offset = 0
                        complete = next_page > document.page_count
                        return json_response({'parts': parts, 'pageCount': document.page_count,
                                              'nextPage': None if complete else next_page,
                                              'nextOffset': None if complete else next_offset,
                                              'sourceHash': source_digest.hex(), 'readMode': 'extracted_text',
                                              'imagesIncluded': False, 'cursorUnit': 'unicode_codepoints'})
                    if read_text:
                        # Text-only evidence has no selection-geometry restriction:
                        # rotated/vertical text must not disappear with its overlay.
                        # No images or OCR; offsets count Python Unicode codepoints.
                        content = page.get_text('text', sort=True, flags=fitz.TEXTFLAGS_TEXT & ~fitz.TEXT_PRESERVE_IMAGES)
                        total_chars = len(content)
                        if text_offset > total_chars: raise ValueError('文字游标超过本页文字长度')
                        chunk = content[text_offset:text_offset + MAX_PDF_READ_TEXT_CHARS]
                        end = text_offset + len(chunk)
                        available = bool(content.strip())
                        result = {'page': page_number, 'pageCount': document.page_count, 'offset': text_offset,
                                  'text': chunk, 'totalChars': total_chars, 'nextOffset': end if end < total_chars else None,
                                  'originalRead': True, 'readMode': 'extracted_text', 'imagesIncluded': False,
                                  'textAvailable': available, 'cursorUnit': 'unicode_codepoints',
                                  'sourceHash': source_digest.hex()}
                        if not available:
                            result.update(code='PDF_TEXT_UNAVAILABLE', warning='本页没有可提取的文字，可能是扫描页或空白页；尚未读取图像，也未执行 OCR。')
                        return json_response(result)
                    if search:
                        return json_response(pdf_preview_search(page, fitz, search_query, normalized_query))
                    if text:
                        return json_response(pdf_preview_text(page, fitz))
                    # Fit the complete page into the rendering budget; never crop or
                    # discard oversized pages from scanner/export applications.
                    render_scale = scale
                    if fit == '1':
                        render_scale = min(scale, math.sqrt((MAX_PREVIEW_PIXELS - 20000) / (width * height)), 16382 / width, 16382 / height)
                    pixel_width, pixel_height = math.ceil(width * render_scale), math.ceil(height * render_scale)
                    if pixel_width * pixel_height > MAX_PREVIEW_PIXELS or max(pixel_width, pixel_height) > 16384:
                        raise ValueError('PDF 页面尺寸过大，请降低缩放比例后重试')
                    pixmap = page.get_pixmap(matrix=fitz.Matrix(render_scale, render_scale), colorspace=fitz.csRGB, alpha=False)
                    image = pixmap.tobytes('jpeg', jpg_quality=85) if image_format == 'jpeg' else pixmap.tobytes('png')
                    del pixmap
                    return 200, f'image/{image_format}', image
            # Serialize page rendering to avoid concurrent large pixmaps and
            # sharing the native PDF renderer between HTTP worker threads.
            with PDF_PREVIEW_LOCK:
                if search or read_text:
                    # A cancelled client waiting behind another page should not
                    # start extraction when it eventually acquires the lock.
                    try:
                        if select.select([self.connection], [], [], 0)[0] and not self.connection.recv(1, socket.MSG_PEEK): return
                    except OSError: return
                # Open the exact regular file without following a swapped symlink.
                directory_fd = os.open(source.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try: descriptor = os.open(source.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
                finally: os.close(directory_fd)
                with os.fdopen(descriptor, 'rb') as original:
                    metadata = os.fstat(original.fileno())
                    if not stat.S_ISREG(metadata.st_mode): raise ValueError('附件路径不可用')
                    if metadata.st_size > MAX_FILE: raise ValueError('单个附件不能超过 64 MB')
                    source_bytes = original.read(MAX_FILE + 1)
                    if len(source_bytes) > MAX_FILE: raise ValueError('单个附件不能超过 64 MB')
                source_digest = hashlib.sha256(source_bytes).digest()
                if expected_source and source_digest.hex() != expected_source:
                    self.send_json({'error': 'PDF 原件已变化，请重新建立文字索引。', 'code': 'PDF_SOURCE_CHANGED'}, 409); return
                # Hash actual securely opened bytes on every request. Stat-only
                # keys miss same-inode/same-size changes with restored mtime.
                action = 'info' if info else 'read-text' if read_text else 'search' if search else 'text' if text else 'image'
                key = (source_digest, action, page_number, scale, fit, image_format, search_query, text_offset, index_batch)
                cached = PDF_RESPONSE_CACHE.get(key)
                if cached is None:
                    response_status, content_type, body = render_response(source_bytes)
                    if response_status == 200:
                        PDF_RESPONSE_CACHE.put(key, content_type, body)
                else:
                    response_status, (content_type, body) = 200, cached
                del source_bytes
            # Slow or disconnected clients never hold the PDF renderer lock.
            self.send_response(response_status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers(); self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError): pass
        except Exception as exc:
            # Native renderer exceptions can contain the private storage path.
            # Expose actionable document errors, never raw filesystem details.
            detail = str(exc)
            safe = {'页码必须是从 1 开始的整数', '预览缩放比例必须在 0.5 到 2 之间', 'fit 参数只能为 0 或 1',
                    '预览格式只支持 png 或 jpeg', '该附件不是 PDF 文件', '该 PDF 已加密，请先上传解密后的文件',
                    'PDF 没有可预览的页面', 'PDF 页面尺寸无效', 'PDF 页面尺寸过大，请降低缩放比例后重试',
                    '附件路径不可用', '单个附件不能超过 64 MB',
                    '文字游标必须是从 0 开始的安全整数', '文字游标超过本页文字长度',
                    '查找内容必须为 1 到 256 个字符，且不能含控制字符'}
            if detail not in safe and not re.fullmatch(r'(page|scale|fit|format|q|offset) 参数只能指定一次', detail):
                detail = '文件可能损坏或尚未完整下载，请重新添加完整的 PDF 原件'
            action = '无法读取 PDF 文字' if read_text else '无法查找 PDF' if search else '无法预览 PDF'
            self.send_json({'error': f'{action}：{detail}'}, 400)
    def do_bookmark_metadata(self):
        if not self.valid_auth_origin(mutation=True):
            self.send_json({'error': '仅允许当前工作站获取网站信息。', 'code': 'INVALID_ORIGIN'}, 403); return
        acquired = bookmark_fetch.FETCH_LOCK.acquire(blocking=False)
        if not acquired:
            self.send_json({'error': '另一项链接读取尚未结束，请稍后重试。', 'code': 'BOOKMARK_BUSY'}, 409); return
        try:
            request = json.loads(self.read_body(32768) or b'{}')
            self.send_json(bookmark_metadata.receive(STORE, request))
        except PublicFetchError as error:
            self.send_json({'error': str(error), 'code': error.code}, error.status)
        except (ValueError, TypeError):
            self.send_json({'error': '网站信息请求格式无效。', 'code': 'INVALID_REQUEST'}, 400)
        except Exception:
            self.send_json({'error': '网站信息暂时不可用，已保存资料未改动。', 'code': 'METADATA_FAILED'}, 503)
        finally:
            bookmark_fetch.FETCH_LOCK.release()

    def do_fetch(self):
        if not self.valid_auth_origin(mutation=True):
            self.send_json({'error': '仅允许当前工作站下载链接资料。', 'code': 'INVALID_ORIGIN'}, 403); return
        bookmark_locked = False
        try:
            request = json.loads(self.read_body(32768) or b'{}')
            if not isinstance(request, dict) or ('native' in request and not isinstance(request['native'], bool)):
                raise PublicFetchError('链接请求格式无效。', 'INVALID_REQUEST', 400)
            bookmark_before = None
            if 'bookmark' in request:
                bookmark_locked = bookmark_fetch.FETCH_LOCK.acquire(blocking=False)
                if not bookmark_locked:
                    raise PublicFetchError('另一项链接读取尚未结束，请稍后重试。', 'BOOKMARK_BUSY', 409)
                with STORE.lock():
                    bookmark_before, cached = bookmark_fetch.prepare(STORE, request)
                if cached is not None:
                    self.send_json(cached); return
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
            if bookmark_before is not None:
                if (mime.startswith('text/') or mime in ('application/xhtml+xml', 'application/json', 'application/xml')) and not result['content'].strip():
                    raise PublicFetchError('网页没有可读取的正文，收藏已保留；可稍后重试或打开原网页。', 'EMPTY_CONTENT', 422)
                with STORE.lock():
                    result = bookmark_fetch.commit(STORE, request, bookmark_before, raw, result)
                self.send_json(result); return
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
        finally:
            if bookmark_locked:
                bookmark_fetch.FETCH_LOCK.release()
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
                # The desktop bundle already includes MuPDF. Never depend on a
                # separately installed command-line parser for searchable text.
                import fitz
                with PDF_PREVIEW_LOCK, fitz.open(stream=data, filetype='pdf') as document:
                    if document.needs_pass:
                        self.send_json({'error': 'PDF 已加密，需先解密原件。', 'code': 'PDF_PASSWORD_REQUIRED'}, 422); return
                    if not document.permissions & fitz.PDF_PERM_COPY:
                        self.send_json({'error': '此 PDF 的权限禁止复制文字，可继续查看原图。', 'code': 'PDF_COPY_RESTRICTED'}, 403); return
                    pages = [{'page': index + 1, 'text': page.get_text('text', sort=True, flags=fitz.TEXTFLAGS_TEXT & ~fitz.TEXT_PRESERVE_IMAGES)} for index, page in enumerate(document)]
                    page_count = document.page_count
                text = '\n\n'.join(f"[第 {page['page']} 页]\n{page['text']}" for page in pages if page['text'].strip())
                if not text.strip(): warning = '没有可提取的文字，可能是扫描页或空白页；未执行 OCR。'
                # This compatibility upload endpoint returns the complete text.
                # Durable background jobs use read-text page/cursor pagination.
                self.send_json({'name': name, 'content': text, 'pages': pages, 'pageCount': page_count,
                                'parser': 'pymupdf-local', 'warning': warning, 'truncated': False,
                                'sourceHash': hashlib.sha256(data).hexdigest(), 'textExtractionComplete': True}); return
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
        headers_sent = False; event_stream = False; phase = 'connection'
        finished = threading.Event(); disconnected = threading.Event(); sockets = []; sockets_lock = threading.Lock(); watcher = None
        def shutdown(upstream):
            try: upstream.shutdown(socket.SHUT_RDWR)
            except OSError: pass
        def connected(upstream):
            nonlocal phase
            phase = 'response'
            with sockets_lock: sockets.append(upstream)
            if disconnected.is_set(): shutdown(upstream); raise ConnectionAbortedError('client disconnected')
        def connecting():
            nonlocal phase
            # Same-origin redirects can begin another connection after the
            # previous one succeeded. Keep timeout classification accurate.
            phase = 'connection'
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
                event = {'type': 'error', 'error': proxy_failure(None, 'stream')}
                try: self.wfile.write(('data: ' + json.dumps(event, ensure_ascii=False) + '\n\n').encode()); self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError): pass
        try:
            body = self.read_body(MAX_FILE) if method == 'POST' else None; request = urllib.request.Request(raw, data=body, method=method)
            for name in ('Authorization', 'Content-Type', 'Accept'):
                if self.headers.get(name): request.add_header(name, self.headers[name])
            watcher = threading.Thread(target=watch_client, daemon=True); watcher.start()
            with proxy_opener(connected, connecting).open(request, timeout=PROXY_CONNECT_TIMEOUT) as response:
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
        except Exception as exc:
            if headers_sent: stream_failure()
            elif not disconnected.is_set():
                try: self.send_json({'error': proxy_failure(exc, phase)}, 502)
                except (BrokenPipeError, ConnectionResetError, OSError): pass
        finally:
            finished.set()
            with sockets_lock: upstreams = list(sockets)
            for upstream in upstreams: shutdown(upstream)
            if watcher: watcher.join(0.3)
    def do_comparison_draft(self):
        # This is a local editor-recovery slot outside workspace content. The
        # exact dynamic loopback check follows this server's ephemeral port on
        # every launch. GET is guarded too because it returns source excerpts.
        mutation = self.command == 'POST'
        if not self.valid_auth_origin(mutation=mutation):
            self.send_json({'error': '仅允许当前工作站访问比较草稿。', 'code': 'draft_origin_denied'}, 403); return
        try:
            with STORE.lock():
                if mutation:
                    payload = json.loads(self.read_body(MAX_COMPARISON_DRAFT_BYTES + 1024) or b'{}')
                    result = COMPARISON_DRAFTS.put(payload)
                elif self.command == 'GET':
                    result = COMPARISON_DRAFTS.get()
                else:
                    self.send_json({'error': '仅支持读取或保存比较草稿。'}, 405); return
            self.send_json(result)
        except DraftError as error:
            self.send_json({'error': str(error), 'code': error.code}, error.status)
        except (ValueError, TypeError, UnicodeError) as error:
            too_large = str(error) == '上传内容过大'
            self.send_json({'error': str(error) or '比较草稿请求格式无效。', 'code': 'draft_too_large' if too_large else 'draft_invalid'}, 413 if too_large else 400)
        except OSError:
            self.send_json({'error': '比较草稿存储失败；上一次已保存版本仍保留。', 'code': 'draft_write_failed'}, 503)

    def do_note_draft(self):
        mutation = self.command == 'POST'
        if not self.valid_auth_origin(mutation=mutation):
            self.send_json({'error': '仅允许当前工作站访问笔记草稿。', 'code': 'draft_origin_denied'}, 403); return
        try:
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query, keep_blank_values=True, strict_parsing=True)
            if set(query) != {'id'} or len(query['id']) != 1:
                raise DraftError('请提供唯一的笔记草稿标识。')
            identifier = query['id'][0]
            with STORE.lock():
                if mutation:
                    if self.headers.get('Content-Type', '').split(';', 1)[0].strip().lower() != 'application/json':
                        raise DraftError('笔记草稿请求必须使用 JSON。', 415)
                    payload = decode_note_draft_json(self.read_body(MAX_NOTE_DRAFT_BYTES + 1024) or b'{}')
                    result = NOTE_DRAFTS.put(identifier, payload)
                else:
                    result = NOTE_DRAFTS.get(identifier)
            self.send_json(result)
        except DraftError as error:
            self.send_json({'error': str(error), 'code': error.code}, error.status)
        except (ValueError, TypeError, UnicodeError, RecursionError) as error:
            too_large = str(error) == '上传内容过大'
            self.send_json({'error': '笔记草稿超过 24 MiB 本机恢复上限，未截断或保存。' if too_large else '笔记草稿请求格式无效。', 'code': 'draft_too_large' if too_large else 'draft_invalid'}, 413 if too_large else 400)
        except OSError:
            self.send_json({'error': '笔记草稿存储不可用；请保留当前编辑内容。', 'code': 'draft_write_failed'}, 503)

    def do_local_document_draft(self):
        mutation = self.command == 'POST'
        if not self.valid_auth_origin(mutation=mutation):
            self.send_json({'error': '仅允许当前工作站访问本机文档草稿。', 'code': 'draft_origin_denied'}, 403); return
        try:
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query, keep_blank_values=True, strict_parsing=True)
            if set(query) != {'id'} or len(query['id']) != 1:
                raise DraftError('请提供唯一的本机文档草稿标识。')
            identifier = query['id'][0]
            if mutation:
                if self.headers.get('Content-Type', '').split(';', 1)[0].strip().lower() != 'application/json':
                    raise DraftError('本机文档草稿请求必须使用 JSON。', 415)
                lengths = self.headers.get_all('Content-Length', [])
                if self.headers.get('Transfer-Encoding') or len(lengths) != 1 or not re.fullmatch(r'[0-9]+', lengths[0]):
                    raise DraftError('本机文档草稿请求长度无效。')
                # Full local drafts are not subject to the existing 1M-note or
                # 4MB-file-application limit. Never acknowledge a partial body.
                length = int(lengths[0]); raw = self.rfile.read(length)
                if len(raw) != length:
                    raise DraftError('本机文档草稿请求未完整接收，未保存。')
                payload = decode_note_draft_json(raw or b'{}')
            with STORE.lock():
                result = LOCAL_DOCUMENT_DRAFTS.put(identifier, payload) if mutation else LOCAL_DOCUMENT_DRAFTS.get(identifier)
            self.send_json(result)
        except DraftError as error:
            self.send_json({'error': str(error), 'code': error.code}, error.status)
        except (ValueError, TypeError, UnicodeError, RecursionError, OverflowError):
            self.send_json({'error': '本机文档草稿请求格式无效，未保存。', 'code': 'draft_invalid'}, 400)
        except (OSError, MemoryError):
            self.send_json({'error': '本机文档草稿存储不可用；请保留当前编辑内容。', 'code': 'draft_write_failed'}, 503)

    def do_GET(self):
        if handle_external_notifications(self, EXTERNAL_NOTIFICATIONS): return
        path = urllib.parse.urlsplit(self.path).path
        if path == '/__health': self.send_json({'app': 'ai-workstation', 'version': VERSION, 'assetFingerprint': ASSET_FINGERPRINT, 'port': self.server.server_port, 'instanceId': SERVICE_INSTANCE})
        elif path == '/__comparison-draft': self.do_comparison_draft()
        elif path == '/__note-draft': self.do_note_draft()
        elif path.startswith('/__document-images/') or path.startswith('/__local/document-images/'): self.do_document_media(path)
        elif path == '/__local-document-draft': self.do_local_document_draft()
        elif path.startswith('/__cloud/'): self.do_cloud(path)
        elif path.startswith('/__claude/'): self.do_claude(path)
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
            if len(file_parts) == 2 and file_parts[1] in ('preview', 'preview-info', 'preview-text', 'preview-search', 'read-text'):
                self.do_pdf_preview(urllib.parse.unquote(file_parts[0]), info=file_parts[1] == 'preview-info', text=file_parts[1] == 'preview-text', search=file_parts[1] == 'preview-search', read_text=file_parts[1] == 'read-text')
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
        if handle_external_notifications(self, EXTERNAL_NOTIFICATIONS): return
        auth_path = urllib.parse.urlsplit(self.path).path
        if auth_path.startswith('/__claude/'):
            self.do_claude(auth_path); return
        if auth_path == '/__comparison-draft': self.do_comparison_draft(); return
        if auth_path == '/__note-draft': self.do_note_draft(); return
        if auth_path.startswith('/__document-images/') or auth_path.startswith('/__local/document-images/'): self.do_document_media(auth_path); return
        if auth_path == '/__local-document-draft': self.do_local_document_draft(); return
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
        elif path == '/__bookmark-metadata': self.do_bookmark_metadata()
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
    finally:
        EXTERNAL_NOTIFICATIONS.close()
        close_claude_service()
        http_server.server_close()
