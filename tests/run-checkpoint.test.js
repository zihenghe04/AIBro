const test = require('node:test');
const assert = require('node:assert/strict');
const Checkpoint = require('../app/run-checkpoint');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture(saved) {
  let state = saved ? clone(saved) : { notes: [], conversations: [{ id: 'chat', messages: [{ id: 'message', text: 'partial', live: true }] }],
    agentRuns: [{ id: 'run', conversationId: 'chat', status: 'running', pendingActions: [{ type: 'create_note', title: 'Synthetic result' }], steps: [] }] };
  const calls = { apply: 0, validate: 0, persist: 0, settled: 0, snapshots: [], reasons: [] };
  let persist = async () => {}, validate = async () => {}, settle = async () => {}, clock = 100, serial = 0;
  let apply = (actions, run, beforeCommit) => {
    const notes = [...state.notes, ...actions.map((action, i) => ({ id: 'note-' + i, title: action.title }))];
    beforeCommit(); state.notes = notes; run.results = actions.map((action, i) => ({ type: 'note', id: 'note-' + i, operation: 'created' }));
    return run.results;
  };
  const api = Checkpoint.create({ getState: () => state, uid: prefix => prefix + '-' + ++serial, now: () => ++clock,
    persist: async () => { calls.persist++; const snapshot = clone(state); const result = await persist(snapshot); calls.snapshots.push(snapshot); return result; },
    apply: (...args) => { calls.apply++; return apply(...args); }, validate: async (...args) => { calls.validate++; return validate(...args); },
    onSettled: async (...args) => { calls.settled++; return settle(...args); }, changed: (_, reason) => calls.reasons.push(reason),
  });
  return { api, calls, get state() { return state; }, set state(value) { state = value; }, get run() { return state.agentRuns[0]; },
    get message() { return state.conversations[0].messages[0]; }, setPersist(fn) { persist = fn; }, setValidate(fn) { validate = fn; }, setApply(fn) { apply = fn; }, setSettled(fn) { settle = fn; },
    prepare: options => api.prepare('run', 'message', { answer: 'The actual result', ...options }),
  };
}

test('prepared snapshot is durable before validation/application; completion and callbacks await the applied snapshot', async () => {
  const f = fixture(), gate = deferred();
  f.setPersist(snapshot => {
    if (snapshot.agentRuns[0].executionReceipt.phase === 'prepared') {
      assert.equal(f.calls.apply, 0); assert.equal(snapshot.notes.length, 0);
    } else {
      assert.equal(snapshot.notes.length, 1); assert.equal(snapshot.agentRuns[0].status, 'awaiting-save');
      assert.equal(f.calls.settled, 0); return gate.promise;
    }
  });
  const pending = f.prepare();
  for (let i = 0; i < 15 && f.calls.persist < 2; i++) await Promise.resolve();
  assert.equal(f.run.status, 'awaiting-save'); assert.equal(f.run.executionReceipt.phase, 'applied');
  assert.equal(f.message.text, 'partial'); assert.equal(f.calls.settled, 0); assert.equal(f.api.isBusy(), true);
  gate.resolve(); const receipt = await pending;
  assert.equal(receipt.phase, 'committed'); assert.equal(f.run.status, 'completed'); assert.equal(f.message.text, 'The actual result');
  assert.deepEqual(receipt.results, f.run.results); assert.equal(f.calls.apply, 1); assert.equal(f.calls.settled, 1); assert.equal(f.api.isBusy(), false);
  assert.equal(f.api.view(f.run).hasSavedResult, true);
});

test('preparation save rejection has no effects and explicit continuation re-saves the same frozen plan', async () => {
  const f = fixture(); f.setPersist(async () => { throw Error('disk full'); });
  await assert.rejects(f.prepare(), { code: 'CHECKPOINT_SAVE_FAILED' });
  const receipt = f.run.executionReceipt; assert.equal(receipt.phase, 'prepared'); assert.equal(f.run.status, 'interrupted');
  assert.equal(f.calls.apply, 0); assert.equal(f.calls.validate, 0); assert.equal(f.state.notes.length, 0);
  f.setPersist(async () => {}); await f.api.continue('run');
  assert.equal(f.run.executionReceipt, receipt); assert.equal(f.calls.apply, 1); assert.equal(f.run.status, 'completed');
});

test('post-application save failure and retry never apply twice', async () => {
  const f = fixture(); f.setPersist(async snapshot => { if (snapshot.agentRuns[0].executionReceipt.phase === 'applied') throw Error('save acknowledgement unavailable'); });
  await assert.rejects(f.prepare(), { code: 'CHECKPOINT_SAVE_FAILED' });
  assert.equal(f.run.executionReceipt.phase, 'applied'); assert.equal(f.run.status, 'awaiting-save'); assert.equal(f.calls.settled, 0);
  f.setPersist(async () => {}); await f.api.save('run'); await f.api.continue('run'); await f.prepare({ answer: 'must not replace' });
  assert.equal(f.calls.apply, 1); assert.equal(f.calls.settled, 1); assert.equal(f.message.text, 'The actual result');
});

