/* Real Kit composer in the full app; all state and transport are isolated. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), net = require('node:net'), assert = require('node:assert/strict'), { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'test-results/composer-kit-20260929'), TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-composer-kit-')), STORE = path.join(TEMP, 'store');
fs.mkdirSync(STORE); fs.mkdirSync(OUT, { recursive: true }); app.setPath('userData', path.join(TEMP, 'profile'));
let win, server, origin; const checks = [], failures = [], errors = [], external = [], sizes = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { const start = Date.now(); while (Date.now() - start < 20000) { if (await fn()) return; await wait(60); } throw Error('Timeout: ' + label); }
function finish(code) { clearTimeout(watchdog); fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ passed: checks.length, checks, failures, rendererErrors: errors, externalRequests: external, modelCalls: 0, sizes, workspace: TEMP }, null, 2)); win?.destroy(); server?.kill('SIGTERM'); app.exit(code); }
const watchdog = setTimeout(() => { failures.push({ error: 'watchdog timeout' }); finish(1); }, 180000);
(async () => {
  const port = await new Promise(resolve => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); }); }); origin = `http://127.0.0.1:${port}`;
  const log = fs.openSync(path.join(TEMP, 'server.log'), 'a'); server = spawn('python3', [path.join(ROOT, 'app/server.py')], { cwd: ROOT, env: { ...process.env, AI_WORKSTATION_PORT: String(port), AI_WORKSTATION_DATA_DIR: STORE, AI_WORKSTATION_ASSET_DIR: path.join(ROOT, 'app') }, stdio: ['ignore', log, log] });
  await until(() => new Promise(resolve => http.get(origin + '/__health', r => { r.resume(); resolve(r.statusCode === 200); }).on('error', () => resolve(false))), 'backend');
  await app.whenReady(); win = new BrowserWindow({ show: false, width: 1240, height: 960, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') { errors.push({ message: event.message, source: event.sourceId, line: event.lineNumber }); console.error('RENDERER', event.message, event.sourceId, event.lineNumber); } });
  win.webContents.on('render-process-gone', (_, details) => { errors.push(details); console.error('RENDERER GONE', details); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (req, cb) => { const outside = !req.url.startsWith(origin + '/'); if (outside) external.push(req.url); cb({ cancel: outside }); });
  const ev = code => win.webContents.executeJavaScript(code, true).catch(error => { console.error('EVALUATING', code.slice(0, 300)); throw error; });
  const click = selector => ev(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing '+${JSON.stringify(selector)});n.click();})()`);
  const fill = value => ev(`(()=>{const n=document.querySelector('#agentInput');n.focus();n.value=${JSON.stringify(value)};n.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));})()`);
  const key = (value, options = {}) => ev(`document.querySelector('#agentInput').dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({ key: value, bubbles: true, cancelable: true, ...options })}))`);
  const settle = async () => { await ev('saveDocumentDurably()'); await ev('flushWorkspace()'); await until(() => ev('!serverSaveInFlight&&!serverSaveQueued&&!state._pendingLocalSave&&!serverConflict'), 'durable fixture'); };
  const check = async (label, fn) => { try { await fn(); checks.push(label); console.log('PASS', label); } catch (error) { failures.push({ label, error: error.stack }); console.error('FAIL', label, error.message); } };
  const shot = async name => { await wait(100); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  await win.loadURL(origin); await until(() => ev('typeof storageHydrated!=="undefined"&&storageHydrated'), 'hydration');
  await ev(`(()=>{WorkstationOnboarding.close();WorkspaceTour.close();state.ui.onboarding={version:1,status:'skipped'};state.ui.workspaceTour={version:1,status:'skipped'};state.projects=[];state.tasks=[];state.notes=[];state.imports=[];state.papers=[];state.agentRuns=[];state.conversations=[{id:'kit-chat',title:'Kit输入区验收',workspace:'日常',permissionMode:'auto',attachments:[],draftAttachmentIds:[],draft:'',messages:[],modelConfig:{provider:'api',model:'kit-synthetic',effort:'medium'},createdAt:Date.now()},{id:'kit-other',title:'另一份草稿',workspace:'日常',draft:'独立对话已保存草稿',messages:[],attachments:[],draftAttachmentIds:[]}];state.currentConversationId='kit-chat';normalizeStateShape(state);state.ui.inspectorOpen=false;state.ui.theme='light';applyUiPreferences();showView('agent','对话');renderAll();window.__kitCalls=[];ConversationModels.resolve=async config=>config;getApiConnection=async()=>({base:'https://fixture.invalid/v1',token:'synthetic-only'});AgentTransport.requestPlan=options=>new Promise((resolve,reject)=>{const entry={options,resolve,reject};__kitCalls.push(entry);options.signal?.addEventListener('abort',()=>reject(Object.assign(Error('Synthetic cancellation'),{code:'CANCELLED'})),{once:true});});})()`); await settle();
  await check('real Kit controls own one stable input and preserve original button IDs', async () => {
    assert.equal(await ev('ComposerUI.mounted'), true);
    assert.equal(await ev(`document.querySelectorAll('#agentInput').length`), 1);
    assert.equal(await ev(`document.querySelector('#agentInput').closest('[data-halaska-root]').dataset.halaskaRoot`), 'ComposerEditor');
    assert.ok(await ev(`['chatAttach','composerContext','composerModel','composerPermission','composerLocal','agentSend','composerMore'].every(id=>document.querySelectorAll('#'+id).length===1&&document.getElementById(id).closest('[data-halaska-root]').dataset.halaskaRoot==='ComposerAction')`));
  });
  await check('IME Enter, legacy 229 and Shift+Enter do not submit or consume the draft', async () => {
    await fill('输入法候选尚未确认'); await key('Enter', { isComposing: true }); await key('Enter', { keyCode: 229 }); await key('Enter', { shiftKey: true }); await wait(100);
    assert.equal(await ev('state.agentRuns.length'), 0); assert.equal(await ev(`document.querySelector('#agentInput').value`), '输入法候选尚未确认');
    await ev(`document.querySelector('#agentInput').focus()`); win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] }); win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: ['shift'] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['shift'] }); await wait(50);
    assert.match(await ev(`document.querySelector('#agentInput').value`), /\n/); assert.equal(await ev('state.agentRuns.length'), 0);
  });
  await check('theme, language and repeated render preserve input identity, draft, selection and focus', async () => {
    await fill('这是保留选区的长草稿 ABCDE'); await ev(`window.__kitInput=document.querySelector('#agentInput');__kitInput.setSelectionRange(3,8);`);
    for (const theme of ['dark', 'light']) await ev(`state.ui.theme='${theme}';applyUiPreferences();renderAll();document.documentElement.lang='en';document.dispatchEvent(new Event('workstation-language-change'));document.documentElement.lang='zh';document.dispatchEvent(new Event('workstation-language-change'));renderAll();`);
    assert.deepEqual(await ev(`({same:__kitInput===document.querySelector('#agentInput'),value:__kitInput.value,start:__kitInput.selectionStart,end:__kitInput.selectionEnd,focused:document.activeElement===__kitInput})`), { same: true, value: '这是保留选区的长草稿 ABCDE', start: 3, end: 8, focused: true });
  });
  await check('switching conversations restores each durable draft without replacing the Kit input', async () => {
    await fill('原对话草稿应恢复'); await settle(); await ev(`openConversation('kit-other')`); assert.equal(await ev(`document.querySelector('#agentInput').value`), '独立对话已保存草稿');
    await fill('第二个独立草稿'); await settle(); await ev(`openConversation('kit-chat')`); assert.equal(await ev(`document.querySelector('#agentInput').value`), '原对话草稿应恢复'); assert.equal(await ev(`__kitInput===document.querySelector('#agentInput')`), true);
  });
  await check('Enter submits once; running Enter queues once and Stop preserves that queue', async () => {
    await fill('开始第一轮'); await key('Enter'); await until(() => ev('__kitCalls.length===1'), 'first synthetic request');
    await fill('执行期间排队'); await key('Enter'); await until(() => ev('currentConversation().pendingSubmits?.length===1'), 'queued input');
    assert.equal(await ev('currentConversation().pendingSubmits[0].goal'), '执行期间排队'); assert.equal(await ev(`document.querySelector('#agentInput').value`), ''); assert.equal(await ev('__kitCalls.length'), 1);
    await click('#agentSend'); await until(() => ev('!sendMessage.busy'), 'stop'); assert.equal(await ev('currentConversation().pendingSubmits.length'), 1); assert.equal(await ev('__kitCalls.length'), 1);
    assert.equal(await ev(`document.querySelector('#agentSend').closest('[data-halaska-root]').dataset.halaskaRoot`), 'ComposerAction');
    await ev('currentConversation().pendingSubmits=[];renderComposerQueue()');
  });
  await check('rapid send clicks never create duplicate submitted user turns or concurrent transports', async () => {
    const messages = await ev(`currentConversation().messages.filter(m=>m.role==='user').length`), calls = await ev('__kitCalls.length');
    await fill('双击只产生一个请求'); await ev(`document.querySelector('#agentSend').click();document.querySelector('#agentSend').click();`); await wait(500);
    assert.ok(await ev(`currentConversation().messages.filter(m=>m.role==='user').length<=${messages + 1}`)); assert.ok(await ev(`__kitCalls.length<=${calls + 1}`));
    if (await ev('!!sendMessage.busy')) { await click('#agentSend'); await until(() => ev('!sendMessage.busy'), 'rapid click cleanup'); }
  });
  await check('pasted file follows real import persistence without consuming typed draft', async () => {
    await fill('附件粘贴前保留的草稿'); await ev(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['Pasted synthetic attachment text.'],'kit-paste.txt',{type:'text/plain'}));document.querySelector('#agentInput').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));})()`);
    await until(() => ev(`!importMaterials.busy&&state.imports.some(item=>item.name==='kit-paste.txt')`), 'pasted file import');
    assert.equal(await ev(`document.querySelector('#agentInput').value`), '附件粘贴前保留的草稿'); assert.equal(await ev(`currentConversation().draftAttachmentIds.length`), 1); await settle();
    const stored = JSON.parse(fs.readFileSync(path.join(STORE, 'workspace.json'), 'utf8')); assert.ok(stored.imports.some(item => item.name === 'kit-paste.txt'));
  });
  await check('more tools Escape returns focus; permission button opens a single actual picker', async () => {
    await click('#composerMore'); assert.equal(await ev(`document.querySelector('#composerExtraTools').hidden`), false);
    await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`); assert.equal(await ev(`document.querySelector('#composerExtraTools').hidden`), true); assert.equal(await ev('document.activeElement.id'), 'composerMore');
    await click('#composerPermission'); await click('#composerPermission'); assert.equal(await ev(`document.querySelectorAll('dialog.permission-picker[open]').length`), 1);
    await ev(`document.querySelector('dialog.permission-picker').dispatchEvent(new Event('cancel',{cancelable:true}))`);
  });
  await check('model button opens once and retains one mounted Kit model picker', async () => {
    await click('#composerModel'); assert.equal(await ev(`(()=>{const e=document.querySelector('#modelPicker');return !e.hidden&&e.tagName==='SECTION'&&!(e instanceof HTMLDialogElement)&&!('open' in e)})()`), true); assert.equal(await ev(`document.querySelectorAll('#modelPickerKit[data-halaska-root="ModelPickerSurface"]').length`), 1);
    await ev(`ConversationModels.close();void 0;`);
    assert.equal(await ev(`document.querySelector('#composerModel').closest('[data-halaska-root]').dataset.halaskaRoot`), 'ComposerAction');
  });
  await check('Bencho add menu invokes each existing action once and cancellation preserves the draft', async () => {
    await fill('添加菜单取消后保留的草稿'); await settle();
    await ev(`window.__kitDialogShows={};window.__kitDialogOriginal=HTMLDialogElement.prototype.showModal;HTMLDialogElement.prototype.showModal=function(...args){__kitDialogShows[this.id]=(__kitDialogShows[this.id]||0)+1;return __kitDialogOriginal.apply(this,args);};void 0;`);
    try {
      await click('#chatAttach'); assert.equal(await ev(`document.querySelector('#composerAddMenu').dataset.halaskaRoot`), 'BenchoAddMenu');
      await click('[data-add-action="attach-file"]'); await until(() => ev(`document.querySelector('#importDialog').open&&!ComposerAddMenu.isOpen()`), 'real import dialog');
      assert.equal(await ev('__kitDialogShows.importDialog'), 1); await ev(`(()=>{const n=[...document.querySelectorAll('#importDialog .import-footer button')].find(b=>b.textContent.trim()==='关闭');if(!n)throw Error('Missing ImportSurface close');n.click();})()`);
      assert.equal(await ev(`document.querySelector('#importDialog').open`), false); assert.equal(await ev(`document.querySelector('#agentInput').value`), '添加菜单取消后保留的草稿');
      await click('#chatAttach'); await click('[data-add-action="workspace-reference"]'); await until(() => ev(`!document.querySelector('#fileContextPicker').hidden&&!ComposerAddMenu.isOpen()`), 'existing file picker');
      assert.equal(await ev(`document.activeElement.matches('#fileContextPicker input.file-context-search')`), true);
      await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`); assert.equal(await ev(`document.querySelector('#fileContextPicker').hidden`), true);
      await click('#chatAttach'); await click('[data-add-action="local-project"]'); await until(() => ev(`document.querySelector('#localProjectsDialog')?.open&&!ComposerAddMenu.isOpen()`), 'existing local projects dialog');
      assert.equal(await ev('__kitDialogShows.localProjectsDialog'), 1); await click('#localProjectsDialog .local-projects-close');
      assert.equal(await ev(`document.querySelector('#agentInput').value`), '添加菜单取消后保留的草稿'); assert.equal(await ev('currentConversation().draft'), '添加菜单取消后保留的草稿');
    } finally { await ev(`HTMLDialogElement.prototype.showModal=__kitDialogOriginal;void 0;`); }
  });
  await check('open add menu closes on route and conversation changes without consuming either draft', async () => {
    await click('#chatAttach'); assert.equal(await ev('ComposerAddMenu.isOpen()'), true); await ev(`showView('daily','日常')`); assert.equal(await ev('ComposerAddMenu.isOpen()'), false);
    await ev(`showView('agent','对话')`); await click('#chatAttach'); await ev(`openConversation('kit-other')`); assert.equal(await ev('ComposerAddMenu.isOpen()'), false); assert.equal(await ev(`document.querySelector('#agentInput').value`), '第二个独立草稿');
    await ev(`openConversation('kit-chat')`); assert.equal(await ev(`document.querySelector('#agentInput').value`), '添加菜单取消后保留的草稿');
  });
  await check('AICSS effort edits remain modal drafts and live language changes preserve the React controls', async () => {
    await settle(); const before = await ev('JSON.stringify(currentConversation().modelConfig)');
    await ev(`document.querySelector('#composerModel').focus()`); await click('#composerModel'); await until(() => ev(`!!document.querySelector('#modelPicker [role="slider"]')`), 'actual AICSS slider');
    await ev(`(()=>{const slider=document.querySelector('#modelPicker [role="slider"]');slider.focus();slider.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}));})()`);
    assert.equal(await ev(`document.querySelector('#conversationEffort').value`), 'ultra'); assert.equal(await ev('JSON.stringify(currentConversation().modelConfig)'), before);
    await ev(`WorkstationI18n.setLanguage('en')`); await wait(80); assert.equal(await ev(`!document.querySelector('#modelPicker').hidden`), true); assert.match(await ev(`document.querySelector('#modelPickerTitle').textContent`), /Model/); await shot('model-aicss-en');
    await ev(`WorkstationI18n.setLanguage('zh')`); await wait(80); assert.equal(await ev(`document.querySelectorAll('#modelPicker [role="slider"]').length`), 1); assert.equal(await ev(`document.querySelector('#conversationEffort').value`), 'ultra'); await shot('model-aicss-zh');
    assert.equal(await ev('JSON.stringify(currentConversation().modelConfig)'), before);
    const saved = JSON.parse(fs.readFileSync(path.join(STORE, 'workspace.json'), 'utf8')); assert.deepEqual(saved.conversations.find(c => c.id === 'kit-chat').modelConfig, JSON.parse(before));
    await click('#closeModelPicker'); await until(() => ev(`!!document.querySelector('#modelPicker').hidden&&document.activeElement.id==='composerModel'`), 'cancel focus return');
    assert.equal(await ev('JSON.stringify(currentConversation().modelConfig)'), before); assert.equal(await ev(`document.querySelector('#agentInput').value`), '添加菜单取消后保留的草稿');
  });
  await check('applying AICSS effort waits for real storage ACK then closes and restores model-button focus', async () => {
    await settle(); await ev(`document.querySelector('#composerModel').focus()`); await click('#composerModel');
    await ev(`(()=>{const slider=document.querySelector('#modelPicker [role="slider"]');slider.focus();slider.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}));window.__kitActualFetch=window.fetch.bind(window);window.__kitSaveHeld=false;window.__kitHoldNext=true;window.__kitSaveAcks=0;window.fetch=async(url,options)=>{const post=String(url).includes('/__state')&&options?.method==='POST';if(post&&__kitHoldNext){__kitHoldNext=false;__kitSaveHeld=true;await new Promise(resolve=>window.__kitReleaseSave=resolve);}const response=await __kitActualFetch(url,options);if(post&&response.ok)__kitSaveAcks++;return response;};})()`);
    try {
      await click('#applyModelSelection'); await until(() => ev('__kitSaveHeld'), 'held actual model save');
      assert.equal(await ev(`!document.querySelector('#modelPicker').hidden`), true); assert.equal(await ev(`document.querySelector('#applyModelSelection').disabled`), true);
      assert.notEqual(JSON.parse(fs.readFileSync(path.join(STORE, 'workspace.json'), 'utf8')).conversations.find(c => c.id === 'kit-chat').modelConfig.effort, 'ultra');
      const beforeSend=await ev(`JSON.stringify({messages:currentConversation().messages,runs:state.agentRuns.length,requests:__kitCalls.length,draft:document.querySelector('#agentInput').value})`);
      assert.notEqual(await ev(`ConversationModels.current().effort`),'ultra');
      assert.notEqual(await ev(`ConversationModels.forNewConversation(state,defaultModelConfiguration()).effort`),'ultra');
      await ev(`sendMessage()`);
      assert.equal(await ev(`JSON.stringify({messages:currentConversation().messages,runs:state.agentRuns.length,requests:__kitCalls.length,draft:document.querySelector('#agentInput').value})`),beforeSend);
      await ev('__kitReleaseSave()'); await until(() => ev(`__kitSaveAcks>0&&!!document.querySelector('#modelPicker').hidden&&document.activeElement.id==='composerModel'`), 'save ACK and focus');
      assert.equal(JSON.parse(fs.readFileSync(path.join(STORE, 'workspace.json'), 'utf8')).conversations.find(c => c.id === 'kit-chat').modelConfig.effort, 'ultra');
      assert.equal(await ev(`document.querySelector('#agentInput').value`), '添加菜单取消后保留的草稿');
    } finally { await ev(`window.__kitReleaseSave?.();window.fetch=__kitActualFetch;void 0;`); }
  });
  await check('320, 440 and 1024px web/native themes keep composer controls inside the viewport', async () => {
    await ev(`currentConversation().pendingSubmits=[];currentConversation().draftAttachmentIds=[];currentConversation().draftFileReferences=[];state.ui.inspectorOpen=false;renderAll();`); await fill('窄窗测试草稿');
    const css = fs.readFileSync(path.join(ROOT, 'native/Resources/workspace.css'), 'utf8');
    await ev(`(()=>{const style=document.createElement('style');style.id='composerNativeFixture';style.textContent=${JSON.stringify(css)};style.disabled=true;document.head.append(style);})()`);
    for (const native of [false, true]) for (const width of [320, 440, 1024]) for (const theme of ['light', 'dark']) {
      win.setSize(width, 900); await ev(`document.querySelector('#composerNativeFixture').disabled=${!native};document.body.classList.toggle('aibro-native',${native});state.ui.theme='${theme}';applyUiPreferences();WorkspaceLayout.refresh();`); await wait(100);
      const fit = await ev(`(()=>{const c=document.querySelector('#composer'),r=c.getBoundingClientRect();return{body:document.documentElement.scrollWidth<=innerWidth,composer:c.scrollWidth<=c.clientWidth+1,left:r.left,right:r.right,width:innerWidth,send:document.querySelector('#agentSend').getBoundingClientRect().toJSON()}})()`); sizes.push({ native, width, theme, ...fit });
      await shot(`${native ? 'native' : 'web'}-${width}-${theme}`);
      if (!fit.body || !fit.composer || fit.left < -1 || fit.right > fit.width + 1 || fit.send.right > fit.width + 1) failures.push({ label: 'composer width containment', native, width, theme, fit });
    }
    assert.equal(sizes.filter(x => !x.body || !x.composer || x.left < -1 || x.right > x.width + 1 || x.send.right > x.width + 1).length, 0);
  });
  if (errors.length) failures.push({ label: 'renderer errors', errors }); if (external.length) failures.push({ label: 'external requests', external });
  console.log(JSON.stringify({ passed: checks.length, failures, errors, external, workspace: TEMP }, null, 2)); finish(failures.length ? 1 : 0);
})().catch(error => { failures.push({ error: error.stack }); console.error(error); finish(1); });
