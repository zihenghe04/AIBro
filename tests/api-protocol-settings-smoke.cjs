/* 接口协议与模型列表验收（真实渲染器）：设置页可选择接口协议、测试连接后把服务真实返回
   的模型填入列表供直接选择，且协议配置真正作用到出站请求——DeepSeek 地址必须发往
   /chat/completions 而不是 /responses。
   出站请求一律拦截，不访问任何真实服务。
   运行：node_modules/.bin/electron tests/api-protocol-settings-smoke.cjs */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18900,ORIGIN=`http://127.0.0.1:${PORT}`;
const TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aw-protocol-settings-')),STORE=path.join(TEMP,'store');fs.mkdirSync(STORE);fs.mkdirSync(path.join(TEMP,'profile'));app.setPath('userData',path.join(TEMP,'profile'));
let server,win;const passed=[],failures=[];const wait=ms=>new Promise(r=>setTimeout(r,ms));
const request=route=>new Promise((resolve,reject)=>http.get(ORIGIN+route,r=>{const chunks=[];r.on('data',c=>chunks.push(c));r.on('end',()=>resolve({status:r.statusCode,body:Buffer.concat(chunks)}));}).on('error',reject));
async function until(fn,label,timeout=15000){const start=Date.now();while(Date.now()-start<timeout){if(await fn())return;await wait(60);}throw Error(`Timed out: ${label}`);}
const watchdog=setTimeout(()=>{console.error('QA timeout',TEMP);win?.destroy();server?.kill('SIGTERM');app.exit(1);},180000);
async function run(){
 await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',()=>reject(Error(`${PORT} occupied; refusing existing workspace`)));probe.listen(PORT,'127.0.0.1',()=>probe.close(resolve));});
 const log=fs.openSync(path.join(TEMP,'server.log'),'a');server=spawn(process.env.PYTHON||'python3',[path.join(ROOT,'app','server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(PORT),AI_WORKSTATION_DATA_DIR:STORE,AI_WORKSTATION_ASSET_DIR:path.join(ROOT,'app')},stdio:['ignore',log,log]});
 await until(async()=>{if(server.exitCode!==null)throw Error('QA service exited');try{return(await request('/__health')).status===200;}catch{return false;}},'QA service');
 await app.whenReady();win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const evaluate=async code=>win.webContents.executeJavaScript(code,true);
 async function step(label,fn){try{await fn();passed.push(label);console.log('PASS',label);}catch(error){failures.push({label,error:error.stack});console.error('FAIL',label,error.message);}}
 await win.loadURL(ORIGIN);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydration');
 // 拦截出站请求：/models 返回固定模型列表，/__proxy 返回一个 chat SSE 流并记录真实目标 URL。
 await evaluate(`(()=>{window.__proxyTargets=[];const original=window.fetch.bind(window);window.fetch=async(url,options)=>{const text=String(url);
  if(decodeURIComponent(text).includes('/models'))return new Response(JSON.stringify({data:[{id:'deepseek-chat'},{id:'deepseek-reasoner'}]}),{status:200,headers:{'content-type':'application/json'}});
  if(text.includes('/__proxy')){window.__proxyTargets.push(decodeURIComponent(text));const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{index:0,delta:{content:'{"message":"ok","actions":[]}'}}]})+'\\n\\n'));c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\\n\\n'));c.enqueue(new TextEncoder().encode('data: [DONE]\\n\\n'));c.close();}});return new Response(stream,{status:200,headers:{'content-type':'text/event-stream'}});}
  return original(url,options);};})()`);
 await step('设置页提供接口协议选择，默认自动且选项齐全',async()=>{
  await evaluate(`showView('settings','系统设置')`);await wait(300);
  const select=await evaluate(`(()=>{const node=document.querySelector('#apiProtocol');return node?{value:node.value,options:[...node.options].map(o=>o.value)}:null})()`);
  assert.ok(select,'设置页应存在接口协议选择');
  assert.deepEqual(select.options,['auto','responses','chat','anthropic']);
  assert.equal(select.value,'auto','默认应为自动');
  assert.ok(await evaluate(`!!document.querySelector('#apiModelOptions')`),'默认模型应挂接可选择的模型列表');
 });
 await step('测试连接把服务返回的模型填入列表供直接选择',async()=>{
  await evaluate(`(()=>{$('#apiBase').value='https://api.deepseek.com';$('#apiKey').value='sk-synthetic';$('#model').value='';$('#model').dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate(`document.querySelector('#testApi').click()`);
  await until(()=>evaluate(`document.querySelectorAll('#apiModelOptions option').length>0`),'model options');
  const options=await evaluate(`JSON.stringify([...document.querySelectorAll('#apiModelOptions option')].map(o=>o.value))`);
  assert.deepEqual(JSON.parse(options),['deepseek-chat','deepseek-reasoner'],'模型列表应来自服务真实返回');
  const status=await evaluate(`$('#apiStatus').textContent`);
  assert.match(status,/已读取模型列表.*尚未验证模型调用/);assert.match(status,/可直接选择/);
  assert.equal(await evaluate(`$('#model').value`),'','列表仅提供选择，不得擅自改写默认模型');
 });
 await step('保存接口协议后配置持久化并作用到出站请求（现实性检查）',async()=>{
  await evaluate(`(()=>{$('#apiProtocol').value='chat';$('#apiProtocol').dispatchEvent(new Event('change',{bubbles:true}));$('#model').value='deepseek-chat';$('#model').dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate(`document.querySelector('#saveSettings').click()`);
  await until(()=>evaluate(`localStorage.getItem('workstation-api-protocol')==='chat'`),'protocol persisted');
  // 真实调用一次：DeepSeek 地址必须发往 chat/completions，而不是 responses
  await evaluate(`AgentTransport.requestPlan({provider:'api',base:localStorage.getItem('workstation-api-base'),model:'deepseek-chat',token:'sk-synthetic',input:'ping'})`);
  const targets=JSON.parse(await evaluate(`JSON.stringify(window.__proxyTargets)`));
  assert.equal(targets.length,1,'应发出一次请求');
  assert.match(targets[0],/\/chat\/completions/,`出站请求应发往 chat/completions，实际：${targets[0]}`);
  assert.doesNotMatch(targets[0],/\/responses/);
 });
 await step('协议选择为自动时，OpenAI 官方地址仍走 responses',async()=>{
  await evaluate(`(()=>{localStorage.setItem('workstation-api-protocol','auto');})()`);
  await evaluate(`AgentTransport.requestPlan({provider:'api',base:'https://api.openai.com/v1',model:'gpt-5.6-luna',token:'sk-synthetic',input:'ping'})`);
  const targets=JSON.parse(await evaluate(`JSON.stringify(window.__proxyTargets)`));
  assert.match(targets.at(-1),/\/responses/,'自动模式不得改写 OpenAI 官方地址的协议');
 });
 console.log(JSON.stringify({passed:passed.length,failures,qaStore:TEMP},null,2));
 assert.deepEqual(failures,[]);
}
function finish(code){clearTimeout(watchdog);win?.destroy();server?.kill('SIGTERM');code?app.exit(code):app.quit();}
run().then(()=>finish(0)).catch(error=>{console.error(error);console.error('QA store retained:',TEMP);finish(1);});
