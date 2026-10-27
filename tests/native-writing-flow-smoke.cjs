/* Production renderer + real temporary persistence; no user store or model calls.
 * Run serially: ./node_modules/.bin/electron tests/native-writing-flow-smoke.cjs
 * This is a renderer aid. Native WKWebView acceptance is a separate release gate.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const LABEL = process.argv.includes('--before') ? 'before' : 'after';
// Prefer the bundled interpreter of a local desktop build when present; otherwise use the system python3 like the other smokes.
const BUNDLED_PYTHON = path.join(ROOT, 'mobile/build/desktop-agenda/AI Bro.app/Contents/Resources/python/bin/python3');
const PYTHON = process.env.AIBRO_TEST_PYTHON || (fs.existsSync(BUNDLED_PYTHON) ? BUNDLED_PYTHON : (process.env.PYTHON || 'python3'));
const OUT = path.join(ROOT, 'test-results/native-writing-20261001/renderer-' + LABEL);
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-native-writing-'));
const STORE = path.join(TEMP, 'store');
fs.mkdirSync(STORE); fs.mkdirSync(path.join(TEMP,'home')); fs.mkdirSync(path.join(TEMP,'codex-home')); fs.mkdirSync(OUT, { recursive: true });
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
    temporaryStoreRemoved: !fs.existsSync(TEMP), pythonRuntime: PYTHON, nativeAcceptance: 'separate gate' }, null, 2));
  app.exit(code);
}
(async () => {
  const port = await new Promise(resolve => { const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); }); });
  origin = 'http://127.0.0.1:' + port;
  const log = fs.openSync(path.join(OUT, 'server.log'), 'w');
  const serverEnv = { ...process.env, AI_WORKSTATION_PORT: String(port), AI_WORKSTATION_DATA_DIR: STORE, HOME: path.join(TEMP, 'home'), CODEX_HOME: path.join(TEMP, 'codex-home'), PYTHONDONTWRITEBYTECODE: '1' };
  for (const key of ['PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONUSERBASE', 'PYTHONEXECUTABLE', '__PYVENV_LAUNCHER__']) delete serverEnv[key];
  // The bundled interpreter is self-contained and runs with the user site off. A system interpreter keeps its image decoder in the user site and HOME is isolated above, so pin the user base to the real one (read-only).
  if (PYTHON === BUNDLED_PYTHON) serverEnv.PYTHONNOUSERSITE = '1';
  else serverEnv.PYTHONUSERBASE = require('node:child_process').execFileSync(PYTHON, ['-c', 'import site;print(site.getuserbase())'], { encoding: 'utf8' }).trim();
  server = spawn(PYTHON, [path.join(ROOT, 'app/server.py')], { cwd: ROOT, env: serverEnv, stdio: ['ignore', log, log] });
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
  const drop = async (selector, filename) => evaluate(`(async()=>{
    const target=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getBoundingClientRect().height>0);
    if(!target)throw Error('Visible drop target missing');
    const canvas=document.createElement('canvas');canvas.width=120;canvas.height=80;
    canvas.getContext('2d').fillRect(0,0,120,80);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    const transfer=new DataTransfer();transfer.items.add(new File([blob],${JSON.stringify(filename)},{type:'image/png'}));
    // Registered after WorkspaceLayout's document capture handler. A visual editor
    // intentionally consumes the drop at its own ancestor, before the target.
    let reached=0;const observe=e=>{if(e.target===target)reached++;};document.addEventListener('drop',observe,{capture:true,once:true});
    const r=target.getBoundingClientRect();
    for(const type of ['dragenter','dragover','drop'])target.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:transfer,clientX:r.left+Math.min(50,r.width/2),clientY:r.top+Math.min(25,r.height/2)}));
    document.removeEventListener('drop',observe,true);
    return {reached,toast:document.querySelector('#toast')?.textContent,owner:target.closest('[data-aibro-file-drop-owner]')?.getAttribute('data-aibro-file-drop-owner')||null};
  })()`);
  const noteDraft = () => evaluate('NoteEditor.currentContent()?.content||""');
  const attachments = () => evaluate('JSON.stringify(state.conversations.map(c=>({id:c.id,attachments:c.attachments,draftAttachmentIds:c.draftAttachmentIds,draft:c.draft})))');
  await check('full application global capture lets a Finder-style file drop reach the visual note editor',async()=>{
    await toMode('编辑');const before=await attachments();
    const observed=await drop('.document-visual-canvas .ProseMirror','visual-drop.png');
    fs.writeFileSync(path.join(OUT,'drop-observation.json'),JSON.stringify(observed,null,2));console.log('DROP_OBSERVATION',JSON.stringify(observed));
    assert.equal(observed.reached,1,'document-level capture must not intercept the editor drop');
    await until(async()=>/visual-drop/.test(await noteDraft()),'durable visual image insertion');
    assert.equal(await attachments(),before,'document image is not a background chat attachment');
    const disk=await storeSnapshot();assert.equal(disk.imports.filter(x=>x.importOrigin?.kind==='document-image').length,1);
    assert.equal(await evaluate('NoteEditor.saveInline()'),true);await settle();await shot('visual-drop');
  });
  if(LABEL==='before'){await finish(failures.length?1:0);return;}
  await check('full application source editor owns the drop without changing conversation attachments',async()=>{
    await toMode('源码');const before=await attachments();const observed=await drop('#previewContent .cm-content','source-drop.png');assert.equal(observed.reached,1);
    await until(async()=>/source-drop/.test(await noteDraft()),'durable source image insertion');assert.equal(await attachments(),before);
    assert.equal(await evaluate('NoteEditor.saveInline()'),true);await settle();
  });
  await check('local Markdown owns both source and visual image drops and saves real sibling resources',async()=>{
    const candidate=await evaluate(`(async()=>{const r=await fetch('/__local/roots',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:${JSON.stringify(path.join(TEMP,'project'))}})});const data=await r.json();if(!r.ok)throw Error(data.error);return data.candidate;})()`);
    await evaluate(`state.projects[0].localFolder=${JSON.stringify(candidate)};saveDocumentDurably()`);
    const ref={projectId:'image-project',candidateId:candidate.id,path:'local.md'};
    await evaluate(`openPreview('local-file',ProjectFiles.localId(${JSON.stringify(ref)}))`);await until(()=>evaluate('!!ProjectFiles.currentContent()'),'local ready');
    const before=await attachments();
    for(const [mode,selector,name] of [['源码','.local-document .cm-content','local-source.png'],['编辑','.local-document .ProseMirror','local-visual.png']]){
      await toMode(mode);const observed=await drop(selector,name);assert.equal(observed.reached,1,mode);
      await until(()=>evaluate(`ProjectFiles.currentContent()?.content.includes(${JSON.stringify(name)})`),'local durable '+mode);
    }
    assert.equal(await attachments(),before);assert.equal(fs.readFileSync(path.join(TEMP,'project','local.md'),'utf8'),'# Local writing\n\nLocal original.');
    assert.equal(await evaluate('ProjectFiles.save()'),true);assert.match(fs.readFileSync(path.join(TEMP,'project','local.md'),'utf8'),/\.assets\//);
    await settle();await shot('local-drop');
  });
  await check('capture attachment area receives files as unsaved capture attachments, without global import',async()=>{
    await evaluate('ReadingPane.revealWorkspace();showView("captures")');await until(()=>evaluate('document.querySelector(".capture-composer textarea")&&!document.querySelector(".capture-composer textarea").disabled'),'capture ready');
    const before=await attachments(),count=await evaluate('state.imports.length');
    const observed=await drop('.capture-composer textarea','capture-drop.png');assert.equal(observed.reached,1);
    await until(()=>evaluate('document.querySelector(".capture-composer .capture-attachments").textContent.includes("capture-drop.png")'),'capture file draft');
    assert.equal(await evaluate('state.imports.length'),count);assert.equal(await attachments(),before);
    await evaluate('document.querySelector(".capture-composer textarea").value="Finder drop capture";document.querySelector(".capture-composer textarea").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("[data-capture-save]").click()');
    await until(()=>evaluate('state.notes.some(n=>n.kind==="随记"&&n.content==="Finder drop capture"&&n.sourceAttachmentIds.length===1)&&!document.querySelector("[data-capture-save]").disabled'),'capture saved');
    await settle();const disk=await storeSnapshot();assert.equal(disk.notes.find(n=>n.content==='Finder drop capture').sourceAttachmentIds.length,1);
  });
  assert.deepEqual(modelRequests,[]);assert.deepEqual(blockedRequests,[]);await finish(failures.length||rendererErrors.length?1:0);
})().catch(async error=>{failures.push({label:'fatal',error:error.stack});console.error(error);await shot('fatal');await finish(1);});
