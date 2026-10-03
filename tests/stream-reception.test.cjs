const test = require('node:test');
const assert = require('node:assert/strict');
global.WorkstationCore = require('../app/workstation-core.js');
const Reception = require('../app/stream-reception.js');
require('../app/agent-transport.js');
const Progress = require('../app/agent-progress.js');
const Conversation = require('../app/halaska-conversation.js');
const next = () => new Promise(setImmediate);

async function fixture() {
  const originalFetch = global.fetch, originalNow = Date.now;
  let now = 1790928000000, fetches = 0;
  Date.now = () => now;
  const streams = [];
  global.fetch = async () => {
    fetches++;
    return new Response(new ReadableStream({ start(controller) { streams.push(controller); } }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const calls = [];
  function request() {
    const run = { status: 'running', startedAt: now }, message = { live: true, text: '', at: now };
    const events = [], abort = new AbortController();
    const promise = AgentTransport.requestPlan({ base: 'https://synthetic.invalid/v1', model: 'fixture', token: '', protocol: 'responses',
      input: 'synthetic fixture', signal: abort.signal, onReception: event => { events.push(event); run.streamReception = Reception.reduce(run.streamReception, event); },
      onPhase: phase => { run.phase = phase; }, onDelta: text => { message.text = text; }, onActivity: event => Progress.update(message, event) });
    // Attach an immediate rejection handler for intentionally cancelled fixtures.
    promise.catch(() => {});
    const value = { run, message, events, abort, promise,
      projected: () => { const props = Conversation.summaryProps(message, run); return Reception.project(props.streamReception, { live: message.live, phase: props.phase }); } };
    calls.push(value); return value;
  }
  return { request, calls, advance: ms => { now += ms; }, fetches: () => fetches,
    async send(index, event) { streams[index].enqueue(new TextEncoder().encode(typeof event === 'string' ? event : `data: ${JSON.stringify(event)}\n\n`)); await next(); },
    async finish(index) { streams[index].enqueue(new TextEncoder().encode('data: {"type":"response.completed"}\n\n')); streams[index].close(); await calls[index].promise; },
    fail(index) { streams[index].error(new Error('Synthetic connection failure')); },
    async destroy() { for (const call of calls) call.abort.abort(); await Promise.allSettled(calls.map(call => call.promise)); global.fetch = originalFetch; Date.now = originalNow; }
  };
}
test('pending → first content → quiet → resumed → completed follows actual transport receipts only', async () => {
  const f = await fixture();
  try {
    const call = f.request(); await next();
    assert.equal(call.projected().first, true); assert.equal(call.projected().quiet, false);
    f.advance(15000); assert.equal(call.projected().quiet, true); assert.equal(call.projected().seconds, 15);
    await f.send(0, { type: 'response.output_text.delta', delta: 'First actual content' });
    assert.equal(call.projected().quiet, false); assert.equal(call.projected().first, false);
    const receipt = call.run.streamReception, text = call.message.text;
    f.advance(120000);
    await f.send(0, ': provider heartbeat\n\n');
    await f.send(0, { type: 'response.output_text.done', text });
    await f.send(0, { type: 'response.created', usage: { total_tokens: 10 } });
    assert.equal(call.run.streamReception, receipt, 'Heartbeat, identical final text and usage metadata do not imply new content');
    assert.equal(call.projected().quiet, true); assert.equal(call.projected().seconds, 120); assert.equal(call.message.text, text);
    await f.send(0, { type: 'response.output_text.delta', delta: ' and continued content' });
    assert.equal(call.projected().quiet, false); assert.equal(call.message.text, text + ' and continued content');
    await f.finish(0);
    assert.equal(call.projected(), null); assert.equal(call.run.streamReception.outcome, 'completed');
    assert.equal(call.run.status, 'running', 'Transport receipt does not fabricate the application run outcome');
    assert.equal(f.fetches(), 1, 'Quietness never triggers a retry');
  } finally { await f.destroy(); }
});
test('public reasoning and changed tool lifecycle update receipts, but active tools retain their real status', async () => {
  const f = await fixture();
  try {
    const call = f.request(); await next();
    await f.send(0, { type: 'response.reasoning_summary_text.delta', item_id: 'reason', delta: 'Reading the synthetic source' });
    f.advance(20000); assert.equal(call.projected().quiet, true);
    await f.send(0, { type: 'response.reasoning_summary_text.delta', item_id: 'reason', delta: ' with a new observation' });
    assert.equal(call.projected().quiet, false);
    await f.send(0, { type: 'response.tool_activity', id: 'tool1', status: 'running', text: '网页搜索', name: 'search' });
    const receipt = call.run.streamReception;
    f.advance(60000);
    await f.send(0, { type: 'response.tool_activity', id: 'tool1', status: 'running', text: '网页搜索', name: 'search' });
    assert.equal(call.run.streamReception, receipt, 'Repeated running tool event does not reset receipt age');
    assert.equal(Conversation.summaryProps(call.message, call.run).phase, 'tool');
    assert.equal(call.projected(), null, 'A real running tool is not labeled model silence');
    await f.send(0, { type: 'response.tool_activity', id: 'tool1', status: 'completed', text: '网页搜索', name: 'search' });
    assert.notEqual(call.run.streamReception, receipt); assert.equal(call.projected().quiet, false);
  } finally { await f.destroy(); }
});
test('cancel and network failure release quiet state without replacing received text or sending again', async () => {
  for (const cancel of [true, false]) {
    const f = await fixture();
    try {
      const call = f.request(); await next();
      await f.send(0, { type: 'response.output_text.delta', delta: 'Preserve this partial result' });
      f.advance(20000); assert.equal(call.projected().quiet, true);
      if (cancel) call.abort.abort(); else f.fail(0);
      await assert.rejects(call.promise);
      assert.equal(call.projected(), null); assert.equal(call.run.streamReception.outcome, cancel ? 'cancelled' : 'failed');
      assert.equal(call.message.text, 'Preserve this partial result'); assert.equal(f.fetches(), 1);
    } finally { await f.destroy(); }
  }
});
test('later request identity rejects late old content/end and duplicate revisions', async () => {
  const f = await fixture();
  try {
    const first = f.request(); await next();
    const second = f.request(); await next();
    let selected = Reception.reduce(first.run.streamReception, second.events[0]);
    const initial = selected;
    await f.send(0, { type: 'response.output_text.delta', delta: 'Older run text' });
    selected = Reception.reduce(selected, first.run.streamReception);
    assert.equal(selected, initial);
    first.abort.abort(); await assert.rejects(first.promise);
    assert.equal(Reception.reduce(selected, first.run.streamReception), initial);
    await f.send(1, { type: 'response.output_text.delta', delta: 'Current run text' });
    selected = Reception.reduce(selected, second.run.streamReception);
    assert.equal(selected.requestId, second.events[0].requestId);
    assert.equal(Reception.reduce(selected, initial), selected);
    assert.equal(Reception.project(selected, { live: false, phase: 'writing' }), null);
    assert.equal(Reception.project({ ...selected, session: 'earlier-process' }, { live: true, phase: 'writing' }), null);
    await f.finish(1);
    selected = Reception.reduce(selected, second.run.streamReception);
    assert.equal(Reception.reduce(selected, { ...selected, revision: selected.revision + 1, active: true }), selected);
  } finally { await f.destroy(); }
});
test('presentation listener failure cannot change the actual model result', async () => {
  const original = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ output_text: 'actual answer' }), { headers: { 'content-type': 'application/json' } });
  try {
    assert.equal(await AgentTransport.requestPlan({ base: 'https://synthetic.invalid/v1', model: 'fixture', input: 'fixture', protocol: 'responses',
      onReception: () => { throw Error('View detached'); } }), 'actual answer');
  } finally { global.fetch = original; }
});
test('existing protocol fallback creates a new request identity without treating fallback copy as model content', async () => {
  const original = global.fetch;
  let calls = 0, current; const events = [];
  global.fetch = async () => {
    if (++calls === 1) return new Response(JSON.stringify({ message: 'No enabled endpoints are available after routing filters' }), { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Real fallback response' } }] }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const output = await AgentTransport.requestPlan({ base: 'https://reception-fallback.invalid/v1', model: 'fixture', input: 'fixture',
      onReception: event => { events.push(event); current = Reception.reduce(current, event); } });
    assert.equal(output, 'Real fallback response'); assert.equal(calls, 2);
    const starts = events.filter(event => event.revision === 1);
    assert.equal(starts.length, 2); assert.notEqual(starts[0].requestId, starts[1].requestId);
    assert.equal(events.filter(event => event.lastKind === 'commentary').length, 0);
    assert.equal(current.requestId, starts[1].requestId); assert.equal(current.outcome, 'completed');
  } finally { global.fetch = original; }
});
