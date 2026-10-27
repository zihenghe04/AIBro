const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const start = source.indexOf('function apiOrigin('), end = source.indexOf('let toastTimer', start);
const helpers = source.slice(start, end);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture({ native, values = {}, storage = {}, fetch, durableSave } = {}) {
  const nodes = new Map(), saved = [], requests = [], timers = [], data = new Map(Object.entries(native ? { 'workstation-api-base': 'https://one.invalid/v1', 'workstation-api-model': 'saved-model', ...storage } : storage));
  function element(id = '') {
    const handlers = new Map();
    return { id, value: '', textContent: '', placeholder: '', disabled: false, hidden: false, dataset: {}, className: '',
      children: [], replaceChildren(...children) { this.children = children; },
      setAttribute() {}, addEventListener(type, fn) { handlers.set(type, fn); },
      insertAdjacentElement(_where, child) { nodes.set('#' + child.id, child); },
      fire(type = 'input') { handlers.get(type)?.({ target: this }); }
    };
  }
  for (const id of ['apiBase', 'apiKey', 'apiProtocol', 'provider', 'apiModelOptions', 'model', 'apiStatus', 'saveSettings', 'testApi', 'usageCurrency', 'usageInputRate', 'usageOutputRate']) nodes.set('#' + id, element(id));
  for (const [key, value] of Object.entries(values)) nodes.get('#' + key).value = value;
  const permissions = [element('permission')]; permissions[0].dataset.permission = '科研'; permissions[0].value = 'approval';
  const state = { settings: { permissions: { 科研: 'approval' } } };
  const context = vm.createContext({ apiProfiles: null, state, URL, Promise, AbortController,
    Event, window: { ...(native ? { workstationDesktop: { apiCredentials: native } } : {}), confirm: () => true, dispatchEvent() {} },
    document: { createElement: () => element(), getElementById: id => nodes.get('#' + id) }, $: selector => nodes.get(selector) || null, $$: () => permissions,
    localStorage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) },
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {}, Core: { endpoint: base => base.replace(/\/$/, '') + '/models' },
    save: () => saved.push(JSON.stringify(state)), saveDocumentDurably: async () => { const submitted = JSON.stringify(state); if (durableSave) await durableSave(submitted); saved.push(submitted); return true; }, syncComposerModel() {},
    fetch: async (...args) => { requests.push(args); return fetch ? fetch(...args) : { ok: true, status: 200, json: async () => ({ data: [{ id: 'fixture-model' }] }) }; }
  });
  vm.runInContext('let apiSettingsDirty=false,apiCredentialReady=null,apiCredentialState=null,apiCredentialError="",apiCredentialVersion=0,settingsHydrated=false;\n' + helpers, context);
  vm.runInContext(fs.readFileSync(require.resolve('../app/usage-cost.js'), 'utf8'), context);
  context.window.UsageCost = context.UsageCost;
  context.UsageCost.init({ getState: () => state, document: () => context.document });
  context.installApiCredentialControls();
  return { context, state, nodes, saved, requests, data, permissions, timers, node: id => nodes.get('#' + id), edit(id, value, type = 'input') { const node = nodes.get('#' + id); node.value = value; node.fire(type); } };
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

test('encrypted-file storage never offers or invokes Keychain unlock for a legacy key', async () => {
  const secure = nativeStore(); let unlocks = 0;
  secure.api.storageBackend = 'encrypted-file';
  secure.api.status = async () => ({hasKey:true,base:'https://one.invalid/v1',verified:false,backend:'encrypted-file',storage:'legacy-keychain',needsReentry:true,requiresUnlock:false});
  secure.api.unlock = async () => { unlocks++; throw Error('Must not ask Keychain'); };
  const h = fixture({native:secure.api}); await h.context.ensureApiCredentials();
  assert.equal(h.node('apiCredentialUnlock').hidden, true);
  assert.match(h.node('apiCredentialStatus').textContent, /旧 Key 尚未迁移/);
  assert.match(h.node('apiKey').placeholder, /重新粘贴/);
  assert.equal(await h.context.unlockApiCredentials(), false); assert.equal(unlocks, 0);
  assert.equal(h.node('apiKey').value, ''); assert.equal(h.requests.length, 0);
});

