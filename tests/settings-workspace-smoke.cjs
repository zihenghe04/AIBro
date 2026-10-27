/* Production renderer only. Every backend/profile/config path belongs to a temp fixture. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results/settings-workspace-20260930/renderer');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-settings-workspace-'));
const STORE = path.join(TEMP, 'store');
const HOME_FIXTURE = path.join(TEMP, 'isolated-home');
for (const directory of [OUT, STORE, HOME_FIXTURE]) fs.mkdirSync(directory, { recursive: true });
app.setPath('userData', path.join(TEMP, 'profile'));
app.on('window-all-closed', () => {});
app.on('quit', () => { fs.rmSync(TEMP, { recursive: true, force: true }); });
const checks = [], failures = [], rendererErrors = [], remoteRequests = [], requests = [], screenshots = [], layout = [], pointerChecks = [], sectionStates = [];
const files = ['app/app.js', 'app/settings-workspace.js', 'app/settings-workspace.css', 'app/ui/settings-workspace-surfaces.jsx', 'app/halaska-ui.js', 'app/i18n-en.js'];
const hashes = () => Object.fromEntries(files.map(file => [file, fs.existsSync(path.join(ROOT, file)) ? crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex') : null]));
const startedHashes = hashes();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, win, origin, fatalError, cleanupDone = false;
async function until(fn, label, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (await fn()) return; await wait(50); }
  throw Error('Timed out: ' + label);
}
async function check(name, fn) {
  try { await fn(); checks.push(name); console.log('PASS', name); }
  catch (error) { failures.push({ name, error: error.stack }); console.error('FAIL', name, error.message); }
}
async function cleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  if (win && !win.isDestroyed()) win.destroy();
  if (server && server.exitCode == null) {
    const ended = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM');
    await Promise.race([ended, wait(2500)]);
    if (server.exitCode == null) { server.kill('SIGKILL'); await ended; }
  }
  fs.rmSync(TEMP, { recursive: true, force: true });
}
const watchdog = setTimeout(async () => { fatalError = 'Settings workspace renderer timeout'; await finish(); }, 180000);
async function finish() {
  clearTimeout(watchdog);
  await cleanup();
  const finishedHashes = hashes();
  const sourceHashesStable = JSON.stringify(startedHashes) === JSON.stringify(finishedHashes);
  if (!sourceHashesStable) failures.push({ name: 'source hashes remain stable throughout renderer acceptance', error: 'A tracked production source changed during this run.' });
  const report = { passed: checks.length, checks, failures, rendererErrors, remoteRequests, realModelCalls: 0,
    requests: requests.filter(item => !/\.(?:js|css|woff2|svg|ico|png)(?:\?|$)/.test(item.path)), screenshots, layout, pointerChecks, sectionStates,
    startedHashes, finishedHashes, sourceHashesStable, fatalError, fixtureRemoved: !fs.existsSync(TEMP),
    scope: 'Whole production renderer and temporary local server. Empty isolated workspace, profile, HOME and CODEX_HOME. No formal store/config or real provider calls. Native acceptance is separate.' };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: checks.length, failures: failures.length, rendererErrors, remoteRequests, fatalError, fixtureRemoved: report.fixtureRemoved }));
  app.exit(fatalError || failures.length || rendererErrors.length || remoteRequests.length ? 1 : 0);
}
(async () => {
  const port = await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); }); });
  origin = `http://127.0.0.1:${port}`;
  const log = fs.openSync(path.join(TEMP, 'server.log'), 'a');
  server = spawn(process.env.PYTHON || 'python3', [path.join(ROOT, 'app/server.py')], { cwd: ROOT,
    env: { ...process.env, HOME: HOME_FIXTURE, CODEX_HOME: path.join(HOME_FIXTURE, '.codex'), AI_WORKSTATION_PORT: String(port), AI_WORKSTATION_DATA_DIR: STORE, AI_WORKSTATION_ASSET_DIR: path.join(ROOT, 'app') }, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  await until(() => new Promise(resolve => { http.get(origin + '/__health', response => { response.resume(); resolve(response.statusCode === 200); }).on('error', () => resolve(false)); }), 'isolated server');
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 1200, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => {
    const remote = !request.url.startsWith(origin + '/');
    if (remote) remoteRequests.push(new URL(request.url).origin);
    else requests.push({ method: request.method, path: new URL(request.url).pathname });
    // No real inference/network operation is allowed by this fixture.
    callback({ cancel: remote || /\/(?:__proxy|__cloud\/(?:connect|sync|disconnect|settings)|__ssh\/(?:connect|probe))/.test(new URL(request.url).pathname) });
  });
  const evaluate = source => win.webContents.executeJavaScript(source, true);
  const click = selector => evaluate(`(() => {const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing control: '+${JSON.stringify(selector)});node.click();})()`);
  const key = async value => { const keyCode = ({ArrowRight:'Right',ArrowLeft:'Left',ArrowUp:'Up',ArrowDown:'Down'})[value] || value;win.webContents.focus(); win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await wait(50); };
  const edit = (id, value) => evaluate(`(() => {const node=document.getElementById(${JSON.stringify(id)});node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const assertPanels = async label => {
    const state = await evaluate(`({selected:SettingsWorkspace.selected(),firstPanel:document.querySelector('#settings .settings-panels')?.firstElementChild?.dataset.settingsSection,panels:[...document.querySelectorAll('#settings .settings-section')].map(n=>({section:n.dataset.settingsSection,hidden:n.hidden,inert:n.inert})),retainedNodes:window.settingsRefs?Object.entries(settingsRefs).every(([id,node])=>node===document.getElementById(id)):null,retainedHandlers:window.settingsHandlers?Object.entries(settingsHandlers).every(([id,handler])=>document.getElementById(id).onclick===handler):null,duplicateControls:window.settingsRefs?Object.keys(settingsRefs).filter(id=>document.querySelectorAll('#'+CSS.escape(id)).length!==1):[]})`);
    sectionStates.push({ label, ...state });
    assert.equal(state.panels.length, 5, label);
    assert.equal(state.firstPanel, state.selected, `${label}: active persistent panel comes first`);
    assert.equal(state.panels.filter(panel => !panel.hidden).length, 1, label);
    for (const panel of state.panels) {
      assert.equal(panel.hidden, panel.section !== state.selected, `${label}: ${panel.section} visibility`);
      assert.equal(panel.inert, panel.hidden, `${label}: ${panel.section} accessibility exposure`);
    }
    if (state.retainedNodes !== null) assert.equal(state.retainedNodes, true, `${label}: original form nodes`);
    if (state.retainedHandlers !== null) assert.equal(state.retainedHandlers, true, `${label}: original handlers`);
    assert.deepEqual(state.duplicateControls, [], `${label}: retained controls have unique focus targets`);
  };
  const select = async section => { await click('#settings-tab-' + section); await until(() => evaluate(`SettingsWorkspace.selected()===${JSON.stringify(section)}`), 'select ' + section); await assertPanels('select ' + section); };
  const snapshot = async name => { await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`); await wait(80); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); screenshots.push(name + '.png'); };
  await win.loadURL(origin);
  await until(() => evaluate(`typeof storageHydrated!=='undefined'&&storageHydrated&&!!document.querySelector('#embeddingSettings')&&!!document.querySelector('#cloudSyncCard')`), 'production hydration');
  await evaluate(`(async()=>{WorkstationOnboarding?.close('skipped');await WorkspaceTour?.open();WorkspaceTour?.close('skipped');showView('settings','设置');SettingsWorkspace.init();})()`);
  await until(() => evaluate(`document.querySelectorAll('#settingsNavigation [role=tab]').length===5`), 'actual SettingsNavigation Kit bundle');
  await evaluate(`window.settingsRefs=Object.fromEntries(['apiBase','apiProtocol','apiKey','model','apiModelOptions','usageCurrency','usageInputRate','usageOutputRate','embeddingBase','embeddingModel','embeddingKey','cloudServerUrl','cloudUsername','cloudPassword','cloudDeviceName','saveSettings'].map(id=>[id,document.getElementById(id)]));window.settingsHandlers=Object.fromEntries(['saveSettings','testApi','embeddingSave','embeddingTest','cloudConnect'].map(id=>[id,document.getElementById(id).onclick]));window.settingsConfigurationBefore={base:localStorage.getItem('workstation-api-base'),model:localStorage.getItem('workstation-api-model'),key:localStorage.getItem('workstation-api-key'),usage:JSON.stringify(state.settings.usagePrice||null)};void 0;`);
  // The old address/key form is a hidden data carrier behind the provider list; expose it only for the tests that drive its controls.
  const legacyCard = visible => evaluate(`document.querySelector('.settings-connection-card').hidden=${!visible};void 0;`);
  await legacyCard(true);
  await check('production initialization groups exactly four live panels and one real Kit tab bar', async () => {
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('#settings .settings-section')].map(n=>n.dataset.settingsSection)`), ['models', 'sync', 'knowledge', 'plugins', 'appearance']);
    assert.equal(await evaluate(`document.querySelector('#settingsNavigation').dataset.halaskaRoot`), 'SettingsNavigation');
    assert.equal(await evaluate(`document.querySelector('#apiCredentials').closest('[role=tabpanel]').id`), 'settings-panel-models');
    assert.equal(await evaluate(`document.querySelector('#cloudSyncCard').closest('[role=tabpanel]').id`), 'settings-panel-sync');
    assert.equal(await evaluate(`document.querySelector('#embeddingSettings').closest('[role=tabpanel]').id`), 'settings-panel-knowledge');
    assert.equal(await evaluate(`document.querySelector('#appearanceCard').closest('[role=tabpanel]').id`), 'settings-panel-appearance');
    assert.equal(await evaluate(`document.querySelectorAll('#settingsNavigation [role=tab][tabindex="0"]').length`), 1);
    assert.equal(await evaluate(`document.querySelectorAll('#settingsNavigation').length`), 1);
    await assertPanels('initial panels');
  });
  const values = { apiBase: 'https://settings-fixture.invalid/v1', apiKey: 'synthetic-unsaved-api-key', model: 'fixture-unsaved-model', usageCurrency: '¥', usageInputRate: '2.5', usageOutputRate: '7.25', embeddingBase: 'https://embedding-fixture.invalid/v1', embeddingModel: 'fixture-embedding-model', embeddingKey: 'synthetic-unsaved-embedding-key', cloudServerUrl: 'https://sync-fixture.invalid', cloudUsername: 'fixture-user', cloudPassword: 'synthetic-unsaved-sync-password', cloudDeviceName: '验收电脑 · unsaved' };
  await check('four-section round trip retains real nodes, handlers and every unsaved field without saving', async () => {
    // Connect stays disabled while the workspace save started by opening the section is in flight (cloud-sync-ui hostBusy).
    await select('sync'); await click('.cloud-sync-advanced summary'); await until(() => evaluate(`!document.querySelector('#cloudStartConnect').disabled`), 'cloud connect enabled'); await click('#cloudStartConnect');
    for (const [id, value] of Object.entries(values)) await edit(id, value);
    await wait(100);
    assert.equal(await evaluate(`document.querySelector('#cloudServerUrl').getClientRects().length>0`), true);
    const writesBefore = requests.filter(item => item.method !== 'GET' && item.path !== '/__store').length;
    for (const section of ['models', 'knowledge', 'appearance', 'sync', 'models']) await select(section);
    assert.equal(await evaluate(`Object.entries(settingsRefs).every(([id,node])=>node===document.getElementById(id))`), true);
    assert.equal(await evaluate(`Object.entries(settingsHandlers).every(([id,handler])=>document.getElementById(id).onclick===handler)`), true);
    assert.deepEqual(await evaluate(`Object.fromEntries(${JSON.stringify(Object.keys(values))}.map(id=>[id,document.getElementById(id).value]))`), values);
    assert.equal(await evaluate(`JSON.stringify(settingsConfigurationBefore)===JSON.stringify({base:localStorage.getItem('workstation-api-base'),model:localStorage.getItem('workstation-api-model'),key:localStorage.getItem('workstation-api-key'),usage:JSON.stringify(state.settings.usagePrice||null)})`), true);
    assert.equal(requests.filter(item => item.method !== 'GET' && item.path !== '/__store').length, writesBefore);
    assert.equal(await evaluate(`document.querySelector('#apiKey').type==='password'&&document.querySelector('#embeddingKey').type==='password'&&document.querySelector('#cloudPassword').type==='password'`), true);
  });
  await check('arrow, Home and End preserve retained controls and synchronize hidden/inert panels; hidden fields cannot receive focus', async () => {
    await evaluate(`window.settingsKeyEvents=[];document.addEventListener('keydown',e=>settingsKeyEvents.push({key:e.key,target:e.target.id}),true)`);
    await evaluate(`document.querySelector('#settings-tab-models').focus()`);
    await key('ArrowRight'); assert.equal(await evaluate(`SettingsWorkspace.selected()`), 'sync');
    await assertPanels('ArrowRight to sync');
    await key('ArrowRight'); assert.equal(await evaluate(`SettingsWorkspace.selected()`), 'knowledge');
    await assertPanels('ArrowRight to knowledge');
    await key('End'); assert.equal(await evaluate(`SettingsWorkspace.selected()`), 'appearance');
    await assertPanels('End to appearance');
    await key('Home'); assert.equal(await evaluate(`SettingsWorkspace.selected()`), 'models');
    await assertPanels('Home to models');
    await key('ArrowLeft'); assert.equal(await evaluate(`SettingsWorkspace.selected()`), 'appearance');
    await assertPanels('ArrowLeft wraps to appearance');
    assert.equal(await evaluate(`document.activeElement.id`), 'settings-tab-appearance');
    assert.equal(await evaluate(`document.querySelectorAll('#settingsNavigation [role=tab][tabindex="0"]').length`), 1);
    assert.equal(await evaluate(`document.querySelectorAll('#settings .settings-section:not([hidden])').length`), 1);
    await evaluate(`document.querySelector('#apiKey').focus()`);
    assert.equal(await evaluate(`document.activeElement.id`), 'settings-tab-appearance');
    await key('Tab');
    assert.equal(await evaluate(`!!document.activeElement.closest('[hidden]')`), false);
    assert.equal(await evaluate(`document.activeElement.closest('[role=tabpanel]')?.id`), 'settings-panel-appearance');
    await select('models'); await evaluate(`document.querySelector('#apiKey').focus();SettingsWorkspace.reveal('knowledge')`);
    assert.equal(await evaluate(`document.activeElement.id`), 'settings-tab-knowledge');
    await assertPanels('reveal knowledge from focused model field');
  });
  await check('real pointer click hits the retained test-connection button and invokes its actual handler once', async () => {
    await select('models');
    await evaluate(`window.settingsOriginalFetch=window.fetch.bind(window);window.settingsPointer={requests:0,events:[]};window.fetch=async(url,options)=>{if(String(url).startsWith('/__proxy?')){settingsPointer.requests++;return new Response(JSON.stringify({data:[{id:'fixture-pointer-model'}]}),{status:200,headers:{'content-type':'application/json'}})}return settingsOriginalFetch(url,options)};document.addEventListener('click',e=>settingsPointer.events.push({id:e.target.id,button:e.target.closest('button')?.id,tag:e.target.tagName,className:e.target.className}),true);document.querySelector('#testApi').scrollIntoView({block:'center'});void 0;`);
    await wait(120);
    const point = await evaluate(`(() => {const n=document.querySelector('#testApi'),r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return {x,y,hit:{id:hit?.id,button:hit?.closest('button')?.id,tag:hit?.tagName,className:hit?.className,html:hit?.outerHTML},button:{id:n.id,disabled:n.disabled,rect:{left:r.left,top:r.top,width:r.width,height:r.height}},stack:document.elementsFromPoint(x,y).slice(0,6).map(e=>({id:e.id,tag:e.tagName,className:e.className,zIndex:getComputedStyle(e).zIndex,pointerEvents:getComputedStyle(e).pointerEvents}))}})()`);
    win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(point.x),y:Math.round(point.y)});
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:Math.round(point.x),y:Math.round(point.y)});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:Math.round(point.x),y:Math.round(point.y)});
    await wait(200);
    const outcome=await evaluate(`({requests:settingsPointer.requests,events:settingsPointer.events,status:document.querySelector('#apiStatus').textContent,active:document.activeElement.id})`);
    pointerChecks.push({point,outcome});
    await evaluate(`window.fetch=settingsOriginalFetch;void 0;`);
    await snapshot('pointer-test-connection');
    assert.equal(point.hit.button,'testApi');
    assert.equal(outcome.requests,1);
    assert.ok(outcome.events.some(event=>event.button==='testApi'));
    assert.match(outcome.status,/模型列表|model list|可用模型|models/);
  });
  await check('language, reduced motion and native palette refresh retain drafts and node identity', async () => {
    await select('models');
    await evaluate(`document.querySelector('#apiKey').focus();document.querySelector('#apiKey').setSelectionRange(4,9);WorkstationI18n.setLanguage('en');document.body.classList.remove('light-mode');document.body.classList.add('native-shell','reduce-motion');void 0;`);
    await until(() => evaluate(`document.querySelector('#settings-tab-knowledge').textContent.includes('Knowledge')`), 'English Kit labels');
    assert.equal(await evaluate(`document.activeElement===settingsRefs.apiKey`), true);
    assert.deepEqual(await evaluate(`[settingsRefs.apiKey.selectionStart,settingsRefs.apiKey.selectionEnd]`), [4, 9]);
    assert.equal(await evaluate(`Object.entries(settingsRefs).every(([id,node])=>node===document.getElementById(id))`), true);
    assert.deepEqual(await evaluate(`Object.fromEntries(${JSON.stringify(Object.keys(values))}.map(id=>[id,document.getElementById(id).value]))`), values);
    assert.equal(await evaluate(`document.querySelector('#settingsNavigation').getAnimations({subtree:true}).filter(a=>a.playState==='running').length`), 0);
    await evaluate(`WorkstationI18n.setLanguage('zh-CN');void 0;`);
    await until(() => evaluate(`document.querySelector('#settings-tab-sync').textContent.includes('服务器')`), 'Chinese Kit labels');
  });
  await legacyCard(false);
  await check('production model-picker management entry reveals models from a remembered non-model section', async () => {
    await select('knowledge'); await evaluate(`showView('agent','对话');void ConversationModels.open()`);
    await until(() => evaluate(`!!document.querySelector('#modelPickerSettings')&&!document.querySelector('#modelPicker').hidden`), 'model picker');
    await click('#modelPickerSettings');
    await until(() => evaluate(`document.body.dataset.view==='settings'&&SettingsWorkspace.selected()==='models'`), 'model management direct section');
    assert.equal(await evaluate(`document.querySelector('#connectionsCard').getClientRects().length>0`), true);
    assert.equal(await evaluate(`document.querySelector('#apiKey').value`), values.apiKey);
    assert.equal(await evaluate(`document.querySelector('#usageInputRate').value`), values.usageInputRate);
  });
  await check('production onboarding connection step selects models without submitting settings', async () => {
    await select('sync'); await evaluate(`WorkstationOnboarding.open();void 0;`);
    await until(() => evaluate(`WorkstationOnboarding.isOpen()&&SettingsWorkspace.selected()==='models'`), 'onboarding model destination');
    assert.equal(await evaluate(`document.querySelector('#connectionsCard').getClientRects().length>0`), true);
    await click('#onboardingSkip');
    assert.equal(await evaluate(`document.querySelector('#apiKey').value`), values.apiKey);
  });
  await check('actual failed-run recovery reveals models and focuses a visible field without retrying', async () => {
    await select('appearance');
    await evaluate(`window.settingsRecoveryConversation=currentConversation()||createConversation();window.settingsRecoveryRun={id:'settings-smoke-failed-run',conversationId:settingsRecoveryConversation.id,status:'failed',modelConfig:{provider:'api'},errorDiagnostic:RunFailureDiagnostics.capture({code:'PROTOCOL_UNSUPPORTED'})};state.agentRuns.push(settingsRecoveryRun);settingsRecoveryConversation.messages.push({id:'settings-smoke-failed-message',role:'assistant',runId:settingsRecoveryRun.id,runStatus:'failed',text:'',retryRunId:settingsRecoveryRun.id});window.settingsRecoveryAccepted=openRunFailureRecovery(settingsRecoveryRun.id,'settings');void 0;`);
    assert.equal(await evaluate(`settingsRecoveryAccepted`), true);
    assert.equal(await evaluate(`SettingsWorkspace.selected()`), 'models');
    assert.equal(await evaluate(`!!document.activeElement.closest('#connectionsCard')`), true);
    assert.equal(await evaluate(`document.activeElement.getClientRects().length>0&&!document.activeElement.closest('[hidden]')`), true);
    assert.equal(await evaluate(`settingsRecoveryRun.status`), 'failed');
    assert.equal(await evaluate(`document.querySelector('#apiKey').value`), values.apiKey);
  });
  await check('actual 1200, 820 and 620 content widths keep each section and field within its pane in both palettes', async () => {
    for (const width of [1200, 820, 620]) {
      win.setContentSize(width, 1000);
      for (const [index, section] of ['models', 'sync', 'knowledge', 'plugins', 'appearance'].entries()) {
        const theme = index % 2 ? 'dark' : 'light';
        await evaluate(`document.body.classList.toggle('light-mode',${theme === 'light'});WorkstationI18n.setLanguage(${JSON.stringify(width === 620 ? 'en' : 'zh-CN')});void 0;`);
        await select(section);
        await evaluate(`document.querySelector('#settings .page-heading').scrollIntoView({block:'start'});void 0;`);
        await wait(80);
        const bounds = await evaluate(`(() => {const panel=document.querySelector('#settings .settings-section:not([hidden])'),page=document.querySelector('#settings'),r=panel.getBoundingClientRect();return {section:panel.dataset.settingsSection,viewport:innerWidth,panel:{left:r.left,right:r.right,width:r.width},pageScrollWidth:page.scrollWidth,pageClientWidth:page.clientWidth,overflow:[...panel.querySelectorAll('input,select,button')].filter(n=>n.getClientRects().length&&!n.closest('[aria-hidden="true"]')).map(n=>({id:n.id,box:n.getBoundingClientRect()})).filter(x=>x.box.width>0&&(x.box.left<r.left-2||x.box.right>r.right+2)).map(x=>x.id)}})()`);
        layout.push({ width, theme, ...bounds });
        assert.equal(bounds.viewport, width);
        assert.ok(bounds.panel.width > 150, JSON.stringify(bounds));
        assert.ok(bounds.panel.left >= -1 && bounds.panel.right <= width + 1, JSON.stringify(bounds));
        assert.deepEqual(bounds.overflow, [], JSON.stringify(bounds));
        assert.ok(bounds.pageScrollWidth <= bounds.pageClientWidth + 2, JSON.stringify(bounds));
        await snapshot(`${width}-${theme}-${section}`);
      }
    }
  });
  await check('selected section survives real reload while unsaved service credentials do not become persisted configuration', async () => {
    await select('knowledge');
    await evaluate(`WorkstationOnboarding.close('skipped');WorkspaceTour.close('skipped');void 0;`);
    await until(() => evaluate(`fetch('/__state').then(r=>r.json()).then(data=>(data.state||data).ui?.settingsSection==='knowledge')`), 'section persisted in workspace backend');
    // Native launches can use a different localhost port. Its workspace state
    // must restore this preference even when origin-local storage is absent.
    await evaluate(`localStorage.removeItem('workstation-settings-section-v1');void 0;`);
    const reloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.reload(); await reloaded;
    await until(() => evaluate(`typeof storageHydrated!=='undefined'&&storageHydrated&&!!document.querySelector('#settingsNavigation')`), 'reload hydration');
    await evaluate(`WorkstationOnboarding.close('skipped');WorkspaceTour.close('skipped');showView('settings','设置');void 0;`);
    assert.equal(await evaluate(`SettingsWorkspace.selected()`), 'knowledge');
    assert.equal(await evaluate(`state.ui.settingsSection`), 'knowledge');
    assert.equal(await evaluate(`document.querySelector('#settings-tab-knowledge').getAttribute('aria-selected')`), 'true');
    // The semantic-search card now lives on Models → Embedding and is parked (hidden) here; the section shows a pointer to it.
    assert.equal(await evaluate(`document.querySelector('#knowledgeEmbeddingPointer').getClientRects().length>0&&document.querySelector('#embeddingSettings').getClientRects().length===0`), true);
    assert.equal(await evaluate(`localStorage.getItem('workstation-api-base')`), null);
    assert.equal(await evaluate(`localStorage.getItem('workstation-api-key')`), null);
    assert.equal(await evaluate(`document.querySelector('#apiKey').value`), '');
    assert.equal(await evaluate(`document.querySelector('#embeddingKey').value`), '');
    assert.equal(await evaluate(`document.querySelector('#cloudPassword').value`), '');
    await assertPanels('restored knowledge after reload');
  });
  await check('no inference, cloud connection or remote request is performed by settings navigation', async () => {
    assert.deepEqual(remoteRequests, []);
    assert.deepEqual(requests.filter(item => /\/(?:__proxy|__cloud\/(?:connect|sync|disconnect|settings)|__ssh\/(?:connect|probe))/.test(item.path)), []);
  });
  await finish();
})().catch(async error => { console.error(error); fatalError = error.stack; await finish(); });
