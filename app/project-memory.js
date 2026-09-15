/* Durable project context. Generated execution facts and proposed decisions stay distinct. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ProjectMemory=api;})(globalThis,()=>{
 'use strict';
 const active=x=>x&&!x.archived&&!x.deletedAt&&!x.wikiFileError;
 const list=x=>Array.isArray(x)?x:[];
 const id=(project,kind,date='')=>'pm_'+project+'_'+kind+(date?'_'+date:'');
 const localDay=time=>{const d=new Date(time);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
 const text=x=>String(x||'').replace(/\r/g,'');
 const line=x=>text(x).replace(/\n/g,' ').slice(0,600);
 const member=(state,p)=>list(state.projects).find(x=>active(x)&&x.id===p);
 const deleted=(state,key)=>list(state.trash).some(t=>list(t.data?.notes).some(n=>n.id===key));
 function find(state,project,kind,date){return list(state.notes).find(n=>active(n)&&n.id===id(project,kind,date)&&n.projectId===project);}
 function ensure(state,project,kind,date){
  const key=id(project.id,kind,date);let note=list(state.notes).find(n=>n.id===key);if(note)return active(note)?note:null;if(deleted(state,key))return null;
  const title=({long:'长期记忆',plan:'项目计划与产出',daily:'进展日记 '+date})[kind];
  note={id:key,title:project.name+' · '+title,workspace:project.workspace,projectId:project.id,kind:project.workspace==='科研'?'科研 Wiki/output':'项目记忆/'+kind,projectMemoryType:kind,memoryDate:date||null,folderPath:'项目记忆'+(kind==='daily'?'/日记':''),content:'# '+title+'\n',sourceAttachmentIds:[],sourceNoteIds:[],tags:[],createdAt:Date.now(),updatedAt:Date.now()};
  state.notes ||= [];state.notes.push(note);return note;
 }
 function update(note,content,reason){if(!note||note.content===content)return;note.revisionHistory ||= [];note.revisionHistory.push({content:note.content,title:note.title,savedAt:Date.now(),reason});note.content=content;note.updatedAt=Math.max(Date.now(),Number(note.updatedAt||0)+1);}
 function validateUpdates(state,run,updates){
  if(updates===undefined)return [];if(!Array.isArray(updates)||updates.length>12)throw Error('每轮最多提出12项项目记忆。');
  if(updates.length&&!member(state,run.projectId))throw Error('长期记忆需要绑定有效项目。');
  const chat=list(state.conversations).find(c=>c.id===run.conversationId&&c.projectId===run.projectId&&active(c));
  return updates.map(value=>{
   if(!value||!['preference','decision','question'].includes(value.type)||typeof value.text!=='string'||!value.text.trim()||value.text.length>2000)throw Error('项目记忆类型或内容无效。');
   const source=list(chat?.messages).find(m=>m.role==='user'&&m.id===value.messageId&&!m.deletedAt);
   if(!source||typeof value.quote!=='string'||!value.quote.trim()||value.quote.length>2000||!text(source.text).includes(value.quote))throw Error('项目记忆必须引用当前项目用户消息中的准确原话。');
   return {type:value.type,text:value.text.trim(),messageId:source.id,quote:value.quote,conversationId:chat.id};
  });
 }
 function planContent(state,project){
  const tasks=list(state.tasks).filter(t=>active(t)&&t.projectId===project.id);
  const outputs=list(state.notes).filter(n=>active(n)&&n.projectId===project.id&&!n.projectMemoryType);
  return ['<!-- aibro:project-index -->','## 目标',project.description||'尚未记录项目目标。','', '## 任务与排期',...tasks.map(t=>`- [${t.status==='done'?'x':' '}] ${line(t.title)} · ${t.status||'todo'}${t.startAt?' · 开始 '+t.startAt:''}${t.dueAt?' · 截止 '+t.dueAt:''}${list(t.dependsOn).length?' · 依赖 '+t.dependsOn.join(', '):''} [task:${t.id}]`),...(tasks.length?[]:['暂无任务。']),'','## 产出索引',...outputs.map(n=>`- ${line(n.title)} [note:${n.id}]`),'<!-- /aibro:project-index -->'].join('\n');
 }
 function refreshPlan(state,projectId){
  const project=member(state,projectId);if(!project)return null;
  const note=ensure(state,project,'plan');if(!note)return null;
  const block=planContent(state,project),re=/<!-- aibro:project-index -->[\s\S]*?<!-- \/aibro:project-index -->/;
  const existing=note.content.match(re)?.[0];
  // A pending review is the working copy. Refresh only its generated index,
  // retaining all proposed prose and the complete previous draft for review.
  if(note.aiDraft){
   const draft=note.aiDraft,body=typeof draft.content==='string'?draft.content:note.content;
   if(!re.test(body))return note; // deleting the generated section is intentional
   const next=body.replace(re,()=>block);
   if(next!==body){note.aiDraftHistory=[...list(note.aiDraftHistory),{...structuredClone(draft),savedAt:Date.now(),reason:'project-index-refresh'}];note.aiDraft={...draft,content:next};note.updatedAt=Math.max(Date.now(),Number(note.updatedAt||0)+1);}
   return note;
  }
  if(existing===block){note.managedIndex=block;return note;}
  // Manual edits to the approved index require review, not an overwrite.
  if(existing&&note.managedIndex&&existing!==note.managedIndex){note.aiDraft={title:note.title,content:note.content.replace(re,()=>block),createdAt:Date.now(),reason:'project-index-refresh'};note.updatedAt=Math.max(Date.now(),Number(note.updatedAt||0)+1);return note;}
  if(!existing&&note.managedIndex)return note;
  update(note,existing?note.content.replace(re,()=>block):note.content+'\n'+block,'project-index-refresh');note.managedIndex=block;return note;
 }
 function settle(state,run){
  const project=member(state,Object.hasOwn(run,'memoryProjectId')?run.memoryProjectId:run.projectId);if(!project||!['completed','failed','cancelled','interrupted'].includes(run.status))return [];
  const day=localDay(run.startedAt||Date.now()),daily=ensure(state,project,'daily',day),changed=[];
  if(daily&&!list(daily.memoryRunIds).includes(run.id)){
   const results=list(run.results).filter(r=>{const record=list(state[({task:'tasks',note:'notes',import:'imports',paper:'papers'})[r.type]]).find(x=>x.id===r.id);return record?.projectId===project.id;}).map(r=>`- ${line(r.text||r.title||r.id)} [${r.type}:${r.id}]`);
   const commands=list(run.commands).filter(c=>c.startedAt).map(c=>`- 终端 ${line(String(c.argv?.[0]||'命令').split('/').pop())}：${c.status}，退出码 ${c.exitCode??'未返回'} [command:${c.id}]`);
   const section=[`\n## ${new Date(run.startedAt||Date.now()).toLocaleTimeString()} · ${run.status}`,`用户目标：${line(run.goal)}`,`来源：会话 ${run.conversationId} / 消息 ${run.userMessageId||'未记录'} / 执行 ${run.id}`, ...results,...commands,...(!results.length&&!commands.length?['没有记录到文件或任务写入。']:[]),...(run.error?['未完成原因：'+line(run.error)]:[])].join('\n');
   update(daily,daily.content+'\n'+section+'\n','project-daily-log');daily.memoryRunIds=[...list(daily.memoryRunIds),run.id];daily.sourceConversationId=run.conversationId;changed.push(daily);
  }
  const long=ensure(state,project,'long');if(long&&!list(long.memoryRunIds).includes(run.id)&&list(run.memoryUpdates).length&&run.status==='completed'){
   const proposal=run.memoryUpdates.map(x=>`\n### ${{preference:'偏好',decision:'决策',question:'研究问题'}[x.type]}\n${x.text}\n\n用户原话：${x.quote}\n\n来源：会话 ${x.conversationId} / 消息 ${x.messageId}`).join('\n');
   if(long.aiDraft)long.aiDraftHistory=[...list(long.aiDraftHistory),{...structuredClone(long.aiDraft),savedAt:Date.now(),reason:'extended'}];
   long.aiDraft={...(long.aiDraft||{}),title:long.title,content:(long.aiDraft?.content||long.content)+'\n'+proposal,createdAt:Date.now(),reason:'project-memory-proposal',sourceConversationId:run.conversationId};long.memoryRunIds=[...list(long.memoryRunIds),run.id];long.updatedAt=Date.now();changed.push(long);
  }
  const plan=refreshPlan(state,project.id);if(plan)changed.push(plan);return changed;
 }
 function context(state,projectId,{offset=0,limit=16000}={}){
  if(!member(state,projectId))return {text:'',entries:[],nextOffset:null};
  const notes=list(state.notes).filter(n=>active(n)&&n.projectId===projectId&&n.projectMemoryType).sort((a,b)=>(a.projectMemoryType==='long'?-1:b.projectMemoryType==='long'?1:0)||Number(b.updatedAt||0)-Number(a.updatedAt||0));
  const all=notes.map(n=>`[note:${n.id}] ${n.title}\n${n.content}`).join('\n\n');
  if(!Number.isSafeInteger(offset)||offset<0)throw Error('无效记忆分页位置');
  return {text:all.slice(offset,offset+limit),entries:notes.map(n=>({id:n.id,title:n.title,type:n.projectMemoryType,pendingDraft:!!n.aiDraft})),offset,totalChars:all.length,nextOffset:offset+limit<all.length?offset+limit:null};
 }
 return {id,find,ensure,context,settle,validateUpdates,refreshPlan};
});
