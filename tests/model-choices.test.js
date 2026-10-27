const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.ModelCatalog = require('../app/model-catalog.js');
const C = globalThis.Connections = require('../app/connections.js');
const P = globalThis.Providers = require('../app/providers.js');
const MC = require('../app/model-choices.js');
const Chain = require('../app/model-chain.js');
const { configuration } = require('../app/model-picker.js');

const A = 'https://relay-a.example.invalid/v1', B = 'https://api.anthropic.com';
function settings() {
  const s = { modelCatalog: { version: 1, services: { [A]: { models: [{ model: 'a-1', label: 'A One' }, { model: 'a-2', efforts: ['low', 'high'] }], updatedAt: 1 }, [B]: { models: [{ model: 'claude-test' }], updatedAt: 1 } } } };
  C.migrate(s, { provider: 'api', base: A, model: 'a-1', protocol: 'chat', profiles: [{ base: B, model: 'claude-test', settings: { protocol: 'auto' } }], codexModel: '' });
  P.ensure(s);
  return s;
}

test('groups list providers in order with default flag, own efforts and protocol efforts', () => {
  const s = settings(), groups = MC.groups(s, {});
  const a = groups.find(group => group.id === C.apiId(A));
  assert.ok(a && a.models.length >= 2);
  assert.equal(a.models.find(entry => entry.model === 'a-2').efforts.join(), 'low,high');
  assert.ok(a.models.find(entry => entry.model === 'a-1').efforts.includes('medium'));
  assert.equal(groups.filter(group => group.isDefault).length, 1);
  assert.equal(groups.some(group => group.kind === 'claude'), false);
});

test('Claude account group only appears when the switch is on', () => {
  const s = settings();
  assert.equal(MC.groups(s, { claudeEnabled: false }).some(group => group.kind === 'claude'), false);
  const on = MC.groups(s, { claudeEnabled: true }).find(group => group.kind === 'claude');
  assert.deepEqual(on.models.map(entry => entry.model), ['', 'sonnet', 'opus', 'haiku']);
});

test('models flagged as not thinking offer no effort levels', () => {
  const s = settings(), id = C.apiId(A);
  P.setModelCaps(s, id, 'a-2', { think: false });
  assert.deepEqual(MC.groups(s, {}).find(group => group.id === id).models.find(entry => entry.model === 'a-2').efforts, []);
});

test('v1 modelConfig maps to the provider that has the model, preferring the active connection', () => {
  const s = settings();
  assert.equal(MC.selectionFrom(s, { provider: 'api', model: 'a-2', effort: 'high' }, { activeBase: A }).connection, C.apiId(A));
  assert.equal(MC.selectionFrom(s, { provider: 'api', model: 'claude-test' }, { activeBase: A }).connection, C.apiId(B));
  assert.equal(MC.selectionFrom(s, { provider: 'api', model: 'nope' }, { activeBase: B }).connection, C.apiId(B));
  assert.deepEqual(MC.selectionFrom(s, { provider: 'openai-auth', model: 'm', effort: 'low' }), { connection: P.CHATGPT_ID, model: 'm', effort: 'low' });
  assert.equal(MC.selectionFrom(s, { provider: 'api', connection: C.apiId(B), model: 'a-2' }, { activeBase: A }).connection, C.apiId(B));
});

test('toConfig writes connection only for custom API and round-trips through ModelChain and the picker', () => {
  const s = settings();
  const sel = { connection: C.apiId(B), model: 'claude-test', effort: 'low' };
  const stored = MC.toConfig(sel);
  assert.deepEqual(stored, { provider: 'api', connection: C.apiId(B), model: 'claude-test', effort: 'low' });
  assert.deepEqual(MC.selectionFrom(s, stored), sel);
  assert.equal(Chain.resolve({ conversation: { modelConfig: stored }, settings: s }, { provider: 'api', model: 'x' }).connection, C.apiId(B));
  assert.equal(configuration({ modelConfig: stored }, {}).connection, C.apiId(B));
  assert.deepEqual(MC.toConfig({ connection: P.CHATGPT_ID, model: 'm', effort: '' }), { provider: 'openai-auth', model: 'm', effort: '' });
  assert.equal('connection' in configuration({ modelConfig: { provider: 'api', model: 'a' } }, {}), false);
});

test('fitEffort drops a level the new model does not offer', () => {
  const model = { efforts: ['low', 'high'] };
  assert.equal(MC.fitEffort(model, 'high'), 'high');
  assert.equal(MC.fitEffort(model, 'xhigh'), '');
});
