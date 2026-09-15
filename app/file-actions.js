(function(root){
 'use strict';
 let hooks,menu,opener;
 const t=(zh,en)=>root.WorkstationI18n?.getLanguage?.()==='en'?en:zh;
 function reference(target){
  const note=target.closest('[data-open-note],[data-wiki-tree-note]');if(note){const id=note.dataset.openNote||note.dataset.wikiTreeNote;if(hooks.getState()._wikiFiles?.[id])return {type:'note',id};}
  const local=target.closest('[data-file-ref]');if(local){try{return JSON.parse(local.dataset.fileRef);}catch{return null;}}
  const node=target.closest('[data-open-import],[data-open-import-context],[data-stage-import]');
  if(node)return {type:'import',id:node.dataset.openImport||node.dataset.openImportContext||node.dataset.stageImport};
  if(target.closest('#previewDialog')){const r=hooks.getState().previewRecord;if(r?.type==='import'||r?.type==='note'&&hooks.getState()._wikiFiles?.[r.id])return {type:r.type,id:r.id};}
  return null;
 }
 async function reveal(ref){
  if(ref.type==='local'&&!hooks.getState().projects.some(p=>root.FileContext.active(p)&&p.id===ref.projectId&&p.localFolder?.id===ref.candidateId))throw Error(t('本机项目已断开或归档。','The local project is disconnected or archived.'));
  return root.FileContext.request('/__local/reveal',ref.type==='local'?{type:'local',candidateId:ref.candidateId,path:ref.path}:{type:ref.type,id:ref.id});
 }
 function close(focus=false){if(menu){menu.remove();menu=null;}if(focus&&opener?.isConnected)opener.focus();}
 function show(event,ref){
  event.preventDefault();close();opener=event.target.closest('button')||event.target;
  menu=document.createElement('div');menu.className='file-action-menu';menu.setAttribute('role','menu');
  const action=document.createElement('button');action.type='button';action.setAttribute('role','menuitem');action.textContent=t('在 Finder 中显示','Show in Finder');
  action.onclick=async()=>{close(true);try{await reveal(ref);}catch(error){hooks.toast(error.message);}};menu.append(action);
  // Keep menus in the top layer when invoked from a modal file preview.
  (event.target.closest('dialog[open]')||document.body).append(menu);
  const rect=opener.getBoundingClientRect(),x=event.clientX||rect.left,y=event.clientY||rect.bottom;
  menu.style.left=Math.max(8,Math.min(x,innerWidth-menu.offsetWidth-8))+'px';menu.style.top=Math.max(8,Math.min(y,innerHeight-menu.offsetHeight-8))+'px';action.focus();
 }
 function init(value){hooks=value;document.addEventListener('contextmenu',event=>{const ref=reference(event.target);if(!ref||!['import','local','note'].includes(ref.type)||!root.workstationDesktop?.isDesktop)return;if(['import','note'].includes(ref.type)&&!root.FileContext.available(hooks.getState(),ref.type,ref.id))return;show(event,ref);});
  document.addEventListener('pointerdown',event=>{if(menu&&!menu.contains(event.target))close();},true);
  document.addEventListener('keydown',event=>{if(!menu)return;if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();close(true);}else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();menu.querySelector('button').focus();}},true);
  root.addEventListener('resize',()=>close());document.addEventListener('scroll',()=>close(),true);
 }
 root.FileActions={init,reveal,reference};
})(globalThis);
