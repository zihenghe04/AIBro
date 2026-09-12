const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const start = source.indexOf('function apiOrigin('), end = source.indexOf('let toastTimer', start);
const helpers = source.slice(start, end);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture({ native, values = {}, storage = {}, fetch } = {}) {
  const nodes = new Map(), saved = [], requests = [], timers = [], data = new Map(Object.entries(native ? { 'workstation-api-base': 'https://one.invalid/v1', 'workstation-api-model': 'saved-model', ...storage } : storage));
  function element(id = '') {
    const handlers = new Map();
    return { id, value: '', textContent: '', placeholder: '', disabled: false, hidden: false, dataset: {}, className: '',
      setAttribute() {}, addEventListener(type, fn) { handlers.set(type, fn); },
      insertAdjacentElement(_where, child) { nodes.set('#' + child.id, child); },
      fire(type = 'input') { handlers.get(type)?.({ target: this }); }
    };
  }
  for (const id of ['apiBase', 'apiKey', 'model', 'apiStatus', 'saveSettings', 'testApi']) nodes.set('#' + id, element(id));
  for (const [key, value] of Object.entries(values)) nodes.get('#' + key).value = value;
  const permissions = [element('permission')]; permissions[0].dataset.permission = '科研'; permissions[0].value = 'approval';
  const state = { settings: { permissions: { 科研: 'approval' } } };
  const context = vm.createContext({ state, URL, Promise, AbortController,
    window: { ...(native ? { workstationDesktop: { apiCredentials: native } } : {}), confirm: () => true },
    document: { createElement: () => element() }, $: selector => nodes.get(selector) || null, $$: () => permissions,
    localStorage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) },
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {}, Core: { endpoint: base => base.replace(/\/$/, '') + '/models' },
    save: () => saved.push(JSON.stringify(state)), syncComposerModel() {},
    fetch: async (...args) => { requests.push(args); return fetch ? fetch(...args) : { ok: true, status: 200, json: async () => ({ data: [{ id: 'fixture-model' }] }) }; }
  });
  vm.runInContext('let apiSettingsDirty=false,apiCredentialReady=null,apiCredentialState=null,apiCredentialError="",apiCredentialVersion=0,settingsHydrated=false;\n' + helpers, context);
  context.installApiCredentialControls();
  return { context, state, nodes, saved, requests, data, permissions, node: id => nodes.get('#' + id), edit(id, value) { const node = nodes.get('#' + id); node.value = value; node.fire(); } };
}
function nativeStore(initial = {}) {
  let stored = { available: true, hasKey: true, base: 'https://one.invalid/v1', model: 'saved-model', token: 'fixture-old', ...initial };
  const calls = [];
  const publicStatus = () => { const { token, ...status } = stored; return { ...status, verified: true, requiresUnlock: false }; };
  return { calls, get stored() { return stored; }, api: {
    async status() { calls.push('status'); return { available: null, hasKey: stored.hasKey, base: '', model: '', requiresUnlock: stored.hasKey, verified: false }; },
    async read({ base }) { calls.push('read'); assert.equal(new URL(base).origin, new URL(stored.base).origin); return { token: stored.token, base: stored.base, model: stored.model }; },
    async save({ base, token, model }) { calls.push('save'); if (!token && (!stored.hasKey || new URL(base).origin !== new URL(stored.base).origin)) throw Error('缺少此地址 Key'); stored = { available: true, hasKey: true, base, model, token: token || stored.token }; return publicStatus(); },
    async remove() { calls.push('remove'); stored = { available: true, hasKey: false, base: '', model: '', token: '' }; return publicStatus(); }
  } };
}

test('desktop restart restores public configuration and reads the saved key only for matching origin, without plaintext state or input', async () => {
  const secure = nativeStore(), h = fixture({ native: secure.api });
  const pending = h.context.getApiConnection();
  const credentials = await pending;
  assert.equal(credentials.base, 'https://one.invalid/v1'); assert.equal(credentials.token, 'fixture-old');
  assert.equal(h.node('apiBase').value, 'https://one.invalid/v1'); assert.equal(h.node('model').value, 'saved-model'); assert.equal(h.node('apiKey').value, '');
  assert.equal(h.data.get('workstation-api-key'), undefined); assert.ok(!JSON.stringify(h.state).includes('fixture-old')); assert.match(h.node('apiCredentialStatus').textContent, /已加密保存在此 Mac/);
  assert.deepEqual(secure.calls, ['status', 'read']);
});

