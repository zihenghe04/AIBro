/* Full application entrypoint with a copied build, temporary profile/store,
   synthetic note, and network/model/auth routes blocked. No real user data. */
'use strict';
const {app,BrowserWindow,session,nativeTheme}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname, '../app'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'ai-bro-native-app-'));
const assets=path.join(temporary,'app'),appData=path.join(temporary,'app-data'),store=path.join(temporary,'store');
require('../app/app-assets').copyAssets(assets);
for(const folder of [appData,store])fs.mkdirSync(folder,{recursive:true});
if(process.env.AI_BRO_GLASS_DIAGNOSTIC)fs.copyFileSync(process.env.AI_BRO_GLASS_DIAGNOSTIC,path.join(assets,'native-glass.node'));
app.setPath('appData',appData);
app.setPath('userData',path.join(appData,'test-profile'));
process.env.AI_WORKSTATION_DATA_DIR=store;
process.env.AI_WORKSTATION_ASSET_DIR=assets;
let win,backdrop,finished=false;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const watchdog=setTimeout(()=>finish(1,Error('Native application acceptance timed out.')),45000);
async function finish(code,error){
  if(finished)return;finished=true;clearTimeout(watchdog);
  if(error)console.error(error.stack||String(error));
  try{win?.destroy();backdrop?.destroy()}catch{}
  // Let the production will-quit hook terminate only its own local server.
  app.emit('will-quit');
  await wait(180);
  try{fs.rmSync(temporary,{recursive:true,force:true})}catch{}
  app.exit(code);
}
async function until(check,label){for(let n=0;n<100;n++){if(await check())return;await wait(80);}throw Error('Timed out: '+label);}
async function run(){
  const port=await new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const number=server.address().port;server.close(()=>resolve(number));});});
  process.env.AI_WORKSTATION_PORT=String(port);const origin='http://127.0.0.1:'+port;
  const denied=[];
  await app.whenReady();app.dock?.hide();
  session.defaultSession.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{
    const url=new URL(details.url),blocked=['http:','https:'].includes(url.protocol)&&(url.origin!==origin||/^\/__(auth|codex|cloud|proxy|fetch)(\/|$)/.test(url.pathname));
    if(blocked)denied.push(url.pathname);callback({cancel:blocked});
  });
  app.on('browser-window-created',(_event,window)=>{if(win)return;win=window;window.hide();window.webContents.setBackgroundThrottling(false);});
  const log=console.log, error=console.error;
  console.log=(...args)=>{if(!String(args[0]).startsWith('[workstation]'))log(...args)};
  console.error=(...args)=>{if(!String(args[0]).startsWith('[workstation]'))error(...args)};
  require(path.join(assets,'electron-main.js'));
  await until(()=>win&&!win.webContents.isLoading()&&win.webContents.getURL()===origin+'/','copied real application');
  const evaluate=source=>win.webContents.executeJavaScript(source,true);
  async function sampleShell(){
    const geometry=await evaluate('({width:innerWidth,height:innerHeight,regions:NativeGlassUI.collectRegions(document).regions})');
    const capture=await win.webContents.capturePage(),size=capture.getSize(),pixels=capture.toBitmap();
    assert.equal(pixels.length,size.width*size.height*4);
    const samples=[];
    for(let y=1;y<geometry.height;y+=43)for(let x=1;x<geometry.width;x+=43){
      if(geometry.regions.some(r=>x>=r.x-4&&x<=r.x+r.width+4&&y>=r.y-4&&y<=r.y+r.height+4))continue;
      const px=Math.min(size.width-1,Math.floor(x*size.width/geometry.width)),py=Math.min(size.height-1,Math.floor(y*size.height/geometry.height));
      samples.push(pixels[(py*size.width+px)*4+3]);
    }
    return {samples:samples.length,minimumAlpha:Math.min(...samples)};
  }
  async function checkScrim(){
    const actual=await evaluate('(()=>{const e=document.querySelector(".topbar"),p=getComputedStyle(e,"::before"),q=getComputedStyle(e,"::after"),r=e.getBoundingClientRect();return{content:p.content,display:p.display,position:p.position,width:parseFloat(p.width),height:parseFloat(p.height),hostWidth:r.width,hostHeight:r.height,background:p.backgroundColor,overlay:{content:q.content,display:q.display,position:q.position,width:parseFloat(q.width),height:parseFloat(q.height),background:q.backgroundColor,mask:q.maskImage},colors:["text","muted","faint"].map(name=>{const span=document.createElement("span");span.style.color="var(--"+name+")";e.append(span);const color=getComputedStyle(span).color;span.remove();return color})}})()');
    assert.notEqual(actual.content,'none');assert.notEqual(actual.display,'none');assert.equal(actual.position,'absolute');
    assert.ok(actual.width>=actual.hostWidth-12&&actual.height>=actual.hostHeight-12,'scrim must cover the actual header text area');
    assert.notEqual(actual.overlay.content,'none');assert.notEqual(actual.overlay.display,'none');assert.equal(actual.overlay.position,'absolute');
    assert.ok(actual.overlay.width>=actual.hostWidth-12&&actual.overlay.height>=actual.hostHeight-12);assert.match(actual.overlay.mask,/linear-gradient/);
    const rgba=value=>value.match(/[\d.]+/g).map(Number),bg=rgba(actual.background),overlay=rgba(actual.overlay.background),alpha=bg[3]??1,overlayAlpha=overlay[3]??1;
    const luminance=rgb=>rgb.map(v=>{const c=v/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    const ratios=[];
    for(const background of [0,255])for(const color of actual.colors){const base=bg.slice(0,3).map((v,i)=>overlay[i]*overlayAlpha+(v*alpha+background*(1-alpha))*(1-overlayAlpha)),fg=rgba(color),visible=fg.slice(0,3).map((v,i)=>v*(fg[3]??1)+base[i]*(1-(fg[3]??1)));const a=luminance(base),b=luminance(visible);ratios.push((Math.max(a,b)+.05)/(Math.min(a,b)+.05));}
    assert.ok(Math.min(...ratios)>=4.5,'header text must contrast with its scrim over both black and white native backdrops');
    return {background:actual.background,contentBackground:actual.overlay.background,minimumContrast:Math.min(...ratios)};
  }
  await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'isolated hydration');
  assert.ok(app.getPath('userData').startsWith(appData+path.sep));
  assert.ok(['#00000000','#000000'].includes(win.getBackgroundColor()));
  await evaluate('document.querySelector("#onboardingSkip")?.click();Object.assign(state,{projects:[],tasks:[],imports:[],papers:[],agentRuns:[],trash:[],notes:[{id:"native-qa-note",title:"Synthetic note",content:"# Synthetic document\\n\\nThis is isolated test content.",workspace:"科研"}]});normalizeStateShape(state);repairRelationships();showView("agent","持续对话");renderAll();NativeGlassUI.init();true');
  const checks=[];
  await until(()=>evaluate('NativeGlassUI.init().status().active'),'native activation in full app');
  let status=await evaluate('NativeGlassUI.init().status()');
  assert.equal(status.supported,true);assert.ok(status.regions>=3&&status.regions<=5);checks.push('real-main-preload-ipc-active');
  const inspect=async()=>{
    const addon=require(path.join(assets,'native-glass.node'));
    return typeof addon.diagnose==='function'?JSON.parse(addon.diagnose()):undefined;
  };
  for(const theme of ['light','dark','light']){
    await evaluate('state.ui.theme='+JSON.stringify(theme)+';applyUiPreferences();NativeGlassUI.refresh();true');
    await until(()=>evaluate('NativeGlassUI.init().status().active'),'theme activation');await wait(250);
    assert.equal(nativeTheme.themeSource,theme);
    const view=await evaluate('({hidden:document.hidden,body:getComputedStyle(document.body).backgroundColor,main:getComputedStyle(document.querySelector(".main")).backgroundColor,topbar:getComputedStyle(document.querySelector(".topbar")).backgroundColor,composer:getComputedStyle(document.querySelector("#composer")).backgroundColor,regions:NativeGlassUI.init().status().regions,overflow:document.documentElement.scrollWidth>innerWidth+1})');
    assert.equal(view.hidden,false);assert.equal(view.overflow,false);assert.equal(view.body,'rgba(0, 0, 0, 0)');
    const shell=await sampleShell();
    assert.ok(shell.samples>15);assert.equal(shell.minimumAlpha,255,'every sampled point outside native regions must have an opaque shell');
    assert.equal(await evaluate('document.querySelector("#nativeGlassShell path")?.getAttribute("fill-rule")'),'evenodd');
    const scrim=await checkScrim();
    const diagnostics=await inspect();
    console.log(JSON.stringify({theme,view,shell,scrim,...(diagnostics?{diagnostics}:{})}));
    checks.push('theme-'+theme);
  }
  await evaluate('openNote("native-qa-note");true');await until(()=>evaluate('!document.querySelector("#readingPane").hidden&&NativeGlassUI.init().status().active&&!!document.querySelector("[data-native-glass-region=reader-header]")'),'reading pane glass');
  const reader=await evaluate('({background:getComputedStyle(document.querySelector("#previewDialog")).backgroundColor,body:document.querySelector(".note-document-preview")?.textContent||document.querySelector("#previewDialog").textContent,regions:NativeGlassUI.init().status().regions})');
  assert.notEqual(reader.background,'rgba(0, 0, 0, 0)');assert.match(reader.body,/Synthetic document/);assert.ok(reader.regions>=3&&reader.regions<=5);checks.push('opaque-readable-document');
  if(process.env.AI_BRO_GLASS_SCREENSHOTS){
    const output=path.resolve(process.env.AI_BRO_GLASS_SCREENSHOTS);fs.mkdirSync(output,{recursive:true});
    const bounds=win.getBounds();backdrop=new BrowserWindow({show:false,frame:false,x:bounds.x-60,y:bounds.y-60,width:bounds.width+120,height:bounds.height+120,backgroundColor:'#ffffff',webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
    const captures=[];
    for(const background of ['bright','dark']){
      const color=background==='bright'?'#ffffff':'#050505';
      await backdrop.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:'+color+'}</style>'));
      backdrop.setBackgroundColor(color);backdrop.showInactive();win.show();win.focus();
      for(const theme of ['light','dark']){
        await evaluate('state.ui.theme='+JSON.stringify(theme)+';applyUiPreferences();NativeGlassUI.refresh();true');
        await until(()=>evaluate('NativeGlassUI.init().status().active'),'visible native theme');await wait(500);
        assert.equal((await sampleShell()).minimumAlpha,255);const scrim=await checkScrim();
        const filename=path.join(output,theme+'-on-'+background+'.png'),windowId=win.getMediaSourceId().split(':')[1];
        const captured=spawnSync('/usr/sbin/screencapture',['-x','-o','-l',windowId,filename],{encoding:'utf8'});
        assert.equal(captured.status,0,captured.stderr);assert.ok(fs.statSync(filename).size>1000);
        captures.push({theme,background,path:filename,minimumContrast:scrim.minimumContrast});
      }
    }
    console.log(JSON.stringify({captures}));checks.push('light-dark-on-bright-dark-native-backdrops');backdrop.destroy();backdrop=null;win.hide();
  }
  win.setSize(1100,800);await wait(220);await until(()=>evaluate('NativeGlassUI.init().status().active&&!document.querySelector("[data-native-glass-region]")?.hidden'),'resized active');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),true);checks.push('resize-and-bounds');
  await evaluate('ReadingPane.hide();NativeGlassUI.refresh();true');await wait(220);
  assert.equal(await evaluate('!!document.querySelector("[data-native-glass-region=reader-header]")'),false);checks.push('closed-reader-removal');
  assert.equal(denied.some(route=>/\/(respond|proxy|fetch|connect)$/.test(route)),false,'no model request was attempted');
  const credentials=path.join(app.getPath('userData'),'credentials');
  assert.ok(!fs.existsSync(credentials)||fs.readdirSync(credentials).length===0,'the isolated acceptance must not create any credential record');
  await evaluate('NativeGlassUI.destroy();true');await wait(150);
  assert.deepEqual(await evaluate('window.workstationDesktop.nativeGlass.status()'),{supported:true,active:false,regions:0});checks.push('native-cleanup');
  console.log(JSON.stringify({ok:true,electron:process.versions.electron,checks}));await finish(0);
}
run().catch(error=>finish(1,error));
