/* The island's link library is a projection of state.imports. Downloads are
 * explicit user actions through the existing guarded public-fetch service. */
(() => {
  'use strict';
  const list = value => Array.isArray(value) ? value : [];
  const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const requestPattern = /^quick_link_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const spaces = ['日常', '课程', '科研'];
  const fail = (reason, deferred = false) => ({status:deferred ? 'deferred' : 'error', reason});
  const core = () => window.WorkstationCore || (typeof Core !== 'undefined' ? Core : null);
  let pending = null;
  function readiness() {
    if (typeof storageHydrated === 'undefined' || !storageHydrated) return fail('hydrating',true);
    if (typeof state === 'undefined' || !Array.isArray(state.imports) || !object(state.ui) || !window.CitationEvidence?.createAccessContext || !core()?.contentStamp || typeof saveDocumentDurably !== 'function') return fail('unavailable',true);
    if (window.PrivateMode?.isOn?.()) return fail('private',true);
    if (typeof serverConflict !== 'undefined' && serverConflict) return fail('conflict',true);
    if (typeof purgeTrash !== 'undefined' && (purgeTrash.syncPaused || purgeTrash.busy || purgeTrash.confirming)) return fail('busy',true);
    if (own(state.ui,'nativeQuickLinkReceipts') && !object(state.ui.nativeQuickLinkReceipts)) return fail('unavailable',true);
    return null;
  }
  function normalizeURL(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value.trim())) return null;
    try {
      const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value.trim()) ? value.trim() : 'https://' + value.trim());
      if (!['http:','https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
      return url.href;
    } catch (_) { return null; }
  }
  // Fragments and query values can identify different papers/pages. Keep them;
  // URL normalisation alone handles host case, default ports and root slashes.
  function target(workspace, projectId, access) {
    if (!spaces.includes(workspace) || projectId !== null && typeof projectId !== 'string') throw Error('invalid');
    if (!projectId) return {workspace,projectId:null,project:null};
    const matches = list(state.projects).filter(row => row?.id === projectId), project = matches[0];
    const ref = {type:'local',projectId,candidateId:project?.localFolder?.id};
    if (matches.length !== 1 || !access.access(ref).available || access.isAmbiguous(ref) || project.workspace !== workspace) throw Error('changed');
    return {workspace,projectId,project:project.name};
  }
  function available(id, access) {
    const ref = {type:'import',id}, result = access.access(ref);
    if (result.kind === 'private') throw Error('private');
    if (!result.available || access.isAmbiguous(ref) || !normalizeURL(result.record?.url)) throw Error('removed');
    return result.record;
  }
  const version = row => core().contentStamp(JSON.stringify(row));
  const hasText = row => !!String(row.content || '').trim() || list(row.pages).some(page=>String(page?.text || page?.content || '').trim());
  const fetchable = row => row.parser==='bookmark' && row.importOrigin==='quick-links' && !row.fileStored && !row.dataUrl && !hasText(row);
  const iconData = value => typeof value==='string' && value.length<=43714 && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : '';
  function metadataFor(row) {
    const entry=state.ui.nativeQuickLinkMetadata?.[row.id];
    return object(entry) && entry.url===row.url && entry.identity===(row.quickLinkIdentity || '') ? entry : null;
  }
  function cacheMetadata(owner,row,value) {
    if (own(owner.ui,'nativeQuickLinkMetadata') && !object(owner.ui.nativeQuickLinkMetadata)) throw Error('unavailable');
    const entries=Object.entries(owner.ui.nativeQuickLinkMetadata || {}).filter(([id,entry])=>id!==row.id && object(entry));
    entries.push([row.id,value]);entries.sort((a,b)=>(Number(b[1].attemptedAt)||0)-(Number(a[1].attemptedAt)||0));
    let bytes=0;owner.ui.nativeQuickLinkMetadata=Object.fromEntries(entries.filter((entry,index)=>{
      bytes+=new TextEncoder().encode(JSON.stringify(entry)).byteLength;return index<128 && bytes<=4*1024*1024;
    }));
  }
  function project(row) {
    const url = normalizeURL(row.url);
    const metadata=metadataFor(row);
    return {id:row.id,title:String(row.name || row.originalName || new URL(url).hostname),url,site:new URL(url).hostname,
      folder:String(row.folderPath || '原始资料'),workspace:list(state.projects).find(item=>item.id===row.projectId)?.workspace || (spaces.includes(row.workspace) ? row.workspace : '日常'),projectId:row.projectId || null,
      projectTitle:String(list(state.projects).find(item=>item.id === row.projectId)?.name || ''),version:version(row),
      createdAt:Number(row.createdAt)||0,hasContent:!!(row.fileStored || hasText(row)),order:Number(row.quickLinkOrder)||0,
      canFetch:fetchable(row),fetchStatus:row.quickLinkFetch?.status || (row.fileStored ? 'ready' : 'idle'),
      fetchError:row.quickLinkFetch?.status==='failed' ? String(row.quickLinkFetch.error || '') : '',
      iconDataUrl:iconData(metadata?.iconDataUrl),siteDescription:String(metadata?.description || '').slice(0,500),
      metadataStatus:metadata?.status || 'idle',metadataError:metadata?.status==='failed' ? String(metadata.error || '').slice(0,500) : ''};
  }
  const folderKey = value => [value.workspace,value.projectId || '',value.folder].join('\u001f');
  const isHidden = value => ['private','ephemeral','incognito','deleted','deletedAt','archived','archivedAt'].some(key=>value?.[key]) || ['deleted','archived'].includes(value?.status);
  function libraryFolders(owner=state) {
    if (owner.folders != null && (!object(owner.folders) || own(owner.folders,'library') && !Array.isArray(owner.folders.library))) throw Error('unavailable');
    return list(owner.folders?.library);
  }
  function folderScope(value,access) {
    const scope=target(value.workspace,value.projectId,access);
    const folder=patchValues({folder:value.folder},access).folderPath;
    return {...scope,folder};
  }
  function folderMembers(scope) {
    return ['imports','notes','papers'].flatMap(type=>list(state[type]).flatMap(row=>{
      const project=list(state.projects).find(item=>item.id===row.projectId);
      const workspace=project?.workspace || (spaces.includes(row.workspace) ? row.workspace : '日常');
      const path=core().folderPath(row.folderPath || (type==='imports' ? '原始资料' : ''));
      if (workspace!==scope.workspace || (row.projectId||null)!==scope.projectId || !(path===scope.folder || path.startsWith(scope.folder+'/'))) return [];
      return [{type,row,path}];
    }));
  }
  function folderDescriptor(scope,access) {
    const entries=libraryFolders().filter(item=>item?.workspace===scope.workspace && (item.projectId||null)===scope.projectId &&
      (item.folderPath===scope.folder || String(item.folderPath||'').startsWith(scope.folder+'/')));
    const exact=entries.filter(item=>item.folderPath===scope.folder),members=folderMembers(scope);
    const child=entries.some(item=>item.folderPath!==scope.folder) || members.some(item=>item.path!==scope.folder);
    const hidden=entries.some(isHidden) || members.some(item=>{
      const ref={type:{imports:'import',notes:'note',papers:'paper'}[item.type],id:item.row.id};
      return isHidden(item.row) || access.isAmbiguous(ref) || !access.access(ref).available;
    });
    const shared=members.some(item=>item.type!=='imports' || !normalizeURL(item.row.url));
    const identity=exact.length===1 && typeof exact[0].id==='string' && exact[0].id ? exact[0].id : null;
    const valid=exact.length<=1 && !(exact.length && !identity) && (!identity || libraryFolders().filter(item=>item.id===identity).length===1);
    return {id:folderKey(scope),folder:scope.folder,workspace:scope.workspace,projectId:scope.projectId,projectTitle:String(scope.project||''),
      folderId:identity,version:version([entries,members.map(({type,row})=>[type,row])]),
      linkIDs:hidden?[]:members.filter(item=>item.type==='imports'&&normalizeURL(item.row.url)).map(item=>item.row.id),
      canRename:valid&&!hidden&&!child&&!shared,
      canDelete:valid&&!!identity&&!hidden&&!entries.some(item=>item.folderPath!==scope.folder)&&members.length===0,
      blockedReason:!valid?'changed':hidden?'folder_protected':child?'folder_children':shared?'folder_shared':'',
      members,entries,exact};
  }
  function folderPublic(group) { const {members,entries,exact,...result}=group; if (result.blockedReason==='folder_protected') result.folderId=null; return result; }
  function folderSnapshot(access,rows,needle) {
    const groups=new Map();
    for (const row of rows) {
      try { const scope=folderScope(row,access),key=folderKey(scope); if (!groups.has(key)) groups.set(key,folderDescriptor(scope,access)); } catch (_) { /* An old malformed scope cannot hide unrelated links. */ }
    }
    for (const entry of libraryFolders()) {
      try {
        if (isHidden(entry)) continue;
        const scope=folderScope({...entry,folder:entry.folderPath},access),key=folderKey(scope);
        const group=folderDescriptor(scope,access);
        if (group.exact.length!==1 || group.folderId!==entry.id || group.blockedReason==='folder_protected') continue;
        if (!needle || [scope.folder,scope.project||''].join('\n').toLocaleLowerCase().includes(needle)) groups.set(key,group);
      } catch (_) {}
    }
    return [...groups.values()].map(folderPublic);
  }
  function applyFolder(owner,payload,access) {
    const scope=folderScope(payload,access),current=folderDescriptor(scope,access),action=payload.action;
    if (action==='folder-create') {
      if (current.entries.length || current.members.length) throw Error('folder_exists');
      if (libraryFolders(owner).some(item=>item.id===payload.requestId)) throw Error('collision');
      const now=Date.now();
      const entry={id:payload.requestId,name:scope.folder.split('/').at(-1),folderPath:scope.folder,workspace:scope.workspace,projectId:scope.projectId,createdAt:now,updatedAt:now};
      owner.folders ||= {projects:[],conversations:[]}; owner.folders.library ||= []; owner.folders.library.push(entry);
      return {ids:[],folderId:entry.id,folderScope:{workspace:scope.workspace,projectId:scope.projectId,folder:scope.folder},folderVersion:version(entry)};
    }
    if (payload.expectedVersion!==current.version) throw Error('changed');
    if (action==='folder-delete') {
      if (!current.canDelete) throw Error(current.blockedReason || 'folder_not_empty');
      owner.folders.library=libraryFolders(owner).filter(item=>item!==current.exact[0]);
      return {ids:[],folderId:current.folderId,folderScope:{workspace:scope.workspace,projectId:scope.projectId,folder:scope.folder}};
    }
    if (!current.canRename) throw Error(current.blockedReason || 'changed');
    if (!current.exact.length && !current.members.length) throw Error('removed');
    const next=folderScope({...payload,folder:payload.newFolder},access);
    if (next.folder===scope.folder) throw Error('invalid');
    const destination=folderDescriptor(next,access);
    if (destination.members.length || destination.entries.length) throw Error('folder_exists');
    const now=Date.now();
    // No foreign document, hidden member, or descendant can be renamed by a
    // link-only surface. Mutations begin only after validating the whole scope.
    for (const {row} of current.members) Object.assign(row,{folderPath:next.folder,updatedAt:Math.max(now,(Number(row.updatedAt)||0)+1)});
    const entry=current.exact[0];
    if (entry) Object.assign(entry,{folderPath:next.folder,name:next.folder.split('/').at(-1),updatedAt:Math.max(now,(Number(entry.updatedAt)||0)+1)});
    return {ids:current.members.map(({row})=>row.id),folderId:entry?.id||null,
      previousGroupId:current.id,folderScope:{workspace:scope.workspace,projectId:scope.projectId,folder:next.folder},folderVersion:entry?version(entry):null};
  }
  function validateFolderReceipt(receipt,access) {
    const scope=folderScope(receipt.folderScope,access),entries=libraryFolders();
    if (receipt.action==='folder-delete') {
      if (entries.some(item=>item.id===receipt.folderId)) throw Error('changed');
    } else if (receipt.folderId) {
      const matches=entries.filter(item=>item.id===receipt.folderId),entry=matches[0];
      if (matches.length!==1 || isHidden(entry) || entry.workspace!==scope.workspace || (entry.projectId||null)!==scope.projectId || version(entry)!==receipt.folderVersion) throw Error('changed');
    }
    const descriptor=folderDescriptor(scope,access);
    if (receipt.action==='folder-delete' && descriptor.members.length) throw Error('changed');
    if (descriptor.blockedReason==='folder_protected') throw Error('private');
  }
  function trashAllowed(entry, access) {
    if (!entry || entry.type !== 'content' || !requestPattern.test(entry.sourceQuickLinkRequestId || '') || !list(entry.data?.imports).length) return false;
    if (['notes','tasks','papers'].some(key=>list(entry.data?.[key]).length)) return false;
    return entry.data.imports.every(row => normalizeURL(row.url) && access.access({type:'import',id:row.id}).kind !== 'private' &&
      (!row.projectId || list(state.projects).filter(p=>p.id===row.projectId).length <= 1));
  }
  function snapshot(payload) {
    const blocked = readiness(); if (blocked) return {...blocked,rows:[],trash:[],projects:[],groups:[]};
    const access = window.CitationEvidence.createAccessContext(state), needle = String(payload.query || '').trim().toLocaleLowerCase();
    const rows = list(state.imports).flatMap(row => {
      try { if (available(row?.id,access) !== row) return []; const item=project(row); return !needle || [item.title,item.url,item.folder,item.projectTitle].join('\n').toLocaleLowerCase().includes(needle) ? [item] : []; } catch (_) { return []; }
    }).sort((a,b)=>a.order-b.order || b.createdAt-a.createdAt || a.id.localeCompare(b.id));
    const projects = list(state.projects).flatMap(row=>{
      try { target(row.workspace,row.id,access); return [{id:row.id,title:String(row.name||''),workspace:row.workspace}]; } catch (_) { return []; }
    });
    const trash = list(state.trash).filter(entry=>trashAllowed(entry,access)).map(entry=>({id:entry.id,title:String(entry.title||''),count:entry.data.imports.length,version:version(entry),deletedAt:Number(entry.deletedAt)||0})).sort((a,b)=>b.deletedAt-a.deletedAt);
    let groups; try { groups=folderSnapshot(access,rows,needle); } catch (_) { return {...fail('unavailable',true),rows:[],projects:[],trash:[],groups:[]}; }
    return {status:'ready',rows,projects,trash,groups};
  }
  function patchValues(patch, access) {
    if (!object(patch) || Object.keys(patch).some(key=>!['title','folder','workspace','projectId','order'].includes(key))) throw Error('invalid');
    const result = {};
    if (own(patch,'title')) { if (typeof patch.title !== 'string' || !patch.title.trim() || patch.title.length>1000) throw Error('invalid'); result.name=patch.title.trim(); result.quickLinkTitleEdited=true; }
    if (own(patch,'folder')) { if (typeof patch.folder !== 'string' || !patch.folder.trim() || patch.folder.length>240 || /[\u0000-\u001f]/.test(patch.folder)) throw Error('invalid'); result.folderPath=core().folderPath(patch.folder); if (!result.folderPath) throw Error('invalid'); }
    if (own(patch,'workspace') || own(patch,'projectId')) Object.assign(result,target(patch.workspace,patch.projectId,access));
    if (own(patch,'order')) { if (!Number.isSafeInteger(patch.order)) throw Error('invalid'); result.quickLinkOrder=patch.order; }
    return result;
  }
  // Apply only lifecycle-owned fields to existing objects. Streaming messages,
  // drafts and selections retain their object identities; no whole-state swap.
  function applyLifecycle(owner, next) {
    for (const key of ['imports','attachments','links']) {
      const originals = new Map(list(owner[key]).map(row=>[JSON.stringify(key==='attachments' ? [row.id,row.conversationId] : row.id),row]));
      owner[key]=list(next[key]).map(row=>originals.get(JSON.stringify(key==='attachments' ? [row.id,row.conversationId] : row.id)) || row);
    }
    owner.trash=next.trash;
    const conversations = new Map(list(next.conversations).map(row=>[row.id,row]));
    for (const row of list(owner.conversations)) { const after=conversations.get(row.id); if (after && JSON.stringify(row.attachments)!==JSON.stringify(after.attachments)) row.attachments=after.attachments; }
    if (Array.isArray(next.lastResults)) owner.lastResults=next.lastResults;
  }
  function apply(owner, payload, access) {
    if (payload.action.startsWith('folder-')) return applyFolder(owner,payload,access);
    if (payload.action === 'add') {
      const url=normalizeURL(payload.url); if (!url) throw Error('invalid');
      const values=patchValues({title:payload.title || new URL(url).hostname,folder:payload.folder || '链接收藏',workspace:payload.workspace,projectId:payload.projectId},access);
      values.quickLinkTitleEdited=!!String(payload.title || '').trim();
      const duplicates=list(owner.imports).filter(row=>normalizeURL(row?.url)===url && (row.projectId||null)===(values.projectId||null) && (row.workspace||'日常')===values.workspace);
      // Hidden/private matches never disclose their ID/title or cause an alias.
      const existing=duplicates.find(row=>{try{return available(row.id,access)===row;}catch(_){return false;}});
      if (existing) return {ids:[existing.id],duplicate:true};
      const id=payload.requestId;
      if (list(owner.imports).some(row=>row.id===id) || list(owner.trash).some(entry=>list(entry.data?.imports).some(row=>row.id===id))) throw Error('collision');
      const now=Date.now(); owner.imports.push({id,...values,url,originalName:values.name,mimeType:'text/html',content:'',pages:[],tags:[],
        status:'original-only',parser:'bookmark',fileStored:false,importOrigin:'quick-links',sourceQuickLinkRequestId:payload.requestId,createdAt:now,updatedAt:now});
      return {ids:[id]};
    }
    if (payload.action === 'restore') {
      const matches=list(owner.trash).filter(row=>row.id===payload.trashId),entry=matches[0];
      if (matches.length!==1 || !trashAllowed(entry,access)) throw Error('removed');
      if (version(entry)!==payload.expectedVersion) throw Error('changed');
      if (!window.ContentLifecycle?.restore) throw Error('unavailable');
      const outcome=window.ContentLifecycle.restore(owner,entry.id);
      if (outcome.counts.import!==entry.data.imports.length) throw Error('collision');
      const restoredAccess=window.CitationEvidence.createAccessContext(outcome.state);
      for (const row of entry.data.imports) if (!restoredAccess.access({type:'import',id:row.id}).available) throw Error('changed');
      applyLifecycle(owner,outcome.state); return {ids:entry.data.imports.map(row=>row.id),trashId:entry.id};
    }
    if (!Array.isArray(payload.items) || !payload.items.length || payload.items.length>500 || new Set(payload.items.map(row=>row?.id)).size!==payload.items.length) throw Error('invalid');
    const rows=payload.items.map(item=>{ const row=available(item.id,access); if (version(row)!==item.expectedVersion) throw Error('changed'); return row; });
    if (payload.action === 'update') {
      if (payload.destination) {
        const scope=folderScope(payload.destination,access),group=folderDescriptor(scope,access);
        if (group.version!==payload.destination.expectedVersion || !group.exact.length && !group.members.length) throw Error('changed');
        if (group.blockedReason==='folder_protected') throw Error('private');
      }
      const updates=payload.items.map(item=>patchValues(item.patch,access));
      rows.forEach((row,index)=>Object.assign(row,updates[index],{updatedAt:Math.max(Date.now(),(Number(row.updatedAt)||0)+1)}));
      return {ids:rows.map(row=>row.id)};
    }
    if (payload.action === 'remove') {
      if (!window.ContentLifecycle?.remove) throw Error('unavailable');
      const outcome=window.ContentLifecycle.remove(owner,rows.map(row=>({type:'import',id:row.id})),{}, {uid:()=> 'trash_' + payload.requestId});
      if (outcome.counts.import!==rows.length || !outcome.entry) throw Error('changed');
      outcome.entry.sourceQuickLinkRequestId=payload.requestId;
      applyLifecycle(owner,outcome.state); return {ids:rows.map(row=>row.id),trashId:outcome.entry.id};
    }
    throw Error('invalid');
  }
  async function applyFetch(owner,payload) {
    if (!Array.isArray(payload.items) || payload.items.length!==1 || Object.keys(payload.items[0] || {}).some(key=>!['id','expectedVersion'].includes(key))) throw Error('invalid');
    const item=payload.items[0], row=available(item.id,window.CitationEvidence.createAccessContext(owner));
    if (version(row)!==item.expectedVersion || !fetchable(row) || !row.quickLinkIdentity) throw Error('changed');
    const check=()=>{
      const blocked=readiness(); if (blocked) throw Error(blocked.reason);
      if (state!==owner || available(item.id,window.CitationEvidence.createAccessContext(owner))!==row || version(row)!==item.expectedVersion) throw Error('changed');
    };
    // The backend resolves only a durable, existing bookmark. The download
    // cannot race ahead of local creation, a title edit or a scope assignment.
    try { if (await saveDocumentDurably()!==true) throw Error(); } catch (_) { throw Error('storage_failed'); }
    check();
    let parsed, failure;
    try {
      const response=await fetch('/__fetch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        url:row.url,native:true,bookmark:{id:row.id,identity:row.quickLinkIdentity,updatedAt:row.updatedAt,requestId:payload.requestId}
      })});
      parsed=await response.json();
      if (!response.ok) failure={code:String(parsed?.code || 'FETCH_FAILED'),error:String(parsed?.error || '网页暂时无法读取，请稍后重试。').slice(0,500)};
      else if (parsed?.id!==row.id || parsed.bookmarkRequestId!==payload.requestId || parsed.fileStored!==true || parsed.storedLocally!==true
        || typeof parsed.content!=='string' || !Array.isArray(parsed.pages) || !normalizeURL(parsed.finalUrl)
        || typeof parsed.mimeType!=='string' || typeof parsed.name!=='string' || !Number.isSafeInteger(parsed.size) || parsed.size<=0) {
        failure={code:'INVALID_RECEIPT',error:'未收到可核对的原件保存回执，请重试；不会新建收藏。'};
      }
    } catch (_) { failure={code:'NETWORK_ERROR',error:'网络连接中断，收藏已保留。网络恢复后可重试获取正文。'}; }
    check();
    const now=Math.max(Date.now(),(Number(row.updatedAt)||0)+1);
    if (failure) {
      // Explicit failed attempts are durable, but never masquerade as content.
      // A user retry gets a fresh CAS envelope. A lost save ACK reuses this one.
      row.quickLinkFetch={status:'failed',...failure,attemptedAt:now}; row.updatedAt=now;
      return {ids:[row.id],fetchStatus:'failed',fetchError:failure.error};
    }
    Object.assign(row,{originalName:parsed.name,finalUrl:parsed.finalUrl,mimeType:parsed.mimeType,size:parsed.size,
      fileStored:true,content:parsed.content,pages:parsed.pages,parser:parsed.parser || 'web-original',
      contentTruncated:!!parsed.truncated,status:hasText(parsed)?'parsed':'original-only',error:String(parsed.warning || ''),
      fetchedAt:now,updatedAt:now,quickLinkFetch:{status:'ready',attemptedAt:now}});
    if (row.quickLinkTitleEdited!==true && parsed.name.trim()) row.name=parsed.name.trim();
    if (parsed.mimeType==='application/pdf') row.indexStatus='pending';
    return {ids:[row.id],fetchStatus:'ready',hasText:hasText(row)};
  }
  async function applyMetadata(owner,payload) {
    if (!Array.isArray(payload.items) || payload.items.length!==1 || Object.keys(payload.items[0] || {}).some(key=>!['id','expectedVersion'].includes(key))) throw Error('invalid');
    if (own(owner.ui,'nativeQuickLinkMetadata') && !object(owner.ui.nativeQuickLinkMetadata)) throw Error('unavailable');
    const item=payload.items[0],row=available(item.id,window.CitationEvidence.createAccessContext(owner));
    if (version(row)!==item.expectedVersion) throw Error('changed');
    const check=()=>{
      const blocked=readiness();if(blocked)throw Error(blocked.reason);
      if(state!==owner || available(item.id,window.CitationEvidence.createAccessContext(owner))!==row || version(row)!==item.expectedVersion)throw Error('changed');
    };
    try {if(await saveDocumentDurably()!==true)throw Error();}catch(_){throw Error('storage_failed');}
    check();
    let parsed,failure;
    try {
      const response=await fetch('/__bookmark-metadata',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:row.url,native:true,bookmark:{id:row.id,identity:row.quickLinkIdentity || '',updatedAt:Number(row.updatedAt)||0,requestId:payload.requestId}})});
      parsed=await response.json();
      if(!response.ok)failure=String(parsed?.error || '网站信息暂时不可用，已保存资料未改动。').slice(0,500);
      else if(parsed?.id!==row.id || parsed.bookmarkRequestId!==payload.requestId || !normalizeURL(parsed.finalUrl)
        || typeof parsed.title!=='string' || parsed.title.length>180 || typeof parsed.description!=='string' || parsed.description.length>500
        || !['ready','unavailable'].includes(parsed.iconStatus) || typeof parsed.iconDataUrl!=='string' || parsed.iconDataUrl && !iconData(parsed.iconDataUrl)
        || (parsed.iconStatus==='ready')!==!!parsed.iconDataUrl)failure='网站信息回执无法核对，已保存资料未改动。';
    } catch(_){failure='网络连接中断，原资料与图标已保留。可稍后重试网站信息。';}
    check();
    const previous=metadataFor(row),now=Date.now(),identity=row.quickLinkIdentity || payload.requestId+':'+row.id;
    if(failure){
      cacheMetadata(owner,row,{...(previous || {}),url:row.url,identity,status:'failed',error:failure,attemptedAt:now});
      return {ids:[row.id],metadataStatus:'failed',metadataError:failure};
    }
    // Main-library editors need not know the island's quickLinkTitleEdited
    // flag. Only a proven placeholder/last auto-title may be replaced.
    const autoTitle=row.importOrigin==='quick-links' && row.quickLinkTitleEdited===false && parsed.title.trim()
      && (row.parser==='bookmark' && row.name===new URL(row.url).hostname && row.originalName===row.name || previous?.autoTitle===row.name);
    cacheMetadata(owner,row,{url:row.url,identity,status:'ready',title:parsed.title,description:parsed.description,
      iconDataUrl:parsed.iconDataUrl || iconData(previous?.iconDataUrl),iconStatus:parsed.iconStatus,attemptedAt:now,
      ...(autoTitle ? {autoTitle:parsed.title.trim()} : {})});
    if(autoTitle){
      row.name=parsed.title.trim();row.updatedAt=Math.max(now,(Number(row.updatedAt)||0)+1);
    }
    return {ids:[row.id],metadataStatus:'ready',iconStatus:parsed.iconStatus,hasMetadata:!!(parsed.title || parsed.description || parsed.iconDataUrl)};
  }
  async function mutate(payload,signature) {
    let blocked=readiness(); if (blocked) return blocked;
    const owner=state;
    if (!window.crypto?.subtle?.digest) return fail('unavailable');
    const hash=Array.from(new Uint8Array(await window.crypto.subtle.digest('SHA-256',new TextEncoder().encode(signature))),byte=>byte.toString(16).padStart(2,'0')).join('');
    blocked=readiness(); if (blocked) return blocked; if (state!==owner) return fail('changed');
    const ledger=owner.ui.nativeQuickLinkReceipts ||= {};
    let receipt=own(ledger,payload.requestId) ? ledger[payload.requestId] : null;
    if (receipt && receipt.hash!==hash) return fail('collision');
    if (!receipt) {
      try {
        const result=payload.action==='fetch' ? await applyFetch(owner,payload) : payload.action==='metadata' ? await applyMetadata(owner,payload) : apply(owner,payload,window.CitationEvidence.createAccessContext(owner));
        const records=payload.action==='remove' ? owner.trash.find(row=>row.id===result.trashId).data.imports : owner.imports.filter(row=>result.ids.includes(row.id));
        const identities={};
        for (const row of records) { row.quickLinkIdentity ||= payload.requestId + ':' + row.id; identities[row.id]=row.quickLinkIdentity; }
        receipt=ledger[payload.requestId]={hash,action:payload.action,...result,identities};
      } catch (error) { return fail(error.message); }
    }
    // Exact retry envelopes survive lost ACKs. Never reapply an old edit,
    // recreate a deleted link, or restore a subsequently purged trash entry.
    const access=window.CitationEvidence.createAccessContext(state);
    if (receipt.action.startsWith('folder-')) { try { validateFolderReceipt(receipt,access); } catch(error) { return fail(error.message); } }
    for (const id of receipt.ids) if (access.access({type:'import',id}).kind==='private') return fail('private');
    if (receipt.action==='remove') {
      const entry=state.trash.find(row=>row.id===receipt.trashId);
      if (!entry) return fail('removed');
      if (list(entry.data?.imports).length!==receipt.ids.length || receipt.ids.some(id=>entry.data.imports.find(row=>row.id===id)?.quickLinkIdentity!==receipt.identities?.[id])) return fail('changed');
    } else {
      try { for (const id of receipt.ids) { const row=available(id,access); if (!receipt.identities?.[id] || row.quickLinkIdentity!==receipt.identities[id]) return fail('collision'); } } catch(error) { return fail(error.message); }
    }
    try { if (await saveDocumentDurably()!==true) return fail('storage_failed'); } catch (_) { return fail('storage_failed'); }
    blocked=readiness(); if (blocked) return blocked;
    if (state!==owner || owner.ui.nativeQuickLinkReceipts?.[payload.requestId]!==receipt) return fail('changed');
    const after=window.CitationEvidence.createAccessContext(state);
    if (receipt.action.startsWith('folder-')) { try { validateFolderReceipt(receipt,after); } catch(error) { return fail(error.message); } }
    if (receipt.ids.some(id=>after.access({type:'import',id}).kind==='private')) return fail('private');
    if (receipt.action==='remove' ? !state.trash.some(row=>row.id===receipt.trashId) : receipt.ids.some(id=>!after.access({type:'import',id}).available)) return fail('removed');
    const settledRecords=receipt.action==='remove' ? state.trash.find(row=>row.id===receipt.trashId).data.imports : state.imports;
    if (receipt.ids.some(id=>settledRecords.find(row=>row.id===id)?.quickLinkIdentity!==receipt.identities?.[id])) return fail('collision');
    try { document.dispatchEvent(new CustomEvent('records-committed',{detail:{source:'native-quick-links',owner,collection:receipt.action.startsWith('folder-') ? 'folders' : 'imports',action:receipt.action,ids:receipt.ids,folderIds:receipt.folderId?[receipt.folderId]:[]}})); } catch (_) {}
    if (receipt.action==='fetch' && receipt.fetchStatus==='ready') {
      try { for (const id of receipt.ids) if (state.imports.find(row=>row.id===id)?.mimeType==='application/pdf') window.PdfTextIndex?.enqueue(id); } catch (_) {}
    }
    return {status:'saved',requestId:payload.requestId,action:receipt.action,ids:receipt.ids,trashId:receipt.trashId || null,duplicate:!!receipt.duplicate,
      ...(receipt.action.startsWith('folder-') ? {folderId:receipt.folderId,groupId:folderKey(receipt.folderScope),previousGroupId:receipt.previousGroupId||null} : {}),
      ...(receipt.action==='fetch' ? {fetchStatus:receipt.fetchStatus,fetchError:receipt.fetchError || '',hasText:!!receipt.hasText} : {}),
      ...(receipt.action==='metadata' ? {metadataStatus:receipt.metadataStatus,metadataError:receipt.metadataError || '',iconStatus:receipt.iconStatus || 'unavailable',hasMetadata:!!receipt.hasMetadata} : {})};
  }
  function request(payload) {
    if (!object(payload)) return Promise.resolve(fail('invalid'));
    if (payload.action==='list') return Promise.resolve(snapshot(payload));
    if (payload.action==='open') {
      const blocked=readiness(); if (blocked) return Promise.resolve(blocked);
      try { const row=available(payload.id,window.CitationEvidence.createAccessContext(state)); return Promise.resolve({status:'ready',id:row.id,url:normalizeURL(row.url)}); } catch (error) { return Promise.resolve(fail(error.message)); }
    }
    if (!['add','update','remove','restore','fetch','metadata','folder-create','folder-rename','folder-delete'].includes(payload.action) || !requestPattern.test(payload.requestId || '')) return Promise.resolve(fail('invalid'));
    const signature=JSON.stringify(payload,(_,value)=>object(value) ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])) : value);
    if (pending) return pending.signature===signature ? pending.promise : Promise.resolve(fail('busy',true));
    const promise=mutate(payload,signature).catch(()=>fail('unavailable')).finally(()=>{ if (pending?.promise===promise) pending=null; });
    pending={signature,promise}; return promise;
  }
  window.NativeQuickLinks=Object.freeze({request});
})();
