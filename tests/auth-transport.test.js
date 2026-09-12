const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function harness(fetch) {
  const context = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout, TextDecoder, WorkstationCore: require('../app/workstation-core') });
  vm.runInContext(fs.readFileSync(require.resolve('../app/agent-transport'), 'utf8'), context);
  return context.AgentTransport;
}
const stream = events => new Response(new ReadableStream({ start(c) { for (const event of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
test('OpenAI auth uses only local bridge and never forwards API credentials', async () => {
  let request;
  const transport = harness(async (url, options) => { request = { url, options }; return stream([{ type: 'response.output_text.delta', delta: '{"message":"完成","actions":[]}' }, {type:'response.completed'}]); });
  const output = await transport.requestPlan({ provider: 'openai-auth', token: 'must-not-send', model: 'account-model', input: 'plan' });
  assert.equal(request.url, '/__codex/respond');
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(JSON.parse(request.options.body).model, 'account-model');
  assert.match(output, /完成/);
});
test('stream failure after partial output is not accepted as success', async () => {
  const transport = harness(async () => stream([{ type:'response.output_text.delta',delta:'{"message":' }, {type:'response.failed',response:{error:{message:'账号额度不足'}}}]));
  await assert.rejects(transport.requestPlan({provider:'openai-auth',input:'plan'}), /账号额度不足/);
});
test('empty stream reports meaningful failure', async () => {
  const transport = harness(async () => stream([{type:'response.completed'}]));
  await assert.rejects(transport.requestPlan({provider:'openai-auth',input:'plan'}), /模型未返回内容/);
});
test('auth URL allowlist rejects credential tricks and alternate hosts', () => {
  const context = vm.createContext({URL});
  vm.runInContext(fs.readFileSync(require.resolve('../app/auth-ui'), 'utf8'),context);
  const check = context.OpenAIAuth.safeAuthURL;
  assert.equal(check('https://auth.openai.com/oauth/authorize?state=example'), 'https://auth.openai.com/oauth/authorize?state=example');
  for (const url of ['javascript:alert(1)','http://auth.openai.com/','https://auth.openai.com.evil.test/','https://evil.test@auth.openai.com/','https://example.test/']) assert.equal(check(url),null);
});

for (const provider of ['api', 'openai-auth']) {
  test(`${provider} sends explicit reasoning effort using only its supported request field`, async () => {
    const requests = [];
    const transport = harness(async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return stream([{ type: 'response.output_text.delta', delta: '{"message":"ok","actions":[]}' }, { type: 'response.completed' }]);
    });
    for (const effort of ['high', 'none']) {
      await transport.requestPlan({ provider, base: 'https://example.invalid/v1', model: 'test-model', input: 'plan', effort });
      const { body } = requests.at(-1);
      if (provider === 'api') {
        assert.deepEqual(body.reasoning, { effort });
        assert.equal(Object.hasOwn(body, 'effort'), false);
      } else {
        assert.equal(body.effort, effort);
        assert.equal(Object.hasOwn(body, 'reasoning'), false);
      }
      assert.equal(body.model, 'test-model');
    }
  });
  test(`${provider} omits reasoning overrides for empty, omitted and auto effort`, async () => {
    let body;
    const transport = harness(async (_url, options) => {
      body = JSON.parse(options.body);
      return stream([{ type: 'response.output_text.delta', delta: 'ok' }, { type: 'response.completed' }]);
    });
    for (const effort of [undefined, '', 'auto']) {
      await transport.requestPlan({ provider, base: 'https://example.invalid/v1', model: 'test-model', input: 'plan', effort });
      assert.equal(Object.hasOwn(body, 'effort'), false);
      assert.equal(Object.hasOwn(body, 'reasoning'), false);
    }
  });
}
