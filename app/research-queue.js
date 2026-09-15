/* Saved batch plans; a restart never silently replays an unfinished model run. */
(function(root,factory){const api=factory(root,typeof module==='object'&&module.exports?require('./research-wiki'):root.ResearchWiki,typeof module==='object'&&module.exports?require('./attachment-analysis'):root.AttachmentAnalysis);if(typeof module==='object'&&module.exports)module.exports=api;else root.ResearchQueue=api;})(globalThis,(root,W,Analysis)=>{
'use strict';const active=W.active;
function create(state,ids,id,now=Date.now()){
 const selected=[...new Set(ids)].map(id=>state.imports.find(n=>n.id===id&&active(n)));
 if(!selected.length||selected.some(n=>!n))throw Error('所选资料已不可用。');
 const groups=new Map();for(const n of selected){const p=n.projectId&&state.projects.find(p=>p.id===n.projectId&&active(p));if(n.projectId&&!p||(p?.workspace||n.workspace)!=='科研')throw Error('队列仅接受有效科研资料。');const key=n.projectId||'';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(n.id);}
 const items=[];for(const [projectId,sources]of groups)for(let i=0;i<sources.length;i+=8)items.push({id:id+'_'+items.length,projectId:projectId||null,ids:sources.slice(i,i+8),status:'pending'});
 return {id,title:'资料处理队列 · '+selected.length+' 份',titleEdited:true,workspace:'科研',projectId:groups.size===1?selected[0].projectId||null:null,messages:[],attachments:[],createdAt:now,updatedAt:now,researchQueue:{status:'paused',createdAt:now,items}};
}
function queues(state){return (state.conversations||[]).filter(c=>active(c)&&c.researchQueue);}
function validate(state,item){if(item.projectId&&!state.projects.some(p=>p.id===item.projectId&&active(p)&&p.workspace==='科研'))throw Error('队列所属项目已不可用。');if(item.ids.some(id=>!state.imports.some(n=>n.id===id&&active(n)&&(n.projectId||null)===item.projectId&&(item.projectId||n.workspace==='科研'))))throw Error('批次资料已删除或移动，请先核对。');}
function outcome(state,item){
 try{validate(state,item);}catch{return 'attention';}
 const inScope=n=>active(n)&&!n.wikiFileError&&(n.projectId||null)===(item.projectId||null)&&(item.projectId||n.workspace==='科研');
 const scoped={...state,notes:(state.notes||[]).filter(inScope),papers:(state.papers||[]).filter(inScope)};
 const run=item.runId&&(state.agentRuns||[]).find(r=>r.id===item.runId);
 const fromRun=n=>!item.runId||run?.status==='completed'&&(run.results||[]).some(r=>r.type==='note'&&r.id===n.id&&['created','updated','drafted'].includes(r.operation));
 const status=item.ids.map(id=>{
  const source=state.imports.find(n=>n.id===id);
  if(Analysis?.derive(scoped,source)?.status==='analyzed')return 'completed';
  return scoped.notes.some(n=>fromRun(n)&&n.aiDraft&&String(n.aiDraft.content||'').trim()&&
   (Array.isArray(n.aiDraft.sourceAttachmentIds)?n.aiDraft.sourceAttachmentIds:n.sourceAttachmentIds||[]).includes(id))?'review':'attention';
 });
 return status.includes('attention')?'attention':status.includes('review')?'review':'completed';
}
function reconcile(state,instance){let changed=false;for(const c of queues(state)){const q=c.researchQueue;if(q.instance&&q.instance!==instance&&q.status==='active'){q.status='paused';q.error='上次运行已中断，请检查结果后继续。';changed=true;}for(const item of q.items){if(item.status!=='running'||q.instance===instance)continue;const run=state.agentRuns?.filter(r=>r.conversationId===item.id).at(-1);item.runId=run?.id||null;item.status=run?.status==='completed'?outcome(state,item):'attention';changed=true;}}return changed;}
let hooks,busy=false,current=null,instance='queue_'+Math.random().toString(36).slice(2);
function find(id){return queues(hooks.getState()).find(c=>c.id===id);}
async function tick(){if(busy||!hooks||!hooks.idle())return;busy=true;try{
 if(reconcile(hooks.getState(),instance))await hooks.persist();
 const c=queues(hooks.getState()).find(c=>c.researchQueue.status==='active');if(!c)return;const q=c.researchQueue,item=q.items.find(i=>i.status==='pending');if(!item){q.status=q.items.every(i=>['completed','review','skipped'].includes(i.status))?'completed':'paused';await hooks.persist();return;}
 validate(hooks.getState(),item);q.instance=instance;item.status='running';current={queue:c.id,item:item.id};
 let chat=hooks.getState().conversations.find(n=>n.id===item.id);if(chat&&!active(chat))throw Error('处理对话已归档，请先恢复。');
 if(!chat){chat={id:item.id,title:'分析批次 · '+(q.items.indexOf(item)+1)+' / '+q.items.length,titleEdited:true,workspace:'科研',projectId:item.projectId,messages:[],attachments:[...item.ids],draftAttachmentIds:[...item.ids],permissionMode:'legacy',createdAt:Date.now(),updatedAt:Date.now()};hooks.getState().conversations.push(chat);}
 await hooks.persist();
 const goal='分析本批 '+item.ids.length+' 份科研资料。逐份读取证据，复用或更新已有论文导读、方法和实验条目，保留来源、局限、失败经验与待验证问题。不要重复创建已有笔记，不更改资料的项目归属。结果提交为可审阅的笔记或 Wiki；保留原件。';
 const lastUser=chat.messages.filter(m=>m.role==='user').at(-1);let timer=setTimeout(()=>hooks.stop(),10*60000);
 try{await hooks.send({goal:lastUser?.text||goal,conversationId:chat.id,background:true,researchQueueId:c.id,researchBatchId:item.id,...(lastUser?{retry:true,userMessageId:lastUser.id,attachmentIds:item.ids,explicitAttachmentSelection:true}:{})});}finally{clearTimeout(timer);}
 const latest=find(c.id),saved=latest?.researchQueue.items.find(i=>i.id===item.id);if(!saved)return;
 const run=hooks.getState().agentRuns.filter(r=>r.conversationId===chat.id).at(-1);saved.runId=run?.id||null;saved.status=run?.status==='completed'?outcome(hooks.getState(),saved):'attention';saved.error=run?.error||(saved.status==='attention'&&run?.status==='completed'?'本批仍有资料未形成关联分析，请核对结果。':null)||(!run?'尚未启动分析，请检查模型配置。':run.status==='awaiting-approval'?'请打开对话审阅待批准动作。':null);
 if(saved.status==='attention'){latest.researchQueue.status='paused';latest.researchQueue.error=saved.error||'本批未完成，已暂停后续批次。';}
 else if(latest.researchQueue.items.every(i=>['completed','review','skipped'].includes(i.status)))latest.researchQueue.status='completed';
 await hooks.persist();
 }catch(e){const c=current?find(current.queue):queues(hooks.getState()).find(c=>c.researchQueue.status==='active');if(c){c.researchQueue.status='paused';c.researchQueue.error=e.message;const item=c.researchQueue.items.find(i=>i.status==='running');if(item)item.status='attention';await hooks.persist().catch(()=>{});}hooks.toast(e.message);}finally{busy=false;current=null;}}
function assertActive(run){if(!run.researchQueueId||run.status!=='running')return;const c=find(run.researchQueueId);if(!c||c.researchQueue.status!=='active'||current?.queue!==c.id||current?.item!==run.researchBatchId)throw Object.assign(Error('资料队列已暂停或归档'),{code:'CANCELLED'});}
async function enqueue(ids){const chat=create(hooks.getState(),ids,hooks.uid('research_queue'));hooks.getState().conversations.push(chat);try{await hooks.persist();open();}catch(e){hooks.getState().conversations=hooks.getState().conversations.filter(c=>c.id!==chat.id);hooks.toast(e.message);}}
function open(){document.getElementById('researchQueueDialog')?.remove();const d=document.createElement('dialog');d.className='research-inspector';d.id='researchQueueDialog';const el=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;},button=(text,fn)=>{const n=el('button',text);n.className='secondary';n.onclick=async()=>{try{await fn();draw();}catch(e){hooks.toast(e.message);}};return n;};
 function draw(){d.replaceChildren();d.append(el('h2','资料处理队列'),el('p','每批最多 8 份，自动分批且按项目隔离。点击开始后使用当前模型配置，可能产生 API 费用；App 打开且空闲时推进。失败、待审批或重启后暂停，已完成批次保留。'));
 for(const c of queues(hooks.getState())){const q=c.researchQueue,row=el('section','');row.className='research-result';row.append(el('h3',c.title),el('p',`${q.items.filter(i=>['completed','review','skipped'].includes(i.status)).length} / ${q.items.length} 批已处理 · `+({active:'运行中',paused:'已暂停',completed:'已完成'}[q.status])));if(q.error)row.append(el('p',q.error));
 if(q.status!=='completed')row.append(button(q.status==='active'?'暂停':'开始 / 继续',async()=>{if(q.status==='active'){q.status='paused';if(current?.queue===c.id)hooks.stop();}else{for(const i of q.items.filter(i=>i.status==='attention')){const run=hooks.getState().agentRuns.find(r=>r.id===i.runId);if(run?.status==='completed'&&outcome(hooks.getState(),i)!=='attention')i.status=outcome(hooks.getState(),i);else throw Error('请先处理未完成批次，或选择重试／跳过。');}q.status='active';q.instance=instance;delete q.error;}await hooks.persist();}));
 for(const i of q.items){const line=el('div',`${q.items.indexOf(i)+1}. ${i.ids.length} 份 · `+({pending:'待处理',running:'处理中',completed:'已分析',review:'分析草稿待审阅',attention:'需要处理',skipped:'已跳过'}[i.status]));line.className='research-tools';if(hooks.getState().conversations.some(c=>c.id===i.id))line.append(button('查看结果',()=>{d.close();hooks.openConversation(i.id);}));if(i.error)line.append(el('span',i.error));if(i.status==='attention')line.append(button('重试本批',async()=>{const run=hooks.getState().agentRuns.find(r=>r.id===i.runId);if(run?.status==='awaiting-approval'||run?.status==='running')throw Error('请先在处理对话中完成审批或停止执行。');i.status=run?.status==='completed'&&outcome(hooks.getState(),i)!=='attention'?outcome(hooks.getState(),i):'pending';q.status='paused';await hooks.persist();}),button('跳过本批',async()=>{if(hooks.getState().agentRuns.some(r=>r.id===i.runId&&['running','awaiting-approval'].includes(r.status)))throw Error('请先处理此批正在执行或待审批的动作。');i.status='skipped';q.status='paused';await hooks.persist();}));row.append(line);}d.append(row);}
 d.append(button('刷新状态',async()=>{}),button('关闭',()=>d.close()));}
 let signature='';const snapshot=()=>JSON.stringify(queues(hooks.getState()).map(c=>[c.id,c.researchQueue]));
 draw();signature=snapshot();const refresh=setInterval(()=>{if(!d.isConnected){clearInterval(refresh);return;}const next=snapshot();if(next!==signature){signature=next;draw();}},750);refresh.unref?.();
 d.addEventListener('close',()=>{clearInterval(refresh);d.remove();},{once:true});document.body.append(d);d.showModal();}
return {create,validate,reconcile,outcome,assertActive,queues,init:h=>{hooks=h;const timer=setInterval(tick,5000);timer.unref?.();},tick,enqueue,open};
});