test('unavailable encrypted file never appears as a usable saved key',async()=>{
  const secure=nativeStore();secure.api.storageBackend='encrypted-file';
  secure.api.status=async()=>({hasKey:true,available:false,verified:false,backend:'encrypted-file',storage:'unavailable',base:''});
  const h=fixture({native:secure.api});await h.context.ensureApiCredentials();
  assert.match(h.node('apiCredentialStatus').textContent,/尚未读取到 Key/);
  assert.equal(h.node('apiCredentialUnlock').hidden,true);assert.equal(h.requests.length,0);
});

test('encrypted-file save and deletion never call legacy authorization and persist no plaintext in UI state', async () => {
  const secure = nativeStore(); secure.api.storageBackend = 'encrypted-file';
  secure.api.authorizeSave = secure.api.authorizeRemove = async () => { throw Error('Must not authorize Keychain'); };
  const h = fixture({native:secure.api}); await h.context.ensureApiCredentials(); h.edit('apiKey','fixture-file-store');
  assert.equal(await h.context.saveApiSettings(), true); assert.equal(secure.stored.token,'fixture-file-store');
  assert.match(h.node('apiCredentialStatus').textContent, /不使用登录钥匙串/);
  assert.equal(h.node('apiKey').value,''); assert.equal(h.data.has('workstation-api-key'),false);
  assert.ok(!JSON.stringify(h.state).includes('fixture-file-store'));
  assert.equal(await h.context.clearApiCredentials(),true); assert.equal(secure.stored.hasKey,false);
  assert.deepEqual(secure.calls,['status','save','remove']);
});

test('silent migration failure stops the request and explains reentry; successful retry records the new backend', async () => {
  const secure = nativeStore(); secure.api.storageBackend = 'encrypted-file'; let reads = 0;
  secure.api.read = async () => { if (++reads === 1) throw Object.assign(Error('请重新粘贴 API Key'), {code:'CREDENTIAL_REENTRY_REQUIRED'}); return {base:'https://one.invalid/v1',token:'fixture-migrated',model:'saved-model'}; };
  const h = fixture({native:secure.api}); await h.context.ensureApiCredentials();
  await assert.rejects(h.context.getApiConnection(), e => e.code === 'CREDENTIAL_REENTRY_REQUIRED');
  assert.equal(h.requests.length,0); assert.equal(h.node('apiCredentialUnlock').hidden,true);
  assert.equal(vm.runInContext('apiCredentialState.needsReentry',h.context),true);
  assert.equal((await h.context.getApiConnection()).token,'fixture-migrated');
  assert.equal(vm.runInContext('apiCredentialState.storage',h.context),'encrypted-file');
  assert.equal(vm.runInContext('apiCredentialState.needsReentry',h.context),false);
  assert.equal(h.data.has('workstation-api-key'),false);
});

test('desktop restart restores public configuration and reads the saved key only for matching origin, without plaintext state or input', async () => {
  const secure = nativeStore(), h = fixture({ native: secure.api });
  const pending = h.context.getApiConnection();
  const credentials = await pending;
  assert.equal(credentials.base, 'https://one.invalid/v1'); assert.equal(credentials.token, 'fixture-old');
  assert.equal(h.node('apiBase').value, 'https://one.invalid/v1'); assert.equal(h.node('model').value, 'saved-model'); assert.equal(h.node('apiKey').value, '');
  assert.equal(h.data.get('workstation-api-key'), undefined); assert.ok(!JSON.stringify(h.state).includes('fixture-old')); assert.match(h.node('apiCredentialStatus').textContent, /已加密保存在此 Mac/);
  assert.deepEqual(secure.calls, ['status', 'read']);
});

