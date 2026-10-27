'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const encoder = new TextEncoder();
const plain = value => JSON.parse(JSON.stringify(value));
const KEY = 'sk-ant-test-FAKE-KEY';
function harness(fetch) {
  const c = vm.createContext({ fetch, crypto: webcrypto, AbortController, TextDecoder, TextEncoder, URL, Response, ReadableStream, setTimeout, clearTimeout, WorkstationCore: require('../app/workstation-core.js') });
  for (const f of ['model-catalog', 'connections', 'sse-frame-scanner', 'stream-reception', 'run-failure-diagnostics', 'agent-retry', 'anthropic-transport', 'agent-transport']) vm.runInContext(fs.readFileSync(require.resolve('../app/' + f + '.js'), 'utf8'), c);
  return { transport: c.AgentTransport, anthropic: c.AnthropicTransport };
}
const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const text = (index, value) => sse('content_block_delta', { index, delta: { type: 'text_delta', text: value } });
const normal = [
  sse('message_start', { message: { id: 'm1', usage: { input_tokens: 25, output_tokens: 1 } } }),
  sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
  sse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'secret reasoning' } }),
  sse('content_block_stop', { index: 0 }),
  sse('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
  sse('ping', {}),
  text(1, '{"message":"你'), text(1, '好","actions":[]}'),
  sse('content_block_stop', { index: 1 }),
  sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } }),
  sse('message_stop', {})
];
function stream(chunks, { split = false, hang = false, signal } = {}) {
  const bytes = encoder.encode(chunks.join(''));
  return new Response(new ReadableStream({
    start(c) {
      if (split) for (const b of bytes) c.enqueue(Uint8Array.of(b)); else c.enqueue(bytes);
      if (!hang) c.close(); else signal?.addEventListener('abort', () => { try { c.error(new DOMException('aborted', 'AbortError')); } catch (_) {} });
    }
  }), { headers: { 'content-type': 'text/event-stream' } });
}
function fixture(chunks = normal, options = {}) {
  const requests = [];
  const h = harness(async (url, o) => { requests.push({ url, ...o }); return options.respond ? options.respond(o) : stream(chunks, { ...options, signal: o.signal }); });
  return { ...h, requests };
}
const opts = { provider: 'api', base: 'https://api.anthropic.com', model: 'claude-test-1', token: KEY, protocol: 'auto', input: [{ role: 'developer', content: [{ type: 'input_text', text: 'JSON only' }] }, { role: 'user', content: [{ type: 'input_text', text: '你好' }] }] };

test('official address with auto protocol streams Messages events through the proxy with the right headers and body', async () => {
  const f = fixture(normal, { split: true }), deltas = [], activities = [], attempts = [], usage = [], reception = [];
  const out = await f.transport.requestPlan({ ...opts, onDelta: (t, d, m) => deltas.push({ t, d, ...m }), onActivity: e => activities.push(e), onAttempt: e => attempts.push(e), onUsage: (u, m) => usage.push({ u, ...m }), onReception: e => reception.push(e) });
  assert.equal(out, '{"message":"你好","actions":[]}');
  const request = f.requests[0];
  assert.equal(request.url, '/__proxy?url=' + encodeURIComponent('https://api.anthropic.com/v1/messages'));
  assert.equal(request.headers['X-Api-Key'], KEY); assert.equal(request.headers['Anthropic-Version'], '2023-06-01'); assert.equal(request.headers.Authorization, undefined);
  const body = JSON.parse(request.body);
  assert.deepEqual(plain(body), { model: 'claude-test-1', max_tokens: 16384, stream: true, system: 'JSON only', messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] });
  assert.ok(!request.body.includes(KEY));
  assert.equal(deltas.at(-1).t, out); assert.equal(deltas[0].attemptId, attempts[0].id);
  assert.deepEqual(plain(attempts.map(e => e.status)), ['running', 'completed']);
  assert.deepEqual(plain(activities.map(e => [e.text, e.status])), [['正在思考', 'running'], ['正在思考', 'completed']]);
  assert.ok(!JSON.stringify(activities).includes('secret reasoning'));
  assert.deepEqual(plain(usage.at(-1).u), { input: 25, output: 12, total: 37 }); assert.equal(usage.at(-1).totalSource, 'components');
  assert.equal(reception.at(-1).outcome, 'completed');
});

test('auto never selects Anthropic from the model name or a relay address', async () => {
  const f = fixture([sse('x', {})], { respond: () => new Response('{"error":{"message":"nope"}}', { status: 401 }) });
  await assert.rejects(f.transport.requestPlan({ ...opts, base: 'https://relay.example.invalid/v1', model: 'claude-sonnet-x' }));
  assert.ok(f.requests[0].url.includes(encodeURIComponent('/responses')));
  assert.equal(f.requests[0].headers['X-Api-Key'], undefined);
});

test('explicit anthropic protocol works on a custom address and normalises the endpoint', () => {
  const { anthropic } = fixture();
  assert.equal(anthropic.endpoint('https://relay.example.invalid'), 'https://relay.example.invalid/v1/messages');
  assert.equal(anthropic.endpoint('https://relay.example.invalid/v1/'), 'https://relay.example.invalid/v1/messages');
  assert.equal(anthropic.endpoint('https://relay.example.invalid/api/v1/messages'), 'https://relay.example.invalid/api/v1/messages');
  assert.throws(() => anthropic.endpoint('https://u:p@relay.example.invalid'));
});

