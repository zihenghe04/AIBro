const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const start = source.indexOf('function apiOrigin('), end = source.indexOf('let toastTimer', start);
const helpers = source.slice(start, end);
const Catalog = require('../app/model-catalog.js');
const BASE = 'https://one.invalid/v1';

// Browser (non-native) settings host with the real app.js settings helpers and the real catalog module.
function fixture({ values = {}, storage = {}, settings = {} } = {}) {
  const nodes = new Map(), saved = [], data = new Map(Object.entries(storage)), refreshes = [];
  function element(id = '') {
    const handlers = new Map();
    return { id, value: '', textContent: '', placeholder: '', disabled: false, hidden: false, dataset: {}, className: '', children: [],
      replaceChildren(...children) { this.children = children; }, setAttribute() {}, addEventListener(type, fn) { handlers.set(type, fn); },
      insertAdjacentElement(_where, child) { nodes.set('#' + child.id, child); }, dispatchEvent(event) { handlers.get(event.type)?.({ target: this }); return true; } };
  }
  for (const id of ['apiBase', 'apiKey', 'apiProtocol', 'provider', 'apiModelOptions', 'model', 'apiStatus', 'saveSettings', 'testApi', 'workspaceModel-daily', 'workspaceModel-course', 'workspaceModel-research']) nodes.set('#' + id, element(id));
  for (const [key, value] of Object.entries(values)) nodes.get('#' + key).value = value;
  const state = { settings: { permissions: {}, ...settings } };
  const context = vm.createContext({ apiProfiles: null, state, URL, Promise, AbortController, JSON,
    Event: class { constructor(type) { this.type = type; } },
    window: { ModelCatalog: Catalog, ModelSettingsUI: { refresh: () => refreshes.push(1) }, confirm: () => true, dispatchEvent() {} },
    document: { createElement: () => element(), getElementById: id => nodes.get('#' + id) }, $: selector => nodes.get(selector) || null, $$: () => [],
    localStorage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) },
    setTimeout: () => 0, clearTimeout() {}, Core: { endpoint: base => base.replace(/\/$/, '') + '/models' },
    save: () => saved.push(JSON.stringify(state)), saveDocumentDurably: async () => { saved.push(JSON.stringify(state)); return true; }, syncComposerModel() {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'fetched-a' }, { id: 'fetched-b' }] }) })
  });
  vm.runInContext('let apiSettingsDirty=false,apiCredentialReady=null,apiCredentialState=null,apiCredentialError="",apiCredentialVersion=0,settingsHydrated=false;\n' + helpers, context);
  context.installApiCredentialControls();
  return { context, state, saved, data, refreshes, node: id => nodes.get('#' + id), view: () => context.apiModelCatalogView() };
}

test('legacy single default model migrates into the saved list and is persisted', () => {
  const h = fixture({ storage: { 'workstation-api-base': BASE, 'workstation-api-model': 'legacy-model' } });
  assert.equal(h.context.migrateApiModelCatalog([{ base: BASE, model: 'legacy-model' }]), 1);
  assert.equal(h.saved.length, 1);
  assert.deepEqual(Catalog.read(h.state.settings, BASE).map(e => e.model), ['legacy-model']);
  assert.equal(h.context.migrateApiModelCatalog([{ base: BASE, model: 'legacy-model' }]), 0);
  assert.equal(h.saved.length, 1);
  assert.deepEqual(h.context.runtimeApiModels().models.map(e => e.model), ['legacy-model']);
});

