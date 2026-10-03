const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = ['sse-frame-scanner', 'agent-transport'].map(file => fs.readFileSync(require.resolve('../app/' + file), 'utf8')).join('\n');
const defaults = { provider: 'api', base: 'https://chat.pku.edu.cn/v1', model: 'deepseek-v4.1-flash', protocol: 'auto', effort: 'medium', input: 'synthetic fixture only' };
const pdf = [{ role: 'user', content: [{ type: 'input_text', text: 'Read the original PDF' }, { type: 'input_file', filename: 'fixture.pdf', file_data: 'data:application/pdf;base64,SYNTHETIC' }] }];
function harness({ learned = {}, configured, fail = false } = {}) {
  const calls = [], activities = [], attempts = [];
  const ctx = vm.createContext({ AbortController, TextDecoder, URL, WorkstationCore: require('../app/workstation-core'), fetch: async (url, init) => {
    calls.push({ url: decodeURIComponent(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(fail ? { error: { message: 'unknown endpoint' } } : {
      output_text: 'fixture answer', choices: [{ message: { content: 'fixture answer', reasoning_content: 'actual fixture reasoning' } }]
    }), { status: fail ? 404 : 200, headers: { 'content-type': 'application/json' } });
  } });
  vm.runInContext(source, ctx);
  ctx.AgentTransport.configure({ learnedProtocols: learned, ...(configured ? { protocol: configured } : {}) });
  return { calls, activities, attempts, transport: ctx.AgentTransport,
    request: options => ctx.AgentTransport.requestPlan({ ...defaults, onActivity: value => activities.push(value), onAttempt: value => attempts.push(value), ...options }) };
}

test('exact PKU DeepSeek Auto selects Chat once and exposes returned reasoning without changing prompt', async () => {
  const h = harness();
  assert.equal(await h.request(), 'fixture answer');
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].url, /https:\/\/chat\.pku\.edu\.cn\/v1\/chat\/completions$/);
  assert.deepEqual(h.calls[0].body.messages, [{ role: 'user', content: defaults.input }]);
  assert.deepEqual(h.calls[0].body.thinking, { type: 'enabled' });
  assert.equal(h.calls[0].body.reasoning_effort, 'medium');
  assert.equal(h.activities[0].text, 'actual fixture reasoning');
  assert.equal(h.activities[0].attemptId, h.attempts[0].id);
  assert.deepEqual(h.attempts.map(item => item.status), ['running', 'completed']);
});

test('compatible text and image blocks preserve role, text, URL and detail in Chat conversion', async () => {
  const input = [
    { role: 'developer', content: [{ type: 'input_text', text: 'Policy' }] },
    { role: 'assistant', content: [{ type: 'input_text', text: 'Earlier response' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'Read this image' }, { type: 'input_image', image_url: 'data:image/png;base64,SYNTHETIC', detail: 'high' }] }
  ];
  const before = JSON.stringify(input), h = harness(); await h.request({ input });
  assert.match(h.calls[0].url, /chat\/completions$/);
  assert.deepEqual(h.calls[0].body.messages, [
    { role: 'system', content: 'Policy' }, { role: 'assistant', content: 'Earlier response' },
    { role: 'user', content: [{ type: 'text', text: 'Read this image' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,SYNTHETIC', detail: 'high' } }] }
  ]);
  assert.equal(JSON.stringify(input), before);
});

test('original PDF always retains Responses input even after host learning preferred Chat', async () => {
  for (const learned of [{}, { 'chat.pku.edu.cn': 'chat' }, { 'chat.pku.edu.cn': 'responses' }]) {
    const h = harness({ learned }), before = JSON.stringify(pdf); await h.request({ input: pdf });
    assert.equal(h.calls.length, 1); assert.match(h.calls[0].url, /\/responses$/);
    assert.deepEqual(h.calls[0].body.input, pdf);
    assert.equal(JSON.stringify(pdf), before);
    assert.equal(Object.hasOwn(h.calls[0].body, 'thinking'), false);
    assert.deepEqual(h.calls[0].body.reasoning, { effort: 'medium' });
  }
});

test('unknown blocks, extra fields and unconvertible shapes stay byte-equivalent Responses inputs', async () => {
  const inputs = [
    [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'SYNTHETIC', format: 'wav' } }] }],
    [{ role: 'user', content: [{ type: 'input_text', text: 'keep extra', metadata: { source: 'fixture' } }] }],
    [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,SYNTHETIC', detail: 'unsupported' }] }],
    [{ role: 'user', content: [{ type: 'input_image', image_url: '' }] }],
    [{ role: 'user', name: 'named-user', content: [{ type: 'input_text', text: 'keep name' }] }],
    [{ role: 'tool', tool_call_id: 'call', content: [{ type: 'input_text', text: 'receipt' }] }],
    [{ role: 'user', content: 'not this converter shape' }],
    [{ role: 'user', content: [{ type: 'input_text', text: 42 }] }],
    [{ role: 'user', content: [] }], { custom: 'unknown input object' }, [], [null]
  ];
  for (const input of inputs) {
    const h = harness({ learned: { 'chat.pku.edu.cn': 'chat' } }); await h.request({ input });
    assert.match(h.calls[0].url, /\/responses$/);
    assert.deepEqual(h.calls[0].body.input, input);
  }
});

