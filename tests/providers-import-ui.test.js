const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
globalThis.ModelCatalog = require('../app/model-catalog.js');
const C = globalThis.Connections = require('../app/connections.js');
const P = globalThis.Providers = require('../app/providers.js');
globalThis.ProviderLibrary = require('../app/provider-library.js');
globalThis.ProviderCheck = require('../app/provider-check.js');
globalThis.ProvidersAddUI = require('../app/providers-add-ui.js');
globalThis.ProvidersImportUI = require('../app/providers-import-ui.js');
const UI = require('../app/providers-ui.js');

const KEY_A = 'sk-fixture-aaaaaaaaaaaa1111', KEY_B = 'sk-fixture-bbbbbbbbbbbb2222';
const click = (document, node) => node.dispatchEvent(new document.defaultView.Event('click', { bubbles: true }));
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check) { for (let i = 0; i < 100; i += 1) { if (check()) return; await tick(); } throw new Error('timed out'); }
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });

const PREVIEW = { importId: 'imp-1', expiresIn: 600, items: [
  { index: 0, app: 'codex', name: 'Relay A', host: 'relay-a.example.invalid', base: 'https://relay-a.example.invalid/v1', protocol: 'responses', models: ['a-model'], model: 'a-model', keyLast4: '1111', hasKey: true, status: 'ready', reason: '' },
  { index: 1, app: 'codex', name: 'Seed again', host: 'seed.example.invalid', base: 'https://seed.example.invalid/v1', protocol: 'chat', models: ['seed-2'], model: 'seed-2', keyLast4: '2222', hasKey: true, status: 'ready', reason: '' },
  { index: 2, app: 'claude', name: 'No key', host: 'nokey.example.invalid', base: 'https://nokey.example.invalid', protocol: 'anthropic', models: [], model: '', keyLast4: '', hasKey: false, status: 'no_key', reason: '' },
  { index: 3, app: 'codex', name: 'OpenAI Official', host: '', base: '', protocol: 'auto', models: [], model: '', keyLast4: '', hasKey: false, status: 'skipped', reason: 'account' },
  { index: 4, app: 'gemini', name: 'Gemini One', host: '', base: '', protocol: 'auto', models: [], model: '', keyLast4: '', hasKey: false, status: 'skipped', reason: 'unsupported' }
] };

function setup(defaultReply = { found: false, path: '/home/u/.cc-switch/cc-switch.db' }) {
  const s = {};
  C.migrate(s, { provider: 'api', base: 'https://seed.example.invalid/v1', model: 'seed-1', protocol: 'chat', profiles: [] });
  P.ensure(s);
  const { document } = parseHTML('<html><body><article id="host"></article></body></html>');
  const calls = [], saved = [], changes = [];
  const defaults = [];
  const fetch = async (path, init) => {
    if (path.endsWith('/default')) { defaults.push(init); return reply(200, defaultReply); }
    calls.push({ path, init });
    if (path.endsWith('/preview')) return reply(200, PREVIEW);
    if (path.endsWith('/commit')) {
      const body = JSON.parse(init.body);
      const all = [{ app: 'codex', name: 'Relay A', base: 'https://relay-a.example.invalid/v1', host: 'relay-a.example.invalid', protocol: 'responses', model: 'a-model', models: ['a-model'], token: KEY_A },
        { app: 'codex', name: 'Seed again', base: 'https://seed.example.invalid/v1', host: 'seed.example.invalid', protocol: 'chat', model: 'seed-2', models: ['seed-2'], token: KEY_B },
        { app: 'claude', name: 'No key', base: 'https://nokey.example.invalid', host: 'nokey.example.invalid', protocol: 'anthropic', model: '', models: [], token: '' }];
      return reply(200, { items: body.selected.map(i => ({ ...all[i], token: body.includeKeys ? all[i].token : '' })) });
    }
    return reply(200, { ok: true });
  };
  const ui = UI.create({ getSettings: () => s, onChange: info => { changes.push(info); }, codexSnapshot: async () => null, confirm: () => true, fetch, saveKey: async payload => { saved.push(payload); } });
  ui.mount(document.getElementById('host'));
  return { s, document, ui, calls, defaults, saved, changes, host: document.getElementById('host') };
}
async function toPreview(env, how = 'file') {
  click(env.document, env.host.querySelector('#providerImportCc'));
  assert.equal(env.ui.page(), 'import');
  await until(() => env.host.querySelector('#ccChoose'));
  if (how === 'file') {
    const input = env.host.querySelector('#ccFile'), file = { name: 'cc-switch.db', size: 10 };
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new env.document.defaultView.Event('change', { bubbles: true }));
    await until(() => env.host.querySelector('#ccList'));
    return file;
  }
  env.host.querySelector('#ccLink').value = 'ccswitch://v1/import?resource=provider&app=codex&name=x&endpoint=https://x.example.invalid';
  click(env.document, env.host.querySelector('#ccParseLink'));
  await until(() => env.host.querySelector('#ccList'));
}