test('lost applied-save acknowledgement can hydrate and re-save without replay', async () => {
  const f = fixture(); let disk;
  f.setPersist(async snapshot => { disk = snapshot; if (snapshot.agentRuns[0].executionReceipt.phase === 'applied') throw Error('ack lost after disk commit'); });
  await assert.rejects(f.prepare());
  const restored = fixture(disk); restored.api.recover(restored.state);
  assert.equal(restored.run.status, 'awaiting-save'); assert.equal(restored.state.notes.length, 1);
  await restored.api.save('run'); assert.equal(restored.calls.apply, 0); assert.equal(restored.run.status, 'completed');
});

test('startup recovery never executes prepared actions and preserves approved/rejected owners', async () => {
  const f = fixture(); f.setPersist(async () => { throw Error('unavailable'); }); await assert.rejects(f.prepare());
  const restored = fixture(f.state); restored.run.status = 'running';
  assert.equal(restored.api.recover(restored.state), true); assert.equal(restored.run.status, 'interrupted'); assert.equal(restored.calls.apply, 0);
  for (const status of ['awaiting-approval', 'rejected']) { restored.run.status = status; assert.equal(restored.api.recover(restored.state), false); assert.equal(restored.run.status, status); }
  restored.run.status = 'awaiting-save'; restored.run.approvalReceipt = { id: 'approval-owner' };
  assert.equal(restored.api.recover(restored.state), false); assert.equal(restored.run.status, 'awaiting-save');
});

test('onSettled failure cannot invalidate an acknowledged commit or run twice', async () => {
  const f = fixture(); f.setSettled(async () => { throw Error('view update failed'); }); await f.prepare();
  assert.equal(f.run.status, 'completed'); assert.match(f.run.executionReceipt.followupError, /view update/);
  await f.api.save('run'); await f.api.continue('run'); assert.equal(f.calls.settled, 1); assert.equal(f.calls.apply, 1);
});

for (const mutation of ['replace', 'remove', 'change-plan', 'change-receipt']) test('awaited validation rejects ' + mutation + ' without applying', async () => {
  const f = fixture(), gate = deferred(); f.setValidate(() => gate.promise); const pending = f.prepare();
  for (let i = 0; i < 15 && !f.calls.validate; i++) await Promise.resolve();
  if (mutation === 'replace') f.state = clone(f.state);
  if (mutation === 'remove') f.state.agentRuns = [];
  if (mutation === 'change-plan') f.run.pendingActions[0].title = 'Different';
  if (mutation === 'change-receipt') f.run.executionReceipt.answer = 'Changed while waiting';
  gate.resolve(); await assert.rejects(pending); assert.equal(f.calls.apply, 0); assert.equal(f.state.notes.length, 0);
  if (mutation === 'replace') { assert.equal(f.run.status, 'running'); assert.equal(f.run.executionReceipt.error, undefined); }
});

test('another run and duplicate continue are locked before the first await', async () => {
  const f = fixture(), gate = deferred(); f.setPersist(() => gate.promise); const pending = f.prepare();
  assert.equal(f.api.view(f.run).busy, true); assert.equal(f.api.view(f.run).canContinue, false);
  await assert.rejects(f.api.continue('run'), { code: 'CHECKPOINT_BUSY' });
  await assert.rejects(f.api.prepare('another', 'message', { answer: '' }), { code: 'CHECKPOINT_BUSY' });
  f.setPersist(async () => {}); gate.resolve(); await pending; assert.equal(f.calls.apply, 1);
});

test('zero actions still persist the answer before reporting completion', async () => {
  const f = fixture(); f.run.pendingActions = []; await f.prepare({ answer: 'A direct answer', clarify: { questions: [{ id: 'q' }], draft: {} } });
  assert.equal(f.calls.persist, 2); assert.equal(f.state.notes.length, 0); assert.equal(f.message.text, 'A direct answer');
  assert.deepEqual(f.message.clarify, { questions: [{ id: 'q' }], draft: {} }); assert.equal(f.run.executionReceipt.actionCount, 0);
  assert.equal(f.run.status, 'completed'); assert.equal(f.api.view(f.run).hasSavedResult, false);
});

