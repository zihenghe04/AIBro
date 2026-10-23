// P8a: plan-level approval (approval card, "allow for this session", reviewer)
// decided by ApprovalBroker.decidePlan. Same contract as tool calls: every
// reason can only tighten; waivers and answerers are closed sets.
const test = require('node:test'), assert = require('node:assert/strict');
const Broker = require('../app/approval-broker.js');
const Policy = require('../app/permission-policy.js');

const MODES = ['request', 'smart', 'full', 'legacy', undefined, 'bogus'];
const PLANS = [[{ type: 'create_task' }], [{ type: 'create_note' }], [{ type: 'delete_task' }], [{ type: 'assign_record' }], [{ type: 'run_shell' }], [{ type: 'create_task' }, { type: 'delete_note' }]];
const SPACES = [[], ['日常'], ['课程', '科研']];
const PERMISSIONS = [{}, { 日常: 'approval' }, { 课程: 'auto', 科研: 'approval' }];
const FLAGS = ['approvalIntent', 'requiresAssignmentReview', 'routingReview'];
const contexts = function* () {
  for (const mode of MODES) for (const actions of PLANS) for (const spaces of SPACES) for (const permissions of PERMISSIONS)
    for (const allows of [undefined, { create_task: 1 }, { create_task: 1, create_note: 1, delete_task: 1, assign_record: 1 }])
      yield { mode, actions, spaces, permissions, sessionAllows: allows, reviewerEnabled: true };
};

test('the permission policy alone decides exactly as before (needsApproval, then session allow)', () => {
  for (const ctx of contexts()) {
    const d = Broker.decidePlan(ctx, Policy);
    const legacyDeletion = (ctx.mode === 'legacy' || !['request', 'smart', 'full'].includes(ctx.mode)) && ctx.actions.some(a => /delete|merge|remove|archive/.test(a.type));
    const before = legacyDeletion || Policy.needsApproval({ mode: ctx.mode, actions: ctx.actions, spaces: ctx.spaces, permissions: ctx.permissions }) && !(ctx.sessionAllows && Policy.canSessionAllow({ actions: ctx.actions, allows: ctx.sessionAllows }));
    assert.equal(d.vote === 'ask', before, JSON.stringify(ctx));
  }
});

test('adding any review reason never loosens a plan decision, and those reasons are never waived', () => {
  for (const ctx of contexts()) {
    const base = Broker.decidePlan(ctx, Policy);
    for (const flag of FLAGS) {
      const tightened = Broker.decidePlan({ ...ctx, [flag]: true }, Policy);
      assert.ok(Broker.RANK[tightened.vote] >= Broker.RANK[base.vote]);
      assert.equal(tightened.vote, 'ask', `${flag} always asks`);
      assert.equal(tightened.waived, null, `${flag} is not waived by session allow`);
    }
  }
});

test('no actions: nothing to approve; a throwing or missing policy asks', () => {
  assert.equal(Broker.decidePlan({ actions: [], approvalIntent: true }, Policy).vote, 'allow');
  const broken = { needsApproval() { throw Error('boom'); }, canSessionAllow: () => true };
  assert.equal(Broker.decidePlan({ actions: [{ type: 'create_task' }], mode: 'full', sessionAllows: { create_task: 1 } }, broken).vote, 'ask', 'a policy that failed cannot be waived');
  const brokenNoWaiver = { needsApproval() { throw Error('boom'); } };
  assert.equal(Broker.decidePlan({ actions: [{ type: 'create_task' }], mode: 'full' }, brokenNoWaiver).vote, 'ask');
  // Without a policy object the old per-space fallback applies.
  const saved = globalThis.WorkstationPermissionPolicy; delete globalThis.WorkstationPermissionPolicy;
  try {
    assert.equal(Broker.decidePlan({ actions: [{ type: 'create_task' }], spaces: ['日常'], permissions: { 日常: 'approval' } }).vote, 'ask');
    assert.equal(Broker.decidePlan({ actions: [{ type: 'create_task' }], spaces: ['日常'], permissions: {} }).vote, 'allow');
  } finally { if (saved) globalThis.WorkstationPermissionPolicy = saved; }
});

