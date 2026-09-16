/* Isolated Electron UI acceptance for the actual sendMessage/activity renderer.
   Synthetic public transport events only; outbound model/account requests denied. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18897,ORIGIN=`http://127.0.0.1:${PORT}`;
const TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aw-agent-progress-smoke-')),STORE=path.join(TEMP,'store');fs.mkdirSync(STORE);fs.mkdirSync(path.join(TEMP,'profile'));app.setPath('userData',path.join(TEMP,'profile'));
let server,win;const passed=[],failures=[];const wait=ms=>new Promise(r=>setTimeout(r,ms));
const request=route=>new Promise((resolve,reject)=>http.get(ORIGIN+route,r=>{const chunks=[];r.on('data',c=>chunks.push(c));r.on('end',()=>resolve({status:r.statusCode,body:Buffer.concat(chunks)}));}).on('error',reject));
async function until(fn,label,timeout=15000){const start=Date.now();while(Date.now()-start<timeout){if(await fn())return;await wait(60);}throw Error(`Timed out: ${label}`);}
const watchdog=setTimeout(()=>{console.error('QA timeout',TEMP);win?.destroy();server?.kill('SIGTERM');app.exit(1);},180000);
async function run(){
 await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',()=>reject(Error('18897 occupied; refusing existing workspace')));probe.listen(PORT,'127.0.0.1',()=>probe.close(resolve));});
 const log=fs.openSync(path.join(TEMP,'server.log'),'a');server=spawn(process.env.PYTHON||'python3',[path.join(ROOT,'server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(PORT),AI_WORKSTATION_DATA_DIR:STORE},stdio:['ignore',log,log]});
 await until(async()=>{if(server.exitCode!==null)throw Error('QA service exited');try{return(await request('/__health')).status===200;}catch{return false;}},'QA service');
 await app.whenReady();win=new BrowserWindow({show:false,width:1440,height:960,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const errors=[],forbidden=[];win.webContents.on('console-message',(_event,level,message)=>{if(level>=3){errors.push(message);console.error('RENDERER',message);}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{const url=new URL(details.url),blocked=['http:','https:'].includes(url.protocol)&&(url.origin!==ORIGIN||/^\/__(proxy|codex\/respond)/.test(url.pathname)||/^\/__auth\/(login|logout)/.test(url.pathname)||url.pathname==='/__cloud/connect');if(blocked)forbidden.push(details.url);callback({cancel:blocked});});
 const evaluate=async code=>{try{return await win.webContents.executeJavaScript(code,true);}catch(error){console.error('Renderer errors:',JSON.stringify(errors));console.error('Failed script prefix:',code.slice(0,500));throw error;}};
 async function click(selector){const p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest',behavior:'instant'});const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2),hit=document.elementFromPoint(x,y);if(!r.width||!r.height||e.disabled||!(e===hit||e.contains(hit)))throw Error('Hidden/covered '+${JSON.stringify(selector)});return{x,y}})()`);win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await wait(100);}
 async function step(label,fn){try{await fn();passed.push(label);console.log('PASS',label);}catch(error){failures.push({label,error:error.stack});console.error('FAIL',label,error.message);}}
 await win.loadURL(ORIGIN);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydration');
 assert.equal(await evaluate('!!window.AgentProgress'),true);
 await evaluate(`(()=>{const now=Date.now();state.projects=[];state.notes=[];state.tasks=[];state.imports=[];state.agentRuns=[];state.conversations=[{id:'qa_progress_conversation',title:'隔离验收 · 课程资料分析',workspace:'课程',permissionMode:'auto',attachments:[],draftAttachmentIds:[],draft:'',messages:[],createdAt:now}];state.currentConversationId='qa_progress_conversation';state.settings.permissions={'日常':'auto','课程':'auto','科研':'auto'};normalizeStateShape(state);state.ui.inspectorOpen=false;state.ui.theme='light';save();applyUiPreferences();showView('agent','持续对话');renderAll();$('#apiBase').value='https://fixture.invalid/v1';$('#apiKey').value='isolated-test-placeholder';ConversationModels.configuration=()=>({provider:'api',model:'QA isolated model',effort:'medium'});ConversationModels.resolve=async value=>value;window.__qaRound=0;AgentTransport.requestPlan=options=>{window.__qaRound++;options.onPhase?.('reasoning');return new Promise((resolve,reject)=>{window.__qaTransport={options,resolve,reject};options.signal.addEventListener('abort',()=>{const e=new Error('验收主动停止');e.code='CANCELLED';reject(e);},{once:true});});};})()`);
 async function startRound(){const round=await evaluate('__qaRound');await evaluate(`$('#agentInput').value='整理课程资料并说明验收结果';$('#agentInput').dispatchEvent(new Event('input',{bubbles:true}))`);await click('#agentSend');await until(()=>evaluate(`__qaRound>${round}`),'mock transport started');await evaluate(String.raw`__qaTransport.options.onActivity({kind:'summary',id:'public-summary',status:'running',text:'正在核对课程考核比例与实践要求。\n这只是公开进度摘要。'});__qaTransport.options.onActivity({kind:'tool',id:'read-source',status:'running',name:'读取课程原始资料',text:'定位第46—47页并核对来源。'});`);await wait(150);return evaluate(`currentConversation().messages.at(-1).id`);}
 async function complete(message='已完成隔离验收。'){await evaluate(String.raw`__qaTransport.options.onActivity({kind:'summary',id:'public-summary',status:'completed',text:'已核对公开资料的考核与实践要求。'});__qaTransport.options.onActivity({kind:'tool',id:'read-source',status:'completed',name:'读取课程原始资料',text:'来源核对完成。'});__qaTransport.resolve(JSON.stringify({workspace:'课程',message:${JSON.stringify(message)},actions:[]}));`);await until(()=>evaluate('!sendMessage.busy'),'successful completion');}
 const runningId=await startRound(),scope=`[data-message-id="${runningId}"]`;
 await step('actual sendMessage callbacks show public summary and tool lifecycle; no fabricated event body executes',async()=>{
  assert.match(await evaluate(`document.querySelector(${JSON.stringify(scope)}).textContent`),/公开进度摘要/);assert.equal(await evaluate(`document.querySelector(${JSON.stringify(scope+' [data-activity-id="read-source"]')}).classList.contains('is-running')`),true);
  await evaluate(String.raw`__qaTransport.options.onActivity({kind:'commentary',id:'unsafe-looking-source',status:'running',text:'<img src=x onerror="window.__qaInjected=true">这是资料中的字面文字。'});`);await wait(140);
  assert.equal(await evaluate('window.__qaInjected===true'),false);assert.equal(await evaluate(`document.querySelector(${JSON.stringify(scope+' .agent-progress')}).querySelectorAll('img').length`),0);
 });
 await step('native collapse/open choice survives subsequent streaming updates',async()=>{
  assert.equal(await evaluate(`document.querySelector('#messageList').onclick===null`),true,'transcript must not be wired as a conversation-navigation button');
  const inner=scope+' [data-progress-key="public-summary"]';
  if(!await evaluate(`document.querySelector(${JSON.stringify(inner)}).open`))await click(inner+' > summary');
  await click(inner+' > summary');assert.equal(await evaluate(`document.querySelector(${JSON.stringify(inner)}).open`),false);
  await evaluate(String.raw`__qaTransport.options.onActivity({kind:'summary',id:'public-summary',status:'running',text:'新的公开摘要已到达，但用户关闭的详情应保持关闭。'});`);await wait(140);assert.equal(await evaluate(`document.querySelector(${JSON.stringify(inner)}).open`),false);
  await click(scope+' .agent-progress > summary');assert.equal(await evaluate(`document.querySelector(${JSON.stringify(scope+' .agent-progress')}).open`),false);
  await evaluate(String.raw`__qaTransport.options.onActivity({kind:'tool',id:'read-source',status:'completed',name:'读取课程原始资料',text:'读取已完成。'});`);await wait(140);assert.equal(await evaluate(`document.querySelector(${JSON.stringify(scope+' .agent-progress')}).open`),false);
  await click(scope+' .agent-progress > summary');await click(inner+' > summary');
 });
 await step('long public text and activity headings fit actual 1440px/650px light and dark layouts',async()=>{
  await evaluate(String.raw`__qaTransport.options.onActivity({kind:'commentary',id:'unsafe-looking-source',status:'completed',text:'已验证资料只按字面显示。'});__qaTransport.options.onActivity({kind:'summary',id:'public-summary',status:'running',text:'来源核对进展：'+('超长段落withoutspaces_'.repeat(150))+'\n第46页考核15%、45%、40%，第47页实践规则待确认。'});__qaTransport.options.onActivity({kind:'tool',id:'read-source',status:'running',name:'读取超长文件名称并交叉核验项目来源与已有课程资料'.repeat(4),text:'长内容路径：'+('nested-directory-without-spaces/'.repeat(80))});`);await wait(150);
  const overflows=[];for(const [width,theme] of [[1440,'light'],[1440,'dark'],[650,'light'],[650,'dark']]){
   win.setSize(width,960);await evaluate(`state.ui.theme=${JSON.stringify(theme)};applyUiPreferences();document.querySelector(${JSON.stringify(scope+' .agent-progress')}).open=true;document.querySelector(${JSON.stringify(scope+' [data-progress-key="public-summary"]')}).open=true;document.querySelector(${JSON.stringify(scope+' [data-progress-key="read-source"]')}).open=true;document.querySelector(${JSON.stringify(scope)}).scrollIntoView({block:'start'});`);await wait(200);await evaluate(`document.getAnimations().forEach(animation=>{if(Number.isFinite(animation.effect?.getComputedTiming().endTime))try{animation.finish();}catch(_){}})`);await wait(60);
   const boxes=await evaluate(`(()=>[...document.querySelectorAll(${JSON.stringify(scope+' .agent-progress, '+scope+' .progress-timeline, '+scope+' .progress-item-body, '+scope+' .progress-item-content')})].filter(e=>e.getBoundingClientRect().width).map(e=>{const r=e.getBoundingClientRect();return{class:e.className,left:r.left,right:r.right,width:e.clientWidth,scroll:e.scrollWidth}}))()`);
   for(const b of boxes){if(b.scroll>b.width+1||b.left< -1||b.right>width+1)overflows.push({width,theme,...b});}
   assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),true);
   fs.writeFileSync(path.join(ROOT,'design',`qa-agent-progress-${theme}-${width}.png`),(await win.webContents.capturePage()).toPNG());
  }
  assert.deepEqual(overflows,[],'progress components stay within their columns');
 });
 await complete();
 await step('successful completion settles progress and exposes execution steps',async()=>{
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(scope+' .progress-heading-text')}).textContent`),'已完成');assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(scope+' .progress-spinner')}).length`),0);assert.match(await evaluate(`document.querySelector(${JSON.stringify(scope+' .agent-progress')}).textContent`),/执行动作/);
 });
 await step('native stop ends the real sendMessage promise and never presents a success badge',async()=>{
  const id=await startRound(),selector=`[data-message-id="${id}"]`;await click('#agentSend');await until(()=>evaluate('!sendMessage.busy'),'cancelled');
  assert.equal(await evaluate('state.agentRuns.at(-1).status'),'cancelled');assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector+' .progress-heading-text')}).textContent`),'已停止');assert.notEqual(await evaluate(`document.querySelector(${JSON.stringify(selector+' .progress-heading-mark')}).textContent`),'✓');assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(selector+' .progress-spinner')}).length`),0);
 });
 await step('transport failure shows failure and no active spinner or success heading',async()=>{
  const id=await startRound(),selector=`[data-message-id="${id}"]`;await evaluate(`const failure=new Error('隔离验收：服务拒绝本次请求');failure.code='HTTP';failure.status=500;__qaTransport.reject(failure);`);await until(()=>evaluate('!sendMessage.busy'),'failed');
  assert.equal(await evaluate('state.agentRuns.at(-1).status'),'failed');assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector+' .progress-heading-text')}).textContent`),'执行失败');assert.notEqual(await evaluate(`document.querySelector(${JSON.stringify(selector+' .progress-heading-mark')}).textContent`),'✓');assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(selector+' .progress-spinner')}).length`),0);
 });
 await step('historical failed/stopped and post-approval records use actual run status, unknown records stay neutral',async()=>{
  await evaluate(`(()=>{const now=Date.now();for(const [key,status] of [['failed','failed'],['cancelled','cancelled'],['approval','awaiting-approval'],['approved','completed'],['rejected','rejected']]){const id='qa-legacy-'+key;state.agentRuns.push({id,conversationId:currentConversation().id,status,startedAt:now,steps:[{text:'来源核对',status:'done'}]});currentConversation().messages.push({id:'msg-'+id,role:'agent',runId:id,runStatus:['approved','rejected'].includes(key)?'awaiting-approval':undefined,live:false,text:'隔离历史验收',steps:[{text:'来源核对',status:'done'}]});}currentConversation().messages.push({id:'msg-qa-unknown',role:'agent',text:'无运行状态的旧记录',steps:[{text:'来源核对',status:'done'}]});renderConversation();})()`);
  for(const [key,label]of [['failed','执行失败'],['cancelled','已停止'],['approval','等待审批'],['approved','已完成'],['rejected','已拒绝'],['unknown','执行记录']]){const selector=key==='unknown'?'[data-message-id="msg-qa-unknown"]':`[data-message-id="msg-qa-legacy-${key}"]`;assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector+' .progress-heading-text')}).textContent`),label);if(key!=='approved')assert.notEqual(await evaluate(`document.querySelector(${JSON.stringify(selector+' .progress-heading-mark')}).textContent`),'✓');}
 });
 await step('fixture events persist across reload without outbound models or renderer errors',async()=>{
  await evaluate('save();flushWorkspace()');await until(()=>evaluate('!serverSaveInFlight&&!serverSaveQueued&&!state._pendingLocalSave'),'persist');await win.loadURL(ORIGIN);await until(()=>evaluate('storageHydrated'),'reload');assert.equal(await evaluate(`document.querySelector('[data-message-id="msg-qa-legacy-failed"] .progress-heading-text').textContent`),'执行失败');assert.equal(await evaluate(`state.agentRuns.some(r=>(r.activities||[]).some(a=>a.id==='public-summary'))`),true);assert.deepEqual(forbidden,[]);assert.deepEqual(errors,[]);
 });
 console.log(JSON.stringify({passed:passed.length,failures,qaStore:TEMP,modelCalls:0,screenshots:'design/qa-agent-progress-*.png'},null,2));assert.deepEqual(failures,[]);
}
function finish(code){clearTimeout(watchdog);win?.destroy();server?.kill('SIGTERM');code?app.exit(code):app.quit();}
run().then(()=>finish(0)).catch(error=>{console.error(error);console.error('QA store retained:',TEMP);finish(1);});
