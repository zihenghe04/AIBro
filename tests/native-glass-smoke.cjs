/* Isolated AppKit/Chromium integration. No workspace, credentials or network. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname, '../app'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'ai-bro-native-glass-smoke-'));
app.setPath('userData',profile);let win;
const guard=setTimeout(()=>finish(1),30000);
function finish(code){clearTimeout(guard);try{win?.destroy()}catch{}try{fs.rmSync(profile,{recursive:true,force:true})}catch{}app.exit(code);}
app.whenReady().then(async()=>{
  app.dock?.hide();
  const native=require(path.join(root,'native-glass.node'));
  assert.equal(native.isSupported(),true);
  win=new BrowserWindow({show:false,width:720,height:500,frame:false,transparent:true,backgroundColor:'#00000000',webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,callback)=>callback({cancel:true}));
  await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}button{position:absolute;left:30px;top:30px;width:160px;height:60px}</style><button id="test">Click through glass</button><script>window.clicked=0;test.onclick=()=>window.clicked++;</script>'));
  const handle=win.getNativeWindowHandle(),r={id:'sidebar',x:0,y:0,width:230,height:500,radius:24,style:'regular'};
  assert.equal(native.setRegions(handle,[r,{id:'composer',x:240,y:380,width:450,height:96,radius:28,style:'clear'}]),2);
  assert.equal(native.setRegions(handle,[{...r,width:280},{id:'composer',x:290,y:390,width:420,height:90,radius:28,style:'regular'}]),2);
  assert.throws(()=>native.setRegions(Buffer.alloc(8),[]),/no longer available/);
  assert.throws(()=>native.setRegions(Buffer.alloc(7),[]),/no longer available/);
  assert.throws(()=>native.setRegions(handle,[{...r,width:NaN}]),/Invalid/);
  win.webContents.focus();win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:100,y:55});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:100,y:55});
  await new Promise(resolve=>setTimeout(resolve,120));assert.equal(await win.webContents.executeJavaScript('window.clicked'),1);
  assert.equal(native.setRegions(handle,[r]),1);assert.equal(native.setRegions(handle,[]),0);
  assert.equal(native.setRegions(handle,[r]),1);win.destroy();win=null;assert.equal(native.clear(),true);
  console.log(JSON.stringify({ok:true,electron:process.versions.electron,node:process.versions.node,napi:process.versions.napi,checks:['public-glass-create','two-regions-update','invalid-handles','invalid-geometry','chromium-click-through','remove','closed-window-cleanup']}));finish(0);
}).catch(error=>{console.error(error.stack);finish(1)});