test('answerers: the user always; the reviewer only where delegation is allowed', () => {
  const ask = { mode: 'request', actions: [{ type: 'create_task' }], reviewerEnabled: true };
  assert.deepEqual(Broker.decidePlan(ask, Policy).answerers, ['user', 'reviewer']);
  assert.ok(Broker.mayAnswer(Broker.decidePlan(ask, Policy), 'reviewer'));
  for (const extra of [{ approvalIntent: true }, { routingReview: true }, { reviewerEnabled: false }, { actions: [{ type: 'delete_task' }] }, { actions: [{ type: 'assign_record' }] }, { actions: [{ type: 'run_shell' }] }])
    assert.equal(Broker.mayAnswer(Broker.decidePlan({ ...ask, ...extra }, Policy), 'reviewer'), false, JSON.stringify(extra));
  // Answerers do not depend on the current vote (the card was already shown);
  // unknown answerers never answer.
  assert.deepEqual(Broker.decidePlan({ mode: 'full', actions: [{ type: 'delete_task' }], reviewerEnabled: true }, Policy).answerers, ['user']);
  assert.equal(Broker.mayAnswer(Broker.decidePlan(ask, Policy), 'session-allow'), false);
  assert.equal(Broker.mayAnswer(null, 'user'), false);
});

test('session-allow types are offered only without "show me first" or routing review', () => {
  const ctx = { mode: 'request', actions: [{ type: 'create_task' }, { type: 'delete_task' }] };
  assert.deepEqual(Broker.decidePlan(ctx, Policy).sessionTypes, ['create_task']);
  assert.deepEqual(Broker.decidePlan({ ...ctx, approvalIntent: true }, Policy).sessionTypes, []);
  assert.deepEqual(Broker.decidePlan({ ...ctx, routingReview: true }, Policy).sessionTypes, []);
  // A granted type waives only the policy's vote, and only when every action is covered.
  assert.equal(Broker.decidePlan({ mode: 'request', actions: [{ type: 'create_task' }], sessionAllows: { create_task: 1 } }, Policy).waived, 'session-allow');
  assert.equal(Broker.decidePlan({ ...ctx, sessionAllows: { create_task: 1, delete_task: 1 } }, Policy).vote, 'ask');
});

// "完全访问" (full) and "风险审批" (smart) approve automatically; only the
// safety boundaries and high-risk exceptions still ask. Freezing must not turn
// either into ask-every-time.
test('full and smart modes approve automatically within the safety boundaries', () => {
  const ordinary = [{ type: 'create_task' }, { type: 'update_task' }, { type: 'create_note' }, { type: 'append_note' }];
  const strictSpaces = { spaces: ['日常', '课程', '科研'], permissions: { 日常: 'approval', 课程: 'approval', 科研: 'approval' } };
  for (const mode of ['full', 'smart']) {
    // The run's mode after freezing: unchanged mode, or a run saved before freezing existed.
    for (const effective of [Broker.effectiveMode(mode, mode), Broker.effectiveMode(undefined, mode)]) {
      assert.equal(effective, mode);
      for (const action of ordinary) assert.equal(Broker.decidePlan({ mode: effective, actions: [action], ...strictSpaces }, Policy).vote, 'allow', `${mode} ${action.type}`);
      assert.equal(Broker.decidePlan({ mode: effective, actions: ordinary, ...strictSpaces }, Policy).vote, 'allow');
      // Safety boundaries: "show me first", routing/assignment review and unknown operations still ask.
      for (const extra of [{ approvalIntent: true }, { routingReview: true }, { requiresAssignmentReview: true }, { actions: [{ type: 'run_shell' }] }])
        assert.equal(Broker.decidePlan({ mode: effective, actions: ordinary, ...strictSpaces, ...extra }, Policy).vote, 'ask', `${mode} ${JSON.stringify(extra)}`);
    }
  }
  // High-risk exception: deletion asks under smart, runs automatically under full.
  assert.equal(Broker.decidePlan({ mode: 'smart', actions: [{ type: 'delete_task' }] }, Policy).vote, 'ask');
  assert.equal(Broker.decidePlan({ mode: 'full', actions: [{ type: 'delete_task' }] }, Policy).vote, 'allow');
  // Switching full → smart mid-run tightens to smart (still automatic for ordinary work), never to per-step asking.
  assert.equal(Broker.effectiveMode('full', 'smart'), 'smart');
  assert.equal(Broker.decidePlan({ mode: Broker.effectiveMode('full', 'smart'), actions: ordinary }, Policy).vote, 'allow');
  // Tool calls with approval:'policy' and a local effect run without asking in both modes; destructive specs still ask.
  for (const permissionMode of ['full', 'smart']) {
    assert.equal(Broker.decide({ effect: 'local', approval: 'policy' }, { permissionMode }), 'allow');
    assert.equal(Broker.decide({ effect: 'local', approval: 'policy', destructive: true }, { permissionMode }), 'ask');
  }
  assert.equal(Broker.decide({ effect: 'local', approval: 'policy' }, { permissionMode: 'request' }), 'ask');
});

