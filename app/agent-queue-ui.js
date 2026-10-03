/* Owns only the queue island. Context drafts are memory-only; durable writes
 * and compare-and-swap belong to AgentQueue, never the main composer. */
(function(root){
 'use strict';
 const STORE='aibro-queue-edit-drafts-v1', drafts=new Map(), paused=new Set(), messages=new Map();
 let hooks={},box=null,model={},editing=null,context=null,operation=null;
 let viewEpoch=0,viewOwner=null,viewPrivate=false;
 const t=(zh,en)=>/^en(?:-|$)/i.test(root.document?.documentElement.lang||'')?en:zh;
 const conversation=id=>hooks.getConversation?.(id);
 const draftKey=(conversationId,id)=>JSON.stringify([conversationId,id]);
 const snapshot=item=>root.AgentQueue.snapshot(item);
 const privateConversation=value=>!!(value?.ephemeral||value?.incognito||value?.private||root.PrivateMode?.isOn?.());
 function localDraft(key,value){try{const data=JSON.parse(root.localStorage.getItem(STORE)||'{}');if(value===undefined)return data[key];if(value===null)delete data[key];else data[key]={draft:String(value.draft||''),expectedGoal:String(value.expectedGoal||'')};root.localStorage.setItem(STORE,JSON.stringify(Object.fromEntries(Object.entries(data).slice(-32))));}catch(_){}return null;}
 function persistGoal(session){const key=draftKey(session.conversationId,session.id);if(privateConversation(conversation(session.conversationId)))localDraft(key,null);else localDraft(key,{draft:session.draft.goal,expectedGoal:session.expected.goal});}
 function releaseEdit(discard=false){if(!editing)return;const old=editing;root.AgentQueue.endEdit(conversation(old.conversationId)||{id:old.conversationId},old.id);if(discard){drafts.delete(draftKey(old.conversationId,old.id));localDraft(draftKey(old.conversationId,old.id),null);}editing=null;}
 function status(id,value){messages.set(id,value);}
 // Focus is a revocable UI intent, separate from the durable save. A user can
 // keep writing in the composer while disk/context work is pending.
 function beginTask(kind,session,owner=session?.conversationId){
  const doc=root.document,focus=doc?.activeElement,host=box;
  const lease={epoch:viewEpoch,owner:conversation(owner),host,private:privateConversation(conversation(owner)),focus,
   eligible:!!focus&&focus!==doc.body&&!!host?.contains?.(focus),revoked:false,
   value:typeof focus?.value==='string'?focus.value:null,
   selection:typeof focus?.selectionStart==='number'?[focus.selectionStart,focus.selectionEnd,focus.selectionDirection]:null};
  const revoke=()=>{lease.revoked=true;};
  const moved=event=>{if(event.target!==focus&&event.target!==doc.body&&event.target!==doc.documentElement)revoke();};
  const interaction=event=>{if(event.type==='keydown'&&event.key!=='Tab'&&event.target===focus)return;if(event.target!==focus||event.key==='Tab')revoke();};
  const hidden=()=>{if(doc.hidden)revoke();};
  const listeners=[['focusin',moved],['pointerdown',interaction],['keydown',interaction],['compositionstart',moved],['visibilitychange',hidden]];
  if(lease.eligible){for(const [name,handler] of listeners)doc.addEventListener?.(name,handler,true);root.addEventListener?.('blur',revoke);}
  lease.dispose=()=>{for(const [name,handler] of listeners)doc.removeEventListener?.(name,handler,true);root.removeEventListener?.('blur',revoke);};
  return{kind,session,owner,focus,lease};
 }
 function invalidateFocus(){viewEpoch++;if(operation?.lease){operation.lease.revoked=true;operation.lease.dispose();}}
 function restoreFocus(task,fallback,preferFallback=false){
  const lease=task.lease,doc=root.document;lease?.dispose();
  if(!lease?.eligible||lease.revoked||lease.epoch!==viewEpoch||box!==lease.host||!box?.isConnected||box.hidden
   ||model.conversationId!==task.owner||conversation(task.owner)!==lease.owner||privateConversation(lease.owner)!==lease.private
   ||doc.hidden||doc.hasFocus?.()===false)return;
  // A focused control belongs to the user, even when no focusin was observed.
  if(doc.activeElement&&doc.activeElement!==doc.body&&doc.activeElement!==doc.documentElement&&doc.activeElement!==lease.focus)return;
  const original=lease.focus?.isConnected&&!lease.focus.disabled?lease.focus:null;
  const node=preferFallback?doc.getElementById(fallback):original||doc.getElementById(fallback);
  if(!node?.isConnected||node.disabled||!box.contains?.(node))return;
  node.focus?.({preventScroll:true});
  if(node===lease.focus&&lease.selection&&node.value===lease.value)node.setSelectionRange?.(...lease.selection);
 }
 function currentSession(){return editing?.conversationId===model.conversationId?editing:null;}
 function changed(){hooks.onChanged?.();refresh();}
 function view(session){return context?.inspect(session.conversationId,session.draft)||{materials:[],skills:[],issues:[],canSend:false};}
 function summary(owner,item){try{return context?.inspect(owner,item)||{materials:[],skills:[],issues:[],canSend:false};}catch(_){return{materials:[],skills:[],issues:[{type:'context',status:'invalid'}],canSend:false};}}
 function refresh(){
  if(!box?.isConnected)return;
  const current=conversation(model.conversationId),items=root.AgentQueue.list(current);
  if(editing&&(editing.conversationId!==current?.id||!items.some(item=>item.id===editing.id)))releaseEdit();
  for(const [key,value] of drafts)if(value.conversationId===current?.id&&!items.some(item=>item.id===value.id))drafts.delete(key);
  if(!editing&&!operation&&current){const restored=[...drafts.values()].find(value=>value.conversationId===current.id&&items.some(item=>item.id===value.id));if(restored&&root.AgentQueue.beginEdit(current,restored.id))editing=restored;}
  const session=currentSession(),busy=!!operation,info=messages.get(current?.id)||{};
  if(session&&privateConversation(current))localDraft(draftKey(session.conversationId,session.id),null);
  box.hidden=!items.length&&!model.injecting&&!info.error;
  if(box.hidden){root.HalaskaUI?.unmount(box);return;}
  if(!root.HalaskaUI?.componentNames.includes('QueueSurface'))return;
  const summaries=Object.fromEntries(items.map(item=>[item.id,summary(current.id,item)]));
  let catalog={materials:[],skills:[],projects:[]};
  if(session&&context)try{catalog=context.catalog(session.conversationId,session.query||'');}catch(_){session.error=t('原对话已不可用，编辑内容仍保留在当前窗口。','The conversation is unavailable. Edits remain in this window.');}
  // A root can become private while a directory request is pending or visible.
  const local=session?.local&&catalog.projects.some(project=>project.id===session.local.projectId)?session.local:null;
  root.HalaskaUI.mount(box,'QueueSurface',{...model,items:items.map(item=>({id:item.id,goal:item.goal,...(Object.hasOwn(item,'pdfReadMode')?{pdfReadMode:item.pdfReadMode}:{})})),summaries,paused:paused.has(current?.id),editingId:session?.id||null,
   draft:session?.draft.goal||'',pdfReadMode:session?.draft.pdfReadMode??'original',contextView:session?view(session):null,catalog,query:session?.query||'',local,busy,
   error:session?.error||info.error||'',notice:session?.notice||info.notice||'',confirmReload:!!session?.confirmReload,
   onEdit:begin,onDraft:value=>{const active=currentSession();if(!active||operation)return;active.draft.goal=value;persistGoal(active);refresh();},
   onPdfReadMode:value=>{const active=currentSession();if(!active||operation)return;if(!['original','text'].includes(value)){active.error=t('PDF 读取方式无效，请重新选择。','Choose a valid PDF reading mode.');refresh();return false;}active.draft.pdfReadMode=value;active.error='';active.notice=t('PDF 读取方式将在保存后用于本条排队消息。','Save to apply this PDF reading mode to this queued message.');refresh();return true;},
   onQuery:value=>{const active=currentSession();if(!active||operation)return;active.query=value;refresh();},
   onMutate:mutateContext,onBrowse:browse,onCheck:()=>check(currentSession()),
   onReload:()=>{if(!operation&&currentSession()){currentSession().confirmReload=true;refresh();}},
   onCancelReload:()=>{if(currentSession()){currentSession().confirmReload=false;refresh();}},
   onConfirmReload:()=>{const active=currentSession(),item=items.find(value=>value.id===active?.id);if(operation||!item)return;active.expected=snapshot(item);active.draft=snapshot(item);active.confirmReload=false;active.error='';active.notice=t('已载入已保存版本。','Loaded the saved version.');persistGoal(active);refresh();check(active);},
   onCancel:()=>{if(operation)return;const id=editing?.id;releaseEdit(true);status(current?.id,{notice:t('编辑已取消，队列保持暂停；准备好后继续发送。','Editing cancelled. Continue when you are ready.')});refresh();root.document.getElementById(`queue-edit-${id}`)?.focus({preventScroll:true});},
   onCommand:commit,onSend:send});
 }
 function begin(id){
  const current=conversation(model.conversationId);if(operation||editing||!root.AgentQueue.beginEdit(current,id))return;
  const item=root.AgentQueue.list(current).find(value=>value.id===id),key=draftKey(current.id,id);let expected;
  try{expected=snapshot(item);}catch(_){root.AgentQueue.endEdit(current,id);paused.add(current.id);status(current.id,{error:t('这条排队消息的读取方式无效。请移除后重新排队，原消息仍保留。','This queued message has an invalid reading mode. Remove it and queue it again; its text remains available.')});refresh();return;}
  const cached=privateConversation(current)?null:localDraft(key);
  editing=drafts.get(key)||{conversationId:current.id,id,expected,draft:snapshot(item),query:'',local:null,error:'',notice:''};
  if(!drafts.has(key)&&cached?.expectedGoal===item.goal)editing.draft.goal=cached.draft;
  drafts.set(key,editing);paused.add(current.id);status(current.id,{});refresh();check(editing);
 }
 async function check(session){
  if(!session||operation||!context)return;
  const task=beginTask('check',session);operation=task;refresh();
  try{await context.check(session.conversationId,session.draft);session.notice='';}
  catch(_){session.error=t('暂时无法核验上下文。草稿仍保留，请重试检查。','Context could not be checked. Your draft is retained; retry the check.');}
  finally{if(operation===task)operation=null;refresh();restoreFocus(task,`queue-check-${session.id}`);}
 }
 async function mutateContext(command){
  const session=currentSession();if(!session||operation||!context)return false;
  const task=beginTask('context',session);operation=task;session.error='';session.notice='';refresh();
  try{const next=await context.mutate(session.conversationId,session.draft,command);session.draft=next;persistGoal(session);await context.check(session.conversationId,next);session.notice=t('上下文已更新，保存修改后才替换排队内容。','Context updated. Save changes to replace the queued content.');return true;}
  catch(_){session.error=t('未能更新上下文。资料可能已变化、设为私密或断开；草稿已保留，请重新检查。','Could not update context. A source may have changed, become private, or disconnected. Your draft is retained.');return false;}
  finally{if(operation===task)operation=null;refresh();restoreFocus(task,`queue-check-${session.id}`);}
 }
 async function browse(request){
  const session=currentSession();if(!session||operation||!context)return;
  if(!request){session.local=null;refresh();return;}
  const task=beginTask('browse',session);operation=task;session.error='';refresh();
  try{const result=await context.browse(session.conversationId,request);session.local={projectId:request.projectId,path:request.path||'',entries:request.offset&&session.local?.path===(request.path||'')?[...session.local.entries,...result.entries]:result.entries,nextOffset:result.nextOffset};}
  catch(_){session.local=null;session.error=t('无法浏览该目录。请检查项目连接或重新选择资料。','Could not browse this folder. Check the project connection or choose another source.');}
  finally{if(operation===task)operation=null;refresh();restoreFocus(task,`queue-check-${session.id}`);}
 }
 async function commit(command){
  if(operation)return false;
  const owner=model.conversationId,session=currentSession(),id=command.id;
  if(session&&command.action!=='edit')return false;
  if(command.action==='edit'&&(!session||session.id!==id))return false;
  const task=beginTask('save',session,owner);operation=task;status(owner,{});if(session){session.error='';session.notice='';}refresh();
  try{
   if(session){const validated=await context.validate(owner,session.draft,{changedFrom:session.expected});command={action:'edit',id,context:validated,expectedContext:session.expected};}
   await root.AgentQueue.commit({getConversation:conversation,save:typeof hooks.save==='function'?()=>hooks.save():null},{...command,conversationId:owner});
   if(session){drafts.delete(draftKey(owner,id));localDraft(draftKey(owner,id),null);root.AgentQueue.endEdit(conversation(owner)||{id:owner},id);if(editing===session)editing=null;}
   status(owner,{notice:command.action==='remove'?t('已移除这条排队消息。','Queued message removed.'):command.action==='move'?t('发送顺序已保存。','Send order saved.'):t('正文与上下文已保存。准备好后点击继续发送。','Message and context saved. Continue when you are ready.')});
   return true;
  }catch(cause){const error=cause?.code==='QUEUE_CONFLICT'?t('这条队列项已在别处修改。你的草稿仍保留；载入已保存版本后再编辑。','This item changed elsewhere. Your draft is retained; reload the saved version before editing.'):t('未能保存修改。草稿仍保留，请重试。','Changes could not be saved. Your draft is retained; try again.');if(session)session.error=error;else status(owner,{error});return false;}
  finally{if(operation===task)operation=null;changed();const saved=!!session&&!drafts.has(draftKey(owner,id));restoreFocus(task,saved?`queue-edit-${id}`:session?`queue-text-${id}`:`queue-edit-${id}`,saved);}
 }
 async function send(){
  const current=conversation(model.conversationId);if(operation||editing||!model.canSend||model.hasDraft||!current)return;
  const item=root.AgentQueue.list(current)[0];if(!item)return;
  const task={kind:'check-send',owner:current.id};operation=task;paused.add(current.id);status(current.id,{});refresh();
  try{const ready=await context.check(current.id,item);if(!ready.canSend){status(current.id,{error:t('队首上下文需要修复。点击编辑，更新或移除不可用项后保存。','The first item needs repair. Edit it, update or remove unavailable context, then save.')});return;}
   if(model.conversationId!==current.id||root.AgentQueue.list(current)[0]!==item||editing||!model.canSend||model.hasDraft)return;
   paused.delete(current.id);operation=null;refresh();return hooks.onSend?.(current);
  }catch(_){status(current.id,{error:t('上下文检查失败，队列已保留。请重试或编辑修复。','Context check failed. The queue is retained; retry or edit to repair it.')});}
  finally{if(operation===task)operation=null;refresh();}
 }
 function render(element,options={}){const owner=options.conversation,id=owner?.id,isPrivate=privateConversation(owner);if(box!==element||viewOwner!==owner||viewPrivate!==isPrivate){invalidateFocus();viewOwner=owner;viewPrivate=isPrivate;}box=element;if(id!==model.conversationId)releaseEdit();model={...options,conversationId:id};delete model.conversation;refresh();}
 function init(options){hooks=options||{};context=root.QueueContext?.create({getState:hooks.getState,getConversation:conversation,selectLocal:hooks.selectLocal});root.document?.removeEventListener('workstation-language-change',refresh);root.document?.addEventListener('workstation-language-change',refresh);return api;}
 function pause(id,message){paused.add(typeof id==='object'?id.id:id);if(message)status(typeof id==='object'?id.id:id,{error:message});refresh();}
 function destroy(){invalidateFocus();viewOwner=null;releaseEdit();root.HalaskaUI?.unmount(box);root.document?.removeEventListener('workstation-language-change',refresh);box=null;model={};}
 const api={init,render,refresh,destroy,isEditing:()=>!!editing,isBusy:()=>!!operation,isPaused:id=>paused.has(typeof id==='object'?id.id:id),pause,check:(id,item)=>context?.check(id,item),inspect:(id,item)=>context?.inspect(id,item)};root.AgentQueueUI=api;
 if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