test('a silent keychain lock preserves the saved key and never escalates a normal read into an unlock dialog', async () => {
  const secure = nativeStore(); let unlocks = 0;
  secure.api.unlock = async () => { unlocks++; throw Error('Must remain explicit'); };
  secure.api.read = async () => { const error = Error('请在设置中解锁已保存的 Key'); error.code = 'KEYCHAIN_LOCKED'; throw error; };
  const h = fixture({ native: secure.api });
  await assert.rejects(h.context.getApiConnection(), { code: 'KEYCHAIN_LOCKED' });
  assert.equal(unlocks, 0); assert.equal(secure.stored.token, 'fixture-old'); assert.equal(h.requests.length, 0);
  assert.equal(h.node('apiCredentialUnlock').hidden, false); assert.equal(h.node('apiKey').value, '');
  assert.match(h.node('apiCredentialStatus').textContent, /解锁/);
});

test('explicit unlock is single-flight, returns only public status and leaves typed settings and key untouched', async () => {
  const secure = nativeStore(), gate = deferred(); let unlocks = 0;
  secure.api.unlock = async ({ base }) => { unlocks++; assert.equal(base, 'https://one.invalid/v1'); await gate.promise; return { available: true, hasKey: true, base, model: 'saved-model', verified: true, requiresUnlock: false }; };
  const h = fixture({ native: secure.api }); await h.context.ensureApiCredentials();
  const pending = h.context.unlockApiCredentials();
  assert.equal(await h.context.unlockApiCredentials(), false);
  h.edit('model', 'new-unsaved-model'); gate.resolve(); assert.equal(await pending, true);
  assert.equal(unlocks, 1); assert.equal(h.node('model').value, 'new-unsaved-model'); assert.equal(h.node('apiKey').value, '');
  assert.equal(h.data.get('workstation-api-key'), undefined); assert.equal(h.requests.length, 0);
  assert.equal(h.node('apiCredentialUnlock').hidden, true); assert.match(h.node('apiStatus').textContent, /未发送模型请求/);
});

test('cancelled explicit unlock does not delete stored credentials or retry itself', async () => {
  const secure = nativeStore(); let unlocks = 0;
  secure.api.unlock = async () => { unlocks++; const error = Error('已取消钥匙串授权'); error.code = 'KEYCHAIN_CANCELLED'; throw error; };
  const h = fixture({ native: secure.api }); await h.context.ensureApiCredentials();
  assert.equal(await h.context.unlockApiCredentials(), false); h.context.renderSettings();
  assert.equal(unlocks, 1); assert.equal(secure.stored.token, 'fixture-old'); assert.equal(h.requests.length, 0);
  assert.equal(h.node('apiCredentialUnlock').hidden, false);
});

