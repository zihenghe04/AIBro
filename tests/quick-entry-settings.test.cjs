const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { parseHTML } = require(process.env.AIBRO_TEST_DOM_MODULE || 'linkedom');
const read = file => fs.readFileSync(require('node:path').join(__dirname, '..', file), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const state = mode => ({ status: 'ok', mode, isEnabled: mode !== 'off', preferredEnabledMode: mode === 'off' ? 'edge' : mode });
function fixture({ native = true } = {}) {
  const { window } = parseHTML('<html lang="zh-CN"><body><section id="settings"><div class="page-heading"></div><div class="settings-grid"><article class="settings-connection-card"><input id="apiKey" value="synthetic-draft"/></article><article id="appearanceCard"></article></div><button id="saveSettings"></button></section></body></html>');
  // linkedom models select.value as read-only; browsers provide this setter.
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', { configurable: true, get() { return this.querySelector('option[selected]')?.value || ''; }, set(value) { const options = [...this.querySelectorAll('option')]; for (const option of options) option.removeAttribute('selected'); options.find(option => option.value === value)?.setAttribute('selected', ''); } });
  const calls = [], pending = [];
  const api = Object.fromEntries(['state', 'setEnabled', 'setMode', 'openSettings'].map(name => [name, (...args) => { calls.push({ name, args }); return new Promise((resolve, reject) => pending.push({ resolve, reject })); }]));
  const localStorage = { getItem: () => null, setItem: () => assert.fail('Native mode must not use localStorage') };
  const context = { window: null, document: window.document, localStorage, addEventListener: window.addEventListener.bind(window), dispatchEvent: window.dispatchEvent.bind(window), workstationDesktop: native ? { quickEntry: api } : undefined, HalaskaUI: { mount(host, name, initial) {
    let props = initial; const button = name === 'Button' ? window.document.createElement('button') : null;
    if (button) { button.id = props.id; button.addEventListener('click', event => props.onClick(event)); host.append(button); }
    const update = next => { props = { ...props, ...next }; if (button) { button.textContent = props.children || ''; button.disabled = !!props.disabled; } };
    update({}); return { update };
  } } };
  // Navigation is already local UI state; allow its existing section key only.
  localStorage.setItem = key => assert.equal(key, 'workstation-settings-section-v1');
  context.window = context; vm.runInNewContext(read('app/settings-workspace.js'), context);
  context.SettingsWorkspace.init();
  return { context, window, doc: window.document, calls, pending, change(node) { node.dispatchEvent(new window.Event('change', { bubbles: true })); }, click(node) { node.dispatchEvent(new window.Event('click', { bubbles: true })); } };
}
test('settings card reads actual native state once, retains other forms and has no web-only substitute', async () => {
  const h = fixture(), key = h.doc.getElementById('apiKey');
  assert.deepEqual(h.calls.map(c => c.name), ['state']);
  assert.equal(h.doc.getElementById('quickEntryEnabled').disabled, true);
  h.pending.shift().resolve(state('off')); await flush();
  assert.equal(h.doc.getElementById('quickEntryEnabled').checked, false);
  assert.equal(h.doc.getElementById('quickEntryMode').value, 'edge');
  assert.equal(h.doc.getElementById('quickEntryMode').disabled, true);
  h.context.SettingsWorkspace.init();
  assert.equal(h.doc.querySelectorAll('#quickEntrySettingsCard').length, 1);
  assert.equal(h.doc.getElementById('settings-panel-appearance').firstElementChild.id, 'quickEntrySettingsCard');
  h.context.SettingsWorkspace.reveal('appearance'); h.pending.shift().resolve(state('island')); await flush();
  h.context.SettingsWorkspace.reveal('models');
  assert.equal(h.doc.getElementById('apiKey'), key); assert.equal(key.value, 'synthetic-draft');
  assert.equal(fixture({ native: false }).doc.getElementById('quickEntrySettingsCard'), null);
});
test('enable, placement, disable and details use authoritative replies; pending prevents duplicate writes', async () => {
  const h = fixture(); h.pending.shift().resolve(state('off')); await flush();
  const enabled = h.doc.getElementById('quickEntryEnabled'), mode = h.doc.getElementById('quickEntryMode');
  enabled.checked = true; h.change(enabled);
  assert.equal(h.calls.at(-1).name, 'setEnabled'); assert.equal(h.calls.at(-1).args[0], true);
  assert.equal(enabled.checked, false); assert.equal(enabled.disabled, true);
  h.change(enabled); assert.equal(h.calls.length, 2);
  h.pending.shift().resolve(state('edge')); await flush(); assert.equal(mode.value, 'edge'); assert.equal(enabled.checked, true);
  for (const value of ['island', 'menuBar']) { mode.value = value; h.change(mode); assert.equal(h.calls.at(-1).args[0], value); h.pending.shift().resolve(state(value)); await flush(); assert.equal(mode.value, value); }
  enabled.checked = false; h.change(enabled); h.pending.shift().resolve(state('off')); await flush();
  h.click(h.doc.getElementById('quickEntryDetails')); assert.equal(h.calls.at(-1).name, 'openSettings');
  h.pending.shift().resolve(state('off')); await flush(); assert.equal(enabled.checked, false);
});
test('late reads do not overwrite later changes; failure keeps confirmed state and controls recover', async () => {
  const h = fixture(); h.pending.shift().resolve(state('island')); await flush();
  h.context.SettingsWorkspace.reveal('appearance'); const stale = h.pending.shift();
  const mode = h.doc.getElementById('quickEntryMode'); mode.value = 'edge'; h.change(mode);
  h.pending.shift().resolve(state('edge')); await flush(); stale.resolve(state('island')); await flush(); assert.equal(mode.value, 'edge');
  mode.value = 'menuBar'; h.change(mode); h.pending.shift().reject(Error('synthetic offline')); await flush();
  assert.equal(mode.value, 'edge'); assert.equal(mode.disabled, false); assert.match(h.doc.querySelector('#quickEntrySettingsCard [role="status"]').textContent, /未能/);
  h.context.dispatchEvent(new h.window.Event('aibro-quick-entry-change')); h.pending.shift().resolve(state('menuBar')); await flush(); assert.equal(mode.value, 'menuBar');
  mode.value = 'edge'; h.change(mode);
  h.context.dispatchEvent(new h.window.Event('aibro-quick-entry-change'));
  h.pending.shift().resolve(state('edge')); await flush();
  assert.equal(h.calls.at(-1).name, 'state'); h.pending.shift().resolve(state('off')); await flush();
  assert.equal(h.doc.getElementById('quickEntryEnabled').checked, false);
  h.doc.documentElement.lang = 'en'; h.doc.dispatchEvent(new h.window.Event('workstation-language-change'));
  assert.equal(h.doc.querySelector('#quickEntrySettingsCard h2').textContent, 'Island & quick entry');
});
function bridge() {
  const { window } = parseHTML('<html><body><article id="quickEntrySettingsCard"><button></button></article></body></html>');
  const calls = []; class Storage { setItem() {} removeItem() {} }
  window.webkit = { messageHandlers: { desktop: { postMessage: async value => { calls.push(value); return state('edge'); } } } };
  vm.runInNewContext(read('native/Resources/desktop.js'), { window, Storage, localStorage: new Storage() });
  // Synthetic Event in this VM only. A browser-created Event.isTrusted is read-only.
  const event = new window.Event('change'); event.isTrusted = true; event.currentTarget = window.document.querySelector('button');
  return { window, api: window.workstationDesktop.quickEntry, calls, event };
}
test('desktop settings RPC is narrow, preserves status and rejects synthetic/no-card requests before posting', async () => {
  const h = bridge(); assert.deepEqual(await h.api.state(), state('edge'));
  await h.api.setEnabled(false, h.event); await h.api.setMode('menuBar', h.event); await h.api.openSettings(h.event);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [{ command: 'quick-entry-settings', action: 'state' }, { command: 'quick-entry-settings', action: 'enabled', enabled: false }, { command: 'quick-entry-settings', action: 'mode', mode: 'menuBar' }, { command: 'quick-entry-settings', action: 'open' }]);
  for (const event of [undefined, {}, { isTrusted: true, currentTarget: h.event.currentTarget }, new h.window.Event('click')]) assert.equal((await h.api.setEnabled(true, event)).reason, 'user_gesture_required');
  assert.equal((await h.api.setMode('off', h.event)).reason, 'invalid_request'); assert.equal((await h.api.setEnabled(1, h.event)).reason, 'invalid_request');
  h.event.currentTarget.remove(); assert.equal((await h.api.openSettings(h.event)).reason, 'user_gesture_required'); assert.equal(h.calls.length, 4);
  h.window.webkit.messageHandlers.desktop.postMessage = async () => { throw Error('native unavailable'); }; await assert.rejects(h.api.state(), /native unavailable/);
});
test('native settings branch stays behind trusted origin and current webview, validates every shape, and reads one coordinator', () => {
  const native = read('native/Sources/AIBro/NativeDesktop.swift'), wiring = read('native/Sources/AIBro/AIBro.swift');
  const branch = native.slice(native.indexOf('if command == "quick-entry-settings"'), native.indexOf('if ["agenda-query"'));
  assert.ok(native.indexOf('message.frameInfo.isMainFrame') < native.indexOf('if command == "quick-entry-settings"'));
  assert.match(native, /url\.scheme=="http",url\.host==origin\.host,url\.port==origin\.port/);
  assert.match(branch, /message\.webView === workspace\.web/); assert.match(branch, /workspace\.ready && workspace\.selection == "settings"/);
  assert.match(branch, /CFGetTypeID\(value\) == CFBooleanGetTypeID\(\)/); assert.match(branch, /\["island","edge","menuBar"\]\.contains\(mode\)/);
  assert.equal((branch.match(/Set\(body\.keys\) == Set\(/g) || []).length, 4);
  assert.match(branch, /default: replyHandler\(\["status":"error","reason":"invalid_request"\]/);
  const source = wiring.slice(wiring.indexOf('model.desktop?.quickEntrySettings ='), wiring.indexOf('model.desktop?.openQuickPanel ='));
  for (const value of ['self.model === model', 'self.quickEntry.setEnabled(enabled)', 'self.quickEntry.mode.rawValue', 'self.quickEntry.isEnabled', 'self.quickEntry.preferredEnabledMode.rawValue', 'self.quickEntry.isShowing(.settings)']) assert.ok(source.includes(value), value);
  assert.doesNotMatch(source, /preferences|localStorage|evaluateJavaScript/);
});
