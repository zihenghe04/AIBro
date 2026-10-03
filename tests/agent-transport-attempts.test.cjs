const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Flow = require('../app/conversation-flow.js');
const options = { provider: 'api', base: 'https://api.deepseek.com', model: 'fixture', input: 'synthetic input' };
const chat = (delta, finish_reason) => ({ choices: [{ index: 0, delta, ...(finish_reason ? { finish_reason } : {}) }] });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const sse = events => new Response(new ReadableStream({ start(stream) {
  for (const event of events) stream.enqueue(new TextEncoder().encode('data: ' + (event === '[DONE]' ? event : JSON.stringify(event)) + '\n\n'));
  stream.close();
} }), { headers: { 'content-type': 'text/event-stream' } });
function harness(fetch) {
  const context = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout, TextDecoder, URL, WorkstationCore: require('../app/workstation-core') });
  for (const file of ['sse-frame-scanner', 'agent-transport']) vm.runInContext(fs.readFileSync(require.resolve('../app/' + file), 'utf8'), context);
  return context.AgentTransport;
}
function callbacks(message, parentId) {
  const recorder = Flow.create(message), attempts = [], deltas = [], activities = [];
  return {
    attempts, deltas, activities,
    onAttempt(event) { attempts.push({ ...event }); if (event.status !== 'running') recorder.settleAttempt(event.id, event.status, { parentId }); },
    onActivity(value) { activities.push({ ...value }); recorder.activity(value, { parentId }); },
    // Fixture values are already safe user-visible prose; production host must
    // project its reviewed JSON message before passing text into the recorder.
    onDelta(text, delta, meta) { deltas.push({ text, delta, ...meta }); recorder.response(meta.attemptId, text, { parentId }); }
  };
}

test('repeated Chat rounds share callback identity within one request but retain separate prose and reasoning', async () => {
  let round = 0;
  const transport = harness(async () => {
    const number = ++round;
    return sse([chat({ reasoning_content: 'thinking ' + number }), chat({ content: 'answer ' }), chat({ content: String(number) }), '[DONE]']);
  });
  const message = {}, seen = callbacks(message);
  await transport.requestPlan({ ...options, ...seen });
  await transport.requestPlan({ ...options, ...seen });
  assert.deepEqual(seen.attempts.map(item => item.status), ['running', 'completed', 'running', 'completed']);
  const [a1, , a2] = seen.attempts;
  assert.notEqual(a1.id, a2.id);
  assert.deepEqual(seen.deltas.map(item => item.attemptId), [a1.id, a1.id, a2.id, a2.id]);
  assert.deepEqual(seen.deltas.map(item => item.delta), ['answer ', '1', 'answer ', '2']);
  assert.ok(seen.activities.every(item => [a1.id, a2.id].includes(item.attemptId)));
  assert.deepEqual(message.conversationFlow.items.map(item => [item.kind, item.text, item.status]), [
    ['reasoning', 'thinking 1', 'completed'], ['response', 'answer 1', 'completed'],
    ['reasoning', 'thinking 2', 'completed'], ['response', 'answer 2', 'completed']
  ]);
});

test('Responses delta and completed envelope carry the same attempt ID', async () => {
  const transport = harness(async () => sse([
    { type: 'response.reasoning_summary_text.delta', item_id: 'reasoning', delta: 'actual summary' },
    { type: 'response.output_text.delta', item_id: 'answer', delta: 'partial' },
    { type: 'response.completed', response: { output_text: 'final correction' } }
  ]));
  const message = {}, seen = callbacks(message);
  assert.equal(await transport.requestPlan({ ...options, ...seen, protocol: 'responses' }), 'final correction');
  assert.equal(new Set([...seen.deltas, ...seen.activities].map(item => item.attemptId)).size, 1);
  assert.equal(seen.deltas.at(-1).delta, undefined, 'full envelope correction keeps the previous callback contract');
  assert.deepEqual(message.conversationFlow.items.map(item => [item.text, item.status]), [['actual summary', 'completed'], ['final correction', 'completed']]);
});

test('protocol fallback is two attempts and its generated diagnostic is excluded from model flow', async () => {
  let fetches = 0;
  const transport = harness(async () => ++fetches === 1
    ? json({ error: { message: 'unknown endpoint' } }, 404)
    : json({ choices: [{ message: { content: 'answer', reasoning_content: 'real reasoning' } }] }));
  const message = {}, seen = callbacks(message);
  await transport.requestPlan({ ...options, ...seen, base: 'https://protocol-fallback-fixture.invalid' });
  assert.deepEqual(seen.attempts.map(item => item.status), ['running', 'failed', 'running', 'completed']);
  assert.notEqual(seen.attempts[0].id, seen.attempts[2].id);
  assert.equal(seen.deltas[0].attemptId, seen.attempts[2].id);
  assert.equal(seen.activities[0].source, 'transport');
  assert.deepEqual(message.conversationFlow.items.map(item => item.text), ['real reasoning', 'answer']);
});

