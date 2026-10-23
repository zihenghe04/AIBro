/* 第 2 轮验收：大回复安全预览 / 会话内任务清单 / 三级审批「本会话允许」。
   真实渲染器中验证；出站模型请求一律拒绝（本脚本不发消息）。
   运行：node_modules/.bin/electron tests/agent-round2-smoke.cjs */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18905,ORIGIN=`http://127.0.0.1:${PORT}`;
const TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aw-round2-')),STORE=path.join(TEMP,'store');fs.mkdirSync(STORE);fs.mkdirSync(path.join(TEMP,'profile'));app.setPath('userData',path.join(TEMP,'profile'));
let server,win;const passed=[],failures=[];const wait=ms=>new Promise(r=>setTimeout(r,ms));
const request=route=>new Promise((resolve,reject)=>http.get(ORIGIN+route,r=>{r.resume();r.on('end',()=>resolve({status:r.statusCode}));}).on('error',reject));
async function until(fn,label,timeout=15000){const start=Date.now();while(Date.now()-start<timeout){if(await fn())return;await wait(60);}throw Error(`Timed out: ${label}`);}
const watchdog=setTimeout(()=>{console.error('QA timeout',TEMP);win?.destroy();server?.kill('SIGTERM');app.exit(1);},180000);
async function run(){
 await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',()=>reject(Error(`${PORT} occupied`)));probe.listen(PORT,'127.0.0.1',()=>probe.close(resolve));});
 const log=fs.openSync(path.join(TEMP,'server.log'),'a');server=spawn(process.env.PYTHON||'python3',[path.join(ROOT,'app','server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(PORT),AI_WORKSTATION_DATA_DIR:STORE,AI_WORKSTATION_ASSET_DIR:path.join(ROOT,'app')},stdio:['ignore',log,log]});
 await until(async()=>{if(server.exitCode!==null)throw Error('QA service exited');try{return(await request('/__health')).status===200;}catch{return false;}},'QA service');
 await app.whenReady();win=new BrowserWindow({show:true,width:1280,height:900,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const errors=[];win.webContents.on('console-message',(_event,level,message)=>{if(level>=3){errors.push(message);console.error('RENDERER',message);}});
 const evaluate=async code=>{try{return await win.webContents.executeJavaScript(code,true);}catch(error){console.error('Renderer errors:',JSON.stringify(errors));throw error;}};
 async function step(label,fn){try{await fn();passed.push(label);console.log('PASS',label);}catch(error){failures.push({label,error:error.stack});console.error('FAIL',label,error.message);}}
 await win.loadURL(ORIGIN);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydration');
 await wait(600);
 assert.equal(await evaluate('!!window.SafePreview'),true,'安全预览模块必须加载');
 assert.equal(await evaluate('!!window.SessionTasks'),true,'任务清单模块必须加载');

 await evaluate(`(()=>{const now=Date.now();
  state.projects=[];state.notes=[];state.tasks=[];state.imports=[];state.agentRuns=[];
  const big='# 大回复标题\\n\\n**粗体**段落。\\n\\n'+'正文内容'.repeat(3200);   // ≈ 12800+ 字符
  state.conversations=[{id:'qa_r2',title:'隔离验收 · 第 2 轮',workspace:'日常',permissionMode:'auto',attachments:[],draftAttachmentIds:[],draft:'',createdAt:now,updatedAt:now,messages:[
    {id:'big_msg',role:'agent',at:now,text:big},
    {id:'small_msg',role:'agent',at:now,text:'这条是普通长度的回复，应当照常渲染。'}
  ]}];
  state.currentConversationId='qa_r2';state.settings.permissions={'日常':'auto','课程':'auto','科研':'auto'};
  normalizeStateShape(state);state.ui.inspectorOpen=false;save();applyUiPreferences();showView('agent','对话');renderAll();})()`);
 await wait(500);

 await step('大回复安全预览：超大回复先给有界纯文本，并如实说明还有多少未渲染',async()=>{
  const probe=await evaluate(`(()=>{const wrap=document.querySelector('[data-message-id="big_msg"]');
   const preview=wrap?.querySelector('.safe-preview');
   const text=preview?.querySelector('.safe-preview-text');
   const notice=preview?.querySelector('.safe-preview-notice');
   const small=document.querySelector('[data-message-id="small_msg"]');
   return {hasPreview:!!preview,plain:!!text,textContent:text?.textContent||'',hasTags:(text?.innerHTML||'').includes('<strong>'),
     notice:notice?.textContent||'',smallPreview:!!small?.querySelector('.safe-preview'),action:!!preview?.querySelector('[data-preview-action="expand"]')};})()`);
  assert.equal(probe.hasPreview,true,'超大回复应先给安全预览');
  assert.ok(probe.textContent.includes('**粗体**'),'预览是纯文本：Markdown 记号原样保留，不当作渲染结果');
  assert.equal(probe.hasTags,false,'预览区不得含渲染后的 HTML 标签');
  assert.match(probe.notice,/未渲染/,'必须说明还有多少内容未渲染——不假装等于完整内容');
  assert.equal(probe.smallPreview,false,'普通长度的回复照常渲染，不受影响');
  assert.equal(probe.action,true,'应提供「显示完整内容」');
 });

 await step('安全预览可双向切换：展开为完整渲染，并可退回预览',async()=>{
  await evaluate(`document.querySelector('[data-preview-action="expand"]').click()`);
  await wait(400);
  const expanded=await evaluate(`(()=>{const wrap=document.querySelector('[data-message-id="big_msg"]');
   return {renderedStrong:!!wrap.querySelector('.message-body strong'),restore:!!wrap.querySelector('.safe-preview-restore [data-preview-action="restore"]'),stillPreview:!!wrap.querySelector('.safe-preview')};})()`);
  assert.equal(expanded.renderedStrong,true,'展开后按 Markdown 渲染');
  assert.equal(expanded.restore,true,'应提供「恢复安全预览」');
  await evaluate(`document.querySelector('[data-preview-action="restore"]').click()`);
  await wait(400);
  const restored=await evaluate(`!!document.querySelector('[data-message-id="big_msg"] .safe-preview')`);
  assert.equal(restored,true,'可以退回安全预览');
 });

 await step('会话内任务清单：进度计数、逐项勾选状态、清除入口',async()=>{
  const shown=await evaluate(`(()=>{const conversation=currentConversation();
   conversation.taskList={items:[{text:'读 package.json 并总结 scripts',done:true},{text:'新建 run.md 写入结论',done:false},{text:'ls -la 验证文件已生成',done:false}],updatedAt:Date.now()};
   save();renderConversation();
   const strip=$('#sessionTaskStrip');
   return {hidden:strip.hidden,title:strip.querySelector('.session-task-title')?.textContent||'',items:[...strip.querySelectorAll('.session-task-item')].map(n=>n.textContent.trim()),done:strip.querySelectorAll('.session-task-item.done').length,clear:!!strip.querySelector('[data-session-task-action="clear"]')};})()`);
  assert.equal(shown.hidden,false,'有待办时应显示清单');
  assert.match(shown.title,/1\/3/,'进度计数如实（1/3 完成）');
  assert.equal(shown.items.length,3);
  assert.match(shown.items[0],/☑/,'已完成项带勾选标记');
  assert.match(shown.items[1],/☐/,'未完成项带空框');
  assert.equal(shown.done,1);
  assert.equal(shown.clear,true,'提供清除入口');
  const cleared=await evaluate(`(()=>{document.querySelector('[data-session-task-action="clear"]').click();
   return {hasList:!!currentConversation().taskList,hidden:$('#sessionTaskStrip').hidden};})()`);
  assert.equal(cleared.hasList,false,'清除后会话不再保留清单');
  assert.equal(cleared.hidden,true,'清除后面板隐藏');
 });

 await step('会话内任务清单：全部完成时自动让位（不再占据输入区上方）',async()=>{
  const hidden=await evaluate(`(()=>{const conversation=currentConversation();
   conversation.taskList={items:[{text:'a',done:true},{text:'b',done:true}],updatedAt:Date.now()};
   save();renderConversation();
   const hiddenNow=$('#sessionTaskStrip').hidden;
   delete conversation.taskList;save();renderConversation();
   return hiddenNow;})()`);
  assert.equal(hidden,true,'全部完成时不再占据输入区上方（清单已留在对话里）');
 });

 await step('三级审批：审批卡提供「本会话允许」，点击后登记同类动作',async()=>{
  const before=await evaluate(`(()=>{const now=Date.now();
   const run={id:'qa_run_allow',conversationId:'qa_r2',status:'awaiting-approval',startedAt:now,goal:'创建任务',steps:[],pendingActions:[{type:'create_task',title:'验收任务',workspace:'日常'}]};
   state.agentRuns=[run];
   currentConversation().messages.push({id:'qa_pending_msg',role:'agent',at:now,text:'准备执行以下动作，请确认：',pendingRunId:run.id,runStatus:'awaiting-approval'});
   save();renderConversation();return true;})()`);
  await wait(300);
  // 待审批运行由计划审阅卡片承载（plan-review-surfaces.jsx）：「批准 N 步」与「本会话允许同类动作」都在卡片上；旧的 [data-approve-run]/[data-session-allow] 只在 PlanReview 不可用时出现（app.js renderMessage）。
  const planButton=prefix=>`[...document.querySelectorAll('[data-message-id="qa_pending_msg"] .plan-review button')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(prefix)}))`;
  const card=await evaluate(`(()=>{const approve=${planButton('批准')},allow=${planButton('本会话允许')};return {hasApprove:!!approve&&!approve.disabled,hasButton:!!allow&&!allow.disabled,label:allow?.textContent||''};})()`);
  assert.equal(card.hasApprove,true,'审批卡仍保留「批准并执行」');
  assert.equal(card.hasButton,true,'应提供「本会话允许同类动作」');
  assert.match(card.label,/本会话允许/);
  await evaluate(`${planButton('本会话允许')}.click()`);
  await until(()=>evaluate(`!!state.conversations.find(c=>c.id==='qa_r2')?.sessionAllows`),'session allow saved');
  const after=await evaluate(`(()=>{const conversation=state.conversations.find(c=>c.id==='qa_r2');return {allows:conversation.sessionAllows||null};})()`);
  assert.equal(!!after.allows?.create_task,true,'点击后应登记该动作类型');
 });

 await step('三级审批的边界：同类不再询问，但破坏性/归属确认/未登记类型仍逐次确认',async()=>{
  await wait(600);
  const probe=await evaluate(`(()=>{ try {
   // 只做纯判定调用，不依赖上一步异步执行留下的状态。
   state.agentRuns=[];
   const conversation=state.conversations.find(c=>c.id==='qa_r2');
   delete conversation.sessionAllows; save();
   const make=(type,extra)=>({id:'probe_'+type,conversationId:'qa_r2',status:'awaiting-approval',startedAt:1,pendingActions:[{type,title:'t',workspace:'日常',...(extra||{})}],steps:[]});
   const out={};
   // 直接验证会话授权判定层（不经过 dry-run：这里测的是"谁能自动通过"，不是动作本身能否执行）。
   out.same=sessionAllowsRun(make('create_task'));
   out.destructive=sessionAllowsRun(make('delete_task'));
   const routing=make('create_task');routing.routingReview={required:true};out.routing=sessionAllowsRun(routing);
   out.other=sessionAllowsRun(make('create_note'));
   conversation.sessionAllows={create_task:Date.now()};
   out.sameAfter=sessionAllowsRun(make('create_task'));
   out.otherAfter=sessionAllowsRun(make('create_note'));
   // 即便破坏性类型被手工写进 allows，也绝不自动通过（防历史数据或误写绕过）。
   conversation.sessionAllows={delete_task:Date.now(),run_command:Date.now()};
   out.destructiveForced=sessionAllowsRun(make('delete_task'));
   out.unknownForced=sessionAllowsRun(make('run_command'));
   // 会话级授权不得覆盖归属确认。
   conversation.sessionAllows={create_task:Date.now()};
   const routingGranted=make('create_task');routingGranted.routingReview={required:true};out.routingForced=sessionAllowsRun(routingGranted);
   delete conversation.sessionAllows; save();
   return JSON.stringify(out);
   } catch(error) { return 'ERR:'+String(error&&error.stack||error); } })()`);
  assert.ok(!String(probe).startsWith('ERR:'), '边界判定不应抛错：'+String(probe).slice(0,400));
  const result=JSON.parse(probe);
  assert.equal(result.same,false,'未登记时不得自动通过');
  assert.equal(result.sameAfter,true,'登记后同类非破坏性动作自动通过');
  assert.equal(result.destructive,false,'不可逆动作不自动通过');
  assert.equal(result.routing,false,'归属确认不自动通过');
  assert.equal(result.other,false,'只放行登记过的类型（create_note 未登记）');
  assert.equal(result.otherAfter,false,'登记 create_task 不会连带放行 create_note');
  assert.equal(result.destructiveForced,false,'破坏性类型即使被写进登记表也不自动通过');
  assert.equal(result.unknownForced,false,'白名单外动作即使被写进登记表也不自动通过');
  assert.equal(result.routingForced,false,'会话级授权不得覆盖归属确认');
 });

 console.log(JSON.stringify({passed:passed.length,failures,qaStore:TEMP,modelCalls:0},null,2));
 assert.deepEqual(failures,[]);
}
function finish(code){clearTimeout(watchdog);win?.destroy();server?.kill('SIGTERM');code?app.exit(code):app.quit();}
run().then(()=>finish(0)).catch(error=>{console.error(error);console.error('QA store retained:',TEMP);finish(1);});
