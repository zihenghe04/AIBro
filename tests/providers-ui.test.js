const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const Catalog = require('../app/model-catalog.js');
globalThis.ModelCatalog = Catalog;
const C = require('../app/connections.js');
globalThis.Connections = C;
const P = require('../app/providers.js');
globalThis.Providers = P;
const UI = require('../app/providers-ui.js');

const A = 'https://relay-a.example.invalid/v1', B = 'https://api.anthropic.com';
function settings() {
  const s = { modelCatalog: { version: 1, services: { [A]: { models: [{ model: 'a-1', label: 'A One' }, { model: 'a-2', efforts: ['low', 'high'] }], updatedAt: 1 }, [B]: { models: [{ model: 'claude-test', efforts: ['low', 'high'] }], updatedAt: 1 } } } };
  C.migrate(s, { provider: 'api', base: A, model: 'a-1', protocol: 'chat', profiles: [{ base: B, model: 'claude-test', settings: { protocol: 'auto' } }], codexModel: '' });
  P.ensure(s);
  return s;
}
const codex = { mode: 'shared', detected: { installed: true, version: '9.9.9', loggedIn: true }, models: [{ model: 'm-1', displayName: 'Model 1', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] };

function mount(s, extra = {}) {
  const { document } = parseHTML('<html><body><article id="host"></article></body></html>');
  const calls = [];
  const ui = UI.create({ getSettings: () => s, onChange: info => { calls.push(info); }, codexSnapshot: async () => codex, confirm: () => true, ...extra });
  ui.mount(document.getElementById('host'));
  return { document, ui, calls, host: document.getElementById('host') };
}
const change = (document, node, value) => { for (const option of [...node.options]) { if (option.value === value) option.setAttribute('selected', ''); else option.removeAttribute('selected'); } node.dispatchEvent(new document.defaultView.Event('change', { bubbles: true })); };

test('view lists providers in order with public status only and the default first', () => {
  const view = UI.buildView(settings(), { codex });
  assert.deepEqual(view.providers.map(row => row.id), [C.apiId(A), C.apiId(B), 'codex-cli']);
  assert.equal(view.providers[0].isDefault, true);
  assert.match(view.providers[0].text, /relay-a\.example\.invalid · Chat Completions/);
  assert.match(view.providers[1].text, /Anthropic Messages/);
  assert.match(view.providers[2].text, /Codex 9\.9\.9 · 已登录/);
  assert.ok(!JSON.stringify(view).match(/sk-|token|apiKey/i));
  assert.equal(view.defaultBar.options[view.defaultBar.value].provider, C.apiId(A));
});

const openRole = (host, role) => host.querySelector(`.pv-role[data-role="${role}"]`).click();
test('purposes are entries at the bottom of the left column and open in the right pane', async () => {
  const { host } = mount(settings());
  assert.equal(host.querySelector('#providerPurposes').children.length, 6);
  assert.ok(!host.querySelector('.effort-mapping'));
  assert.ok(!host.textContent.includes('强度映射'));
  assert.deepEqual([...host.querySelectorAll('.pv-role')].map(node => node.getAttribute('data-role')), ['default', 'translate', 'vision', 'kernel', 'default-effort']);
  assert.match(host.querySelector('.pv-role[data-role="translate"]').textContent, /翻译跟随默认/);
  assert.match(host.querySelector('.pv-role[data-role="vision"]').textContent, /视觉跟随默认/);
  assert.equal(host.querySelector('#providerPurposePane'), null);
  openRole(host, 'vision');
  assert.ok(host.querySelector('#providerPurposePane #purpose-vision'));
  assert.equal(host.querySelector('#providerDetail'), null);
  host.querySelector('.pv-row').click();
  assert.equal(host.querySelector('#providerPurposePane'), null);
});

test('changing the default model reorders the list and reports the change', () => {
  const s = settings();
  const { document, host, calls } = mount(s);
  openRole(host, 'default');
  const select = host.querySelector('#providerDefaultModel');
  const target = [...select.options].find(option => /claude-test/.test(option.textContent));
  assert.ok(target);
  change(document, select, target.value);
  assert.equal(P.items(s)[0].id, C.apiId(B));
  assert.equal(s.modelRoles.qa.connection, C.apiId(B));
  assert.deepEqual(calls.at(-1), { defaultChanged: true });
  assert.ok(host.querySelector('.pv-row').getAttribute('data-id') === C.apiId(B));
});

test('an override is stored only when chosen and clears back to follow the default', () => {
  const s = settings();
  const { document, host, calls } = mount(s);
  openRole(host, 'translate');
  const select = host.querySelector('#purpose-translate');
  const target = [...select.options].find(option => /claude-test/.test(option.textContent));
  change(document, select, target.value);
  assert.deepEqual(P.overrides(s).translate, { provider: C.apiId(B), model: 'claude-test', effort: '' });
  assert.equal(C.resolveRole(s, 'translate').model, 'claude-test');
  assert.deepEqual(calls.at(-1), { defaultChanged: false });
  assert.match(host.querySelector('.pv-role[data-role="translate"]').textContent, /claude-test/);
  change(document, host.querySelector('#purpose-translate'), '');
  assert.deepEqual(P.overrides(s), {});
  assert.equal(C.resolveRole(s, 'translate').followsQa, true);
});

test('clicking a row shows its detail; model order and removal edit the fallback list', () => {
  const s = settings();
  const { document, host } = mount(s);
  host.querySelector(`[data-id="${C.apiId(A)}"]`).dispatchEvent(new document.defaultView.Event('click', { bubbles: true }));
  const rows = () => [...host.querySelectorAll('#providerModels .pv-model')].map(node => node.getAttribute('data-model'));
  assert.deepEqual(rows(), ['a-1', 'a-2']);
  assert.match(host.querySelector('#providerModels .pv-tag').textContent, /主模型/);
  host.querySelectorAll('#providerModels .pv-model')[1].querySelector('[aria-label="上移"]').dispatchEvent(new document.defaultView.Event('click', { bubbles: true }));
  assert.deepEqual(rows(), ['a-2', 'a-1']);
  assert.equal(s.modelRoles.qa.model, 'a-2');
  host.querySelectorAll('#providerModels .pv-model')[1].querySelector('[aria-label="移除"]').dispatchEvent(new document.defaultView.Event('click', { bubbles: true }));
  assert.deepEqual(rows(), ['a-2']);
  const input = host.querySelector('#providerAddModel');
  input.value = 'a-new';
  host.querySelector('#providerAddModelButton').dispatchEvent(new document.defaultView.Event('click', { bubbles: true }));
  assert.deepEqual(rows(), ['a-2', 'a-new']);
});

test('moving a row (drag drop path) changes the default; delete asks first and falls overrides back', () => {
  const s = settings();
  P.setOverride(s, 'kernel', { provider: C.apiId(B), model: 'claude-test', effort: '' });
  let asked = 0;
  const { document, host, ui } = mount(s, { confirm: () => { asked += 1; return asked > 1; } });
  ui.select(C.apiId(B));
  host.querySelector('#providerMakeDefault').dispatchEvent(new document.defaultView.Event('click', { bubbles: true }));
  assert.equal(P.items(s)[0].id, C.apiId(B));
  host.querySelector('#providerRemove').dispatchEvent(new document.defaultView.Event('click', { bubbles: true }));
  assert.ok(P.get(s, C.apiId(B)), 'declined confirmation keeps the provider');
  host.querySelector('#providerRemove').dispatchEvent(new document.defaultView.Event('click', { bubbles: true }));
  assert.equal(P.get(s, C.apiId(B)), null);
  assert.deepEqual(P.overrides(s), {});
  assert.equal(s.modelRoles.qa.connection, C.apiId(A));
});

test('the account row is read-only and lists the official models', async () => {
  const s = settings();
  const { document, host, ui } = mount(s);
  await new Promise(resolve => setTimeout(resolve, 5));
  ui.select('codex-cli');
  assert.ok(!host.querySelector('#providerAddModel'));
  assert.match(host.querySelector('#providerModels').textContent, /Model 1/);
  assert.ok(host.querySelector('#connectionsCodexCheck'));
  assert.ok(!host.textContent.match(/shared|private|kind/i));
});

test('an empty list renders without throwing and offers to add', () => {
  const { host } = mount({});
  assert.match(host.textContent, /还没有供应商/);
  assert.ok(host.querySelector('#providerAdd'));
});

test('the card layout spans the settings grid', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app', 'providers-ui.css'), 'utf8');
  assert.match(css, /\.connections-card\{[^}]*grid-column:1\/-1/);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css.replace(/\/\*.*?\*\//g, '')), 'tokens only');
});

test('detail edits address, format and key in place; changing the address needs the key too', async () => {
  const s = settings();
  const saved = [];
  const { document, host, calls } = mount(s, { saveKey: async payload => { saved.push(payload); } });
  const id = C.apiId(A);
  host.querySelector(`[data-id="${id}"]`).dispatchEvent(new document.defaultView.Event('click', { bubbles: true }));
  const click = node => node.dispatchEvent(new document.defaultView.Event('click', { bubbles: true }));
  const base = host.querySelector('#providerBase'), key = host.querySelector('#providerKey');
  assert.ok(base && key && host.querySelector('#providerProtocol'));
  assert.ok(!/下方/.test(host.textContent), 'no pointer to the old card');
  base.value = 'https://moved.example.invalid/v1';
  click(host.querySelector('#providerConnectionSave'));
  assert.match(host.querySelector('#providerConnectionStatus').textContent, /密钥/);
  assert.equal(saved.length, 0);
  key.value = 'sk-test';
  click(host.querySelector('#providerConnectionSave'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].base, 'https://moved.example.invalid/v1');
  assert.ok(P.items(s).some(item => item.base === 'https://moved.example.invalid/v1'));
  assert.ok(calls.length >= 1);
});

test('a repaint puts the scroll position back (the page does not jump to the top)', () => {
  const { host } = mount(settings());
  const scroller = { scrollTop: 0, scrollLeft: 0, isConnected: true };
  UI.restoreView(host, { scroller, top: 420, left: 3, focus: null });
  assert.equal(scroller.scrollTop, 420);
  assert.equal(scroller.scrollLeft, 3);
  assert.equal(typeof UI.captureView(host).top, 'number');
});

test('account detail shows sign-in or sign-out, never both; a shared account shows a terminal hint instead', async () => {
  const legacy = { signIn() {}, signOut() {}, workspace: () => '', setWorkspace() {}, toolProtocol: () => 'text', setToolProtocol() {} };
  const seen = async snapshot => {
    const { host, ui } = mount(settings(), { legacy, codexSnapshot: async () => snapshot });
    await new Promise(resolve => setTimeout(resolve, 5));
    ui.select('codex-cli');
    return { signIn: !!host.querySelector('#connectionsCodexSignIn'), signOut: !!host.querySelector('#connectionsCodexSignOut'), hint: !!host.querySelector('#providerCodexSharedNote') };
  };
  assert.deepEqual(await seen({ ...codex, mode: 'private', detected: { installed: true, loggedIn: true } }), { signIn: false, signOut: true, hint: false });
  assert.deepEqual(await seen({ ...codex, mode: 'private', detected: { installed: true, loggedIn: false } }), { signIn: true, signOut: false, hint: false });
  assert.deepEqual(await seen(codex), { signIn: false, signOut: false, hint: true });
});

test('the availability test result is shown in the account detail', async () => {
  const { host, ui } = mount(settings(), { codexTest: async () => ({ ok: true, message: '可用：已收到回复' }) });
  await new Promise(resolve => setTimeout(resolve, 5));
  ui.select('codex-cli');
  host.querySelector('#connectionsCodexTest').dispatchEvent(new (host.ownerDocument.defaultView.Event)('click', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(host.querySelector('#providerCodexTestResult').textContent, /可用：已收到回复/);
});

test('the add-model combobox offers fetched models, filters them and adds the chosen one', async () => {
  const s = settings();
  const request = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'a-1' }, { id: 'relay-x' }, { id: 'relay-y' }, { id: 'other' }] }) });
  const { document, host, ui } = mount(s, { credentials: async () => ({ token: 't' }), request });
  ui.select(C.apiId(A));
  const win = document.defaultView;
  assert.equal(host.querySelector('#providerAddModel').getAttribute('role'), 'combobox');
  host.querySelector('#providerFetchModels').dispatchEvent(new win.Event('click', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 30));
  const input = host.querySelector('#providerAddModel');
  input.value = 'relay';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  const options = [...host.querySelectorAll('#providerModelOptions [role="option"]')].map(node => node.getAttribute('data-value'));
  assert.deepEqual(options, ['relay-x', 'relay-y']);
  host.querySelector('#providerModelOptions [role="option"]').dispatchEvent(new win.Event('mousedown', { bubbles: true, cancelable: true }));
  assert.ok(P.get(s, C.apiId(A)).models.some(entry => entry.model === 'relay-x'));
});

