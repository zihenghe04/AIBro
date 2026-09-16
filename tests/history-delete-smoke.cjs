/* Native Electron clicks against a self-managed temporary store on port 18893.
   No real workspace, account, or model is used. Logs and QA screenshots remain for diagnosis. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..'), PORT = 18893, ORIGIN = `http://127.0.0.1:${PORT}`;
for (const name of ['attachment-context.js', 'run-history.js', 'run-history-actions.css']) assert.ok(fs.existsSync(path.join(ROOT,name)), `Required app asset is not ready: ${name}`);
const TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aw-history-delete-smoke-')), STORE=path.join(TEMP,'store');
fs.mkdirSync(STORE); fs.mkdirSync(path.join(TEMP,'profile')); app.setPath('userData',path.join(TEMP,'profile'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const request=route=>new Promise((resolve,reject)=>{http.get(ORIGIN+route,response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,body:Buffer.concat(chunks)}));}).on('error',reject);});
async function until(check,label,timeout=15000){const start=Date.now();while(Date.now()-start<timeout){if(await check())return;await wait(60);}throw new Error(`Timed out: ${label}`);}
let server,win;const passed=[];
const watchdog=setTimeout(()=>{console.error('SMOKE timed out; QA store:',TEMP);win?.destroy();server?.kill('SIGTERM');app.exit(1);},90000);
async function run(){
  await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',()=>reject(new Error('Port 18893 is occupied; refusing to connect to an existing service.')));probe.listen(PORT,'127.0.0.1',()=>probe.close(resolve));});
  const log=fs.openSync(path.join(TEMP,'server.log'),'a');
  server=spawn(process.env.PYTHON||'python3',[path.join(ROOT,'server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(PORT),AI_WORKSTATION_DATA_DIR:STORE},stdio:['ignore',log,log]});
  let serverError;server.on('error',error=>{serverError=error;});
  await until(async()=>{if(serverError)throw serverError;if(server.exitCode!==null)throw Error('QA server exited; see '+TEMP);try{return(await request('/__health')).status===200;}catch{return false;}},'temporary server');
  await app.whenReady();win=new BrowserWindow({show:false,width:1440,height:960,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
  const errors=[],forbidden=[];
  win.webContents.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message);});
  win.webContents.session.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{
    const url=new URL(details.url),blocked=['http:','https:'].includes(url.protocol)&&(url.origin!==ORIGIN||url.pathname.startsWith('/__proxy')||url.pathname==='/__codex/respond'||/^\/__auth\/(login|logout)/.test(url.pathname)||url.pathname==='/__cloud/connect');
    if(blocked)forbidden.push(details.url);callback({cancel:blocked});
  });
  const evaluate=code=>win.webContents.executeJavaScript(code,true);
  async function click(selector){
    const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control: '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2),hit=document.elementFromPoint(x,y);if(!r.width||!r.height||e.disabled||!(hit===e||e.contains(hit)))throw Error('Control disabled, hidden, or covered: '+${JSON.stringify(selector)});return{x,y}})()`);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});await wait(100);
  }
  async function input(selector,value){await click(selector);await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}))})()`);await wait(100);}
  async function settled(){assert.notEqual(await evaluate('flushWorkspace()'),false,'local persistence');await until(()=>evaluate('!serverSaveInFlight&&!serverSaveQueued&&!state._pendingLocalSave'),'autosave complete');assert.equal(await evaluate('serverConflict'),false);}
  async function step(label,fn){await fn();passed.push(label);console.log('PASS',label);}
  const preserved=()=>evaluate(`JSON.stringify({projects:state.projects,tasks:state.tasks,notes:state.notes,imports:state.imports,papers:state.papers,conversations:state.conversations,attachments:state.attachments,links:state.links,trash:state.trash})`);
  await win.loadURL(ORIGIN);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'workspace hydration');
  assert.equal(await evaluate(`!!document.querySelector('link[href="run-history-actions.css"]')`),true,'history action stylesheet linked');
  await evaluate(`(()=>{const now=Date.now(),project={id:'qa_history_project',name:'科研资料整理',workspace:'科研',createdAt:now};state.projects.push(project);state.imports.push({id:'qa_history_import',name:'持久化原件.txt',projectId:project.id,workspace:'科研',content:'保留原始资料正文',mimeType:'text/plain',createdAt:now});state.tasks.push({id:'qa_history_task',title:'复核论文实验',projectId:project.id,workspace:'科研',status:'done',completedAt:now,sourceAttachmentIds:['qa_history_import'],createdAt:now});state.notes.push({id:'qa_history_note',title:'人工阅读笔记',projectId:project.id,workspace:'科研',content:'已审核结论，删除执行日志也必须保留。',sourceAttachmentIds:['qa_history_import'],createdAt:now,userEdited:true});state.conversations.push({id:'qa_history_conversation',title:'论文分析对话',projectId:project.id,workspace:'科研',createdAt:now,attachments:['qa_history_import'],messages:[{id:'qa_history_user',role:'user',text:'整理这篇论文',at:now},{id:'qa_history_assistant',role:'assistant',text:'已整理材料并保留分析笔记。',at:now+1,runId:'qa_history_single',steps:[{status:'done',text:'读取资料'}],results:[{type:'note',id:'qa_history_note'}]}]});state.currentConversationId='qa_history_conversation';const defs=[['single','单条验收 · 分析控制理论论文','completed'],['batch1','筛选验收 · 归纳核心方法','completed'],['batch2','筛选验收 · 本地整理资料','completed-local'],['batch3','筛选验收 · 记录失败原因','failed'],['keep','保留验收 · 已审核分析','completed'],['busy','筛选验收 · 正在读取原文','running'],['approval','筛选验收 · 等待写入审批','awaiting-approval'],['unknown','保留验收 · 旧版未记录状态','legacy']];state.agentRuns=defs.map(([id,goal,status],index)=>({id:'qa_history_'+id,goal,status,conversationId:'qa_history_conversation',projectId:project.id,workspace:'科研',startedAt:now-index*1000,finishedAt:['running','awaiting-approval','legacy'].includes(status)?null:now+2000,steps:[{status:'done',text:'读取原始材料并定位来源页码'},{status:status==='running'?'running':'done',text:'汇总核心方法、实验比较与后续研究方向'}],modelConfig:{provider:'api',model:'QA 模型（不调用）',effort:'high'},results:[{type:'task',id:'qa_history_task',text:'复核论文实验'},{type:'note',id:'qa_history_note',text:'人工阅读笔记'}]}));normalizeStateShape(state);repairRelationships();save();renderAll()})()`);
  await settled();const baseline=await preserved();
  await step('native single-delete confirmation can cancel, then delete only the selected log',async()=>{
    await click('#historyBtn');await click('[data-run-id="qa_history_single"]');await click('#runHistoryDeleteOne');
    assert.equal(await evaluate(`document.querySelector('#runHistoryDeleteDialog').open`),true);assert.match(await evaluate(`document.querySelector('#runHistoryDeleteDialog').textContent`),/无法恢复/);
    await click('#runHistoryDeleteCancel');assert.equal(await evaluate(`state.agentRuns.some(r=>r.id==='qa_history_single')`),true);assert.equal(await preserved(),baseline);
    await click('#runHistoryDeleteOne');await click('#runHistoryDeleteConfirm');await until(()=>evaluate(`!document.querySelector('#runHistoryDeleteDialog').open`),'confirmed deletion');await settled();
    assert.equal(await evaluate(`state.agentRuns.some(r=>r.id==='qa_history_single')`),false);assert.equal(await preserved(),baseline);
  });
  await step('native filtered bulk selection protects running and approval logs and preserves unrelated results',async()=>{
    await input('#runHistorySearch','筛选验收');assert.equal(await evaluate(`document.querySelectorAll('#runHistoryDialog [data-run-id]').length`),5);
    for(const id of ['busy','approval'])assert.equal(await evaluate(`document.querySelector('[data-select-run="qa_history_${id}"]').disabled`),true);
    await click('#runHistorySelectAll');assert.match(await evaluate(`document.querySelector('#runHistoryDeleteSelected').textContent`),/3/);
    await click('#runHistoryDeleteSelected');assert.match(await evaluate(`document.querySelector('#runHistoryDeleteTitle').textContent`),/3 条/);await click('#runHistoryDeleteCancel');
    assert.equal(await evaluate(`document.querySelectorAll('#runHistoryDialog [data-select-run]:checked').length`),3);
    await click('#runHistoryDeleteSelected');await click('#runHistoryDeleteConfirm');await until(()=>evaluate(`!document.querySelector('#runHistoryDeleteDialog').open`),'bulk deletion');await settled();
    assert.deepEqual(await evaluate(`state.agentRuns.map(r=>r.id)`),['qa_history_keep','qa_history_busy','qa_history_approval','qa_history_unknown']);assert.equal(await preserved(),baseline);
    await click('[data-run-id="qa_history_busy"]');assert.equal(await evaluate(`document.querySelector('#runHistoryDeleteOne').disabled`),true);
  });
  await step('deletion survives full reload and SQLite/JSON persistence; chats, tasks, notes and sources remain identical',async()=>{
    await win.loadURL(ORIGIN);await until(()=>evaluate('storageHydrated'),'reload');
    assert.deepEqual(await evaluate(`state.agentRuns.map(r=>r.id)`),['qa_history_keep','qa_history_busy','qa_history_approval','qa_history_unknown']);assert.equal(await preserved(),baseline);
    const disk=JSON.parse((await request('/__state')).body);assert.equal(disk.agentRuns.length,4);assert.ok(fs.existsSync(path.join(STORE,'workspace.sqlite3')));assert.ok(fs.existsSync(path.join(STORE,'workspace.json')));
  });
  await step('light/dark desktop and 650px layouts keep bulk controls and confirmation within the viewport',async()=>{
    fs.mkdirSync(path.join(ROOT,'design'),{recursive:true});
    for(const [width,theme] of [[1440,'light'],[1440,'dark'],[650,'light'],[650,'dark']]){
      win.setSize(width,960);await evaluate(`state.ui.theme=${JSON.stringify(theme)};applyUiPreferences()`);await wait(180);await click('#historyBtn');
      const layout=await evaluate(`(()=>{const nodes=[...document.querySelectorAll('#runHistoryDialog,.run-history-bulk,.run-history-controls,.run-history-list,.run-history-detail')].filter(e=>e.getBoundingClientRect().width);return nodes.map(e=>({name:e.className,width:e.clientWidth,scroll:e.scrollWidth,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right}))})()`);
      for(const box of layout){assert.ok(box.scroll<=box.width+1,`${width}/${theme} ${box.name} horizontal overflow: ${JSON.stringify(box)}`);assert.ok(box.left>=0&&box.right<=width,`${box.name} outside viewport`);}
      await click('#runHistorySelectAll');assert.match(await evaluate(`document.querySelector('#runHistoryDeleteSelected').textContent`),/1/);
      fs.writeFileSync(path.join(ROOT,'design',`qa-history-delete-list-${theme}-${width}.png`),(await win.webContents.capturePage()).toPNG());
      await click('#runHistoryDeleteSelected');await wait(180);
      const confirm=await evaluate(`(()=>{const e=document.querySelector('#runHistoryDeleteDialog'),r=e.getBoundingClientRect(),b=document.querySelector('#runHistoryDeleteConfirm').getBoundingClientRect();return{overflow:e.scrollWidth>e.clientWidth,left:r.left,right:r.right,buttonLeft:b.left,buttonRight:b.right,bottom:b.bottom,height:innerHeight}})()`);
      assert.equal(confirm.overflow,false);assert.ok(confirm.left>=0&&confirm.right<=width&&confirm.buttonLeft>=0&&confirm.buttonRight<=width&&confirm.bottom<=confirm.height,'confirmation controls accessible');
      fs.writeFileSync(path.join(ROOT,'design',`qa-history-delete-confirm-${theme}-${width}.png`),(await win.webContents.capturePage()).toPNG());
      await click('#runHistoryDeleteCancel');await click('[data-run-id="qa_history_keep"]');
      await click('#runHistoryDeleteOne');assert.equal(await evaluate(`document.querySelector('#runHistoryDeleteDialog').open`),true);await click('#runHistoryDeleteCancel');
      await click('#runHistoryDialog .run-history-close');
    }
    assert.equal(await preserved(),baseline);assert.deepEqual(forbidden,[],'no model/account/external request');assert.deepEqual(errors,[],'no renderer errors');
  });
  console.log(JSON.stringify({passed:passed.length,qaStore:TEMP,screenshots:'design/qa-history-delete-*.png',modelCalls:0},null,2));
}
function finish(code){clearTimeout(watchdog);win?.destroy();server?.kill('SIGTERM');if(code)app.exit(code);else app.quit();}
run().then(()=>finish(0)).catch(error=>{console.error(error);console.error('QA store retained:',TEMP);finish(1);});
