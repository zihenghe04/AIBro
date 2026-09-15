"""Local SQLite snapshot, per-record sync projection and durable outbox.

Only explicitly selected knowledge fields leave this database. Credentials,
local paths, execution permissions and renderer state stay device-local.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager

COLLECTIONS = ('projects', 'tasks', 'notes', 'imports', 'papers', 'conversations', 'attachments', 'links', 'trash', 'skills')
COMMON = set('id title name description workspace projectId project folderId folderPath createdAt updatedAt archived deletedAt tags sourceAttachmentIds sourceAttachmentId sourceConversationId agentRunId'.split())
FIELDS = {
 'projects': COMMON | set('status dueAt deadline completedAt color icon'.split()),
 'tasks': COMMON | set('status priority startAt dueAt completedAt checklist sourceNoteIds dependsOn'.split()),
 'notes': COMMON | set('content kind paperId userEdited userEditedAt revisionHistory aiDraft sourceNoteIds relatedNoteIds mergedNoteIds consolidatedSections projectMemoryType memoryDate memoryRunIds managedIndex wikiFileBacked wikiCategory wikiMigratedAt wikiImportHash wikiOriginalName wikiImportBatch'.split()),
 'imports': COMMON | set('originalName content pages parser mimeType size url warning error blobHash analysis importOrigin'.split()),
 'papers': COMMON | set('noteId authors year venue doi arxivId url sourceUrl canonicalKey metadata paperType structured userEdits confidence reviewed reviewedAt relations'.split()),
 'conversations': COMMON | set('attachments skillId modelOverride'.split()),
 'messages': set('id conversationId position role content text at createdAt updatedAt attachments attachmentIds retrievedSources provider model reasoningEffort modelLabel actualModel'.split()),
 'attachments': COMMON | set('type relation taskId noteId importId sourceId targetId sourceType targetType'.split()),
 'links': COMMON | set('sourceId targetId sourceType targetType relation'.split()),
 'trash': set('id type title deletedAt counts data'.split()),
 'folders': set('id name kind createdAt updatedAt'.split()),
 'skills': set('id name command description instructions enabled createdAt updatedAt'.split()),
}
SENSITIVE = set('apikey accesstoken refreshtoken idtoken authorization password passwd secret clientsecret token credentials credential auth localfolder localpath path rootpath rootid absolutepath dataurl rawbase64 permissionmode permissions approvalpolicy sandboxmode'.split())
IDENTIFIER = re.compile(r'^[A-Za-z0-9_-]{1,200}$')
DIGEST = re.compile(r'^[a-f0-9]{64}$')

def dump(value): return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True, allow_nan=False)
def copy(value): return json.loads(dump(value))
def new_id(): return uuid.uuid4().hex

def clean(value, depth=0):
    if depth > 40: raise ValueError('同步内容嵌套过深。')
    if isinstance(value, dict):
        return {key: clean(item, depth+1) for key, item in value.items() if isinstance(key, str) and not key.startswith('_') and re.sub('[^a-z]', '', key.lower()) not in SENSITIVE and not re.sub('[^a-z]', '', key.lower()).endswith(('apikey', 'accesstoken', 'refreshtoken', 'password', 'clientsecret'))}
    if isinstance(value, list): return [clean(item, depth+1) for item in value]
    return value

def record(kind, item):
    if not isinstance(item, dict): raise ValueError('同步记录格式无效。')
    result = clean({key: value for key, value in item.items() if key in FIELDS[kind]})
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
                    wire = uuid.uuid5(uuid.NAMESPACE_URL, dump([identifier, mid])).hex
                    if ('messages', wire) in output: raise ValueError('同一对话存在重复消息 ID。')
                    output[('messages', wire)] = record('messages', {**message, 'conversationId': identifier, 'position': position})
    for group in ('projects', 'conversations'):
        for folder in (snapshot.get('folders') or {}).get(group, []):
            if not folder.get('id'): raise ValueError('文件夹缺少稳定 ID。')
            wire = uuid.uuid5(uuid.NAMESPACE_URL, dump([group, folder['id']])).hex
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
        with self.db() as db: return self._get(db, 'snapshot')
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
            if current is not None and current.get('_revision',0)==revision: return current
            return self._get(db,'history:'+str(revision))
    def _save_snapshot(self, db, snapshot):
        previous=self._get(db,'snapshot')
        if previous is not None and previous.get('_revision',0)!=snapshot.get('_revision',0):
            self._put(db,'history:'+str(previous.get('_revision',0)),previous)
        self._put(db,'snapshot',snapshot)
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
        projected = project(snapshot)
        with self.db() as db:
            rows = {(r['kind'],r['id']):r for r in db.execute('SELECT * FROM entities')}
            for key in set(projected) | set(rows):
                kind, identifier = key; row = rows.get(key)
                deleted = key not in projected; value = None if deleted else dump(projected[key])
                if row and row['data'] == value and bool(row['deleted']) == deleted: continue
                version = row['remote_version'] if row else 0
                db.execute('INSERT INTO entities(kind,id,data,deleted) VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,deleted=excluded.deleted', (kind,identifier,value,int(deleted)))
                conflict = db.execute('SELECT 1 FROM conflicts WHERE kind=? AND entity_id=?',key).fetchone()
                # Even permanent local deletion is represented by a tombstone.
                self._enqueue(db,kind,identifier,value,deleted,version,int(bool(conflict)))
            self._save_snapshot(db,snapshot)
            if before_commit: before_commit(snapshot)
            self._save_snapshot(db,snapshot)
        return snapshot
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
            grouped[row['kind']].append({**local,**item})
        for kind in COLLECTIONS: snapshot[kind]=grouped[kind]
        by_conv={}
        for message in grouped['messages']: by_conv.setdefault(message['conversationId'],[]).append(message)
        for conversation in snapshot['conversations']:
            messages=sorted(by_conv.get(conversation['id'],[]),key=lambda m:(m.get('position',0),m.get('createdAt',0),m['id']))
            conversation['messages']=[{k:v for k,v in m.items() if k not in ('position','conversationId')} for m in messages]
        snapshot['folders']={kind:[{k:v for k,v in item.items() if k!='kind'} for item in grouped['folders'] if item.get('kind')==kind] for kind in ('projects','conversations')}
        snapshot.setdefault('agentRuns',[])
        return snapshot
    def apply_changes(self, changes, cursor, before_commit=None):
        with self.db() as db:
            previous=self._get(db,'snapshot',{}); changed=False
            last_cursor=self._get(db,'cursor',0)
            if not isinstance(cursor,int) or cursor<last_cursor: raise ValueError('无效同步游标。')
            for change in changes:
                kind,identifier=change['entityType'],change['entityId']
                if kind not in FIELDS or not IDENTIFIER.fullmatch(identifier): raise ValueError('未知同步记录。')
                version=change['version']; deleted=bool(change.get('deleted')); value=None if deleted else dump(record(kind,change['data']))
                if not isinstance(version,int) or isinstance(version,bool) or version<1: raise ValueError('无效同步版本。')
                row=db.execute('SELECT * FROM entities WHERE kind=? AND id=?',(kind,identifier)).fetchone()
                if row and version<=row['remote_version']: continue
                pending=db.execute('SELECT * FROM outbox WHERE kind=? AND id=?',(kind,identifier)).fetchone()
                if pending and (pending['data']!=value or bool(pending['deleted'])!=deleted):
                    self._conflict(db,kind,identifier,version,value,deleted)
                    continue
                db.execute('INSERT INTO entities VALUES (?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,deleted=excluded.deleted,remote_version=excluded.remote_version,remote_data=excluded.remote_data,remote_deleted=excluded.remote_deleted',(kind,identifier,value,int(deleted),version,value,int(deleted)))
                db.execute('DELETE FROM outbox WHERE kind=? AND id=?',(kind,identifier))
                db.execute('DELETE FROM conflicts WHERE kind=? AND entity_id=?',(kind,identifier))
                changed=changed or not row or row['data']!=value or bool(row['deleted'])!=deleted
            snapshot=self._assemble(db,previous) if changed else previous
            if changed:
                snapshot['_revision']=int(previous.get('_revision',0))+1; snapshot['_savedAt']=int(time.time()*1000)
                snapshot.pop('_pendingLocalSave',None)
                self._save_snapshot(db,snapshot); self._put(db,'remoteAppliedRevision',snapshot['_revision'])
            self._put(db,'cursor',cursor)
            self._publish_files(db,before_commit,snapshot)
            return {'changed':changed,'snapshot':snapshot}
    def conflicts(self):
        with self.db() as db:
            result=[]
            for c in db.execute('SELECT * FROM conflicts'):
                row=db.execute('SELECT data,deleted FROM entities WHERE kind=? AND id=?',(c['kind'],c['entity_id'])).fetchone()
                local=json.loads(row['data']) if row and row['data'] else None; remote=json.loads(c['remote_data']) if c['remote_data'] else None
                result.append({'id':c['id'],'type':c['kind'],'entityId':c['entity_id'],'title':(local or remote or {}).get('title') or (local or remote or {}).get('name') or c['entity_id'],'local':local,'remote':remote,'remoteVersion':c['remote_version']})
            return result
    def resolve_conflict(self, identifier, choice, before_commit=None):
        if choice not in ('local','remote'): raise ValueError('请选择保留本机或使用云端版本。')
        with self.db() as db:
            conflict=db.execute('SELECT * FROM conflicts WHERE id=?',(identifier,)).fetchone()
            if not conflict: raise ValueError('这条冲突已经处理。')
            key=(conflict['kind'],conflict['entity_id']); previous=self._get(db,'snapshot',{})
            if choice=='local':
                local=db.execute('SELECT * FROM entities WHERE kind=? AND id=?',key).fetchone()
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
