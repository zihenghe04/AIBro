const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.ModelCatalog = require('../app/model-catalog.js');
const C = require('../app/connections.js');
globalThis.Connections = C;
require('../app/kernel-host.js'); // no host token: loads without starting
const Host = globalThis.AIBroKernelHost;

function settings(login) {
  const s = {};
  C.migrate(s, { provider: 'api', base: 'https://relay.example.invalid/v1', model: 'm-1' });
  C.setCodexLogin(s, login);
  C.setRole(s, 'kernel', { connection: C.CODEX_ID, model: 'gpt-x', effort: 'high' });
  return s;
}

test('the kernel uses AI Bro\'s own ChatGPT channel (Responses + function tools) for the oauth login and keeps the Codex runtime for the CLI logins', () => {
  assert.deepEqual({ ...Host.modelSource({ settings: settings('oauth') }, { request: {} }) }, { kind: 'chatgpt', model: 'gpt-x', effort: 'high' });
  assert.deepEqual({ ...Host.modelSource({ settings: settings('shared') }, { request: {} }) }, { kind: 'codex', mode: 'shared', model: 'gpt-x', effort: 'high' });
  assert.deepEqual({ ...Host.modelSource({ settings: settings('private') }, { request: {} }) }, { kind: 'codex', mode: 'private', model: 'gpt-x', effort: 'high' });
});

test('the ChatGPT route needs no API key and never goes through the generic proxy', () => {
  const source = require('node:fs').readFileSync(require.resolve('../app/kernel-host.js'), 'utf8');
  assert.match(source, /chatgpt\?\{base:'\/__chatgpt',model:source\.model\|\|'',token:'',wire:'responses'\}/);
  assert.match(source, /chatgpt\?'\/__chatgpt\/responses'/);
  assert.match(source, /pause:failure\.code==='chatgpt_quota'/);
});
