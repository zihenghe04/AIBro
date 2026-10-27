/* P8b 无头内核宿主冒烟：真实 server.py（隔离数据目录）+ 本机假模型（OpenAI 兼容，
   脚本化回复，不出网）+ 两个隐藏渲染器：kernel.html（内核宿主，代替原生壳里的隐藏
   WKWebView）和主窗口 index.html。覆盖：
   1. 客户端用 token 建 run → 宿主领取 → 写操作进入“待审批” → 主窗口面板批准 →
      主窗口落盘并回执 → run 完成，事件流完整；
   2. 待审批时取消 → 不写入、状态 cancelled；
   3. 关闭主窗口后，只读 run 仍能完成；
   4. P9b 内核走 Codex CLI（假 codex 可执行文件，不出网）：设置里内核选 Codex 时
      只读 run 完成、每步只发增量、事件记延迟；额度用尽时 run 暂停，继续后完成。
   运行：node_modules/.bin/electron tests/kernel-host-smoke.cjs */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),HOST_TOKEN='k'.repeat(64);
let PORT=0,ORIGIN='';
const TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aw-kernel-host-')),STORE=path.join(TEMP,'store');fs.mkdirSync(STORE);fs.mkdirSync(path.join(TEMP,'profile'));app.setPath('userData',path.join(TEMP,'profile'));
let server,mainWin,kernelWin,model;const passed=[],failures=[];const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=20000){const start=Date.now();while(Date.now()-start<timeout){if(await fn())return;await wait(100);}throw Error(`Timed out: ${label}`);}
async function step(label,fn){try{await fn();passed.push(label);console.log('PASS',label);}catch(error){failures.push({label,error:error.stack});console.error('FAIL',label,error.message);}}
const watchdog=setTimeout(()=>{console.error('QA timeout',TEMP);finish(1);},240000);

// Fake Codex CLI (P9b): app-server over stdio; text-protocol replies; "额度" runs hit the usage limit until quota-ok exists.
const CODEX_STUB=path.join(TEMP,'codex'),CODEX_LOG=path.join(TEMP,'codex.log'),QUOTA_OK=path.join(TEMP,'quota-ok');
fs.writeFileSync(CODEX_STUB,`#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
if args == ['--version']: print('codex-cli 0.163.0'); sys.exit(0)
if args[:2] == ['login', 'status']: sys.exit(0)
if not args or args[0] != 'app-server': sys.exit(2)
def send(m): print(json.dumps(m), flush=True)
def note(e):
    with open(${JSON.stringify(CODEX_LOG)}, 'a') as f: f.write(json.dumps(e, ensure_ascii=False) + '\\n')
threads = turns = 0
for line in sys.stdin:
    m = json.loads(line); method = m.get('method'); i = m.get('id'); p = m.get('params') or {}
    if i is None or not method: continue
    if method == 'thread/start':
        threads += 1
        send({'id': i, 'result': {'thread': {'id': 'th-%d' % threads}, 'approvalPolicy': 'never', 'sandbox': {'type': 'readOnly', 'networkAccess': False}}}); continue
    if method == 'turn/start':
        turns += 1; th = p['threadId']; tu = 'tu-%d' % turns; text = ''.join(x.get('text', '') for x in p.get('input', []))
        note({'thread': th, 'text': text[:60]})
        send({'id': i, 'result': {'turn': {'id': tu}}})
        base = {'threadId': th, 'turnId': tu}
        if '额度' in text and not os.path.exists(${JSON.stringify(QUOTA_OK)}):
            send({'method': 'turn/completed', 'params': {'threadId': th, 'turn': {'id': tu, 'status': 'failed', 'error': {'message': 'usage limit', 'codexErrorInfo': 'usageLimitExceeded'}}}}); continue
        reply = {'final': '项目目录已读取（Codex）。'} if '工具结果' in text else {'tool_calls': [{'name': 'project_list', 'arguments': {}}]}
        send({'method': 'item/completed', 'params': {**base, 'item': {'type': 'agentMessage', 'id': 'a', 'text': json.dumps(reply, ensure_ascii=False), 'phase': 'final_answer'}}})
        send({'method': 'thread/tokenUsage/updated', 'params': {**base, 'tokenUsage': {'last': {'inputTokens': 1200, 'cachedInputTokens': 0, 'outputTokens': 30, 'reasoningOutputTokens': 0, 'totalTokens': 1230}, 'total': {'inputTokens': 1200, 'cachedInputTokens': 0, 'outputTokens': 30, 'reasoningOutputTokens': 0, 'totalTokens': 1230}}}})
        send({'method': 'turn/completed', 'params': {'threadId': th, 'turn': {'id': tu, 'status': 'completed'}}}); continue
    send({'id': i, 'result': {}})
`);fs.chmodSync(CODEX_STUB,0o755);
const codexTurns=()=>{try{return fs.readFileSync(CODEX_LOG,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));}catch{return [];}};

