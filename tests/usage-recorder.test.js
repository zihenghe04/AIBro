const test = require('node:test');
const assert = require('node:assert/strict');
const AgentUsage = require('../app/agent-usage.js');
const Recorder = require('../app/usage-recorder.js');

function harness(extra = {}) {
  let clock = 1_000_000; const posted = [], timers = [];
  const rec = Recorder.create({ now: () => clock, post: async entries => { posted.push(...entries); }, route: item => ({ id: item.provider === 'openai-auth' ? 'codex-cli' : 'api:https://a.example.invalid/v1', kind: item.provider === 'openai-auth' ? 'account' : 'api' }),
    setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer() {}, ...extra });
  return { rec, posted, timers, tick: ms => { clock += ms; }, fire: async () => { for (const fn of timers.splice(0)) fn(); await rec.flush(); } };
}
const newRun = () => ({ id: 'run-1', toolCalls: [] });

test('a finished chat attempt becomes one counts-only row with latency, cache tokens and outcome', async () => {
  const h = harness(), run = newRun(), off = h.rec.observe(AgentUsage);
  const usage = AgentUsage.create(run, { });
  usage.attempt({ id: 'a1', status: 'running' }, { provider: 'api', model: 'm-1' });
  h.tick(900);
  usage.report({ input: 120, output: 30, total: 150 }, { attemptId: 'a1', totalSource: 'reported', cacheRead: 80 });
  usage.attempt({ id: 'a1', status: 'completed', httpStatus: 200 }, { provider: 'api', model: 'm-1' });
  await h.fire();
  assert.equal(h.posted.length, 1);
  assert.deepEqual(h.posted[0], { ts: 1_000_900, providerId: 'api:https://a.example.invalid/v1', providerKind: 'api', model: 'm-1', role: 'qa', input: 120, output: 30, cacheRead: 80, latencyMs: 900, status: 200, outcome: 'completed', runId: 'run-1' });
  off();
});

test('failed and interrupted attempts keep the HTTP status when known; the ledger itself is unchanged', async () => {
  const h = harness(), run = newRun(); h.rec.observe(AgentUsage);
  const usage = AgentUsage.create(run, null);
  usage.attempt({ id: 'a1', status: 'running' }, { provider: 'openai-auth', model: 'gpt-x' });
  usage.attempt({ id: 'a1', status: 'failed', httpStatus: 402 }, { provider: 'openai-auth', model: 'gpt-x' });
  usage.attempt({ id: 'a2', status: 'running' }, { provider: 'api', model: 'm-2' });
  usage.finish('cancelled');
  await h.fire();
  assert.deepEqual(h.posted.map(e => [e.providerId, e.providerKind, e.outcome, e.status, e.input]), [['codex-cli', 'account', 'failed', 402, null], ['api:https://a.example.invalid/v1', 'api', 'cancelled', null, null]]);
  assert.deepEqual(run.usageLedger.attempts.map(a => Object.keys(a).sort().join()), [Object.keys(run.usageLedger.attempts[0]).sort().join(), Object.keys(run.usageLedger.attempts[0]).sort().join()]);
  assert.ok(!JSON.stringify(run.usageLedger).includes('httpStatus'), 'statistics fields do not leak into the saved run');
});

test('tracker wraps transport callbacks for one-off requests such as translation', async () => {
  const h = harness(), track = h.rec.track({ role: 'translate', providerId: 'api:https://b.example.invalid/v1', model: 'tr-1', runId: 'sel-1' });
  track.onAttempt({ id: 'x', status: 'running' }); h.tick(250);
  track.onUsage({ input: 10, output: 5, total: 15 }, { attemptId: 'x', cacheRead: 0 });
  track.onAttempt({ id: 'x', status: 'completed' });
  track.onAttempt({ id: 'x', status: 'failed' });
  await h.fire();
  assert.equal(h.posted.length, 1, 'one row per request');
  assert.deepEqual([h.posted[0].role, h.posted[0].latencyMs, h.posted[0].cacheRead, h.posted[0].status], ['translate', 250, 0, 200]);
});

test('kernel tap records model responses of background runs and skips non-model events', async () => {
  const h = harness(), tap = h.rec.kernelTap({ providerId: 'codex-cli', providerKind: 'account', model: 'gpt-x', runId: 'k-1' });
  tap({ status: 'completed', ms: 1200, usage: { input: 500, output: 40 } });
  tap({ status: 'failed', ms: 300, error: 'boom secret text' });
  tap(null);
  await h.fire();
  assert.deepEqual(h.posted.map(e => [e.role, e.outcome, e.latencyMs, e.input, e.providerKind]), [['kernel', 'completed', 1200, 500, 'account'], ['kernel', 'failed', 300, null, 'account']]);
  assert.ok(!JSON.stringify(h.posted).includes('boom'));
});

test('private mode records nothing, a failing log never throws, and the queue is bounded', async () => {
  let priv = true;
  const h = harness({ skip: () => priv, post: async () => { throw new Error('log down'); } });
  const track = h.rec.track({ role: 'qa', providerId: 'p', model: 'm' });
  track.onAttempt({ id: 'x', status: 'running' }); track.onAttempt({ id: 'x', status: 'completed' });
  assert.equal(h.rec.pending(), 0);
  priv = false;
  for (let i = 0; i < 260; i += 1) { const t = h.rec.track({ role: 'qa', providerId: 'p', model: 'm' }); t.onAttempt({ id: 'y', status: 'running' }); t.onAttempt({ id: 'y', status: 'completed' }); }
  assert.equal(h.rec.pending(), 200);
  await assert.doesNotReject(h.fire());
});

test('an observer that throws cannot break the run ledger', () => {
  const run = newRun(), off = AgentUsage.observe(() => { throw new Error('observer bug'); });
  const usage = AgentUsage.create(run, null);
  assert.equal(usage.attempt({ id: 'a1', status: 'running' }, { provider: 'api', model: 'm' }), true);
  assert.equal(usage.attempt({ id: 'a1', status: 'completed' }, { provider: 'api', model: 'm' }), true);
  off();
});
