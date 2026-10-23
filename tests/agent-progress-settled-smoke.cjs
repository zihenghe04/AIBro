/* 终态可回看验收（真实渲染器）：整轮回答完成、过程条收束后，用户仍应能重新展开
   过程总览、并逐段展开回看详情（思考摘要与工具段正文）。
   同时验证终态保存/重载后这些内容仍在（不因持久化丢失）。
   运行：node_modules/.bin/electron tests/agent-progress-settled-smoke.cjs */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18899,ORIGIN=`http://127.0.0.1:${PORT}`;
const TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aw-progress-settled-')),STORE=path.join(TEMP,'store');fs.mkdirSync(STORE);fs.mkdirSync(path.join(TEMP,'profile'));app.setPath('userData',path.join(TEMP,'profile'));
let server,win;const passed=[],failures=[];const wait=ms=>new Promise(r=>setTimeout(r,ms));
const request=route=>new Promise((resolve,reject)=>http.get(ORIGIN+route,r=>{const chunks=[];r.on('data',c=>chunks.push(c));r.on('end',()=>resolve({status:r.statusCode,body:Buffer.concat(chunks)}));}).on('error',reject));
async function until(fn,label,timeout=15000){const start=Date.now();while(Date.now()-start<timeout){if(await fn())return;await wait(60);}throw Error(`Timed out: ${label}`);}
const watchdog=setTimeout(()=>{console.error('QA timeout',TEMP);win?.destroy();server?.kill('SIGTERM');app.exit(1);},180000);
async function run(){
 await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',()=>reject(Error(`${PORT} occupied; refusing existing workspace`)));probe.listen(PORT,'127.0.0.1',()=>probe.close(resolve));});
 const log=fs.openSync(path.join(TEMP,'server.log'),'a');server=spawn(process.env.PYTHON||'python3',[path.join(ROOT,'app','server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(PORT),AI_WORKSTATION_DATA_DIR:STORE,AI_WORKSTATION_ASSET_DIR:path.join(ROOT,'app')},stdio:['ignore',log,log]});
 await until(async()=>{if(server.exitCode!==null)throw Error('QA service exited');try{return(await request('/__health')).status===200;}catch{return false;}},'QA service');
 await app.whenReady();win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const errors=[];win.webContents.on('console-message',(event,level,message)=>{const isError=event&&typeof event==='object'&&!Array.isArray(event)&&('level' in event)?event.level==='error':level>=3;const text=(event&&typeof event==='object'&&'message' in event)?event.message:message;if(isError){errors.push(text);console.error('RENDERER',text);}});
 const evaluate=async code=>{try{return await win.webContents.executeJavaScript(code,true);}catch(error){console.error('Renderer errors:',JSON.stringify(errors));throw error;}};
 async function step(label,fn){try{await fn();passed.push(label);console.log('PASS',label);}catch(error){failures.push({label,error:error.stack});console.error('FAIL',label,error.message);}}
 await win.loadURL(ORIGIN);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydration');
 assert.equal(await evaluate('!!window.AgentProgress'),true);
 await wait(900);const bootErrors=[...errors];
 await evaluate(`(()=>{const now=Date.now();state.projects=[];state.notes=[];state.tasks=[];state.imports=[];state.agentRuns=[];state.conversations=[{id:'qa_settled_conversation',title:'隔离验收 · 终态回看',workspace:'日常',permissionMode:'auto',attachments:[],draftAttachmentIds:[],draft:'',messages:[],createdAt:now}];state.currentConversationId='qa_settled_conversation';state.settings.permissions={'日常':'auto','课程':'auto','科研':'auto'};normalizeStateShape(state);state.ui.inspectorOpen=false;save();applyUiPreferences();showView('agent','对话');renderAll();$('#apiBase').value='https://fixture.invalid/v1';$('#apiKey').value='isolated-test-placeholder';ConversationModels.configuration=()=>({provider:'api',model:'QA isolated model',effort:'medium'});ConversationModels.resolve=async value=>value;window.__qaRound=0;AgentTransport.requestPlan=options=>{window.__qaRound++;options.onPhase?.('reasoning');return new Promise((resolve,reject)=>{window.__qaTransport={options,resolve,reject};options.signal.addEventListener('abort',()=>{const e=new Error('验收主动停止');e.code='CANCELLED';reject(e);},{once:true});});};})()`);
 await evaluate(`$('#agentInput').value='验证终态回看';$('#agentInput').dispatchEvent(new Event('input',{bubbles:true}))`);
 await evaluate(`document.querySelector('#agentSend').click()`);
 await until(()=>evaluate('__qaRound>0'),'mock transport started');
 const messageId=await evaluate(`currentConversation().messages.at(-1).id`),scope=`[data-message-id="${messageId}"]`;
 const inject=async events=>{await evaluate(`(()=>{const o=__qaTransport.options;${events}})()`);await wait(180);};
 // 连续过程（ConversationFlow v1）：思考段 progressKey=ConversationProcess.flowKey 复合键；工具段是账本行 data-tool-id=provider:main:<id>，开合记在 run.toolLedgerPins。
 const flowKey=id=>'flow:'+JSON.stringify(['reasoning',null,null,id]),node=key=>key==='feed'?`${scope} .agent-progress`:key.startsWith('tool-')?`${scope} .tool-ledger-row[data-tool-id="provider:main:${key}"]`:`${scope} [data-progress-key='${flowKey(key)}']`;
 const openOf=key=>evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(node(key))});return n?n.open:null})()`);
 const clickSummary=key=>evaluate(`document.querySelector(${JSON.stringify(node(key)+' > summary')}).click()`);
 await step('构造完整一轮（含思考摘要与工具段）并完成',async()=>{
  await inject(`o.onActivity({kind:'summary',id:'seg-1',status:'running',text:'先核对公开资料。'});o.onActivity({kind:'tool',id:'tool-1',status:'running',name:'读取原始资料',text:'定位第 3 页'});`);
  await inject(`o.onActivity({kind:'summary',id:'seg-1',status:'completed',text:'第一步已完成。'});o.onActivity({kind:'tool',id:'tool-1',status:'completed',name:'读取原始资料',text:'第 3 页已读取，共 12 段'});o.onActivity({kind:'summary',id:'seg-2',status:'running',text:'第二步：汇总结论。'});`);
  await evaluate(`__qaTransport.resolve(JSON.stringify({workspace:'日常',message:'终态回看验收完成。',actions:[]}));`);
  await until(()=>evaluate('!sendMessage.busy'),'successful completion');
  await wait(250);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(scope+' .agent-progress')}).open`),false,'终态过程条默认收束');
 });
 await step('终态下可重新展开过程总览，且各段与正文仍在',async()=>{
  await clickSummary('feed');await wait(200);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(scope+' .agent-progress')}).open`),true,'终态点击应能重新展开过程总览');
  // 诊断：列出全部条目的构成（id / kind / 是否可展开 / 文本），用于确认哪些行可回看
  // 过程行（思考/工具）在 .conversation-flow 中；固定阶段只作状态记录，收在“阶段记录”诊断里。
  const items=await evaluate(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(scope+' .agent-progress .conversation-flow > .conversation-flow-item, '+scope+' .agent-progress .conversation-flow-stages > li')})].map(li=>{const d=li.querySelector('details.conversation-flow-reasoning-details,details.tool-ledger-row');const body=!d?'':d.matches('.tool-ledger-row')?[...d.children].filter(n=>n.nodeName!=='SUMMARY'&&!n.matches('.tool-ledger-raw')).map(n=>n.textContent).join(''):d.querySelector(':scope > .conversation-flow-text')?.textContent||'';const id=li.dataset.flowKind==='reasoning'?JSON.parse(li.dataset.flowId)[3]:d?.dataset.toolId?.replace(/^provider:main:/,'')||'stage:'+li.textContent.trim();return{id,expandable:!!d,bodyChars:body.trim().length,label:(li.querySelector('summary')||li).textContent.trim().slice(0,32)};}),null,1)`);
  console.log('ITEMS',items);
  const listed=JSON.parse(items);
  for(const id of ['seg-1','tool-1','seg-2'])assert.ok(listed.some(item=>item.id===id&&item.expandable),`段 ${id} 应作为可展开条目出现`);
  assert.ok(listed.filter(item=>item.id==='seg-1'&&item.bodyChars>0).length===1,'思考摘要详情正文应可回看');
  assert.ok(listed.filter(item=>item.id==='tool-1'&&item.bodyChars>0).length===1,'工具段结果应可回看');
  assert.ok(listed.filter(item=>!item.expandable).length>0,'没有正文的阶段仅显示状态，不提供空的展开入口');
  assert.ok(listed.filter(item=>item.expandable).every(item=>item.bodyChars>0),'只有有真实内容的过程才可展开');
 });
 await step('终态下可逐段展开回看详情',async()=>{
  assert.equal(await openOf('seg-1'),false,'未固定过的段终态收束');
  await clickSummary('seg-1');await wait(200);
  assert.equal(await openOf('seg-1'),true,'终态点击段标题应能展开');
  const body=await evaluate(`(()=>{const d=document.querySelector(${JSON.stringify(node('seg-1'))});return d.querySelector(':scope > .conversation-flow-text')?.textContent||''})()`);
  assert.ok(body.includes('第一步已完成'),'展开后应能看到段的详情正文');
  assert.equal(await openOf('tool-1'),false,'未固定过的工具段终态收束');
  await clickSummary('tool-1');await wait(200);
  assert.equal(await openOf('tool-1'),true,'工具段同样可展开回看');
  assert.match(await evaluate(`document.querySelector(${JSON.stringify(node('tool-1'))}).textContent`),/第 3 页已读取，共 12 段/,'工具段结果正文可回看');
 });
 await step('终态展开状态随消息持久化（重载后仍可回看）',async()=>{
  await evaluate('save();flushWorkspace()');await until(()=>evaluate('!serverSaveInFlight&&!serverSaveQueued&&!state._pendingLocalSave'),'persist');
  const pins=await evaluate(`JSON.stringify(currentConversation().messages.at(-1).progressPins||null)`);
  assert.equal(pins,JSON.stringify({feed:true,[flowKey('seg-1')]:true}),'终态下的开合选择进入 progressPins');
  assert.equal(await evaluate(`JSON.stringify(state.agentRuns.at(-1).toolLedgerPins||null)`),'{"provider:main:tool-1":true}','工具段的终态开合选择进入 run.toolLedgerPins');
  assert.equal(await evaluate(`JSON.stringify(currentConversation().messages.at(-1).conversationFlow.items.map(i=>[i.kind,i.status]))`),'[["reasoning","completed"],["tool","completed"],["reasoning","completed"]]','连续过程记录随终态保存');
  const activities=await evaluate(`JSON.stringify((currentConversation().messages.at(-1).activities||[]).map(a=>a.id))`);
  assert.equal(activities,'["seg-1","tool-1","seg-2"]','活动明细不因终态保存被裁剪');
  await evaluate('renderAll()');await wait(200);
  assert.equal(await openOf('seg-1'),true,'重渲染后展开状态保持');
  assert.equal(await openOf('tool-1'),true,'重渲染后工具段展开状态保持');
  assert.ok((await evaluate(`document.querySelector(${JSON.stringify(node('seg-1'))}).querySelector(':scope > .conversation-flow-text')?.textContent||''`)).includes('第一步已完成'),'重渲染后思考详情仍可回看');
 });
 await step('终态回看不引入新增渲染器错误',async()=>{
  const introduced=errors.filter(message=>!bootErrors.includes(message)&&!/covered/.test(message));
  assert.deepEqual(introduced,[],'除启动基线外无新增渲染器错误');
 });
 console.log(JSON.stringify({passed:passed.length,failures,qaStore:TEMP},null,2));
 assert.deepEqual(failures,[]);
}
function finish(code){clearTimeout(watchdog);win?.destroy();server?.kill('SIGTERM');code?app.exit(code):app.quit();}
run().then(()=>finish(0)).catch(error=>{console.error(error);console.error('QA store retained:',TEMP);finish(1);});