test('receipt presentation accepts known persisted operations and rejects proposals, no-ops and malformed results', () => {
  const receipt = results => ({ version: 1, phase: 'committed', actionCount: 1, results });
  const view = results => Checkpoint.view({ executionReceipt: receipt(results) });
  for (const [type, operation] of [['note', 'created'], ['note', 'updated'], ['task', 'created'], ['task', 'updated'],
    ['project', 'created'], ['project', 'linked'], ['import', 'assigned'], ['import', 'renamed'], ['import', 'updated'], ['paper', 'updated']]) {
    assert.equal(view([{ type, operation, id: 'actual-record' }]).hasSavedResult, true, `${type}:${operation}`);
  }
  for (const result of [null, {}, { type: 'note', id: 'note' }, { type: 'note', id: '', operation: 'created' },
    { type: 'note', id: 1, operation: 'created' }, { type: 'note', id: 'note', operation: 'matched' },
    { type: 'note', id: 'note', operation: 'drafted' }, { type: 'note', id: 'note', operation: 'deleted' },
    { type: 'note', id: 'note', operation: 'created', undoneAt: 1 }, { type: 'note', id: 'note', operation: 'assigned' },
    { type: 'schedule-proposal', id: 'proposal', operation: 'created' }, { type: 'tool', id: 'read', operation: 'completed' }]) {
    assert.equal(view([result]).hasSavedResult, false, JSON.stringify(result));
  }
  for (const results of [undefined, null, {}, []]) assert.equal(view(results).hasSavedResult, false);
  for (const overrides of [{ phase: 'prepared' }, { phase: 'applied' }, { actionCount: 0 }, { actionCount: '1' }, { actionCount: -1 }]) {
    assert.equal(Checkpoint.view({ executionReceipt: { ...receipt([{ type: 'note', id: 'note', operation: 'created' }]), ...overrides } }).hasSavedResult, false);
  }
  assert.equal(view([{ type: 'note', id: 'draft', operation: 'drafted' }, { type: 'task', id: 'task', operation: 'created' }]).hasSavedResult, true);
});

test('result identity changed during durable save cannot be reported as completed', async () => {
  const f = fixture(), gate = deferred(); f.setPersist(snapshot => snapshot.agentRuns[0].executionReceipt.phase === 'applied' ? gate.promise : undefined);
  const pending = f.prepare(); for (let i = 0; i < 15 && f.calls.persist < 2; i++) await Promise.resolve();
  f.run.results = [{ type: 'note', id: 'different' }]; gate.resolve(); await assert.rejects(pending, { code: 'CHECKPOINT_RESULTS_CHANGED' });
  assert.equal(f.run.executionReceipt.phase, 'applied'); assert.equal(f.calls.settled, 0); assert.equal(f.calls.apply, 1);
  await assert.rejects(f.api.save('run'), { code: 'CHECKPOINT_RESULTS_CHANGED' }); assert.equal(f.calls.apply, 1);
});

test('failure after the synchronous commit boundary is save-only, never a fresh execution', async () => {
  const f = fixture(); f.setApply((actions, run, beforeCommit) => { beforeCommit(); f.state.notes.push({ id: 'effect' }); run.results = [{ type: 'note', id: 'effect' }]; throw Error('post-commit display error'); });
  await assert.rejects(f.prepare(), /post-commit display/); assert.equal(f.run.executionReceipt.phase, 'applied');
  await f.api.save('run'); assert.equal(f.calls.apply, 1); assert.equal(f.state.notes.length, 1);
});

test('rejected/unknown phases stay unavailable and cannot be replaced by prepare', async () => {
  const f = fixture(); f.run.executionReceipt = { version: 1, id: 'original', phase: 'rejected', messageId: 'message' };
  assert.equal(f.api.view(f.run), null); await assert.rejects(f.prepare(), { code: 'CHECKPOINT_PHASE' });
  assert.equal(f.run.executionReceipt.id, 'original'); assert.equal(f.calls.apply, 0); assert.equal(f.calls.persist, 0);
});

test('false persistence acknowledgement blocks execution with a meaningful error', async () => {
  const f = fixture(); f.setPersist(async () => false); await assert.rejects(f.prepare(), { code: 'CHECKPOINT_SAVE_FAILED' }); assert.equal(f.calls.apply, 0);
  assert.equal(f.calls.reasons.at(-1), 'idle'); assert.equal(f.api.view(f.run).canContinue, true);
});

test('same-id replacement during applied-save acknowledgement never completes or mutates the replacement', async () => {
  const f = fixture(), gate = deferred(); f.setPersist(snapshot => snapshot.agentRuns[0].executionReceipt.phase === 'applied' ? gate.promise : undefined);
  const pending = f.prepare(); for (let i = 0; i < 15 && f.calls.persist < 2; i++) await Promise.resolve();
  f.state = clone(f.state); const before = clone(f.state); gate.resolve();
  await assert.rejects(pending, { code: 'CHECKPOINT_CHANGED' }); assert.deepEqual(f.state, before); assert.equal(f.calls.settled, 0);
});

test('late apply callback is rejected after the synchronous hook has returned', async () => {
  const f = fixture(); let late;
  f.setApply((actions, run, beforeCommit) => { late = beforeCommit; });
  await assert.rejects(f.prepare(), { code: 'CHECKPOINT_APPLY_CONTRACT' });
  assert.throws(late, { code: 'CHECKPOINT_APPLY_CONTRACT' }); assert.equal(f.run.executionReceipt.phase, 'prepared');
});
