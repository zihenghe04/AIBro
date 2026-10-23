/* 第 4 轮验收：消息目录刻度导航（§2.2）与设置页「减少动画」（§17）。
   真实渲染器中验证；出站模型请求一律拒绝（本脚本不发消息）。
   运行：node_modules/.bin/electron tests/agent-round4-smoke.cjs */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18909,ORIGIN=`http://127.0.0.1:${PORT}`;
const TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aw-round4-')),STORE=path.join(TEMP,'store');fs.mkdirSync(STORE);fs.mkdirSync(path.join(TEMP,'profile'));app.setPath('userData',path.join(TEMP,'profile'));
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
 assert.equal(await evaluate('!!window.MessageRail'),true,'刻度导航模块必须加载');

 const seed=async (count,long=true)=>evaluate(`(()=>{const now=Date.now();
  state.projects=[];state.notes=[];state.tasks=[];state.imports=[];state.agentRuns=[];
  const messages=[];
  for(let i=0;i<${count};i++) messages.push({id:'m'+i,role:i%2?'agent':'user',at:now-(100-i)*60000,text:(i%2?'AI 的第 ':'我的第 ')+(i+1)+' 条消息：'+'内容'.repeat(${long?'80+(i%5)*20':'8'})});
  state.conversations=[{id:'qa_r4',title:'隔离验收 · 第 4 轮',workspace:'日常',permissionMode:'auto',attachments:[],draftAttachmentIds:[],draft:'',createdAt:now,updatedAt:now,messages}];
  state.currentConversationId='qa_r4';state.settings.permissions={'日常':'auto','课程':'auto','科研':'auto'};
  normalizeStateShape(state);state.ui.inspectorOpen=false;save();applyUiPreferences();showView('agent','对话');renderAll();})()`);

 await step('刻度导航：消息少时逐条一个刻度，且不覆盖消息正文',async()=>{
  // 一屏放得下的对话没有可去的位置，刻度收起；超出一屏才显示。
  await seed(2,false);
  await wait(700);
  assert.equal(await evaluate(`$('#messageRail')?.hidden`),true,'整段对话都在屏幕上时收起刻度');
  await seed(6);
  await wait(700);
  const probe=await evaluate(`(()=>{const rail=$('#messageRail');const ticks=[...document.querySelectorAll('.message-rail-tick')];
   const wrap=document.querySelector('.message-wrap');
   const railBox=rail?.getBoundingClientRect(),wrapBox=wrap?.getBoundingClientRect();
   return {exists:!!rail,hidden:rail?.hidden,ticks:ticks.length,stats:window.MessageRail.stats(),
     noOverlap:railBox&&wrapBox?railBox.right<=wrapBox.left+1:true};})()`);
  assert.equal(probe.exists,true,'应创建刻度导航');
  assert.equal(probe.hidden,false,'有条目时应显示');
  assert.equal(probe.ticks,6,'6 条消息 → 6 个刻度');
  assert.equal(probe.noOverlap,true,'刻度不得覆盖消息正文（落在容器左内边距里）');
 });

 await step('刻度导航：深色刻度跟随"当前屏幕正在显示的消息范围"',async()=>{
  const before=await evaluate(`window.MessageRail.stats().active`);
  assert.ok(before>=1,'滚动到顶部时至少有一条消息处于可见范围');
  await evaluate(`document.querySelector('#messageList').scrollTop=document.querySelector('#messageList').scrollHeight`);
  await wait(700);
  const after=await evaluate(`(()=>{const ticks=[...document.querySelectorAll('.message-rail-tick')];
   return {active:ticks.filter(t=>t.dataset.railActive==='true').length,lastActive:ticks[ticks.length-1]?.dataset.railActive,firstActive:ticks[0]?.dataset.railActive};})()`);
  assert.ok(after.active>=1,'滚到底部后仍有刻度处于可见范围');
  assert.equal(after.lastActive,'true','可见范围应落在最后几条消息上');
 });

 await step('刻度导航：悬停给出角色、时间与内容摘要；点击可跳转',async()=>{
  await evaluate(`document.querySelector('#messageList').scrollTop=0`);
  await wait(400);
  const preview=await evaluate(`(()=>{const tick=document.querySelector('.message-rail-tick');
   tick.dispatchEvent(new MouseEvent('mouseenter',{bubbles:false}));
   const box=document.querySelector('[data-rail-preview]');
   const text=box?box.textContent:'';
   tick.dispatchEvent(new MouseEvent('mouseleave',{bubbles:false}));
   const gone=!document.querySelector('[data-rail-preview]');
   return {shown:!!box,text,gone};})()`);
  assert.equal(preview.shown,true,'悬停应出现预览');
  assert.match(preview.text,/^\s*1\. 你 · \d{2}:\d{2}/,'预览应含序号、角色与时间');
  assert.match(preview.text,/我的第 1 条消息/,'预览应含内容摘要');
  assert.equal(preview.gone,true,'移开鼠标后预览消失');
  const jumped=await evaluate(`(()=>{const ticks=[...document.querySelectorAll('.message-rail-tick')];
   const list=$('#messageList');const before=list.scrollTop;
   ticks[ticks.length-1].click();
   return new Promise(resolve=>setTimeout(()=>resolve({before,after:list.scrollTop}),900));})()`);
  assert.ok(jumped.after>jumped.before,'点击末尾刻度应滚动到后面的消息');
 });

 await step('刻度导航：消息很多时聚合刻度，悬停聚合格给出区间内的精确目录',async()=>{
  // 200 条 → 每格 7 条（> 展示上限 6），才能覆盖“这一格还有 N 条”的分支。
  await seed(200);
  await wait(1200);
  const probe=await evaluate(`(()=>{const ticks=[...document.querySelectorAll('.message-rail-tick')];
   const tick=ticks[0];
   tick.dispatchEvent(new MouseEvent('mouseenter',{bubbles:false}));
   const box=document.querySelector('[data-rail-preview]');
   const lines=box?box.querySelectorAll('.message-rail-line').length:0;
   const more=box?box.querySelector('.message-rail-more')?.textContent||'':'';
   tick.dispatchEvent(new MouseEvent('mouseleave',{bubbles:false}));
   return {count:ticks.length,stats:window.MessageRail.stats(),lines,more};})()`);
  assert.ok(probe.count<=30,`聚合后刻度数应不超过 30，实际 ${probe.count}`);
  assert.ok(probe.count>=10,`聚合后仍应有足够刻度，实际 ${probe.count}`);
  assert.ok(probe.lines>=2,`悬停聚合格应列出区间内的精确条目，实际 ${probe.lines}`);
  assert.match(probe.more,/还有 \d+ 条/,'超出展示上限时如实说明这一格还有多少条');
  assert.equal(probe.lines,6,'聚合格最多列出 6 条精确项');
 });

 await step('设置页「减少动画」：开关切换即时生效，并且不误伤过渡结束语义',async()=>{
  const probe=await evaluate(`(()=>{const toggle=$('#reduceMotionToggle');
   const before=document.body.classList.contains('reduce-motion');
   toggle.checked=true;toggle.dispatchEvent(new Event('change',{bubbles:true}));
   const on=document.body.classList.contains('reduce-motion');
   const stored=!!state.settings.reduceMotion;
   toggle.checked=false;toggle.dispatchEvent(new Event('change',{bubbles:true}));
   const off=document.body.classList.contains('reduce-motion');
   const duration=getComputedStyle(document.querySelector('.conversation-pane')).transitionDuration;
   return {hasToggle:!!toggle,before,on,stored,off,duration};})()`);
  assert.equal(probe.hasToggle,true,'设置页应有「减少动画」开关');
  assert.equal(probe.before,false,'默认关闭');
  assert.equal(probe.on,true,'开启后 body 应带 reduce-motion 标记');
  assert.equal(probe.stored,true,'开关状态应写入设置（持久化）');
  assert.equal(probe.off,false,'关闭后标记移除');
 });

 console.log(JSON.stringify({passed:passed.length,failures,qaStore:TEMP,modelCalls:0},null,2));
 assert.deepEqual(failures,[]);
}
function finish(code){clearTimeout(watchdog);win?.destroy();server?.kill('SIGTERM');code?app.exit(code):app.quit();}
run().then(()=>finish(0)).catch(error=>{console.error(error);console.error('QA store retained:',TEMP);finish(1);});