test('saving blank native key preserves it, while a failed cross-origin save retains prior persisted configuration and new input', async () => {
  const secure = nativeStore(), h = fixture({ native: secure.api }); await h.context.ensureApiCredentials();
  h.edit('model', 'new-model'); assert.equal(await h.context.saveApiSettings(), true); assert.equal(secure.stored.token, 'fixture-old'); assert.equal(secure.stored.model, 'new-model');
  h.edit('apiBase', 'https://two.invalid/v1'); assert.equal(await h.context.saveApiSettings(), false);
  assert.equal(h.data.get('workstation-api-base'), 'https://one.invalid/v1'); assert.equal(h.node('apiBase').value, 'https://two.invalid/v1'); assert.equal(secure.stored.base, 'https://one.invalid/v1'); assert.match(h.node('apiStatus').textContent, /保存失败/);
  const result = await h.context.getApiConnection(); assert.equal(result.token, ''); assert.ok(!secure.calls.includes('read'));
});

test('temporary input can test successfully but never persists without save, then native save clears only the saved input', async () => {
  const secure = nativeStore(), h = fixture({ native: secure.api }); await h.context.ensureApiCredentials(); h.edit('apiKey', 'fixture-new');
  await h.context.testConnection(); assert.match(h.node('apiStatus').textContent, /未保存/); assert.equal(h.requests[0][1].headers.Authorization, 'Bearer fixture-new'); assert.equal(secure.stored.token, 'fixture-old');
  assert.equal(await h.context.saveApiSettings(), true); assert.equal(secure.stored.token, 'fixture-new'); assert.equal(h.node('apiKey').value, ''); assert.equal(h.data.get('workstation-api-key'), undefined); assert.match(h.node('apiStatus').textContent, /已保存到此 Mac/);
});

test('a newer input typed during asynchronous save is retained and remains explicitly unsaved', async () => {
  const secure = nativeStore(), saving = deferred(), originalSave = secure.api.save;
  const h = fixture({ native: secure.api }); await h.context.ensureApiCredentials();
  secure.api.save = async value => { await saving.promise; return originalSave(value); };
  h.edit('apiKey', 'fixture-new'); const pending = h.context.saveApiSettings(); await Promise.resolve(); await Promise.resolve();
  h.edit('apiKey', 'fixture-newer'); h.edit('apiBase', 'https://two.invalid/v1'); saving.resolve(); await pending;
  assert.equal(secure.stored.token, 'fixture-new'); assert.equal(h.node('apiKey').value, 'fixture-newer'); assert.equal(h.node('apiBase').value, 'https://two.invalid/v1'); assert.match(h.node('apiCredentialStatus').textContent, /尚未保存/);
  h.context.renderSettings(); assert.equal(h.node('apiKey').value, 'fixture-newer'); assert.equal(h.node('apiBase').value, 'https://two.invalid/v1');
});

test('failed encrypted persistence never reports saved or discards the user key', async () => {
  const secure = nativeStore(), h = fixture({ native: secure.api }); await h.context.ensureApiCredentials(); secure.api.save = async () => { throw Error('fixture disk error'); };
  h.edit('apiKey', 'fixture-new'); h.edit('model', 'new-model'); assert.equal(await h.context.saveApiSettings(), false);
  assert.equal(h.node('apiKey').value, 'fixture-new'); assert.equal(h.data.get('workstation-api-model'), 'saved-model'); assert.equal(h.saved.length, 0); assert.match(h.node('apiStatus').textContent, /保存失败/); assert.equal(h.node('saveSettings').disabled, false);
});

test('late startup status cannot override credentials typed during restore', async () => {
  const pending = deferred(), secure = nativeStore(); secure.api.status = () => pending.promise;
  const h = fixture({ native: secure.api }); const reading = h.context.ensureApiCredentials(); h.edit('apiBase', 'https://typed.invalid/v1'); h.edit('apiKey', 'fixture-typed');
  pending.resolve({ available: true, hasKey: true, base: 'https://saved.invalid/v1', model: 'saved' }); await reading;
  assert.equal(h.node('apiBase').value, 'https://typed.invalid/v1'); assert.equal(h.node('apiKey').value, 'fixture-typed'); h.context.renderSettings(); assert.equal(h.node('apiKey').value, 'fixture-typed');
});

test('clear invalidates a pending credential read and does not resurrect the secret', async () => {
  const pending = deferred(), started = deferred(), secure = nativeStore(), h = fixture({ native: secure.api }); await h.context.ensureApiCredentials();
  secure.api.read = () => { started.resolve(); return pending.promise; }; const reading = h.context.getApiConnection(); await started.promise;
  assert.equal(await h.context.clearApiCredentials(), true); pending.resolve({ token: 'fixture-old', base: 'https://one.invalid/v1' });
  await assert.rejects(reading, error => error.code === 'CANCELLED'); assert.equal((await h.context.getApiConnection()).token, ''); assert.equal(h.node('apiKey').value, ''); assert.equal(h.data.get('workstation-api-key'), undefined);
});

