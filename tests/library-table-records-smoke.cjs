/* Full production app + Kit project navigation, using a fresh temporary server
 * store and Electron profile. No user workspace, provider or SSH is involved.
 * Run only after the parent's normal build:ui step; this script never builds.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results/library-table-records-20261001');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-library-table-records-'));
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
  await paint(); fs.writeFileSync(path.join(OUT, 'library-' + name + '.png'), (await win.webContents.capturePage()).toPNG());
}
function report() {
  fs.writeFileSync(path.join(OUT, 'renderer-report.json'), JSON.stringify({ passed: checks.length, checks, failures, observations, rendererErrors, externalRequests,
    scope: 'Full production app and actual Kit DataTable, project scope controls and overview record actions; synthetic records only.',
    excluded: 'No native acceptance, provider requests, SSH, real workspace, document mutation or filesystem imports. Only two entry-specific reader routes verify actual clicked anchors.',
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
const SEARCH='#projectCollection [data-cui-search]',TYPE='#projectCollection select[data-cui-type]';
const row=key=>'#projectCollection tr[data-cui-key='+JSON.stringify(key)+']';
const scope=value=>'#projectLibraryNavigation button[data-project-library-scope='+JSON.stringify(value)+']';
const folder=value=>'#projectLibraryNavigation [data-project-library-folder='+JSON.stringify(value)+']';
const visibleKeys=()=>evaluate(`[...document.querySelectorAll('#projectCollection tr[data-cui-key]')].map(row=>row.dataset.cuiKey)`);
const selectedKeys=()=>evaluate(`[...document.querySelectorAll('#projectCollection tr[data-cui-key]')].filter(row=>row.querySelector('[data-cui-check]')?.checked).map(row=>row.dataset.cuiKey).sort()`);
async function project(section='knowledge') {assert.equal(await evaluate(`WorkspaceNavigation.go(${JSON.stringify(section)},'table-project')`),true);await paint();}
async function input(selector,value){
  await evaluate(`(() => {const target=document.querySelector(${JSON.stringify(selector)});if(!target||!target.getClientRects().length||target.disabled)throw Error('Unavailable input');const prototype=target.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(target,${JSON.stringify(value)});target.dispatchEvent(new Event(target.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);await paint();
}
async function keyActivate(selector,key='Enter') {
  // Electron requires a focused BrowserWindow for sendInputEvent. A DOM focus
  // in show:false is insufficient; exercise native keyboard default activation.
  win.show();win.focus();win.webContents.focus();
  await until(async()=>win.isFocused()&&await evaluate('document.hasFocus()'),'focused keyboard test window');
  await evaluate(`(() => {const button=document.querySelector(${JSON.stringify(selector)});if(!button||button.disabled||!button.getClientRects().length)throw Error('Unavailable keyboard control');button.focus();window.tableKeyEvents=[];window.tableKeyCleanup?.();const observe=event=>{const matches=event.target===button;queueMicrotask(()=>tableKeyEvents.push({type:event.type,key:event.key||'',trusted:event.isTrusted,targetMatches:matches,prevented:event.defaultPrevented}));};for(const type of ['keydown','keyup','click'])document.addEventListener(type,observe,true);window.tableKeyCleanup=()=>{for(const type of ['keydown','keyup','click'])document.removeEventListener(type,observe,true);};})()`);
  assert.equal(await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`),true,'target owns DOM focus before keyboard dispatch');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:key});
  if(key==='Enter')win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:key});await delay(50);await paint();
  const delivered=await evaluate('tableKeyCleanup();tableKeyEvents');observations.push({keyboard:{selector,key,delivered}});
  assert.ok(delivered.some(event=>event.type==='keydown'&&event.trusted&&event.targetMatches),'trusted keyboard event reaches the actual sort button');
  assert.ok(delivered.some(event=>event.type==='click'&&event.trusted&&event.targetMatches),'native keyboard activation produces its trusted click');
}

async function rootFolder(){await click('#projectLibraryNavigation [data-project-library-all]');}
async function scopes(){return evaluate(`Object.fromEntries([...document.querySelectorAll('#projectLibraryNavigation button[data-project-library-scope]')].map(button=>[button.dataset.projectLibraryScope,{text:button.textContent.trim(),checked:button.getAttribute('aria-checked')}]))`);}
async function run(){
  const port=await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',reject);probe.listen(0,'127.0.0.1',()=>{const value=probe.address().port;probe.close(()=>resolve(value));});});origin='http://127.0.0.1:'+port;
  const log=fs.openSync(path.join(OUT,'renderer-server.log'),'w');server=spawn('python3',[path.join(ROOT,'app/server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(port),AI_WORKSTATION_DATA_DIR:STORE},stdio:['ignore',log,log]});fs.closeSync(log);
  await until(()=>new Promise(resolve=>http.get(origin+'/__health',response=>{response.resume();resolve(response.statusCode===200);}).on('error',()=>resolve(false))),'isolated server');
  await app.whenReady();win=new BrowserWindow({show:false,width:1280,height:880,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(request,done)=>{const url=new URL(request.url),allowed=url.origin===origin&&!/^\/__(?:proxy|codex\/respond|cloud\/connect|auth\/(?!status(?:$|\?)|models\?(?:[^#]*&)?cacheonly)|local\/)/.test(url.pathname+url.search);if(!allowed)externalRequests.push(request.url);done({cancel:!allowed});});
  win.webContents.on('console-message',event=>{if(event.level==='error')rendererErrors.push(event.message);});
  await win.loadURL(origin);await until(()=>evaluate(`typeof storageHydrated!=='undefined'&&storageHydrated`),'workspace hydration');
  assert.equal(await evaluate(`['LibraryDataTable','ProjectMemoryActions','ProjectLibraryNavigation'].every(name=>HalaskaUI.componentNames.includes(name))`),true,'Build current production Kit bundle first');
  await evaluate(`(() => {
    WorkstationOnboarding.close();WorkspaceTour.close();state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};state.ui.workspaceTour={version:WorkspaceTour.VERSION,status:'skipped'};
    state.projects=[{id:'table-project',name:'资料与项目记录（合成验收）',workspace:'日常'}];
    const note=(id,title,folderPath,updatedAt,extra={})=>({id,title,folderPath,projectId:'table-project',workspace:'日常',kind:'note',content:'# '+title+'\\n\\nApproved fixture body '+id,sourceAttachmentIds:[],createdAt:1,updatedAt,...extra});
    state.notes=[note('shared','A user note','shared',10),note('content-b','B second note','elsewhere',20),note('unknown-kind','C custom record','shared',30,{projectMemoryType:'custom'}),note('named-folder','D manual 项目记忆 note','项目记忆',40),note('pending-doc','Z 待审阅的长标题用于验证窄窗资料列表仍能清晰阅读与保留状态'.repeat(3),'shared',60,{aiDraft:{content:'Unapproved synthetic proposal',createdAt:61}}),note('record-long','Long project memory','context',9991,{projectMemoryType:'long',content:'Approved project memory body: PUBLIC_RECORD_NEEDLE'}),note('record-plan','Plan project record','shared',9992,{projectMemoryType:'plan',aiDraft:{content:'Not approved plan text',createdAt:9994}}),note('record-daily','Daily project journal','项目记忆/日记',9993,{projectMemoryType:'daily'}),note('private-record','PRIVATE_RECORD_TITLE','private-record-folder',9999,{projectMemoryType:'daily',sourceConversationId:'private-chat'}),note('ambiguous-record','AMBIGUOUS_RECORD_TITLE','ambiguous-folder',9999),note('ambiguous-record','AMBIGUOUS_RECORD_TITLE','ambiguous-folder',9999)];
    state.imports=[{id:'shared',name:'E shared-id source.txt',folderPath:'shared',projectId:'table-project',workspace:'日常',mimeType:'text/plain',status:'parsed',parser:'text',content:'An independent original with same id as a note',updatedAt:15},{id:'source-f',name:'F second original.txt',folderPath:'elsewhere',projectId:'table-project',workspace:'日常',mimeType:'text/plain',status:'parsed',parser:'text',content:'Second original',updatedAt:25}];
    state.tasks=[];state.papers=[];state.trash=[];state.links=[];state.attachments=[];state.agentRuns=[];state.conversations=[{id:'table-chat',title:'Unchanged synthetic conversation',projectId:'table-project',workspace:'日常',messages:[],attachments:[],draftAttachmentIds:[],draft:'Keep this draft unchanged.'},{id:'private-chat',private:true,projectId:'table-project',messages:[]}];
    state.currentConversationId='table-chat';state.currentProjectId='table-project';state.ui.projectLibraryFolders={};state.ui.projectLibraryExpansion={};state.ui.projectLibraryLocations={};state.ui.projectLibraryScopes={};state.ui.projectCollectionPreferences={};state.ui.workspaceNavigation={projects:{}};state.ui.theme='light';state.ui.reducedMotion=true;
    normalizeStateShape(state);applyUiPreferences();renderAll();window.tableFixtureNotes=JSON.stringify(state.notes);window.tableFixtureDraft=state.conversations.find(item=>item.id==='table-chat').draft;
    window.tableOriginCalls=[];const originalOrigin=captureDocumentOrigin;captureDocumentOrigin=function(kind,id,navigation={}){const value=originalOrigin(kind,id,navigation);tableOriginCalls.push({kind,id,exactAnchor:navigation.anchor===window.tableExpectedAnchor,origin:value});return value;};
    window.tableExplicitSaves=0;const originalSave=saveDocumentDurably;saveDocumentDurably=async function(...args){tableExplicitSaves++;return originalSave(...args);};
  })()`);
  await project();

  await check('default scope displays real Kit DataTable user materials, leaving three known project record kinds discoverable',async()=>{
    const meta=await evaluate(`({owner:document.querySelector('#projectCollection table')?.closest('[data-halaska-root]')?.dataset.halaskaRoot,tableLabel:document.querySelector('#projectCollection table')?.getAttribute('aria-label'),scope:document.querySelector('#projectLibraryNavigation nav').dataset.projectLibraryScope,treeCount:document.querySelector('#projectTreeCount').textContent,text:document.querySelector('#projectCollection').textContent,folderText:document.querySelector('#projectLibraryNavigation').textContent})`);
    assert.equal(meta.owner,'LibraryDataTable');assert.equal(meta.tableLabel,'项目资料');assert.equal(meta.scope,'content');assert.match(meta.treeCount,/7/);assert.doesNotMatch(meta.text+meta.folderText,/PRIVATE_RECORD_TITLE|AMBIGUOUS_RECORD_TITLE|private-record-folder|ambiguous-folder/);
    const choices=await scopes();assert.match(choices.content.text,/资料\s*7/);assert.match(choices.records.text,/记录\s*3/);assert.match(choices.all.text,/全部\s*10/);assert.equal(choices.content.checked,'true');
    assert.deepEqual((await visibleKeys()).sort(),['import:shared','import:source-f','note:content-b','note:named-folder','note:pending-doc','note:shared','note:unknown-kind']);
    assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(folder('项目记忆'))})`),true,'user-named folders are not hidden by heuristic');observations.push({initial:meta,choices});
  });

  await check('content, project records and all have consistent folder counts and independently restore their selected paths',async()=>{
    await click(folder('shared'));assert.deepEqual((await visibleKeys()).sort(),['import:shared','note:pending-doc','note:shared','note:unknown-kind']);
    await click(scope('records'));assert.deepEqual((await visibleKeys()).sort(),['note:record-daily','note:record-long','note:record-plan']);assert.equal(await evaluate(`document.querySelector('#projectCollection [data-cui-pending]')`),null);
    assert.equal(await evaluate(`document.querySelector('#projectSourceActions').hidden`),true);await click(folder('shared'));assert.deepEqual(await visibleKeys(),['note:record-plan']);
    assert.match(await evaluate(`document.querySelector(${JSON.stringify(row('note:record-plan'))}).textContent`),/待审阅/);
    await click(scope('all'));assert.equal((await visibleKeys()).length,10);await click(folder('shared'));assert.equal((await visibleKeys()).length,5);
    await click(scope('content'));assert.equal(await evaluate(`state.ui.projectLibraryFolders['table-project']`),'shared');assert.equal((await visibleKeys()).length,4);
    await click(scope('records'));assert.equal(await evaluate(`state.ui.projectLibraryFolders['table-project']`),'shared');assert.deepEqual(await visibleKeys(),['note:record-plan']);
    assert.equal(await evaluate(`JSON.stringify(state.notes)===tableFixtureNotes`),true,'scope navigation must not rewrite notes or folderPath');
    await click(scope('content'));await rootFolder();
  });

  await check('changing scope retires an unfinished Chinese IME input while retaining only the committed search',async()=>{
    await input(SEARCH,'A user');await evaluate(`(() => {const input=document.querySelector(${JSON.stringify(SEARCH)});window.tableOldSearch=input;input.focus();input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'未提交范围候选');input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'未提交范围候选',inputType:'insertCompositionText',isComposing:true}));})()`);
    await click(scope('records'));assert.equal(await evaluate(`tableOldSearch.isConnected`),false);assert.equal(await evaluate(`document.querySelector(${JSON.stringify(SEARCH)}).value`),'A user');
    await evaluate(`tableOldSearch.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'未提交范围候选'}));`);await paint();assert.equal(await evaluate(`document.querySelector(${JSON.stringify(SEARCH)}).value`),'A user');assert.equal(await evaluate(`state.ui.projectCollectionPreferences['table-project'].query`),'A user');
    await input(SEARCH,'');await click(scope('content'));await rootFolder();assert.equal(await evaluate(`document.querySelector(${JSON.stringify(SEARCH)}).value`),'');
  });

  await check('real native header buttons sort by keyboard, expose aria-sort and preserve their focus',async()=>{
    await input(TYPE,'all');await click('#projectCollection [data-cui-view="list"]');
    const name='#projectCollection th[data-column="name"] > button';await keyActivate(name);
    assert.equal(await evaluate(`document.querySelector('#projectCollection th[data-column="name"]').getAttribute('aria-sort')`),'ascending');
    const ascending=['note:shared','note:content-b','note:unknown-kind','note:named-folder','import:shared','import:source-f','note:pending-doc'];assert.deepEqual(await visibleKeys(),ascending);
    assert.equal(await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(name)})`),true);await keyActivate(name,'Space');assert.deepEqual(await visibleKeys(),[...ascending].reverse());assert.equal(await evaluate(`document.querySelector('#projectCollection th[data-column="name"]').getAttribute('aria-sort')`),'descending');
    assert.equal(await evaluate(`document.querySelector('#projectCollection th[data-column="status"] button')`),null);
    await keyActivate('#projectCollection th[data-column="updated"] > button');assert.equal(await evaluate(`document.querySelector('#projectCollection th[data-column="updated"]').getAttribute('aria-sort')`),'descending');assert.match(await evaluate(`document.querySelector('#projectCollection [data-cui-sort]').textContent`),/更新时间\s*↓/);
  });

  await check('typed ids keep note/source selection independent through insertion, same-row refresh and filtering',async()=>{
    await click(row('note:shared')+' [data-cui-check]');assert.deepEqual(await selectedKeys(),['note:shared']);assert.equal(await evaluate(`document.querySelector(${JSON.stringify(row('import:shared')+' [data-cui-check]')}).checked`),false);
    const before=await evaluate(`(() => {const row=document.querySelector(${JSON.stringify(row('note:shared'))}),input=row.querySelector('[data-cui-check]');input.focus();window.tableStableRow=row;window.tableStableInput=input;window.tableStableRoot=document.querySelector('#projectCollection table');return input.checked;})()`);assert.equal(before,true);
    await evaluate(`state.notes.push({id:'inserted',title:'00 new user note',folderPath:'shared',projectId:'table-project',workspace:'日常',kind:'note',content:'A new synthetic note',createdAt:1,updatedAt:10000});renderProject('table-project');`);await paint();
    const refreshed=await evaluate(`({sameTable:tableStableRoot===document.querySelector('#projectCollection table'),sameRow:tableStableRow===document.querySelector(${JSON.stringify(row('note:shared'))}),sameInput:tableStableInput===document.querySelector(${JSON.stringify(row('note:shared')+' [data-cui-check]')}),focused:document.activeElement===tableStableInput,mixed:document.querySelector('#projectCollection [data-cui-all]').indeterminate,ariaMixed:document.querySelector('#projectCollection [data-cui-all]').getAttribute('aria-checked')})`);
    observations.push({refresh:refreshed});assert.equal(refreshed.sameTable&&refreshed.sameRow&&refreshed.sameInput&&refreshed.focused,true);assert.equal(refreshed.mixed,true);assert.equal(refreshed.ariaMixed,'mixed');assert.deepEqual(await selectedKeys(),['note:shared']);assert.match((await scopes()).content.text,/资料\s*8/);
    await input(SEARCH,'E shared-id');assert.deepEqual(await visibleKeys(),['import:shared']);assert.deepEqual(await selectedKeys(),[]);assert.equal(await evaluate(`document.querySelector('#projectCollection .kit-library-batch')`),null);
    await input(SEARCH,'');await click('#projectCollection [data-cui-all]');assert.equal((await selectedKeys()).length,8);assert.equal(await evaluate(`document.querySelector('#projectCollection [data-cui-all]').indeterminate`),false);await click('#projectCollection [data-cui-all]');assert.deepEqual(await selectedKeys(),[]);
  });

  await check('a real Kit row button forwards its exact anchor into the source reader and returns to the same collection',async()=>{
    await evaluate(`window.tableExpectedAnchor=document.querySelector(${JSON.stringify(row('note:shared')+' [data-cui-open]')});tableOriginCalls=[];`);await click(row('note:shared')+' [data-cui-open]');
    await until(()=>evaluate(`ReadingPane.isActive('note','shared')&&ReadingPane.snapshot().visible`),'table document open');await until(()=>evaluate(`document.querySelector('#previewContent')?.textContent.includes('Approved fixture body shared')`),'actual source body');
    const route=await evaluate(`({call:tableOriginCalls.find(item=>item.id==='shared'),tab:ReadingPane.snapshot().tabs.find(tab=>tab.kind==='note'&&tab.id==='shared')})`);assert.equal(route.call.exactAnchor,true);assert.deepEqual(route.tab.origin,{view:'project',projectId:'table-project',section:'knowledge'});assert.equal(await evaluate('tableExplicitSaves'),0);
    await click('#readingBack');await until(()=>evaluate(`document.body.dataset.view==='project'&&state.ui.projectTab==='knowledge'&&!ReadingPane.snapshot().visible`),'return to collection');assert.equal(await evaluate(`!!document.querySelector('#projectCollection table')`),true);
  });

  await check('cold-start overview mounts real Kit record actions and opens existing approved memory without saving',async()=>{
    await project('overview');const result=await evaluate(`({attached:document.querySelector('#projectMemoryControls')?.isConnected,panel:document.querySelector('#projectMemoryControls')?.closest('[data-project-panel]')?.dataset.projectPanel,owner:document.querySelector('#projectMemoryControls')?.dataset.halaskaRoot,text:document.querySelector('#projectMemoryControls')?.textContent,oldBanner:!!document.querySelector('#projectLocalSummary')})`);assert.equal(result.attached,true);assert.equal(result.panel,'overview');assert.equal(result.owner,'ProjectMemoryActions');assert.equal(result.oldBanner,false);assert.match(result.text,/项目记忆.*计划与产出.*进展日记/s);
    await evaluate(`window.tableExpectedAnchor=[...document.querySelectorAll('#projectMemoryControls button')].find(button=>button.textContent.trim()==='项目记忆');tableOriginCalls=[];window.tableMemorySaveBaseline=tableExplicitSaves;tableExpectedAnchor.click();`);await paint();await until(()=>evaluate(`ReadingPane.isActive('note','record-long')&&ReadingPane.snapshot().visible`),'overview record open');await until(()=>evaluate(`document.querySelector('#previewContent')?.textContent.includes('PUBLIC_RECORD_NEEDLE')`),'approved record body');
    assert.equal(await evaluate(`tableOriginCalls.find(item=>item.id==='record-long')?.exactAnchor`),true);assert.equal(await evaluate(`tableExplicitSaves===tableMemorySaveBaseline`),true);await click('#readingBack');await until(()=>evaluate(`!ReadingPane.snapshot().visible`),'close overview reader');observations.push({overview:result});
  });

  await check('public project records remain searchable while private and ambiguous records expose no result',async()=>{
    const result=await evaluate(`({record:searchEntities('PUBLIC_RECORD_NEEDLE').map(row=>({type:row.type,id:row.id})),privateRows:searchEntities('PRIVATE_RECORD_TITLE'),ambiguousRows:searchEntities('AMBIGUOUS_RECORD_TITLE')})`);assert.deepEqual(result.record,[{type:'note',id:'record-long'}]);assert.deepEqual(result.privateRows,[]);assert.deepEqual(result.ambiguousRows,[]);
  });

  await check('workspace-wide real Kit table keeps public rows, typed selection and the actual project callback',async()=>{
    await evaluate(`(() => {const host=document.createElement('div');host.id='workspaceTableFixture';host.style.cssText='position:fixed;inset:72px 24px 24px;z-index:9999;overflow:auto;background:var(--panel);padding:16px;';document.body.append(host);window.workspaceTableProjectCalls=[];window.workspaceOriginalOpenProject=openProject;CollectionUI.init({openProject:id=>{workspaceTableProjectCalls.push(id);return workspaceOriginalOpenProject(id);}});CollectionUI.render(host,{workspace:'日常',types:['note','import','paper']});})()`);await paint();
    try{
      const meta=await evaluate(`({owner:document.querySelector('#workspaceTableFixture table')?.closest('[data-halaska-root]')?.dataset.halaskaRoot,label:document.querySelector('#workspaceTableFixture table')?.getAttribute('aria-label'),projectHeader:document.querySelector('#workspaceTableFixture th[data-column="project"]')?.textContent,text:document.querySelector('#workspaceTableFixture').textContent,keys:[...document.querySelectorAll('#workspaceTableFixture tr[data-cui-key]')].map(row=>row.dataset.cuiKey)})`);
      assert.equal(meta.owner,'LibraryDataTable');assert.equal(meta.label,'知识与资料');assert.match(meta.projectHeader,/归属项目/);assert.doesNotMatch(meta.text,/PRIVATE_RECORD_TITLE|AMBIGUOUS_RECORD_TITLE/);assert.ok(meta.keys.includes('note:shared')&&meta.keys.includes('import:shared'));
      await click('#workspaceTableFixture tr[data-cui-key="note:shared"] [data-cui-check]');assert.equal(await evaluate(`document.querySelector('#workspaceTableFixture tr[data-cui-key="note:shared"] [data-cui-check]').checked`),true);assert.equal(await evaluate(`document.querySelector('#workspaceTableFixture tr[data-cui-key="import:shared"] [data-cui-check]').checked`),false);
      await click('#workspaceTableFixture tr[data-cui-key="note:shared"] [data-cui-project]');assert.deepEqual(await evaluate('workspaceTableProjectCalls'),['table-project']);assert.equal(await evaluate('state.currentProjectId'),'table-project');observations.push({workspaceTable:meta});
    }finally{await evaluate(`(() => {const host=document.querySelector('#workspaceTableFixture');for(const island of host.querySelectorAll('[data-halaska-root]'))HalaskaUI.unmount(island);host.remove();CollectionUI.init({openProject:workspaceOriginalOpenProject});})()`);}
  });

  await check('real table, scope and status stay readable without horizontal overflow at 1280/800/440 in both themes',async()=>{
    await project();await click(scope('content'));await rootFolder();await input(SEARCH,'');await input(TYPE,'all');await click('#projectCollection [data-cui-view="list"]');
    for(const [width,theme]of [[1280,'light'],[800,'light'],[440,'light'],[1280,'dark'],[800,'dark'],[440,'dark']]){
      win.setSize(width,880);await delay(80);await evaluate(`state.ui.theme=${JSON.stringify(theme)};applyUiPreferences();WorkspaceLayout.refresh();`);await paint();
      const layout=await evaluate(`(() => {const box=selector=>{const node=document.querySelector(selector),r=node.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,scroll:node.scrollWidth,client:node.clientWidth};};const pending=document.querySelector(${JSON.stringify(row('note:pending-doc')+' .library-data-status')}),name=document.querySelector(${JSON.stringify(row('note:pending-doc')+' .library-data-name strong')}),nr=name.getBoundingClientRect(),status=pending.getBoundingClientRect();return {width:innerWidth,page:document.documentElement.scrollWidth,nav:box('#projectLibraryNavigation'),toolbar:box('#projectCollection .kit-library-toolbar'),table:box('#projectCollection table'),tableContainer:box('#projectCollection .library-data-table'),pending:{text:pending.textContent,display:getComputedStyle(pending).display,width:status.width,left:status.left,right:status.right},title:{width:nr.width,right:nr.right,scroll:name.scrollWidth,client:name.clientWidth},nameHeader:box('#projectCollection th[data-column="name"]'),statusHeader:box('#projectCollection th[data-column="status"]'),tableColor:getComputedStyle(document.querySelector('#projectCollection table')).color,bg:getComputedStyle(document.body).backgroundColor,reducedMotion:state.ui.reducedMotion};})()`);
      observations.push({theme,layout});assert.ok(layout.page<=layout.width+1,'page overflow '+width+' '+theme);for(const part of ['nav','toolbar','table','tableContainer']){assert.ok(layout[part].scroll<=layout[part].client+2,part+' horizontal overflow '+width+' '+theme);assert.ok(layout[part].left>=-1&&layout[part].right<=layout.width+1,part+' viewport overflow '+width+' '+theme);}
      assert.ok(layout.pending.width>0&&layout.pending.display!=='none');assert.match(layout.pending.text,/待审阅/);assert.ok(layout.title.width>0&&layout.title.right<=layout.pending.left+2,'title/status overlap');assert.ok(layout.nameHeader.width>0&&layout.statusHeader.width>0);assert.equal(layout.reducedMotion,true);await screenshot(theme+'-'+width);
    }
  });
  await check('no renderer errors or prohibited requests and synthetic draft remains unchanged',async()=>{assert.deepEqual(rendererErrors,[]);assert.deepEqual(externalRequests,[]);assert.equal(await evaluate(`state.conversations.find(item=>item.id==='table-chat').draft===tableFixtureDraft`),true);assert.equal(await evaluate('state.agentRuns.length'),0);});
  return failures.length?1:0;
}
run().then(finish).catch(error=>{failures.push({name:'infrastructure',error:error.stack});console.error(error);void finish(1);});
