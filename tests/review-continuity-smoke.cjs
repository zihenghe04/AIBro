/* Isolated product renderer acceptance. Run with Electron; never uses user workspace data. */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), { once } = require('node:events');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results/review-continuity-20261001');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-review-continuity-'));
fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', path.join(TEMP, 'profile'));
let win, server, origin, cleaning = false;
const checks = [], errors = [], blockedRequests = [], localRequests = [], screenshots = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), checks, errors, blockedRequests, screenshots, modelCalls: 0, tempDataOnly: true, nativeAcceptance: false };
const RUN = 'continuity-run', A = 'continuity-a', B = 'continuity-b';
async function until(fn, label, timeout = 8500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await wait(45); }
  throw Error('Timed out: ' + label);
}
const evaluate = code => win.webContents.executeJavaScript(code, true);
const settle = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
async function click(selector) {
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
  await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(node.disabled)throw Error('Disabled control: '+${JSON.stringify(selector)});node.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});})()`);
  await settle();
  await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)}),r=node.getBoundingClientRect();if(r.width<1||r.height<1||r.bottom<=0||r.top>=innerHeight)throw Error('Not visible: '+${JSON.stringify(selector)});node.focus({preventScroll:true});node.click();})()`);
  await settle();
}
async function visibleClick(selector) {
  // Deliberately no scrollIntoView: a sticky file tree must be usable while
  // the document stays at its reading anchor, rather than hiding a reset.
  const point = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)throw Error('Missing enabled control: '+${JSON.stringify(selector)});const r=n.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=document.elementFromPoint(x,y);if(r.width<1||r.height<1||x<0||x>=innerWidth||y<0||y>=innerHeight||!n.contains(hit))throw Error('Sticky control is not visibly hittable: '+${JSON.stringify(selector)}+' '+JSON.stringify({x,y,hit:hit?.className}));return{x,y};})()`);
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  await settle();
}
async function treeFile(id) {
  await visibleClick('[data-review-file="' + id + '"]');
  await until(() => selected().then(value => value === id), 'visible file selection ' + id);
  await settle();
}
async function shot(name) {
  await settle();
  const file = name + '.png';
  fs.writeFileSync(path.join(OUT, file), (await win.webContents.capturePage()).toPNG());
  screenshots.push(file);
}
async function cleanup(exitCode) {
  if (cleaning) return; cleaning = true; clearTimeout(watchdog);
  try { if (server?.pid && fs.existsSync(path.join(TEMP, 'server.log'))) fs.copyFileSync(path.join(TEMP, 'server.log'), path.join(OUT, 'server.log')); } catch (_) {}
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
  if (server && server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, 'exit').catch(() => {}); server.kill('SIGTERM');
    await Promise.race([stopped, wait(1500)]);
    if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await Promise.race([stopped, wait(800)]); }
  }
  report.serverStopped = !server || server.exitCode !== null || server.signalCode !== null;
  try { fs.rmSync(TEMP, { recursive: true, force: true }); report.temporaryDataRemoved = !fs.existsSync(TEMP); }
  catch (error) { report.cleanupError = error.message; exitCode = 1; }
  report.finishedAt = new Date().toISOString(); report.passed = checks.length;
  report.localRequestCount = localRequests.length; report.success = exitCode === 0;
  fs.writeFileSync(path.join(OUT, 'renderer-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); app.exit(exitCode);
}
const watchdog = setTimeout(() => {
  report.failure = 'Renderer acceptance exceeded 115 seconds'; void cleanup(1);
}, 115000);

function fixture() {
  const line = (prefix, index) => `${prefix} stable line ${String(index + 1).padStart(4, '0')} — readable context`;
  const aBefore = Array.from({ length: 1000 }, (_, i) => line('A', i));
  const aAfter = aBefore.map((value, i) => i >= 300 && i < 900 ? value + ' changed in this run' : value);
  aAfter[649] = 'A_LONG_LINE_' + 'abcdefgh0123456789'.repeat(180);
  const bBefore = Array.from({ length: 1000 }, (_, i) => line('B', i));
  const bAfter = [...bBefore]; bAfter[19] = 'B_LONG_LINE_' + 'ijklmnop0123456789'.repeat(180); bAfter[849] += ' revised';
  const before = [{ id: A, title: 'Alpha long review', folderPath: 'review/alpha', workspace: '日常', content: aBefore.join('\n') },
    { id: B, title: 'Beta source view', folderPath: 'review/beta', workspace: '日常', content: bBefore.join('\n') }];
  return { before, after: before.map((note, i) => ({ ...note, content: (i ? bAfter : aAfter).join('\n') })) };
}
async function installHelpers() {
  await evaluate(`window.__reviewQA={
    content:()=>document.querySelector('.file-review-content'),
    scroller(){let node=this.content();while(node?.parentElement){if(/auto|scroll/.test(getComputedStyle(node).overflowY)&&node.scrollHeight>node.clientHeight+1)return node;node=node.parentElement;}return document.scrollingElement;},
    readingTop(s){const top=Math.max(0,s.getBoundingClientRect().top),bar=document.querySelector('.review-toolbar').getBoundingClientRect();return bar.bottom>top&&bar.top<top+s.clientHeight?Math.max(top,bar.bottom):top;},
    viewport(){const c=this.content(),s=this.scroller(),top=this.readingTop(s),bottom=Math.min(innerHeight,s.getBoundingClientRect().bottom);const row=[...c.querySelectorAll('[data-review-row]')].find(n=>{const r=n.getBoundingClientRect();return r.bottom>top&&r.top<bottom;});return{nearby:[...c.querySelectorAll('[data-review-row]')].map(n=>({key:n.dataset.reviewRow,offset:n.getBoundingClientRect().top-top})).filter(p=>p.offset>=-50&&p.offset<100),key:row?.dataset.reviewRow,text:row?.textContent,offset:row?row.getBoundingClientRect().top-top:null,top:s.scrollTop,left:c.scrollLeft,rows:c.querySelectorAll('[data-review-row]').length};},
    position(key){const row=this.content().querySelector('[data-review-row="'+key+'"]');if(!row)throw Error('Missing reading row '+key);row.scrollIntoView({block:'start',inline:'nearest',behavior:'instant'});const s=this.scroller();s.scrollTop+=row.getBoundingClientRect().top-this.readingTop(s)-24;},
    geometry(){const c=this.content(),r=c.getBoundingClientRect(),line=[...c.querySelectorAll('code')].find(n=>n.textContent.includes('_LONG_LINE_'));return{documentWidth:document.documentElement.scrollWidth,windowWidth:innerWidth,clientWidth:c.clientWidth,scrollWidth:c.scrollWidth,right:r.right,lineHeight:line?.getBoundingClientRect().height,whiteSpace:line&&getComputedStyle(line).whiteSpace,wrap:document.querySelector('[data-review-wrap]')?.getAttribute('aria-pressed'),split:!!document.querySelector('.is-split')};}
  };void 0;`);
}
async function routeFile(id) {
  await evaluate(`openPreview('review',${JSON.stringify(RUN)},${JSON.stringify(id)})`);
  await until(() => evaluate(`document.querySelector('[data-review-file][aria-pressed="true"]')?.dataset.reviewFile===${JSON.stringify(id)}`), 'requested review file ' + id);
  await settle();
}
async function selected() { return evaluate(`document.querySelector('[data-review-file][aria-pressed="true"]')?.dataset.reviewFile`); }
async function mode() { return evaluate(`document.querySelector('[data-mode][aria-selected="true"]')?.dataset.mode`); }
async function loadRow(key, selector = '.file-review-diff>.review-more') {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await evaluate(`!!document.querySelector('.file-review-content [data-review-row="${key}"]')`)) return;
    const more = await evaluate(`!!document.querySelector(${JSON.stringify(selector)}+':not([hidden])')`);
    assert(more, 'Requested reading row must be reachable through Show more: ' + key);
    await click(selector + ':not([hidden])');
  }
  throw Error('Too many pagination steps for row ' + key);
}
async function assertSplitAccess(rowKey, label) {
  await until(() => evaluate(`!!document.querySelector('.review-horizontal-scroll:not([hidden])')`), label + ' shared horizontal rail');
  await evaluate(`(()=>{const rail=document.querySelector('.review-horizontal-scroll');rail.focus({preventScroll:true});rail.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}));})()`); await settle();
  const before = await evaluate(`(()=>{const row=document.querySelector('[data-review-row="${rowKey}"]'),pair=row.closest('.diff-pair'),c=document.querySelector('.file-review-content'),rect=c.getBoundingClientRect(),halves=[...pair.children];return{container:{left:rect.left,right:rect.right,width:rect.width},scrollWidth:c.scrollWidth,clientWidth:c.clientWidth,halves:halves.map(half=>{const r=half.getBoundingClientRect(),code=half.querySelector('code').getBoundingClientRect(),clip=half.querySelector('.diff-code-viewport').getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,height:r.height,width:r.width,codeLeft:code.left,clipLeft:clip.left,clipRight:clip.right,numberLeft:half.querySelector('.diff-number').getBoundingClientRect().left};})};})()`);
  assert(before.scrollWidth <= before.clientWidth + 2, label + ': the split table must not widen the content surface');
  assert(before.halves.every(half => half.left >= before.container.left - 1 && half.right <= before.container.right + 1), label + ': both fixed halves are visible ' + JSON.stringify(before));
  assert(Math.abs(before.halves[0].width - before.halves[1].width) <= 2, label + ': equal visible halves');
  assert(Math.abs(before.halves[0].top - before.halves[1].top) <= 1 && Math.abs(before.halves[0].height - before.halves[1].height) <= 1, label + ': paired rows remain aligned');
  assert(before.halves.every(half => half.codeLeft >= half.clipLeft - 1 && half.codeLeft < half.clipRight), label + ': both code starts are visible at Home');
  await evaluate(`(()=>{const rail=document.querySelector('.review-horizontal-scroll');rail.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}));})()`); await settle();
  const end = await evaluate(`(()=>{const row=document.querySelector('[data-review-row="${rowKey}"]'),code=row.querySelector('code'),clip=row.querySelector('.diff-code-viewport').getBoundingClientRect(),walker=document.createTreeWalker(code,NodeFilter.SHOW_TEXT);let text,last;while(text=walker.nextNode())last=text;const range=document.createRange();range.setStart(last,Math.max(0,last.length-8));range.setEnd(last,last.length);const r=range.getBoundingClientRect(),rail=document.querySelector('.review-horizontal-scroll');return{tail:last.textContent.slice(-8),left:r.left,right:r.right,clipLeft:clip.left,clipRight:clip.right,offset:rail.scrollLeft,max:Number(rail.getAttribute('aria-valuemax')),numberLeft:row.querySelector('.diff-number').getBoundingClientRect().left,heights:[...row.closest('.diff-pair').children].map(half=>half.getBoundingClientRect().height)};})()`);
  assert(end.offset > 500 && Math.abs(end.offset - end.max) <= 2, label + ': End reaches the real horizontal maximum ' + JSON.stringify(end));
  assert(end.left >= end.clipLeft - 2 && end.right <= end.clipRight + 2, label + ': final source characters are inside the code viewport ' + JSON.stringify(end));
  assert(Math.abs(end.numberLeft - before.halves[1].numberLeft) <= 1, label + ': after line number does not scroll away');
  assert(Math.abs(end.heights[0] - end.heights[1]) <= 1, label + ': scrolling retains pair alignment');
  await evaluate(`document.querySelector('.review-horizontal-scroll').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}))`); await settle();
  assert(await evaluate(`document.querySelector('.review-horizontal-scroll').scrollLeft < ${end.offset}`), label + ': arrow key adjusts the rail');
  await evaluate(`document.querySelector('.review-horizontal-scroll').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}))`); await settle();
  return { before, end };
}
function assertAnchor(actual, expected, label) {
  const anchor=actual.key===expected.key?actual:actual.nearby.find(row=>row.key===expected.key);
  assert(anchor, label + ': the original source line remains at the reading edge');
  assert(Math.abs(anchor.offset - expected.offset) <= 5, label + ': vertical offset ' + JSON.stringify({ actual, expected }));
  assert(actual.top > 100, label + ': stays deep in the document');
}

(async () => {
  const port = await new Promise((resolve, reject) => { const socket = net.createServer(); socket.on('error', reject); socket.listen(0, '127.0.0.1', () => { const value = socket.address().port; socket.close(() => resolve(value)); }); });
  origin = `http://127.0.0.1:${port}`;
  const log = fs.openSync(path.join(TEMP, 'server.log'), 'a');
  server = spawn('python3', [path.join(ROOT, 'app/server.py')], { cwd: ROOT, env: { ...process.env, AI_WORKSTATION_PORT: String(port), AI_WORKSTATION_DATA_DIR: path.join(TEMP, 'store') }, stdio: ['ignore', log, log] }); fs.closeSync(log);
  await until(() => new Promise(resolve => { const request = http.get(origin + '/__health', response => { response.resume(); resolve(response.statusCode === 200); }); request.on('error', () => resolve(false)); request.setTimeout(500, () => { request.destroy(); resolve(false); }); }), 'isolated server');
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 1440, height: 980, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (request, callback) => {
    const url = new URL(request.url), external = url.origin !== origin;
    const forbidden = /\/(?:__agent\/(?:run|chat)|__ai|__models?\/(?:test|generate)|__cloud\/(?:push|pull|sync)|__ssh\/)/.test(url.pathname);
    if (external || forbidden) blockedRequests.push({ method: request.method, path: external ? url.origin + url.pathname : url.pathname });
    else localRequests.push({ method: request.method, path: url.pathname });
    callback({ cancel: external || forbidden });
  });
  win.webContents.on('console-message', (...args) => { const event = args[0]; const level = typeof event === 'object' ? event.level : args[1]; const message = typeof event === 'object' ? event.message : args[2]; if ((level === 'error' || level === 3) && message) errors.push(message); });
  win.webContents.on('render-process-gone', (_, details) => { errors.push('Renderer exited: ' + details.reason); });
  await win.loadURL(origin);
  win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  await until(() => evaluate('typeof storageHydrated!=="undefined"&&storageHydrated&&typeof settingsHydrated!=="undefined"&&settingsHydrated'), 'hydrated');
  const data = fixture();
  await evaluate(`(()=>{const data=${JSON.stringify(data)},now=Date.now();WorkstationOnboarding.close();WorkspaceTour?.close();state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};state.ui.workspaceTour={version:1,status:'skipped'};state.ui.reduceMotion=true;state.ui.theme='light';state.ui.inspectorOpen=false;state.ui.documentWorkspace=null;state.projects=[];state.notes=data.after;state.tasks=[];state.imports=[];state.agentRuns=[{id:${JSON.stringify(RUN)},conversationId:'continuity-chat',status:'completed',startedAt:now-90000,finishedAt:now-1000,fileChanges:FileReview.capture({notes:data.before},{notes:data.after},data.after.map(note=>({id:note.id,type:'note'}))),steps:[],commands:[]}];state.conversations=[{id:'continuity-chat',title:'Isolated review continuity',workspace:'日常',attachments:[],draftAttachmentIds:[],draft:'',messages:[],createdAt:now}];state.currentConversationId='continuity-chat';normalizeStateShape(state);applyUiPreferences();showView('agent','对话');renderAll();save();})()`);
  await routeFile(A); await click('#readingExpand'); await installHelpers();
  await until(() => evaluate(`!!document.querySelector('[data-halaska-root="ReviewDiffTools"] [data-review-wrap]')&&!document.querySelector('[data-review-split]').disabled`), 'real Kit review tools');
  await loadRow(':650');
  let geometry = await evaluate('__reviewQA.geometry()');
  assert.equal(geometry.wrap, 'true'); assert(geometry.documentWidth <= geometry.windowWidth + 1, JSON.stringify(geometry));
  await click('[data-review-wrap]'); geometry = await evaluate('__reviewQA.geometry()');
  assert.equal(geometry.wrap, 'false'); assert(geometry.scrollWidth > geometry.clientWidth + 500, JSON.stringify(geometry)); assert(geometry.documentWidth <= geometry.windowWidth + 1, JSON.stringify(geometry));
  await click('[data-review-split]'); await until(() => evaluate('!!document.querySelector(".is-split")'), 'split review');
  geometry = await evaluate('__reviewQA.geometry()'); assert(geometry.scrollWidth <= geometry.clientWidth + 2, JSON.stringify(geometry)); assert(geometry.documentWidth <= geometry.windowWidth + 1, JSON.stringify(geometry));
  report.splitHorizontal = await assertSplitAccess(':650', 'unequal long line');
  report.wide = geometry; await shot('wide-split-nowrap'); checks.push('real Kit wrap button keeps both split columns visible; one keyboard-accessible rail reaches long-line ends with fixed numbers');
  win.setSize(620, 780); await until(() => evaluate(`document.querySelector('[data-review-split]').disabled&&!document.querySelector('.is-split')`), 'compact unified');
  geometry = await evaluate('__reviewQA.geometry()'); assert.equal(geometry.wrap, 'false'); assert(geometry.documentWidth <= geometry.windowWidth + 1, JSON.stringify(geometry)); assert(geometry.scrollWidth > geometry.clientWidth + 500, JSON.stringify(geometry));
  await click('[data-review-wrap]'); geometry = await evaluate('__reviewQA.geometry()');
  assert.equal(geometry.wrap, 'true'); assert(geometry.scrollWidth <= geometry.clientWidth + 2, JSON.stringify(geometry)); assert(geometry.documentWidth <= geometry.windowWidth + 1, JSON.stringify(geometry));
  report.narrow = geometry; await shot('narrow-wrapped'); checks.push('620px automatically uses unified review and the actual wrap toggle removes horizontal content overflow');
  win.setSize(1440, 980); await until(() => evaluate('!!document.querySelector(".is-split")'), 'split restored');
  await click('[data-review-split]'); await click('[data-review-wrap]');
  await click('.file-review-diff .diff-gap button');
  await loadRow(':850'); await evaluate(`__reviewQA.position(':850');`); await settle();
  const anchorA = await evaluate('__reviewQA.viewport()'); assert(anchorA.rows > 800); assert(await evaluate(`!!document.querySelector('.diff-expanded-context [data-review-row="100:100"]')`));
  // File tree buttons must remain physically hittable at this deep reading position.
  await treeFile(B); await click('[data-mode="source"]');
  if (await evaluate(`document.querySelector('[data-review-wrap]').getAttribute('aria-pressed')==='false'`)) await click('[data-review-wrap]');
  await loadRow(':850', '.review-source>.review-more'); await evaluate(`__reviewQA.position(':850');`); await settle();
  const anchorB = await evaluate('__reviewQA.viewport()');
  await treeFile(A); assert.equal(await mode(), 'diff'); assert.equal(await evaluate(`document.querySelector('[data-review-wrap]').getAttribute('aria-pressed')`), 'false');
  assert(await evaluate(`!!document.querySelector('.diff-expanded-context [data-review-row="100:100"]')`));
  const restoredA = await evaluate('__reviewQA.viewport()'); assert(restoredA.rows >= anchorA.rows); assertAnchor(restoredA, anchorA, 'file A return');
  await treeFile(B); assert.equal(await mode(), 'source'); assert.equal(await evaluate(`document.querySelector('[data-review-wrap]').getAttribute('aria-pressed')`), 'true');
  assertAnchor(await evaluate('__reviewQA.viewport()'), anchorB, 'file B return');
  report.perFile = { anchorA, restoredA, anchorB }; checks.push('physically clicking visible file tree entries retains independent modes, wrapping, loaded rows, expanded context and source-line anchors');
  // The fixed reading toolbar provides a visible document-origin affordance.
  await evaluate(`openPreview('note',${JSON.stringify(B)},undefined,undefined,undefined,{anchor:document.querySelector('#readingExpand')})`);
  await until(() => evaluate(`state.previewRecord?.type==='note'&&!!document.querySelector('#readingBack')`), 'current document opened');
  assert(await evaluate(`ReadingPane.snapshot().tabs.find(tab=>tab.kind==='note'&&tab.id===${JSON.stringify(B)}).origin?.view==='document'`));
  await click('#readingBack'); await until(() => evaluate(`state.previewRecord?.type==='review'`), 'return to review origin');
  assert.equal(await selected(), B); assert.equal(await mode(), 'source'); assertAnchor(await evaluate('__reviewQA.viewport()'), anchorB, 'document return');
  checks.push('open current document and the visible Back control restore the originating review file and source anchor');
  // Native destination restoration can park an already restored reader. WebKit
  // may reset the hidden element's scrollTop without changing its eventual width.
  const beforePark = await evaluate('__reviewQA.viewport()');
  const parkedWidth = await evaluate(`document.querySelector('.file-review-content').getBoundingClientRect().width`);
  await evaluate(`window.__retainedReviewNode=document.querySelector('.file-review-content');ReadingPane.revealWorkspace({force:true});document.querySelector('#previewDialog').scrollTop=0;ReadingPane.remember();void 0;`);
  await wait(280);
  assert(await evaluate(`ReadingPane.snapshot().retained&&!ReadingPane.snapshot().visible`));
  const parkedBookmark = await evaluate(`ReadingPane.bookmark('review',${JSON.stringify(RUN)}).review.documents.find(view=>view.id===${JSON.stringify(B)}).positions.source`);
  assert.equal(parkedBookmark.key, beforePark.key, 'hidden scroll reset cannot overwrite the saved source line');
  assert(Math.abs(parkedBookmark.top-beforePark.top)<=2,'hidden metadata retains the source scroll position');
  await click('#readingToggle');
  await until(() => evaluate(`ReadingPane.snapshot().visible&&document.querySelector('.review-source')!==null`), 'same-width parked reader resume');
  assert(await evaluate(`__retainedReviewNode===document.querySelector('.file-review-content')`), 'resume retains the document owner');
  assert(Math.abs(await evaluate(`document.querySelector('.file-review-content').getBoundingClientRect().width`) - parkedWidth) <= 1, 'restoration cannot rely on a width change');
  assertAnchor(await evaluate('__reviewQA.viewport()'), anchorB, 'same-width park/resume');
  report.parkedBookmark = parkedBookmark;checks.push('native-style parking preserves the same document and source anchor despite a hidden scroll reset at unchanged width');
  // Persist the real presentation metadata, then discard the whole renderer JS heap.
  await evaluate(`ReadingPane.remember();saveDocumentDurably()`);
  const durable = await evaluate(`fetch('/__state',{cache:'no-store'}).then(response=>response.json())`);
  const savedReview = durable.ui.documentWorkspace.tabs.find(tab => tab.kind === 'review' && tab.id === RUN)?.bookmark?.review;
  assert.equal(savedReview?.selectedId, B); assert.equal(savedReview.documents.find(view => view.id === B)?.mode, 'source');
  assert(!JSON.stringify(savedReview).includes('stable line'), 'UI metadata must not duplicate document bodies');
  report.durableMetadata = savedReview;
  const loaded = once(win.webContents, 'did-finish-load'); win.webContents.reload(); await loaded;
  await until(() => evaluate(`typeof storageHydrated!=='undefined'&&storageHydrated&&state.previewRecord?.type==='review'&&!!document.querySelector('.review-source')`), 'cold restore');
  await installHelpers(); await settle();
  assert.equal(await selected(), B); assert.equal(await mode(), 'source'); assert.equal(await evaluate(`document.querySelector('[data-review-wrap]').getAttribute('aria-pressed')`), 'true');
  assertAnchor(await evaluate('__reviewQA.viewport()'), anchorB, 'cold source restore');
  await shot('cold-source-restored'); checks.push('cold renderer reload restores selected file, source mode, wrap and reading anchor from durable ReadingPane metadata');
  const beforeHiddenReload=await evaluate('__reviewQA.viewport()');
  await evaluate(`ReadingPane.revealWorkspace({force:true});document.querySelector('#previewDialog').scrollTop=0;ReadingPane.remember();saveDocumentDurably()`);
  const hiddenMetadata = await evaluate(`fetch('/__state',{cache:'no-store'}).then(response=>response.json()).then(saved=>saved.ui.documentWorkspace)`);
  assert.equal(hiddenMetadata.visible,false);
  const hiddenPosition=hiddenMetadata.tabs.find(tab=>tab.kind==='review'&&tab.id===RUN).bookmark.review.documents.find(view=>view.id===B).positions.source;
  assert.equal(hiddenPosition.key,beforeHiddenReload.key);
  assert(Math.abs(hiddenPosition.top-beforeHiddenReload.top)<=2);
  const hiddenLoaded=once(win.webContents,'did-finish-load');win.webContents.reload();await hiddenLoaded;
  await until(()=>evaluate(`typeof storageHydrated!=='undefined'&&storageHydrated&&typeof settingsHydrated!=='undefined'&&settingsHydrated&&ReadingPane.snapshot().tabs.length>0`),'cold hidden tabs');
  assert(await evaluate(`!ReadingPane.snapshot().visible&&!document.querySelector('.review-source')`),'cold hidden reader defers its document mount');
  await click('#readingToggle');await until(()=>evaluate(`state.previewRecord?.type==='review'&&!!document.querySelector('.review-source')`),'first visible mount after cold hidden restore');
  await installHelpers();await settle();
  assert.equal(await selected(),B);assert.equal(await mode(),'source');
  assertAnchor(await evaluate('__reviewQA.viewport()'),anchorB,'cold hidden-to-visible restore');
  report.hiddenRestore=hiddenPosition;checks.push('cold startup with a hidden reader retains its durable bookmark until the first visible mount');

  await routeFile(A); assert.equal(await selected(), A, 'explicit requested file wins over saved selected file B');
  assert.equal(await mode(), 'diff'); assert.equal(await evaluate(`document.querySelector('[data-review-wrap]').getAttribute('aria-pressed')`), 'false');
  assert(await evaluate(`!!document.querySelector('.diff-expanded-context [data-review-row="100:100"]')`));
  assertAnchor(await evaluate('__reviewQA.viewport()'), anchorA, 'cold nonselected-file restore'); checks.push('an explicit file intent overrides bookmarked selection while restoring that file\'s own review state');
  await routeFile(B);
  await evaluate(`(()=>{const run=state.agentRuns.find(run=>run.id===${JSON.stringify(RUN)}),change=run.fileChanges.find(file=>file.id===${JSON.stringify(B)});change.after.content='A new short snapshot\\nMust start at its first line';})()`);
  await routeFile(B); assert.equal(await mode(), 'source');
  const replacement = await evaluate('__reviewQA.viewport()'); assert(replacement.top <= 2, JSON.stringify(replacement));
  assert.match(await evaluate(`document.querySelector('.review-source').textContent`), /A new short snapshot/);
  assert.equal(await evaluate(`document.querySelectorAll('.review-source [data-review-row]').length`), 2);
  checks.push('replaced snapshot discards stale loaded viewport and opens short source at the beginning');
  assert.deepEqual(await evaluate(`state.notes.map(note=>({id:note.id,content:note.content}))`), data.after.map(note => ({ id: note.id, content: note.content })), 'Review presentation cannot edit current document bodies');
  await shot('changed-snapshot-start'); report.changedSnapshot = replacement;
  // Preserve the real authoritative-hunk DOM and actions when applying the same
  // split/nowrap presentation. These callbacks record intent; no local write API.
  await evaluate(`(()=>{window.__splitHunkCalls=[];const hunks=[{id:'horizontal-h1',oldStart:11,newStart:11,oldCount:2,newCount:2,before:'old short\\nold second\\n',after:'HUNK_LONG_LINE_'+('0123456789abcdef'.repeat(220))+'TAIL_END\\nnew second\\n',status:'pending'},{id:'horizontal-h2',oldStart:30,newStart:30,oldCount:2,newCount:1,before:'deleted first\\ndeleted second\\n',after:'replacement\\n',status:'pending'}];ReviewWorkbench.document(document.querySelector('.file-review-viewer'),{path:'isolated/structured-hunks.txt',before:'',after:'',hunks,onHunk:(action,id)=>__splitHunkCalls.push({action,id})},{mode:'diff',split:true,wrap:false});})()`);
  await settle(); report.hunkHorizontal = await assertSplitAccess(':11', 'structured hunk');
  assert.equal(await evaluate(`document.querySelectorAll('.review-hunk').length`), 2);
  assert.equal(await evaluate(`document.querySelectorAll('.review-hunk[data-hunk-id="horizontal-h2"] .diff-pair').length`), 2, 'unequal hunk keeps its empty partner row');
  await click('[data-hunk-id="horizontal-h2"][data-hunk-action="accept-hunk"]');
  assert.deepEqual(await evaluate('__splitHunkCalls'), [{action:'accept-hunk',id:'horizontal-h2'}]);
  assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth+1`));
  checks.push('structured hunks preserve grouping, unequal row alignment, visible halves and exact action identity with synchronized horizontal scrolling');
  await shot('structured-hunks-nowrap');
  await evaluate(`void ReviewWorkbench.document(document.querySelector('.file-review-viewer'),{path:'isolated/short.txt',before:'short before',after:'short after'},{mode:'diff',split:true,wrap:false})`);await settle();
  assert(await evaluate(`document.querySelector('.review-horizontal-scroll').hidden`),'short split lines do not display an unnecessary horizontal rail');
  assert.deepEqual(blockedRequests, [], 'The isolated review flow must not request network, models or sync');
  assert.deepEqual(errors, [], 'No renderer errors');
  await cleanup(0);
})().catch(async error => {
  report.failure = error.stack || String(error);
  if (win && !win.isDestroyed()) {
    try { report.failureState = await evaluate(`({preview:state.previewRecord,selected:document.querySelector('[data-review-file][aria-pressed="true"]')?.dataset.reviewFile,mode:document.querySelector('[data-mode][aria-selected="true"]')?.dataset.mode,geometry:window.__reviewQA&&document.querySelector('.file-review-content')?__reviewQA.geometry():null,viewport:window.__reviewQA&&document.querySelector('.file-review-content')?__reviewQA.viewport():null})`); await shot('failure'); } catch (_) {}
  }
  console.error(error); await cleanup(1);
});
