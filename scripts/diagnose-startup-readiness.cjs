// Read-only source diagnostic, not an installed-app reproduction or a repaired
// regression gate. Synthetic state only; no network, GUI, server or user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const bridge = fs.readFileSync(path.join(root, 'native/Resources/bridge.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app/app.js'), 'utf8');
const hash = source => crypto.createHash('sha256').update(source).digest('hex');
const results = [];
function probeLostFirstSnapshot(mode) {
  let calls = 0, received = 0, dropping = true;
  const intervals = [], classes = new Set();
  const env = {
    state: { projects: [], conversations: [], tasks: [], notes: [], imports: [], ui: {} },
    storageHydrated: false, sendMessage: { busy: false },
    setInterval: (callback, ms) => intervals.push({ callback, ms }),
    document: { hidden: false, addEventListener() {}, body: { dataset: { view: 'agent' }, classList: {
      add: name => classes.add(name), contains: name => classes.has(name), toggle: (name, enabled) => { enabled ? classes.add(name) : classes.delete(name); return enabled; },
    } }, querySelector: () => null },
    window: { addEventListener() {}, webkit: { messageHandlers: { workspace: { postMessage() {
      calls++;
      if (dropping) { if (mode === 'throw') throw Error('synthetic bridge send failure'); return; }
      received++;
    } } } } },
  };
  vm.runInNewContext(bridge, env);
  const tick = intervals.find(item => item.ms === 500).callback;
  env.storageHydrated = true;
  if (mode === 'throw') assert.throws(tick, /synthetic bridge/); else tick();
  dropping = false;
  for (let i = 0; i < 120; i++) tick();
  assert.equal(calls, 1); assert.equal(received, 0);
  env.state.notes.push({ id: 'synthetic-note', title: 'Fixture', workspace: '日常' }); tick();
  assert.equal(calls, 2); assert.equal(received, 1);
  results.push({ scenario: `first snapshot ${mode}`, outcome: 'confirmed_gap', callsAcross120UnchangedTicks: 1, acceptedAcross120UnchangedTicks: 0, recoversOnlyAfterPayloadChange: true });
}
function section(from, to) {
  const start = app.indexOf(from), end = app.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'source boundaries must match actual app');
  return app.slice(start, end);
}
const hydrate = section('async function hydratePersistentState() {', '\nfunction semanticTokens(');
const files = section('let fileDbPromise;', 'async function fileStoreGet(');
async function probeHydration(stage) {
  let release, openRequest, responsePending = false, complete = false;
  const requests = [];
  const remote = { _revision: 1, _migrationId: 'fixture', imports: stage === 'indexeddb' ? [{ id: 'synthetic-file', dataUrl: 'synthetic' }] : [], ui: {} };
  const env = {
    window: { workstationDesktop: { nativeWorkspacePersistence: true } },
    state: { _revision: 0, _migrationId: 'fixture', imports: [], ui: {} },
    storageHydrated: false, executionInstanceId: null, serverConflict: false,
    localStorage: { getItem: () => null, setItem() {} },
    fetch: async url => {
      requests.push(url);
      if ((stage === 'state' && url === '/__state') || (stage === 'health' && url === '/__health')) {
        responsePending = true; await new Promise(resolve => release = resolve);
      }
      return { ok: true, json: async () => url === '/__state' ? remote : { instanceId: 'synthetic-service' } };
    },
    normalizeStateShape: value => { env.state = value; },
    dataUrlToBlob: () => ({ arrayBuffer() {} }),
    repairRelationships() {}, rememberCloudAppliedRevision() {}, recoverApprovalReceipts: () => false,
    save() {}, applyUiPreferences() {}, renderAll() {}, renderSettings() {}, showView() {},
    restoreDocumentWorkspace: async () => {}, persistServerSnapshot() {},
    $: () => null, document: { getElementById: () => null }, viewLabels: {},
  };
  if (stage === 'indexeddb') {
    env.indexedDB = env.window.indexedDB = { open() {
      openRequest = {};
      release = () => {
        openRequest.result = { transaction() {
          const transaction = { objectStore: () => ({ put() { queueMicrotask(() => transaction.oncomplete()); } }) };
          return transaction;
        } };
        openRequest.onsuccess();
      };
      return openRequest;
    } };
  }
  vm.createContext(env); vm.runInContext(files + hydrate, env);
  const pending = env.hydratePersistentState().then(() => { complete = true; });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  if (stage === 'normal') {
    await pending; assert.equal(env.storageHydrated, true); assert.equal(complete, true);
    results.push({ scenario: 'normal synthetic hydration control', outcome: 'completes' }); return;
  }
  assert.equal(env.storageHydrated, false); assert.equal(complete, false);
  assert.equal(typeof release, 'function');
  if (stage === 'indexeddb') assert.equal(openRequest.onblocked, undefined);
  else assert.equal(responsePending, true);
  release(); await pending; assert.equal(env.storageHydrated, true);
  results.push({ scenario: `pending ${stage} before hydration`, outcome: 'confirmed_unbounded_dependency', appDeadlinePresent: false, readyWhilePending: false, releasedDependencyCompletes: true, requests });
}
(async () => {
  probeLostFirstSnapshot('throw'); probeLostFirstSnapshot('silent-drop');
  for (const stage of ['normal', 'state', 'health', 'indexeddb']) await probeHydration(stage);
  process.stdout.write(JSON.stringify({ date: '2026-10-02', kind: 'source_failure_path_diagnostic', incidentRootCauseEstablished: false, productionChanges: false, sourceHashes: { bridge: hash(bridge), app: hash(app) }, results }, null, 2) + '\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
