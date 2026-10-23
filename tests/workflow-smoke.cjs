/* Run with Electron against the isolated QA service, never the user's workspace. */
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const qaURL = process.env.AW_QA_URL || 'http://127.0.0.1:18891/';
assert.equal(new URL(qaURL).hostname, '127.0.0.1');
assert.equal(new URL(qaURL).port, '18891', 'This smoke test is restricted to QA port 18891');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-workflow-profile-'));
app.setPath('userData', profile);
// Without AW_QA_URL, start the isolated QA service ourselves: real app/server.py, disposable store.
const qaServer = process.env.AW_QA_URL ? null : spawn('python3', ['-B', path.join(__dirname, '../app/server.py')], { cwd: path.join(__dirname, '..'), env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', AI_WORKSTATION_PORT: '18891', AI_WORKSTATION_DATA_DIR: path.join(profile, 'store') }, stdio: 'ignore' });
process.on('exit', () => { qaServer?.kill(); fs.rmSync(profile, { recursive: true, force: true }); });
// The local-rule workflow was removed (docs/READER_REGION_WIKI_COMPOSER_20260929.md): an unconfigured model now fails.
// A fixture model returns the plan instead, so routing, approval and persistence still run through the real host. No request leaves the page.
const fixtureModel = `document.querySelector('#provider').value='api';document.querySelector('#apiBase').value='https://qa-fixture.invalid/v1';document.querySelector('#model').value='qa-fixture-model';document.querySelector('#apiKey').value='qa-fixture-placeholder';ConversationModels.resolve=async config=>({...config});window.__qaPlans=[];AgentTransport.requestPlan=async options=>{const conversation=currentConversation(),id=conversation.attachments.at(-1),n=' · '+conversation.id.slice(-5),scope={workspace:'日常',projectId:window.__qaProjectId,sourceAttachmentIds:[id]};window.__qaPlans.push(options.input);return JSON.stringify({workspace:'日常',message:'已整理材料。',actions:[{type:'assign_attachment',attachmentId:id,projectId:window.__qaProjectId,workspace:'日常',folderPath:'原始资料'},{type:'create_knowledge_item',title:window.__qaTag+' 材料清单'+n,kind:'主笔记',content:'需要准备护照原件及照片；预约确认单需要打印。',...scope},{type:'create_knowledge_item',title:window.__qaTag+' 时间节点'+n,kind:'笔记',content:'提交日期以预约通知为准，提前完成材料核对。',...scope},{type:'create_task',title:window.__qaTag+' 准备签证材料',description:'核对护照、照片与预约确认单。',status:'todo',priority:'medium',dueAt:null,...scope}]});};window.confirm=()=>true;true`;
const setField = (id, value) => `(()=>{const e=document.getElementById(${JSON.stringify(id)});const proto=e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})();`;
const tag = `QA-SMOKE-${Date.now()}`;
let window;
const results = [];
const evaluate = code => window.webContents.executeJavaScript(code, true);
async function waitFor(code, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(code)) return;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out waiting: ${code}`);
}
async function step(label, fn) { await fn(); results.push(label); console.log('PASS', label); }
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = !/^https?:/.test(details.url) || details.url.startsWith('http://127.0.0.1:18891/');
    callback({ cancel: !allowed });
  });
  window = new BrowserWindow({ show: false, width: 1440, height: 920, webPreferences: { contextIsolation: true, sandbox: true } });
  const errors = [];
  window.webContents.on('console-message', (_, level, message) => { if (level >= 3 && !/404|ERR_BLOCKED_BY_CLIENT/.test(message)) errors.push(message.slice(0, 250)); });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(qaURL + '__health')).ok) break; } catch (_) {} await new Promise(resolve => setTimeout(resolve, 100)); }
  await window.loadURL(qaURL);
  await waitFor('typeof storageHydrated !== "undefined" && storageHydrated');
  await evaluate('WorkstationOnboarding.close();WorkspaceTour.close();state.ui.onboarding={version:1,status:"skipped"};state.ui.workspaceTour={version:1,status:"skipped"};true');
  await evaluate(`window.__qaTag = ${JSON.stringify(tag)}; window.__qaOldPermission = state.settings.permissions['日常']; window.__qaOldProvider = state.settings.provider; document.querySelector('#provider').value = 'api'; localStorage.setItem('workstation-provider', 'api'); document.querySelector('#apiBase').value = ''; document.querySelector('#model').value = ''; document.querySelector('#apiKey').value = ''; localStorage.removeItem('workstation-api-base'); localStorage.removeItem('workstation-api-model'); localStorage.removeItem('workstation-api-key'); state.settings.permissions['日常'] = 'auto'; window.confirm = () => true; true;`);
  let projectId, taskId, importId;
  await step('create isolated project through dialog', async () => {
    await evaluate(`document.querySelector('#newProject').click(); document.querySelector('#newProjectNameInput').value = __qaTag + ' 验收项目'; document.querySelector('#newProjectWorkspaceInput').value = '日常'; document.querySelector('#createProjectSubmit').click();`);
    projectId = await evaluate('state.currentProjectId'); assert.ok(projectId); assert.equal(await evaluate('state.projects.find(x=>x.id===state.currentProjectId)?.name'), tag+' 验收项目');
    // A new project has no chat to resume; its conversations section offers the real “新建对话” action.
    await evaluate(`window.__qaProjectId = state.currentProjectId; document.querySelector('#projectConversationActions button').click();`);
    await waitFor(`document.body.dataset.view==='agent'&&currentConversation()?.projectId===${JSON.stringify(projectId)}`);
    await evaluate(fixtureModel);
  });
  async function importText(name, body) {
    await evaluate(`document.querySelector('#chatAttach').click();`);
    await waitFor('!!document.querySelector("[data-add-action=attach-file]")');
    await evaluate('document.querySelector("[data-add-action=attach-file]").click()');
    await waitFor('document.querySelector("#importDialog").open');
    await evaluate(`const transfer = new DataTransfer(); transfer.items.add(new File([${JSON.stringify(body)}], ${JSON.stringify(name)}, {type:'text/plain'})); document.querySelector('#fileInput').files = transfer.files; document.querySelector('#fileInput').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#startImport').click();`);
    // The import window keeps its saved result open (docs/IMPORT_WORKSPACE_DELIVERY_20260930.md); the user closes it.
    await waitFor(`!importMaterials.busy&&currentConversation().attachments.some(id=>state.imports.some(item=>item.id===id&&item.name===${JSON.stringify(name)}))`);
    await evaluate(`[...document.querySelectorAll('#importDialog button')].find(b=>b.textContent.trim()==='关闭').click();`); await waitFor('!document.querySelector("#importDialog").open');
  }
  await step('import original text through parser and route the model plan into the project', async () => {
    await importText(`${tag}-签证材料.txt`, '材料清单\n需要准备护照原件及照片\n预约确认单需要打印\n注意提前完成材料核对\n提交日期以预约通知为准');
    importId = await evaluate('currentConversation().attachments.at(-1)');
    assert.ok(importId);
    await evaluate(`document.querySelector('#agentInput').value = __qaTag + ' 验收项目 整理材料并创建任务'; document.querySelector('#agentSend').click();`);
    await waitFor('!sendMessage.busy');
    const derived = await evaluate(`({status:state.agentRuns.at(-1).status, task:state.tasks.find(x=>x.projectId===${JSON.stringify(projectId)}), notes:state.notes.filter(x=>x.projectId===${JSON.stringify(projectId)}&&x.agentRunId===state.agentRuns.at(-1).id).map(x=>({id:x.id,sources:x.sourceAttachmentIds})), material:state.imports.find(x=>x.id===${JSON.stringify(importId)})?.projectId})`);
    assert.equal(derived.status, 'completed'); assert.equal(derived.material, projectId); assert.ok(await evaluate('__qaPlans.length') >= 1);
    assert.ok(derived.task && derived.notes.length >= 2); console.log('QA routing', JSON.stringify({projectId,importId,taskId:derived.task?.id,sources:derived.task?.sourceAttachmentIds})); assert.ok(derived.task.sourceAttachmentIds.includes(importId)); assert.ok(derived.notes.every(n=>n.sources.includes(importId))); taskId=derived.task.id;
    // The project tree now lists folders; the routed records appear in the project's sources library.
    await evaluate(`openProject(${JSON.stringify(projectId)}, 'knowledge');`);
    await waitFor(`document.querySelector('#project')?.dataset.workspaceSection==='knowledge'&&!!document.querySelector('#projectCollection')?.getClientRects().length`);
    const library = await evaluate(`({tree:document.querySelector('#projectTree').textContent,items:document.querySelector('#projectCollection').textContent})`);
    assert.match(library.tree, /原始资料/); assert.ok(library.items.includes(tag + '-签证材料.txt')); assert.ok(library.items.includes(tag + ' 材料清单'));
  });
  await step('task draft survives checklist add and saves completion', async () => {
    await evaluate(`openTask(${JSON.stringify(taskId)});`); await waitFor(`!!document.querySelector('#taskDialog[open] #taskTitleInput')`);
    await evaluate(setField('taskTitleInput', tag + ' 已编辑任务') + setField('taskDescriptionInput', 'QA 验收标准') + setField('taskStatusInput', 'done') + setField('taskDueInput', '2026-10-01') + setField('newChecklistItem', '检查原件'));
    await evaluate(`document.querySelector('#addChecklistItem').click();`); await waitFor(`[...document.querySelectorAll('#taskChecklist input')].some(e=>e.getAttribute('aria-label')==='检查原件')`);
    assert.equal(await evaluate("document.querySelector('#taskDescriptionInput').value"), 'QA 验收标准');
    await evaluate(`const checks=document.querySelectorAll('#taskChecklist input'); checks[checks.length-1].click(); document.querySelector('#saveTask').click();`);
    await waitFor(`!saveTaskDetails.busy&&state.tasks.find(x=>x.id===${JSON.stringify(taskId)})?.status==='done'`);
    const task = await evaluate(`state.tasks.find(x=>x.id===${JSON.stringify(taskId)})`);
    assert.equal(task.status, 'done');assert.ok(task.completedAt);assert.equal(task.dueAt, '2026-10-01'); assert.ok(task.checklist.at(-1).done);
    await evaluate(`showView('dashboard');`);
    assert.equal(await evaluate(`!!document.querySelector('#dashboardTasks [data-open-task="${taskId}"]')`), false);
  });
  await step('disk persistence and original preview survive reload', async () => {
    await evaluate('window.flushWorkspace()');
    const loaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve)); window.reload(); await loaded; await waitFor('typeof storageHydrated !== "undefined" && storageHydrated');
    const task = await evaluate(`state.tasks.find(x=>x.id===${JSON.stringify(taskId)})`);
    assert.ok(task);assert.equal(task.status, 'done');assert.ok(task.checklist.at(-1).done);
    await evaluate(`openImport(${JSON.stringify(importId)})`);
    await waitFor("!document.querySelector('#previewDialog').hidden");
    assert.ok(await evaluate("!document.querySelector('#previewDialog').hidden"));
    assert.equal(await evaluate('(()=>{const e=document.querySelector("#previewDialog");return e.tagName==="SECTION"&&!(e instanceof HTMLDialogElement)&&!("open" in e)&&!("close" in e)})()'),true);
    assert.ok(await evaluate("document.querySelector('#previewContent').textContent.includes('护照')"));
    assert.ok(await evaluate(`fileStoreGet(${JSON.stringify(importId)}).then(blob=>!!blob&&blob.size>0)`));
    await evaluate(`ReadingPane.hide(); window.__qaTag = ${JSON.stringify(tag)}; window.__qaProjectId = ${JSON.stringify(projectId)}; true;`); await evaluate(fixtureModel);
  });
  await step('approval reject writes no derived content or assignment', async () => {
    await evaluate("state.settings.permissions['日常']='approval'; newConversation('日常'); window.__qaRejectedConversation=state.currentConversationId;");
    await importText(`${tag}-待审批.txt`, '材料清单\n需要准备护照\n注意预约日期另行确认');
    const before = await evaluate('({projects:state.projects.length,tasks:state.tasks.length,notes:state.notes.length,importId:currentConversation().attachments.at(-1)})');
    await evaluate(`document.querySelector('#agentInput').value=${JSON.stringify(tag+' 验收项目 整理这份材料并创建待办')}; document.querySelector('#agentSend').click();`);
    await waitFor('!sendMessage.busy');
    assert.equal(await evaluate('state.agentRuns.at(-1).status'), 'awaiting-approval');
    const queued = await evaluate('({projects:state.projects.length,tasks:state.tasks.length,notes:state.notes.length})');
    assert.deepEqual(queued,{projects:before.projects,tasks:before.tasks,notes:before.notes});
    // Approval decisions now go through the plan review card.
    await waitFor(`!!document.querySelector('.plan-review-footer')`);
    await evaluate(`[...document.querySelectorAll('.plan-review-footer button')].find(b=>b.textContent.trim()==='拒绝执行').click();`);
    await waitFor(`state.agentRuns.at(-1).status==='rejected'`);
    assert.equal(await evaluate(`state.imports.find(x=>x.id===${JSON.stringify(before.importId)}).projectId || null`),null);
  });
  await step('project delete cascades and restore returns linked content', async () => {
    await evaluate(`openProject(${JSON.stringify(projectId)}); document.querySelector('#projectMenu').click(); document.querySelector('#manageDelete').click();`);
    assert.equal(await evaluate(`state.tasks.some(x=>x.id===${JSON.stringify(taskId)})`),false);
    assert.equal(await evaluate(`state.imports.some(x=>x.id===${JSON.stringify(importId)})`),false);
    await evaluate("showView('daily');");
    assert.equal(await evaluate(`document.querySelector('#daily').textContent.includes(${JSON.stringify(tag+' 已编辑任务')})`),false);
    await evaluate(`showView('trash'); const entry=state.trash.find(x=>x.type==='project'&&x.data.projects.some(p=>p.id===${JSON.stringify(projectId)})); document.querySelector('[data-restore-trash="'+entry.id+'"]').click();`);
    assert.equal(await evaluate(`state.tasks.find(x=>x.id===${JSON.stringify(taskId)})?.projectId`),projectId);
    assert.ok(await evaluate(`state.notes.some(x=>x.projectId===${JSON.stringify(projectId)}&&x.sourceAttachmentIds.includes(${JSON.stringify(importId)}))`));
  });
  await step('task delete and restore synchronize dashboard', async () => {
    await evaluate(`toggleTaskStatus(${JSON.stringify(taskId)}); showView('dashboard');`);
    assert.ok(await evaluate(`document.querySelector('#dashboardTasks [data-open-task="${taskId}"]')!==null`));
    await evaluate(`openTask(${JSON.stringify(taskId)}); document.querySelector('#deleteTask').click();`);
    assert.equal(await evaluate(`!!document.querySelector('#dashboardTasks [data-open-task="${taskId}"]')`), false);
    await evaluate(`showView('trash'); restoreTrash(state.trash.findIndex(x=>x.type==='content'&&x.data.tasks.some(t=>t.id===${JSON.stringify(taskId)})));`);
    assert.ok(await evaluate(`state.tasks.some(x=>x.id===${JSON.stringify(taskId)})`));
  });
  // Keep fixtures recoverable and out of ordinary working surfaces.
  await evaluate(`openProject(${JSON.stringify(projectId)}); document.querySelector('#projectMenu').click(); document.querySelector('#manageArchive').click(); state.settings.permissions['日常']='auto'; save(); window.flushWorkspace();`);
  console.log(JSON.stringify({tag,passed:results.length,consoleErrors:errors},null,2));
  if(errors.length)throw new Error('Unexpected renderer errors');
  app.exit(0);
}).catch(async error=>{try { await evaluate('window.flushWorkspace()'); } catch (_) {} console.error('SMOKE FAILED',error.message);console.log(JSON.stringify({tag,passed:results},null,2));app.exit(1);});
