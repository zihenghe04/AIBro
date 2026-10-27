/* External MCP plugin smoke (M1 P3 acceptance): the production renderer and a
   temporary local server with an isolated data directory, HOME and profile.
   The test MCP server (tests/fixtures/mcp-fixture-server.py) is added through
   Settings → Plugins. Checks the four roadmap points: it can be added and
   switched on/off; its write tool asks by default; it sees no keys; after it
   exits its tools are gone. No model is called; remote requests are refused.
   Run: node_modules/.bin/electron tests/mcp-plugins-smoke.cjs (holds the GUI lock). */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results/mcp-plugins-smoke');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-mcp-smoke-'));
const STORE = path.join(TEMP, 'store');
const HOME_FIXTURE = path.join(TEMP, 'isolated-home');
for (const directory of [OUT, STORE, HOME_FIXTURE]) fs.mkdirSync(directory, { recursive: true });
app.setPath('userData', path.join(TEMP, 'profile'));
app.on('window-all-closed', () => {});
// Fake keys in the local service's environment: the plugin must not see any of them.
const FAKE_KEYS = { OPENAI_API_KEY: 'sk-smoke-not-a-real-key', ANTHROPIC_API_KEY: 'smoke-not-a-real-key', AI_BRO_SMOKE_TOKEN: 'smoke-token' };
const PYTHON = execFileSync(process.env.PYTHON || 'python3', ['-c', 'import sys;print(sys.executable)']).toString().trim();
const FIXTURE = path.join(ROOT, 'tests/fixtures/mcp-fixture-server.py');
const checks = [], failures = [], rendererErrors = [], remoteRequests = [], requests = [], screenshots = [];
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
const watchdog = setTimeout(async () => { fatalError = 'MCP plugin smoke timeout'; await finish(); }, 180000);
async function finish() {
  clearTimeout(watchdog);
  await cleanup();
  const report = { passed: checks.length, checks, failures, rendererErrors, remoteRequests, realModelCalls: 0, screenshots, fatalError, fixtureRemoved: !fs.existsSync(TEMP),
    requests: requests.filter(item => item.path.startsWith('/__plugins')),
    scope: 'Production renderer, temporary local server, isolated data/HOME/profile, stdio test MCP server. No model calls.' };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: checks.length, failures: failures.length, rendererErrors, remoteRequests, fatalError, fixtureRemoved: report.fixtureRemoved }));
  app.exit(fatalError || failures.length || rendererErrors.length || remoteRequests.length ? 1 : 0);
}
(async () => {
  const port = await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); }); });
  origin = `http://127.0.0.1:${port}`;
  const log = fs.openSync(path.join(TEMP, 'server.log'), 'a');
  server = spawn(PYTHON, [path.join(ROOT, 'app/server.py')], { cwd: ROOT,
    env: { ...process.env, ...FAKE_KEYS, HOME: HOME_FIXTURE, CODEX_HOME: path.join(HOME_FIXTURE, '.codex'), AI_WORKSTATION_PORT: String(port), AI_WORKSTATION_DATA_DIR: STORE, AI_WORKSTATION_ASSET_DIR: path.join(ROOT, 'app') }, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  await until(() => new Promise(resolve => { http.get(origin + '/__health', response => { response.resume(); resolve(response.statusCode === 200); }).on('error', () => resolve(false)); }), 'isolated server');
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 1200, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => {
    const remote = !request.url.startsWith(origin + '/');
    if (remote) remoteRequests.push(new URL(request.url).origin);
    else requests.push({ method: request.method, path: new URL(request.url).pathname });
    callback({ cancel: remote || /\/(?:__proxy|__cloud\/|__ssh\/)/.test(new URL(request.url).pathname) });
  });
  const evaluate = source => win.webContents.executeJavaScript(source, true);
  const click = selector => evaluate(`(() => {const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing control: '+${JSON.stringify(selector)});node.click();})()`);
  const snapshot = async name => { await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`); await wait(80); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); screenshots.push(name + '.png'); };
  const paste = async text => {
    await evaluate(`(()=>{const n=document.getElementById('pluginImportText');n.value=${JSON.stringify(text)};n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await click('#pluginImportParse');
  };
  const toolset = () => evaluate(`AIBroPlugins.default.freeze().tools.filter(n=>n.startsWith('vocabfixture__')).sort()`);
  // A call as a run makes it: the window's adapter, a run record and the card.
  const startCall = (type, args = {}) => evaluate(`(()=>{window.smokeRun={id:'smoke-run-'+Date.now(),permissionMode:'auto',pluginCalls:[]};
    window.smokeCall=AIBroMcpPlugins.execute({type:${JSON.stringify(type)},...${JSON.stringify(args)}},{run:smokeRun,save(){},refresh(){}}).then(r=>window.smokeResult=r,e=>window.smokeResult={thrown:e.code||e.message});
    window.smokeResult=null;return true;})()`);
  const result = async () => { await until(() => evaluate(`window.smokeResult!==null`), 'call result', 20000); return evaluate(`window.smokeResult`); };
  await win.loadURL(origin);
  await until(() => evaluate(`typeof storageHydrated!=='undefined'&&storageHydrated&&!!window.AIBroPlugins?.default?.loaded()`), 'production hydration and plugin settings');
  await evaluate(`(async()=>{WorkstationOnboarding?.close('skipped');await WorkspaceTour?.open();WorkspaceTour?.close('skipped');showView('settings','设置');SettingsWorkspace.init();SettingsWorkspace.reveal('plugins');window.confirm=()=>true;})()`);
  await until(() => evaluate(`!!document.querySelector('#settings-panel-plugins #pluginSettingsCard')&&!document.querySelector('#settings-panel-plugins').hidden`), 'Settings → Plugins');

  await check('a package runner command is refused before anything starts', async () => {
    await click('#pluginImportOpen');
    await paste('/usr/bin/env npx some-mcp-server');
    await until(() => evaluate(`!!document.querySelector('[data-status="needs_install"]')`), 'install notice shown');
    assert.match(await evaluate(`document.querySelector('[data-status="needs_install"]').textContent`), /npm install -g some-mcp-server/);
    assert.equal(await evaluate(`!!document.querySelector('[data-status="needs_install"] [data-action="check"]')`), false);
  });
  await check('add: test the connection, preview (server claims not enforced, every tool asks), confirm', async () => {
    await paste(`${PYTHON} ${FIXTURE}`);
    await until(() => evaluate(`!!document.querySelector('[data-status="ready"] [data-action="check"]')`), 'ready candidate');
    await click('[data-status="ready"] [data-action="check"]');
    await until(() => evaluate(`!!document.querySelector('#pluginCheckTools li')`), 'tool preview', 20000);
    assert.match(await evaluate(`document.querySelector('#pluginCheck .plugin-notice').textContent`), /无法强制/);
    assert.ok(await evaluate(`document.querySelectorAll('#pluginCheckTools li').length`) >= 5);
    assert.equal(await evaluate(`document.querySelector('#pluginCheckTier .on').dataset.value`), 'ask');
    await evaluate(`(()=>{const n=document.getElementById('pluginCheckName');n.value='vocab-fixture';n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await snapshot('add-preview');
    await click('#pluginCheckConfirm');
    await until(() => evaluate(`AIBroPlugins.default.config().mcp.length===1`), 'added');
    assert.ok((await evaluate(`AIBroPlugins.default.config().mcp[0].tools.every(t=>t.tier==='ask')`)));
    await click('#pluginBack');
    await until(() => evaluate(`!!document.querySelector('[data-mcp-plugin="vocabfixture"]')`), 'added plugin listed');
    assert.ok((await toolset()).includes('vocabfixture__add_word'));
    assert.equal(await evaluate(`AIBroTools.registry.get('vocabfixture__add_word').effect`), 'external');
    // Lazy start: adding stopped the probe; nothing runs until the first call.
    assert.deepEqual(await evaluate(`fetch('/__plugins').then(r=>r.json()).then(v=>v.mcp.map(e=>e.id))`), ['vocabfixture']);
    await snapshot('added');
  });
  await check('switch off and on: the tools leave and return for the next run', async () => {
    await evaluate(`(()=>{const n=document.querySelector('[data-mcp-plugin="vocabfixture"] input[type=checkbox]');n.checked=false;n.dispatchEvent(new Event('change'));})()`);
    await until(async () => (await toolset()).length === 0, 'tools gone when off');
    await evaluate(`(()=>{const n=document.querySelector('[data-mcp-plugin="vocabfixture"] input[type=checkbox]');n.checked=true;n.dispatchEvent(new Event('change'));})()`);
    await until(async () => (await toolset()).includes('vocabfixture__add_word'), 'tools back when on');
  });
  await check('the write tool asks by default; declined it never runs, allowed it runs once', async () => {
    await startCall('vocabfixture__add_word', { word: 'serendipity', meaning: 'luck' });
    await until(() => evaluate(`smokeRun.pluginCalls[0]?.status==='awaiting-approval'&&AIBroMcpPlugins.pending().length===1`), 'approval question', 20000);
    const card = await evaluate(`(()=>{const c=AIBroMcpPlugins.card(smokeRun);return {allow:!!c.querySelector('[data-mcp-decision=allow]'),deny:!!c.querySelector('[data-mcp-decision=deny]')};})()`);
    assert.deepEqual(card, { allow: true, deny: true });
    await evaluate(`AIBroMcpPlugins.decide(AIBroMcpPlugins.pending()[0],false)`);
    assert.equal((await result()).code, 'APPROVAL_DENIED');
    await startCall('vocabfixture__add_word', { word: 'serendipity', meaning: 'luck' });
    await until(() => evaluate(`AIBroMcpPlugins.pending().length===1`), 'second question', 20000);
    await evaluate(`(()=>{const c=AIBroMcpPlugins.card(smokeRun);document.body.append(c);c.querySelector('[data-mcp-decision=allow]').click();})()`);
    const done = await result();
    assert.equal(done.content, 'saved serendipity'); assert.equal(done.externalContentIsUntrusted, true);
  });
  await check('the server sees no keys and runs in its own data directory', async () => {
    // Lower env_report to read-only through the settings page (the user confirms).
    await click('[data-mcp-plugin="vocabfixture"]');
    await evaluate(`(()=>{const s=document.querySelector('select[data-tool="env_report"]');s.value='readonly';s.dispatchEvent(new Event('change'));})()`);
    await until(() => evaluate(`AIBroPlugins.default.config().mcp[0].tools.find(t=>t.name==='env_report').tier==='readonly'`), 'tier saved');
    await click('#pluginBack');
    await startCall('vocabfixture__env_report');
    const report = JSON.parse((await result()).content);
    for (const name of Object.keys(FAKE_KEYS)) assert.ok(!report.names.includes(name), name);
    assert.ok(report.names.every(name => /^(PATH|HOME|TMPDIR|LANG|LC_ALL|LC_CTYPE|PWD|SHLVL|_|__CF_USER_TEXT_ENCODING|VERSIONER_PYTHON_VERSION|PYTHONIOENCODING)$/.test(name)), JSON.stringify(report.names));
    assert.ok(fs.realpathSync(report.cwd).startsWith(fs.realpathSync(path.join(STORE, 'plugins'))), report.cwd);
    assert.equal(fs.realpathSync(report.home), fs.realpathSync(report.cwd));
  });
  await check('after the server exits its tools are gone until it is tested again', async () => {
    await startCall('vocabfixture__quit_server');
    await until(() => evaluate(`AIBroMcpPlugins.pending().length===1`), 'quit question', 20000);
    await evaluate(`AIBroMcpPlugins.decide(AIBroMcpPlugins.pending()[0],true)`);
    await result();
    await until(() => evaluate(`fetch('/__plugins').then(r=>r.json()).then(v=>v.mcp[0].available===false)`), 'marked unavailable', 20000);
    await evaluate(`AIBroPlugins.default.load()`);
    assert.deepEqual(await toolset(), []);
    assert.match(await evaluate(`document.querySelector('[data-mcp-plugin="vocabfixture"]').textContent`), /不可用/);
    await snapshot('exited');
    await click('[data-mcp-plugin="vocabfixture"]');
    await click('[data-action="retest"]');
    await until(async () => (await toolset()).includes('vocabfixture__add_word'), 'back after re-test', 20000);
  });
  await check('remove: the plugin and its tools leave', async () => {
    await click('[data-action="remove"]');
    await until(() => evaluate(`!document.querySelector('[data-mcp-plugin="vocabfixture"]')`), 'removed');
    await until(async () => (await toolset()).length === 0, 'tools gone after remove');
    assert.deepEqual(await toolset(), []);
    assert.equal(await evaluate(`AIBroTools.registry.has('vocabfixture__add_word')`), false);
  });
  await check('no remote request or model call was made', async () => {
    assert.deepEqual(remoteRequests, []);
    // /__codex/detect only looks for the local CLI (the connections card calls it on load); it sends nothing to a model.
    assert.deepEqual(requests.filter(item => /\/(?:__proxy|__claude|__codex)/.test(item.path) && item.path !== "/__codex/detect"), []);
  });
  await finish();
})().catch(async error => { console.error(error); fatalError = error.stack; await finish(); });
