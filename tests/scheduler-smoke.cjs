/* M1 调度器冒烟：真实 server.py（隔离数据目录）+ 本机假模型（OpenAI 兼容，脚本化回复，
   不出网）+ 隐藏的 kernel.html（代替原生壳里的隐藏 WKWebView）和主窗口 index.html。覆盖：
   1. 只读范围的自动任务：调度器到点提交后台运行 → 读项目 → mark_task_done → 执行记录“已完成”，单次任务结束；
   2. 越界：只读范围的任务要写入 → 暂停“待你批准”（理由 out-of-scope，通知标记越界）→ 主窗口批准 → 写入落盘 → 完成；
   3. 没调用 mark_task_done → “未通过完成验收”，任务暂停；
   4. 无人值守系统规则、工具清单（有 mark_task_done）只给计划任务。
   运行：node_modules/.bin/electron tests/scheduler-smoke.cjs */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),HOST_TOKEN='k'.repeat(64);
let PORT=0,ORIGIN='';
const TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aw-scheduler-smoke-')),STORE=path.join(TEMP,'store');fs.mkdirSync(STORE);fs.mkdirSync(path.join(TEMP,'profile'));app.setPath('userData',path.join(TEMP,'profile'));
let server,mainWin,kernelWin,model;const passed=[],failures=[];const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=20000){const start=Date.now();while(Date.now()-start<timeout){if(await fn())return;await wait(100);}throw Error(`Timed out: ${label}`);}
async function step(label,fn){try{await fn();passed.push(label);console.log('PASS',label);}catch(error){failures.push({label,error:error.stack});console.error('FAIL',label,error.message);}}
const watchdog=setTimeout(()=>{console.error('QA timeout',TEMP);finish(1);},240000);

