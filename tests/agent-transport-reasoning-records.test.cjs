const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(fetch, globals = {}) {
  const context = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout, TextDecoder, URL, WorkstationCore: require('../app/workstation-core'), ...globals });
  for (const file of ['sse-frame-scanner', 'agent-transport', 'agent-progress']) vm.runInContext(fs.readFileSync(require.resolve('../app/' + file), 'utf8'), context);
  return { transport: context.AgentTransport, progress: context.AgentProgress };
}
const options = { provider: 'api', base: 'https://api.deepseek.com', model: 'synthetic-reasoner', input: 'synthetic input' };
const chat = (delta, extra = {}) => ({ choices: [{ index: 0, delta, ...extra }] });
const sse = events => new Response(new ReadableStream({ start(controller) {
  for (const event of events) controller.enqueue(new TextEncoder().encode('data: ' + (event === '[DONE]' ? event : JSON.stringify(event)) + '\n\n'));
  controller.close();
} }), { headers: { 'content-type': 'text/event-stream' } });
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

test('successive Chat requests retain separate reasoning records while deltas and settlement share an ID', async () => {
  let turn = 0, now = 10;
  const { transport, progress } = harness(async () => {
    const number = ++turn;
    return sse([chat({ reasoning_content: `round ${number}\n` }), chat({ reasoning_content: 'exact second part' }), chat({ content: `answer ${number}` }), chat({}, { finish_reason: 'stop' }), '[DONE]']);
  });
  const message = {}, events = [];
  for (let round = 1; round <= 2; round++) {
    const seen = [];
    assert.equal(await transport.requestPlan({ ...options, onActivity: activity => { seen.push(activity); progress.update(message, activity, now++); } }), `answer ${round}`);
    assert.equal(new Set(seen.map(item => item.id)).size, 1, 'deltas and completion update their own record');
    assert.equal(seen.at(-1).status, 'completed');
    events.push(seen);
  }
  assert.notEqual(events[0][0].id, events[1][0].id, 'another provider round gets a distinct ID');
  assert.deepEqual(JSON.parse(JSON.stringify(message.activities.map(item => item.text))), ['round 1\nexact second part', 'round 2\nexact second part']);
  assert.ok(message.activities[0].at < message.activities[1].at, 'the second round belongs at its actual later position');
});

test('successive Responses requests cannot collide when the provider reuses an item ID', async () => {
  let turn = 0;
  const { transport, progress } = harness(async () => {
    const text = `summary ${++turn}`;
    return sse([
      { type: 'response.reasoning_summary_text.delta', item_id: 'reused-item', summary_index: 0, delta: text },
      { type: 'response.reasoning_summary_text.done', item_id: 'reused-item', summary_index: 0, text },
      { type: 'response.output_text.delta', delta: 'answer' },
      { type: 'response.completed' }
    ]);
  });
  const message = {};
  for (let index = 0; index < 2; index++) await transport.requestPlan({ ...options, protocol: 'responses', onActivity: activity => progress.update(message, activity) });
  assert.equal(message.activities.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(message.activities.map(item => [item.text, item.status]))), [['summary 1', 'completed'], ['summary 2', 'completed']]);
});

test('JSON Chat records returned reasoning text before the answer without mixing channels', async () => {
  for (const key of ['reasoning_content', 'reasoning']) {
    const original = '  synthetic reasoning\n第二行 😀  ', events = [], order = [];
    const { transport } = harness(async () => json({ choices: [{ message: { content: 'synthetic answer', [key]: original }, finish_reason: 'stop' }] }));
    assert.equal(await transport.requestPlan({ ...options, onActivity: activity => { events.push(activity); order.push('reasoning'); }, onDelta: output => { assert.equal(output, 'synthetic answer'); order.push('answer'); } }), 'synthetic answer');
    assert.deepEqual(order, ['reasoning', 'answer']);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'summary');
    assert.equal(events[0].status, 'completed');
    assert.equal(events[0].text, original, 'preserve exact returned text including whitespace');
  }
});

test('missing reasoning creates no record and unsupported or encrypted fields stay excluded', async () => {
  const responses = [
    () => json({ choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }] }),
    () => json({ choices: [{ message: { content: 'answer', reasoning_content: { text: 'unsupported' }, encrypted_content: 'synthetic encrypted' }, finish_reason: 'stop' }] }),
    () => sse([chat({ content: 'answer' }), '[DONE]']),
    () => json({ output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'unsupported raw reasoning' }], encrypted_content: 'synthetic encrypted' }, { type: 'message', content: [{ type: 'output_text', text: 'answer' }] }] })
  ];
  for (const response of responses) {
    const seen = [], { transport } = harness(async () => response());
    assert.equal(await transport.requestPlan({ ...options, onActivity: activity => seen.push(activity) }), 'answer');
    assert.equal(seen.length, 0);
  }
});

