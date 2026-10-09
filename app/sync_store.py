"""Local SQLite snapshot, per-record sync projection and durable outbox.

Only explicitly selected knowledge fields leave this database. Credentials,
local paths, execution permissions and renderer state stay device-local.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from functools import lru_cache

COLLECTIONS = ('projects', 'tasks', 'notes', 'imports', 'papers', 'conversations', 'attachments', 'links', 'trash', 'skills')
COMMON = set('id title name description workspace projectId project folderId folderPath createdAt updatedAt archived deletedAt tags sourceAttachmentIds sourceAttachmentId sourceConversationId agentRunId'.split())
FIELDS = {
 'projects': COMMON | set('status dueAt deadline completedAt color icon'.split()),
 'tasks': COMMON | set('status priority startAt dueAt completedAt checklist sourceNoteIds dependsOn provenance workflowCategory reminderMinutes'.split()),
 'notes': COMMON | set('content kind paperId userEdited userEditedAt revisionHistory aiDraft aiDraftHistory provenance sourceNoteIds relatedNoteIds mergedNoteIds consolidatedSections sourceComparison projectMemoryType memoryDate memoryRunIds managedIndex wikiFileBacked wikiCategory wikiMigratedAt wikiImportHash wikiOriginalName wikiImportBatch'.split()),
 'imports': COMMON | set('originalName content pages parser mimeType size url warning error blobHash analysis importOrigin'.split()),
 'papers': COMMON | set('noteId authors year venue doi arxivId url sourceUrl canonicalKey metadata paperType structured userEdits confidence reviewed reviewedAt relations provenance'.split()),
 'conversations': COMMON | set('attachments skillId skillIds modelOverride favorite pinnedAt mobileContext'.split()),
 'messages': set('id conversationId position role content text at createdAt updatedAt attachments attachmentIds retrievedSources provider model reasoningEffort modelLabel actualModel skillSnapshot pendingPlan reasoning toolEvents status error capabilities'.split()),
 'attachments': COMMON | set('type relation taskId noteId importId sourceId targetId sourceType targetType'.split()),
 'links': COMMON | set('sourceId targetId sourceType targetType relation'.split()),
 'trash': set('id type title deletedAt counts data'.split()),
 'folders': set('id name kind createdAt updatedAt'.split()),
 'skills': set('id name command description instructions enabled createdAt updatedAt'.split()),
}
SENSITIVE = set('apikey accesstoken refreshtoken idtoken authorization password passwd secret clientsecret token credentials credential auth localfolder localpath path rootpath rootid absolutepath dataurl rawbase64 permissionmode permissions approvalpolicy sandboxmode'.split())
IDENTIFIER = re.compile(r'^[A-Za-z0-9_-]{1,200}$')
DIGEST = re.compile(r'^[a-f0-9]{64}$')
MESSAGE_PROCESS_FIELDS = ('pendingPlan', 'reasoning', 'toolEvents', 'status', 'error', 'capabilities')
MESSAGE_ENTITY_BYTES = 4 * 1024 * 1024

def dump(value): return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True, allow_nan=False)
def copy(value): return json.loads(dump(value))
def new_id(): return uuid.uuid4().hex


class MessageBodyConflict(ValueError):
    """Both wire spellings changed, so picking either would lose user content."""
    code = 'MESSAGE_BODY_CONFLICT'
    status = 409
    def __init__(self):
        super().__init__('消息的 text 与 content 正文存在不同修改，请保留两份内容并重新核对后保存。')


def _invalidate_message_plan(message, reason):
    plan = message.get('pendingPlan')
    if isinstance(plan, dict) and plan.get('status') == 'pending':
        message['pendingPlan'] = {**plan, 'status': 'invalidated',
                                  'invalidatedReason': reason, 'invalidatedAt': int(time.time() * 1000)}


def _message_body(message):
    if 'content' in message: return message['content']
    return message.get('text')


def _message_text_alias(message):
    # Mac rendering and continuation consume text. This alias is snapshot-only:
    # record() omits an identical text beside content, preserving the wire body.
    if isinstance(message.get('content'), str):
        if 'text' in message and message['text'] != message['content']: raise MessageBodyConflict()
        message['text'] = message['content']
    return message


def _validate_message_process(value):
    """Keep complete history or reject atomically; never truncate an action plan.

    The size/tree envelope matches cloud_server's existing v1 entity limits:
    4 MiB UTF-8 JSON, depth 32 and 20,000 values, including the message body.
    Status names stay extensible for older/newer clients; no execution is added.
    """
    for key in ('reasoning', 'status', 'error'):
        if key in value and value[key] is not None and not isinstance(value[key], str):
            raise ValueError('消息过程字段 %s 必须为文字或空值。' % key)
    if isinstance(value.get('status'), str) and (len(value['status']) > 80 or re.search(r'[\x00-\x1f\x7f]', value['status'])):
        raise ValueError('消息状态标识无效。')
    if 'pendingPlan' in value and value['pendingPlan'] is not None and not isinstance(value['pendingPlan'], dict):
        raise ValueError('消息待审阅方案必须为对象或空值。')
    if 'toolEvents' in value and (not isinstance(value['toolEvents'], list) or any(not isinstance(event, dict) for event in value['toolEvents'])):
        raise ValueError('消息工具历史必须为对象数组。')
    if 'capabilities' in value and (not isinstance(value['capabilities'], dict) or any(type(flag) is not bool for flag in value['capabilities'].values())):
        raise ValueError('消息能力记录必须为布尔值对象。')
    if len(dump(value).encode('utf-8')) > MESSAGE_ENTITY_BYTES:
        raise ValueError('含过程历史的消息不能超过 4 MiB，请保留原记录后分批处理。')
    pending = [(value, 0)]; count = 0
    while pending:
        item, depth = pending.pop(); count += 1
        children = list(item.values()) if isinstance(item, dict) else item if isinstance(item, list) else []
        if depth > 32 or count + len(pending) + len(children) > 20000:
            raise ValueError('消息过程历史超出深度 32 或 20000 个 JSON 值的限制。')
        pending.extend((child, depth + 1) for child in children)


class ConflictRevisionError(ValueError):
    """A choice must refer to exactly the two versions the user reviewed."""
    def __init__(self, changed=False):
        super().__init__('冲突版本已变化，请重新查看两边内容后再选择。' if changed else '请重新打开冲突比较，取得有效的版本标识后再选择。')
        self.code = 'CONFLICT_CHANGED' if changed else 'INVALID_CONFLICT_REVISION'
        self.status = 409 if changed else 400


def validate_conflict_revision(revision):
    if not isinstance(revision, str) or DIGEST.fullmatch(revision) is None:
        raise ConflictRevisionError()

@lru_cache(maxsize=32768)
def _cached_wire_id(parent, identifier):
    return uuid.uuid5(uuid.NAMESPACE_URL, dump([parent, identifier])).hex

def wire_id(parent, identifier):
    # IDs remain exactly compatible with existing peers. Bound both entry count
    # and cached key length; uncommon legacy ID shapes retain the uncached path.
    if isinstance(parent, str) and isinstance(identifier, str) and len(parent) <= 200 and len(identifier) <= 200:
        return _cached_wire_id(parent, identifier)
    return uuid.uuid5(uuid.NAMESPACE_URL, dump([parent, identifier])).hex

@lru_cache(maxsize=4096)
def public_key(key):
    normalized = re.sub('[^a-z]', '', key.lower())
    return not key.startswith('_') and normalized not in SENSITIVE and not normalized.endswith(('apikey', 'accesstoken', 'refreshtoken', 'password', 'clientsecret'))

def _provenance_fields(value, strings=None, integers=(), booleans=()):
    """Copy only typed scalar metadata; unknown nested objects never leave here."""
    if not isinstance(value, dict): return {}
    result = {}
    for key, limit in (strings or {}).items():
        item = value.get(key)
        if key not in value or not public_key(key): continue
        if item is None: result[key] = None
        elif isinstance(item, str) and not re.search(r'[\x00-\x1f\x7f]', item): result[key] = item[:limit]
    for key in integers:
        item = value.get(key)
        if key in value and (item is None or type(item) is int and 0 <= item <= 9007199254740991): result[key] = item
    for key in booleans:
        if type(value.get(key)) is bool: result[key] = value[key]
    return result

def clean_provenance(value):
    """Portable v1 provenance only, including when nested in note history.

    This is a sync projection, not a mutation of the device's exact snapshot.
    Local file identities can embed paths in id/refKey/title, so none of those
    navigation fields are sent to another device.
    """
    if not isinstance(value, dict) or type(value.get('version')) is not int or value['version'] != 1: return None
    output = _provenance_fields(value.get('output'), {'type': 20, 'id': 200, 'variant': 20})
    if output.get('type') not in ('note', 'paper', 'task') or not output.get('id') or output.get('variant') not in ('body', 'draft'): return None
    origin = _provenance_fields(value.get('origin'), {'runId': 200, 'conversationId': 200, 'userMessageId': 200, 'model': 160, 'provider': 80, 'effort': 40}, ('at',), ('recorded', 'private'))
    if origin.get('recorded') is not True or not origin.get('runId'): return None
    result = _provenance_fields(value, {'operation': 20, 'outputStamp': 160}, ('omittedInputs',), ('evidenceLimitReached', 'evidenceExcerptLimitReached'))
    if result.get('operation') not in ('created', 'updated', 'drafted', 'captured'): result.pop('operation', None)
    result.update(version=1, output=output, origin=origin, inputs=[])
    inputs = value.get('inputs')
    seen = set()
    # Excerpt budgets apply to retained text, not to the supplied-page index.
    # Keep every validated metadata record, including pages after the old 128
    # item boundary. Deduplicate only identical portable projections so a new
    # page, version, evidence ID or capture state never disappears in transit.
    for raw in inputs if isinstance(inputs, list) else []:
        if not isinstance(raw, dict) or raw.get('provided') is not True or raw.get('type') not in ('note', 'paper', 'task', 'import', 'local'): continue
        item = _provenance_fields(raw, {'type': 20, 'id': 200, 'title': 240, 'sourceId': 200, 'projectId': 200, 'variant': 20, 'version': 300, 'origin': 80, 'media': 40, 'bodyHash': 80, 'bodyVariant': 20, 'bodyFormat': 40, 'excerptState': 20, 'textRepresentation': 40}, ('page', 'offset', 'end', 'capturedAt', 'excerptCharacters'), ('provided', 'private'))
        if item.get('variant') not in ('current', 'draft'): item.pop('variant', None)
        if item.get('bodyVariant') not in ('current', 'draft'): item.pop('bodyVariant', None)
        if item.get('bodyFormat') != 'canonical-v1': item.pop('bodyFormat', None)
        if item.get('excerptState') not in ('retained', 'omitted'): item.pop('excerptState', None)
        if item.get('textRepresentation') != 'normalized-page': item.pop('textRepresentation', None)
        if type(item.get('excerptCharacters')) is not int: item.pop('excerptCharacters', None)
        if item.get('media') not in (None, 'page_image', 'original_file', 'original_image'): item.pop('media', None)
        if item.get('variant') == 'draft' and item.get('bodyVariant') != 'draft': item.pop('bodyHash', None)
        if item['type'] == 'local':
            item.pop('id', None); item.pop('title', None)
            if not isinstance(item.get('version'), str) or not DIGEST.fullmatch(item['version']): item.pop('version', None)
        elif not item.get('id'): continue
        identity = dump(item)
        if identity in seen: continue
        seen.add(identity)
        result['inputs'].append(item)
    return result

def clean(value, depth=0, provenance_context=None):
    if depth > 40: raise ValueError('同步内容嵌套过深。')
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if not isinstance(key, str) or not public_key(key): continue
            if key == 'provenance':
                projected = clean_provenance(item) if provenance_context in ('artifact', 'note', 'draft-history-entry') else None
                if projected is not None: result[key] = projected
            else:
                context = None
                if provenance_context == 'note': context = {'aiDraft': 'artifact', 'revisionHistory': 'history', 'aiDraftHistory': 'draft-history'}.get(key)
                elif provenance_context == 'draft-history-entry' and key == 'draft': context = 'artifact'
                result[key] = clean(item, depth+1, context)
        return result
    if isinstance(value, list):
        context = {'history': 'artifact', 'draft-history': 'draft-history-entry'}.get(provenance_context)
        return [clean(item, depth+1, context) for item in value]
    return value

def conversation_context(value):
    """Portable explicit references, never copied content or local file paths.

    Reject a malformed selection as a whole: dropping invalid keys could turn
    an explicitly scoped discussion into an unrestricted one on another device.
    The same bounded v1 contract is enforced by the mobile and Mac consumers.
    """
    def invalid(): raise ValueError('会话引用或返回来源格式无效，请重新选择资料。')
    if (not isinstance(value, dict) or set(value) != {'version', 'keys', 'source'}
            or type(value.get('version')) is not int or value['version'] != 1
            or not isinstance(value.get('keys'), list) or len(value['keys']) > 50): invalid()
    keys = []
    for key in value['keys']:
        if not isinstance(key, str) or re.fullmatch(r'(notes|imports):[A-Za-z0-9_-]{1,200}', key) is None: invalid()
        if key not in keys: keys.append(key)
    source = value['source']
    if source is not None:
        if (not isinstance(source, dict) or set(source) - {'kind', 'id', 'conversationId'}
                or source.get('kind') != 'notes' or not isinstance(source.get('id'), str)
                or IDENTIFIER.fullmatch(source['id']) is None
                or 'conversationId' in source and (not isinstance(source['conversationId'], str)
                    or IDENTIFIER.fullmatch(source['conversationId']) is None)): invalid()
        source = copy(source)
    return {'version': 1, 'keys': keys, 'source': source}

def record(kind, item):
    if not isinstance(item, dict): raise ValueError('同步记录格式无效。')
    if kind == 'folders' and item.get('kind') == 'library':
        folder = item.get('folderPath')
        if (not isinstance(folder, str) or not folder or len(folder) > 240 or re.search(r'[\x00-\x1f\x7f]', folder)
                or any(part in ('', '.', '..') or part != part.strip() for part in folder.split('/')) or '\\' in folder
                or len(folder.split('/')) > 6 or item.get('workspace') not in ('日常', '课程', '科研')
                or item.get('projectId') is not None and (not isinstance(item['projectId'], str) or not IDENTIFIER.fullmatch(item['projectId']))):
            raise ValueError('资料目录归属或路径无效。')
    # Validate the raw value, before generic sensitive-field filtering can
    # conceal an unexpected field inside an otherwise valid reference object.
    mobile_context = conversation_context(item['mobileContext']) if kind == 'conversations' and 'mobileContext' in item else None
    context = 'note' if kind == 'notes' else 'artifact' if kind in ('tasks', 'papers') else None
    result = clean({key: value for key, value in item.items() if key in FIELDS[kind]}, provenance_context=context)
    if mobile_context is not None: result['mobileContext'] = mobile_context
    if kind == 'messages':
        if 'content' in result and 'text' in result:
            if result['content'] != result['text']: raise MessageBodyConflict()
            result.pop('text')
        if any(key in result for key in MESSAGE_PROCESS_FIELDS):
            if result.get('pendingPlan') != item.get('pendingPlan'):
                _invalidate_message_plan(result, 'metadata-redacted')
            _validate_message_process(result)
    if kind == 'tasks':
        # Missing inherits each device's default; null explicitly disables it.
        # Match the portable agenda range and reject booleans/fractional values.
        if 'reminderMinutes' in item:
            minutes = item['reminderMinutes']
            if minutes is not None and (type(minutes) is not int or not 0 <= minutes <= 10080):
                raise ValueError('任务提醒必须为 0 到 10080 的整数分钟，或为空以关闭提醒。')
            result['reminderMinutes'] = minutes
        # Only the category identity syncs, never the external-inbox source ID.
        # Explicit null means a deliberate removal and must outrank provenance.
        if 'workflowCategory' in item:
            category = item['workflowCategory']
            if category is not None and (not isinstance(category, str) or category not in ('P0', 'P1', 'P2', 'P3')):
                raise ValueError('任务分类无效。')
            result['workflowCategory'] = category
        elif isinstance(item.get('sourceTaskInbox'), dict) and item['sourceTaskInbox'].get('category') in ('P0', 'P1', 'P2', 'P3'):
            result['workflowCategory'] = item['sourceTaskInbox']['category']
    if kind == 'folders' and item.get('kind') == 'library':
        result.update({key: item.get(key) for key in ('folderPath', 'workspace', 'projectId')})
    if kind == 'trash':
        data = item.get('data') or {}; result['data'] = {}
        for key in COLLECTIONS:
            if key == 'trash': continue
            if isinstance(data.get(key), list):
                result['data'][key] = [record(key, entry) for entry in data[key]]
                if key == 'conversations':
                    for value, original in zip(result['data'][key], data[key]):
                        value['messages'] = [record('messages', m) for m in original.get('messages', [])]
        for key in ('attachmentMemberships', 'sharedImports', 'sharedImportMoves'):
            if isinstance(data.get(key), list): result['data'][key] = clean(data[key])
        if isinstance(data.get('consolidation'), dict):
            result['data']['consolidation'] = clean({key: value for key, value in data['consolidation'].items()
                if key in ('canonicalId', 'mergedAt', 'sections', 'linkHistory', 'rewired')})
    return result

def all_imports(snapshot):
    yield from snapshot.get('imports', [])
    for entry in snapshot.get('trash', []): yield from (entry.get('data') or {}).get('imports', [])

def public_library_folder(snapshot, folder):
    def hidden(value):
        return any(value.get(key) for key in ('private', 'ephemeral', 'incognito', 'deleted', 'deletedAt', 'archived', 'archivedAt')) or value.get('status') in ('archived', 'deleted')
    def inherited_private(value):
        # Same privacy ancestry as the reader: a public-looking source may
        # originate in a private run or conversation, including retired owners.
        queue, seen = [value], set()
        for row in queue:
            if not isinstance(row, dict) or id(row) in seen: continue
            seen.add(id(row))
            if any(row.get(key) for key in ('private', 'ephemeral', 'incognito')): return True
            provenance = row.get('provenance')
            if isinstance(provenance, dict): queue.append(provenance.get('origin'))
            for kind, key in (('projects','projectId'), ('agentRuns','agentRunId'), ('agentRuns','runId'), ('conversations','sourceConversationId'), ('conversations','conversationId')):
                identifier = row.get(key)
                if not identifier: continue
                values = list(snapshot.get(kind, []))
                if kind == 'agentRuns': values += snapshot.get('runs', [])
                for bundle in snapshot.get('trash', []):
                    values += (bundle.get('data') or {}).get(kind, [])
                    if kind == 'agentRuns': values += (bundle.get('data') or {}).get('runs', [])
                queue.extend(item for item in values if item.get('id') == identifier)
        return False
    if hidden(folder): return False
    if folder.get('projectId'):
        projects = [p for p in snapshot.get('projects', []) if p.get('id') == folder['projectId']]
        if len(projects) != 1: return False
        project = projects[0]
        if hidden(project) or inherited_private(project): return False
        if project.get('workspace') != folder.get('workspace'): return False
    for kind in ('imports', 'notes', 'papers'):
        members = snapshot.get(kind, [])
        for item in members:
            path = item.get('folderPath') or ('原始资料' if kind == 'imports' else '')
            if not isinstance(path, str): continue
            if (item.get('projectId') or None) != (folder.get('projectId') or None): continue
            workspace = project.get('workspace') if folder.get('projectId') else item.get('workspace', '日常')
            if workspace != folder.get('workspace') or not (path == folder.get('folderPath') or path.startswith(str(folder.get('folderPath')) + '/')): continue
            if hidden(item) or inherited_private(item) or sum(row.get('id') == item.get('id') for row in members) != 1: return False
    return True

def project(snapshot):
    output = {}
    for kind in COLLECTIONS:
        for item in snapshot.get(kind, []):
            identifier = item.get('id') if isinstance(item, dict) else None
            if not isinstance(identifier, str) or not IDENTIFIER.fullmatch(identifier):
                # Legacy trash and message IDs are assigned by the UI migration.
                raise ValueError('记录缺少稳定 ID，请重新打开工作站完成数据迁移。')
            key = (kind, identifier)
            if key in output: raise ValueError('工作站中存在重复 ID，请先处理重复记录。')
            output[key] = record(kind, item)
            if kind == 'conversations':
                for position, message in enumerate(item.get('messages', [])):
                    mid = message.get('id')
                    if not mid: raise ValueError('消息缺少稳定 ID。')
                    wire = wire_id(identifier, mid)
                    if ('messages', wire) in output: raise ValueError('同一对话存在重复消息 ID。')
                    output[('messages', wire)] = record('messages', {**message, 'conversationId': identifier, 'position': position})
    library_scopes = set()
    for group in ('projects', 'conversations', 'library'):
        for folder in (snapshot.get('folders') or {}).get(group, []):
            if group == 'library':
                if not public_library_folder(snapshot, folder): continue
                scope = dump([folder.get('workspace'), folder.get('projectId'), folder.get('folderPath')])
                if scope in library_scopes: raise ValueError('同一位置存在重复资料目录。')
                library_scopes.add(scope)
            if not folder.get('id'): raise ValueError('文件夹缺少稳定 ID。')
            wire = wire_id(group, folder['id'])
            if ('folders', wire) in output: raise ValueError('同类文件夹存在重复 ID。')
            output[('folders', wire)] = record('folders', {**folder, 'kind': group})
    return output

class SyncStore:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.path = self.directory / 'workspace.sqlite3'
        self._hash_cache = {}
    @contextmanager
    def db(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        # BEGIN IMMEDIATE serializes transactions, but WAL configuration and
        # schema setup happen before it. A simultaneous first status request
        # can otherwise fail that configuration with SQLITE_BUSY. Cover the
        # whole connection lifetime across threads, instances and processes;
        # closing the descriptor also releases the lock after exceptions.
        descriptor = os.open(self.directory / '.sqlite.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            with self._connection() as connection:
                yield connection
        finally: os.close(descriptor)
    @contextmanager
    def _connection(self):
        if self.path.is_symlink(): raise ValueError('工作站数据库不能是符号链接。')
        connection = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        connection.row_factory = sqlite3.Row
        try:
            os.chmod(self.path, 0o600)
            connection.execute('PRAGMA journal_mode=WAL')
            connection.execute('PRAGMA synchronous=FULL')
            connection.executescript('''
                CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS entities (kind TEXT, id TEXT, data TEXT, deleted INTEGER NOT NULL DEFAULT 0, remote_version INTEGER NOT NULL DEFAULT 0, remote_data TEXT, remote_deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(kind,id));
                CREATE TABLE IF NOT EXISTS outbox (op_id TEXT PRIMARY KEY, kind TEXT NOT NULL, id TEXT NOT NULL, base_version INTEGER NOT NULL, data TEXT, deleted INTEGER NOT NULL, blocked INTEGER NOT NULL DEFAULT 0, UNIQUE(kind,id));
                CREATE TABLE IF NOT EXISTS sent (op_id TEXT PRIMARY KEY, kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT, deleted INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS conflicts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, entity_id TEXT NOT NULL, remote_version INTEGER NOT NULL, remote_data TEXT, remote_deleted INTEGER NOT NULL, UNIQUE(kind,entity_id));
                CREATE TABLE IF NOT EXISTS incoming_groups (group_id TEXT PRIMARY KEY, first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL, envelope TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS incoming_group_members (group_id TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL, PRIMARY KEY(group_id,kind,entity_id));
                CREATE INDEX IF NOT EXISTS incoming_group_member_record ON incoming_group_members(kind,entity_id);
                CREATE TRIGGER IF NOT EXISTS capture_projection_insert AFTER INSERT ON entities BEGIN DELETE FROM meta WHERE key='captureProjectionDigest'; END;
                CREATE TRIGGER IF NOT EXISTS capture_projection_update AFTER UPDATE ON entities BEGIN DELETE FROM meta WHERE key='captureProjectionDigest'; END;
                CREATE TRIGGER IF NOT EXISTS capture_projection_delete AFTER DELETE ON entities BEGIN DELETE FROM meta WHERE key='captureProjectionDigest'; END;
            ''')
            connection.execute('BEGIN IMMEDIATE')
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback(); raise
        finally: connection.close()
    def _get(self, db, key, default=None):
        row = db.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
        return json.loads(row['value']) if row else default
    def _put(self, db, key, value): db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', (key,dump(value)))
    def snapshot(self):
        if not self.path.exists(): return None
        with self.db() as db: return self._read_message_aliases(self._get(db, 'snapshot'))
    @staticmethod
    def _read_message_aliases(snapshot):
        # Existing databases may predate the display alias. Make old phone
        # bodies visible immediately without creating a version or rewriting
        # persisted data. Preserve differing existing fields for capture's
        # baseline comparison instead of guessing which text the user edited.
        if snapshot is not None:
            for conversation in snapshot.get('conversations', []):
                for message in conversation.get('messages', []):
                    if 'text' not in message and isinstance(message.get('content'), str):
                        message['text'] = message['content']
        return snapshot
    def has_snapshot(self):
        if not self.path.exists(): return False
        with self.db() as db: return db.execute("SELECT 1 FROM meta WHERE key='snapshot'").fetchone() is not None
    def file_transaction_committed(self, identifier):
        if not self.path.exists(): return False
        with self.db() as db: return self._get(db,'filetx:'+identifier,False) is True
    def forget_file_transaction(self, identifier):
        with self.db() as db: db.execute('DELETE FROM meta WHERE key=?',('filetx:'+identifier,))
    def _publish_files(self, db, callback, snapshot):
        if callback:
            identifier=callback(snapshot)
            if identifier is not None:
                if not isinstance(identifier,str) or not re.fullmatch(r'\.cloud-undo-[A-Za-z0-9_-]+',identifier):
                    raise ValueError('无效的附件事务标识。')
                self._put(db,'filetx:'+identifier,True)
            # File-backed stores attach local mappings during publication.
            self._save_snapshot(db, snapshot)
    def snapshot_at(self, revision):
        with self.db() as db:
            current=self._get(db,'snapshot')
            if current is not None and current.get('_revision',0)==revision: return self._read_message_aliases(current)
            return self._read_message_aliases(self._get(db,'history:'+str(revision)))
    def _save_snapshot(self, db, snapshot):
        serialized = dump(snapshot)
        previous = db.execute("SELECT value FROM meta WHERE key='snapshot'").fetchone()
        # Publication may attach Wiki mappings between the two saves. Keep both
        # transaction checkpoints, but do not decode and rewrite an identical
        # large snapshot when publication did not change it.
        if previous is None or previous['value'] != serialized:
            if previous is not None:
                revision = json.loads(previous['value']).get('_revision', 0)
                if revision != snapshot.get('_revision', 0):
                    # Preserve the exact committed baseline inside this SQLite
                    # transaction instead of another JSON round trip.
                    db.execute("INSERT OR REPLACE INTO meta(key,value) SELECT ?,value FROM meta WHERE key='snapshot'", ('history:'+str(revision),))
            db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', ('snapshot', serialized))
        size=0
        rows=db.execute("SELECT key,length(CAST(value AS BLOB)) AS size FROM meta WHERE key LIKE 'history:%' ORDER BY CAST(substr(key,9) AS INTEGER) DESC").fetchall()
        for index,row in enumerate(rows):
            size+=row['size']
            if index>=30 or size>64*1024*1024: db.execute('DELETE FROM meta WHERE key=?',(row['key'],))
    def bind_target(self, target):
        with self.db() as db:
            old = self._get(db, 'target')
            if old and old != target: raise ValueError('此本地工作区已绑定另一个同步账号或服务器。请使用独立工作区，避免混合不同账号的数据。')
            self._put(db, 'target', target)
    def _enqueue(self, db, kind, identifier, data, deleted, version, blocked=0):
        db.execute('DELETE FROM outbox WHERE kind=? AND id=?', (kind,identifier))
        db.execute('INSERT INTO outbox VALUES (?,?,?,?,?,?,?)', (new_id(),kind,identifier,version,data,int(deleted),blocked))
    def _with_hashes(self, snapshot):
        snapshot = copy(snapshot)
        # Assign missing legacy IDs once, as part of the migration transaction.
        for kind in COLLECTIONS:
            for item in snapshot.get(kind, []):
                if not item.get('id'): item['id'] = new_id()
                if kind == 'conversations':
                    for message in item.get('messages', []):
                        if not message.get('id'): message['id'] = new_id()
        for folders in (snapshot.get('folders') or {}).values():
            if isinstance(folders, list):
                for folder in folders:
                    if not folder.get('id'): folder['id'] = new_id()
        files = self.directory / 'files'
        for item in all_imports(snapshot):
            fid = item.get('id', '')
            if not isinstance(fid, str) or not IDENTIFIER.fullmatch(fid): continue
            source = files / fid
            if source.is_file() and not files.is_symlink() and not source.is_symlink():
                stat = source.stat(); identity = (str(source), stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size)
                digest = self._hash_cache.get(identity)
                if digest is None:
                    h = hashlib.sha256()
                    with source.open('rb') as stream:
                        for chunk in iter(lambda: stream.read(1024*1024), b''): h.update(chunk)
                    digest = h.hexdigest(); self._hash_cache[identity] = digest
                    if len(self._hash_cache) > 10000: self._hash_cache = {identity:digest}
                item['blobHash'] = digest; item['size'] = stat.st_size
        return snapshot
    def capture(self, snapshot, before_commit=None):
        snapshot = self._with_hashes(snapshot)
        for conversation in snapshot.get('conversations', []):
            for message in conversation.get('messages', []):
                plan = message.get('pendingPlan')
                if isinstance(plan, dict) and clean(plan) != plan:
                    _invalidate_message_plan(message, 'metadata-redacted')
        def projection():
            values = {key: dump(value) for key, value in project(snapshot).items()}
            digest = hashlib.sha256(b'capture-projection-v1\0')
            for (kind, identifier), value in sorted(values.items()):
                digest.update(kind.encode() + b'\0' + identifier.encode() + b'\0' + value.encode('utf-8') + b'\0')
            return values, digest.hexdigest()
        try: values, fingerprint = projection()
        except MessageBodyConflict:
            # The canonical baseline below can resolve a one-sided alias edit.
            values, fingerprint = None, None
        with self.db() as db:
            # The trigger invalidates this transactional certificate on *every*
            # entity write, including sync, other processes and older clients.
            # Matching projections may skip only entity/outbox comparison; all
            # snapshot history, file publication and FULL commit still happen.
            if values is None or self._get(db, 'captureProjectionDigest') != fingerprint:
                self._reconcile_conversation_context(db, snapshot)
                self._reconcile_message_process(db, snapshot)
                values, fingerprint = projection()
                if self._get(db, 'captureProjectionDigest') != fingerprint:
                    self._capture_entities(db, values)
                    self._put(db, 'captureProjectionDigest', fingerprint)
            for conversation in snapshot.get('conversations', []):
                for message in conversation.get('messages', []): _message_text_alias(message)
            self._save_snapshot(db,snapshot)
            if before_commit: before_commit(snapshot)
            self._save_snapshot(db,snapshot)
        return snapshot
    def _reconcile_conversation_context(self, db, snapshot):
        # Older renderers may reconstruct a conversation without newer fields.
        # Preserve the authoritative selection on that local save; an explicit
        # empty v1 context clears it. Incoming remote omission still clears the
        # field through _assemble(), where it is now a synchronized field.
        conversations = {item['id']: item for item in snapshot.get('conversations', [])}
        for row in db.execute("SELECT id,data FROM entities WHERE kind='conversations' AND deleted=0"):
            current = conversations.get(row['id'])
            if current is None or 'mobileContext' in current: continue
            old = json.loads(row['data'])
            if 'mobileContext' in old: current['mobileContext'] = conversation_context(old['mobileContext'])
    def _reconcile_message_process(self, db, snapshot):
        # An old renderer may omit unfamiliar fields on save. Recover them from
        # the authoritative entity in this transaction, never from another chat
        # or a deleted record. A normal continuation merely appends messages.
        conversations = {conversation['id']: conversation for conversation in snapshot.get('conversations', [])}
        messages = {wire_id(cid, message['id']): (cid, message) for cid, conversation in conversations.items()
                    for message in conversation.get('messages', [])}
        changed = set()
        for row in db.execute("SELECT id,data FROM entities WHERE kind='messages' AND deleted=0"):
            old = json.loads(row['data'])
            current = messages.get(row['id'])
            if current is None:
                if old.get('conversationId') in conversations: changed.add(old['conversationId'])
                continue
            cid, message = current
            baseline = _message_body(old)
            candidates = [message[key] for key in ('content', 'text') if key in message]
            if candidates:
                if len(candidates) == 2 and candidates[0] != candidates[1]:
                    edited = [value for value in candidates if value != baseline]
                    if len(edited) != 1: raise MessageBodyConflict()
                    body = edited[0]
                else: body = candidates[0]
                # Preserve the original wire spelling. A content-only phone
                # message stays content-only despite Mac's display alias.
                if 'content' in old:
                    message['content'] = body
                    if 'text' in message: message['text'] = body
                elif 'text' in old:
                    message['text'] = body; message.pop('content', None)
                if body != baseline: changed.add(cid)
            elif 'content' in old or 'text' in old: changed.add(cid)
            if message.get('role') != old.get('role'): changed.add(cid)
            for key in MESSAGE_PROCESS_FIELDS:
                if key not in message and key in old: message[key] = copy(old[key])
            prior, proposed = old.get('pendingPlan'), message.get('pendingPlan')
            if (isinstance(prior, dict) and isinstance(proposed, dict) and prior.get('id') == proposed.get('id')
                    and prior.get('status') != 'pending' and proposed.get('status') == 'pending'):
                # Replaying an older UI snapshot cannot re-arm a terminal plan.
                message['pendingPlan'] = copy(prior)
        for cid in changed:
            for message in conversations[cid].get('messages', []):
                _invalidate_message_plan(message, 'conversation-message-edited')
    def _capture_entities(self, db, values):
        # Compare canonical JSON as UTF-8 bytes, without decoding every old
        # body or loading remote_data (unused by local capture). Restore the
        # connection's text factory before all other queries/publication.
        factory = db.text_factory
        try:
            db.text_factory = bytes
            rows = {(r['kind'].decode(), r['id'].decode()): r for r in db.execute('SELECT kind,id,data,deleted,remote_version FROM entities')}
        finally: db.text_factory = factory
        for key in set(values) | set(rows):
            kind, identifier = key; row = rows.get(key)
            deleted = key not in values; value = None if deleted else values[key]
            encoded = value.encode('utf-8') if value is not None else None
            if row and row['data'] == encoded and bool(row['deleted']) == deleted: continue
            version = row['remote_version'] if row else 0
            db.execute('INSERT INTO entities(kind,id,data,deleted) VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,deleted=excluded.deleted', (kind,identifier,value,int(deleted)))
            conflict = db.execute('SELECT 1 FROM conflicts WHERE kind=? AND entity_id=?',key).fetchone()
            # Even permanent local deletion is represented by a tombstone.
            self._enqueue(db,kind,identifier,value,deleted,version,int(bool(conflict)))
    def pending(self, limit=100):
        with self.db() as db:
            rows = db.execute('SELECT * FROM outbox WHERE blocked=0 ORDER BY rowid LIMIT ?', (max(1,min(100,int(limit))),)).fetchall()
            result = []; payload_bytes = 0
            for row in rows:
                size = len((row['data'] or '').encode()) + 500
                if result and payload_bytes + size > 8 * 1024 * 1024: break
                payload_bytes += size
                db.execute('INSERT OR IGNORE INTO sent VALUES (?,?,?,?,?)',(row['op_id'],row['kind'],row['id'],row['data'],row['deleted']))
                result.append({'opId':row['op_id'],'entityType':row['kind'],'entityId':row['id'],'baseVersion':row['base_version'],'data':json.loads(row['data']) if row['data'] else None,'deleted':bool(row['deleted'])})
            return result
    def _conflict(self, db, kind, identifier, version, data, deleted):
        row = db.execute('SELECT id FROM conflicts WHERE kind=? AND entity_id=?',(kind,identifier)).fetchone()
        latest=db.execute('SELECT remote_version FROM conflicts WHERE kind=? AND entity_id=?',(kind,identifier)).fetchone()
        if latest and latest['remote_version'] >= version: return
        cid = row['id'] if row else new_id()
        db.execute('INSERT OR REPLACE INTO conflicts VALUES (?,?,?,?,?,?)',(cid,kind,identifier,version,data,int(deleted)))
        db.execute('UPDATE outbox SET blocked=1 WHERE kind=? AND id=?',(kind,identifier))
    def ack(self, accepted, conflicts=None):
        with self.db() as db:
            for answer in accepted:
                sent = db.execute('SELECT * FROM sent WHERE op_id=?',(answer['opId'],)).fetchone()
                if not sent: continue
                key=(sent['kind'],sent['id']); entity=db.execute('SELECT * FROM entities WHERE kind=? AND id=?',key).fetchone()
                version=answer['version']
                if not isinstance(version,int) or isinstance(version,bool) or version<1: raise ValueError('同步服务器版本无效。')
                if not entity or version < entity['remote_version']: continue
                db.execute('UPDATE entities SET remote_version=?,remote_data=?,remote_deleted=? WHERE kind=? AND id=?',(version,sent['data'],sent['deleted'],*key))
                if self._group_locked(db,*key): self._conflict(db,*key,version,sent['data'],sent['deleted'])
                current=db.execute('SELECT * FROM outbox WHERE kind=? AND id=?',key).fetchone()
                if current:
                    if current['op_id']==answer['opId'] or (current['data']==sent['data'] and current['deleted']==sent['deleted']): db.execute('DELETE FROM outbox WHERE kind=? AND id=?',key)
                    else: self._enqueue(db,*key,current['data'],current['deleted'],version,current['blocked'])
                db.execute('DELETE FROM sent WHERE op_id=?',(answer['opId'],))
            for conflict in conflicts or []:
                sent=db.execute('SELECT * FROM sent WHERE op_id=?',(conflict['opId'],)).fetchone()
                if not sent: continue
                remote=conflict['remote']; value=None if remote.get('deleted') else dump(record(sent['kind'],remote['data']))
                self._conflict(db,sent['kind'],sent['id'],remote['version'],value,remote.get('deleted',False))
                db.execute('DELETE FROM sent WHERE op_id=?',(conflict['opId'],))
    def _assemble(self, db, previous):
        snapshot=copy(previous or {})
        existing={kind:{item['id']:item for item in snapshot.get(kind,[])} for kind in COLLECTIONS}
        old_messages={uuid.uuid5(uuid.NAMESPACE_URL,dump([conversation['id'],message['id']])).hex:message for conversation in previous.get('conversations',[]) for message in conversation.get('messages',[]) if message.get('id')}
        grouped={kind:[] for kind in FIELDS}
        for row in db.execute('SELECT * FROM entities WHERE deleted=0 ORDER BY rowid'):
            item=json.loads(row['data']); old=old_messages.get(row['id'],{}) if row['kind']=='messages' else existing.get(row['kind'],{}).get(item.get('id'),{})
            # Keep fields which are intentionally device-local. Synced fields
            # absent in the remote record must not leak back from old data.
            local={k:v for k,v in old.items() if k not in FIELDS[row['kind']]}
            if row['kind']=='conversations': local.pop('messages',None)
            if row['kind']=='trash':
                # Preserve original directory bindings only on their own device.
                old_projects={p['id']:p for p in old.get('data',{}).get('projects',[])}
                for project_item in item.get('data',{}).get('projects',[]):
                    prior=old_projects.get(project_item.get('id'),{})
                    if 'localFolder' in prior: project_item['localFolder']=prior['localFolder']
                # Creation receipts remain local even while a note is trashed.
                # Restoring the same capture must still resolve a lost native
                # acknowledgement, without copying old content over peer edits.
                old_notes={n['id']:n for n in old.get('data',{}).get('notes',[])}
                for note_item in item.get('data',{}).get('notes',[]):
                    prior=old_notes.get(note_item.get('id'),{})
                    for key in ('sourceQuickCaptureId','quickCaptureFingerprint'):
                        if key in prior: note_item[key]=prior[key]
            grouped[row['kind']].append({**local,**item})
        for kind in COLLECTIONS: snapshot[kind]=grouped[kind]
        by_conv={}
        for message in grouped['messages']: by_conv.setdefault(message['conversationId'],[]).append(message)
        for conversation in snapshot['conversations']:
            messages=sorted(by_conv.get(conversation['id'],[]),key=lambda m:(m.get('position',0),m.get('createdAt',0),m['id']))
            conversation['messages']=[_message_text_alias({k:v for k,v in m.items() if k not in ('position','conversationId')}) for m in messages]
        snapshot['folders']={kind:[{k:v for k,v in item.items() if k!='kind'} for item in grouped['folders'] if item.get('kind')==kind] for kind in ('projects','conversations')}
        library=[{k:v for k,v in item.items() if k!='kind'} for item in grouped['folders'] if item.get('kind')=='library']
        # Private or orphaned directory metadata stays local, including when an
        # unrelated remote record causes reconstruction of this snapshot.
        local_folders=[item for item in previous.get('folders',{}).get('library',[]) if not public_library_folder(previous,item)]
        if library or 'library' in previous.get('folders',{}):
            local_ids={item['id'] for item in local_folders}
            snapshot['folders']['library']=local_folders+[item for item in library if item['id'] not in local_ids]
        snapshot.setdefault('agentRuns',[])
        return snapshot
    @staticmethod
    def _group_locked(db, kind, identifier):
        return db.execute('SELECT 1 FROM incoming_group_members WHERE kind=? AND entity_id=?',(kind,identifier)).fetchone() is not None

    @staticmethod
    def _incoming_change(change):
        if not isinstance(change,dict): raise ValueError('未知同步记录。')
        kind,identifier=change.get('entityType'),change.get('entityId')
        if not isinstance(kind,str) or kind not in FIELDS or not isinstance(identifier,str) or not IDENTIFIER.fullmatch(identifier): raise ValueError('未知同步记录。')
        version=change.get('version'); deleted=change.get('deleted')
        if type(version) is not int or not 1<=version<=9007199254740991 or type(deleted) is not bool: raise ValueError('无效同步版本。')
        if deleted and change.get('data') is not None: raise ValueError('删除记录内容必须为空。')
        value=None if deleted else dump(record(kind,change.get('data')))
        return kind,identifier,version,deleted,value

    def _receive_group(self, db, envelope, cursor):
        if (set(envelope)!={'type','groupId','firstSeq','lastSeq','changes'} or not isinstance(envelope.get('groupId'),str)
                or not IDENTIFIER.fullmatch(envelope['groupId']) or not isinstance(envelope.get('changes'),list)
                or not 1<=len(envelope['changes'])<=100 or type(envelope.get('firstSeq')) is not int or envelope['firstSeq']<1
                or type(envelope.get('lastSeq')) is not int or envelope['lastSeq']!=envelope['firstSeq']+len(envelope['changes'])-1
                or envelope['lastSeq']>cursor): raise ValueError('原子同步组格式无效。')
        values=[self._incoming_change(change) for change in envelope['changes']]
        if len({item[:2] for item in values})!=len(values) or any(type(change.get('seq')) is not int or change['seq']!=envelope['firstSeq']+index for index,change in enumerate(envelope['changes'])):
            raise ValueError('原子同步组成员或序列不完整。')
        encoded=dump(envelope)
        if len(encoded.encode('utf-8'))>16*1024*1024: raise ValueError('原子同步组超过大小限制。')
        prior=db.execute('SELECT envelope FROM incoming_groups WHERE group_id=?',(envelope['groupId'],)).fetchone()
        if prior and prior['envelope']!=encoded: raise ValueError('原子同步组标识被用于不同内容。')
        rows={item[:2]:db.execute('SELECT * FROM entities WHERE kind=? AND id=?',item[:2]).fetchone() for item in values}
        # A replay of a group already observed completely must not turn later
        # local edits into a new conflict against obsolete history.
        if not prior and all(rows[item[:2]] and rows[item[:2]]['remote_version']>=item[2] for item in values) and not any(self._group_locked(db,*item[:2]) for item in values): return False
        blocked=bool(prior) or any(self._group_locked(db,*item[:2]) or
            db.execute('SELECT 1 FROM outbox WHERE kind=? AND id=?',item[:2]).fetchone() or
            db.execute('SELECT 1 FROM sent WHERE kind=? AND id=?',item[:2]).fetchone() or
            db.execute('SELECT 1 FROM conflicts WHERE kind=? AND entity_id=?',item[:2]).fetchone() for item in values)
        if blocked:
            db.execute('INSERT OR IGNORE INTO incoming_groups VALUES(?,?,?,?)',(envelope['groupId'],envelope['firstSeq'],envelope['lastSeq'],encoded))
            for kind,identifier,version,deleted,value in values:
                db.execute('INSERT OR IGNORE INTO incoming_group_members VALUES(?,?,?)',(envelope['groupId'],kind,identifier))
                row=rows[kind,identifier]
                if row and row['remote_version']>version: version,deleted,value=row['remote_version'],bool(row['remote_deleted']),row['remote_data']
                self._conflict(db,kind,identifier,version,value,deleted)
            return False
        changed=False
        for kind,identifier,version,deleted,value in values:
            row=rows[kind,identifier]
            if row and version<=row['remote_version']: continue
            self._apply_remote(db,kind,identifier,version,value,deleted)
            changed=changed or not row or row['data']!=value or bool(row['deleted'])!=deleted
        return changed

    @staticmethod
    def _apply_remote(db, kind, identifier, version, value, deleted):
        db.execute('INSERT INTO entities VALUES (?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,deleted=excluded.deleted,remote_version=excluded.remote_version,remote_data=excluded.remote_data,remote_deleted=excluded.remote_deleted',(kind,identifier,value,int(deleted),version,value,int(deleted)))
        db.execute('DELETE FROM outbox WHERE kind=? AND id=?',(kind,identifier))
        db.execute('DELETE FROM conflicts WHERE kind=? AND entity_id=?',(kind,identifier))

    def apply_changes(self, changes, cursor, before_commit=None):
        with self.db() as db:
            previous=self._get(db,'snapshot',{}); changed=False
            last_cursor=self._get(db,'cursor',0)
            if type(cursor) is not int or cursor<last_cursor or cursor>9007199254740991 or not isinstance(changes,list): raise ValueError('无效同步游标。')
            for change in changes:
                if isinstance(change,dict) and change.get('type')=='atomic-group':
                    changed=self._receive_group(db,change,cursor) or changed
                    continue
                kind,identifier,version,deleted,value=self._incoming_change(change)
                row=db.execute('SELECT * FROM entities WHERE kind=? AND id=?',(kind,identifier)).fetchone()
                if self._group_locked(db,kind,identifier):
                    if row and row['remote_version']>version: version,deleted,value=row['remote_version'],bool(row['remote_deleted']),row['remote_data']
                    self._conflict(db,kind,identifier,version,value,deleted)
                    continue
                if row and version<=row['remote_version']: continue
                pending=db.execute('SELECT * FROM outbox WHERE kind=? AND id=?',(kind,identifier)).fetchone()
                if pending and (pending['data']!=value or bool(pending['deleted'])!=deleted):
                    self._conflict(db,kind,identifier,version,value,deleted)
                    continue
                self._apply_remote(db,kind,identifier,version,value,deleted)
                changed=changed or not row or row['data']!=value or bool(row['deleted'])!=deleted
            snapshot=self._assemble(db,previous) if changed else previous
            if changed:
                snapshot['_revision']=int(previous.get('_revision',0))+1; snapshot['_savedAt']=int(time.time()*1000)
                snapshot.pop('_pendingLocalSave',None)
                self._save_snapshot(db,snapshot); self._put(db,'remoteAppliedRevision',snapshot['_revision'])
            self._put(db,'cursor',cursor)
            self._publish_files(db,before_commit,snapshot)
            return {'changed':changed,'snapshot':snapshot}
    @staticmethod
    def _conflict_revision(conflict, local):
        # Hash only the sync projection, not the full workspace or credentials.
        # Include both deletion flags: an absent entity is not a live null body.
        value = {'id': conflict['id'], 'type': conflict['kind'], 'entityId': conflict['entity_id'],
                 'local': {'data': local['data'], 'deleted': bool(local['deleted'])} if local else None,
                 'remote': {'data': conflict['remote_data'], 'deleted': bool(conflict['remote_deleted']),
                            'version': conflict['remote_version']}}
        return hashlib.sha256(dump(value).encode('utf-8')).hexdigest()

    def _group_component(self, db, kind, identifier):
        groups={row['group_id'] for row in db.execute('SELECT group_id FROM incoming_group_members WHERE kind=? AND entity_id=?',(kind,identifier))}
        keys=set(); pending=list(groups)
        while pending:
            group_id=pending.pop()
            for row in db.execute('SELECT kind,entity_id FROM incoming_group_members WHERE group_id=?',(group_id,)):
                key=(row['kind'],row['entity_id'])
                if key in keys: continue
                keys.add(key)
                for member in db.execute('SELECT group_id FROM incoming_group_members WHERE kind=? AND entity_id=?',key):
                    if member['group_id'] not in groups: groups.add(member['group_id']); pending.append(member['group_id'])
        return sorted(groups),sorted(keys)

    def _group_conflict(self, db, group_ids, keys):
        members=[]; certificate=[]
        for kind,identifier in keys:
            conflict=db.execute('SELECT * FROM conflicts WHERE kind=? AND entity_id=?',(kind,identifier)).fetchone()
            if not conflict: raise ValueError('原子同步组冲突成员缺失，未进行恢复。')
            row=db.execute('SELECT * FROM entities WHERE kind=? AND id=?',(kind,identifier)).fetchone()
            local=json.loads(row['data']) if row and row['data'] else None
            remote=json.loads(conflict['remote_data']) if conflict['remote_data'] else None
            members.append({'id':conflict['id'],'type':kind,'entityId':identifier,
                'title':(local or remote or {}).get('title') or (local or remote or {}).get('name') or identifier,
                'local':local,'remote':remote,'remoteVersion':conflict['remote_version'],
                'localDeleted':bool(row['deleted']) if row else True,'remoteDeleted':bool(conflict['remote_deleted'])})
            certificate.append({'key':[kind,identifier],'conflict':dict(conflict),'local':dict(row) if row else None,
                'outbox':[dict(item) for item in db.execute('SELECT * FROM outbox WHERE kind=? AND id=? ORDER BY op_id',(kind,identifier))],
                'sent':[dict(item) for item in db.execute('SELECT * FROM sent WHERE kind=? AND id=? ORDER BY op_id',(kind,identifier))]})
        envelopes=[dict(db.execute('SELECT * FROM incoming_groups WHERE group_id=?',(group_id,)).fetchone()) for group_id in group_ids]
        revision=hashlib.sha256(dump({'groups':envelopes,'members':certificate}).encode('utf-8')).hexdigest()
        return {**members[0],'groupId':group_ids[0],'groupIds':group_ids,'memberCount':len(members),'groupMembers':members,'revision':revision}

    def conflicts(self):
        with self.db() as db:
            result=[]; grouped=set()
            for c in db.execute('SELECT * FROM conflicts'):
                group_ids,keys=self._group_component(db,c['kind'],c['entity_id'])
                if group_ids:
                    if group_ids[0] not in grouped:
                        result.append(self._group_conflict(db,group_ids,keys)); grouped.update(group_ids)
                    continue
                row=db.execute('SELECT data,deleted FROM entities WHERE kind=? AND id=?',(c['kind'],c['entity_id'])).fetchone()
                local=json.loads(row['data']) if row and row['data'] else None; remote=json.loads(c['remote_data']) if c['remote_data'] else None
                result.append({'id':c['id'],'type':c['kind'],'entityId':c['entity_id'],'title':(local or remote or {}).get('title') or (local or remote or {}).get('name') or c['entity_id'],'local':local,'remote':remote,'remoteVersion':c['remote_version'],'revision':self._conflict_revision(c,row)})
            return result
    def resolve_conflict(self, identifier, choice, revision=None, before_commit=None):
        if choice not in ('local','remote'): raise ValueError('请选择保留本机或使用云端版本。')
        validate_conflict_revision(revision)
        with self.db() as db:
            conflict=db.execute('SELECT * FROM conflicts WHERE id=?',(identifier,)).fetchone()
            if not conflict: raise ConflictRevisionError(changed=True)
            group_ids,keys=self._group_component(db,conflict['kind'],conflict['entity_id'])
            if group_ids:
                if choice!='remote': raise ValueError('原子操作组不能逐项保留本机版本，请比较后采用完整云端组，再重新审阅本机修改。')
                group=self._group_conflict(db,group_ids,keys)
                if group['revision']!=revision: raise ConflictRevisionError(changed=True)
                previous=self._get(db,'snapshot',{})
                self._put(db,'resolved:'+identifier,{'groupId':group['groupId'],'groupIds':group_ids,'members':group['groupMembers'],'choice':'remote','at':int(time.time()*1000)})
                for kind,entity_id in keys:
                    current=db.execute('SELECT * FROM conflicts WHERE kind=? AND entity_id=?',(kind,entity_id)).fetchone()
                    self._apply_remote(db,kind,entity_id,current['remote_version'],current['remote_data'],current['remote_deleted'])
                    db.execute('DELETE FROM sent WHERE kind=? AND id=?',(kind,entity_id))
                for group_id in group_ids:
                    db.execute('DELETE FROM incoming_group_members WHERE group_id=?',(group_id,))
                    db.execute('DELETE FROM incoming_groups WHERE group_id=?',(group_id,))
                snapshot=self._assemble(db,previous)
                snapshot['_revision']=int(previous.get('_revision',0))+1; snapshot['_savedAt']=int(time.time()*1000)
                snapshot.pop('_pendingLocalSave',None)
                self._save_snapshot(db,snapshot); self._put(db,'remoteAppliedRevision',snapshot['_revision'])
                self._publish_files(db,before_commit,snapshot)
                return {'changed':True,'snapshot':snapshot}
            key=(conflict['kind'],conflict['entity_id']); previous=self._get(db,'snapshot',{})
            local=db.execute('SELECT * FROM entities WHERE kind=? AND id=?',key).fetchone()
            # This is the authoritative CAS, inside the same write transaction
            # as resolution and before any file-publication callback runs.
            if self._conflict_revision(conflict,local) != revision:
                raise ConflictRevisionError(changed=True)
            if choice=='local':
                if not local: raise ValueError('本机记录已不存在。')
                db.execute('UPDATE entities SET remote_version=?,remote_data=?,remote_deleted=? WHERE kind=? AND id=?',(conflict['remote_version'],conflict['remote_data'],conflict['remote_deleted'],*key))
                self._enqueue(db,*key,local['data'],local['deleted'],conflict['remote_version'])
            else:
                db.execute('UPDATE entities SET data=?,deleted=?,remote_version=?,remote_data=?,remote_deleted=? WHERE kind=? AND id=?',(conflict['remote_data'],conflict['remote_deleted'],conflict['remote_version'],conflict['remote_data'],conflict['remote_deleted'],*key))
                db.execute('DELETE FROM outbox WHERE kind=? AND id=?',key)
            db.execute('DELETE FROM conflicts WHERE id=?',(identifier,))
            # Preserve both sides as a local recovery artifact, even after choice.
            self._put(db,'resolved:'+identifier,{'local':project(previous).get(key),'remote':json.loads(conflict['remote_data']) if conflict['remote_data'] else None,'choice':choice,'at':int(time.time()*1000)})
            snapshot=self._assemble(db,previous) if choice=='remote' else previous
            changed=choice=='remote'
            if changed:
                snapshot['_revision']=int(previous.get('_revision',0))+1; snapshot['_savedAt']=int(time.time()*1000)
                self._save_snapshot(db,snapshot); self._put(db,'remoteAppliedRevision',snapshot['_revision'])
            self._publish_files(db,before_commit,snapshot)
            return {'changed':changed,'snapshot':snapshot}
    def blob_manifest(self):
        result={}
        for item in all_imports(self.snapshot() or {}):
            digest=item.get('blobHash','')
            if DIGEST.fullmatch(digest): result[(item['id'],digest)]={'id':item['id'],'hash':digest,'name':item.get('name',''),'mimeType':item.get('mimeType','application/octet-stream'),'size':item.get('size',0)}
        return list(result.values())
    def status(self):
        with self.db() as db:
            return {'pending':db.execute('SELECT COUNT(*) FROM outbox').fetchone()[0],'conflicts':db.execute('SELECT COUNT(*) FROM conflicts').fetchone()[0],'cursor':self._get(db,'cursor',0),'target':self._get(db,'target'),'remoteAppliedRevision':self._get(db,'remoteAppliedRevision',0)}
