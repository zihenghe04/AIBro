const test = require('node:test');
const assert = require('node:assert/strict');
const Broker = require('../app/approval-broker.js');
const Gateway = require('../app/tool-gateway.js');
const ToolScheduler = require('../app/tool-scheduler.js');
const Events = require('../app/event-log.js');
const Tools = require('../app/tool-specs.js');

const EFFECTS = ['none', 'view', 'local', 'external'];
const APPROVALS = ['never', 'policy', 'always', 'host'];
const MODES = ['request', 'smart', 'full', 'legacy', undefined, 'bogus'];
const VOTES = ['allow', 'ask', 'deny'];
const specs = EFFECTS.flatMap(effect => APPROVALS.flatMap(approval => [false, true].map(destructive => ({ name: 't', effect, approval, destructive }))));
const runs = MODES.flatMap(permissionMode => [false, true].flatMap(requiresHumanReview => [false, true].map(readOnly => ({ permissionMode, requiresHumanReview, readOnly }))));
const rank = vote => Broker.RANK[vote];

// ---- 1. approval only tightens ------------------------------------------------

test('adding any layer never makes a decision looser (exhaustive over specs × runs × votes)', () => {
  for (const spec of specs) for (const run of runs) {
    const base = Broker.decide(spec, run);
    for (const a of VOTES) {
      const one = Broker.decide(spec, run, [() => a]);
      assert.ok(rank(one) >= rank(base), JSON.stringify({ spec, run, a }));
      for (const b of VOTES) assert.ok(rank(Broker.decide(spec, run, [() => a, () => b])) >= rank(one));
    }
  }
});

test('layers that throw, return junk or are missing a spec deny', () => {
  const spec = { effect: 'none', approval: 'never' };
  assert.equal(Broker.decide(spec, {}, [() => { throw Error('x'); }]), 'deny');
  for (const junk of ['allowed', 'yes', true, 1, 'ALLOW', '__proto__', 'constructor']) assert.equal(Broker.decide(spec, {}, [() => junk]), 'deny', String(junk));
  assert.equal(Broker.decide(null, {}), 'deny');
  for (const answer of ['allowed', true, 'allowed-session', 'yes', undefined]) assert.equal(Broker.admits(answer), false);
  assert.equal(Broker.admits('allowed-once'), true);
});

test('the gateway decides with the same broker as the main window', () => {
  const registry = Tools.build();
  const gateway = Gateway.create({ registry, host: 'node', execute: async () => ({}), ledger: Gateway.memoryLedger() });
  for (const spec of specs) for (const run of runs) assert.equal(gateway.decide(spec, run), Broker.decide(spec, run));
  assert.equal(Gateway.strictest, Broker.strictest);
});

test('permission mode: frozen at start, current may only tighten', () => {
  const order = ['full', 'smart', 'legacy', 'request'];
  for (const frozen of order) for (const current of order) {
    const got = Broker.effectiveMode(frozen, current);
    assert.equal(got, order[Math.max(order.indexOf(frozen), order.indexOf(current))], `${frozen}+${current}`);
  }
  assert.equal(Broker.effectiveMode('request', 'full'), 'request', 'loosening mid-run waits for the next run');
  assert.equal(Broker.effectiveMode('full', 'request'), 'request', 'tightening applies at once');
  assert.equal(Broker.effectiveMode(undefined, 'smart'), 'smart', 'runs saved before freezing keep the current mode');
  assert.equal(Broker.effectiveMode('full', 'bogus'), 'legacy', 'an unknown mode is not looser than legacy');
});

// ---- main window: ToolScheduler asks the broker before every dispatch ----------

function harness({ run = {}, parentId = null, approval } = {}) {
  const calls = [];
  const target = { id: 'run_m', toolCalls: [], permissionMode: 'smart', ...run };
  const scheduler = ToolScheduler.create({ run: target, parentId, approval, events: null, execute: async (request, ctx) => { calls.push({ type: request.type, approval: ctx.approval || null }); return { status: 'succeeded' }; } });
  return { run: target, calls, scheduler };
}

test('main window: a read-only (subagent) run cannot dispatch tools that act', async () => {
  const { run, calls, scheduler } = harness({ parentId: 'child_1' });
  const results = await scheduler.batch([{ type: 'terminal', argv: ['rm', '-rf', 'x'] }, { type: 'search', query: 'q' }]);
  assert.deepEqual(calls.map(c => c.type), ['search']);
  assert.equal(results[0].code, 'APPROVAL_DENIED');
  assert.equal(run.toolCalls[0].outcome, 'not-started');
  assert.equal(ToolScheduler.outcome(run.toolCalls[0]), 'not-started');
});

