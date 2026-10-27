/* Isolated production PDFReader + Halaska toolbar, real PyMuPDF HTTP rasters.
   Electron/DPR renderer evidence, not native WKWebView acceptance. */
const {app, BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict'),{spawn,spawnSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-pdf-quality-')),STORE=path.join(TEMP,'store'),OUT=path.join(ROOT,'test-results/pdf-reader-quality-20260929');
fs.mkdirSync(path.join(STORE,'files'),{recursive:true});fs.mkdirSync(OUT,{recursive:true});app.setPath('userData',path.join(TEMP,'profile'));app.commandLine.appendSwitch('force-device-scale-factor','2');
const python=process.env.PYTHON||'python3',env={...process.env,PYTHONDONTWRITEBYTECODE:'1'};
const made=spawnSync(python,['-c',`import fitz,json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=fitz.open()
for index in range(2):
 page=d.new_page(width=612,height=792); page.insert_text((40,65),'RETINA PDF / PAGE '+str(index+1),fontsize=24)
 for row in range(36): page.insert_text((40,100+row*17),'Stable page geometry and sharp document text. '+str(row+1),fontsize=11)
 page.draw_rect(fitz.Rect(40,76,572,82),color=(.1,.5,.4),fill=(.1,.5,.4))
(p/'quality-pdf').write_bytes(d.tobytes()); (p/'quality-pdf.meta.json').write_text(json.dumps({'name':'Retina reading.pdf','mimeType':'application/pdf'}))`,path.join(STORE,'files')],{env});
assert.equal(made.status,0,made.stderr.toString());
const original=fs.readFileSync(path.join(STORE,'files','quality-pdf')),checks=[],failures=[],requests=[],rendererErrors=[],externalRequests=[];
let win,backend,proxy,gate=null,failNext=false;const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){for(let n=0;n<250;n++){if(await fn())return;await delay(25);}throw Error('Timeout: '+label);}
async function port(){return new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const value=s.address().port;s.close(()=>resolve(value));});});}
function finish(code){win?.destroy();backend?.kill();proxy?.close();app.exit(code);}
const watchdog=setTimeout(()=>finish(1),90000);
(async()=>{
 const backendPort=await port(),backendOrigin=`http://127.0.0.1:${backendPort}`,log=fs.openSync(path.join(TEMP,'backend.log'),'a');
 backend=spawn(python,[path.join(ROOT,'app/server.py')],{cwd:ROOT,env:{...env,AI_WORKSTATION_PORT:String(backendPort),AI_WORKSTATION_DATA_DIR:STORE},stdio:['ignore',log,log]});
 await until(()=>new Promise(resolve=>http.get(backendOrigin+'/__health',response=>{response.resume();resolve(response.statusCode===200);}).on('error',()=>resolve(false))),'real PDF service');
 const html=`<!doctype html><html lang="en"><head><meta charset="UTF-8"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/pdf-reader.css"><style>body{display:block;padding:20px;margin:0}#host{height:740px;width:320px}*{box-sizing:border-box}</style></head><body><div id="host"></div><script src="/halaska-ui.js"></script><script src="/pdf-reader.js"></script><script>window.notices=[];window.mountReader=()=>{window.reader?.destroy();host.style.width='320px';window.reader=PDFReader.mount(host,{item:{id:'quality-pdf',name:'Retina reading.pdf'},toast:message=>notices.push(message)});};mountReader();</script></body></html>`;
 proxy=http.createServer((request,response)=>{
  if(request.url==='/'){response.writeHead(200,{'Content-Type':'text/html'});response.end(html);return;}
  if(request.url==='/favicon.ico'){response.writeHead(204);response.end();return;}
  const raster=/\/preview\?/.test(request.url),entry=raster?{url:request.url,time:Date.now()}:null;if(entry)requests.push(entry);
  if(raster&&failNext){failNext=false;entry.failure=true;response.writeHead(503);response.end('Intentional refinement failure');return;}
  const hold=raster&&gate&&!gate.captured?gate:null;if(hold){hold.captured=true;entry.held=true;}
  const upstream=http.get(backendOrigin+request.url,res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const deliver=()=>{if(!response.destroyed){response.writeHead(res.statusCode,res.headers);response.end(Buffer.concat(chunks));}};if(hold){hold.deliver=deliver;if(hold.released)deliver();}else deliver();});});upstream.on('error',error=>{if(!response.destroyed){response.writeHead(502);response.end(error.message);}});
 });await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${proxy.address().port}`;
 await app.whenReady();win=new BrowserWindow({show:false,width:1100,height:820,useContentSize:true,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>{if(event.level==='error')rendererErrors.push(event.message);});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(request,done)=>{const external=!request.url.startsWith(origin+'/');if(external)externalRequests.push(request.url);done({cancel:external});});
 const evaluate=code=>win.webContents.executeJavaScript(code,true),ready=(scale,page=1)=>until(()=>evaluate(`reader.getSnapshot().phase==='ready'&&reader.getSnapshot().rasterScale===${scale}&&reader.getSnapshot().page===${page}&&document.querySelector('.pdf-sheet img')?.complete`),`page ${page} scale ${scale}`);
 const snapshot=()=>evaluate(`(()=>{const image=document.querySelector('.pdf-sheet img'),v=document.querySelector('.pdf-viewport');return{...reader.getSnapshot(),src:image?.getAttribute('src'),naturalWidth:image?.naturalWidth,cssWidth:image?.getBoundingClientRect().width,scroll:v?.scrollTop,dpr:devicePixelRatio}})()`);
 const holdNext=()=>{gate={captured:false,released:false,deliver:null};return gate;},release=hold=>{hold.released=true;hold.deliver?.();if(gate===hold)gate=null;};
 async function check(name,fn){try{await fn();checks.push(name);console.log('PASS',name);}catch(error){failures.push({name,error:error.stack});console.error('FAIL',name,error.message);if(gate)release(gate);}}
 await win.loadURL(origin);await ready(1);
 await check('Retina first render requests one real current-page raster at measured density',async()=>{const value=await snapshot();assert.equal(value.dpr,2);assert.equal(value.naturalWidth,612);assert.equal(requests.length,1);assert.match(value.src,/page=1&scale=1&fit=1$/);assert.ok(value.cssWidth>=280&&value.cssWidth<=300,JSON.stringify(value));});
 await check('resize storm requests one sharper raster after settling; readable image and scroll survive swap',async()=>{
  const before=requests.length,hold=holdNext();for(const width of[400,470,550,640]){await evaluate(`host.style.width='${width}px'`);await delay(55);}assert.equal(requests.length,before);
  await until(()=>hold.captured,'settled refinement request');await evaluate(`document.querySelector('.pdf-viewport').scrollTop=130`);const working=await snapshot();assert.equal(working.rasterScale,1);assert.equal(working.pendingScale,2);assert.equal(working.scroll,130);assert.equal(working.naturalWidth,612);
  release(hold);await ready(2);const value=await snapshot();assert.equal(requests.length,before+1);assert.equal(value.naturalWidth,1224);assert.equal(value.scroll,130);assert.equal(value.cssWidth,working.cssWidth);fs.writeFileSync(path.join(OUT,'retina-real-pdf.png'),(await win.webContents.capturePage()).toPNG());
 });
 await check('retained quality avoids downscale/resize loops and respects the backend ceiling',async()=>{const before=requests.length;await evaluate(`host.style.width='340px'`);await delay(250);await evaluate(`host.style.width='950px'`);await delay(300);assert.equal(requests.length,before);assert.equal((await snapshot()).rasterScale,2);});
 await check('failed sharper render preserves working pixels and scroll until explicit real-toolbar retry',async()=>{
  await evaluate('mountReader()');await ready(1);const before=requests.length;failNext=true;await evaluate(`host.style.width='640px'`);await delay(90);await evaluate(`document.querySelector('.pdf-viewport').scrollTop=130`);
  await until(()=>evaluate(`!!document.querySelector('[data-pdf-retry]')`),'refinement retry');let value=await snapshot();assert.equal(value.phase,'ready');assert.equal(value.rasterScale,1);assert.equal(value.naturalWidth,612);assert.equal(value.scroll,130);await delay(400);assert.equal(requests.length,before+1);
  await evaluate(`document.querySelector('[data-pdf-retry]').click()`);await ready(2);value=await snapshot();assert.equal(value.scroll,130);assert.equal(value.naturalWidth,1224);assert.equal(requests.length,before+2);
 });
 await check('page flip cancels a delayed sharper response without replacing the new page',async()=>{
  await evaluate('mountReader()');await ready(1);const hold=holdNext();await evaluate(`host.style.width='640px'`);await until(()=>hold.captured,'held page 1 refinement');await evaluate('reader.setPage(2)');await ready(2,2);release(hold);await delay(250);const value=await snapshot();assert.equal(value.page,2);assert.match(value.src,/page=2&scale=2&fit=1$/);assert.equal(value.naturalWidth,1224);
 });
 await check('destroy cancels in-flight refinement and leaves no image or follow-up requests',async()=>{
  await evaluate('mountReader()');await ready(1);const hold=holdNext();await evaluate(`host.style.width='640px'`);await until(()=>hold.captured,'held destroy refinement');await evaluate('reader.destroy()');const before=requests.length;release(hold);await delay(300);assert.equal(await evaluate('host.childElementCount'),0);assert.equal(requests.length,before);
 });
 await check('all requests remain bounded and local; original PDF bytes are intact',async()=>{
  for(const request of requests){const url=new URL(request.url,origin);assert.ok(Number(url.searchParams.get('scale'))>=.5&&Number(url.searchParams.get('scale'))<=2);assert.ok(['1','2'].includes(url.searchParams.get('page')));}
  assert.deepEqual(fs.readFileSync(path.join(STORE,'files','quality-pdf')),original);assert.deepEqual(externalRequests,[]);assert.equal(requests.filter(request=>request.failure).length,1);assert.deepEqual(rendererErrors.filter(message=>!/503/.test(message)),[]);
 });
 const report={passed:checks.length,checks,failures,requests,rendererErrors,externalRequests,modelCalls:0,workspace:TEMP,scope:'Production PDFReader and real local PyMuPDF images in isolated Electron at DPR 2; not native WKWebView acceptance.'};fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));clearTimeout(watchdog);finish(failures.length?1:0);
})().catch(error=>{console.error(error);clearTimeout(watchdog);finish(1);});
