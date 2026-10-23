/* 第 7 轮验收：原件预览补充形态（§5.3）——视频 / 音频 / CSV 表格 / HTML 沙箱。
   真实渲染器中验证；出站模型请求一律拒绝（本脚本不发消息）。
   运行：node_modules/.bin/electron tests/agent-round7-smoke.cjs */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18913,ORIGIN=`http://127.0.0.1:${PORT}`;
const TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aw-round7-')),STORE=path.join(TEMP,'store');fs.mkdirSync(STORE);fs.mkdirSync(path.join(TEMP,'profile'));app.setPath('userData',path.join(TEMP,'profile'));
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
 assert.equal(await evaluate('!!window.PreviewMedia'),true,'预览模块必须加载');

 // 造四个资料（走 dataUrl 分支：断言真实接线，不依赖后端文件存储）
 await evaluate(`(()=>{const now=Date.now();
  state.projects=[];state.notes=[];state.tasks=[];state.agentRuns=[];state.conversations=[{id:'qa_c1',title:'预览验收',workspace:'日常',permissionMode:'auto',attachments:[],draftAttachmentIds:[],draft:'',createdAt:now,updatedAt:now,messages:[]}];
  state.currentConversationId='qa_c1';state.settings.permissions={'日常':'auto','课程':'auto','科研':'auto'};
  state.imports=[
   {id:'qa_video',name:'演示短片.mp4',originalName:'演示短片.mp4',mimeType:'video/mp4',size:1024,dataUrl:'data:video/mp4;base64,AAAAIGZ0eXA=',content:'',status:'original-only',folderPath:'原始资料',createdAt:now,updatedAt:now,tags:[]},
   {id:'qa_audio',name:'录音.mp3',originalName:'录音.mp3',mimeType:'audio/mpeg',size:512,dataUrl:'data:audio/mpeg;base64,SUQz',content:'',status:'original-only',folderPath:'原始资料',createdAt:now,updatedAt:now,tags:[]},
   {id:'qa_csv',name:'数据表.csv',originalName:'数据表.csv',mimeType:'text/csv',size:64,dataUrl:null,content:'名称,数量\\n苹果,3\\n<script>alert(1)</script>,7',status:'parsed',folderPath:'原始资料',createdAt:now,updatedAt:now,tags:[]},
   {id:'qa_html',name:'页面.html',originalName:'页面.html',mimeType:'text/html',size:128,dataUrl:'data:text/html;base64,PGgxPkhlbGxvPC9oMT4=',content:'',status:'original-only',folderPath:'原始资料',createdAt:now,updatedAt:now,tags:[]},
   {id:'qa_plain',name:'说明.txt',originalName:'说明.txt',mimeType:'text/plain',size:32,dataUrl:'data:text/plain;base64,aGk=',content:'hi',status:'parsed',folderPath:'原始资料',createdAt:now,updatedAt:now,tags:[]},
   {id:'qa_image',name:'照片.png',originalName:'照片.png',mimeType:'image/png',size:256,dataUrl:'data:image/png;base64,iVBORw0KGgo=',content:'',status:'original-only',folderPath:'原始资料',createdAt:now,updatedAt:now,tags:[]}
  ];
  normalizeStateShape(state);save();applyUiPreferences();showView('agent','对话');renderAll();})()`);
 await wait(500);

 await step('视频：原件预览渲染为带控件的播放器（不再只给"已保存可下载"）',async()=>{
  const probe=await evaluate(`(async()=>{await openPreview('import','qa_video');await new Promise(r=>setTimeout(r,250));
   const visual=$('#previewVisual');const video=visual.querySelector('video');
   return {hasVideo:!!video,controls:video?video.controls:null,src:video?video.src.slice(0,20):'',
     noteShown:/原始文件已保存/.test(visual.innerHTML)};})()`);
  assert.equal(probe.hasVideo,true,'必须渲染 video 元素');
  assert.equal(probe.controls,true,'必须带原生控件');
  assert.match(probe.src,/^(blob:|data:video\/)/,'应使用原件自身的 URL（不伪造来源）');
  assert.equal(probe.noteShown,false,'不应再显示"原始文件已保存，可下载查看"');
 });

 await step('音频：渲染为音频播放器',async()=>{
  const probe=await evaluate(`(async()=>{await openPreview('import','qa_audio');await new Promise(r=>setTimeout(r,250));
   const audio=$('#previewVisual').querySelector('audio');
   return {hasAudio:!!audio,controls:audio?audio.controls:null};})()`);
  assert.equal(probe.hasAudio,true);
  assert.equal(probe.controls,true);
 });

 await step('CSV：渲染成表格，且单元格一律转义（标记只能字面呈现）',async()=>{
  const probe=await evaluate(`(async()=>{await openPreview('import','qa_csv');await new Promise(r=>setTimeout(r,250));
   const visual=$('#previewVisual');const table=visual.querySelector('table.preview-table');
   const html=visual.innerHTML;
   return {hasTable:!!table,th:[...visual.querySelectorAll('th')].map(n=>n.textContent),
     td:[...visual.querySelectorAll('td')].map(n=>n.textContent).slice(0,4),
     injected:/<script>alert/.test(html),escaped:/&lt;script&gt;/.test(html)};})()`);
  assert.equal(probe.hasTable,true,'必须渲染表格');
  assert.deepEqual(probe.th,['名称','数量'],'表头取自首行');
  assert.equal(probe.td[0],'苹果');
  assert.equal(probe.injected,false,'不得把单元格当 HTML 注入');
  assert.equal(probe.escaped,true,'标记必须以字面（转义后）呈现');
 });

 await step('HTML：空沙箱 iframe（不执行脚本、不发外链请求）+ 如实说明',async()=>{
  const probe=await evaluate(`(async()=>{await openPreview('import','qa_html');await new Promise(r=>setTimeout(r,250));
   const visual=$('#previewVisual');const frame=visual.querySelector('iframe');
   return {hasFrame:!!frame,sandbox:frame?frame.getAttribute('sandbox'):null,
     referrer:frame?frame.getAttribute('referrerpolicy'):null,
     note:visual.textContent};})()`);
  assert.equal(probe.hasFrame,true,'必须渲染 iframe');
  assert.equal(probe.sandbox,'','沙箱必须为空（拒绝一切能力）——安全边界不得放开');
  assert.equal(probe.referrer,'no-referrer');
  assert.match(probe.note,/不执行.*脚本/,'必须如实告知未执行脚本');
 });

 await step('不认识的类型不接管：仍显示既有兜底提示（不回归）',async()=>{
  const probe=await evaluate(`(async()=>{await openPreview('import','qa_plain');await new Promise(r=>setTimeout(r,250));
   const visual=$('#previewVisual');
   return {noteShown:/原始文件已保存/.test(visual.innerHTML),hasMedia:!!visual.querySelector('video,audio,iframe,table')};})()`);
  assert.equal(probe.noteShown,true,'纯文本原件应保持既有提示');
  assert.equal(probe.hasMedia,false,'不得渲染任何媒体元素');
 });

 await step('图片仍走既有分支（不回归）',async()=>{
  const probe=await evaluate(`(async()=>{await openPreview('import','qa_image');await new Promise(r=>setTimeout(r,250));
   const img=$('#previewVisual').querySelector('img');
   return {hasImage:!!img,src:img?img.src.slice(0,15):''};})()`);
  assert.equal(probe.hasImage,true);
  assert.match(probe.src,/^(blob:|data:image\/)/);
 });

 console.log(JSON.stringify({passed:passed.length,failures,qaStore:TEMP,modelCalls:0},null,2));
 assert.deepEqual(failures,[]);
}
function finish(code){clearTimeout(watchdog);win?.destroy();server?.kill('SIGTERM');code?app.exit(code):app.quit();}
run().then(()=>finish(0)).catch(error=>{console.error(error);console.error('QA store retained:',TEMP);finish(1);});
