(async () => {
const assert = require('node:assert/strict');
globalThis.WorkstationCore = require('../app/workstation-core.js');
require('../app/agent-transport.js');

const stream = lines => new Response(new ReadableStream({
  start(controller) { lines.forEach(line => controller.enqueue(new TextEncoder().encode(`data: ${line}\n\n`))); controller.close(); }
}), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const collect = async events => {
  const usages = [];
  globalThis.fetch = async () => stream(events.map(event => JSON.stringify(event)));
  await globalThis.AgentTransport.requestPlan({ base: 'https://example.test/v1', model: 'demo', token: 'secret', input: 'hello', onUsage: usage => usages.push(usage) });
  return usages;
};
// chat 协议以流协议自带的结束标记收尾，缺少它整轮会被判定为不完整。
const collectChat = async events => {
  const usages = [];
  globalThis.fetch = async () => stream([...events.map(event => JSON.stringify(event)), '[DONE]']);
  await globalThis.AgentTransport.requestPlan({ base: 'https://example.test/v1', model: 'demo', token: 'secret', input: 'hello', onUsage: usage => usages.push(usage) });
  return usages;
};

// responses 协议：用量在 response.completed 的 response 对象上
assert.deepEqual(await collect([
  { type: 'response.output_text.delta', delta: '{"message":"已"}' },
  { type: 'response.completed', response: { usage: { input_tokens: 1200, output_tokens: 345, total_tokens: 1545 } } }
]), [{ input: 1200, output: 345, total: 1545 }], 'responses 用量应原样上报');

// chat 协议：用量在最后一个 chunk，字段名不同
assert.deepEqual(await collectChat([
  { choices: [{ index: 0, delta: { content: '好' } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 800, completion_tokens: 120, total_tokens: 920 } }
]), [{ input: 800, output: 120, total: 920 }], 'chat 用量字段应映射为 input/output');

// 缺失或畸形的用量不得编造数值
assert.deepEqual(await collect([{ type: 'response.output_text.delta', delta: 'x' }, { type: 'response.completed', response: {} }]), [], '无用量时不应上报');
assert.deepEqual(await collect([{ type: 'response.output_text.delta', delta: 'x' }, { type: 'response.completed', response: { usage: { total_tokens: 0 } } }]), [{ input: null, output: null, total: 0 }], '服务端明确报告的零用量保留，不能与未报告混淆');
assert.deepEqual(await collect([{ type: 'response.output_text.delta', delta: 'x' }, { type: 'response.completed', response: { usage: { total_tokens: 'many' } } }]), [], '非数值用量不应上报');
assert.deepEqual(await collect([{ type: 'response.output_text.delta', delta: 'x' }, { type: 'response.completed', response: { usage: { total_tokens: 50, input_tokens: 'n/a' } } }]), [{ input: null, output: null, total: 50 }], '部分字段缺失时应保留可用总量');
console.log('agent transport usage tests passed');
})().catch(error => { console.error(error); process.exit(1); });
