const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const base = { provider: 'api', base: 'https://relay.example.invalid/v1', model: 'primary', input: 'synthetic input', protocol: 'chat' };
const chat = (delta, finish) => ({ choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] });
const sse = events => new Response(new ReadableStream({ start(stream) { for (const e of events) stream.enqueue(new TextEncoder().encode('data: ' + (e === '[DONE]' ? e : JSON.stringify(e)) + '\n\n')); stream.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
const fail = (status, body = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function harness(fetch) {
  const context = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout, TextDecoder, URL, WorkstationCore: require('../app/workstation-core') });
  for (const file of ['run-failure-diagnostics', 'sse-frame-scanner', 'agent-transport']) vm.runInContext(fs.readFileSync(require.resolve('../app/' + file), 'utf8'), context);
  return context.AgentTransport;
}
const ok = text => sse([chat({ content: text }), chat({}, 'stop'), '[DONE]']);
function watch() {
  const seen = { models: [], attempts: [], activities: [], fallbacks: [] };
  return { seen, handlers: { onAttempt: event => seen.attempts.push({ ...event }), onActivity: item => seen.activities.push(item), onFallback: info => seen.fallbacks.push(info) } };
}
const bodyModel = init => JSON.parse(init.body).model;

test('a rate-limited model that showed nothing falls back to the next model of the same provider', async () => {
  const models = [];
  const transport = harness(async (url, init) => { models.push(bodyModel(init)); return models.length === 1 ? fail(429, { error: { message: 'slow down' } }) : ok('answer from fallback'); });
  const { seen, handlers } = watch();
  const out = await transport.requestPlan({ ...base, fallbackModels: ['backup-1', 'backup-2'], ...handlers });
  assert.match(String(out), /answer from fallback/);
  assert.deepEqual(models.slice(0, 1).concat(models.slice(-1)), ['primary', 'backup-1']);
  assert.ok(!models.includes('backup-2'));
  assert.deepEqual(seen.fallbacks.map(item => [item.from, item.to, item.code]), [['primary', 'backup-1', 'RATE_LIMITED']]);
  assert.ok(seen.activities.some(item => item.name === '备用模型' && /backup-1/.test(item.text)));
  const running = seen.attempts.filter(item => item.status === 'running');
  assert.equal(running.at(-1).model, 'backup-1', 'the attempt names the model that really answered');
  assert.equal(running[0].model, undefined, 'the original model is not renamed');
});

test('fallbacks are tried in order and stop at the end of the list with the last error', async () => {
  const models = [];
  const transport = harness(async (url, init) => { models.push(bodyModel(init)); return fail(503, { error: { message: 'down' } }); });
  const { seen, handlers } = watch();
  await assert.rejects(transport.requestPlan({ ...base, fallbackModels: ['b1', 'b2'], ...handlers }), error => error && /./.test(String(error.message)));
  const order = models.filter((m, i) => i === 0 || m !== models[i - 1]);
  assert.deepEqual(order, ['primary', 'b1', 'b2']);
  assert.equal(seen.fallbacks.length, 2);
});

test('a model that is not available falls back; an authentication error or a bad request never does', async () => {
  let calls = 0;
  const available = harness(async (url, init) => { calls += 1; return bodyModel(init) === 'primary' ? fail(404, { error: { message: 'model not found', code: 'model_not_found' } }) : ok('fine'); });
  assert.match(String(await available.requestPlan({ ...base, fallbackModels: ['b1'] })), /fine/);
  for (const status of [401, 403, 400]) {
    const models = [];
    const transport = harness(async (url, init) => { models.push(bodyModel(init)); return fail(status, { error: { message: 'nope' } }); });
    await assert.rejects(transport.requestPlan({ ...base, fallbackModels: ['b1'] }));
    assert.deepEqual([...new Set(models)], ['primary'], `HTTP ${status} must not switch models`);
  }
});

test('once content was shown nothing is switched, and without a fallback list behaviour is unchanged', async () => {
  const models = [];
  const broken = harness(async (url, init) => { models.push(bodyModel(init)); return sse([chat({ content: 'partial ' })]); });
  await assert.rejects(broken.requestPlan({ ...base, fallbackModels: ['b1'] }));
  assert.deepEqual([...new Set(models)], ['primary']);
  const plain = harness(async (url, init) => fail(429, {}));
  const { seen, handlers } = watch();
  await assert.rejects(plain.requestPlan({ ...base, ...handlers }));
  assert.equal(seen.fallbacks.length, 0);
});

test('accounts and the same model name in the list are ignored', async () => {
  const models = [];
  const transport = harness(async (url, init) => { models.push(bodyModel(init)); return fail(503, {}); });
  await assert.rejects(transport.requestPlan({ ...base, fallbackModels: ['primary', 'primary'] }));
  assert.deepEqual([...new Set(models)], ['primary']);
});