// Fake model: replies chosen by the task text and how many tool results came back.
const modelLog=[];
function fakeModel(){
 return http.createServer((req,res)=>{
  let body='';req.on('data',c=>body+=c);req.on('end',()=>{
   const json=JSON.parse(body||'{}'),messages=json.messages||[];
   const system=messages.find(m=>m.role==='system')?.content||'',task=messages.find(m=>m.role==='user')?.content||'';
   const results=messages.filter(m=>m.role!=='system'&&/工具结果/.test(String(m.content))).length,last=String(messages[messages.length-1]?.content||'');
   modelLog.push({task:task.slice(0,40),system,results});
   let reply;
   if(/写一个任务/.test(task)){
    if(results===0)reply={tool_calls:[{name:'create_task',arguments:{title:'计划任务写入的任务',due:'2026-12-01'}}]};
    else if(results===1)reply=/"ok":\s*true/.test(last)?{tool_calls:[{name:'mark_task_done',arguments:{summary:'已写入一个任务。'}}]}:{final:'没写成：'+last.slice(0,60)};
    else reply={final:'完成。'};
   }else if(/不标记/.test(task)){
    reply=results===0?{tool_calls:[{name:'project_list',arguments:{}}]}:{final:'看完了。'};
   }else{
    if(results===0)reply={tool_calls:[{name:'project_list',arguments:{}}]};
    else if(results===1)reply={tool_calls:[{name:'mark_task_done',arguments:{summary:'项目目录已读取。'}}]};
    else reply={final:'项目目录已读取。'};
   }
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   res.write(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(reply)}}]})}\n\n`);
   res.write(`data: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5}})}\n\n`);
   res.end('data: [DONE]\n\n');
  });
 });
}

async function api(method,route,body,headers={}){
 const res=await fetch(ORIGIN+route,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});
 return {status:res.status,body:await res.json().catch(()=>({}))};
}

async function run(){
 // A free loopback port (other QA servers may be running).
 PORT=await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',reject);probe.listen(0,'127.0.0.1',()=>{const port=probe.address().port;probe.close(()=>resolve(port));});});ORIGIN=`http://127.0.0.1:${PORT}`;
 model=fakeModel();await new Promise(r=>model.listen(0,'127.0.0.1',r));
 const modelBase=`http://127.0.0.1:${model.address().port}/v1`;
 const log=fs.openSync(path.join(TEMP,'server.log'),'a');
 server=spawn(process.env.PYTHON||'python3',[path.join(ROOT,'app','server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(PORT),AI_WORKSTATION_DATA_DIR:STORE,AI_WORKSTATION_ASSET_DIR:path.join(ROOT,'app'),AI_WORKSTATION_KERNEL_HOST_TOKEN:HOST_TOKEN},stdio:['ignore',log,log]});
 await until(async()=>{try{return (await fetch(ORIGIN+'/__health')).ok;}catch{return false;}},'server');
 await app.whenReady();
 mainWin=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const main=code=>mainWin.webContents.executeJavaScript(code,true);
 await mainWin.loadURL(ORIGIN);await until(()=>main('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydration');
 await main("WorkstationOnboarding.close();state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};true");
 // The saved connection: a loopback model needs no key.
 await main(`localStorage.setItem('workstation-api-base',${JSON.stringify(modelBase)});localStorage.setItem('workstation-api-model','mock-model');state.projects.push({id:'p_kernel',name:'后台运行验收',workspace:'日常',createdAt:Date.now()});saveDocumentDurably().then(()=>true)`);
 kernelWin=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const kernel=code=>kernelWin.webContents.executeJavaScript(code,true);
 await kernelWin.loadURL(ORIGIN+'/kernel.html');
 assert.equal(await kernel('typeof AIBroKernelHost'),'object','kernel page loads its modules only');
 assert.equal(await kernel('document.querySelectorAll("link[rel=stylesheet]").length'),0);
 await kernel(`window.__aibroKernel={hostToken:${JSON.stringify(HOST_TOKEN)},hostId:'electron-smoke'};AIBroKernelHost.start();true`);
 const token=fs.readFileSync(path.join(STORE,'kernel','api-token'),'utf8').trim();
 const bearer={Authorization:'Bearer '+token};


 const origin={Origin:ORIGIN};
 const iso=offset=>new Date(Date.now()+offset).toISOString();
 const schedule=async payload=>{const r=await api('POST','/__scheduler/upsert',{kind:'auto',dueAt:iso(-1000),projectId:'p_kernel',...payload},origin);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
 const rowOf=async id=>(await api('GET','/__scheduler',null)).body.executions.find(e=>e.taskId===id);
 const taskOf=async id=>(await api('GET','/__scheduler',null)).body.tasks.find(t=>t.id===id);
 const runOf=async runId=>(await api('GET','/__kernel/runs/'+runId,null,bearer)).body.run;

 await step('没有声明范围的自动任务：不确认就不保存（409）',async()=>{
  const r=await api('POST','/__scheduler/upsert',{kind:'auto',name:'未声明',prompt:'看看项目',dueAt:iso(60000)},origin);
  assert.equal(r.status,409);assert.equal(r.body.code,'SCOPE_UNDECLARED');
  assert.equal((await api('GET','/__scheduler',null)).body.tasks.length,0);
 });

 await step('只读范围：到点提交后台运行 → 读项目 → mark_task_done → 已完成',async()=>{
  const task=await schedule({name:'读项目',prompt:'看看有哪些项目',scope:{access:'read'}});
  await until(async()=>(await rowOf(task.id))?.status==='completed','completed',40000);
  const row=await rowOf(task.id),run=await runOf(row.runId);
  assert.equal(row.summary,'项目目录已读取。');assert.equal(run.source.kind,'scheduler');assert.equal(run.request.schedule.executionId,row.id);
  assert.equal((await taskOf(task.id)).status,'completed');assert.equal(row.catchUp,false);
  const sys=modelLog.find(m=>/看看有哪些项目/.test(m.task)).system;
  assert.match(sys,/不要向用户提问/);assert.match(sys,/不要设定、调度/);assert.match(sys,/mark_task_done/);
 });

 await step('越界：只读任务要写入 → 待你批准（out-of-scope）→ 主窗口批准 → 落盘 → 完成',async()=>{
  const task=await schedule({name:'越界写入',prompt:'请写一个任务',scope:{access:'read'}});
  await until(async()=>(await rowOf(task.id))?.status==='awaiting-approval','awaiting approval',40000);
  const row=await rowOf(task.id),run=await runOf(row.runId),approval=run.approvals.find(a=>a.status==='pending');
  assert.ok(approval.reasons.includes('out-of-scope'),approval.reasons.join(','));
  const pending=(await api('GET','/__kernel/host/pending',null,{'X-AIBro-Kernel-Host':HOST_TOKEN})).body;
  assert.equal(pending.approvals[0].outOfScope,true);assert.equal(pending.approvals[0].scheduled,true);
  assert.equal((await api('GET','/__scheduler',null)).body.attention.length,1);
  // 计划任务对话框：待你批准入口 → 后台运行面板。
  assert.equal(await main(`!!document.querySelector('#settings #schedulerOpenSettings')`),true,'settings entry (the native overview hero has none)');
  await main(`document.querySelector('#schedulerOpenSettings').click();true`);
  await until(()=>main(`!!document.querySelector('#schedulerDialog[open] [data-scheduler-attention]')`),'attention entry');
  await main(`document.querySelector('[data-scheduler-attention] button').click();true`);
  assert.equal(await main(`document.querySelector('#schedulerDialog').open`),false);
  await until(()=>main(`!!document.querySelector('#kernelRunsPanel:not([hidden]) [data-decision="allowed-once"]')`),'approval card');
  assert.match(await main(`document.querySelector('#kernelRunsPanel').textContent`),/超出任务声明的范围/);
  assert.match(await main(`document.querySelector('#kernelRunsPanel').textContent`),/计划任务/);
  await main(`document.querySelector('#kernelRunsPanel [data-decision="allowed-once"]').click();true`);
  await until(async()=>(await rowOf(task.id))?.status==='completed','completed',40000);
  assert.equal(Number(await main(`state.tasks.filter(t=>t.title==='计划任务写入的任务').length`)),1);
  assert.equal((await rowOf(task.id)).sideEffects,true);
 });

 await step('没调用 mark_task_done：未通过完成验收，任务暂停',async()=>{
  const task=await schedule({name:'不标记',prompt:'看看项目但不标记',scope:{access:'read'}});
  await until(async()=>(await rowOf(task.id))?.status==='unverified','unverified',40000);
  assert.match((await rowOf(task.id)).error,/标记完成/);assert.equal((await taskOf(task.id)).status,'paused');
 });

 await step('普通后台运行没有计划任务规则和 mark_task_done',async()=>{
  const before=modelLog.length;
  const created=await api('POST','/__kernel/runs',{prompt:'看看有哪些项目（普通）'},bearer);
  await until(async()=>['completed','failed'].includes((await runOf(created.body.run.id)).status),'plain run',30000);
  const sys=modelLog.slice(before).find(m=>/普通/.test(m.task)).system;
  assert.doesNotMatch(sys,/mark_task_done/);assert.doesNotMatch(sys,/计划任务的无人值守/);
 });

 await step('界面：新建自动任务默认最小范围、可改；人工提醒；列表显示范围与执行历史',async()=>{
  await main(`Connections.upsert(state.settings,{kind:'codex-cli'});document.querySelector('#schedulerOpen').click();true`);
  await until(()=>main(`!!document.querySelector('#schedulerDialog[open] #schedulerForm')`),'dialog');
  assert.ok(await main(`[...document.querySelectorAll('#schedulerForm [name=modelConnection] option')].some(o=>o.value==='codex-cli')`),'Codex CLI is a choice for the task model');
  const defaults=JSON.parse(await main(`JSON.stringify({access:document.querySelector('#schedulerForm [data-access][aria-pressed="true"]')?.dataset.access,computer:document.querySelector('#schedulerForm [name=computerUse]').checked,tools:document.querySelectorAll('#schedulerForm .scheduler-tools input:checked').length,scopeVisible:!document.querySelector('#schedulerForm .scheduler-scope-field').hidden})`));
  assert.deepEqual(defaults,{access:'read',computer:false,tools:0,scopeVisible:true});
  await main(`(()=>{const f=document.querySelector('#schedulerForm');f.querySelector('[name=name]').value='界面建的任务';f.querySelector('[name=prompt]').value='看看有哪些项目（界面）';
   f.querySelector('[name=dueAt]').value=new Date(Date.now()+86400000-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16);
   f.querySelector('[data-access="ask"]').click();const c=f.querySelector('[name=modelConnection]');c.value='codex-cli';c.dispatchEvent(new Event('change'));f.querySelector('[name=model]').value='per-task-model';f.requestSubmit();return true;})()`);
  await until(()=>main(`[...document.querySelectorAll('[data-scheduler-task]')].some(r=>/界面建的任务/.test(r.textContent))`),'task listed');
  const saved=(await api('GET','/__scheduler',null)).body.tasks.find(t=>t.name==='界面建的任务');
  assert.deepEqual(saved.scope,{declared:true,access:'ask',tools:[],computerUse:false});assert.deepEqual(saved.modelOverride,{connectionId:'codex-cli',model:'per-task-model'});
  assert.match(await main(`[...document.querySelectorAll('[data-scheduler-task]')].find(r=>/界面建的任务/.test(r.textContent)).textContent`),/写入先问我/);
  await main(`(()=>{const f=document.querySelector('#schedulerForm');[...f.querySelectorAll('.automation-choice-row button')].find(b=>/人工提醒/.test(b.textContent)).click();
   f.querySelector('[name=name]').value='交表提醒';f.querySelector('[name=dueAt]').value=new Date(Date.now()+7200000-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16);f.requestSubmit();return true;})()`);
  await until(async()=>(await api('GET','/__scheduler',null)).body.tasks.some(t=>t.name==='交表提醒'&&t.kind==='reminder'),'reminder saved');
  const pending=(await api('GET','/__kernel/host/pending',null,{'X-AIBro-Kernel-Host':HOST_TOKEN})).body;
  assert.ok(pending.reminders.some(r=>r.title==='交表提醒'),'reminder handed to the native shell');
  assert.ok(await main(`!!document.querySelector('[data-scheduler-execution][data-status="completed"]')`),'history shows executions');
  if(process.env.SCHEDULER_SHOTS){
   await main(`document.querySelector('#schedulerDialog').scrollTop=0;true`);await wait(300);
   fs.writeFileSync(path.join(process.env.SCHEDULER_SHOTS,'scheduler-list.png'),(await mainWin.webContents.capturePage()).toPNG());
   await main(`document.querySelector('#schedulerForm').scrollIntoView();[...document.querySelectorAll('#schedulerForm .automation-choice-row button')].find(b=>/自动任务/.test(b.textContent)).click();true`);await wait(300);
   fs.writeFileSync(path.join(process.env.SCHEDULER_SHOTS,'scheduler-form.png'),(await mainWin.webContents.capturePage()).toPNG());
  }
  await main(`document.querySelector('#schedulerDialog').close();true`);
 });

 console.log(JSON.stringify({passed:passed.length,failures,qaStore:TEMP,modelRequests:modelLog.length,externalRequests:0},null,2));
 assert.deepEqual(failures,[]);
}
function finish(code){clearTimeout(watchdog);mainWin?.destroy();kernelWin?.destroy();server?.kill('SIGTERM');model?.close();code?app.exit(code):app.quit();}
run().then(()=>finish(0)).catch(error=>{console.error(error);console.error('QA store retained:',TEMP);finish(1);});