test('cancelling on JSON reasoning preserves that record and publishes no later answer', async () => {
  const controller = new AbortController(), seen = [], output = [];
  const { transport } = harness(async () => json({ choices: [{ message: { content: 'must not publish', reasoning_content: 'received before stop' }, finish_reason: 'stop' }] }));
  await assert.rejects(transport.requestPlan({ ...options, signal: controller.signal, onActivity: activity => { seen.push(activity); controller.abort(); }, onDelta: value => output.push(value) }), { code: 'CANCELLED' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, 'received before stop');
  assert.equal(output.length, 0);
});

test('cancelling a reasoning stream keeps received text without inventing completion', async () => {
  const controller = new AbortController(), seen = [], output = [];
  const { transport } = harness(async () => new Response(new ReadableStream({ start(stream) {
    stream.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(chat({ reasoning_content: 'partial reasoning' })) + '\n\n'));
  } }), { headers: { 'content-type': 'text/event-stream' } }));
  await assert.rejects(transport.requestPlan({ ...options, signal: controller.signal, onActivity: activity => { seen.push(activity); controller.abort(); }, onDelta: value => output.push(value) }), { code: 'CANCELLED' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, 'partial reasoning');
  assert.equal(seen[0].status, 'running', 'the host applies its cancelled lifecycle; transport must not claim completion');
  assert.equal(output.length, 0);
});

test('request-scoped provider tool IDs retain their name through lifecycle events', async () => {
  const seen = [];
  const { transport } = harness(async () => sse([
    { type: 'response.output_item.added', item: { type: 'mcp_call', id: 'same-tool', name: 'synthetic-tool', status: 'in_progress' } },
    { type: 'response.mcp_call.completed', item_id: 'same-tool' },
    { type: 'response.output_text.delta', delta: 'answer' },
    { type: 'response.completed' }
  ]));
  await transport.requestPlan({ ...options, protocol: 'responses', onActivity: activity => seen.push(activity) });
  assert.equal(new Set(seen.map(item => item.id)).size, 1);
  assert.equal(seen.at(-1).name, 'synthetic-tool');
  assert.equal(seen.at(-1).status, 'completed');
});

test('restored reasoning records stay distinct across independent module loads with UUID and fallback sessions', async () => {
  for (const useCrypto of [true, false]) {
    let message = {};
    for (let round = 0; round < 2; round++) {
      const fixedMath = Object.create(Math); fixedMath.random = () => round ? 0.75 : 0.25;
      const globals = useCrypto
        ? { crypto: { randomUUID: () => `${round + 1}0000000-0000-4000-8000-000000000000` } }
        : { Date: class extends Date { static now() { return 1; } }, Math: fixedMath };
      const { transport, progress } = harness(async () => sse([chat({ reasoning_content: `reload ${round}` }), chat({ content: 'answer' }), '[DONE]']), globals);
      await transport.requestPlan({ ...options, onActivity: activity => progress.update(message, activity, 10 + round) });
      message = JSON.parse(JSON.stringify(message));
    }
    assert.equal(message.activities.length, 2, useCrypto ? 'UUID session must survive a reload' : 'same-clock fallback sessions must stay distinct');
    assert.deepEqual(message.activities.map(item => item.text), ['reload 0', 'reload 1']);
    assert.notEqual(message.activities[0].id, message.activities[1].id);
  }
});

test('long provider identities and different summary indexes stay distinct below the progress ID limit', async () => {
  const itemId = 'provider-'.padEnd(160, 'x'), message = {};
  const { transport, progress } = harness(async () => sse([
    ...[0, 1].map(index => ({ type: 'response.reasoning_summary_text.done', item_id: itemId, summary_index: index, text: `part ${index}` })),
    { type: 'response.reasoning_summary_text.done', item_id: itemId.slice(0, -1) + 'y', summary_index: 0, text: 'other item' },
    { type: 'response.output_text.delta', delta: 'answer' }, { type: 'response.completed' }
  ]), { crypto: { randomUUID: () => '10000000-0000-4000-8000-000000000000' } });
  await transport.requestPlan({ ...options, protocol: 'responses', onActivity: activity => { assert.ok(activity.id.length <= 180); progress.update(message, activity); } });
  assert.equal(message.activities.length, 3);
  assert.equal(new Set(message.activities.map(item => item.id)).size, 3);
});

test('separate context recovery attempts keep their own commentary records', async () => {
  let request = 0;
  const seen = [];
  const { transport } = harness(async () => ++request % 2
    ? new Response(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'maximum context length exceeded' } }), { status: 400, headers: { 'content-type': 'application/json' } })
    : json({ choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }] }));
  for (let attempt = 0; attempt < 2; attempt++) await transport.requestPlan({ ...options, input: 'long synthetic input for recovery', recoverInput: () => 'short', onActivity: activity => seen.push(activity) });
  assert.equal(seen.length, 2);
  assert.ok(seen.every(item => item.kind === 'commentary' && item.id.includes('context-recovery')));
  assert.notEqual(seen[0].id, seen[1].id);
});
