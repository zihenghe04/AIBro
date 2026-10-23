/* 第 5 轮验收：无痕模式（§1.10）——列表与搜索的可见性、退出即真删除、重启清理。
   真实渲染器中验证；出站模型请求一律拒绝（本脚本不发消息）。
   运行：node_modules/.bin/electron tests/agent-round5-smoke.cjs */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18911,ORIGIN=`http://127.0.0.1:${PORT}`;
const TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aw-round5-')),STORE=path.join(TEMP,'store');fs.mkdirSync(STORE);fs.mkdirSync(path.join(TEMP,'profile'));app.setPath('userData',path.join(TEMP,'profile'));
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
 assert.equal(await evaluate('!!window.PrivateMode'),true,'无痕模式模块必须加载');

 await evaluate(`(()=>{const now=Date.now();
  state.projects=[];state.notes=[];state.tasks=[];state.imports=[];state.agentRuns=[];
  state.conversations=[{id:'qa_normal',title:'普通对话 · 隔离验收',workspace:'日常',permissionMode:'auto',attachments:[],draftAttachmentIds:[],draft:'',createdAt:now,updatedAt:now,messages:[{id:'n1',role:'user',at:now,text:'这条属于普通对话。'}]}];
  state.currentConversationId='qa_normal';state.settings.permissions={'日常':'auto','课程':'auto','科研':'auto'};
  // 设置页开关的勾选状态由模块同步。
  normalizeStateShape(state);state.ui.inspectorOpen=false;save();applyUiPreferences();showView('agent','对话');renderAll();})()`);
 await wait(500);

 await step('开启无痕模式：状态条出现并明确告知"永久删除、不可恢复"',async()=>{
  const probe=await evaluate(`(()=>{const toggle=$('#privateModeToggle');toggle.checked=true;toggle.dispatchEvent(new Event('change',{bubbles:true}));
   const strip=$('#privateModeStrip');
   return {on:window.PrivateMode.isOn(),stripHidden:strip.hidden,text:strip.textContent,toggleChecked:toggle.checked};})()`);
  assert.equal(probe.on,true,'应进入无痕模式');
  assert.equal(probe.stripHidden,false,'状态条应出现');
  assert.match(probe.text,/永久删除/, '必须明确告知删除语义');
  assert.match(probe.text,/不可恢复/);
  assert.equal(probe.toggleChecked,true,'设置页开关应与状态一致');
 });

 await step('无痕对话不进普通列表：隐私模式下只显示本次会话的无痕对话',async()=>{
  const probe=await evaluate(`(()=>{newConversation('日常',null);
   const conversation=currentConversation();
   save();renderAll();
   const ids=[...document.querySelectorAll('.conversation-item')].map(node=>node.getAttribute('data-conversation-id'));
   return {ephemeral:!!conversation.ephemeral,ids,current:conversation.id};})()`);
  assert.equal(probe.ephemeral,true,'隐私模式下新建的对话应带无痕标记');
  assert.equal(probe.ids.includes('qa_normal'),false,'隐私模式下普通对话不出现在列表里');
  assert.equal(probe.ids.includes(probe.current),true,'当前这条无痕对话应可见（否则用户会凭空丢失）');
 });

 await step('无痕模式下「继续上次」不指向被隐藏的普通对话',async()=>{
  const probe=await evaluate(`(()=>{renderConversation();
   const resume=[...document.querySelectorAll('.chat-resume-item')].map(n=>n.getAttribute('data-open-conversation'));
   return {resume,normalHidden:!resume.includes('qa_normal')};})()`);
  assert.equal(probe.normalHidden,true,'“继续上次”不得指向一条在列表里看不到的普通对话');
 });

 await step('全文搜索绝对排除无痕对话',async()=>{
  const probe=await evaluate(`(()=>{const conversation=state.conversations.find(item=>item.ephemeral);
   conversation.messages.push({id:'p1',role:'user',at:Date.now(),text:'无痕专属关键词 zebra'});
   save();
   const rows=searchEntities('zebra');
   const normalRows=searchEntities('这条属于普通对话');
   return {privateHits:rows.filter(row=>row.type==='conversation').length,normalHits:normalRows.filter(row=>row.type==='conversation').length};})()`);
  assert.equal(probe.privateHits,0,'无痕对话的内容不得被搜索到');
  assert.equal(probe.normalHits,1,'普通对话照常可搜');
 });

 await step('退出无痕模式：无痕对话与执行记录被真删除，普通对话恢复',async()=>{
  const probe=await evaluate(`(()=>{const conversation=state.conversations.find(item=>item.ephemeral);
   state.agentRuns.push({id:'qa_run_priv',conversationId:conversation.id,status:'completed',startedAt:Date.now(),steps:[],pendingActions:[]});
   save();
   const toggle=$('#privateModeToggle');toggle.checked=false;toggle.dispatchEvent(new Event('change',{bubbles:true}));
   const ids=[...document.querySelectorAll('.conversation-item')].map(node=>node.getAttribute('data-conversation-id'));
   return {on:window.PrivateMode.isOn(),
     stillInState:state.conversations.some(item=>item.ephemeral),
     runLeft:state.agentRuns.some(run=>run.id==='qa_run_priv'),
     stripHidden:$('#privateModeStrip').hidden,
     ids};})()`);
  assert.equal(probe.on,false,'应退出无痕模式');
  assert.equal(probe.stillInState,false,'无痕对话必须被真删除（不是打标记）');
  assert.equal(probe.runLeft,false,'它的执行记录也要一起删除');
  assert.equal(probe.stripHidden,true,'状态条应消失');
  assert.equal(probe.ids.includes('qa_normal'),true,'退出后普通对话恢复显示');
 });

 await step('重启清理：启动时按约定删除上次遗留的无痕对话',async()=>{
  const probe=await evaluate(`(()=>{const now=Date.now();
   state.conversations.push({id:'qa_leftover',title:'上次会话遗留的无痕对话',workspace:'日常',ephemeral:true,attachments:[],draftAttachmentIds:[],draft:'',createdAt:now,updatedAt:now,messages:[]});
   state.agentRuns.push({id:'qa_leftover_run',conversationId:'qa_leftover',status:'completed',startedAt:now,steps:[],pendingActions:[]});
   save();
   const before=state.conversations.length;
   const result=window.PrivateMode.init({getState:()=>state,save,renderAll,toast});
   return {before,after:state.conversations.length,purgedOnLoad:result.purgedOnLoad,
     leftoverGone:!state.conversations.some(item=>item.id==='qa_leftover'),
     runGone:!state.agentRuns.some(run=>run.id==='qa_leftover_run')};})()`);
  assert.equal(probe.purgedOnLoad,1,'启动时应识别出 1 条遗留无痕对话');
  assert.equal(probe.leftoverGone,true,'遗留的无痕对话必须被删除');
  assert.equal(probe.runGone,true,'它的执行记录同样删除');
  assert.ok(probe.after<probe.before,'状态里的对话数应减少');
 });

 console.log(JSON.stringify({passed:passed.length,failures,qaStore:TEMP,modelCalls:0},null,2));
 assert.deepEqual(failures,[]);
}
function finish(code){clearTimeout(watchdog);win?.destroy();server?.kill('SIGTERM');code?app.exit(code):app.quit();}
run().then(()=>finish(0)).catch(error=>{console.error(error);console.error('QA store retained:',TEMP);finish(1);});
