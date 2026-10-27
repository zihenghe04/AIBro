const test = require('node:test');
const assert = require('node:assert/strict');
const Catalog = require('../app/model-catalog.js');
globalThis.ModelCatalog = Catalog;
const C = require('../app/connections.js');
globalThis.Connections = C;
const P = require('../app/providers.js');

const A = 'https://relay-a.example.invalid/v1', B = 'https://relay-b.example.invalid/v1';
function legacySettings() {
  const s = { modelCatalog: { version: 1, services: { [A]: { models: [{ model: 'a-1' }, { model: 'a-2', efforts: ['low', 'high'] }], updatedAt: 1 }, [B]: { models: [{ model: 'b-1' }, { model: 'b-2' }], updatedAt: 1 } } } };
  C.migrate(s, { provider: 'api', base: A, model: 'a-1', protocol: 'chat', profiles: [{ base: B, model: 'b-1', settings: { protocol: 'anthropic' } }], codexModel: 'gpt-x' });
  return s;
}

test('migration: empty data gives an empty list and no overrides', () => {
  for (const input of [undefined, null, {}, { connections: null }, 'oops', []]) {
    const out = P.migrateFromV1(input);
    assert.deepEqual(out.providers, { version: 2, items: [] });
    assert.deepEqual(out.roles, { version: 2, overrides: {} });
  }
});

test('migration: corrupted data is skipped without throwing', () => {
  const out = P.migrateFromV1({ connections: { version: 1, items: [null, 7, { kind: 'api' }, { kind: 'api', base: 'not a url' }, { kind: 'bogus' }, { kind: 'api', base: A, models: 'x' }] }, modelRoles: { version: 1, qa: 'bad', translate: { connection: 'api:gone' } } });
  assert.deepEqual(out.providers.items.map(item => item.id), [C.apiId(A)]);
  assert.deepEqual(out.providers.items[0].models, []);
  assert.deepEqual(out.roles.overrides, {});
  assert.deepEqual(P.migrateFromV1({ connections: { version: 1, items: 'nope' } }).providers.items, []);
});

test('migration: a future version is never overwritten', () => {
  assert.equal(P.migrateFromV1({ connections: { version: 9, items: [] } }), null);
  assert.equal(P.migrateFromV1({ modelRoles: { version: 3 } }), null);
  const s = { connections: { version: 9, items: [] }, providers: { version: 7, items: [{ keep: true }] } };
  const before = JSON.stringify(s);
  assert.equal(P.ensure(s), false);
  assert.equal(P.reconcile(s), false);
  assert.equal(P.project(s), false);
  assert.equal(JSON.stringify(s), before);
});

test('migration: default provider first, primary model first, others become fallbacks, v1 untouched', () => {
  const s = legacySettings();
  C.setRole(s, 'qa', { connection: C.apiId(B), model: 'b-2', effort: 'high' });
  const v1 = JSON.stringify({ c: s.connections, r: s.modelRoles });
  const out = P.migrateFromV1(s);
  assert.equal(JSON.stringify({ c: s.connections, r: s.modelRoles }), v1);
  assert.deepEqual(out.providers.items.map(item => item.id), [C.apiId(B), C.apiId(A), 'codex-cli']);
  const first = out.providers.items[0];
  assert.deepEqual(first.models.map(model => [model.model, model.role]), [['b-2', 'primary'], ['b-1', 'fallback']]);
  assert.equal(first.models[0].effort, 'high');
  assert.equal(first.protocol, 'anthropic');
  assert.deepEqual(out.providers.items[2].account, { service: 'chatgpt', login: 'oauth' });
  assert.ok(!out.providers.items.some(item => item.kind === 'claude-cli' || item.id === 'claude-cli'));
});

test('migration: overrides only when they differ from the default', () => {
  const s = legacySettings();
  C.setRole(s, 'qa', { connection: C.apiId(A), model: 'a-1', effort: '' });
  C.setRole(s, 'translate', { connection: C.apiId(A), model: 'a-1', effort: '' });
  C.setRole(s, 'vision', { connection: C.apiId(B), model: 'b-1', effort: '' });
  C.setRole(s, 'kernel', { connection: C.apiId(A), model: 'a-1', effort: 'low' });
  const out = P.migrateFromV1(s);
  assert.deepEqual(Object.keys(out.roles.overrides).sort(), ['kernel', 'vision']);
  assert.deepEqual(out.roles.overrides.vision, { provider: C.apiId(B), model: 'b-1', effort: '' });
});

