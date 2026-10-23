/* 第 3 轮验收：快捷键说明面板（⌘/）与 Tab 一键两义。
   真实渲染器中验证；出站模型请求一律拒绝（本脚本不发消息）。
   运行：node_modules/.bin/electron tests/agent-round3-smoke.cjs */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18907,ORIGIN=`http://127.0.0.1:${PORT}`;
const TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aw-round3-')),STORE=path.join(TEMP,'store');fs.mkdirSync(STORE);fs.mkdirSync(path.join(TEMP,'profile'));app.setPath('userData',path.join(TEMP,'profile'));
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
 assert.equal(await evaluate('!!window.Shortcuts'),true,'快捷键面板模块必须加载');
 assert.equal(await evaluate('!!window.ComposerTips'),true,'Tab 提示模块必须加载');

 await evaluate(`(()=>{const now=Date.now();
  state.projects=[];state.notes=[];state.tasks=[];state.imports=[];state.agentRuns=[];
  state.conversations=[{id:'qa_r3',title:'隔离验收 · 第 3 轮',workspace:'日常',permissionMode:'auto',attachments:[],draftAttachmentIds:[],draft:'',createdAt:now,updatedAt:now,messages:[]}];
  state.currentConversationId='qa_r3';state.settings.permissions={'日常':'auto','课程':'auto','科研':'auto'};
  normalizeStateShape(state);state.ui.inspectorOpen=false;save();applyUiPreferences();showView('agent','对话');renderAll();})()`);
 await wait(500);

 await step('快捷键面板：⌘/ 打开，分组与条目按清单渲染，再按一次关闭',async()=>{
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'/',metaKey:true,bubbles:true,cancelable:true}))`);
  await wait(300);
  const opened=await evaluate(`(()=>{const dialog=document.querySelector('#shortcutsDialog');
   return {exists:!!dialog,open:!!dialog?.open,groups:dialog?dialog.querySelectorAll('.shortcuts-group').length:0,
     rows:dialog?dialog.querySelectorAll('.shortcut-row').length:0,
     kbd:dialog?dialog.querySelectorAll('.shortcut-keys kbd').length:0,
     firstKey:dialog?.querySelector('.shortcut-keys kbd')?.textContent||''};})()`);
  assert.equal(opened.exists,true,'应创建快捷键面板');
  assert.equal(opened.open,true,'⌘/ 应打开面板');
  assert.ok(opened.groups>=3,`分组过少：${opened.groups}`);
  assert.ok(opened.rows>=8,`条目过少：${opened.rows}`);
  assert.ok(opened.kbd>=opened.rows,'每个条目至少一个按键片段');
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'/',metaKey:true,bubbles:true,cancelable:true}))`);
  await wait(200);
  const closed=await evaluate(`!document.querySelector('#shortcutsDialog')?.open`);
  assert.equal(closed,true,'再按 ⌘/ 应关闭面板');
 });

 await step('快捷键面板不编造：面板条目与可核验清单一致',async()=>{
  const probe=await evaluate(`(()=>{window.Shortcuts.open();
   const dialog=document.querySelector('#shortcutsDialog');
   const rows=[...dialog.querySelectorAll('.shortcut-row')].map(row=>({
     keys:[...row.querySelectorAll('kbd')].map(k=>k.textContent),
     label:row.querySelector('.shortcut-label')?.textContent||''}));
   const expected=window.Shortcuts.entries();
   const missing=expected.filter(item=>!rows.some(row=>row.label===item.zh||row.label===item.en));
   const text=window.Shortcuts.asText();
   const verifiable=window.Shortcuts.verifiable();
   window.Shortcuts.close();
   return {rowCount:rows.length,expected:expected.length,missingLabels:missing.map(m=>m.zh),textCovers:text.includes('⌘ + K')&&text.includes('Enter'),verifiableCount:verifiable.length};})()`);
  assert.equal(probe.missingLabels.length,0,`面板缺少清单条目：${probe.missingLabels.join('、')}`);
  assert.equal(probe.rowCount,probe.expected,'面板条目数应与清单一致');
  assert.equal(probe.textCovers,true,'文本导出应覆盖真实按键');
  assert.ok(probe.verifiableCount>=6,'可核验条目应足够多（这是"不编造"的保障）');
 });

 await step('Tab 一键两义：空输入填提示、连按轮换、有内容不覆盖',async()=>{
  const press=async()=>{await evaluate(`(()=>{const input=$('#agentInput');input.focus();input.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));})()`);await wait(150);};
  const value=()=>evaluate(`$('#agentInput').value`);
  await evaluate(`$('#agentInput').value=''`);
  await press();
  const first=await value();
  assert.equal(first,'整理附件并提取待办','空输入时按 Tab 应填入第一条提示');
  await press();
  const second=await value();
  assert.equal(second,'分析资料并归入合适的项目','再按 Tab 换下一条');
  await evaluate(`(()=>{const input=$('#agentInput');input.value='我自己写的需求';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await press();
  const kept=await value();
  assert.equal(kept,'我自己写的需求','用户自己写的内容绝不被覆盖');
  await evaluate(`(()=>{const input=$('#agentInput');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 });

 console.log(JSON.stringify({passed:passed.length,failures,qaStore:TEMP,modelCalls:0},null,2));
 assert.deepEqual(failures,[]);
}
function finish(code){clearTimeout(watchdog);win?.destroy();server?.kill('SIGTERM');code?app.exit(code):app.quit();}
run().then(()=>finish(0)).catch(error=>{console.error(error);console.error('QA store retained:',TEMP);finish(1);});
