const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { parseHTML } = require('linkedom');
globalThis.ModelCatalog = require('../app/model-catalog.js');
const C = globalThis.Connections = require('../app/connections.js');
const P = globalThis.Providers = require('../app/providers.js');
globalThis.ProviderLibrary = require('../app/provider-library.js');
globalThis.ProviderCheck = require('../app/provider-check.js');
globalThis.ProvidersAddUI = require('../app/providers-add-ui.js');
const UI = require('../app/providers-ui.js');

const click = (document, node) => node.dispatchEvent(new document.defaultView.Event('click', { bubbles: true }));
const type = (document, node, value, event = 'input') => { node.value = value; node.dispatchEvent(new document.defaultView.Event(event, { bubbles: true })); };
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check) { for (let i = 0; i < 100; i += 1) { if (check()) return; await tick(); } throw new Error('timed out'); }

function fakeProvider(handler) {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push({ method: req.method, url: req.url, auth: req.headers.authorization }); handler(req, res); });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ seen, port: server.address().port, close: () => new Promise(done => server.close(done)) })));
}
function setup(extra = {}) {
  const s = {};
  C.migrate(s, { provider: 'api', base: 'https://seed.example.invalid/v1', model: 'seed-1', protocol: 'chat', profiles: [] });
  P.ensure(s);
  const { document } = parseHTML('<html><body><article id="host"></article></body></html>');
  const saved = [], changes = [];
  const ui = UI.create({ getSettings: () => s, onChange: info => { changes.push(info); }, codexSnapshot: async () => null, confirm: () => true,
    saveKey: async payload => { saved.push(payload); }, request: (url, headers, signal) => fetch(url, { headers, signal }), credentials: async () => ({ token: 'stored-token' }), ...extra });
  ui.mount(document.getElementById('host'));
  return { s, document, ui, saved, changes, host: document.getElementById('host') };
}

test('add page: tiles, categories and search; custom comes first and nothing is promoted', () => {
  const { document, host, ui } = setup();
  click(document, host.querySelector('#providerAdd'));
  assert.equal(ui.page(), 'add');
  assert.deepEqual([...host.querySelectorAll('.pa-wide')].map(node => node.getAttribute('id')), ['providerAddImport', 'providerAddCustom']);
  assert.match(host.querySelector('#providerAddImport').textContent, /从 CC Switch 导入/);
  assert.ok(host.querySelector('[data-account="chatgpt"]'));
  assert.ok(host.querySelectorAll('[data-preset]').length >= 90);
  type(document, host.querySelector('#providerAddSearch'), 'kimi');
  const tiles = [...host.querySelectorAll('[data-preset]')];
  assert.equal(tiles.length, 1);
  assert.match(tiles[0].textContent, /个版本/);
  type(document, host.querySelector('#providerAddSearch'), 'no-such-vendor-xyz');
  assert.match(host.textContent, /没有匹配的供应商/);
  click(document, host.querySelector('#providerAddBack'));
  assert.equal(ui.page(), 'list');
});

