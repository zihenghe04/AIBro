'use strict';
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),http=require('node:http'),{spawn}=require('node:child_process');
const OUT=path.resolve(__dirname,'../test-results/research-evidence-20260930'),ASSETS=path.resolve(__dirname,'../app'),TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-research-evidence-'));
fs.mkdirSync(OUT,{recursive:true});
app.setPath('userData',path.join(TEMP,'profile'));app.on('window-all-closed',()=>{});
const result={scope:'Frozen full production Electron renderer, synthetic isolated workspace, no provider or user records.',runtime:process.versions,cases:[],skipped:[],failures:[],externalRequests:[],rendererErrors:[],modelCalls:0};
let win,server,finished=false;const delay=ms=>new Promise(r=>setTimeout(r,ms));
const watchdog=setTimeout(()=>finish(1,new Error('Baseline watchdog')),240000);
const write=()=>fs.writeFileSync(path.join(OUT,'acceptance.json'),JSON.stringify(result,null,2));
async function finish(code,error){if(finished)return;finished=true;clearTimeout(watchdog);if(error){result.error=error.stack||String(error);console.error(error);}if(win&&!win.isDestroyed()){if(win.webContents.debugger.isAttached())win.webContents.debugger.detach();win.destroy();}if(server&&server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('exit',r)),delay(2000)]);}result.serverStopped=!server||server.exitCode!==null||server.signalCode!==null;if(result.serverStopped)fs.rmSync(TEMP,{recursive:true,force:true});result.temporaryProfileRemoved=!fs.existsSync(TEMP);write();console.log(JSON.stringify({cases:result.cases.length,skipped:result.skipped,error:result.error||null,report:path.join(OUT,'acceptance.json')}));app.exit(code);}
process.on('SIGTERM',()=>finish(1,new Error('Harness interrupted')));
async function until(fn,label){for(let i=0;i<250;i++){if(await fn())return;await delay(50);}throw Error('Timeout '+label);}
(async()=>{
 const port=await new Promise(resolve=>{const probe=net.createServer();probe.listen(0,'127.0.0.1',()=>{const value=probe.address().port;probe.close(()=>resolve(value));});});
 const origin='http://127.0.0.1:'+port,log=fs.openSync(path.join(OUT,'acceptance-server.log'),'a');
 server=spawn('python3',['-B',path.join(ASSETS,'server.py')],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',AI_WORKSTATION_DATA_DIR:path.join(TEMP,'store'),AI_WORKSTATION_ASSET_DIR:ASSETS,AI_WORKSTATION_PORT:String(port)},stdio:['ignore',log,log]});fs.closeSync(log);
 await until(()=>new Promise(resolve=>http.get(origin+'/__health',r=>{r.resume();resolve(r.statusCode===200);}).on('error',()=>resolve(false))),'server health');
 await app.whenReady();win=new BrowserWindow({show:false,width:1440,height:980,useContentSize:true,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(request,done)=>{const external=!request.url.startsWith(origin+'/');if(external)result.externalRequests.push(request.url);done({cancel:external});});
 win.webContents.on('console-message',event=>{if(event.level==='error')result.rendererErrors.push(event.message);});
 win.webContents.on('render-process-gone',(_,details)=>{result.rendererGone=details;void finish(1,new Error('Renderer exited'));});
 const evaluate=code=>win.webContents.executeJavaScript(code,true);
 await win.loadURL(origin);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydrated');
 async function check(name,code){try{const value=await evaluate(`(async()=>{const expect=(ok,message)=>{if(!ok)throw Error(message);};${code}})()`);result.cases.push({name,value});console.log('PASS '+name);}catch(e){result.failures.push({name,error:e.message});console.error('FAIL '+name+' '+e.message);}write();}
 await evaluate(fs.readFileSync(path.join(__dirname,'fixtures/research-evidence-seed.js'),'utf8'));
 const assert=require('node:assert/strict');
 const click=selector=>evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing '+${JSON.stringify(selector)});if(n.disabled)throw Error('Disabled '+${JSON.stringify(selector)});n.focus();n.click();})()`);
 const writeField=async(selector,value)=>{await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});for(let d=n.closest('details');d;d=d.parentElement.closest('details'))d.open=true;n.focus();n.select();})()`);await win.webContents.insertText(value);};
 const select=(selector,value)=>evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 const button=(label,scope='#sourceComparisonDialog')=>evaluate(`(()=>{const n=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(n=>n.textContent.trim()===${JSON.stringify(label)});if(!n||n.disabled)throw Error('Unavailable button '+${JSON.stringify(label)});n.click();})()`);
 const saved=()=>until(()=>evaluate('!SourceComparison.isBusy()&&!state._pendingLocalSave&&!serverSaveInFlight'),'save');
 async function step(name,fn){try{await fn();result.cases.push({name});console.log('PASS '+name);}catch(e){result.failures.push({name,error:e.stack});console.error('FAIL '+name,e.message);console.error(await evaluate(`document.querySelector('#sourceComparisonDialog')?.textContent?.slice(-2200)`));}write();}
 const row='[data-comparison-criterion="criterion-1"]',a=row+' [data-comparison-cell="note:support-note"]',b=row+' [data-comparison-cell="note:counter-note"]';
 await step('Wiki research entry opens actual Kit picker and then question-first editor',async()=>{
  await click('[data-wiki-action="research"]');await until(()=>evaluate('SourceComparison.isOpen()'),'picker');
  assert.equal(await evaluate('document.querySelector("#researchModeTab").getAttribute("aria-selected")'),'true');
  await click('.comparison-picker-row input[aria-label="小样本实验记录"]');await click('.comparison-picker-row input[aria-label="跨域验证与反例"]');await click('#comparisonStart');
  assert.ok(await evaluate('document.querySelector("#comparisonQuestion")'));
  assert.equal(await evaluate('state.conversations[0].draft'),'保留这份原对话草稿');
 });
 await step('question, real quotes, relation selectors and explicit human reviews persist in stable controls',async()=>{
  await writeField('#comparisonTitle','固定随机种子能否改善跨域表现？');await writeField('#comparisonQuestion','固定随机种子能否改善跨域表现？');await writeField('#comparisonScope','仅依据这两份实验记录，区分同域复验与跨域验证。');
  await writeField(a+' .comparison-evidence textarea','固定随机种子后，三次独立复验均获得更低的验证误差。');await writeField(a+' .comparison-judgment textarea','支持同域复验稳定性，尚不能证明跨域收益。');await select('#comparisonRelation-criterion-1-0','supports');
  await writeField(b+' .comparison-evidence textarea','迁移到新的数据集后，误差不再降低，部分样本表现更差。');await writeField(b+' .comparison-judgment textarea','跨域条件下未复现收益，是当前结论的反例。');await select('#comparisonRelation-criterion-1-1','contradicts');
  await click('#comparisonReview-criterion-1-0');await click('#comparisonReview-criterion-1-1');
  const stable=await evaluate(`(()=>{const n=document.querySelector('#comparisonQuestion');window.__questionNode=n;SourceComparison.refresh();return n===document.querySelector('#comparisonQuestion');})()`);assert.equal(stable,true);
  await evaluate(`document.querySelector('.comparison-workspace').scrollTop=0`);await delay(80);fs.writeFileSync(path.join(OUT,'light-question.png'),(await win.webContents.capturePage()).toPNG());
 });
 await step('claims reference confirmed evidence and can save a real Research Wiki output',async()=>{
  let n=await evaluate('document.querySelectorAll("[id^=comparisonClaim-]").length');if(!n)await button('＋ 添加结论');
  await writeField('[id^=comparisonClaim-]','当前记录支持同域复验收益；跨域收益证据不足。');
  await click('[data-evidence-choice] input');await evaluate(`document.querySelectorAll('[data-evidence-choice] input')[1].click()`);
  await writeField('#comparisonOpenQuestions','增加独立数据集，并隔离分布偏移与标注质量。');await select('#comparisonResearchStatus','ready');await click('#comparisonSave');await saved();
  await check('durable metadata, Wiki discovery and original chat draft',`const n=state.notes.find(n=>n.sourceComparison);expect(n?.kind==='科研 Wiki/output','output category');expect(n.sourceComparison.researchStatus==='ready','ready state');expect(n.sourceComparison.claims[0].evidenceIds.length===2,'claim citations');expect(ResearchWiki.entries(state).some(x=>x.id===n.id),'Wiki inclusion');const s=await fetch('/__state').then(r=>r.json());expect(s.notes.find(x=>x.id===n.id).sourceComparison.question===n.sourceComparison.question,'durable question');window.__researchNoteId=n.id;return {id:n.id,evidence:n.sourceComparison.claims[0].evidenceIds};`);
 });
 await step('actual reader opens saved research and returns to structured editor',async()=>{
  const label=await evaluate(`[...document.querySelectorAll('#sourceComparisonDialog button')].find(n=>/打开.*(笔记|成果)|查看.*Wiki/.test(n.textContent))?.textContent.trim()`);await button(label);await until(()=>evaluate('!SourceComparison.isOpen()'),'reader complete');
  assert.equal(await evaluate('state.previewRecord.id'),await evaluate('__researchNoteId'));await click('#previewComparison button');await until(()=>evaluate('SourceComparison.isOpen()'),'reopen');assert.equal(await evaluate('document.querySelector("#comparisonQuestion").value'),'固定随机种子能否改善跨域表现？');
 });
 await step('source changes revoke review and ready eligibility without losing the claim or judgments',async()=>{
  await evaluate(`state.notes.find(n=>n.id==='support-note').content+='\\n后续复验尚未完成。';SourceComparison.refresh();`);
  assert.match(await evaluate(`document.querySelector(${JSON.stringify('[data-comparison-source="note:support-note"]')}).textContent`),/有新版本/);
  await check('readiness derives from live evidence',`const n=state.notes.find(n=>n.sourceComparison),v=SourceComparison.researchView(state,n.sourceComparison);expect(!v.ready,'changed source incorrectly ready');expect(n.sourceComparison.claims[0].text.includes('跨域收益'),'claim lost');return {ready:v.ready,reasons:v.readinessReasons};`);
  await button('刷新摘录','[data-comparison-source="note:support-note"]');assert.equal(await evaluate(`document.querySelector(${JSON.stringify(a+' .comparison-judgment textarea')}).value`),'支持同域复验稳定性，尚不能证明跨域收益。');
  await click('#comparisonReview-criterion-1-0');await select('#comparisonResearchStatus','ready');await click('#comparisonSave');await saved();
 });
 await step('IME edit, Escape and reopening retain the exact question and focus node',async()=>{
  await evaluate(`document.querySelector('#comparisonQuestion').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));document.querySelector('#sourceComparisonDialog').dispatchEvent(new Event('cancel',{cancelable:true}));`);assert.equal(await evaluate('SourceComparison.isOpen()'),true);
  await evaluate(`document.querySelector('#comparisonQuestion').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:''}));`);
  await writeField('#comparisonQuestion','修改后的研究问题，保留未保存输入');await evaluate('SourceComparison.close()');await delay(70);await evaluate('openSourceComparison(undefined,{mode:"research"})');assert.equal(await evaluate('document.querySelector("#comparisonQuestion").value'),'修改后的研究问题，保留未保存输入');
  await writeField('#comparisonQuestion','固定随机种子能否改善跨域表现？');await click('#comparisonSave');await saved();
 });
 await step('narrow dark research remains contained with reduced motion and accessible selectors',async()=>{
  win.setContentSize(430,850);await evaluate(`state.ui.theme='dark';state.settings.reduceMotion=true;applyUiPreferences();document.querySelector('.comparison-workspace').scrollTop=0;`);await delay(120);
  const size=await evaluate(`(()=>{const d=document.querySelector('#sourceComparisonDialog');return {width:d.getBoundingClientRect().width,overflow:d.scrollWidth-d.clientWidth,field:!!document.querySelector('#comparisonResearchStatus').getAttribute('aria-label')};})()`);assert.ok(size.width<=430);assert.ok(size.overflow<3);assert.equal(size.field,true);assert.equal(await evaluate(`document.querySelector('#sourceComparisonDialog [data-halaska-root]').dataset.halaskaTheme`),'dark');assert.equal(await evaluate(`document.querySelector('#sourceComparisonDialog').getAnimations({subtree:true}).filter(a=>a.playState==='running').length`),0);fs.writeFileSync(path.join(OUT,'dark-narrow.png'),(await win.webContents.capturePage()).toPNG());
  win.setContentSize(1440,980);await evaluate(`state.ui.theme='light';applyUiPreferences();`);
 });
 await step('saved structure survives complete renderer restart without false external edits',async()=>{
  await evaluate('SourceComparison.close()');await saved();const id=await evaluate('__researchNoteId');await win.reload();await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'reload');
  await evaluate(`openSourceComparison(undefined,{noteId:${JSON.stringify(id)}})`);await until(()=>evaluate('SourceComparison.isOpen()'),'reloaded editor');assert.equal(await evaluate('document.querySelector("#comparisonQuestion").value'),'固定随机种子能否改善跨域表现？');
  assert.equal(await evaluate(`SourceComparison.reopenSession(state,${JSON.stringify(id)}).externalChanged`),false);
  result.finalNote=await evaluate(`state.notes.find(n=>n.id===${JSON.stringify(id)})`);
 });
 await step('evidence locator uses the actual source reader and returns without losing research',async()=>{
  await button('定位原文 ↗',a);await until(()=>evaluate('!SourceComparison.isOpen()'),'evidence route');assert.equal(await evaluate('state.previewRecord.id'),'support-note');
  assert.equal(await evaluate('!!CSS.highlights?.get("citation-location")'),true);await evaluate('openSourceComparison()');assert.equal(await evaluate('document.querySelector("#comparisonQuestion").value'),'固定随机种子能否改善跨域表现？');
 });
 if(result.failures.length||result.rendererErrors.length||result.externalRequests.length)throw Error('Research acceptance failures; see report');
 await finish(0);
})().catch(e=>finish(1,e));
