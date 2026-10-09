/* Explicit, persistent file references. Metadata is durable; content is read on demand. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.FileContext=api;})(globalThis,function(root){
 'use strict';
 const list=v=>Array.isArray(v)?v:[];
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const portable=r=>['note','import'].includes(r?.type);
 const portableKey=r=>{if(!portable(r))return null;if(typeof r.id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(r.id))throw Error('引用资料标识无效，请重新选择。');return `${r.type==='note'?'notes':'imports'}:${r.id}`;};
 const active=v=>!!v&&!v.wikiFileError&&!v.archived&&!v.archivedAt&&!v.deletedAt&&!v.deleted&&!['deleted','archived'].includes(v.status);
 const key=r=>r?.type==='local'?JSON.stringify(['local',r.candidateId,r.path]):JSON.stringify([r?.type,r?.id]);
 function available(state,type,id){const evidence=typeof module==='object'&&module.exports?require('./citation-evidence'):root.CitationEvidence;const access=evidence?.access(state,{type,id});return access?.available?access.record:null;}
 function sourceRefs(context){
  if(context===undefined)return [];
  const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v),id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(v);
  const fail=()=>{throw Object.assign(Error('会话引用或返回来源格式无效，请重新选择资料'),{code:'CONVERSATION_CONTEXT_INVALID'});};
  if(!object(context)||context.version!==1||Object.keys(context).sort().join(',')!=='keys,source,version'||!Array.isArray(context.keys)||context.keys.length>50)fail();
  const source=context.source;
  if(source!==null&&(!object(source)||source.kind!=='notes'||!id(source.id)||Object.keys(source).some(k=>!['kind','id','conversationId'].includes(k))||Object.hasOwn(source,'conversationId')&&!id(source.conversationId)))fail();
  if(!context.keys.every(k=>typeof k==='string'&&/^(notes|imports):[A-Za-z0-9_-]{1,200}$/.test(k)))fail();
  return [...new Set(context.keys)].map(k=>{const [kind,id]=k.split(':');return {type:kind==='notes'?'note':'import',id};});
 }
 function references(conversation,{retry=false,message}={}){
  if(retry)return structuredClone(list(message?.retryFileReferences||message?.fileReferences));
  const selected=sourceRefs(conversation?.mobileContext),authoritative=conversation?.mobileContext!==undefined;
  const allowed=new Set(selected.map(key)),excluded=new Set(list(conversation?.excludedFileReferenceKeys)),refs=new Map();
  for(const r of selected)refs.set(key(r),r);
  // Portable membership comes from the latest synced selection. Old messages
  // and drafts only enrich selected identities with their local version; they
  // cannot resurrect a source removed on another device. Local files stay local.
  const include=(r,draft=false)=>{if(authoritative&&portable(r)){if(allowed.has(key(r)))refs.set(key(r),r);}else if(draft||!excluded.has(key(r)))refs.set(key(r),r);};
  for(const m of list(conversation?.messages))if(m.role==='user'&&!m.deletedAt)for(const r of list(m.fileReferences))include(r);
  for(const r of list(conversation?.draftFileReferences))include(r,true);
  return structuredClone([...refs.values()]);
 }
 function portableKeys(conversation){return references(conversation).filter(portable).map(portableKey);}
 function hasLegacyAttachmentSelection(conversation){
  if(conversation?.mobileContext!==undefined)return false;
  // Older desktop turns recorded dropped files as attachmentIds rather than
  // explicit fileReferences. The v1 portable envelope cannot distinguish
  // pending carry-over from explicit references: migrating those identities
  // would either discard them or resend already-read/deleted originals.
  // Keep these conversations on their existing local selection semantics.
  const explicit=new Set(portableKeys(conversation));
  const messages=list(conversation?.messages).filter(m=>m.role==='user'&&active(m)&&!m.private&&!m.ephemeral&&!m.incognito);
  const ids=m=>[...new Set([...list(m.attachmentIds),...list(m.attachments).map(a=>a?.id)])];
  const excluded=new Set(list(conversation?.excludedFileReferenceKeys));
  const retryExcluded=new Set(messages.flatMap(m=>Array.isArray(m.retryAttachmentIds)?ids(m).filter(id=>!m.retryAttachmentIds.includes(id)):[]));
  for(const m of messages)for(const id of ids(m)){
   if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(id)||excluded.has(key({type:'import',id}))||retryExcluded.has(id))continue;
   if(!explicit.has(`imports:${id}`))return true;
  }
  return false;
 }
 function changedContext(conversation,ref,selected){
  const identity=portableKey(ref);if(!identity)return null;
  if(hasLegacyAttachmentSelection(conversation))return null;
  const current=portableKeys(conversation),keys=selected?current:current.filter(k=>k!==identity);if(selected&&!keys.includes(identity))keys.push(identity);
  if(keys.length>50)throw Error('每个对话最多引用 50 项资料，请先移除部分引用。');
  return {version:1,keys,source:structuredClone(conversation.mobileContext?.source??null)};
 }
 function stage(conversation,ref){const next=changedContext(conversation,ref,true),copy=structuredClone(ref);conversation.draftFileReferences=[...list(conversation.draftFileReferences).filter(r=>key(r)!==key(ref)),copy];conversation.excludedFileReferenceKeys=list(conversation.excludedFileReferenceKeys).filter(k=>k!==key(ref));if(next)conversation.mobileContext=next;}
 function refresh(conversation,ref){stage(conversation,ref);for(const message of list(conversation.messages)){const refs=list(message.retryFileReferences||message.fileReferences);if(refs.some(r=>key(r)===key(ref)))message.retryFileReferences=refs.map(r=>key(r)===key(ref)?structuredClone(ref):r);}}
 function remove(conversation,ref){const next=changedContext(conversation,ref,false);conversation.draftFileReferences=list(conversation.draftFileReferences).filter(r=>key(r)!==key(ref));conversation.excludedFileReferenceKeys=[...new Set([...list(conversation.excludedFileReferenceKeys),key(ref)])];if(next)conversation.mobileContext=next;}
 // Save failure only rolls back this identity. A concurrent source change,
 // different selection or newer version of the same reference must win.
 function contextSnapshot(conversation,ref){return {value:structuredClone(conversation.mobileContext),keys:portableKeys(conversation),ref:references(conversation).find(r=>key(r)===key(ref))};}
 function rollbackContext(conversation,ref,before,after){
  const identity=portableKey(ref);if(!identity||!after||same(before.value,after.value))return;
  let current;try{current=contextSnapshot(conversation,ref);}catch{return;}
  if(!same(current.ref,after.ref))return;
  if(same(current.value,after.value)){if(before.value===undefined)delete conversation.mobileContext;else conversation.mobileContext=structuredClone(before.value);return;}
  if(!current.value||current.keys.includes(identity)!==after.keys.includes(identity))return;
  const keys=current.keys.filter(k=>k!==identity);if(before.keys.includes(identity))keys.push(identity);
  if(keys.length<=50)conversation.mobileContext={...current.value,keys};
 }
 function consume(conversation,refs){const sent=new Set(refs.map(key));conversation.draftFileReferences=list(conversation.draftFileReferences).filter(r=>!sent.has(key(r)));}
 function search(state,query='',projectId=null){const terms=query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);return ['note','import'].flatMap(type=>list(state[type==='note'?'notes':'imports']).filter(r=>available(state,type,r.id)).map(r=>{const project=list(state.projects).find(p=>p.id===r.projectId);return {type,id:r.id,title:r.title||r.name||r.originalName||'Untitled',projectId:r.projectId||null,location:[r.workspace,project?.name,r.folderPath].filter(Boolean).join(' / '),updatedAt:r.updatedAt||0};})).filter(r=>terms.every(t=>(r.title+' '+r.location).toLocaleLowerCase().includes(t))).sort((a,b)=>Number(b.projectId===projectId)-Number(a.projectId===projectId)||b.updatedAt-a.updatedAt||a.title.localeCompare(b.title));}
 async function digest(text){const crypto=root.crypto||require('node:crypto').webcrypto;const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return [...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('');}
 async function libraryRef(state,type,id){const r=available(state,type,id);if(!r)throw Error('引用资料已删除或归档，请移除引用或恢复资料。');return {type,id,title:r.title||r.name||r.originalName||'Untitled',projectId:r.projectId||null,version:await digest(type==='note'?String(r.content||''):JSON.stringify([r.id,r.createdAt,r.size,r.originalName])),selectedAt:Date.now()};}
 async function request(path,payload,signal){const response=await root.fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal});const body=await response.json();if(!response.ok)throw Error(body.error||`HTTP ${response.status}`);return body;}
 async function prepare(state,refs,{signal,readLocal=request}={}){
  const snapshots=[],initial=[],notes=new Map(),coverage=new Map();
  function record(refKey,part){if(typeof part.text!=='string')return;const c=coverage.get(refKey)||{total:part.totalChars,ranges:[]};c.ranges.push([part.offset,part.nextOffset??part.totalChars]);coverage.set(refKey,c);}
  function fullyRead(refKey){const c=coverage.get(refKey);if(!c)return false;let end=0;for(const [a,b] of c.ranges.slice().sort((a,b)=>a[0]-b[0])){if(a>end)return false;end=Math.max(end,b);}return end>=c.total;}
  const frozen={projects:structuredClone(list(state.projects)),notes:structuredClone(list(state.notes).filter(n=>refs.some(r=>r.type==='note'&&r.id===n.id))),imports:structuredClone(list(state.imports).filter(n=>refs.some(r=>r.type==='import'&&r.id===n.id)))};
  for(const ref of refs){
   if(signal?.aborted)throw Object.assign(Error('已停止读取文件'),{code:'CANCELLED'});
   let current,part;
   if(ref.type==='local'){
    const project=list(state.projects).find(p=>active(p)&&p.id===ref.projectId&&p.localFolder?.id===ref.candidateId);if(!project)throw Error('本机项目已断开或归档，请更新文件引用。');
    part=await readLocal('/__local/read',{candidateId:ref.candidateId,path:ref.path,version:ref.version,offset:0},signal);current={...ref,version:part.version};
   }else if(['note','import'].includes(ref.type)){
    if(!available(state,ref.type,ref.id))throw Error('引用资料已删除、归档或不再可读，请移除引用或恢复资料。');
    current=await libraryRef(frozen,ref.type,ref.id);
    if(!available(state,ref.type,ref.id))throw Error('引用资料已不再可读，请重新选择资料。');
    if(ref.version&&ref.version!==current.version)throw Error(`「${current.title}」已修改，请在输入框上方更新引用后继续。`);
    if(ref.type==='note'){const content=String(available(frozen,'note',ref.id).content||'');notes.set(key(ref),content);part={text:content.slice(0,12000),offset:0,totalChars:content.length,nextOffset:content.length>12000?12000:null};}
    else part={delivery:'original_attachment',hint:'See this turn attachment delivery and page coverage.'};
   }else throw Error('不支持的文件引用类型。');
   record(key(current),part);current={...current,readAt:Date.now()};snapshots.push(current);initial.push({refKey:key(current),type:current.type,title:current.title,version:current.version,...part});
  }
  async function read(req){const ref=snapshots.find(r=>key(r)===req.refKey);if(!ref)throw Error('只能读取本轮用户明确引用的文件。');const offset=req.offset??0;if(!Number.isSafeInteger(offset)||offset<0)throw Error('无效的读取位置。');
   if(['note','import'].includes(ref.type)&&!available(state,ref.type,ref.id))throw Error('引用资料已不再可读，请重新选择资料。');
   let part;if(ref.type==='local'){if(!list(state.projects).some(p=>active(p)&&p.id===ref.projectId&&p.localFolder?.id===ref.candidateId))throw Error('本机项目已断开或归档，请更新文件引用。');part=await readLocal('/__local/read',{candidateId:ref.candidateId,path:ref.path,version:ref.version,offset},signal);}
   else if(ref.type==='note'){const content=notes.get(key(ref));part={offset,text:content.slice(offset,offset+12000),totalChars:content.length,nextOffset:offset+12000<content.length?offset+12000:null};}
   else throw Error('附件请使用 read/read_page 和该附件 id 读取。');
   record(key(ref),part);return {type:ref.type,id:ref.id||key(ref),title:ref.title,refKey:key(ref),version:ref.version,...part};
  }
  if(snapshots.some(ref=>['note','import'].includes(ref.type)&&!available(state,ref.type,ref.id)))throw Error('引用资料已不再可读，请重新选择资料。');
  return {snapshots,initial,read,fullyRead,text:JSON.stringify(initial)};
 }
 function mention(value,caret){const before=value.slice(0,caret);const match=before.match(/(?:^|\s)@([^@\n]{0,100})$/u);return match?{start:caret-match[1].length-1,end:caret,query:match[1]}:null;}
 return {key,active,available,sourceRefs,references,portableKeys,contextSnapshot,rollbackContext,stage,refresh,remove,consume,search,digest,libraryRef,prepare,request,mention};
});