test('only explicit settings save and clear use native authorization actions', async () => {
  const secure = nativeStore(); const save = secure.api.save, remove = secure.api.remove; let saves = 0, removes = 0;
  secure.api.authorizeSave = async value => { saves++; return save(value); };
  secure.api.authorizeRemove = async () => { removes++; return remove(); };
  secure.api.save = async () => { throw Error('Unexpected ordinary save'); };
  secure.api.remove = async () => { throw Error('Unexpected ordinary remove'); };
  const h = fixture({ native: secure.api }); await h.context.ensureApiCredentials(); h.edit('apiKey', 'fixture-new');
  assert.equal(await h.context.saveApiSettings(), true); assert.equal(saves, 1);
  assert.equal(await h.context.clearApiCredentials(), true); assert.equal(removes, 1);
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

test('editing connection while the native credential read waits cancels the test before any outbound request', async () => {
  const secure = nativeStore(), h = fixture({ native: secure.api }); await h.context.ensureApiCredentials(); const pending = deferred(); secure.api.read = () => pending.promise;
  const testing = h.context.testConnection(); await Promise.resolve(); await Promise.resolve(); h.edit('apiBase', 'https://two.invalid/v1');
  pending.resolve({ token: 'fixture-old', base: 'https://one.invalid/v1' }); await testing;
  assert.equal(h.requests.length, 0); assert.equal(secure.calls.filter(x => x === 'save').length, 0);
  assert.equal(h.node('testApi').disabled, false); assert.match(h.node('apiStatus').textContent, /连接配置已更改/);
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

const response = (ids, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => ({ data: ids.map(id => ({ id })) }) });
const microtasks = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const configured = { apiBase: 'https://one.invalid/v1', apiKey: 'fixture-transient', model: 'chosen-model', apiProtocol: 'chat', provider: 'api' };

test('late success from an old connection cannot populate a new address or release a newer test', async () => {
  const old = deferred(), next = deferred(); let count = 0;
  const h = fixture({ values: configured, fetch: () => (++count === 1 ? old.promise : next.promise) });
  const first = h.context.testConnection(); await microtasks();
  assert.equal(h.requests.length, 1); assert.equal(h.node('testApi').disabled, true);
  h.edit('apiBase', 'https://two.invalid/v1');
  assert.equal(h.requests[0][1].signal.aborted, true); assert.equal(h.node('testApi').disabled, false);
  const second = h.context.testConnection(); await microtasks();
  old.resolve(response(['obsolete-model'])); await first;
  assert.deepEqual(h.node('apiModelOptions').children, []);
  assert.equal(h.node('testApi').disabled, true); assert.match(h.node('apiStatus').textContent, /正在读取模型列表/);
  next.resolve(response(['current-model'])); await second;
  assert.deepEqual(h.node('apiModelOptions').children.map(node => node.value), ['current-model']);
  assert.match(h.node('apiStatus').textContent, /已读取模型列表.*尚未验证模型调用/);
  assert.equal(h.node('testApi').disabled, false); assert.equal(h.saved.length, 0);
});

test('a late old failure cannot replace a successful newer result after switching away and back', async () => {
  const old = deferred(); let count = 0;
  const h = fixture({ values: configured, fetch: () => ++count === 1 ? old.promise : response(['current']) });
  const first = h.context.testConnection(); await microtasks();
  h.edit('apiBase', 'https://two.invalid/v1'); h.edit('apiBase', configured.apiBase);
  await h.context.testConnection(); const currentStatus = h.node('apiStatus').textContent;
  old.reject(Error('obsolete service error')); await first;
  assert.equal(h.node('apiStatus').textContent, currentStatus);
  assert.deepEqual(h.node('apiModelOptions').children.map(node => node.value), ['current']);
});

test('programmatic field replacement during response body parsing is rejected even without an input event', async () => {
  const body = deferred(), h = fixture({ values: configured, fetch: async () => ({ok:true,status:200,json:() => body.promise}) });
  const pending = h.context.testConnection(); await microtasks();
  h.node('apiKey').value = 'fixture-new-transient';
  body.resolve({data:[{id:'obsolete'}]}); await pending;
  assert.deepEqual(h.node('apiModelOptions').children, []);
  assert.match(h.node('apiStatus').textContent, /连接配置已更改/);
  assert.equal(h.node('apiKey').value, 'fixture-new-transient');
});

test('provider and protocol changes cancel a pending test without persisting or restoring stale settings', async () => {
  for (const [field, value] of [['provider','openai-auth'],['apiProtocol','responses']]) {
    const gate=deferred(),h=fixture({values:configured,fetch:()=>gate.promise});
    const pending=h.context.testConnection(); await microtasks(); h.edit(field,value,'change');
    gate.resolve(response(['obsolete'])); await pending;
    assert.equal(h.node(field).value,value); assert.equal(h.requests[0][1].signal.aborted,true);
    assert.deepEqual(h.node('apiModelOptions').children,[]); assert.equal(h.saved.length,0);
    assert.match(h.node('apiStatus').textContent,/连接配置已更改/);
  }
});

test('empty or malformed model lists clear prior options and never claim a verified model call', async () => {
  for (const payload of [{data:[]},{data:[null,{}, {id:6}, {id:' '}]},{data:{}},null]) {
    const h=fixture({values:configured,fetch:async()=>({ok:true,status:200,json:async()=>payload})});
    h.context.fillModelOptions(['old-model']); await h.context.testConnection();
    assert.deepEqual(h.node('apiModelOptions').children,[]);
    assert.match(h.node('apiStatus').textContent,/尚未验证模型调用/);
    assert.doesNotMatch(h.node('apiStatus').textContent,/连接成功/);
    assert.match(h.node('apiStatus').textContent,Array.isArray(payload?.data)?/未返回可用模型/:/未返回有效的模型列表/);
    assert.equal(h.node('model').value,configured.model);
  }
});

test('model list retrieval deduplicates valid ids and model edits retain choices but invalidate the test result', async () => {
  const h=fixture({values:configured,fetch:async()=>response([' useful ', 'useful', '<model-name>'])});
  await h.context.testConnection();
  assert.deepEqual(h.node('apiModelOptions').children.map(node=>node.value),['useful','<model-name>']);
  assert.match(h.node('apiStatus').textContent,/可用模型 2 个.*尚未验证模型调用/);
  h.edit('model','useful');
  assert.deepEqual(h.node('apiModelOptions').children.map(node=>node.value),['useful','<model-name>']);
  assert.match(h.node('apiStatus').textContent,/连接配置已更改/);
});

test('saving or deleting credentials owns status even when an older model request completes afterwards', async () => {
  for (const action of ['saveApiSettings','clearApiCredentials']) {
    const secure=nativeStore(),gate=deferred(),h=fixture({native:secure.api,fetch:()=>gate.promise});
    await h.context.ensureApiCredentials(); const testing=h.context.testConnection(); await microtasks();
    assert.equal(h.requests.length,1); assert.equal(await h.context[action](),true);
    const currentStatus=h.node('apiStatus').textContent;
    gate.resolve(response(['obsolete'])); await testing;
    assert.equal(h.node('apiStatus').textContent,currentStatus);
    assert.deepEqual(h.node('apiModelOptions').children,[]);
  }
});

test('editing usage fields survives renderSettings and a failed save without changing persisted prices', async () => {
  const secure=nativeStore(),h=fixture({native:secure.api}); await h.context.ensureApiCredentials();
  h.state.settings.usagePrice={currency:'$',input:1,output:2}; h.context.renderSettings();
  h.edit('usageCurrency','¥');h.edit('usageInputRate','3');h.edit('usageOutputRate','6');
  h.context.renderSettings(); assert.equal(h.node('usageInputRate').value,'3'); assert.equal(h.node('usageCurrency').value,'¥');
  secure.api.save=async()=>{throw Error('fixture disk full');};
  assert.equal(await h.context.saveApiSettings(),false);h.context.renderSettings();
  assert.equal(h.node('usageInputRate').value,'3');assert.equal(h.node('usageOutputRate').value,'6');
  assert.deepEqual(h.state.settings.usagePrice,{currency:'$',input:1,output:2});
  assert.equal(h.node('saveSettings').textContent,'保存权限与用量');
});

test('usage save freezes the submitted prices and preserves newer drafts through later render and save', async () => {
  const secure=nativeStore(),gate=deferred(),originalSave=secure.api.save,h=fixture({native:secure.api});
  await h.context.ensureApiCredentials();h.edit('usageCurrency','¥');h.edit('usageInputRate','3');h.edit('usageOutputRate','6');
  secure.api.save=async input=>{await gate.promise;return originalSave(input);};
  const saving=h.context.saveApiSettings(); await microtasks();
  h.edit('usageInputRate','9'); gate.resolve(); assert.equal(await saving,true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.settings.usagePrice)),{currency:'¥',input:3,output:6});
  assert.equal(h.context.saveApiSettings.usageDirty,true);assert.match(h.node('apiStatus').textContent,/保存期间的新修改尚未保存/);h.context.renderSettings();assert.equal(h.node('usageInputRate').value,'9');
  assert.equal(await h.context.saveApiSettings(),true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.settings.usagePrice)),{currency:'¥',input:9,output:6});
  assert.equal(h.context.saveApiSettings.usageDirty,false);
  h.timers.at(-1)();assert.equal(h.node('saveSettings').textContent,'保存权限与用量');
});