// Fake model: text protocol replies chosen by what the last user message asks.
const modelLog=[];
function fakeModel(){
 return http.createServer((req,res)=>{
  let body='';req.on('data',c=>body+=c);req.on('end',()=>{
   const json=JSON.parse(body||'{}'),messages=json.messages||[];
   const task=messages.find(m=>m.role==='user')?.content||'',last=messages[messages.length-1]?.content||'';
   modelLog.push({task:task.slice(0,40),auth:req.headers.authorization||null,turns:messages.length});
   let reply;
   if(/建一个任务/.test(task)){
    if(!/工具结果/.test(last))reply={tool_calls:[{name:'create_task',arguments:{title:'复核本周周报',due:'2026-12-01'}}]};
    else reply={final:/"ok":\s*true/.test(last)?'任务已建好。':'任务没有建成：'+last.slice(0,80)};
   }else{
    if(!/工具结果/.test(last))reply={tool_calls:[{name:'project_list',arguments:{}}]};
    else reply={final:'项目目录已读取。'};
   }
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   const text=JSON.stringify(reply);
   res.write(`data: ${JSON.stringify({choices:[{delta:{content:text}}]})}\n\n`);
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
 server=spawn(process.env.PYTHON||'python3',[path.join(ROOT,'app','server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(PORT),AI_WORKSTATION_DATA_DIR:STORE,AI_WORKSTATION_ASSET_DIR:path.join(ROOT,'app'),AI_WORKSTATION_KERNEL_HOST_TOKEN:HOST_TOKEN,AI_WORKSTATION_CODEX_BIN:CODEX_STUB},stdio:['ignore',log,log]});
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

 await step('后台运行权限默认跟随主窗口：日常空间“自动执行”时写入不经审批直接落盘',async()=>{
  assert.equal(await main('state.settings.headlessPermissionMode===undefined&&(state.settings.permissions["日常"]||"auto")==="auto"'),true);
  const created=await api('POST','/__kernel/runs',{prompt:'请建一个任务：跟随主窗口',projectId:'p_kernel'},bearer);const id=created.body.run.id;
  await until(async()=>(await api('GET','/__kernel/runs/'+id,null,bearer)).body.run.status==='completed','completed',30000);
  const done=(await api('GET','/__kernel/runs/'+id,null,bearer)).body.run;
  assert.deepEqual(done.approvals,[]);assert.equal(done.effects[0].status,'applied');assert.equal(done.result.final,'任务已建好。');
  assert.equal(Number(await main(`state.tasks.filter(t=>t.kernelRunId===${JSON.stringify(id)}).length`)),1);
 });
 // From here on the stricter setting: every write asks.
 await main("state.settings.headlessPermissionMode='request';saveDocumentDurably().then(()=>true)");

 await step('写操作（每个写入都审批）：待审批 → 主窗口批准 → 主窗口落盘回执 → run 完成',async()=>{
  const created=await api('POST','/__kernel/runs',{prompt:'请建一个任务：复核本周周报',source:{kind:'scheduler',id:'smoke'},projectId:'p_kernel'},bearer);
  assert.equal(created.status,201);const id=created.body.run.id;
  await until(async()=>(await api('GET','/__kernel/runs/'+id,null,bearer)).body.run.status==='awaiting-approval','awaiting approval');
  // The client that started the run cannot approve it.
  const run=(await api('GET','/__kernel/runs/'+id,null,bearer)).body.run,approval=run.approvals[0];
  assert.equal(approval.tool,'create_task');assert.match(approval.summary,/复核本周周报/);
  assert.equal((await api('POST',`/__kernel/runs/${id}/approvals/${approval.id}`,{decision:'allowed-once'},bearer)).status,403);
  await main('AIBroKernelRuns.show();true');
  await until(()=>main(`!!document.querySelector('#kernelRunsPanel:not([hidden]) [data-decision="allowed-once"]')`),'approval card in main window');
  assert.match(await main(`document.querySelector('#kernelRunsButton').textContent`),/待审批 1/);
  await main(`document.querySelector('#kernelRunsPanel [data-decision="allowed-once"]').click();true`);
  await until(async()=>(await api('GET','/__kernel/runs/'+id,null,bearer)).body.run.status==='completed','completed',30000);
  const done=(await api('GET','/__kernel/runs/'+id,null,bearer)).body.run;
  assert.equal(done.result.final,'任务已建好。');
  assert.equal(done.effects[0].status,'applied');
  const tasks=JSON.parse(await main(`JSON.stringify(state.tasks.filter(t=>t.kernelRunId===${JSON.stringify(id)}))`));
  assert.equal(tasks.length,1);assert.equal(tasks[0].title,'复核本周周报');assert.equal(tasks[0].projectId,'p_kernel');
  const types=(await api('GET',`/__kernel/runs/${id}/events?after=0`,null,bearer)).body.events.map(e=>e.type);
  for(const t of ['run/queued','run/started','model/request','approval/asked','approval/decided','tool/dispatched','tool/result','run/finished'])assert.ok(types.includes(t),'event '+t+' in '+types.join(','));
  assert.ok(modelLog.every(m=>m.auth===null),'a loopback model gets no key');
 });

 await step('待审批时取消：不写入，状态 cancelled',async()=>{
  const before=Number(await main('state.tasks.length'));
  const created=await api('POST','/__kernel/runs',{prompt:'请建一个任务：要被取消的',projectId:'p_kernel'},bearer);const id=created.body.run.id;
  await until(async()=>(await api('GET','/__kernel/runs/'+id,null,bearer)).body.run.status==='awaiting-approval','awaiting approval');
  assert.equal((await api('POST',`/__kernel/runs/${id}/cancel`,{},bearer)).status,200);
  await until(async()=>(await api('GET','/__kernel/runs/'+id,null,bearer)).body.run.status==='cancelled','cancelled',30000);
  await wait(3500);
  assert.equal(Number(await main('state.tasks.length')),before);
  const run=(await api('GET','/__kernel/runs/'+id,null,bearer)).body.run;
  assert.deepEqual(run.effects,[]);assert.equal(run.approvals[0].status,'cancelled');
 });

 await step('Codex CLI 模式（设置里内核选 Codex）：只读 run 完成，每步只发增量，事件记延迟',async()=>{
  await main(`Connections.upsert(state.settings,{id:'codex-cli',kind:'codex-cli',name:'Codex CLI',login:'shared'});Connections.setRole(state.settings,'kernel',{connection:'codex-cli',model:'stub-model'});saveDocumentDurably().then(()=>true)`);
  const created=await api('POST','/__kernel/runs',{prompt:'看看有哪些项目（Codex）'},bearer);const id=created.body.run.id;
  await until(async()=>['completed','failed'].includes((await api('GET','/__kernel/runs/'+id,null,bearer)).body.run.status),'codex run done',30000);
  const run=(await api('GET','/__kernel/runs/'+id,null,bearer)).body.run;
  assert.equal(run.status,'completed',run.error||'');assert.equal(run.result.final,'项目目录已读取（Codex）。');
  const turns=codexTurns();
  assert.equal(turns.length,2);assert.equal(turns[0].thread,turns[1].thread,'one thread per run');
  assert.match(turns[1].text,/^工具结果/,'the second step sends only the tool result');
  const events=(await api('GET',`/__kernel/runs/${id}/events?after=0`,null,bearer)).body.events;
  const payload=e=>e.data?.data??e.data;
  assert.equal(payload(events.find(e=>e.type==='run/model')).source,'codex-cli');
  const responses=events.filter(e=>e.type==='model/response');
  assert.equal(responses.length,2);assert.ok(responses.every(e=>Number.isFinite(payload(e).ms)&&Number.isFinite(payload(e).codex?.ms)),'latency per step');
 });

 await step('Codex 额度用尽：run 暂停（不重试）并在面板显示，继续后完成',async()=>{
  const before=codexTurns().length;
  const created=await api('POST','/__kernel/runs',{prompt:'额度测试：看看项目',model:{connection:'codex-cli'}},bearer);const id=created.body.run.id;
  await until(async()=>(await api('GET','/__kernel/runs/'+id,null,bearer)).body.run.status==='paused','paused',30000);
  const run=(await api('GET','/__kernel/runs/'+id,null,bearer)).body.run;
  assert.equal(run.pause.code,'CODEX_QUOTA');assert.match(run.pause.message,/额度/);
  await wait(1500);
  assert.equal(codexTurns().length,before+1,'the limited step is not retried');
  assert.equal(Number(await kernel('AIBroKernelHost.status.paused')),1);
  await main('AIBroKernelRuns.show();true');
  await until(()=>main(`!!document.querySelector('#kernelRunsPanel:not([hidden]) [data-resume]')`),'paused card with 继续');
  assert.match(await main(`document.querySelector('#kernelRunsButton').textContent`),/已暂停 1/);
  fs.writeFileSync(QUOTA_OK,'1');
  await main(`document.querySelector('#kernelRunsPanel [data-resume]').click();true`);
  await until(async()=>(await api('GET','/__kernel/runs/'+id,null,bearer)).body.run.status==='completed','completed after resume',30000);
  const done=(await api('GET','/__kernel/runs/'+id,null,bearer)).body.run;
  assert.equal(done.resumes,1);assert.equal(done.result.final,'项目目录已读取（Codex）。');
  await main(`Connections.setRole(state.settings,'kernel',null);saveDocumentDurably().then(()=>true)`);
 });

 await step('关闭主窗口后只读 run 仍能完成；SSE 订阅能看到结束',async()=>{
  mainWin.destroy();mainWin=null;
  const created=await api('POST','/__kernel/runs',{prompt:'看看有哪些项目'},bearer);const id=created.body.run.id;
  const stream=await fetch(`${ORIGIN}/__kernel/runs/${id}/events/stream?after=0`,{headers:bearer});
  const text=await stream.text();
  assert.match(text,/event: run\/finished/);assert.match(text,/"status": "completed"/);
  const run=(await api('GET','/__kernel/runs/'+id,null,bearer)).body.run;
  assert.equal(run.status,'completed');assert.equal(run.result.final,'项目目录已读取。');
 });

 console.log(JSON.stringify({passed:passed.length,failures,qaStore:TEMP,modelRequests:modelLog.length,externalRequests:0},null,2));
 assert.deepEqual(failures,[]);
}
function finish(code){clearTimeout(watchdog);mainWin?.destroy();kernelWin?.destroy();server?.kill('SIGTERM');model?.close();code?app.exit(code):app.quit();}
run().then(()=>finish(0)).catch(error=>{console.error(error);console.error('QA store retained:',TEMP);finish(1);});
