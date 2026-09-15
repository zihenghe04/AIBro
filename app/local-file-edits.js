/* Proposals are separate from state actions; only a user's review button writes to disk. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.LocalFileEdits=api;})(globalThis,root=>{
 'use strict';
 const F=root.FileContext||(typeof require==='function'?require('./file-context.js'):null);
 const t=(zh,en)=>root.WorkstationI18n?.getLanguage?.()==='en'?en:zh;
 function validate(edits,state,run,context){
  if(edits===undefined)return [];
  if(!Array.isArray(edits))throw Error('fileEdits 必须是数组。');
  const seen=new Set();
  return edits.map(edit=>{
   if(!edit)throw Error('无效的文件提案。');
   if(edit.operation!=='mkdir'&&(typeof edit.content!=='string'||edit.content.includes('\0')||new TextEncoder().encode(edit.content).length>4*1024*1024))throw Error('文件提案必须包含完整的 UTF-8 文本（不超过 4 MB）。');
   let ref;
   if(edit.operation==='update'){
    ref=context.snapshots.find(r=>r.type==='local'&&F.key(r)===edit.refKey);
    if(!ref||!context.fullyRead(edit.refKey))throw Error('改写前必须读取本轮明确引用文件的全部正文，不能省略未读部分。');
   }else if(['create','mkdir'].includes(edit.operation)){
    if(!run.projectId||edit.projectId!==run.projectId)throw Error('新建本机文件必须属于当前对话项目。');
    const project=state.projects.find(p=>p.id===run.projectId&&F.active(p));ref={projectId:project?.id,candidateId:project?.localFolder?.id,path:edit.path};
   }else throw Error('本机文件提案只支持 create / update / mkdir。');
   const project=state.projects.find(p=>F.active(p)&&p.id===ref.projectId&&p.localFolder?.id&&p.localFolder.id===ref.candidateId);
   if(!project)throw Error('文件所在项目已断开或归档。');
   if(typeof ref.path!=='string'||!ref.path||/[\\%\0]/.test(ref.path)||ref.path.split('/').some(p=>!p||p.startsWith('.'))||(edit.operation!=='mkdir'&&!(/\.(docx|xlsx|pptx|md|mdx|txt|json|html|htm|css|scss|sass|less|js|mjs|cjs|jsx|ts|tsx|vue|svelte|swift|sql|csv|xml|sh|c|h|cpp|py|toml|yaml|yml|go|rs|rb|php|java)$/i.test(ref.path))))throw Error('请使用已有父目录下的普通相对路径；文件需为 Markdown、代码或配置文本。');
   if(/\.(docx|xlsx|pptx)$/i.test(ref.path)){try{const spec=JSON.parse(edit.content);if(!spec||Array.isArray(spec)||typeof spec!=='object')throw Error();}catch{throw Error('Office 提案内容必须是结构化 JSON。');}}
   const key=JSON.stringify([ref.candidateId,ref.path]);if(seen.has(key))throw Error('同一轮不能重复修改同一个文件。');seen.add(key);
   return {operation:edit.operation,content:edit.content||'',candidateId:ref.candidateId,projectId:ref.projectId,path:ref.path,version:ref.version,runId:run.id};
  });
 }
 // Rebuild from durable run records, never from the currently visible messages.
 function outputs(state,conversationId){
  const rows=[],seen=new Set();
  for(const run of [...(state.agentRuns||[])].filter(r=>r.conversationId===conversationId&&F.active(r)).sort((a,b)=>(b.startedAt||0)-(a.startedAt||0))){
   for(const edit of run.localFileEdits||[])rows.push({kind:'local',runId:run.id,id:edit.id,title:edit.path,status:edit.status,pending:edit.status==='pending'});
   for(const change of run.fileChanges||[]){
    const key=JSON.stringify([change.type,change.id]);if(seen.has(key))continue;seen.add(key);
    const current=F.available(state,change.type,change.id);if(!current||change.undoneAt)continue;
    rows.push({kind:change.type,runId:run.id,id:change.id,title:current.title||current.name||change.title,pending:change.type==='note'&&!!current.aiDraft});
   }
  }
  return rows.sort((a,b)=>Number(b.pending)-Number(a.pending));
 }
 function followUp(state,run,edit,action){
  if(edit.directory)return;
  const conversation=(state.conversations||[]).find(c=>c.id===run.conversationId&&F.active(c));if(!conversation)return;
  const old=action==='apply'?edit.beforeVersion:edit.afterVersion,next=action==='apply'?edit.afterVersion:edit.beforeVersion;
  const identity={type:'local',candidateId:edit.candidateId,projectId:edit.projectId,path:edit.path};
  const refs=F.references(conversation),existing=refs.find(r=>F.key(r)===F.key(identity));
  if(existing&&existing.version===old){if(next)F.refresh(conversation,{...existing,version:next,selectedAt:Date.now()});else F.remove(conversation,existing);}
  else if(action==='apply'&&edit.beforeVersion===null&&!existing&&!(conversation.excludedFileReferenceKeys||[]).includes(F.key(identity))){
   F.stage(conversation,{...identity,title:edit.path.split('/').at(-1),version:next,selectedAt:Date.now()});
  }
 }
 function tray(conversation){
  if(!hooks||!conversation)return;
  let host=root.document.getElementById('conversationOutputs');
  if(!host){host=el('details','conversation-outputs');host.id='conversationOutputs';root.document.getElementById('composer')?.before(host);}
  if(host.dataset.conversationId!==conversation.id)host.open=false;
  host.dataset.conversationId=conversation.id;const rows=outputs(hooks.getState(),conversation.id);host.hidden=!rows.length;host.replaceChildren();if(!rows.length)return;
  const pending=rows.filter(r=>r.pending).length,summary=el('summary');summary.append(el('span','',t('对话产出','Conversation files')+` · ${rows.length}`));if(pending)summary.append(el('span','output-pending',`${pending} `+t('项待审阅','to review')));host.append(summary);
  const list=el('div','conversation-output-list');
  for(const row of rows){const item=el('div','conversation-output-row'),open=btn(row.title,()=>row.kind==='local'?hooks.open(row.runId,row.id):hooks.openFile(row.kind,row.id));open.className='output-file';open.title=row.title;
   item.append(open,el('small','',row.kind==='local'?status(row.status):row.pending?t('待采纳草稿','Draft to review'):t('已入库','In library')));
   if(row.kind!=='local'){const review=btn(t('查看修改','Review changes'),()=>hooks.openReview(row.runId));review.className='output-review';item.append(review);}list.append(item);
  }host.append(list);
 }
 let hooks;
 const el=(tag,cls,text)=>{const node=root.document.createElement(tag);node.className=cls||'';if(text!==undefined)node.textContent=text;return node;};
 const btn=(text,fn)=>{const b=el('button','secondary',text);b.type='button';b.onclick=fn;return b;};
 const status=s=>({pending:t('待保存到本机','Ready to save'),applied:t('已保存到本机','Saved to file'),undone:t('已撤销','Undone'),dismissed:t('已放弃','Dismissed'),interrupted:t('需要检查当前文件','Check current file'),applying:t('正在确认保存结果','Checking save result'),undoing:t('正在确认撤销结果','Checking undo result')})[s]||s;
 function card(run){
  if(!run?.localFileEdits?.length)return null;
  const card=el('section','file-change-card local-file-change-card'),head=el('header');head.append(el('strong','',t('本机文件修改','Local file changes')+` · ${run.localFileEdits.length}`),btn(t('审阅文件','Review files'),()=>hooks.open(run.id)));card.append(head,el('p','local-file-notice',t('提案已保存在此设备。待保存项只有点击“保存到本机”才会写入。','Proposals are stored on this device. Pending edits are written only when you choose “Save to file”.')));
  for(const edit of run.localFileEdits){const row=btn('',()=>hooks.open(run.id));row.className='file-change-row';row.append(el('span','file-change-name',edit.path),el('span','local-file-status',status(edit.status)));if(edit.status==='applied')row.dataset.fileRef=JSON.stringify({type:'local',...edit});card.append(row);}
  return card;
 }
 function render(container,run,selectedId){
  container.replaceChildren();const layout=el('section','file-review');const tree=el('nav','file-review-tree'),viewer=el('div','file-review-viewer');tree.setAttribute('aria-label',t('本轮本机文件','Local file changes'));const search=el('input');search.placeholder=t('筛选本轮文件…','Filter changed files…');search.setAttribute('aria-label',search.placeholder);tree.append(search);layout.append(tree,viewer);container.append(layout);let epoch=0;
  const entries=[];
  const valid=(edit,action)=>{const state=hooks.getState();if(hooks.isBusy()||!state.agentRuns.some(r=>r.id===run.id&&!r.archived&&!r.deletedAt&&!(action==='dismiss'?['running']:['running','failed','cancelled']).includes(r.status)))throw Error(t('请等待对话完成，并从有效的执行记录审阅。','Wait for the conversation to finish and review an active run.'));if(action!=='dismiss'&&!state.projects.some(p=>F.active(p)&&p.id===edit.projectId&&p.localFolder?.id===edit.candidateId))throw Error(t('项目目录已断开或归档。','The project is disconnected or archived.'));};
  async function select(summary){
   const ticket=++epoch;entries.forEach(([item,b])=>b.setAttribute('aria-pressed',String(item===summary)));viewer.replaceChildren(el('p','muted',t('正在读取修改快照…','Loading change snapshots…')));
   try{
    let edit=await F.request('/__local/edits/get',{id:summary.id});if(ticket!==epoch||!layout.isConnected)return;
    const current=hooks.getState().agentRuns.find(r=>r.id===run.id)?.localFileEdits?.find(e=>e.id===summary.id);if(current&&current.status!==edit.status){current.status=edit.status;summary.status=edit.status;hooks.save();}
    function draw(){
     viewer.replaceChildren();const actions=el('div','file-review-actions'),body=el('div','file-review-content'),error=el('p','file-review-error');error.hidden=true;error.setAttribute('role','alert');
     const show=mode=>{body.replaceChildren();actions.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===mode)));if(mode==='preview'){const article=el('article','note-document-preview');article.innerHTML=hooks.markdown(edit.after);body.append(article);}else if(mode==='source')body.append(el('pre','',edit.after));else{
      const all=root.FileReview.diff(edit.before,edit.after),kept=new Set();all.forEach((row,i)=>{if(row.type!=='same')for(let n=Math.max(0,i-3);n<=Math.min(all.length-1,i+3);n++)kept.add(n);});const rows=[];let skipped=0;all.forEach((row,i)=>{if(kept.has(i)){if(skipped)rows.push({type:'same',text:`… ${skipped} ${t('行未修改','unchanged lines')} …`});skipped=0;rows.push(row);}else skipped++;});if(skipped)rows.push({type:'same',text:`… ${skipped} ${t('行未修改','unchanged lines')} …`});const table=el('div','file-review-diff');let shown=0;const more=btn(t('继续显示','Show more'),append);
      function append(){for(const row of rows.slice(shown,shown+400)){const line=el('div','diff-line '+row.type);line.append(el('span','diff-number',row.old??''),el('span','diff-number',row.next??''),el('span','diff-sign',row.type==='add'?'+':row.type==='remove'?'−':' '),el('code','',row.text));table.append(line);}shown+=400;more.hidden=shown>=rows.length;}
      append();body.append(table,more);
     }};
     for(const [mode,label] of [['diff','Diff'],['source',edit.office?t('修改后文字','Proposed text'):t('修改后源码','Proposed source')],...(/\.md$/i.test(edit.path)?[['preview',t('排版预览','Preview')]]:[])]){const b=btn(label,()=>show(mode));b.dataset.mode=mode;actions.append(b);}
     async function act(action){
      try{valid(edit,action);actions.querySelectorAll('button').forEach(b=>b.disabled=true);const result=await F.request('/__local/edits/'+action,{id:edit.id});
       edit=result;if(['apply','undo'].includes(action))hooks.fileChanged?.(run,result,action);const current=hooks.getState().agentRuns.find(r=>r.id===run.id)?.localFileEdits?.find(e=>e.id===summary.id);if(current){current.status=result.status;summary.status=result.status;hooks.save();}
       if(ticket===epoch&&layout.isConnected)draw();
      }catch(e){if(ticket===epoch&&layout.isConnected){actions.querySelectorAll('button').forEach(b=>b.disabled=false);error.textContent=e.message;error.hidden=false;}}
     }
     if(edit.status==='pending'){const save=btn(t('保存到本机','Save to file'),()=>act('apply'));save.dataset.localEditAction='apply';actions.append(save);const dismiss=btn(t('放弃提案','Dismiss proposal'),()=>act('dismiss'));dismiss.dataset.localEditAction='dismiss';actions.append(dismiss);}
     if(edit.status==='applied'){const undo=btn(t('撤销本轮修改','Undo this edit'),()=>act('undo'));undo.dataset.localEditAction='undo';actions.append(undo);}
     if(!edit.creating||edit.status==='applied')actions.append(btn(t('在 Finder 中显示','Show in Finder'),async()=>{try{await root.FileActions.reveal({type:'local',...edit});}catch(e){hooks.toast(e.message);}}));
     viewer.append(el('h3','',edit.path),el('p','muted',status(edit.status)+' · '+t('此处保留本轮快照；文件的后续修改不会覆盖它。','This review preserves the snapshots from this turn.')),actions,error,body);show('diff');
    }draw();
   }catch(error){if(ticket===epoch&&layout.isConnected)viewer.replaceChildren(el('p','file-review-error',error.message));}
  }
  for(const edit of run.localFileEdits){const b=btn(edit.path,()=>select(edit));b.className='file-review-file';tree.append(b);entries.push([edit,b]);}
  search.oninput=()=>entries.forEach(([e,b])=>b.hidden=!e.path.toLowerCase().includes(search.value.toLowerCase()));if(entries.length)select(entries.find(([e])=>e.id===selectedId)?.[0]||entries[0][0]);
 }
 return {validate,outputs,followUp,tray,card,render,init(value){hooks=value;}};
});
