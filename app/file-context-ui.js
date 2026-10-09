(function(root){
 'use strict';
 let hooks, panel, results, filter, status, tabs, chips, button, origin, trigger, mode='library', localProject=null, localPath='', nextOffset=null, rows=[], selected=0, epoch=0, aborter, choosing=false;
 const previews=new Set();
 const F=root.FileContext,doc=root.document;
 const t=(zh,en)=>root.WorkstationI18n?.getLanguage?.()==='en'?en:zh;
 const el=(tag,cls,text)=>{const n=doc.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
 function btn(text,action,cls=''){const b=el('button',cls,text);b.type='button';b.onclick=action;return b;}
 const state=()=>hooks.getState();
 const current=()=>hooks?.getConversation?.();
 const isPrivate=()=>!!(hooks?.isPrivate?.()||root.PrivateMode?.isOn?.()||current()?.private||current()?.ephemeral||current()?.incognito);
 const unavailable=()=>Error(t('该来源已不可用或已设为私密。','This source is unavailable or private.'));
 const stale=()=>Error(t('对话已切换，请重新选择资料。','The conversation changed. Select the source again.'));
 function access(ref){
  const checker=root.CitationEvidence?.access||root.ContextWorkbench?.access;
  if(checker)return checker(state(),ref);
  const record=ref.type==='local'?(state().projects||[]).find(p=>p.id===ref.projectId):F.available(state(),ref.type,ref.id);
  const project=ref.type==='local'?record:(state().projects||[]).find(p=>p.id===record?.projectId);
  if([ref,record,project].some(v=>v?.private||v?.ephemeral||v?.incognito))return {kind:'private',available:false};
  return {kind:F.active(record)&&(!record.projectId||F.active(project))&&(ref.type!=='local'||project?.localFolder?.id===ref.candidateId)?'available':'missing',available:!!(F.active(record)&&(!record.projectId||F.active(project))&&(ref.type!=='local'||project?.localFolder?.id===ref.candidateId))};
 }
 function ownerValid(owner){return !!owner&&current()?.id===owner&&F.active(current())&&!isPrivate();}
 function assertAccess(ref,owner){if(!ownerValid(owner))throw stale();if(!access(ref).available)throw unavailable();}
 function projectAvailable(project){return project&&access({type:'local',projectId:project.id,candidateId:project.localFolder?.id}).available;}
 function clearPreview(view){view.aborter.abort();view.content.textContent='';view.title.textContent='';if(view.dialog.open)view.dialog.close();view.dialog.remove();previews.delete(view);}
 function validatePreviews(){for(const view of previews)if(!ownerValid(view.owner)||!access(view.ref).available)clearPreview(view);}
 function notify(){render();hooks.onChange?.();}
 async function mutate(command){
  if(!ownerValid(command.conversationId))throw stale();
  if(hooks.mutate){if(await hooks.mutate(command)===false)throw Error(t('未能保存修改，请重试。','Could not save changes. Try again.'));return;}
  // Legacy hosts still persist asynchronously. Only roll back fields that have
  // not changed again while the save was pending.
  const updated=command.action==='refresh-reference'?await selectRef(command.ref,{conversationId:command.conversationId}):null;
  if(!ownerValid(command.conversationId))throw stale();
  if(updated)assertAccess(updated,command.conversationId);
  const conversation=current(),fields=['draftFileReferences','excludedFileReferenceKeys','draftAttachmentIds'];
  const before=new Map(fields.map(k=>[k,{exists:Object.hasOwn(conversation,k),value:structuredClone(conversation[k])}]));
  const reference=updated||command.ref||{type:'import',id:command.id},contextBefore=F.contextSnapshot(conversation,reference);
  if(command.action==='add-reference')F.stage(conversation,command.ref);
  else if(command.action==='refresh-reference')F.stage(conversation,updated);
  else {F.remove(conversation,command.ref||{type:'import',id:command.id});if(command.action==='remove-attachment')conversation.draftAttachmentIds=(conversation.draftAttachmentIds||[]).filter(id=>id!==command.id);}
  const applied=new Map(fields.map(k=>[k,JSON.stringify(conversation[k])]));
  const contextAfter=F.contextSnapshot(conversation,reference);
  try{if(await hooks.save?.()===false)throw Error(t('未能保存修改，请重试。','Could not save changes. Try again.'));}
  catch(error){F.rollbackContext(conversation,reference,contextBefore,contextAfter);for(const key of fields)if(JSON.stringify(conversation[key])===applied.get(key)){const old=before.get(key);if(old.exists)conversation[key]=old.value;else delete conversation[key];}throw error;}
 }

 function close(){epoch++;aborter?.abort();if(panel){panel.hidden=true;results.replaceChildren();status.textContent='';filter.value='';rows=[];}button?.setAttribute('aria-expanded','false');doc.querySelector('#agentInput')?.removeAttribute('aria-activedescendant');trigger=null;}
 function place(){const rect=doc.querySelector('#composer').getBoundingClientRect();panel.style.width=`${Math.min(580,rect.width,innerWidth-24)}px`;panel.style.left=`${Math.max(12,Math.min(rect.left,innerWidth-panel.offsetWidth-12))}px`;panel.style.bottom=`${Math.max(12,innerHeight-rect.top+8)}px`;panel.style.maxHeight=`${Math.max(120,rect.top-20)}px`;}
 function highlight(){[...results.querySelectorAll('[role=option]')].forEach((node,i)=>{node.setAttribute('aria-selected',String(i===selected));if(i===selected){doc.querySelector('#agentInput').setAttribute('aria-activedescendant',node.id);node.scrollIntoView({block:'nearest'});}});}
 function draw(list){rows=list;selected=0;results.replaceChildren();list.forEach((item,i)=>{const row=btn('',()=>choose(item),'file-context-option');row.id=`file-context-option-${i}`;if(['local','import'].includes(item.type)&&!item.directory)row.dataset.fileRef=JSON.stringify(item);row.setAttribute('role','option');row.append(el('span','file-context-symbol',item.directory?'▸':item.type==='note'?'≡':item.type==='project'?'▱':'▤'));const copy=el('span','file-context-copy');const title=el('strong','',item.title);title.dataset.userContent='';const meta=el('small','',item.location||'');meta.dataset.userContent='';copy.append(title,meta);row.append(copy);if(item.disabled){row.disabled=true;row.append(el('small','',t('附件导入','Import as attachment')));}results.append(row);});if(!list.length)results.append(el('p','file-context-empty',t('没有匹配文件','No matching files')));highlight();place();}
 async function load(){
  if(!ownerValid(origin)){close();return;}
  const ticket=++epoch;aborter?.abort();aborter=new AbortController();status.textContent='';filter.placeholder=mode==='local'?t('筛选当前目录…','Filter this folder…'):t('搜索文件或笔记…','Search files or notes…');tabs.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===mode)));
  if(mode==='library'){const all=F.search(state(),filter.value,current().projectId).filter(item=>access(item).available);const limit=Number(results.dataset.limit)||80;draw(all.slice(0,limit));if(all.length>limit)results.append(btn(t('加载更多','Load more'),()=>{results.dataset.limit=limit+80;load();},'file-context-more'));status.textContent=t('引用随当前对话保留；可随时移除。','References stay with this conversation until removed.');return;}
  if(!localProject){draw(state().projects.filter(p=>p.localFolder?.id&&projectAvailable(p)).map(p=>({type:'project',id:p.id,title:p.name,location:p.localFolder.name||'',directory:true})));status.textContent=t('仅浏览已连接项目；其他格式可拖入附件。','Browse connected projects. Drag other formats in as attachments.');return;}
  const project=state().projects.find(p=>p.id===localProject&&projectAvailable(p));if(!project){localProject=null;return load();}
  status.textContent=t('正在列出文件…','Listing files…');
  try{const data=await F.request('/__local/files',{candidateId:project.localFolder.id,path:localPath,offset:0},aborter.signal);if(ticket!==epoch||panel.hidden)return;if(!ownerValid(origin)||!projectAvailable(project)){close();return;}nextOffset=data.nextOffset;const all=data.entries.map(r=>({...r,type:'local',projectId:project.id,candidateId:project.localFolder.id,title:r.name,location:localPath||project.name,directory:r.type==='directory',disabled:!r.supported}));drawLocal(all);status.textContent=`${project.name} / ${localPath||''}`;}
  catch(error){if(ticket===epoch){if(!ownerValid(origin)||!projectAvailable(project)){close();return;}draw([]);status.textContent=error.message;}}
 }
 function drawLocal(all){const query=filter.value.toLocaleLowerCase();draw([{type:'back',title:t('返回上一级','Parent folder'),directory:true},...all.filter(r=>r.title.toLocaleLowerCase().includes(query))]);if(nextOffset!==null)results.append(btn(t('加载更多文件','Load more files'),async event=>{event.currentTarget.disabled=true;const ticket=epoch,project=state().projects.find(p=>p.id===localProject);if(!ownerValid(origin)||!projectAvailable(project)){close();return;}try{const data=await F.request('/__local/files',{candidateId:project.localFolder.id,path:localPath,offset:nextOffset},aborter.signal);if(ticket!==epoch)return;if(!ownerValid(origin)||!projectAvailable(project)){close();return;}nextOffset=data.nextOffset;drawLocal([...all,...data.entries.map(r=>({...r,type:'local',projectId:project.id,candidateId:project.localFolder.id,title:r.name,location:localPath||project.name,directory:r.type==='directory',disabled:!r.supported}))]);}catch(error){if(ticket!==epoch)return;if(!ownerValid(origin)||!projectAvailable(project)){close();return;}status.textContent=error.message;}},'file-context-more'));}
 async function selectRef(item,{conversationId=current()?.id,signal}={}){
  assertAccess(item,conversationId);
  let ref;
  if(item.type==='local'){
   const result=await F.request('/__local/read',{candidateId:item.candidateId,path:item.path,offset:0},signal);
   ref={type:'local',candidateId:item.candidateId,projectId:item.projectId,path:item.path,title:item.title,version:result.version,selectedAt:Date.now()};
  }else ref=await F.libraryRef(state(),item.type,item.id);
  assertAccess(item,conversationId);return ref;
 }
 async function choose(item){
  if(item.disabled||choosing||!ownerValid(origin))return;
  if(item.type==='project'){const project=state().projects.find(p=>p.id===item.id);if(!projectAvailable(project)){refresh();return;}localProject=item.id;localPath='';filter.value='';return load();}
  if(item.type==='back'){if(localPath)localPath=localPath.split('/').slice(0,-1).join('/');else localProject=null;return load();}
  if(item.directory){if(!access(item).available){refresh();return;}localPath=item.path;filter.value='';return load();}
  const owner=origin,ticket=epoch,input=doc.querySelector('#agentInput'),token=trigger,originalInput=input.value;status.textContent=t('正在引用…','Adding reference…');choosing=true;
  try{
   const ref=await selectRef(item,{conversationId:owner,signal:aborter?.signal});if(ticket!==epoch||!ownerValid(owner))return;
   await mutate({conversationId:owner,action:'add-reference',ref});
   if(ticket!==epoch||!ownerValid(owner)){notify();return;}
   if(token&&input.value===originalInput){input.value=input.value.slice(0,token.start)+input.value.slice(token.end);input.setSelectionRange(token.start,token.start);input.dispatchEvent(new Event('input',{bubbles:true}));}
   close();notify();input.focus();
  }catch(error){if(ticket===epoch){if(!ownerValid(owner)||!access(item).available)refresh();else status.textContent=error.message;}}
  finally{choosing=false;}
 }
 function open(token=null){if(!current()||isPrivate())return;origin=current().id;trigger=token;mode='library';localProject=null;localPath='';filter.value=token?.query||'';results.dataset.limit='80';panel.hidden=false;button.setAttribute('aria-expanded','true');place();load();if(!token)filter.focus();}
 function render(){
  if(!chips)return;validatePreviews();if(!panel.hidden&&!ownerValid(origin))close();if(!panel.hidden)requestAnimationFrame(place);chips.replaceChildren();const refs=isPrivate()?[]:F.references(current());chips.hidden=!refs.length;
  for(const ref of refs){
   const visibility=access(ref),hidden=visibility.kind==='private',owner=current()?.id;
   const row=el('span','file-context-chip');const label=btn(hidden?t('私密来源','Private source'):ref.title,()=>preview(ref),'file-context-chip-name');label.disabled=!visibility.available;label.dataset.userContent='';
   if(visibility.available){label.dataset.fileRef=JSON.stringify(ref);label.title=ref.path||ref.title;}
   const update=btn('↻',async()=>{update.disabled=true;try{await mutate({conversationId:owner,action:'refresh-reference',ref});notify();if(ownerValid(owner))hooks.toast?.(t('引用已更新，可继续发送。','Reference updated. You can continue.'));}catch(error){refresh();if(ownerValid(owner))hooks.toast?.(access(ref).available?error.message:unavailable().message);}},'file-context-chip-action');update.disabled=!visibility.available;update.setAttribute('aria-label',t('更新引用','Refresh reference'));
   const remove=btn('×',async()=>{remove.disabled=true;try{await mutate({conversationId:owner,action:ref.type==='import'?'remove-attachment':'remove-reference',ref,id:ref.id});notify();}catch(error){refresh();if(ownerValid(owner))hooks.toast?.(error.message);}},'file-context-chip-action');remove.setAttribute('aria-label',t('移除引用','Remove reference'));row.append(label,update,remove);chips.append(row);
  }
 }
 function refresh(){
  render();if(!panel||panel.hidden)return;
  if(mode==='library'){load();return;}
  // Refreshing the UI never reads or lists local files. Revoke stale rows and
  // previews immediately, and leave further filesystem reads to user actions.
  if(localProject){const project=state().projects.find(p=>p.id===localProject);if(!projectAvailable(project)){close();return;}const valid=rows.filter(item=>item.type==='back'||access(item).available);if(valid.length!==rows.length)draw(valid);}
  else draw((state().projects||[]).filter(p=>p.localFolder?.id&&projectAvailable(p)).map(p=>({type:'project',id:p.id,title:p.name,location:p.localFolder.name||'',directory:true})));
 }
 async function preview(ref){
  const owner=current()?.id;
  try{assertAccess(ref,owner);}catch{refresh();return false;}
  if(ref.type!=='local')return hooks.open(ref.type,ref.id);
  const dialog=el('dialog','file-reference-preview');const head=el('header');const title=el('strong','',ref.path);title.dataset.userContent='';head.append(title,btn('×',()=>dialog.close()));const content=el('pre');content.dataset.userContent='';const foot=el('footer');dialog.append(head,content,foot);doc.body.append(dialog);
  const view={dialog,title,content,ref,owner,aborter:new AbortController()};previews.add(view);dialog.addEventListener('close',()=>clearPreview(view));dialog.showModal();let cursor=0;
  const more=btn(t('继续读取','Read more'),()=>read());foot.append(more);
  async function read(){
   if(!ownerValid(owner)||!access(ref).available){clearPreview(view);return;}more.disabled=true;
   try{const part=await F.request('/__local/read',{candidateId:ref.candidateId,path:ref.path,version:ref.version,offset:cursor},view.aborter.signal);if(!dialog.open)return;if(!ownerValid(owner)||!access(ref).available){clearPreview(view);return;}content.textContent+=part.text;cursor=part.nextOffset;more.hidden=cursor===null;more.disabled=false;}
   catch(error){if(!dialog.open)return;if(!ownerValid(owner)||!access(ref).available){clearPreview(view);return;}content.textContent=error.message;more.hidden=true;}
  }
  await read();return dialog.open;
 }
 function handleKey(event){if(panel.hidden||event.isComposing||event.keyCode===229)return false;if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();close();return true;}if(['ArrowDown','ArrowUp','Enter'].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();if(event.key==='Enter'){if(rows[selected])choose(rows[selected]);}else{selected=(selected+(event.key==='ArrowDown'?1:-1)+rows.length)%Math.max(1,rows.length);highlight();}return true;}return false;}
 function init(value){hooks=value;if(panel)return;const input=doc.querySelector('#agentInput');chips=el('div','file-context-chips');chips.id='fileContextChips';doc.querySelector('#stagedAttachments').after(chips);button=btn('@',()=>panel.hidden?open():close(),'composer-reference');button.id='composerReference';button.title=t('引用文件（@）','Reference files (@)');button.setAttribute('aria-label',button.title);button.setAttribute('aria-expanded','false');button.setAttribute('aria-controls','fileContextPicker');(root.ComposerUI?.rootFor(doc.querySelector('#chatAttach'))||doc.querySelector('#chatAttach')).after(button);
  panel=el('section','file-context-picker');panel.id='fileContextPicker';panel.hidden=true;panel.setAttribute('aria-label',t('选择引用文件','Select file references'));filter=el('input','file-context-search');filter.placeholder=t('搜索文件或笔记…','Search files or notes…');filter.setAttribute('aria-label',filter.placeholder);tabs=el('div','file-context-tabs');for(const [name,zh,en] of [['library','资料与笔记','Library & notes'],['local','本机文件','Local files']]){const b=btn(t(zh,en),()=>{mode=name;filter.value='';load();});b.dataset.mode=name;tabs.append(b);}results=el('div','file-context-options');results.setAttribute('role','listbox');results.id='fileContextOptions';status=el('p','file-context-status');status.setAttribute('role','status');panel.append(filter,tabs,results,status);if(root.FileCapabilities)panel.append(btn(t("支持的文件与处理范围","Supported files and capabilities"),()=>root.FileCapabilities.open(),"file-context-more"));doc.body.append(panel);
  filter.addEventListener('input',()=>{results.dataset.limit='80';load();});filter.addEventListener('keydown',handleKey);input.addEventListener('keydown',handleKey,true);input.setAttribute('aria-controls','fileContextOptions');input.addEventListener('input',event=>{if(event.isComposing)return;const token=F.mention(input.value,input.selectionStart);if(token){if(panel.hidden)open(token);else{trigger=token;filter.value=token.query;mode='library';load();}}else if(!panel.hidden&&trigger)close();});
  doc.addEventListener('pointerdown',event=>{if(!panel.hidden&&!panel.contains(event.target)&&event.target!==input&&!button.contains(event.target))close();});root.addEventListener('resize',()=>{if(!panel.hidden)place();});if(root.ResizeObserver)new ResizeObserver(()=>{if(!panel.hidden)place();}).observe(doc.querySelector('#composer'));doc.addEventListener('workstation-language-change',()=>{button.title=t('引用文件（@）','Reference files (@)');button.setAttribute('aria-label',button.title);tabs.querySelector('[data-mode=library]').textContent=t('资料与笔记','Library & notes');tabs.querySelector('[data-mode=local]').textContent=t('本机文件','Local files');render();if(!panel.hidden)load();});
  doc.addEventListener('pointerdown',event=>{const target=event.target.closest('[data-open-note],[data-open-import]');if(target)target.draggable=true;});
  doc.addEventListener('dragstart',event=>{const target=event.target.closest('[data-open-note],[data-open-import]');if(!target||!event.dataTransfer)return;const type=target.dataset.openNote?'note':'import',id=target.dataset.openNote||target.dataset.openImport;event.dataTransfer.setData('application/x-aibro-reference',JSON.stringify({type,id}));});
  const composer=doc.querySelector('#composer');composer.addEventListener('dragover',event=>{if([...event.dataTransfer.types].includes('application/x-aibro-reference'))event.preventDefault();});composer.addEventListener('drop',async event=>{const raw=event.dataTransfer.getData('application/x-aibro-reference');if(!raw)return;event.preventDefault();event.stopPropagation();const owner=current()?.id;try{const item=JSON.parse(raw);if(!['note','import'].includes(item.type))return;const ref=await selectRef(item,{conversationId:owner});if(!ownerValid(owner))return;await mutate({conversationId:owner,action:'add-reference',ref});notify();}catch(error){if(ownerValid(owner))hooks.toast?.(error.message);}},true);
  render();
 }
 root.FileContextUI={init,open,close,render,refresh,preview,selectRef};
})(globalThis);
