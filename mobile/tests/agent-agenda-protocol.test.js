import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, MemoryAdapter } from '../src/store.js';
import { ask } from '../src/ai.js';
import { createAgentTools, agentToolDefinitions, applyPlan } from '../src/agent-tools.js';
import { readEvent } from '../src/agenda.js';

const prompt = '帮我新建日程：合成讨论，时间还没定';
const details = { title: '合成讨论', start: '2030-12-04T15:00:00+08:00', end: '2030-12-04T16:00:00+08:00', timeZone: 'Asia/Shanghai' };
const change = data => ({ operation: 'create', kind: 'agenda', changes: data });
const call = (name, args, id = name) => ({ id, name, args });
function response(format, calls = [], text = '') {
  return format === 'chat' ? { choices: [{ message: { content: text || null, tool_calls: calls.map(c =>
    ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }] }
    : { status: 'completed', output: [...calls.map(c => ({ type: 'function_call', id: 'fc_' + c.id, call_id: c.id, name: c.name, arguments: JSON.stringify(c.args), status: 'completed' })),
      ...(text ? [{ type: 'message', id: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }] : [])] };
}
async function fixture(format = 'chat') {
  const adapter = new MemoryAdapter(), store = await new Store(adapter).load();
  await store.tx(s => { s.settings.model = { base: 'https://synthetic.invalid/v1', model: 'fixture', format }; });
  let credential = 'synthetic-only';
  return { store, adapter, vault: { get: async () => credential, set: async (_key, value) => { credential = value; } } };
}

for (const format of ['chat', 'responses']) test(`${format}: controlled clarification survives reload; follow-up can create review and approve the exact agenda`, async () => {
  const { store, adapter, vault } = await fixture(format); let requests = 0;
  const first = await ask({ store, vault, prompt, http: async () => {
    requests++;
    return response(format, [call('request_clarification', { kind: 'agenda', operation: 'create', fields: ['start', 'end'] })], '幻觉：已经创建并同步');
  } });
  assert.equal(requests, 1); assert.equal(first.status, 'completed'); assert.equal(first.pendingPlan, null);
  assert.match(first.text, /开始日期和时间.*结束时间或持续时长/); assert.doesNotMatch(first.text, /幻觉|已经创建并同步/);
  assert.equal(store.list('notes').length, 0);
  const reloaded = await new Store(adapter).load();
  assert.deepEqual(reloaded.list('messages').at(-1).clarification, { status: 'needs_input', requests: [{ kind: 'agenda', operation: 'create', fields: ['start', 'end'] }] });
  let followup = 0;
  const second = await ask({ store: reloaded, vault, conversationID: first.conversationID, prompt: '2030年12月4日下午3点开始，持续1小时', http: async (_url, { body }) => {
    followup++;
    const history = format === 'chat' ? body.messages : body.input;
    assert.ok(history.some(item => typeof item.content === 'string' && item.content.includes('开始日期和时间')));
    return followup === 1 ? response(format, [call('propose_changes', { actions: [change(details)] })]) : response(format, [], '请审阅合成讨论的具体时间。');
  } });
  assert.equal(followup, 2, 'a follow-up without explicit mutation wording retains the ordinary protocol tail');
  assert.equal(reloaded.list('notes').length, 0); assert.equal(second.pendingPlan.actions.length, 1);
  const plan = await applyPlan(reloaded, second.pendingPlan), event = readEvent(reloaded.get('notes', plan.receipts[0].id));
  assert.equal(event.title, details.title); assert.equal(event.start, Date.parse(details.start));
  assert.equal(event.end, Date.parse(details.end)); assert.equal(event.timeZone, details.timeZone);
  assert.equal(reloaded.list('notes').length, 1); assert.equal(plan.status, 'applied');
  await applyPlan(reloaded, second.pendingPlan); assert.equal(reloaded.list('notes').length, 1);
});

for (const format of ['chat', 'responses']) test(`${format}: complete single agenda proposal is reviewable without an optional failing provider tail`, async () => {
  const { store, vault } = await fixture(format); let requests = 0;
  const result = await ask({ store, vault, prompt: '请创建日程“合成讨论”，在2030年12月4日15:00到16:00，时区Asia/Shanghai', http: async () => {
    if (++requests > 1) throw Error('synthetic optional tail outage');
    return response(format, [call('propose_changes', { actions: [change(details)] })], '已经创建完毕');
  } });
  assert.equal(requests, 1); assert.equal(result.status, 'completed'); assert.match(result.text, /拟新建日程/);
  assert.doesNotMatch(result.text, /已经创建完毕/); assert.equal(store.list('notes').length, 0);
  assert.equal(store.list('messages').at(-1).pendingPlan.status, 'pending');
});

test('a failing call after a valid proposal prevents early completion; all calls are awaited', async () => {
  const { store, vault } = await fixture(); let requests = 0;
  await assert.rejects(ask({ store, vault, prompt: '帮我创建日程合成讨论', http: async () => {
    if (++requests > 1) throw Error('synthetic tail remains required');
    return response('chat', [call('propose_changes', { actions: [change(details)] }), call('knowledge_read', { kind: 'agenda', id: 'missing' })]);
  } }), /synthetic tail remains required/);
  assert.equal(requests, 2); assert.equal(store.list('messages').at(-1).status, 'failed');
  assert.equal(store.list('notes').length, 0);
});

test('partial multi-kind and quantified same-kind requests do not short-circuit on one matching action', async () => {
  for (const value of ['帮我创建项目和日程', '帮我创建两个日程', '创建日程甲，然后创建日程乙']) {
    const { store, vault } = await fixture(); let count = 0;
    await assert.rejects(ask({ store, vault, prompt: value, http: async () => {
      if (++count > 1) throw Error('compound request needs continuation');
      return response('chat', [call('propose_changes', { actions: [change(details)] })]);
    } }), /compound request needs continuation/);
    assert.equal(count, 2); assert.equal(store.list('notes').length, 0);
  }
});

for (const format of ['chat', 'responses']) test(`${format}: comma-separated repeated operations keep collecting same-kind targets`, async () => {
  for (const value of ['创建任务甲，创建任务乙', '创建任务甲，创建乙']) {
    const { store, vault } = await fixture(format); let requests = 0;
    const result = await ask({ store, vault, prompt: value, http: async () => {
      requests++;
      if (requests <= 2) return response(format, [call('propose_changes', { actions: [{ operation: 'create', kind: 'tasks',
        changes: { title: requests === 1 ? '甲' : '乙' } }] }, 'target_' + requests)]);
      return response(format, [], '两个任务均已准备，等待审阅。');
    } });
    assert.equal(requests, 3, value);
    assert.deepEqual(result.pendingPlan.actions.map(action => action.title), ['甲', '乙']);
    assert.equal(result.status, 'completed'); assert.equal(store.list('tasks').length, 0);
  }
});

test('non-single numeric quantities, including 10 and 100, cannot complete after only one proposed target', async () => {
  for (const value of ['创建0个任务', '创建2个任务', '创建10个任务', '创建100个任务', '创建１００个任务', '创建10项任务', '创建一百零一个任务']) {
    const { store, vault } = await fixture(); let requests = 0;
    await assert.rejects(ask({ store, vault, prompt: value, http: async () => {
      if (++requests > 1) throw Error('quantity requires continuation');
      return response('chat', [call('propose_changes', { actions: [{ operation: 'create', kind: 'tasks', changes: { title: '甲' } }] })]);
    } }), /quantity requires continuation/);
    assert.equal(requests, 2, value); assert.equal(store.list('messages').at(-1).status, 'failed');
    assert.equal(store.list('tasks').length, 0);
  }
});

test('a single numeric target remains eligible; quoted title verbs do not add operations', async () => {
  for (const value of ['创建1个任务', '创建一个任务', '创建１个任务“创建甲，创建乙”']) {
    const { store, vault } = await fixture(); let requests = 0;
    const result = await ask({ store, vault, prompt: value, http: async () => {
      if (++requests > 1) throw Error('unnecessary provider tail');
      return response('chat', [call('propose_changes', { actions: [{ operation: 'create', kind: 'tasks', changes: { title: '甲' } }] })]);
    } });
    assert.equal(requests, 1, value); assert.equal(result.status, 'completed');
    assert.equal(result.pendingPlan.actions.length, 1); assert.equal(store.list('tasks').length, 0);
  }
});

test('plain no-tool prose, including questions or fabricated saves, cannot claim a controlled clarification', async () => {
  for (const text of ['请问安排在哪一天？', '已经创建并保存日程。', '已保存？']) {
    const { store, vault } = await fixture();
    await assert.rejects(ask({ store, vault, prompt, http: async () => response('chat', [], text) }), /日程没有保存/);
    assert.equal(store.list('messages').at(-1).status, 'failed');
    assert.equal(store.list('messages').at(-1).content, ''); assert.equal(store.list('notes').length, 0);
  }
});

test('clarification accepts only bounded fields, cannot smuggle provider text, and cannot coexist with a proposal', async () => {
  const { store } = await fixture(), tools = createAgentTools({ store });
  for (const args of [{ kind: 'agenda', operation: 'create', fields: ['start'], question: '已保存' },
    { kind: 'agenda', operation: 'create', fields: ['content'] }, { kind: 'agenda', operation: 'create', fields: [] }])
    assert.ok((await tools.execute('request_clarification', args)).error);
  assert.deepEqual(tools.clarifications(), []);
  assert.equal((await tools.execute('request_clarification', { kind: 'agenda', operation: 'create', fields: ['start'] })).status, 'needs_input');
  assert.match((await tools.execute('propose_changes', { actions: [change(details)] })).error, /等用户回答/);
  assert.equal(tools.pendingPlan(), null); assert.equal(store.list('notes').length, 0);
});

test('agenda schema exposes actual typed fields; runtime rejects missing/invalid dates before review and never guesses offset', async () => {
  const properties = agentToolDefinitions.find(t => t.function.name === 'propose_changes').function.parameters.properties.actions.items.properties.changes;
  assert.equal(properties.additionalProperties, false);
  for (const field of ['title', 'start', 'end', 'timeZone', 'allDay', 'reminderMinutes', 'recurrence']) assert.ok(properties.properties[field], field);
  assert.match(properties.properties.start.description, /2030-02-04T15:00:00\+08:00/);
  assert.equal(properties.properties.allDay.type, 'boolean');
  const { store } = await fixture();
  for (const data of [{ title: '缺日期' }, { ...details, start: '2030-12-04T15:00:00' },
    { ...details, start: true }, { ...details, end: null }, { ...details, timeZone: 'invented/zone' },
    { ...details, allDay: 'false' }, { ...details, reminderMinutes: '15' }, { ...details, startAt: details.start }]) {
    const tools = createAgentTools({ store });
    assert.ok((await tools.execute('propose_changes', { actions: [change(data)] })).error);
    assert.equal(tools.pendingPlan(), null); assert.equal(store.list('notes').length, 0);
  }
});

test('truncated SSE cannot publish or run a write call even when its JSON happens to be complete', async () => {
  const { store, vault } = await fixture();
  await assert.rejects(ask({ store, vault, prompt: '帮我新建日程', stream: async (_url, { onEvent }) => {
    onEvent({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'partial', function: { name: 'propose_changes', arguments: JSON.stringify({ actions: [change(details)] }) } }] } }] });
  } }), /完成前中断/);
  assert.equal(store.list('notes').length, 0); assert.equal(store.list('messages').at(-1).pendingPlan, null);
});
