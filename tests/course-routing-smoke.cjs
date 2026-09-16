/* Native Electron acceptance against an isolated store and a mocked model transport. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18901,ORIGIN='http://127.0.0.1:'+PORT;
const TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aw-course-routing-smoke-')),STORE=path.join(TEMP,'store');
fs.mkdirSync(path.join(STORE,'files'),{recursive:true});fs.mkdirSync(path.join(TEMP,'profile'));app.setPath('userData',path.join(TEMP,'profile'));
// Keep Electron alive after its window closes until the child service exits
// and the isolated profile/store have both been removed.
app.on('window-all-closed',()=>{});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const request=route=>new Promise((resolve,reject)=>http.get(ORIGIN+route,response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,body:Buffer.concat(chunks)}));}).on('error',reject));
async function until(check,label,timeout=15000){const start=Date.now();while(Date.now()-start<timeout){if(await check())return;await wait(60);}throw Error('Timed out: '+label);}
let server,win,serverLog,finishing=false;const passed=[],failures=[];
const watchdog=setTimeout(()=>{console.error('QA timeout');finish(1);},240000);
async function run(){
 await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',()=>reject(Error('18901 occupied; refusing existing workspace')));probe.listen(PORT,'127.0.0.1',()=>probe.close(resolve));});
 const original='独立验收材料：矩阵可以表示线性变换。';
 for(const id of ['qa-old-source','qa-route-source','qa-stale-source','qa-context-source']){
  fs.writeFileSync(path.join(STORE,'files',id),original);
  fs.writeFileSync(path.join(STORE,'files',id+'.meta.json'),JSON.stringify({name:id+'.txt',mimeType:'text/plain',size:Buffer.byteLength(original)}));
 }
 serverLog=fs.openSync(path.join(TEMP,'server.log'),'a');server=spawn(process.env.PYTHON||'python3',[path.join(ROOT,'server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(PORT),AI_WORKSTATION_DATA_DIR:STORE},stdio:['ignore',serverLog,serverLog]});
 await until(async()=>{if(server.exitCode!==null)throw Error('QA service exited');try{return(await request('/__health')).status===200;}catch{return false;}},'temporary service');
 await app.whenReady();win=new BrowserWindow({show:false,width:1440,height:960,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const errors=[],forbidden=[];
 win.webContents.on('console-message',(_event,level,message)=>{if(level>=3){errors.push(message);console.error('RENDERER',message);}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{
  const url=new URL(details.url),blocked=['http:','https:'].includes(url.protocol)&&(url.origin!==ORIGIN||/^\/__(proxy|codex\/respond)/.test(url.pathname)||/^\/__auth\/(login|logout)/.test(url.pathname)||url.pathname==='/__cloud/connect');
  if(blocked)forbidden.push(details.url);callback({cancel:blocked});
 });
 const evaluate=code=>win.webContents.executeJavaScript(code,true);
 async function settle(){await wait(180);await evaluate('document.getAnimations().forEach(a=>{if(Number.isFinite(a.effect?.getComputedTiming().endTime))try{a.finish();}catch(_){}})');await wait(30);}
 async function click(selector){
  await settle();const point=await evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');if(!e)throw Error("Missing "+'+JSON.stringify(selector)+');e.scrollIntoView({block:"nearest",behavior:"instant"});const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2),hit=document.elementFromPoint(x,y);if(!r.width||!r.height||e.disabled||!(e===hit||e.contains(hit)))throw Error("Hidden/covered "+'+JSON.stringify(selector)+');return{x,y}})()');
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});await wait(100);
 }
 async function input(selector,value){await click(selector);await evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');e.value='+JSON.stringify(value)+';e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}))})()');await wait(60);}
 // Native selects open a platform popup on click; change the selected option
 // through its real change handler so subsequent native button clicks stay visible.
 async function select(selector,value){await evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');if(!e||!e.matches("select")||![...e.options].some(o=>o.value==='+JSON.stringify(value)+'))throw Error("Missing select option");e.value='+JSON.stringify(value)+';e.dispatchEvent(new Event("change",{bubbles:true}))})()');}
 async function step(label,fn){try{await fn();passed.push(label);console.log('PASS',label);}catch(error){failures.push({label,error:error.stack});console.error('FAIL',label,error.message);}}
 const settleSave=async()=>{await evaluate('flushWorkspace()');await until(()=>evaluate('!serverSaveInFlight&&!serverSaveQueued&&!state._pendingLocalSave'),'saved fixture');};
 const domain=()=>evaluate('JSON.stringify({projects:state.projects,tasks:state.tasks,notes:state.notes,imports:state.imports,papers:state.papers,links:state.links})');
 const stored=async()=>JSON.parse((await request('/__state')).body);
 await win.loadURL(ORIGIN);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydration');
 const now=Date.now(),oldId='qa-old-course',holdId='qa-hold-course',mainId='qa-main-conversation',sourceId='qa-route-source',newName='人工智能基础数学理论和算法';
 const material=(id,projectId=null)=>({id,name:id+'.txt',originalName:id+'.txt',mimeType:'text/plain',size:Buffer.byteLength(original),content:original,projectId,project:projectId===oldId?'人工智能：原理模型与算法':null,workspace:'课程',folderPath:'原始资料',analysis:{status:'pending'},importOrigin:'conversation',createdAt:now,updatedAt:now});
 const conversation=(id,attachmentId,projectId=null)=>({id,title:id,workspace:'课程',projectId,permissionMode:'full',modelConfig:{provider:'api',model:'isolated-model',effort:'medium'},attachments:[attachmentId],draftAttachmentIds:[attachmentId],draft:'',messages:[],createdAt:now,updatedAt:now});
 const fixture={projects:[{id:oldId,name:'人工智能：原理模型与算法',workspace:'课程',createdAt:now},{id:holdId,name:'另一独立课程',workspace:'课程',createdAt:now}],papers:[],trash:[],agentRuns:[],links:[],attachments:[],
  imports:[material('qa-old-source',oldId),material(sourceId),material('qa-stale-source'),material('qa-context-source')],
  notes:[{id:'qa-old-note',title:'旧课程原笔记',content:'保留原课程笔记，不属于此次矩阵课件。',projectId:oldId,project:'人工智能：原理模型与算法',workspace:'课程',sourceAttachmentIds:['qa-old-source'],createdAt:now}],
  tasks:[{id:'qa-old-task',title:'旧课程原任务',projectId:oldId,project:'人工智能：原理模型与算法',workspace:'课程',status:'todo',priority:'medium',sourceAttachmentIds:['qa-old-source'],createdAt:now}],
  conversations:[conversation(mainId,sourceId),conversation('qa-stale-conversation','qa-stale-source'),conversation('qa-context-conversation','qa-context-source'),{...conversation('qa-old-conversation','qa-old-source',oldId),draftAttachmentIds:[]}],currentConversationId:mainId};
 await evaluate('Object.assign(state,'+JSON.stringify(fixture)+');normalizeStateShape(state);repairRelationships();state.ui.theme="light";state.ui.inspectorOpen=false;state.settings.permissions={日常:"auto",课程:"auto",科研:"auto"};save();applyUiPreferences();showView("agent","持续对话");renderAll()');
 await settleSave();assert.equal(await evaluate('!!window.CourseRouting'),true,'routing module loaded in actual page');
 const keepBefore=await evaluate('JSON.stringify([state.imports.find(x=>x.id==="qa-old-source"),state.notes.find(x=>x.id==="qa-old-note"),state.tasks.find(x=>x.id==="qa-old-task")])');
 await evaluate('$("#apiBase").value="https://isolated-fixture.invalid/v1";$("#apiKey").value="QA_FAKE_API_TOKEN";window.__qaRequests=[];ConversationModels.resolve=async config=>({...config});AgentTransport.requestPlan=options=>{__qaRequests.push({provider:options.provider,input:options.input});return new Promise((resolve,reject)=>{window.__qaPending={resolve,reject};options.signal?.addEventListener("abort",()=>{const e=new Error("验收取消");e.code="CANCELLED";reject(e)},{once:true})})};true');
 const actions=(id,suffix)=>[
  {type:'rename_attachment',attachmentId:id,newName:'矩阵第一章_'+suffix+'.txt'},
  {type:'create_knowledge_item',title:'矩阵分析_'+suffix,kind:'课程分析',content:'矩阵表示线性变换，对比核空间与列空间可以分析方程的解结构。应把定义、条件和例子关联起来，逐步检验结论。',workspace:'课程',projectId:oldId,sourceAttachmentIds:[id]},
  {type:'create_task',title:'复习矩阵_'+suffix,description:'比较线性变换的核空间与列空间。',workspace:'课程',projectId:oldId,status:'todo',priority:'medium',dueAt:null,sourceAttachmentIds:[id]}
 ];
 async function sendPending(cid,id,suffix){
  await evaluate('ReadingPane.hide();openConversation('+JSON.stringify(cid)+');true');await input('#agentInput','请分析这份课件，整理知识点和复习任务。');
  const count=await evaluate('__qaRequests.length');await click('#agentSend');await until(()=>evaluate('__qaRequests.length>'+count),'mock transport intercepted');
  await evaluate('__qaPending.resolve('+JSON.stringify(JSON.stringify({workspace:'课程',message:'拟整理课件内容。',actions:actions(id,suffix)}))+');true');await until(()=>evaluate('!sendMessage.busy'),'pending course review');
  return evaluate('state.agentRuns.at(-1)');
 }
 async function approve(run){await click('[data-approve-run="'+run.id+'"]');await until(()=>evaluate('state.agentRuns.find(x=>x.id==='+JSON.stringify(run.id)+').status!=="awaiting-approval"'),'review decision');return evaluate('state.agentRuns.find(x=>x.id==='+JSON.stringify(run.id)+')');}
 async function moveMaterial(id,{newProjectName,projectId}){
  await evaluate('openImport('+JSON.stringify(id)+')');await until(()=>evaluate('state.previewImportId==='+JSON.stringify(id)+'&&!$("#previewOrganize").hidden'),'material reader');await click('#previewOrganize');
  await select('#assignWorkspaceInput','课程');if(newProjectName)await input('#assignNewProjectInput',newProjectName);else await select('#assignProjectInput',projectId);
  await click('#assignSubmit');await until(()=>evaluate('!$("#assignDialog").open'),'material move');
 }
 async function bindConversation(cid,projectId){await evaluate('ReadingPane.hide();openConversation('+JSON.stringify(cid)+');true');await click('#chatContextBtn');await select('#contextWorkspace','课程');await select('#contextProject',projectId);await click('#saveContext');await until(()=>evaluate('!$("#contextDialog").open'),'scope applied');}
 let firstRun,noteId,taskId,newId,historyBefore;
 await step('unbound full-permission course materials require routing review with zero domain writes',async()=>{
  const before=await domain();firstRun=await sendPending(mainId,sourceId,'first');assert.equal(firstRun.status,'awaiting-approval');assert.equal(firstRun.permissionMode,'full');assert.equal(firstRun.routingReview.required,true);
  assert.equal(await domain(),before);assert.match(await evaluate('document.querySelector('+JSON.stringify('[data-approve-run="'+firstRun.id+'"]')+').textContent'),/确认归属并执行/);assert.equal(await evaluate('document.querySelector('+JSON.stringify('[data-reject-run="'+firstRun.id+'"]')+').textContent'),'暂不归入');
  await settleSave();const disk=await stored();assert.equal(disk.imports.find(x=>x.id===sourceId).name,sourceId+'.txt');assert.equal(disk.imports.find(x=>x.id===sourceId).projectId,null);assert.equal(disk.notes.length,1);assert.equal(disk.tasks.length,1);
 });
 await step('native confirmation commits the whole reviewed plan once and preserves unrelated original course data',async()=>{
  const run=await approve(firstRun);assert.equal(run.status,'completed');assert.equal(run.mode,'ai');const owned=await evaluate('({source:state.imports.find(x=>x.id==='+JSON.stringify(sourceId)+'),notes:state.notes.filter(x=>x.agentRunId==='+JSON.stringify(run.id)+'),tasks:state.tasks.filter(x=>x.agentRunId==='+JSON.stringify(run.id)+')})');
  assert.equal(owned.source.name,'矩阵第一章_first.txt');assert.equal(owned.source.projectId,oldId);assert.equal(owned.notes.length,1);assert.equal(owned.tasks.length,1);noteId=owned.notes[0].id;taskId=owned.tasks[0].id;assert.equal(owned.notes[0].projectId,oldId);assert.equal(owned.tasks[0].projectId,oldId);assert.equal(await evaluate('currentConversation().projectId'),oldId);
  await settleSave();const disk=await stored();assert.equal(disk.imports.find(x=>x.id===sourceId).projectId,oldId);assert.equal(disk.notes.filter(x=>x.id===noteId).length,1);assert.equal(disk.tasks.filter(x=>x.id===taskId).length,1);
  historyBefore=await evaluate('JSON.stringify({run:state.agentRuns.find(x=>x.id==='+JSON.stringify(run.id)+').results,messages:state.conversations.find(x=>x.id==='+JSON.stringify(mainId)+').messages.map(m=>m.results||null)})');
  assert.equal(await evaluate('JSON.stringify([state.imports.find(x=>x.id==="qa-old-source"),state.notes.find(x=>x.id==="qa-old-note"),state.tasks.find(x=>x.id==="qa-old-task")])'),keepBefore);
 });
 await step('moving an attachment during review rejects the stale confirmation without applying any planned mutation',async()=>{
  const run=await sendPending('qa-stale-conversation','qa-stale-source','stale-source');assert.equal(run.status,'awaiting-approval');await moveMaterial('qa-stale-source',{projectId:holdId});
  await evaluate('ReadingPane.hide();openConversation("qa-stale-conversation");true');const before=await domain(),done=await approve(run);assert.equal(done.status,'cancelled');assert.match(done.error,/归属已变化/);assert.equal(await domain(),before);assert.equal(await evaluate('state.imports.find(x=>x.id==="qa-stale-source").projectId'),holdId);assert.equal(await evaluate('state.notes.some(x=>x.title==="矩阵分析_stale-source")'),false);
 });
 await step('changing conversation scope during review rejects the stale confirmation and keeps the chosen scope',async()=>{
  const run=await sendPending('qa-context-conversation','qa-context-source','stale-context');assert.equal(run.status,'awaiting-approval');await bindConversation('qa-context-conversation',holdId);const before=await domain(),done=await approve(run);
  assert.equal(done.status,'cancelled');assert.match(done.error,/归属已变化/);assert.equal(await domain(),before);assert.equal(await evaluate('currentConversation().projectId'),holdId);assert.equal(await evaluate('state.imports.find(x=>x.id==="qa-context-source").projectId'),null);
 });
 await step('the real move and scope forms cascade only source-linked results and update both result heading and project conversations',async()=>{
  await moveMaterial(sourceId,{newProjectName:newName});newId=await evaluate('state.projects.find(x=>x.name==='+JSON.stringify(newName)+').id');
  const moved=await evaluate('({source:state.imports.find(x=>x.id==='+JSON.stringify(sourceId)+'),note:state.notes.find(x=>x.id==='+JSON.stringify(noteId)+'),task:state.tasks.find(x=>x.id==='+JSON.stringify(taskId)+')})');
  for(const item of Object.values(moved)){assert.equal(item.projectId,newId);assert.equal(item.project,newName);assert.equal(item.workspace,'课程');}assert.deepEqual(moved.note.sourceAttachmentIds,[sourceId]);assert.deepEqual(moved.task.sourceAttachmentIds,[sourceId]);assert.equal(moved.task.status,'todo');
  assert.match(await evaluate('$("#previewMeta").textContent'),new RegExp(newName));assert.doesNotMatch(await evaluate('$("#previewMeta").textContent'),/人工智能：原理模型与算法/);
  await bindConversation(mainId,newId);assert.match(await evaluate('$("#messageList .message-result-heading").textContent'),new RegExp(newName));assert.doesNotMatch(await evaluate('$("#messageList .message-result-heading").textContent'),/原理模型与算法/);
  assert.equal(await evaluate('JSON.stringify({run:state.agentRuns.find(x=>x.id==='+JSON.stringify(firstRun.id)+').results,messages:state.conversations.find(x=>x.id==='+JSON.stringify(mainId)+').messages.map(m=>m.results||null)})'),historyBefore,'historical results are not rewritten');
  await evaluate('openProject('+JSON.stringify(oldId)+')');assert.equal(await evaluate('!!$("#projectConversations [data-open-conversation=\\"'+mainId+'\\"]")'),false);assert.equal(await evaluate('!!$("#projectConversations [data-open-conversation=\\"qa-old-conversation\\"]")'),true);
  await evaluate('openProject('+JSON.stringify(newId)+')');assert.equal(await evaluate('!!$("#projectConversations [data-open-conversation=\\"'+mainId+'\\"]")'),true);
  assert.equal(await evaluate('JSON.stringify([state.imports.find(x=>x.id==="qa-old-source"),state.notes.find(x=>x.id==="qa-old-note"),state.tasks.find(x=>x.id==="qa-old-task")])'),keepBefore);
 });
 await step('reload preserves corrected ownership and original bytes with no model, external request or renderer error',async()=>{
  assert.ok(newId);await settleSave();const disk=await stored();for(const [key,id]of[['imports',sourceId],['notes',noteId],['tasks',taskId],['conversations',mainId]])assert.equal(disk[key].find(x=>x.id===id).projectId,newId);
  assert.deepEqual(['imports','notes','tasks'].map(key=>disk[key].filter(x=>x.projectId===oldId).length),[1,1,1]);
  await win.loadURL(ORIGIN);await until(()=>evaluate('storageHydrated'),'reloaded corrected state');assert.equal(await evaluate('state.conversations.find(x=>x.id==='+JSON.stringify(mainId)+').projectId'),newId);await evaluate('openConversation('+JSON.stringify(mainId)+')');assert.match(await evaluate('$("#messageList .message-result-heading").textContent'),new RegExp(newName));
  assert.equal((await request('/__files/'+sourceId)).body.toString(),original);assert.equal((await request('/__files/qa-old-source')).body.toString(),original);assert.deepEqual(errors,[]);assert.deepEqual(forbidden,[]);
 });
 await settleSave();console.log(JSON.stringify({passed:passed.length,failed:failures.length,failures},null,2));assert.equal(failures.length,0,'Acceptance failures');
}
run().then(()=>finish(0)).catch(error=>{console.error(error.stack);finish(1);});
async function finish(code){
 if(finishing)return;finishing=true;clearTimeout(watchdog);
 try{win?.destroy();}catch{}
 try{if(server&&server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(resolve=>server.once('exit',resolve)),wait(2500)]);if(server.exitCode===null){server.kill('SIGKILL');await wait(100);}}}catch{}
 try{if(serverLog!==undefined)fs.closeSync(serverLog);}catch{}
 // Chromium may write Preferences/cache during app.exit, after an in-process
 // rm has finished. Remove only this mkdtemp directory once Electron exits.
 const cleanup = spawn(process.env.PYTHON||'python3',['-c',
  'import os,shutil,sys,time\nroot,pid=sys.argv[1],int(sys.argv[2])\nfor _ in range(200):\n try: os.kill(pid,0)\n except ProcessLookupError: break\n time.sleep(.05)\nelse: raise RuntimeError("Electron did not exit; fixture retained")\nshutil.rmtree(root)\nassert not os.path.exists(root)\nprint("Temporary store/profile removed: true",flush=True)',TEMP,String(process.pid)],
  {stdio:['ignore','inherit','inherit'],detached:true});
 await new Promise(resolve=>{cleanup.once('spawn',resolve);cleanup.once('error',error=>{console.error('Temporary fixture cleanup failed:',error.message);code=1;resolve();});});
 cleanup.unref();
 app.exit(code);
}