test('a preset only needs the key; save stores the key through the host, adds the provider last and tests the connection', async () => {
  const fx = await fakeProvider((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'live-1' }, { id: 'live-2' }] })); });
  try {
    const { s, document, host, saved, changes } = setup();
    click(document, host.querySelector('#providerAdd'));
    click(document, host.querySelector('#providerAddCustom'));
    assert.ok(!/null/.test(host.textContent), 'the form never prints a stray null');
    type(document, host.querySelector('#providerFormBase'), `http://127.0.0.1:${fx.port}/v1/chat/completions`, 'change');
    assert.equal(host.querySelector('#providerFormBase').value, `http://127.0.0.1:${fx.port}/v1`);
    assert.match(host.querySelector('#providerFormHint').textContent, /已整理为.*Chat Completions/);
    assert.equal(host.querySelector('#providerFormName').value, '本地服务');
    type(document, host.querySelector('#providerFormName'), 'Local fake');
    type(document, host.querySelector('#providerFormAddModel'), 'fake-model');
    click(document, host.querySelector('#providerFormAddModelButton'));
    type(document, host.querySelector('#providerFormKey'), 'sk-test-key-123');
    click(document, host.querySelector('#providerFormSave'));
    await until(() => document.getElementById('providerDetail'));
    assert.equal(saved.length, 1);
    assert.deepEqual([saved[0].name, saved[0].base, saved[0].protocol, saved[0].model, saved[0].token], ['Local fake', `http://127.0.0.1:${fx.port}/v1`, 'chat', 'fake-model', 'sk-test-key-123']);
    const items = P.items(s);
    assert.equal(items.at(-1).name, 'Local fake');
    assert.equal(items[0].id, C.apiId('https://seed.example.invalid/v1'), 'the default is unchanged');
    assert.equal(items.at(-1).check.state, 'ok');
    assert.equal(fx.seen.length, 1);
    assert.deepEqual([fx.seen[0].method, fx.seen[0].url, fx.seen[0].auth], ['GET', '/v1/models', 'Bearer sk-test-key-123']);
    assert.ok(!JSON.stringify(s).includes('sk-test-key-123'), 'the key is not in settings');
    assert.ok(!host.innerHTML.includes('sk-test-key-123'), 'the key is not in the page');
    assert.equal(host.querySelector('#providerFormKey'), null);
    assert.deepEqual(changes.at(-1), { defaultChanged: false });
    assert.match(host.querySelector('#providerList [aria-current="true"]').textContent, /Local fake/);
  } finally { await fx.close(); }
});

test('"make default" on save changes the default and reports it', async () => {
  const fx = await fakeProvider((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [] })); });
  try {
    const { s, document, host, changes } = setup();
    click(document, host.querySelector('#providerAdd'));
    click(document, host.querySelector('#providerAddCustom'));
    type(document, host.querySelector('#providerFormBase'), `http://127.0.0.1:${fx.port}/v1`, 'change');
    type(document, host.querySelector('#providerFormAddModel'), 'm-x'); click(document, host.querySelector('#providerFormAddModelButton'));
    type(document, host.querySelector('#providerFormKey'), 'k');
    host.querySelector('#providerFormDefault').checked = true;
    host.querySelector('#providerFormDefault').dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
    click(document, host.querySelector('#providerFormSave'));
    await until(() => document.getElementById('providerDetail'));
    assert.equal(P.items(s)[0].models[0].model, 'm-x');
    assert.deepEqual(changes.at(-1), { defaultChanged: true });
    assert.equal(s.modelRoles.qa.model, 'm-x');
  } finally { await fx.close(); }
});