test('a chat-only service gets a protocol suggestion that can be applied', async () => {
  const s = settings();
  const request = async (url, headers, signal, init) => {
    if (!init) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'a-1' }] }) };
    return url.endsWith('/chat/completions') ? { status: 400, text: async () => 'model required' } : { status: 503, text: async () => 'No enabled endpoints for this request' };
  };
  const { document, host, ui } = mount(s, { credentials: async () => ({ token: 't' }), request });
  P.setConnection(s, C.apiId(A), { base: A, protocol: 'responses' });
  ui.select(C.apiId(A));
  const win = document.defaultView;
  host.querySelector('#providerTest').dispatchEvent(new win.Event('click', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 40));
  const apply = host.querySelector('#providerApplyProtocol');
  assert.ok(apply, 'suggestion shown');
  apply.dispatchEvent(new win.Event('click', { bubbles: true }));
  assert.equal(P.get(s, C.apiId(A)).protocol, 'chat');
  assert.ok(!host.querySelector('#providerApplyProtocol'));
});

const oauthSnapshot = (extra = {}) => ({ mode: 'oauth', detected: { installed: true, loggedIn: true, needsReauth: false, version: null }, account: { email: 'me@example.invalid', planType: 'plus' }, login: { pending: false }, models: [{ model: 'gpt-x', displayName: 'GPT X' }], ...extra });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('oauth account: shows who is signed in, the 5-hour and weekly windows, and refreshes them on request', async () => {
  const legacy = { signIn() {}, signOut() {}, cancelLogin() {}, workspace: () => '', setWorkspace() {}, toolProtocol: () => 'text', setToolProtocol() {} };
  let usageCalls = 0;
  const codexUsage = async () => { usageCalls++; return { windows: [{ name: 'five_hour', usedPercent: 12.4, resetsAt: 1800000000 }, { name: 'seven_day', usedPercent: 95, resetsAt: null }] }; };
  const { host, ui } = mount(settings(), { legacy, codexSnapshot: async () => oauthSnapshot(), codexUsage });
  await wait(20);
  ui.select('codex-cli');
  assert.equal(usageCalls, 1);
  assert.match(host.querySelector('#providerDetail header').textContent, /已登录 · me@example\.invalid/);
  assert.ok(host.querySelector('#connectionsCodexSignOut')); assert.ok(!host.querySelector('#connectionsCodexSignIn'));
  assert.ok(!host.querySelector('#providerCodexSharedNote')); assert.ok(!host.querySelector('#providerOauthHint'));
  const rows = [...host.querySelectorAll('.pv-quota-row')];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /5 小时/); assert.match(rows[0].textContent, /12%/);
  assert.match(rows[1].textContent, /每周/); assert.match(rows[1].textContent, /95%/);
  assert.equal(rows[1].querySelector('.pv-quota-fill').getAttribute('data-high'), '1');
  assert.equal(rows[1].querySelector('[role=progressbar]').getAttribute('aria-valuenow'), '95');
  host.querySelector('#providerQuotaRefresh').dispatchEvent(new (host.ownerDocument.defaultView.Event)('click', { bubbles: true }));
  await wait(20);
  assert.equal(usageCalls, 2);
});