test('migration: preset matcher fills capability tags', () => {
  const s = legacySettings();
  const out = P.migrateFromV1(s, { matchPreset: host => host === 'relay-b.example.invalid' ? { preset: 'demo', caps: { 'b-1': { vision: true, think: false } } } : null });
  const b = out.providers.items.find(item => item.id === C.apiId(B));
  assert.equal(b.preset, 'demo');
  assert.deepEqual(b.models[0].caps, { vision: true, think: false });
});

test('ensure writes v2 once, keeps a valid v2, and backs up a broken one', () => {
  const s = legacySettings();
  assert.equal(P.ensure(s), true);
  assert.equal(s.providers.version, 2);
  const snapshot = JSON.stringify(s.providers);
  P.ensure(s);
  assert.equal(JSON.stringify(s.providers), snapshot);
  const broken = { providers: { version: 2, items: 'x' }, connections: legacySettings().connections };
  P.ensure(broken);
  assert.deepEqual(broken.providersBackup, { version: 2, items: 'x' });
  assert.ok(P.items(broken).length >= 2);
});

test('moving a provider to the top changes the default and projects to v1', () => {
  const s = legacySettings();
  P.ensure(s);
  assert.equal(P.defaultSelection(s).provider, C.apiId(A));
  assert.ok(P.makeDefault(s, C.apiId(B)));
  P.project(s);
  assert.equal(P.defaultSelection(s).model, 'b-1');
  assert.deepEqual(s.modelRoles.qa, { connection: C.apiId(B), model: 'b-1', effort: '' });
  assert.deepEqual(s.connections.items.map(item => item.id).slice(0, 2), [C.apiId(B), C.apiId(A)]);
});

test('model order is the fallback order; primary is always first', () => {
  const s = legacySettings();
  P.ensure(s);
  const id = C.apiId(A);
  P.moveModel(s, id, 'a-2', 0);
  assert.deepEqual(P.get(s, id).models.map(model => [model.model, model.role]), [['a-2', 'primary'], ['a-1', 'fallback']]);
  P.addModel(s, id, 'a-3'); P.addModel(s, id, 'a-3');
  P.removeModel(s, id, 'a-1');
  P.setModelCaps(s, id, 'a-3', { vision: true, bogus: true });
  assert.deepEqual(P.get(s, id).models.map(model => model.model), ['a-2', 'a-3']);
  assert.deepEqual(P.get(s, id).models[1].caps, { vision: true });
  P.project(s);
  assert.equal(s.modelRoles.qa.model, 'a-2');
  assert.deepEqual(C.get(s, id).models.map(model => model.model), ['a-2', 'a-3']);
});

test('overrides: set, clear, and fall back to the default when the provider is removed', () => {
  const s = legacySettings();
  P.ensure(s);
  assert.equal(P.setOverride(s, 'translate', { provider: 'api:missing', model: 'x' }), false);
  assert.ok(P.setOverride(s, 'translate', { provider: C.apiId(B), model: 'b-2', effort: '' }));
  P.project(s);
  assert.equal(C.resolveRole(s, 'translate').model, 'b-2');
  assert.ok(P.remove(s, C.apiId(B)));
  P.project(s);
  assert.deepEqual(P.overrides(s), {});
  assert.equal(C.get(s, C.apiId(B)), null);
  assert.equal(C.resolveRole(s, 'translate').followsQa, true);
  assert.equal(P.setOverride(s, 'qa', { provider: C.apiId(A) }), false);
});

test('a provider removed here is not added back from the old connection card', () => {
  const s = legacySettings();
  P.ensure(s);
  P.remove(s, C.apiId(B));
  C.upsert(s, { kind: 'api', base: B, protocol: 'chat', models: [{ model: 'b-1' }] });
  P.reconcile(s);
  assert.ok(!P.get(s, C.apiId(B)));
  P.upsert(s, { kind: 'api', base: B, name: 'again', models: [{ model: 'b-1' }] });
  assert.ok(P.get(s, C.apiId(B)));
  P.reconcile(s);
  assert.equal(P.get(s, C.apiId(B)).name, 'again');
});

