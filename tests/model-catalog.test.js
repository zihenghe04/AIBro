const test = require('node:test');
const assert = require('node:assert/strict');
const Catalog = require('../app/model-catalog.js');

const BASE = 'https://Relay.Example.invalid/v1/';

test('service key groups by normalized address and rejects credentials in URLs', () => {
  assert.equal(Catalog.serviceKey(BASE), 'https://relay.example.invalid/v1');
  assert.equal(Catalog.serviceKey('https://relay.example.invalid/v1'), Catalog.serviceKey(BASE));
  assert.equal(Catalog.serviceKey('https://user:pw@relay.example.invalid/v1'), '');
  assert.equal(Catalog.serviceKey('file:///tmp/x'), '');
  assert.equal(Catalog.serviceKey(''), '');
});

test('entries are normalized: blank models dropped, duplicates keep the first row, labels default to the model', () => {
  const list = Catalog.normalizeList([
    { model: '  glm-5.3 ', label: '', contextWindow: '1,000,000', efforts: ['max', 'low', 'bogus', 'high'] },
    { model: '', label: 'blank row' },
    { model: 'glm-5.3', label: 'duplicate' },
    { model: 'tiny', label: 'Tiny', contextWindow: 12 },
    null
  ]);
  assert.deepEqual(list, [
    { model: 'glm-5.3', label: 'glm-5.3', contextWindow: 1000000, efforts: ['low', 'high', 'max'] },
    { model: 'tiny', label: 'Tiny', contextWindow: null, efforts: [] }
  ]);
});

test('migration turns the old single default model into one list item without loss', () => {
  const settings = { permissions: { 科研: 'approval' }, workspaceModelConfig: { 科研: { provider: 'api', model: 'w' } } };
  const before = JSON.parse(JSON.stringify(settings));
  assert.equal(Catalog.migrate(settings, [{ base: BASE, model: 'gpt-5.6-luna' }]), 1);
  assert.deepEqual(Catalog.read(settings, BASE), [{ model: 'gpt-5.6-luna', label: 'gpt-5.6-luna', contextWindow: null, efforts: [] }]);
  // Existing settings are untouched; only the new field is added.
  const { modelCatalog, ...rest } = settings;
  assert.deepEqual(rest, before);
  assert.equal(modelCatalog.version, 1);
});

test('migration is idempotent and never overwrites an existing list, even an emptied one', () => {
  const settings = {};
  Catalog.write(settings, BASE, [{ model: 'a', label: 'A', contextWindow: 200000, efforts: ['high'] }, { model: 'b' }], 1);
  const snapshot = JSON.stringify(settings);
  assert.equal(Catalog.migrate(settings, [{ base: BASE, model: 'legacy' }]), 0);
  assert.equal(JSON.stringify(settings), snapshot);
  Catalog.write(settings, 'https://other.invalid/v1', [], 2);
  assert.equal(Catalog.migrate(settings, [{ base: 'https://other.invalid/v1', model: 'legacy' }]), 0);
  assert.deepEqual(Catalog.read(settings, 'https://other.invalid/v1'), []);
  assert.equal(Catalog.migrate(settings, [{ base: 'https://third.invalid/v1', model: 'x' }, { base: 'https://third.invalid/v1', model: 'y' }]), 1);
  assert.deepEqual(Catalog.read(settings, 'https://third.invalid/v1').map(e => e.model), ['x']);
});

test('migration skips missing models, invalid addresses and catalogs from a newer version', () => {
  const settings = {};
  assert.equal(Catalog.migrate(settings, [{ base: BASE, model: '' }, { base: 'not a url', model: 'x' }]), 0);
  assert.equal(settings.modelCatalog, undefined);
  const future = { modelCatalog: { version: 2, services: { anything: { models: [{ model: 'keep' }] } } } };
  const frozen = JSON.stringify(future);
  assert.equal(Catalog.migrate(future, [{ base: BASE, model: 'x' }]), 0);
  assert.equal(Catalog.write(future, BASE, [{ model: 'x' }]), false);
  assert.equal(JSON.stringify(future), frozen);
  assert.deepEqual(Catalog.read(future, BASE), []);
});

test('a damaged catalog is kept as a backup before a new one is written', () => {
  const settings = { modelCatalog: { version: 1, services: 'broken' } };
  assert.equal(Catalog.write(settings, BASE, [{ model: 'x' }]), true);
  assert.deepEqual(settings.modelCatalogBackup, { version: 1, services: 'broken' });
  assert.deepEqual(Catalog.read(settings, BASE).map(e => e.model), ['x']);
});

test('state round trip through JSON keeps the list per service', () => {
  const settings = {};
  Catalog.write(settings, BASE, [{ model: 'deepseek-v4.1-flash', label: 'DeepSeek Flash', contextWindow: '1050000', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }]);
  const restored = JSON.parse(JSON.stringify(settings));
  assert.deepEqual(Catalog.read(restored, 'https://relay.example.invalid/v1'), Catalog.read(settings, BASE));
  assert.deepEqual(Catalog.read(restored, 'https://elsewhere.invalid/v1'), []);
});

