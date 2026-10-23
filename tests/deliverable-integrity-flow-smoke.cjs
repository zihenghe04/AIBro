/* Synthetic AgentTransport response; actual root app, sendMessage, Core,
 * execution checkpoint, FileReview, output/file surfaces and temporary server.
 * Run serially, hidden: electron tests/deliverable-integrity-flow-smoke.cjs
 * This proves application behavior, not real provider quality or native QA. */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), { createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname,'..'), OUT = path.join(ROOT,'test-results/deliverable-integrity-20260930/renderer');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(),'aibro-deliverable-integrity-')), STORE = path.join(TEMP,'store');
const FIXTURE = path.join(ROOT,'tests/fixtures/deliverable-integrity.js');
fs.mkdirSync(STORE); fs.mkdirSync(OUT,{recursive:true});
fs.copyFileSync(FIXTURE,path.join(path.dirname(OUT),'native-fixture-client.js'));
app.setPath('userData',path.join(TEMP,'profile')); app.on('window-all-closed',()=>{});
let win,server,origin,ending=false;
const checks=[],failures=[],observations=[],rendererErrors=[],externalRequests=[],networkModelRequests=[];
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),q=JSON.stringify;
const evaluate=code=>win.webContents.executeJavaScript(code,true);
async function until(fn,label,timeout=18000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await wait(40);}throw Error('Timed out: '+label);}
async function shot(name){if(win&&!win.isDestroyed())fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG());}
async function check(label,fn){try{await fn();checks.push(label);console.log('PASS',label);}catch(error){failures.push({label,error:error.stack});console.error('FAIL',label,error.message);await shot('failure-'+failures.length);try{observations.push({failure:label,state:await evaluate('({runs:state.agentRuns.map(r=>({id:r.id,status:r.status,error:r.error,errorCode:r.errorCode,formatRepairCount:r.formatRepairCount,executionReceipt:r.executionReceipt,results:r.results})),notes:state.notes.map(n=>({id:n.id,title:n.title,content:n.content})),calls:window.__integrityProviderCalls,preview:state.previewRecord})')});}catch(_){}}}
const click=selector=>evaluate(`(()=>{const n=document.querySelector(${q(selector)});if(!n)throw Error('Missing '+${q(selector)});if(n.disabled)throw Error('Disabled '+${q(selector)});n.click()})()`);
async function settle(){await evaluate('saveDocumentDurably()');await evaluate('flushWorkspace()');await until(()=>evaluate('!serverSaveInFlight&&!serverSaveQueued&&!state._pendingLocalSave&&!serverConflict'),'store settled');}
const snapshot=()=>evaluate('(async()=>{const r=await fetch("/__state",{cache:"no-store"});if(!r.ok)throw Error("State read failed");return r.json()})()');
// Failed runs still append the application's existing system audit journal.
// Those explicit system records are asserted separately, never called outputs.
const business=s=>({projects:s.projects,notes:s.notes.filter(note=>!note.projectMemoryType),tasks:s.tasks,papers:s.papers,imports:s.imports.map(({id,name,originalName,content,projectId,workspace,folderPath})=>({id,name,originalName,content,projectId,workspace,...(folderPath===undefined?{}:{folderPath})}))});
const watchdog=setTimeout(()=>{failures.push({label:'watchdog'});void finish(1)},240000);
async function finish(code){
  if(ending)return;ending=true;clearTimeout(watchdog);
  if(win&&!win.isDestroyed()){if(win.webContents.debugger.isAttached())win.webContents.debugger.detach();win.destroy()}
  if(server&&server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(resolve=>server.once('exit',resolve)),wait(2500)])}
  const stopped=!server||server.exitCode!==null||server.signalCode!==null;if(!stopped){failures.push({label:'fixture server did not stop'});code=1}else fs.rmSync(TEMP,{recursive:true,force:true});
  if(!code&&!failures.length)for(const name of fs.readdirSync(OUT))if(/^(?:failure-.*|fatal)\.png$/.test(name))fs.rmSync(path.join(OUT,name));
  const files=['app/app.js','app/workstation-core.js','app/run-checkpoint.js','app/run-outcome-presentation.js','app/file-review.js','app/project-outputs.js','tests/fixtures/deliverable-integrity.js'];
  const sourceHashes=Object.fromEntries(files.map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(ROOT,file))).digest('hex')]));
  fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify({passed:checks.length,checks,failures,observations,rendererErrors,externalRequests,networkModelRequests,externalModelCalls:networkModelRequests.length,userWorkspaceLoaded:false,temporaryProfileRemoved:!fs.existsSync(TEMP),fixtureServerStopped:stopped,sourceHashes,scope:'Synthetic AgentTransport only; real root renderer, send button/sendMessage, Core, execution checkpoint, FileReview, temporary persistent server. No provider credentials read. Not real model generation quality or native WKWebView acceptance.'},null,2));
  console.log(JSON.stringify({passed:checks.length,failures,report:path.join(OUT,'report.json')},null,2));app.exit(code);
}
async function createRenderer(){
  win=new BrowserWindow({show:false,width:1440,height:980,useContentSize:true,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
  win.webContents.on('console-message',event=>{if(event.level==='error'){rendererErrors.push(event.message);console.error('RENDERER',event.message)}});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(request,done)=>{const local=request.url.startsWith(origin+'/'),model=local&&/^\/(?:__proxy|__api|__llm|__models|__codex\/respond)(?:[/?]|$)/.test(new URL(request.url).pathname);if(!local)externalRequests.push(request.url);if(model)networkModelRequests.push(request.url);done({cancel:!local||model})});
  await win.loadURL('about:blank');win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Page.enable');
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:`window.webkit={messageHandlers:{workspace:{postMessage(){}}}};window.addEventListener('DOMContentLoaded',()=>{document.body.classList.add('aibro-native');const s=document.createElement('style');s.textContent=${q(fs.readFileSync(path.join(ROOT,'native/Resources/workspace.css'),'utf8'))};document.head.append(s)});`});
  await win.loadURL(origin);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydrate');
}
async function submit(marker){
  const count=await evaluate('state.agentRuns.length');
  await evaluate(`(()=>{currentConversation().draftAttachmentIds=['integrity-source'];renderStagedAttachments();const input=document.querySelector('#agentInput');input.value=${q('整理这份资料并保存分析笔记 [QA:')}+${q(marker)}+']';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(()=>evaluate('!document.querySelector("#agentSend").disabled'),'send enabled');await click('#agentSend');
  await until(()=>evaluate(`state.agentRuns.length>${count}&&!sendMessage.busy&&!sendMessage.preflight&&!sendMessage.preparingWiki`),'send terminal '+marker,30000);await settle();
  return evaluate('structuredClone(state.agentRuns.at(-1))');
}
async function noteReady(id){await until(()=>evaluate(`ReadingPane.snapshot().visible&&state.previewRecord?.type==='note'&&state.previewRecord.id===${q(id)}&&NoteEditor.inlineActive(${q(id)})&&!!document.querySelector('.document-toolbar-kit [role=radio]:not([disabled])')`),'note open');}
async function readNote(id){
  await noteReady(id);await evaluate(`(()=>{const n=[...document.querySelectorAll('.document-toolbar-kit [role=radio]')].find(n=>n.textContent.trim()==='阅读');if(!n||n.disabled)throw Error('Reading mode unavailable');n.click()})()`);
  await until(()=>evaluate('!!document.querySelector(".note-document-preview [data-document-markdown]")'),'actual Markdown reader');
  return evaluate('NoteEditor.currentContent().content');
}
(async()=>{
  const port=await new Promise(resolve=>{const probe=net.createServer();probe.listen(0,'127.0.0.1',()=>{const value=probe.address().port;probe.close(()=>resolve(value))})});origin='http://127.0.0.1:'+port;
  const log=fs.openSync(path.join(OUT,'server.log'),'w');server=spawn(process.env.PYTHON||'python3',['-B',path.join(ROOT,'app/server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(port),AI_WORKSTATION_DATA_DIR:STORE,PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore',log,log]});fs.closeSync(log);
  await until(()=>new Promise(resolve=>http.get(origin+'/__health',response=>{response.resume();resolve(response.statusCode===200)}).on('error',()=>resolve(false))),'fixture server');
  await app.whenReady();await createRenderer();await evaluate(fs.readFileSync(FIXTURE,'utf8'));await until(()=>evaluate('window.__deliverableIntegrityFixtureReady'),'fixture');await settle();
  const baseline=business(await snapshot());let validId,validRunId,validMessageId,expectedBody;
  for(const marker of ['MISSING-BODY','EMPTY-NOTE','PLACEHOLDER','MIXED-EMPTY'])await check(marker+' final is rejected atomically before any execution checkpoint or empty note',async()=>{
    const run=await submit(marker);observations.push({marker,run:{id:run.id,status:run.status,errorCode:run.errorCode,formatRepairCount:run.formatRepairCount}});
    assert.equal(run.status,'failed');assert.equal(run.errorCode,'INCOMPLETE_ANALYSIS_RESULT');assert.equal(run.formatRepairCount,2);assert.equal(run.executionReceipt,undefined);
    assert.deepEqual(run.results||[],[]);assert.deepEqual(run.fileChanges||[],[]);const disk=await snapshot();assert.deepEqual(business(disk),baseline);
    const system=disk.notes.filter(note=>note.projectMemoryType);assert.deepEqual(system.map(note=>note.projectMemoryType).sort(),['daily','long','plan']);
    assert.ok(system.every(note=>note.projectId==='integrity-project'&&note.id.startsWith('pm_integrity-project_')));
    const journal=system.find(note=>note.projectMemoryType==='daily');assert.ok(journal.memoryRunIds.includes(run.id));assert.ok(journal.content.includes('failed'));assert.ok(journal.content.includes('没有记录到文件或任务写入'));
    observations.push({marker,systemAuditNotes:system.map(note=>({id:note.id,type:note.projectMemoryType})),businessPlanMutations:0});
    const calls=await evaluate(`__integrityProviderCalls.filter(call=>call.runId===${q(run.id)})`);
    // The real AgentContext loads missing operation capabilities and asks for
    // a checked final again; that step is not a format-repair attempt. The
    // kernel allows two consecutive format repairs (kernel-run-loop.js).
    assert.equal(calls.filter(call=>call.formatRepair).length,2,'exactly two consecutive format-repair requests');
    const capabilities=marker==='MIXED-EMPTY'?['knowledge','tasks']:['knowledge'];
    assert.deepEqual(calls.map(call=>({repair:call.formatRepair,capabilities:[...call.loadedCapabilities].sort()})),[
      {repair:false,capabilities:[]},
      {repair:false,capabilities},
      {repair:true,capabilities},
      {repair:true,capabilities},
    ],'initial final, capability protocol expansion, then two consecutive format repairs');
    assert.ok(calls.every(call=>call.marker===marker));
    const result=await evaluate(`(()=>{const c=currentConversation(),m=c.messages.find(m=>[m.runId,m.retryRunId,m.pendingRunId].includes(${q(run.id)}));const n=document.querySelector('[data-message-id="'+m.id+'"]');return {status:m.runStatus,text:m.text,ui:n.textContent};})()`);
    assert.equal(result.status,'failed');assert.match(result.ui,/未完成|失败|没有|未生成|不完整/);assert.doesNotMatch(result.text,/^已完成整理[。！]?$/);
    assert.deepEqual(await evaluate('ProjectOutputs.build({state,projectId:"integrity-project"}).counts'),{all:0,saved:0,review:0});
    if(marker==='MIXED-EMPTY')await shot('rejected-empty-with-actions');
  });
  await check('valid source-linked Markdown reaches actual durable commit with a real note and FileReview snapshot',async()=>{
    const run=await submit('VALID-OUTPUT');expectedBody=await evaluate('__integrityBody');validRunId=run.id;
    assert.equal(run.status,'completed');assert.equal(run.executionReceipt.phase,'committed');
    const disk=await snapshot(),note=disk.notes.find(note=>note.title==='材料分析成果');assert.ok(note);validId=note.id;
    assert.equal(note.content,expectedBody);assert.deepEqual(note.sourceAttachmentIds,['integrity-source']);assert.equal(note.projectId,'integrity-project');
    assert.equal(business(disk).notes.length,baseline.notes.length+1);assert.equal(disk.imports[0].name,'成果验收资料.txt');assert.equal(disk.tasks.length,baseline.tasks.length);
    assert.ok(run.results.some(result=>result.type==='note'&&result.id===validId));
    const change=run.fileChanges.find(change=>change.type==='note'&&change.id===validId);assert.ok(change);assert.equal(change.after.content,expectedBody);
    validMessageId=await evaluate(`currentConversation().messages.find(message=>message.runId===${q(run.id)})?.id`);assert.ok(validMessageId);
    assert.deepEqual(await evaluate('ProjectOutputs.build({state,projectId:"integrity-project"}).counts'),{all:1,saved:1,review:0});
    observations.push({validRunId,validId,validMessageId,contentCharacters:expectedBody.length,syntheticCalls:await evaluate('__integrityProviderCalls')});
  });
  await check('conversation file tree opens the generated body rather than an empty completion claim',async()=>{
    assert.ok(validId,'valid fixture must have committed');
    if(!await evaluate('state.ui.inspectorOpen&&state.ui.inspector==="files"'))await click('#workspaceFilesToggle');
    await until(()=>evaluate('!!document.querySelector("[data-halaska-root=DocumentFiles]")'),'real Kit files');
    const key=JSON.stringify(['note',validId]);
    await evaluate(`(()=>{const n=[...document.querySelectorAll('[data-document-file-key]')].find(n=>n.dataset.documentFileKey===${q(key)});if(!n)throw Error('Output is missing in conversation files');n.click()})()`);
    assert.equal(await readNote(validId),expectedBody);
    assert.match(await evaluate('document.querySelector(".note-document-preview").textContent'),/可核验结论/);
    assert.equal(await evaluate('document.querySelector(".note-document-preview").textContent.includes("只有标题的空文件")'),true);
    await shot('generated-note-from-conversation-files');
  });
  await check('real historical FileReview shows the delivered body and opens its current persisted file',async()=>{
    assert.ok(validRunId);await evaluate(`openPreview('review',${q(validRunId)},${q(validId)})`);
    await until(()=>evaluate(`document.querySelector('[data-review-file][aria-pressed=true]')?.dataset.reviewFile===${q(validId)}`),'real captured change');
    assert.match(await evaluate('document.querySelector(".file-review-content").textContent'),/材料分析成果|可核验结论/);
    assert.equal(await evaluate('!!document.querySelector("[data-halaska-root=ReviewActions]")'),true);
    await evaluate(`(()=>{const n=[...document.querySelectorAll('.review-file-actions button')].find(n=>n.textContent.trim()==='打开当前文件');if(!n)throw Error('Open current file action missing');n.click()})()`);
    assert.equal(await readNote(validId),expectedBody);
  });
  await check('project saved-output card opens the same canonical document with its linked source',async()=>{
    assert.equal(await evaluate('openProject("integrity-project",{section:"outputs"})'),true);
    await until(()=>evaluate(`!!document.querySelector(${q('[aria-label="打开 材料分析成果"]')})`),'real project output');
    await click('[aria-label="打开 材料分析成果"]');assert.equal(await readNote(validId),expectedBody);
    assert.deepEqual(await evaluate(`state.notes.find(n=>n.id===${q(validId)}).sourceAttachmentIds`),['integrity-source']);
    await shot('generated-note-from-project-output');
  });
  await check('fresh renderer without synthetic provider replay retains failed runs and successful source-linked deliverable',async()=>{
    await settle();win.webContents.debugger.detach();win.destroy();await createRenderer();
    assert.equal(await evaluate('typeof __deliverableIntegrityFixtureReady'),'undefined');
    const disk=await snapshot();assert.equal(disk.notes.find(n=>n.id===validId).content,expectedBody);assert.equal(disk.agentRuns.filter(r=>r.status==='failed'&&r.errorCode==='INCOMPLETE_ANALYSIS_RESULT').length,4);
    assert.equal(disk.agentRuns.find(r=>r.id===validRunId).executionReceipt.phase,'committed');
    assert.equal(await evaluate('openProject("integrity-project",{section:"outputs"})'),true);await click('[aria-label="打开 材料分析成果"]');assert.equal(await readNote(validId),expectedBody);
    assert.equal(await evaluate(`state.notes.filter(n=>!String(n.content||'').trim()).length`),0);await shot('persisted-output-after-new-renderer');
  });
  assert.deepEqual(externalRequests,[]);assert.deepEqual(networkModelRequests,[]);await finish(failures.length||rendererErrors.length?1:0);
})().catch(async error=>{failures.push({label:'fatal',error:error.stack});console.error(error);await shot('fatal');await finish(1)});
