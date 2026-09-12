(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.WorkstationTrash=api;}(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  const MAX_BATCH=2000;
  const types={project:'项目',conversation:'对话',task:'任务',note:'知识',paper:'论文',import:'资料',content:'内容'};
  function createController(hooks,environment=root){
    const doc=environment.document,selected=new Set();let confirmation;
    const node=(tag,cls,text)=>{const e=doc.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
    const button=(text,cls,fn)=>{const e=node('button',cls,text);e.type='button';e.addEventListener('click',fn);return e;};
    const items=()=>Array.isArray(hooks.getState().trash)?hooks.getState().trash:[];
    const busy=()=>!!hooks.isBusy?.();
    function render(){
      const box=doc.querySelector('#trashList'),toolbar=doc.querySelector('#trashToolbar');if(!box||!toolbar)return;
      const rows=items(),ids=new Set(rows.map(r=>r.id));for(const id of selected)if(!ids.has(id))selected.delete(id);
      toolbar.replaceChildren();toolbar.hidden=!rows.length;box.replaceChildren();box.classList.toggle('empty-list',!rows.length);
      const selectLabel=node('label','trash-select-all'),all=node('input');all.type='checkbox';all.id='trashSelectAll';all.setAttribute('aria-label','选择回收站记录');all.disabled=busy();all.checked=!!rows.length&&selected.size===rows.length;all.indeterminate=selected.size>0&&selected.size<rows.length;
      all.addEventListener('change',()=>{selected.clear();if(all.checked)rows.slice(0,MAX_BATCH).forEach(r=>selected.add(r.id));if(all.checked&&rows.length>MAX_BATCH)hooks.toast?.('一次最多处理 2000 条，已选择前 2000 条。');render();});
      selectLabel.append(all,node('span','',selected.size?`已选择 ${selected.size} / ${rows.length} 条`:`共 ${rows.length} 条`));toolbar.append(selectLabel);
      const actions=node('div','trash-bulk-actions');
      const clear=button('取消选择','text-action',()=>{selected.clear();render();});clear.id='trashClearSelection';clear.hidden=!selected.size;clear.disabled=busy();
      const remove=button('永久删除所选','danger-button',()=>hooks.purge([...selected],{bulk:true}));remove.id='trashDeleteSelected';remove.disabled=busy()||!selected.size;
      const empty=button('清空回收站','secondary',()=>hooks.purge(rows.map(r=>r.id),{empty:true}));empty.id='trashEmpty';empty.disabled=busy()||!rows.length||rows.length>MAX_BATCH;if(rows.length>MAX_BATCH)empty.title='回收站超过 2000 条，请先分批勾选删除。';
      actions.append(clear,remove,empty);toolbar.append(actions);
      if(!rows.length){box.append(node('p','trash-empty-message','回收站为空。'));return;}
      rows.slice().reverse().forEach(entry=>{
        const row=node('div','trash-row'),check=node('input','trash-check');row.dataset.trashId=entry.id;row.classList.toggle('selected',selected.has(entry.id));check.type='checkbox';check.checked=selected.has(entry.id);check.disabled=busy();check.dataset.trashSelect=entry.id;check.setAttribute('aria-label',`选择 ${entry.title||'已删除内容'}`);
        check.addEventListener('change',()=>{if(check.checked&&selected.size>=MAX_BATCH){check.checked=false;hooks.toast?.('一次最多选择 2000 条。');return;}if(check.checked)selected.add(entry.id);else selected.delete(entry.id);render();doc.querySelectorAll('[data-trash-select]').forEach(e=>{if(e.dataset.trashSelect===entry.id)e.focus({preventScroll:true});});});
        const copy=node('div','trash-row-copy');copy.append(node('strong','',entry.title||'已删除内容'));
        const counts=[['tasks','任务'],['notes','知识'],['imports','资料'],['papers','论文']].filter(([k])=>entry.data?.[k]?.length).map(([k,l])=>`${entry.data[k].length} 项${l}`);
        const date=new Date(entry.deletedAt);copy.append(node('small','',[types[entry.type]||'内容',...counts,Number.isNaN(date.getTime())?'删除时间未记录':date.toLocaleString('zh-CN')].join(' · ')));
        const buttons=node('div','trash-row-actions'),restore=button('恢复','secondary',()=>hooks.restore(entry.id)),purge=button('永久删除','danger-button',()=>hooks.purge([entry.id]));restore.dataset.restoreTrash=entry.id;purge.dataset.purgeTrash=entry.id;restore.disabled=purge.disabled=busy();
        // Clicks are owned here; legacy document delegation must not run twice.
        buttons.addEventListener('click',event=>event.stopPropagation());buttons.append(restore,purge);row.append(check,copy,buttons);box.append(row);
      });
    }
    function confirmDelete(entries,options={}){
      if(confirmation)return Promise.resolve(false);
      const prior=doc.activeElement;
      return new Promise(resolve=>{
        let accepted=false;const dialog=node('dialog','trash-purge-dialog');confirmation=dialog;dialog.id='trashPurgeDialog';dialog.setAttribute('aria-labelledby','trashPurgeTitle');dialog.setAttribute('aria-describedby','trashPurgeHelp');
        const title=node('h2','',options.empty?`清空 ${entries.length} 条回收记录？`:`永久删除 ${entries.length} 条回收记录？`);title.id='trashPurgeTitle';
        const help=node('p','muted','此操作无法撤销。仅清理所选回收记录，以及不再被任何内容引用的工作站附件。');help.id='trashPurgeHelp';
        const list=node('ul','trash-purge-preview');entries.slice(0,8).forEach(entry=>list.append(node('li','',entry.title||'已删除内容')));if(entries.length>8)list.append(node('li','muted',`另外 ${entries.length-8} 条记录`));
        const note=node('p','trash-purge-note','仍被引用的原件、本机项目目录、研究库导出文件和已有备份会保留。云同步会传播这些记录的删除；不会立即擦除云端历史和备份。');
        const actions=node('div','trash-purge-actions'),cancel=button('取消','secondary',()=>dialog.close()),confirm=button(options.empty?'确认清空':'确认永久删除','danger-button',()=>{accepted=true;dialog.close();});confirm.id='confirmTrashPurge';actions.append(cancel,confirm);dialog.append(title,help,list,note,actions);
        dialog.addEventListener('close',()=>{confirmation=null;dialog.remove();prior?.focus?.({preventScroll:true});resolve(accepted);},{once:true});doc.body.append(dialog);dialog.showModal();cancel.focus();
      });
    }
    return {render,confirmDelete,clearSelection(){selected.clear();render();},selection(){return [...selected];}};
  }
  let controller;
  return {MAX_BATCH,createController,init(hooks){controller=createController(hooks);return this;},render(){controller?.render();},confirmDelete(entries,options){return controller?.confirmDelete(entries,options)||Promise.resolve(false);},clearSelection(){controller?.clearSelection();}};
}));
