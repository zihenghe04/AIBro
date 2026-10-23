/* 段级呼吸验收（真实渲染器）：执行过程段在流式时自动展开、完成后自动收束；
   用户显式开合过的段以用户的选择为准，不被后续流式更新还原。
   合成公开传输事件；出站模型/账号请求一律拒绝。
   运行：node_modules/.bin/electron tests/agent-progress-breathing-smoke.cjs */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18898,ORIGIN=`http://127.0.0.1:${PORT}`;
const TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aw-progress-breathing-')),STORE=path.join(TEMP,'store');fs.mkdirSync(STORE);fs.mkdirSync(path.join(TEMP,'profile'));app.setPath('userData',path.join(TEMP,'profile'));
let server,win;const passed=[],failures=[];const wait=ms=>new Promise(r=>setTimeout(r,ms));
const request=route=>new Promise((resolve,reject)=>http.get(ORIGIN+route,r=>{const chunks=[];r.on('data',c=>chunks.push(c));r.on('end',()=>resolve({status:r.statusCode,body:Buffer.concat(chunks)}));}).on('error',reject));
async function until(fn,label,timeout=15000){const start=Date.now();while(Date.now()-start<timeout){if(await fn())return;await wait(60);}throw Error(`Timed out: ${label}`);}
const watchdog=setTimeout(()=>{console.error('QA timeout',TEMP);win?.destroy();server?.kill('SIGTERM');app.exit(1);},180000);
async function run(){
 await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',()=>reject(Error(`${PORT} occupied; refusing existing workspace`)));probe.listen(PORT,'127.0.0.1',()=>probe.close(resolve));});
 const log=fs.openSync(path.join(TEMP,'server.log'),'a');server=spawn(process.env.PYTHON||'python3',[path.join(ROOT,'app','server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(PORT),AI_WORKSTATION_DATA_DIR:STORE,AI_WORKSTATION_ASSET_DIR:path.join(ROOT,'app')},stdio:['ignore',log,log]});
 await until(async()=>{if(server.exitCode!==null)throw Error('QA service exited');try{return(await request('/__health')).status===200;}catch{return false;}},'QA service');
 await app.whenReady();win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const errors=[];win.webContents.on('console-message',(event,level,message)=>{const isError=event&&typeof event==='object'&&!Array.isArray(event)&&('level' in event)?event.level==='error':level>=3;const text=(event&&typeof event==='object'&&'message' in event)?event.message:message;if(isError){errors.push(text);console.error('RENDERER',text,'@',(event?.sourceId||'?')+':'+(event?.lineNumber??'?'));}});
 const evaluate=async code=>{try{return await win.webContents.executeJavaScript(code,true);}catch(error){console.error('Renderer errors:',JSON.stringify(errors));throw error;}};
 async function step(label,fn){try{await fn();passed.push(label);console.log('PASS',label);}catch(error){failures.push({label,error:error.stack});console.error('FAIL',label,error.message);}}
 await win.loadURL(ORIGIN);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydration');
 assert.equal(await evaluate('!!window.AgentProgress'),true);
 await wait(900);const bootErrors=[...errors];console.log('BOOT ERRORS',JSON.stringify(bootErrors));
 await evaluate(`(()=>{window.__qaToggles=[];document.addEventListener('toggle',event=>{const node=event.target;if(!node?.dataset?.progressKey)return;window.__qaToggles.push({key:node.dataset.progressKey,open:node.open,connected:node.isConnected,trusted:event.isTrusted,at:Math.round(performance.now())});},true);})()`);
 await evaluate(`(()=>{const now=Date.now();state.projects=[];state.notes=[];state.tasks=[];state.imports=[];state.agentRuns=[];state.conversations=[{id:'qa_breathing_conversation',title:'隔离验收 · 段级呼吸',workspace:'日常',permissionMode:'auto',attachments:[],draftAttachmentIds:[],draft:'',messages:[],createdAt:now}];state.currentConversationId='qa_breathing_conversation';state.settings.permissions={'日常':'auto','课程':'auto','科研':'auto'};normalizeStateShape(state);state.ui.inspectorOpen=false;save();applyUiPreferences();showView('agent','对话');renderAll();$('#apiBase').value='https://fixture.invalid/v1';$('#apiKey').value='isolated-test-placeholder';ConversationModels.configuration=()=>({provider:'api',model:'QA isolated model',effort:'medium'});ConversationModels.resolve=async value=>value;window.__qaRound=0;AgentTransport.requestPlan=options=>{window.__qaRound++;options.onPhase?.('reasoning');return new Promise((resolve,reject)=>{window.__qaTransport={options,resolve,reject};options.signal.addEventListener('abort',()=>{const e=new Error('验收主动停止');e.code='CANCELLED';reject(e);},{once:true});});};})()`);
 await evaluate(`$('#agentInput').value='验证执行过程的展开与收束';$('#agentInput').dispatchEvent(new Event('input',{bubbles:true}))`);
 await evaluate(`document.querySelector('#agentSend').click()`);
 await until(()=>evaluate('__qaRound>0'),'mock transport started');
 const messageId=await evaluate(`currentConversation().messages.at(-1).id`),scope=`[data-message-id="${messageId}"]`;
 // 连续过程（ConversationFlow v1）：思考段的 progressKey 是 ConversationProcess.flowKey 的复合键；工具段是 ToolScheduler 账本行（data-tool-id=provider:main:<id>），开合记在 run.toolLedgerPins。
 const flowKey=id=>'flow:'+JSON.stringify(['reasoning',null,null,id]),reasoning=id=>`${scope} [data-progress-key='${flowKey(id)}']`,tool=id=>`${scope} .tool-ledger-row[data-tool-id="provider:main:${id}"]`;
 const openOf=selector=>evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return n?n.open:null})()`),textOf=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent??null`);
 const clickSummary=selector=>evaluate(`document.querySelector(${JSON.stringify(selector+' > summary')}).click()`);
 // Kit 摘要在挂载时异步渲染；文字出现前短暂等待，再按原断言判定。
 const showsText=async(selector,pattern,label)=>{await until(async()=>pattern.test(await textOf(selector)||''),label).catch(()=>{});assert.match(await textOf(selector)||'',pattern,label);};
 // interaction-system.js 的开合动画结束才写回 open；等动画结束再读，等同用户看完再操作。
 const settled=()=>until(()=>evaluate(`!document.getAnimations().some(a=>a.effect?.target?.nodeName==='DETAILS'&&a.playState!=='finished')`),'disclosure animation');
 const inject=async events=>{await evaluate(`(()=>{const o=__qaTransport.options;${events}})()`);await wait(180);};
 await step('正在流式的段自动展开，工具段与摘要段各自独立',async()=>{
  await inject(`o.onActivity({kind:'summary',id:'seg-a',status:'running',text:'第一步：核对公开资料。'});o.onActivity({kind:'tool',id:'tool-x',status:'running',name:'读取原始资料',text:'定位第 3 页'});`);
  // 思考段流式时自动展开、结束后自动收起；用户显式开合优先（tests/conversation-flow-ui.test.cjs “reasoning opens while it streams”）。
  await showsText(reasoning('seg-a')+' > summary',/第一步：核对公开资料。/,'流式思考段的标题行应实时显示最新内容');
  await settled();assert.equal(await openOf(reasoning('seg-a')),true,'流式思考段自动展开，实时显示思考过程');
  assert.equal(await openOf(tool('tool-x')),true,'进行中的工具段应自动展开');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(reasoning('seg-a'))}).closest('.conversation-flow-item')!==document.querySelector(${JSON.stringify(tool('tool-x'))}).closest('.conversation-flow-item')`),true,'思考段与工具段是各自独立的过程行');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(scope+' .agent-progress')}).open`),true,'整轮执行中过程条应展开');
 });
 await step('段完成后自动收束，下一段接管展开（呼吸）',async()=>{
  await inject(`o.onActivity({kind:'summary',id:'seg-a',status:'completed',text:'第一步已完成。'});o.onActivity({kind:'tool',id:'tool-x',status:'completed',name:'读取原始资料',text:'第 3 页已读取'});o.onActivity({kind:'tool',id:'tool-y',status:'running',name:'写入笔记',text:'保存中'});`);
  assert.equal(await openOf(tool('tool-x')),false,'已完成的段应自动收束');
  await settled();assert.equal(await openOf(reasoning('seg-a')),false,'思考段结束后自动收起');
  await showsText(reasoning('seg-a')+' > summary',/第一步已完成。/,'收起的思考段保留最新内容预览');
  assert.equal(await openOf(tool('tool-y')),true,'新开始的段应接管展开');
 });
 await step('用户显式展开的段在后续流式更新中保持展开',async()=>{
  await clickSummary(reasoning('seg-a'));
  assert.equal(await openOf(reasoning('seg-a')),true,'点击后应立即展开');
  await inject(`o.onActivity({kind:'summary',id:'seg-b',status:'running',text:'第二步：继续核对。'});`);
  assert.equal(await openOf(reasoning('seg-a')),true,'用户展开的已完成段不应被自动逻辑收束');
  assert.equal(await openOf(tool('tool-y')),true,'未被用户干预的进行中段仍按自动逻辑展开');
  await showsText(reasoning('seg-b')+' > summary',/第二步：继续核对。/,'新段出现并实时显示');
 });
 await step('用户关闭的段在后续流式更新中保持关闭',async()=>{
  await settled();
  assert.equal(await openOf(reasoning('seg-b')),true,'正在流式的思考段已自动展开');
  await clickSummary(reasoning('seg-b'));
  assert.equal(await evaluate(`currentConversation().messages.at(-1).progressPins[${JSON.stringify(flowKey('seg-b'))}]`),false,'动画开始时立即记住关闭意图');
  await inject(`o.onActivity({kind:'summary',id:'seg-b',status:'running',text:'第二步：新内容到达。'});`);
  await until(async()=>await openOf(reasoning('seg-b'))===false,'关闭动画完成');
  assert.equal(await openOf(reasoning('seg-b')),false,'用户关闭的流式段应保持关闭');
  await inject(`o.onActivity({kind:'tool',id:'tool-z',status:'running',name:'检索资料',text:'检索中'});`);
  assert.equal(await openOf(tool('tool-z')),true,'新的进行中工具段自动展开');
  await settled();await clickSummary(tool('tool-z'));
  assert.equal(await evaluate(`state.agentRuns.at(-1).toolLedgerPins?.['provider:main:tool-z']`),false,'工具段的关闭意图记入 run.toolLedgerPins');
  await inject(`o.onActivity({kind:'tool',id:'tool-z',status:'running',name:'检索资料',text:'检索中：第二批'});`);
  await until(async()=>await openOf(tool('tool-z'))===false,'工具段关闭动画完成');
  await inject(`o.onActivity({kind:'tool',id:'tool-z',status:'running',name:'检索资料',text:'检索中：第三批'});`);
  assert.equal(await openOf(tool('tool-z')),false,'用户关闭的进行中工具段不被自动展开覆盖');
 });
 await step('展开的段完整显示、无内部滚动（不靠悬停滚轮查看）',async()=>{
  const longText=Array.from({length:40},(_,i)=>`第 ${i+1} 行：这是一段较长的深度思考内容，用于验证展开后应当完整可见，而不是被限制在固定高度里需要用滚轮查看。`).join('\n');
  await inject(`o.onActivity({kind:'summary',id:'seg-long',status:'running',text:${JSON.stringify(longText)}});`);
  // 流式思考段自动展开，无需点击。新行的进入动画（短暂上移 4px）结束后再测量。
  await settled();await until(()=>evaluate(`!document.querySelector(${JSON.stringify(scope)}).getAnimations({subtree:true}).some(a=>a.playState==='running')`),'entrance animations');
  // 思考正文经宿主安全 Markdown 渲染，换行成为段落/软换行；按去空白后的文字比对是否完整。
  const probe=await evaluate(`(()=>{const scope=document.querySelector(${JSON.stringify(scope)});const details=document.querySelector(${JSON.stringify(reasoning('seg-long'))});const body=details.querySelector(':scope > .conversation-flow-text');const timeline=scope.querySelector('.conversation-flow');return {feedOpen:scope.querySelector('.agent-progress').open,open:details.open,bodyScroll:body.scrollHeight,bodyClient:body.clientHeight,bodyText:body.textContent.replace(/\\s+/g,''),expected:${JSON.stringify(longText.replace(/\s+/g,''))},bodyHeight:Math.round(body.getBoundingClientRect().height),timelineOverflow:timeline.scrollHeight-timeline.clientHeight};})()`);
  assert.equal(probe.feedOpen,true,'执行中过程条应处于展开态');
  assert.equal(probe.open,true,'流式思考段自动处于展开态');
  assert.equal(probe.bodyText,probe.expected,'展开的内容必须完整渲染（不截断）');
  assert.ok(probe.bodyScroll<=probe.bodyClient+1,`段内容不得产生内部滚动（scrollHeight ${probe.bodyScroll} / clientHeight ${probe.bodyClient}）`);
  assert.ok(probe.timelineOverflow<=1,`时间线不得产生内部滚动（溢出 ${probe.timelineOverflow}px）`);
  assert.ok(probe.bodyHeight>400,`展开高度应随内容增长（实测 ${probe.bodyHeight}px）`);
 });
 await step('轮次结束后过程条整体收束，用户的段级选择被保留',async()=>{
  await evaluate(`__qaTransport.resolve(JSON.stringify({workspace:'日常',message:'段级呼吸验收完成。',actions:[]}));`);
  await until(()=>evaluate('!sendMessage.busy'),'successful completion');
  await wait(200);await settled();
  assert.equal(await openOf(reasoning('seg-a')),true,'用户展开过的段保持展开');
  assert.equal(await openOf(reasoning('seg-b')),false,'用户关闭过的段保持关闭');
  assert.equal(await openOf(tool('tool-z')),false,'用户关闭过的工具段保持关闭');
  assert.equal(await openOf(tool('tool-y')),false,'未被用户干预的段终态收束');
  assert.equal(await openOf(tool('tool-x')),false,'已完成的工具段终态收束');
  // 有用户展开（正在回看）的段时，终态重绘不把它连同外层一起藏起来；外层由用户显式收起，且显式收起优先
  // （app/conversation-process.js composeFlow 的 readingPinned；tests/agent-progress.test.js “finishing a run does not hide a pinned detail”）。
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(scope+' .agent-progress')}).open`),true,'用户正在回看的段让过程条在终态保持可见');
  await clickSummary(scope+' .agent-progress');await settled();
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(scope+' .agent-progress')}).open`),false,'终态过程条由用户收束');
  await evaluate('renderConversation()');await wait(200);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(scope+' .agent-progress')}).open`),false,'显式收束在终态重绘后保持');
  assert.equal(await openOf(reasoning('seg-a')),true,'收束外层不改写段级选择');
 });
 await step('呼吸状态随消息持久化且不引入新增渲染器错误',async()=>{
  await evaluate('save();flushWorkspace()');await until(()=>evaluate('!serverSaveInFlight&&!serverSaveQueued&&!state._pendingLocalSave'),'persist');
  const pins=await evaluate(`JSON.stringify(currentConversation().messages.at(-1).progressPins||null)`);
  assert.equal(pins,JSON.stringify({[flowKey('seg-a')]:true,[flowKey('seg-b')]:false,feed:false}),'只有用户显式开合的段进入 progressPins');
  assert.equal(await evaluate(`JSON.stringify(state.agentRuns.at(-1).toolLedgerPins||null)`),'{"provider:main:tool-z":false}','工具段只有用户显式开合的进入 run.toolLedgerPins');
  // 以启动基线为参照：启动即存在的既有噪声不计入本次回归（其根因与执行过程渲染无关）。
  const introduced=errors.filter(message=>!bootErrors.includes(message)&&!/covered/.test(message));
  assert.deepEqual(introduced,[],'除启动基线外无新增渲染器错误');
 });
 await step('思考段以“模型思考”命名（区分服务返回的思考与公开摘要），且与工具段分层',async()=>{
  // 2026-10-03 process-transparency 批次把“深度思考”改为“模型思考 / Model reasoning”（test-results/process-transparency-20261003/progress/scope.patch；理由见同目录 conversation-ux-gap.md 第 6 条）。
  const heading=await textOf(reasoning('seg-a')+' > summary');
  assert.match(heading,/^模型思考/,'思考段标题应为“模型思考”');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(reasoning('seg-a'))}).closest('.conversation-flow-item').dataset.flowKind`),'reasoning','思考段属于 reasoning 过程行');
  const toolTitle=await textOf(tool('tool-y')+' > summary');
  assert.match(toolTitle,/^写入笔记/,'工具段以工具名命名');
  assert.ok(!/模型思考|深度思考/.test(toolTitle),'工具段不得被标成思考段');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(tool('tool-y'))}).closest('.conversation-flow-item').dataset.flowKind`),'tool','工具段属于独立的 tool 过程行');
 });
 await step('工具记录默认层人类可读，原始 JSON 收入“查看原始数据”二级折叠',async()=>{
  const result=await evaluate(`(()=>{const card=ToolScheduler.card({toolCalls:[{id:'qa-1',parentId:null,type:'read',status:'completed',request:{type:'read',id:'note_1'},result:{result:{title:'验收笔记',content:('第一行\\n第二行').repeat(60)},truncated:false}}]});document.body.append(card);const lines=[...card.querySelectorAll('.tool-ledger-line')].map(node=>node.textContent);const captions=[...card.querySelectorAll('.tool-ledger-caption')].map(node=>node.textContent);const raw=card.querySelector('.tool-ledger-raw');const field=card.querySelector('.tool-ledger-text-field');const before={open:field?.open??null,full:!!field?.querySelector('.tool-ledger-full-text'),label:field?.querySelector(':scope > summary .tool-ledger-expand-label')?.textContent||null,preview:field?.querySelector('.tool-ledger-text-preview')?.textContent.slice(0,12)||null};field?.querySelector(':scope > summary').click();const full=field?.querySelector('.tool-ledger-full-text');const expected=('第一行\\n第二行').repeat(60);const fieldState={before,full:full?full.textContent:null,expected};const out={lines,captions,rawSummary:raw?raw.querySelector('summary').textContent:null,rawText:raw?raw.querySelector('pre').textContent:'',topLevelPre:card.querySelectorAll('.tool-ledger-row>pre').length,rawCount:card.querySelectorAll('.tool-ledger-raw pre').length,fieldState};card.remove();return out;})()`);
  assert.ok(result.captions.includes('参数')&&result.captions.includes('结果'),'参数与结果必须分区呈现');
  assert.ok(result.lines.some(line=>line.includes('read')),'请求字段以键值行呈现');
  assert.equal(result.topLevelPre,0,'首层不得再直接倾倒原始 JSON');
  assert.equal(result.rawSummary,'查看原始数据','原始数据保留在二级折叠入口');
  assert.match(result.rawText,/"note_1"/,'原始请求 JSON 仍可核查（不丢数据）');
  assert.equal(result.rawCount,2,'请求与结果的原始 JSON 都在');
  // 长文本字段（>300 字）默认给短预览与“查看全文”，用户展开后挂载完整正文（docs/CONVERSATION_TOOL_TEXT_20261003.md）。
  assert.equal(result.fieldState.before.open,false,'长文本字段默认收起为短预览');
  assert.equal(result.fieldState.before.label,'查看全文','长文本字段提供“查看全文”入口');
  assert.ok(result.fieldState.before.preview?.startsWith('第一行'),'短预览显示正文开头');
  assert.equal(result.fieldState.before.full,false,'未展开时不挂载全文');
  assert.equal(result.fieldState.full,result.fieldState.expected,'长文本字段以正文块完整显示');
 });
 await step('工具执行记录自动呼吸：执行中展开、终态收敛、用户手动优先',async()=>{
  const probe=await evaluate(`(()=>{
    const host=document.createElement('div');host.style.display='none';document.body.append(host);
    const live=ToolScheduler.card({status:'running',toolCalls:[
      {id:'br-1',type:'read',status:'running',request:{type:'read',id:'n1'}},
      {id:'br-2',type:'read',status:'completed',request:{type:'read',id:'n2'},finishedAt:Date.now()}
    ]});
    host.append(live);
    const liveState={open:live.open,rows:[...live.querySelectorAll('.tool-ledger-row')].map(row=>row.open)};
    const done=ToolScheduler.card({status:'completed',finishedAt:Date.now(),toolCalls:[{id:'br-3',type:'read',status:'completed',request:{type:'read'}}]});
    host.append(done);
    const doneState={open:done.open,rows:[...done.querySelectorAll('.tool-ledger-row')].map(row=>row.open)};
    const pinned=ToolScheduler.card({status:'completed',finishedAt:Date.now(),toolLedgerPins:{ledger:true},toolCalls:[{id:'br-4',type:'read',status:'completed',request:{type:'read'}}]});
    host.append(pinned);
    const pinnedState={open:pinned.open};
    const heldOpen=ToolScheduler.card({status:'running',toolLedgerPins:{ledger:false},toolCalls:[{id:'br-5',type:'read',status:'running',request:{type:'read'}}]});
    host.append(heldOpen);
    const heldState={open:heldOpen.open,row:heldOpen.querySelector('.tool-ledger-row').open};
    host.remove();
    return {liveState,doneState,pinnedState,heldState};
  })()`);
  assert.equal(probe.liveState.open,true,'执行中的工具记录应自动展开（实时看到正在调用什么）');
  assert.deepEqual(probe.liveState.rows,[true,false],'正在执行的行展开、已完成的行收起');
  assert.equal(probe.doneState.open,false,'终态工具记录应收敛成一行摘要');
  assert.equal(probe.doneState.rows[0],false,'终态所有工具行收起');
  assert.equal(probe.pinnedState.open,true,'用户固定展开后，终态也不得自动收起');
  assert.equal(probe.heldState.open,false,'用户固定收起后，执行中也不得自动展开');
  assert.equal(probe.heldState.row,true,'行级 pin 未设置时该行仍按自动逻辑展开');
 });
 console.log(JSON.stringify({passed:passed.length,failures,qaStore:TEMP,modelCalls:0},null,2));
 assert.deepEqual(failures,[]);
}
function finish(code){clearTimeout(watchdog);win?.destroy();server?.kill('SIGTERM');code?app.exit(code):app.quit();}
run().then(()=>finish(0)).catch(error=>{console.error(error);console.error('QA store retained:',TEMP);finish(1);});
