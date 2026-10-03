/* Production renderMessage + owned process/Kit controllers in an isolated
 * Electron renderer. No app bootstrap, user workspace, model or external I/O.
 * The three app-owned disclosure/navigation listeners are extracted verbatim.
 * Routing/action sinks are spies: this checks their preserved dispatch contract,
 * not execution of approvals, source-reader windows, or transport recovery. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.AIBRO_CONVERSATION_PROCESS_OUT
  ? path.resolve(process.env.AIBRO_CONVERSATION_PROCESS_OUT)
  : path.join(ROOT, 'test-results/conversation-process-20260929');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-conversation-process-'));
fs.mkdirSync(OUT, { recursive: true }); app.setPath('userData', path.join(TEMP, 'profile'));
const source = fs.readFileSync(path.join(ROOT, 'app/app.js'), 'utf8');
function extract(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, 'Locate production code: ' + start); return source.slice(first, last);
}
const renderSource = extract('function renderRichText(', '// 提交问询卡片的回答：');
const resultHelpers = extract('function formatTokenCount(', 'function conversationProjectIds(') + '\n' + extract('function dedupeResultEntries(', 'function groupedEntities(');
const checkpointPropsSource = extract('function runCheckpointProps(', 'async function continueRunCheckpoint(');
const captureListeners = extract('// 执行过程段的“呼吸”状态', '// 输入区上方的就地操作');
assert.match(captureListeners, /conversation-process-view/);
assert.match(captureListeners, /toolLedgerPins/);
const checks = [], failures = [], observations = [], rendererErrors = [], externalRequests = [];
let win, server, stopping = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => { failures.push({ name: 'watchdog', error: '120 second timeout' }); finish(1); }, 120000);
function report() {
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ passed: checks.length, checks, failures, observations,
    rendererErrors, externalRequests, modelCalls: 0, userWorkspaceLoaded: false,
    fixture: 'Exact production renderMessage, rich-text/result/checkpoint helpers and app-owned disclosure/navigation listeners; genuine process, FileReview, RunCheckpoint, DraftReview, outcome, source, transport and Kit modules; isolated state and action sinks',
    renderMessageSha256: crypto.createHash('sha256').update(renderSource).digest('hex'),
    captureListenerSha256: crypto.createHash('sha256').update(captureListeners).digest('hex'),
    temporaryProfileRemoved: !fs.existsSync(TEMP),
  }, null, 2));
}
app.on('quit', () => { fs.rmSync(TEMP, { recursive: true, force: true }); report(); });
async function finish(code) {
  if (stopping) return; stopping = true; clearTimeout(watchdog);
  if (win && !win.isDestroyed()) win.destroy();
  if (server) await new Promise(resolve => server.close(resolve));
  fs.rmSync(TEMP, { recursive: true, force: true }); report(); app.exit(code);
}
function initializeFixture() {
  window.WorkstationI18n = { getLanguage: () => 'zh', t: text => text };
  window.Core = WorkstationCore;
  window.esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  window.uiIcon = () => '';
  window.workspaceName = value => value === '课程' || value === '科研' ? value : '日常';
  window.statusLabel = value => value;
  window.formatDate = value => String(value);
  window.currentConversation = () => state.conversations[0];
  window.visibleNote = note => !note.deletedAt && !note.archived;
  window.approveRun = { busy: new Set() };
  window.sendMessage = { busy: false, preflight: false, preparingWiki: false };
  window.runCheckpointController = null;
  window.save = () => { window.saveCount++; localStorage.setItem('conversation-process-fixture', JSON.stringify(state)); };
  window.saveCount = 0; window.actionLog = []; window.sourceLog = [];
  window.fileOpenLog = []; window.fileReviewLog = []; window.checkpointLog = [];
  window.continueRunCheckpoint = id => checkpointLog.push({ action: 'continue', id });
  window.WorkstationRunHistory = { open: id => checkpointLog.push({ action: 'history', id }) };
  FileReview.init({ getState: () => state,
    open: (runId, id) => fileReviewLog.push({ runId, id }),
    openFile: (type, id, options = {}) => fileOpenLog.push({ type, id, sourceGuard: options.sourceGuard, allowed: options.canOpen?.() === true }),
  });
  window.SourcePeek = { show: target => sourceLog.push(CitationEvidence.resolveTarget(state, target)) };
  document.addEventListener('click', event => {
    const target = event.target.closest('[data-retry-run],[data-adjust-run],[data-approve-run],[data-reject-run],[data-stop-run],[data-open-note],[data-open-import]');
    if (target) actionLog.push({ ...target.dataset });
  });
  window.createState = () => ({ conversations: [{ id: 'synthetic-conversation', messages: [] }], agentRuns: [],
    imports: [{ id: 'synthetic-pdf', name: '合成原始资料.pdf', text: '合成资料的第三页正文。', pages: [{page:3,text:'合成资料的第三页正文。'}] }],
    projects: [], notes: [{ id: 'synthetic-note', title: '合成阅读结果', content: '保存的结果正文。', workspace: '科研' }],
    tasks: [], papers: [], settings: {} });
  window.makeFixture = (mode = 'mixed', relation = 'runId') => {
    const now = Date.now();
    const message = { id: 'synthetic-message', role: 'agent', text: '正在核对合成资料。', live: true, at: now - 2000,
      steps: [{ text: '准备读取资料', status: 'done', at: now - 2000 }, { text: '已返回资料片段', status: 'done', at: now - 1000 }, { text: '正在核对引用', status: 'running', at: now }], [relation]: 'synthetic-run' };
    const run = { id: 'synthetic-run', conversationId: 'synthetic-conversation', status: 'running', startedAt: now - 2000,
      toolCalls: [{ id: 'read-one', type: 'read', status: 'running', request: { type: 'read', id: 'SYNTHETIC_ALPHA', title: '合成原始请求' } },
        { id: 'read-two', type: 'read_page', status: 'completed', request: { type: 'read_page', id: 'synthetic-pdf', page: 3 }, result: { text: '合成第三页读取结果' } }] };
    if (mode === 'tools') delete message.steps;
    if (mode === 'progress') run.toolCalls = [];
    if (mode === 'empty') { delete message.steps; run.toolCalls = []; }
    return { message, run };
  };
  window.renderFixture = previous => {
    const holder = document.createElement('div'); renderMessage(message, holder, { previous }); return holder.firstElementChild;
  };
  window.installFixture = (fixture = makeFixture()) => {
    if (window.current) { HalaskaConversation.discard(current); current.remove(); }
    window.state = createState(); window.message = fixture.message; window.run = fixture.run;
    if (fixture.notes) state.notes = fixture.notes;
    if (fixture.projects) state.projects = fixture.projects;
    if (fixture.conversation) Object.assign(state.conversations[0], fixture.conversation);
    state.conversations[0].messages.push(message); state.agentRuns.push(run);
    window.current = renderFixture(); document.querySelector('#transcript').append(current);
    current._messageAttached?.();
    return current;
  };
  window.streamFixture = (iteration, addRecord = false) => {
    message.text = '资料核对进展 ' + iteration;
    if (message.steps?.length) message.steps.at(-1).text = '收到新的公开进展 ' + iteration;
    if (addRecord) message.steps.push({ text: '新增真实合成记录 ' + iteration, status: 'done', at: Date.now() });
    AgentProgress.patchLive(current, renderFixture(current));
  };
  window.restoreFixture = () => {
    const saved = JSON.parse(localStorage.getItem('conversation-process-fixture'));
    HalaskaConversation.discard(current); current.remove(); state = saved;
    message = state.conversations[0].messages[0]; run = state.agentRuns[0]; current = renderFixture(); document.querySelector('#transcript').append(current);
    current._messageAttached?.();
  };
  window.makeHierarchyFixture = () => {
    const value = makeFixture();
    Object.assign(value.message, { live: false, runStatus: 'completed',
      text: '已整理这份资料。\n\n成果保留了可核对的正文与来源。[[cite:hierarchy-source]]',
      results: [{ type: 'note', id: 'synthetic-note', operation: 'created' }],
      usage: { total: 1250, input: 1000, output: 250 } });
    Object.assign(value.run, { status: 'completed', finishedAt: value.run.startedAt + 42000,
      results: value.message.results, memoryNoteIds: ['hierarchy-memory'],
      evidenceSources: [{ sourceId: 'hierarchy-source', type: 'import', id: 'synthetic-pdf', title: '合成原始资料.pdf', provided: true, number: 1, page: 3, excerpt: '合成资料的第三页正文。' }],
      retrievalCoverage: { strategy: 'local-bm25', eligibleRecords: 3, originalFiles: 1, textIndexedRecords: 3, metadataOnlyRecords: 0, nextOffset: null, truncated: true },
      attachmentIds: ['synthetic-pdf'], attachmentDelivery: { scope: 'prepared_representations', totalAttachments: 1, nativeAttachments: 0, textAttachments: 1, originalFiles: 0, originalImages: 0, pdfPageImages: 0 },
    });
    value.message.steps.forEach(item => { item.status = 'done'; });
    value.run.toolCalls.forEach(item => { item.status = 'completed'; });
    value.notes = [{ id: 'synthetic-note', title: '合成阅读结果', content: '# 分析成果\n\n这里是已经保存且可打开的完整正文。', workspace: '科研' },
      { id: 'hierarchy-memory', title: '项目记录：已阅读材料', content: '供后续执行使用的记录。', workspace: '科研' }];
    value.projects = [{ id: 'hierarchy-project', name: '合成阅读项目', workspace: '科研' }];
    value.conversation = { projectId: 'hierarchy-project', workspace: '科研' };
    value.run.projectId = 'hierarchy-project';
    value.notes.forEach(note => { note.projectId = 'hierarchy-project'; });
    value.run.fileChanges = FileReview.capture({ notes: [] }, { notes: [value.notes[0]] }, value.message.results);
    value.run.executionReceipt = { version: 1, id: 'hierarchy-receipt', phase: 'committed', messageId: value.message.id,
      actionCount: 1, committedAt: value.run.finishedAt, answer: value.message.text, results: value.message.results };
    return value;
  };
  window.resetFixture = installFixture;
}
(async () => {
  const assets = ['workstation-core.js', 'halaska-ui.js', 'sse-frame-scanner.js', 'agent-transport.js', 'conversation-flow.js', 'stream-code.js', 'stream-markdown.js', 'streaming-body.js', 'agent-progress.js', 'tool-scheduler.js', 'conversation-process.js', 'run-outcome-presentation.js', 'safe-preview.js', 'citation-evidence.js', 'note-editor.js', 'draft-review.js', 'file-review.js', 'run-checkpoint.js', 'halaska-conversation.js'];
  const html = '<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src \'self\'; img-src \'self\' data:">' +
    ['styles.css', 'liquid-glass.css', 'agent-progress.css', 'tool-scheduler.css', 'file-review.css', 'source-peek.css', 'run-checkpoint.css', 'agent-workbench.css'].map(file => `<link rel="stylesheet" href="/${file}">`).join('') +
    '<style>body{display:block!important;overflow:auto!important;padding:20px}main{max-width:780px;margin:auto}.message-wrap{width:100%;max-width:none;box-sizing:border-box}h1{font-size:18px}details{margin-block:6px}pre{white-space:pre-wrap}#transcript{min-width:0}</style></head>' +
    '<body class="liquid-glass light-mode reduce-motion"><main><h1>执行过程 · 生产渲染路径隔离验收</h1><div id="transcript"></div></main>' + assets.map(file => `<script src="/${file}"></script>`).join('') + '</body></html>';
  server = http.createServer((request, response) => {
    const name = new URL(request.url, 'http://localhost').pathname;
    if (name === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); return response.end(html); }
    const file = path.join(ROOT, 'app', path.basename(name));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); return response.end(); }
    response.writeHead(200, { 'Content-Type': name.endsWith('.css') ? 'text/css' : name.endsWith('.woff2') ? 'font/woff2' : 'application/javascript' }); response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 960, height: 1050, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => {
    const external = !request.url.startsWith(origin + '/'); if (external) externalRequests.push(request.url); done({ cancel: external });
  });
  const evaluate = code => win.webContents.executeJavaScript(code, true);
  const screenshot = async name => { await delay(40); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  async function check(name, fn) {
    if(process.env.AIBRO_PROCESS_CHECK&&!name.includes(process.env.AIBRO_PROCESS_CHECK))return;
    try { await fn(); checks.push(name); console.log('PASS', name); }
    catch (error) { failures.push({ name, error: error.stack }); console.error('FAIL', name, error.message); await screenshot('failure-' + failures.length); }
  }
  await win.loadURL(origin);
  await evaluate('(' + initializeFixture.toString() + ')()');
  await evaluate(resultHelpers + '\n' + checkpointPropsSource + '\n' + renderSource + '\n' + captureListeners + '\ninstallFixture()');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const key = async (selector, value = 'Space') => {
    if (selector) await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    const codes = { Space: 32, Enter: 13, ArrowRight: 39, ArrowLeft: 37, Home: 36, End: 35, Tab: 9 };
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: value === 'Space' ? ' ' : value, code: value, windowsVirtualKeyCode: codes[value] });
    await delay(30);
  };
  const toolsTab = '[role="tab"][data-value="tools"]', progressTab = '[role="tab"][data-value="progress"]';
  await check('production renderMessage has one process disclosure and embedded tools with separate truthful counts', async () => {
    const result = await evaluate(`({outer:current.querySelectorAll(':scope > .agent-progress').length,standalone:current.querySelectorAll(':scope > .tool-ledger').length,embedded:current.querySelectorAll('.conversation-process-tools > .tool-ledger').length,tabs:current.querySelectorAll('[role="tab"]').length,summary:current.querySelector('.agent-progress > summary').textContent,panels:[...current.querySelectorAll('[role="tabpanel"]')].map(p=>({id:p.id,hidden:p.hidden,labelledBy:p.getAttribute('aria-labelledby')})),canonical:Object.hasOwn(message,'processView'),kit:current.querySelector('.conversation-process-navigation').dataset.halaskaRoot})`);
    observations.push({ composition: result }); assert.equal(result.outer, 1); assert.equal(result.standalone, 0); assert.equal(result.embedded, 1); assert.equal(result.tabs, 2);
    assert.match(result.summary, /3 项进展 · 2 次工具调用/); assert.equal(result.canonical, false); assert.equal(result.kit, 'AgentProcessTabs');
    assert.deepEqual(result.panels.map(p => p.hidden), [true, false]);
    for (const panel of result.panels) assert.equal(await evaluate(`document.getElementById(${JSON.stringify(panel.labelledBy)})?.getAttribute('aria-controls')`), panel.id);
    assert.equal(await evaluate(`ToolScheduler.card(run).tagName`), 'DETAILS', 'Run-history caller retains standalone disclosure');
    await screenshot('mixed-progress-light');
  });
  await check('actual Kit tabs use arrows Home End, one tab stop and canonical persisted selection without feed pins', async () => {
    await key(progressTab, 'ArrowRight');
    assert.equal(await evaluate(`message.processView`), 'tools');
    assert.equal(await evaluate(`document.activeElement.dataset.value`), 'tools');
    await key(null, 'Home'); assert.equal(await evaluate(`message.processView`), 'progress');
    await key(null, 'End'); assert.equal(await evaluate(`message.processView`), 'tools');
    await key(null, 'ArrowRight'); assert.equal(await evaluate(`message.processView`), 'progress');
    await key(null, 'ArrowLeft'); assert.equal(await evaluate(`message.processView`), 'tools');
    const result = await evaluate(`({tabstops:current.querySelectorAll('[role="tab"][tabindex="0"]').length,selected:current.querySelectorAll('[role="tab"][aria-selected="true"]').length,feedPins:message.progressPins||null,saved:JSON.parse(localStorage.getItem('conversation-process-fixture')).conversations[0].messages[0].processView,visible:current.querySelector('.conversation-process-tools').hidden===false})`);
    observations.push({ tabKeyboard: result }); assert.equal(result.tabstops, 1); assert.equal(result.selected, 1); assert.equal(result.feedPins, null); assert.equal(result.saved, 'tools'); assert.equal(result.visible, true);
    await key(null, 'Tab'); assert.equal(await evaluate(`document.activeElement.getAttribute('role')==='tab'`), false, 'Tab exits the roving tab list');
  });
  await check('focused tab and connected Kit navigation retain identity across 20 count-changing stream deltas', async () => {
    const result = await evaluate(`(()=>{window.originalTab=current.querySelector('[role="tab"][data-value="tools"]');originalTab.focus();const host=originalTab.closest('[data-halaska-root]'),samples=[];let mounts=0;const originalMount=HalaskaUI.mount;HalaskaUI.mount=function(el,name,...args){if(name==='AgentProcessTabs')mounts++;return originalMount.call(this,el,name,...args)};try{for(let i=0;i<20;i++){streamFixture(i,true);samples.push({tab:current.querySelector('[role="tab"][data-value="tools"]')===originalTab,host:current.querySelector('.conversation-process-navigation')===host,focus:document.activeElement===originalTab,label:originalTab.textContent,view:message.processView})}}finally{HalaskaUI.mount=originalMount}return{samples,mounts,aria:originalTab.getAttribute('aria-label'),count:current.querySelector('.conversation-process-navigation').dataset.progressCount}})()`);
    observations.push({ focusedTabStream: result }); assert.equal(result.mounts, 0, 'Deferred owned roots must not remount navigation per delta'); assert.equal(result.count, '23');
    for (const sample of result.samples) { assert.equal(sample.tab, true); assert.equal(sample.host, true); assert.equal(sample.focus, true); assert.equal(sample.label, '工具'); assert.equal(sample.view, 'tools'); }
  });
  await check('raw request selection, focused summary and open intent survive new result/new tool and 20 stream deltas', async () => {
    await key('.tool-ledger-raw > summary');
    const result = await evaluate(`(()=>{window.originalRaw=current.querySelector('.tool-ledger-raw');const summary=originalRaw.querySelector('summary'),text=originalRaw.querySelector('pre').firstChild,start=text.nodeValue.indexOf('SYNTHETIC_ALPHA');summary.focus();const range=document.createRange();range.setStart(text,start);range.setEnd(text,start+15);getSelection().removeAllRanges();getSelection().addRange(range);const samples=[];for(let i=0;i<20;i++){if(i===4)run.toolCalls[0].result={text:'新的真实合成读取结果'};if(i===11)run.toolCalls.push({id:'read-three',type:'read',status:'completed',request:{id:'SYNTHETIC_BETA'},result:{text:'第三次工具结果'}});streamFixture(i);samples.push({raw:current.querySelector('.tool-ledger-raw')===originalRaw,text:originalRaw.querySelector('pre').firstChild===text,focus:document.activeElement===summary,selection:getSelection().toString(),open:originalRaw.open})}return{samples,pins:run.toolLedgerPins,saved:JSON.parse(localStorage.getItem('conversation-process-fixture')).agentRuns[0].toolLedgerPins,rows:current.querySelectorAll('.tool-ledger-row').length,blocks:originalRaw.querySelectorAll('pre').length}})()`);
    observations.push({ rawStream: result });
    for (const sample of result.samples) { assert.equal(sample.raw, true); assert.equal(sample.text, true); assert.equal(sample.focus, true); assert.equal(sample.open, true); assert.equal(sample.selection, 'SYNTHETIC_ALPHA'); }
    assert.equal(result.pins['raw:read-one'], true); assert.equal(result.saved['raw:read-one'], true); assert.equal(result.rows, 3); assert.equal(result.blocks, 2);
    await screenshot('tools-selection-light');
  });
  await check('switching panels retains raw nodes and synthetic reload restores tab and disclosure preferences', async () => {
    await evaluate(`current.querySelector('[role="tab"][data-value="progress"]').click();current.querySelector('[role="tab"][data-value="tools"]').click()`);
    assert.equal(await evaluate(`current.querySelector('.tool-ledger-raw')===originalRaw&&originalRaw.open`), true);
    await evaluate(`save();restoreFixture()`);
    assert.equal(await evaluate(`message.processView`), 'tools'); assert.equal(await evaluate(`current.querySelector('.conversation-process-tools').hidden`), false); assert.equal(await evaluate(`current.querySelector('.tool-ledger-raw').open`), true);
    await key('.tool-ledger-raw > summary'); await evaluate(`streamFixture('closed');save();restoreFixture()`);
    assert.equal(await evaluate(`run.toolLedgerPins['raw:read-one']`), false); assert.equal(await evaluate(`current.querySelector('.tool-ledger-raw').open`), false);
  });
  await check('retry-only and pending-only run relations persist raw intent in the canonical run', async () => {
    for (const relation of ['retryRunId', 'pendingRunId']) {
      await evaluate(`(()=>{const value=makeFixture('mixed',${JSON.stringify(relation)});value.message.live=false;value.message.progressPins={feed:true};value.run.status=${JSON.stringify(relation === 'retryRunId' ? 'failed' : 'awaiting-approval')};value.run.error='合成中断';value.run.toolLedgerPins={'read-one':true};installFixture(value);current.querySelector('[role="tab"][data-value="tools"]').click()})()`);
      await key('.tool-ledger-raw > summary');
      const result = await evaluate(`({runId:message.runId||null,pin:run.toolLedgerPins['raw:read-one'],saved:JSON.parse(localStorage.getItem('conversation-process-fixture')).agentRuns[0].toolLedgerPins['raw:read-one'],view:message.processView})`);
      observations.push({ relation, result }); assert.equal(result.runId, null); assert.equal(result.pin, true); assert.equal(result.saved, true); assert.equal(result.view, 'tools');
    }
  });
  await check('protocol display clone keeps original DSML byte-for-byte while tab and raw pins update canonical state', async () => {
    await evaluate(`(()=>{const value=makeFixture();value.message.live=false;value.message.text='< | DSML | calls>\\n< | DSML | invoke name="read_page">\\nSYNTHETIC_ORIGINAL_PROTOCOL\\n</ | DSML | invoke>\\n</ | DSML | calls>';value.message.progressPins={feed:true};value.run.status='completed';value.run.finishedAt=Date.now();value.run.toolLedgerPins={'read-one':true};window.originalProtocol=value.message.text;installFixture(value);current.querySelector('[role="tab"][data-value="tools"]').click()})()`);
    await key('.tool-ledger-raw > summary');
    const result = await evaluate(`({unchanged:message.text===originalProtocol,status:run.status,view:message.processView,rawPin:run.toolLedgerPins['raw:read-one'],inspection:[...current.querySelectorAll(':scope>details')].find(d=>d.querySelector('summary')?.textContent==='查看原始异常回复')?.querySelector('pre')?.textContent,body:current.querySelector('.message-body').textContent,bodyHidden:current.querySelector('.message-body').hidden,card:current.querySelector('.message-actions').textContent,retry:current.querySelectorAll('[data-retry-run]').length,adjust:current.querySelectorAll('[data-adjust-run]').length})`);
    observations.push({ protocolClone: result }); assert.equal(result.unchanged, true); assert.equal(result.status, 'completed'); assert.equal(result.view, 'tools'); assert.equal(result.rawPin, true); assert.equal(result.inspection, await evaluate('originalProtocol')); assert.equal(result.body, ''); assert.equal(result.bodyHidden, true); assert.match(result.card, /未执行的工具调用格式/); assert.equal(result.retry, 1); assert.equal(result.adjust, 0);
  });
  await check('save-pending display clone preserves canonical history and exposes one save-only action', async () => {
    await evaluate(`(()=>{const value=makeFixture('mixed','pendingRunId');value.message.live=false;value.message.text='原始历史回答';value.message.progressPins={feed:true};value.run.status='completed';value.run.approvalReceipt={savePending:true,baseText:'已有结果，等待保存确认。'};value.run.approvalSaveError='合成保存失败';value.run.toolLedgerPins={'read-one':true};installFixture(value);current.querySelector('[role="tab"][data-value="tools"]').click()})()`);
    await key('.tool-ledger-raw > summary');
    const result = await evaluate(`({text:message.text,status:run.status,view:message.processView,pin:run.toolLedgerPins['raw:read-one'],body:current.querySelector('.message-body').textContent,saveButtons:current.querySelectorAll('[data-retry-approval-save]').length,approveButtons:current.querySelectorAll('[data-approve-run]').length,pending:current.querySelector('.pending-actions').textContent,saveDataset:current.querySelector('[data-retry-approval-save]').dataset.retryApprovalSave})`);
    observations.push({ savePendingClone: result }); assert.equal(result.text, '原始历史回答'); assert.equal(result.status, 'completed'); assert.equal(result.view, 'tools'); assert.equal(result.pin, true); assert.equal(result.body, '已有结果，等待保存确认。'); assert.equal(result.saveButtons, 1); assert.equal(result.approveButtons, 0); assert.equal(result.saveDataset, 'synthetic-run'); assert.match(result.pending, /只保存|不会再次执行/);
  });
  await check('tools-only and progress-only histories have truthful panels without empty tab bars or fake events', async () => {
    for (const mode of ['tools', 'progress', 'empty']) {
      const result = await evaluate(`(()=>{const value=makeFixture(${JSON.stringify(mode)});value.message.live=false;value.run.status='completed';value.run.finishedAt=Date.now();installFixture(value);const nav=current.querySelector('.conversation-process-navigation');return{outer:current.querySelectorAll('.agent-progress').length,tabs:[...current.querySelectorAll('[role="tab"]')].filter(tab=>tab.getClientRects().length>0).length,navHidden:nav?.hidden??null,view:nav?.dataset.view||null,rows:current.querySelectorAll('.progress-item').length,tools:current.querySelectorAll('.tool-ledger-row').length,pins:message.progressPins||null}})()`);
      observations.push({ mode, result }); assert.equal(result.outer, mode === 'empty' ? 0 : 1); assert.equal(result.tabs, 0); assert.equal(result.navHidden, mode === 'empty' ? null : true); assert.equal(result.view, mode === 'empty' ? null : mode); assert.equal(result.rows, mode === 'progress' ? 3 : 0); assert.equal(result.tools, mode === 'tools' ? 2 : 0); assert.equal(result.pins, null);
    }
  });
  await check('explicit feed close outranks legacy raw-open pins and fallback does not persist defaults during rendering', async () => {
    const result = await evaluate(`(()=>{const value=makeFixture();value.message.live=false;value.message.processView='obsolete';value.message.progressPins={feed:false};value.run.status='cancelled';value.run.toolLedgerPins={'raw:read-one':true};const before=saveCount;installFixture(value);const first={feed:current.querySelector('.agent-progress').open,view:current.querySelector('.conversation-process-navigation').dataset.view,stored:message.processView,saves:saveCount-before};delete message.progressPins.feed;AgentProgress.patchLive(current,renderFixture(current));return{first,legacyOpen:current.querySelector('.agent-progress').open,legacyRaw:current.querySelector('.tool-ledger-raw').open}})()`);
    observations.push({ feedPriority: result }); assert.equal(result.first.feed, false); assert.equal(result.first.view, 'tools'); assert.equal(result.first.stored, 'obsolete'); assert.equal(result.first.saves, 0); assert.equal(result.legacyOpen, true); assert.equal(result.legacyRaw, true);
  });
  await check('a later first tool preserves the existing progress panel and focused step Kit root', async () => {
    const result = await evaluate(`(()=>{const value=makeFixture('progress');value.message.steps[0].detail='实际上下文准备记录';installFixture(value);const nav=current.querySelector('.conversation-process-navigation'),tab=nav.querySelector('[role="tab"][data-value="progress"]'),panel=current.querySelector('.conversation-process-progress'),row=panel.querySelector('.progress-item'),summary=row.querySelector('summary'),island=summary.querySelector('[data-halaska-root]');summary.focus();run.toolCalls=makeFixture().run.toolCalls;AgentProgress.patchLive(current,renderFixture(current));return{nav:current.querySelector('.conversation-process-navigation')===nav,tab:nav.querySelector('[role="tab"][data-value="progress"]')===tab,visible:!nav.hidden,panel:current.querySelector('.conversation-process-progress')===panel,row:panel.querySelector('.progress-item')===row,island:summary.querySelector('[data-halaska-root]')===island,focus:document.activeElement===summary,tabs:current.querySelectorAll('[role="tab"]').length,tools:current.querySelectorAll('.tool-ledger-row').length}})()`);
    observations.push({ firstToolDelta: result }); for (const key of ['nav', 'tab', 'visible', 'panel', 'row', 'island', 'focus']) assert.equal(result[key], true, key); assert.equal(result.tabs, 2); assert.equal(result.tools, 2);
  });
  await check('generated failure and cancel envelopes display once while historical bytes and meaningful partial output remain', async () => {
    for (const status of ['failed', 'cancelled']) {
      const result = await evaluate(`(()=>{const value=makeFixture('mixed','retryRunId');value.message.live=false;value.run.status=${JSON.stringify(status)};value.run.error=${JSON.stringify(status === 'cancelled' ? '已停止本次执行' : 'SYNTHETIC_503_READ_FAILURE')};value.message.text=(${JSON.stringify(status)}==='cancelled'?'已停止本次执行：':'调用失败：')+value.run.error+'\\n\\n尚未执行任何动作。可以重试，或点击“调整附件后重试”移除有问题的附件；也可以直接在下方继续对话。';const original=value.message.text;installFixture(value);const first={body:current.querySelector('.message-body').textContent,bodyHidden:current.querySelector('.message-body').hidden,card:current.querySelector('.message-actions').textContent,unchanged:message.text===original,errorOccurrences:current.textContent.split(run.error).length-1};message.text='已经整理的第一段结果。\\n\\n**这一部分仍然有价值。**';const partial=message.text;AgentProgress.patchLive(current,renderFixture(current));return{first,partialStored:message.text===partial,partialBody:current.querySelector('.message-body').textContent,partialHidden:current.querySelector('.message-body').hidden}})()`);
      observations.push({ status, failurePresentation: result }); assert.equal(result.first.body, ''); assert.equal(result.first.bodyHidden, true); assert.equal(result.first.unchanged, true); assert.doesNotMatch(result.first.card, /尚未执行任何动作/); assert.match(result.first.card, /工具与资料读取记录仍可查看/); assert.equal(result.first.errorOccurrences, status === 'cancelled' ? 0 : 1); assert.equal(result.partialStored, true); assert.match(result.partialBody, /已经整理的第一段结果。.*这一部分仍然有价值/s); assert.equal(result.partialHidden, false);
    }
  });
  await check('production sources, results and approval/retry actions keep their existing dispatch contracts once', async () => {
    await evaluate(`(()=>{const value=makeFixture();value.message.live=false;value.message.pendingRunId=value.run.id;value.run.status='awaiting-approval';value.run.pendingActions=[{type:'create_note'}];value.message.results=[{type:'note',id:'synthetic-note',operation:'created'}];value.run.evidenceSources=[{sourceId:'synthetic-evidence',type:'import',id:'synthetic-pdf',title:'合成原始资料.pdf',provided:true,number:1,page:3,excerpt:'合成资料的第三页正文。'}];installFixture(value);window.actionLog=[];window.sourceLog=[];current.querySelector('.citation-sources').open=true;})()`);
    await delay(40);
    await evaluate(`(()=>{current.querySelector('.citation-source-title button').click();current.querySelector('[data-open-note]').click();current.querySelector('[data-approve-run]').click()})()`);
    const result = await evaluate(`({source:sourceLog[0],actionLog,approveButtons:current.querySelectorAll('[data-approve-run]').length,sourceOutside:current.querySelector('.citation-sources').parentElement===current,resultOutside:current.querySelector('.message-result-links').parentElement===current,process:current.querySelectorAll('.agent-progress').length})`);
    observations.push({ preservedContracts: result }); assert.equal(result.source.source.page, 3); assert.equal(result.source.source.id, 'synthetic-pdf'); assert.deepEqual(result.actionLog, [{ openNote: 'synthetic-note' }, { approveRun: 'synthetic-run' }]); assert.equal(result.approveButtons, 1); assert.equal(result.sourceOutside, true); assert.equal(result.resultOutside, true); assert.equal(result.process, 1);
    await evaluate(`(()=>{const value=makeFixture('mixed','retryRunId');value.message.live=false;value.run.status='failed';value.run.error='合成失败';installFixture(value);actionLog=[];current.querySelector('[data-retry-run]').click();current.querySelector('[data-adjust-run]').click()})()`);
    assert.deepEqual(await evaluate('actionLog'), [{ retryRun: 'synthetic-run' }, { adjustRun: 'synthetic-run', i18n: '' }]);
  });
  await check('completed answer leads to one real Kit result then sources while settled records stay inside the process', async () => {
    await evaluate(`installFixture(makeHierarchyFixture());fileOpenLog=[];fileReviewLog=[];checkpointLog=[];actionLog=[]`);
    const result = await evaluate(`(()=>{const body=current.querySelector(':scope>.message-body'),file=current.querySelector(':scope>.file-change-card'),sources=current.querySelector(':scope>.citation-sources'),records=current.querySelector('.conversation-process-records'),memory=records?.querySelector('[data-open-note="hierarchy-memory"]'),receipt=records?.querySelector('.run-checkpoint-host');return{process:current.querySelectorAll(':scope>.agent-progress').length,feedOpen:current.querySelector('.agent-progress').open,body:body.textContent,fileKit:file?.dataset.halaskaRoot,fileRows:file?.querySelectorAll('.file-change-row').length,resultDuplicates:current.querySelectorAll('.message-result-links').length,answerBeforeFile:!!(body.compareDocumentPosition(file)&Node.DOCUMENT_POSITION_FOLLOWING),fileBeforeSources:!!(file.compareDocumentPosition(sources)&Node.DOCUMENT_POSITION_FOLLOWING),sources:current.querySelectorAll('.citation-sources').length,sourcesOpen:sources.open,recordsInside:records?.parentElement===current.querySelector('.agent-progress'),memory:memory?.textContent,memoryVisible:memory?.checkVisibility({contentVisibilityAuto:true,checkVisibilityCSS:true}),receiptKit:receipt?.dataset.halaskaRoot,receiptText:receipt?.textContent,receiptVisible:receipt?.checkVisibility({contentVisibilityAuto:true,checkVisibilityCSS:true}),footerElapsed:current.querySelectorAll('.message-meta .meta-elapsed').length,summary:current.querySelector('.agent-progress>summary').textContent,tokens:current.querySelector('.meta-usage')?.textContent}})()`);
    observations.push({ completedHierarchy: result }); assert.equal(result.process, 1); assert.equal(result.feedOpen, false); assert.match(result.body, /成果保留了可核对的正文与来源/);
    assert.equal(result.fileKit, 'ReviewChangeCard'); assert.equal(result.fileRows, 1); assert.equal(result.resultDuplicates, 0); assert.equal(result.answerBeforeFile, true); assert.equal(result.fileBeforeSources, true);
    assert.equal(result.sources, 1); assert.equal(result.sourcesOpen, false); assert.equal(result.recordsInside, true); assert.match(result.memory, /项目记录：已阅读材料/); assert.equal(result.memoryVisible, false);
    assert.equal(result.receiptKit, 'RunCheckpointCard'); assert.match(result.receiptText, /结果已保存/); assert.equal(result.receiptVisible, false); assert.equal(result.footerElapsed, 0); assert.match(result.summary, /42 秒/); assert.match(result.tokens, /tokens/);
    await evaluate(`current.querySelector('.file-change-card [aria-label^="打开文档"]').click();current.querySelector('.file-change-card [aria-label^="审阅修改"]').click()`);
    assert.deepEqual(await evaluate('fileOpenLog'), [{ type: 'note', id: 'synthetic-note', sourceGuard: { type: 'note', id: 'synthetic-note', runId: 'synthetic-run', conversationId: 'synthetic-conversation' }, allowed: true }]);
    assert.deepEqual(await evaluate('fileReviewLog'), [{ runId: 'synthetic-run', id: 'synthetic-note' }]);
    await screenshot('hierarchy-completed-light');
  });
  await check('keyboard expansion reveals settled records and two final refreshes preserve the connected receipt and history action', async () => {
    await key('.agent-progress > summary');
    const before = await evaluate(`(()=>{window.settledRecords=current.querySelector('.conversation-process-records');window.settledReceipt=settledRecords.querySelector('.run-checkpoint-host');const memory=settledRecords.querySelector('[data-open-note="hierarchy-memory"]');memory.click();return{open:current.querySelector('.agent-progress').open,pin:message.progressPins.feed,memoryVisible:memory.checkVisibility({contentVisibilityAuto:true,checkVisibilityCSS:true}),receiptVisible:settledReceipt.checkVisibility({contentVisibilityAuto:true,checkVisibilityCSS:true}),actions:actionLog}})()`);
    observations.push({ expandedRecords: before }); assert.equal(before.open, true); assert.equal(before.pin, true); assert.equal(before.memoryVisible, true); assert.equal(before.receiptVisible, true); assert.deepEqual(before.actions, [{ openNote: 'hierarchy-memory' }]);
    const samples = [];
    for (let iteration = 0; iteration < 2; iteration++) {
      await evaluate(`(()=>{const next=renderFixture(current);AgentProgress.patchLive(current,next);next._messageAttached?.()})()`); await delay(30);
      samples.push(await evaluate(`({records:current.querySelector('.conversation-process-records')===settledRecords,receipt:current.querySelector('.run-checkpoint-host')===settledReceipt,kit:settledReceipt.dataset.halaskaRoot,text:settledReceipt.textContent,buttons:settledReceipt.querySelectorAll('button').length,visible:settledReceipt.checkVisibility({contentVisibilityAuto:true,checkVisibilityCSS:true}),pin:message.progressPins.feed,feed:current.querySelector('.agent-progress').open,duplicates:current.querySelectorAll('.run-checkpoint-host').length})`));
    }
    observations.push({ committedRefreshes: samples });
    for (const sample of samples) { assert.equal(sample.records, true); assert.equal(sample.receipt, true); assert.equal(sample.kit, 'RunCheckpointCard'); assert.match(sample.text, /结果已保存.*查看执行记录/s); assert.equal(sample.buttons, 1); assert.equal(sample.visible, true); assert.equal(sample.pin, true); assert.equal(sample.feed, true); assert.equal(sample.duplicates, 1); }
    await evaluate(`settledReceipt.querySelector('button').click()`); assert.deepEqual(await evaluate('checkpointLog'), [{ action: 'history', id: 'synthetic-run' }]);
    await screenshot('hierarchy-records-expanded-light');
  });
  await check('pending draft and unsaved checkpoint remain visible outside a closed process without claiming persistence', async () => {
    await evaluate(`(()=>{const value=makeHierarchyFixture();value.message.progressPins={feed:false};value.notes.push({id:'hierarchy-draft',title:'待确认的分析',content:'尚未替换的原正文。',projectId:'hierarchy-project',workspace:'科研',aiDraft:{title:'新的分析建议',content:'需要用户确认的新草稿。'}});value.run.memoryNoteIds.push('hierarchy-draft');installFixture(value)})()`);
    const draft = await evaluate(`(()=>{const card=current.querySelector('.draft-review-card'),link=current.querySelector('[data-open-note="hierarchy-draft"]');return{feed:current.querySelector('.agent-progress').open,cardOutside:card?.parentElement===current,visible:card?.checkVisibility({contentVisibilityAuto:true,checkVisibilityCSS:true}),text:card?.textContent,linkOutside:link?.closest('.agent-progress')===null,body:state.notes.find(note=>note.id==='hierarchy-draft').content,preview:card?.querySelector('pre')?.textContent,actions:[...card.querySelectorAll('button')].map(button=>button.textContent)}})()`);
    observations.push({ pendingDraft: draft }); assert.equal(draft.feed, false); assert.equal(draft.cardOutside, true); assert.equal(draft.visible, true); assert.equal(draft.linkOutside, true); assert.equal(draft.body, '尚未替换的原正文。'); assert.equal(draft.preview, '需要用户确认的新草稿。'); assert.deepEqual(draft.actions, ['采纳并保存', '放弃草稿']);
    await screenshot('hierarchy-pending-draft-light');
    await evaluate(`(()=>{const value=makeHierarchyFixture();value.message.progressPins={feed:false};value.message.pendingRunId=value.run.id;value.message.runStatus='awaiting-save';value.run.status='awaiting-save';value.run.executionReceipt.phase='applied';value.run.executionReceipt.appliedAt=value.run.finishedAt;delete value.run.executionReceipt.committedAt;value.run.executionReceipt.error='合成持久化尚未确认';installFixture(value);checkpointLog=[];fileOpenLog=[]})()`);
    const pending = await evaluate(`(()=>{const host=current.querySelector('.run-checkpoint-host'),save=[...host.querySelectorAll('button')].find(button=>button.textContent==='继续保存结果');save.click();return{feed:current.querySelector('.agent-progress').open,outside:host.parentElement===current,visible:host.checkVisibility({contentVisibilityAuto:true,checkVisibilityCSS:true}),kit:host.dataset.halaskaRoot,phase:host.querySelector('[data-checkpoint-phase]')?.dataset.checkpointPhase,text:host.textContent,saveButtons:[...host.querySelectorAll('button')].filter(button=>button.textContent==='继续保存结果').length,executeButtons:current.querySelectorAll('[data-approve-run],[data-retry-run]').length,resultOpen:current.querySelectorAll('.file-change-card [aria-label^="打开文档"]').length,resultStatus:current.querySelector('.file-result-status')?.textContent,checkpointLog,receiptPhase:run.executionReceipt.phase,fileOpenLog}})()`);
    observations.push({ pendingSave: pending }); assert.equal(pending.feed, false); assert.equal(pending.outside, true); assert.equal(pending.visible, true); assert.equal(pending.kit, 'RunCheckpointCard'); assert.equal(pending.phase, 'applied'); assert.match(pending.text, /等待保存确认/); assert.equal(pending.saveButtons, 1); assert.equal(pending.executeButtons, 0); assert.equal(pending.resultOpen, 0); assert.equal(pending.resultStatus, '等待保存'); assert.deepEqual(pending.checkpointLog, [{ action: 'continue', id: 'synthetic-run' }]); assert.equal(pending.receiptPhase, 'applied'); assert.deepEqual(pending.fileOpenLog, []);
    await screenshot('hierarchy-awaiting-save-light');
  });
  await check('failed and stopped responses retain one copy action, preserve partial prose and suppress save-document for empty display bodies', async () => {
    for (const status of ['failed', 'cancelled']) {
      await evaluate(`(()=>{const value=makeHierarchyFixture();delete value.run.executionReceipt;delete value.run.fileChanges;delete value.message.results;value.run.results=[];value.message.retryRunId=value.run.id;value.message.progressPins={feed:false};value.run.status=${JSON.stringify(status)};value.message.runStatus=value.run.status;value.run.error=value.run.status==='cancelled'?'已停止本次执行':'合成连接中断';value.message.text=(value.run.status==='cancelled'?'已停止本次执行：':'调用失败：')+value.run.error;installFixture(value)})()`);
      const empty = await evaluate(`({body:current.querySelector('.message-body').textContent,hidden:current.querySelector('.message-body').hidden,copy:current.querySelectorAll('[data-copy-message]').length,saveDocument:current.querySelectorAll('[data-save-note]').length,recoveryOutside:current.querySelector('.message-actions').parentElement===current,recoveryVisible:current.querySelector('.message-actions').checkVisibility({contentVisibilityAuto:true,checkVisibilityCSS:true}),sources:current.querySelectorAll('.citation-sources').length,feed:current.querySelector('.agent-progress').open})`);
      assert.equal(empty.body, ''); assert.equal(empty.hidden, true); assert.equal(empty.copy, 1); assert.equal(empty.saveDocument, 0); assert.equal(empty.recoveryOutside, true); assert.equal(empty.recoveryVisible, true); assert.equal(empty.sources, 1); assert.equal(empty.feed, false);
      await evaluate(`(()=>{message.text='已完成的第一段分析仍可使用。\\n\\n**保留这个结论与引用。** [[cite:hierarchy-source]]';const next=renderFixture(current);AgentProgress.patchLive(current,next);next._messageAttached?.()})()`);
      const partial = await evaluate(`({body:current.querySelector('.message-body').textContent,hidden:current.querySelector('.message-body').hidden,copy:current.querySelectorAll('[data-copy-message]').length,saveDocument:current.querySelectorAll('[data-save-note]').length,sources:current.querySelectorAll('.citation-sources').length,stored:message.text,status:run.status,feed:current.querySelector('.agent-progress').open})`);
      observations.push({ status, partialRecoveryHierarchy: { empty, partial } }); assert.match(partial.body, /已完成的第一段分析仍可使用.*保留这个结论与引用/s); assert.equal(partial.hidden, false); assert.equal(partial.copy, 1); assert.equal(partial.saveDocument, 1); assert.equal(partial.sources, 1); assert.match(partial.stored, /\[\[cite:hierarchy-source\]\]/); assert.equal(partial.status, status); assert.equal(partial.feed, false);
    }
    await screenshot('hierarchy-stopped-partial-light');
  });
  await check('live process records retain node identity focus and explicit open intent across twenty stream patches', async () => {
    await evaluate(`(()=>{const value=makeHierarchyFixture();delete value.run.executionReceipt;delete value.run.fileChanges;delete value.message.results;value.run.results=[];value.message.live=true;value.message.runStatus='running';value.run.status='running';delete value.run.finishedAt;value.message.progressPins={feed:true};value.message.processView='tools';installFixture(value)})()`);
    const result = await evaluate(`(()=>{const records=current.querySelector('.conversation-process-records'),memory=records.querySelector('[data-open-note="hierarchy-memory"]');memory.focus();const samples=[];for(let i=0;i<20;i++){streamFixture(i);samples.push({records:current.querySelector('.conversation-process-records')===records,memory:current.querySelector('[data-open-note="hierarchy-memory"]')===memory,focus:document.activeElement===memory,visible:memory.checkVisibility({contentVisibilityAuto:true,checkVisibilityCSS:true}),feed:current.querySelector('.agent-progress').open,pin:message.progressPins.feed,view:message.processView,count:current.querySelectorAll('.message-project-record-group').length,outside:current.querySelectorAll(':scope>.message-project-record-group').length})}return{samples,body:current.querySelector('.message-body').textContent}})()`);
    observations.push({ liveRecords: result }); for (const sample of result.samples) { assert.equal(sample.records, true); assert.equal(sample.memory, true); assert.equal(sample.focus, true); assert.equal(sample.visible, true); assert.equal(sample.feed, true); assert.equal(sample.pin, true); assert.equal(sample.view, 'tools'); assert.equal(sample.count, 1); assert.equal(sample.outside, 0); } assert.match(result.body, /资料核对进展 19/);
  });
  await check('new reasoning never conceals the tool output being selected under an automatic tab', async () => {
    const result=await evaluate(`(()=>{const value=makeFixture();delete value.message.processView;value.run.toolCalls[0].result={text:'Selected real synthetic tool output'};installFixture(value);const line=current.querySelector('.tool-ledger-row .tool-ledger-line span:last-child');const range=document.createRange();range.selectNodeContents(line);getSelection().removeAllRanges();getSelection().addRange(range);const before=getSelection().toString();message.activities=[{id:'new-reason',kind:'summary',text:'A new real reasoning segment',status:'running',at:Date.now()}];AgentProgress.patchLive(current,renderFixture(current));const held={view:current.querySelector('.conversation-process-navigation').dataset.view,visible:!current.querySelector('.conversation-process-tools').hidden,selected:getSelection().toString(),stored:message.processView||null};getSelection().removeAllRanges();document.activeElement.blur();AgentProgress.patchLive(current,renderFixture(current));return{before,held,released:current.querySelector('.conversation-process-navigation').dataset.view}})()`);
    assert.equal(result.held.view,'tools');assert.equal(result.held.visible,true);assert.equal(result.held.selected,result.before);assert.equal(result.held.stored,null);assert.equal(result.released,'progress');
  });
  await check('continuous flow never adds a plan placeholder while legacy live rendering keeps its existing fallback', async () => {
    for (const mode of ['empty','reasoning','tool']) {
      const result = await evaluate(`(()=>{const value=makeFixture('empty');value.message.text='';value.message.planPreview=true;const flow=ConversationFlow.create(value.message);if(${JSON.stringify(mode)}==='reasoning')flow.activity({id:'actual-reason',kind:'summary',attemptId:'attempt',status:'running',text:'Actual recorded reasoning'});if(${JSON.stringify(mode)}==='tool'){value.run.toolCalls.push({id:'actual-tool',type:'read',status:'running',request:{type:'read',id:'paper'}});flow.tool(value.run.toolCalls[0])}installFixture(value);return{placeholder:current.querySelectorAll('.plan-streaming-state').length,flowCount:current.querySelectorAll('.conversation-flow-item').length,text:current.querySelector('.conversation-flow')?.textContent||'',planPreview:message.planPreview,body:current.querySelector(':scope>.message-body').textContent}})()`);
      observations.push({ continuousPlanGuard: { mode, ...result } }); assert.equal(result.placeholder,0); assert.equal(result.planPreview,true); assert.equal(result.body,''); assert.equal(result.flowCount,mode==='empty'?0:1);
      if (mode==='reasoning') assert.match(result.text,/Actual recorded reasoning/);
    }
    const legacy = await evaluate(`(()=>{const value=makeFixture('empty');value.message.planPreview=true;installFixture(value);return{placeholder:current.querySelector('.plan-streaming-state')?.textContent,hasFlow:!!message.conversationFlow}})()`);
    assert.equal(legacy.placeholder,'结构化执行计划生成中…'); assert.equal(legacy.hasFlow,false);
  });
  await check('continuous recorded flow uses real Kit summaries, exact tool receipts and one final answer without tabs', async () => {
    const result = await evaluate(`(()=>{const value=makeFixture();value.message.text='唯一最终答复';value.message.live=false;value.run.status='completed';value.run.toolCalls=value.run.toolCalls.slice(0,1);value.run.toolCalls[0].status='completed';value.run.toolCalls[0].result={text:'真实工具输出'};const recorder=ConversationFlow.create(value.message);recorder.activity({id:'reasoning-first',kind:'summary',attemptId:'flow-a1',status:'completed',text:'先读取资料。\\n再核对真实输出。'});recorder.response('flow-a1','中间说明 <script>不能执行</script>',{status:'completed'});recorder.tool(value.run.toolCalls[0]);recorder.response('flow-a2',value.message.text,{status:'completed'});installFixture(value);window.flowRecorder=ConversationFlow.create(message);return{order:[...current.querySelector('.conversation-flow').children].map(n=>n.dataset.flowKind),tabs:current.querySelectorAll('[role="tab"]').length,tools:current.querySelectorAll('.tool-ledger-row').length,finals:current.textContent.split('唯一最终答复').length-1,reasoningOpen:current.querySelector('.conversation-flow-reasoning-details').open,preview:current.querySelector('.conversation-flow-reasoning-details>summary').textContent,reasoningKit:current.querySelector('.conversation-flow-reasoning-details>summary [data-halaska-root]')?.dataset.halaskaRoot,feedKit:current.querySelector('.agent-progress>summary [data-halaska-root]')?.dataset.halaskaRoot,diagnosticsOpen:current.querySelector('.conversation-flow-diagnostics').open,scripts:current.querySelector('.conversation-flow').querySelectorAll('script').length,body:current.querySelector('.message-body').textContent}})()`);
    observations.push({ continuousComposition: result });
    assert.deepEqual(result.order, ['reasoning','response','tool']); assert.equal(result.tabs, 0); assert.equal(result.tools, 1); assert.equal(result.finals, 1);
    assert.equal(result.reasoningOpen, false); assert.match(result.preview, /再核对真实输出/); assert.equal(result.reasoningKit, 'AgentActivitySummary'); assert.equal(result.feedKit, 'AgentLifecycleSummary');
    assert.equal(result.diagnosticsOpen, false); assert.equal(result.scripts, 0); assert.equal(result.body, '唯一最终答复');
  });
  await check('continuous reasoning and tool detail keep keyboard pins, owned roots and real Range selection through stream updates', async () => {
    await evaluate(`(()=>{const value=makeFixture();value.run.toolCalls=value.run.toolCalls.slice(0,1);value.run.toolCalls[0].result={text:'已记录输出。'.repeat(900)+'TAIL-A'};const recorder=ConversationFlow.create(value.message);recorder.activity({id:'reasoning-live',kind:'summary',attemptId:'live-a1',status:'running',text:'完整思考内容\\n当前进度'});recorder.tool(value.run.toolCalls[0]);installFixture(value);window.flowRecorder=ConversationFlow.create(message)})()`);
    await key('.conversation-flow-reasoning-details>summary','Enter');
    const before = await evaluate(`(()=>{const detail=current.querySelector('.conversation-flow-reasoning-details');window.flowReasoning=detail;window.flowReasoningKit=detail.querySelector('[data-halaska-root]');const field=current.querySelector('.tool-ledger-text-field');field.querySelector('summary').click();const body=field.querySelector('.tool-ledger-full-text');body.focus();const range=document.createRange();range.setStart(body.firstChild,1);range.setEnd(body.firstChild,7);getSelection().removeAllRanges();getSelection().addRange(range);window.flowField=field;window.flowText=body.firstChild;window.flowSelected=getSelection().toString();return{reasoningOpen:detail.open,pinned:message.progressPins[detail.dataset.progressKey],text:window.flowSelected}})()`);
    assert.equal(before.reasoningOpen, true); assert.equal(before.pinned, true);
    const result = await evaluate(`(()=>{for(let i=0;i<12;i++){run.toolCalls[0].result.text='已记录输出。'.repeat(900)+'TAIL-'+i;flowRecorder.activity({id:'reasoning-live',kind:'summary',attemptId:'live-a1',status:'running',text:'完整思考内容\\n当前进度 '+i});flowRecorder.response('live-a2','根据工具结果继续核对 '+i);AgentProgress.patchLive(current,renderFixture(current))}return{detail:current.querySelector('.conversation-flow-reasoning-details')===flowReasoning,kit:flowReasoning.querySelector('[data-halaska-root]')===flowReasoningKit,open:flowReasoning.open,field:current.querySelector('.tool-ledger-text-field')===flowField,text:flowField.querySelector('.tool-ledger-full-text').firstChild===flowText,selected:getSelection().toString()===flowSelected,focused:document.activeElement===flowField.querySelector('.tool-ledger-full-text'),tail:flowField.querySelector('.tool-ledger-full-text').textContent.endsWith('TAIL-11'),toolCount:current.querySelectorAll('.tool-ledger-row').length}})()`);
    observations.push({ continuousReading: result }); for(const name of ['detail','kit','open','field','text','selected','focused','tail']) assert.equal(result[name], true, name); assert.equal(result.toolCount, 1);
  });
  await check('continuous process stays within narrow native palettes and has no nested vertical scroll', async () => {
    await evaluate(`(()=>{const value=makeFixture();value.run.toolCalls=value.run.toolCalls.slice(0,1);value.run.toolCalls[0].result={text:'真实长结果。'.repeat(600)};const recorder=ConversationFlow.create(value.message);recorder.activity({id:'narrow-reason',kind:'summary',attemptId:'narrow',status:'running',text:'超长思考预览'.repeat(100)});recorder.response('narrow','连续中间回复。'.repeat(100));recorder.tool(value.run.toolCalls[0]);installFixture(value)})()`);
    for(const width of [360,440]) for(const theme of ['light-mode','dark-mode']) {
      await win.setContentSize(width,850); await evaluate(`document.body.className='liquid-glass ${theme} reduce-motion'`); await delay(35);
      const result = await evaluate(`(()=>{const nodes=[current.querySelector('.conversation-flow'),...current.querySelectorAll('.conversation-flow-item,.conversation-flow-text')];return{overflow:document.documentElement.scrollWidth>innerWidth+1,nested:nodes.some(n=>['auto','scroll'].includes(getComputedStyle(n).overflowY)&&n.scrollHeight>n.clientHeight+1),count:current.querySelectorAll('.conversation-flow-item').length}})()`);
      observations.push({ continuousNarrow: { width, theme, ...result } }); assert.equal(result.overflow,false); assert.equal(result.nested,false); assert.equal(result.count,3);
    }
    await screenshot('continuous-flow-narrow'); await win.setContentSize(960,1050);
  });
  await check('continuous Markdown uses the safe host renderer and retains rich text selection and focused links', async () => {
    const result = await evaluate(`(()=>{const value=makeFixture();value.message.text='Final body stays separate';const recorder=ConversationFlow.create(value.message);recorder.activity({id:'rich-reason',kind:'summary',attemptId:'rich-a1',status:'running',text:'**Reasoning evidence**\\n\\n- First source\\n- Second source'});recorder.response('rich-a1','start selected end **bold** [safe](https://example.invalid/flow)\\n\\n<script>window.flowInjected=true</script> [unsafe](javascript:alert(1))\\n\\n'+String.fromCharCode(96).repeat(3)+'js\\nconst value = "<img onerror=bad()>";\\n'+String.fromCharCode(96).repeat(3));installFixture(value);current.querySelector('.conversation-flow-reasoning-details>summary').click();const body=current.querySelector('.conversation-flow-response .conversation-flow-rich'),paragraph=body.querySelector('p'),text=paragraph.firstChild,link=body.querySelector('a[href="https://example.invalid/flow"]');link.focus();const range=document.createRange();range.setStart(text,6);range.setEnd(text,14);getSelection().removeAllRanges();getSelection().addRange(range);const flow=ConversationFlow.create(message);flow.response('rich-a1',message.conversationFlow.items.find(i=>i.kind==='response').text.replace('start selected','a longer prefix selected'));AgentProgress.patchLive(current,renderFixture(current));return{rich:!!body.querySelector('strong'),reasoningList:current.querySelectorAll('.conversation-flow-reasoning .conversation-flow-rich li').length,code:body.querySelector('.message-code code')?.textContent,scripts:body.querySelectorAll('script,img,iframe,[onerror]').length,unsafe:body.querySelectorAll('a[href^="javascript:"]').length,injected:!!window.flowInjected,node:body.querySelector('p')===paragraph&&paragraph.firstChild===text,selected:getSelection().toString(),focus:document.activeElement===link,finals:current.querySelectorAll('.message-body').length,cache:StreamMarkdown.inspect()}})()`);
    observations.push({ continuousMarkdown: result }); assert.equal(result.rich,true); assert.equal(result.reasoningList,2); assert.match(result.code, /<img onerror=bad\(\)>/);
    assert.equal(result.scripts,0); assert.equal(result.unsafe,0); assert.equal(result.injected,false); assert.equal(result.node,true); assert.equal(result.selected,'selected'); assert.equal(result.focus,true); assert.equal(result.finals,1); assert.ok(result.cache.entries <= result.cache.maxEntries);
  });
  await check('continuous failures keep a truthful plain issue label and child entries visibly name their recorded owner', async () => {
    const result = await evaluate(`(()=>{const value=makeFixture();value.run.toolCalls=value.run.toolCalls.slice(0,1);value.run.toolCalls[0].status='failed';value.run.toolCalls[0].error='Recorded failure';value.run.delegations=[{id:'child-one',title:'核对来源'}];const recorder=ConversationFlow.create(value.message);recorder.activity({id:'child-reasoning',kind:'summary',attemptId:'child-a1',status:'completed',text:'真实子任务思考'},{parentId:'child-one'});recorder.response('child-a1','真实子任务说明',{parentId:'child-one'});recorder.tool(value.run.toolCalls[0]);installFixture(value);const issue=current.querySelector('.progress-issues');return{issue:issue?.textContent,tag:issue?.tagName,role:issue?.getAttribute('role'),controls:current.querySelectorAll('.conversation-process-navigation,[role="tab"],.conversation-tool-filters').length,owners:[...current.querySelectorAll('.conversation-flow-owner')].map(n=>n.textContent),failure:current.querySelector('.tool-ledger-row').textContent.includes('Recorded failure')}})()`);
    observations.push({ continuousOwnerAndIssue: result }); assert.equal(result.issue, '1 次工具异常'); assert.equal(result.tag, 'SPAN'); assert.equal(result.role, null); assert.equal(result.controls, 0);
    assert.deepEqual(result.owners, ['研究子任务 · 核对来源','研究子任务 · 核对来源']); assert.equal(result.failure, true);
  });
  await check('360 and 440 pixel palettes and reduced motion retain readable process controls without horizontal overflow', async () => {
    await evaluate(`installFixture();current.querySelector('[role="tab"][data-value="tools"]').click();current.querySelector('.tool-ledger-raw').open=true;run.toolLedgerPins={'raw:read-one':true};message.progressPins={feed:true};getSelection().removeAllRanges()`);
    for (const width of [440, 360]) {
      win.setSize(width, 1100); await delay(60);
      for (const light of [true, false]) {
        await evaluate(`document.body.classList.toggle('light-mode',${light});scrollTo(0,0)`); await delay(60);
        const result = await evaluate(`({width:innerWidth,scroll:document.documentElement.scrollWidth,body:document.body.scrollWidth,tabRects:[...current.querySelectorAll('[role="tab"]')].map(tab=>{const r=tab.getBoundingClientRect();return{left:r.left,right:r.right,height:r.height}}),theme:current.querySelector('.conversation-process-navigation').dataset.halaskaTheme,animations:current.getAnimations({subtree:true}).filter(a=>a.playState==='running').length})`);
        observations.push({ viewport: width, light, result }); assert.ok(result.scroll <= result.width, 'Document overflow'); assert.ok(result.body <= result.width, 'Body overflow'); assert.equal(result.theme, light ? 'light' : 'dark'); assert.equal(result.animations, 0);
        for (const rect of result.tabRects) { assert.ok(rect.left >= 0); assert.ok(rect.right <= result.width); assert.ok(rect.height >= 28); }
        await screenshot(`narrow-${width}-${light ? 'light' : 'dark'}`);
      }
    }
  });
  await check('connected roots clean up without detached leaks, external requests or renderer errors', async () => {
    await delay(80);
    const roots = await evaluate(`({mounts:HalaskaUI.diagnostics().mounts,connected:document.querySelectorAll('[data-halaska-root]').length})`);
    observations.push({ roots }); assert.equal(roots.mounts, roots.connected);
    await evaluate(`HalaskaConversation.discard(current);current.remove()`); await delay(80);
    assert.equal(await evaluate(`HalaskaUI.diagnostics().mounts`), 0); assert.deepEqual(rendererErrors, []); assert.deepEqual(externalRequests, []);
  });
  await finish(failures.length ? 1 : 0);
})().catch(async error => { failures.push({ name: 'setup', error: error.stack }); console.error(error); await finish(1); });