test('incompatible PKU inputs do not fall back to Chat after a Responses endpoint refusal', async () => {
  for (const input of [pdf, [{ role: 'user', content: [{ type: 'unknown', value: 'must stay' }] }]]) {
    const h = harness({ fail: true });
    await assert.rejects(h.request({ input }), error => error.code === 'HTTP' && /保留 Responses/.test(error.message));
    assert.equal(h.calls.length, 1); assert.match(h.calls[0].url, /\/responses$/);
    assert.deepEqual(h.calls[0].body.input, input);
    assert.deepEqual(h.attempts.map(item => item.status), ['running', 'failed']);
  }
});

test('sparse input and content arrays retain Responses serialization without discarding slots', async () => {
  const sparseInput = Array(2); sparseInput[1] = { role: 'user', content: [{ type: 'input_text', text: 'keep slot' }] };
  const sparseContent = Array(2); sparseContent[1] = { type: 'input_text', text: 'keep slot' };
  for (const input of [sparseInput, [{ role: 'user', content: sparseContent }]]) {
    const h = harness({ learned: { 'chat.pku.edu.cn': 'chat' } }); await h.request({ input });
    assert.match(h.calls[0].url, /\/responses$/);
    assert.deepEqual(h.calls[0].body.input, JSON.parse(JSON.stringify(input)));
  }
  assert.equal(0 in sparseInput, false); assert.equal(0 in sparseContent, false);
});

test('explicit protocols and account auth still take precedence over the Auto preference', async () => {
  const responses = harness({ learned: { 'chat.pku.edu.cn': 'chat' } });
  await responses.request({ protocol: 'responses' }); assert.match(responses.calls[0].url, /\/responses$/);
  const chat = harness(); await assert.rejects(chat.request({ protocol: 'chat', input: pdf }), { code: 'PROTOCOL_UNSUPPORTED' });
  assert.equal(chat.calls.length, 0);
  const account = harness(); await account.request({ provider: 'openai-auth', protocol: 'chat', input: pdf });
  assert.equal(account.calls[0].url, '/__codex/respond'); assert.deepEqual(account.calls[0].body.input, pdf);
  const configured = harness({ configured: 'responses' }); await configured.request({ protocol: undefined });
  assert.match(configured.calls[0].url, /\/responses$/);
});

test('request-level PKU compatibility overrides host learning while other models and hosts keep existing learning', async () => {
  const pku = harness({ learned: { 'chat.pku.edu.cn': 'responses' } }); await pku.request();
  assert.match(pku.calls[0].url, /chat\/completions$/);
  const otherModel = harness({ learned: { 'chat.pku.edu.cn': 'responses' } }); await otherModel.request({ model: 'gpt-6' });
  assert.match(otherModel.calls[0].url, /\/responses$/);
  const otherModelChat = harness({ learned: { 'chat.pku.edu.cn': 'chat' } }); await otherModelChat.request({ model: 'gpt-6' });
  assert.match(otherModelChat.calls[0].url, /chat\/completions$/);
  const otherHost = harness({ learned: { 'other.invalid': 'chat' } }); await otherHost.request({ base: 'https://other.invalid/v1' });
  assert.match(otherHost.calls[0].url, /chat\/completions$/);
});

test('lookalike origins, userinfo and non-default ports do not acquire the Auto preference', async () => {
  for (const base of ['http://chat.pku.edu.cn/v1', 'https://chat.pku.edu.cn:8443/v1', 'https://user:fixture@chat.pku.edu.cn/v1', 'https://chat.pku.edu.cn.evil.invalid/v1', 'https://sub.chat.pku.edu.cn/v1', 'https://other.invalid/v1']) {
    const h = harness(); await h.request({ base }); assert.match(h.calls[0].url, /\/responses$/);
  }
  for (const model of ['qwen3', 'my-deepseek-alias', 'deepseeker']) {
    const h = harness(); await h.request({ model }); assert.match(h.calls[0].url, /\/responses$/);
  }
});

test('Auto protocol does not override Auto effort defaults or web-search restrictions', async () => {
  for (const effort of ['auto', '', undefined]) {
    const h = harness(); await h.request({ effort }); assert.match(h.calls[0].url, /chat\/completions$/);
    assert.equal(Object.hasOwn(h.calls[0].body, 'thinking'), false);
    assert.equal(Object.hasOwn(h.calls[0].body, 'reasoning_effort'), false);
  }
  const web = harness();
  await assert.rejects(web.request({ webSearch: true }), error => error.code === 'WEB_SEARCH_UNSUPPORTED' && /此 API 服务尚未确认/.test(error.message));
  assert.equal(web.calls.length, 0);
});

test('new Chat preference never adds a reverse fallback or response replay', async () => {
  const h = harness({ fail: true }); await assert.rejects(h.request(), { code: 'HTTP' });
  assert.equal(h.calls.length, 1); assert.match(h.calls[0].url, /chat\/completions$/);
  assert.deepEqual(h.attempts.map(item => item.status), ['running', 'failed']);
});
