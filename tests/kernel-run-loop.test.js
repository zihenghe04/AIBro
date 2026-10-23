// P8a kernel run loop: a Node host with a fake model runs whole runs through the
// real KnowledgeAccess loop. No DOM, network or workspace.
const test = require('node:test'), assert = require('node:assert/strict');
const RunLoop = require('../app/kernel-run-loop.js');
const KernelRules = require('../app/kernel-rules.js');
const K = require('../app/knowledge-access');
const Core = require('../app/workstation-core');

const json = value => JSON.stringify(value);
const read = id => ({ type: 'read', recordType: 'note', id });
const note = title => ({ type: 'create_note', title, content: '正文' });

// A host the way a headless kernel would build one: model replies are a script,
// tools return fixed evidence, accept() is the host's final-plan validation.
function host(replies, { accept, repair } = {}) {
  const run = { id: 'run-1', noteContextIds: [] }, asks = [], executed = [], events = [], accepted = [], repairs = [];
  let turn = 0;
  const next = () => { const reply = replies[turn++]; assert.notEqual(reply, undefined, 'no unplanned model request'); return reply; };
  const options = {
    knowledge: K, run, parsePlan: Core.parsePlan,
    emit: (type, data) => events.push({ type, data }),
    execute: async request => { executed.push(request.id); return { type: 'note', id: request.id, text: 'EVIDENCE_' + request.id, nextOffset: null }; },
    ask: async (extra, blocks) => { asks.push(extra); return next(); },
    finalize: {
      accept: async output => { const plan = Core.parsePlan(output); if (accept) await accept(plan); accepted.push(plan); },
      repair: async (error, invalid, withdrawn) => { repairs.push({ error: error.message, withdrawn: withdrawn.map(r => r.id) }); return repair ? repair(error, invalid, withdrawn) : next(); },
    },
  };
  return { run, asks, executed, events, accepted, repairs, options, start: initial => RunLoop.run(initial, options) };
}

test('a tool-phase write is staged, not executed, and reaches the final plan', async () => {
  const h = host([json({ message: '已读完', actions: [{ type: 'create_task', title: '复习' }] })]);
  await h.start(json({ knowledgeRequests: [read('a')], actions: [note('读书笔记')] }));
  assert.deepEqual(h.executed, ['a'], 'only the read ran');
  // The model sees what is staged, and that it has not taken effect.
  assert.match(h.asks[0], /已暂存的写操作（尚未执行/); assert.match(h.asks[0], /create_note/);
  assert.equal(h.accepted.length, 1);
  assert.deepEqual(h.accepted[0].actions.map(a => a.type), ['create_note', 'create_task']);
  assert.ok(h.run.stagedWrites.every(r => r.settled && !('item' in r)), 'settled records keep no copy of the write');
  assert.ok(h.events.some(e => e.type === 'tool/staged' && e.data.count === 1 && e.data.types[0] === 'create_note'));
});

test('a staged write restated in the final plan is kept once; withdrawStaged drops one', async () => {
  const h = host([json({ message: 'ok', actions: [note('A')], withdrawStaged: ['staged-2'] })]);
  await h.start(json({ knowledgeRequests: [read('a')], actions: [note('A'), note('B')] }));
  const final = h.accepted[0];
  assert.deepEqual(final.actions.map(a => a.title), ['A']);
  assert.equal(final.withdrawStaged, undefined, 'the control field never reaches validation');
});

test('nothing staged: the final output reaches the host unchanged', async () => {
  const seen = [];
  const h = host([], { accept: plan => seen.push(plan) });
  const final = json({ message: '直接回答', actions: [] });
  assert.equal(await h.start(final), final);
  assert.equal(h.run.stagedWrites, undefined);
});

test('a failed final validation withdraws staged writes before the repair request', async () => {
  let checks = 0;
  const h = host([json({ message: '先回答' }), json({ message: '修正后', actions: [note('B')] })], {
    accept: plan => { if (++checks === 1) throw Object.assign(Error('附件引用无效'), { code: 'INVALID_PLAN' }); },
  });
  await h.start(json({ knowledgeRequests: [read('a')], actions: [note('A')] }));
  // The first final had no own actions, so the staged one was merged and failed.
  assert.equal(h.repairs.length, 1); assert.deepEqual(h.repairs[0].withdrawn, ['staged-1']);
  assert.deepEqual(h.accepted[0].actions.map(a => a.title), ['B'], 'the repaired plan states its writes itself');
  assert.equal(h.run.formatRepairCount, 1); assert.deepEqual(h.run.withdrawnStagedWrites.map(r => r.id), ['staged-1']);
});

