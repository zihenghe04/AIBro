const test = require('node:test');
const assert = require('node:assert/strict');
const Events = require('../app/event-log.js');
const ToolScheduler = require('../app/tool-scheduler.js');
const Gateway = require('../app/tool-gateway.js');
const Tools = require('../app/tool-specs.js');

function memorySink() {
  const rows = [], last = new Map();
  const sink = async batch => {
    for (const e of batch) {
      const prev = last.get(e.stream) || 0;
      if (e.seq !== prev + 1) throw Object.assign(Error('SEQ'), { code: 'SEQ', last: { [e.stream]: prev } });
      last.set(e.stream, e.seq);
    }
    rows.push(...structuredClone(batch));
    return { ok: true };
  };
  return { rows, sink, last };
}
const view = calls => calls.map(c => ({ id: c.id, status: c.status, ...(c.outcome ? { outcome: c.outcome } : {}) }));
const folded = (rows, options) => {
  const run = [...Events.fold(rows, options).values()][0];
  return view([...run.tools.values()]);
};

test('events carry per-stream seq, batch ordinary events and flush dispatch at once', async () => {
  const { rows, sink } = memorySink();
  const log = Events.create({ sink, delay: 50 });
  log.emit('tool/requested', { runId: 'r1', callId: 'c1', data: { type: 'read' } });
  log.emit('step/added', { runId: 'r2', data: { text: 'x' } });
  assert.equal(rows.length, 0, 'ordinary events wait for the batch');
  await log.emit('tool/dispatched', { runId: 'r1', callId: 'c1' });
  assert.deepEqual(rows.map(e => [e.stream, e.seq, e.type]), [['run:r1', 1, 'tool/requested'], ['run:r2', 1, 'step/added'], ['run:r1', 2, 'tool/dispatched']]);
  for (const e of rows) assert.deepEqual(Object.keys(e).slice(0, 6), ['v', 'id', 'stream', 'seq', 'ts', 'type']);
  await log.emit('tool/progress', { runId: 'r1', durability: 'ephemeral' });
  await log.flush();
  assert.equal(rows.length, 3, 'ephemeral events are not written');
  assert.throws(() => log.emit('shell/run', { runId: 'r1' }));
});

test('a stream continued by another page/process renumbers after the stored seq', async () => {
  const { rows, sink, last } = memorySink();
  last.set('run:r1', 7);
  const log = Events.create({ sink });
  await log.emit('run/finished', { runId: 'r1', data: { status: 'completed' } });
  assert.deepEqual(rows.map(e => e.seq), [8]);
  await log.emit('run/finished', { runId: 'r1' });
  assert.deepEqual(rows.map(e => e.seq), [8, 9]);
});

test('a failing sink is reported and never throws into the caller', async () => {
  const errors = [];
  const log = Events.create({ sink: async () => { throw Error('offline'); }, onError: e => errors.push(e.message) });
  assert.equal(await log.emit('tool/dispatched', { runId: 'r', callId: 'c' }), false);
  assert.deepEqual(errors, ['offline']);
});

test('no secrets or headers leave the module', () => {
  const key = 'sk-' + 'Zx9Yw8Vu7Ts6Rq5P';
  const out = Events.redact({ url: 'https://example.org/a', headers: { Authorization: 'Bearer ' + 'k'.repeat(24) }, apiKey: key, api_key: key, nested: [{ note: 'token: ' + 'm'.repeat(20) + ' ' + key, password: 'hunter22' }], text: 'x'.repeat(5000) });
  const text = JSON.stringify(out);
  for (const leaked of [key, 'k'.repeat(24), 'm'.repeat(20), 'hunter22', 'Bearer ']) assert.ok(!text.includes(leaked), leaked);
  assert.equal(out.url, 'https://example.org/a');
  assert.equal(out.headers, '[redacted]');
  assert.ok(out.text.length < 4100);
});