test('oauth account: signed out, expired and device-code states offer the right buttons', async () => {
  const legacy = { signIn() {}, signOut() {}, cancelLogin() {}, workspace: () => '', setWorkspace() {}, toolProtocol: () => 'text', setToolProtocol() {} };
  const seen = async snapshot => {
    const { host, ui } = mount(settings(), { legacy, codexSnapshot: async () => snapshot, codexUsage: async () => ({ windows: [] }) });
    await wait(10); ui.select('codex-cli');
    return { signIn: host.querySelector('#connectionsCodexSignIn')?.textContent || '', signOut: !!host.querySelector('#connectionsCodexSignOut'), cancel: !!host.querySelector('#connectionsCodexCancel'), code: host.querySelector('#providerDeviceCode')?.textContent || '', quota: !!host.querySelector('#providerQuota') };
  };
  assert.deepEqual(await seen(oauthSnapshot({ detected: { installed: true, loggedIn: false }, account: null })), { signIn: '登录', signOut: false, cancel: false, code: '', quota: false });
  const expired = await seen(oauthSnapshot({ detected: { installed: true, loggedIn: false, needsReauth: true } }));
  assert.equal(expired.signIn, '重新登录'); assert.equal(expired.quota, false);
  const device = await seen(oauthSnapshot({ detected: { installed: true, loggedIn: false }, account: null, login: { pending: true, userCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/codex/device' } }));
  assert.equal(device.signIn, ''); assert.equal(device.cancel, true);
  assert.match(device.code, /1455/); assert.match(device.code, /ABCD-1234/);
});

test('moving between the three sign-in kinds: other kinds offer AI Bro\'s own login, and reusing the local Codex login is an advanced opt-in', async () => {
  const s = settings();
  const legacy = { signIn() {}, signOut() {}, cancelLogin() {}, workspace: () => '', setWorkspace() {}, toolProtocol: () => 'text', setToolProtocol() {} };
  let snapshot = { ...codex }, changed = 0;
  const { host, ui } = mount(s, { legacy, codexSnapshot: async () => snapshot, onLoginChanged: () => { changed++; } });
  await wait(10);
  C.setCodexLogin(s, 'shared'); P.reconcile(s); ui.select('codex-cli');
  assert.ok(host.querySelector('#providerOauthHint'));
  host.querySelector('#providerMore').setAttribute('open', '');
  assert.equal(host.querySelector('#providerReuseCodex').hasAttribute('checked'), true);
  snapshot = oauthSnapshot();
  host.querySelector('#providerUseOauth').dispatchEvent(new (host.ownerDocument.defaultView.Event)('click', { bubbles: true }));
  await wait(30);
  assert.equal(C.codexLogin(s), 'oauth'); assert.equal(P.get(s, 'codex-cli').account.login, 'oauth'); assert.equal(changed, 1);
  assert.ok(!host.querySelector('#providerOauthHint'));
  assert.equal(host.querySelector('#providerReuseCodex').hasAttribute('checked'), false);
  const box = host.querySelector('#providerReuseCodex'); box.checked = true;
  box.dispatchEvent(new (host.ownerDocument.defaultView.Event)('change', { bubbles: true }));
  await wait(30);
  assert.equal(C.codexLogin(s), 'shared'); assert.equal(changed, 2);
});

test('oauth account: the official model list replaces stale stored models (an old preset name leaves, the primary stays valid)', async () => {
  const s = settings();
  P.upsert(s, { kind: 'account', account: { service: 'chatgpt', login: 'oauth' }, models: [{ model: 'gpt-6.1-sol' }, { model: 'gpt-5.6-luna' }] });
  const live = oauthSnapshot({ live: true, models: [{ model: 'gpt-6-luna', displayName: 'GPT-6-Luna' }, { model: 'gpt-5.6-terra' }, { model: 'gpt-5.6-luna' }] });
  mount(s, { codexSnapshot: async () => live, legacy: null });
  await wait(30);
  assert.deepEqual(P.get(s, 'codex-cli').models.map(model => model.model), ['gpt-5.6-luna', 'gpt-6-luna', 'gpt-5.6-terra']);
  const builtin = settings();
  P.upsert(builtin, { kind: 'account', account: { service: 'chatgpt', login: 'oauth' }, models: [{ model: 'keep-me' }] });
  mount(builtin, { codexSnapshot: async () => oauthSnapshot({ live: false }) });
  await wait(30);
  assert.deepEqual(P.get(builtin, 'codex-cli').models.map(model => model.model), ['keep-me']);
});

test('with a roles module the tabs are Text / Embedding / Speech / Usage and switching between role tabs remounts', () => {
  const mounted = [];
  const roles = { mount: (node, which) => { mounted.push(which); node.textContent = which; }, park: () => mounted.push('park'), refresh: () => mounted.push('refresh') };
  const { ui, host } = (() => { const m = mount(settings(), { roles }); return { ui: m.ui, host: m.host }; })();
  assert.deepEqual([...host.querySelectorAll('.uk-seg-item, .pv-tabs button')].map(n => n.textContent), ['文本生成', '嵌入', '语音识别', '使用统计']);
  ui.showTab('embedding'); ui.showTab('transcription');
  assert.deepEqual(mounted.filter(x => x !== 'park' && x !== 'refresh'), ['embedding', 'transcription']);
  assert.equal(host.querySelector('#providerRolesHost').textContent, 'transcription');
  ui.showTab('providers');
  assert.equal(host.querySelector('#providerRolesHost'), null);
});
