/* Production renderer and real local draft service. No model calls or user store. */
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'test-results/project-workspace-20260930/renderer'),TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-project-workspace-')),STORE=path.join(TEMP,'store');
fs.mkdirSync(STORE);fs.mkdirSync(OUT,{recursive:true});app.setPath('userData',path.join(TEMP,'profile'));
let server,win,origin,ending=false;const checks=[],failures=[],rendererErrors=[],wait=ms=>new Promise(r=>setTimeout(r,ms));
const evaluate=code=>win.webContents.executeJavaScript(code,true);
async function until(fn,label){const start=Date.now();while(Date.now()-start<16000){if(await fn())return;await wait(35);}throw Error('Timed out: '+label);}
async function check(label,fn){try{await fn();checks.push(label);console.log('PASS',label);}catch(e){failures.push({label,error:e.stack});console.error('FAIL',label,e.message);}}
const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
async function route(section,id='nav-alpha'){await evaluate(`WorkspaceNavigation.go(${JSON.stringify(section)},${JSON.stringify(id)})`);await until(()=>evaluate(`document.body.dataset.view==='project'&&state.currentProjectId===${JSON.stringify(id)}&&state.ui.projectTab===${JSON.stringify(section)}`),'project section');}
async function shot(name){fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG());}
const watchdog=setTimeout(()=>{failures.push({label:'watchdog'});void finish(1);},180000);app.on('window-all-closed',()=>{});
async function finish(code){if(ending)return;ending=true;clearTimeout(watchdog);win?.destroy();if(server){server.kill();await Promise.race([new Promise(r=>server.once('exit',r)),wait(1000)]);}fs.rmSync(TEMP,{recursive:true,force:true});fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify({passed:checks.length,checks,failures,rendererErrors,modelCalls:0,userWorkspaceLoaded:false,temporaryStoreRemoved:!fs.existsSync(TEMP)},null,2));app.exit(code);}
(async()=>{
 const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});origin='http://127.0.0.1:'+port;
 const log=fs.openSync(path.join(OUT,'server.log'),'w');server=spawn('python3',[path.join(ROOT,'app/server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(port),AI_WORKSTATION_DATA_DIR:STORE,PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore',log,log]});
 await until(()=>new Promise(r=>http.get(origin+'/__health',s=>{s.resume();r(s.statusCode===200)}).on('error',()=>r(false))),'server');await app.whenReady();win=new BrowserWindow({show:false,width:1500,height:980,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(d,cb)=>cb({cancel:!d.url.startsWith(origin+'/')}));win.webContents.on('console-message',e=>{if(e.level==='error'){rendererErrors.push(e.message);console.error('RENDERER',e.message);}});
 await win.loadURL(origin);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydrate');await evaluate(fs.readFileSync(path.join(ROOT,'tests/fixtures/project-workspace-fixture-client.js'),'utf8'));await until(()=>evaluate('window.__projectFixtureReady'),'fixture');
 await check('project tabs share one explicit list and do not auto-create conversations',async()=>{
  await evaluate('openProject("nav-alpha")');assert.equal(await evaluate('state.ui.projectTab'),'conversations');assert.equal(await evaluate('document.querySelector("[data-project-panel=conversations]").hidden'),false);
  const before=await evaluate('state.conversations.length');await route('knowledge');await click('[data-workspace-route=conversations]');await until(()=>evaluate('state.ui.projectTab==="conversations"'),'list');assert.equal(await evaluate('state.conversations.length'),before);
  assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-workspace-route]")].map(n=>n.dataset.workspaceRoute)'),['conversations','knowledge','outputs','tasks','schedule','overview']);assert.ok(await evaluate('!!document.querySelector("#workspaceResumeChat")'));assert.doesNotMatch(await evaluate('document.querySelector("#projectConversations").textContent'),/课程计划/);
 });
 await check('explicit continue returns to the exact thread and retained composer draft',async()=>{
  await click('#workspaceResumeChat');await until(()=>evaluate('document.body.dataset.view==="agent"'),'chat');assert.equal(await evaluate('state.currentConversationId'),'nav-chat-a');assert.equal(await evaluate('document.querySelector("#agentInput").value'),'尚未发送的项目问题');assert.equal(await evaluate('document.querySelector("[data-workspace-route=conversations]").getAttribute("aria-selected")'),'true');
 });
 await check('project A and B independently restore sections across all entry calls',async()=>{
  await route('outputs');await route('tasks','nav-beta');await evaluate('openProject("nav-alpha")');assert.equal(await evaluate('state.ui.projectTab'),'outputs');await evaluate('openProject("nav-beta")');assert.equal(await evaluate('state.ui.projectTab'),'tasks');await evaluate('openProject("nav-alpha",{section:"conversations"})');assert.equal(await evaluate('state.ui.projectTab'),'conversations');
 });
 await check('real output surface separates saved, review and no-file execution without promoting sources',async()=>{
  await route('outputs');assert.deepEqual(await evaluate('ProjectOutputs.build({state,projectId:"nav-alpha"}).counts'),{all:2,saved:1,review:1});const text=await evaluate('document.querySelector("#projectOutputs").textContent');assert.match(text,/文献整理成果/);assert.match(text,/待审阅研究草稿/);assert.doesNotMatch(text,/原始阅读笔记/);assert.equal(await evaluate('ProjectOutputs.build({state,projectId:"nav-alpha"}).completedWithoutOutput'),1);await shot('outputs-light');
 });
 await check('saved output opens its real document and source returns to its actual conversation',async()=>{
  await click('[aria-label="打开 文献整理成果"]');await until(()=>evaluate('ReadingPane.isActive("note","nav-result")'),'result note');assert.match(await evaluate('document.querySelector("#previewContent").textContent'),/Saved synthesis/);await evaluate('ReadingPane.revealWorkspace({force:true})');await click('.project-output-origin button');await until(()=>evaluate('document.body.dataset.view==="agent"'),'source conversation');assert.equal(await evaluate('state.currentConversationId'),'nav-chat-a');
 });
 await check('pending proposal opens real review surface with the proposed content',async()=>{
  await route('outputs');await click('[aria-label="审阅 待审阅研究草稿"]');await until(()=>evaluate('state.previewRecord?.type==="review"'),'review');assert.equal(await evaluate('state.previewRecord.id'),'nav-run-draft');assert.match(await evaluate('document.querySelector("#previewVisual").textContent'),/Proposed revision/);await evaluate('ReadingPane.revealWorkspace({force:true})');
 });
 await check('project switch persists current document draft without saving original',async()=>{
  await evaluate('openPreview("note","nav-result")');await evaluate('[...document.querySelectorAll(".note-document-toolbar-island [role=radio]")].find(n=>n.textContent==="源码").click()');await until(()=>evaluate('!!document.querySelector("#previewContent .cm-content")'),'source editor');await evaluate('document.querySelector("#previewContent .cm-content").focus()');win.webContents.focus();await wait(80);win.webContents.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['meta']});win.webContents.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['meta']});await wait(40);await win.webContents.insertText('# Research output\n\nUnsent working draft.');await until(()=>evaluate('NoteEditor.currentContent()?.content.includes("Unsent working draft")'),'typed');
  await evaluate('openProject("nav-beta")');assert.equal(await evaluate('state.currentProjectId'),'nav-beta');assert.doesNotMatch(await evaluate('state.notes.find(n=>n.id==="nav-result").content'),/Unsent/);await evaluate('openProject("nav-alpha")');await evaluate('openPreview("note","nav-result")');assert.match(await evaluate('NoteEditor.currentContent().content'),/Unsent working draft/);
 });
 await check('failed or superseded route flush leaves actual destination and draft intact',async()=>{
  const result=await evaluate('(async()=>{const original=beforePreviewSwitch;beforePreviewSwitch=async()=>false;try{return {ok:await openProject("nav-beta"),project:state.currentProjectId,text:NoteEditor.currentContent().content};}finally{beforePreviewSwitch=original;}})()');assert.equal(result.ok,false);assert.equal(result.project,'nav-alpha');assert.match(result.text,/Unsent/);
  assert.equal(await evaluate('(async()=>{const original=beforePreviewSwitch;let release;beforePreviewSwitch=()=>new Promise(r=>release=r);try{const pending=openProject("nav-beta");showView("daily");release(true);return await pending;}finally{beforePreviewSwitch=original;}})()'),false);assert.equal(await evaluate('document.body.dataset.view'),'daily');
 });
 await check('project list conversation clicks obey the same draft failure gate as continue',async()=>{
  await route('conversations');await evaluate('window.__oldBeforePreviewSwitch=beforePreviewSwitch;beforePreviewSwitch=async()=>false;true');
  try{await click('#projectConversations [data-open-conversation]');await wait(80);assert.equal(await evaluate('document.body.dataset.view'),'project');}
  finally{await evaluate('beforePreviewSwitch=window.__oldBeforePreviewSwitch;delete window.__oldBeforePreviewSwitch');}
  await click('#projectConversations [data-open-conversation]');await until(()=>evaluate('document.body.dataset.view==="agent"'),'guarded list');assert.equal(await evaluate('state.currentConversationId'),'nav-chat-a');
 });
 await check('restart restores project section memories and protected current document draft',async()=>{
  await evaluate('openProject("nav-alpha",{section:"outputs"})');assert.equal(await evaluate('flushLocalDrafts()'),true);await evaluate('saveDocumentDurably()');await win.reload();await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'reload');await evaluate('openProject("nav-beta")');assert.equal(await evaluate('state.ui.projectTab'),'tasks');await evaluate('openProject("nav-alpha")');assert.equal(await evaluate('state.ui.projectTab'),'outputs');await evaluate('openPreview("note","nav-result")');assert.match(await evaluate('NoteEditor.currentContent()?.content'),/Unsent working draft/);
 });
 await check('output privacy revalidation blocks a retained tab when its recorded origin becomes private',async()=>{
  await route('outputs');await click('[aria-label="打开 文献整理成果"]');await until(()=>evaluate('ReadingPane.isActive("note","nav-result")'),'protected note');assert.ok(await evaluate('state.ui.documentWorkspace.tabs.find(t=>t.id==="nav-result").source.projectOutput'));
  await evaluate('state.conversations.find(c=>c.id==="nav-chat-a").private=true;ReadingPane.reconcile()');assert.equal(await evaluate('ReadingPane.snapshot().tabs.some(t=>t.id==="nav-result")'),false);await evaluate('delete state.conversations.find(c=>c.id==="nav-chat-a").private;renderAll()');
 });
 await check('narrow and dark project output layout keeps controls inside the working surface',async()=>{
  await route('outputs');await evaluate('state.ui.theme="dark";applyUiPreferences()');win.setSize(740,880);await wait(120);assert.equal(await evaluate('(()=>{const r=document.querySelector("#projectOutputs").getBoundingClientRect();return r.width>0&&r.right<=innerWidth+1;})()'),true);await shot('outputs-dark-narrow');
 });
 await check('empty project list offers explicit new chat without silently creating a thread',async()=>{
  const before=await evaluate('state.conversations.length');await evaluate('openProject("nav-empty")');assert.equal(await evaluate('state.ui.projectTab'),'conversations');assert.equal(await evaluate('state.conversations.length'),before);assert.equal(await evaluate('!!document.querySelector("#workspaceResumeChat")'),false);await click('#projectConversationActions button');await until(()=>evaluate('document.body.dataset.view==="agent"&&currentConversation().projectId==="nav-empty"'),'explicit new');assert.equal(await evaluate('state.conversations.length'),before+1);
 });
 await finish(failures.length||rendererErrors.length?1:0);
})().catch(e=>{failures.push({label:'fatal',error:e.stack});console.error(e);void finish(1);});