test('legacy key migrates only from local browser storage and is removed only after durable encrypted save', async () => {
  const secure = nativeStore({ hasKey: false, base: '', token: '' }), pending = deferred(), originalSave = secure.api.save;
  secure.api.save = async value => { await pending.promise; return originalSave(value); };
  const h = fixture({ native: secure.api, storage: { 'workstation-api-base': 'https://one.invalid/v1', 'workstation-api-key': 'fixture-legacy', 'workstation-api-model': 'fixture-model' } });
  await h.context.ensureApiCredentials(); assert.deepEqual(secure.calls, ['status']);
  const saving = h.context.getApiConnection(); await Promise.resolve(); assert.equal(h.data.get('workstation-api-key'), 'fixture-legacy');
  pending.resolve(); await saving; assert.equal(h.data.get('workstation-api-key'), undefined); assert.equal(secure.stored.token, 'fixture-legacy');
  assert.doesNotMatch(source, /if \(remote\._apiKey\) localStorage\.setItem/);
});

test('clear waits for an already issued migration write before deleting it', async () => {
  const secure = nativeStore({ hasKey: false, base: '', token: '' }), pending = deferred(), originalSave = secure.api.save;
  secure.api.save = async value => { await pending.promise; return originalSave(value); };
  const h = fixture({ native: secure.api, storage: { 'workstation-api-base': 'https://one.invalid/v1', 'workstation-api-key': 'fixture-legacy' } });
  await h.context.ensureApiCredentials(); const started = deferred(); const migrate = secure.api.save; secure.api.save = value => { started.resolve(); return migrate(value); };
  const restoring = h.context.getApiConnection(); await started.promise; const removing = h.context.clearApiCredentials(); pending.resolve(); await assert.rejects(restoring, error => error.code === 'CANCELLED'); await removing;
  assert.equal(secure.stored.hasKey, false); assert.equal((await h.context.getApiConnection()).token, ''); assert.equal(h.data.get('workstation-api-key'), undefined);
});

test('a temporarily unavailable native store can be retried and never falls back to a saved plaintext key', async () => {
  const secure = nativeStore(), h = fixture({ native: secure.api, values: { apiBase: 'https://one.invalid/v1' }, storage: { 'workstation-api-key': 'fixture-legacy' } });
  let available = false; const originalRead = secure.api.read; secure.api.read = value => available ? originalRead(value) : Promise.reject(Error('加密存储暂不可用'));
  await h.context.ensureApiCredentials(); assert.deepEqual(secure.calls, ['status']);
  await assert.rejects(h.context.getApiConnection(), /加密存储暂不可用/); assert.equal(h.data.get('workstation-api-key'), 'fixture-legacy'); available = true; assert.equal((await h.context.getApiConnection()).token, 'fixture-old');
});

test('browser blank save retains current-origin key, and changing origin never leaks it to a model or test', async () => {
  const h = fixture({ storage: { 'workstation-api-base': 'https://one.invalid/v1', 'workstation-api-key': 'fixture-browser', 'workstation-api-model': 'fixture-model' } }); h.context.renderSettings();
  assert.equal(await h.context.saveApiSettings(), true); assert.equal(h.data.get('workstation-api-key'), 'fixture-browser'); assert.equal(h.node('apiKey').value, ''); assert.match(h.node('apiCredentialStatus').textContent, /当前浏览器/);
  h.edit('apiBase', 'https://two.invalid/v1'); assert.equal((await h.context.getApiConnection()).token, ''); await h.context.testConnection(); assert.equal(h.requests.length, 0); assert.equal(await h.context.saveApiSettings(), false);
});

test('test connection freezes address and key across native reads and labels temporary settings without saving them', async () => {
  const secure = nativeStore(), h = fixture({ native: secure.api }); await h.context.ensureApiCredentials(); const pending = deferred(); secure.api.read = () => pending.promise;
  const testing = h.context.testConnection(); await Promise.resolve(); await Promise.resolve(); h.edit('apiBase', 'https://two.invalid/v1');
  pending.resolve({ token: 'fixture-old', base: 'https://one.invalid/v1' }); await testing;
  assert.match(decodeURIComponent(h.requests[0][0]), /https:\/\/one\.invalid\/v1\/models/); assert.doesNotMatch(decodeURIComponent(h.requests[0][0]), /two\.invalid/);
  assert.equal(h.requests[0][1].headers.Authorization, 'Bearer fixture-old'); assert.equal(secure.calls.filter(x => x === 'save').length, 0);
});