test('the import page is reachable from the add page and from More, and its own text is the only place naming the source', () => {
  const env = setup();
  click(env.document, env.host.querySelector('#providerAdd'));
  click(env.document, env.host.querySelector('#providerAddImport'));
  assert.equal(env.ui.page(), 'import');
  assert.match(env.host.querySelector('h2').textContent, /从 CC Switch 导入/);
  const visible = env.host.textContent.replace(/从 CC Switch 导入/g, '').replace(/cc-switch\.db/g, '');
  assert.ok(!/cc.?switch/i.test(visible), visible);
  click(env.document, env.host.querySelector('#ccBack'));
  assert.equal(env.ui.page(), 'list');
});

test('a chosen file is uploaded as-is for server-side read-only parsing; the preview shows only masked keys', async () => {
  const env = setup();
  const file = await toPreview(env);
  assert.equal(env.calls[0].path, '/__providers/ccswitch/preview');
  assert.equal(env.calls[0].init.body, file, 'the picked file itself is the body');
  assert.equal(env.calls[0].init.headers['Content-Type'], 'application/octet-stream');
  const text = env.host.textContent;
  assert.ok(text.includes('••••1111') && text.includes('••••2222'));
  assert.ok(!text.includes(KEY_A) && !text.includes('aaaaaaaaaaaa'));
  const states = [...env.host.querySelectorAll('#ccList .pv-cc-row')].map(row => row.getAttribute('data-state'));
  assert.deepEqual(states, ['new', 'exists', 'no_key', 'skipped', 'skipped']);
  const boxes = [...env.host.querySelectorAll('#ccList input[type="checkbox"]')];
  assert.deepEqual(boxes.map(box => box.hasAttribute('checked')), [true, false, false, false, false], 'existing and key-less rows start unticked');
  assert.ok(!boxes[2].hasAttribute('disabled') && !boxes[2].hasAttribute('checked'), 'key-less rows can be ticked but start unticked');
  assert.ok(boxes[3].hasAttribute('disabled') && boxes[4].hasAttribute('disabled'));
  assert.match(env.host.querySelectorAll('#ccList .pv-cc-row')[2].textContent, /需补密钥/);
  assert.match(env.host.querySelectorAll('#ccList .pv-cc-row')[3].textContent, /请在 AI Bro 里用账号登录添加/);
  assert.match(env.host.textContent, /请在 AI Bro 里用账号登录添加/);
  assert.match(env.host.querySelector('#ccImport').textContent, /导入 1 个供应商/);
});

test('importing stores the key through the host, adds providers last and returns to the list with a summary', async () => {
  const env = setup();
  await toPreview(env);
  click(env.document, env.host.querySelector('#ccImport'));
  await until(() => env.ui.page() === 'list');
  const commit = env.calls.find(call => call.path.endsWith('/commit'));
  assert.deepEqual(JSON.parse(commit.init.body), { importId: 'imp-1', selected: [0], includeKeys: true });
  assert.equal(env.saved.length, 1);
  assert.deepEqual([env.saved[0].name, env.saved[0].base, env.saved[0].protocol, env.saved[0].token], ['Relay A', 'https://relay-a.example.invalid/v1', 'responses', KEY_A]);
  const added = P.get(env.s, C.apiId('https://relay-a.example.invalid/v1'));
  assert.deepEqual(added.models.map(model => model.model), ['a-model']);
  assert.equal(P.items(env.s).at(-1).id, added.id);
  assert.equal(P.items(env.s)[0].id, C.apiId('https://seed.example.invalid/v1'), 'default unchanged');
  assert.ok(!JSON.stringify(env.s).includes(KEY_A));
  assert.ok(!env.host.innerHTML.includes(KEY_A));
  assert.match(env.host.querySelector('#providerNotice').textContent, /已导入 1 个/);
  assert.match(env.host.querySelector('#providerList [aria-current="true"]').textContent, /Relay A/);
});

test('address-only import skips the key; an existing provider only gains models unless "update keys" is ticked', async () => {
  const env = setup();
  await toPreview(env);
  const boxes = [...env.host.querySelectorAll('#ccList input[type="checkbox"]')];
  boxes[0].checked = true; boxes[1].checked = true;
  for (const box of boxes.slice(0, 2)) box.dispatchEvent(new env.document.defaultView.Event('change', { bubbles: true }));
  env.host.querySelector('#ccAddressOnly').checked = true;
  env.host.querySelector('#ccAddressOnly').dispatchEvent(new env.document.defaultView.Event('change', { bubbles: true }));
  click(env.document, env.host.querySelector('#ccImport'));
  await until(() => env.ui.page() === 'list');
  assert.equal(JSON.parse(env.calls.find(call => call.path.endsWith('/commit')).init.body).includeKeys, false);
  assert.ok(env.saved.every(payload => payload.token === ''), 'no key was stored');
  const seed = P.get(env.s, C.apiId('https://seed.example.invalid/v1'));
  assert.deepEqual(seed.models.map(model => model.model), ['seed-1', 'seed-2'], 'models merged, order kept, default unchanged');
});

