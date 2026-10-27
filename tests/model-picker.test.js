const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const load = name => fs.readFileSync(require.resolve('../app/' + name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const Catalog = require('../app/model-catalog.js'), C = require('../app/connections.js'), P = require('../app/providers.js');
globalThis.ModelCatalog = Catalog; globalThis.Connections = C; globalThis.Providers = P;
const A = 'https://relay-a.example.invalid/v1', B = 'https://relay-b.example.invalid/v1';
const catalogue = [
  { model: 'account-default', displayName: 'Default account model', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] },
  { id: 'account-fast', displayName: 'Fast account model', supportedReasoningEfforts: ['low', 'medium'], defaultReasoningEffort: 'low' },
];
const response = models => ({ ok: true, json: async () => ({ data: models }) });

function makeSettings() {
  const s = { modelCatalog: { version: 1, services: { [A]: { models: [{ model: 'a-1', label: 'A One' }, { model: 'a-2', efforts: ['low', 'high'] }], updatedAt: 1 }, [B]: { models: [{ model: 'b-1', label: 'B One' }], updatedAt: 1 } } } };
  C.migrate(s, { provider: 'api', base: A, model: 'a-1', protocol: 'chat', profiles: [{ base: B, model: 'b-1', settings: { protocol: 'chat' } }], codexModel: '' });
  P.ensure(s);
  P.setModelCaps(s, C.apiId(B), 'b-1', { think: false, vision: true });
  return s;
}

function harness(options = {}) {
  const { document, window } = parseHTML('<html lang="zh-CN"><body><div id="reader" tabindex="0"></div><button id="composerModel" type="button">模型</button><section id="modelPicker" hidden></section></body></html>');
  const registry = {};
  document.addEventListener = (type, fn) => (registry[type] ||= []).push(fn);
  const fire = (type, event) => (registry[type] || []).forEach(fn => fn(event));
  const state = { settings: options.settings || makeSettings(), conversations: options.conversations || [{ id: 'first', title: 'First conversation' }, { id: 'second', title: 'Second conversation' }] };
  let currentId = state.conversations[0].id, saves = 0;
  const defaults = options.defaults || { provider: 'api', model: 'a-1', effort: '' };
  const calls = [], toasts = [];
  const context = vm.createContext({
    document, Event: window.Event, AbortController, URL, structuredClone, setTimeout, clearTimeout, innerWidth: 1200, innerHeight: 900, addEventListener() {}, console,
    fetch: (url, init) => { calls.push({ url, init }); return options.fetch ? options.fetch(url, init) : Promise.resolve(response(catalogue)); },
    OpenAIAuth: { ensureReady: async () => { if (options.ensureReady) await options.ensureReady(); } },
    ClaudeAuth: { ensureReady: async () => {} },
    requestAnimationFrame: undefined, ComposerUI: options.composerUI,
  });
  for (const file of ['ui-kit.js', 'model-catalog.js', 'connections.js', 'providers.js', 'model-choices.js', 'model-picker.js']) vm.runInContext(load(file), context, { filename: file });
  const api = context.ConversationModels;
  if (options.claude !== undefined) api.configure({ claudeEnabled: () => options.claude });
  api.init({
    getState: () => state, getConversation: () => state.conversations.find(conversation => conversation.id === currentId),
    getDefaults: () => defaults, getResolvedConfig: options.getResolvedConfig, getActiveBase: () => A, canSave: options.canSave,
    save: async () => { saves++; return options.save ? options.save() : true; }, toast: message => toasts.push(message), openSettings: () => { calls.push('settings'); },
  });
  const $ = id => document.getElementById(id), $$ = selector => [...document.querySelectorAll(selector)];
  return {
    api, state, defaults, calls, toasts, document, $, fire,
    open: () => $('composerModel').click(),
    rows: () => $$('#modelPickerList [role=option]'),
    row: model => $$('#modelPickerList [role=option]').find(node => node.dataset.model === model),
    selected: () => $$('#modelPickerList [aria-selected=true]').map(node => node.dataset.model),
    switchConversation: id => { currentId = id; api.sync(); },
    get saves() { return saves; },
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('conversations inherit live defaults until explicitly selected, without mutating other conversations', () => {
  const h = harness();
  assert.deepEqual(plain(h.api.current()), { provider: 'api', model: 'a-1', effort: '' });
  h.api.setSelection(h.state.conversations[0], { provider: 'openai-auth', model: 'account-default', effort: 'high' });
  h.defaults.model = 'updated-global'; h.defaults.effort = 'low';
  assert.deepEqual(plain(h.api.current()), { provider: 'openai-auth', model: 'account-default', effort: 'high' });
  h.switchConversation('second');
  assert.deepEqual(plain(h.api.current()), { provider: 'api', model: 'updated-global', effort: 'low' });
  assert.equal(h.state.conversations[1].modelConfig, undefined);
  assert.match(h.$('composerModel').title, /继承默认/);
});

test('configuration keeps the chosen provider connection and drops empty effort', () => {
  const h = harness();
  assert.deepEqual(plain(h.api.configuration({ modelConfig: { provider: 'api', model: '  custom-model  ', effort: 'auto' } })), { provider: 'api', model: 'custom-model', effort: '' });
  assert.deepEqual(plain(h.api.configuration({ modelConfig: { provider: 'api', connection: C.apiId(B), model: 'b-1', effort: 'low' } })), { provider: 'api', connection: C.apiId(B), model: 'b-1', effort: 'low' });
  assert.deepEqual(plain(h.api.effortsFor(catalogue, 'account-fast')), ['low', 'medium']);
  const conversation = h.state.conversations[0];
  h.api.setSelection(conversation, { provider: 'api', model: 'api-a', effort: 'low' });
  h.api.setSelection(conversation, { provider: 'openai-auth', model: 'account-fast', effort: 'medium' });
  assert.deepEqual(plain(conversation.modelChoices), { api: { model: 'api-a', effort: 'low' }, 'openai-auth': { model: 'account-fast', effort: 'medium' } });
});

test('an in-flight model and effort snapshot stays fixed while the conversation selection changes', async () => {
  const ready = deferred();
  const h = harness({ ensureReady: () => ready.promise });
  const conversation = h.state.conversations[0];
  h.api.setSelection(conversation, { provider: 'openai-auth', model: 'account-default', effort: 'high' });
  const runInput = h.api.current();
  const run = h.api.resolve(runInput);
  runInput.model = 'account-fast'; runInput.effort = 'low';
  h.api.setSelection(conversation, { provider: 'api', model: 'new-api', effort: 'medium' });
  ready.resolve();
  assert.deepEqual(plain(await run), { provider: 'openai-auth', model: 'account-default', effort: 'high' });
  assert.equal(h.api.current().model, 'new-api');
});

test('account model resolution rejects unavailable names and unsupported effort instead of silently falling back', async () => {
  const h = harness();
  await assert.rejects(h.api.resolve({ provider: 'openai-auth', model: 'missing', effort: '' }), /当前模型不可用/);
  await assert.rejects(h.api.resolve({ provider: 'openai-auth', model: 'account-fast', effort: 'high' }), /不支持 high/);
  assert.deepEqual(plain(await h.api.resolve({ provider: 'openai-auth', model: '', effort: '' })), { provider: 'openai-auth', model: 'account-default', effort: 'medium' });
});

test('Claude run snapshots reject unsupported alias or reasoning before transport', async () => {
  const h = harness();
  await assert.rejects(h.api.resolve({ provider: 'claude-auth', model: 'arbitrary-model', effort: '' }), /别名/);
  await assert.rejects(h.api.resolve({ provider: 'claude-auth', model: 'opus', effort: 'high' }), /默认推理/);
  assert.equal((await h.api.resolve({ provider: 'claude-auth', model: 'sonnet', effort: '' })).model, 'sonnet');
});

test('new conversations inherit the latest used model; old workspaces migrate the most recent message config', () => {
  const h = harness();
  const restored = JSON.parse(JSON.stringify(h.state));
  h.api.remember(restored, { provider: 'api', connection: C.apiId(B), model: 'b-1', effort: 'high' });
  assert.deepEqual(plain(h.api.forNewConversation(restored, h.defaults)), { provider: 'api', connection: C.apiId(B), model: 'b-1', effort: 'high' });
  const old = harness();
  old.state.conversations[0].messages = [{ at: 10, modelConfig: { provider: 'api', model: 'old', effort: 'low' } }];
  old.state.conversations[1].messages = [{ at: 20, modelConfig: { provider: 'openai-auth', model: 'account-fast', effort: 'medium' } }];
  assert.equal(old.api.forNewConversation(old.state, old.defaults).model, 'account-fast');
});

test('the panel lists enabled providers as groups, marks the current and default model, and offers no connection dropdown', async () => {
  const h = harness();
  await h.open(); await tick();
  const panel = h.$('modelPicker');
  assert.equal(panel.hidden, false);
  assert.equal(h.$('composerModel').getAttribute('aria-expanded'), 'true');
  assert.deepEqual([...panel.querySelectorAll('.mp-group-name')].map(node => node.textContent).length >= 2, true);
  assert.deepEqual(h.rows().map(node => node.dataset.model).filter(Boolean).slice(0, 4).includes('b-1'), true);
  assert.deepEqual(h.selected(), ['a-1']);
  assert.match(panel.querySelector('.uk-badge').textContent, /默认/);
  assert.equal(panel.querySelector('select'), null);
  assert.equal(panel.querySelector('#conversationApiModel'), null);
  assert.match(h.$('modelPickerSource').textContent, /继承/);
  assert.equal(h.$('resetModelSelection').hidden, true);
});

test('choosing a model of another provider stores its connection, persists once and keeps the panel open for effort', async () => {
  const h = harness();
  await h.open(); await tick();
  h.row('a-2').click(); await tick();
  assert.deepEqual(plain(h.state.conversations[0].modelConfig), { provider: 'api', connection: C.apiId(A), model: 'a-2', effort: '' });
  assert.equal(h.saves, 1);
  assert.equal(h.$('modelPicker').hidden, false);
  const effort = h.$('modelPickerEffort');
  assert.equal(effort.hidden, false);
  assert.deepEqual([...effort.querySelectorAll('.uk-seg-item')].map(node => node.dataset.value), ['', 'low', 'high']);
  effort.querySelector('[data-value="high"]').click(); await tick();
  assert.equal(h.state.conversations[0].modelConfig.effort, 'high');
  assert.equal(h.saves, 2);
  assert.match(h.$('modelPickerSource').textContent, /对话设定/);
  assert.equal(h.$('resetModelSelection').hidden, false);
  assert.equal(h.state.settings.recentConversationModel.effort, 'high');
});

test('a model that does not think shows no effort picker and the panel closes after choosing it', async () => {
  const h = harness();
  await h.open(); await tick();
  h.row('b-1').click(); await tick();
  assert.equal(h.state.conversations[0].modelConfig.connection, C.apiId(B));
  assert.equal(h.$('modelPicker').hidden, true);
  assert.equal(h.$('composerModel').getAttribute('aria-expanded'), 'false');
  assert.match(h.$('composerModel').textContent, /B One/);
});

test('an effort the new model does not offer is dropped when switching models', async () => {
  const h = harness();
  h.api.setSelection(h.state.conversations[0], { provider: 'api', connection: C.apiId(A), model: 'a-2', effort: 'high' });
  await h.open(); await tick();
  h.row('a-1').click(); await tick();
  assert.equal(h.state.conversations[0].modelConfig.model, 'a-1');
  assert.equal(h.state.conversations[0].modelConfig.effort, 'high', 'a-1 offers every protocol level, so high stays');
  h.row('a-2').click(); await tick();
  h.$('modelPickerEffort').querySelector('[data-value="low"]').click(); await tick();
  h.row('b-1').click(); await tick();
  assert.equal(h.state.conversations[0].modelConfig.effort, '');
});

test('old v1 modelConfig (no connection) selects the right row; unknown models stay visible instead of switching', async () => {
  const h = harness();
  h.state.conversations[0].modelConfig = { provider: 'api', model: 'b-1', effort: '' };
  await h.open(); await tick();
  assert.deepEqual(h.selected(), ['b-1']);
  h.$('closeModelPicker').click();
  h.state.conversations[0].modelConfig = { provider: 'api', model: 'gone-model', effort: '' };
  await h.open(); await tick();
  assert.equal(h.$('modelPickerList').querySelector('.is-stale .mp-opt-label').textContent, 'gone-model');
  assert.equal(h.state.conversations[0].modelConfig.model, 'gone-model', 'opening never rewrites the stored choice');
});

test('search filters by model, provider name or host', async () => {
  const h = harness();
  await h.open(); await tick();
  const search = h.$('modelPickerSearch');
  search.value = 'relay-b'; search.dispatchEvent(new h.document.defaultView.Event('input')); 
  assert.deepEqual(h.rows().map(node => node.dataset.model), ['b-1']);
  search.value = 'zzz'; search.dispatchEvent(new h.document.defaultView.Event('input'));
  assert.match(h.$('modelPickerList').textContent, /没有匹配/);
});

test('reset inherits and remembers the inherited resolution; failed saves roll back with a visible message', async () => {
  const h = harness();
  h.api.setSelection(h.state.conversations[0], { provider: 'api', connection: C.apiId(B), model: 'b-1', effort: '' });
  await h.open(); await tick();
  h.$('resetModelSelection').click(); await tick();
  assert.equal(h.state.conversations[0].modelConfig, undefined);
  assert.equal(h.$('resetModelSelection').hidden, true);
  const failing = harness({ save: async () => { throw Error('disk full'); } });
  await failing.open(); await tick();
  failing.row('a-2').click(); await tick();
  assert.equal(failing.state.conversations[0].modelConfig, undefined);
  assert.match(failing.$('modelPickerStatus').textContent, /disk full/);
  assert.equal(failing.$('modelPicker').hidden, false);
});

test('Claude is offered only when its switch is on, as official aliases without efforts', async () => {
  const off = harness({ claude: false }); await off.open(); await tick();
  assert.equal(off.rows().some(node => node.dataset.connection === C.CLAUDE_ID), false);
  const on = harness({ claude: true }); await on.open(); await tick();
  assert.deepEqual(on.rows().filter(node => node.dataset.connection === C.CLAUDE_ID).map(node => node.dataset.model), ['', 'sonnet', 'opus', 'haiku']);
  on.row('opus').click(); await tick();
  assert.deepEqual(plain(on.state.conversations[0].modelConfig), { provider: 'claude-auth', model: 'opus', effort: '' });
});

test('Escape, outside press and conversation switch dismiss without writing; manage models opens settings', async () => {
  const h = harness();
  await h.open(); await tick();
  h.fire('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(h.$('modelPicker').hidden, true);
  await h.open(); await tick();
  h.fire('pointerdown', { target: h.$('reader') });
  assert.equal(h.$('modelPicker').hidden, true);
  await h.open(); await tick();
  h.switchConversation('second');
  assert.equal(h.$('modelPicker').hidden, true);
  assert.equal(h.state.conversations[0].modelConfig, undefined);
  h.switchConversation('first');
  await h.open(); await tick();
  h.$('modelPickerSettings').click();
  assert.deepEqual(h.calls.filter(call => call === 'settings'), ['settings']);
  assert.equal(h.$('modelPicker').hidden, true);
});

test('a save in flight blocks a second choice and Escape; a pending choice is not visible to other readers until ACK', async () => {
  const gate = deferred();
  const h = harness({ save: () => gate.promise });
  await h.open(); await tick();
  h.row('a-2').click(); await tick();
  assert.equal(h.api.isSaving(), true);
  assert.deepEqual(h.selected(), ['a-2'], 'the panel shows the pending choice');
  assert.equal(h.api.current().model, 'a-1', 'committed view is unchanged until ACK');
  h.row('b-1').click(); await tick();
  assert.equal(h.saves, 1);
  h.fire('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(h.$('modelPicker').hidden, false);
  gate.resolve(true); await tick(); await tick();
  assert.equal(h.api.current().model, 'a-2');
  assert.equal(h.api.isSaving(), false);
});

test('a request being prepared blocks changes with an honest message', async () => {
  const h = harness({ canSave: () => false });
  await h.open(); await tick();
  h.row('a-2').click(); await tick();
  assert.equal(h.state.conversations[0].modelConfig, undefined);
  assert.match(h.$('modelPickerStatus').textContent, /正在准备请求/);
});

test('account models come from the signed-in catalogue and a failed read says so without blocking other providers', async () => {
  const s = makeSettings();
  const h = harness({ settings: s, fetch: async () => { throw Error('offline'); } });
  P.upsert(s, { kind: 'account', name: 'ChatGPT', account: { service: 'chatgpt', login: 'shared' }, models: [] });
  await h.open(); await tick(); await tick();
  assert.match(h.$('modelPickerStatus').textContent, /暂时读不到/);
  assert.ok(h.row('a-1'));
  const ok = harness({ settings: s });
  await ok.open(); await tick(); await tick();
  assert.deepEqual(ok.rows().filter(node => node.dataset.connection === P.CHATGPT_ID).map(node => node.dataset.model), ['account-default', 'account-fast']);
  ok.row('account-fast').click(); await tick();
  assert.deepEqual(plain(ok.state.conversations[0].modelConfig), { provider: 'openai-auth', model: 'account-fast', effort: '' });
  assert.deepEqual([...ok.$('modelPickerEffort').querySelectorAll('.uk-seg-item')].map(node => node.dataset.value), ['', 'low', 'medium']);
});

test('providers imported without a key are listed greyed with a key-needed hint and open settings instead of being chosen', async () => {
  const s = makeSettings();
  P.setNeedsKey(s, C.apiId(B), true);
  const h = harness({ settings: s });
  await h.open(); await tick();
  const row = h.row('b-1');
  assert.ok(row.classList.contains('needs-key'));
  assert.match(row.textContent, /待补密钥/);
  row.click(); await tick();
  assert.equal(h.state.conversations[0].modelConfig, undefined);
  assert.deepEqual(h.calls.filter(call => call === 'settings'), ['settings']);
  assert.equal(h.$('modelPicker').hidden, true);
});