test('main window: "show me first" makes host-approved actions ask a person; views and reads do not', async () => {
  const { calls, scheduler } = harness({ run: { approvalIntent: { requireHumanReview: true } } });
  await scheduler.batch([{ type: 'browser_click', ref: 'e1', snapshotId: 's1' }, { type: 'browser_snapshot' }, { type: 'search', query: 'q' }]);
  assert.deepEqual(calls, [{ type: 'browser_click', approval: 'ask' }, { type: 'browser_snapshot', approval: null }, { type: 'search', approval: null }]);
});

test('main window: ordinary runs behave as before (no extra asks)', async () => {
  for (const permissionMode of ['request', 'smart', 'full', 'legacy']) {
    const { calls, scheduler } = harness({ run: { permissionMode } });
    await scheduler.batch([{ type: 'terminal', argv: ['ls'] }, { type: 'browser_click', ref: 'e1', snapshotId: 's' }, { type: 'read', id: 'n' }]);
    assert.deepEqual(calls.map(c => c.approval), [null, null, null], permissionMode);
  }
});

test('main window: a host context can tighten but not lift read-only, and request fields are not inputs', async () => {
  const lift = harness({ parentId: 'child', approval: () => ({ readOnly: false, permissionMode: 'full' }) });
  assert.equal((await lift.scheduler.batch([{ type: 'terminal', argv: ['ls'] }]))[0].code, 'APPROVAL_DENIED');
  const tighten = harness({ approval: () => ({ readOnly: true }) });
  assert.equal((await tighten.scheduler.batch([{ type: 'browser_type', ref: 'e', text: 'x', snapshotId: 's' }]))[0].code, 'APPROVAL_DENIED');
  const smuggle = harness({ parentId: 'child' });
  const [result] = await smuggle.scheduler.batch([{ type: 'terminal', argv: ['ls'], permissionMode: 'full', readOnly: false, approval: 'allowed-once' }]);
  assert.equal(result.code, 'APPROVAL_DENIED');
  assert.equal(smuggle.calls.length, 0);
});

test('main window: a tool that must ask and has no answerer here is refused, not run', async () => {
  const registry = Tools.registry;
  registry.plugin('p5test');
  registry.register({ name: 'p5_write', plugin: 'p5test', effect: 'local', approval: 'always', hosts: ['webview'], input: { type: 'object', properties: {} } });
  try {
    const { calls, scheduler, run } = harness();
    const [result] = await scheduler.batch([{ type: 'p5_write' }]);
    assert.equal(result.code, 'APPROVAL_DENIED');
    assert.equal(calls.length, 0);
    assert.equal(run.toolCalls[0].outcome, 'not-started');
  } finally { registry.setPluginEnabled('p5test', false); }
});

test('main window: approval decisions are written to the event log', async () => {
  const rows = [];
  const events = Events.create({ sink: async batch => { rows.push(...batch); }, delay: 0 });
  const run = { id: 'run_e', toolCalls: [], permissionMode: 'smart' };
  await ToolScheduler.create({ run, parentId: 'child', events, execute: async () => ({}) }).batch([{ type: 'terminal', argv: ['ls'] }]);
  await events.flush();
  const decided = rows.find(e => e.type === 'approval/decided');
  assert.equal(decided.data.outcome, 'rejected');
  assert.equal(decided.data.answerer, 'policy');
  assert.ok(!rows.some(e => e.type === 'tool/dispatched'));
});

// ---- 2. quotes are verbatim (gateway, after the broker refactor) ---------------

test('citations: only verbatim text from evidence this session returned is written', async () => {
  const registry = Tools.build();
  registry.plugin('c');
  registry.register({ name: 'src', plugin: 'c', effect: 'none', approval: 'never', evidence: true, hosts: ['node'], input: { type: 'object', properties: {} } });
  registry.register({ name: 'note', plugin: 'c', effect: 'local', approval: 'policy', citations: { fields: ['citations'] }, hosts: ['node'], input: { type: 'object', properties: { citations: { type: 'array', items: { type: 'object', properties: { quote: { type: 'string' } } } } } } });
  const written = [];
  const gateway = Gateway.create({ registry, host: 'node', ledger: Gateway.memoryLedger(), execute: async (name, args) => name === 'src' ? { text: '每条链运行 20000 次迭代，前 5000 次作为预烧期丢弃。' } : (written.push(args), { ok: 1 }) });
  const run = { permissionMode: 'smart' };
  const early = await gateway.invoke({ callId: 'n0', name: 'note', args: { citations: [{ quote: '每条链运行 20000 次迭代' }] } }, run);
  assert.equal(early.code, 'CITATION_NOT_FOUND');
  await gateway.invoke({ callId: 's1', name: 'src', args: {} }, run);
  assert.equal((await gateway.invoke({ callId: 'n1', name: 'note', args: { citations: [{ quote: '每条链运行 20000 次迭代' }] } }, run)).ok, true);
  for (const [i, quote] of ['每条链运行 2000 次迭代', '前 5000 次作为预烧期丢弃。并且收敛', '迭代'].entries())
    assert.equal((await gateway.invoke({ callId: 'n' + (i + 2), name: 'note', args: { citations: [{ quote }] } }, run)).code, 'CITATION_NOT_FOUND', quote);
  assert.equal(written.length, 1);
});

