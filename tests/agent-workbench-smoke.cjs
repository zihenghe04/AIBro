/* Real renderer + real local-file HTTP transactions, isolated temp workspace only. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18941,ORIGIN=`http://127.0.0.1:${PORT}`,TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-workbench-')),STORE=path.join(TEMP,'store'),PROJECT=path.join(TEMP,'project');
for(const p of [STORE,PROJECT,path.join(PROJECT,'docs'),path.join(PROJECT,'src'),path.join(TEMP,'profile')])fs.mkdirSync(p,{recursive:true});app.setPath('userData',path.join(TEMP,'profile'));
const OUT=path.join(ROOT,'test-results/ui-refresh-20260923');fs.mkdirSync(OUT,{recursive:true});let server,win;const passed=[],failures=[],wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const start=Date.now();while(Date.now()-start<15000){if(await fn())return;await wait(60);}throw Error('Timed out: '+label);}
const watchdog=setTimeout(()=>{server?.kill();win?.destroy();app.exit(1);},150000);
async function run(){
 await new Promise((resolve,reject)=>{const p=net.createServer();p.once('error',reject);p.listen(PORT,'127.0.0.1',()=>p.close(resolve));});
 const log=fs.openSync(path.join(TEMP,'server.log'),'a');server=spawn('python3',[path.join(ROOT,'app/server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(PORT),AI_WORKSTATION_DATA_DIR:STORE},stdio:['ignore',log,log]});
 await until(()=>new Promise(resolve=>http.get(ORIGIN+'/__health',r=>{r.resume();resolve(r.statusCode===200);}).on('error',()=>resolve(false))),'server');
 await app.whenReady();win=new BrowserWindow({show:false,width:1440,height:980,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,cb)=>cb({cancel:!details.url.startsWith(ORIGIN+'/')}));
 win.webContents.on('console-message',(event)=>{if(event.level==='error')console.error('RENDERER',event.message);});
 const evaluate=code=>win.webContents.executeJavaScript(code,true),click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
 const shot=async name=>{await wait(200);fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG());};
 // Awaiting-approval runs render the plan review card; its footer calls the same approveRun/rejectRun.
 const planButton=(message,prefix)=>`[...document.querySelectorAll('[data-message-id="${message}"] .plan-review-footer button')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(prefix)}))`;
 const clickPlan=async(message,prefix)=>{await until(()=>evaluate(`!!${planButton(message,prefix)}&&!${planButton(message,prefix)}.disabled`),'plan review '+prefix);await evaluate(`${planButton(message,prefix)}.click();true`);};
 async function step(label,fn){try{await fn();passed.push(label);console.log('PASS',label);}catch(e){failures.push({label,error:e.stack});console.error('FAIL',label,e.message);}}
 await win.loadURL(ORIGIN);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydration');
 await evaluate(`WorkstationOnboarding.close();state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};`+fs.readFileSync(path.join(__dirname,'fixtures/agent-workbench.js'),'utf8'));
 await step('message card selects the clicked snapshot; preview and source keep the conversation usable',async()=>{
  await click('.file-change-row:nth-child(2) button[aria-label^="审阅修改"]');await until(()=>evaluate(`!!document.querySelector('[data-review-file="ui-notes"][aria-pressed="true"]')`),'second file');
  await click('[data-mode="preview"]');assert.match(await evaluate(`document.querySelector('.file-review-content h1').textContent`),/设计原则/);
  await click('[data-mode="source"]');assert.match(await evaluate(`document.querySelector('.review-source').textContent`),/# 设计原则/);
  assert.equal(await evaluate(`document.querySelector('#previewDialog').matches(':modal')`),false);
  await evaluate(`document.querySelector('#agentInput').value='审阅时仍可继续输入';`);assert.match(await evaluate(`document.querySelector('#agentInput').value`),/继续输入/);
 });
 await step('folders, full-path filtering, no-match state and keyboard navigation agree',async()=>{
  if(await evaluate(`document.querySelector('.review-files-toggle')&&!document.querySelector('.review-files-toggle').hidden&&document.querySelector('.file-review-tree').hidden`))await click('.review-files-toggle');
  await evaluate(`(()=>{const n=document.querySelector('.review-search');n.value='research/设计';n.dispatchEvent(new Event('input'));})()`);
  assert.equal(await evaluate(`document.querySelector('[data-review-file="ui-plan"]').hidden`),true);assert.equal(await evaluate(`document.querySelector('[data-review-file="ui-notes"]').hidden`),false);
  await evaluate(`(()=>{const n=document.querySelector('.review-search');n.value='missing';n.dispatchEvent(new Event('input'));})()`);assert.equal(await evaluate(`document.querySelector('.file-review-tree .review-empty').hidden`),false);
  await evaluate(`(()=>{const n=document.querySelector('.review-search');n.value='';n.dispatchEvent(new Event('input'));document.querySelector('.review-folder summary').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));})()`);
  assert.equal(await evaluate(`document.activeElement.dataset.reviewFile`),'ui-plan');
  await click('[data-review-file="ui-plan"]');await click('[data-mode="diff"]');if(await evaluate(`document.querySelector('[data-review-split]').disabled`)){await click('#readingExpand');await until(()=>evaluate(`!document.querySelector('[data-review-split]').disabled`),'wide review');}await click('[data-review-split]');assert.ok(await evaluate(`document.querySelectorAll('.diff-pair').length>0`));
 });
 await step('both themes, narrow reader, preview and keyboard-selected tabs fit without horizontal clipping',async()=>{
  for(const theme of ['light','dark']){
   await evaluate(`state.ui.theme=${JSON.stringify(theme)};applyUiPreferences();WorkspaceLayout.refresh()`);await shot('smoke-'+theme+'-review');
   assert.equal(await evaluate(`document.documentElement.scrollWidth>innerWidth`),false);
  }
  await evaluate(`document.querySelector('[data-mode="source"]').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));`);assert.equal(await evaluate(`document.activeElement.dataset.mode`),'preview');
  await shot('smoke-dark-preview');win.setSize(760,900);await evaluate('WorkspaceLayout.refresh()');await shot('smoke-narrow-preview');assert.equal(await evaluate(`document.documentElement.scrollWidth>innerWidth`),false);
  win.setSize(1440,980);await evaluate(`state.ui.theme='light';applyUiPreferences();WorkspaceLayout.refresh()`);
 });
 await step('large sparse diffs stay accurate and expanding source, full diff or folded context preserves order',async()=>{
  const result=await evaluate(`(()=>{
   const host=document.createElement('div');document.body.append(host);
   try{
    const before=Array.from({length:12000},(_,i)=>'line '+i).join('\\n'),after=before.split('\\n').map((line,i)=>i%1000===100?line+' changed':line).join('\\n');
    const diff=FileReview.diff(before,after),count=ReviewWorkbench.stats(diff);
    const view=ReviewWorkbench.document(host,{path:'large.txt',before,after},{mode:'diff',split:false});
    const initiallyVisible=host.querySelectorAll('.diff-line').length;
    view.show('source');host.querySelector('.review-source>.review-more').click();
    const source=[...host.querySelectorAll('.review-source>.diff-line code')].map(n=>n.textContent).join('\\n')===after.split('\\n').slice(0,800).join('\\n');
    view.show('diff');host.querySelector('[data-review-context]').click();host.querySelector('.file-review-diff>.review-more').click();
    const full=[...host.querySelectorAll('.file-review-diff>.diff-line code')].map(n=>n.textContent).join('\\n')===diff.slice(0,800).map(r=>r.text).join('\\n');
    host.querySelector('[data-review-context]').click();
    const folded=ReviewWorkbench.contextRows(diff),gapIndex=folded.filter(r=>r.type==='gap').findIndex(r=>r.rows.length>800);
    const expected=folded.filter(r=>r.type==='gap')[gapIndex].rows;
    host.querySelectorAll('.diff-gap button')[gapIndex].click();const expanded=host.querySelector('.diff-expanded-context');expanded.querySelector('.review-more').click();expanded.querySelector('.review-more').click();
    const context=[...expanded.querySelectorAll('.diff-line code')].map(n=>n.textContent).join('\\n')===expected.map(r=>r.text).join('\\n');
    return {count,initiallyVisible,source,full,context};
   }finally{host.remove();}
  })()`);
  assert.deepEqual(result.count,{added:12,removed:12});assert.equal(result.initiallyVisible,96);assert.equal(result.source,true);assert.equal(result.full,true);assert.equal(result.context,true);
 });
 await step('real local proposals save, survive tab switches, undo, and refuse later manual edits',async()=>{
  const setup=await evaluate(`(async()=>{const connection=await FileContext.request('/__local/roots',{path:${JSON.stringify(PROJECT)}});const cid=connection.candidate.id;state.projects.push({id:'local-qa',name:'隔离项目',workspace:'日常',localFolder:{id:cid}});const run={id:'local-qa-run',conversationId:currentConversation().id,projectId:'local-qa',status:'completed',startedAt:Date.now(),localFileEdits:[]};for(const [p,content]of [['docs/plan.md','# Plan\\n\\nReview before saving.'],['src/demo.js','export const active = true;']])run.localFileEdits.push(await FileContext.request('/__local/edits/propose',{candidateId:cid,projectId:'local-qa',runId:run.id,path:p,operation:'create',content}));state.agentRuns.push(run);save();await openPreview('local-review',run.id,run.localFileEdits[1].id);return {ids:run.localFileEdits.map(e=>e.id)};})()`);
  await until(()=>evaluate(`!!document.querySelector('[data-local-edit-action="apply"]')`),'local snapshot');assert.match(await evaluate(`document.querySelector('.review-breadcrumb').textContent`),/src\/demo.js/);
  await click('[data-local-edit-action="apply"]');await until(()=>evaluate(`!!document.querySelector('[data-local-edit-action="undo"]')`),'save');assert.equal(fs.readFileSync(path.join(PROJECT,'src/demo.js'),'utf8'),'export const active = true;');
  await click(`[data-review-file="${setup.ids[0]}"]`);await until(()=>evaluate(`document.querySelector('.review-breadcrumb')?.textContent==='docs/plan.md'`),'other file');await click(`[data-review-file="${setup.ids[1]}"]`);await until(()=>evaluate(`!!document.querySelector('[data-local-edit-action="undo"]')`),'saved file');
  fs.writeFileSync(path.join(PROJECT,'src/demo.js'),'manual edit');await click('[data-local-edit-action="undo"]');await until(()=>evaluate(`!document.querySelector('.file-review-error').hidden`),'conflict shown');assert.equal(fs.readFileSync(path.join(PROJECT,'src/demo.js'),'utf8'),'manual edit');
  fs.writeFileSync(path.join(PROJECT,'src/demo.js'),'export const active = true;');await click('[data-local-edit-action="undo"]');await until(()=>evaluate(`document.querySelector('.review-notice').textContent.includes('已撤销')`),'undo');assert.equal(fs.existsSync(path.join(PROJECT,'src/demo.js')),false);
  await click(`[data-review-file="${setup.ids[0]}"]`);await until(()=>evaluate(`!!document.querySelector('[data-local-edit-action="dismiss"]')`),'pending file');await click('[data-local-edit-action="dismiss"]');await until(()=>evaluate(`document.querySelector('.review-notice').textContent.includes('已放弃')`),'dismiss');assert.equal(fs.existsSync(path.join(PROJECT,'docs/plan.md')),false);
 });
 await step('Kit approval runs the real transaction once and persists the new note',async()=>{
  await evaluate(`ReadingPane.hide();state.currentConversationId='ui-conversation';showView('agent','对话');(()=>{const c=currentConversation(),now=Date.now(),run={id:'kit-approval-run',conversationId:c.id,workspace:'日常',projectId:null,status:'awaiting-approval',startedAt:now-1000,goal:'记录组件验收结果',steps:[{id:'plan',text:'等待批准笔记写入',status:'pending',at:now-500}],pendingActions:[{type:'create_note',title:'Kit 真实审批验收',workspace:'日常',content:'这条笔记由真实 approveRun、executeActions 和 save 路径生成。'}]};state.agentRuns.push(run);c.messages.push({id:'kit-approval-message',role:'agent',text:'准备创建验收笔记，请确认。',pendingRunId:run.id,runId:run.id,at:now,steps:run.steps});renderAll();})()`);
  await clickPlan('kit-approval-message','批准 ');
  assert.equal(await evaluate(`!!document.querySelector('[data-message-id="kit-approval-message"] [data-halaska-root="PlanReviewSurface"]')||state.agentRuns.find(r=>r.id==='kit-approval-run').status!=='awaiting-approval'`),true);
  await until(()=>evaluate(`state.agentRuns.find(r=>r.id==='kit-approval-run').status==='completed'`),'approval settled');
  assert.equal(await evaluate(`state.notes.filter(n=>n.title==='Kit 真实审批验收').length`),1);
  await until(()=>evaluate(`fetch('/__state',{cache:'no-store'}).then(r=>r.json()).then(s=>s.notes.some(n=>n.title==='Kit 真实审批验收'))`),'durable approval');
  assert.match(await evaluate(`document.querySelector('[data-message-id="kit-approval-message"] [data-halaska-root="AgentLifecycleSummary"]').textContent`),/已完成/);
  assert.equal(await evaluate(`!!document.querySelector('[data-approve-run="kit-approval-run"]')`),false);
  await shot('smoke-kit-approval-completed');
 });
 await step('Kit rejection and error controls reach the real existing handlers',async()=>{
  await evaluate(`(()=>{const c=currentConversation(),run={id:'kit-reject-run',conversationId:c.id,status:'awaiting-approval',workspace:'日常',startedAt:Date.now(),steps:[{id:'proposed',text:'等待批准',status:'pending'}],pendingActions:[{type:'create_note',title:'禁止创建的拒绝验收笔记',workspace:'日常',content:'Must not exist'}]};state.agentRuns.push(run);c.messages.push({id:'kit-reject-message',role:'agent',text:'这项操作将被拒绝。',runId:run.id,pendingRunId:run.id,steps:run.steps});renderAll()})()`);
  await clickPlan('kit-reject-message','拒绝执行');
  await until(()=>evaluate(`state.agentRuns.find(r=>r.id==='kit-reject-run').status==='rejected'`),'rejection settled');
  assert.equal(await evaluate(`state.notes.some(n=>n.title==='禁止创建的拒绝验收笔记')`),false);
  await evaluate(`(()=>{const c=currentConversation(),run={id:'kit-failure-run',conversationId:c.id,status:'failed',startedAt:Date.now()-1000,finishedAt:Date.now(),error:'验收用离线错误',goal:'校验重试附件入口',attachmentIds:[],steps:[{id:'request',text:'请求失败',status:'failed'}]};state.agentRuns.push(run);c.messages.push({id:'kit-failure-message',role:'agent',runId:run.id,retryRunId:run.id,runStatus:'failed',text:'调用失败：验收用离线错误',steps:run.steps});renderAll()})()`);
  await click('[data-adjust-run="kit-failure-run"]');
  assert.equal(await evaluate(`!!document.querySelector('[data-message-id="kit-failure-message"] .retry-attachment-editor')`),true);
  await click('[data-cancel-retry]');
  assert.equal(await evaluate(`!!document.querySelector('.retry-attachment-editor')`),false);
  await click('[data-dismiss-failure="kit-failure-message"]');
  assert.equal(await evaluate(`!!currentConversation().messages.find(m=>m.id==='kit-failure-message').deletedAt`),true);
  assert.equal(await evaluate(`!!document.querySelector('[data-message-id="kit-failure-message"]')`),false);
 });
 await step('streaming keeps animation nodes and keyboard focus connected while respecting explicit folds',async()=>{
  await evaluate(`ReadingPane.hide();state.currentConversationId='ui-conversation';showView('agent','对话');window.__live={id:'ui-live',role:'agent',text:'正在整理审阅结果。',live:true,at:Date.now(),activities:[{id:'think',kind:'summary',status:'running',text:'核对目录与修改内容。',at:Date.now()}]};currentConversation().messages.push(__live);renderConversation();window.__signal=document.querySelector('[data-message-id="ui-live"] [data-halaska-orb]');window.__summary=document.querySelector('[data-message-id="ui-live"] [data-progress-key="think"]>summary');__summary.focus();window.__paint=()=>{const next=document.createElement('div');renderMessage(__live,next);AgentProgress.patchLive(document.querySelector('[data-message-id="ui-live"]'),next.firstElementChild);};true;`);
  for(let i=0;i<12;i++)await evaluate(`__live.activities[0].text+=' 下一步';__paint();`);
  assert.equal(await evaluate(`__signal===document.querySelector('[data-message-id="ui-live"] [data-halaska-orb]')&&__signal.isConnected&&document.activeElement===__summary`),true);
  await click('[data-message-id="ui-live"] [data-progress-key="think"]>summary');await evaluate(`__live.activities[0].text+=' 保留折叠';__paint()`);await until(()=>evaluate(`!document.querySelector('[data-message-id="ui-live"] [data-progress-key="think"]').open`),'explicit fold animation completes after a live delta');assert.equal(await evaluate(`document.querySelector('[data-message-id="ui-live"] [data-progress-key="think"]').open`),false);
  await evaluate(`__live.activities[0].status='completed';__live.activities.push({id:'file',kind:'tool',name:'读取文件',text:'docs/plan.md',status:'running',at:Date.now()});__paint()`);assert.equal(await evaluate(`document.querySelector('[data-message-id="ui-live"] .agent-progress').dataset.progressPhase`),'tool');
  await shot('smoke-live-progress');await evaluate(`__live.live=false;__live.runStatus='completed';AgentProgress.finish(__live,'completed');__paint()`);assert.equal(await evaluate(`document.querySelector('[data-message-id="ui-live"] .agent-progress').open&&document.querySelector('[data-message-id="ui-live"] .agent-progress').contains(document.activeElement)`),true,'focused reading surface is held for this paint');await evaluate(`document.activeElement.blur();__paint()`);assert.equal(await evaluate(`document.querySelector('[data-message-id="ui-live"] .agent-progress').open`),false,'settled feed closes once focus leaves');
 });
 await step('reduced motion disables the indicator and persisted review data survives reload',async()=>{
  await evaluate(`__live.live=true;__live.activities[0].status='running';__paint();document.body.classList.add('reduce-motion')`);assert.equal(await evaluate(`document.querySelector('[data-message-id="ui-live"] .progress-activity').getAnimations({subtree:true}).filter(a=>a.playState==='running').length`),0);
  await evaluate(`__live.live=false;AgentProgress.finish(__live,'completed');save();`);await wait(1400);await win.reload();await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'reload');await evaluate(`openPreview('review','ui-review-run','ui-notes')`);assert.equal(await evaluate(`document.querySelector('[data-review-file="ui-notes"]').getAttribute('aria-pressed')`),'true');
 });
 const report={passed:passed.length,checks:passed,failures,qaStore:TEMP,modelCalls:0};fs.writeFileSync(path.join(OUT,'smoke-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));return failures.length?1:0;
}
run().then(code=>{clearTimeout(watchdog);win?.destroy();server?.kill();app.exit(code);}).catch(error=>{console.error(error);clearTimeout(watchdog);win?.destroy();server?.kill();app.exit(1);});
