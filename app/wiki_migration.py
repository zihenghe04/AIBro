"""Explicit, version-checked adoption into the managed research Markdown vault."""
import copy,json,re,time,uuid,hashlib,unicodedata
from wiki_vault import WikiVault,WikiVaultError
import wiki_sources
class WikiMigration:
 def __init__(self,store):self.store=store
 @staticmethod
 def version(note):return hashlib.sha256(json.dumps(note,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
 @staticmethod
 def active(n):return n and not any(n.get(k) for k in ('archived','archivedAt','deleted','deletedAt'))
 def candidates(self,state):
  projects={p['id'] for p in state.get('projects',[]) if self.active(p) and p.get('workspace')=='科研'}
  return [n for n in state.get('notes',[]) if self.active(n) and n.get('kind')!='随记' and not n.get('wikiFileError') and n['id'] not in state.get('_wikiFiles',{}) and (n.get('projectId') in projects or not n.get('projectId') and n.get('workspace')=='科研')]
 def preview(self):
  with self.store.lock():
   state=self.store.load();rows=[]
   for n in self.candidates(state):
    category='paper' if n.get('paperId') else 'output';draft={**n,'wikiCategory':category,'wikiFileBacked':True}
    rows.append({'id':n['id'],'title':n.get('title'),'projectId':n.get('projectId'),'category':category,'version':self.version(n),'path':WikiVault.relative(draft),'characters':len(n.get('content','')),'pendingDraft':bool(n.get('aiDraft'))})
   return {'entries':rows,'types':WikiVault.TYPES}
 def adopt(self,payload):
  selections=payload.get('entries')
  if not isinstance(selections,list) or not 1<=len(selections)<=100:raise WikiVaultError('每批选择1–100篇笔记')
  with self.store.lock():
   state=self.store.load();available={n['id']:n for n in self.candidates(state)};seen=set()
   for selected in selections:
    n=available.get(selected.get('id'))
    if not n or n['id'] in seen or selected.get('version')!=self.version(n):raise WikiVaultError('笔记已变化或已迁入，请重新预览')
    category=selected.get('category','output')
    if category not in WikiVault.TYPES or n.get('paperId') and category!='paper':raise WikiVaultError('无效的迁入分类')
    seen.add(n['id']);n.update(wikiFileBacked=True,wikiCategory=category,wikiMigratedAt=int(time.time()*1000),userEdited=True)
   self.store.save(state,enable_wiki=True)
   return {'snapshot':self.store.load(),'ids':list(seen)}
 def import_markdown(self,payload):
  files=payload.get('files');request_id=payload.get('requestId')
  if not isinstance(files,list) or not 1<=len(files)<=32 or not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}',str(request_id)):raise WikiVaultError('每批导入1–32份 Markdown，需要有效批次身份')
  with self.store.lock():
   state=self.store.load();pid=payload.get('projectId') or None
   if pid and not any(self.active(p) and p['id']==pid and p.get('workspace')=='科研' for p in state.get('projects',[])):raise WikiVaultError('请选择有效科研项目')
   category=payload.get('category','output')
   if category not in WikiVault.TYPES:raise WikiVaultError('请选择有效分类')
   ids=[];total=0;names=set();sources,writes=wiki_sources.prepare(self.store,state,payload,files)
   for index,file in enumerate(files):
    title=file.get('name');body=file.get('content');relative=file.get('relativePath') or title
    if not isinstance(title,str) or not title.lower().endswith(('.md','.markdown')) or '/' in title or '\\' in title or not isinstance(body,str) or '\0' in body:raise WikiVaultError('仅导入普通 UTF-8 Markdown 文件')
    if not isinstance(relative,str) or relative.startswith('/') or '\\' in relative or '\0' in relative or len(relative)>1000 or len(relative.split('/'))>12 or any(not p or p.startswith('.') for p in relative.split('/')) or relative.split('/')[-1]!=title:raise WikiVaultError('目录内路径无效')
    if unicodedata.normalize('NFC',relative).casefold() in names:raise WikiVaultError('同批 Markdown 文件名不能重复')
    names.add(unicodedata.normalize('NFC',relative).casefold())
    title=re.sub(r'\.(?:md|markdown)$','',title,flags=re.I).strip()
    if not title or len(title)>240:raise WikiVaultError('文件标题须为1–240字符')
    size=len(body.encode('utf-8'));total+=size
    if size>WikiVault.LIMIT-2048 or total>16*1024*1024:raise WikiVaultError('每份 Markdown 须小于4 MiB，每批最多16 MiB')
    identifier='wiki_'+uuid.uuid5(uuid.NAMESPACE_URL,request_id+':'+str(index)).hex
    digest=hashlib.sha256(body.encode('utf-8')).hexdigest();prior=next((n for n in WikiVault.notes(state) if n['id']==identifier),None)
    if prior:
     if sorted(prior.get('wikiImportAssets',[]))!=sorted(sources.values()):raise WikiVaultError('此导入批次的原件选择已变化，请重新选择批次')
     if not self.active(prior) or not any(n['id']==identifier for n in state['notes']) or prior.get('wikiImportHash')!=digest or prior.get('projectId')!=pid or prior.get('wikiOriginalName')!=file['name'] or prior.get('wikiOriginalPath',prior.get('wikiOriginalName'))!=relative or prior.get('wikiCategory')!=category:raise WikiVaultError('此导入批次已变化或被删除，请重新选择文件')
     ids.append(identifier);continue
    note={'id':identifier,'title':title,'content':body,'kind':'科研 Wiki/'+category,'workspace':'科研','projectId':pid,'wikiFileBacked':True,'wikiCategory':category,'wikiImportHash':digest,'wikiImportBatch':request_id,'wikiOriginalName':file['name'],'wikiOriginalPath':relative,'sourceAttachmentIds':[],'sourceNoteIds':[],'createdAt':int(time.time()*1000),'updatedAt':int(time.time()*1000),'userEdited':True}
    note['wikiImportAssets']=sorted(sources.values());wiki_sources.associate(note,sources);state['notes'].append(note);ids.append(identifier)
   written=[]
   try:
    for identifier,raw,name,mime in writes:
     written.append(identifier);self.store.save_file(identifier,raw,name,mime)
    self.store.save(state,enable_wiki=True)
   except Exception:
    # Keep files only if their IDs made it into the authoritative commit.
    committed={i['id'] for i in self.store._load_cached().get('imports',[])}
    for identifier in written:
     if identifier not in committed:
      for path in (self.store.file_path(identifier),self.store.file_path(identifier).with_suffix('.meta.json')):path.unlink(missing_ok=True)
    raise
   return {'snapshot':self.store.load(),'ids':ids}
