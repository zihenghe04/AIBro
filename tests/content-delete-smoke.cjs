/* Run with the installed Electron binary. Uses only a new temporary store on 18892.
   Models/external requests are blocked. All destructive confirmations are
   exercised through real rendered dialogs, never by replacing window.confirm. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const http = require('node:http');
const sockets = require('node:net');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..'), PORT = 18892, ORIGIN = `http://127.0.0.1:${PORT}`;
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-content-delete-smoke-'));
const STORE = path.join(TEMP, 'store'); fs.mkdirSync(STORE); fs.mkdirSync(path.join(TEMP,'profile'));
const LOCAL = path.join(TEMP, 'user-project'); fs.mkdirSync(LOCAL); fs.writeFileSync(path.join(LOCAL,'keep.txt'),'USER_ORIGINAL_MUST_SURVIVE');
app.setPath('userData', path.join(TEMP,'profile'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = route => new Promise((resolve,reject)=>{http.get(ORIGIN+route,response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,body:Buffer.concat(chunks)}));}).on('error',reject);});
async function until(check, label, timeout = 12000) { const start=Date.now();while(Date.now()-start<timeout){if(await check())return;await wait(60);}throw new Error(`Timed out: ${label}`); }
const groups = [{route:'daily',workspace:'日常'},{route:'courses',workspace:'课程'},{route:'research',workspace:'科研'}].map(group=>({...group,project:`qa_${group.route}_project`,token:`QA_DELETE_${group.route}`,task:`qa_${group.route}_task`,note:`qa_${group.route}_note`,import:`qa_${group.route}_import`,paper:`qa_${group.route}_paper`}));
let server, win;
async function run(){
  await new Promise((resolve,reject)=>{const probe=sockets.createServer();probe.once('error',()=>reject(new Error('Port 18892 already belongs to another process; refusing to reuse it.')));probe.listen(PORT,'127.0.0.1',()=>probe.close(resolve));});
  const log=fs.openSync(path.join(TEMP,'server.log'),'a');
  server=spawn(process.env.PYTHON||'python3',[path.join(ROOT,'server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(PORT),AI_WORKSTATION_DATA_DIR:STORE},stdio:['ignore',log,log]});
  await until(async()=>{try{return(await request('/__health')).status===200;}catch{return false;}},'isolated server');
  await app.whenReady();
  win=new BrowserWindow({show:false,width:1440,height:960,webPreferences:{sandbox:true,backgroundThrottling:false}});
  const rendererErrors=[],forbidden=[],purgeRequests=[];
  win.webContents.on('console-message',(_event,level,message)=>{if(level>=3)rendererErrors.push(message);});
  win.webContents.session.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{
    const url=new URL(details.url);
    if(url.origin===ORIGIN&&url.pathname==='/__trash/purge'&&details.method==='POST')purgeRequests.push(details.id);
    const blocked=(url.protocol==='http:'||url.protocol==='https:')&&(url.origin!==ORIGIN||url.pathname.startsWith('/__proxy')||url.pathname==='/__codex/respond'||url.pathname.startsWith('/__auth/'));
    if(blocked)forbidden.push(details.url);
    callback({cancel:blocked});
  });
  const evaluate=script=>win.webContents.executeJavaScript(script);
  const click=async selector=>{
    const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control: '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(!r.width||!r.height||e.disabled)throw Error('Control unavailable: '+${JSON.stringify(selector)});return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});await wait(120);
  };
  const settled=async()=>{assert.notEqual(await evaluate('flushWorkspace()'),false,'persist workspace');await until(()=>evaluate('!serverSaveInFlight && !serverSaveQueued && !state._pendingLocalSave'),'autosave');assert.equal(await evaluate('serverConflict'),false,'no CAS conflict');};
  const search=async(token,count)=>{await evaluate(`openSearchDialog();document.querySelector('#globalSearchInput').value=${JSON.stringify(token)};document.querySelector('#globalSearchInput').dispatchEvent(new Event('input',{bubbles:true}))`);assert.equal(await evaluate(`document.querySelectorAll('#searchResults [data-search-result]').length`),count,'global search count');await evaluate(`document.querySelector('#searchDialog').close()`);};
  const space=async group=>{await click(`[data-view="${group.route}"]`);await click(`#${group.route} [data-space-tab="content"]`);};
  const snapshot=async(name,width,theme)=>{win.setSize(width,960);await evaluate(`state.ui.theme=${JSON.stringify(theme)};applyUiPreferences()`);await wait(300);fs.writeFileSync(path.join(TEMP,name),(await win.webContents.capturePage()).toPNG());};
  const confirmPurge=async(ids)=>{
    await until(()=>evaluate(`!!document.querySelector('#trashPurgeDialog[open]')`),'permanent-delete confirmation');
    assert.match(await evaluate(`document.querySelector('#trashPurgeTitle').textContent`),new RegExp(ids.length+' 条'));
    const requests=purgeRequests.length;await click('#confirmTrashPurge');
    await until(()=>evaluate(`!purgeTrash.busy&&!purgeTrash.confirming&&${JSON.stringify(ids)}.every(id=>!state.trash.some(entry=>entry.id===id))`),'confirmed purge result');
    await settled();assert.equal(purgeRequests.length,requests+1,'confirmation must send exactly one atomic purge request');
  };
  const cancelPurge=async(count)=>{
    await until(()=>evaluate(`!!document.querySelector('#trashPurgeDialog[open]')`),'cancelable purge dialog');
    assert.match(await evaluate(`document.querySelector('#trashPurgeTitle').textContent`),new RegExp(count+' 条'));
    const requests=purgeRequests.length,before=await evaluate('JSON.stringify(state.trash)');
    await click('#trashPurgeDialog .secondary');await until(()=>evaluate('!purgeTrash.confirming'),'cancel purge');
    assert.equal(await evaluate('JSON.stringify(state.trash)'),before,'cancel preserves all trash records');assert.equal(purgeRequests.length,requests,'cancel must not contact purge endpoint');
  };
  const deleteOne=async(group,type,id)=>{await space(group);await click(`#${group.route}Collection [data-cui-key="${type}:${id}"] [data-cui-delete]`);await click('#confirmContentDelete');await settled();return evaluate(`state.trash.find(entry=>entry.data?.[${JSON.stringify({task:'tasks',note:'notes',import:'imports'}[type])}]?.some(item=>item.id===${JSON.stringify(id)})).id`);};
  await win.loadURL(ORIGIN);await until(()=>evaluate('storageHydrated'),'hydrate');
  await evaluate(`(()=>{const groups=${JSON.stringify(groups)},now=Date.now();for(const g of groups){state.projects.push({id:g.project,name:'验收项目 · '+g.workspace,workspace:g.workspace,createdAt:now,localFolder:{id:'local_qa',rootId:'root_qa',name:'原始代码',path:${JSON.stringify(LOCAL)}}});state.tasks.push({id:g.task,title:g.token+' 任务',projectId:g.project,workspace:g.workspace,status:'done',completedAt:now,sourceAttachmentIds:[g.import],createdAt:now});state.notes.push({id:g.note,title:g.token+' 笔记',projectId:g.project,workspace:g.workspace,content:'保留人工分析内容',userEdited:true,paperId:g.paper,sourceAttachmentIds:[g.import],createdAt:now});state.imports.push({id:g.import,name:g.token+' 原件.txt',projectId:g.project,workspace:g.workspace,content:'来源正文',mimeType:'text/plain',parser:'local',createdAt:now});state.papers.push({id:g.paper,title:g.token+' 论文',projectId:g.project,workspace:g.workspace,noteId:g.note,year:'2026',authors:['QA Author'],structured:{tldr:'QA evidence'},sourceAttachmentIds:[g.import],createdAt:now});}normalizeStateShape(state);save();renderAll()})()`);
  for(const group of groups)assert.equal(await evaluate(`(async()=>{const r=await fetch('/__files/${group.import}',{method:'POST',headers:{'Content-Type':'text/plain','X-Filename':'source.txt'},body:'ORIGINAL_${group.import}'});return r.status})()`),200);
  await settled();
  const initial=JSON.parse((await request('/__state')).body);assert.equal(initial.tasks.length,3);assert.equal(initial.papers.length,3);
  const vault=path.join(STORE,'vault');assert.ok(fs.existsSync(vault),'paper notes materialized in vault');
  for(const group of groups){
    await space(group);assert.equal(await evaluate(`document.querySelectorAll('#${group.route}Collection [data-cui-key]').length`),4);
    await search(group.token,4);
    await evaluate(`openProject(${JSON.stringify(group.project)})`);await click('[data-project-tab="knowledge"]');
    assert.equal(await evaluate(`document.querySelectorAll('#projectCollection [data-cui-key]').length`),4);
    await space(group);await click(`#${group.route}Collection [data-cui-all]`);
    assert.equal(await evaluate(`!!document.querySelector('#${group.route}Collection [data-cui-reopen]')`),true,'completed tasks can reopen');
    await click(`#${group.route}Collection [data-cui-delete-selected]`);await until(()=>evaluate(`!!document.querySelector('#contentDeleteDialog[open]')`),'content confirmation');
    assert.match(await evaluate(`document.querySelector('#contentDeleteTitle').textContent`),/4 项/);
    if(group.route==='daily')await snapshot('qa-content-delete-confirm-light.png',1440,'light');
    if(group.route==='research')await snapshot('qa-content-delete-confirm-dark.png',650,'dark');
    const dialogLayout=await evaluate(`(()=>{const d=document.querySelector('#contentDeleteDialog'),r=d.getBoundingClientRect(),b=document.querySelector('#confirmContentDelete').getBoundingClientRect();return{overflow:d.scrollWidth>d.clientWidth,visible:b.left>=0&&b.right<=innerWidth&&b.bottom<=innerHeight}})()`);assert.equal(dialogLayout.overflow,false);assert.equal(dialogLayout.visible,true);
    await click('#contentDeleteDialog .secondary');assert.equal(await evaluate(`document.querySelectorAll('#${group.route}Collection [data-cui-check]:checked').length`),4,'cancel keeps selection');
    await click(`#${group.route}Collection [data-cui-delete-selected]`);await click('#confirmContentDelete');await settled();
    assert.equal(await evaluate(`document.querySelectorAll('#${group.route}Collection [data-cui-key]').length`),0,'removed from collection');await search(group.token,0);
    await evaluate(`openProject(${JSON.stringify(group.project)})`);await click('[data-project-tab="knowledge"]');assert.equal(await evaluate(`document.querySelectorAll('#projectCollection [data-cui-key]').length`),0);
    const other=groups.filter(item=>item.route!==group.route);for(const item of other)assert.equal(await evaluate(`state.tasks.some(t=>t.id===${JSON.stringify(item.task)})`),true,'other spaces preserved');
    assert.equal((await request(`/__files/${group.import}`)).body.toString(),`ORIGINAL_${group.import}`,'soft delete keeps blob');
    await evaluate(`showView('trash','回收站')`);const trashId=await evaluate(`state.trash.find(e=>e.data?.tasks?.some(t=>t.id===${JSON.stringify(group.task)})).id`);await click(`[data-restore-trash="${trashId}"]`);await settled();
    await space(group);assert.equal(await evaluate(`document.querySelectorAll('#${group.route}Collection [data-cui-key]').length`),4);await search(group.token,4);
    console.log('PASS mixed delete/cancel/restore and scope/search/project consistency:',group.workspace);
  }
  win.setSize(1440,960);await settled();await win.loadURL(ORIGIN);await until(()=>evaluate('storageHydrated'),'reload restored workspace');
  for(const group of groups)assert.equal(await evaluate(`state.imports.some(i=>i.id===${JSON.stringify(group.import)})&&state.papers.some(i=>i.id===${JSON.stringify(group.paper)})`),true);
  console.log('PASS restore survives reload');
  // Delete one original while keeping the task/note/paper that cite it. Permanent
  // deletion may remove the trash record, but referenced source bytes must remain.
  const daily=groups[0];await space(daily);await click(`#dailyCollection [data-cui-key="import:${daily.import}"] [data-cui-delete]`);await click('#confirmContentDelete');await settled();
  let trashId=await evaluate(`state.trash.find(e=>e.data?.imports?.some(i=>i.id===${JSON.stringify(daily.import)})).id`);
  await evaluate(`window.__qaTrashDelegation=[];document.addEventListener('click',event=>{if(event.target.closest('[data-restore-trash],[data-purge-trash]'))window.__qaTrashDelegation.push(event.target.textContent)});showView('trash','回收站')`);await click(`[data-purge-trash="${trashId}"]`);await confirmPurge([trashId]);
  assert.equal(await evaluate(`state.trash.some(e=>e.id===${JSON.stringify(trashId)})`),false);assert.equal((await request(`/__files/${daily.import}`)).status,200,'still referenced original retained');
  console.log('PASS permanent deletion retains referenced original');
  // Full independent bundle can release its managed blob after explicit purge.
  const research=groups[2];await space(research);await click('#researchCollection [data-cui-all]');await click('#researchCollection [data-cui-delete-selected]');await click('#confirmContentDelete');await settled();
  trashId=await evaluate(`state.trash.find(e=>e.data?.imports?.some(i=>i.id===${JSON.stringify(research.import)})).id`);await evaluate(`showView('trash','回收站')`);await click(`[data-purge-trash="${trashId}"]`);await confirmPurge([trashId]);
  assert.equal(await evaluate(`state.trash.some(e=>e.id===${JSON.stringify(trashId)})`),false);assert.equal((await request(`/__files/${research.import}`)).status,404,'unreferenced managed blob removed');
  assert.equal(fs.readFileSync(path.join(LOCAL,'keep.txt'),'utf8'),'USER_ORIGINAL_MUST_SURVIVE');assert.ok(fs.existsSync(vault),'research vault preserved');

  // Build three genuine trash bundles through the collection's soft-delete UI.
  // Restoring the note before purging the other two reintroduces a live source
  // reference, which must protect the original during the same atomic batch.
  const batch={source:'qa_batch_source',note:'qa_batch_restored_note',task:'qa_batch_task'};
  await evaluate(`(()=>{const now=Date.now(),projectId=${JSON.stringify(daily.project)};state.imports.push({id:${JSON.stringify(batch.source)},name:'QA_BATCH_SOURCE.txt',projectId,workspace:'日常',mimeType:'text/plain',content:'批量原件',createdAt:now});state.notes.push({id:${JSON.stringify(batch.note)},title:'QA_BATCH_RESTORE_NOTE',projectId,workspace:'日常',content:'恢复后继续引用原件',sourceAttachmentIds:[${JSON.stringify(batch.source)}],createdAt:now});state.tasks.push({id:${JSON.stringify(batch.task)},title:'QA_BATCH_TASK',projectId,workspace:'日常',status:'todo',createdAt:now});normalizeStateShape(state);save();renderAll()})()`);
  assert.equal(await evaluate(`(async()=>{const r=await fetch('/__files/${batch.source}',{method:'POST',headers:{'Content-Type':'text/plain','X-Filename':'batch.txt'},body:'BATCH_ORIGINAL_KEEP'});return r.status})()`),200);await settled();
  const sourceTrash=await deleteOne(daily,'import',batch.source),noteTrash=await deleteOne(daily,'note',batch.note),taskTrash=await deleteOne(daily,'task',batch.task);
  await evaluate(`showView('trash','回收站')`);assert.equal(await evaluate('state.trash.length'),3);assert.equal(await evaluate(`document.querySelectorAll('#trashList [data-trash-id]').length`),3);
  await click(`[data-trash-select="${sourceTrash}"]`);await click(`[data-trash-select="${taskTrash}"]`);await click('#trashDeleteSelected');await cancelPurge(2);
  assert.equal(await evaluate(`document.querySelectorAll('[data-trash-select]:checked').length`),2,'batch cancel preserves selection');
  await click('#trashEmpty');await cancelPurge(3);assert.equal(await evaluate(`document.querySelectorAll('[data-trash-select]:checked').length`),2,'empty cancel preserves selection');
  await click(`[data-restore-trash="${noteTrash}"]`);await settled();
  assert.equal(await evaluate(`state.notes.filter(item=>item.id===${JSON.stringify(batch.note)}).length`),1,'row restore runs once');
  assert.equal(await evaluate('state.trash.length'),2);assert.equal(await evaluate(`document.querySelectorAll('[data-trash-select]:checked').length`),2,'other selection survives restore');
  await click('#trashDeleteSelected');await confirmPurge([sourceTrash,taskTrash]);
  assert.equal(await evaluate('state.trash.length'),0);assert.equal((await request(`/__files/${batch.source}`)).body.toString(),'BATCH_ORIGINAL_KEEP','restored note protects source in batch purge');
  assert.deepEqual(await evaluate('window.__qaTrashDelegation'),[],'row actions must stop legacy document delegation');
  console.log('PASS three real bundles: batch/clear cancellation, restore with selection retention, atomic batch and live-source protection');

  // Clear three independent entries through the distinct clear-all action.
  const emptyTasks=['qa_empty_one','qa_empty_two','qa_empty_three'];
  await evaluate(`(()=>{for(const id of ${JSON.stringify(emptyTasks)})state.tasks.push({id,title:id,workspace:'日常',projectId:${JSON.stringify(daily.project)},status:'todo',createdAt:Date.now()});normalizeStateShape(state);save();renderAll()})()`);await settled();
  const emptyTrash=[];for(const id of emptyTasks)emptyTrash.push(await deleteOne(daily,'task',id));
  await evaluate(`showView('trash','回收站')`);await click('#trashSelectAll');assert.equal(await evaluate(`document.querySelectorAll('[data-trash-select]:checked').length`),3);
  await click('#trashClearSelection');assert.equal(await evaluate(`document.querySelectorAll('[data-trash-select]:checked').length`),0);assert.equal(await evaluate(`document.querySelector('#trashDeleteSelected').disabled`),true);
  await click('#trashEmpty');await cancelPurge(3);await click('#trashEmpty');await confirmPurge(emptyTrash);
  assert.equal(await evaluate('state.trash.length'),0);assert.equal(await evaluate(`document.querySelector('#trashToolbar').hidden`),true);assert.match(await evaluate(`document.querySelector('#trashList').textContent`),/回收站为空/);
  const emptyRequests=purgeRequests.length;await evaluate('purgeTrash([])');assert.equal(purgeRequests.length,emptyRequests);assert.equal(await evaluate(`!!document.querySelector('#trashPurgeDialog[open]')`),false,'empty purge opens no dialog');
  await win.loadURL(ORIGIN);await until(()=>evaluate('storageHydrated'),'reload purged workspace');assert.equal(await evaluate(`state.papers.some(p=>p.id===${JSON.stringify(research.paper)})`),false);assert.equal((await request(`/__files/${research.import}`)).status,404);
  assert.equal(await evaluate('state.trash.length'),0);assert.equal(await evaluate(`state.notes.filter(item=>item.id===${JSON.stringify(batch.note)}).length`),1);assert.equal(await evaluate(`${JSON.stringify(emptyTasks)}.some(id=>state.tasks.some(item=>item.id===id))`),false);assert.equal((await request(`/__files/${batch.source}`)).body.toString(),'BATCH_ORIGINAL_KEEP');
  console.log('PASS clear-all cancellation/confirmation, empty state, and restored source references survive reload');
  await space(groups[1]);for(const [width,theme] of [[1440,'light'],[650,'dark']]){win.setSize(width,960);await evaluate(`state.ui.theme=${JSON.stringify(theme)};applyUiPreferences()`);await wait(200);const layout=await evaluate(`(()=>{const t=document.querySelector('#coursesCollection .collection-table'),r=t.getBoundingClientRect();return{overflow:t.scrollWidth>t.clientWidth,visible:[...t.querySelectorAll('[data-cui-delete]')].every(b=>{const x=b.getBoundingClientRect();return x.left>=r.left&&x.right<=r.right})}})()`);assert.equal(layout.overflow,false);assert.equal(layout.visible,true);}
  assert.deepEqual(forbidden,[],'no model or external request attempted');assert.deepEqual(rendererErrors,[],'no renderer errors');
  console.log('PASS purge persistence, original local folder/vault retention, full-app 1440/650 layout; no external/model calls or renderer errors.');
  console.log('QA store:',TEMP);
}
run().then(()=>{win?.destroy();server?.kill('SIGTERM');app.quit();}).catch(error=>{console.error(error);console.error('QA store retained for diagnosis:',TEMP);win?.destroy();server?.kill('SIGTERM');app.exit(1);});