test('ensureModel keeps the default model in the list; addModels skips known ids', () => {
  assert.deepEqual(Catalog.ensureModel([{ model: 'a' }], 'b').map(e => e.model), ['a', 'b']);
  assert.deepEqual(Catalog.ensureModel([{ model: 'a' }], 'a').map(e => e.model), ['a']);
  assert.deepEqual(Catalog.addModels([{ model: 'a' }], ['a', 'c', 'c']).map(e => e.model), ['a', 'c']);
  assert.equal(Catalog.label([{ model: 'a', label: 'Alpha' }], 'a'), 'Alpha');
  assert.equal(Catalog.label([], 'unlisted'), 'unlisted');
});

test('reasoning levels follow the protocol; unsupported choices are hidden, empty means all protocol levels', () => {
  assert.deepEqual(Catalog.protocolEfforts('responses'), ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.ok(Catalog.protocolEfforts('chat').includes('max'));
  assert.ok(!Catalog.protocolEfforts('chat').includes('ultra'));
  assert.deepEqual(Catalog.effortsFor({ efforts: ['low', 'max'] }, 'responses'), ['low']);
  assert.deepEqual(Catalog.effortsFor({ efforts: [] }, 'chat'), Catalog.protocolEfforts('chat'));
  assert.deepEqual(Catalog.effortsFor(null, 'auto'), Catalog.EFFORTS);
  assert.equal(Catalog.summarizeEfforts(['low', 'medium', 'high', 'xhigh', 'max']), 'low → max');
  assert.equal(Catalog.summarizeEfforts(['low', 'high', 'max']), 'low, high, max');
});

test('context budgets keep the current fixed values when no window is set and scale with bounds when it is', () => {
  const none = Catalog.budgets(null);
  assert.equal(none.configured, false);
  assert.deepEqual({ ...none, configured: undefined }, { ...Catalog.DEFAULT_BUDGETS, configured: undefined });
  const reference = Catalog.budgets(128000);
  for (const key of Object.keys(Catalog.DEFAULT_BUDGETS)) assert.equal(reference[key], Catalog.DEFAULT_BUDGETS[key], key);
  const small = Catalog.budgets(8192), huge = Catalog.budgets(1050000);
  assert.ok(small.compactThreshold < none.compactThreshold && small.historyTokens < none.historyTokens);
  assert.ok(small.keepRecentTokens <= small.compactThreshold / 2);
  assert.ok(huge.compactThreshold > none.compactThreshold && huge.compactThreshold <= 48000 && huge.historyTokens <= 14000);
  assert.equal(Catalog.budgets('abc').configured, false);
});

test('kernel budgets (evidence input, run compaction) keep the fixed values without a window and scale with one', () => {
  const none = Catalog.kernelBudgets(null);
  assert.equal(none.configured, false);
  assert.deepEqual({ ...none, configured: undefined }, { ...Catalog.KERNEL_DEFAULTS, configured: undefined });
  assert.deepEqual([none.evidenceInputTokens, none.runCompactTokens, none.runRetainTokens], [24000, 32000, 8000]);
  const reference = Catalog.kernelBudgets(128000);
  for (const key of Object.keys(Catalog.KERNEL_DEFAULTS)) assert.equal(reference[key], Catalog.KERNEL_DEFAULTS[key], key);
  const small = Catalog.kernelBudgets(16000), huge = Catalog.kernelBudgets(1050000);
  assert.ok(small.runCompactTokens < 32000 && small.evidenceInputTokens < 24000 && small.runCompactTokens < 16000);
  assert.ok(small.runRetainTokens <= small.runCompactTokens / 2);
  assert.ok(huge.runCompactTokens > 32000 && huge.runCompactTokens <= 160000 && huge.evidenceInputTokens <= 96000);
  assert.equal(Catalog.kernelBudgets('abc').configured, false);
});

test('hints are specific to the row and service', () => {
  const relay = Catalog.hints({ model: 'gpt-6.1-sol', contextWindow: 1050000, efforts: [] }, { base: 'https://relay.invalid/v1' });
  assert.deepEqual(relay.map(h => h.code), ['relay-gpt-window']);
  assert.deepEqual(Catalog.hints({ model: 'gpt-6.1-sol', contextWindow: 1050000, efforts: [] }, { base: 'https://api.openai.com/v1' }), []);
  assert.deepEqual(Catalog.hints({ model: 'glm-5.3', contextWindow: 1000000, efforts: [] }, { base: 'https://relay.invalid/v1' }), []);
  assert.deepEqual(Catalog.hints({ model: 'x', contextWindow: 8192, efforts: ['max'] }, { protocol: 'responses', available: ['y'] }).map(h => h.code), ['small-window', 'not-listed', 'effort-protocol']);
  for (const hint of relay) assert.ok(hint.zh && hint.en);
});
