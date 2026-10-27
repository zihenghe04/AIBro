/* Production renderer + real temporary persistence; no user store or model calls.
 * Run serially: ./node_modules/.bin/electron tests/document-review-flow-smoke.cjs
 * This is a renderer aid. Native WKWebView acceptance is a separate release gate.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results/document-images-20260930/renderer');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-document-images-'));
const STORE = path.join(TEMP, 'store');
fs.mkdirSync(STORE); fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', path.join(TEMP, 'profile'));
let server, win, origin, ending = false;
const checks = [], failures = [], rendererErrors = [], blockedRequests = [], modelRequests = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => win.webContents.executeJavaScript(code, true);
async function until(fn, label) {
  const start = Date.now();
  while (Date.now() - start < 18000) { if (await fn()) return; await wait(40); }
  throw Error('Timed out: ' + label);
}
async function shot(name) {
  if (!win || win.isDestroyed()) return;
  fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
async function check(label, fn) {
  try { await fn(); checks.push(label); console.log('PASS', label); }
  catch (error) {
    failures.push({ label, error: error.stack }); console.error('FAIL', label, error.message);
    await shot('failure-' + failures.length);
  }
}
const click = selector => evaluate(`(()=>{const control=document.querySelector(${JSON.stringify(selector)});if(!control)throw Error('Missing control: '+${JSON.stringify(selector)});if(control.disabled)throw Error('Disabled control: '+${JSON.stringify(selector)});control.click();})()`);
const button = (label, host = 'body') => evaluate(`(()=>{const host=document.querySelector(${JSON.stringify(host)});const control=[...host.querySelectorAll('button')].find(node=>node.textContent.trim()===${JSON.stringify(label)}&&!node.disabled);if(!control)throw Error('Missing enabled button: '+${JSON.stringify(label)});control.click();})()`);
async function selectTree(id) {
  if (!await evaluate('state.ui.inspectorOpen&&state.ui.inspector==="files"')) await click('#workspaceFilesToggle');
  await until(() => evaluate('!!document.querySelector("[data-halaska-root=DocumentFiles]")'), 'real file tree');
  await evaluate(`(()=>{const row=[...document.querySelectorAll('[data-document-file-key]')].find(node=>node.dataset.documentFileKey===${JSON.stringify(JSON.stringify(['note', id]))});if(!row)throw Error('File tree row unavailable: '+${JSON.stringify(id)});row.click();})()`);
  await until(() => evaluate(`document.querySelector('[data-review-file][aria-pressed=true]')?.dataset.reviewFile===${JSON.stringify(id)}`), 'exact selected proposal ' + id);
}
async function sourceMode() {
  await evaluate(`(()=>{const control=[...document.querySelectorAll('.note-document-toolbar-island [role=radio]')].find(node=>node.textContent.trim()==='源码');if(!control)throw Error('Missing real source-mode control');control.click();})()`);
  await until(() => evaluate('!!document.querySelector("#previewContent .cm-content[contenteditable=true]")'), 'CodeMirror source editor');
}
async function settle() {
  await evaluate('saveDocumentDurably()'); await evaluate('flushWorkspace()');
  await until(() => evaluate('!serverSaveInFlight&&!serverSaveQueued&&!state._pendingLocalSave&&!serverConflict'), 'durable store settled');
}
async function storeSnapshot() {
  return evaluate('(async()=>{const response=await fetch("/__state",{cache:"no-store"});if(!response.ok)throw Error("State read failed");return response.json();})()');
}
const original = id => id === 'review-first' ? '# 研究问题\n\nFIRST ORIGINAL · 原来的研究问题。' : '# 阅读结论\n\nSECOND ORIGINAL · 尚未采纳的原始结论。';
const edited = '# 阅读结论\n\nSECOND PROPOSAL · 经过核对的新结论。\n\n## 证据\n\n保留来源和审阅记录。\n\n用户补充：已人工核对。';
const watchdog = setTimeout(() => { failures.push({ label: 'watchdog' }); void finish(1); }, 240000);
app.on('window-all-closed', () => {});
async function finish(code) {
  if (ending) return; ending = true; clearTimeout(watchdog);
  win?.destroy();
  if (server) { server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)), wait(1000)]); }
  fs.rmSync(TEMP, { recursive: true, force: true });
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ passed: checks.length, checks, failures, rendererErrors,
    modelCalls: modelRequests.length, modelRequests, blockedRequests, userWorkspaceLoaded: false,
    temporaryStoreRemoved: !fs.existsSync(TEMP), nativeAcceptance: 'separate gate' }, null, 2));
  app.exit(code);
}
(async () => {
  const port = await new Promise(resolve => { const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); }); });
  origin = 'http://127.0.0.1:' + port;
  const log = fs.openSync(path.join(OUT, 'server.log'), 'w');
  server = spawn('python3', [path.join(ROOT, 'app/server.py')], { cwd: ROOT,
    env: { ...process.env, AI_WORKSTATION_PORT: String(port), AI_WORKSTATION_DATA_DIR: STORE, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', log, log] });
  await until(() => new Promise(resolve => http.get(origin + '/__health', response => { response.resume(); resolve(response.statusCode === 200); }).on('error', () => resolve(false))), 'server');
  fs.mkdirSync(path.join(TEMP,'project')); fs.writeFileSync(path.join(TEMP,'project','local.md'),'# Local writing\n\nLocal original.');
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 1500, height: 980, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => {
    const local = request.url.startsWith(origin + '/');
    const model = local && /\/(?:__proxy|__api|__llm|__models)(?:[/?]|$)/.test(new URL(request.url).pathname);
    if (!local) blockedRequests.push(request.url); if (model) modelRequests.push(request.url);
    callback({ cancel: !local || model });
  });
  win.webContents.on('console-message', event => { if (event.level === 'error') { rendererErrors.push(event.message); console.error('RENDERER', event.message); } });
  await win.loadURL(origin);
  await until(() => evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'), 'hydrate');
  await evaluate(fs.readFileSync(path.join(ROOT, 'tests/fixtures/document-images-fixture-client.js'), 'utf8'));
  await until(() => evaluate('window.__documentImageFixtureReady'), 'fixture ready'); await settle();


  const toMode = async label => {
    await until(()=>evaluate(`[...document.querySelectorAll('.document-toolbar-kit [role=radio]')].some(e=>e.textContent.trim()===${JSON.stringify(label)}&&!e.disabled)`),'enabled mode '+label);
    await evaluate(`(()=>{const c=[...document.querySelectorAll('.document-toolbar-kit [role=radio]')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!c||c.disabled)throw Error('Mode unavailable');c.click();})()`);
    await until(()=>evaluate(label==='源码' ? '!!document.querySelector(".cm-content[contenteditable=true]")' : label==='编辑' ? '!!document.querySelector(".document-visual-canvas [contenteditable=true]")' : '!!document.querySelector(".note-document-preview img,.local-document-preview img")'),'mode '+label);
  };
  const paste = async (label='diagram.png') => evaluate(`(async()=>{
    const canvas=document.createElement('canvas');canvas.width=120;canvas.height=80;const ctx=canvas.getContext('2d');ctx.fillStyle='#56b7a2';ctx.fillRect(0,0,120,80);ctx.fillStyle='#162b24';ctx.fillRect(20,20,80,40);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));const file=new File([blob],${JSON.stringify(label)},{type:'image/png'});const transfer=new DataTransfer();transfer.items.add(file);
    const target=[...document.querySelectorAll('.document-visual-canvas [contenteditable=true],.cm-content[contenteditable=true]')].find(e=>e.getBoundingClientRect().height>0);if(!target)throw Error('Editable target unavailable');target.focus();target.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));return true;
  })()`);
  await check('ordinary note clipboard image is durably registered before inserting canonical markdown',async()=>{
    await until(()=>evaluate('[...document.querySelectorAll(".document-toolbar-kit [role=radio]")].some(n=>n.textContent.trim()==="编辑"&&!n.disabled)'),'mode ready');
    await toMode('编辑');await paste();
    await until(()=>evaluate('NoteEditor.currentContent()?.content.includes("/__files/")'),'durable image insertion');
    // The canonical markdown is committed before the editor image finishes decoding; wait for the real bytes.
    await until(()=>evaluate('document.querySelector(".document-visual-editor img")?.naturalWidth===120'),'visual editor image decoded');
    assert.equal(await evaluate('document.querySelector(".document-visual-editor img")?.naturalWidth'),120);
    assert.equal(await evaluate('state.notes.find(n=>n.id==="image-note").content.includes("/__files/")'),false);
    const disk=await storeSnapshot();assert.equal(disk.imports.filter(x=>x.importOrigin?.kind==='document-image').length,1);
    assert.ok(disk.imports[0].blobHash,'image must enter existing sync blob path');
    await shot('note-image-edit');
  });
  await check('saving note then reading and real reload preserve image bytes and canonical reference',async()=>{
    assert.equal(await evaluate('NoteEditor.saveInline()'),true);await settle();await toMode('阅读');
    await until(()=>evaluate('document.querySelector(".note-document-preview img")?.naturalWidth===120'),'ordinary read image');
    await win.reload();await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'reload');
    await evaluate('openPreview("note","image-note")');
    await until(()=>evaluate('document.querySelector(".note-document-preview img")?.naturalWidth===120'),'reload read image');
    const body=await evaluate('state.notes.find(n=>n.id==="image-note").content');assert.match(body,/!\[.*\]\(\/__files\//);assert.doesNotMatch(body,/blob:|data:/);
  });
  await check('note source mode accepts another clipboard image and current unsaved image exports with its bytes',async()=>{
    await toMode('源码');await paste('second.png');await until(()=>evaluate('(NoteEditor.currentContent()?.content.split("![")||[]).length===3'),'source image');
    const result=await evaluate(`(async()=>{const draft=await NoteEditor.prepareExport();const r=await fetch('/__document-images/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({noteId:draft.id,title:draft.title,content:draft.content})});if(!r.ok)throw Error((await r.json()).error);return [...new Uint8Array(await r.arrayBuffer())];})()`);
    fs.writeFileSync(path.join(OUT,'note-with-images.zip'),Buffer.from(result));
    const checked=require('node:child_process').spawnSync('python3',['-c',`import sys,zipfile
z=zipfile.ZipFile(sys.argv[1]);names=z.namelist();md=next(n for n in names if n.endswith('.md'));text=z.read(md).decode();assert text.count('![')==2;assert '/__files/' not in text;assert any(n.startswith('assets/') for n in names);print(len(names))`,path.join(OUT,'note-with-images.zip')],{encoding:'utf8'});assert.equal(checked.status,0,checked.stderr);
    assert.equal(await evaluate('NoteEditor.saveInline()'),true);await settle();
  });
  await check('Wiki uses the same upload, source and reading path',async()=>{
    await evaluate('openPreview("note","image-wiki")');await until(()=>evaluate('NoteEditor.inlineActive("image-wiki")'),'wiki open');await toMode('编辑');await paste('wiki.png');
    await until(()=>evaluate('NoteEditor.currentContent()?.content.includes("/__files/")'),'wiki image');assert.equal(await evaluate('NoteEditor.saveInline()'),true);await settle();await toMode('阅读');
    await until(()=>evaluate('document.querySelector(".note-document-preview img")?.naturalWidth===120'),'wiki read');
  });
  await check('local Markdown pastes to immutable sibling resources without writing the original text',async()=>{
    const candidate=await evaluate(`(async()=>{const r=await fetch('/__local/roots',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:${JSON.stringify(path.join(TEMP,'project'))}})});const data=await r.json();if(!r.ok)throw Error(data.error);return data.candidate;})()`);
    await evaluate(`state.projects[0].localFolder=${JSON.stringify(candidate)};saveDocumentDurably()`);
    const ref={projectId:'image-project',candidateId:candidate.id,path:'local.md'};
    await evaluate(`openPreview('local-file',ProjectFiles.localId(${JSON.stringify(ref)}))`);
    await until(()=>evaluate('!!ProjectFiles.currentContent()'),'local editor ready');await toMode('源码');await paste('local.png');
    await until(()=>evaluate('ProjectFiles.currentContent()?.content.includes(".assets/")'),'local image ref');
    assert.equal(fs.readFileSync(path.join(TEMP,'project','local.md'),'utf8'),'# Local writing\n\nLocal original.');
    assert.ok(fs.readdirSync(path.join(TEMP,'project')).some(n=>n.endsWith('.assets')));
    assert.equal(await evaluate('ProjectFiles.save()'),true);await settle();
    await toMode('阅读');await until(()=>evaluate('document.querySelector(".local-document-preview img")?.naturalWidth===120'),'local image read');await shot('local-image-read');
  });
  await check('local export includes durable image and keeps draft content separate from original',async()=>{
    const result=await evaluate(`(async()=>{const d=await ProjectFiles.prepareExport();const r=await fetch('/__local/document-images/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...d.ref,title:d.title,content:d.content})});if(!r.ok)throw Error((await r.json()).error);return [...new Uint8Array(await r.arrayBuffer())];})()`);
    fs.writeFileSync(path.join(OUT,'local-with-images.zip'),Buffer.from(result));
    const checked=require('node:child_process').spawnSync('python3',['-c',`import sys,zipfile
z=zipfile.ZipFile(sys.argv[1]);assert any(n.endswith('.png') for n in z.namelist());assert any(n.endswith('.md') for n in z.namelist())`,path.join(OUT,'local-with-images.zip')],{encoding:'utf8'});assert.equal(checked.status,0,checked.stderr);
  });
  assert.deepEqual(modelRequests,[]);await finish(failures.length||rendererErrors.length?1:0);
})().catch(async error=>{failures.push({label:'fatal',error:error.stack});console.error(error);await shot('fatal');await finish(1);});
