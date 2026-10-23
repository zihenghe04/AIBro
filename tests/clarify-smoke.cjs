/* 结构化问询卡片验收：真实渲染器中，Agent 以选择题提问，用户点选后可一键提交；
   提交的结果是一条普通用户消息，走既有发送 / 排队路径；提交后卡片只读并保留当时选择。
   合成公开传输事件；出站模型请求一律拒绝。
   运行：node_modules/.bin/electron tests/clarify-smoke.cjs */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18902,ORIGIN=`http://127.0.0.1:${PORT}`;
const TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aw-clarify-')),STORE=path.join(TEMP,'store');fs.mkdirSync(STORE);fs.mkdirSync(path.join(TEMP,'profile'));app.setPath('userData',path.join(TEMP,'profile'));
let server,win;const passed=[],failures=[];const wait=ms=>new Promise(r=>setTimeout(r,ms));
const request=route=>new Promise((resolve,reject)=>http.get(ORIGIN+route,r=>{const chunks=[];r.on('data',c=>chunks.push(c));r.on('end',()=>resolve({status:r.statusCode,body:Buffer.concat(chunks)}));}).on('error',reject));
async function until(fn,label,timeout=15000){const start=Date.now();while(Date.now()-start<timeout){if(await fn())return;await wait(60);}throw Error(`Timed out: ${label}`);}
const watchdog=setTimeout(()=>{console.error('QA timeout',TEMP);win?.destroy();server?.kill('SIGTERM');app.exit(1);},180000);
async function run(){
 await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',()=>reject(Error(`${PORT} occupied; refusing existing workspace`)));probe.listen(PORT,'127.0.0.1',()=>probe.close(resolve));});
 const log=fs.openSync(path.join(TEMP,'server.log'),'a');server=spawn(process.env.PYTHON||'python3',[path.join(ROOT,'app','server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(PORT),AI_WORKSTATION_DATA_DIR:STORE,AI_WORKSTATION_ASSET_DIR:path.join(ROOT,'app')},stdio:['ignore',log,log]});
 await until(async()=>{if(server.exitCode!==null)throw Error('QA service exited');try{return(await request('/__health')).status===200;}catch{return false;}},'QA service');
 await app.whenReady();win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const errors=[];win.webContents.on('console-message',(_event,level,message)=>{if(level>=3){errors.push(message);console.error('RENDERER',message);}});
 const evaluate=async code=>{try{return await win.webContents.executeJavaScript(code,true);}catch(error){console.error('Renderer errors:',JSON.stringify(errors));throw error;}};
 async function step(label,fn){try{await fn();passed.push(label);console.log('PASS',label);}catch(error){failures.push({label,error:error.stack});console.error('FAIL',label,error.message);}}
 await win.loadURL(ORIGIN);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydration');
 await wait(600);
 assert.equal(await evaluate('!!window.ClarifyQuestions'),true,'问询模块必须先于应用加载');
 await evaluate(`(()=>{
  const now=Date.now();
  state.projects=[];state.notes=[];state.tasks=[];state.imports=[];state.agentRuns=[];
  state.conversations=[{id:'qa_clarify_conversation',title:'隔离验收 · 结构化问询',workspace:'日常',permissionMode:'auto',attachments:[],draftAttachmentIds:[],draft:'',messages:[],createdAt:now}];
  state.currentConversationId='qa_clarify_conversation';
  state.settings.permissions={'日常':'auto','课程':'auto','科研':'auto'};
  normalizeStateShape(state);state.ui.inspectorOpen=false;save();applyUiPreferences();showView('agent','对话');
  $('#apiBase').value='https://fixture.invalid/v1';$('#apiKey').value='isolated-test-placeholder';
  ConversationModels.configuration=()=>({provider:'api',model:'QA isolated model',effort:'medium'});
  ConversationModels.resolve=async value=>value;
  window.__qaRound=0;
  AgentTransport.requestPlan=options=>{window.__qaRound++;window.__qaTransport={options};return new Promise((resolve,reject)=>{window.__qaTransport.resolve=resolve;options.signal.addEventListener('abort',()=>{const e=new Error('验收主动停止');e.code='CANCELLED';reject(e);},{once:true});});};
  const conversation=state.conversations[0];
  conversation.messages.push({id:'qa-clarify-a',role:'agent',at:now,text:'我需要先确认几个信息。',clarify:{questions:ClarifyQuestions.validate([
    {id:'q1',question:'计划哪天发布？',options:['9月上旬','9月中旬','9月下旬'],multiple:false},
    {id:'q2',question:'主要渠道？',options:['官网','社交媒体','用户社群'],multiple:true},
  ]),draft:{},submittedAt:0,answers:null}});
  conversation.messages.push({id:'qa-clarify-b',role:'agent',at:now+1,text:'还有一个问题。',clarify:{questions:ClarifyQuestions.validate([
    {id:'q1',question:'预算范围？',options:['1 万以内','1-5 万'],multiple:false},
  ]),draft:{},submittedAt:0,answers:null}});
  save();renderAll();
 })()`);
 await step('问询卡片渲染为选择题：两个问题、六个选项、多选标注与提交入口',async()=>{
  const card=await evaluate(`(()=>{const host=document.querySelector('[data-clarify-message="qa-clarify-a"]');if(!host)return null;const card=host.querySelector('.clarify-card');return{questions:card.querySelectorAll('.clarify-question').length,options:card.querySelectorAll('[data-clarify-pick]').length,submit:!!card.querySelector('.clarify-submit'),multiple:card.querySelector('.clarify-multiple')?.textContent||'',pressed:[...card.querySelectorAll('[aria-pressed]')].every(node=>node.getAttribute('aria-pressed')==='false')};})()`);
  assert.ok(card,'卡片应渲染在对应消息上');
  assert.equal(card.questions,2);
  assert.equal(card.options,6);
  assert.equal(card.submit,true);
  assert.match(card.multiple,/可多选/);
  assert.equal(card.pressed,true,'初始时所有选项都应是未选中状态');
 });
 await step('点选工作正常：单选互斥可取消、多选累积、aria-pressed 同步',async()=>{
  const press=async(value,question='q1',message='qa-clarify-a')=>{await evaluate(`document.querySelector('[data-clarify-message="${message}"] [data-clarify-question="${question}"] [data-clarify-value="${value}"]').click()`);await wait(120);};
  const stateOf=(question='q1',message='qa-clarify-a')=>evaluate(`(()=>{const nodes=[...document.querySelectorAll('[data-clarify-message="${message}"] [data-clarify-question="${question}"] [data-clarify-pick]')];return nodes.map(n=>({v:n.dataset.clarifyValue,picked:n.classList.contains('is-picked'),pressed:n.getAttribute('aria-pressed')}));})()`);
  await press('9月中旬');
  let rows=await stateOf();
  assert.deepEqual(rows.map(r=>r.picked),[false,true,false],'单选：只有被点的一项选中');
  assert.equal(rows[1].pressed,'true');
  await press('9月下旬');
  rows=await stateOf();
  assert.deepEqual(rows.map(r=>r.picked),[false,false,true],'单选再点另一项应替换而不是叠加');
  await press('9月下旬');
  rows=await stateOf();
  assert.deepEqual(rows.map(r=>r.picked),[false,false,false],'再点同一项可取消选择');
  await press('9月中旬');
  await press('官网','q2');
  await press('用户社群','q2');
  const multi=await stateOf('q2');
  assert.deepEqual(multi.map(r=>r.picked),[true,false,true],'多选应累积');
 });
 await step('未选择任何项时提交被拒：不发送消息、不发起请求',async()=>{
  const before=await evaluate(`currentConversation().messages.length`);
  await evaluate(`document.querySelector('[data-clarify-message="qa-clarify-b"] .clarify-submit').click()`);
  await wait(220);
  assert.equal(await evaluate(`currentConversation().messages.length`),before,'被拒时不得新增消息');
  assert.match(await evaluate(`$('#toast').textContent`),/请先选择至少一项/);
  assert.equal(await evaluate(`__qaRound`),0,'被拒时不得发起模型请求');
 });
 await step('提交后回答作为一条普通用户消息发送，卡片转为只读并保留当时选择',async()=>{
  await evaluate(`document.querySelector('[data-clarify-message="qa-clarify-a"] .clarify-submit').click()`);
  await until(()=>evaluate('__qaRound===1'),'answer triggers a new round');
  const sent=await evaluate(`(()=>{const messages=currentConversation().messages;const index=messages.findIndex(m=>m.id==='qa-clarify-a');return messages.slice(index+1).find(m=>m.role==='user')?.text||'';})()`);
  assert.match(sent,/回答上面的问题/);
  assert.match(sent,/计划哪天发布？ 9月中旬/);
  assert.match(sent,/主要渠道？ 官网、用户社群/);
  const card=await evaluate(`(()=>{const card=document.querySelector('[data-clarify-message="qa-clarify-a"] .clarify-card');return{picks:card.querySelectorAll('[data-clarify-pick]').length,submit:!!card.querySelector('.clarify-submit'),picked:[...card.querySelectorAll('.clarify-option.is-picked')].map(n=>n.textContent),note:card.querySelector('.clarify-note').textContent};})()`);
  assert.equal(card.picks,0,'提交后不应再有可点选项');
  assert.equal(card.submit,false,'提交后不应再有提交按钮');
  assert.deepEqual([...card.picked].sort(),['9月中旬','官网','用户社群'].sort(),'只读视图保留当时的选择');
  assert.match(card.note,/已回答/);
  assert.ok(await evaluate(`currentConversation().messages.find(m=>m.id==='qa-clarify-a').clarify.submittedAt>0`),'提交时间必须记录');
  assert.equal(await evaluate(`currentConversation().messages.find(m=>m.id==='qa-clarify-a').text`),'我需要先确认几个信息。','原回复不得被改写');
 });
 await step('执行中提交回答自动进入既有队列：不丢内容、不打断当前轮',async()=>{
  assert.equal(await evaluate('!!sendMessage.busy'),true,'第一轮应仍在执行');
  await evaluate(`document.querySelector('[data-clarify-message="qa-clarify-b"] [data-clarify-question="q1"] [data-clarify-value="1-5 万"]').click()`);
  await evaluate(`document.querySelector('[data-clarify-message="qa-clarify-b"] .clarify-submit').click()`);
  await wait(260);
  const queued=await evaluate(`(()=>{const conversation=currentConversation();return{count:(conversation.pendingSubmits||[]).length,goals:(conversation.pendingSubmits||[]).map(item=>item.goal),toast:$('#toast').textContent,round:__qaRound};})()`);
  assert.equal(queued.count,1,'执行中提交应进入队列而不是被丢弃');
  assert.match(queued.goals[0],/预算范围？ 1-5 万/);
  assert.match(queued.toast,/回答已排队/);
  assert.equal(queued.round,1,'排队不得提前发起新请求');
  assert.equal(await evaluate(`currentConversation().messages.some(m=>m.role==='user'&&/预算范围/.test(m.text))`),false,'排队内容不得提前进入对话记录');
 });
 console.log(JSON.stringify({passed:passed.length,failures,qaStore:TEMP,modelCalls:0},null,2));
 assert.deepEqual(failures,[]);
}
function finish(code){clearTimeout(watchdog);win?.destroy();server?.kill('SIGTERM');code?app.exit(code):app.quit();}
run().then(()=>finish(0)).catch(error=>{console.error(error);console.error('QA store retained:',TEMP);finish(1);});
