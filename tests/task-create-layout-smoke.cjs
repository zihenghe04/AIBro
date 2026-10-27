/* Production TaskCreateForm + PlanningWorkbench + fresh temporary SQLite store.
 * Renderer development gate only; this does not establish native AX acceptance.
 * Uses the already built UI bundle and never loads the user's workspace. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results/native-release-edges-20261001');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-task-create-layout-'));
const STORE = path.join(TEMP, 'store');
fs.mkdirSync(STORE); fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', path.join(TEMP, 'profile')); app.on('window-all-closed', () => {});
let server, win, origin, stopping = false;
const checks = [], failures = [], observations = [], rendererErrors = [], blockedRequests = [];
const report = { checks, failures, observations, rendererErrors, blockedRequests, nativeAcceptance: false,
  scope: 'Production task creation; isolated renderer and real temporary local store. Only save failure transport is synthetic.',
  userWorkspaceLoaded: false, realModelCalls: 0, localCloudStatusReads: 0, localSSHMetadataReads: 0 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = source => win.webContents.executeJavaScript(source, true);
const watchdog = setTimeout(() => { failures.push({ name: 'watchdog', error: '120 second deadline' }); void finish(1); }, 120000);
async function until(predicate, label) {
  const start = Date.now();
  while (Date.now() - start < 12000) { if (await predicate()) return; await delay(60); }
  throw new Error('Timeout: ' + label);
}
async function paint() {
  await evaluate(`new Promise(resolve => { document.getAnimations().forEach(animation => { try { animation.finish(); } catch {} }); requestAnimationFrame(() => requestAnimationFrame(resolve)); })`);
}
async function shot(name) {
  await paint(); fs.writeFileSync(path.join(OUT, 'task-create-' + name + '.png'), (await win.webContents.capturePage()).toPNG());
}
async function check(name, action) {
  try { await action(); checks.push(name); console.log('PASS', name); }
  catch (error) { failures.push({ name, error: error.stack }); await shot('failure').catch(() => {}); throw error; }
}
async function hit(selector, scroll = true) {
  if (scroll) { await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'nearest',inline:'nearest'})`); await paint(); }
  const result = await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if (!el) throw Error('Missing '+${JSON.stringify(selector)}); const r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,top=document.elementFromPoint(x,y);return {x,y,hit:!!top&&(top===el||el.contains(top)),disabled:el.disabled,rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},viewport:{width:innerWidth,height:innerHeight},topTag:top?.tagName,topClass:top?.className};})()`);
  assert.equal(result.disabled, false, selector + ' enabled');
  assert.equal(result.hit, true, selector + ' center is hit-testable: ' + JSON.stringify(result));
  assert.ok(result.rect.left >= 0 && result.rect.right <= result.viewport.width + 1 && result.rect.top >= 0 && result.rect.bottom <= result.viewport.height + 1, selector + ' fully inside viewport');
  return result;
}
async function click(selector) {
  const { x, y } = await hit(selector);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
  win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  await paint();
}
async function input(selector, value) {
  await evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)}); const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(el instanceof HTMLSelectElement?'change':'input',{bubbles:true}));})()`); await paint();
}
const values = () => evaluate(`Object.fromEntries(['Title','Description','Due','Start','Priority'].map(key=>[key,document.querySelector('#planningTask'+key)?.value]))`);
const disk = () => evaluate(`fetch('/__state',{cache:'no-store'}).then(r=>r.json()).then(data=>data.state||data)`);
async function finish(code) {
  if (stopping) return; stopping = true; clearTimeout(watchdog);
  if (win && !win.isDestroyed()) win.destroy();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM'); await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(1500)]);
    if (server.exitCode === null) { server.kill('SIGKILL'); await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(500)]); }
  }
  fs.rmSync(TEMP, { recursive: true, force: true });
  Object.assign(report, { passed: checks.length, success: code === 0, temporaryWorkspaceRemoved: !fs.existsSync(TEMP), serverStopped: !server || server.exitCode !== null || server.signalCode !== null, origin });
  fs.writeFileSync(path.join(OUT, 'task-create-report.json'), JSON.stringify(report, null, 2) + '\n'); app.exit(code);
}
async function run() {
  const port = await new Promise((resolve,reject) => { const probe=net.createServer();probe.once('error',reject);probe.listen(0,'127.0.0.1',()=>{const value=probe.address().port;probe.close(()=>resolve(value));}); }); origin='http://127.0.0.1:'+port;
  const log=fs.openSync(path.join(OUT,'task-create-server.log'),'w'); server=spawn('python3',[path.join(ROOT,'app/server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(port),AI_WORKSTATION_DATA_DIR:STORE,PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore',log,log]});fs.closeSync(log);
  await until(()=>new Promise(resolve=>http.get(origin+'/__health',response=>{response.resume();resolve(response.statusCode===200);}).on('error',()=>resolve(false))),'temporary server');
  await app.whenReady(); win=new BrowserWindow({show:false,width:1280,height:700,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(request,done)=>{
    const url=new URL(request.url),statusRead=url.origin===origin&&request.method==='GET'&&(['/__cloud/status','/__cloud/ssh','/__auth/status'].includes(url.pathname)||(url.pathname==='/__auth/models'&&url.searchParams.has('cacheonly')));
    if(statusRead&&url.pathname==='/__cloud/status')report.localCloudStatusReads++; if(statusRead&&url.pathname==='/__cloud/ssh')report.localSSHMetadataReads++;
    const blocked=url.origin!==origin||!statusRead&&/^\/__(?:proxy|codex|auth|cloud|models|api|llm|local|terminal|browser)(?:\/|$)/.test(url.pathname);
    if(blocked)blockedRequests.push({url:request.url,method:request.method});done({cancel:blocked});
  });
  win.webContents.on('console-message',event=>{if(event.level==='error')rendererErrors.push(event.message);});
  await win.loadURL(origin); await until(()=>evaluate(`typeof storageHydrated!=='undefined'&&storageHydrated`),'hydration');
  await evaluate(`(() => {WorkstationOnboarding.close();WorkspaceTour.close();state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};state.ui.workspaceTour={version:WorkspaceTour.VERSION,status:'skipped'};state.projects=[{id:'task-create-layout-project',name:'课程整理 · 合成验收',workspace:'课程'}];state.tasks=[];state.notes=[];state.imports=[];state.papers=[];state.trash=[];state.links=[];state.attachments=[];state.agentRuns=[];state.conversations=[{id:'task-create-layout-chat',title:'合成对话',projectId:'task-create-layout-project',workspace:'课程',messages:[],attachments:[],draftAttachmentIds:[],draft:''}];state.currentConversationId='task-create-layout-chat';state.currentProjectId='task-create-layout-project';state.ui.theme='light';state.ui.reducedMotion=true;normalizeStateShape(state);applyUiPreferences();renderAll();})()`);
  await evaluate('saveDocumentDurably()'); await evaluate('flushWorkspace()');
  await until(()=>evaluate('!serverSaveInFlight&&!serverSaveQueued'),'initial durable fixture');
  await evaluate(`PlanningWorkbench.createTask({projectId:'task-create-layout-project'})`); await paint();
  const expected={Title:'课程复习 · 创建表单验收',Description:'保留展开和收起之间的详情。\n完成整理后再次复习。',Due:'2026-10-08',Start:'2026-10-02',Priority:'high'};
  await check('expanded properties unmount and remount without losing controlled values',async()=>{
    assert.equal(await evaluate(`document.querySelector('#planningCreateSurface').dataset.halaskaRoot`),'TaskCreateForm');
    assert.equal(await evaluate(`!!document.querySelector('#taskCreateDetails')`),false);
    await input('#planningTaskTitle',expected.Title); await input('#planningTaskDescription',expected.Description); await input('#planningTaskDue',expected.Due);
    await click('[aria-controls="taskCreateDetails"]'); await input('#planningTaskPriority',expected.Priority); await input('#planningTaskStart',expected.Start);
    assert.deepEqual(await values(),expected); await click('[aria-controls="taskCreateDetails"]');
    assert.equal(await evaluate(`!!document.querySelector('#taskCreateDetails')`),false); await click('[aria-controls="taskCreateDetails"]'); assert.deepEqual(await values(),expected);
  });
  await check('fixed footer remains visible and hit-testable while only properties scroll at three sizes',async()=>{
    for(const [width,height] of [[1280,700],[950,650],[440,800]]){
      win.setContentSize(width,height); await paint();
      for(const where of ['start','end']){
        await evaluate(`document.querySelector('.task-create-content').scrollTop=${where==='start'?'0':'100000'}`); await paint();
        const submit=await hit('#planningCreateSubmit',false),cancel=await hit('.task-create-actions button:first-child',false);
        const layout=await evaluate(`(()=>{const d=document.querySelector('#planningCreateDialog'),c=document.querySelector('.task-create-content'),h=document.querySelector('.task-create-heading'),f=document.querySelector('.task-create-actions');return {page:document.documentElement.scrollWidth,viewport:innerWidth,dialog:{scrollTop:d.scrollTop,scrollHeight:d.scrollHeight,clientHeight:d.clientHeight},content:{scrollTop:c.scrollTop,scrollHeight:c.scrollHeight,clientHeight:c.clientHeight},headerTop:h.getBoundingClientRect().top,footerTop:f.getBoundingClientRect().top};})()`);
        observations.push({width,height,where,submit,cancel,layout}); assert.ok(layout.page<=layout.viewport+1); assert.equal(layout.dialog.scrollTop,0);
        assert.ok(layout.dialog.scrollHeight<=layout.dialog.clientHeight+1); assert.ok(layout.headerTop>=0); assert.ok(layout.content.scrollHeight>layout.content.clientHeight);
      }
      await shot(width+'x'+height);
    }
  });
  await check('native renderer Tab sequence reaches Add task after conditional properties',async()=>{
    win.setContentSize(950,650);await paint();await click('#planningTaskTitle');
    const trace=[];for(let index=0;index<28;index++){
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});await paint();
      const active=await evaluate(`({id:document.activeElement?.id,tag:document.activeElement?.tagName,label:document.activeElement?.getAttribute('aria-label'),text:document.activeElement?.textContent?.slice(0,40)})`);trace.push(active);if(active.id==='planningCreateSubmit')break;
    }
    observations.push({tabTrace:trace});assert.equal(trace.at(-1)?.id,'planningCreateSubmit');await hit('#planningCreateSubmit',false);
  });
  await check('a local save transport failure preserves all input and rolls back the optimistic task',async()=>{
    await evaluate(`window.__taskCreateRealFetch=window.fetch;window.__taskCreateFailSave=true;window.__taskCreateFailureCount=0;window.__taskCreateSubmitCount=0;document.querySelector('#planningCreateForm').addEventListener('submit',()=>window.__taskCreateSubmitCount++);window.fetch=function(resource,options={}){const target=typeof resource==='string'?resource:resource.url;if(window.__taskCreateFailSave&&new URL(target,location.href).pathname==='/__state'&&String(options.method||'GET').toUpperCase()==='POST'){window.__taskCreateFailureCount++;return Promise.resolve(new Response(JSON.stringify({error:'Synthetic local storage unavailable'}),{status:503,headers:{'Content-Type':'application/json'}}));}return window.__taskCreateRealFetch.call(this,resource,options);};void 0;`);
    await click('#planningCreateSubmit');await until(()=>evaluate(`!PlanningWorkbench.isBusy()&&!!document.querySelector('#planningCreateError')?.textContent`),'save failure');
    assert.equal(await evaluate(`document.querySelector('#planningCreateDialog').open`),true);assert.deepEqual(await values(),expected);assert.equal(await evaluate('state.tasks.length'),0);assert.equal((await disk()).tasks.length,0);await shot('save-failure');
    await evaluate('window.__taskCreateFailSave=false');
  });
  await check('one successful visible submit closes the dialog and persists the exact task once',async()=>{
    await click('#planningCreateSubmit'); await until(()=>evaluate(`!document.querySelector('#planningCreateDialog').open&&!PlanningWorkbench.isBusy()`),'real save receipt');
    const saved=await disk(); assert.equal(saved.tasks.length,1);const task=saved.tasks[0];assert.equal(task.title,expected.Title);assert.equal(task.description,expected.Description);assert.equal(task.dueAt,expected.Due);assert.equal(task.startAt,expected.Start);assert.equal(task.priority,expected.Priority);assert.equal(task.projectId,'task-create-layout-project');assert.equal(task.workspace,'课程');
    report.savedTask=task;report.submitEvents=await evaluate('__taskCreateSubmitCount');report.syntheticSaveFailures=await evaluate('__taskCreateFailureCount');assert.equal(report.submitEvents,2);assert.ok(report.syntheticSaveFailures>=1);await evaluate('void (window.fetch=window.__taskCreateRealFetch)');
  });
  await check('no model, cloud mutation, external request or renderer exception occurs',async()=>{assert.deepEqual(blockedRequests,[]);assert.deepEqual(rendererErrors,[]);});
  return 0;
}
run().then(finish).catch(error=>{if(!failures.length)failures.push({name:'setup/runtime',error:error.stack});console.error(error.stack);void finish(1);});
