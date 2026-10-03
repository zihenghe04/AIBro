"""Attach a public download to an existing bookmark, never replace an original.

Workspace metadata is still committed by the renderer's durable/CAS pipeline.
The file metadata holds a receipt so an interrupted bridge can recover the
already-downloaded bytes without a second fetch or a second import identity.
"""
import hashlib
import json
import math
from pathlib import Path
import re
import threading

from public_url_fetch import PublicFetchError


FETCH_LOCK = threading.Lock()
ID = re.compile(r'quick_link_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')


def _items(value):
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _active(value):
    return (isinstance(value, dict) and not any(value.get(k) for k in
            ('wikiFileError', 'archived', 'archivedAt', 'deleted', 'deletedAt'))
            and value.get('status') not in ('deleted', 'archived'))


def _matches(state, collection, identifier, retired=False):
    if not identifier:
        return []
    values = _items(state.get(collection, []))
    if retired:
        if collection == 'agentRuns':
            values += _items(state.get('runs', []))
        for entry in _items(state.get('trash', [])):
            data = entry.get('data') or {}
            if isinstance(data, dict):
                values += _items(data.get(collection, []))
                if collection == 'agentRuns':
                    values += _items(data.get('runs', []))
    return [value for value in values if value.get('id') == identifier]


def _private(state, row):
    # Mirrors the canonical source privacy ancestry, including retired owners.
    queue = [row] + _matches(state, 'imports', row.get('id'), retired=True)
    seen = set()
    for value in queue:
        if not isinstance(value, dict) or id(value) in seen:
            continue
        seen.add(id(value))
        if any(value.get(key) for key in ('private', 'ephemeral', 'incognito')):
            return True
        provenance = value.get('provenance')
        if isinstance(provenance, dict):
            queue.append(provenance.get('origin'))
        for collection, key in (('projects', 'projectId'), ('agentRuns', 'agentRunId'),
                                ('agentRuns', 'runId'), ('conversations', 'sourceConversationId'),
                                ('conversations', 'conversationId')):
            queue.extend(_matches(state, collection, value.get(key), retired=True))
    return False


def _changed():
    return PublicFetchError('链接或归属已变化，请刷新后重试；未覆盖现有资料。', 'BOOKMARK_CHANGED', 409)


def _record(store, request):
    target = request.get('bookmark')
    if (not isinstance(target, dict) or set(target) != {'id', 'identity', 'updatedAt', 'requestId'}
            or not ID.fullmatch(str(target.get('id', '')))
            or not ID.fullmatch(str(target.get('requestId', '')))
            or not isinstance(target.get('identity'), str) or not target['identity'] or len(target['identity']) > 240
            or isinstance(target.get('updatedAt'), bool)
            or not isinstance(target.get('updatedAt'), (int, float))
            or not math.isfinite(target['updatedAt']) or target['updatedAt'] < 0
            or request.get('native') is not True):
        raise PublicFetchError('书签抓取请求格式无效。', 'INVALID_REQUEST', 400)
    state = store.load()
    matches = _matches(state, 'imports', target['id'])
    if len(matches) != 1 or not _active(matches[0]):
        raise _changed()
    row = matches[0]
    if _private(state, row):
        raise PublicFetchError('私密资料不能从快捷链接库联网读取。', 'BOOKMARK_PRIVATE', 403)
    projects = _matches(state, 'projects', row.get('projectId'))
    if row.get('projectId') and (len(projects) != 1 or not _active(projects[0])):
        raise _changed()
    if (row.get('quickLinkIdentity') != target['identity'] or row.get('updatedAt') != target['updatedAt']
            or row.get('url') != request.get('url') or row.get('parser') != 'bookmark'
            or row.get('importOrigin') != 'quick-links' or row.get('fileStored')
            or row.get('dataUrl') or str(row.get('content') or '').strip()
            or any(str(page.get('text') or page.get('content') or '').strip() for page in _items(row.get('pages', [])))):
        raise _changed()
    return row


def prepare(store, request):
    """Called under store.lock; return a CAS snapshot and an optional receipt."""
    row = _record(store, request)
    target = request['bookmark']
    path = store.file_path(row['id'])
    metadata = path.with_suffix('.meta.json')
    if path.exists():
        try:
            saved = json.loads(metadata.read_text())['quickLinkFetch']
            result = saved['result']
            if (saved['identity'] != row['quickLinkIdentity'] or saved['url'] != row['url']
                    or result['id'] != row['id'] or saved['sha256'] != hashlib.sha256(path.read_bytes()).hexdigest()):
                raise ValueError()
        except (OSError, ValueError, KeyError, TypeError):
            raise PublicFetchError('已有原件的保存状态无法确认，未覆盖文件。', 'BOOKMARK_FILE_CONFLICT', 409) from None
        # A title/group edit after a lost ACK may start a new request. Original
        # identity and URL still bind the cached bytes; current access was checked.
        return row, dict(result, bookmarkRequestId=target['requestId'])
    return row, None


def commit(store, request, before, raw, result):
    """Called under store.lock after public download and parsing finish."""
    current = _record(store, request)
    if current != before:
        raise _changed()
    path = store.file_path(current['id'])
    metadata = path.with_suffix('.meta.json')
    if path.exists():
        # A second request cannot overwrite bytes that appeared during download.
        raise PublicFetchError('此链接已有原件，请重试以核对保存结果。', 'BOOKMARK_FILE_CONFLICT', 409)
    final = dict(result, id=current['id'], fileStored=True, storedLocally=True,
                 bookmarkRequestId=request['bookmark']['requestId'])
    receipt = {'identity': current['quickLinkIdentity'], 'url': current['url'],
               'sha256': hashlib.sha256(raw).hexdigest(), 'result': final}
    meta = {'name': Path(result['name']).name, 'mimeType': result['mimeType'], 'size': len(raw), 'quickLinkFetch': receipt}
    try:
        # Metadata first: a crash before the atomic original write leaves no
        # readable original; a crash after it always has a recoverable receipt.
        store.atomic_write(metadata, json.dumps(meta, ensure_ascii=False).encode())
        store.atomic_write(path, raw)
    except Exception:
        if not path.exists():
            try:
                metadata.unlink(missing_ok=True)
            except OSError:
                pass
        raise PublicFetchError('原件未能完整保存，请检查本地磁盘后重试。', 'STORE_FAILED', 503) from None
    return final
