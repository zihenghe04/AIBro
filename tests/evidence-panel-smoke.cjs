/* Production renderMessage + owned process/Kit controllers in an isolated
 * Electron renderer. No app bootstrap, user workspace, model or external I/O.
 * The three app-owned disclosure/navigation listeners are extracted verbatim.
 * Routing/action sinks are spies: this checks their preserved dispatch contract,
 * not execution of approvals, source-reader windows, or transport recovery. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'test-results/evidence-panel-20260929');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-evidence-panel-'));
fs.mkdirSync(OUT, { recursive: true }); app.setPath('userData', path.join(TEMP, 'profile'));
const source = fs.readFileSync(path.join(ROOT, 'app/app.js'), 'utf8');
function extract(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, 'Locate production code: ' + start); return source.slice(first, last);
}
const renderSource = extract('function renderRichText(', '// 提交问询卡片的回答：');
const resultHelpers = extract('function formatTokenCount(', 'function conversationProjectIds(') + '\n' + extract('function dedupeResultEntries(', 'function groupedEntities(');
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
    fixture: 'Exact production renderMessage, rich-text/result helpers and app-owned disclosure/navigation listeners; genuine process, outcome, source, transport and Kit modules; isolated state and action sinks',
    renderMessageSha256: crypto.createHash('sha256').update(renderSource).digest('hex'),
    captureListenerSha256: crypto.createHash('sha256').update(captureListeners).digest('hex'),
    temporaryProfileRemoved: !fs.existsSync(TEMP),
  }, null, 2));
}
app.on('window-all-closed', () => {});
async function finish(code) {
  if (stopping) return; stopping = true; clearTimeout(watchdog);
  if (win && !win.isDestroyed()) { if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach(); win.destroy(); }
  if (server) await new Promise(resolve => server.close(resolve));
  fs.rmSync(TEMP, { recursive: true, force: true }); report(); setImmediate(() => app.exit(code));
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
  window.save = () => { window.saveCount++; localStorage.setItem('conversation-process-fixture', JSON.stringify(state)); };
  window.saveCount = 0; window.actionLog = []; window.sourceLog = [];
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
    if (window.current) { HalaskaConversation.discard(current); CitationEvidence.discard(current); current.remove(); }
    window.state = createState(); window.message = fixture.message; window.run = fixture.run;
    state.conversations[0].messages.push(message); state.agentRuns.push(run);
    window.current = renderFixture(); document.querySelector('#transcript').append(current);
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
    HalaskaConversation.discard(current); CitationEvidence.discard(current); current.remove(); state = saved;
    message = state.conversations[0].messages[0]; run = state.agentRuns[0]; current = renderFixture(); document.querySelector('#transcript').append(current);
  };
  window.resetFixture = installFixture;
}
(async () => {
  const assets = ['workstation-core.js', 'halaska-ui.js', 'sse-frame-scanner.js', 'agent-transport.js', 'agent-progress.js', 'json-schema-lite.js', 'tool-registry.js', 'tool-specs.js', 'tool-scheduler.js', 'conversation-process.js', 'run-outcome-presentation.js', 'safe-preview.js', 'citation-evidence.js', 'halaska-conversation.js'];
  const html = '<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src \'self\'; img-src \'self\' data:">' +
    ['styles.css', 'liquid-glass.css', 'agent-progress.css', 'source-peek.css'].map(file => `<link rel="stylesheet" href="/${file}">`).join('') +
    '<style>body{display:block!important;overflow:auto!important;padding:20px}main{max-width:780px;margin:auto}.message-wrap{width:100%;max-width:none;box-sizing:border-box}h1{font-size:18px}details{margin-block:6px}pre{white-space:pre-wrap}#transcript{min-width:0}</style></head>' +
    '<body class="liquid-glass light-mode reduce-motion"><main><h1>来源证据 · 生产渲染路径隔离验收</h1><div id="transcript"></div></main>' + assets.map(file => `<script src="/${file}"></script>`).join('') + '</body></html>';
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
    try { await fn(); checks.push(name); console.log('PASS', name); }
    catch (error) { failures.push({ name, error: error.stack }); console.error('FAIL', name, error.message); await screenshot('failure-' + failures.length); }
  }
  await win.loadURL(origin);
  await evaluate('(' + initializeFixture.toString() + ')()');
  await evaluate(resultHelpers + '\n' + renderSource + '\n' + captureListeners + '\ninstallFixture()');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const key = async (selector, value = 'Space') => {
    if (selector) await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    const codes = { Space: 32, Enter: 13, ArrowRight: 39, ArrowLeft: 37, Home: 36, End: 35, Tab: 9 };
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: value === 'Space' ? ' ' : value, code: value, windowsVirtualKeyCode: codes[value] });
    await delay(30);
  };
  await evaluate(`window.withEvidence=(relation='runId',count=31)=>{const value=makeFixture('mixed',relation);value.run.evidenceSources=Array.from({length:count},(_,n)=>({sourceId:'evidence-'+n,type:'import',id:'synthetic-pdf',title:'合成材料 · 第 '+(n+1)+' 个位置',provided:true,number:n+1,page:n+1,excerpt:'本轮实际提供片段 '+n}));value.run.retrievalCoverage={strategy:'hybrid-rrf',eligibleRecords:101,originalFiles:45,textIndexedRecords:90,metadataOnlyRecords:11,vectorReady:20,vectorTotal:25,nextOffset:null,truncated:true};value.run.attachmentIds=['synthetic-pdf'];value.run.attachmentDelivery={scope:'prepared_representations',totalAttachments:1,nativeAttachments:0,textAttachments:1,originalFiles:0,originalImages:0,pdfPageImages:0};value.message.retrievedSources=[{type:'import',id:'synthetic-pdf',page:3,chunkId:'chunk-one'}];return value;};installFixture(withEvidence());`);
  await check('source, retrieval and prepared attachment details share one production evidence entry',async()=>{
    const value=await evaluate(`({count:current.querySelectorAll(':scope>.citation-sources').length,other:[...current.querySelectorAll(':scope>details')].filter(n=>!n.matches('.citation-sources,.agent-progress,.tool-ledger')).map(n=>n.textContent),closed:!current.querySelector('.citation-sources').open,root:current.querySelector('.citation-sources [data-halaska-root]')?.dataset.halaskaRoot||null,deferred:current.querySelector('.citation-sources').hasAttribute('data-citation-deferred'),children:current.querySelector('.citation-panel-content').childElementCount,canonical:Object.hasOwn(message,'evidenceOpen')})`);
    assert.equal(value.count,1);assert.deepEqual(value.other,[]);assert.equal(value.closed,true);assert.equal(value.root,null);assert.equal(value.deferred,true);assert.equal(value.children,0);assert.equal(value.canonical,false);observations.push({composition:value});
    await key('.citation-sources > summary','Space');
    const opened=await evaluate(`({open:current.querySelector('.citation-sources').open,saved:message.evidenceOpen,count:current.querySelectorAll('.citation-source-list li').length,text:current.querySelector('.citation-sources').textContent,root:current.querySelector('.citation-sources [data-halaska-root]')?.dataset.halaskaRoot})`);
    assert.equal(opened.open,true);assert.equal(opened.saved,true);assert.equal(opened.count,20);assert.equal(opened.root,'CitationSourceList');assert.match(opened.text,/101/);assert.doesNotMatch(opened.text,/这些原件已加入本轮模型请求|本轮提供原件 · 1/);
    await screenshot('evidence-expanded-light');
  });
  await check('stream updates retain the page, focused source, root and current source bindings without new mounts',async()=>{
    await evaluate(`current.querySelector('.citation-list-pager button:last-child').click()`);
    const value=await evaluate(`(()=>{const panel=current.querySelector('.citation-sources'),host=panel.querySelector('[data-halaska-root]'),button=panel.querySelector('.citation-source-title button');button.focus();let mounts=0;const original=HalaskaUI.mount;HalaskaUI.mount=function(el,name,...rest){if(name==='CitationSourceList')mounts++;return original.call(this,el,name,...rest)};try{for(let i=0;i<20;i++){run.evidenceSources[20].title='刷新后的合成位置 '+i;run.evidenceSources.push({sourceId:'new-'+i,type:'import',id:'synthetic-pdf',title:'新增来源 '+i,provided:true,number:32+i,page:3,excerpt:'新提供片段 '+i});streamFixture(i)}}finally{HalaskaUI.mount=original};button.click();return {samePanel:current.querySelector('.citation-sources')===panel,sameHost:panel.querySelector('[data-halaska-root]')===host,sameButton:panel.querySelector('.citation-source-title button')===button,focus:document.activeElement===button,open:panel.open,page:panel.querySelector('.citation-list-pager').textContent,count:panel.querySelectorAll('li').length,mounts,resolved:CitationEvidence.resolveTarget(state,button),clicked:sourceLog.at(-1)}})()`);
    for(const k of ['samePanel','sameHost','sameButton','focus','open'])assert.equal(value[k],true,k);
    assert.equal(value.mounts,0);assert.equal(value.count,20);assert.match(value.page,/2\s*\/\s*3/);assert.equal(value.resolved.source.title,'刷新后的合成位置 19');assert.equal(value.clicked.source.title,'刷新后的合成位置 19');observations.push({stream:value});
  });
  await check('evidence-only messages retain their island and programmatic rendering never overwrites saved open choices',async()=>{
    const value=await evaluate(`(()=>{const value=withEvidence();delete value.message.steps;value.run.toolCalls=[];value.message.evidenceOpen=true;installFixture(value);const panel=current.querySelector('.citation-sources'),root=panel.querySelector('[data-halaska-root]'),before=saveCount;streamFixture(1);return {process:current.querySelector('.agent-progress'),same:current.querySelector('.citation-sources')===panel,root:panel.querySelector('[data-halaska-root]')===root,open:panel.open,saves:saveCount-before}})()`);
    assert.equal(value.process,null);assert.equal(value.same,true);assert.equal(value.root,true);assert.equal(value.open,true);assert.equal(value.saves,0);
  });
  await check('pending and retry display clones save evidence disclosure to canonical messages and survive reload',async()=>{
    for(const relation of ['pendingRunId','retryRunId']){
      await evaluate(`(()=>{const value=withEvidence(${JSON.stringify(relation)},2);value.message.live=false;value.run.status=${JSON.stringify(relation==='pendingRunId'?'awaiting-save':'failed')};value.run.error='合成测试错误';value.message.text='合成部分回答。';installFixture(value)})()`);
      await key('.citation-sources > summary','Space');assert.equal(await evaluate('message.evidenceOpen'),true);
      await evaluate('restoreFixture()');assert.equal(await evaluate(`current.querySelector('.citation-sources').open`),true);
      await key('.citation-sources > summary','Space');assert.equal(await evaluate('message.evidenceOpen'),false);
      await evaluate('restoreFixture()');assert.equal(await evaluate(`current.querySelector('.citation-sources').open`),false);
    }
  });
  await check('coverage-only and unknown count records remain accessible without inventing indexed or delivered totals',async()=>{
    const value=await evaluate(`(()=>{const value=makeFixture();value.run.retrievalCoverage={strategy:'local-bm25',semanticStatus:'unavailable'};installFixture(value);const panel=current.querySelector('.citation-sources');return {exists:!!panel,text:panel?.textContent}})()`);
    assert.equal(value.exists,true);assert.doesNotMatch(value.text,/undefined|NaN|null|索引范围\s*0|0\s*项资料/);
    await key('.citation-sources > summary','Space');
    const opened=await evaluate(`current.querySelector('.citation-sources').textContent`);assert.match(opened,/关键词/);assert.doesNotMatch(opened,/undefined|NaN|null|索引范围\s*0|0\s*项资料/);observations.push({unknownCoverage:{...value,opened}});
    const empty=await evaluate(`(()=>{installFixture(makeFixture());return current.querySelector('.citation-sources')===null})()`);assert.equal(empty,true);
  });
  await check('private sources redact saved titles and excerpts after an in-place refresh and missing originals remain truthful',async()=>{
    const value=await evaluate(`(()=>{const value=withEvidence('runId',1);value.message.evidenceOpen=true;installFixture(value);state.imports[0].private=true;streamFixture(1);const panel=current.querySelector('.citation-sources');return {text:panel.textContent,model:CitationEvidence.evidenceModel(message,run,state)}})()`);
    assert.doesNotMatch(value.text,/合成材料|本轮实际提供片段|合成原始资料/);assert.match(value.text,/私密/);
    const missing=await evaluate(`(()=>{state.imports=[];streamFixture(2);return current.querySelector('.citation-sources').textContent})()`);assert.match(missing,/不可用|删除/);
  });
  await check('360 and 440 pixel light/dark layouts remain within the viewport and provide real source inspection',async()=>{
    await evaluate(`(()=>{const value=withEvidence('runId',3);value.message.evidenceOpen=true;value.run.evidenceSources[0].title='超长的来源名称'.repeat(18);installFixture(value)})()`);
    for(const width of [360,440])for(const light of [true,false]){
      win.setSize(width,1000);await evaluate(`document.body.className='liquid-glass reduce-motion ${light?'light-mode':''}';document.documentElement.dataset.theme='${light?'light':'dark'}'`);await delay(80);
      const value=await evaluate(`(()=>{const panel=current.querySelector('.citation-sources');panel.scrollIntoView({block:'start'});const button=panel.querySelector('.citation-source-title button');button.click();return {width:innerWidth,scroll:document.documentElement.scrollWidth,panel:panel.getBoundingClientRect().toJSON(),button:button.getBoundingClientRect().toJSON(),title:button.querySelector('span').getBoundingClientRect().toJSON(),row:button.closest('li').getBoundingClientRect().toJSON(),meta:button.closest('li').querySelector('small').getBoundingClientRect().toJSON(),animations:panel.getAnimations({subtree:true}).length,source:sourceLog.at(-1)?.source.id}})()`);
      assert.ok(value.scroll<=value.width+1);assert.ok(value.panel.right<=value.width);assert.ok(value.button.right<=value.width);assert.ok(value.title.bottom<=value.button.bottom+1,'Wrapped title fits its button');assert.ok(value.meta.top>=value.button.bottom-1,'Page metadata stays below title');assert.ok(value.row.top<=value.title.top,'Title never overlaps earlier row content');assert.equal(value.animations,0);assert.equal(value.source,'synthetic-pdf');await screenshot(`narrow-${width}-${light?'light':'dark'}`);
    }
  });
  await check('evidence removal and detached staged shells dispose only their own React roots',async()=>{
    await evaluate(`run.evidenceSources=[];delete run.retrievalCoverage;delete run.attachmentDelivery;message.retrievedSources=[];streamFixture(9)`);await delay(80);
    assert.equal(await evaluate(`current.querySelector('.citation-sources')===null`),true);
    const roots=await evaluate(`({mounts:HalaskaUI.diagnostics().mounts,connected:document.querySelectorAll('[data-halaska-root]').length})`);assert.equal(roots.mounts,roots.connected);
    await evaluate(`CitationEvidence.discard(current);HalaskaConversation.discard(current);current.remove()`);await delay(80);assert.equal(await evaluate('HalaskaUI.diagnostics().mounts'),0);assert.deepEqual(rendererErrors,[]);assert.deepEqual(externalRequests,[]);
  });
  await finish(failures.length?1:0);
})().catch(async error=>{failures.push({name:'setup',error:error.stack});console.error(error);await finish(1)});
