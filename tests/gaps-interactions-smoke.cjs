/* 第四阶段补缺验收：代码块复制、移入回收站后撤销、生成中 Esc 停止。
   真实渲染器中验证；不发出模型请求（Esc 停止用的是本地模拟的执行状态）。
   运行：node_modules/.bin/electron tests/gaps-interactions-smoke.cjs */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18991,ORIGIN=`http://127.0.0.1:${PORT}`;
const TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aw-gaps-')),STORE=path.join(TEMP,'store');fs.mkdirSync(STORE);fs.mkdirSync(path.join(TEMP,'profile'));app.setPath('userData',path.join(TEMP,'profile'));
let server,win;const passed=[],failures=[];const wait=ms=>new Promise(r=>setTimeout(r,ms));
const request=route=>new Promise((resolve,reject)=>http.get(ORIGIN+route,r=>{r.resume();r.on('end',()=>resolve({status:r.statusCode}));}).on('error',reject));
async function until(fn,label,timeout=15000){const start=Date.now();while(Date.now()-start<timeout){if(await fn())return;await wait(60);}throw Error(`Timed out: ${label}`);}
const watchdog=setTimeout(()=>{console.error('QA timeout',TEMP);win?.destroy();server?.kill('SIGTERM');app.exit(1);},180000);
async function run(){
 await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',()=>reject(Error(`${PORT} occupied`)));probe.listen(PORT,'127.0.0.1',()=>probe.close(resolve));});
 const log=fs.openSync(path.join(TEMP,'server.log'),'a');server=spawn(process.env.PYTHON||'python3',[path.join(ROOT,'app','server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(PORT),AI_WORKSTATION_DATA_DIR:STORE,AI_WORKSTATION_ASSET_DIR:path.join(ROOT,'app')},stdio:['ignore',log,log]});
 await until(async()=>{if(server.exitCode!==null)throw Error('QA service exited');try{return(await request('/__health')).status===200;}catch{return false;}},'QA service');
 await app.whenReady();win=new BrowserWindow({show:true,width:1280,height:900,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const errors=[];win.webContents.on('console-message',(_event,level,message)=>{if(level>=3){errors.push(message);}});
 const evaluate=async code=>{try{return await win.webContents.executeJavaScript(code,true);}catch(error){console.error('Renderer errors:',JSON.stringify(errors));throw error;}};
 async function step(label,fn){try{await fn();passed.push(label);console.log('PASS',label);}catch(error){failures.push({label,error:error.stack});console.error('FAIL',label,error.message);}}
 await win.loadURL(ORIGIN);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydration');
 await wait(600);
 await wait(600);
 assert.equal(await evaluate('!!window.CodeCopy'),true,'code-copy.js 必须加载');
 await evaluate(`(()=>{const now=Date.now(),fence=String.fromCharCode(96).repeat(3);
  state.projects=[];state.notes=[];state.tasks=[];state.imports=[];state.agentRuns=[];
  const text=['示例：','',fence+'js','const total = 1 + 2;',fence].join('\\n');
  state.conversations=[{id:'qa_keep',title:'保留的对话',workspace:'日常',attachments:[],draftAttachmentIds:[],draft:'',createdAt:now,updatedAt:now,messages:[{id:'u0',role:'user',at:now,text:'写段代码'},{id:'m1',role:'assistant',at:now,text}]},
   {id:'qa_drop',title:'要删除的对话',workspace:'日常',attachments:[],draftAttachmentIds:[],draft:'',createdAt:now-5,updatedAt:now-5,messages:[{id:'u1',role:'user',at:now,text:'临时'}]}];
  state.currentConversationId='qa_keep';normalizeStateShape(state);state.ui.workspaceTour={status:'skipped',at:now};state.ui.inspectorOpen=false;save();showView('agent','持续对话');renderAll();
  document.querySelector('#onboardingLayer')?.remove();})()`);
 await evaluate(`(()=>{if(window.WorkspaceTour?.isOpen?.())window.WorkspaceTour.close('skipped');return !window.WorkspaceTour?.isOpen?.();})()`);
 await wait(800);

 await step('代码块：悬停出现复制按钮，复制的是代码原文，按钮不在消息里',async()=>{
  const probe=await evaluate(`(async()=>{const pre=document.querySelector('#messageList pre.message-code');
   pre.dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));const button=document.querySelector('.code-copy-float');
   let copied=null;const original=navigator.clipboard.writeText.bind(navigator.clipboard);navigator.clipboard.writeText=async t=>{copied=t;};
   const r=button.getBoundingClientRect(),p=pre.getBoundingClientRect();button.click();await new Promise(r=>setTimeout(r,50));navigator.clipboard.writeText=original;
   return {visible:!button.hidden,inside:r.left>=p.left-1&&r.right<=p.right+1&&r.top>=p.top-1&&r.bottom<=p.bottom+1,copied,label:button.textContent,
    inList:document.querySelector('#messageList').contains(button)};})()`);
  assert.equal(probe.visible,true);assert.equal(probe.inside,true,'按钮落在代码块内');assert.equal(probe.copied,'const total = 1 + 2;');
  assert.equal(probe.label,'已复制');assert.equal(probe.inList,false);
 });

 await step('删除对话后 toast 提供撤销，撤销恢复同一条对话且回收站清空',async()=>{
  const before=await evaluate(`(()=>{const original=window.confirm;window.confirm=()=>true;manageTarget={kind:'conversation',id:'qa_drop'};deleteManagedItem();window.confirm=original;
   const box=document.getElementById('toast');return {gone:!state.conversations.some(c=>c.id==='qa_drop'),trash:state.trash.length,text:box.textContent,action:box.querySelector('.toast-action')?.textContent,
    clickable:getComputedStyle(box).pointerEvents};})()`);
  assert.equal(before.gone,true);assert.equal(before.trash,1);assert.equal(before.action,'撤销');assert.equal(before.clickable,'auto');
  const after=await evaluate(`(()=>{document.querySelector('#toast .toast-action').click();return {back:state.conversations.some(c=>c.id==='qa_drop'),trash:state.trash.length,text:document.getElementById('toast').textContent};})()`);
  assert.equal(after.back,true);assert.equal(after.trash,0);assert.match(after.text,/已撤销/);
 });

 await step('生成中按 Esc 停止；查找栏打开时 Esc 只关查找栏',async()=>{
  await evaluate(`(()=>{window.__qaStops=0;window.__qaController=activeRunController;sendMessage.busy=true;
   activeRunController={abort(){window.__qaStops++;},signal:{aborted:false}};window.FindInConversation.open('total');})()`);
  await wait(200);
  await evaluate(`$('#findInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  await wait(120);
  const afterFind=await evaluate(`({stops:window.__qaStops,findHidden:$('#findBar').hidden})`);
  await evaluate(`(()=>{const input=$('#agentInput');input.focus();input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));})()`);
  const probe={afterFind,stops:await evaluate(`(()=>{const n=window.__qaStops;sendMessage.busy=false;activeRunController=window.__qaController;return n;})()`)};
  assert.deepEqual(probe.afterFind,{stops:0,findHidden:true});assert.equal(probe.stops,1);
 });

 console.log(JSON.stringify({passed:passed.length,failures,qaStore:TEMP,modelCalls:0},null,2));
 assert.deepEqual(failures,[]);
}
function finish(code){clearTimeout(watchdog);win?.destroy();server?.kill('SIGTERM');code?app.exit(code):app.quit();}
run().then(()=>finish(0)).catch(error=>{console.error(error);console.error('QA store retained:',TEMP);finish(1);});
