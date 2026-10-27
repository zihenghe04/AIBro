/* Full production app + Kit project navigation, using a fresh temporary server
 * store and Electron profile. No user workspace, provider or SSH is involved.
 * Run only after the parent's normal build:ui step; this script never builds.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results/project-tasks-schedule-20261001');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-project-tasks-'));
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
    scope: 'Full production App, task list/board/create/schedule and durable writes; synthetic records only.',
    excluded: 'No native acceptance, provider requests, SSH, real workspace or filesystem imports.',
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
    state.tasks=[{id:'deadline-task',title:'截止日期验收',projectId:'overview-project',workspace:'日常',dueAt:PlanningWorkbench.dateField(Date.now()),status:'todo',priority:'medium',checklist:[]},{id:'no-date-task',title:'未排期任务',projectId:'overview-project',workspace:'日常',status:'todo',priority:'low',checklist:[]},{id:'invalid-date-task',title:'异常日期任务',projectId:'overview-project',workspace:'日常',dueAt:'2026-02-30',status:'todo',priority:'medium',checklist:[]},{id:'private-task',title:'PRIVATE_TASK_NEVER',projectId:'overview-project',workspace:'日常',provenance:{origin:{private:true}},status:'todo',checklist:[]}];state.papers=[];state.trash=[];state.links=[];state.attachments=[];
    state.conversations=[{id:'overview-chat',title:'Synthetic source conversation',projectId:'overview-project',workspace:'日常',messages:[],attachments:[],draftAttachmentIds:[],draft:'Keep this draft.'}];
    state.agentRuns=[{id:'synthetic-output-run',projectId:'overview-project',conversationId:'overview-chat',status:'completed',finishedAt:200,results:[{type:'note',id:'output-note',operation:'created'}]},{id:'synthetic-no-output-run',projectId:'overview-project',conversationId:'overview-chat',status:'completed',finishedAt:100}];
    state.currentConversationId='overview-chat';state.currentProjectId='overview-project';state.ui.theme='light';state.ui.reducedMotion=true;
    normalizeStateShape(state);applyUiPreferences();renderAll();window.overviewSourceSnapshot=JSON.stringify({notes:state.notes,imports:state.imports});
    window.overviewOriginCalls=[];const originalOrigin=captureDocumentOrigin;captureDocumentOrigin=function(kind,id,navigation={}){const value=originalOrigin(kind,id,navigation);overviewOriginCalls.push({kind,id,exactAnchor:navigation.anchor===window.expectedOverviewAnchor,origin:value});return value;};
    window.overviewExplicitSaves=0;const originalSave=saveDocumentDurably;saveDocumentDurably=async function(...args){overviewExplicitSaves++;return originalSave(...args);};
  })()`);
  await go('tasks');
  await check('task root owns a continuous list with real Kit controls, correct dates and private exclusions',async()=>{
    const result=await evaluate(`({kit:document.querySelector('#projectTasks').dataset.halaskaRoot,text:document.querySelector('#projectTasks').textContent,rows:document.querySelectorAll('[data-board-task]').length,add:[...document.querySelectorAll('button')].filter(b=>b.getClientRects().length&&b.textContent.trim()==='添加任务').length})`);
    observations.push(result);assert.equal(result.kit,'ProjectBoard');assert.equal(result.rows,3);assert.equal(result.add,1);assert.doesNotMatch(result.text,/PRIVATE_TASK_NEVER|拖动卡片切换状态/);await screenshot('tasks-light');
  });
  await check('new task form uses actual Kit and persists only after a real local storage receipt',async()=>{
    await evaluate(`PlanningWorkbench.createTask({projectId:'overview-project'})`);await paint();
    assert.equal(await evaluate(`document.querySelector('#planningCreateSurface').dataset.halaskaRoot`),'TaskCreateForm');
    assert.equal(await evaluate(`document.querySelector('#taskCreateDetails')`),null);
    await input('#planningTaskTitle','新建任务 · 截止日期与保存验收');
    await click('[aria-controls=taskCreateDetails]');assert.equal(await evaluate(`document.querySelector('#planningCreateDialog').open`),true);assert.ok(await evaluate(`document.querySelector('#taskCreateDetails')?.getClientRects().length`));assert.equal(await evaluate(`document.querySelector('#planningTaskProject').value`),'overview-project');await click('[aria-controls=taskCreateDetails]');assert.equal(await evaluate(`document.querySelector('#taskCreateDetails')`),null);assert.equal(await evaluate(`document.querySelector('#planningTaskTitle').value`),'新建任务 · 截止日期与保存验收');
    const due=await evaluate('PlanningWorkbench.dateField(Date.now())');await input('#planningTaskDue',due);
    await click('#planningCreateSubmit');await until(()=>evaluate(`!document.querySelector('#planningCreateDialog').open`),'task creation receipt');
    const created=await evaluate(`state.tasks.find(task=>task.title==='新建任务 · 截止日期与保存验收')`);assert.ok(created?.id);assert.equal(created.dueAt,due);assert.equal(created.projectId,'overview-project');
    const saved=await evaluate(`fetch('/__state').then(r=>r.json()).then(data=>(data.state||data).tasks.find(task=>task.id===${JSON.stringify(created.id)}))`);assert.equal(saved?.title,created.title);
    await evaluate(`window.createdScheduleTaskId=${JSON.stringify(created.id)}`);
  });
  await check('schedule displays date-only tasks on their day and separates undated and invalid dates',async()=>{
    await go('schedule');
    const result=await evaluate(`({kit:document.querySelector('#projectSchedule').dataset.halaskaRoot,days:[...document.querySelectorAll('.schedule-day')].map(n=>n.textContent),text:document.querySelector('#projectSchedule').textContent,planOpen:document.querySelector('.project-plan-panel').open})`);observations.push(result);
    assert.equal(result.kit,'ProjectScheduleSurface');assert.ok(result.days.some(text=>text.includes('截止日期验收')&&text.includes('新建任务')));assert.match(result.text,/未排期任务/);assert.match(result.text,/异常日期任务/);assert.doesNotMatch(result.text,/PRIVATE_TASK_NEVER/);assert.equal(result.planOpen,false);assert.equal(await evaluate(`(()=>{const rows=[...document.querySelectorAll('.schedule-task-row')];return rows.every(row=>{const r=row.getBoundingClientRect(),c=row.querySelector('.schedule-task-copy').getBoundingClientRect();return c.top>=r.top&&c.bottom<=r.bottom;});})()`),true);await screenshot('schedule-light');
  });
  await check('plan text survives same-project refresh and project round trip, then saves durably',async()=>{
    await click('.project-plan-panel > summary');
    await evaluate(String.raw`(()=>{const el=document.querySelector('[data-plan-input]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'# 合成计划\n\n计划输入保留验证');el.dispatchEvent(new Event('input',{bubbles:true}));window.planInputBeforeRefresh=el;})()`);await paint();
    await evaluate(`renderProject('overview-project')`);await paint();
    assert.equal(await evaluate(`document.querySelector('[data-plan-input]')===planInputBeforeRefresh`),true);assert.equal(await evaluate(`document.querySelector('[data-plan-input]').value`),'# 合成计划\n\n计划输入保留验证');
    await go('schedule','empty-project');assert.equal(await evaluate(`document.querySelector('[data-plan-input]')?.value||''`),'');
    await go('schedule');if(!await evaluate(`document.querySelector('.project-plan-panel').open`))await click('.project-plan-panel > summary');
    assert.equal(await evaluate(`document.querySelector('[data-plan-input]').value`),'# 合成计划\n\n计划输入保留验证');
    await click('[data-plan-save]');await until(()=>evaluate(`!ProjectSchedule.isBusy()&&!ProjectSchedule.isDirty()`),'project plan save');
    const value=await evaluate(`fetch('/__state').then(r=>r.json()).then(data=>(data.state||data).projects.find(p=>p.id==='overview-project').plan)`);assert.equal(value,'# 合成计划\n\n计划输入保留验证');
  });
  await check('task detail updates preserve schedule origin and wait for durable save',async()=>{
    await evaluate(`openTask(createdScheduleTaskId,{origin:{view:'project',projectId:'overview-project',section:'schedule'}})`);await paint();
    assert.equal(await evaluate(`taskDocumentOrigin().entry.section`),'schedule');
    await input('#taskTitleInput','已编辑任务 · 原生排期准备');await click('#saveTask');await until(()=>evaluate(`!document.querySelector('#taskDialog').open&&!saveTaskDetails.busy`),'task detail receipt');
    const value=await evaluate(`fetch('/__state').then(r=>r.json()).then(data=>(data.state||data).tasks.find(t=>t.id===createdScheduleTaskId).title)`);assert.equal(value,'已编辑任务 · 原生排期准备');
  });
  await check('list and board share guarded status actions; missing deliverable cannot be marked done',async()=>{
    await go('tasks');await evaluate(`(()=>{const b=[...document.querySelectorAll('#projectTasks button')].find(b=>b.textContent==='看板');b.click();})()`);await paint();
    assert.equal(await evaluate(`document.querySelectorAll('#projectTasks .project-board-column').length`),4);
    await evaluate(`(()=>{const el=document.querySelector('[data-task-status-select="deadline-task"]');el.value='in_progress';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);await until(()=>evaluate(`!ProjectBoard.isBusy()`),'status receipt');assert.equal(await evaluate(`state.tasks.find(t=>t.id==='deadline-task').status`),'in_progress');
    await evaluate(`state.tasks.find(t=>t.id==='deadline-task').deliverable={kind:'note',ref:'missing'};ProjectBoard.render('overview-project');`);
    await evaluate(`(()=>{const el=document.querySelector('[data-task-status-select="deadline-task"]');el.value='done';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);await paint();
    assert.equal(await evaluate(`state.tasks.find(t=>t.id==='deadline-task').status`),'in_progress');await screenshot('board-light');
  });
  await check('light dark narrow surfaces keep content and primary actions within their work area',async()=>{
    for(const [theme,width] of [['light',1280],['dark',680],['light',440]])for(const section of ['tasks','schedule']){
      win.setContentSize(width,880);await evaluate(`state.ui.theme=${JSON.stringify(theme)};state.ui.reducedMotion=true;applyUiPreferences();`);await go(section);
      const selector=section==='tasks'?'#projectTasks':'#projectSchedule';
      const layout=await evaluate(`(()=>{const host=document.querySelector(${JSON.stringify(selector)}),r=host.getBoundingClientRect();return {width:innerWidth,page:document.documentElement.scrollWidth,host:{left:r.left,right:r.right,scroll:host.scrollWidth,client:host.clientWidth}};})()`);observations.push({theme,width,section,layout});assert.ok(layout.page<=layout.width+1);assert.ok(layout.host.scroll<=layout.host.client+2);await screenshot(section+'-'+theme+'-'+width);
    }
  });
  await check('all changes stay local to synthetic tasks and plan, without provider requests or renderer errors',async()=>{
    assert.deepEqual(rendererErrors,[]);assert.deepEqual(externalRequests,[]);assert.equal(await evaluate(`JSON.stringify({notes:state.notes,imports:state.imports})===overviewSourceSnapshot`),true);assert.equal(await evaluate(`state.conversations.find(item=>item.id==='overview-chat').draft`),'Keep this draft.');
  });
  return failures.length?1:0;
}
run().then(finish).catch(error=>{failures.push({name:'infrastructure',error:error.stack});console.error(error);void finish(1);});
