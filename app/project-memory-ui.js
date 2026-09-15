(function(root){
 const el=(tag,text,cls)=>{const x=document.createElement(tag);if(text)x.textContent=text;if(cls)x.className=cls;return x;};
 function render(project){
  let box=document.querySelector('#projectMemoryControls');if(!box){box=el('div',null,'context-source-links');box.id='projectMemoryControls';document.querySelector('#projectLocalSummary')?.insertAdjacentElement('afterend',box);}box.replaceChildren();
  const en=root.WorkstationI18n?.getLanguage?.()==='en';
  for(const [kind,label]of [['long',en?'Project memory':'项目记忆'],['plan',en?'Plan & outputs':'计划与产出'],['daily',en?'Daily progress':'进展日记']]){
   const b=el('button',label,'secondary');b.onclick=async()=>{try{const notes=ProjectMemory.context(state,project.id).entries.filter(n=>n.type===kind);let note=notes.length?state.notes.find(n=>n.id===notes[0].id):kind==='plan'?ProjectMemory.refreshPlan(state,project.id):kind==='long'?ProjectMemory.ensure(state,project,'long'):null;if(!note){toast(en?'No project run recorded yet.':'完成项目对话后会记录进展日记。');return;}await saveDocumentDurably();openPreview('note',note.id);}catch(e){toast(e.message);}};box.append(b);
  }
  if(root.ProjectAutomation){const b=el('button',en?'Automatic tasks':'自动任务','secondary');b.onclick=()=>root.ProjectAutomation.open(project);box.append(b);}
 }
 function relations(box,note){
  if(!note.projectMemoryType)return;
  for(const id of note.memoryRunIds||[]){const run=state.agentRuns.find(r=>r.id===id);const chat=state.conversations.find(c=>c.id===run?.conversationId&&!c.deletedAt&&!c.archived&&c.projectId===note.projectId);if(!chat)continue;const b=el('button','执行来源 · '+chat.title,'source-link');b.onclick=e=>{e.stopPropagation();openConversation(chat.id);};box.append(b);}
  if(note.projectMemoryType==='plan')for(const task of state.tasks.filter(t=>t.projectId===note.projectId&&!t.deletedAt&&!t.archived)){const b=el('button',task.title,'source-link');b.onclick=e=>{e.stopPropagation();openTask(task.id);};box.append(b);}
 }
 root.ProjectMemoryUI={render,relations};
})(globalThis);
