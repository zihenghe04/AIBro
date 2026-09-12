const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Core = require('../workstation-core');
const app = fs.readFileSync(require.resolve('../app'), 'utf8');
const start = app.indexOf('function apiOrigin('), end = app.indexOf('\nlet toastTimer', start);
assert.ok(start > 0 && end > start);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const TOKEN = 'synthetic-ui-review-token';
function harness(options = {}) {
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', hidden: false, disabled: false, placeholder: '', classList: { add() {}, remove() {} }, addEventListener() {} });
    return nodes.get(id);
  };
  const storage = options.storage || new Map(), persisted = options.persisted || { base: '', token: '', model: '' }, calls = [], snapshots = [];
  const status = () => ({ available: null, hasKey: !!persisted.token, base: '', model: '', verified: false, requiresUnlock: !!persisted.token });
  const bridge = {
    status: async () => { calls.push(['status']); return options.status ? options.status() : status(); },
    read: async value => { calls.push(['read', value.base]); return options.read ? options.read(value) : { ...persisted }; },
    save: async value => { calls.push(['save']); if (options.save) await options.save(value); Object.assign(persisted, value, { token: value.token || persisted.token }); return {available:true,hasKey:true,base:persisted.base,model:persisted.model,verified:true,requiresUnlock:false}; },
    remove: async () => { calls.push(['remove']); Object.assign(persisted, { base: '', token: '', model: '' }); return status(); },
  };
  const state = { tasks: [], notes: [], projects: [], settings: { permissions: {} } };
  const window = { workstationDesktop: { apiCredentials: bridge }, OpenAIAuth: { provider: () => 'api', persist() {}, render() {} }, confirm: () => options.confirm !== false };
  const c = vm.createContext({ $, $$: () => [], window, Core, URL, AbortController,
    apiSettingsDirty: false, apiCredentialReady: null, apiCredentialState: null, apiCredentialError: '', apiCredentialVersion: 0, settingsHydrated: false,
    state, localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    save: () => snapshots.push(JSON.stringify(state)), syncComposerModel() {},
    setTimeout: () => 1, clearTimeout() {}, fetch: async (url, init) => { calls.push(['fetch', url, init]); return new Response(JSON.stringify({ data: [{ id: 'fixture-model' }] }), { headers: { 'content-type': 'application/json' } }); },
  });
  vm.runInContext(app.slice(start, end), c);
  return { c, $, storage, persisted, calls, snapshots, state };
}

test('testing an unsaved key is explicit and never persists it or creates workspace entities', async () => {
  const h = harness(); h.$('#apiBase').value = 'https://gateway.example.invalid/v1'; h.$('#model').value = 'fixture-model'; h.$('#apiKey').value = TOKEN; h.c.apiSettingsDirty = true;
  await h.c.testConnection();
  assert.match(h.$('#apiStatus').textContent, /未保存|临时/);
  assert.equal(h.calls.some(call => call[0] === 'save'), false);
  assert.equal(h.persisted.token, '');
  assert.equal(h.storage.has('workstation-api-key'), false);
  assert.equal(h.state.tasks.length + h.state.notes.length + h.state.projects.length, 0);
});

test('save then a fresh renderer restores metadata and obtains a key only through secure read', async () => {
  const h = harness(); h.$('#apiBase').value = 'https://gateway.example.invalid/v1'; h.$('#model').value = 'fixture-model'; h.$('#apiKey').value = TOKEN; h.c.apiSettingsDirty = true;
  assert.equal(await h.c.saveApiSettings(), true);
  assert.equal(h.$('#apiKey').value, '');
  assert.equal(h.storage.has('workstation-api-key'), false);
  assert.equal(h.snapshots.some(snapshot => snapshot.includes(TOKEN)), false);
  const fresh = harness({ persisted: h.persisted, storage: h.storage });
  const connection = await fresh.c.getApiConnection();
  assert.equal(connection.base, h.persisted.base);
  assert.equal(connection.token, TOKEN);
  assert.equal(fresh.$('#apiKey').value, '', 'Restored secret is never repopulated into the input');
  assert.equal(fresh.$('#model').value, 'fixture-model');
  assert.equal(fresh.storage.has('workstation-api-key'), false);
});

test('late secure read after explicit clear cannot resurrect a key in the active renderer', async () => {
  const late = deferred();
  const h = harness({ persisted: { base: 'https://gateway.example.invalid/v1', model: 'fixture', token: TOKEN }, storage: new Map([['workstation-api-base','https://gateway.example.invalid/v1']]), read: () => late.promise });
  await h.c.ensureApiCredentials();
  const connection = h.c.getApiConnection(); await tick();
  assert.equal(h.calls.some(call => call[0] === 'read'), true);
  assert.equal(await h.c.clearApiCredentials(), true);
  late.resolve({ base: 'https://gateway.example.invalid/v1', model: 'fixture', token: TOKEN });
  await assert.rejects(connection, error => error.code === 'CANCELLED');
  assert.equal(h.c.apiCredentialState.hasKey, false);
  assert.equal((await h.c.getApiConnection()).token, '');
  assert.equal(h.$('#apiKey').value, '');
});

test('temporary file-status failure can retry without restarting or probing encryption', async () => {
  let attempts = 0;
  const h = harness({ status: async () => { if (++attempts === 1) throw Error('文件状态暂不可用'); return { available: null, hasKey: false, base: '', model: '', verified:false }; } });
  await assert.rejects(h.c.ensureApiCredentials(), /文件状态暂不可用/);
  assert.equal((await h.c.ensureApiCredentials()).available, null);
  assert.equal(attempts, 2);
  assert.equal(h.calls.some(call=>call[0]==='read'||call[0]==='save'),false);
});

test('a denied keychain read can retry after user authorization without discarding the saved credential', async () => {
  let attempts=0;
  const persisted={base:'https://gateway.example.invalid/v1',model:'fixture',token:TOKEN};
  const h=harness({persisted,storage:new Map([['workstation-api-base',persisted.base]]),read:()=>{if(++attempts===1)throw Error('系统安全存储当前不可用');return {...persisted};}});
  await assert.rejects(h.c.getApiConnection(),/系统安全存储当前不可用/);
  assert.equal(h.c.apiCredentialState.verified,false);
  assert.equal(h.persisted.token,TOKEN);
  assert.equal((await h.c.getApiConnection()).token,TOKEN);
  assert.equal(h.c.apiCredentialState.verified,true);
});

test('an in-flight settings save cannot clear a newer key or leak it into workspace snapshots', async () => {
  const saving = deferred();
  const h = harness({ save: () => saving.promise });
  h.$('#apiBase').value = 'https://gateway.example.invalid/v1'; h.$('#model').value = 'fixture-model'; h.$('#apiKey').value = TOKEN; h.c.apiSettingsDirty = true;
  const done = h.c.saveApiSettings(); await tick();
  h.$('#apiKey').value = 'synthetic-new-draft-token';
  saving.resolve(); assert.equal(await done, true);
  assert.equal(h.persisted.token, TOKEN);
  assert.equal(h.$('#apiKey').value, 'synthetic-new-draft-token');
  assert.equal(h.c.apiSettingsDirty, true);
  assert.equal(h.snapshots.some(snapshot => /synthetic-.*token/.test(snapshot)), false);
});
