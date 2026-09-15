// Isolated workspace only: exercise real persistence, action execution and reader navigation.
const check=(v,message)=>{if(!v)throw Error(message);};
NativeConversationActions.perform({kind:'folder',action:'create',name:'学习资料'});
const folder=state.folders.conversations.find(x=>x.name==='学习资料');
const chat=state.conversations[0];
NativeConversationActions.perform({kind:'conversation',id:chat.id,action:'save',name:'周末计划整理',folderId:folder.id});
NativeConversationActions.perform({kind:'folder',id:folder.id,action:'archive'});
check(state.conversations.find(x=>x.id===chat.id).archived,'folder archive');
NativeConversationActions.perform({kind:'folder',id:folder.id,action:'restore'});
check(!state.conversations.find(x=>x.id===chat.id).archived,'folder restore');
const run={id:'qa-file-review',conversationId:chat.id,workspace:'日常',projectId:'qa-trip',steps:[],status:'completed'};
state.agentRuns.push(run);
const results=executeActions([{type:'create_note',title:'出行资料清单',content:'# 出行资料清单\n\n## 行前准备\n- 确认交通\n- 带好雨具',workspace:'日常',projectId:'qa-trip',sourceAttachmentIds:[]}],run);
check(run.fileChanges?.length===1,'capture execution before and after');
const noteId=results.find(x=>x.type==='note').id;
const message={id:'qa-reviewed-message',role:'assistant',text:'已经整理好出行资料清单。',runId:run.id,results};state.conversations.find(x=>x.id===chat.id).messages.push(message);state.currentConversationId=chat.id;save();renderAll();
await openPreview('review',run.id);
check(document.querySelector('.file-review-diff .add'),'diff visible');
check(document.querySelector('#previewVisual').style.display==='block','review surface visible');
await openPreview('note',noteId);
check(!document.querySelector('#previewContent').hidden,'note returns after review');
check(!document.querySelector('#previewExtracted').hidden,'note parent returns after review');
check(document.querySelector('[data-note-action=edit]').textContent==='源码','source mode available');
await openPreview('review',run.id);
check(document.querySelectorAll('.reading-tab').length>=2,'review and file tabs');
// Exercise the actual picker and persistent references without a model request.
const liveChat=state.conversations.find(x=>x.id===chat.id);
const pickerWait=async condition=>{for(let i=0;i<120;i++){if(condition())return;await new Promise(r=>setTimeout(r,25));}throw Error('file picker timed out');};
FileContextUI.open();
const picker=document.querySelector('#fileContextPicker'), search=picker.querySelector('input');
search.value='出行资料清单';search.dispatchEvent(new Event('input',{bubbles:true}));
await pickerWait(()=>picker.querySelector('[role=option]'));
search.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
await pickerWait(()=>FileContext.references(liveChat).length===1);
check(document.querySelector('#fileContextChips button').textContent==='出行资料清单','selected reference chip');
const selectedRefs=FileContext.references(liveChat), frozen=await FileContext.prepare(state,selectedRefs);
check(frozen.initial[0].text.includes('确认交通'),'actual referenced note content');
liveChat.messages.push({id:'qa-file-reference-message',role:'user',text:'根据这份笔记继续完善出行准备。',fileReferences:selectedRefs});
FileContext.consume(liveChat,selectedRefs);save();renderConversation();
check(FileContext.references(liveChat).length===1,'reference survives next turn');
check(document.querySelector('.message-file-references button'),'transcript reference link');
FileContext.remove(liveChat,selectedRefs[0]);FileContextUI.render();
check(FileContext.references(liveChat).length===0,'remove ongoing reference');
check(FileContext.references(liveChat,{retry:true,message:liveChat.messages.at(-1)}).length===1,'retry retains original selection');
FileContext.stage(liveChat,selectedRefs[0]);
if(referenceDirectory){
 const connected=await FileContext.request('/__local/roots',{path:referenceDirectory});
 const project=state.projects.find(p=>p.id==='qa-trip');project.localFolder={id:connected.candidate.id,rootId:connected.root.id,name:connected.candidate.name,path:connected.candidate.path};
 FileContextUI.open();picker.querySelector('[data-mode=local]').click();
 await pickerWait(()=>picker.querySelector('[role=option]'));
 picker.querySelector('[role=option]').click();
 await pickerWait(()=>[...picker.querySelectorAll('[role=option]')].some(b=>b.textContent.includes('路线计划.md')));
 [...picker.querySelectorAll('[role=option]')].find(b=>b.textContent.includes('路线计划.md')).click();
 await pickerWait(()=>FileContext.references(liveChat).some(r=>r.type==='local'));
 const prepared=await FileContext.prepare(state,FileContext.references(liveChat));
 check(prepared.initial.some(r=>r.type==='local'&&r.text.includes('溪谷路线')),'actual local file reference');
}
// Verify the real send pipeline with an isolated transport; no external API call.
const originalTransport=AgentTransport.requestPlan, previousInputs=[$('#apiBase').value,$('#apiKey').value,$('#model').value];
const captured=[];$('#apiBase').value='https://reference-qa.invalid/v1';$('#apiKey').value='synthetic';$('#model').value='synthetic-model';
liveChat.modelConfig={provider:'api',model:'synthetic-model',effort:''};
AgentTransport.requestPlan=async options=>{captured.push(options.input);if(captured.length===1&&referenceDirectory){const localRef=FileContext.references(liveChat).find(r=>r.type==='local');return JSON.stringify({knowledgeRequests:[{type:'read_file',refKey:FileContext.key(localRef),offset:12000}],actions:[]});}return JSON.stringify({workspace:'日常',message:'已根据引用资料继续整理。',actions:[]});};
try{
 await sendMessage({goal:'根据明确引用的文件，继续列出准备事项；仅回答，不创建任务。'});
 const completed=state.agentRuns.at(-1);
 check(completed.status==='completed','send pipeline completes: '+completed.status);
 check(JSON.stringify(captured).includes('确认交通'),'reference text reaches model payload');
 check(completed.fileReferences.length>=1,'run snapshots persisted');
 if(referenceDirectory)check(JSON.stringify(captured.at(-1)).includes('后半段实际证据'),'paged file read reaches follow-up request');
 const sent=liveChat.messages.find(m=>m.id===completed.userMessageId);
 const other=await FileContext.libraryRef(state,'note','qa-note-wellness');FileContext.stage(liveChat,other);
 await sendMessage({goal:completed.goal,retry:true,userMessageId:sent.id,conversationId:liveChat.id,attachmentIds:[]});
 check(!state.agentRuns.at(-1).fileReferences.some(r=>r.id===other.id),'retry does not consume newly staged reference');
 check(liveChat.draftFileReferences.some(r=>r.id===other.id),'retry preserves staged references');
 FileContext.remove(liveChat,other);
}finally{AgentTransport.requestPlan=originalTransport;[$('#apiBase').value,$('#apiKey').value,$('#model').value]=previousInputs;}
// Local disk editing is always a proposal, even in auto mode. Exercise real review controls.
if(referenceDirectory){
 const file=FileContext.references(liveChat).find(r=>r.type==='local');
 const initial=await FileContext.request('/__local/read',{candidateId:file.candidateId,path:file.path,offset:0});
 const tail=await FileContext.request('/__local/read',{candidateId:file.candidateId,path:file.path,offset:12000,version:initial.version});
 const full=initial.text+tail.text, proposed=full+'\n\n## 新增行程\n- 检查周末天气\n';
 let asks=0;
 $('#apiBase').value='https://reference-qa.invalid/v1';$('#apiKey').value='synthetic';$('#model').value='synthetic-model';
 AgentTransport.requestPlan=async()=>{asks++;return JSON.stringify(asks===1?{knowledgeRequests:[{type:'read_file',refKey:FileContext.key(file),offset:12000}],actions:[]}:{workspace:'日常',message:'已生成修改提案，请审阅后保存。',actions:[],fileEdits:[{operation:'update',refKey:FileContext.key(file),content:proposed}]});};
 try{await sendMessage({goal:'完善引用的本机路线计划，增加周末天气检查，保留其余内容。'});}finally{AgentTransport.requestPlan=originalTransport;[$('#apiBase').value,$('#apiKey').value,$('#model').value]=previousInputs;}
 const diskRun=state.agentRuns.at(-1);check(diskRun.status==='completed','file edit run: '+diskRun.error);
 check(diskRun.localFileEdits?.length===1,'proposal captured');
 check((await FileContext.request('/__local/read',{candidateId:file.candidateId,path:file.path})).version===initial.version,'proposal does not write');
 await openPreview('local-review',diskRun.id);
 await pickerWait(()=>document.querySelector('[data-local-edit-action=apply]'));
 check(document.querySelector('.file-review-diff .add'),'local diff shown');
 document.querySelector('[data-mode=preview]').click();check(document.querySelector('#previewVisual article').textContent.includes('检查周末天气'),'local Markdown preview');
 document.querySelector('[data-local-edit-action=apply]').click();
 await pickerWait(()=>document.querySelector('[data-local-edit-action=undo]'));
 const saved=await FileContext.request('/__local/read',{candidateId:file.candidateId,path:file.path});check(saved.version!==initial.version,'review button writes file');check(FileContext.references(liveChat).find(r=>r.type==='local').version===saved.version,'saved file reference advances for follow-up');
 document.querySelector('[data-local-edit-action=undo]').click();
 await pickerWait(()=>diskRun.localFileEdits[0].status==='undone');
 check((await FileContext.request('/__local/read',{candidateId:file.candidateId,path:file.path})).version===initial.version,'undo restores original bytes');
 // Actual right click opens the theme-aware menu and an actual Finder reveal.
 FileContextUI.render();const chip=[...document.querySelectorAll('[data-file-ref]')].find(n=>JSON.parse(n.dataset.fileRef).type==='local');
 check(chip,'context target present');chip.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:250,clientY:350}));
 check(document.querySelector('.file-action-menu [role=menuitem]'),'Finder context action visible');
 document.querySelector('.file-action-menu button').click();
 await new Promise(r=>setTimeout(r,500));
 const fixture='qa-finder-original';const bytes=new TextEncoder().encode('Synthetic imported file for Finder QA.');
 const uploaded=await fetch('/__files/'+fixture,{method:'POST',headers:{'X-Filename':'Finder-fixture.txt','Content-Type':'text/plain'},body:bytes});check(uploaded.ok,'synthetic import stored');
 state.imports.push({id:fixture,name:'Finder-fixture.txt',originalName:'Finder-fixture.txt',mimeType:'text/plain',size:bytes.length,projectId:'qa-trip',workspace:'日常',createdAt:Date.now()});save();await window.flushWorkspace();
 await openPreview('import',fixture);const tab=document.querySelector('[data-open-import-context="'+fixture+'"]');check(tab,'reader tab reveal identity');
 tab.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:600,clientY:150}));check(document.querySelector('.file-action-menu'),'reader tab context menu');
 document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));check(!document.querySelector('.file-action-menu'),'Escape dismisses menu');
 check((await FileActions.reveal({type:'import',id:fixture})).ok,'actual imported file reveal');
 await openPreview('local-review',diskRun.id);

 // Directory creation follows the same explicit review boundary.
 const directory=await FileContext.request('/__local/edits/propose',{candidateId:file.candidateId,projectId:liveChat.projectId,runId:diskRun.id,path:'实验产出',operation:'mkdir'});
 diskRun.localFileEdits.push(directory);save();await openPreview('local-review',diskRun.id,directory.id);await pickerWait(()=>document.querySelector('[data-local-edit-action=apply]')&&document.querySelector('.file-review-viewer h3')?.textContent==='实验产出');
 document.querySelector('[data-local-edit-action=apply]').click();await pickerWait(()=>directory.status==='applied');check(!FileContext.references(liveChat).some(r=>r.path==='实验产出'),'directories are not file references');
 check((await FileActions.reveal({type:'local',...directory})).ok,'created directory Finder reveal');
 document.querySelector('[data-local-edit-action=undo]').click();await pickerWait(()=>directory.status==='undone');
 // Office output is reviewed as extracted text, never executed or saved implicitly.
 const office=await FileContext.request('/__local/edits/propose',{candidateId:file.candidateId,projectId:liveChat.projectId,runId:diskRun.id,path:'Experiment.docx',operation:'create',content:JSON.stringify({paragraphs:[{text:'Experiment plan',style:'Title'},'Keep source evidence.']})});
 diskRun.localFileEdits.push(office);save();await openPreview('local-review',diskRun.id,office.id);await pickerWait(()=>document.querySelector('[data-local-edit-action=apply]')&&document.querySelector('.file-review-viewer h3')?.textContent==='Experiment.docx');
 check(document.querySelector('.file-review-content').textContent.includes('Keep source evidence.'),'Office text review');document.querySelector('[data-local-edit-action=apply]').click();await pickerWait(()=>office.status==='applied');
 check((await FileContext.request('/__local/read',{candidateId:file.candidateId,path:'Experiment.docx'})).text.includes('Keep source evidence.'),'generated Word readable');document.querySelector('[data-local-edit-action=undo]').click();await pickerWait(()=>office.status==='undone');
 // Persisted conversation shelf, exact proposal selection, creation follow-up and dismissal.
 const creation=await FileContext.request('/__local/edits/propose',{candidateId:file.candidateId,projectId:liveChat.projectId,runId:diskRun.id,path:'新建待办.md',operation:'create',content:'# 待办\n- 确认天气'});
 diskRun.localFileEdits.push(creation);save();renderConversation();
 const shelf=document.getElementById('conversationOutputs');check(!shelf.hidden&&shelf.textContent.includes('项待审阅'),'persistent shelf pending count');shelf.open=true;
 [...shelf.querySelectorAll('.output-file')].find(b=>b.textContent==='新建待办.md').click();
 await pickerWait(()=>document.querySelector('[data-local-edit-action=apply]')&&document.querySelector('.file-review-viewer h3')?.textContent==='新建待办.md');
 document.querySelector('[data-local-edit-action=apply]').click();await pickerWait(()=>creation.status==='applied');
 check(FileContext.references(liveChat).some(r=>r.path==='新建待办.md'),'new file joins continuing conversation');
 document.querySelector('[data-local-edit-action=undo]').click();await pickerWait(()=>creation.status==='undone');
 check(!FileContext.references(liveChat).some(r=>r.path==='新建待办.md'),'undo removes created reference');
 const dismissed=await FileContext.request('/__local/edits/propose',{candidateId:file.candidateId,projectId:liveChat.projectId,runId:diskRun.id,path:'放弃提案.md',operation:'create',content:'# Proposed'});
 diskRun.localFileEdits.push(dismissed);const folder=state.projects.find(p=>p.id===liveChat.projectId).localFolder;delete state.projects.find(p=>p.id===liveChat.projectId).localFolder;
 await openPreview('local-review',diskRun.id,dismissed.id);await pickerWait(()=>document.querySelector('[data-local-edit-action=dismiss]'));
 document.querySelector('[data-local-edit-action=dismiss]').click();await pickerWait(()=>dismissed.status==='dismissed');
 state.projects.find(p=>p.id===liveChat.projectId).localFolder=folder;
 renderConversation();check(shelf.open,'shelf remains expanded after save');
 check(LocalFileEdits.outputs(JSON.parse(JSON.stringify(state)),liveChat.id).some(r=>r.id===creation.id),'shelf survives state serialization');
}
if(referenceDirectory){
 const capturedCommands=[];let turn=0;
 $('#apiBase').value='https://terminal-qa.invalid/v1';$('#apiKey').value='synthetic';$('#model').value='synthetic-model';
 AgentTransport.requestPlan=async options=>{capturedCommands.push(options.input);return JSON.stringify(++turn===1?{knowledgeRequests:[{type:'terminal',argv:['/bin/pwd'],cwd:'',timeout:5}],actions:[]}:{message:'已依据终端实际结果完成检查。',actions:[]});};
 try{
  const sending=sendMessage({goal:'运行 pwd 检查当前项目工作目录，仅检查。'});
  await pickerWait(()=>document.querySelector('[data-command-action=remember]'));
  const command=state.agentRuns.at(-1).commands[0];check(command.status==='pending'&&!command.output,'command waits for explicit approval');
  document.querySelector('[data-command-action=remember]').click();await sending;
  check(command.status==='succeeded'&&command.exitCode===0,'real terminal succeeds');
  check(JSON.stringify(capturedCommands.at(-1)).includes(command.output.trim()),'actual terminal result reaches next model request');
  check(command.trusted,'explicit readonly allowlist saved');
  turn=0;await sendMessage({goal:'再次检查当前项目工作目录。'});
  check(state.agentRuns.at(-1).commands[0].status==='succeeded','exact approved command auto-runs');
  const forget=document.querySelector('[data-command-action=forget]');check(forget,'allowlist can be revoked');forget.click();
  await pickerWait(()=>!document.querySelector('[data-command-action=forget]'));
  turn=0;AgentTransport.requestPlan=async()=>JSON.stringify(++turn===1?{knowledgeRequests:[{type:'terminal',argv:['/bin/echo','must not execute'],timeout:5}],actions:[]}:{message:'命令已拒绝，未执行。',actions:[]});
  const rejected=sendMessage({goal:'输出一行测试文字。'});await pickerWait(()=>document.querySelector('[data-command-action=deny]'));document.querySelector('[data-command-action=deny]').click();await rejected;
  check(state.agentRuns.at(-1).commands[0].status==='cancelled'&&!state.agentRuns.at(-1).commands[0].startedAt,'denial does not run a process');
  turn=0;AgentTransport.requestPlan=async()=>JSON.stringify({knowledgeRequests:[{type:'terminal',argv:['/bin/sleep','10'],timeout:15}],actions:[]});
  const stopped=sendMessage({goal:'等待十秒，用于验证停止命令。'});await pickerWait(()=>document.querySelector('[data-command-action=start]'));document.querySelector('[data-command-action=start]').click();await pickerWait(()=>document.querySelector('[data-command-action=cancel]'));
  activeRunController.abort();await stopped;check(state.agentRuns.at(-1).status==='cancelled','stop cancels the agent tool loop');
  check(state.agentRuns.at(-1).commands[0].status!=='succeeded','stopped command not marked successful');
 }finally{AgentTransport.requestPlan=originalTransport;[$('#apiBase').value,$('#apiKey').value,$('#model').value]=previousInputs;}
}

