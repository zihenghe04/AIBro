/* Focused real DOM selection/scroll checks; synthetic messages, no model or workspace. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'test-results/process-transparency-20261003/reading-selection');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-selection-follow-'));
app.setPath('userData', path.join(temporary, 'profile'));
app.on('window-all-closed', () => {});
const checks = [], failures = [], rendererErrors = [], externalRequests = [];
let win, finished = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => { failures.push({ name: 'watchdog' }); finish(1); }, 30000);
async function finish(code) {
  if (finished) return; finished = true; clearTimeout(watchdog);
  if (win && !win.isDestroyed()) win.destroy();
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'renderer-report.json'), JSON.stringify({ checks, failures, rendererErrors, externalRequests, modelCalls: 0, userWorkspaceLoaded: false, temporaryProfileRemoved: !fs.existsSync(temporary) }, null, 2));
  app.exit(code);
}
(async () => {
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 800, height: 650, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => { externalRequests.push(request.url); done({ cancel: true }); });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:24px;font:16px/24px sans-serif}#messageList{width:600px;height:360px;overflow:auto;overflow-anchor:none;border:1px solid}article{min-height:180px;padding:8px;box-sizing:border-box}p{margin:0 0 12px}textarea{display:block;margin-top:10px;width:500px}</style></head><body class="reduce-motion"><p id="before">Outside before the transcript</p><div id="messageList" tabindex="0" data-conversation-id="selection-fixture"></div><p id="after">Outside after the transcript</p><textarea id="composer">Composer selection is independent</textarea></body></html>`));
  const evaluate = code => win.webContents.executeJavaScript(code, true);
  await evaluate(fs.readFileSync(path.join(ROOT, 'app/conversation-reading.js'), 'utf8'));
  await evaluate(`window.list=document.querySelector('#messageList');
    window.inspect=()=>ConversationReading.inspect(list);
    window.grow=()=>{const token=ConversationReading.beforeRender(list,list.dataset.conversationId);const p=document.createElement('p');p.textContent='A real newly appended fixture paragraph. '.repeat(3);list.lastElementChild.append(p);ConversationReading.afterRender(list,token);};
    window.bottom=()=>list.scrollHeight-list.clientHeight-list.scrollTop;
    for(let i=0;i<12;i++){const row=document.createElement('article');row.dataset.messageId='synthetic-'+i;const p=document.createElement('p');p.className='message-body';p.textContent='Selectable transcript text that must stay still during streaming. '.repeat(3);row.append(p);list.append(row);}
    const token=ConversationReading.beforeRender(list,list.dataset.conversationId);ConversationReading.afterRender(list,token);`);
  await delay(100);
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  async function check(name, task) {
    try { await task(); checks.push(name); console.log('PASS', name); }
    catch (error) { failures.push({ name, error: error.stack }); console.error('FAIL', name, error.message); }
  }
  await check('mouse selection at bottom pauses following and preserves text, focus and scroll across output', async () => {
    assert.equal(await evaluate('inspect().following'), true);
    const point = await evaluate(`(()=>{const range=document.createRange();range.setStart(list.lastElementChild.firstElementChild.firstChild,0);range.setEnd(list.lastElementChild.firstElementChild.firstChild,16);const box=range.getBoundingClientRect();return {x:box.left+2,y:box.top+box.height/2,end:box.right-2};})()`);
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.end, y: point.y, button: 'left', buttons: 1 });
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.end, y: point.y, button: 'left', clickCount: 1 });
    await delay(50);
    const before = await evaluate(`window.selectionFocus=document.activeElement;({top:list.scrollTop,text:getSelection().toString(),following:inspect().following})`);
    assert.ok(before.text.length > 4, 'real mouse gesture selected transcript text');
    assert.equal(before.following, false);
    await evaluate('for(let i=0;i<12;i++)grow()'); await delay(100);
    const after = await evaluate(`({top:list.scrollTop,text:getSelection().toString(),sameFocus:document.activeElement===selectionFocus,following:inspect().following})`);
    assert.equal(after.text, before.text); assert.equal(after.sameFocus, true); assert.equal(after.following, false);
    assert.ok(Math.abs(after.top - before.top) < 1);
  });
  await check('selection clear does not jump or resume, deliberate downward wheel then resumes', async () => {
    const top = await evaluate('list.scrollTop');
    await evaluate('getSelection().removeAllRanges()'); await delay(70);
    assert.equal(await evaluate('inspect().following'), false);
    assert.ok(Math.abs(await evaluate('list.scrollTop') - top) < 1);
    await evaluate('grow()'); await delay(70);
    assert.ok(Math.abs(await evaluate('list.scrollTop') - top) < 1);
    const point = await evaluate('(()=>{const r=list.getBoundingClientRect();return {x:r.left+200,y:r.top+200};})()');
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 10000 }); await delay(350);
    assert.equal(await evaluate('inspect().following'), true); assert.ok(await evaluate('bottom()') < 2);
    await evaluate('grow()'); await delay(250); assert.ok(await evaluate('bottom()') < 2);
  });
  await check('crossing range with external endpoints pauses; explicit follow preserves and overrides unchanged selection', async () => {
    await evaluate(`getSelection().setBaseAndExtent(document.querySelector('#before').firstChild,2,document.querySelector('#after').firstChild,8)`); await delay(50);
    assert.equal(await evaluate('inspect().following'), false);
    const top = await evaluate('list.scrollTop'); await evaluate('grow()'); await delay(70);
    assert.ok(Math.abs(await evaluate('list.scrollTop') - top) < 1);
    const text = await evaluate('getSelection().toString()');
    await evaluate('ConversationReading.follow(list,{behavior:"instant"})'); await delay(220);
    assert.equal(await evaluate('inspect().following'), true); assert.equal(await evaluate('getSelection().toString()'), text);
    await evaluate('grow()'); await delay(70); assert.ok(await evaluate('bottom()') < 2);
    await evaluate('getSelection().removeAllRanges()');
  });
  await check('outside text and composer selections do not detach or lose focus', async () => {
    await evaluate(`getSelection().setBaseAndExtent(document.querySelector('#before').firstChild,0,document.querySelector('#before').firstChild,7)`); await delay(40);
    await evaluate('grow()'); await delay(70);
    assert.equal(await evaluate('inspect().following'), true); assert.ok(await evaluate('bottom()') < 2);
    await evaluate(`getSelection().removeAllRanges();document.querySelector('#composer').focus();document.querySelector('#composer').setSelectionRange(0,8);grow()`); await delay(70);
    assert.equal(await evaluate('inspect().following'), true); assert.ok(await evaluate('bottom()') < 2);
    assert.equal(await evaluate(`document.activeElement.id`), 'composer');
    assert.equal(await evaluate(`document.querySelector('#composer').selectionEnd`), 8);
  });
  await check('production selection controller produces no external requests or renderer errors', async () => {
    assert.deepEqual(externalRequests, []); assert.deepEqual(rendererErrors, []);
    await evaluate('ConversationReading.destroy(list)');
    assert.equal(await evaluate('ConversationReading.inspect(list)'), null);
  });
  await finish(failures.length ? 1 : 0);
})().catch(error => { failures.push({ name: 'setup', error: error.stack }); console.error(error); finish(1); });
