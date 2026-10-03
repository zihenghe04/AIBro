import React, { useLayoutEffect, useRef } from 'react';
import { AlertBanner, Badge, Button, Caption, Card, StatusBadge, TextArea, TextInput } from './halaska-kit.jsx';
import { KitSelect } from './kit-controls.jsx';
import styles from './queue-surfaces.css';
if (!document.getElementById('queue-surface-styles')) { const style=document.createElement('style');style.id='queue-surface-styles';style.textContent=styles;document.head.append(style); }
const MIME='application/x-aibro-pending-submit';
const t=(zh,en)=>/^en(?:-|$)/i.test(document.documentElement.lang)?en:zh;
const labels={available:['可用','Available'],frozen:['已固定快照','Frozen snapshot'],changed:['有新版本','Changed'],missing:['已不可用','Unavailable'],unavailable:['核验失败','Check failed'],private:['私密来源','Private source'],invalid:['需修复','Needs repair'],disabled:['已停用','Disabled']};
const healthy=status=>['available','frozen'].includes(status);
function Status({ value }) { return <StatusBadge status={healthy(value)?'online':value==='changed'?'pending':'error'} pulse={false}>{t(...(labels[value]||labels.invalid))}</StatusBadge>; }
function ContextRow({ row, busy, onMutate, skill=false }) {
 const title=row.status==='private'?t('私密来源','Private source'):row.title;
 const reason=skill?{frozen:'Keeps the instructions selected for this message.',changed:'A newer Skill exists. The queued instructions remain frozen until you choose to update.',disabled:'This Skill is disabled. Remove it before sending.',missing:'This Skill is unavailable. Remove it before sending.'}[row.status]:{changed:'The source changed. Update its reference or remove it before sending.',private:'This source is private and cannot be used by this message.',missing:'The source or its project is unavailable.',invalid:'This reference needs repair. Update it or remove it.',unavailable:'The current source version could not be checked. Retry or remove the reference.'}[row.status];
 return <li className="queue-context-row" data-context-key={row.key}><div className="queue-context-description"><span className="queue-context-title" data-user-content>{title}</span><Status value={row.status}/>{row.reason&&<Caption>{t(row.reason,reason||row.reason)}</Caption>}</div><div className="queue-context-actions">
  {row.refresh&&<Button size="sm" variant="ghost" disabled={busy} onClick={()=>{if(!busy)onMutate(row.refresh);}} aria-label={t(`更新引用：${title}`,`Update reference: ${title}`)}>{skill?t('更新到当前版本','Use current version'):t('更新引用','Update reference')}</Button>}
  {row.remove&&<Button size="sm" variant="ghost" disabled={busy} onClick={()=>{if(!busy)onMutate(row.remove);}} aria-label={t(`移除：${title}`,`Remove: ${title}`)}>{t('移除','Remove')}</Button>}
 </div></li>;
}
function CatalogRow({ row, busy, selected, onMutate }) {
 return <li className="queue-catalog-row"><span data-user-content>{row.title||row.name}</span><Button size="sm" variant="ghost" disabled={busy||selected||!row.add} onClick={()=>{if(!busy&&!selected&&row.add)onMutate(row.add);}} aria-label={t(`添加：${row.title||row.name}`,`Add: ${row.title||row.name}`)}>{selected?t('已添加','Added'):t('添加','Add')}</Button></li>;
}
function ContextEditor({ item, contextView, catalog, query, local, busy, pdfReadMode='original', onPdfReadMode, onQuery, onMutate, onBrowse, onCheck }) {
 const data=contextView||{materials:[],skills:[],issues:[],canSend:false}, available=catalog||{materials:[],skills:[],projects:[]};
 const search=useRef(null);
 useLayoutEffect(()=>{search.current?.querySelector('input')?.setAttribute('aria-label',t('搜索可添加的资料与 Skills','Search materials and Skills'));});
 return <div className="queue-context-editor">
  <div className="queue-section-heading"><h4>{t('本条消息的上下文','Context for this message')}</h4><Button id={`queue-check-${item.id}`} size="sm" variant="ghost" disabled={busy} onClick={()=>{if(!busy)onCheck();}}>{t('重新检查','Check again')}</Button></div>
  <Caption>{t('修改只用于这条排队消息；保存后生效，不改变输入框草稿或会话默认 Skills。','Changes apply only to this queued message after saving. Composer drafts and conversation defaults stay separate.')}</Caption>
  <div><label htmlFor={`queue-pdf-mode-${item.id}`}>{t('本条消息的 PDF 读取方式','PDF reading mode for this message')}</label><KitSelect id={`queue-pdf-mode-${item.id}`} label={t('本条消息的 PDF 读取方式','PDF reading mode for this message')} value={pdfReadMode} onChange={value=>{if(!busy)onPdfReadMode?.(value);}} disabled={busy} size="sm" options={[{value:'original',label:t('原件','Original file')},{value:'text',label:t('读取文字','Read extracted text')}]}/></div>
  <Caption>{pdfReadMode==='text'?t('仅使用已提取的文字，不包含页面图片与排版。保存后用于本条消息中的 PDF。','Uses extracted text without page images or layout. Applies to this message’s PDFs after saving.'):t('发送 PDF 原件，需要模型与接口支持。此选择不会改变正在执行的请求。','Sends the original PDF and requires model and endpoint support. This choice does not change the running request.')}</Caption>
  {!!data.issues.length&&<AlertBanner variant="warning" title={t('上下文需要处理','Context needs attention')} description={t('可以先保存草稿；发送前请更新或移除不可用项。','You can save your edits. Update or remove unavailable items before sending.')}/>}
  <Card padding={10}><h5>{t(`资料与本机引用 · ${data.materials.length}`,`Materials and local references · ${data.materials.length}`)}</h5>
   {data.materials.length?<ul className="queue-context-list">{data.materials.map(row=><ContextRow key={row.key} {...{row,busy,onMutate}}/>)}</ul>:<Caption>{t('还没有为这条消息添加资料。','No material is attached to this message.')}</Caption>}
  </Card>
  <Card padding={10}><h5>{t(`Skills 快照 · ${data.skills.length}`,`Skill snapshots · ${data.skills.length}`)}</h5><Caption>{t('保留入队时的指令；更新到当前版本需要你主动选择。','Instructions stay as queued. Upgrading to the current version is your choice.')}</Caption>
   {data.skills.length?<ul className="queue-context-list">{data.skills.map(row=><ContextRow key={row.key} {...{row,busy,onMutate}} skill/>)}</ul>:<Caption>{t('本条消息不使用 Skill。','This message uses no Skill.')}</Caption>}
  </Card>
  <details className="queue-add-context"><summary>{t('添加资料或 Skill','Add material or a Skill')}</summary>
   <div ref={search}><TextInput value={query} onChange={onQuery} disabled={busy} size="sm" placeholder={t('搜索资料、笔记或 Skill…','Search materials, notes, or Skills…')}/></div>
   <h5>{t('资料库','Library')}</h5><ul className="queue-catalog-list">{available.materials.map(row=><CatalogRow key={row.key||`${row.type}:${row.id}`} {...{row,busy,onMutate}} selected={data.materials.some(value=>value.type===row.type&&value.id===row.id)}/>)}</ul>
   {!available.materials.length&&<Caption>{t('没有匹配的可用资料。','No matching available material.')}</Caption>}
   <h5>Skills</h5><ul className="queue-catalog-list">{available.skills.map(row=><CatalogRow key={row.key||row.id} {...{row,busy,onMutate}} selected={data.skills.some(value=>value.id===row.id)}/>)}</ul>
   {!available.skills.length&&<Caption>{t('没有匹配的可用 Skill。','No matching available Skill.')}</Caption>}
  </details>
  <details className="queue-add-context"><summary>{t('从已连接的本机目录添加','Add from a connected local folder')}</summary>
   <Caption>{t('浏览仅列目录；添加或核验时在本机读取文件确认版本，正文不保存在编辑草稿中。','Browsing only lists folders. Adding or checking a reference reads the file locally to confirm its version; file contents are not kept in the edit draft.')}</Caption>
   {!local?<ul className="queue-catalog-list">{available.projects.map(project=><li key={project.key} className="queue-catalog-row"><span data-user-content>{project.title}</span><Button size="sm" variant="ghost" disabled={busy} onClick={()=>{if(!busy)onBrowse({projectId:project.id,path:'',offset:0});}}>{t('浏览','Browse')}</Button></li>)}</ul>:<>
    <div className="queue-local-path"><Button size="sm" variant="ghost" disabled={busy} onClick={()=>{if(!busy)onBrowse(local.path?{projectId:local.projectId,path:local.path.split('/').slice(0,-1).join('/'),offset:0}:null);}}>{t('上一级','Up one level')}</Button><span data-user-content>{local.path||available.projects.find(value=>value.id===local.projectId)?.title}</span></div>
    <ul className="queue-catalog-list">{local.entries.map(row=><li key={row.key||row.path} className="queue-catalog-row"><span data-user-content>{row.title}</span><Button size="sm" variant="ghost" disabled={busy||(!row.directory&&row.disabled)} onClick={()=>{if(busy||(!row.directory&&row.disabled))return;row.directory?onBrowse({projectId:local.projectId,path:row.path,offset:0}):onMutate(row.add);}} aria-label={t(`${row.directory?'打开目录':'添加文件'}：${row.title}`,`${row.directory?'Open folder':'Add file'}: ${row.title}`)}>{row.directory?t('打开','Open'):row.disabled?t('不支持','Unsupported'):t('添加','Add')}</Button></li>)}</ul>
    {local.nextOffset!=null&&<Button size="sm" variant="ghost" disabled={busy} onClick={()=>{if(!busy)onBrowse({projectId:local.projectId,path:local.path,offset:local.nextOffset});}}>{t('加载更多文件','Load more files')}</Button>}
   </>}
   {!available.projects.length&&<Caption>{t('暂无可访问的本机目录。先在项目中连接目录。','No local folder is available. Connect a folder in a project first.')}</Caption>}
  </details>
 </div>;
}
function Editor({ item, draft, busy, onDraft, onSave, onCancel, confirmReload, onReload, onConfirmReload, onCancelReload, ...context }) {
 const ref=useRef(null), composing=useRef(false);
 useLayoutEffect(()=>{const input=ref.current.querySelector('textarea');input.id=`queue-text-${item.id}`;input.setAttribute('aria-label',t('编辑排队消息','Edit queued message'));input.focus({preventScroll:true});input.setSelectionRange(input.value.length,input.value.length);},[item.id]);
 useLayoutEffect(()=>{ref.current.querySelector('textarea').setAttribute('aria-label',t('编辑排队消息','Edit queued message'));});
 return <div className="queue-edit" ref={ref} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onKeyDown={event=>{if(composing.current||event.isComposing||event.nativeEvent?.isComposing||event.keyCode===229)return;if((event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();event.stopPropagation();if(!busy&&draft.trim())onSave();}else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!busy)(confirmReload?onCancelReload:onCancel)();}}}>
  <TextArea value={draft} onChange={onDraft} disabled={busy} rows={3}/>
  <ContextEditor {...context} {...{item,busy}}/>
  {confirmReload?<div className="queue-reload-confirm"><AlertBanner variant="warning" title={t('载入已保存版本？','Reload the saved version?')} description={t('这会替换本条消息尚未保存的正文与上下文。','This replaces this message’s unsaved text and context.')}/><div className="queue-edit-actions"><Button size="sm" variant="ghost" disabled={busy} onClick={onCancelReload}>{t('保留编辑','Keep editing')}</Button><Button id={`queue-confirm-reload-${item.id}`} size="sm" variant="secondary" disabled={busy} onClick={onConfirmReload}>{t('确认载入','Reload')}</Button></div></div>:<Button id={`queue-reload-${item.id}`} size="sm" variant="ghost" disabled={busy} onClick={onReload}>{t('载入已保存版本','Reload saved version')}</Button>}
  <div className="queue-edit-footer"><Caption>{t('⌘ / Ctrl + Enter 保存 · Esc 取消','⌘ / Ctrl + Enter to save · Esc to cancel')}</Caption><span className="queue-edit-actions"><Button id={`queue-cancel-${item.id}`} variant="ghost" size="sm" onClick={onCancel} disabled={busy}>{t('取消','Cancel')}</Button><Button id={`queue-save-${item.id}`} variant="accent" size="sm" onClick={onSave} loading={busy} disabled={busy||!draft.trim()}>{t('保存修改','Save changes')}</Button></span></div>
 </div>;
}
export function QueueSurface({ conversationId, items=[], summaries={}, injecting='', canSend=false, editingId=null, draft='', busy=false, error='', notice='', hasDraft=false, paused=false, onEdit, onDraft, onCancel, onCommand, onSend, ...context }) {
 const editing=items.find(item=>item.id===editingId);
 const drop=(event,beforeId)=>{event.preventDefault();const id=event.dataTransfer.getData(MIME);if(id&&id!==beforeId&&!busy&&!editing)onCommand({action:'move',id,beforeId});};
 return <section className="queue-surface" aria-label={t('待发送消息','Queued messages')} aria-busy={busy}>
  <header className="queue-heading"><div className="queue-heading-title"><Badge>{t(`队列 ${items.length}`,`${items.length} queued`)}</Badge><Caption>{editing?t('编辑期间暂停发送队列','Queue paused while editing'):paused?t('队列已暂停，准备好后继续发送','Queue paused. Continue when ready.'):t('当前回复结束后依序发送','Sent in order after the current reply')}</Caption></div>{!!items.length&&<Button id="queueSendNext" variant="ghost" size="sm" disabled={!canSend||busy||!!editing||hasDraft} onClick={()=>{if(canSend&&!busy&&!editing&&!hasDraft)onSend();}}>{t('继续发送','Continue')}</Button>}</header>
  {!!injecting&&<p className="queue-injection">{injecting}</p>}
  <ol className="queue-list" aria-label={t('发送顺序','Send order')}>
   {items.map((item,index)=><li key={item.id} data-queue-id={item.id} className={`queue-row${editingId===item.id?' is-editing':''}`} draggable={!busy&&!editing} onDragStart={event=>{if(busy||editing){event.preventDefault();return;}event.dataTransfer.setData(MIME,item.id);event.dataTransfer.effectAllowed='move';}} onDragOver={event=>{if(event.dataTransfer.types.includes(MIME)&&!busy&&!editing){event.preventDefault();event.dataTransfer.dropEffect='move';}}} onDrop={event=>drop(event,item.id)}>
    <span className="queue-position" aria-hidden="true">{index+1}</span><div className="queue-content">
     {editingId===item.id?<Editor key={`${conversationId}:${item.id}`} {...context} {...{item,draft,busy,onDraft,onCancel}} onSave={()=>{if(!busy)onCommand({action:'edit',id:item.id});}}/>:<><div className="queue-message" data-user-content>{item.goal}</div><div className="queue-context"><Caption>{t(`${summaries[item.id]?.materials.length||0} 项资料 · ${summaries[item.id]?.skills.length||0} 个 Skills`,`${summaries[item.id]?.materials.length||0} materials · ${summaries[item.id]?.skills.length||0} Skills`)}</Caption>{!!summaries[item.id]?.materials.length&&<Caption>{item.pdfReadMode==='text'?t('PDF：读取文字','PDF: extracted text'):!Object.hasOwn(item,'pdfReadMode')||item.pdfReadMode==='original'?t('PDF：原件','PDF: original file'):t('PDF：读取方式无效','PDF: invalid reading mode')}</Caption>}{!!summaries[item.id]?.issues.length&&<StatusBadge status="pending" pulse={false}>{t('上下文需修复','Context needs repair')}</StatusBadge>}</div></>}
     {editingId!==item.id&&<div className="queue-row-actions"><Button id={`queue-edit-${item.id}`} size="sm" variant="ghost" disabled={busy||!!editing} onClick={()=>{if(!busy&&!editing)onEdit(item.id);}}>{summaries[item.id]?.issues.length?t('编辑并修复','Edit and repair'):t('编辑','Edit')}</Button><Button id={`queue-up-${item.id}`} size="sm" variant="ghost" disabled={busy||!!editing||index===0} aria-label={t('上移这条消息','Move this message up')} onClick={()=>{if(!busy&&!editing&&index>0)onCommand({action:'move',id:item.id,delta:-1});}}>↑</Button><Button id={`queue-down-${item.id}`} size="sm" variant="ghost" disabled={busy||!!editing||index===items.length-1} aria-label={t('下移这条消息','Move this message down')} onClick={()=>{if(!busy&&!editing&&index<items.length-1)onCommand({action:'move',id:item.id,delta:1});}}>↓</Button><Button id={`queue-remove-${item.id}`} size="sm" variant="ghost" disabled={busy||!!editing} aria-label={t('移除这条排队消息','Remove this queued message')} onClick={()=>{if(!busy&&!editing)onCommand({action:'remove',id:item.id});}}>{t('移除','Remove')}</Button></div>}
    </div>
   </li>)}
  </ol>
  {items.length>1&&!editing&&<div className="queue-drop-end" onDragOver={event=>{if(event.dataTransfer.types.includes(MIME)&&!busy)event.preventDefault();}} onDrop={event=>drop(event,null)}><Caption>{t('可拖动调整顺序，或使用上移 / 下移按钮','Drag to reorder, or use the up / down buttons')}</Caption></div>}
  {hasDraft&&!!items.length&&<p className="queue-draft-note">{t('输入框中有草稿，队列会等待你先处理草稿。','There is a composer draft. Handle it before continuing the queue.')}</p>}
  <div className="queue-status" role="status" aria-live="polite">{error&&<AlertBanner variant="danger" title={t('队列已保留','Queue retained')} description={error}/>}<span className="queue-notice">{notice}</span></div>
 </section>;
}