test('a preset form is prefilled; family versions switch in place; missing key is refused before any request', async () => {
  const { document, host, saved } = setup();
  click(document, host.querySelector('#providerAdd'));
  type(document, host.querySelector('#providerAddSearch'), 'kimi');
  click(document, host.querySelector('[data-preset]'));
  assert.match(host.querySelector('#providerFormBase').value, /^https:\/\//);
  assert.ok(host.querySelectorAll('#providerFormModels .pv-model').length >= 1);
  const versions = [...host.querySelectorAll('[data-version]')];
  assert.ok(versions.length >= 2);
  const before = host.querySelector('#providerFormBase').value;
  click(document, versions.find(node => node.getAttribute('aria-pressed') !== 'true'));
  assert.notEqual(host.querySelector('#providerFormBase').value, before);
  click(document, host.querySelector('#providerFormSave'));
  assert.match(host.querySelector('#providerFormStatus').textContent, /请填写 API 密钥/);
  assert.equal(saved.length, 0);
});

test('a host that fails to store the key keeps the form and adds nothing', async () => {
  const { s, document, host } = setup({ saveKey: async () => { throw new Error('系统钥匙串不可用'); } });
  click(document, host.querySelector('#providerAdd'));
  click(document, host.querySelector('#providerAddCustom'));
  type(document, host.querySelector('#providerFormBase'), 'https://relay.example.invalid/v1', 'change');
  type(document, host.querySelector('#providerFormKey'), 'k');
  const count = P.items(s).length;
  click(document, host.querySelector('#providerFormSave'));
  await until(() => /钥匙串不可用/.test(host.querySelector('#providerFormStatus').textContent));
  assert.equal(P.items(s).length, count);
  assert.ok(host.querySelector('#providerFormSave') && !host.querySelector('#providerFormSave').hasAttribute('disabled'));
});

test('detail: test connection and model fetching use the stored key; capability tags toggle and persist', async () => {
  const fx = await fakeProvider((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'fetched-a' }, { id: 'fetched-b' }] })); });
  try {
    const { s, document, host, ui } = setup();
    P.upsert(s, { kind: 'api', name: 'Fake', base: `http://127.0.0.1:${fx.port}/v1`, protocol: 'chat', models: [{ model: 'f-1' }] });
    P.project(s);
    ui.select(C.apiId(`http://127.0.0.1:${fx.port}/v1`));
    assert.match(host.querySelector('#providerDetail').textContent, /未验证/);
    click(document, host.querySelector('#providerTest'));
    await until(() => /已读取模型列表/.test(document.getElementById('providerCheckStatus').textContent));
    assert.equal(fx.seen[0].auth, 'Bearer stored-token');
    assert.match(host.querySelector('#providerDetail').textContent, /已验证/);
    host.querySelector('#providerAddModel').dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
    assert.equal([...host.querySelectorAll('#providerModelOptions [role="option"]')].length, 2);
    const cap = host.querySelector('#providerModels [data-cap="vision"]');
    assert.equal(cap.getAttribute('aria-pressed'), 'false');
    click(document, cap);
    assert.equal(P.get(s, C.apiId(`http://127.0.0.1:${fx.port}/v1`)).models[0].caps.vision, true);
    assert.equal(host.querySelector('#providerModels [data-cap="vision"]').getAttribute('aria-pressed'), 'true');
  } finally { await fx.close(); }
});

test('adding the ChatGPT account from the tiles puts the account provider in the list', () => {
  const { s, document, host, ui } = setup();
  assert.ok(P.get(s, 'codex-cli'));
  P.remove(s, 'codex-cli'); P.project(s);
  assert.ok(!P.get(s, 'codex-cli'));
  ui.refresh();
  assert.ok(!P.get(s, 'codex-cli'), 'a removed account is not added back by the old list');
  click(document, host.querySelector('#providerAdd'));
  click(document, host.querySelector('[data-account="chatgpt"]'));
  assert.ok(P.get(s, 'codex-cli'));
  assert.ok(C.get(s, 'codex-cli'));
});

test('balance: only providers with a published endpoint get a refresh button, and nothing is requested until it is pressed', async () => {
  globalThis.ProviderBalance = require('../app/provider-balance.js');
  const requests = [];
  const { s, document, host, ui } = setup({ request: async (url, headers) => { requests.push({ url, auth: headers.Authorization }); return { ok: true, status: 200, json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: '0.00' }] }) }; } });
  P.upsert(s, { kind: 'api', name: 'DS', base: 'https://api.deepseek.com', protocol: 'chat', models: [{ model: 'deepseek-chat' }] });
  P.upsert(s, { kind: 'api', name: 'Other', base: 'https://relay.example.invalid/v1', protocol: 'chat', models: [{ model: 'x' }] });
  P.project(s);
  ui.select(C.apiId('https://relay.example.invalid/v1'));
  assert.equal(host.querySelector('#providerBalance'), null);
  ui.select(C.apiId('https://api.deepseek.com'));
  assert.ok(host.querySelector('#providerBalance'));
  assert.equal(requests.length, 0);
  click(document, host.querySelector('#providerBalanceRefresh'));
  await until(() => /¥0\.00/.test(host.querySelector('#providerBalanceValue').textContent));
  assert.deepEqual(requests, [{ url: 'https://api.deepseek.com/user/balance', auth: 'Bearer stored-token' }]);
  assert.match(host.querySelector('#providerList').textContent, /余额用尽/);
  delete globalThis.ProviderBalance;
});
