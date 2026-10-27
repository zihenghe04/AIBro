const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const plain = value => JSON.parse(JSON.stringify(value));
const stream = events => new Response(new ReadableStream({ start(controller) { for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
const done = { type: 'response.completed', response: { output_text: '{"message":"ok","actions":[]}' } };

function transportHarness(fetch) {
  const context = vm.createContext({ fetch, URL, AbortController, setTimeout, clearTimeout, TextDecoder, WorkstationCore: require('../app/workstation-core') });
  vm.runInContext(fs.readFileSync(require.resolve('../app/sse-frame-scanner'), 'utf8') + '\n' + fs.readFileSync(require.resolve('../app/agent-transport'), 'utf8'), context);
  return context.AgentTransport;
}

test('the Codex request carries the shared login mode only when the host says so', async () => {
  const bodies = [];
  const transport = transportHarness(async (url, options) => { bodies.push({ url, body: JSON.parse(options.body) }); return stream([done]); });
  await transport.requestPlan({ provider: 'openai-auth', input: 'a' });
  assert.equal(bodies[0].body.mode, undefined);
  transport.configure({ codexMode: () => 'shared' });
  await transport.requestPlan({ provider: 'openai-auth', input: 'b' });
  assert.equal(bodies[1].url, '/__codex/respond'); assert.equal(bodies[1].body.mode, 'shared');
  await transport.requestPlan({ provider: 'openai-auth', input: 'c', effort: 'high' });
  assert.equal(bodies[2].body.effort, 'high'); assert.equal(bodies[2].body.mode, 'shared');
  transport.configure({ codexMode: () => 'private' });
  await transport.requestPlan({ provider: 'openai-auth', input: 'd' });
  assert.equal(bodies[3].body.mode, undefined);
  transport.configure({ codexMode: () => { throw new Error('host failure'); } });
  await transport.requestPlan({ provider: 'openai-auth', input: 'e' });
  assert.equal(bodies[4].body.mode, undefined);
});

function pickerHarness() {
  const context = vm.createContext({ document: undefined });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(require.resolve('../app/model-picker.js'), 'utf8'), context);
  return context.ConversationModels;
}

test('a retired Claude login falls back to the default model; the host switch brings it back', () => {
  const picker = pickerHarness();
  const old = { modelConfig: { provider: 'claude-auth', model: 'sonnet', effort: '' } };
  assert.equal(plain(picker.configuration(old, { provider: 'api', model: 'gpt-x' })).provider, 'claude-auth');
  let enabled = false; const seen = [];
  picker.configure({ claudeEnabled: () => enabled, claudeFallback: source => { seen.push(source.model); return { provider: 'api', model: 'fallback-model', effort: 'low' }; } });
  assert.deepEqual(plain(picker.configuration(old, { provider: 'api', model: 'gpt-x' })), { provider: 'api', model: 'fallback-model', effort: 'low' });
  assert.deepEqual(seen, ['sonnet']);
  assert.deepEqual(plain(picker.configuration({ modelConfig: { provider: 'api', model: 'keep', effort: '' } }, {})), { provider: 'api', model: 'keep', effort: '' });
  assert.equal(seen.length, 1);
  // Defaults that still say Claude are retired too; with no hook result the API default wins.
  picker.configure({ claudeFallback: () => null });
  assert.equal(plain(picker.configuration({}, { provider: 'claude-auth', model: 'opus' })).provider, 'api');
  enabled = true;
  assert.equal(plain(picker.configuration(old, {})).provider, 'claude-auth');
});