test('updating keys of existing providers is explicit', async () => {
  const env = setup();
  await toPreview(env);
  const box = env.host.querySelectorAll('#ccList input[type="checkbox"]')[1];
  box.checked = true; box.dispatchEvent(new env.document.defaultView.Event('change', { bubbles: true }));
  env.host.querySelector('#ccUpdateKeys').checked = true;
  env.host.querySelector('#ccUpdateKeys').dispatchEvent(new env.document.defaultView.Event('change', { bubbles: true }));
  click(env.document, env.host.querySelector('#ccImport'));
  await until(() => env.ui.page() === 'list');
  assert.equal(env.saved.length, 2);
  assert.ok(env.saved.some(payload => payload.token === KEY_B && payload.base === 'https://seed.example.invalid/v1'));
});

test('a key that cannot be stored fails only that provider and the rest still import', async () => {
  const env = setup();
  let first = true;
  const bad = UI.create({ getSettings: () => env.s, onChange() {}, codexSnapshot: async () => null, confirm: () => true, fetch: async (path, init) => path.endsWith('/default') ? reply(200, { found: false }) : path.endsWith('/preview') ? reply(200, PREVIEW) : reply(200, { items: [
    { app: 'codex', name: 'Relay A', base: 'https://relay-a.example.invalid/v1', host: 'relay-a.example.invalid', protocol: 'responses', model: 'a-model', models: ['a-model'], token: KEY_A },
    { app: 'claude', name: 'No key', base: 'https://nokey.example.invalid', host: 'nokey.example.invalid', protocol: 'anthropic', model: '', models: [], token: KEY_B }] }),
    saveKey: async () => { if (first) { first = false; throw new Error('钥匙串不可用'); } } });
  const host2 = parseHTML('<html><body><article id="h"></article></body></html>');
  bad.mount(host2.document.getElementById('h'));
  click(host2.document, host2.document.querySelector('#providerImportCc'));
  await until(() => host2.document.querySelector('#ccFile'));
  const input = host2.document.querySelector('#ccFile');
  Object.defineProperty(input, 'files', { value: [{ name: 'x.db' }], configurable: true });
  input.dispatchEvent(new host2.document.defaultView.Event('change', { bubbles: true }));
  await until(() => host2.document.querySelector('#ccList'));
  const boxes = [...host2.document.querySelectorAll('#ccList input[type="checkbox"]')];
  click(host2.document, host2.document.querySelector('#ccImport'));
  await until(() => bad.page() === 'list');
  assert.ok(!P.get(env.s, C.apiId('https://relay-a.example.invalid/v1')));
  assert.ok(P.get(env.s, C.apiId('https://nokey.example.invalid')));
  assert.match(host2.document.querySelector('#providerNotice').textContent, /1 个失败：Relay A/);
});