test('thinking effort maps to budget_tokens and raises max_tokens above it; none and auto send nothing', () => {
  const { anthropic } = fixture();
  const build = effort => anthropic.buildRequest({ model: 'm', input: 'hi', effort });
  assert.equal(build('').thinking, undefined); assert.equal(build('auto').thinking, undefined); assert.equal(build('none').thinking, undefined);
  assert.deepEqual(plain(build('low').thinking), { type: 'enabled', budget_tokens: 2048 });
  const high = build('high'); assert.equal(high.thinking.budget_tokens, 16384); assert.ok(high.max_tokens > high.thinking.budget_tokens);
  const max = build('max'); assert.ok(max.max_tokens > max.thinking.budget_tokens);
  assert.throws(() => build('ultra'), { code: 'EFFORT_UNSUPPORTED' });
});

test('input conversion: images become blocks, same-role runs merge, files and unknown parts fail before sending', async () => {
  const { anthropic } = fixture();
  const png = 'data:image/png;base64,AAAA';
  const { system, messages } = anthropic.convertInput([
    { role: 'system', content: [{ type: 'input_text', text: 'A' }] }, { role: 'developer', content: 'B' },
    { role: 'assistant', content: [{ type: 'output_text', text: '先答' }] },
    { role: 'user', content: [{ type: 'input_text', text: '看图' }, { type: 'input_image', image_url: png }] }, { role: 'user', content: [{ type: 'input_text', text: '再问' }] }, { role: 'user', content: [{ type: 'input_text', text: '   ' }] }
  ]);
  assert.equal(system, 'A\n\nB');
  assert.deepEqual(plain(messages.map(m => m.role)), ['user', 'assistant', 'user']);
  assert.deepEqual(plain(messages[2].content[1]), { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  assert.equal(messages[2].content.length, 3);
  assert.throws(() => anthropic.convertInput([{ role: 'user', content: [{ type: 'input_file', file_id: 'f' }] }]), { code: 'PROTOCOL_UNSUPPORTED' });
  assert.throws(() => anthropic.convertInput([{ role: 'user', content: [{ type: 'input_image', image_url: 'http://x.invalid/a.png' }] }]), { code: 'PROTOCOL_UNSUPPORTED' });
  assert.throws(() => anthropic.convertInput([{ role: 'user', content: [{ type: 'weird' }] }]), { code: 'PROTOCOL_UNSUPPORTED' });
  const f = fixture();
  await assert.rejects(f.transport.requestPlan({ ...opts, webSearch: true }), { code: 'WEB_SEARCH_UNSUPPORTED' });
  await assert.rejects(f.transport.requestPlan({ ...opts, requirePlanProtocol: true, nativeTools: [{ name: 't' }] }), { code: 'PROTOCOL_UNSUPPORTED' });
  assert.equal(f.requests.length, 0);
});

test('cancelling aborts the fetch and settles the attempt as cancelled', async () => {
  const f = fixture([sse('message_start', { message: { usage: { input_tokens: 1 } } })], { hang: true });
  const controller = new AbortController(), attempts = [];
  const pending = f.transport.requestPlan({ ...opts, signal: controller.signal, onAttempt: e => attempts.push(e.status) });
  await new Promise(r => setTimeout(r, 30)); controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal(f.requests[0].signal.aborted, true); assert.deepEqual(plain(attempts), ['running', 'cancelled']);
});

test('truncated, refused, error and tool-block streams never count as success', async () => {
  const head = [sse('message_start', { message: { usage: { input_tokens: 1 } } }), sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }), text(0, '{"a":1}')];
  const run = chunks => { const f = fixture(chunks); return f.anthropic.request(opts, { errorFrom: (r, b) => Object.assign(new Error(b), { code: 'HTTP' }) }); };
  await assert.rejects(run(head), { code: 'STREAM_INCOMPLETE' });
  await assert.rejects(run([...head, sse('message_delta', { delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 9 } }), sse('message_stop', {})]), { code: 'OUTPUT_LIMIT' });
  await assert.rejects(run([...head, sse('message_delta', { delta: { stop_reason: 'refusal' } }), sse('message_stop', {})]), { code: 'MODEL_REFUSED' });
  await assert.rejects(run([...head, sse('error', { error: { type: 'overloaded_error', message: 'busy' } })]), { code: 'HTTP' });
  await assert.rejects(run([head[0], sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 't', name: 'x', input: {} } })]), { code: 'MODEL_PROTOCOL_ERROR' });
  await assert.rejects(run([head[0], sse('message_delta', { delta: { stop_reason: 'end_turn' } }), sse('message_stop', {})]), { code: 'EMPTY_RESPONSE' });
});

test('HTTP errors keep fixed guidance: context overflow is recognised and the key is never echoed', async () => {
  const body = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `prompt is too long: 300000 tokens > 200000 maximum; key ${KEY}` } });
  const f = fixture([], { respond: () => new Response(body, { status: 400 }) });
  const error = await f.transport.requestPlan(opts).then(() => null, e => e);
  assert.equal(error.code, 'CONTEXT_LENGTH_EXCEEDED'); assert.equal(error.requestProtocol, 'anthropic');
  assert.ok(!JSON.stringify({ m: error.message, d: error.diagnostic }).includes(KEY));
});

test('model list endpoint and headers for the connection test', () => {
  const { anthropic } = fixture();
  assert.equal(anthropic.modelsEndpoint('https://api.anthropic.com'), 'https://api.anthropic.com/v1/models?limit=1000');
  assert.equal(anthropic.modelsEndpoint('https://relay.example.invalid/v1'), 'https://relay.example.invalid/v1/models?limit=1000');
});
