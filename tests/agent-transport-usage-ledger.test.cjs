const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const Usage = require('../app/agent-usage'), Flow = require('../app/conversation-flow');
const route = { provider: 'api', model: 'fixture' }, options = { ...route, base: 'https://fixture.invalid/v1', input: 'synthetic only', protocol: 'chat' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const chat = (usage, text = 'answer', reason = 'stop') => ({ choices: [{ index: 0, delta: { content: text }, finish_reason: reason }], ...(usage ? { usage } : {}) });
const sse = events => new Response(events.map(value => 'data: ' + (value === '[DONE]' ? value : JSON.stringify(value)) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
function harness(fetch) {
 const ctx = vm.createContext({ fetch, AbortController, TextDecoder, URL, WorkstationCore: require('../app/workstation-core') });
 for (const file of ['sse-frame-scanner', 'agent-transport']) vm.runInContext(fs.readFileSync(require.resolve('../app/' + file), 'utf8'), ctx);
 const run = {}, message = {}, ledger = Usage.create(run, message), flow = Flow.create(message), seen = [];
 return { transport: ctx.AgentTransport, run, message, ledger, seen, callbacks: {
  onAttempt(event) { ledger.attempt(event, route); if (event.status !== 'running') flow.settleAttempt(event.id, event.status); },
  onUsage(value, meta) { seen.push(JSON.parse(JSON.stringify({ value, meta }))); ledger.report(value, meta); },
  onDelta(text, delta, meta) { flow.response(meta.attemptId, text); }
 } };
}

test('real transport identities count cumulative duplicate packets once and survive multiple model rounds', async () => {
 let n = 0; const h = harness(async () => sse([chat({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }), chat({ prompt_tokens: ++n * 100, completion_tokens: 10, total_tokens: n * 100 + 10 }), chat({ prompt_tokens: n * 100, completion_tokens: 10, total_tokens: n * 100 + 10 }), '[DONE]']));
 for (let i = 0; i < 3; i++) await h.transport.requestPlan({ ...options, ...h.callbacks });
 assert.equal(h.run.usage.total, 630); assert.equal(h.run.usage.attempts, 3); assert.equal(h.seen.length, 9); assert.equal(new Set(h.seen.map(x => x.meta.attemptId)).size, 3);
 assert.ok(h.run.usageLedger.attempts.every(a => a.status === 'completed')); assert.equal(h.message.conversationFlow.items.length, 3);
});

test('non-stream Chat and Responses capture usage, including failures with real reported tokens', async () => {
 for (const value of [{ choices: [{ message: { content: 'answer' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }, { response: { output_text: 'answer', usage: { input_tokens: 3, output_tokens: 4 } } }]) {
  const h = harness(async () => json(value)); await h.transport.requestPlan({ ...options, ...h.callbacks });
  assert.equal(h.run.usage.total, 7); assert.equal(h.run.usageLedger.attempts[0].totalSource, 'components');
 }
 const h = harness(async () => json({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }));
 await assert.rejects(h.transport.requestPlan({ ...options, ...h.callbacks }), { code: 'STREAM_ERROR' }); assert.equal(h.run.usage.total, 7); assert.equal(h.run.usage.complete, false);
});

test('Responses failure envelope keeps usage before propagating failure and preserves flow status', async () => {
 const h = harness(async () => sse([{ type: 'response.output_text.delta', delta: 'partial' }, { type: 'response.failed', response: { status: 'failed', error: { message: 'synthetic failure' }, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }]));
 await assert.rejects(h.transport.requestPlan({ ...options, protocol: 'responses', ...h.callbacks }));
 assert.equal(h.run.usage.total, 12); assert.equal(h.run.usageLedger.attempts[0].status, 'failed'); assert.equal(h.message.conversationFlow.items[0].status, 'failed');
});

test('protocol fallback and context retry register distinct attempts without inventing missing usage', async () => {
 for (const context of [false, true]) {
  let n = 0; const h = harness(async () => ++n === 1 ? json({ error: { message: context ? 'maximum context length exceeded' : 'unknown endpoint', ...(context ? { code: 'context_length_exceeded' } : {}) } }, context ? 400 : 404) : json({ output_text: 'answer', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }));
  await h.transport.requestPlan({ ...options, ...h.callbacks, protocol: context ? 'chat' : 'auto', ...(context ? { input: 'long input', recoverInput: () => 'short' } : {}) });
  assert.equal(h.run.usage.total, 12); assert.equal(h.run.usage.attempts, 2); assert.equal(h.run.usage.reportedAttempts, 1); assert.equal(h.run.usage.complete, false);
  assert.deepEqual(h.run.usageLedger.attempts.map(a => a.status), ['failed', 'completed']);
 }
});

test('HTTP error usage is attributed before fallback settles the old attempt', async () => {
 let n = 0; const h = harness(async () => ++n === 1 ? json({ error: { message: 'unknown endpoint' }, usage: { total_tokens: 5 } }, 404) : json({ output_text: 'answer', usage: { total_tokens: 12 } }));
 await h.transport.requestPlan({ ...options, protocol: 'auto', ...h.callbacks }); assert.equal(h.run.usage.total, 17); assert.equal(h.run.usage.reportedAttempts, 2);
 assert.notEqual(h.seen[0].meta.attemptId, h.seen[1].meta.attemptId);
});

test('cancellation retains prior real usage and blocks later packets in the same chunk', async () => {
 const controller = new AbortController(); const h = harness(async () => sse([chat({ total_tokens: 12 }), chat({ total_tokens: 999 }), '[DONE]']));
 await assert.rejects(h.transport.requestPlan({ ...options, ...h.callbacks, signal: controller.signal, onUsage(value, meta) { h.callbacks.onUsage(value, meta); controller.abort(); } }), { code: 'CANCELLED' });
 assert.equal(h.run.usage.total, 12); assert.equal(h.seen.length, 1); assert.equal(h.run.usageLedger.attempts[0].status, 'cancelled'); assert.equal(h.run.usage.complete, false);
});

test('cancel without usage and validation before request do not invent zero-cost receipts', async () => {
 const controller = new AbortController(); const h = harness(async () => { throw Error('must not send'); });
 await assert.rejects(h.transport.requestPlan({ ...options, ...h.callbacks, signal: controller.signal, onAttempt(e) { h.callbacks.onAttempt(e); controller.abort(); } }), { code: 'CANCELLED' });
 assert.equal(h.run.usage.total, null); assert.equal(h.run.usage.reportedAttempts, 0);
 const v = harness(async () => { throw Error('must not send'); }); await assert.rejects(v.transport.requestPlan({ ...options, ...v.callbacks, webSearch: 'bad' })); assert.equal(v.run.usageLedger.attempts.length, 0);
});

test('zero, null, missing, invalid and component-only packets keep precise known fields', async () => {
 const cases = [
  [{ input_tokens: 0, output_tokens: 0, total_tokens: 0 }, { input: 0, output: 0, total: 0 }],
  [{ input_tokens: null, output_tokens: null, total_tokens: 8 }, { input: null, output: null, total: 8 }],
  [{ input_tokens: 3, output_tokens: 4 }, { input: 3, output: 4, total: 7 }],
  [{ input_tokens: 3 }, { input: 3, output: null, total: null }],
  [{ input_tokens: false, output_tokens: '', total_tokens: -2 }, null],
  [{ input_tokens: 1.5, output_tokens: Infinity, total_tokens: Number.MAX_SAFE_INTEGER + 1 }, null]
 ];
 for (const [wire, expected] of cases) { const h = harness(async () => json({ output_text: 'answer', usage: wire })); await h.transport.requestPlan({ ...options, ...h.callbacks }); assert.deepEqual(h.run.usageLedger.attempts[0].usage, expected); }
});
