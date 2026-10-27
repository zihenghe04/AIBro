/* Production renderer + real temporary persistence; no user store or model calls.
 * Run serially: ./node_modules/.bin/electron tests/document-review-flow-smoke.cjs
 * This is a renderer aid. Native WKWebView acceptance is a separate release gate.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results/document-review-20260930/renderer');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-document-review-'));
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
  await evaluate(fs.readFileSync(path.join(ROOT, 'tests/fixtures/document-review-fixture-client.js'), 'utf8'));
  await until(() => evaluate('window.__documentReviewFixtureReady'), 'fixture ready'); await settle();

  await check('the real file tree lists two pending notes while the durable originals remain unchanged', async () => {
    assert.equal(await evaluate('!!document.querySelector("[data-halaska-root=DocumentFiles]")'), true);
    assert.equal(await evaluate('document.querySelectorAll(".document-file-row:not(.is-folder) .document-file-state.is-review").length'), 2);
    const disk = await storeSnapshot(); assert.equal(disk.notes.find(note => note.id === 'review-first').content, original('review-first'));
    assert.equal(disk.notes.find(note => note.id === 'review-second').content, original('review-second'));
    assert.deepEqual(await evaluate('ProjectOutputs.build({state,projectId:"review-project"}).counts'), { all: 2, saved: 0, review: 2 });
  });
  await check('clicking the second note in the conversation file tree opens its exact diff and real Kit actions', async () => {
    await selectTree('review-first');
    if (!await evaluate('document.body.classList.contains("reading-expanded")')) await click('#readingExpand');
    await selectTree('review-second');
    assert.match(await evaluate('document.querySelector(".file-review-content").textContent'), /SECOND ORIGINAL/);
    assert.match(await evaluate('document.querySelector(".file-review-content").textContent'), /SECOND PROPOSAL/);
    assert.doesNotMatch(await evaluate('document.querySelector(".file-review-content").textContent'), /FIRST (?:ORIGINAL|PROPOSAL)/);
    assert.equal(await evaluate('["ReviewHeading","ReviewModeControl","ReviewActions"].every(name=>document.querySelector(`[data-halaska-root="${name}"]`))'), true);
    assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-draft-review-action]")].map(node=>node.dataset.draftReviewAction)'), ['adopt', 'discard', 'edit']);
    await shot('second-proposal');
  });
  await check('open editor preserves the original until the user explicitly applies or saves a draft', async () => {
    await click('[data-draft-review-action=edit]');
    await until(() => evaluate('ReadingPane.isActive("note","review-second")&&NoteEditor.inlineActive("review-second")'), 'real note editor');
    await until(() => evaluate('[...document.querySelectorAll(".note-document-toolbar-island [role=radio]")].some(node=>node.textContent.trim()==="编辑"&&node.getAttribute("aria-checked")==="true"&&!node.disabled)&&!!document.querySelector(".note-document-rich [contenteditable=true]")'), 'visual editing after draft recovery is ready');
    await sourceMode(); assert.equal(await evaluate('NoteEditor.currentContent().content'), original('review-second'));
    assert.equal(await evaluate('document.querySelector(".note-document-ai").hidden'), false);
    assert.match(await evaluate('document.querySelector(".note-document-ai").textContent'), /SECOND PROPOSAL/);
    await evaluate(`(()=>{const tab=[...document.querySelectorAll('[data-reading-key]')].find(node=>node.dataset.readingKey===JSON.stringify(['review','review-run']));if(!tab)throw Error('Retained review tab unavailable');tab.click();})()`);
    await until(() => evaluate('!!document.querySelector("[data-draft-review-action=adopt]")'), 'return to proposal tab');
    assert.equal(await evaluate('document.querySelector("[data-review-file][aria-pressed=true]").dataset.reviewFile'), 'review-second');
  });
  await check('a failed save retains the original, pending proposal and inline error; repeated clicks cannot duplicate the write', async () => {
    await settle();
    await evaluate('window.__reviewSave=saveDocumentDurably;window.__reviewSaveAttempts=0;saveDocumentDurably=()=>{__reviewSaveAttempts++;return new Promise((resolve,reject)=>{window.__rejectReviewSave=()=>reject(Error("隔离验收：本机数据库写入失败"));});};true');
    try {
      await click('[data-draft-review-action=adopt]');
      await until(() => evaluate('typeof window.__rejectReviewSave==="function"'), 'held save');
      assert.equal(await evaluate('[...document.querySelectorAll(".review-file-actions button")].every(node=>node.disabled)'), true);
      await evaluate('document.querySelector("[data-draft-review-action=adopt]").click()');
      assert.equal(await evaluate('window.__reviewSaveAttempts'), 1);
      await evaluate('window.__rejectReviewSave()');
      await until(() => evaluate('[...document.querySelectorAll(".file-review-error")].some(node=>!node.hidden&&node.textContent.includes("本机数据库写入失败"))'), 'visible save error');
      assert.equal(await evaluate('state.notes.find(note=>note.id==="review-second").content'), original('review-second'));
      assert.match(await evaluate('state.notes.find(note=>note.id==="review-second").aiDraft.content'), /SECOND PROPOSAL/);
      assert.match(await evaluate('document.querySelector(".review-notice").textContent'), /待采纳/);
      await until(() => evaluate('!document.querySelector("[data-draft-review-action=adopt]").disabled'), 'retry enabled');
      await shot('failed-save-retains-proposal');
    } finally { await evaluate('saveDocumentDurably=window.__reviewSave;delete window.__reviewSave;delete window.__rejectReviewSave;true'); }
    await settle(); const disk = await storeSnapshot();
    assert.equal(disk.notes.find(note => note.id === 'review-second').content, original('review-second'));
    assert.equal(disk.notes.find(note => note.id === 'review-second').aiDraftHistory?.length || 0, 0);
  });
  await check('adopt and save writes only the selected second note and moves its outcome from review to saved', async () => {
    await click('[data-draft-review-action=adopt]');
    await until(() => evaluate('document.querySelector(".review-notice")?.textContent.includes("已采纳")'), 'adopted state'); await settle();
    const disk = await storeSnapshot(), first = disk.notes.find(note => note.id === 'review-first'), second = disk.notes.find(note => note.id === 'review-second');
    assert.equal(first.content, original('review-first')); assert.ok(first.aiDraft);
    assert.match(second.content, /SECOND PROPOSAL/); assert.equal(second.aiDraft, undefined);
    assert.equal(second.aiDraftHistory.at(-1).action, 'adopt'); assert.equal(second.provenance.output.variant, 'body');
    assert.equal(second.provenance.origin.conversationId, 'review-conversation');
    assert.deepEqual(await evaluate('ProjectOutputs.build({state,projectId:"review-project"}).counts'), { all: 2, saved: 1, review: 1 });
    assert.equal(await evaluate('!!document.querySelector("[data-draft-review-action=adopt]")'), false); await shot('adopted-second');
  });
  await check('discarding the first proposal keeps its original and does not manufacture a saved output', async () => {
    await click('[data-review-file=review-first]'); await click('[data-draft-review-action=discard]');
    await until(() => evaluate('document.querySelector(".review-notice")?.textContent.includes("已放弃")'), 'discarded state'); await settle();
    const disk = await storeSnapshot(), first = disk.notes.find(note => note.id === 'review-first');
    assert.equal(first.content, original('review-first')); assert.equal(first.aiDraft, undefined); assert.equal(first.aiDraftHistory.at(-1).action, 'discard');
    assert.deepEqual(await evaluate('ProjectOutputs.build({state,projectId:"review-project"}).counts'), { all: 1, saved: 1, review: 0 });
    assert.deepEqual(await evaluate('LocalFileEdits.outputs(state,"review-conversation").map(row=>row.id)'), ['review-second']);
    assert.match(await evaluate('document.querySelector(".file-review-content").textContent'), /FIRST PROPOSAL/);
    assert.equal(await evaluate('!!document.querySelector("[data-draft-review-action=discard]")'), false);
  });
  await check('open current file reaches the adopted body and a real source-editor save persists a manual revision', async () => {
    await click('[data-review-file=review-second]'); await button('打开当前文件', '.review-file-actions');
    await until(() => evaluate('ReadingPane.isActive("note","review-second")&&NoteEditor.inlineActive("review-second")'), 'current file'); await sourceMode();
    assert.match(await evaluate('NoteEditor.currentContent().content'), /SECOND PROPOSAL/);
    await evaluate('document.querySelector("#previewContent .cm-content").focus()'); win.webContents.focus(); await wait(80);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['meta'] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['meta'] });
    await wait(40); await win.webContents.insertText(edited);
    await until(() => evaluate('NoteEditor.currentContent()?.content.includes("用户补充")'), 'real editor typing');
    assert.equal(await evaluate('document.querySelector(".document-toolbar-kit-state").textContent'), '未保存');
    await button('保存', '.document-toolbar-kit');
    await until(() => evaluate('state.notes.find(note=>note.id==="review-second").content.includes("用户补充")&&!NoteEditor.currentContent()?.dirty'), 'explicit editor save'); await settle();
    assert.equal((await storeSnapshot()).notes.find(note => note.id === 'review-second').content, edited); await shot('edited-saved-document');
  });
  await check('a real renderer reload restores both durable decisions, the manual edit and immutable proposal snapshots', async () => {
    await settle(); await win.reload(); await until(() => evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'), 'reload');
    assert.equal(await evaluate('state.notes.find(note=>note.id==="review-first").content'), original('review-first'));
    assert.equal(await evaluate('state.notes.find(note=>note.id==="review-second").content'), edited);
    assert.deepEqual(await evaluate('state.notes.map(note=>[note.id,note.aiDraftHistory.at(-1).action,!!note.aiDraft])'), [['review-first', 'discard', false], ['review-second', 'adopt', false]]);
    assert.match(await evaluate('state.agentRuns.find(run=>run.id==="review-run").fileChanges[1].after.aiDraft.content'), /SECOND PROPOSAL/);
    assert.doesNotMatch(await evaluate('state.agentRuns.find(run=>run.id==="review-run").fileChanges[1].after.aiDraft.content'), /用户补充/);
    assert.deepEqual(await evaluate('ProjectOutputs.build({state,projectId:"review-project"}).counts'), { all: 1, saved: 1, review: 0 });
  });
  await check('the project output opens the saved document and returns to its original conversation', async () => {
    await evaluate('WorkspaceNavigation.go("outputs","review-project")');
    await until(() => evaluate('document.body.dataset.view==="project"&&state.ui.projectTab==="outputs"'), 'project outputs');
    assert.equal(await evaluate('document.querySelectorAll("#projectOutputs .project-output-row").length'), 1);
    assert.match(await evaluate('document.querySelector("#projectOutputs .project-output-row").textContent'), /02 · 阅读结论/);
    assert.doesNotMatch(await evaluate('document.querySelector("#projectOutputs .project-output-row").textContent'), /01 · 研究问题/);
    await click('#projectOutputs .project-output-title');
    await until(() => evaluate('ReadingPane.isActive("note","review-second")'), 'saved output opened');
    assert.match(await evaluate('NoteEditor.currentContent().content'), /用户补充/);
    await click('#readingCollapse'); await until(() => evaluate('!document.body.classList.contains("reading-open")'), 'reader collapsed');
    await click('#projectOutputs .project-output-origin button');
    await until(() => evaluate('document.body.dataset.view==="agent"&&state.currentConversationId==="review-conversation"'), 'source conversation');
    await shot('returned-to-source');
  });
  assert.deepEqual(modelRequests, []); await finish(failures.length || rendererErrors.length ? 1 : 0);
})().catch(async error => {
  failures.push({ label: 'fatal', error: error.stack }); console.error(error); await shot('fatal'); await finish(1);
});