async function schedulerRun({ crashAfterDispatchOf = null } = {}) {
  const { rows, sink } = memorySink();
  const events = Events.create({ sink, delay: 0 });
  const run = { id: 'run_1', toolCalls: [] };
  const execute = async request => {
    if (request.type === 'search') return { results: [] };
    if (request.type === 'read') throw Object.assign(Error('missing'), { code: 'NOT_FOUND' });
    if (request.type === 'terminal') return { status: 'succeeded', exitCode: 0 };
    return {};
  };
  const scheduler = ToolScheduler.create({ run, execute, events });
  const results = await scheduler.batch([{ type: 'search', query: 'q' }, { type: 'read', id: 'n1' }, { type: 'terminal', argv: ['ls'] }]);
  ToolScheduler.finish(run, 'completed', events);
  await events.flush();
  return { run, rows, results };
}

test('P2: the event log folds back to the same tool ledger as run.toolCalls (dual write)', async () => {
  const { run, rows, results } = await schedulerRun();
  assert.equal(results.length, 3);
  assert.deepEqual(folded(rows), view(run.toolCalls));
  assert.deepEqual(view(run.toolCalls).map(c => c.status), ['completed', 'failed', 'completed']);
  // dispatched is recorded before the tool's result, for every call
  for (const call of run.toolCalls) {
    const types = rows.filter(e => e.callId === call.id).map(e => e.type);
    assert.deepEqual(types, ['tool/requested', 'tool/dispatched', 'tool/result']);
  }
  // The snapshot record is the same with or without the log.
  const plain = { id: 'run_1', toolCalls: [] };
  await ToolScheduler.create({ run: plain, execute: async r => r.type === 'read' ? Promise.reject(Object.assign(Error('missing'), { code: 'NOT_FOUND' })) : r.type === 'terminal' ? { status: 'succeeded', exitCode: 0 } : { results: [] }, events: null })
    .batch([{ type: 'search', query: 'q' }, { type: 'read', id: 'n1' }, { type: 'terminal', argv: ['ls'] }]);
  const strip = calls => calls.map(({ id, createdAt, startedAt, finishedAt, dispatchedAt, ...rest }) => rest);
  assert.deepEqual(strip(plain.toolCalls), strip(run.toolCalls));
});

test('P2: killed after dispatch -> the log folds to unknown (never retried); a read folds to failed', async () => {
  const { rows, sink } = memorySink();
  const events = Events.create({ sink, delay: 0 });
  const run = { id: 'run_k', toolCalls: [] };
  let release;
  const hang = new Promise(resolve => { release = resolve; });
  const scheduler = ToolScheduler.create({ run, execute: () => hang, events });
  scheduler.batch([{ type: 'terminal', argv: ['python3', 'record_run.py'] }]).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 30));
  await events.flush();
  // The process dies here: no tool/result, no run/finished reaches the log.
  const crashed = structuredClone(rows);
  assert.deepEqual(crashed.map(e => e.type), ['tool/requested', 'tool/dispatched']);
  const [call] = folded(crashed);
  assert.equal(call.outcome, 'unknown');
  assert.equal(folded(crashed, { live: true })[0].status, 'running');
  // Same cut for a read-only call: nothing to doubt, no outcome.
  const readRows = crashed.map(e => ({ ...e, data: { ...e.data, type: 'search' } }));
  assert.equal(folded(readRows, { readOnly: c => c.type === 'search' })[0].outcome, undefined);
  release({});
});

test('P2: ToolGateway writes tool/approval events and flushes dispatch before executing', async () => {
  const { rows, sink } = memorySink();
  const events = Events.create({ sink, delay: 1000 });
  const registry = Tools.build();
  registry.plugin('t');
  registry.register({ name: 'act', plugin: 't', effect: 'local', approval: 'always', hosts: ['node'], input: { type: 'object', properties: {} } });
  let sawDispatchBeforeRun = false;
  const gateway = Gateway.create({ registry, host: 'node', ledger: Gateway.memoryLedger(), events, runId: 'g1', ask: async () => 'allowed-once',
    execute: async () => { sawDispatchBeforeRun = rows.some(e => e.type === 'tool/dispatched'); return { done: true }; } });
  const receipt = await gateway.invoke({ callId: 'k1', name: 'act', args: {} }, { permissionMode: 'smart' });
  assert.equal(receipt.ok, true);
  assert.ok(sawDispatchBeforeRun);
  await events.flush();
  assert.deepEqual(rows.map(e => e.type), ['tool/requested', 'approval/asked', 'approval/decided', 'tool/dispatched', 'tool/result']);
  assert.equal(rows.find(e => e.type === 'approval/decided').data.outcome, 'allowed-once');
});