// Capture UI → durable original → versioned references → real action commit → provenance.
showView('captures','随记');CaptureNotes.render();
const captureInput=document.querySelector('#captures textarea');
captureInput.value='观察：短笔记能帮助复盘。';captureInput.dispatchEvent(new Event('input',{bubbles:true}));
CaptureNotes.attach([new File(['# 观察记录\n一次只改变一个变量。'],'随记附件.md',{type:'text/markdown'})]);
document.querySelector('[data-capture-save]').click();
await pickerWait(()=>CaptureNotes.items(state).length===1&&!document.querySelector('[data-capture-save]').disabled);
const captureOne=CaptureNotes.items(state)[0];check(captureOne.sourceAttachmentIds.length===1,'capture original attachment saved');
check(captureInput.value==='','successful capture clears composer');
captureInput.value='行动：为这个想法设计一个小实验，日期待定。';captureInput.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-capture-save]').click();
await pickerWait(()=>CaptureNotes.items(state).length===2&&!document.querySelector('[data-capture-save]').disabled);
const sourceCopies=JSON.stringify(CaptureNotes.items(state));
document.querySelectorAll('.capture-card input[type=checkbox]').forEach(n=>{n.checked=true;n.dispatchEvent(new Event('change'));});
$('#apiBase').value='https://capture-qa.invalid/v1';$('#apiKey').value='synthetic';$('#model').value='synthetic-model';
let captureRequest;
AgentTransport.requestPlan=async options=>{captureRequest=options.input;return JSON.stringify({workspace:'日常',message:'已整理关联与下一步。',actions:[{type:'create_note',title:'零散观察 · 实验线索',workspace:'日常',content:'# 实验线索\n原始观察：短笔记辅助复盘。\n待验证：单变量对照实验。'},{type:'create_task',workspace:'日常',title:'设计单变量实验'}]});};
try{
 document.querySelector('[data-capture-ai=organize]').click();
 await pickerWait(()=>state.agentRuns.at(-1)?.captureNoteIds?.length===2&&['completed','failed'].includes(state.agentRuns.at(-1).status));
 const captureRun=state.agentRuns.at(-1);check(captureRun.status==='completed','capture AI workflow: '+captureRun.error);
 check(JSON.stringify(CaptureNotes.items(state))===sourceCopies,'analysis preserves source captures exactly');
 check(JSON.stringify(captureRequest).includes('一次只改变一个变量'),'attachment content reaches actual request');
 const derived=state.notes.find(n=>n.title==='零散观察 · 实验线索');check(derived?.sourceNoteIds?.length===2,'derived note links all selected sources');
 const nextTask=state.tasks.find(n=>n.title==='设计单变量实验');check(nextTask?.sourceNoteIds?.length===2&&!nextTask.dueAt,'task source links and no invented date');
 await openPreview('note',derived.id);check(document.querySelectorAll('#previewRelations [data-preview-note]').length===2,'reader can return to each original capture');
 showView('captures','随记');CaptureNotes.render();check(document.querySelectorAll('.capture-derived').length===2,'capture cards show derived results');
 const beforeChats=state.conversations.length;document.querySelector('[data-capture-ai=organize]').click();await new Promise(r=>setTimeout(r,150));check(state.conversations.length===beforeChats,'same batch returns to existing conversation');
 await window.flushWorkspace();const persisted=await (await fetch('/__state')).json();check(persisted.notes.find(n=>n.id===captureOne.id)?.sourceAttachmentIds.length===1,'capture and attachment link survive server persistence');
}finally{AgentTransport.requestPlan=originalTransport;[$('#apiBase').value,$('#apiKey').value,$('#model').value]=previousInputs;}
showView('captures','随记');CaptureNotes.render();

