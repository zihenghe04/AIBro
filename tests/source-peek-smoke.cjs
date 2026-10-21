/* Real source chips, keyboard focus and pointer events in an isolated renderer. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict'),{spawn,spawnSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-source-peek-')),OUT=path.join(ROOT,'test-results/source-peek-20260924');
fs.mkdirSync(path.join(TEMP,'profile'));fs.mkdirSync(OUT,{recursive:true});app.setPath('userData',path.join(TEMP,'profile'));
let server,win;const checks=[],failures=[],wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let n=0;n<200;n++){if(await fn())return;await wait(40)}throw Error('Timeout: '+label)}
const watchdog=setTimeout(()=>{win?.destroy();server?.kill();app.exit(1)},90000);
(async()=>{
 const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})});const origin=`http://127.0.0.1:${port}`;
 const log=fs.openSync(path.join(TEMP,'server.log'),'a');server=spawn('python3',[path.join(ROOT,'app/server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(port),AI_WORKSTATION_DATA_DIR:path.join(TEMP,'store')},stdio:['ignore',log,log]});
 await until(()=>new Promise(r=>http.get(origin+'/__health',v=>{v.resume();r(v.statusCode===200)}).on('error',()=>r(false))),'server');await app.whenReady();
 win=new BrowserWindow({show:false,width:1180,height:900,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const rendererErrors=[];win.webContents.on('console-message',event=>{if(event.level==='error')rendererErrors.push({message:event.message,source:event.sourceId,line:event.lineNumber});});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(d,cb)=>cb({cancel:!d.url.startsWith(origin+'/')}));
 const evaluate=code=>win.webContents.executeJavaScript(code,true),hidden=()=>evaluate('document.querySelector("#sourcePeek").hidden');
 const key=keyCode=>{win.webContents.sendInputEvent({type:'keyDown',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode});};
 const move=async selector=>{const p=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);win.webContents.sendInputEvent({type:'mouseMove',...p});};
 const focus=id=>evaluate(`document.getElementById(${JSON.stringify(id)}).focus()`);
 const moveOutside=async()=>{const point=await evaluate(`(()=>{for(const point of [{x:4,y:4},{x:innerWidth-4,y:4},{x:4,y:innerHeight-4}]){const target=document.elementFromPoint(point.x,point.y);if(target&&!document.querySelector('#sourcePeek').contains(target))return point;}throw Error('No visible point outside source preview');})()`);win.webContents.sendInputEvent({type:'mouseMove',...point});};
 const shot=async name=>{await wait(220);fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG())};
 async function step(label,fn){try{await fn();checks.push(label);console.log('PASS',label)}catch(e){failures.push({label,error:e.stack});console.error('FAIL',label,e.message)}}
 await win.loadURL(origin);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydrate');await wait(900);
 // A hidden BrowserWindow can change activeElement without dispatching focusin.
 // Focus its webContents so this test exercises real browser focus events.
 // Focus emulation keeps the hidden window focused regardless of which app the
 // OS considers frontmost (same approach as citation-evidence-smoke).
 win.webContents.focus();win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});assert.equal(await evaluate('document.hasFocus()'),true);
 await step('startup produces valid resource URLs and no renderer initialization errors',async()=>{assert.deepEqual(rendererErrors,[]);assert.deepEqual(await evaluate(`performance.getEntriesByType('resource').filter(r=>!URL.canParse(r.name)).map(r=>({name:r.name,type:r.initiatorType}))`),[]);});
 await evaluate(`WorkstationOnboarding.close();state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};`+fs.readFileSync(path.join(ROOT,'tests/fixtures/agent-workbench.js'),'utf8'));
 await evaluate(`(()=>{currentConversation().messages=[{id:'source-answer',role:'agent',text:'这次方案参考了当前项目里已保存的两份文档。聚焦或悬停来源可以先查看内容，再决定是否打开原文。',at:Date.now()}];renderConversation();const host=document.createElement('div');host.id='qa-source-row';host.style.cssText='display:flex;gap:12px;padding:24px';for(const[id,note,label]of[['qa-plan','ui-plan','交互改造计划'],['qa-principles','ui-notes','设计原则'],['qa-missing','missing','已失效来源']]){const b=document.createElement('button');b.type='button';b.id=id;b.dataset.openNote=note;b.textContent=label;host.append(b)}document.querySelector('#messageList').append(host);host.scrollIntoView({behavior:'instant',block:'center'});document.querySelector('#qa-plan').setAttribute('aria-describedby','existing-description');})()`);
 await step('keyboard focus previews the current saved body without navigating or mutating the record',async()=>{
  const before=await evaluate('JSON.stringify(state.notes)');await focus('qa-plan');assert.equal(await hidden(),false);
  const shown=await evaluate(`({title:document.querySelector('#sourcePeek strong').textContent,body:document.querySelector('#sourcePeek p').textContent,expected:SourcePeek.excerpt(state.notes.find(n=>n.id==='ui-plan')),reading:document.querySelector('#readingPane').hidden})`);
  assert.equal(shown.title,'交互改造计划');assert.equal(shown.body,shown.expected);assert.match(shown.body,/目录与 Diff 并排/);assert.equal(await evaluate('JSON.stringify(state.notes)'),before);await shot('source-light');
 });
 await step('Escape from the preview action restores the source without immediately reopening it',async()=>{
  key('Down');await until(()=>evaluate(`document.activeElement===document.querySelector('#sourcePeek button')`),'preview action focus');key('Escape');await wait(340);
  assert.equal(await hidden(),true);assert.equal(await evaluate('document.activeElement.id'),'qa-plan');assert.equal(await evaluate(`document.querySelector('#qa-plan').getAttribute('aria-describedby')`),'existing-description');
 });
 await step('Escape on the already focused source does not suppress a later deliberate focus',async()=>{
  await focus('agentInput');await focus('qa-plan');assert.equal(await hidden(),false);key('Escape');await wait(30);assert.equal(await hidden(),true);await focus('agentInput');await focus('qa-plan');assert.equal(await hidden(),false);
 });
 await step('pointer hover waits, opens the real source, survives transfer to the preview, then closes on exit',async()=>{
  await focus('agentInput');await move('#conversationTitle');await move('#qa-plan');await wait(120);assert.equal(await hidden(),true);await until(async()=>!await hidden(),'hover preview');
  await move('#sourcePeek button');await wait(240);assert.equal(await hidden(),false);await moveOutside();await until(hidden,'pointer exit');
 });
 await step('a keyboard target cancels an older hover timer and removes the old source relationship',async()=>{
  await move('#qa-plan');await wait(60);await focus('qa-principles');await wait(340);assert.equal(await hidden(),false);assert.equal(await evaluate(`document.querySelector('#sourcePeek strong').textContent`),'设计原则');assert.equal(await evaluate(`document.querySelector('#qa-plan').getAttribute('aria-describedby')`),'existing-description');assert.equal(await evaluate(`document.querySelector('#qa-principles').getAttribute('aria-describedby')`),'sourcePeek');
 });
 await step('layout-only pointerover cannot steal keyboard source; real movement can change it',async()=>{
  await focus('qa-principles');await evaluate(`document.querySelector('#qa-plan').dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse',clientX:0,clientY:0}))`);await wait(340);assert.equal(await evaluate(`document.querySelector('#sourcePeek strong').textContent`),'设计原则');
  await moveOutside();await wait(240);assert.equal(await hidden(),false);assert.equal(await evaluate(`document.activeElement.id`),'qa-principles');
  await focus('agentInput');await move('#qa-plan');await until(async()=>!await hidden(),'deliberate hover after keyboard');assert.equal(await evaluate(`document.querySelector('#sourcePeek strong').textContent`),'交互改造计划');await moveOutside();await until(hidden,'deliberate hover leave');
 });
 await step('missing or deleted records never leave an unrelated preview on screen',async()=>{
  await focus('qa-missing');assert.equal(await hidden(),true);await evaluate(`state.notes.find(n=>n.id==='ui-plan').deletedAt=Date.now()`);await focus('qa-plan');assert.equal(await hidden(),true);await evaluate(`delete state.notes.find(n=>n.id==='ui-plan').deletedAt`);
 });
 await step('dark narrow preview stays in the viewport and renders source text as text',async()=>{
  await evaluate(`state.ui.theme='dark';state.settings.reduceMotion=true;applyUiPreferences();state.notes.find(n=>n.id==='ui-notes').content='真实保存的正文 <img src=x onerror="window.__badSource=true">';`);win.setSize(780,840);await wait(200);await focus('qa-principles');
  const value=await evaluate(`(()=>{const c=document.querySelector('#sourcePeek'),r=c.getBoundingClientRect();return{body:c.querySelector('p').textContent,images:c.querySelectorAll('img').length,inBounds:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,animated:c.getAnimations().length,executed:!!window.__badSource}})()`);
  assert.match(value.body,/<img/);assert.equal(value.images,0);assert.equal(value.executed,false);assert.equal(value.inBounds,true);assert.equal(value.animated,0);await shot('source-dark-narrow');
 });
 await step('Open original routes to the selected real note and closes the transient preview',async()=>{
  await focus('qa-plan');await evaluate(`document.querySelector('#sourcePeek button').click()`);await until(()=>evaluate(`document.querySelector('#previewTitle').textContent==='交互改造计划'`),'source reader');assert.equal(await hidden(),true);assert.match(await evaluate(`document.querySelector('#previewContent').textContent`),/目录与 Diff/);
 });
 await step('scrolling the focused source outside its message viewport closes the detached preview',async()=>{
  await evaluate(`ReadingPane.hide();const list=document.querySelector('#messageList');const pad=document.createElement('div');pad.style.cssText='height:1600px;flex-shrink:0';list.prepend(pad);list.append(pad.cloneNode());document.querySelector('#qa-plan').scrollIntoView({block:'center',behavior:'instant'});document.querySelector('#qa-plan').focus();`);
  assert.equal(await hidden(),false);
  await evaluate(`document.querySelector('#messageList').scrollTo({top:0,behavior:'instant'});`);
  await until(hidden,'source leaves message viewport');
  assert.equal(await evaluate(`document.querySelector('#qa-plan').getAttribute('aria-describedby')`),'existing-description');
 });
 await step('Open original keeps a citation’s PDF page through the actual reader and raster renderer',async()=>{
  const files=path.join(TEMP,'store','files');fs.mkdirSync(files,{recursive:true});
  const pdf=spawnSync('python3',['-c',`import fitz,sys,json\nfrom pathlib import Path\np=Path(sys.argv[1]);d=fitz.open()\nfor n in range(2):\n page=d.new_page(width=420,height=300);page.insert_text((35,45),'Source citation page '+str(n+1))\n(p/'qa-source-pdf').write_bytes(d.tobytes())\n(p/'qa-source-pdf.meta.json').write_text(json.dumps({'name':'Source citation.pdf','mimeType':'application/pdf'}))`,files]);
  assert.equal(pdf.status,0,pdf.stderr?.toString());
  win.setSize(1440,1000);
  await evaluate(`ReadingPane.hide();state.imports.push({id:'qa-source-pdf',name:'Source citation.pdf',mimeType:'application/pdf',content:'Page one overview. Page two evidence.',workspace:'日常'});const chip=document.createElement('button');chip.id='qa-page-source';chip.dataset.openImport='qa-source-pdf';chip.dataset.sourcePage='2';chip.textContent='来源 · 第 2 页';document.querySelector('#messageList').append(chip);`);
  // Let ConversationReading observe the new layout first; a scroll in the same
  // tick as the insertion is treated as layout and restored to the reading anchor.
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`);
  await evaluate(`(()=>{const chip=document.querySelector('#qa-page-source');chip.scrollIntoView({block:'center',behavior:'instant'});chip.focus();return true;})()`);
  assert.equal(await hidden(),false);
  await evaluate(`document.querySelector('#sourcePeek button').click()`);
  await until(()=>evaluate(`(()=>{const image=document.querySelector('.pdf-sheet img');return document.querySelector('[data-pdf-page]')?.value==='2'&&image?.complete&&image.naturalWidth>0;})()`),'source PDF page 2');
  assert.match(await evaluate(`document.querySelector('.pdf-sheet img').src`),/preview\?page=2&/);
  assert.equal(await hidden(),true);await shot('source-pdf-page-2');
 });
 await step('Open original marks the cited PDF excerpt on its page',async()=>{
  await evaluate(`(()=>{ReadingPane.hide();state.agentRuns.push({id:'qa-cite-run',evidenceSources:[{type:'import',id:'qa-source-pdf',sourceId:'qa-cite-1',title:'Source citation.pdf',page:2,excerpt:'[第 2 页]\\nSource citation page 2',provided:true,number:1}]});const chip=document.createElement('button');chip.id='qa-cite-chip';chip.dataset.citationRun='qa-cite-run';chip.dataset.citationSource='qa-cite-1';chip.textContent='1';document.querySelector('#messageList').append(chip);})()`);
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`);
  await evaluate(`(()=>{const chip=document.querySelector('#qa-cite-chip');chip.scrollIntoView({block:'center',behavior:'instant'});chip.focus();return true;})()`);
  assert.equal(await hidden(),false);
  const canOpen=await evaluate(`!document.querySelector('#citationOpenOriginal')?.disabled`);assert.equal(canOpen,true,'citation can open original');
  await evaluate(`window.__toasts=[];const box=document.querySelector('#toast');if(box)new MutationObserver(()=>__toasts.push(box.textContent)).observe(box,{childList:true,subtree:true,characterData:true});document.querySelector('#citationOpenOriginal').click()`);
  await until(()=>evaluate(`document.querySelectorAll('.pdf-citation-mark').length>0`),'citation marks on PDF page');
  const marks=await evaluate(`(()=>{const marks=[...document.querySelectorAll('.pdf-citation-mark')].map(m=>m.getBoundingClientRect()),words=[...document.querySelectorAll('.pdf-text-word')].map(w=>w.textContent.trim());return{count:marks.length,page:document.querySelector('[data-pdf-page]').value,words,visible:marks.every(r=>r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight),toasts:__toasts}})()`);
  assert.equal(marks.page,'2');assert.equal(marks.count,1,JSON.stringify(marks));assert.equal(marks.visible,true,JSON.stringify(marks));
  assert.ok(!marks.toasts.some(text=>/未能唯一定位/.test(text)),JSON.stringify(marks));await shot('source-pdf-citation-marked');
  // Turning the page drops the mark; a citation the page cannot match reports it.
  await evaluate(`document.querySelector('[data-pdf-prev]').click()`);await until(()=>evaluate(`document.querySelector('[data-pdf-page]').value==='1'&&!document.querySelector('.pdf-citation-mark')`),'mark cleared on page turn');
  assert.equal(await evaluate(`revealSourceExcerpt('import','qa-source-pdf',{page:1,excerpt:'Words that are not on this page'})`),false);
 });
 await evaluate(`window.__peekAccess={projects:[{id:'guard-project'}],notes:[{id:'guard-note',title:'SECRET_TITLE',content:'SECRET_BODY',projectId:'guard-project'}],agentRuns:[{id:'guard-run',evidenceSources:[{type:'note',id:'guard-note',sourceId:'guard-source',title:'SECRET_TITLE',excerpt:'SECRET_BODY',path:'SECRET_PATH',url:'https://secret.example/',provided:true,number:1}]}]};window.__peekOpens=0;window.__peekPrivate=false;SourcePeek.init({state:()=>__peekAccess,isPrivate:()=>__peekPrivate,open:async()=>{__peekOpens++;}});ReadingPane.hide();const guarded=document.createElement('button');guarded.id='qa-guarded';guarded.dataset.citationRun='guard-run';guarded.dataset.citationSource='guard-source';guarded.textContent='Saved source';document.querySelector('#messageList').append(guarded);guarded.scrollIntoView({block:'center',behavior:'instant'});`);
 await step('source project archive is checked again at click time before opening the original',async()=>{
  await focus('qa-guarded');assert.equal(await hidden(),false);await evaluate(`__peekAccess.projects[0].archived=true;document.querySelector('#citationOpenOriginal').click()`);
  assert.equal(await evaluate('__peekOpens'),0);assert.equal(await evaluate(`document.querySelector('#citationOpenOriginal').disabled`),true);assert.match(await evaluate(`document.querySelector('.citation-excerpt').textContent`),/SECRET_BODY/);await evaluate(`delete __peekAccess.projects[0].archived;SourcePeek.refresh()`);
 });
 await step('private changes close the open popover and remove sensitive text and React content',async()=>{
  await evaluate(`__peekAccess.notes[0].private=true;SourcePeek.refresh()`);assert.equal(await hidden(),true);assert.equal(await evaluate(`document.querySelector('#sourcePeek').textContent`),'');assert.equal(await evaluate(`document.querySelector('#sourcePeek').childElementCount`),0);await evaluate(`SourcePeek.show(document.querySelector('#qa-guarded'))`);assert.equal(await hidden(),true);await evaluate(`delete __peekAccess.notes[0].private;SourcePeek.show(document.querySelector('#qa-guarded'))`);assert.equal(await hidden(),false);
 });
 await step('private mode is rechecked at click time and cannot invoke the host opener',async()=>{
  await evaluate(`__peekPrivate=true;document.querySelector('#citationOpenOriginal').click()`);assert.equal(await hidden(),true);assert.equal(await evaluate('__peekOpens'),0);assert.equal(await evaluate(`document.querySelector('#sourcePeek').textContent`),'');await evaluate('__peekPrivate=false');
 });
 await step('late asynchronous errors cannot restore private excerpts, paths or error text',async()=>{
  await evaluate(`SourcePeek.init({state:()=>__peekAccess,isPrivate:()=>__peekPrivate,open:()=>new Promise((resolve,reject)=>{window.__peekReject=reject;})});SourcePeek.show(document.querySelector('#qa-guarded'));document.querySelector('#citationOpenOriginal').click()`);await until(()=>evaluate(`typeof __peekReject==='function'`),'pending opener');await evaluate(`__peekAccess.notes[0].private=true;__peekReject(Error('SECRET_ERROR and SECRET_PATH'));`);await until(hidden,'late private error closes');assert.equal(await evaluate(`document.querySelector('#sourcePeek').textContent`),'');await evaluate(`delete __peekAccess.notes[0].private;`);
 });
 await step('legacy chips cannot bypass archive or private ownership checks',async()=>{
  await evaluate(`(()=>{const chip=document.querySelector('#qa-guarded');delete chip.dataset.citationRun;delete chip.dataset.citationSource;chip.dataset.openNote='guard-note';__peekAccess.projects[0].deletedAt=1;SourcePeek.show(chip)})()`);assert.equal(await hidden(),true);await evaluate(`delete __peekAccess.projects[0].deletedAt;SourcePeek.show(document.querySelector('#qa-guarded'))`);assert.equal(await hidden(),false);await evaluate(`__peekAccess.notes[0].private=true;document.body.append(document.createElement('span'))`);await until(hidden,'DOM state change clears private legacy source');assert.equal(await evaluate(`document.querySelector('#sourcePeek').textContent`),'');
 });
 const report={checks,passed:checks.length,failures,modelCalls:0,rendererErrors,workspace:TEMP};fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));clearTimeout(watchdog);win.destroy();server.kill();app.exit(failures.length?1:0);
})().catch(e=>{console.error(e);clearTimeout(watchdog);if(win&&!win.isDestroyed()&&win.webContents.debugger.isAttached())win.webContents.debugger.detach();win?.destroy();server?.kill();app.exit(1)});