test('an unavailable optional models route does not retain an old catalog or claim a model works', async () => {
  for (const status of [404,405]) {
    const h=fixture({values:configured,fetch:async()=>response([],status)});
    h.context.fillModelOptions(['old']);await h.context.testConnection();
    assert.match(h.node('apiStatus').textContent,/地址可达.*尚未验证模型调用/);
    assert.deepEqual(h.node('apiModelOptions').children,[]);
  }
});

test('timeout during credential retrieval never reaches the network after the key arrives', async () => {
  const secure=nativeStore(),gate=deferred(),h=fixture({native:secure.api});await h.context.ensureApiCredentials();
  secure.api.read=()=>gate.promise;const pending=h.context.testConnection();await microtasks();
  h.timers[0]();gate.resolve({base:configured.apiBase,token:'fixture-old'});await pending;
  assert.equal(h.requests.length,0);assert.match(h.node('apiStatus').textContent,/连接超时/);assert.equal(h.node('testApi').disabled,false);
});

test('timeout while parsing the response body reports a timeout instead of an invalid list', async () => {
  const body=deferred(),h=fixture({values:configured,fetch:async()=>({ok:true,status:200,json:()=>body.promise})});
  const pending=h.context.testConnection();await microtasks();h.timers[0]();body.reject(Object.assign(Error('body aborted'),{name:'AbortError'}));await pending;
  assert.match(h.node('apiStatus').textContent,/连接超时/);assert.doesNotMatch(h.node('apiStatus').textContent,/无效|未返回有效/);
  assert.equal(h.node('testApi').disabled,false);
});