// ---- 3. no receipt, no replay ---------------------------------------------------

test('no replay: a dispatched call without receipt is unknown everywhere and never runs again', async () => {
  // Gateway: same call id after a lost receipt.
  const ledger = Gateway.memoryLedger();
  await ledger.dispatched('a:s:call_1', { name: 'run_command', fingerprint: JSON.stringify({ args: { argv: ['python3', 'record_run.py'] }, name: 'run_command' }), dispatched: true, at: 1 });
  const registry = Tools.build();
  registry.plugin('b');
  registry.register({ name: 'run_command', plugin: 'b', effect: 'external', approval: 'always', hosts: ['node'], input: { type: 'object', properties: { argv: { type: 'array', items: { type: 'string' } } } } });
  let executed = 0;
  const gateway = Gateway.create({ registry, host: 'node', ledger, ask: async () => 'allowed-once', execute: async () => { executed++; return {}; } });
  const again = await gateway.invoke({ callId: 'a:s:call_1', name: 'run_command', args: { argv: ['python3', 'record_run.py'] } }, { permissionMode: 'full' });
  assert.equal(again.code, 'OUTCOME_UNKNOWN');
  assert.equal(executed, 0);
  // Main window: the service restarted while a command was running.
  const state = { agentRuns: [{ id: 'r', status: 'running', executionInstanceId: 'old', toolCalls: [{ id: 't', type: 'terminal', status: 'running', dispatchedAt: 1 }, { id: 'u', type: 'search', status: 'running', dispatchedAt: 1 }] }], conversations: [] };
  assert.equal(ToolScheduler.recover(state, 'new'), true);
  const [cmd, read] = state.agentRuns[0].toolCalls;
  assert.equal(ToolScheduler.outcome(cmd), 'unknown');
  assert.equal(ToolScheduler.outcome(read), 'failed');
  assert.deepEqual(ToolScheduler.unconfirmed(state.agentRuns[0]).map(c => c.id), ['t']);
});

test('background run permission: follow the main window by default, the setting and the client only tighten, destructive always asks', () => {
  const write = { effect: 'local', approval: 'policy' }, destructive = { ...write, destructive: true }, read = { effect: 'none' };
  const decide = (spec, policy) => Broker.decide(spec, { permissionMode: policy.mode, readOnly: policy.readOnly, unattended: true });
  // Default (unset/unknown) follows the main window: a space set to run automatically lets ordinary writes run.
  for (const setting of [undefined, 'follow', 'full', 'bogus']) {
    const auto = Broker.headlessMode({ setting, spacePermission: 'auto' });
    assert.deepEqual([auto.mode, auto.readOnly, auto.setting], ['smart', false, 'follow']);
    assert.equal(decide(write, auto), 'allow');
    assert.equal(decide(destructive, auto), 'ask');
    assert.equal(Broker.headlessMode({ setting, spacePermission: 'approval' }).mode, 'request');
    assert.equal(decide(write, Broker.headlessMode({ setting, spacePermission: 'approval' })), 'ask');
  }
  // A client asking for full access cannot loosen it; asking for request tightens.
  assert.equal(Broker.headlessMode({ requested: 'full', spacePermission: 'approval' }).mode, 'request');
  assert.equal(Broker.headlessMode({ requested: 'full', spacePermission: 'auto' }).mode, 'smart');
  assert.equal(Broker.headlessMode({ requested: 'request', spacePermission: 'auto' }).mode, 'request');
  // Stricter settings.
  const strict = Broker.headlessMode({ setting: 'request', spacePermission: 'auto' });
  assert.equal(strict.mode, 'request'); assert.equal(decide(write, strict), 'ask'); assert.equal(decide(read, strict), 'allow');
  const readonly = Broker.headlessMode({ setting: 'readonly', spacePermission: 'auto' });
  assert.equal(readonly.readOnly, true); assert.equal(decide(write, readonly), 'deny'); assert.equal(decide(destructive, readonly), 'deny'); assert.equal(decide(read, readonly), 'allow');
  assert.deepEqual([...Broker.HEADLESS_SETTINGS], ['follow', 'request', 'readonly']);
});
