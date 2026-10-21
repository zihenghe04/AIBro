(function(root){
 'use strict';
 let hooks,menu,opener;
 const t=(zh,en)=>root.WorkstationI18n?.getLanguage?.()==='en'?en:zh;
 const wikiFile=id=>!!hooks.getState()._wikiFiles?.[id];
 // A file row names its record: library/collection rows, file-tree rows and
 // explicit note/import links. Notes outside the wiki tree can be asked about
 // but have no Finder file of their own.
 function reference(target){
  const note=target.closest('[data-open-note],[data-wiki-tree-note]');if(note){const id=note.dataset.openNote||note.dataset.wikiTreeNote;if(wikiFile(id)||hooks.ask)return {type:'note',id};}
  const row=target.closest('[data-cui-kind][data-cui-id]');if(row&&['note','import'].includes(row.dataset.cuiKind))return {type:row.dataset.cuiKind,id:row.dataset.cuiId};
  const local=target.closest('[data-file-ref]');if(local){try{return JSON.parse(local.dataset.fileRef);}catch{return null;}}
  const tree=target.closest('[data-document-file-key]');
  if(tree){try{const [kind,id]=JSON.parse(tree.dataset.documentFileKey);if(kind==='note'||kind==='import')return {type:kind,id};
   if(kind==='local-file'){const [projectId,candidateId,path]=JSON.parse(id);return {type:'local',projectId,candidateId,path,title:String(path).split('/').at(-1)};}}catch{}return null;}
  const node=target.closest('[data-open-import],[data-open-import-context],[data-stage-import]');
  if(node)return {type:'import',id:node.dataset.openImport||node.dataset.openImportContext||node.dataset.stageImport};
  if(target.closest('#previewDialog')){const r=hooks.getState().previewRecord;if(r?.type==='import'||r?.type==='note'&&hooks.getState()._wikiFiles?.[r.id])return {type:r.type,id:r.id};}
  return null;
 }
 async function reveal(ref){
  if(ref.type==='local'&&!hooks.getState().projects.some(p=>root.FileContext.active(p)&&p.id===ref.projectId&&p.localFolder?.id===ref.candidateId))throw Error(t('本机项目已断开或归档。','The local project is disconnected or archived.'));
  const result=await root.FileContext.request('/__local/reveal',ref.type==='local'?{type:'local',candidateId:ref.candidateId,path:ref.path}:{type:ref.type,id:ref.id});
  if(result.exported)hooks.toast(t('已在 Finder 中显示具名副本；修改副本不会影响知识库原件。','Showing a named copy in Finder. Editing it does not change the library original.'));
  return result;
 }
 function close(focus=false){if(menu){menu.remove();menu=null;}if(focus&&opener?.isConnected)opener.focus();}
 const revealable=ref=>!!root.workstationDesktop?.isDesktop&&(ref.type!=='note'||wikiFile(ref.id));
 const askable=ref=>typeof hooks.ask==='function'&&hooks.canAsk?.()!==false;
 function show(event,ref){
  event.preventDefault();close();opener=event.target.closest('button,[data-cui-key]')||event.target;
  menu=document.createElement('div');menu.className='file-action-menu';menu.setAttribute('role','menu');
  const item=(label,run)=>{const action=document.createElement('button');action.type='button';action.setAttribute('role','menuitem');action.tabIndex=-1;action.textContent=label;action.onclick=run;menu.append(action);};
  if(askable(ref)){const anchor=opener;item(t('问 AI · 就这份资料提问','Ask AI about this file'),async()=>{close(false);try{await hooks.ask(ref,anchor?.isConnected?anchor:null);}catch(error){hooks.toast(error.message);}});}
  if(revealable(ref))item(t('在 Finder 中显示','Show in Finder'),async()=>{close(true);try{await reveal(ref);}catch(error){hooks.toast(error.message);}});
  // Keep menus in the top layer when invoked from a modal file preview.
  (event.target.closest('dialog[open]')||document.body).append(menu);
  const rect=opener.getBoundingClientRect(),x=event.clientX||rect.left,y=event.clientY||rect.bottom;
  menu.style.left=Math.max(8,Math.min(x,innerWidth-menu.offsetWidth-8))+'px';menu.style.top=Math.max(8,Math.min(y,innerHeight-menu.offsetHeight-8))+'px';menu.querySelector('button').focus();
 }
 function init(value){hooks=value;document.addEventListener('contextmenu',event=>{const ref=reference(event.target);if(!ref||!['import','local','note'].includes(ref.type)||!revealable(ref)&&!askable(ref))return;if(['import','note'].includes(ref.type)&&!root.FileContext.available(hooks.getState(),ref.type,ref.id))return;show(event,ref);});
  document.addEventListener('pointerdown',event=>{if(menu&&!menu.contains(event.target))close();},true);
  document.addEventListener('keydown',event=>{if(!menu)return;if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();close(true);}else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const items=[...menu.querySelectorAll('button')],at=items.indexOf(document.activeElement),last=items.length-1;
   items[event.key==='Home'?0:event.key==='End'?last:event.key==='ArrowDown'?(at+1)%items.length:(at<=0?last:at-1)].focus();}},true);
  root.addEventListener('resize',()=>close());document.addEventListener('scroll',()=>close(),true);
 }
 root.FileActions={init,reveal,reference,close};
})(globalThis);
