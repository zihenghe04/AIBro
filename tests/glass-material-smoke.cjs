/* Isolated native + DOM glass acceptance. Only synthetic content is shown. */
const {app,BrowserWindow,ipcMain,nativeTheme,desktopCapturer}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),net=require('node:net');const{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-material-qa-'));app.setPath('userData',path.join(TEMP,'profile'));
let server,win,back,glass;const wait=ms=>new Promise(r=>setTimeout(r,ms));const deadline=setTimeout(()=>finish(1),100000);
async function until(fn,label){for(let i=0;i<400;i++){if(await fn())return;await wait(50)}throw Error('Waiting for '+label)}
async function run(){
 const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})}),origin='http://127.0.0.1:'+port;
 server=spawn('python3',[path.join(ROOT,'app/server.py')],{env:{...process.env,AI_WORKSTATION_DATA_DIR:path.join(TEMP,'store'),AI_WORKSTATION_PORT:String(port),AI_WORKSTATION_ASSET_DIR:path.join(ROOT,'app')},stdio:'ignore'});await until(async()=>{try{return(await fetch(origin+'/__health')).ok}catch{return false}},'server');await app.whenReady();
 const preload=path.join(TEMP,'preload.cjs');fs.writeFileSync(preload,`const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('workstationDesktop',{nativeGlass:{status:()=>ipcRenderer.invoke('qa:status'),setRegions:r=>ipcRenderer.invoke('qa:regions',r)}});`);
 back=new BrowserWindow({show:true,x:10,y:30,width:1450,height:1000,title:'Synthetic glass backdrop',webPreferences:{sandbox:true}});await back.loadURL('data:text/html,'+encodeURIComponent('<body style="margin:0;background:radial-gradient(ellipse at 15% 30%,#cc855b,transparent 48%),radial-gradient(ellipse at 35% 80%,#7a9478,transparent 50%),linear-gradient(125deg,#b3ac9f,#eee9dd);height:100vh"></body>'));
 win=new BrowserWindow({show:false,x:30,y:50,width:1380,height:940,title:'AI Bro material review',transparent:true,backgroundColor:'#00000000',titleBarStyle:'hiddenInset',webPreferences:{preload,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 glass=require('../app/native-liquid-glass').createNativeGlass({getWindow:()=>win,getLocalOrigin:()=>origin,loadAddon:()=>require(path.join(ROOT,'AI Bro.app/Contents/Resources/app/native-glass.node'))});ipcMain.handle('qa:status',e=>glass.status(e));ipcMain.handle('qa:regions',(e,r)=>glass.setRegions(e,r));
 const forbidden=[];win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(d,done)=>{const block=new URL(d.url).origin!==origin;if(block)forbidden.push(d.url);done({cancel:block})});
 const ev=s=>win.webContents.executeJavaScript(s,true);await win.loadURL(origin);await until(()=>ev('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydrate');
 await ev(`Object.assign(state,{projects:[{id:'p',name:'Research notebook',workspace:'科研'}],notes:[],papers:[],imports:[],tasks:[],agentRuns:[],conversations:[{id:'qa',title:'Turn reading into understanding',workspace:'科研',projectId:'p',messages:Array.from({length:12},(_,i)=>({id:'m'+i,role:i%2?'agent':'user',text:i%2?'The key distinction is how evidence is collected. Compare the methods, record limitations, and connect the result to your existing notes.':'Compare these approaches and identify what is worth exploring next.',at:Date.now()})),attachments:[],draftAttachmentIds:[],draft:''}],currentConversationId:'qa'});normalizeStateShape(state);state.ui.theme='light';applyUiPreferences();showView('agent','对话');renderAll();document.querySelectorAll('dialog[open]').forEach(x=>x.close());document.querySelector('#onboardingSkip')?.click();true`);
 win.show();win.focus();await wait(800);
 const reports=[];
 for(const theme of ['light','dark']){
  nativeTheme.themeSource=theme;await ev(`state.ui.theme='${theme}';applyUiPreferences();renderAll();true`);await wait(700);
  const info=await ev(`(()=>{const c=document.getElementById('composer'),s=getComputedStyle(c);return{native:NativeGlassUI.init().status(),lens:c.dataset.glassRefracting,filter:s.backdropFilter,nativeTargets:[...document.querySelectorAll('[data-native-glass-region]')].map(e=>e.id),overflow:document.documentElement.scrollWidth>innerWidth}})()`);
  assert.equal(info.lens,'true');assert.match(info.filter,/url/);assert.ok(info.nativeTargets.every(x=>['sidebar','conversationNavigator'].includes(x)));assert.equal(info.overflow,false);reports.push({theme,...info});
  fs.writeFileSync(path.join(TEMP,theme+'-renderer.png'),(await win.webContents.capturePage()).toPNG());
  // Window capture includes AppKit regions, unlike WebContents-only screenshots.
  const sources=await desktopCapturer.getSources({types:['window'],thumbnailSize:{width:1600,height:1100}});const shot=sources.find(s=>s.id===win.getMediaSourceId());if(shot)fs.writeFileSync(path.join(TEMP,theme+'-native.png'),shot.thumbnail.toPNG());
 }
 await ev(`document.querySelector('#agentInput').value='Draft stays sharp while the backdrop moves';document.querySelector('#agentInput').focus();true`);await wait(300);assert.equal(await ev(`getComputedStyle(document.querySelector('#agentInput')).filter`),'none');
 win.setSize(1000,760);await wait(500);assert.equal(await ev('document.documentElement.scrollWidth>innerWidth'),false);
 win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});await wait(500);assert.equal(await ev(`document.documentElement.classList.contains('native-liquid-glass')`),false);assert.equal(await ev(`document.getElementById('composer').hasAttribute('data-glass-refracting')`),false);
 assert.deepEqual(forbidden,[]);console.log(JSON.stringify({passed:true,reports,screenshots:TEMP,checks:['native navigation only','DOM composer refraction remains active','no text filter','light and dark','resize','reduced transparency fallback','no external requests']}));
}
function finish(code){clearTimeout(deadline);glass?.dispose();win?.destroy();back?.destroy();server?.kill();app.exit(code)}run().then(()=>finish(0)).catch(e=>{console.error(e.stack);finish(1)});