test('a link is parsed without a file, and cancel tells the server to drop the import', async () => {
  const env = setup();
  await toPreview(env, 'link');
  assert.equal(env.calls[0].init.headers['Content-Type'], 'application/json');
  assert.match(JSON.parse(env.calls[0].init.body).link, /^ccswitch:\/\//);
  click(env.document, env.host.querySelector('#ccCancel'));
  await until(() => env.calls.some(call => call.path.endsWith('/cancel')));
  assert.equal(JSON.parse(env.calls.find(call => call.path.endsWith('/cancel')).init.body).importId, 'imp-1');
  assert.equal(env.ui.page(), 'list');
});

test('a server refusal is shown and the user stays on the first step', async () => {
  const env = setup();
  const failing = UI.create({ getSettings: () => env.s, onChange() {}, codexSnapshot: async () => null, fetch: async path => path.endsWith('/default') ? reply(200, { found: false }) : reply(400, { error: '这不是有效的供应商数据库。' }) });
  const parsed = parseHTML('<html><body><article id="h"></article></body></html>');
  failing.mount(parsed.document.getElementById('h'));
  click(parsed.document, parsed.document.querySelector('#providerImportCc'));
  await until(() => parsed.document.querySelector('#ccFile'));
  const input = parsed.document.querySelector('#ccFile');
  Object.defineProperty(input, 'files', { value: [{ name: 'x.db' }], configurable: true });
  input.dispatchEvent(new parsed.document.defaultView.Event('change', { bubbles: true }));
  await until(() => /这不是有效的供应商数据库/.test(parsed.document.querySelector('#ccStatus').textContent));
  assert.ok(parsed.document.querySelector('#ccChoose'));
});

const DEFAULT_REPLY = () => ({ found: true, path: '/home/u/.cc-switch/cc-switch.db', importId: 'imp-d', expiresIn: 600, items: [
  { index: 0, app: 'claude', name: 'Claude Official', host: '', base: '', protocol: 'auto', models: [], model: '', keyLast4: '', hasKey: false, status: 'skipped', reason: 'no_usable_key', current: true, notes: '' },
  { index: 1, app: 'claude', name: 'Right Code', host: 'rightapi.example.invalid', base: 'https://rightapi.example.invalid', protocol: 'anthropic', models: ['m-1'], model: 'm-1', keyLast4: '3664', hasKey: true, status: 'ready', reason: '', current: false, notes: 'cc desktop' },
  { index: 2, app: 'claude', name: 'pku', host: 'pku.example.invalid', base: 'https://pku.example.invalid', protocol: 'anthropic', models: ['a', 'b', 'c'], model: 'a', keyLast4: '8OnH', hasKey: true, status: 'ready', reason: '', current: false, notes: '' }] });

test('opening the page reads the default database on click and lists it straight away, marking the one in use and the unusable ones', async () => {
  const env = setup(DEFAULT_REPLY());
  assert.equal(env.defaults.length, 0, 'nothing is read before the click');
  click(env.document, env.host.querySelector('#providerImportCc'));
  await until(() => env.host.querySelector('#ccList'));
  assert.equal(env.defaults.length, 1);
  assert.equal(env.calls.length, 0, 'no file upload needed');
  const rows = [...env.host.querySelectorAll('#ccList .pv-cc-row')];
  assert.equal(rows.length, 3);
  assert.match(rows[0].textContent, /CC Switch 当前使用/); assert.match(rows[0].textContent, /不可导入/); assert.match(rows[0].textContent, /Claude 官方账号/);
  assert.match(rows[1].textContent, /Right Code · cc desktop · claude/); assert.match(rows[1].textContent, /••••3664/); assert.match(rows[1].textContent, /1 个模型：m-1/);
  assert.match(rows[2].textContent, /3 个模型：a, b, c/);
  assert.match(env.host.querySelector('#ccDbPath').textContent, /\.cc-switch\/cc-switch\.db/);
  assert.match(env.host.querySelector('#ccImport').textContent, /导入 2 个供应商/);
  assert.ok(env.host.querySelector('#ccChooseOther') && env.host.querySelector('#ccCancel'));
});

test('a missing default database falls back to choosing a file and says where it looked', async () => {
  const env = setup();
  click(env.document, env.host.querySelector('#providerImportCc'));
  await until(() => env.host.querySelector('#ccChoose'));
  assert.match(env.host.querySelector('#ccStatus').textContent, /没有在默认位置找到数据库/);
});

test('choosing another database file from the list replaces it and drops the first import', async () => {
  const env = setup(DEFAULT_REPLY());
  click(env.document, env.host.querySelector('#providerImportCc'));
  await until(() => env.host.querySelector('#ccList'));
  const input = env.host.querySelector('#ccFile');
  Object.defineProperty(input, 'files', { value: [{ name: 'other.db', size: 10 }], configurable: true });
  input.dispatchEvent(new env.document.defaultView.Event('change', { bubbles: true }));
  await until(() => /Relay A/.test(env.host.textContent));
  assert.match(env.host.querySelector('#ccDbPath').textContent, /other\.db/);
  assert.equal(JSON.parse(env.calls.find(call => call.path.endsWith('/cancel')).init.body).importId, 'imp-d');
});

test('a provider imported without a key is marked, kept out of default and purpose pickers, and cleared once a key is added', async () => {
  const env = setup();
  await toPreview(env);
  const boxes = [...env.host.querySelectorAll('#ccList input[type="checkbox"]')];
  boxes[2].checked = true; boxes[2].dispatchEvent(new env.document.defaultView.Event('change', { bubbles: true }));
  click(env.document, env.host.querySelector('#ccImport'));
  await until(() => env.ui.page() === 'list');
  const id = C.apiId('https://nokey.example.invalid');
  assert.equal(P.get(env.s, id).needsKey, true);
  assert.equal(P.defaultSelection(env.s).provider, C.apiId('https://seed.example.invalid/v1'));
  assert.match(env.host.querySelector('#providerList').textContent, /待补密钥/);
  P.makeDefault(env.s, id);
  assert.notEqual(P.defaultSelection(env.s).provider, id, 'a key-less provider is never the default');
  P.setNeedsKey(env.s, id, false);
  assert.equal(P.get(env.s, id).needsKey, undefined);
});
