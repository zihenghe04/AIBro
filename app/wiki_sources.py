"""Prepare explicitly selected directory sources; originals remain in file storage."""
import base64,hashlib,posixpath,re,time,uuid,unicodedata
from urllib.parse import unquote
from wiki_vault import WikiVaultError,WikiVault
import wiki_links

def prepare(store,state,payload,markdown_files):
 assets=payload.get('assets',[])
 if not isinstance(assets,list) or len(assets)>32:raise WikiVaultError('每批最多32份 PDF/图片原件')
 names={unicodedata.normalize('NFC',f.get('relativePath') or f['name']).casefold() for f in markdown_files};writes=[];sources={};total=0
 for asset in assets:
  name=asset.get('name');path=asset.get('relativePath');encoded=asset.get('base64')
  if not isinstance(name,str) or not isinstance(path,str) or path.startswith('/') or '\\' in path or '\0' in path or len(path)>1000 or len(path.split('/'))>12 or any(not p or p.startswith('.') for p in path.split('/')) or path.split('/')[-1]!=name:raise WikiVaultError('原件目录路径无效')
  key=unicodedata.normalize('NFC',path).casefold()
  if key in names:raise WikiVaultError('目录内文件路径重复')
  names.add(key)
  if not isinstance(encoded,str) or len(encoded)>90*1024*1024:raise WikiVaultError('原件数据过大或无效')
  try:raw=base64.b64decode(encoded,validate=True)
  except ValueError:raise WikiVaultError('原件数据不完整')
  total+=len(raw)
  if not raw or total>64*1024*1024:raise WikiVaultError('每批原件最多64 MiB，请分批选择')
  ext=name.lower().rsplit('.',1)[-1];mime=None
  if ext=='pdf' and b'%PDF-' in raw[:1024]:mime='application/pdf'
  elif ext=='png' and raw.startswith(b'\x89PNG\r\n\x1a\n'):mime='image/png'
  elif ext in ('jpg','jpeg') and raw.startswith(b'\xff\xd8\xff'):mime='image/jpeg'
  elif ext=='gif' and raw.startswith((b'GIF87a',b'GIF89a')):mime='image/gif'
  elif ext=='webp' and raw.startswith(b'RIFF') and raw[8:12]==b'WEBP':mime='image/webp'
  if not mime:raise WikiVaultError('目录原件仅支持 PDF、PNG、JPEG、GIF、WebP，文件内容须匹配格式')
  identifier='att_'+uuid.uuid5(uuid.NAMESPACE_URL,payload['requestId']+':source:'+path).hex;digest=hashlib.sha256(raw).hexdigest();pid=payload.get('projectId') or None
  prior=next((i for i in state.get('imports',[]) if i['id']==identifier),None)
  if prior:
   if prior.get('wikiImportHash')!=digest or prior.get('projectId')!=pid or any(prior.get(k) for k in ('archived','deletedAt','deleted','archivedAt')):raise WikiVaultError('原件批次已变化或被归档，请重新选择')
  else:
   if any(i.get('id')==identifier for t in state.get('trash',[]) for i in t.get('data',{}).get('imports',[])):raise WikiVaultError('原件已在回收站，请先恢复或重新选择批次')
   target=store.file_path(identifier)
   if target.exists() or target.is_symlink() or target.with_suffix('.meta.json').exists():raise WikiVaultError('该原件有未完成导入，请保留文件并重新选择批次')
   state['imports'].append({'id':identifier,'name':name,'originalName':name,'mimeType':mime,'size':len(raw),'fileStored':True,'status':'original-only','parser':'原件就绪','content':'','pages':[],'analysis':{'status':'pending'},'workspace':'科研','projectId':pid,'folderPath':posixpath.dirname(path),'wikiImportBatch':payload['requestId'],'wikiOriginalPath':path,'wikiVaultPath':WikiVault.TYPES[payload.get('category','output')]+'/import-'+payload['requestId']+'/'+path,'wikiImportHash':digest,'createdAt':int(time.time()*1000),'updatedAt':int(time.time()*1000)})
   writes.append((identifier,raw,name,mime))
  sources[path]=identifier
 return sources,writes

def associate(note,sources):
 # Source links are provenance, not a claim that the original was analyzed.
 linked={}
 for href,_,_ in wiki_links.occurrences(note.get('content',''),include_images=True):
  if re.match(r'^[a-z][a-z0-9+.-]*:|^[/\\]',href,re.I):continue
  path=posixpath.normpath(posixpath.join(posixpath.dirname(note['wikiOriginalPath']),unquote(href.split('#',1)[0])))
  if path in sources:linked[href]=sources[path]
 note['wikiSourceLinks']=linked;note['sourceAttachmentIds']=list(dict.fromkeys(linked.values()))
