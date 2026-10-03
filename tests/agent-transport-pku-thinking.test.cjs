const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = ['sse-frame-scanner', 'agent-transport'].map(file => fs.readFileSync(require.resolve('../app/' + file), 'utf8')).join('\n');
const defaults = { provider: 'api', base: 'https://chat.pku.edu.cn/v1', model: 'deepseek-v4.1-flash', protocol: 'chat', input: 'synthetic fixture only' };
async function request(options) {
  const calls = [];
  const ctx = vm.createContext({ AbortController, TextDecoder, URL, WorkstationCore: require('../app/workstation-core'), fetch: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ output_text: 'fixture answer', choices: [{ message: { content: 'fixture answer' } }] }), { headers: { 'content-type': 'application/json' } });
  } });
  vm.runInContext(source, ctx);
  assert.equal(await ctx.AgentTransport.requestPlan({ ...defaults, ...options }), 'fixture answer');
  assert.equal(calls.length, 1, 'thinking selection never adds a request or retry');
  return calls[0].body;
}

test('PKU DeepSeek Chat explicitly enables thinking while retaining chosen effort and prompt', async () => {
  for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    const body = await request({ effort });
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.equal(body.reasoning_effort, effort);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'synthetic fixture only' }]);
    assert.equal(body.model, 'deepseek-v4.1-flash');
    assert.equal(body.stream, true);
    assert.equal(Object.hasOwn(body, 'tools'), false);
  }
});

test('none and off explicitly disable thinking without sending an unsupported off effort', async () => {
  const none = await request({ effort: 'none' }), off = await request({ effort: 'off' });
  assert.deepEqual(none.thinking, { type: 'disabled' }); assert.equal(none.reasoning_effort, 'none');
  assert.deepEqual(off.thinking, { type: 'disabled' }); assert.equal(Object.hasOwn(off, 'reasoning_effort'), false);
});

test('automatic, empty and absent effort leave upstream thinking defaults untouched', async () => {
  for (const effort of ['auto', '', undefined]) {
    const body = await request({ effort });
    assert.equal(Object.hasOwn(body, 'thinking'), false);
    assert.equal(Object.hasOwn(body, 'reasoning_effort'), false);
  }
});

test('different origins, userinfo and extra ports never receive this gateway adapter', async () => {
  for (const base of [
    'https://api.deepseek.com/v1', 'https://gateway.invalid/v1', 'http://chat.pku.edu.cn/v1',
    'https://chat.pku.edu.cn:8443/v1', 'https://user:fixture-password@chat.pku.edu.cn/v1',
    'https://chat.pku.edu.cn.gateway.invalid/v1', 'https://sub.chat.pku.edu.cn/v1'
  ]) {
    const body = await request({ base, effort: 'medium' });
    assert.equal(Object.hasOwn(body, 'thinking'), false, base);
    assert.equal(body.reasoning_effort, 'medium', 'existing generic body remains unchanged');
  }
});

test('the same gateway does not alter other model families', async () => {
  for (const model of ['gpt-6', 'qwen3', 'my-deepseek-alias', 'deepseeker']) {
    const body = await request({ model, effort: 'high' });
    assert.equal(Object.hasOwn(body, 'thinking'), false, model);
    assert.equal(body.reasoning_effort, 'high');
  }
});

test('Responses and account-auth body contracts are unchanged', async () => {
  const responses = await request({ protocol: 'responses', effort: 'medium' });
  assert.equal(Object.hasOwn(responses, 'thinking'), false);
  assert.deepEqual(responses.reasoning, { effort: 'medium' });
  assert.equal(Object.hasOwn(responses, 'reasoning_effort'), false);
  const account = await request({ provider: 'openai-auth', protocol: 'chat', effort: 'medium' });
  assert.equal(Object.hasOwn(account, 'thinking'), false);
  assert.equal(account.effort, 'medium');
  assert.equal(Object.hasOwn(account, 'messages'), false, 'account still forces Responses');
});

test('documented deployment suffix uses the same canonical switch without changing model routing', async () => {
  const model = 'deepseek-v4.1-flash@DEEPSEEK', body = await request({ model, effort: 'high' });
  assert.equal(body.model, model);
  assert.deepEqual(body.thinking, { type: 'enabled' });
});