test('deletion under full access: undoable trash deletions run, irreversible operations always ask (policy and broker agree)', () => {
  const reversible = ['delete_task', 'delete_note', 'delete_project', 'delete_attachment'];
  const irreversible = ['purge_trash', 'permanent_delete', 'delete_credential', 'merge_notes', 'empty_trash'];
  assert.deepEqual([...Policy.REVERSIBLE_DELETES].sort(), [...reversible].sort());
  for (const type of reversible) assert.equal(Policy.irreversible(type), false, type);
  const expected = { full: ['allow', 'ask'], smart: ['ask', 'ask'], request: ['ask', 'ask'] };
  for (const [mode, [onReversible, onIrreversible]] of Object.entries(expected)) {
    for (const type of reversible) {
      assert.equal(Policy.needsApproval({ mode, actions: [{ type }] }), onReversible === 'ask', `policy ${mode} ${type}`);
      assert.equal(Broker.decidePlan({ mode, actions: [{ type }] }, Policy).vote, onReversible, `broker ${mode} ${type}`);
    }
    for (const type of irreversible) {
      assert.equal(Policy.needsApproval({ mode, actions: [{ type }] }), true, `policy ${mode} ${type}`);
      assert.equal(Broker.decidePlan({ mode, actions: [{ type }] }, Policy).vote, onIrreversible, `broker ${mode} ${type}`);
    }
  }
  // An irreversible operation mixed into an otherwise automatic plan stops the whole plan,
  // cannot be waived by "allowed for this session", and is never delegated to the reviewer.
  const mixed = Broker.decidePlan({ mode: 'full', actions: [{ type: 'create_task' }, { type: 'purge_trash' }], sessionAllows: { create_task: true, purge_trash: true }, reviewerEnabled: true }, Policy);
  assert.equal(mixed.vote, 'ask'); assert.equal(mixed.waived, null); assert.ok(!mixed.answerers.includes('reviewer'));
  assert.ok(Broker.decidePlan({ mode: 'full', actions: [{ type: 'merge_notes' }] }, Policy).reasons.includes('irreversible'));
  assert.ok(Broker.PLAN_UNWAIVABLE.includes('irreversible'));
  // Background runs: destructive tools ask in every mode, whatever their reversibility.
  for (const permissionMode of ['full', 'smart']) assert.equal(Broker.decide({ effect: 'local', approval: 'policy', destructive: true }, { permissionMode, unattended: true }), 'ask');
});

test('the full-access description names undoable deletions and the irreversible exception in both languages', () => {
  const fs = require('fs'), path = require('path');
  const picker = fs.readFileSync(path.join(__dirname, '../app/permission-picker.js'), 'utf8'), en = fs.readFileSync(path.join(__dirname, '../app/i18n-en.js'), 'utf8');
  const zh = '自动执行当前支持的操作，含可撤销的删除（移入回收站）；永久删除等不可恢复的操作仍需你批准。限已连接的本机目录。';
  const english = 'Run supported actions automatically, including undoable deletions (moved to the trash). Permanent deletion and other irreversible actions still need your approval. Limited to connected local folders.';
  assert.ok(picker.includes(`['full', '完全访问', '${zh}', 'shield', 'Full access', '${english}']`));
  assert.ok(en.includes(`"${zh}": "${english}"`));
});
