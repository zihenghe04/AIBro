/* P7 在主窗口的接线：传输层（原生调用 → 计划里的 knowledgeRequests）、调度器
   （沿用由 tool_call id 推导的 callId）、requestAgentPlan（按 run 冻结的工具协议
   注入声明并写 model/* 事件）。默认文本协议的行为不变。夹具是真实录制的流。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const Scheduler = require('../app/tool-scheduler.js');
const Tools = require('../app/tool-specs.js');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', 'tool-calls', name), 'utf8');
const sse = text => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
const chatSse = events => sse(events.map(e => e === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(e)}\n\n`).join(''));
function harness(fetch) {
  const context = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout, TextDecoder, URL, WorkstationCore: require('../app/workstation-core'), AIBroToolCalls: require('../app/tool-calls') });
  vm.runInContext(fs.readFileSync(require.resolve('../app/sse-frame-scanner'), 'utf8') + '\n' + fs.readFileSync(require.resolve('../app/agent-transport'), 'utf8'), context);
  return context.AgentTransport;
}
const tools = [
  { name: 'fs_read', description: '读取项目内文件', input: { type: 'object', required: ['path'], properties: { path: { type: 'string' } }, additionalProperties: false } },
  { name: 'search', description: '检索资料库', input: { type: 'object', required: ['query'], properties: { query: { type: 'string' } }, additionalProperties: false } },
];
const j = value => JSON.parse(JSON.stringify(value));

for (const wire of ['chat', 'responses']) {
  test(`传输层（${wire}，录制流）：原生调用变成计划的 knowledgeRequests，声明随请求发出，callId 交给宿主`, async () => {
    let body, url;
    const transport = harness(async (u, options) => { url = decodeURIComponent(u); body = JSON.parse(options.body); return sse(fixture(`${wire}-parallel.sse`)); });
    const seen = [];
    const output = await transport.requestPlan({ provider: 'api', base: 'https://gateway.example.com/v1', model: 'm', token: 'sk-x', protocol: wire, input: '计划', requirePlanProtocol: true, nativeTools: tools, toolCallSession: 'run_1', onToolCalls: calls => seen.push(...j(calls)) });
    assert.match(url, wire === 'chat' ? /chat\/completions/ : /\/responses/);
    const names = wire === 'chat' ? body.tools.map(t => t.function.name) : body.tools.map(t => t.name);
    assert.deepEqual(names, ['fs_read', 'search']);
    const plan = JSON.parse(output);
    assert.deepEqual(plan.actions, []);
    assert.deepEqual(plan.knowledgeRequests.map(r => r.type), ['fs_read', 'search']);
    assert.match(plan.knowledgeRequests[0].path, /README\.md/);
    assert.match(plan.knowledgeRequests[1].query, /变分推断/);
    assert.ok(plan.knowledgeRequests.every(r => !('callId' in r)), 'callId 不进请求参数（不影响去重键和循环守卫）');
    assert.equal(seen.length, 2);
    assert.ok(seen.every(c => c.callId.startsWith('n:run_1:call_')), JSON.stringify(seen));
  });
}

test('默认文本协议：不声明工具；模型若返回原生调用仍按协议错误处理（行为不变）', async () => {
  let body;
  const transport = harness(async (u, options) => { body = JSON.parse(options.body); return sse(fixture('chat-parallel.sse')); });
  await assert.rejects(transport.requestPlan({ provider: 'api', base: 'https://gateway.example.com/v1', model: 'm', token: 'sk-x', protocol: 'chat', input: '计划', requirePlanProtocol: true }), { code: 'MODEL_PROTOCOL_ERROR', protocolKind: 'native_tool_call' });
  assert.equal(body.tools, undefined);
});

test('无效原生调用（未知工具名 / 坏 JSON）：整轮不执行，作为可修复的协议错误', async () => {
  for (const [name, args] of [['rm_rf', '{}'], ['search', '{"query":']]) {
    const transport = harness(async () => chatSse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name, arguments: args } }] } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]']));
    const calls = [];
    await assert.rejects(transport.requestPlan({ provider: 'api', base: 'https://gateway.example.com/v1', model: 'm', token: 'sk-x', protocol: 'chat', input: 'x', requirePlanProtocol: true, nativeTools: tools, onToolCalls: c => calls.push(c) }), error => error.code === 'MODEL_PROTOCOL_ERROR' && error.protocolKind === 'native_tool_args' && error.recoverable === true);
    assert.equal(calls.length, 0, '无效时不把任何调用交给宿主');
  }
});

test('正文里的 JSON 计划与原生调用合并；正文是说明文字时成为 message', async () => {
  const call = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"query":"b"}' } }] } }] };
  const end = { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] };
  const run = async content => JSON.parse(await harness(async () => chatSse([{ choices: [{ index: 0, delta: { content } }] }, call, end, '[DONE]'])).requestPlan({ provider: 'api', base: 'https://gateway.example.com/v1', model: 'm', token: 'sk-x', protocol: 'chat', input: 'x', requirePlanProtocol: true, nativeTools: tools }));
  const merged = await run('{"message":"先查","knowledgeRequests":[{"type":"search","query":"a"}],"actions":[]}');
  assert.equal(merged.message, '先查');
  assert.deepEqual(merged.knowledgeRequests.map(r => r.query), ['a', 'b']);
  const prose = await run('我先检索一下。');
  assert.equal(prose.message, '我先检索一下。');
  assert.deepEqual(j(prose.knowledgeRequests), [{ query: 'b', type: 'search' }]);
});

test('调度器：原生调用沿用推导出的 callId；格式不对或已用过的 id 换成新 id', async () => {
  const run = { toolCalls: [{ id: 'n:run:used', type: 'read', status: 'completed' }] };
  const ids = { a: 'n:run:call_A', b: 'n:run:used', c: 'tool_forged' };
  const s = Scheduler.create({ run, execute: async () => ({ ok: true }), callIdFor: request => ids[request.query] });
  await s.batch([{ type: 'search', query: 'a' }, { type: 'search', query: 'b' }, { type: 'search', query: 'c' }, { type: 'search', query: 'd' }]);
  const fresh = run.toolCalls.slice(1).map(call => call.id);
  assert.equal(fresh[0], 'n:run:call_A');
  assert.ok(fresh.slice(1).every(id => id.startsWith('tool_')), fresh.join(','));
  assert.equal(new Set(run.toolCalls.map(c => c.id)).size, run.toolCalls.length);
  // 不给 callIdFor（文本协议）时与原来一样。
  const plain = { };
  await Scheduler.create({ run: plain, execute: async () => ({}) }).batch([{ type: 'search', query: 'x' }]);
  assert.match(plain.toolCalls[0].id, /^tool_/);
});

// requestAgentPlan 取自 app.js（与 project-memory-host.test.cjs 同样的切片方式）。
const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');
const start = source.indexOf('async function requestAgentPlan(options, run) {'), end = source.indexOf('\nasync function sendMessage(', start);
const host = new Function('AgentTransport', 'window', source.slice(start, end) + '\nreturn { requestAgentPlan, takeNativeCallId };');

function appHarness(reply) {
  const requests = [], events = [];
  const transport = { requestPlan: async options => { requests.push(options); return reply(options); } };
  const window = { AIBroRunLoop: require('../app/kernel-run-loop'), AIBroToolCalls: require('../app/tool-calls'), AIBroTools: Tools, AIBroEvents: { default: { emit: (type, event) => events.push({ type, ...event }) } } };
  return { ...host(transport, window), requests, events };
}

test('requestAgentPlan：native run 注入注册表声明并记下 callId；text run 不变；都写 model/request、model/response 事件', async () => {
  const h = appHarness(options => { options.onToolCalls?.([{ callId: 'n:run_n:call_1', name: 'search', args: { query: 'q', offset: 0 } }]); options.onUsage?.({ input: 10, output: 2, total: 12 }); return '{"knowledgeRequests":[{"type":"search","query":"q","offset":0}],"actions":[]}'; });
  const nativeRun = { id: 'run_n', toolProtocol: 'native' };
  await h.requestAgentPlan({ provider: 'api', base: 'b', model: 'm', input: '目标' }, nativeRun);
  const sent = h.requests[0];
  const expected = Tools.registry.list().filter(s => s.modelCallable && s.hosts.includes('webview')).map(s => s.name);
  assert.deepEqual(sent.nativeTools.map(s => s.name), expected);
  assert.equal(sent.toolCallSession, 'run_n');
  assert.match(sent.input, /本连接已启用原生工具调用/);
  // 参数键顺序不同也能认领；认领一次后不再给出。
  assert.equal(h.takeNativeCallId(nativeRun, { offset: 0, type: 'search', query: 'q' }), 'n:run_n:call_1');
  assert.equal(h.takeNativeCallId(nativeRun, { type: 'search', query: 'q', offset: 0 }), null);
  assert.deepEqual(h.events.map(e => e.type), ['model/request', 'model/response']);
  assert.match(h.events[0].data.inputHash, /^[0-9a-f]{8}$/);
  assert.equal(h.events[1].data.status, 'completed');
  assert.equal(h.events[0].data.toolProtocol, 'native');
  assert.deepEqual(h.events[1].data.nativeCalls, [{ callId: 'n:run_n:call_1', name: 'search' }]);
  assert.deepEqual(h.events[1].data.usage, { input: 10, output: 2, total: 12 });
  assert.ok(h.events.every(e => e.runId === 'run_n' && !JSON.stringify(e.data).includes('目标')), '事件不含提示词正文');

  const t = appHarness(() => '{"message":"ok","actions":[]}');
  for (const run of [{ id: 'run_t', toolProtocol: 'text' }, { id: 'run_old' }]) await t.requestAgentPlan({ provider: 'api', base: 'b', model: 'm', input: '目标' }, run);
  assert.ok(t.requests.every(r => r.nativeTools === undefined && r.input === '目标'), '文本协议和旧 run 的请求与以前相同');
  const c = appHarness(() => '{"message":"ok","actions":[]}');
  await c.requestAgentPlan({ provider: 'claude-auth', model: 'm', input: 'x' }, { id: 'run_c', toolProtocol: 'native' });
  assert.equal(c.requests[0].nativeTools, undefined, '只有 API 连接走原生调用');
});

test('requestAgentPlan：无效原生调用消耗一次修复（内核预算：连续最多两次），修复请求仍带声明，失败写 status=failed 的 model/response', async () => {
  let n = 0;
  const h = appHarness(() => { if (n++ === 0) throw Object.assign(Error('模型的原生工具调用无效：rm_rf：没有名为 rm_rf 的工具'), { code: 'MODEL_PROTOCOL_ERROR', protocolKind: 'native_tool_args' }); return '{"message":"ok","actions":[]}'; });
  const run = { id: 'run_r', toolProtocol: 'native' };
  assert.equal(await h.requestAgentPlan({ provider: 'api', base: 'b', model: 'm', input: '目标' }, run), '{"message":"ok","actions":[]}');
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests[1].nativeTools?.length > 0);
  assert.match(h.requests[1].input, /函数调用无效/);
  assert.equal((h.requests[1].input.match(/本连接已启用原生工具调用/g) || []).length, 1, '说明只附一次');
  assert.deepEqual(h.events.map(e => [e.type, e.data.status || null]), [['model/request', null], ['model/response', 'failed'], ['model/request', null], ['model/response', 'completed']]);
  assert.equal(h.events[1].data.kind, 'native_tool_args');
  assert.equal(h.events[2].data.repair, true);
});
