/* Production PDF service + renderer. Synthetic PDFs/state only; no native AX claim.
 * Clipboard is an explicit writeText capture, not the macOS system clipboard. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), net = require('node:net'), assert = require('node:assert/strict'), { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..'), TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-pdf-text-')), STORE = path.join(TEMP, 'store'), OUT = path.join(ROOT, 'test-results/pdf-text-layer-20260929');
fs.mkdirSync(path.join(STORE, 'files'), { recursive: true }); fs.mkdirSync(OUT, { recursive: true }); app.setPath('userData', path.join(TEMP, 'profile'));
const made = spawnSync(process.env.PYTHON || 'python3', ['-c', `import fitz,json,sys,math
from pathlib import Path
p=Path(sys.argv[1]); expected={}
def save(document,id):
 (p/id).write_bytes(document.tobytes()); (p/(id+'.meta.json')).write_text(json.dumps({'name':id+'.pdf','mimeType':'application/pdf'}))
with fitz.open() as d:
 for angle in (0,90,180,270):
  page=d.new_page(width=400,height=300)
  page.insert_text((100,100),'Rotation'+str(angle)+' selectable',fontsize=16)
  page.insert_text((100,135),'Next line',fontsize=16)
  page.insert_text((5,15),'OUTSIDE_CROP',fontsize=8)
  page.set_cropbox(fitz.Rect(50,30,350,230));page.set_rotation(angle)
  words=[]
  for x0,y0,x1,y1,text,block,line,_ in page.get_text('words'):
   points=[fitz.Point(x,y)*page.rotation_matrix for x,y in ((x0,y0),(x1,y0),(x1,y1),(x0,y1))]
   words.append({'text':text,'box':[min(q.x for q in points),min(q.y for q in points),max(q.x for q in points),max(q.y for q in points)],'line':str(block)+':'+str(line)})
  expected[str(len(d))]={'width':page.rect.width,'height':page.rect.height,'rotation':angle,'words':words}
 with fitz.open() as scanned:
  page=scanned.new_page(width=300,height=200);page.insert_text((30,40),'Raster words are not selectable',fontsize=14)
  raster=page.get_pixmap().tobytes('png')
 d.new_page(width=300,height=200).insert_image(fitz.Rect(0,0,300,200),stream=raster)
 d.new_page(width=300,height=200)
 page=d.new_page(width=300,height=200);page.insert_text((30,40),'Allowed horizontal',fontsize=12);page.insert_text((150,150),'ROTATED',rotate=90,fontsize=12)
 page=d.new_page(width=300,height=200);page.insert_text((150,150),'ROTATED',rotate=90,fontsize=12)
 save(d,'text-cases')
with fitz.open() as d:
 for index in range(2):
  page=d.new_page(width=1200,height=1800)
  page.insert_text((60,70),'Tall page '+str(index+1)+' selection',fontsize=30)
  for row in range(45):page.insert_text((60,130+row*33),'Stable reading position and selectable document text '+str(row),fontsize=20)
 save(d,'text-tall')
with fitz.open() as d:
 d.new_page(width=300,height=200).insert_text((30,40),'Restricted original remains visible')
 (p/'text-restricted').write_bytes(d.tobytes(encryption=fitz.PDF_ENCRYPT_AES_256,owner_pw='synthetic-owner',user_pw='',permissions=fitz.PDF_PERM_PRINT))
 (p/'text-restricted.meta.json').write_text(json.dumps({'name':'restricted.pdf','mimeType':'application/pdf'}))
(p.parent/'expected.json').write_text(json.dumps(expected))`, path.join(STORE, 'files')]);
assert.equal(made.status, 0, made.stderr.toString());
const expected = JSON.parse(fs.readFileSync(path.join(STORE, 'expected.json'))), originals = Object.fromEntries(fs.readdirSync(path.join(STORE, 'files')).map(name => [name, fs.readFileSync(path.join(STORE, 'files', name))]));
const checks = [], failures = [], measurements = [], rendererErrors = [], externalRequests = [], intentionalNetworkErrors = [];
const rasterFailures = new Set(); let injectedRasterFailures = 0;
let win, server; const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 12000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await delay(40); } throw Error('Timeout: ' + label); }
const watchdog = setTimeout(() => { win?.destroy(); server?.kill(); app.exit(1); }, 180000);
(async () => {
 const port = await new Promise(resolve => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); }); });
 const origin = `http://127.0.0.1:${port}`, log = fs.openSync(path.join(TEMP, 'server.log'), 'a');
 server = spawn(process.env.PYTHON || 'python3', [path.join(ROOT, 'app/server.py')], { cwd: ROOT, env: { ...process.env, AI_WORKSTATION_PORT: String(port), AI_WORKSTATION_DATA_DIR: STORE }, stdio: ['ignore', log, log] });
 await until(() => new Promise(resolve => http.get(origin + '/__health', response => { response.resume(); resolve(response.statusCode === 200); }).on('error', () => resolve(false))), 'isolated PDF service'); await app.whenReady();
 win = new BrowserWindow({ show: false, width: 1280, height: 800, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
 win.webContents.on('console-message', event => { if (event.level !== 'error') return; if (injectedRasterFailures && /net::ERR_BLOCKED_BY_CLIENT/.test(event.message)) intentionalNetworkErrors.push(event.message); else rendererErrors.push(event.message); });
 win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => { const external = !request.url.startsWith(origin + '/'); if (external) externalRequests.push(request.url); const fault = rasterFailures.has(new URL(request.url).pathname); if (fault) injectedRasterFailures++; done({ cancel: external || fault }); });
 const evaluate = code => win.webContents.executeJavaScript(code, true), click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
 const screenshot = async name => { await delay(80); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
 async function check(name, fn) { try { await fn(); checks.push(name); console.log('PASS', name); } catch (error) { failures.push({ name, error: error.stack }); console.error('FAIL', name, error.message); await screenshot('failure-' + name.replace(/[^a-z0-9]+/gi, '-').slice(0, 90)); } }
 const readyImage = page => until(() => evaluate(`(()=>{const image=document.querySelector('.pdf-sheet img');return image?.complete&&image.naturalWidth>0&&Number(document.querySelector('[data-pdf-page]')?.value)===${page}})()`), 'image page ' + page);
 const textStatus = status => until(() => evaluate(`document.querySelector('[data-pdf-text-status]')?.getAttribute('data-pdf-text-status')===${JSON.stringify(status)}`), 'text status ' + status);
 const ready = async (page, status = 'ready') => { await readyImage(page); await textStatus(status); };
 const turn = async page => {
  await evaluate(`(()=>{const input=document.querySelector('[data-pdf-page]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(String(page))});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await evaluate(`document.querySelector('[data-pdf-page]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
 };
 const open = async (id, page = 1, status = 'ready') => { await evaluate(`openImport(${JSON.stringify(id)},${page})`); await ready(page, status); };
 const measureGeometry = page => evaluate(`(()=>{
  const expected=${JSON.stringify(expected[String(page)])},image=document.querySelector('.pdf-sheet img'),layer=document.querySelector('.pdf-text-layer'),ir=image.getBoundingClientRect(),lr=layer.getBoundingClientRect(),scale=ir.width/expected.width;
  const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
  const rectangle=r=>({left:r.left,top:r.top,width:r.width,height:r.height,right:r.right,bottom:r.bottom});
  const words=[...layer.querySelectorAll('.pdf-text-word')].map((span,index)=>{
   const word=expected.words[index],range=document.createRange();range.setStart(span.firstChild,0);range.setEnd(span.firstChild,word.text.length);const rangeRect=range.getBoundingClientRect();
   const [x0,y0,x1,y1]=word.box,nx=canvas.width/expected.width,ny=canvas.height/expected.height;
   let ink=0,covered=0;for(let y=Math.max(0,Math.floor(y0*ny));y<Math.min(canvas.height,Math.ceil(y1*ny));y++)for(let x=Math.max(0,Math.floor(x0*nx));x<Math.min(canvas.width,Math.ceil(x1*nx));x++){
    const at=(y*canvas.width+x)*4;if(Math.min(pixels[at],pixels[at+1],pixels[at+2])<180){ink++;const sx=ir.left+(x+.5)*ir.width/canvas.width,sy=ir.top+(y+.5)*ir.height/canvas.height;if(sx>=rangeRect.left-1&&sx<=rangeRect.right+1&&sy>=rangeRect.top-1&&sy<=rangeRect.bottom+1)covered++;}
   }
   return{text:span.textContent.trim(),range:rectangle(rangeRect),expected:{left:ir.left+x0*scale,top:ir.top+y0*scale,width:(x1-x0)*scale,height:(y1-y0)*scale},ink,covered,coverage:ink?covered/ink:0,transform:span.style.transform};
  });
  return{page:${page},rotation:expected.rotation,image:rectangle(ir),layer:rectangle(lr),natural:{width:image.naturalWidth,height:image.naturalHeight},scale,layerScale:new DOMMatrix(getComputedStyle(layer).transform).a,words,textLayerCount:document.querySelectorAll('.pdf-text-layer').length,overflow:document.documentElement.scrollWidth>innerWidth,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio}};
 })()`);
 function assertGeometry(value) {
  assert.equal(value.textLayerCount, 1); assert.equal(value.words.length, 4); assert.equal(value.overflow, false);
  for (const key of ['left', 'top', 'width', 'height']) assert.ok(Math.abs(value.layer[key] - value.image[key]) <= 1.2, 'layer/image ' + key + ': ' + JSON.stringify(value));
  assert.ok(Math.abs(value.layerScale - value.scale) < .0001);
  for (const word of value.words) { assert.ok(word.ink >= 20, JSON.stringify(word)); assert.ok(word.coverage >= .84, JSON.stringify(word));
   const horizontal=value.rotation%180===0,axis=horizontal?'width':'height';assert.ok(Math.abs(word.range[axis]-word.expected[axis])<=2.5,JSON.stringify(word));
  }
 }
 await win.loadURL(origin); await until(() => evaluate(`typeof storageHydrated!=='undefined'&&storageHydrated`), 'workspace hydrate');
 await evaluate(`WorkstationOnboarding.close();state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};` + fs.readFileSync(path.join(ROOT, 'tests/fixtures/agent-workbench.js'), 'utf8'));
 await evaluate(`(()=>{
  state.projects=[{id:'text-project',name:'PDF 原文验收',workspace:'科研'}];currentConversation().projectId='text-project';
  state.imports=['text-cases','text-tall','text-restricted'].map(id=>({id,name:id+'.pdf',mimeType:'application/pdf',content:'Synthetic PDF index.',workspace:'科研',projectId:'text-project'}));state.ui.inspectorOpen=false;state.settings.reduceMotion=true;applyUiPreferences();
  const style=document.createElement('style');style.textContent=${JSON.stringify(fs.readFileSync(path.join(ROOT, 'native/Resources/workspace.css'), 'utf8'))};document.head.append(style);document.body.classList.add('aibro-native');renderAll();WorkspaceLayout.refresh();
  window.__clipboardWrites=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__clipboardWrites.push(text);}}});
  window.__textRequests=[];window.__textFailures=new Set();window.__textHold=new Set();window.__textGates={};
  const original=window.fetch.bind(window);window.fetch=async(input,init={})=>{const url=new URL(typeof input==='string'?input:input.url,location.href);if(!url.pathname.endsWith('/preview-text'))return original(input,init);const key=url.pathname+url.search;const record={key,aborted:!!init.signal?.aborted};window.__textRequests.push(record);init.signal?.addEventListener('abort',()=>{record.aborted=true;},{once:true});if(window.__textFailures.has(key))return new Response(JSON.stringify({code:'SYNTHETIC_TEXT_FAILURE',error:'Synthetic text service failure'}),{status:503,headers:{'Content-Type':'application/json'}});if(window.__textHold.has(key)){const response=await original(input,{...init,signal:undefined}),body=await response.text();return new Promise(resolve=>{window.__textGates[key]=()=>resolve(new Response(body,{status:response.status,headers:{'Content-Type':'application/json'}}));});}return original(input,init);};
 })()`);
 for (const page of [1, 2, 3, 4]) await check(`crop and rotation ${expected[String(page)].rotation} align real DOM selection with raster ink`, async () => {
  await open('text-cases', page); await click('[data-pdf-fit-page]'); await delay(100);const value=await measureGeometry(page);measurements.push(value);assertGeometry(value);
  const selection=await evaluate(`(()=>{const words=[...document.querySelectorAll('.pdf-text-word')],range=document.createRange();range.setStart(words[0].firstChild,0);range.setEnd(words.at(-1).firstChild,words.at(-1).textContent.trimEnd().length);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return selection.toString();})()`);
  assert.ok(selection.includes(`Rotation${expected[String(page)].rotation} selectable`));assert.ok(selection.includes('Next line'));assert.ok(!selection.includes('OUTSIDE_CROP'));
  await screenshot(`rotation-${expected[String(page)].rotation}-selected`);
 });
 await check('real mouse drag selects the visible original PDF words', async () => {
  await open('text-cases',1);await click('[data-pdf-fit-page]');await delay(100);
  if(!win.webContents.debugger.isAttached())win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  const diagnostics=[];
  async function drag(selector,label){
   const points=await evaluate(`(()=>{getSelection().removeAllRanges();const words=[...document.querySelectorAll(${JSON.stringify(selector)})];const rect=span=>{const r=document.createRange();r.setStart(span.firstChild,0);r.setEnd(span.firstChild,span.textContent.trimEnd().length);return r.getBoundingClientRect()};const a=rect(words[0]),b=rect(words.at(-1));return{x1:Math.ceil(a.left+1),x2:Math.floor(b.right-1),y:Math.round((a.top+a.bottom)/2)}})()`);
   await evaluate(`window.__mouseTrace=[];if(!window.__mouseTraceInstalled){window.__mouseTraceInstalled=true;for(const kind of ['mousedown','mousemove','mouseup','selectstart','selectionchange'])document.addEventListener(kind,event=>queueMicrotask(()=>{const s=getSelection();window.__mouseTrace.push({type:event.type,trusted:event.isTrusted,target:event.target.className||event.target.parentElement?.className,buttons:event.buttons,defaultPrevented:event.defaultPrevented,focus:document.hasFocus(),selection:s.toString(),anchor:s.anchorNode?.parentElement?.className,anchorOffset:s.anchorOffset,focusNode:s.focusNode?.parentElement?.className,focusOffset:s.focusOffset})}),{capture:true})}`);
   const before=await evaluate(`(()=>{const hit=document.elementFromPoint(${points.x1},${points.y});return{focused:document.hasFocus(),hit:hit?.className,ancestors:[...function*(n){while(n){yield n;n=n.parentElement}}(hit)].map(el=>({tag:el.tagName,id:el.id,cls:el.className,draggable:el.draggable,editable:el.isContentEditable,userSelect:getComputedStyle(el).userSelect,webkitUserSelect:getComputedStyle(el).webkitUserSelect,appRegion:getComputedStyle(el).webkitAppRegion}))}})()`);
   await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:points.x1,y:points.y});
   await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,x:points.x1,y:points.y});
   const press=await evaluate(`(()=>{const s=getSelection();return{text:s.toString(),anchor:s.anchorNode?.parentElement?.className,anchorOffset:s.anchorOffset,focus:s.focusNode?.parentElement?.className,focusOffset:s.focusOffset}})()`);
   for(let step=1;step<=6;step++){await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:Math.round(points.x1+(points.x2-points.x1)*step/6),y:points.y});await delay(20);}
   await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:points.x2,y:points.y});await delay(60);
   const selected=await evaluate(`getSelection().toString()`),events=await evaluate(`window.__mouseTrace`);const result={label,points,selected,events,before,press};diagnostics.push(result);return result;
  }
  const actual=await drag('.pdf-text-word:nth-child(-n+2)','actual PDF');
  if(!actual.selected.includes('Rotation0 selectable')){
   await evaluate(`(()=>{const d=document.createElement('div');d.id='mouse-control';d.style.cssText='position:fixed;top:70px;left:50px;background:white;color:black;z-index:99999;padding:8px;user-select:text;font:20px sans-serif';d.innerHTML='<span class="ordinary-control">Ordinary control selectable</span>';document.body.append(d)})()`);
   await drag('.ordinary-control','ordinary opaque text');
   await evaluate(`document.querySelector('.ordinary-control').style.color='transparent'`);await drag('.ordinary-control','ordinary transparent text');
   await evaluate(`document.querySelector('.ordinary-control').style.cssText='position:absolute;top:0;left:0;color:transparent;white-space:pre;user-select:text'`);await drag('.ordinary-control','absolute transparent text');
   await evaluate(`document.querySelector('#mouse-control').remove()`);
  }
  measurements.push({case:'real-mouse-selection',diagnostics,focusEmulation:true});
  fs.writeFileSync(path.join(OUT,'mouse-diagnostics.json'),JSON.stringify(diagnostics,null,2));
  assert.ok(actual.events.some(event=>event.type==='mousedown'&&event.trusted));assert.ok(actual.selected.includes('Rotation0 selectable'),JSON.stringify(diagnostics));await screenshot('mouse-drag-selection');
  // The same real selection offers explain / translate / ask, and the request
  // names this PDF and page. The transport is a local fake: nothing leaves.
  await until(()=>evaluate(`!document.querySelector('#selectionBar').hidden`),'selection toolbar for PDF text');
  const buttons=await evaluate(`[...document.querySelectorAll('#selectionBar button')].map(b=>b.textContent)`);
  assert.deepEqual(buttons.filter(name=>['解释','翻译','批注','问 AI'].includes(name)),['解释','翻译','批注','问 AI']);
  const request=await evaluate(`(async()=>{let captured=null;const transport=AgentTransport.requestPlan;AgentTransport.requestPlan=async options=>{captured=options.input;return '合成译文';};
   const resolve=ConversationModels.resolve;ConversationModels.resolve=async()=>({provider:'local-fake',model:'fake'});
   try{document.querySelector('#selectionBar [data-selection-mode="translate"]').click();for(let i=0;i<50&&!captured;i++)await new Promise(r=>setTimeout(r,20));}
   finally{AgentTransport.requestPlan=transport;ConversationModels.resolve=resolve;}
   return {rules:captured?.[0]?.content?.[0]?.text||'',user:captured?.[1]?.content?.[0]?.text||'',title:document.querySelector('#selectionTitle')?.textContent||''};})()`);
  assert.match(request.rules,/翻译选中片段/);assert.match(request.rules,/第 1 页/);assert.match(request.user,/Rotation0 selectable/);assert.match(request.title,/翻译/);
  // The finished translation can be kept as a new note naming this PDF and page.
  await until(()=>evaluate(`!document.querySelector('#selectionSave').hidden&&!document.querySelector('#selectionSave').disabled`),'save-as-note enabled');
  const notesBefore=await evaluate(`state.notes.length`);
  await evaluate(`document.querySelector('#selectionSave').click()`);
  await until(()=>evaluate(`state.notes.length===${notesBefore}+1&&document.querySelector('#selectionPanel').hidden`),'note saved');
  const saved=await evaluate(`(()=>{const n=state.notes.at(-1);return{kind:n.kind,title:n.title,content:n.content,sources:n.sourceAttachmentIds,page:n.sourcePage,projectId:n.projectId,preview:state.previewRecord}})()`);
  assert.equal(saved.kind,'阅读笔记');assert.match(saved.title,/^翻译：Rotation0 selectable/);assert.match(saved.content,/^> 摘自《text-cases\.pdf》第 1 页/);assert.match(saved.content,/## 翻译\n\n合成译文/);
  assert.deepEqual(saved.sources,['text-cases']);assert.equal(saved.page,1);assert.equal(saved.projectId,'text-project');assert.equal(saved.preview?.type,'note',JSON.stringify(saved));
  measurements.push({case:'selection-save-note',saved});await screenshot('selection-saved-note');
  await open('text-cases',1);
  // Private mode: the same selection is not offered to a model.
  await evaluate(`(()=>{window.__privateOn=PrivateMode.isOn;PrivateMode.isOn=()=>true;document.dispatchEvent(new Event('selectionchange'))})()`);await delay(60);
  assert.equal(await evaluate(`document.querySelector('#selectionBar').hidden`),true,'private mode hides selection actions on PDF text');
  await evaluate(`PrivateMode.isOn=window.__privateOn;getSelection().removeAllRanges()`);
 });
 await check('copy-page Kit action passes actual extracted page text to clipboard writeText', async () => {
  await open('text-cases', 1);await click('[data-pdf-copy]');await until(()=>evaluate(`window.__clipboardWrites.length===1`),'copy callback');
  assert.equal(await evaluate(`window.__clipboardWrites[0]`),'Rotation0 selectable\nNext line');
 });
 await check('ask-page references this PDF in the conversation beside the reader and quotes the page', async () => {
  await open('text-cases', 2);await evaluate(`(()=>{const input=document.querySelector('#agentInput');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const before=await evaluate(`({view:document.body.dataset.view,refs:(currentConversation().draftFileReferences||[]).length,label:document.querySelector('[data-pdf-ask]')?.getAttribute('aria-label')})`);
  assert.equal(before.label,'问 AI 第 2 页',JSON.stringify(before));
  await click('[data-pdf-ask]');
  if(before.view!=='agent'){await until(()=>evaluate(`!!document.querySelector('[role="menu"] [role="menuitem"]')`),'conversation chooser');await evaluate(`document.querySelector('[role="menu"] [role="menuitem"]').click()`);}
  await until(()=>evaluate(`document.querySelector('#agentInput').value.includes('第 2 页')`),'page quote in composer');
  const after=await evaluate(`({value:document.querySelector('#agentInput').value,refs:(currentConversation().draftFileReferences||[]).map(r=>r.type+':'+r.id),focused:document.activeElement?.id})`);
  assert.equal(after.value,'关于《text-cases.pdf》第 2 页：');assert.ok(after.refs.includes('import:text-cases'),JSON.stringify(after));assert.equal(after.focused,'agentInput');
  measurements.push({case:'ask-page',before,after});await screenshot('ask-page-staged');
  await evaluate(`(()=>{const input=document.querySelector('#agentInput');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 });
 await check('region drag crops the page image and stages it with the PDF in the conversation', async () => {
  await open('text-cases', 1);await evaluate(`(()=>{const input=document.querySelector('#agentInput');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const importsBefore=await evaluate(`state.imports.length`);
  await click('[data-pdf-region]');await until(()=>evaluate(`!!document.querySelector('.pdf-region-layer')`),'region layer');
  assert.equal(await evaluate(`document.querySelector('[data-pdf-region]').getAttribute('aria-pressed')`),'true');
  // Escape cancels without staging anything; a second press starts again.
  await evaluate(`document.querySelector('.pdf-region-layer').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await until(()=>evaluate(`!document.querySelector('.pdf-region-layer')`),'region cancelled');
  await click('[data-pdf-region]');await until(()=>evaluate(`!!document.querySelector('.pdf-region-layer')`),'region layer again');
  const box=await evaluate(`(()=>{const r=document.querySelector('.pdf-sheet img').getBoundingClientRect();return{x1:Math.round(r.left+r.width*.1),y1:Math.round(r.top+r.height*.1),x2:Math.round(r.left+r.width*.6),y2:Math.round(r.top+r.height*.4),width:r.width,natural:document.querySelector('.pdf-sheet img').naturalWidth}})()`);
  if(!win.webContents.debugger.isAttached())win.webContents.debugger.attach('1.3');
  const mouse=(type,x,y,buttons)=>win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x,y,button:'left',buttons,clickCount:1});
  await mouse('mouseMoved',box.x1,box.y1,0);await mouse('mousePressed',box.x1,box.y1,1);
  for(let step=1;step<=5;step++){await mouse('mouseMoved',Math.round(box.x1+(box.x2-box.x1)*step/5),Math.round(box.y1+(box.y2-box.y1)*step/5),1);await delay(16);}
  await screenshot('region-drag');
  await mouse('mouseReleased',box.x2,box.y2,0);
  await until(()=>evaluate(`document.querySelector('#agentInput').value.includes('框选的区域')`),'region quote in composer',20000);
  const staged=await evaluate(`(()=>{const c=currentConversation(),ids=c.draftAttachmentIds||[],items=state.imports.filter(i=>ids.includes(i.id));return{value:document.querySelector('#agentInput').value,refs:(c.draftFileReferences||[]).map(r=>r.type+':'+r.id),images:items.filter(i=>/^image[/]/.test(i.mimeType||'')).map(i=>({name:i.name,type:i.mimeType,size:i.size})),chips:[...document.querySelectorAll('#stagedAttachments .staged-chip-name')].map(n=>n.textContent),layer:!!document.querySelector('.pdf-region-layer'),imports:state.imports.length}})()`);
  assert.equal(staged.value,'关于《text-cases.pdf》第 1 页框选的区域：',JSON.stringify(staged));
  assert.ok(staged.refs.includes('import:text-cases'),JSON.stringify(staged));
  assert.equal(staged.images.length,1,JSON.stringify(staged));assert.equal(staged.images[0].type,'image/png');assert.match(staged.images[0].name,/text-cases-第1页-框选\.png/);
  assert.ok(staged.chips.some(name=>/框选\.png/.test(name)),JSON.stringify(staged));assert.equal(staged.layer,false);assert.equal(staged.imports,importsBefore+1);
  const crop=await evaluate(`(async()=>{const item=state.imports.find(i=>/框选\.png$/.test(i.name));const blob=await (await fetch('/__files/'+encodeURIComponent(item.id))).blob();const bitmap=await createImageBitmap(blob);return{width:bitmap.width,height:bitmap.height}})()`);
  // Cropped from the 2x render: 2 px per PDF point (the page is 300 pt wide at 754 css px here).
  const page={width:expected["1"].width},expectedWidth=Math.round((box.x2-box.x1)/box.width*page.width*2);
  assert.ok(Math.abs(crop.width-expectedWidth)<=3,JSON.stringify({crop,expectedWidth,box}));
  measurements.push({case:'region-ask',box,staged,crop});await screenshot('region-staged');
  await evaluate(`(()=>{const c=currentConversation();c.draftAttachmentIds=[];c.attachments=[];const input=document.querySelector('#agentInput');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));renderStagedAttachments();})()`);
 });
 await check('fit-width, zoom and sharper raster keep the same text nodes and browser Range', async () => {
  await open('text-tall',1);await click('[data-pdf-fit-page]');await delay(100);
  const initial=await evaluate(`(()=>{const layer=document.querySelector('.pdf-text-layer'),span=layer.firstChild,range=document.createRange();range.setStart(span.firstChild,0);range.setEnd(span.firstChild,4);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);window.__selectionWitness={layer,span,anchor:selection.anchorNode,focus:selection.focusNode,anchorOffset:selection.anchorOffset,focusOffset:selection.focusOffset,text:selection.toString(),image:document.querySelector('.pdf-sheet img')};return{raster:Number(new URL(__selectionWitness.image.src).searchParams.get('scale')),text:selection.toString(),width:__selectionWitness.image.getBoundingClientRect().width};})()`);
  assert.equal(initial.text,'Tall');await click('[data-pdf-fit-width]');await delay(80);await click('[data-pdf-plus]');await delay(400);
  await until(()=>evaluate(`document.querySelector('.pdf-sheet img').complete&&Number(new URL(document.querySelector('.pdf-sheet img').src).searchParams.get('scale'))>${initial.raster}`),'higher-resolution replacement');
  const stable=await evaluate(`(()=>{const w=__selectionWitness,s=getSelection(),image=document.querySelector('.pdf-sheet img');return{sameLayer:w.layer===document.querySelector('.pdf-text-layer'),sameSpan:w.span===document.querySelector('.pdf-text-word'),sameAnchor:w.anchor===s.anchorNode,sameFocus:w.focus===s.focusNode,sameOffsets:w.anchorOffset===s.anchorOffset&&w.focusOffset===s.focusOffset,text:s.toString(),imageChanged:w.image!==image,raster:Number(new URL(image.src).searchParams.get('scale')),width:image.getBoundingClientRect().width};})()`);
  measurements.push({case:'selection-after-raster',initial,...stable});for(const key of ['sameLayer','sameSpan','sameAnchor','sameFocus','sameOffsets','imageChanged'])assert.equal(stable[key],true,key);assert.equal(stable.text,'Tall');assert.ok(stable.width>initial.width);await screenshot('zoom-refined-selection-stable');
 });
 await check('page navigation restores reading position and only the current page text layer', async () => {
  await open('text-tall',1);await click('[data-pdf-fit-width]');await delay(80);
  const initial=await evaluate(`(()=>{const v=document.querySelector('.pdf-viewport');v.scrollTop=330;return{top:v.scrollTop,ratio:v.scrollTop/parseFloat(document.querySelector('.pdf-sheet img').style.height)}})()`);assert.ok(initial.top>=250,JSON.stringify(initial));
  await click('[data-pdf-next]');await ready(2);assert.ok((await evaluate(`document.querySelector('.pdf-text-layer').textContent`)).includes('Tall page 2'));assert.equal(await evaluate(`document.querySelector('.pdf-viewport').scrollTop`),0);
  await click('[data-pdf-prev]');await ready(1);await delay(100);const restored=await evaluate(`document.querySelector('.pdf-viewport').scrollTop/parseFloat(document.querySelector('.pdf-sheet img').style.height)`);assert.ok(Math.abs(restored-initial.ratio)<.003,JSON.stringify({initial,restored}));assert.equal(await evaluate(`document.querySelectorAll('.pdf-text-layer').length`),1);await screenshot('reading-position-restored');
 });
 await check('reader expansion, viewport resize and split restore the normalized reading position', async () => {
  await open('text-tall',1);await click('[data-pdf-fit-width]');await delay(80);
  const position=()=>evaluate(`(()=>{const v=document.querySelector('.pdf-viewport'),image=document.querySelector('.pdf-sheet img');return{top:v.scrollTop,height:parseFloat(image.style.height),ratio:v.scrollTop/parseFloat(image.style.height),sameText:window.__positionLayer===document.querySelector('.pdf-text-layer'),expanded:document.body.classList.contains('reading-expanded')}})()`);
  await evaluate(`window.__positionLayer=document.querySelector('.pdf-text-layer');document.querySelector('.pdf-viewport').scrollTop=280`);const before=await position();assert.ok(before.top>200);
  await click('[data-pdf-fullscreen]');await delay(250);const expanded=await position();assert.equal(expanded.expanded,true);assert.equal(expanded.sameText,true);assert.ok(Math.abs(expanded.ratio-before.ratio)<.004,JSON.stringify({before,expanded}));
  win.setContentSize(1440,850);await delay(250);const resized=await position();assert.equal(resized.sameText,true);assert.ok(Math.abs(resized.ratio-before.ratio)<.004,JSON.stringify({before,resized}));
  await click('[data-pdf-fullscreen]');await delay(250);const split=await position();assert.equal(split.expanded,false);assert.equal(split.sameText,true);assert.ok(Math.abs(split.ratio-before.ratio)<.004,JSON.stringify({before,split}));measurements.push({case:'normalized-position-layout-changes',before,expanded,resized,split});await screenshot('expanded-resized-position-restored');
  win.setContentSize(1280,800);await delay(100);
 });
 await check('late text response from an aborted previous page cannot replace current text', async () => {
  const key='/__files/text-cases/preview-text?page=1';await evaluate(`window.__textHold.add(${JSON.stringify(key)});openImport('text-cases',1)`);await readyImage(1);await until(()=>evaluate(`!!window.__textGates[${JSON.stringify(key)}]`),'held text response');
  assert.equal(await evaluate(`document.querySelectorAll('.pdf-text-word').length`),0);await click('[data-pdf-next]');await ready(2);const before=await evaluate(`document.querySelector('.pdf-text-layer').textContent`);
  await evaluate(`window.__textGates[${JSON.stringify(key)}]();window.__textHold.delete(${JSON.stringify(key)})`);await delay(150);assert.equal(await evaluate(`document.querySelector('.pdf-text-layer').textContent`),before);assert.ok(before.includes('Rotation90'));assert.equal(await evaluate(`document.querySelectorAll('.pdf-text-layer').length`),1);assert.equal(await evaluate(`window.__textRequests.filter(item=>item.key===${JSON.stringify(key)}).at(-1).aborted`),true);
 });
 await check('late text from a destroyed document cannot alter its replacement reader', async () => {
  const key='/__files/text-cases/preview-text?page=4';await evaluate(`window.__textHold.add(${JSON.stringify(key)});openImport('text-cases',4)`);await readyImage(4);await until(()=>evaluate(`!!window.__textGates[${JSON.stringify(key)}]`),'held old-document text');
  await open('text-tall',1);const before=await evaluate(`window.__replacementText=document.querySelector('.pdf-text-layer');window.__replacementText.textContent`);
  await evaluate(`window.__textGates[${JSON.stringify(key)}]();window.__textHold.delete(${JSON.stringify(key)})`);await delay(120);assert.equal(await evaluate(`document.querySelector('.pdf-text-layer')===window.__replacementText`),true);assert.equal(await evaluate(`document.querySelector('.pdf-text-layer').textContent`),before);assert.ok(before.includes('Tall page 1'));assert.equal(await evaluate(`document.querySelectorAll('.pdf-text-layer').length`),1);
  await open('text-cases',1);
 });
 await check('late successful text stays hidden after raster failure and retry restores both', async () => {
  const key='/__files/text-cases/preview-text?page=2',rasterPath='/__files/text-cases/preview';rasterFailures.add(rasterPath);
  try{
   await evaluate(`window.__textHold.add(${JSON.stringify(key)});openImport('text-cases',2)`);await until(()=>evaluate(`document.querySelector('.pdf-page-status')?.getAttribute('role')==='alert'`),'intentional initial raster failure');await until(()=>evaluate(`!!window.__textGates[${JSON.stringify(key)}]`),'late text after raster failure');
   await evaluate(`window.__textGates[${JSON.stringify(key)}]();window.__textHold.delete(${JSON.stringify(key)})`);await textStatus('page-error');
   const hidden=await evaluate(`(()=>{const layer=document.querySelector('.pdf-text-layer');return{exists:!!layer,hidden:layer?.hidden,display:layer?getComputedStyle(layer).display:null,copyDisabled:document.querySelector('[data-pdf-copy]').disabled,rasterCount:document.querySelectorAll('.pdf-sheet img').length}})()`);measurements.push({case:'text-after-raster-failure',...hidden});assert.equal(hidden.exists,true);assert.equal(hidden.hidden,true);assert.equal(hidden.display,'none');assert.equal(hidden.copyDisabled,true);assert.equal(hidden.rasterCount,0);await screenshot('late-text-raster-failed');
  }finally{rasterFailures.delete(rasterPath);await evaluate(`window.__textHold.delete(${JSON.stringify(key)})`);}
  await click('[data-pdf-retry]');await ready(2);assert.equal(await evaluate(`document.querySelector('.pdf-text-layer').hidden`),false);await screenshot('raster-and-text-retry-restored');
 });
 await check('scan and blank pages retain raster and disable copy without invented text', async () => {
  for(const page of [5,6]){await turn(page);await ready(page,'empty');assert.equal(await evaluate(`document.querySelectorAll('.pdf-text-word').length`),0);assert.equal(await evaluate(`document.querySelector('[data-pdf-copy]').disabled`),true);await screenshot(page===5?'scan-page':'blank-page');}
 });
 await check('unsupported directions disclose partial extraction and copy only supported text', async () => {
  await turn(7);await ready(7,'partial');assert.equal(await evaluate(`document.querySelectorAll('.pdf-text-word').length`),2);await click('[data-pdf-copy]');assert.equal(await evaluate(`window.__clipboardWrites.at(-1)`),'Allowed horizontal');await screenshot('partial-text');
  await turn(8);await ready(8,'unsupported');assert.equal(await evaluate(`document.querySelectorAll('.pdf-text-word').length`),0);assert.equal(await evaluate(`document.querySelector('[data-pdf-copy]').disabled`),true);
 });
 await check('copy-restricted PDF remains readable with an explicit disabled copy state', async () => {
  await open('text-restricted',1,'restricted');assert.equal(await evaluate(`document.querySelectorAll('.pdf-text-word').length`),0);assert.equal(await evaluate(`document.querySelector('[data-pdf-copy]').disabled`),true);await screenshot('copy-restricted');
 });
 await check('text service failure keeps the rendered page and retry restores selectable text', async () => {
  const key='/__files/text-cases/preview-text?page=3';await evaluate(`window.__textFailures.add(${JSON.stringify(key)});openImport('text-cases',3)`);await ready(3,'error');assert.equal(await evaluate(`document.querySelector('[data-pdf-copy]').disabled`),true);const image=await evaluate(`window.__failedTextImage=document.querySelector('.pdf-sheet img');window.__failedTextImage.src`);await screenshot('text-failure-image-preserved');
  await evaluate(`window.__textFailures.delete(${JSON.stringify(key)})`);await click('[data-pdf-text-retry]');await ready(3);assert.equal(await evaluate(`window.__failedTextImage===document.querySelector('.pdf-sheet img')`),true);assert.equal(await evaluate(`document.querySelector('.pdf-sheet img').src`),image);
 });
 await check('dark and narrow layouts bound the raster/text canvas without page overflow', async () => {
  await evaluate(`state.ui.theme='dark';applyUiPreferences();ReadingPane.setExpanded(true)`);
  for(const width of [440,360]){win.setContentSize(width,720);await delay(150);await click('[data-pdf-fit-page]');await delay(80);const value=await measureGeometry(3);measurements.push({case:'dark-narrow-'+width,...value});assertGeometry(value);const bounds=await evaluate(`(()=>{const v=document.querySelector('.pdf-viewport'),t=document.querySelector('.pdf-reader-toolbar');return{viewport:v.clientWidth,scroll:v.scrollWidth,toolbar:t.clientWidth,toolbarScroll:t.scrollWidth,copyWidth:document.querySelector('[data-pdf-copy]').getBoundingClientRect().width}})()`);assert.ok(bounds.scroll<=bounds.viewport+1,JSON.stringify(bounds));assert.ok(bounds.toolbarScroll<=bounds.toolbar+1,JSON.stringify(bounds));assert.ok(bounds.copyWidth>15);await screenshot('dark-narrow-'+width);}
 });
 await check('PDF bytes are unchanged and only local synthetic resources were requested', async () => {
  for(const [name,bytes] of Object.entries(originals))assert.deepEqual(fs.readFileSync(path.join(STORE,'files',name)),bytes,name);assert.deepEqual(externalRequests,[]);assert.deepEqual(rendererErrors,[]);
 });
 const report={passed:checks.length,checks,failures,measurements,rendererErrors,externalRequests,intentionalNetworkErrors,injectedRasterFailures,clipboard:'Captured the real Kit copy action calling navigator.clipboard.writeText; system clipboard was not touched.',faultInjection:'Only explicit text response delay/503 and one blocked initial raster were injected; normal text, metadata, PDF bytes and rasters came from the production local server.',mouseInput:'Trusted Chromium Input.dispatchMouseEvent with focus emulation in a hidden Electron renderer; no native UI automation.',scope:'Electron production-renderer acceptance with native CSS; does not claim macOS WKWebView/AX or OS clipboard acceptance.',workspace:TEMP,modelCalls:0};
 fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:checks.length,failures,report:path.join(OUT,'report.json')},null,2));clearTimeout(watchdog);win.destroy();server.kill();app.exit(failures.length?1:0);
})().catch(error=>{console.error(error);clearTimeout(watchdog);win?.destroy();server?.kill();app.exit(1);});
