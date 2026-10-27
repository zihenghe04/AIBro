// P9b: the kernel's Codex client (app/codex-kernel-client.js) and what the
// shared tool loop does with it: text protocol end to end, usage limits end
// the run as paused (no retry), cancel reaches the provider, reported or
// estimated usage triggers compaction. A fake provider stands in for
// /__kernel/host/codex/*; no Codex, no network.
const test = require('node:test'), assert = require('node:assert/strict');
const Client = require('../app/codex-kernel-client.js');
const RunLoop = require('../app/kernel-run-loop.js');
const Calls = require('../app/tool-calls.js');
const Compaction = require('../app/kernel-compaction.js');

const json = value => JSON.stringify(value);
const reply = (status, value) => ({ ok: status < 400, status, json: async () => value });

// A provider: answers each step from a script; records what was posted.
function provider(script) {
  const posts = [];
  let step = 0;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    posts.push({ url, body, headers: init.headers });
    if (url.endsWith('/cancel') || url.endsWith('/close')) return reply(200, { ok: true });
    const next = script[step++];
    assert.ok(next, 'no unplanned step');
    return typeof next === 'function' ? next(body) : next;
  };
  return { fetch, posts, steps: () => step };
}
const answer = (content, usage = { prompt_tokens: 900, completion_tokens: 20, estimated: false }) => reply(200, { content, usage, finish: 'stop', newThread: false, sent: 1, ms: 12, thread: 1, version: '0.163.0' });

const SPECS = [{ name: 'read_doc', description: '读取资料', input: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', maxLength: 64 } } } }];

function loop(fetch, { compaction = null, signal = null } = {}) {
  const client = Client.create({ fetch, url: action => '/__kernel/host/codex/' + action, headers: { 'X-AIBro-Kernel-Host': 'tok' }, runId: 'krun_test1', mode: 'shared', model: 'gpt-x' });
  const events = [], invoked = [];
  const session = { id: 's1', steps: 0, turns: [{ role: 'system', content: 'RULES\n\n' + Calls.textCatalog(SPECS) }, { role: 'user', content: '任务' }] };
  const host = {
    calls: Calls, specs: SPECS, protocol: 'text', wire: 'chat', model: 'gpt-x', signal, compaction,
    emit: async (type, data) => events.push({ type, data }),
    request: client.request,
    invoke: async call => { invoked.push(call.name); return json({ ok: true, text: '资料正文'.repeat(20) }); },
  };
  return { session, events, invoked, run: () => RunLoop.toolLoop(session, host) };
}

test('client posts plain text messages and returns the reply with usage and codex timing', async () => {
  const p = provider([answer('{"final":"好"}')]);
  const client = Client.create({ fetch: p.fetch, url: a => '/x/' + a, headers: { H: '1' }, runId: 'krun_a1', model: 'm', effort: 'low' });
  const out = await client.request({ messages: [{ role: 'system', content: 'S' }, { role: 'user', tool: true, content: 'U' }] });
  assert.equal(out.content, '{"final":"好"}');
  assert.equal(out.raw, null);
  assert.equal(out.usage.prompt_tokens, 900);
  assert.deepEqual(out.codex, { newThread: false, sent: 1, ms: 12, thread: 1, version: '0.163.0' });
  assert.deepEqual(p.posts[0].body, { runId: 'krun_a1', mode: 'shared', model: 'm', effort: 'low', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }] });
  assert.equal(p.posts[0].headers.H, '1');
  assert.deepEqual(Client.messagesOf({ input: [{ role: 'developer', content: [{ type: 'input_text', text: 'D' }] }] }), [{ role: 'system', content: 'D' }]);
});

test('text protocol end to end through the client: tool call, result, final', async () => {
  const p = provider([
    answer(json({ tool_calls: [{ name: 'read_doc', arguments: { id: 'd1' } }] })),
    body => { assert.match(body.messages.at(-1).content, /工具结果/); return answer(json({ final: '读完了' })); },
  ]);
  const run = loop(p.fetch);
  const result = await run.run();
  assert.equal(result.stop, 'final');
  assert.equal(result.final, '读完了');
  assert.deepEqual(run.invoked, ['read_doc']);
  const responses = run.events.filter(e => e.type === 'model/response');
  assert.equal(responses.length, 2);
  assert.ok(responses.every(e => Number.isFinite(e.data.ms) && e.data.codex?.ms === 12), 'every step logs its latency');
});

