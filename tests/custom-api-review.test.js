const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Core = require('../workstation-core');
const Delivery = require('../attachment-delivery');
const Models = require('../model-picker');
const transportSource = fs.readFileSync(require.resolve('../agent-transport'), 'utf8');
const plan = { message: '已读取材料，等待工作站执行', actions: [{ type: 'create_task', title: '核对课程考核要求', workspace: '课程' }] };
const planText = JSON.stringify(plan);
const input = text => [{ role: 'user', content: [{ type: 'input_text', text }] }];
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const eventText = events => events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\r\n\r\n`).join('');
function sse(events, chunkSize = 7) {
  const bytes = new TextEncoder().encode(eventText(events));
  return new Response(new ReadableStream({ start(controller) {
    for (let index = 0; index < bytes.length; index += chunkSize) controller.enqueue(bytes.slice(index, index + chunkSize));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}
function harness(reply) {
  const requests = [];
  const context = vm.createContext({ WorkstationCore: Core, AbortController, TextDecoder, URL,
    fetch: async (url, options) => {
      const request = { url, options, body: JSON.parse(options.body) };
      requests.push(request);
      return reply(request, requests.length);
    } });
  vm.runInContext(transportSource, context);
  return { requests, request: options => context.AgentTransport.requestPlan({ provider: 'api', base: 'https://gateway.example.invalid/v1/responses', model: 'fixture-model', token: 'synthetic-fixture-token', input: input('请分析'), ...options }) };
}

test('custom Responses endpoint streams split UTF-8 JSON and keeps the result executable only after completion', async () => {
  const deltas = [];
  const h = harness(() => sse([
    { type: 'response.output_text.delta', item_id: 'answer', delta: planText.slice(0, 23) },
    { type: 'response.output_text.delta', item_id: 'answer', delta: planText.slice(23) },
    { type: 'response.completed', response: { status: 'completed' } },
  ]));
  const output = await h.request({ onDelta: text => deltas.push(text), effort: 'high' });
  assert.equal(output, planText); assert.equal(deltas.at(-1), planText);
  assert.deepEqual(Core.parsePlan(output), plan);
  const request = h.requests[0];
  assert.equal(new URL(request.url, 'http://app.invalid').searchParams.get('url'), 'https://gateway.example.invalid/v1/responses');
  assert.deepEqual(request.body.reasoning, { effort: 'high' });
  assert.equal(request.body.stream, true);
  assert.equal(request.body.tools, undefined);
  assert.equal(request.options.headers.Authorization, 'Bearer synthetic-fixture-token');
});

test('custom API native PDF is sent once with exact original bytes and no extracted full-text fallback', async () => {
  const original = Buffer.from('%PDF-1.7\nfixture original bytes\n%%EOF');
  const file = { id: 'source-fixture', name: '课程.pdf', mimeType: 'application/pdf', content: 'EXTRACTED_TEXT_MUST_NOT_LEAK' };
  const delivered = await Delivery.prepare([file], { provider: 'api', getBlob: async () => new Blob([original], { type: 'application/pdf' }), getPdfInfo() { throw Error('Do not render API PDF'); } });
  const h = harness(() => json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: planText }] }] }));
  const payload = [{ role: 'user', content: [{ type: 'input_text', text: '请分析这份课程资料' }, ...delivered.blocks] }];
  assert.equal(await h.request({ input: payload }), planText);
  const files = h.requests[0].body.input.flatMap(message => message.content).filter(block => block.type === 'input_file');
  assert.equal(files.length, 1);
  assert.deepEqual(Buffer.from(files[0].file_data.split(',')[1], 'base64'), original);
  assert.equal(files[0].filename, '课程.pdf');
  assert.doesNotMatch(h.requests[0].options.body, /EXTRACTED_TEXT_MUST_NOT_LEAK/);
});

test('401 and 404 retain actionable errors and never return a successful text answer', async () => {
  for (const [status, payload, pattern] of [[401, { error: { message: 'Invalid fixture credential' } }, /Invalid fixture credential/], [404, {}, /404.*Responses|Responses.*404/]]) {
    const h = harness(() => json(payload, status));
    await assert.rejects(h.request(), error => error.code === 'HTTP' && error.status === status && pattern.test(error.message));
    assert.equal(h.requests.length, 1);
  }
});

test('a Chat-compatible DONE marker can complete an ordinary choices stream', async () => {
  const h = harness(() => sse([{ choices: [{ delta: { content: planText }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]']));
  assert.equal(await h.request(), planText);
});

test('clean EOF without a terminal event cannot authorize complete-looking JSON actions', async () => {
  const h = harness(() => sse([{ type: 'response.output_text.delta', delta: planText }]));
  await assert.rejects(h.request(), error => /STREAM|INCOMPLETE/.test(error.code || '') || /未完成|中断|不完整|结束标记/.test(error.message));
});

test('Responses deltas cannot substitute a Chat DONE marker for native completion', async () => {
  const h = harness(() => sse([{ type: 'response.output_text.delta', delta: planText }, '[DONE]']));
  await assert.rejects(h.request(), error => /STREAM|INCOMPLETE/.test(error.code || '') || /未完成|中断|不完整|结束标记/.test(error.message));
});

test('HTTP200 failed or incomplete Responses JSON never becomes a successful answer or action plan', async () => {
  for (const status of ['failed', 'incomplete']) {
    const h = harness(() => json({ status, error: { message: 'fixture generation did not complete' }, output: [{ type: 'message', content: [{ type: 'output_text', text: planText }] }] }));
    await assert.rejects(h.request(), /fixture generation did not complete|未完成|不完整|失败/);
  }
});

test('non-stream Chat truncation and empty or failed envelopes never masquerade as successful results', async () => {
  const cases = [
    {},
    { type: 'response.failed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: planText }] }] } },
    ...['length', 'content_filter', 'error'].map(reason => ({ choices: [{ message: { content: planText }, finish_reason: reason }] })),
  ];
  for (const value of cases) {
    const h = harness(() => json(value));
    await assert.rejects(h.request(), error => /未完成|未返回|不完整|失败|截断/.test(error.message));
  }
});

test('failure after partial output is rejected even when accumulated text is valid JSON', async () => {
  const h = harness(() => sse([{ type: 'response.output_text.delta', delta: planText }, { type: 'response.failed', response: { error: { message: 'fixture stream interrupted' } } }]));
  await assert.rejects(h.request(), /fixture stream interrupted/);
});

test('a nominal completion event carrying an incomplete status cannot authorize actions', async () => {
  const h = harness(() => sse([{ type: 'response.output_text.delta', delta: planText }, { type: 'response.completed', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }]));
  await assert.rejects(h.request(), error => /STREAM|INCOMPLETE/.test(error.code || '') || /未完成|中断|不完整|结束标记/.test(error.message));
});

test('conversation-specific API and account choices use isolated routes and credential fields', async () => {
  const conversation = { id: 'fixture-conversation' };
  const h = harness(() => sse([{ type: 'response.output_text.delta', delta: planText }, { type: 'response.completed', response: { status: 'completed' } }]));
  Models.setSelection(conversation, { provider: 'api', model: 'custom-model', effort: 'high' });
  const frozen = Models.configuration(conversation);
  Models.setSelection(conversation, { provider: 'openai-auth', model: 'account-model', effort: 'low' });
  await h.request(frozen);
  await h.request(Models.configuration(conversation));
  assert.match(h.requests[0].url, /^\/__proxy\?/);
  assert.equal(h.requests[0].body.model, 'custom-model');
  assert.equal(h.requests[0].body.effort, undefined);
  assert.equal(h.requests[1].url, '/__codex/respond');
  assert.equal(h.requests[1].body.model, 'account-model');
  assert.equal(h.requests[1].body.effort, 'low');
  assert.equal(h.requests[1].body.reasoning, undefined);
  assert.equal(h.requests[1].options.headers.Authorization, undefined);
  assert.doesNotMatch(h.requests[1].options.body, /synthetic-fixture-token|custom-model/);
  assert.equal(conversation.modelChoices.api.model, 'custom-model');
});
