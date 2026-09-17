const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const between = (start, end) => {
  const begin = source.indexOf(start), finish = source.indexOf(end, begin);
  assert.ok(begin >= 0 && finish > begin, `Cannot extract real source: ${start}`);
  return source.slice(begin, finish);
};
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const drain = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const descendants = element => (element.children || []).flatMap(child => [child, ...descendants(child)]);
const payload = (title, revision = 1) => ({
  _revision: revision, _migrationId: 'aw-state-v2',
  projects: [], tasks: [{ id: 'task-one', title }], notes: [], imports: [], links: [], papers: [],
  attachments: [], trash: [], agentRuns: [], conversations: [{ id: 'conversation-one', title: 'Conversation', messages: [], attachments: [] }],
  currentConversationId: 'conversation-one', ui: { lastView: 'agent' },
});

function harness(options = {}) {
  const stored = new Map(), timers = new Map(), elements = new Map(), requests = [], downloaded = [];
  let timerID = 0, createdBlob = null;
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {}; this.textContent = ''; this.style = {}; this.classes = new Set(); this.classList = { add: name => this.classes.add(name), toggle: (name, yes) => yes ? this.classes.add(name) : this.classes.delete(name) }; }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(...items) { this.children.push(...items); items.forEach(item => { if (item.id) elements.set(item.id, item); }); }
    appendChild(item) { this.append(item); return item; }
    click() { if (this.tagName === 'A') downloaded.push(this); return this.onclick?.({ target: this }); }
    remove() { if (this.id) elements.delete(this.id); }
  }
  ['connectionState', 'currentContext', 'agent', 'dashboard', 'project'].forEach(id => { const item = new Element('div'); item.id = id; elements.set(id, item); });
  const body = new Element('body');
  const context = {
    state: options.state || payload('Local draft'), initializingUI: options.initializingUI ?? false,
    storageHydrated: options.storageHydrated ?? true, settingsHydrated: false,
    localEditVersion: 0, serverSaveTimer: null, serverSaveInFlight: false, serverSaveQueued: false, serverConflict: false, purgeTrash: { syncPaused: false },
    STORAGE_KEY: 'workstation-state', Research: {}, uid: name => `${name}-generated`, workspaceName: name => name === '科研' || name === '课程' ? name : '日常',
    localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)), removeItem: key => stored.delete(key) },
    document: { body, createElement: tag => new Element(tag), getElementById: id => elements.get(id) || null },
    $: selector => elements.get(selector.replace(/^#/, '')) || null, $$: () => [],
    setTimeout: (callback, delay) => { const id = ++timerID; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: (url, init = {}) => { requests.push({ url, init }); return options.fetch ? options.fetch(url, init) : Promise.resolve(response({ revision: 2 })); },
    repairRelationships() {}, applyUiPreferences() {}, renderAll() {}, renderSettings() {}, renderDashboard() {}, renderConversation() {}, renderResults() {}, renderSpace() {}, renderTrash() {}, renderProject() {}, renderSidebar() {},
    dataUrlToBlob: () => null, fileStorePut: async () => {},
    Blob, URL: { createObjectURL: blob => { createdBlob = blob; return 'blob:isolated-recovery'; }, revokeObjectURL() {} },
    console, window: {}, viewLabels: { agent: '持续对话', dashboard: '总览' },
  };
  vm.createContext(context);
  vm.runInContext([
    between('function normalizeStateShape(', '\ntry { normalizeStateShape'),
    between('function ensureConversation(', '\nconst currentConversation'),
    between('function exportRecoveryDraft(', '\nwindow.flushWorkspace'),
    between('async function hydratePersistentState(', '\nfunction semanticTokens'),
    between('function showView(', '\nconst viewLabels'),
    'globalThis.testAPI = { save, hydratePersistentState, persistServerSnapshot, showSyncConflict, exportRecoveryDraft, normalizeStateShape };',
  ].join('\n'), context);
  context.testAPI.normalizeStateShape(context.state);
  stored.set(context.STORAGE_KEY, JSON.stringify(context.state));
  return {
    c: context, api: context.testAPI, stored, timers, elements, requests, downloaded,
    storedState: () => JSON.parse(stored.get(context.STORAGE_KEY)),
    async flushTimers() {
      const scheduled = [...timers]; timers.clear();
      for (const [, timer] of scheduled) timer.callback();
      await drain();
    },
    get createdBlob() { return createdBlob; },
  };
}

test('dirty startup snapshot survives hydration from a newer remote revision', async () => {
  const local = { ...payload('Unsaved local correction', 3), _pendingLocalSave: true };
  const h = harness({ state: local, storageHydrated: false, fetch: async (_url, init) => init.method === 'POST' ? response({ revision: 10 }) : response(payload('Remote correction', 9)) });
  await h.api.hydratePersistentState();
  assert.equal(h.c.state.tasks[0].title, 'Unsaved local correction');
  assert.equal(h.storedState().tasks[0].title, 'Unsaved local correction');
  assert.equal(h.c.state._revision, 3);
  assert.equal(h.c.state._pendingLocalSave, true);
  assert.equal(h.c.serverConflict, true);
  assert.equal(h.c.storageHydrated, true);
  await h.flushTimers();
  assert.equal(h.requests.filter(item => item.init.method === 'POST').length, 0);
  const notice = h.elements.get('syncConflictNotice');
  assert.ok(notice); assert.equal(notice.attributes.role, 'alert');
  assert.ok(descendants(notice).some(item => item.tagName === 'BUTTON' && /导出/.test(item.textContent)));
});

test('workspace hydration completes when the optional browser cache exceeds quota', async () => {
  const remote=payload('Large local database task', 9);
  remote.agentRuns=[{id:'synthetic-run',status:'completed',output:'x'.repeat(6*1024*1024)}];
  const h=harness({storageHydrated:false,fetch:async url=>response(url==='/__state'?remote:{instanceId:'fixture'})});
  h.c.localStorage.setItem=()=>{throw Object.assign(new Error('Storage quota exceeded'),{name:'QuotaExceededError'});};
  h.c.console={warn(){},error(){}};
  await h.api.hydratePersistentState();
  assert.equal(h.c.storageHydrated,true);
  assert.equal(h.c.state.tasks[0].title,remote.tasks[0].title);
  assert.equal(h.c.state.agentRuns[0].output.length,6*1024*1024);
  assert.equal(h.c.state._revision,9);
});

test('native workspace bypasses browser cache and still saves the complete database snapshot', async () => {
  const remote=payload('Native database task',9);remote.agentRuns=[{id:'complete-ledger',output:'synthetic evidence'}];
  const h=harness({storageHydrated:false,fetch:async(url,init)=>response(init.method==='POST'?{revision:10}:url==='/__state'?remote:{instanceId:'fixture'})});
  h.c.window.workstationDesktop={nativeWorkspacePersistence:true};
  let cacheWrites=0;h.c.localStorage.setItem=key=>{if(key===h.c.STORAGE_KEY){cacheWrites++;throw new Error('Native must not mirror full workspace');}};
  await h.api.hydratePersistentState();
  await drain();const firstEditRequest=h.requests.length;
  h.c.state.tasks[0].title='Edited after startup';h.api.save();h.api.persistServerSnapshot();await drain();
  assert.equal(cacheWrites,0);
  const posted=JSON.parse(h.requests.slice(firstEditRequest).find(r=>r.init.method==='POST').init.body);
  assert.equal(posted.tasks[0].title,'Edited after startup');
  assert.equal(posted.agentRuns[0].output,'synthetic evidence');
  assert.equal(h.c.state._pendingLocalSave,undefined);
});

test('old successful response cannot clear newer local edits and subsequent save uses acknowledged revision', async () => {
  const first = deferred(), second = deferred(); let post = 0;
  const h = harness({ fetch: () => ++post === 1 ? first.promise : second.promise });
  h.c.state.tasks[0].title = 'First save'; h.api.save(); h.api.persistServerSnapshot();
  assert.equal(h.c.serverSaveInFlight, true);
  assert.equal(JSON.parse(h.requests[0].init.body).tasks[0].title, 'First save');
  assert.equal(Object.hasOwn(JSON.parse(h.requests[0].init.body), '_pendingLocalSave'), false);
  h.c.state.tasks[0].title = 'Edited while saving'; h.api.save();
  await h.flushTimers(); // A debounce firing during a request must not start another writer.
  assert.equal(h.requests.length, 1);
  first.resolve(response({ revision: 2 })); await drain();
  assert.equal(h.c.state._pendingLocalSave, true);
  assert.equal(h.storedState()._pendingLocalSave, true);
  assert.equal(h.storedState().tasks[0].title, 'Edited while saving');
  assert.equal(h.c.state._revision, 2);
  assert.equal(h.c.serverSaveQueued, true);
  assert.ok([...h.timers.values()].some(timer => timer.delay === 180));
  await h.flushTimers();
  assert.equal(h.requests.length, 2);
  assert.equal(JSON.parse(h.requests[1].init.body)._revision, 2);
  assert.equal(JSON.parse(h.requests[1].init.body).tasks[0].title, 'Edited while saving');
  second.resolve(response({ revision: 3 })); await drain();
  assert.equal(Object.hasOwn(h.c.state, '_pendingLocalSave'), false);
  assert.equal(Object.hasOwn(h.storedState(), '_pendingLocalSave'), false);
});

test('successful save without subsequent edits clears dirty state in memory and local snapshot', async () => {
  const pending = deferred(); const h = harness({ fetch: () => pending.promise });
  h.api.save(); h.api.persistServerSnapshot();
  assert.equal(h.c.state._pendingLocalSave, true);
  pending.resolve(response({ revision: 2 })); await drain();
  assert.equal(h.c.serverSaveInFlight, false);
  assert.equal(h.c.serverSaveQueued, false);
  assert.equal(h.c.state._revision, 2);
  assert.equal(h.c.state._pendingLocalSave, undefined);
  assert.equal(h.storedState()._pendingLocalSave, undefined);
});

test('409 stops automatic retries and offers a credential-free local recovery export', async () => {
  const pending = deferred(); const h = harness({ fetch: () => pending.promise });
  h.c.state.settings.apiKey = 'fixture-do-not-export';
  h.c.state.settings.nested = { access_token: 'fixture-token', ordinary: 'keep me' };
  h.api.save(); h.api.persistServerSnapshot();
  pending.resolve(response({ error: 'Concurrent edit', code: 'state_conflict' }, 409)); await drain();
  assert.equal(h.c.serverConflict, true); assert.equal(h.c.state._pendingLocalSave, true);
  h.c.state.tasks[0].title = 'Correction after conflict'; h.api.save(); await h.flushTimers();
  h.api.persistServerSnapshot();
  assert.equal(h.requests.length, 1, 'Conflict must never automatically overwrite the other revision');
  assert.equal(h.storedState().tasks[0].title, 'Correction after conflict');
  const notice = h.elements.get('syncConflictNotice');
  const exportButton = descendants(notice).find(item => item.tagName === 'BUTTON' && /导出/.test(item.textContent));
  assert.ok(exportButton); exportButton.click();
  assert.equal(h.downloaded.length, 1);
  const exported = JSON.parse(await h.createdBlob.text());
  assert.equal(exported.tasks[0].title, 'Correction after conflict');
  assert.equal(exported.settings.apiKey, undefined); assert.equal(exported.settings.nested.access_token, undefined);
  assert.equal(exported.settings.nested.ordinary, 'keep me');
});

test('network failure retains local draft, queues backoff and retries the current state', async () => {
  const failure = deferred(); let count = 0;
  const h = harness({ fetch: () => ++count === 1 ? failure.promise : Promise.resolve(response({ revision: 2 })) });
  h.api.save(); h.api.persistServerSnapshot(); failure.reject(new TypeError('Failed to fetch')); await drain();
  assert.equal(h.c.serverSaveInFlight, false); assert.equal(h.c.serverSaveQueued, true);
  assert.equal(h.c.serverConflict, false); assert.equal(h.storedState()._pendingLocalSave, true);
  assert.equal(h.storedState().tasks[0].title, 'Local draft');
  assert.ok([...h.timers.values()].some(timer => timer.delay === 5000));
  await h.flushTimers();
  assert.equal(h.requests.length, 2);
  assert.equal(JSON.parse(h.requests[1].init.body).tasks[0].title, 'Local draft');
  assert.equal(h.c.state._pendingLocalSave, undefined);
});

test('initial render saves do not mark a clean startup dirty or block remote hydration', async () => {
  const get = deferred(), post = deferred();
  const h = harness({ initializingUI: true, storageHydrated: false, fetch: (_url, init) => init.method === 'POST' ? post.promise : get.promise });
  // Exercise save callers during the real boot order, then its asynchronous hydration.
  h.c.renderAll = () => h.api.save();
  const startup = between("renderAll(); renderSettings(); settingsHydrated = true; showView('agent'", '\nwindow.OpenAIAuth');
  vm.runInContext(startup.replace('hydratePersistentState();', 'globalThis.bootHydration = hydratePersistentState();'), h.c);
  assert.equal(h.c.initializingUI, false);
  assert.equal(h.c.state._pendingLocalSave, undefined);
  assert.equal(h.c.localEditVersion, 0);
  get.resolve(response(payload('Newer remote task', 8))); await h.c.bootHydration;
  assert.equal(h.c.state.tasks[0].title, 'Newer remote task');
  assert.equal(h.c.state._revision, 8); assert.equal(h.c.serverConflict, false);
  assert.equal(h.elements.has('syncConflictNotice'), false);
  post.resolve(response({ revision: 9 })); await drain();
});

test('an early user edit during the startup fetch is retained instead of being overwritten', async () => {
  const pending = deferred(); const h = harness({ initializingUI: false, storageHydrated: false, fetch: () => pending.promise });
  const hydration = h.api.hydratePersistentState();
  h.c.state.tasks[0].title = 'Typed before server arrived'; h.api.save();
  assert.equal(h.storedState()._pendingLocalSave, true);
  pending.resolve(response(payload('Remote old content', 4))); await hydration;
  assert.equal(h.c.state.tasks[0].title, 'Typed before server arrived');
  assert.equal(h.storedState().tasks[0].title, 'Typed before server arrived');
  assert.equal(h.c.serverConflict, true);
  assert.equal(h.requests.filter(r=>r.url==='/__state').length, 1);
});

test('dirty startup at the same revision is retried normally without a false conflict', async () => {
  const post = deferred();
  const h = harness({ state: { ...payload('Offline edit', 4), _pendingLocalSave: true }, storageHydrated: false,
    fetch: (_url, init) => init.method === 'POST' ? post.promise : Promise.resolve(response(payload('Server state', 4))) });
  await h.api.hydratePersistentState();
  assert.equal(h.c.serverConflict, false);
  assert.equal(h.c.state.tasks[0].title, 'Offline edit');
  const writes = h.requests.filter(item => item.init.method === 'POST');
  assert.equal(writes.length, 1); assert.equal(JSON.parse(writes[0].init.body)._revision, 4);
  post.resolve(response({ revision: 5 })); await drain();
  assert.equal(h.c.state._pendingLocalSave, undefined);
});
