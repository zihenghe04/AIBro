/* Full production app + Kit project navigation, using a fresh temporary server
 * store and Electron profile. No user workspace, provider or SSH is involved.
 * Run only after the parent's normal build:ui step; this script never builds.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results/project-overview-outputs-20261001');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-project-overview-'));
const STORE = path.join(TEMP, 'store');
fs.mkdirSync(STORE); fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', path.join(TEMP, 'profile'));
app.on('window-all-closed', () => {});
let server, win, origin, stopping = false;
const checks = [], failures = [], observations = [], rendererErrors = [], externalRequests = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = source => win.webContents.executeJavaScript(source, true);
const watchdog = setTimeout(() => { failures.push({ name: 'watchdog', error: '120 second deadline' }); void finish(1); }, 120000);
async function until(predicate, label) {
  const start = Date.now();
  while (Date.now() - start < 15000) { if (await predicate()) return; await delay(60); }
  throw new Error('Timeout: ' + label);
}
async function check(name, action) {
  try { await action(); checks.push(name); console.log('PASS', name); }
  catch (error) { failures.push({ name, error: error.stack }); console.error('FAIL', name, error.message); }
}
async function paint() {
  await evaluate(`new Promise(resolve => { document.getAnimations().forEach(animation => { try { animation.finish(); } catch {} }); requestAnimationFrame(() => requestAnimationFrame(resolve)); })`);
}
async function click(selector) {
  await evaluate(`(() => { const target = document.querySelector(${JSON.stringify(selector)}); if (!target || !target.getClientRects().length || target.disabled) throw Error('Unavailable control: '+${JSON.stringify(selector)}); target.click(); })()`);
  await paint();
}
async function screenshot(name) {
  await paint(); fs.writeFileSync(path.join(OUT, 'project-' + name + '.png'), (await win.webContents.capturePage()).toPNG());
}
function report() {
  fs.writeFileSync(path.join(OUT, 'renderer-report.json'), JSON.stringify({ passed: checks.length, checks, failures, observations, rendererErrors, externalRequests,
    scope: 'Full production App, actual Kit overview and outputs; synthetic project records only.',
    excluded: 'No native acceptance, provider requests, SSH, real workspace, document mutation or filesystem imports. One new overview entry verifies exact source-reader anchor and return origin.',
    userWorkspaceLoaded: false, workspace: TEMP, temporaryWorkspaceRemoved: !fs.existsSync(TEMP), origin,
  }, null, 2) + '\n');
}
async function finish(code) {
  if (stopping) return; stopping = true; clearTimeout(watchdog);
  if (win && !win.isDestroyed()) win.destroy();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(1500)]);
    if (server.exitCode === null) { server.kill('SIGKILL'); await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(500)]); }
  }
  fs.rmSync(TEMP, { recursive: true, force: true }); report(); app.exit(code);
}
async function go(section='overview',id='overview-project') {
  assert.equal(await evaluate(`WorkspaceNavigation.go(${JSON.stringify(section)},${JSON.stringify(id)})`),true); await paint();
}
async function input(selector,value) {
  await evaluate(`(() => { const target=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(target,${JSON.stringify(value)});target.dispatchEvent(new Event('input',{bubbles:true})); })()`);await paint();
}
async function run() {
  const port=await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',reject);probe.listen(0,'127.0.0.1',()=>{const value=probe.address().port;probe.close(()=>resolve(value));});});origin='http://127.0.0.1:'+port;
  const log=fs.openSync(path.join(OUT,'renderer-server.log'),'w');server=spawn('python3',[path.join(ROOT,'app/server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(port),AI_WORKSTATION_DATA_DIR:STORE},stdio:['ignore',log,log]});fs.closeSync(log);
  await until(()=>new Promise(resolve=>http.get(origin+'/__health',response=>{response.resume();resolve(response.statusCode===200);}).on('error',()=>resolve(false))),'isolated server');
  await app.whenReady();win=new BrowserWindow({show:false,width:1280,height:880,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(request,done)=>{const url=new URL(request.url),allowed=url.origin===origin&&!/^\/__(?:proxy|codex\/respond|cloud\/connect|auth\/(?!status(?:$|\?)|models\?(?:[^#]*&)?cacheonly)|local\/)/.test(url.pathname+url.search);if(!allowed)externalRequests.push(request.url);done({cancel:!allowed});});
  win.webContents.on('console-message',event=>{if(event.level==='error')rendererErrors.push(event.message);});
  await win.loadURL(origin);await until(()=>evaluate(`typeof storageHydrated!=='undefined'&&storageHydrated`),'workspace hydration');
  assert.equal(await evaluate(`HalaskaUI.componentNames.includes('ProjectOverview')`),true);
  await evaluate(`(() => {
    WorkstationOnboarding.close();WorkspaceTour.close();state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};state.ui.workspaceTour={version:WorkspaceTour.VERSION,status:'skipped'};
    state.projects=[{id:'overview-project',name:'Project overview (synthetic)',workspace:'日常',description:'Actual project description'}, {id:'empty-project',name:'Empty project',workspace:'日常'}];
    state.notes=[{id:'output-note',title:'整理成果与很长的标题'.repeat(4),projectId:'overview-project',workspace:'日常',kind:'note',content:'# Saved output\\n\\nApproved overview fixture body.',updatedAt:200}, {id:'memory-note',title:'Project memory',projectId:'overview-project',projectMemoryType:'long',content:'Existing public project memory',updatedAt:300},{id:'private-note',title:'PRIVATE_NEVER_VISIBLE',projectId:'overview-project',content:'Private',provenance:{origin:{private:true}},updatedAt:999}];
    state.imports=[{id:'source',projectId:'overview-project',name:'Original.txt',mimeType:'text/plain',status:'parsed',parser:'text',content:'A synthetic source',updatedAt:100}];
    state.tasks=[];state.papers=[];state.trash=[];state.links=[];state.attachments=[];
    state.conversations=[{id:'overview-chat',title:'Synthetic source conversation',projectId:'overview-project',workspace:'日常',messages:[],attachments:[],draftAttachmentIds:[],draft:'Keep this draft.'}];
    state.agentRuns=[{id:'synthetic-output-run',projectId:'overview-project',conversationId:'overview-chat',status:'completed',finishedAt:200,results:[{type:'note',id:'output-note',operation:'created'}]},{id:'synthetic-no-output-run',projectId:'overview-project',conversationId:'overview-chat',status:'completed',finishedAt:100}];
    state.currentConversationId='overview-chat';state.currentProjectId='overview-project';state.ui.theme='light';state.ui.reducedMotion=true;
    normalizeStateShape(state);applyUiPreferences();renderAll();window.overviewSourceSnapshot=JSON.stringify({notes:state.notes,imports:state.imports});
    window.overviewOriginCalls=[];const originalOrigin=captureDocumentOrigin;captureDocumentOrigin=function(kind,id,navigation={}){const value=originalOrigin(kind,id,navigation);overviewOriginCalls.push({kind,id,exactAnchor:navigation.anchor===window.expectedOverviewAnchor,origin:value});return value;};
    window.overviewExplicitSaves=0;const originalSave=saveDocumentDurably;saveDocumentDurably=async function(...args){overviewExplicitSaves++;return originalSave(...args);};
  })()`);
  await go();
  await check('a project with zero tasks shows actual saved outputs and material counts, not task onboarding',async()=>{
    const result=await evaluate(`({owner:document.querySelector('#projectOverview').dataset.halaskaRoot,text:document.querySelector('#projectOverview').textContent,legacy:!!document.querySelector('#projectMetrics,#projectSummary,#projectOnboarding'),insightsOpen:document.querySelector('#projectInsights').open,graphs:document.querySelector('#projectPlanning').children.length})`);
    observations.push(result);assert.equal(result.owner,'ProjectOverview');assert.match(result.text,/整理成果/);assert.doesNotMatch(result.text,/PRIVATE_NEVER_VISIBLE/);assert.equal(result.legacy,false);assert.equal(result.insightsOpen,false);assert.equal(result.graphs,0);await screenshot('overview-light');
  });
  await check('overview output opens approved body with exact anchor and returns to overview without a save',async()=>{
    await evaluate(`window.expectedOverviewAnchor=[...document.querySelectorAll('#projectOverview button')].find(button=>button.textContent.includes('整理成果'));expectedOverviewAnchor.click();`);
    await until(()=>evaluate(`ReadingPane.isActive('note','output-note')&&ReadingPane.snapshot().visible`),'overview output reader');
    await until(()=>evaluate(`document.querySelector('#previewContent')?.textContent.includes('Approved overview fixture body')`),'approved body');
    const call=await evaluate(`overviewOriginCalls.find(item=>item.id==='output-note')`);assert.equal(call.exactAnchor,true);assert.deepEqual(call.origin,{view:'project',projectId:'overview-project',section:'overview'});
    await click('#readingBack');await until(()=>evaluate(`state.ui.projectTab==='overview'&&!ReadingPane.snapshot().visible`),'overview return');assert.equal(await evaluate('overviewExplicitSaves'),0);
  });
  await check('overview task action opens the real scoped editor and add task dialog without creating records',async()=>{
    await evaluate(`[...document.querySelectorAll('#projectOverview button')].find(button=>button.textContent.includes('添加任务')).click()`);await paint();assert.equal(await evaluate(`document.querySelector('#planningCreateForm')?.closest('dialog').open`),true);assert.equal(await evaluate(`document.querySelector('#planningCreateForm .task-create-location').textContent`),'Project overview (synthetic)');
    await click('#planningCreateForm [aria-controls=taskCreateDetails]');assert.equal(await evaluate(`document.querySelector('#planningTaskProject').value`),'overview-project');
    await evaluate(`(()=>{const cancel=[...document.querySelectorAll('#planningCreateForm .task-create-actions button')].find(button=>button.textContent.trim()==='取消');if(!cancel?.getClientRects().length||cancel.disabled)throw Error('Unavailable control: task create cancel');cancel.click();})()`);await paint();
    assert.equal(await evaluate(`document.querySelector('#planningCreateDialog').open`),false);assert.equal(await evaluate('state.tasks.length'),0);
    await evaluate(`state.tasks=[{id:'next-task',title:'Review this output',projectId:'overview-project',workspace:'日常',status:'todo',dueAt:'2026-10-09'}];renderProject('overview-project');`);await paint();
    await evaluate(`[...document.querySelectorAll('#projectOverview button')].find(button=>button.textContent.includes('Review this output')).click()`);await paint();assert.equal(await evaluate(`document.querySelector('#taskDialog').open`),true);
    await evaluate(`document.querySelector('#taskDialog').close()`);await paint();assert.equal(await evaluate('state.tasks.length'),1);
  });
  await check('analytics is lazy, retains real charts and closes when switching projects',async()=>{
    await click('#projectInsights > summary');await until(()=>evaluate(`document.querySelector('#projectPlanning').children.length>0`),'lazy insights');
    assert.doesNotMatch(await evaluate(`document.querySelector('#projectInsights').textContent`),/PRIVATE_NEVER_VISIBLE/);
    await go('overview','empty-project');assert.equal(await evaluate(`document.querySelector('#projectInsights').open`),false);assert.match(await evaluate(`document.querySelector('#projectOverview').textContent`),/添加资料/);assert.doesNotMatch(await evaluate(`document.querySelector('#projectOverview').textContent`),/整理成果|Review this output/);await screenshot('empty');await go();
  });
  await check('outputs use continuous rows, retain search during refresh and retire composition after a project switch',async()=>{
    await go('outputs');assert.equal(await evaluate(`document.querySelector('#projectOutputs .project-outputs-intro,.project-outputs-footnote')`),null);
    await input('#projectOutputs input','整理');await evaluate(`window.previousOutputInput=document.querySelector('#projectOutputs input');previousOutputInput.focus();renderProject('overview-project');`);await paint();assert.equal(await evaluate(`previousOutputInput===document.querySelector('#projectOutputs input')&&document.activeElement===previousOutputInput`),true);
    await evaluate(`previousOutputInput.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(previousOutputInput,'未提交');previousOutputInput.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));`);
    await go('outputs','empty-project');assert.equal(await evaluate('previousOutputInput.isConnected'),false);await evaluate(`previousOutputInput.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'未提交'}))`);assert.equal(await evaluate(`document.querySelector('#projectOutputs input')?.value||''`),'');
    await go('outputs');assert.equal(await evaluate(`document.querySelector('#projectOutputs input').value`),'整理');await input('#projectOutputs input','');await screenshot('outputs-light');
  });
  await check('light and dark narrow surfaces keep all primary actions inside the work area',async()=>{
    for(const [theme,width] of [['light',1280],['dark',680],['light',440]])for(const section of ['overview','outputs']){
      win.setContentSize(width,880);await evaluate(`state.ui.theme=${JSON.stringify(theme)};state.ui.reducedMotion=true;applyUiPreferences();`);await go(section);
      const selector=section==='overview'?'#projectOverview':'#projectOutputs';
      const layout=await evaluate(`(() => {const host=document.querySelector(${JSON.stringify(selector)}),r=host.getBoundingClientRect();return {width:innerWidth,page:document.documentElement.scrollWidth,host:{left:r.left,right:r.right,scroll:host.scrollWidth,client:host.clientWidth},buttons:[...host.querySelectorAll('button')].filter(button=>button.getClientRects().length).map(button=>{const r=button.getBoundingClientRect();return {text:button.textContent,left:r.left,right:r.right,width:r.width};})};})()`);observations.push({theme,width,section,layout});assert.ok(layout.page<=layout.width+1);assert.ok(layout.host.scroll<=layout.host.client+2);assert.ok(layout.buttons.every(button=>button.width>0&&button.left>=0&&button.right<=width+1));await screenshot(section+'-'+theme+'-'+width);
    }
  });
  await check('no errors or external requests; read-only flow preserves sources and composer draft',async()=>{
    assert.deepEqual(rendererErrors,[]);assert.deepEqual(externalRequests,[]);assert.equal(await evaluate(`JSON.stringify({notes:state.notes,imports:state.imports})===overviewSourceSnapshot`),true);assert.equal(await evaluate(`state.conversations.find(item=>item.id==='overview-chat').draft`),'Keep this draft.');assert.equal(await evaluate('overviewExplicitSaves'),0);
  });
  return failures.length?1:0;
}
run().then(finish).catch(error=>{failures.push({name:'infrastructure',error:error.stack});console.error(error);void finish(1);});