test('reconcile pulls in changes made through the old entry points', () => {
  const s = legacySettings();
  P.ensure(s);
  C.upsert(s, { kind: 'api', base: 'https://relay-c.example.invalid/v1', protocol: 'responses', models: [{ model: 'c-1' }] });
  C.setRole(s, 'qa', { connection: C.apiId(B), model: 'b-2', effort: 'low' });
  C.upsert(s, { kind: 'api', base: A, protocol: 'chat', models: [{ model: 'a-1' }, { model: 'a-2' }, { model: 'a-9' }] });
  P.reconcile(s);
  const ids = P.items(s).map(item => item.id);
  assert.equal(ids[0], C.apiId(B));
  assert.ok(ids.includes('api:https://relay-c.example.invalid/v1'));
  assert.deepEqual(P.get(s, C.apiId(B)).models.map(model => model.model), ['b-2', 'b-1']);
  assert.equal(P.get(s, C.apiId(B)).models[0].effort, 'low');
  assert.ok(P.get(s, C.apiId(A)).models.some(model => model.model === 'a-9'));
});

test('vision auto: follows the default unless another model is the first one tagged as vision', () => {
  const s = legacySettings();
  P.ensure(s);
  assert.equal(P.visionAuto(s).auto, 'default');
  P.setModelCaps(s, C.apiId(B), 'b-2', { vision: true });
  const auto = P.visionAuto(s);
  assert.deepEqual([auto.provider, auto.model, auto.auto], [C.apiId(B), 'b-2', 'vision']);
  P.setModelCaps(s, C.apiId(A), 'a-1', { vision: true });
  assert.equal(P.visionAuto(s).auto, 'default');
});

test('no secrets and no unknown fields survive normalization', () => {
  const s = legacySettings();
  P.ensure(s);
  P.upsert(s, { kind: 'api', base: 'https://relay-d.example.invalid/v1', apiKey: 'sk-secret', token: 'zzz', models: [{ model: 'd-1', apiKey: 'sk-secret' }] });
  assert.ok(!JSON.stringify(s.providers).includes('sk-secret'));
  assert.ok(!JSON.stringify(s.providers).includes('zzz'));
});

test('the last connection check is kept as time, outcome and state only', () => {
  const s = legacySettings();
  P.ensure(s);
  assert.ok(P.setCheck(s, C.apiId(A), { state: 'auth', message: 'sk-should-not-be-kept', models: ['x'] }));
  const check = P.get(s, C.apiId(A)).check;
  assert.deepEqual([check.ok, check.state], [false, 'auth']);
  assert.ok(Number.isFinite(check.at));
  assert.ok(!JSON.stringify(s.providers).includes('sk-should'));
  assert.equal(P.setCheck(s, C.apiId(A), { state: 'nonsense' }), false);
  P.setCheck(s, C.apiId(A), { state: 'ok' });
  assert.equal(P.get(s, C.apiId(A)).check.ok, true);
});

test('adding from a preset keeps its id and models; a migrated host match fills capability tags', () => {
  const s = legacySettings();
  P.ensure(s);
  const added = P.upsert(s, { kind: 'api', preset: 'demo', name: 'Demo', base: 'https://demo.example.invalid/v1', protocol: 'responses', models: [{ model: 'd-1', caps: { vision: true, text: true } }, { model: 'd-2' }] });
  assert.equal(added.preset, 'demo');
  assert.deepEqual(added.models.map(model => model.role), ['primary', 'fallback']);
  assert.equal(P.items(s).at(-1).id, added.id, 'new providers go to the end, the default is unchanged');
  assert.equal(P.defaultSelection(s).provider, C.apiId(A));
});