test('context retry gets a fresh attempt while transport recovery commentary never becomes reasoning', async () => {
  let fetches = 0;
  const transport = harness(async () => ++fetches === 1
    ? json({ error: { code: 'context_length_exceeded', message: 'maximum context length exceeded' } }, 400)
    : json({ choices: [{ message: { content: 'recovered' } }] }));
  const message = {}, seen = callbacks(message);
  await transport.requestPlan({ ...options, ...seen, input: 'long original input', recoverInput: () => 'short' });
  assert.deepEqual(seen.attempts.map(item => item.status), ['running', 'failed', 'running', 'completed']);
  assert.notEqual(seen.attempts[0].id, seen.attempts[2].id);
  assert.equal(seen.activities[0].source, 'transport');
  assert.equal(seen.activities[0].attemptId, seen.attempts[0].id);
  assert.deepEqual(message.conversationFlow.items.map(item => [item.text, item.attemptId]), [['recovered', seen.attempts[2].id]]);
});

test('stream cancellation settles received text and prevents later frames in the same network chunk', async () => {
  const controller = new AbortController();
  const transport = harness(async () => sse([chat({ content: 'partial' }), chat({ content: ' MUST NOT PUBLISH' }), '[DONE]']));
  const message = {}, seen = callbacks(message);
  await assert.rejects(transport.requestPlan({ ...options, ...seen, signal: controller.signal,
    onDelta(...args) { seen.onDelta(...args); controller.abort(); }
  }), { code: 'CANCELLED' });
  assert.deepEqual(seen.attempts.map(item => item.status), ['running', 'cancelled']);
  assert.equal(seen.deltas.length, 1);
  assert.deepEqual(message.conversationFlow.items.map(item => [item.text, item.status]), [['partial', 'cancelled']]);
});

test('cancelling from attempt start sends no request and emits exactly one terminal status', async () => {
  const controller = new AbortController(); let fetches = 0;
  const transport = harness(async () => { fetches++; return json({ output_text: 'must not send' }); });
  const attempts = [];
  await assert.rejects(transport.requestPlan({ ...options, signal: controller.signal, onAttempt(value) {
    attempts.push({ ...value }); if (value.status === 'running') controller.abort();
  } }), { code: 'CANCELLED' });
  assert.equal(fetches, 0);
  assert.deepEqual(attempts.map(item => item.status), ['running', 'cancelled']);
});

test('failed JSON and incomplete streams settle once without marking success or inventing prose', async () => {
  for (const response of [
    () => json({ error: { message: 'unauthorized' } }, 401),
    () => sse([chat({ reasoning_content: 'received partial reasoning' })])
  ]) {
    const transport = harness(async () => response()), message = {}, seen = callbacks(message);
    await assert.rejects(transport.requestPlan({ ...options, ...seen }));
    assert.deepEqual(seen.attempts.map(item => item.status), ['running', 'failed']);
    assert.ok(message.conversationFlow.items.every(item => item.kind === 'reasoning' && item.status === 'failed'));
  }
});

test('child attempt identity stays scoped to the explicit parent without polluting main prose', async () => {
  const transport = harness(async () => json({ choices: [{ message: { content: 'child answer', reasoning: 'child public reasoning' } }] }));
  const message = { text: 'child answer' }, seen = callbacks(message, 'delegate-call');
  await transport.requestPlan({ ...options, ...seen });
  assert.ok(message.conversationFlow.items.every(item => item.parentId === 'delegate-call' && item.status === 'completed'));
  assert.equal(Flow.entries(message).length, 2, 'child response is never deduped against main text');
});

test('unsupported input validation and a pre-aborted signal do not invent network attempts', async () => {
  let fetches = 0;
  const transport = harness(async () => { fetches++; return json({ output_text: 'unexpected' }); });
  const attempts = [], controller = new AbortController(); controller.abort();
  await assert.rejects(transport.requestPlan({ ...options, signal: controller.signal, onAttempt: value => attempts.push(value) }), { code: 'CANCELLED' });
  await assert.rejects(transport.requestPlan({ ...options, webSearch: 'yes', onAttempt: value => attempts.push(value) }), { code: 'INVALID_WEB_SEARCH' });
  assert.deepEqual(attempts, []); assert.equal(fetches, 0);
});

test('host cancellation rejection settles the attempt as cancelled without claiming provider success', async () => {
  const transport = harness(async () => sse([chat({ content: 'received' }), '[DONE]']));
  const message = {}, seen = callbacks(message);
  await assert.rejects(transport.requestPlan({ ...options, ...seen, onDelta(...args) {
    seen.onDelta(...args); throw Object.assign(new Error('host cancelled'), { code: 'CANCELLED' });
  } }), { code: 'CANCELLED' });
  assert.deepEqual(seen.attempts.map(item => item.status), ['running', 'cancelled']);
  assert.equal(message.conversationFlow.items[0].status, 'cancelled');
});