// Typed Wiki editor, cross-conversation list/read, reviewed update and source backlinks.
showView('wiki','科研 Wiki');ResearchWikiUI.render();document.querySelector('.wiki-heading button.primary').click();
const wikiTitle=document.querySelector('.wiki-dialog .wiki-title');wikiTitle.value='稀疏采样 · 对照实验';wikiTitle.dispatchEvent(new Event('input'));
const hypothesis=document.querySelector('[data-wiki-section=hypothesis]');hypothesis.value='测试局部片段采样是否遗漏短事件。';hypothesis.dispatchEvent(new Event('input'));
document.querySelector('[data-wiki-save]').click();await pickerWait(()=>!document.querySelector('.wiki-dialog').open);
const wiki=ResearchWiki.entries(state).find(n=>n.title==='稀疏采样 · 对照实验');check(wiki,'manual Wiki saved');const wikiOriginal=wiki.content;
await refreshWikiVault(true);check(state._wikiEnabled&&state._wikiFiles[wiki.id]?.path.endsWith('.md'),'Wiki Markdown authority initialized and indexed');
state.settings.permissions.科研='auto';newConversation('科研');const wikiChat=currentConversation();
FileContext.stage(wikiChat,await FileContext.libraryRef(state,'note',captureOne.id));
$('#apiBase').value='https://wiki-qa.invalid/v1';$('#apiKey').value='synthetic';$('#model').value='synthetic-model';
let wikiTurn=0;const wikiRequests=[];
AgentTransport.requestPlan=async options=>{wikiRequests.push(options.input);wikiTurn++;return JSON.stringify(wikiTurn===1?{knowledgeRequests:[{type:'wiki_list',offset:0}],actions:[]}:wikiTurn===2?{knowledgeRequests:[{type:'read',recordType:'note',id:wiki.id,offset:0}],actions:[]}:{workspace:'科研',message:'已生成实验记忆更新草稿，原有记录保留。',actions:[{type:'upsert_wiki',wikiType:'experiment',title:wiki.title,noteId:wiki.id,baseUpdatedAt:wiki.updatedAt,projectId:null,sourceNoteIds:[captureOne.id],sections:Object.fromEntries(Object.keys(ResearchWiki.fields('experiment')).map(k=>[k,k==='results'?'首次试验未覆盖短事件，需再次验证。':k==='hypothesis'?'测试局部片段采样是否遗漏短事件。':'尚待记录。']))}]});};
try{
 await sendMessage({goal:'读取已保存的实验 Wiki，将本轮观察写为待审阅更新，保留所有原有章节。'});
 const r=state.agentRuns.at(-1);check(r.status==='completed','Wiki tool loop: '+r.error);check(wikiTurn===3,'Wiki list → read → update loop');
 const latest=state.notes.find(n=>n.id===wiki.id);check(latest.content===wikiOriginal&&latest.aiDraft,'Wiki body preserved before review');check(JSON.stringify(wikiRequests.at(-1)).includes('局部片段采样'),'persisted research content reaches new conversation');
 const adopt=[...document.querySelectorAll('.draft-review-card button')].find(b=>b.textContent==='采纳并保存');check(adopt,'Wiki adoption control shown in chat');adopt.click();await pickerWait(()=>!state.notes.find(n=>n.id===wiki.id).aiDraft);
 const adopted=state.notes.find(n=>n.id===wiki.id);check(adopted.content.includes('首次试验')&&!adopted.aiDraft,'Wiki draft adopted');check(adopted.revisionHistory.at(-1).content===wikiOriginal,'old Wiki body retained');check(adopted.sourceNoteIds.includes(captureOne.id),'adopted Wiki retains capture source');
 await openPreview('note',captureOne.id);check(document.querySelector('#previewRelations').textContent.includes(wiki.title),'original capture has reverse Wiki link');
 await window.flushWorkspace();const savedWiki=(await(await fetch('/__state')).json()).notes.find(n=>n.id===wiki.id);check(savedWiki.kind==='科研 Wiki/experiment'&&savedWiki.content===adopted.content,'typed Wiki survives real persistence');
}finally{AgentTransport.requestPlan=originalTransport;[$('#apiBase').value,$('#apiKey').value,$('#model').value]=previousInputs;}
showView('wiki','科研 Wiki');ResearchWikiUI.render();
const treeEntry=document.querySelector('[data-wiki-tree-note="'+wiki.id+'"]');check(treeEntry,'Wiki directory references saved note');treeEntry.click();await pickerWait(()=>document.querySelector('#previewTitle')?.textContent===wiki.title);
const researchProject=state.projects.find(p=>p.workspace==='科研'&&!p.archived);const previousChat=currentConversation().id;
check(NativeShell.perform({type:'new-project-conversation',id:researchProject.id}),'new project chat command accepted');check(currentConversation().projectId===researchProject.id&&currentConversation().id!==previousChat,'project shortcut creates one correctly owned conversation');
// Real scheduling and child model loop with isolated model responses.
newConversation('科研');$('#apiBase').value='https://delegation-qa.invalid/v1';$('#apiKey').value='synthetic';$('#model').value='synthetic-model';
let parentTurns=0,childTurns=0;
AgentTransport.requestPlan=async options=>{
 const input=typeof options.input==='string'?options.input:JSON.stringify(options.input);
 if(input.startsWith('你是只读研究子代理')){childTurns++;return JSON.stringify(childTurns===1?{knowledgeRequests:[{type:'read',id:wiki.id}],actions:[]}:{message:'已读取实验条目 '+wiki.id+'，观察仍需验证。',actions:[]});}
 parentTurns++;return JSON.stringify(parentTurns===1?{knowledgeRequests:[{type:'read',id:wiki.id},{type:'delegate',title:'核对实验',task:'读取现有实验条目并列出证据缺口。'}],actions:[]}:{workspace:'科研',message:'并发读取与子代理研究已汇合，未修改任何资料。',actions:[]});
};
try{
 await sendMessage({goal:'把实验核对拆成独立只读子问题，并综合现有证据。'});
 const r=state.agentRuns.at(-1);check(r.status==='completed','scheduled child workflow: '+r.error);check(parentTurns===2&&childTurns===2,'separate parent and child model requests');
 check(r.toolCalls.length===3&&r.toolCalls.every(t=>t.status==='completed'),'all concurrent reads and child calls recorded');check(r.toolCalls.some(t=>t.parentId),'nested child evidence log');
 check(document.querySelector('.tool-ledger'),'tool ledger rendered in conversation');
 await window.flushWorkspace();const saved=(await(await fetch('/__state')).json()).agentRuns.find(x=>x.id===r.id);check(saved.delegations[0].readEvidence[0].id===wiki.id,'child provenance persisted');
 // Stop reaches the child request and its parent; no late completion is accepted.
 newConversation('科研');let enteredChild=false;
 AgentTransport.requestPlan=async options=>{if(String(options.input).startsWith('你是只读研究子代理')){enteredChild=true;return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(Error('Synthetic stop'),{code:'CANCELLED'})),{once:true}));}return JSON.stringify({knowledgeRequests:[{type:'delegate',task:'读取实验'}],actions:[]});};
 const pending=sendMessage({goal:'测试停止子代理'});await pickerWait(()=>enteredChild);stopCurrentRun();await pending;
 const stopped=state.agentRuns.at(-1);check(stopped.status==='cancelled'&&stopped.delegations[0].status==='cancelled','stop propagated to child');check(stopped.toolCalls.every(t=>!['queued','running'].includes(t.status)),'no stuck tool statuses');
}finally{AgentTransport.requestPlan=originalTransport;[$('#apiBase').value,$('#apiKey').value,$('#model').value]=previousInputs;}
// Task dependency editing preserves unsaved selections across checklist refresh.
const dependencyRun={id:'qa-dependencies',conversationId:currentConversation().id,projectId:researchProject.id,workspace:'科研',steps:[],status:'completed'};state.agentRuns.push(dependencyRun);
executeActions([{type:'create_task',title:'Synthetic baseline',projectId:researchProject.id,workspace:'科研'},{type:'create_task',title:'Synthetic comparison',projectId:researchProject.id,workspace:'科研'}],dependencyRun);
const baseTask=state.tasks.find(t=>t.title==='Synthetic baseline'),comparisonTask=state.tasks.find(t=>t.title==='Synthetic comparison');window.WorkstationRunHistory.open();check(document.querySelector('#runHistoryDialog').open,'history opened before task');openTask(comparisonTask.id);check(!document.querySelector('#runHistoryDialog').open&&document.querySelector('#taskDialog').open,'task replaces execution history without overlapping');
const dependencyCheck=document.querySelector('[data-dependency-id="'+baseTask.id+'"]');check(dependencyCheck,'dependency editor present');dependencyCheck.checked=true;document.querySelector('#newChecklistItem').value='Synthetic check';document.querySelector('#addChecklistItem').click();check(document.querySelector('[data-dependency-id="'+baseTask.id+'"]').checked,'dependency draft survives checklist refresh');document.querySelector('#saveTask').click();check(state.tasks.find(t=>t.id===comparisonTask.id).dependsOn.includes(baseTask.id),'dependency saved by task form');
// Durable project memory and scheduled execution use the real UI/store/tool path.
NativeShell.perform({type:'new-project-conversation',id:researchProject.id});
$('#apiBase').value='https://project-memory-qa.invalid/v1';$('#apiKey').value='synthetic';$('#model').value='synthetic-model';
const memoryChat=currentConversation();let memoryRequest;
AgentTransport.requestPlan=async options=>{memoryRequest=options.input;const message=memoryChat.messages.filter(m=>m.role==='user').at(-1);return JSON.stringify({workspace:'科研',message:'已记录偏好草稿。',actions:[],memoryUpdates:[{type:'preference',text:'先比较基线',messageId:message.id,quote:'先跑基线再比较'}]});};
try{
 await sendMessage({goal:'记住我的习惯：先跑基线再比较。'});
 const r=state.agentRuns.at(-1);check(r.status==='completed','memory proposal run: '+r.error);
 let long=ProjectMemory.find(state,researchProject.id,'long');check(long?.aiDraft?.content.includes('先比较基线'),'memory proposed with user quote');check(!long.content.includes('先比较基线'),'unapproved memory excluded from body');
 await openPreview('note',long.id);const adopt=[...document.querySelectorAll('.draft-review-card button')].find(b=>b.textContent==='采纳并保存');check(adopt,'memory uses persistent review control');adopt.click();await pickerWait(()=>!ProjectMemory.find(state,researchProject.id,'long').aiDraft);
 NativeShell.perform({type:'new-project-conversation',id:researchProject.id});AgentTransport.requestPlan=async options=>{memoryRequest=options.input;return JSON.stringify({workspace:'科研',message:'已读取项目记忆。',actions:[]});};
 await sendMessage({goal:'继续项目研究。'});check(JSON.stringify(memoryRequest).includes('先比较基线'),'approved memory reaches new chat');
 await saveDocumentDurably();const persisted=await(await fetch('/__state')).json();long=ProjectMemory.find(persisted,researchProject.id,'long');check(persisted._wikiFiles[long.id]?.path.includes('meta/projects/'),'research memory is an actual Wiki file');
 // Create via native-backed web controls; execute the same automatic Agent loop.
 await ProjectAutomation.open(researchProject);const form=document.querySelector('#projectAutomationDialog form'),inputs=form.querySelectorAll('input');inputs[0].value='Synthetic recurring review';form.querySelector('textarea').value='回顾现有项目记忆，返回一句总结。';inputs[1].value=new Date(Date.now()-60000-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16);form.requestSubmit();
 await pickerWait(()=>document.querySelector('#projectAutomationDialog section strong')?.textContent==='Synthetic recurring review');document.querySelector('#projectAutomationDialog').close();
 $('#agentInput').value='';currentConversation().draft='';currentConversation().draftAttachmentIds=[];
 const jobs=await(await fetch('/__project/jobs')).json(),job=jobs.jobs.find(j=>j.name==='Synthetic recurring review');check(job,'automatic job persisted from form');
 AgentTransport.requestPlan=async options=>{memoryRequest=options.input;return JSON.stringify({workspace:'科研',message:'自动回顾已完成。',actions:[]});};
 await ProjectAutomation.tick();const completed=(await(await fetch('/__project/jobs')).json()).jobs.find(j=>j.id===job.id);check(completed.status==='completed','automatic job completed: '+JSON.stringify(completed));
 const autoRun=state.agentRuns.find(r=>r.id===completed.attempt.runId);check(autoRun?.automaticAttemptId===completed.attempt.id,'attempt linked to actual run');check(autoRun.projectId===researchProject.id,'automatic run retains project');check(JSON.stringify(memoryRequest).includes('先比较基线'),'automatic run receives approved project memory');
 check(autoRun.memoryNoteIds.length>0,'automatic run updates project daily log');
 await ProjectAutomation.open(researchProject);[...document.querySelectorAll('#projectAutomationDialog section button')].find(b=>b.textContent==='编辑').click();const editForm=document.querySelector('#projectAutomationDialog form');editForm.querySelector('input').value='Synthetic revised review';editForm.querySelector('input[type=datetime-local]').value='2099-01-01T12:00';editForm.requestSubmit();await pickerWait(()=>document.querySelector('#projectAutomationDialog section strong')?.textContent==='Synthetic revised review');document.querySelector('#projectAutomationDialog').close();
 await ProjectAutomation.tick();const future=(await(await fetch('/__project/jobs')).json()).jobs.find(j=>j.id===job.id);check(future.attempt.id===completed.attempt.id,'future edit does not execute immediately');
 await FileContext.request('/__project/jobs/now',{id:job.id});let automaticEntered=false;
 AgentTransport.requestPlan=async options=>{automaticEntered=true;return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(Error('Synthetic automatic pause'),{code:'CANCELLED'})),{once:true}));};
 const automaticPending=ProjectAutomation.tick();await pickerWait(()=>automaticEntered);await FileContext.request('/__project/jobs/pause',{id:job.id});await automaticPending;
 const paused=(await(await fetch('/__project/jobs')).json()).jobs.find(j=>j.id===job.id);check(paused.status==='paused'&&paused.attempt.status==='cancelled','pause stops actual automatic request');check(paused.history.length===1,'previous result retained in history');
}finally{AgentTransport.requestPlan=originalTransport;[$('#apiBase').value,$('#apiKey').value,$('#model').value]=previousInputs;}
// Existing notes and selected Markdown import preserve bodies and relative links.
showView('captures','随记');CaptureNotes.render();
const filterTag=document.querySelectorAll('.capture-filters select')[0],filterDate=document.querySelectorAll('.capture-filters input')[0];
filterDate.value='2099-01-01';filterDate.dispatchEvent(new Event('change'));check(!document.querySelector('.capture-card'),'date filter excludes older captures');filterDate.value='';filterDate.dispatchEvent(new Event('change'));
const filterButtons=[document.querySelector('[data-capture-select-visible]'),document.querySelector('[data-capture-clear-selection]')];filterButtons[1].click();filterButtons[0].click();check(document.querySelectorAll('.capture-card input:checked').length===CaptureNotes.items(state).length,'select visible batch');filterButtons[1].click();check(!document.querySelector('.capture-card input:checked'),'clear batch');
const agendaSource=CaptureNotes.write(state,{text:'2026年9月22日10点至11点讨论实验，上海时区，每周二，共4次，提前15分钟提醒。'},{uid});
newConversation('日常');const agendaChat=currentConversation();agendaChat.modelConfig={provider:'api',model:'synthetic-model',effort:''};FileContext.stage(agendaChat,await FileContext.libraryRef(state,'note',agendaSource.id));
$('#apiBase').value='https://agenda-qa.invalid/v1';$('#apiKey').value='synthetic';$('#model').value='synthetic-model';
AgentTransport.requestPlan=async()=>JSON.stringify({message:'已提出日程，请确认。',actions:[],agendaProposals:[{title:'Synthetic experiment discussion',sourceNoteId:agendaSource.id,quote:agendaSource.content,start:'2026-09-22T10:00:00+08:00',end:'2026-09-22T11:00:00+08:00',timeZone:'Asia/Shanghai',frequency:'weekly',weekdays:[3],count:4,reminderMinutes:15}]});
try{await sendMessage({goal:'根据所选随记提出日程供我审阅。'});check(state.agentRuns.at(-1).status==='completed','agenda Agent loop');check(state.agentRuns.at(-1).agendaProposals?.length===1,'agenda proposal persisted');check(document.querySelector('[data-agenda-proposal]'),'agenda review card');}finally{AgentTransport.requestPlan=originalTransport;[$('#apiBase').value,$('#apiKey').value,$('#model').value]=previousInputs;}
const migrationRun={id:'qa-migration',conversationId:currentConversation().id,projectId:researchProject.id,workspace:'科研',steps:[],status:'completed'};state.agentRuns.push(migrationRun);
executeActions([{type:'create_note',title:'Synthetic legacy note',content:'# Original legacy body\n\nPreserve every line.',kind:'笔记',projectId:researchProject.id,workspace:'科研'}],migrationRun);await saveDocumentDurably();const legacy=state.notes.find(n=>n.title==='Synthetic legacy note');
showView('wiki','科研 Wiki');ResearchWikiUI.render();[...document.querySelectorAll('.wiki-storage button')].find(b=>b.textContent.includes('迁入')).click();await pickerWait(()=>document.querySelector('[data-migrate-note="'+legacy.id+'"]'));
const legacySelect=document.querySelector('[data-migrate-note="'+legacy.id+'"]');legacySelect.checked=true;legacySelect.dispatchEvent(new Event('change'));[...document.querySelectorAll('#wikiMigrationDialog button')].find(b=>b.textContent==='迁入所选笔记').click();await pickerWait(()=>state._wikiFiles[legacy.id]);check(state.notes.find(n=>n.id===legacy.id).content===legacy.content,'migration body and ID preserved');
const transfer=new DataTransfer();transfer.items.add(new File(['# One\n[Two](two.md)\n[PDF](paper.pdf)\n![Pixel](pixel.png)'],'one.md',{type:'text/markdown'}));transfer.items.add(new File(['# Two'],'two.md',{type:'text/markdown'}));transfer.items.add(new File(['%PDF-synthetic'],'paper.pdf',{type:'application/pdf'}));transfer.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),c=>c.charCodeAt(0))],'pixel.png',{type:'image/png'}));const pickerInput=document.querySelector('[data-wiki-import-files]');pickerInput.files=transfer.files;pickerInput.dispatchEvent(new Event('change'));await pickerWait(()=>document.querySelectorAll('#wikiMigrationDialog details').length===2&&!pickerInput.disabled);
[...document.querySelectorAll('#wikiMigrationDialog button')].find(b=>b.textContent==='导入预览中的 Markdown').click();await pickerWait(()=>state.notes.some(n=>n.wikiOriginalName==='two.md'));const one=state.notes.find(n=>n.wikiOriginalName==='one.md'),two=state.notes.find(n=>n.wikiOriginalName==='two.md');check(ResearchWiki.resolveLink(state,one.id,'two.md')===two.id,'imported relative link remains usable');check(one.content==='# One\n[Two](two.md)\n[PDF](paper.pdf)\n![Pixel](pixel.png)','Markdown source unchanged');document.querySelector('#wikiMigrationDialog').close();
check(one.sourceAttachmentIds.length===2,'directory originals linked');await openPreview('note',one.id);const sourceImage=document.querySelector('.wiki-source-image img');check(sourceImage,'directory image rendered');sourceImage.loading='eager';await pickerWait(()=>sourceImage.naturalWidth===1);check(document.querySelector('[data-open-import="'+one.wikiSourceLinks['paper.pdf']+'"]'),'PDF source link rendered');
await WikiExport.open([one.id,two.id]);check(document.querySelectorAll('#wikiExportDialog input[type=checkbox]').length===3,'export selection UI');document.querySelector('#wikiExportDialog').close();
const bundlePreview=await(await fetch('/__wiki/bundle-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[one.id,two.id]})})).json();const bundleResponse=await fetch('/__wiki/bundle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...bundlePreview,includeSources:true})});const bundleBytes=new Uint8Array(await bundleResponse.arrayBuffer());check(bundleResponse.ok&&bundleBytes[0]===80&&bundleBytes[1]===75,'native portable ZIP response');
showView('wiki','科研 Wiki');ResearchWikiUI.render();
save();renderAll();
await window.flushWorkspace();
// WeKnora-inspired inspection uses the same index and source-to-conversation path.
const researchBefore=JSON.stringify(state.notes),researchReport=ResearchInspector.inspect(state);
check(researchReport.counts.notes>0&&researchReport.counts.sources>0,'research inspection scope');
ResearchInspector.openHealth();check(document.querySelector('#researchHealthDialog[open] .research-metric'),'health metrics');document.querySelector('#researchHealthDialog').close();
check(JSON.stringify(state.notes)===researchBefore,'health check cannot rewrite notes');
const linkedResearch=researchReport.edges.find(e=>e.type==='source');check(linkedResearch,'real source relationship');
ResearchInspector.openRelations(linkedResearch.from);check(document.querySelectorAll('#researchRelationsDialog .research-relation-node').length>0,'real relationship navigation');document.querySelector('#researchRelationsDialog').close();
ResearchInspector.openSearch();const lab=document.querySelector('#researchSearchDialog'),labQuery=lab.querySelector('input');labQuery.value='one';lab.querySelector('form').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
await pickerWait(()=>lab.querySelector('.research-result'));check(lab.querySelector('.research-excerpt').textContent.length>0,'actual search text');
[...lab.querySelectorAll('button')].find(b=>b.textContent==='前后证据').click();check(lab.querySelector('.research-neighbors'),'neighbor evidence');
labQuery.value='changed';labQuery.dispatchEvent(new Event('input'));check(!lab.querySelector('.research-result'),'query editing clears stale pagination');
labQuery.value='zzzz_no_research_match';lab.querySelector('form').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));await pickerWait(()=>lab.querySelector('[role=status]').textContent.includes('0 条结果'));lab.close();
ResearchInspector.openSources();const sourceDialog=document.querySelector('#researchSourcesDialog');const sourceFilter=sourceDialog.querySelector('select');sourceFilter.value='all';sourceFilter.dispatchEvent(new Event('change'));const sourceCheckbox=sourceDialog.querySelector('input[type=checkbox]');check(sourceCheckbox,'available research original');sourceCheckbox.click();
const runsBeforeAnalysis=state.agentRuns.length;[...sourceDialog.querySelectorAll('button')].find(b=>b.textContent==='准备分析对话').click();
check(!sourceDialog.open&&currentConversation().draftAttachmentIds.length===1,'source batch prepares actual conversation');check(state.agentRuns.length===runsBeforeAnalysis,'batch preparation does not call a model');
// A later task update must retain a pending plan review, including its prose.
const managedPlan=ProjectMemory.refreshPlan(state,researchProject.id),planApproved=managedPlan.content;
managedPlan.aiDraft={title:managedPlan.title,content:planApproved+'\n## Pending protocol\nKeep the preregistered evaluation criteria.',createdAt:Date.now()};
const planTask=state.tasks.find(t=>t.id===baseTask.id),taskOriginalTitle=planTask.title;planTask.title='Synthetic refreshed plan task';ProjectMemory.refreshPlan(state,researchProject.id);
check(managedPlan.content===planApproved,'plan approved body protected while review pending');
check(managedPlan.aiDraft.content.includes('Keep the preregistered evaluation criteria.')&&managedPlan.aiDraft.content.includes(planTask.title),'plan draft prose and updated index coexist');
await saveDocumentDurably();const persistedPlan=(await(await fetch('/__state')).json()).notes.find(n=>n.id===managedPlan.id);
check(persistedPlan.aiDraft.content.includes('Keep the preregistered evaluation criteria.'),'pending plan persists');
state.tasks.find(t=>t.id===baseTask.id).title=taskOriginalTitle;
// Close original roadmap gaps through actual controls and durable state.
await WikiMerge.open(two.id);const mergeDialog=document.querySelector('#wikiMergeDialog');
const mergeChoice=[...mergeDialog.querySelectorAll('label')].find(n=>n.textContent===one.title);check(mergeChoice,'merge candidate within same scope');mergeChoice.querySelector('input').click();
[...mergeDialog.querySelectorAll('button')].find(b=>b.textContent==='预览合并').click();check(mergeDialog.querySelector('pre').textContent.includes('# One'),'merge preview retains source body');
[...mergeDialog.querySelectorAll('button')].find(b=>b.textContent==='保存合并草稿').click();await pickerWait(()=>state.notes.find(n=>n.id===two.id)?.aiDraft?.origin==='manual-wiki-merge'&&!document.querySelector('#wikiMergeDialog'));
await openPreview('note',two.id);document.querySelector('[data-note-action=apply-ai]').click();document.querySelector('[data-note-action=save]').click();await pickerWait(()=>!state.notes.find(n=>n.id===two.id).aiDraft);await saveDocumentDurably();
const mergedState=await(await fetch('/__state')).json();check(mergedState.notes.find(n=>n.id===two.id).content.includes('# One'),'merged approved body persisted');check(mergedState.notes.find(n=>n.id===one.id).content===one.content,'merge original preserved');check(mergedState.notes.find(n=>n.id===two.id).sourceNoteIds.includes(one.id),'merged source provenance persisted');
openProject(researchProject.id);state.ui.projectTaskView='board';ProjectBoard.render(researchProject.id);const boardCard=document.querySelector('[data-board-task="'+baseTask.id+'"]');check(boardCard,'project board card');[...boardCard.querySelectorAll('button')].find(b=>b.textContent==='移至 已完成').click();await pickerWait(()=>state.tasks.find(n=>n.id===baseTask.id).status==='done');await saveDocumentDurably();check((await(await fetch('/__state')).json()).tasks.find(n=>n.id===baseTask.id).completedAt,'board transition persisted');
const dragCard=document.querySelector('[data-board-task="'+comparisonTask.id+'"]'),dragData=new DataTransfer();dragCard.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dragData}));document.querySelector('[data-board-status=blocked]').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dragData}));await pickerWait(()=>state.tasks.find(n=>n.id===comparisonTask.id).status==='blocked');await saveDocumentDurably();check((await(await fetch('/__state')).json()).tasks.find(n=>n.id===comparisonTask.id).status==='blocked','board drag handler persisted');
$('#agentInput').value='';currentConversation().draft='';currentConversation().draftAttachmentIds=[];
$('#apiBase').value='https://queue-qa.invalid/v1';$('#apiKey').value='synthetic';$('#model').value='synthetic-model';
AgentTransport.requestPlan=async()=>JSON.stringify({workspace:'科研',message:'批次分析已形成有来源笔记。',actions:[{type:'create_note',title:'Synthetic queued evidence',kind:'资料分析',workspace:'科研',projectId:null,content:'# Evidence\n\nThese synthetic documents demonstrate a contrast between diagram evidence and textual claims; further measurements are needed.',sourceAttachmentIds:one.sourceAttachmentIds}]});
try{await ResearchQueue.enqueue(one.sourceAttachmentIds);const queueChat=state.conversations.find(c=>c.researchQueue);check(queueChat,'queue saved');const dialog=document.querySelector('#researchQueueDialog');[...dialog.querySelectorAll('button')].find(b=>b.textContent==='开始 / 继续').click();await pickerWait(()=>state.conversations.find(c=>c.id===queueChat.id).researchQueue.status==='active');await ResearchQueue.tick();const q=state.conversations.find(c=>c.id===queueChat.id).researchQueue;check(q.items[0].runId,'queue actual Agent run retained');check(['completed','review'].includes(q.items[0].status),'queue output: '+JSON.stringify(q));await saveDocumentDurably();check((await(await fetch('/__state')).json()).conversations.find(c=>c.id===queueChat.id).researchQueue.items[0].runId,'queue persistence');document.querySelector('#researchQueueDialog')?.close();}finally{AgentTransport.requestPlan=originalTransport;[$('#apiBase').value,$('#apiKey').value,$('#model').value]=previousInputs;}
const previousLanguage=WorkstationI18n.getLanguage();WorkstationI18n.setLanguage('en');ResearchInspector.openHealth();check(document.querySelector('#researchHealthDialog h2').textContent==='Knowledge checks','English inspection heading');document.querySelector('#researchHealthDialog').close();WorkstationI18n.setLanguage(previousLanguage);
await saveDocumentDurably();await openPreview('note',linkedResearch.from);
const layoutDiagnostic=JSON.stringify({bodyClass:document.body.className,bodyDisplay:getComputedStyle(document.body).display,grid:getComputedStyle(document.body).gridTemplateColumns,variable:document.body.style.getPropertyValue('--workspace-reader-width'),width:innerWidth,main:document.querySelector('.main').getBoundingClientRect().toJSON(),reader:document.querySelector('.reading-pane').getBoundingClientRect().toJSON()});
check(document.querySelector('.reading-pane').getBoundingClientRect().width>=320,'reader geometry while native view is hidden: '+layoutDiagnostic);
if(document.hidden)for(const selector of ['.reading-pane','#previewDialog'])check(getComputedStyle(document.querySelector(selector)).opacity==='1','background reader must be painted: '+selector);
return 'PASS: manual Wiki merge/adoption/provenance, persisted task board transitions, durable source queue through real Agent loop; Wiki checks, real source relationships, local retrieval/neighbor evidence, source batch preparation without model calls, English labels and background reader visibility; existing-note migration and Markdown batch import with relative links; reviewed file-backed project memory, new-chat memory retrieval, automatic task form/claim/Agent/persistence/daily log; concurrent tool scheduling, isolated child model/read loop, persisted child provenance and propagated cancellation; native folder rename/move/archive/restore, real note action capture, diff and source/preview reader switching, typed Wiki creation, scoped list/read/update and draft adoption, capture text/file save, batch AI provenance and original preservation, persisted save, keyboard file picker, note/local references, retry isolation, real local proposal/save/undo, Finder context menu and imported original reveal; isolated synthetic data only.';
