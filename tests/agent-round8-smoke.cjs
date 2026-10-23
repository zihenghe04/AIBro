/* 第 8 轮验收：富文本扩展（§3）——代码块语法高亮、行内/块级数学公式。
   真实渲染器中验证；出站模型请求一律拒绝（本脚本不发消息）。
   运行：node_modules/.bin/electron tests/agent-round8-smoke.cjs */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18915,ORIGIN=`http://127.0.0.1:${PORT}`;
const TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aw-round8-')),STORE=path.join(TEMP,'store');fs.mkdirSync(STORE);fs.mkdirSync(path.join(TEMP,'profile'));app.setPath('userData',path.join(TEMP,'profile'));
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
 assert.equal(await evaluate('!!window.CodeHighlight && !!window.MathRender'),true,'两个模块必须加载');

 // 渲染一条含：js 代码块、未知语言代码块、行内公式、块级公式、价格写法 的回复
 await evaluate(`(()=>{const now=Date.now();
  const fence=String.fromCharCode(96).repeat(3);
  const body=[
   '示例代码：','',''+fence+'js','const total = 1+2; // 合计',''+fence,'',
   '未知语言：','',''+fence+'brainfuck','+++[->+<]',''+fence,'',
   '行内公式 $E = mc^2$ 与块级公式：','','$$\\\\frac{a}{b}$$','',
   '价格 $5 到 $10 不该被当成公式。','','**粗体** 照常工作。'
  ].join('\\n');
  state.projects=[];state.notes=[];state.tasks=[];state.imports=[];state.agentRuns=[];
  state.conversations=[{id:'qa_r8',title:'富文本验收',workspace:'日常',permissionMode:'auto',attachments:[],draftAttachmentIds:[],draft:'',createdAt:now,updatedAt:now,messages:[{id:'m8',role:'assistant',at:now,text:body}]}];
  state.currentConversationId='qa_r8';state.settings.permissions={'日常':'auto','课程':'auto','科研':'auto'};
  normalizeStateShape(state);state.ui.inspectorOpen=false;save();applyUiPreferences();showView('agent','对话');renderAll();
  const layer=document.querySelector('#onboardingLayer');if(layer)layer.remove();})()`);
 await wait(800);

 await step('代码块高亮：关键字/注释/数字被着色，且语言标签可见',async()=>{
  const probe=await evaluate(`(()=>{const pre=document.querySelector('#messageList .message-code');
   return {hasPre:!!pre,keyword:!!pre?.querySelector('.tok-keyword'),comment:!!pre?.querySelector('.tok-comment'),
     number:!!pre?.querySelector('.tok-number'),lang:pre?.querySelector('.message-code-lang')?.textContent||''};})()`);
  assert.equal(probe.hasPre,true,'代码块必须渲染');
  assert.equal(probe.keyword,true,'关键字应被着色');
  assert.equal(probe.comment,true,'注释应被着色');
  assert.equal(probe.number,true,'数字应被着色');
  assert.equal(probe.lang,'js','右上角应标注语言');
 });

 await step('高亮不改内容：代码文本与原件逐字一致（核心不变量）',async()=>{
  const probe=await evaluate(`(()=>{const pre=document.querySelector('#messageList .message-code');
   const code=pre.querySelector('code');
   return {text:code.textContent};})()`);
  assert.equal(probe.text,'const total = 1+2; // 合计','代码内容必须逐字守恒（只加标记）');
 });

 await step('未知语言不假高亮：回退为纯文本（无 token 标记）',async()=>{
  const probe=await evaluate(`(()=>{const pres=[...document.querySelectorAll('#messageList .message-code')];
   const plain=pres.find(pre=>!pre.querySelector('.tok-keyword')&&!pre.querySelector('.tok-string')&&!pre.querySelector('.tok-number'));
   return {exists:!!plain,text:plain?.querySelector('code')?.textContent||'',lang:plain?.querySelector('.message-code-lang')?.textContent||''};})()`);
  assert.equal(probe.text,'+++[->+<]','未知语言的内容应原样显示');
  assert.equal(probe.lang,'brainfuck','语言名仍如实标注');
 });

 await step('行内公式：$E = mc^2$ 渲染为上标形式，且保留原始写法便于核对',async()=>{
  const probe=await evaluate(`(()=>{const math=document.querySelector('#messageList .math-inline');
   return {exists:!!math,html:math?.innerHTML||'',label:math?.getAttribute('aria-label')||''};})()`);
  assert.equal(probe.exists,true,'行内公式必须渲染');
  assert.match(probe.label,/E = mc\^2/,'aria-label 应保留原始写法');
 });

 await step('块级公式：$$…$$ 渲染为居中块，分式有分子分母',async()=>{
  const probe=await evaluate(`(()=>{const block=document.querySelector('#messageList .math-block');
   return {exists:!!block,frac:!!block?.querySelector('.math-frac'),
     num:block?.querySelector('.math-num')?.textContent||'',den:block?.querySelector('.math-den')?.textContent||''};})()`);
  assert.equal(probe.exists,true,'块级公式必须渲染');
  assert.equal(probe.frac,true,'分式应渲染');
  assert.equal(probe.num,'a');
  assert.equal(probe.den,'b');
 });

 await step('不误伤：价格写法 $5 到 $10 保持纯文本',async()=>{
  const probe=await evaluate(`(()=>{const body=[...document.querySelectorAll('#messageList .message-body')].pop();
   return {text:body.textContent};})()`);
  assert.match(probe.text,/价格 \$5 到 \$10 不该被当成公式/,'价格写法不得被渲染成公式');
  const count=await evaluate(`document.querySelectorAll('#messageList .math-inline').length`);
  assert.equal(count,1,'只应有一个行内公式（E=mc^2），价格不算');
 });

 await step('既有渲染不回归：粗体与普通段落照常',async()=>{
  const probe=await evaluate(`(()=>{const body=[...document.querySelectorAll('#messageList .message-body')].pop();
   return {bold:!!body.querySelector('strong'),paragraphs:body.querySelectorAll('p').length};})()`);
  assert.equal(probe.bold,true,'粗体照常渲染');
  assert.ok(probe.paragraphs>2,'段落照常渲染');
 });

 await step('安全：消息里的标记字符不得注入',async()=>{
  const probe=await evaluate(`(()=>{const now=Date.now();
   state.conversations[0].messages.push({id:'m8b',role:'assistant',at:now,
     text:'危险：$<img src=x onerror=alert(1)>$ 与 \\u0060\\u0060\\u0060js\\n<script>alert(1)</script>\\n\\u0060\\u0060\\u0060'});
   save();renderAll();
   const bodies=[...document.querySelectorAll('#messageList .message-body')];
   const last=bodies[bodies.length-1];
   return {hasImg:!!last.querySelector('img'),hasScript:!!last.querySelector('script'),
     mathEscaped:/&lt;img/.test(last.innerHTML)};})()`);
  assert.equal(probe.hasImg,false,'公式里的 img 不得注入');
  assert.equal(probe.hasScript,false,'代码块里的 script 不得注入');
  assert.equal(probe.mathEscaped,true,'应转义为字面实体');
 });

 console.log(JSON.stringify({passed:passed.length,failures,qaStore:TEMP,modelCalls:0},null,2));
 assert.deepEqual(failures,[]);
}
function finish(code){clearTimeout(watchdog);win?.destroy();server?.kill('SIGTERM');code?app.exit(code):app.quit();}
run().then(()=>finish(0)).catch(error=>{console.error(error);console.error('QA store retained:',TEMP);finish(1);});