test('usage limit: the run ends as paused with the reason, the step is not counted and not retried', async () => {
  const p = provider([
    answer(json({ tool_calls: [{ name: 'read_doc', arguments: { id: 'd1' } }] })),
    reply(429, { error: { code: 'CODEX_QUOTA', message: 'Codex 订阅额度已用尽。', pause: true } }),
  ]);
  const run = loop(p.fetch);
  const result = await run.run();
  assert.equal(result.stop, 'paused');
  assert.deepEqual(result.pause, { code: 'CODEX_QUOTA', message: 'Codex 订阅额度已用尽。' });
  assert.equal(result.steps, 1);
  assert.equal(p.steps(), 2);
  const failed = run.events.find(e => e.type === 'model/response' && e.data.status === 'paused');
  assert.equal(failed.data.code, 'CODEX_QUOTA');
  assert.equal(run.events.at(-1).type, 'run/finished');
  assert.equal(run.events.at(-1).data.status, 'paused');
});

test('other provider errors fail the run (no pause)', async () => {
  const p = provider([reply(502, { error: { code: 'CODEX_TOOL_EVENT', message: 'Codex CLI 回报了自带工具事件（commandExecution），已中止这一步。', pause: false } })]);
  await assert.rejects(loop(p.fetch).run(), error => error.code === 'CODEX_TOOL_EVENT' && /commandExecution/.test(error.message));
});

test('cancel: the provider is told to interrupt and the run ends cancelled', async () => {
  const controller = new AbortController();
  let release;
  const p = provider([() => new Promise(resolve => { release = resolve; controller.abort(); })]);
  const wrapped = async (url, init) => {
    const out = p.fetch(url, init);
    if (url.endsWith('/cancel')) release(reply(409, { error: { code: 'CANCELLED', message: '运行已取消，这一步已中止。', pause: false } }));
    return out;
  };
  const result = await loop(wrapped, { signal: controller.signal }).run();
  assert.equal(result.stop, 'cancelled');
  assert.ok(p.posts.some(post => post.url.endsWith('/cancel') && post.body.runId === 'krun_test1'));
});

test('reported usage over the threshold compacts even when the estimate is small; an estimate compacts earlier', async () => {
  for (const [usage, expect] of [
    [{ prompt_tokens: 5000, completion_tokens: 5 }, true],
    [{ prompt_tokens: 3900, completion_tokens: 5, estimated: true }, true],   // 3900 ≥ 0.75 × 5000
    [{ prompt_tokens: 3900, completion_tokens: 5 }, false],
  ]) {
    const requests = [];
    const p = provider([
      answer(json({ tool_calls: [{ name: 'read_doc', arguments: { id: 'd1' } }] }), { prompt_tokens: 100, completion_tokens: 5 }),
      answer(json({ tool_calls: [{ name: 'read_doc', arguments: { id: 'd2' } }] }), usage),
      body => { requests.push(body); return answer(json({ summary: '读过 d1、d2。', excerpts: [] })); },
      answer(json({ final: '完成' })),
    ]);
    const run = loop(p.fetch, { compaction: { compactor: Compaction, thresholdTokens: 5000, retainTokens: 50, usage: true } });
    const result = await run.run();
    const compacted = run.events.some(e => e.type === 'run/compacted' && e.data.trigger === 'usage');
    assert.equal(compacted, expect, JSON.stringify(usage));
    // Without compaction the second reply is an ordinary (malformed) step that gets a format reminder.
    assert.equal(result.final, '完成');
    assert.equal(run.session.formatErrors || 0, expect ? 0 : 1);
  }
});

test('without compaction.usage the API path is unchanged (estimate only)', async () => {
  const p = provider([answer(json({ tool_calls: [{ name: 'read_doc', arguments: { id: 'd1' } }] }), { prompt_tokens: 99999, completion_tokens: 1 }), answer(json({ final: '完成' }))]);
  const run = loop(p.fetch, { compaction: { compactor: Compaction, thresholdTokens: 5000, retainTokens: 50 } });
  assert.equal((await run.run()).final, '完成');
  assert.ok(!run.events.some(e => e.type === 'run/compacted'));
});
