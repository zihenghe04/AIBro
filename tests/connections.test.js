const test = require('node:test');
const assert = require('node:assert/strict');
const Catalog = require('../app/model-catalog.js');
const C = require('../app/connections.js');
globalThis.ModelCatalog = Catalog;

const BASE = 'https://relay.example.invalid/v1';
const legacySettings = () => ({ permissions: { 科研: 'approval' }, modelCatalog: { version: 1, services: { [BASE]: { models: [{ model: 'glm-5.3', label: 'GLM', contextWindow: 200000, efforts: ['low', 'high'] }], updatedAt: 1 } } } });

test('migration builds the list from legacy services, Codex and a hidden Claude entry without touching old keys', () => {
  const settings = legacySettings(), before = JSON.stringify(settings.modelCatalog);
  const added = C.migrate(settings, { provider: 'api', base: BASE + '/', model: 'glm-5.3', protocol: 'chat', profiles: [{ base: 'https://api.anthropic.com', model: 'claude-x', settings: { protocol: 'auto' } }] });
  assert.equal(added, 4);
  assert.equal(JSON.stringify(settings.modelCatalog), before);
  const ids = C.items(settings).map(item => item.id);
  assert.deepEqual(ids, ['api:https://relay.example.invalid/v1', 'api:https://api.anthropic.com', 'codex-cli']);
  assert.equal(C.items(settings, { includeHidden: true }).length, 4);
  assert.equal(C.get(settings, ids[0]).models[0].contextWindow, 200000);
  assert.equal(C.get(settings, ids[0]).protocol, 'chat');
  assert.deepEqual(settings.modelRoles.qa, { connection: ids[0], model: 'glm-5.3', effort: '' });
  assert.equal(settings.modelRoles.translate, null);
});

test('migration is idempotent and never overwrites existing entries or roles', () => {
  const settings = legacySettings();
  C.migrate(settings, { provider: 'api', base: BASE, model: 'glm-5.3' });
  C.setRole(settings, 'qa', { connection: C.CODEX_ID, model: 'gpt-x', effort: 'high' });
  C.upsert(settings, { kind: 'api', base: BASE, protocol: 'responses', models: [{ model: 'mine' }] });
  assert.equal(C.migrate(settings, { provider: 'api', base: BASE, model: 'other' }), 0);
  assert.equal(C.get(settings, C.apiId(BASE)).models[0].model, 'mine');
  assert.equal(settings.modelRoles.qa.model, 'gpt-x');
});

test('future-version connection lists are left alone', () => {
  const settings = { connections: { version: 9, items: [1] } };
  assert.equal(C.migrate(settings, { base: BASE, model: 'm' }), 0);
  assert.deepEqual(settings.connections, { version: 9, items: [1] });
  assert.equal(C.upsert(settings, { kind: 'codex-cli' }), null);
});

test('credentials in service URLs or keys are never stored', () => {
  const settings = {};
  assert.equal(C.upsert(settings, { kind: 'api', base: 'https://user:pw@x.example.invalid/v1', models: [] }), null);
  C.upsert(settings, { kind: 'api', base: BASE, token: 'sk-secret', apiKey: 'sk-secret', models: [] });
  assert.ok(!JSON.stringify(settings).includes('sk-secret'));
});

test('auto protocol only recognises the official Anthropic address, never model names or relays', () => {
  assert.equal(C.detectProtocol('https://api.anthropic.com', 'auto'), 'anthropic');
  assert.equal(C.detectProtocol('https://api.anthropic.com/v1', 'auto'), 'anthropic');
  assert.equal(C.detectProtocol('https://relay.example.invalid/anthropic', 'auto'), '');
  assert.equal(C.detectProtocol('https://api.anthropic.com.evil.invalid', 'auto'), '');
  assert.equal(C.detectProtocol('http://api.anthropic.com', 'auto'), '');
  assert.equal(C.detectProtocol('https://relay.example.invalid/v1', 'anthropic'), 'anthropic');
  assert.equal(C.detectProtocol('https://api.anthropic.com', 'chat'), 'chat');
});

