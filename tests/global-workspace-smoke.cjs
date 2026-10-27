/* Production renderer and real local draft service. No model calls or user store. */
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'test-results/global-workspace-20260930/renderer'),TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-global-workspace-')),STORE=path.join(TEMP,'store');
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
 await check('all three spaces start with projects and show only the requested panel',async()=>{
  for(const view of ['daily','courses','research']){await evaluate(`navigateWorkspaceView('${view}')`);assert.equal(await evaluate(`state.ui.spaceTabs.${view}`),'projects');assert.deepEqual(await evaluate(`[...document.querySelectorAll('#${view} [data-space-panel]')].filter(p=>!p.hidden).map(p=>p.dataset.spacePanel)`),['projects']);}
 });
 await check('knowledge and tasks have distinct real controls without mixed records',async()=>{
  await evaluate('navigateWorkspaceView("courses",{section:"tasks"})');assert.ok(await evaluate('document.querySelector("#coursesTaskCollection").textContent.includes("检查课程材料")'));
  await evaluate('navigateWorkspaceView("research",{section:"knowledge"})');assert.ok(await evaluate('document.querySelector("#researchCollection [data-halaska-root]") !== null'));assert.match(await evaluate('document.querySelector("#researchCollection").textContent'),/原始阅读笔记/);assert.doesNotMatch(await evaluate('document.querySelector("#researchCollection").textContent'),/检查课程材料/);
  await shot('research-knowledge');
 });
 await check('space breadcrumb returns to remembered section and workspace crumb uses host route',async()=>{
  await evaluate('openProject("nav-alpha",{section:"outputs"})');await click('#workspaceBreadcrumbs button:nth-of-type(2)');await until(()=>evaluate('document.body.dataset.view==="research"'),'space crumb');assert.equal(await evaluate('state.ui.spaceTabs.research'),'knowledge');
  await evaluate('openProject("nav-alpha")');await evaluate('window.__hostDestinations=[];window.workstationDesktop={navigateWorkspace:async d=>{window.__hostDestinations.push(d);return true;}};true');await click('#workspaceBreadcrumbs button:first-child');assert.deepEqual(await evaluate('window.__hostDestinations'),[{view:'overview'}]);await evaluate('delete window.workstationDesktop');
  assert.equal(await evaluate('document.querySelector("#workspaceConversationsToggle").textContent'),'切换对话');
 });
 await check('explicit space new-chat never reassigns existing project chat',async()=>{
  const before=await evaluate('state.conversations.find(c=>c.id==="nav-chat-a").projectId');await evaluate('navigateWorkspaceNewConversation("courses")');assert.equal(await evaluate('currentConversation().workspace'),'课程');assert.equal(await evaluate('currentConversation().projectId'),null);assert.equal(await evaluate('state.conversations.find(c=>c.id==="nav-chat-a").projectId'),before);
 });
 await check('failed real route gate preserves visible document and space memory',async()=>{
  await evaluate('openPreview("note","nav-result")');await evaluate('window.__before=beforePreviewSwitch;beforePreviewSwitch=async()=>false;true');
  try{assert.equal(await evaluate('navigateWorkspaceView("daily",{section:"tasks"})'),false);assert.equal(await evaluate('navigateWorkspaceNewConversation("daily")'),false);assert.equal(await evaluate('ReadingPane.isActive("note","nav-result")'),true);assert.equal(await evaluate('state.ui.spaceTabs.daily'),'projects');}
  finally{await evaluate('beforePreviewSwitch=window.__before;delete window.__before');}
 });
 await check('space section memories survive durable reload independently',async()=>{
  await evaluate('navigateWorkspaceView("courses",{section:"tasks"})');await evaluate('saveDocumentDurably()');await win.reload();await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'reload');
  await evaluate('navigateWorkspaceView("research")');assert.equal(await evaluate('state.ui.spaceTabs.research'),'knowledge');await evaluate('navigateWorkspaceView("courses")');assert.equal(await evaluate('state.ui.spaceTabs.courses'),'tasks');
 });
 await check('archived parent sources disappear from space collections',async()=>{
  await evaluate('state.projects.find(p=>p.id==="nav-alpha").archivedAt=Date.now();navigateWorkspaceView("research",{section:"knowledge"})');assert.doesNotMatch(await evaluate('document.querySelector("#researchCollection").textContent'),/原始阅读笔记/);await evaluate('delete state.projects.find(p=>p.id==="nav-alpha").archivedAt');
 });
 await check('native-header marker removes duplicate tabs while preserving actual content and narrow layout',async()=>{
  await evaluate('document.body.classList.add("aibro-native","aibro-native-space-navigation");navigateWorkspaceView("research",{section:"knowledge"})');win.setSize(820,880);await wait(100);
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#research .space-tabs")).display'),'none');assert.equal(await evaluate('document.querySelector("#researchCollection").getBoundingClientRect().width>0'),true);await evaluate('state.ui.theme="dark";applyUiPreferences()');await shot('research-knowledge-dark-narrow');
 });
 await finish(failures.length||rendererErrors.length?1:0);
})().catch(e=>{failures.push({label:'fatal',error:e.stack});console.error(e);void finish(1);});
