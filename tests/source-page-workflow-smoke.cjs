/* Full production app + Kit project navigation, using a fresh temporary server
 * store and Electron profile. No user workspace, provider or SSH is involved.
 * Run only after the parent's normal build:ui step; this script never builds.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results/source-page-workflow-20261001');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-source-page-workflow-'));
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
  await paint(); fs.writeFileSync(path.join(OUT, 'source-page-' + name + '.png'), (await win.webContents.capturePage()).toPNG());
}
function report() {
  fs.writeFileSync(path.join(OUT, 'renderer-report.json'), JSON.stringify({ passed: checks.length, checks, failures, observations, rendererErrors, externalRequests,
    scope: 'Full production app and real Kit collection controls; per-project preferences, pending filtering, source actions, empty state and narrow layouts. Synthetic data only.',
    excluded: 'No native acceptance, provider requests, SSH, external data, reader regression or filesystem imports. Connected-directory status uses an empty response fixture; picker intent is intercepted.',
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
const SEARCH = '#projectCollection [data-cui-search]';
const TYPE = '#projectCollection select[data-cui-type]';
const folder = value => '#projectLibraryNavigation [data-project-library-folder=' + JSON.stringify(value) + ']';
const visibleIds = () => evaluate(`[...document.querySelectorAll('#projectCollection [data-cui-id]')].map(row=>row.dataset.cuiId).sort()`);
async function project(id) {
  assert.equal(await evaluate(`WorkspaceNavigation.go('knowledge',${JSON.stringify(id)})`), true);
  await paint();
}
async function input(selector, value) {
  await evaluate(`(() => { const target=document.querySelector(${JSON.stringify(selector)});if(!target||!target.getClientRects().length||target.disabled)throw Error('Unavailable input');const prototype=target.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(target,${JSON.stringify(value)});target.dispatchEvent(new Event(target.tagName==='SELECT'?'change':'input',{bubbles:true})); })()`);
  await paint();
}
async function snapshot() {
  return evaluate(`(() => {const search=document.querySelector(${JSON.stringify(SEARCH)}),type=document.querySelector(${JSON.stringify(TYPE)}),sort=document.querySelector('#projectCollection [data-cui-sort]'),view=document.querySelector('#projectCollection [data-cui-view][aria-pressed="true"]');return {query:search.value,type:type.value,sort:sort.textContent.trim(),view:view?.dataset.cuiView,folder:state.ui.projectLibraryFolders?.[state.currentProjectId]??null};})()`);
}
async function settleSave() {
  await evaluate('flushWorkspace()');
  await until(() => evaluate('!serverSaveInFlight&&!serverSaveQueued&&!state._pendingLocalSave'), 'isolated preference save');
}
async function observeActions() {
  await evaluate(`(() => {
    window.sourcePageAnalysisCalls=[];window.sourcePagePickerCalls=[];window.sourcePageLocalRequests=[];
    analyzeImports=function(...args){sourcePageAnalysisCalls.push(args);return false;};
    CollectionUI.init({analyzeImports});
    const originalClick=HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click=function(...args){if(this.type==='file'){sourcePagePickerCalls.push({id:this.id,projectId:this.dataset.projectId||null,hidden:this.hidden});return;}return originalClick.apply(this,args);};
    const originalFetch=window.fetch.bind(window);
    window.fetch=(input,options)=>{const url=new URL(typeof input==='string'?input:input.url,location.href);if(url.pathname==='/__local/files'){sourcePageLocalRequests.push(url.pathname);return Promise.resolve(new Response(JSON.stringify({entries:[],nextOffset:null}),{status:200,headers:{'Content-Type':'application/json'}}));}return originalFetch(input,options);};
  })()`);
}
async function run() {
  const port=await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',reject);probe.listen(0,'127.0.0.1',()=>{const value=probe.address().port;probe.close(()=>resolve(value));});});
  origin='http://127.0.0.1:'+port;
  const log=fs.openSync(path.join(OUT,'renderer-server.log'),'w');
  server=spawn('python3',[path.join(ROOT,'app/server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(port),AI_WORKSTATION_DATA_DIR:STORE},stdio:['ignore',log,log]});fs.closeSync(log);
  await until(()=>new Promise(resolve=>http.get(origin+'/__health',response=>{response.resume();resolve(response.statusCode===200);}).on('error',()=>resolve(false))),'isolated server');
  await app.whenReady();
  win=new BrowserWindow({show:false,width:1280,height:880,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(request,done)=>{
    const url=new URL(request.url),allowed=url.origin===origin&&!/^\/__(?:proxy|codex\/respond|cloud\/connect|auth\/(?!status(?:$|\?)|models\?(?:[^#]*&)?cacheonly))/.test(url.pathname+url.search);
    if(!allowed)externalRequests.push(request.url);done({cancel:!allowed});
  });
  win.webContents.on('console-message',event=>{if(event.level==='error')rendererErrors.push(event.message);});
  await win.loadURL(origin);await until(()=>evaluate(`typeof storageHydrated!=='undefined'&&storageHydrated`),'workspace hydration');
  assert.equal(await evaluate(`!!window.CollectionUI&&HalaskaUI.componentNames.includes('ProjectSourceActions')`),true,'Build the current production Kit bundle before running this fixture');
  await evaluate(`(() => {
    WorkstationOnboarding.close();WorkspaceTour.close();state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};state.ui.workspaceTour={version:WorkspaceTour.VERSION,status:'skipped'};
    state.projects=[{id:'source-a',name:'A · 资料工作流（合成验收）',workspace:'日常'},{id:'source-b',name:'B · 独立资料（合成验收）',workspace:'日常'},{id:'source-empty',name:'空资料项目（合成验收）',workspace:'日常'}];
    const note=(id,title,folderPath,projectId='source-a')=>({id,title,folderPath,projectId,workspace:'日常',kind:'note',content:'# '+title+'\\n\\nSynthetic fixture document body.',sourceAttachmentIds:[],createdAt:10,updatedAt:20});
    const original=(id,name,folderPath,projectId='source-a')=>({id,name,originalName:name,folderPath,projectId,workspace:'日常',mimeType:'text/plain',content:'Synthetic source text with facts to study.',parser:'text',status:'parsed',createdAt:10,updatedAt:20});
    state.notes=[note('source-alpha','alpha 笔记','alpha-group'),note('source-other-note','其他资料笔记','elsewhere'),note('source-beta-note','beta 笔记','beta-group','source-b'),{...note('source-analyzed-note','已分析原件的解释','alpha-group'),kind:'资料分析',content:'通过比较材料内不同概念的适用条件，可以建立一条从假设核验到实际应用的学习路线。这是合成验收的分析内容，并非原始资料的逐字复制。',sourceAttachmentIds:['source-analyzed']}];
    state.imports=[original('source-pending-a','alpha 原始资料一.txt','alpha-group'),original('source-pending-b','alpha 原始资料二.txt','alpha-group'),original('source-pending-other','不在当前目录.txt','elsewhere'),original('source-analyzed','已经完成分析.txt','alpha-group'),original('source-beta','beta 原始资料.txt','beta-group','source-b'),{...original('source-private','不能计入公开目录.txt','alpha-group'),private:true}];
    state.tasks=[];state.papers=[];state.trash=[];state.links=[];state.attachments=[];state.agentRuns=[];
    state.conversations=[{id:'source-chat',title:'保留的对话草稿（合成）',projectId:'source-a',workspace:'日常',messages:[],attachments:[],draftAttachmentIds:[],draft:'This draft must stay unchanged.'}];
    state.currentConversationId='source-chat';state.currentProjectId='source-a';state.ui.projectLibraryFolders={};state.ui.projectLibraryExpansion={};state.ui.projectCollectionPreferences={};state.ui.workspaceNavigation={projects:{}};state.ui.theme='light';state.ui.reducedMotion=true;
    normalizeStateShape(state);applyUiPreferences();renderAll();
  })()`);
  await observeActions();await project('source-a');

  await check('production Kit owns native search/select controls and the note type uses the Notes label',async()=>{
    const result=await evaluate(`(() => {const select=document.querySelector(${JSON.stringify(TYPE)}),search=document.querySelector(${JSON.stringify(SEARCH)});return {selectTag:select?.tagName,selectNative:select?.classList.contains('kit-input-hit'),selectOwner:select?.closest('[data-halaska-root]')?.dataset.halaskaRoot,searchOwner:search?.closest('[data-halaska-root]')?.dataset.halaskaRoot,noteLabel:[...select.options].find(option=>option.value==='note')?.textContent,analyzed:importAnalysis(state.imports.find(item=>item.id==='source-analyzed')).status};})()`);
    observations.push({productionControls:result});assert.equal(result.selectTag,'SELECT');assert.equal(result.selectNative,true);assert.equal(result.selectOwner,'LibraryToolbar');assert.equal(result.searchOwner,'LibraryToolbar');assert.equal(result.noteLabel,'笔记');assert.equal(result.analyzed,'analyzed','fixture includes an actually derived analyzed source, not a status-only stub');
  });

  let expectedA,expectedB;
  await check('A and B keep independent query, type, sorting direction, view and folder without resetting each other',async()=>{
    await click(folder('alpha-group'));await input(SEARCH,'alpha');await input(TYPE,'note');
    for(let n=0;n<3;n++)await click('#projectCollection [data-cui-sort]');
    await click('#projectCollection [data-cui-view="cards"]');expectedA=await snapshot();assert.deepEqual(expectedA,{query:'alpha',type:'note',sort:'名称 ↓',view:'cards',folder:'alpha-group'});assert.deepEqual(await visibleIds(),['source-alpha','source-analyzed-note']);
    await project('source-b');assert.deepEqual(await snapshot(),{query:'',type:'all',sort:'更新时间 ↓',view:'list',folder:null});
    await click(folder('beta-group'));await input(SEARCH,'beta');await input(TYPE,'import');await click('#projectCollection [data-cui-sort]');await click('#projectCollection [data-cui-view="tree"]');expectedB=await snapshot();assert.deepEqual(expectedB,{query:'beta',type:'import',sort:'更新时间 ↑',view:'tree',folder:'beta-group'});assert.deepEqual(await visibleIds(),['source-beta']);
    await project('source-a');assert.deepEqual(await snapshot(),expectedA);await project('source-b');assert.deepEqual(await snapshot(),expectedB);
  });

  await check('isolated server save and page reload restore both project preference sets',async()=>{
    await settleSave();await win.loadURL(origin);await until(()=>evaluate(`typeof storageHydrated!=='undefined'&&storageHydrated`),'reloaded saved fixture');await observeActions();
    assert.deepEqual(await evaluate('state.projects.map(item=>item.id).sort()'),['source-a','source-b','source-empty']);
    await project('source-a');assert.deepEqual(await snapshot(),expectedA);await project('source-b');assert.deepEqual(await snapshot(),expectedB);
    observations.push({savedProjectA:expectedA,savedProjectB:expectedB});
  });

  await check('unfinished Chinese composition cannot leak into a different project or overwrite the committed query',async()=>{
    await project('source-a');await evaluate(`(() => {const search=document.querySelector(${JSON.stringify(SEARCH)});window.sourcePageOldSearch=search;search.focus();search.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(search,'尚未提交中文');search.dispatchEvent(new InputEvent('input',{bubbles:true,data:'尚未提交中文',inputType:'insertCompositionText',isComposing:true}));})()`);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(SEARCH)}).value`),'尚未提交中文');
    await project('source-b');assert.deepEqual(await snapshot(),expectedB);
    const detached=await evaluate(`!sourcePageOldSearch.isConnected`);assert.equal(detached,true,'scope changes must retire the composing input, not reuse its composition state in the next project');
    await evaluate(`sourcePageOldSearch.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'尚未提交中文'}));`);await paint();assert.deepEqual(await snapshot(),expectedB);
    await project('source-a');assert.deepEqual(await snapshot(),expectedA);assert.equal(await evaluate(`state.ui.projectCollectionPreferences['source-a'].query`),'alpha');assert.equal(await evaluate(`state.ui.projectCollectionPreferences['source-b'].query`),'beta');
  });

  await check('pending count uses visible originals in the current folder and clicking only clears query and filters them',async()=>{
    await project('source-a');await input(SEARCH,'no matching filename');await input(TYPE,'note');
    const before=await evaluate(`({conversations:JSON.stringify(state.conversations),runs:JSON.stringify(state.agentRuns),attachments:JSON.stringify(state.attachments),current:state.currentConversationId})`);
    assert.equal(await evaluate(`document.querySelector('#projectCollection [data-cui-pending]')?.textContent.trim()`),'待分析 2');
    await click('#projectCollection [data-cui-pending]');const current=await snapshot();assert.equal(current.query,'');assert.equal(current.type,'pending-analysis');assert.equal(current.folder,'alpha-group');assert.deepEqual(await visibleIds(),['source-pending-a','source-pending-b']);
    const after=await evaluate(`({conversations:JSON.stringify(state.conversations),runs:JSON.stringify(state.agentRuns),attachments:JSON.stringify(state.attachments),current:state.currentConversationId})`);assert.deepEqual(after,before);assert.deepEqual(await evaluate('sourcePageAnalysisCalls'),[]);
    await click(folder('elsewhere'));assert.equal(await evaluate(`document.querySelector('#projectCollection [data-cui-pending]')?.textContent.trim()`),'待分析 1');assert.deepEqual(await visibleIds(),['source-pending-other']);await click(folder('alpha-group'));
  });

  await check('source header has one primary add action and only unconnected projects show Connect local folder; legacy banners are absent',async()=>{
    await project('source-a');let result=await evaluate(`({add:!!document.querySelector('#projectAddSource'),connect:!!document.querySelector('#projectLocalFiles'),legacyPending:!!document.querySelector('#projectPendingAnalysis'),legacyLocal:!!document.querySelector('#projectLocalSummary'),owner:document.querySelector('#projectAddSource')?.closest('[data-halaska-root]')?.dataset.halaskaRoot})`);assert.deepEqual(result,{add:true,connect:true,legacyPending:false,legacyLocal:false,owner:'ProjectSourceActions'});
    await evaluate(`state.projects.find(item=>item.id==='source-b').localFolder={id:'source-empty-local-fixture',name:'合成空目录'};`);await project('source-b');
    result=await evaluate(`({add:!!document.querySelector('#projectAddSource'),connect:!!document.querySelector('#projectLocalFiles'),legacyPending:!!document.querySelector('#projectPendingAnalysis'),legacyLocal:!!document.querySelector('#projectLocalSummary'),actions:document.querySelector('#projectSourceActions').textContent.trim()})`);assert.deepEqual(result,{add:true,connect:false,legacyPending:false,legacyLocal:false,actions:'添加资料'});
    observations.push({connectedActions:result,localResponses:'Empty transport fixture only; no filesystem directory was read.'});
  });

  await check('empty project Add sources and the header use the same hidden picker with the exact project destination',async()=>{
    await project('source-empty');assert.equal(await evaluate(`document.querySelector('#projectCollection .kit-library-body')?.dataset.halaskaRoot`),'LibraryEmpty');
    await click('#projectAddSource');await click('#projectCollection .kit-library-body button');
    const calls=await evaluate('sourcePagePickerCalls');assert.deepEqual(calls,[{id:'projectLibraryInput',projectId:'source-empty',hidden:true},{id:'projectLibraryInput',projectId:'source-empty',hidden:true}]);
    assert.equal(await evaluate(`document.querySelector('#importDialog').open`),false);assert.equal(await evaluate(`state.imports.length`),6);assert.deepEqual(await evaluate('sourcePageAnalysisCalls'),[]);
    await input(SEARCH,'没有匹配');assert.equal(await evaluate(`document.querySelector('#projectCollection .kit-library-body button').textContent.trim()`),'清除筛选');await click('#projectCollection .kit-library-body button');assert.equal((await snapshot()).query,'');assert.equal(await evaluate('sourcePagePickerCalls.length'),2,'clearing filters must not trigger the file picker');
  });

  await check('actual toolbar and source actions wrap inside 1280, 800 and 440 pixel viewports',async()=>{
    await project('source-a');await input(SEARCH,'');await input(TYPE,'all');await click('#projectCollection [data-cui-view="list"]');
    for(const width of [1280,800,440]){
      win.setSize(width,880);await delay(90);await evaluate('WorkspaceLayout.refresh()');await paint();
      const result=await evaluate(`(() => {const box=selector=>{const node=document.querySelector(selector),r=node.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,scroll:node.scrollWidth,client:node.clientWidth};};return {width:innerWidth,page:document.documentElement.scrollWidth,toolbar:box('#projectCollection .kit-library-toolbar'),actions:box('#projectSourceActions'),collection:box('#projectCollection'),buttons:[...document.querySelectorAll('#projectCollection .kit-library-toolbar button,#projectCollection .kit-library-toolbar select,#projectSourceActions button')].filter(node=>node.getClientRects().length&&node.tabIndex!==-1).map(node=>{const r=node.getBoundingClientRect();return {text:node.textContent.trim(),left:r.left,right:r.right,width:r.width,disabled:node.disabled};})};})()`);
      observations.push({layout:result});assert.ok(result.page<=result.width+1,'page overflow at '+width);
      for(const key of ['toolbar','actions','collection']){assert.ok(result[key].scroll<=result[key].client+2,key+' horizontal overflow at '+width);assert.ok(result[key].left>=-1&&result[key].right<=result.width+1,key+' leaves viewport at '+width);}
      for(const button of result.buttons)assert.ok(button.width>0&&button.left>=-1&&button.right<=result.width+1,'control leaves viewport at '+width+': '+button.text);
      await screenshot(String(width));
    }
  });
  await check('fixture has no provider or analysis calls, user workspace access, external requests or renderer errors',async()=>{assert.deepEqual(await evaluate('sourcePageAnalysisCalls'),[]);assert.deepEqual(externalRequests,[]);assert.deepEqual(rendererErrors,[]);});
  return failures.length?1:0;
}
run().then(finish).catch(error=>{failures.push({name:'infrastructure',error:error.stack});console.error(error);void finish(1);});
