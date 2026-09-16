/* Run with Electron against the isolated QA service, never the user's workspace. */
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const qaURL = process.env.AW_QA_URL || 'http://127.0.0.1:18891/';
assert.equal(new URL(qaURL).hostname, '127.0.0.1');
assert.equal(new URL(qaURL).port, '18891', 'This smoke test is restricted to QA port 18891');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-workflow-profile-'));
app.setPath('userData', profile);
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
  await window.loadURL(qaURL);
  await waitFor('typeof storageHydrated !== "undefined" && storageHydrated');
  await evaluate(`window.__qaTag = ${JSON.stringify(tag)}; window.__qaOldPermission = state.settings.permissions['日常']; window.__qaOldProvider = state.settings.provider; document.querySelector('#provider').value = 'api'; localStorage.setItem('workstation-provider', 'api'); document.querySelector('#apiBase').value = ''; document.querySelector('#model').value = ''; document.querySelector('#apiKey').value = ''; localStorage.removeItem('workstation-api-base'); localStorage.removeItem('workstation-api-model'); localStorage.removeItem('workstation-api-key'); state.settings.permissions['日常'] = 'auto'; window.confirm = () => true; true;`);
  let projectId, taskId, importId;
  await step('create isolated project through dialog', async () => {
    await evaluate(`document.querySelector('#newProject').click(); document.querySelector('#newProjectNameInput').value = __qaTag + ' 验收项目'; document.querySelector('#newProjectWorkspaceInput').value = '日常'; document.querySelector('#createProjectSubmit').click();`);
    projectId = await evaluate('state.currentProjectId'); assert.ok(projectId); assert.equal(await evaluate('state.projects.find(x=>x.id===state.currentProjectId)?.name'), tag+' 验收项目');
    await evaluate(`document.querySelector('#projectChat').click(); window.__qaConversation = state.currentConversationId;`);
  });
  async function importText(name, body) {
    await evaluate(`document.querySelector('#chatAttach').click(); const transfer = new DataTransfer(); transfer.items.add(new File([${JSON.stringify(body)}], ${JSON.stringify(name)}, {type:'text/plain'})); document.querySelector('#fileInput').files = transfer.files; document.querySelector('#fileInput').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#startImport').click();`);
    await waitFor('!document.querySelector("#importDialog").open');
  }
  await step('import original text through parser and run local workflow', async () => {
    await importText(`${tag}-签证材料.txt`, '材料清单\n需要准备护照原件及照片\n预约确认单需要打印\n注意提前完成材料核对\n提交日期以预约通知为准');
    importId = await evaluate('currentConversation().attachments.at(-1)');
    assert.ok(importId);
    await evaluate(`document.querySelector('#agentInput').value = __qaTag + ' 验收项目 整理材料并创建任务'; document.querySelector('#agentSend').click();`);
    await waitFor('!sendMessage.busy');
    const derived = await evaluate(`({status:state.agentRuns.at(-1).status, task:state.tasks.find(x=>x.projectId===${JSON.stringify(projectId)}), notes:state.notes.filter(x=>x.projectId===${JSON.stringify(projectId)}).map(x=>({id:x.id,sources:x.sourceAttachmentIds})), material:state.imports.find(x=>x.id===${JSON.stringify(importId)})?.projectId})`);
    assert.equal(derived.status, 'completed-local'); assert.equal(derived.material, projectId);
    assert.ok(derived.task && derived.notes.length >= 2); console.log('QA routing', JSON.stringify({projectId,importId,taskId:derived.task?.id,sources:derived.task?.sourceAttachmentIds})); assert.ok(derived.task.sourceAttachmentIds.includes(importId)); assert.ok(derived.notes.every(n=>n.sources.includes(importId))); taskId=derived.task.id;
    await evaluate(`openProject(${JSON.stringify(projectId)});`);
    assert.ok(await evaluate(`document.querySelector('#projectTree').textContent.includes(${JSON.stringify(tag)})`));
  });
  await step('task draft survives checklist add and saves completion', async () => {
    await evaluate(`openTask(${JSON.stringify(taskId)}); document.querySelector('#taskTitleInput').value = __qaTag+' 已编辑任务'; document.querySelector('#taskDescriptionInput').value = 'QA 验收标准'; document.querySelector('#taskStatusInput').value = 'done'; document.querySelector('#taskDueInput').value = '2026-10-01'; document.querySelector('#newChecklistItem').value = '检查原件'; document.querySelector('#addChecklistItem').click();`);
    assert.equal(await evaluate("document.querySelector('#taskDescriptionInput').value"), 'QA 验收标准');
    await evaluate(`const checks=document.querySelectorAll('#taskChecklist input'); checks[checks.length-1].click(); document.querySelector('#saveTask').click();`);
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
    await waitFor("document.querySelector('#previewDialog').open");
    assert.ok(await evaluate("document.querySelector('#previewDialog').open"));
    assert.ok(await evaluate("document.querySelector('#previewContent').textContent.includes('护照')"));
    assert.ok(await evaluate(`fileStoreGet(${JSON.stringify(importId)}).then(blob=>!!blob&&blob.size>0)`));
    await evaluate(`document.querySelector('#previewDialog').close(); window.__qaTag = ${JSON.stringify(tag)}; document.querySelector('#provider').value='api'; document.querySelector('#apiBase').value='';document.querySelector('#model').value='';document.querySelector('#apiKey').value='';window.confirm=()=>true; true;`);
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
    await evaluate("document.querySelector('.reject-run').click();");
    assert.equal(await evaluate('state.agentRuns.at(-1).status'), 'rejected');
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
    await evaluate(`openTask(${JSON.stringify(taskId)}); document.querySelector('#deleteTask').click(); document.querySelector('#confirmContentDelete').click();`);
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
