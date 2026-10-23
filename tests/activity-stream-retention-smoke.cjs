/* Isolated real renderer regression for activity/ledger ownership.
 * Loads production AgentProgress, ToolScheduler, Halaska bundle, and the exact
 * app.js progress/ledger capture listeners. Only synthetic state is mounted;
 * save() writes to this test's isolated localStorage, never the user workspace.
 * Run: node_modules/.bin/electron tests/activity-stream-retention-smoke.cjs */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results/activity-stream-retention-20260929');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-activity-retention-'));
fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', path.join(TEMP, 'profile'));
const source = fs.readFileSync(path.join(ROOT, 'app/app.js'), 'utf8');
const start = source.indexOf('// 执行过程段的“呼吸”状态');
const end = source.indexOf('// 输入区上方的就地操作', start);
assert.ok(start >= 0 && end > start, 'Locate the actual app-owned capture listeners');
const captureListeners = source.slice(start, end);
assert.match(captureListeners, /document\.addEventListener\('click'/);
assert.match(captureListeners, /toolLedgerPins/);
let win, server, stopping = false;
const checks = [], failures = [], observations = [], errors = [], externalRequests = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 4000) {
  const expires = Date.now() + timeout;
  while (Date.now() < expires) { if (await fn()) return; await delay(30); }
  throw Error('Timeout: ' + label);
}
const watchdog = setTimeout(() => { failures.push({ name: 'watchdog', error: 'Timed out after 90 seconds' }); finish(1); }, 90000);
function report() {
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({
    passed: checks.length, checks, failures, observations, rendererErrors: errors,
    externalRequests, modelCalls: 0, userWorkspaceLoaded: false,
    fixture: 'Production controllers and extracted app.js capture listeners; synthetic localStorage persistence',
    captureListenerSha256: crypto.createHash('sha256').update(captureListeners).digest('hex'),
    temporaryProfileRemoved: !fs.existsSync(TEMP),
  }, null, 2));
}
app.on('window-all-closed', () => {});
app.on('quit', () => { fs.rmSync(TEMP, { recursive: true, force: true }); report(); });
async function finish(code) {
  if (stopping) return; stopping = true; clearTimeout(watchdog);
  if (win && !win.isDestroyed()) { if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach(); win.destroy(); }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  // Only this run's own mkdtemp directory is removed.
  fs.rmSync(TEMP, { recursive: true, force: true }); report();
  setImmediate(() => app.exit(code));
}
function initializeFixture() {
  window.WorkstationI18n = { getLanguage: () => 'zh', t: text => text };
  window.state = { conversations: [{ id: 'fixture-conversation', messages: [] }], agentRuns: [] };
  window.save = () => { localStorage.setItem('activity-retention-fixture', JSON.stringify(state)); };
  window.renderFixture = (options = {}) => {
    const wrapper = document.createElement('article'); wrapper.className = 'message-wrap agent-message';
    wrapper.dataset.messageId = message.id;
    const identity = document.createElement('div'); identity.className = 'message-identity'; identity.textContent = 'AI · 隔离验收';
    wrapper.append(identity);
    const progress = document.createElement('div');
    progress.innerHTML = AgentProgress.markup({ ...message, runStatus: run.status });
    if (progress.firstElementChild) wrapper.append(progress.firstElementChild);
    const body = document.createElement('div'); body.className = 'message-body'; body.textContent = message.text;
    wrapper.append(body);
    if (options.insertResult) {
      const result = document.createElement('section'); result.className = 'message-result-links';
      result.innerHTML = '<div class="message-result-heading">真实合成结果<small>用于核对 DOM 插入位置</small></div><button data-open-note="fixture-note">本轮产出</button>';
      wrapper.append(result);
    }
    const ledger = ToolScheduler.card(run); if (ledger) wrapper.append(ledger);
    HalaskaConversation.enhance(wrapper, message, run);
    return wrapper;
  };
  window.resetFixture = (pinned = false) => {
    if (window.current) { HalaskaConversation.discard(current); current.remove(); }
    const now = Date.now();
    window.message = { id: 'fixture-message', runId: 'fixture-run', role: 'agent', live: true, at: now,
      text: '正在核对资料。', activities: [{ id: 'activity-1', kind: 'tool', name: '读取原始资料', text: '第一段进展', status: 'running', at: now }] };
    window.run = { id: 'fixture-run', status: 'running', startedAt: now,
      toolCalls: [{ id: 'read-one', type: 'read', status: 'running', request: { type: 'read', id: 'SYNTHETIC_ALPHA', title: '隔离原始请求' } }] };
    if (pinned) run.toolLedgerPins = { ledger: true, 'read-one': true };
    state.conversations[0].messages = [message]; state.agentRuns = [run];
    window.current = renderFixture(); document.querySelector('main').append(current);
  };
  window.streamFixture = (iteration, insertResult = false) => {
    message.text = '资料核对进展 ' + iteration;
    message.activities[0].text = '收到新的公开进展 ' + iteration;
    AgentProgress.patchLive(current, renderFixture({ insertResult }));
  };
  resetFixture();
}
(async () => {
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src \'self\'; img-src \'self\' data:"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/agent-progress.css"><link rel="stylesheet" href="/activity-motion.css"><style>body{display:block!important;overflow:auto!important;padding:24px}main{max-width:760px;margin:auto}.message-wrap{width:100%;max-width:none}details{margin:8px 0}summary{cursor:pointer}pre{white-space:pre-wrap}h1{font-size:20px}</style></head><body class="light-mode reduce-motion"><main><h1>工具记录 · 流式保留隔离验收</h1></main><script src="/halaska-ui.js"></script><script src="/streaming-body.js"></script><script src="/agent-progress.js"></script><script src="/activity-motion.js"></script><script src="/json-schema-lite.js"></script><script src="/tool-registry.js"></script><script src="/tool-specs.js"></script><script src="/tool-scheduler.js"></script><script src="/halaska-conversation.js"></script></body></html>';
  server = http.createServer((request, response) => {
    const name = new URL(request.url, 'http://localhost').pathname;
    if (name === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); return response.end(html); }
    const file = path.join(ROOT, 'app', path.basename(name));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); return response.end(); }
    response.writeHead(200, { 'Content-Type': name.endsWith('.css') ? 'text/css' : name.endsWith('.woff2') ? 'font/woff2' : 'application/javascript' });
    response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 1000, height: 900, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => {
    const external = !request.url.startsWith(origin + '/'); if (external) externalRequests.push(request.url); done({ cancel: external });
  });
  const evaluate = code => win.webContents.executeJavaScript(code, true);
  const screenshot = async name => fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG());
  async function check(name, fn) {
    try { await fn(); checks.push(name); console.log('PASS', name); }
    catch (error) { failures.push({ name, error: error.stack }); console.error('FAIL', name, error.message); await screenshot('failure-' + checks.length); }
  }
  await win.loadURL(origin);
  await evaluate('(' + initializeFixture.toString() + ')()');
  await evaluate(captureListeners);
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const key = async (selector, value = 'Space') => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: value === 'Space' ? ' ' : value, code: value, windowsVirtualKeyCode: value === 'Space' ? 32 : 13 });
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: value === 'Space' ? ' ' : value, code: value, windowsVirtualKeyCode: value === 'Space' ? 32 : 13 });
    await delay(40);
  };
  await check('keyboard activation persists raw intent through the real app capture listener', async () => {
    // Pin the initially auto-open parent surfaces by explicitly closing/opening.
    for (const selector of ['.tool-ledger > summary', '.tool-ledger-row > summary']) { await key(selector); await key(selector); }
    await key('.tool-ledger-raw > summary');
    const value = await evaluate(`({open:current.querySelector('.tool-ledger-raw').open,pins:run.toolLedgerPins,saved:JSON.parse(localStorage.getItem('activity-retention-fixture')).agentRuns[0].toolLedgerPins})`);
    observations.push({ keyboard: value });
    assert.equal(value.open, true); assert.equal(value.pins['raw:read-one'], true);
    assert.equal(value.saved['raw:read-one'], true); assert.equal(value.pins.ledger, true); assert.equal(value.pins['read-one'], true);
  });
  await check('stream updates preserve raw DOM identity and focused summary', async () => {
    const value = await evaluate(`(()=>{window.originalLedger=current.querySelector('.tool-ledger');window.originalRaw=current.querySelector('.tool-ledger-raw');window.originalSummary=originalRaw.querySelector('summary');originalSummary.focus();for(let i=0;i<6;i++)streamFixture(i);return{ledger:originalLedger===current.querySelector('.tool-ledger'),raw:originalRaw===current.querySelector('.tool-ledger-raw'),summary:originalSummary===current.querySelector('.tool-ledger-raw>summary'),focus:document.activeElement===originalSummary,open:originalRaw.open}})()`);
    observations.push({ focusedStream: value }); for (const actual of Object.values(value)) assert.equal(actual, true);
  });
  await check('selected original request survives repeated stream and new result insertion', async () => {
    const value = await evaluate(`(()=>{
      const text=current.querySelector('.tool-ledger-raw pre').firstChild,start=text.nodeValue.indexOf('SYNTHETIC_ALPHA');
      const range=document.createRange();range.setStart(text,start);range.setEnd(text,start+'SYNTHETIC_ALPHA'.length);getSelection().removeAllRanges();getSelection().addRange(range);
      const samples=[];
      for(let i=0;i<12;i++){
        if(i===3)run.toolCalls[0].result={text:'An actual synthetic result arrived'};
        if(i===7)run.toolCalls.push({id:'read-two',type:'read',status:'completed',request:{type:'read',id:'SECOND_SOURCE'},result:{text:'Second result'}});
        streamFixture(i,true);
        samples.push({selection:getSelection().toString(),sameText:text===current.querySelector('.tool-ledger-raw pre').firstChild,sameRaw:originalRaw===current.querySelector('.tool-ledger-raw'),rawOpen:originalRaw.open});
      }
      return{samples,results:current.querySelectorAll('.message-result-links').length,ledgers:current.querySelectorAll('.tool-ledger').length,rows:current.querySelectorAll('.tool-ledger-row').length,rawBlocks:originalRaw.querySelectorAll('pre').length};
    })()`);
    observations.push({ selectedStream: value });
    for (const sample of value.samples) { assert.equal(sample.selection, 'SYNTHETIC_ALPHA'); assert.equal(sample.sameText, true); assert.equal(sample.sameRaw, true); assert.equal(sample.rawOpen, true); }
    assert.equal(value.results, 1); assert.equal(value.ledgers, 1); assert.equal(value.rows, 2); assert.equal(value.rawBlocks, 2);
    await screenshot('stream-selection-preserved');
  });
  await check('settlement preserves user-pinned ledger, row, and raw data', async () => {
    const value = await evaluate(`(()=>{message.live=false;message.runStatus='completed';run.status='completed';run.finishedAt=Date.now();run.toolCalls.forEach(call=>call.status='completed');AgentProgress.finish(message,'completed');streamFixture('finished',true);return{ledger:current.querySelector('.tool-ledger').open,row:current.querySelector('.tool-ledger-row').open,raw:current.querySelector('.tool-ledger-raw').open,secondRow:current.querySelectorAll('.tool-ledger-row')[1].open,pins:run.toolLedgerPins}})()`);
    observations.push({ settled: value }); assert.equal(value.ledger, true); assert.equal(value.row, true); assert.equal(value.raw, true); assert.equal(value.secondRow, false);
  });
  await check('explicitly closed raw state survives refresh and synthetic persisted reload', async () => {
    await key('.tool-ledger-raw > summary');
    assert.equal(await evaluate(`run.toolLedgerPins['raw:read-one']`), false);
    await evaluate(`streamFixture('after-close',true)`);
    assert.equal(await evaluate(`current.querySelector('.tool-ledger-raw').open`), false);
    await evaluate(`(()=>{const restored=JSON.parse(localStorage.getItem('activity-retention-fixture'));HalaskaConversation.discard(current);current.remove();state=restored;run=state.agentRuns[0];message=state.conversations[0].messages[0];current=renderFixture();document.querySelector('main').append(current)})()`);
    assert.equal(await evaluate(`current.querySelector('.tool-ledger-raw').open`), false);
    assert.equal(await evaluate(`current.querySelector('.tool-ledger').open`), true);
  });
  await check('raw-only intent keeps its automatic ancestors visible when the run finishes', async () => {
    await evaluate('resetFixture()');
    await key('.tool-ledger-raw > summary');
    const value = await evaluate(`(()=>{message.live=false;run.status='completed';run.finishedAt=Date.now();run.toolCalls[0].status='completed';AgentProgress.finish(message,'completed');streamFixture('raw-only-finish');return{ledger:current.querySelector('.tool-ledger').open,row:current.querySelector('.tool-ledger-row').open,raw:current.querySelector('.tool-ledger-raw').open,pins:run.toolLedgerPins}})()`);
    observations.push({ rawOnlyFinished: value }); assert.deepEqual(value.pins, { 'raw:read-one': true }); assert.equal(value.ledger, true); assert.equal(value.row, true); assert.equal(value.raw, true);
  });
  await check('explicit ancestor close takes precedence over a nested raw-open preference', async () => {
    await key('.tool-ledger > summary');
    await evaluate(`streamFixture('explicit-ledger-close')`);
    assert.equal(await evaluate(`current.querySelector('.tool-ledger').open`), false);
    assert.equal(await evaluate(`run.toolLedgerPins.ledger`), false);
    await key('.tool-ledger > summary');
    await key('.tool-ledger-row > summary');
    await evaluate(`streamFixture('explicit-row-close')`);
    const value = await evaluate(`({ledger:current.querySelector('.tool-ledger').open,row:current.querySelector('.tool-ledger-row').open,raw:current.querySelector('.tool-ledger-raw').open,pins:run.toolLedgerPins})`);
    observations.push({ ancestorPriority: value }); assert.equal(value.ledger, true); assert.equal(value.row, false); assert.equal(value.raw, true); assert.equal(value.pins['read-one'], false);
  });
  await check('untouched auto-open ledger and running row still collapse at terminal state', async () => {
    const value = await evaluate(`(()=>{resetFixture();const before={ledger:current.querySelector('.tool-ledger').open,row:current.querySelector('.tool-ledger-row').open,raw:current.querySelector('.tool-ledger-raw').open};message.live=false;run.status='completed';run.finishedAt=Date.now();run.toolCalls[0].status='completed';AgentProgress.finish(message,'completed');streamFixture('finished');return{before,after:{ledger:current.querySelector('.tool-ledger').open,row:current.querySelector('.tool-ledger-row').open,raw:current.querySelector('.tool-ledger-raw').open},pins:run.toolLedgerPins||null}})()`);
    observations.push({ automatic: value }); assert.deepEqual(value.before, { ledger: true, row: true, raw: false }); assert.deepEqual(value.after, { ledger: false, row: false, raw: false }); assert.equal(value.pins, null);
  });
  await check('introducing a tool group preserves the first row focus, selection, and connected Kit root', async () => {
    await evaluate('resetFixture()');
    for (let i = 0; i < 2; i++) await key('[data-progress-key="activity-1"] > summary');
    const value = await evaluate(`(()=>{
      const row=current.querySelector('[data-activity-id="activity-1"]'),summary=row.querySelector('summary'),island=summary.querySelector('[data-halaska-root]'),body=row.querySelector('.progress-item-body'),text=body.firstChild;
      summary.focus();const range=document.createRange();range.selectNodeContents(body);getSelection().removeAllRanges();getSelection().addRange(range);const selected=getSelection().toString();
      message.activities[0].status='completed';message.activities.push({id:'activity-2',kind:'tool',name:message.activities[0].name,text:'第二条工具继续读取',status:'running',at:Date.now()+1});
      AgentProgress.patchLive(current,renderFixture());
      const first={row:row===current.querySelector('[data-activity-id="activity-1"]'),summary:summary===current.querySelector('[data-progress-key="activity-1"] > summary'),island:island===summary.querySelector('[data-halaska-root]'),text:text===body.firstChild,focus:document.activeElement===summary,selection:getSelection().toString(),groupCount:current.querySelectorAll('.progress-group-details').length,rowOpen:row.querySelector('details').open};
      message.activities[1].text+='，并取得实际结果';AgentProgress.patchLive(current,renderFixture());
      return{selected,first,second:{focus:document.activeElement===summary,selection:getSelection().toString(),row:row===current.querySelector('[data-activity-id="activity-1"]')}};
    })()`);
    observations.push({ groupTransplant: value });
    for (const key of ['row','summary','island','text','focus','rowOpen']) assert.equal(value.first[key], true, key);
    assert.equal(value.first.selection, value.selected); assert.equal(value.first.groupCount, 1);
    assert.equal(value.second.focus, true); assert.equal(value.second.selection, value.selected); assert.equal(value.second.row, true);
    await screenshot('group-first-row-preserved');
  });
  await check('production Kit roots have no detached leaks and fixture makes no external requests', async () => {
    await delay(80);
    const mounts = await evaluate(`({diagnostics:HalaskaUI.diagnostics().mounts,connected:document.querySelectorAll('[data-halaska-root]').length})`);
    observations.push({ roots: mounts }); assert.equal(mounts.diagnostics, mounts.connected);
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  });
  await finish(failures.length ? 1 : 0);
})().catch(async error => { failures.push({ name: 'setup', error: error.stack }); console.error(error); await finish(1); });