test('startup renders unverified encrypted status without reading or migrating, even when a legacy key exists',async()=>{
 for(const hasKey of [true,false]){
  const secure=nativeStore({hasKey}),h=fixture({native:secure.api,storage:{'workstation-api-key':'fixture-legacy'}});
  h.context.renderSettings();await h.context.ensureApiCredentials();h.context.renderSettings();await h.context.ensureApiCredentials();
  assert.deepEqual(secure.calls,['status']);assert.equal(h.data.get('workstation-api-key'),'fixture-legacy');assert.equal(h.node('apiBase').value,'https://one.invalid/v1');assert.equal(h.node('model').value,'saved-model');assert.equal(h.node('apiKey').value,'');
  if(hasKey){assert.match(h.node('apiCredentialStatus').textContent,/已保存加密凭据；连接时验证/);assert.match(h.node('apiCredentialStatus').textContent,/钥匙串授权/);assert.doesNotMatch(h.node('apiCredentialStatus').textContent,/已加密保存在此 Mac/);}
  else assert.match(h.node('apiCredentialStatus').textContent,/检测到旧版/);
 }
});

test('unverified encrypted credentials are sent through backend origin validation instead of falsely reporting a missing Key',async()=>{
 const secure=nativeStore(),h=fixture({native:secure.api});await h.context.ensureApiCredentials();
 assert.equal(vm.runInContext('apiCredentialState.verified',h.context),false);const result=await h.context.getApiConnection();assert.equal(result.token,'fixture-old');assert.equal(vm.runInContext('apiCredentialState.verified',h.context),true);assert.equal(secure.calls.filter(x=>x==='read').length,1);assert.match(h.node('apiCredentialStatus').textContent,/已加密保存在此 Mac/);
});

test('unverified cross-origin reads fail closed before network and do not remove a legacy key',async()=>{
 const secure=nativeStore(),h=fixture({native:secure.api,storage:{'workstation-api-key':'fixture-legacy'}});await h.context.ensureApiCredentials();
 secure.api.read=async({base})=>{secure.calls.push('read');assert.equal(base,'https://other.invalid/v1');throw Error('已保存的 Key 不属于此 API 地址');};
 h.edit('apiBase','https://other.invalid/v1');await h.context.testConnection();assert.equal(h.requests.length,0);assert.match(h.node('apiStatus').textContent,/不属于此 API 地址/);assert.equal(h.data.get('workstation-api-key'),'fixture-legacy');assert.equal(vm.runInContext('apiCredentialState.verified',h.context),false);
});

test('legacy migration requires an explicit same-origin action and failure never falls back to the plaintext token',async()=>{
 const secure=nativeStore({hasKey:false,base:'',token:''}),h=fixture({native:secure.api,storage:{'workstation-api-key':'fixture-legacy'}});await h.context.ensureApiCredentials();
 h.edit('apiBase','https://other.invalid/v1');assert.equal((await h.context.getApiConnection()).token,'');assert.deepEqual(secure.calls,['status']);
 h.edit('apiBase','https://one.invalid/v1');secure.api.save=async()=>{secure.calls.push('save');throw Error('fixture Keychain denied');};await h.context.testConnection();assert.equal(h.requests.length,0);assert.match(h.node('apiStatus').textContent,/Keychain denied/);assert.equal(h.data.get('workstation-api-key'),'fixture-legacy');assert.deepEqual(secure.calls,['status','save']);
});

test('concurrent explicit requests serialize one legacy migration and verify the encrypted result before use',async()=>{
 const secure=nativeStore({hasKey:false,base:'',token:''}),pending=deferred(),started=deferred(),originalSave=secure.api.save;
 secure.api.save=async value=>{started.resolve();await pending.promise;return originalSave(value);};const h=fixture({native:secure.api,storage:{'workstation-api-key':'fixture-legacy'}});await h.context.ensureApiCredentials();
 const first=h.context.getApiConnection(),second=h.context.getApiConnection();await started.promise;pending.resolve();const result=await Promise.all([first,second]);assert.equal(secure.calls.filter(x=>x==='save').length,1);assert.equal(secure.calls.filter(x=>x==='read').length,2);assert.ok(result.every(x=>x.token==='fixture-legacy'));assert.equal(h.data.get('workstation-api-key'),undefined);
});

test('explicit save can migrate a same-origin legacy Key without auto migration on startup',async()=>{
 const secure=nativeStore({hasKey:false,base:'',token:''}),h=fixture({native:secure.api,storage:{'workstation-api-key':'fixture-legacy'}});h.context.renderSettings();await h.context.ensureApiCredentials();assert.deepEqual(secure.calls,['status']);assert.equal(await h.context.saveApiSettings(),true);assert.deepEqual(secure.calls,['status','save']);assert.equal(secure.stored.token,'fixture-legacy');assert.equal(h.data.get('workstation-api-key'),undefined);
});