test('roles resolve independently; translate and vision follow Q&A until chosen', () => {
  const settings = legacySettings();
  C.migrate(settings, { provider: 'api', base: BASE, model: 'glm-5.3' });
  C.setRole(settings, 'translate', { connection: C.CODEX_ID, model: 'gpt-x', effort: 'low' });
  const qa = C.resolveRole(settings, 'qa'), tr = C.resolveRole(settings, 'translate'), vi = C.resolveRole(settings, 'vision');
  assert.equal(qa.provider, 'api'); assert.equal(qa.base, 'https://relay.example.invalid/v1'); assert.equal(qa.entry.label, 'GLM');
  assert.equal(tr.provider, 'openai-auth'); assert.equal(tr.effort, 'low'); assert.equal(tr.followsQa, false);
  assert.equal(vi.model, 'glm-5.3'); assert.equal(vi.followsQa, true);
  assert.equal(C.setRole(settings, 'bogus', { connection: 'x' }), false);
  C.setRole(settings, 'translate', null);
  assert.equal(C.resolveRole(settings, 'translate').followsQa, true);
});

test('Claude entry is hidden by default; roles pointing at it fall back and the old conversation gets one notice', () => {
  const settings = legacySettings();
  C.migrate(settings, { provider: 'api', base: BASE, model: 'glm-5.3' });
  C.setRole(settings, 'translate', { connection: C.CLAUDE_ID, model: 'sonnet' });
  assert.equal(C.resolveRole(settings, 'translate').connection, C.apiId(BASE));
  const first = C.claudeFallback(settings, { provider: 'claude-auth', model: 'sonnet' });
  assert.equal(first.config.provider, 'api'); assert.equal(first.config.model, 'glm-5.3'); assert.equal(first.notice, true);
  const second = C.claudeFallback(settings, { provider: 'claude-auth', model: 'sonnet' });
  assert.equal(second.notice, false); assert.equal(second.message, null);
  assert.equal(C.claudeFallback(settings, { provider: 'api', model: 'm' }), null);
  C.setClaudeCliEnabled(settings, true);
  assert.equal(C.items(settings).some(item => item.kind === 'claude-cli'), true);
  assert.equal(C.resolveRole(settings, 'translate').provider, 'claude-auth');
  assert.equal(C.claudeFallback(settings, { provider: 'claude-auth', model: 'sonnet' }), null);
});

test('effort levels follow the protocol; the anthropic budget table stays internal', () => {
  assert.deepEqual(C.effortLevels('api', 'anthropic').slice(0, 3), ['none', 'minimal', 'low']);
  assert.ok(C.effortLevels('api', 'chat').includes('max'));
  assert.ok(!C.effortLevels('api', 'responses').includes('max'));
  assert.equal(C.effortMapping, undefined);
  assert.equal(C.anthropicBudget('medium'), 8192);
  assert.equal(C.anthropicBudget('ultra'), null);
});

test('ChatGPT login defaults to AI Bro\'s own OAuth; past Codex in-app sign-in users keep their private login; reusing the local Codex login is opt-in', () => {
  const fresh = {};
  C.migrate(fresh, { provider: 'api', base: BASE, model: 'm' });
  assert.equal(C.codexLogin(fresh), 'oauth');
  const returning = {};
  C.migrate(returning, { provider: 'openai-auth' });
  assert.equal(C.codexLogin(returning), 'private');
  assert.equal(C.setCodexLogin(fresh, 'private'), true);
  assert.equal(C.codexLogin(fresh), 'private');
  assert.equal(C.setCodexLogin(fresh, 'shared'), true);
  assert.equal(C.codexLogin(fresh), 'shared');
  assert.equal(C.setCodexLogin(fresh, 'anything'), true);
  assert.equal(C.codexLogin(fresh), 'oauth');
  assert.equal(C.codexLogin({}), 'oauth');
  assert.deepEqual(C.LOGINS, ['oauth', 'private', 'shared']);
});

test('kernel role (P9b): follows Q&A until chosen; can be Codex CLI with the login mode', () => {
  const settings = legacySettings();
  C.migrate(settings, { provider: 'api', base: BASE, model: 'glm-5.3' });
  const follow = C.resolveRole(settings, 'kernel');
  assert.equal(follow.kind, 'api'); assert.equal(follow.followsQa, true); assert.equal(follow.model, 'glm-5.3');
  assert.equal(C.setRole(settings, 'kernel', { connection: C.CODEX_ID, model: 'gpt-x', effort: 'medium' }), true);
  const chosen = C.resolveRole(settings, 'kernel');
  assert.deepEqual([chosen.kind, chosen.model, chosen.effort, chosen.followsQa], ['codex-cli', 'gpt-x', 'medium', false]);
  assert.equal(C.codexLogin(settings), 'oauth');
  assert.equal(C.resolveRole(settings, 'qa').kind, 'api');
});