test('manual model settings entries reveal the model section after routing, without reinitializing its form', () => {
  const seen=[],env={window:{ConversationModels:{init:hooks=>{env.modelHooks=hooks;}},WorkstationOnboarding:{init:hooks=>{env.tourHooks=hooks;}},SettingsWorkspace:{reveal:section=>seen.push(section)}},get state(){return {};},currentConversation(){},defaultModelConfiguration(){},resolveRunModel(){},toast(){},viewLabels:{settings:'设置'},save(){},showView:view=>seen.push(view)};
  vm.createContext(env);
  for (const name of ['ConversationModels','WorkstationOnboarding']) {
    const line=source.split('\n').find(line=>line.startsWith('window.'+name+'?.init('));assert.ok(line);vm.runInContext(line,env);
  }
  env.modelHooks.openSettings();assert.deepEqual(seen,['settings','models']);seen.length=0;
  env.tourHooks.showView('settings');assert.deepEqual(seen,['settings','models']);seen.length=0;
  env.tourHooks.showView('agent');assert.deepEqual(seen,['agent']);
});


test('settings do not claim durable success or clear a key before the workspace acknowledges submitted permissions and prices', async () => {
  const secure=nativeStore(),commit=deferred(),submitted=[],h=fixture({native:secure.api,durableSave:async snapshot=>{submitted.push(JSON.parse(snapshot));await commit.promise;}});
  await h.context.ensureApiCredentials();h.edit('apiKey','fixture-entered');h.edit('usageCurrency','¥');h.edit('usageInputRate','3');h.permissions[0].value='auto';h.permissions[0].fire('change');
  const pending=h.context.saveApiSettings();await microtasks();
  assert.equal(secure.stored.token,'fixture-entered');assert.equal(submitted.length,1);assert.equal(submitted[0].settings.permissions.科研,'auto');
  assert.equal(h.saved.length,0);assert.equal(h.node('apiKey').value,'fixture-entered');assert.equal(h.node('saveSettings').disabled,true);assert.equal(h.node('testApi').disabled,true);
  assert.equal(h.node('saveSettings').textContent,'正在保存…');assert.doesNotMatch(h.node('apiStatus').textContent,/设置已保存/);
  await h.context.testConnection();assert.equal(h.requests.length,0);
  h.edit('apiKey','fixture-newer');h.edit('usageInputRate','9');h.permissions[0].value='approval';h.permissions[0].fire('change');
  commit.resolve();assert.equal(await pending,true);
  assert.equal(h.saved.length,1);assert.equal(h.node('apiKey').value,'fixture-newer');assert.equal(h.node('usageInputRate').value,'9');assert.equal(h.permissions[0].value,'approval');
  assert.equal(h.context.saveApiSettings.usageDirty,true);assert.match(h.node('apiStatus').textContent,/保存期间的新修改尚未保存/);
  assert.equal(h.node('testApi').disabled,false);
});