test('editing the list is a draft until settings are saved; save writes list and default together without the key', async () => {
  const h = fixture({ values: { apiBase: BASE, model: 'm1', apiKey: 'synthetic-secret-token' }, storage: { 'workstation-api-base': BASE, 'workstation-api-model': 'm1' } });
  h.view().onAdd();
  let rows = h.view().entries; assert.equal(rows.length, 2); assert.equal(rows[0].model, 'm1'); assert.equal(rows[0].isDefault, true);
  h.view().onUpdate(rows[1].key, { model: 'm2', label: 'Model Two', contextWindow: '200000', efforts: ['high', 'low'] });
  h.view().onAddFetched(['m2', 'm3']);
  assert.deepEqual(h.view().entries.map(e => e.model), ['m1', 'm2', 'm3']);
  assert.equal(vm.runInContext('apiSettingsDirty', h.context), true);
  assert.deepEqual(h.context.runtimeApiModels().models.map(e => e.model), ['m1'], 'runtime uses the saved list, not the draft');
  assert.equal(await h.context.saveApiSettings(), true);
  assert.deepEqual(Catalog.read(h.state.settings, BASE), [
    { model: 'm1', label: 'm1', contextWindow: null, efforts: [] },
    { model: 'm2', label: 'Model Two', contextWindow: 200000, efforts: ['low', 'high'] },
    { model: 'm3', label: 'm3', contextWindow: null, efforts: [] }
  ]);
  assert.ok(h.saved.every(json => !json.includes('synthetic-secret-token')), 'the key never enters workspace state');
  assert.equal(h.context.runtimeApiModels().models.length, 3);
});

test('the default model cannot be removed; blank rows are dropped and invalid windows block save', async () => {
  const h = fixture({ values: { apiBase: BASE, model: 'm1', apiKey: 'synthetic' } });
  const first = h.view().entries[0];
  h.view().onRemove(first.key);
  assert.deepEqual(h.view().entries.map(e => e.model), ['m1']);
  h.view().onAdd(); h.view().onAdd();
  const [, blank, bad] = h.view().entries;
  h.view().onUpdate(bad.key, { model: 'bad', contextWindow: '12' });
  assert.ok(h.view().entries[2].hints.some(hint => hint.code === 'window-invalid'));
  assert.equal(await h.context.saveApiSettings(), false);
  assert.match(h.node('apiStatus').textContent, /上下文窗口/);
  assert.equal(h.state.settings.modelCatalog, undefined);
  h.view().onUpdate(bad.key, { contextWindow: '' });
  assert.equal(await h.context.saveApiSettings(), true);
  assert.deepEqual(Catalog.read(h.state.settings, BASE).map(e => e.model), ['m1', 'bad']);
  assert.ok(!h.view().entries.some(e => e.key === blank.key && !e.model) || h.view().entries.length === 2);
});

test('default and workspace choices write through the retained inputs', () => {
  const h = fixture({ values: { apiBase: BASE, model: 'm1' } });
  h.view().onAddFetched(['m2']);
  let changed = 0; h.node('workspaceModel-research').addEventListener('change', () => { changed++; });
  h.view().onWorkspace('research', 'm2');
  assert.equal(h.node('workspaceModel-research').value, 'm2'); assert.equal(changed, 1);
  h.view().onDefault('m2');
  assert.equal(h.node('model').value, 'm2');
  assert.equal(h.view().entries.find(e => e.model === 'm2').isDefault, true);
});

test('fetch models offers the returned ids in a chooser and marks rows the service does not list', async () => {
  const h = fixture({ values: { apiBase: BASE, model: 'not-served', apiKey: 'synthetic' } });
  await h.context.fetchApiModelList();
  const view = h.view();
  assert.deepEqual([...view.fetched], ['fetched-a', 'fetched-b']);
  assert.equal(view.chooser, true);
  assert.ok(view.entries[0].hints.some(hint => hint.code === 'not-listed'));
  view.onAddFetched(['fetched-b']);
  assert.equal(h.view().chooser, false);
  assert.deepEqual(h.view().entries.map(e => e.model), ['not-served', 'fetched-b']);
});

test('context budgets come from the saved list entry of the active service', () => {
  const settings = {}; Catalog.write(settings, BASE, [{ model: 'big', contextWindow: 1000000 }, { model: 'plain' }]);
  const h = fixture({ settings, storage: { 'workstation-api-base': BASE, 'workstation-api-model': 'plain' } });
  const budgets = name => Catalog.budgets(Catalog.find(h.context.runtimeApiModels().models, name)?.contextWindow);
  assert.equal(budgets('big').configured, true);
  assert.equal(budgets('plain').configured, false);
  assert.equal(budgets('plain').compactThreshold, 12000);
});
