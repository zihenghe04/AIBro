"""Explicit portable Wiki exports. Never writes a second live body/source store."""
import hashlib, io, json, os, posixpath, re, stat, zipfile
from urllib.parse import quote
from wiki_migration import WikiMigration
from wiki_vault import WikiVaultError
import wiki_links

class WikiBundle:
 LIMIT=128*1024*1024
 def __init__(self,store):self.store=store
 @staticmethod
 def sources(note):return list(dict.fromkeys(note.get('sourceAttachmentIds',[])+note.get('wikiImportAssets',[])))
 def preview(self,ids):
  if not isinstance(ids,list) or not 1<=len(ids)<=1000 or any(not isinstance(i,str) for i in ids):raise WikiVaultError('请选择1–1000篇 Wiki')
  with self.store.lock():
   state=self.store.load();active=WikiMigration.active;projects={p['id'] for p in state.get('projects',[]) if active(p)}
   rows=[{'id':n['id'],'title':n.get('title'),'version':WikiMigration.version(n),'path':state['_wikiFiles'][n['id']]['path'],'sourceIds':self.sources(n)} for n in state.get('notes',[]) if n['id'] in ids and n['id'] in state.get('_wikiFiles',{}) and active(n) and not n.get('wikiFileError') and (not n.get('projectId') or n['projectId'] in projects)]
   if len(rows)!=len(set(ids)):raise WikiVaultError('选择中包含已变化或不可用的 Wiki，请刷新')
   source_ids={i for row in rows for i in row['sourceIds']}
   return {'entries':rows,'sources':[{'id':i['id'],'name':i.get('name')} for i in state.get('imports',[]) if i['id'] in source_ids and active(i) and (not i.get('projectId') or i['projectId'] in projects)]}
 def build(self,payload):
  selected=payload.get('entries')
  if not isinstance(selected,list) or not 1<=len(selected)<=1000:raise WikiVaultError('请选择1–1000篇 Wiki，可按项目分批导出')
  with self.store.lock():
   state=self.store.load();mapping=state.get('_wikiFiles',{});active=WikiMigration.active
   projects={p['id'] for p in state.get('projects',[]) if active(p)}
   notes={n['id']:n for n in state.get('notes',[]) if active(n) and n['id'] in mapping and not n.get('wikiFileError') and (not n.get('projectId') or n['projectId'] in projects)}
   chosen=[];seen=set()
   for row in selected:
    n=notes.get(row.get('id'))
    if not n or n['id'] in seen or row.get('version')!=WikiMigration.version(n):raise WikiVaultError('Wiki 已变化或不可用，请刷新导出清单')
    chosen.append(n);seen.add(n['id'])
   files={};total=0;manifest={'format':'AI Bro portable Wiki v1','notes':[],'sources':[],'missing':[],'linksOutsideSelection':[]}
   def put(path,raw):
    nonlocal total
    self.store.wiki.path(path)
    if path.casefold() in {p.casefold() for p in files}:raise WikiVaultError('导出目录存在重名冲突')
    total+=len(raw)
    if total>self.LIMIT:raise WikiVaultError('导出内容超过128 MiB，请缩小范围')
    files[path]=raw
   source_paths={};imports={i['id']:i for i in state.get('imports',[]) if active(i) and (not i.get('projectId') or i['projectId'] in projects)}
   if payload.get('includeSources') is True:
    for n in chosen:
     for identifier in self.sources(n):
      if identifier in source_paths:continue
      source=imports.get(identifier)
      if not source:manifest['missing'].append({'noteId':n['id'],'sourceId':identifier,'reason':'来源已删除或不可用'});continue
      path=self.store.file_path(identifier)
      try:
       if path.parent.is_symlink():raise WikiVaultError('原件目录不能是符号链接')
       fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
       try:
        before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or before.st_size>64*1024*1024:raise WikiVaultError('原件不是普通文件或超过64 MiB')
        with os.fdopen(fd,'rb',closefd=False) as f:raw=f.read(64*1024*1024+1)
        after=os.fstat(fd)
        if len(raw)!=before.st_size or (before.st_mtime_ns,before.st_size)!=(after.st_mtime_ns,after.st_size):raise WikiVaultError('导出期间原件有变化')
       finally:os.close(fd)
      except FileNotFoundError:manifest['missing'].append({'noteId':n['id'],'sourceId':identifier,'reason':'本机未保存原件'});continue
      name=re.sub(r'[\x00-\x1f/\\:*?"<>|]','_',str(source.get('originalName') or source.get('name') or 'source')).strip('. ')[:180] or 'source'
      target=source.get('wikiVaultPath') or f'sources/files/{identifier}/{name}';put(target,raw);source_paths[identifier]=target
      manifest['sources'].append({'id':identifier,'name':source.get('name'),'path':target,'sha256':hashlib.sha256(raw).hexdigest()})
   for n in chosen:
    entry=mapping[n['id']];path=entry['path'];body=n.get('content','')
    # Only the exported copy is repaired; approved local Markdown stays intact.
    for href,start,end in reversed(wiki_links.occurrences(body,include_images=True)):
     source=n.get('wikiSourceLinks',{}).get(href)
     if source in source_paths:
      replacement=quote(posixpath.relpath(source_paths[source],posixpath.dirname(path) or '.'),safe='/')+('#'+href.split('#',1)[1] if '#' in href else '')
      body=body[:start]+replacement+body[end:];continue
     target=entry.get('links',{}).get(href)
     if not target:continue
     if target not in seen:
      manifest['linksOutsideSelection'].append({'noteId':n['id'],'targetId':target});continue
     relative=posixpath.relpath(mapping[target]['path'],posixpath.dirname(path) or '.')
     replacement=quote(relative,safe='/')+('#'+href.split('#',1)[1] if '#' in href else '')
     body=body[:start]+replacement+body[end:]
    sources=[(i,source_paths[i]) for i in n.get('sourceAttachmentIds',[]) if i in source_paths]
    if sources:
     body+='\n\n## 原始来源 / Source files\n\n'+'\n'.join(f'- [{i}]({quote(posixpath.relpath(p,posixpath.dirname(path) or "."),safe="/")})' for i,p in sources)+'\n'
    put(path,self.store.wiki.encode({**n,'content':body}));manifest['notes'].append({'id':n['id'],'title':n.get('title'),'path':path,'sourceIds':self.sources(n)})
   put('AIBRO-EXPORT.json',json.dumps(manifest,ensure_ascii=False,indent=2).encode())
   put('AIBRO-INDEX.md',('# Wiki export\n\n'+ '\n'.join(f'- [{n["id"]}]({quote(mapping[n["id"]]["path"],safe="/")})' for n in chosen)+'\n\nMissing files and links outside this selection are listed in AIBRO-EXPORT.json.\n').encode())
   out=io.BytesIO()
   with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as archive:
    for name,raw in files.items():archive.writestr(name,raw)
   return out.getvalue()
