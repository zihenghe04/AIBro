/* 第 10 轮验收：消息媒体（§3）——连续图片合并画廊、视频/音频内嵌播放、其余不变。
   真实渲染器中验证；出站模型请求一律拒绝（本脚本不发消息）。
   运行：node_modules/.bin/electron tests/agent-round10-smoke.cjs */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18919,ORIGIN=`http://127.0.0.1:${PORT}`;
const TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aw-round10-')),STORE=path.join(TEMP,'store');fs.mkdirSync(STORE);fs.mkdirSync(path.join(TEMP,'profile'));app.setPath('userData',path.join(TEMP,'profile'));
let server,win;const passed=[],failures=[];const wait=ms=>new Promise(r=>setTimeout(r,ms));
const request=route=>new Promise((resolve,reject)=>http.get(ORIGIN+route,r=>{r.resume();r.on('end',()=>resolve({status:r.statusCode}));}).on('error',reject));
async function until(fn,label,timeout=15000){const start=Date.now();while(Date.now()-start<timeout){if(await fn())return;await wait(60);}throw Error(`Timed out: ${label}`);}
const watchdog=setTimeout(()=>{console.error('QA timeout',TEMP);win?.destroy();server?.kill('SIGTERM');app.exit(1);},180000);
async function run(){
 await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',()=>reject(Error(`${PORT} occupied`)));probe.listen(PORT,'127.0.0.1',()=>probe.close(resolve));});
 const log=fs.openSync(path.join(TEMP,'server.log'),'a');server=spawn(process.env.PYTHON||'python3',[path.join(ROOT,'app','server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(PORT),AI_WORKSTATION_DATA_DIR:STORE,AI_WORKSTATION_ASSET_DIR:path.join(ROOT,'app')},stdio:['ignore',log,log]});
 await until(async()=>{if(server.exitCode!==null)throw Error('QA service exited');try{return(await request('/__health')).status===200;}catch{return false;}},'QA service');
 await app.whenReady();win=new BrowserWindow({show:true,width:1360,height:950,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const errors=[];win.webContents.on('console-message',(_event,level,message)=>{if(level>=3){errors.push(message);}});
 const evaluate=async code=>{try{return await win.webContents.executeJavaScript(code,true);}catch(error){console.error('Renderer errors:',JSON.stringify(errors));throw error;}};
 async function step(label,fn){try{await fn();passed.push(label);console.log('PASS',label);}catch(error){failures.push({label,error:error.stack});console.error('FAIL',label,error.message);}}
 await win.loadURL(ORIGIN);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydration');
 await wait(600);
 assert.equal(await evaluate('!!window.MessageMedia'),true,'消息媒体模块必须加载');

 // 1x1 PNG（真实可渲染的 dataUrl）
 await evaluate(`(()=>{const now=Date.now();
  const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const mk=(id,name,mimeType,extra)=>({id,name,originalName:name,mimeType,size:100,fileStored:false,dataUrl:PNG,content:'',status:'original-only',folderPath:'原始资料',createdAt:now,updatedAt:now,tags:[],...extra});
  state.projects=[];state.notes=[];state.tasks=[];state.agentRuns=[];
  state.imports=[
   mk('qa_img1','第一张.png','image/png'), mk('qa_img2','第二张.png','image/png'), mk('qa_img3','第三张.png','image/png'),
   mk('qa_vid','演示.mp4','video/mp4'),
   mk('qa_pdf','文档.pdf','application/pdf',{dataUrl:null}),
   mk('qa_legacy','旧图.png','image/png',{dataUrl:null})
  ];
  state.conversations=[{id:'qa_c10',title:'媒体验收',workspace:'日常',permissionMode:'auto',draft:'',draftAttachmentIds:[],createdAt:now,updatedAt:now,
   messages:[{id:'qa_m10',role:'user',at:now,text:'看看这几张图和一个视频。',
    attachmentIds:['qa_img1','qa_img2','qa_img3','qa_vid','qa_pdf','qa_legacy'],
    attachments:state.imports.map(i=>({id:i.id,name:i.name}))}]}];
  state.currentConversationId='qa_c10';state.settings.permissions={'日常':'auto','课程':'auto','科研':'auto'};
  normalizeStateShape(state);state.ui.inspectorOpen=false;save();applyUiPreferences();showView('agent','对话');renderAll();
  const layer=document.querySelector('#onboardingLayer');if(layer)layer.remove();})()`);
 await wait(900);

 await step('连续三张图片合并成一个画廊（带张数角标）',async()=>{
  const probe=await evaluate(`(()=>{const gal=document.querySelector('#messageList .message-media-gallery');
   return {exists:!!gal,multi:gal?.classList.contains('is-multi')??false,count:gal?.dataset.mediaCount||'',
     images:gal?gal.querySelectorAll('img').length:0,label:gal?.querySelector('.message-media-count')?.textContent||''};})()`);
  assert.equal(probe.exists,true,'应渲染画廊');
  assert.equal(probe.multi,true,'多图应带 is-multi');
  assert.equal(probe.images,3,'三张图片都在画廊里');
  assert.equal(probe.label,'3 张','应显示张数角标');
 });

 await step('画廊图片可点击预览原件（沿用既有入口），并有 alt',async()=>{
  const probe=await evaluate(`(()=>{const first=document.querySelector('#messageList .message-media-image');
   const img=first?.querySelector('img');
   return {openAttr:first?.getAttribute('data-open-import')||'',alt:img?.getAttribute('alt')||'',lazy:img?.getAttribute('loading')||''};})()`);
  assert.equal(probe.openAttr,'qa_img1','应指向对应附件');
  assert.equal(probe.alt,'第一张.png','应有 alt');
  assert.equal(probe.lazy,'lazy','应懒加载');
 });

 await step('视频内嵌为可播放控件（不再是文件按钮）',async()=>{
  const probe=await evaluate(`(()=>{const player=document.querySelector('#messageList .message-media-player');
   const video=player?.querySelector('video');
   return {player:!!player,video:!!video,controls:video?.controls??false,caption:player?.querySelector('b')?.textContent||''};})()`);
  assert.equal(probe.player,true,'应渲染播放器块');
  assert.equal(probe.video,true,'应为 video 元素');
  assert.equal(probe.controls,true,'应带原生控件');
  assert.equal(probe.caption,'演示.mp4','应显示文件名');
 });

 await step('PDF 与拿不到地址的旧图仍走既有按钮（不显示破图）',async()=>{
  const probe=await evaluate(`(()=>{const buttons=[...document.querySelectorAll('#messageList .message-attachment')];
   const names=buttons.map(b=>b.querySelector('b')?.textContent||'');
   const gallery=document.querySelector('#messageList .message-media-gallery');
   return {names,legacyInGallery:!!gallery&&/旧图/.test(gallery.textContent||'')};})()`);
  assert.ok(probe.names.includes('文档.pdf'),'PDF 应保持按钮形态');
  assert.ok(probe.names.includes('旧图.png'),'无地址的图片应退回按钮');
  assert.equal(probe.legacyInGallery,false,'无地址的图片不得进画廊（否则是破图）');
 });

 await step('安全：文件名里的标记字符被转义（渲染到画廊 alt 与播放器标题）',async()=>{
  const probe=await evaluate(`(()=>{const now=Date.now();
   state.imports.push({id:'qa_xss',name:'<img src=x onerror=1>.png',originalName:'<img src=x onerror=1>.png',mimeType:'image/png',size:10,fileStored:false,dataUrl:'data:image/png;base64,iVBORw0KGgo=',content:'',status:'original-only',folderPath:'原始资料',createdAt:now,updatedAt:now,tags:[]});
   state.conversations[0].messages.push({id:'qa_m10b',role:'user',at:now,text:'危险文件名',attachmentIds:['qa_xss'],attachments:[{id:'qa_xss',name:'<img src=x onerror=1>.png'}]});
   save();renderAll();
   const bodies=[...document.querySelectorAll('#messageList .message-body')];
   const galleries=[...document.querySelectorAll('#messageList .message-media-gallery')];
   const last=galleries[galleries.length-1];
   const img=last?.querySelector('img');
   return {alt:img?.getAttribute('alt')||'',injected:/<img\s+src=x/i.test(last?.innerHTML||'')};})()`);
  assert.equal(probe.injected,false,'不得注入图片标签');
  assert.match(probe.alt,/^<img src=x onerror=1>\.png$/,'alt 里应是原文件名文本');
 });

 console.log(JSON.stringify({passed:passed.length,failures,qaStore:TEMP,modelCalls:0},null,2));
 assert.deepEqual(failures,[]);
}
function finish(code){clearTimeout(watchdog);win?.destroy();server?.kill('SIGTERM');code?app.exit(code):app.quit();}
run().then(()=>finish(0)).catch(error=>{console.error(error);console.error('QA store retained:',TEMP);finish(1);});