test('fallback models are the ones after the current model in the same provider, skipping those marked as unable to use tools', () => {
  const s = legacySettings();
  P.ensure(s);
  const id = C.apiId(A);
  P.addModel(s, id, { model: 'a-3', caps: { text: false } });
  P.addModel(s, id, { model: 'a-4' });
  assert.deepEqual(P.fallbackModels(s, id, 'a-1'), ['a-2', 'a-4']);
  assert.deepEqual(P.fallbackModels(s, id, 'a-2'), ['a-4']);
  assert.deepEqual(P.fallbackModels(s, id, 'a-4'), []);
  assert.deepEqual(P.fallbackModels(s, id, 'not-listed'), [], 'a model that is not in the list has no fallbacks');
  assert.deepEqual(P.fallbackModels(s, 'codex-cli', 'x'), [], 'accounts have none');
  assert.deepEqual(P.fallbackModels(s, 'api:missing', 'x'), []);
});

test('setConnection changes protocol in place and moves id (with overrides) when the address changes', () => {
  const s = legacySettings();
  P.ensure(s);
  const id = C.apiId(A);
  P.setOverride(s, 'translate', { provider: id, model: 'a-1' });
  assert.equal(P.setConnection(s, id, { protocol: 'anthropic' }).protocol, 'anthropic');
  const moved = P.setConnection(s, id, { base: 'https://moved.example.invalid/v1' });
  assert.ok(moved && moved.id !== id && moved.models.length >= 1);
  assert.equal(P.overrides(s).translate.provider, moved.id);
  assert.equal(P.get(s, id), null);
  assert.equal(P.setConnection(s, moved.id, { base: B }), null, 'an address that another provider already uses is refused');
  assert.equal(P.setConnection(s, moved.id, { protocol: 'bogus' }), null);
  assert.equal(P.setConnection(s, 'codex-cli', { protocol: 'chat' }), null, 'accounts have no address');
});

test('purpose roles: embedding and transcription sit next to overrides and survive overrides rewrites', () => {
  const s = legacySettings();
  assert.equal(P.ensure(s), true);
  assert.equal(P.purposeRole(s, 'embedding'), null);
  const first = P.items(s).find(item => item.kind === 'api');
  assert.equal(P.setPurposeRole(s, 'embedding', { provider: first.id, base: A + '/embeddings', model: 'text-embedding-3-small', dimensions: '512', enabled: true }), true);
  assert.deepEqual(P.purposeRole(s, 'embedding'), { provider: first.id, base: A + '/embeddings', model: 'text-embedding-3-small', dimensions: 512, enabled: true });
  assert.equal(P.setPurposeRole(s, 'embedding', P.purposeRole(s, 'embedding')), false, 'identical value is not a change');
  assert.equal(P.setPurposeRole(s, 'transcription', { source: 'cloud', scheme: 'abc', model: 'm', realtime: true }), true);
  assert.equal(P.setPurposeRole(s, 'nope', {}), false);
  // overrides rewrites keep both
  P.setOverride(s, 'translate', { provider: first.id, model: 'a-1', effort: '' });
  assert.equal(s.roles.embedding.model, 'text-embedding-3-small');
  assert.equal(s.roles.transcription.source, 'cloud');
  assert.equal(P.overrides(s).translate.model, 'a-1');
  // removing the referenced provider clears the link but keeps the data (nothing lost)
  P.remove(s, first.id);
  assert.equal(P.purposeRole(s, 'embedding').provider, '');
  assert.equal(P.purposeRole(s, 'embedding').base, A + '/embeddings');
  assert.equal(s.roles.transcription.scheme, 'abc');
});

test('purpose roles: invalid values are normalized; a future roles version is never written', () => {
  const s = legacySettings(); P.ensure(s);
  P.setPurposeRole(s, 'transcription', { source: 'bogus', scheme: 5, realtime: 'yes' });
  assert.deepEqual(P.purposeRole(s, 'transcription'), { source: 'none', scheme: '5', model: '', realtime: false });
  assert.equal(P.setPurposeRole(s, 'embedding', 'oops'), false);
  assert.equal(P.setPurposeRole(s, 'embedding', null), false, 'nothing to delete');
  const future = legacySettings(); P.ensure(future); future.roles = { version: 3, overrides: {}, embedding: { base: 'x' } };
  assert.equal(P.setPurposeRole(future, 'embedding', { base: 'https://a.example.invalid' }), false);
  assert.equal(future.roles.version, 3);
});