test('a workspace failure after credential persistence is a partial save and retains all draft fields for retry', async () => {
  const secure=nativeStore(),h=fixture({native:secure.api,durableSave:async()=>{throw Error('fixture workspace unavailable');}});
  await h.context.ensureApiCredentials();h.edit('apiKey','fixture-entered');h.edit('usageCurrency','¥');h.edit('usageInputRate','7');h.permissions[0].value='auto';h.permissions[0].fire('change');
  assert.equal(await h.context.saveApiSettings(),false);
  assert.equal(secure.stored.token,'fixture-entered');assert.equal(h.saved.length,0);assert.equal(h.node('apiKey').value,'fixture-entered');
  assert.match(h.node('apiStatus').textContent,/连接凭据已保存，其他设置尚未全部保存/);assert.match(h.node('apiStatus').textContent,/fixture workspace unavailable/);
  assert.doesNotMatch(h.node('saveSettings').textContent,/已保存/);assert.equal(h.node('saveSettings').disabled,false);
  h.context.renderSettings();assert.equal(h.node('apiKey').value,'fixture-entered');assert.equal(h.node('usageInputRate').value,'7');assert.equal(h.permissions[0].value,'auto');
  assert.equal(h.context.saveApiSettings.usageDirty,true);assert.equal(vm.runInContext('apiSettingsDirty',h.context),true);
  assert.equal(JSON.stringify(h.state).includes('fixture-entered'),false);
});

test('a conversation that picked another provider sends with that provider’s own address, key and format', async () => {
  const Catalog = require('../app/model-catalog.js'), C = require('../app/connections.js'), P = require('../app/providers.js');
  const A = 'https://relay-a.example.invalid/v1', B = 'https://relay-b.example.invalid/v1';
  const h = fixture({ values: { apiBase: A } });
  const reads = [];
  Object.assign(h.context.window, { Connections: C, Providers: P, ModelCatalog: Catalog });
  C.migrate(h.state.settings, { provider: 'api', base: A, model: 'a-1', protocol: 'chat', profiles: [{ base: B, model: 'b-1', settings: { protocol: 'anthropic' } }], codexModel: '' });
  P.ensure(h.state.settings);
  h.context.apiProfiles = { capture: () => ({}), readForBase: async base => { reads.push(base); return { base, token: 'tok-b' }; } };
  const routed = await h.context.getApiConnection(undefined, C.apiId(B));
  assert.equal(routed.token, 'tok-b'); assert.equal(routed.protocol, 'anthropic'); assert.equal(C.apiId(routed.base), C.apiId(B));
  assert.equal(await h.context.routedApiConnection(C.apiId(A)), null, 'the active connection uses the normal path');
  assert.equal(await h.context.routedApiConnection('missing'), null);
  assert.equal(reads.length, 1);
});
