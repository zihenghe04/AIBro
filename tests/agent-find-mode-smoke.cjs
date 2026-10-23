/* 页内查找 / 收藏置顶 / 模式关键词提示 验收：真实渲染器中验证。
   · 页内查找：⌘F 打开、计数如实、上下跳转、命中在收起的折叠块里时自动展开、Esc 关闭；
   · 收藏置顶：收藏的对话排到列表最前并显示星标；
   · 模式提示：输入命中关键词时给出提示，Shift+Tab 转换，已有前缀不再打扰。
   出站模型请求一律拒绝（本脚本不发消息）。
   运行：node_modules/.bin/electron tests/agent-find-mode-smoke.cjs */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18901,ORIGIN=`http://127.0.0.1:${PORT}`;
const TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aw-find-mode-')),STORE=path.join(TEMP,'store');fs.mkdirSync(STORE);fs.mkdirSync(path.join(TEMP,'profile'));app.setPath('userData',path.join(TEMP,'profile'));
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
 assert.equal(await evaluate('!!window.FindInConversation'),true,'查找模块必须在应用初始化前加载');
 assert.equal(await evaluate('!!window.ModeHint'),true,'模式提示模块必须在应用初始化前加载');

 // 合成一条隔离对话：正文不含关键词，关键词只出现在一个收起的折叠块里。
 await evaluate(`(()=>{const now=Date.now();
  state.projects=[];state.notes=[];state.tasks=[];state.imports=[];state.agentRuns=[];
  state.conversations=[
   {id:'qa_find_a',title:'隔离验收 · 查找与收藏',workspace:'日常',permissionMode:'auto',attachments:[],draftAttachmentIds:[],draft:'',createdAt:now-9000,updatedAt:now-9000,messages:[{id:'qa_msg_1',role:'agent',text:'正文与关键词无关，这里是用于核对的普通段落。',createdAt:now-8000}]},
   {id:'qa_find_b',title:'第二条对话（更旧）',workspace:'日常',permissionMode:'auto',attachments:[],draftAttachmentIds:[],draft:'',createdAt:now-99000,updatedAt:now-99000,messages:[]}
  ];
  state.currentConversationId='qa_find_a';state.settings.permissions={'日常':'auto','课程':'auto','科研':'auto'};
  normalizeStateShape(state);state.ui.inspectorOpen=false;save();applyUiPreferences();showView('agent','对话');renderAll();
  // 在真实消息列表里补一个收起的折叠块——模拟深度思考/工具记录展开前的状态。
  const fold=document.createElement('div');fold.className='message-wrap agent-message';
  fold.innerHTML='<div class="message-body"><details class="qa-fold"><summary>展开看看</summary><div>量子纠缠观测记录</div></details></div>';
  document.querySelector('#messageList').appendChild(fold);
 })()`);

 await step('页内查找：⌘F 打开查找栏，输入后计数如实、可上下跳转',async()=>{
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'f',metaKey:true,bubbles:true,cancelable:true}))`);
  await wait(120);
  const opened=await evaluate(`(()=>{const bar=$('#findBar');return{hidden:bar.hidden,focused:document.activeElement&&document.activeElement.id};})()`);
  assert.equal(opened.hidden,false,'⌘F 应打开查找栏');
  assert.equal(opened.focused,'findInput','打开后焦点应在查找输入框');
  await evaluate(`(()=>{const field=$('#findInput');field.value='量子纠缠';field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await wait(160);
  const found=await evaluate(`(()=>{const stats=window.FindInConversation.stats();return{hits:stats.hits,label:$('#findCount').textContent,empty:$('#findBar').dataset.empty};})()`);
  assert.equal(found.hits,1,'应命中一处（只在折叠块里）');
  assert.match(found.label,/第 1 \/ 共 1 个匹配/,'计数应如实显示');
  assert.equal(found.empty,'false');
  await evaluate(`(()=>{const field=$('#findInput');field.value='不存在的词组';field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await wait(160);
  const none=await evaluate(`(()=>({label:$('#findCount').textContent,empty:$('#findBar').dataset.empty}))()`);
  assert.equal(none.empty,'true','无匹配时应标记为空态');
  assert.match(none.label,/无匹配/,'无匹配时如实说明，而不是显示 0/0');
  assert.doesNotMatch(none.label,/\d/,'空计数不得出现数字');
 });

 await step('页内查找：命中落在收起的折叠块里时自动展开——避免“搜到了但看不到”',async()=>{
  // 上一步输入关键词时已经自动展开过——先复位，再验证“命中在其内会展开”这条独立规则。
  await evaluate(`(()=>{const fold=document.querySelector('.qa-fold');fold.open=false;})()`);
  const before=await evaluate(`document.querySelector('.qa-fold').open`);
  assert.equal(before,false,'前提：折叠块已复位为收起');
  await evaluate(`(()=>{const field=$('#findInput');field.value='量子纠缠';field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await wait(200);
  const after=await evaluate(`(()=>{const fold=document.querySelector('.qa-fold');return{open:fold.open,text:fold.querySelector('div:last-child').textContent};})()`);
  assert.equal(after.open,true,'命中在其内时必须自动展开折叠块');
  assert.match(after.text,/量子纠缠/,'展开后能看到被命中的内容');
  const step2=await evaluate(`(()=>{window.FindInConversation.next();return window.FindInConversation.stats();})()`);
  assert.equal(step2.hits,1,'循环跳转仍停在唯一命中上');
 });

 await step('页内查找：Esc 关闭并清除状态',async()=>{
  await evaluate(`(()=>{const field=$('#findInput');field.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));})()`);
  await wait(120);
  const closed=await evaluate(`(()=>{const bar=$('#findBar');return{hidden:bar.hidden,stats:window.FindInConversation.stats(),highlights:!!(window.CSS&&CSS.highlights&&CSS.highlights.size)};})()`);
  assert.equal(closed.hidden,true,'Esc 应关闭查找栏');
  assert.equal(closed.stats.hits,0,'关闭后应清空命中');
  assert.equal(closed.highlights,false,'关闭后不应残留高亮');
 });

 await step('收藏置顶：收藏后排序前置并显示星标，取消后恢复',async()=>{
  const toggle=async id=>{await evaluate(`(()=>{openManageDialog('conversation',${JSON.stringify(id)});document.querySelector('#manageFavorite').click();})()`);await wait(200);};
  await toggle('qa_find_b');
  const starred=await evaluate(`(()=>{const item=state.conversations.find(entry=>entry.id==='qa_find_b');const rows=[...document.querySelectorAll('.conversation-item')].map(node=>node.getAttribute('data-conversation-id'));return{favorite:!!item.favorite,order:rows,mark:document.querySelector('.favorite-mark')?.textContent||''};})()`);
  assert.equal(starred.favorite,true,'应写入收藏标记');
  assert.equal(starred.order[0],'qa_find_b','收藏的对话应排到最前（置顶）');
  assert.match(starred.mark,/★/,'列表里应显示星标');
  const visible=await evaluate(`(()=>(openManageDialog('conversation','qa_find_b'),$('#manageFavorite').textContent))()`);
  // 收藏已并入“置顶”（app.js openManageDialog；docs/FIVE_FEATURES_DELIVERY_20260924.md），按钮文案随之改为置顶/取消置顶。
  assert.match(visible,/取消置顶/,'再打开对话框时按钮应显示当前状态');
  await toggle('qa_find_b');
  const restored=await evaluate(`(()=>{const item=state.conversations.find(entry=>entry.id==='qa_find_b');const rows=[...document.querySelectorAll('.conversation-item')].map(node=>node.getAttribute('data-conversation-id'));return{favorite:!!item.favorite,order:rows};})()`);
  assert.equal(restored.favorite,false,'取消收藏后应清除标记');
  assert.equal(restored.order[0],'qa_find_a','取消后恢复按时间排序');
 });

 await step('模式提示：命中关键词时提示、Shift+Tab 转换、已有前缀不再打扰',async()=>{
  const type=async text=>{await evaluate(`(()=>{const input=$('#agentInput');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(120);};
  const stripState=()=>evaluate(`(()=>{const strip=$('#modeHintStrip');return{hidden:strip.hidden,text:strip.textContent,mode:strip.dataset.mode,input:$('#agentInput').value};})()`);
  await type('帮我做个计划');
  const hinted=await stripState();
  assert.equal(hinted.hidden,false,'命中“计划”时应给出提示');
  assert.match(hinted.text,/创建规划/,'提示应指向规划模式');
  assert.match(hinted.text,/Shift\+Tab/,'提示应写明触发方式');
  assert.equal(hinted.mode,'plan');
  await evaluate(`(()=>{const input=$('#agentInput');input.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));})()`);
  await wait(160);
  const converted=await stripState();
  assert.equal(converted.input,'/plan 帮我做个计划','Shift+Tab 应把输入转成规划模式且不改写内容');
  assert.equal(converted.hidden,true,'已有前缀后不再提示');
  await type('帮我达成这个目标');
  const goalHint=await stripState();
  assert.equal(goalHint.hidden,false);
  assert.equal(goalHint.mode,'goal','目标类表述应切到目标模式');
  await evaluate(`(()=>{const strip=$('#modeHintStrip');strip.click();})()`);
  await wait(140);
  const goalApplied=await stripState();
  assert.match(goalApplied.input,/^\/goal /,'点提示同样完成转换');
  await type('今天整理一下资料');
  assert.equal((await stripState()).hidden,true,'无关表述不应提示');
  await evaluate(`(()=>{const input=$('#agentInput');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 });

 await step('/plan 前缀解析：进入规划语义且前缀不留在对话内容里',async()=>{
  const parsed=await evaluate(`(()=>{const intent=window.ModeHint.parsePlan('/plan 重构检索层');const empty=window.ModeHint.parsePlan('/plan');return{intent,empty};})()`);
  assert.deepEqual(parsed.intent,{plan:'重构检索层',explicit:true});
  assert.equal(parsed.empty,null,'空规划不开启');
 });

 console.log(JSON.stringify({passed:passed.length,failures,qaStore:TEMP,modelCalls:0},null,2));
 assert.deepEqual(failures,[]);
}
function finish(code){clearTimeout(watchdog);win?.destroy();server?.kill('SIGTERM');code?app.exit(code):app.quit();}
run().then(()=>finish(0)).catch(error=>{console.error(error);console.error('QA store retained:',TEMP);finish(1);});
