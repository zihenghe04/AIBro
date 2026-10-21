/* Production renderer + isolated service: ask AI about a project material
 * (imported PDF, Markdown note, connected local Markdown) from the project's
 * 资料 tab. Synthetic store and folder; the model transport is a local fake.
 * Not native WKWebView acceptance. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), net = require('node:net'), assert = require('node:assert/strict'), { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..'), TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-material-ask-')), STORE = path.join(TEMP, 'store'), PROJECT = path.join(TEMP, 'project'), OUT = path.join(ROOT, 'test-results/project-material-ask-20261014');
for (const dir of [path.join(STORE, 'files'), path.join(PROJECT, 'docs'), OUT]) fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(TEMP, 'profile'));
fs.writeFileSync(path.join(PROJECT, 'docs/method.md'), '# Method\n\nLOCAL_METHOD_BODY uses three stages.\n');
const made = spawnSync(process.env.PYTHON || 'python3', ['-c', `import fitz,json,sys
from pathlib import Path
p=Path(sys.argv[1])
with fitz.open() as d:
 for n in range(2): d.new_page(width=300,height=200).insert_text((30,40),'PDF_PAGE_TEXT '+str(n+1),fontsize=12)
 (p/'ask-pdf').write_bytes(d.tobytes())
(p/'ask-pdf.meta.json').write_text(json.dumps({'name':'survey.pdf','mimeType':'application/pdf'}))`, path.join(STORE, 'files')]);
assert.equal(made.status, 0, made.stderr.toString());
const checks = [], failures = [], rendererErrors = [], external = [];
let win, server, ending = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await delay(40); } throw Error('Timeout: ' + label); }
async function finish(code) {
 if (ending) return; ending = true; clearTimeout(watchdog); win?.destroy();
 if (server) { server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(1500)]); }
 fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ passed: checks.length, checks, failures, rendererErrors, external, modelCalls: 0 }, null, 2));
 fs.rmSync(TEMP, { recursive: true, force: true }); app.exit(code);
}
const watchdog = setTimeout(() => { failures.push({ name: 'watchdog' }); void finish(1); }, 180000);
app.on('window-all-closed', () => {});
(async () => {
 const port = await new Promise(resolve => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); }); });
 const origin = `http://127.0.0.1:${port}`, log = fs.openSync(path.join(TEMP, 'server.log'), 'a');
 server = spawn(process.env.PYTHON || 'python3', [path.join(ROOT, 'app/server.py')], { cwd: ROOT, env: { ...process.env, AI_WORKSTATION_PORT: String(port), AI_WORKSTATION_DATA_DIR: STORE, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', log, log] });
 await until(() => new Promise(resolve => http.get(origin + '/__health', r => { r.resume(); resolve(r.statusCode === 200); }).on('error', () => resolve(false))), 'service');
 await app.whenReady();
 win = new BrowserWindow({ show: false, width: 1440, height: 940, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
 win.webContents.on('console-message', event => { if (event.level === 'error') { rendererErrors.push(event.message); console.error('RENDERER', event.message); } });
 win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => { const blocked = !request.url.startsWith(origin + '/'); if (blocked) external.push(request.url); done({ cancel: blocked }); });
 const evaluate = code => win.webContents.executeJavaScript(code, true);
 const shot = async name => { await delay(80); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
 async function check(name, fn) { try { await fn(); checks.push(name); console.log('PASS', name); } catch (error) { failures.push({ name, error: error.stack }); console.error('FAIL', name, error.message); await shot('failure-' + name.replace(/[^a-z0-9]+/gi, '-').slice(0, 80)); } }
 const clearComposer = () => evaluate(`(()=>{const input=$('#agentInput');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 // Pick the first chooser target with the given label, or the first one.
 const choose = label => until(() => evaluate(`(()=>{const items=[...document.querySelectorAll('[role="menu"] [role="menuitem"]')];const item=items.find(n=>n.textContent.includes(${JSON.stringify(label)}))||null;if(!item)return false;item.click();return true;})()`), 'chooser item ' + label);
 const staged = () => evaluate(`(()=>{const c=currentConversation();return{id:c.id,projectId:c.projectId,view:document.body.dataset.view,value:$('#agentInput').value,refs:(c.draftFileReferences||[]).map(r=>({type:r.type,id:r.id,path:r.path,version:r.version})),chips:[...document.querySelectorAll('.file-context-chip')].map(n=>n.textContent)}})()`);
 // The fake transport records the exact model input; nothing leaves the machine.
 const sendWithFake = goal => evaluate(`(async()=>{const c=currentConversation();c.permissionMode='auto';state.settings.permissions={'日常':'auto','课程':'auto','科研':'auto'};
  ConversationModels.configuration=()=>({provider:'api',model:'material-fixture',effort:''});ConversationModels.resolve=async value=>value;
  getApiConnection=async()=>({base:'https://fixture.invalid/v1',token:'synthetic-material-only'});window.__requests=[];
  AgentTransport.requestPlan=async options=>{__requests.push(JSON.stringify(options.input));return JSON.stringify({workspace:'科研',message:'已读取资料。',actions:[]});};
  await sendMessage({goal:${JSON.stringify(goal)}});return{requests:__requests,run:state.agentRuns.at(-1)};})()`);

 await win.loadURL(origin); await until(() => evaluate(`typeof storageHydrated!=='undefined'&&storageHydrated`), 'hydrate');
 const candidate = await evaluate(`(async()=>{const r=await fetch('/__local/roots',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:${JSON.stringify(PROJECT)}})});const data=await r.json();if(!r.ok)throw Error(data.error);return data.candidate;})()`);
 await evaluate(`(async()=>{WorkstationOnboarding.close();WorkspaceTour?.close?.();state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};state.ui.workspaceTour={version:1,status:'skipped'};document.querySelectorAll('dialog[open]').forEach(n=>n.close());
  const now=Date.now();
  state.projects=[{id:'ask-project',name:'材料提问项目',workspace:'科研',createdAt:now,localFolder:${JSON.stringify(candidate)}},{id:'other-project',name:'其他项目',workspace:'科研',createdAt:now}];
  state.imports=[{id:'ask-pdf',name:'survey.pdf',originalName:'survey.pdf',mimeType:'application/pdf',content:'PDF_PAGE_TEXT 1 PDF_PAGE_TEXT 2',pages:[{page:1,text:'PDF_PAGE_TEXT 1'},{page:2,text:'PDF_PAGE_TEXT 2'}],projectId:'ask-project',workspace:'科研',createdAt:now,size:1000}];
  state.notes=[{id:'ask-note',title:'阅读笔记 · 方法',content:'# 方法\\n\\nNOTE_BODY_MARKER 说明了实验的三个阶段。',projectId:'ask-project',workspace:'科研',createdAt:now,updatedAt:now}];
  state.tasks=[];state.papers=[];state.agentRuns=[];
  state.conversations=[{id:'project-chat',title:'项目对话',projectId:'ask-project',workspace:'科研',messages:[],attachments:[],draftAttachmentIds:[],draftFileReferences:[],draft:'',createdAt:now,updatedAt:now},{id:'other-chat',title:'别的项目对话',projectId:'other-project',workspace:'科研',messages:[],attachments:[],draftAttachmentIds:[],draftFileReferences:[],draft:'',createdAt:now,updatedAt:now-10}];
  state.currentConversationId='other-chat';state.ui.inspectorOpen=false;state.settings.reduceMotion=true;applyUiPreferences();await saveDocumentDurably();renderAll();
  state.ui.projectTab='knowledge';openProject('ask-project');})()`);
 await until(() => evaluate(`document.body.dataset.view==='project'&&!!document.querySelector('#projectCollection [data-cui-kind="import"]')`), 'project 资料 tab');

 await check('PDF opened from the project 资料 tab: reader "问 AI" picks the project chat, stages the PDF and prefills the prompt', async () => {
  await evaluate(`document.querySelector('#projectCollection [data-cui-kind="import"] [data-cui-open]').click()`);
  await until(() => evaluate(`!!document.querySelector('.pdf-sheet img')?.naturalWidth&&!document.querySelector('.reading-ask-action').hidden`), 'PDF reader with ask action');
  const button = await evaluate(`(()=>{const b=$('#readingAsk');return{text:b.textContent,label:b.getAttribute('aria-label'),disabled:b.disabled}})()`);
  assert.equal(button.text, '问 AI'); assert.equal(button.label, '就这份资料提问'); assert.equal(button.disabled, false);
  await shot('pdf-reader-ask-action');
  await evaluate(`$('#readingAsk').click()`);
  await choose('材料提问项目 / 项目对话');
  await until(() => evaluate(`$('#agentInput').value.includes('survey.pdf')`), 'PDF prompt');
  const after = await staged();
  assert.equal(after.id, 'project-chat', JSON.stringify(after)); assert.equal(after.view, 'agent');
  assert.equal(after.value, '关于《survey.pdf》：'); assert.deepEqual(after.refs.map(r => r.type + ':' + r.id), ['import:ask-pdf']);
  assert.ok(after.chips.some(text => text.includes('survey.pdf')), JSON.stringify(after));
  await shot('pdf-staged');
  const sent = await sendWithFake('关于《survey.pdf》：第 2 页讲了什么？');
  const request = sent.requests.join('\n');
  assert.ok(sent.requests.length >= 1);
  assert.match(request, /ask-pdf/);
  // The PDF reaches the model as the original file (attachment delivery), not as extracted text.
  const files = sent.requests.flatMap(text => JSON.parse(text)).flatMap(item => Array.isArray(item.content) ? item.content : []).filter(part => part.type === 'input_file');
  assert.equal(files.length, 1, 'one original PDF file part');
  assert.equal(Buffer.from(String(files[0].file_data).replace(/^data:[^,]*,/, ''), 'base64').subarray(0, 5).toString(), '%PDF-', 'the file part carries the actual PDF bytes');
  assert.deepEqual(sent.run.fileReferences.map(r => r.type + ':' + r.id), ['import:ask-pdf']);
 });

 await check('Markdown note: 资料 row context menu "问 AI" opens it, stages the note into the current same-project chat, and the request carries its body', async () => {
  await evaluate(`state.ui.projectTab='knowledge';openProject('ask-project')`);
  await until(() => evaluate(`!!document.querySelector('#projectCollection [data-cui-kind="note"]')`), 'note row');
  await evaluate(`(()=>{const row=document.querySelector('#projectCollection [data-cui-kind="note"] [data-cui-open]');const r=row.getBoundingClientRect();row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+20,clientY:r.top+8}));})()`);
  await until(() => evaluate(`!!document.querySelector('.file-action-menu [role="menuitem"]')`), 'row menu');
  assert.match(await evaluate(`document.querySelector('.file-action-menu [role="menuitem"]').textContent`), /问 AI/);
  await shot('note-row-menu');
  await clearComposer();
  await evaluate(`document.querySelector('.file-action-menu [role="menuitem"]').click()`);
  // Project view: the chooser lists the project's conversations first.
  await choose('材料提问项目 / 项目对话');
  await until(() => evaluate(`$('#agentInput').value.includes('阅读笔记 · 方法')`), 'note prompt');
  const after = await staged();
  assert.equal(after.id, 'project-chat'); assert.equal(after.value, '关于《阅读笔记 · 方法》：');
  assert.deepEqual(after.refs.map(r => r.type + ':' + r.id), ['note:ask-note']);
  assert.equal(await evaluate(`state.previewRecord?.type+':'+state.previewRecord?.id`), 'note:ask-note');
  const sent = await sendWithFake('关于《阅读笔记 · 方法》：总结一下。');
  assert.match(sent.requests.join('\n'), /NOTE_BODY_MARKER/, 'the note body is inlined into the request');
 });

 await check('selection "问 AI" on the note preview stages the note too', async () => {
  await clearComposer();
  await evaluate(`(()=>{const c=currentConversation();c.draftFileReferences=[];renderAll();})()`);
  // Moving to the conversation parks the reader; reopen it beside the chat.
  if (await evaluate(`ReadingPane.snapshot().retained`)) await evaluate(`$('#readingToggle').click()`);
  await until(() => evaluate(`ReadingPane.snapshot().visible&&!!document.querySelector('#previewContent [data-selection-source="note"]')`), 'note preview root');
  await evaluate(`(()=>{const root=document.querySelector('#previewContent [data-selection-source="note"]');const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;while((node=walker.nextNode())&&!node.textContent.includes('NOTE_BODY_MARKER'));const range=document.createRange();const at=node.textContent.indexOf('NOTE_BODY_MARKER');range.setStart(node,at);range.setEnd(node,at+16);getSelection().removeAllRanges();getSelection().addRange(range);document.dispatchEvent(new Event('selectionchange'));})()`);
  try{await until(() => evaluate(`!document.querySelector('#selectionBar').hidden`), 'selection toolbar',4000);}catch(error){console.log('SELECTION DIAG',JSON.stringify(await evaluate(`(()=>{const s=getSelection();const n=s.anchorNode?.parentElement;return{text:s.toString(),root:!!n?.closest('[data-selection-source]'),hiddenAncestor:(()=>{const h=n?.closest('[hidden],[inert],[aria-hidden="true"]');return h?h.tagName+'#'+h.id+'.'+h.className+' '+[...h.attributes].map(a=>a.name).join(','):null})(),reader:JSON.stringify(ReadingPane.snapshot()).slice(0,300),view:document.body.dataset.view,bar:!!document.querySelector('#selectionBar'),edit:!!n?.closest('[contenteditable]'),html:n?.closest('[data-selection-source]')?.outerHTML.slice(0,300)}})()`)));throw error;}
  await evaluate(`[...document.querySelectorAll('#selectionBar button')].find(b=>b.textContent==='问 AI').click()`);
  await until(() => evaluate(`$('#agentInput').value.includes('NOTE_BODY_MARKER')`), 'quote in composer');
  const after = await staged();
  assert.deepEqual(after.refs.map(r => r.type + ':' + r.id), ['note:ask-note'], JSON.stringify(after));
  assert.match(after.value, /^> 关于《阅读笔记 · 方法》：\n> NOTE_BODY_MARKER/);
 });

 await check('connected local Markdown from the project folder: reader "问 AI" stages the local file with its current version and the request reads it', async () => {
  await clearComposer();
  await evaluate(`state.ui.projectTab='knowledge';openProject('ask-project')`);
  await until(() => evaluate(`!!document.querySelector('#projectLocalTree [data-file-ref]')||!!document.querySelector('#projectLocalTree summary')`), 'local tree', 20000);
  // Expand folders until the method.md row appears.
  await until(() => evaluate(`(()=>{const row=[...document.querySelectorAll('#projectLocalTree [data-file-ref]')].find(n=>JSON.parse(n.dataset.fileRef).path==='docs/method.md');if(row)return true;document.querySelectorAll('#projectLocalTree details:not([open])').forEach(d=>d.open=true);return false;})()`), 'local method.md row', 20000);
  await evaluate(`[...document.querySelectorAll('#projectLocalTree [data-file-ref]')].find(n=>JSON.parse(n.dataset.fileRef).path==='docs/method.md').click()`);
  await until(() => evaluate(`ProjectFiles.current()&&!ProjectFiles.current().loading&&!document.querySelector('.reading-ask-action').hidden`), 'local editor ready');
  await evaluate(`$('#readingAsk').click()`);
  await choose('材料提问项目 / 项目对话');
  await until(() => evaluate(`$('#agentInput').value.includes('method.md')`), 'local prompt');
  const after = await staged(), version = await evaluate(`ProjectFiles.current().version`);
  assert.equal(after.id, 'project-chat'); assert.equal(after.value, '关于《method.md》：');
  // The note staged by the previous step stays; the local file joins it.
  const local = after.refs.filter(r => r.type === 'local');
  assert.equal(local.length, 1, JSON.stringify(after)); assert.equal(local[0].path, 'docs/method.md'); assert.equal(local[0].version, version);
  await shot('local-staged');
  const sent = await sendWithFake('关于《method.md》：三个阶段是什么？');
  assert.match(sent.requests.join('\n'), /LOCAL_METHOD_BODY/, 'FileContext.prepare read the local file into the request');
 });

 await check('private mode hides the reader ask action and the row menu ask item', async () => {
  await evaluate(`(()=>{window.__privateOn=PrivateMode.isOn;PrivateMode.isOn=()=>true;ReadingPane.reconcile();})()`);
  assert.equal(await evaluate(`document.querySelector('.reading-ask-action').hidden`), true);
  await evaluate(`state.ui.projectTab='knowledge';openProject('ask-project')`);
  await until(() => evaluate(`!!document.querySelector('#projectCollection [data-cui-kind="note"]')`), 'note row');
  const prevented = await evaluate(`(()=>{const row=document.querySelector('#projectCollection [data-cui-kind="note"] [data-cui-open]');const event=new MouseEvent('contextmenu',{bubbles:true,cancelable:true});row.dispatchEvent(event);return event.defaultPrevented||!!document.querySelector('.file-action-menu');})()`);
  assert.equal(prevented, false);
  await evaluate(`PrivateMode.isOn=window.__privateOn;ReadingPane.reconcile()`);
 });

 await finish(failures.length || rendererErrors.length || external.length ? 1 : 0);
})().catch(async error => { console.error(error); failures.push({ name: 'fatal', error: error.stack }); await finish(1); });
