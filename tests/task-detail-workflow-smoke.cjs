/* Production task detail island + temporary local server. Run serially after
 * build:ui; no build, real workspace, provider, SSH or external requests.
 * Native stylesheet is exercised in Chromium, not a WKWebView acceptance claim.
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), { createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results/task-detail-agenda-20261001');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-task-detail-'));
const STORE = path.join(TEMP, 'store');
fs.mkdirSync(STORE); fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', path.join(TEMP, 'profile')); app.on('window-all-closed', () => {});
let server, win, origin, ending = false;
const checks = [], failures = [], observations = [], rendererErrors = [], externalRequests = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = async source => {
  // Compile the generated source before shipping it to the renderer so a test
  // fixture syntax error is distinguishable from a production runtime failure.
  new (require('node:vm').Script)(source, { filename: 'task-detail-renderer-evaluation.js' });
  const errorCount = rendererErrors.length;
  try { return await win.webContents.executeJavaScript(source, true); }
  catch (error) {
    const details = rendererErrors.slice(errorCount).join('\n');
    error.message += details ? '\nRenderer: ' + details : '';
    error.stack += details ? '\nRenderer: ' + details : '';
    throw error;
  }
};
const quote = JSON.stringify;
const watchdog = setTimeout(() => { failures.push({ name: 'watchdog', error: '180 second deadline' }); void finish(1); }, 180000);
async function until(predicate, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (await predicate()) return; await wait(50); }
  throw Error('Timeout: ' + label);
}
async function paint() { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); }
async function click(selector) {
  const point = await evaluate(`(()=>{const n=document.querySelector(${quote(selector)});if(!n)throw Error('Missing '+${quote(selector)});n.scrollIntoView({block:'center',behavior:'instant'});const r=n.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=document.elementFromPoint(x,y);if(n.disabled||!r.width||!r.height||!(n===hit||n.contains(hit)))throw Error('Covered or disabled '+${quote(selector)});return {x,y};})()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await paint();
}
async function input(selector, value) {
  await evaluate(`(()=>{const n=document.querySelector(${quote(selector)});if(!n||n.disabled)throw Error('Unavailable input '+${quote(selector)});const proto=n.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(n,${quote(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`); await paint();
}
async function choice(selector, value) {
  await evaluate(`(()=>{const n=document.querySelector(${quote(selector)});if(!n||n.disabled)throw Error('Unavailable select');n.value=${quote(value)};n.dispatchEvent(new Event('change',{bubbles:true}));})()`); await paint();
}
async function screenshot(name) { await paint(); fs.writeFileSync(path.join(OUT, 'task-detail-' + name + '.png'), (await win.webContents.capturePage()).toPNG()); }
function disk() { const value = JSON.parse(fs.readFileSync(path.join(STORE, 'workspace.json'), 'utf8')); return value.state || value; }
function diskTask(id = 'detail-a') { return disk().tasks.find(task => task.id === id); }
async function check(name, action) {
  if (process.env.AIBRO_RENDERER_CHECK && !new RegExp(process.env.AIBRO_RENDERER_CHECK).test(name)) return;
  try { await action(); checks.push(name); console.log('PASS', name); }
  catch (error) { failures.push({ name, error: error.stack }); console.error('FAIL', name, error.message); await screenshot('failure-' + failures.length); }
}
async function finish(code) {
  if (ending) return; ending = true; clearTimeout(watchdog);
  if (win && !win.isDestroyed()) { if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach(); win.destroy(); }
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM'); await Promise.race([new Promise(resolve => server.once('exit', resolve)), wait(1500)]);
    if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await Promise.race([new Promise(resolve => server.once('exit', resolve)), wait(500)]); }
  }
  const stopped = !server || server.exitCode !== null || server.signalCode !== null;
  if (stopped) fs.rmSync(TEMP, { recursive: true, force: true }); else { code = 1; failures.push({ name: 'fixture server shutdown' }); }
  const hashes = Object.fromEntries(['app/app.js','app/halaska-ui.js','app/ui/task-detail.jsx','app/ui/task-detail.css','native/Resources/workspace.css'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(ROOT,file))).digest('hex')]));
  fs.writeFileSync(path.join(OUT, 'task-detail-renderer-report.json'), JSON.stringify({ passed: checks.length, checks, failures, observations, rendererErrors, externalRequests, sourceHashes: hashes,
    scope: 'Actual production TaskDetailSurface and local server persistence. Real pointer controls, controlled-input events, negative persistence/ownership seams, retained reader routes, theme/narrow layout and renderer composition events.',
    exclusions: 'No native WKWebView/AX/VoiceOver acceptance, OS IME candidate input, performance benchmark, model, SSH, external library showcase or formal user data.',
    userWorkspaceLoaded: false, fixtureServerStopped: stopped, temporaryWorkspaceRemoved: !fs.existsSync(TEMP), origin }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: checks.length, failures, report: path.join(OUT,'task-detail-renderer-report.json') })); app.exit(code);
}
async function fixture() {
  await evaluate(`(async()=>{
    saveDocumentDurably=window.detailOriginalSave;
    if(document.querySelector('#taskDialog').open)document.querySelector('#taskDialog').close();
    taskEditorContexts.clear();taskEditorIntent++;state.openTaskId=null;
    if(ReadingPane.snapshot().visible)await ReadingPane.hide({restoreFocus:false});
    state.projects=[{id:'detail-project',name:'合成验收项目',workspace:'日常'},{id:'other-project',name:'第二项目',workspace:'日常'},{id:'private-project',name:'PRIVATE_PROJECT_NEVER',workspace:'日常',private:true}];
    state.tasks=[{id:'detail-a',title:'原始任务甲',description:'原始说明',projectId:'detail-project',workspace:'日常',status:'todo',priority:'medium',dueAt:'2026-10-01',checklist:[{text:'原始检查项',done:false}],sourceAttachmentIds:['detail-source','private-source'],sourceNoteIds:['detail-note','private-note']},
      {id:'detail-b',title:'原始任务乙',projectId:'other-project',workspace:'日常',status:'todo',priority:'low',checklist:[]},
      {id:'prerequisite',title:'同项目前置任务',projectId:'detail-project',workspace:'日常',status:'done',checklist:[]},
      {id:'private-task',title:'PRIVATE_TASK_NEVER',projectId:'detail-project',workspace:'日常',private:true,status:'todo',checklist:[]}];
    state.notes=[{id:'detail-note',title:'合成关联笔记',projectId:'detail-project',workspace:'日常',kind:'note',content:${quote('# 合成材料\n\n只读原文不得被任务编辑改写。')},sourceAttachmentIds:['detail-source']},
      {id:'private-note',title:'PRIVATE_NOTE_NEVER',projectId:'detail-project',workspace:'日常',content:'Private',sourceAttachmentIds:['detail-source'],private:true}];
    state.imports=[{id:'detail-source',name:'合成源文件.txt',projectId:'detail-project',workspace:'日常',mimeType:'text/plain',status:'parsed',parser:'text',content:'A local synthetic source.'},
      {id:'private-source',name:'PRIVATE_SOURCE_NEVER',projectId:'detail-project',workspace:'日常',mimeType:'text/plain',status:'parsed',content:'Private',private:true}];
    state.conversations=[{id:'detail-chat',title:'保留草稿会话',projectId:'detail-project',workspace:'日常',messages:[],attachments:[],draftAttachmentIds:[],draft:'保留会话草稿'}];
    state.currentConversationId='detail-chat';state.currentProjectId='detail-project';state.papers=[];state.links=[];state.trash=[];state.attachments=[];state.agentRuns=[];
    normalizeStateShape(state);repairRelationships();state.ui.theme='light';state.settings.reduceMotion=true;applyUiPreferences();renderAll();
    if(await saveDocumentDurably()!==true)throw Error('Fixture did not save');await flushWorkspace();
    if(await WorkspaceNavigation.go('tasks','detail-project')!==true)throw Error('Fixture project route');
  })()`); await until(() => evaluate('!serverSaveInFlight&&!serverSaveQueued&&!state._pendingLocalSave&&!serverConflict'), 'fixture persisted'); await paint();
}
async function open(id = 'detail-a') {
  assert.equal(await evaluate(`openTask(${quote(id)},{origin:{view:'project',projectId:'detail-project',section:'tasks'}})`), true); await paint();
}
async function add(text) { await input('#newChecklistItem',text); await click('#addChecklistItem'); }
async function finishDiscard() {
  if (await evaluate(`!!document.querySelector('#taskDiscardChanges')`)) await click('#taskDiscardChanges');
  await until(() => evaluate(`!document.querySelector('#taskDialog').open`), 'task form closed');
}
async function cancel() { await click('#cancelTask'); await finishDiscard(); }
async function run() {
  const port=await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',reject);probe.listen(0,'127.0.0.1',()=>{const value=probe.address().port;probe.close(()=>resolve(value));});}); origin='http://127.0.0.1:'+port;
  const log=fs.openSync(path.join(OUT,'task-detail-renderer-server.log'),'w'); server=spawn('python3',[path.join(ROOT,'app/server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(port),AI_WORKSTATION_DATA_DIR:STORE},stdio:['ignore',log,log]});fs.closeSync(log);
  await until(()=>new Promise(resolve=>http.get(origin+'/__health',response=>{response.resume();resolve(response.statusCode===200);}).on('error',()=>resolve(false))),'isolated server');
  await app.whenReady();win=new BrowserWindow({show:false,width:1280,height:920,useContentSize:true,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(request,done)=>{const url=new URL(request.url),allowed=url.origin===origin&&!/^\/__(?:proxy|api|llm|models|codex\/respond|cloud\/connect|auth\/(?!status(?:$|\?)|models\?(?:[^#]*&)?cacheonly)|local\/)/.test(url.pathname+url.search);if(!allowed)externalRequests.push(request.url);done({cancel:!allowed});});
  win.webContents.on('console-message',event=>{if(event.level==='error')rendererErrors.push(event.message);});
  // Create the renderer before asking CDP to enable Page; a never-navigated
  // hidden BrowserWindow can otherwise wait indefinitely for its first target.
  await win.loadURL('about:blank');
  win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Page.enable');
  // A hidden renderer suppresses focusin/focusout. Emulate page activation
  // while keeping this isolated renderer from stealing the user's desktop.
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:`window.webkit={messageHandlers:{workspace:{postMessage(){}}}};window.addEventListener('DOMContentLoaded',()=>{document.body.classList.add('aibro-native');const s=document.createElement('style');s.textContent=${quote(fs.readFileSync(path.join(ROOT,'native/Resources/workspace.css'),'utf8'))};document.head.append(s);});`});
  await win.loadURL(origin);await until(()=>evaluate(`typeof storageHydrated!=='undefined'&&storageHydrated`),'hydration');
  assert.equal(await evaluate(`HalaskaUI.componentNames.includes('TaskDetailSurface')`),true);
  await evaluate(`(()=>{WorkstationOnboarding.close();WorkspaceTour.close();state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};state.ui.workspaceTour={version:WorkspaceTour.VERSION,status:'skipped'};window.detailOriginalSave=saveDocumentDurably;const originalApi=HalaskaUI;window.HalaskaUI={...originalApi,mount(host,name,props){if(name==='TaskDetailSurface')window.detailLatestProps=props;return originalApi.mount(host,name,props);}};})()`);
  await check('real Kit task island shows primary fields and checklist; secondary properties and private sources are absent from default composition',async()=>{
    await fixture();await open();
    const view=await evaluate(`(()=>{const host=document.querySelector('#taskDialogBody');return {kit:host.dataset.halaskaRoot,groups:[...host.querySelectorAll('details')].map(n=>[n.dataset.taskGroup,n.open]),labels:[...host.querySelectorAll('input,textarea,select')].filter(n=>n.getClientRects().length).map(n=>n.id),text:host.textContent,projects:[...document.querySelector('#taskProjectInput').options].map(n=>n.value),saveType:document.querySelector('#saveTask').type,checkbox:document.querySelector('#taskCheck-0').type};})()`);observations.push(view);
    assert.equal(view.kit,'TaskDetailSurface');assert.ok(view.labels.includes('taskTitleInput')&&view.labels.includes('taskDescriptionInput')&&view.labels.includes('taskStatusInput'));assert.deepEqual(view.groups,[['properties',false],['completion',false],['sources',false]]);assert.deepEqual(view.projects,['','detail-project','other-project']);assert.equal(view.saveType,'submit');assert.equal(view.checkbox,'checkbox');assert.doesNotMatch(view.text,/PRIVATE_(?:NOTE|TASK|SOURCE|PROJECT)_NEVER/);await screenshot('primary-light');
  });
  await check('checklist toggle add remove and cancelled or Escaped editing never publish to memory or disk',async()=>{
    for(const route of ['close','escape']){
      await fixture();await open();const before=diskTask();await add('取消前新增项');await click('#taskCheck-0');await click('[data-check-index="1"] button');
      assert.deepEqual(await evaluate(`state.tasks.find(t=>t.id==='detail-a').checklist`),before.checklist);assert.equal(await evaluate(`taskEditorHasDrafts()`),true);
      if(route==='close')await click('#cancelTask');else {win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await paint();}
      assert.equal(await evaluate(`document.querySelector('#taskDialog').open&&!!document.querySelector('[role=alertdialog] #taskDiscardTitle')`),true);assert.deepEqual(diskTask(),before);
      if(route==='close') { await click('#taskContinueEditing');assert.equal(await evaluate(`document.querySelector('#taskCheck-0').checked`),true);assert.equal(await evaluate(`document.querySelector('#taskDialog').open&&document.activeElement.id==='cancelTask'`),true);await click('#cancelTask'); }
      await finishDiscard();assert.equal(await evaluate(`document.querySelector('#taskDialog').open`),false);assert.deepEqual(diskTask(),before);await open();assert.deepEqual(await evaluate(`WorkstationTaskDetail.handle.capture().checklist`),before.checklist);await cancel();
    }
  });
  await check('task and checklist save share a pending receipt; close duplicate save and keyboard Escape are blocked until durable disk save',async()=>{
    await fixture();await open();await input('#taskTitleInput','一次保存的任务与清单');await add('一起保存的步骤');await click('#taskCheck-0');
    await evaluate(`window.detailSaveCalls=0;saveDocumentDurably=()=>{detailSaveCalls++;return new Promise(resolve=>window.detailReleaseSave=async()=>resolve(await detailOriginalSave()));};void 0`);
    await click('#saveTask');await until(()=>evaluate('!!saveTaskDetails.busy'),'pending receipt');
    assert.equal(await evaluate(`document.querySelector('#taskDialog').open`),true);assert.equal(await evaluate(`[...document.querySelectorAll('#taskDialog button,#taskDialog input,#taskDialog select,#taskDialog textarea')].every(n=>n.disabled)`),true);
    assert.equal(await evaluate(`saveTaskDetails()`),false);assert.equal(await evaluate(`(()=>{const e=new Event('cancel',{cancelable:true});document.querySelector('#taskDialog').dispatchEvent(e);return e.defaultPrevented;})()`),true);assert.equal(diskTask().title,'原始任务甲');assert.equal(await evaluate('detailSaveCalls'),1);
    await evaluate(`detailReleaseSave()`);await until(()=>evaluate(`!saveTaskDetails.busy&&!document.querySelector('#taskDialog').open`),'real durable receipt');
    assert.equal(diskTask().title,'一次保存的任务与清单');assert.deepEqual(diskTask().checklist,[{text:'原始检查项',done:true},{text:'一起保存的步骤',done:false}]);
  });
  await check('failed durable receipt rolls back task and checklist, preserves controlled draft, and explicit retry writes once',async()=>{
    await fixture();await open();const before=diskTask();await input('#taskDescriptionInput','失败后保留的说明');await add('失败后保留的检查项');await evaluate(`saveDocumentDurably=async()=>false;void 0`);await click('#saveTask');await until(()=>evaluate('!saveTaskDetails.busy'),'failure resolved');
    assert.deepEqual(await evaluate(`state.tasks.find(t=>t.id==='detail-a')`),before);assert.deepEqual(diskTask(),before);assert.equal(await evaluate(`document.querySelector('#taskDescriptionInput').value`),'失败后保留的说明');assert.equal(await evaluate(`WorkstationTaskDetail.handle.capture().checklist.length`),2);assert.equal(await evaluate(`document.querySelector('#taskDialog').open`),true);
    await evaluate(`saveDocumentDurably=detailOriginalSave;void 0`);await click('#saveTask');await until(()=>evaluate(`!document.querySelector('#taskDialog').open&&!saveTaskDetails.busy`),'retry receipt');assert.equal(diskTask().description,'失败后保留的说明');assert.equal(diskTask().checklist[1].text,'失败后保留的检查项');
  });
  await check('Enter adds a checklist step without submitting; pending step is saved exactly once after failure and retry',async()=>{
    await fixture();await open();await input('#newChecklistItem','回车添加步骤');
    const stopped=await evaluate(`(()=>{const n=document.querySelector('#newChecklistItem'),e=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});n.dispatchEvent(e);return e.defaultPrevented;})()`);await paint();
    assert.equal(stopped,true);assert.equal(await evaluate(`document.querySelector('#taskDialog').open`),true);assert.equal(diskTask().checklist.length,1);
    assert.equal(await evaluate(`WorkstationTaskDetail.handle.capture().checklist[1].text`),'回车添加步骤');
    await input('#newChecklistItem','直接保存的待添加步骤');await evaluate(`saveDocumentDurably=async()=>false;void 0`);await click('#saveTask');await until(()=>evaluate('!saveTaskDetails.busy'),'pending checklist failed receipt');
    assert.equal(await evaluate(`document.querySelector('#newChecklistItem').value`),'直接保存的待添加步骤');assert.equal(diskTask().checklist.length,1);
    await evaluate(`saveDocumentDurably=detailOriginalSave;void 0`);await click('#saveTask');await until(()=>evaluate(`!document.querySelector('#taskDialog').open&&!saveTaskDetails.busy`),'pending checklist retry');
    assert.deepEqual(diskTask().checklist,[{text:'原始检查项',done:false},{text:'回车添加步骤',done:false},{text:'直接保存的待添加步骤',done:false}]);
  });
  await check('source reader round trip preserves controlled fields checklist groups selection and original task origin without writes',async()=>{
    await fixture();await open();await evaluate(`window.detailFocusLog=[];document.addEventListener('focusin',event=>detailFocusLog.push({kind:'focusin',tag:event.target.tagName,id:event.target.id}));document.addEventListener('focusout',event=>detailFocusLog.push({kind:'focusout',tag:event.target.tagName,id:event.target.id}));void 0`);const before=diskTask();await input('#taskTitleInput','阅读返回未保存标题');await input('#taskDescriptionInput','阅读返回未保存说明 ABC');await add('阅读返回未保存步骤');await click('[data-task-group="properties"] > summary');await input('#taskStartInput','2026-10-03');await click('[data-task-group="sources"] > summary');
    await evaluate(`(()=>{const n=document.querySelector('#taskDescriptionInput');n.focus();n.setSelectionRange(2,8,'backward');})()`);
    // Pointer activation records the preceding field's focusout, as real UI does.
    await click('[data-task-source-type="note"][data-task-source-id="detail-note"]');
    await until(()=>evaluate(`ReadingPane.snapshot().visible&&state.previewRecord?.id==='detail-note'&&!document.querySelector('#taskDialog').open`),'related note reader');
    observations.push({parkedDraft:await evaluate(`taskEditorContexts.get('detail-a')`)});assert.deepEqual(await evaluate(`ReadingPane.snapshot().tabs.find(t=>t.kind==='note'&&t.id==='detail-note').origin`),{view:'task',id:'detail-a',entry:{view:'project',projectId:'detail-project',section:'tasks'}});await click('#readingBack');
    await until(()=>evaluate(`document.querySelector('#taskDialog').open&&state.openTaskId==='detail-a'&&!ReadingPane.snapshot().visible`),'task restored');await paint();
    observations.push({returnedContext:await evaluate(`({context:taskEditorContexts.get('detail-a'),focusLog:detailFocusLog,active:document.activeElement.outerHTML.slice(0,500),descriptionSelection:[document.querySelector('#taskDescriptionInput').selectionStart,document.querySelector('#taskDescriptionInput').selectionEnd,document.querySelector('#taskDescriptionInput').selectionDirection]})`)});
    const draft=await evaluate(`({draft:WorkstationTaskDetail.handle.capture(),focus:{id:document.activeElement.id,start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd,direction:document.activeElement.selectionDirection}})`);observations.push({readerReturn:draft});assert.equal(draft.draft.fields.taskTitleInput,'阅读返回未保存标题');assert.equal(draft.draft.fields.taskStartInput,'2026-10-03');assert.equal(draft.draft.checklist[1].text,'阅读返回未保存步骤');assert.equal(draft.draft.groups.sources,true);assert.deepEqual(draft.focus,{id:'taskDescriptionInput',start:2,end:8,direction:'backward'});assert.deepEqual(diskTask(),before);assert.equal(await evaluate(`state.tasks.find(t=>t.id==='detail-a').title`),'原始任务甲');await screenshot('source-return-draft');await cancel();
  });
  await check('retired callbacks and changed versions cannot affect the replacement form or overwrite external checklist changes',async()=>{
    await fixture();await open();await evaluate(`window.retiredTaskProps=detailLatestProps;void 0`);await input('#taskTitleInput','甲任务草稿');await evaluate(`openTask('detail-b',{origin:{view:'project',projectId:'other-project',section:'tasks'}})`);await paint();await input('#taskTitleInput','乙任务独立草稿');
    assert.equal(await evaluate(`retiredTaskProps.onSave()`),false);await evaluate(`retiredTaskProps.onCancel();retiredTaskProps.onDelete();retiredTaskProps.onOpen('note','detail-note',null)`);assert.equal(await evaluate(`document.querySelector('#taskDialog').open&&state.openTaskId==='detail-b'&&document.querySelector('#taskTitleInput').value==='乙任务独立草稿'`),true);assert.equal(diskTask('detail-b').title,'原始任务乙');await cancel();
    await open();await input('#taskTitleInput','会冲突的本地标题');await evaluate(`state.tasks.find(t=>t.id==='detail-a').checklist.push({text:'外部新步骤',done:true});window.conflictWriteCalls=0;saveDocumentDurably=async()=>{conflictWriteCalls++;return detailOriginalSave();};void 0`);await click('#saveTask');await paint();assert.equal(await evaluate('conflictWriteCalls'),0);assert.equal(await evaluate(`state.tasks.find(t=>t.id==='detail-a').title`),'原始任务甲');assert.equal(await evaluate(`state.tasks.find(t=>t.id==='detail-a').checklist[1].text`),'外部新步骤');assert.equal(await evaluate(`document.querySelector('#taskTitleInput').value`),'会冲突的本地标题');assert.equal(diskTask().title,'原始任务甲');await cancel();
    for(const kind of ['private','duplicate','revoked']){
      await fixture();await open();await input('#taskTitleInput','不得复活的草稿');await evaluate(`parkTaskEditor();document.querySelector('#taskDialog').close();if(${quote(kind)}==='private')state.tasks.find(t=>t.id==='detail-a').private=true;else if(${quote(kind)}==='duplicate')state.tasks.push({...state.tasks.find(t=>t.id==='detail-a')});else state.projects.find(p=>p.id==='detail-project').archived=true;`);
      assert.equal(await evaluate(`restorePreviewTask('detail-a')`),false);assert.equal(await evaluate(`taskEditorContexts.has('detail-a')`),false);assert.equal(await evaluate(`document.querySelector('#taskDialog').open`),false);
    }
  });
  await check('wide narrow light dark and reduced motion keep the task form usable; composition Enter cannot submit',async()=>{
    await fixture();await open();await input('#taskTitleInput','长任务标题'.repeat(25));await add('长检查清单与中文标点'.repeat(15));
    for(const [theme,width] of [['light',1280],['dark',680],['light',440]]){
      win.setContentSize(width,920);await evaluate(`state.ui.theme=${quote(theme)};state.settings.reduceMotion=true;applyUiPreferences();`);await paint();
      const layout=await evaluate(`(()=>{const dialog=document.querySelector('#taskDialog'),r=dialog.getBoundingClientRect(),form=document.querySelector('#taskForm'),motion=[...form.querySelectorAll('*')].flatMap(n=>{const s=getComputedStyle(n);return [s.animationDuration,s.transitionDuration].flatMap(v=>v.split(',').map(x=>parseFloat(x)));});return {width:innerWidth,page:document.documentElement.scrollWidth,left:r.left,right:r.right,client:dialog.clientWidth,scroll:dialog.scrollWidth,formScroll:form.scrollWidth,formClient:form.clientWidth,maxMotionSeconds:Math.max(0,...motion)};})()`);observations.push({theme,width,layout});assert.ok(layout.page<=layout.width+1);assert.ok(layout.left>=-1&&layout.right<=layout.width+1);assert.ok(layout.scroll<=layout.client+2&&layout.formScroll<=layout.formClient+2);assert.ok(layout.maxMotionSeconds<=.0011);await screenshot(theme+'-'+width);
    }
    await evaluate(`window.compositionWriteCalls=0;saveDocumentDurably=async()=>{compositionWriteCalls++;return false;};void 0`);
    const prevented=await evaluate(`(()=>{const n=document.querySelector('#taskTitleInput');n.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'中'}));const e=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,isComposing:true});n.dispatchEvent(e);document.querySelector('#taskForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));n.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中'}));return e.defaultPrevented;})()`);assert.equal(prevented,true);assert.equal(await evaluate('compositionWriteCalls'),0);assert.equal(await evaluate(`document.querySelector('#taskDialog').open`),true);await cancel();win.setContentSize(1280,920);
  });
  await check('fresh renderer hydration retains the saved task checklist and source records; no external requests or renderer errors',async()=>{
    await fixture();await open();await input('#taskTitleInput','重载保留任务');await add('重载保留清单');await click('#saveTask');await until(()=>evaluate(`!saveTaskDetails.busy&&!document.querySelector('#taskDialog').open`),'reload fixture saved');const persisted=diskTask();const originalNotes=disk().notes;
    const reloaded=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));win.reload();await reloaded;await until(()=>evaluate(`typeof storageHydrated!=='undefined'&&storageHydrated`),'fresh hydration');assert.deepEqual(await evaluate(`state.tasks.find(t=>t.id==='detail-a')`),persisted);assert.deepEqual(disk().notes,originalNotes);await evaluate(`WorkstationOnboarding.close();WorkspaceTour.close();openTask('detail-a',{origin:{view:'project',projectId:'detail-project',section:'tasks'}})`);await paint();assert.equal(await evaluate(`document.querySelector('#taskTitleInput').value`),'重载保留任务');assert.equal(await evaluate(`WorkstationTaskDetail.handle.capture().checklist[1].text`),'重载保留清单');assert.equal(await evaluate(`state.conversations.find(c=>c.id==='detail-chat').draft`),'保留会话草稿');assert.deepEqual(rendererErrors,[]);assert.deepEqual(externalRequests,[]);await screenshot('reloaded');
  });
  return failures.length?1:0;
}
run().then(finish).catch(error=>{failures.push({name:'infrastructure',error:error.stack});console.error(error);void finish(1);});