test('repairs: at most two in a row; a tool batch that runs resets the streak', async () => {
  const bad = json({ message: '' });
  let n = 0;
  const h = host([], {
    accept: plan => { if (!plan.message) throw Object.assign(Error('空回答'), { code: 'EMPTY' }); },
    // invalid → repair 1 → tool batch (reset) → invalid → repair 1 → invalid → repair 2 → invalid → fail
    repair: async () => [json({ knowledgeRequests: [read('b')] }), bad, bad, bad][n++],
  });
  h.options.ask = async () => bad;
  await assert.rejects(h.start(bad), { code: 'EMPTY' });
  assert.equal(n, 3); assert.deepEqual(h.executed, ['b']);
  assert.equal(h.run.formatRepairCount, 3); assert.equal(h.run.formatRepairStreak, 2);
});

test('cancellation is never repaired', async () => {
  const h = host([], { accept: () => { throw Object.assign(Error('stopped'), { code: 'CANCELLED' }); } });
  await assert.rejects(h.start(json({ message: 'x' })), { code: 'CANCELLED' });
  assert.equal(h.repairs.length, 0);
  // before() runs outside the repairable part: an inactive run fails as is.
  const g = host([]); g.options.finalize.before = () => { throw Object.assign(Error('scope revoked'), { code: 'SCOPE' }); };
  await assert.rejects(g.start(json({ message: 'x' })), { code: 'SCOPE' });
  assert.equal(g.repairs.length, 0);
});

test('malformed tool batches share the budget: two corrections in a row, then the error', async () => {
  const h = host([json({ knowledgeRequests: [{ type: '' }] }), json({ knowledgeRequests: [{ type: '' }] })]);
  await assert.rejects(h.start(json({ knowledgeRequests: [{ type: '' }] })), { code: 'INVALID_KNOWLEDGE_REQUESTS' });
  assert.equal(h.asks.length, 2); assert.match(h.asks[0], /连续修正最多 2 次/);
  assert.equal(h.executed.length, 0);
});

test('without a staging host (subagents) the tool phase stays read-only', async () => {
  await assert.rejects(K.continuePlan(json({ knowledgeRequests: [read('a')], actions: [note('A')] }), { execute: async () => ({}), ask: async () => json({ message: 'x' }) }), /检索步骤不能同时修改资料/);
});

test('an invalid batch stages nothing', async () => {
  const h = host([json({ message: 'ok', actions: [] })]);
  await h.start(json({ knowledgeRequests: [{ type: '' }], actions: [note('A')] }));
  assert.equal((h.run.stagedWrites || []).length, 0);
  assert.deepEqual(h.accepted[0].actions, []);
});

test('no KnowledgeAccess: the same finalize and repair budget apply', async () => {
  // The truncated first reply fails to parse; the repaired one is accepted.
  const h = host([json({ message: 'fixed', actions: [] })]);
  h.options.knowledge = null;
  assert.equal(await h.start('{"message":'), json({ message: 'fixed', actions: [] }));
  assert.equal(h.run.formatRepairCount, 1);
});

test('recordResult keeps the run ledgers and returns the step to show', () => {
  const run = { noteContextIds: [] }, live = {};
  const search = RunLoop.recordResult(run, live, { type: 'search', query: 'q' }, { total: 1, offset: 0, nextOffset: null, coverage: { c: 1 }, entries: [{ id: 'n1', chunkId: 'c1', type: 'note', title: 'T' }] });
  assert.equal(search.text, '已检索知识库，可继续读取'); assert.equal(search.save, true);
  assert.equal(live.retrievedSources.length, 1); assert.deepEqual(run.retrievalCoverage, { c: 1 });
  RunLoop.recordResult(run, live, { type: 'read', id: 'n1' }, { type: 'note', id: 'n1', text: 'x' });
  assert.deepEqual(run.noteContextIds, ['n1']); assert.equal(run.knowledgeReads.length, 2);
  assert.deepEqual(RunLoop.recordResult(run, live, { type: 'capabilities', name: 'x' }, {}), { text: '已按需加载操作说明', status: 'done' });
  const tracked = []; const step = RunLoop.recordResult(run, live, { type: 'terminal' }, { status: 'failed' }, { trackRead: r => tracked.push(r) });
  assert.deepEqual(step, { text: '本机命令：failed', status: 'failed', save: true }); assert.equal(tracked.length, 1);
});

test('kernel rules: one list for both hosts; the bench text is unchanged', () => {
  const bench = KernelRules.text('bench'), app = KernelRules.text('app');
  // Hash of the bench's pre-P8a rule text (route-a.cjs RULES, 6 rules).
  assert.equal(require('node:crypto').createHash('sha256').update(bench).digest('hex').slice(0, 12), 'a0c2fa99d5dd');
  assert.match(app, /按最严的口径计数/); assert.match(app, /OUTCOME_UNKNOWN/);
  assert.doesNotMatch(app, /写完后自己核对/, 'the main window writes at the end of the run, not in the tool phase');
  assert.equal(app.split('\n').length, 1 + KernelRules.forHost('app').length);
});
