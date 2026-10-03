const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const installRunCheckpointHost = require('./helpers/run-checkpoint-host.cjs');
const Core = require('../app/workstation-core');
const PlanReview = require('../app/plan-review');
const TaskContext = require('../app/task-context');
const WorkstationPermissionPolicy = require('../app/permission-policy');
const ReviewerDelegate = require('../app/reviewer-delegate');
const ApprovalIntent = require('../app/approval-intent');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
function cut(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Actual host source boundaries exist: ${start}`);
  return source.slice(from, to);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate) {
  for (let i = 0; i < 30; i++) { if (predicate()) return; await Promise.resolve(); }
  assert.ok(predicate(), 'Expected async host boundary was reached');
}

// Only platform boundaries are injected. Approval, receipt saving, reviewer
// decisions, permission policy, editable-plan validation and Core are real.
function fixture(actions = [{ type: 'create_task', title: 'Approved task' }], savedState) {
  const state = savedState ? clone(savedState) : {
    projects: [{ id: 'project', name: 'Research', workspace: '科研' }], tasks: [],
    notes: [{ id: 'note', title: 'Existing note', content: 'Human content', kind: '主笔记', projectId: 'project', workspace: '科研', updatedAt: 1 }],
    imports: [{ id: 'source', name: 'Source.txt', content: 'Evidence', projectId: 'project', workspace: '科研', updatedAt: 1 }],
    attachments: [], links: [], papers: [], trash: [],
    conversations: [{ id: 'chat', projectId: 'project', workspace: '科研', reviewerApprove: true, messages: [{ id: 'message', pendingRunId: 'run', text: 'Please review.' }] }],
    agentRuns: [{ id: 'run', status: 'awaiting-approval', conversationId: 'chat', projectId: 'project', workspace: '科研', permissionMode: 'request', pendingActions: clone(actions), steps: [] }],
    settings: { permissions: { 科研: 'approval', 日常: 'auto' } }, ui: {}, currentConversationId: 'chat'
  };
  const calls = { execute: 0, preview: 0, save: 0, durable: 0, render: 0, sound: 0, goal: 0, requests: [], errors: [], queuedSnapshots: [], durableSnapshots: [] };
  let serial = 0, durable = async () => true, transport = async () => JSON.stringify({ verdict: 'approve', reasons: ['Synthetic review'], risks: [] });
  const window = { TaskContext, WorkstationPermissionPolicy, ReviewerDelegate, ApprovalIntent, AlertSound: { play: () => calls.sound++ }, GoalLoop: { onRoundFinished: () => calls.goal++ } };
  const c = vm.createContext({ state, window, structuredClone, AbortController, setTimeout, clearTimeout,
    Core: { ...Core, applyPlan: (...args) => { calls.execute++; return Core.applyPlan(...args); } },
    WorkstationPermissionPolicy, ReviewerDelegate, TaskContext, workspaceName: value => value || '日常',
    uid: prefix => `${prefix}-fixture-${++serial}`, normalizeStateShape() {},
    addRunStep: (run, text, status = 'done') => run.steps.push({ text, status }),
    save: () => { calls.save++; calls.queuedSnapshots.push(clone(c.state)); },
    saveDocumentDurably: async () => { calls.durable++; calls.durableSnapshots.push(clone(c.state)); return durable(c); },
    // This fixture covers approvals with no path transaction; branch-host tests load the real lock.
    conversationPathSaving: () => false,
    renderAll: () => { calls.render++; }, renderConversation: () => { calls.render++; }, toast: message => calls.errors.push(String(message)),
    captureApiConnection: () => ({ protocol: 'responses' }),
    getApiConnection: async () => ({ base: 'https://synthetic.invalid', token: 'synthetic-only' }),
    resolveRunModel: () => ({ provider: 'api', model: 'synthetic-model' }),
    AgentTransport: { requestPlan: async request => { calls.requests.push(request); return transport(request); } }, activeRunController: null
  });
  vm.runInContext([
    cut('function commitAttachmentAnalysis(', '\nfunction fallbackWorkflow('),
    cut('function actionsNeedApproval(', '\nfunction grantSessionAllow('),
    cut('function grantSessionAllow(', '\nconst ACTION_LABELS'),
    cut('function sessionAllowMarkup(', '\nlet runCheckpointController'),
    cut('function approvalBusy(', '\nasync function fetchWithTimeout('),
    cut('function assertRunActive(', '\nlet activeRunController'),
    cut('async function requestReviewerOpinion(', '\nfunction reviewerMarkup('),
    cut('let delegatedReviewTimer =', '\n// 人一旦亲自批准')
  ].join('\n'), c);
  installRunCheckpointHost(c);
  const plan = PlanReview.createController({
    getState: () => c.state, getRun: id => c.state.agentRuns.find(run => run.id === id), contextForRun: run => c.approvalContext(run),
    applyPlan: (snapshot, actions, context) => { calls.preview++; const run = snapshot.agentRuns.find(item => item.id === context.runId); if (run?.taskContext) TaskContext.assertUnchanged(snapshot, actions, run.taskContext.snapshots); return Core.applyPlan(snapshot, actions, context); }, recheckPlan: (...args) => c.recheckApprovalPlan(...args), save: () => c.saveDocumentDurably(),
    isBusy: () => !!c.approveRun.busy?.size
  });
  c.window.PlanReview = plan;
  return { c, calls, plan, get run() { return c.state.agentRuns.find(run => run.id === 'run'); }, get chat() { return c.state.conversations.find(chat => chat.id === 'chat'); },
    setDurable: fn => { durable = fn; }, setTransport: fn => { transport = fn; },
    pauseValidation() { const gate = deferred(); const api = { revalidate: () => gate.promise }; c.window.LocalProjectAgent = c.LocalProjectAgent = api; c.window.LocalProjects = c.LocalProjects = {}; return gate; }
  };
}

test('double approval is locked before awaits and completion waits for durable receipt', async () => {
  const f = fixture(), gate = deferred(); f.setDurable(() => gate.promise);
  const first = f.c.approveRun('run');
  assert.equal(await f.c.approveRun('run'), false);
  await until(() => f.calls.durable === 1);
  assert.equal(f.calls.execute, 1); assert.equal(f.calls.sound, 0); assert.equal(f.calls.goal, 0);
  assert.equal(f.c.approvalBusy(), true);
  assert.equal(f.calls.durableSnapshots[0].agentRuns[0].approvalReceipt.savePending, true);
  assert.equal(f.calls.durableSnapshots[0].tasks.length, 1);
  gate.resolve(true); assert.equal(await first, true);
  assert.equal(f.run.status, 'completed'); assert.equal(f.run.approvalReceipt.savePending, false);
  assert.equal(f.chat.messages[0].pendingRunId, null); assert.equal(f.calls.sound, 1); assert.equal(f.calls.goal, 1);
  assert.equal(await f.c.approveRun('run'), false); assert.equal(await f.c.retryApprovalSave('run'), false); assert.equal(f.calls.execute, 1);
});

for (const [name, change] of [
  ['same-id object replacement', f => { f.c.state = clone(f.c.state); }],
  ['changed action', f => { f.run.pendingActions[0].title = 'Unreviewed task'; }],
  ['external rejection', f => { f.run.status = 'rejected'; }],
  ['archived conversation', f => { f.chat.archived = true; }],
  ['deleted conversation', f => { f.chat.deletedAt = 2; }],
  ['deleted run', f => { f.run.deletedAt = 2; }],
  ['archived target project', f => { f.c.state.projects[0].archived = true; }],
  ['changed allowed scope', f => { f.run.noteContextIds = ['note']; }]
]) test(`approval revalidates after await: ${name}`, async () => {
  const f = fixture(), gate = f.pauseValidation(), approving = f.c.approveRun('run');
  change(f); gate.resolve(); assert.equal(await approving, false);
  assert.equal(f.calls.execute, 0); assert.equal(f.c.state.tasks.length, 0); assert.equal(f.calls.durable, 0);
  assert.equal(f.chat.sessionAllows, undefined);
});

test('changed deletion target blocks a byte-identical plan without deleting newer content', async () => {
  const f = fixture([{ type: 'delete_note', noteId: 'note' }]), gate = f.pauseValidation();
  const approving = f.c.approveRun('run'); f.c.state.notes[0].content = 'New human content'; gate.resolve();
  assert.equal(await approving, false); assert.equal(f.calls.execute, 0); assert.equal(f.c.state.notes[0].content, 'New human content');
});

test('source changes invalidate a reviewed derived note and preserve the source', async () => {
  const f = fixture([{ type: 'create_note', title: 'Derived', content: 'Summary', sourceAttachmentIds: ['source'] }]), gate = f.pauseValidation();
  const approving = f.c.approveRun('run'); f.c.state.imports[0].content = 'New evidence'; gate.resolve();
  assert.equal(await approving, false); assert.equal(f.calls.execute, 0); assert.equal(f.c.state.notes.length, 1);
});

test('host lock blocks plan mutation and reject while approval validation is pending', async () => {
  const f = fixture(), row = f.plan.draft('run').rows[0], gate = f.pauseValidation(), approving = f.c.approveRun('run');
  assert.equal(f.c.rejectRun('run'), false);
  for (const action of [() => f.plan.edit('run', row.key, 'title', 'Raced'), () => f.plan.toggle('run', row.key, false), () => f.plan.move('run', row.key, 1), () => f.plan.recheck('run'), () => f.plan.reload('run')]) assert.throws(action, { code: 'PLAN_BUSY' });
  await assert.rejects(f.plan.save('run'), { code: 'PLAN_BUSY' });
  gate.resolve(); assert.equal(await approving, true); assert.equal(f.c.state.tasks[0].title, 'Approved task');
});

for (const [name, change] of [
  ['changed actions', f => { f.run.pendingActions = [{ type: 'delete_note', noteId: 'note' }]; }],
  ['delegate disabled', f => { f.chat.reviewerApprove = false; }],
  ['delegate halted', f => { f.chat.reviewerHalted = true; }],
  ['human rejected', f => { f.c.rejectRun('run'); }],
  ['same-id snapshot replacement', f => { f.c.state = clone(f.c.state); }]
]) test(`late delegated review does not execute after ${name}`, async () => {
  const f = fixture(), gate = deferred(); f.setTransport(() => gate.promise);
  const reviewing = f.c.runDelegatedReview('run'); await until(() => f.calls.requests.length === 1);
  change(f); gate.resolve(JSON.stringify({ verdict: 'approve', reasons: ['Synthetic'], risks: [] }));
  assert.equal(await reviewing, false); assert.equal(f.calls.execute, 0); assert.equal(f.c.state.notes.length, 1); assert.equal(f.calls.goal, 0); assert.equal(f.chat.sessionAllows, undefined);
});

test('review request contains the complete exact structured plan and successful delegate uses one receipt', async () => {
  const title = 'A'.repeat(500), f = fixture([{ type: 'create_task', title, description: 'Unique tail of the reviewed action' }]);
  assert.equal(await f.c.runDelegatedReview('run'), true);
  assert.ok(f.calls.requests[0].input.includes(title)); assert.ok(f.calls.requests[0].input.includes('Unique tail of the reviewed action'));
  assert.equal(f.calls.execute, 1); assert.equal(f.run.approvedBy, 'reviewer'); assert.equal(f.run.status, 'completed');
});

test('session permission is not granted by stale UI or failed preflight, and is saved with successful effects', async () => {
  const stale = fixture(); stale.run.status = 'rejected'; assert.equal(stale.c.grantSessionAllow(stale.run), false); assert.equal(await stale.c.approveRun('run', { sessionAllow: true }), false); assert.equal(stale.chat.sessionAllows, undefined);
  const invalid = fixture([{ type: 'update_task', taskId: 'missing', patch: { title: 'No' } }]); assert.equal(await invalid.c.approveRun('run', { sessionAllow: true }), false); assert.equal(invalid.chat.sessionAllows, undefined);
  const f = fixture(); assert.equal(await f.c.approveRun('run', { sessionAllow: true }), true);
  assert.ok(f.chat.sessionAllows.create_task); assert.ok(f.calls.durableSnapshots[0].conversations[0].sessionAllows.create_task);
  assert.equal(f.calls.durableSnapshots[0].tasks.length, 1);
});

test('post-commit display failure never reports unexecuted or reapplies the plan', async () => {
  const f = fixture(); f.c.addRunStep = () => { throw Error('Synthetic display failure'); };
  assert.equal(await f.c.approveRun('run'), true); assert.equal(f.run.status, 'completed'); assert.equal(f.calls.execute, 1);
  assert.match(f.run.approvalReceipt.displayError, /Synthetic display failure/); assert.doesNotMatch(f.chat.messages[0].text, /未执行/);
});

test('failed save retains applied effects and locked receipt; concurrent retry only saves once', async () => {
  const f = fixture(); f.setDurable(async () => { throw Error('Synthetic disk unavailable'); });
  assert.equal(await f.c.approveRun('run'), false); assert.equal(f.calls.execute, 1); assert.equal(f.run.status, 'awaiting-save'); assert.equal(f.chat.messages[0].pendingRunId, 'run'); assert.equal(f.calls.goal, 0);
  assert.equal(f.c.approvalBusy(), true); assert.equal(await f.c.approveRun('run'), false); assert.equal(f.c.rejectRun('run'), false); assert.equal(await f.c.runDelegatedReview('run'), false); assert.equal(f.c.grantSessionAllow(f.run, f.run.approvalReceipt.id), false);
  assert.throws(() => f.plan.capture('run'), { code: 'PLAN_GONE' });
  const gate = deferred(); f.setDurable(() => gate.promise); const retry = f.c.retryApprovalSave('run');
  assert.equal(await f.c.retryApprovalSave('run'), false); gate.resolve(true); assert.equal(await retry, true);
  assert.equal(f.calls.execute, 1); assert.equal(f.c.state.tasks.length, 1); assert.equal(f.calls.goal, 1); assert.equal(f.calls.sound, 1);
});

test('backend commit followed by lost acknowledgement never replays already applied actions', async () => {
  const f = fixture(); let disk;
  f.setDurable(async c => { disk = clone(c.state); throw Error('Synthetic acknowledgement lost after commit'); });
  assert.equal(await f.c.approveRun('run'), false); assert.equal(disk.agentRuns[0].status, 'completed'); assert.equal(disk.tasks.length, 1);
  const persistedRecovery = f.calls.queuedSnapshots.at(-1); assert.equal(persistedRecovery.agentRuns[0].status, 'awaiting-save');
  const restarted = fixture(undefined, persistedRecovery); assert.equal(await restarted.c.approveRun('run'), false); assert.equal(await restarted.c.retryApprovalSave('run'), true);
  assert.equal(restarted.calls.execute, 0); assert.equal(restarted.c.state.tasks.length, 1); assert.equal(restarted.chat.messages[0].text.includes('undefined'), false);
  const committedRestart = fixture(undefined, disk); assert.equal(await committedRestart.c.approveRun('run'), false); assert.equal(committedRestart.calls.execute, 0);
});

test('same receipt snapshot replacement during durable save settles the canonical result once', async () => {
  const f = fixture(); f.setDurable(async c => { c.state = clone(c.state); return true; });
  assert.equal(await f.c.approveRun('run'), true); assert.equal(f.run.status, 'completed'); assert.equal(f.run.approvalReceipt.savePending, false); assert.equal(f.calls.execute, 1); assert.equal(f.calls.goal, 1);
});

test('different receipt replacement during durable save cannot settle another run outcome', async () => {
  const f = fixture(); f.setDurable(async c => { c.state = clone(c.state); c.state.agentRuns[0].approvalReceipt.id = 'other-writer'; return true; });
  assert.equal(await f.c.approveRun('run'), false); assert.equal(f.run.approvalReceipt.id, 'other-writer'); assert.equal(f.calls.goal, 0); assert.equal(f.calls.execute, 1);
});

test('empty results do not hide a real link mutation or permit a save retry to reapply it', async () => {
  const f = fixture([{ type: 'create_link', sourceId: 'source', targetId: 'note', relation: 'reference' }]); f.setDurable(async () => { throw Error('Synthetic save failure'); });
  assert.equal(await f.c.approveRun('run'), false); assert.equal(f.c.state.links.length, 1); assert.equal(f.run.results.length, 0); assert.ok(f.run.approvalReceipt);
  f.setDurable(async () => true); assert.equal(await f.c.retryApprovalSave('run'), true); assert.equal(f.calls.execute, 1); assert.equal(f.c.state.links.length, 1);
});

test('disabled or reordered prerequisite invalidates the whole plan with no partial effects', async () => {
  const actions = [{ type: 'create_project', id: 'future', name: 'Future', workspace: '科研' }, { type: 'create_task', title: 'Dependent task', projectId: 'future' }];
  for (const mode of ['disable', 'reorder']) {
    const f = fixture(actions), d = f.plan.draft('run');
    if (mode === 'disable') f.plan.toggle('run', d.rows[0].key, false); else f.plan.move('run', d.rows[1].key, -1);
    assert.equal(d.validation.ok, false); await assert.rejects(f.plan.save('run'), { code: 'PLAN_INVALID' });
    assert.equal(await f.c.approveRun('run'), false); assert.equal(f.calls.execute, 0); assert.equal(f.c.state.projects.length, 1); assert.equal(f.c.state.tasks.length, 0);
  }
});

test('saved selected steps execute exactly the edited plan while keeping set-workspace order', async () => {
  const f = fixture([{ type: 'set_workspace', workspace: '日常' }, { type: 'create_task', title: 'Keep', projectId: null }, { type: 'create_note', title: 'Skip', content: 'No' }]);
  const d = f.plan.draft('run'); f.plan.toggle('run', d.rows[2].key, false); await f.plan.save('run');
  assert.equal(await f.c.approveRun('run'), true); assert.equal(f.c.state.tasks[0].workspace, '日常'); assert.equal(f.c.state.tasks[0].projectId, null); assert.equal(f.c.state.notes.length, 1); assert.equal(f.calls.execute, 1);
});

test('successful durability is not reversed by a completion callback exception', async () => {
  const f = fixture(); f.c.window.GoalLoop.onRoundFinished = () => { f.calls.goal++; throw Error('Synthetic GoalLoop rendering failure'); };
  await f.c.approveRun('run'); assert.equal(f.run.status, 'completed'); assert.equal(f.run.approvalReceipt.savePending, false); assert.equal(f.calls.execute, 1); assert.equal(await f.c.retryApprovalSave('run'), false);
});

test('an authentic token from another pending run cannot authorize this run', async () => {
  const f = fixture(), token = f.plan.capture('run');
  const second = { ...clone(f.run), id: 'other-run', pendingActions: [{ type: 'create_task', title: 'Different intent' }] };
  f.c.state.agentRuns.push(second); f.chat.messages.push({ id: 'other-message', pendingRunId: second.id, text: 'Another plan' });
  assert.equal(await f.c.approveRun(second.id, { token }), false);
  assert.equal(f.calls.execute, 0); assert.equal(second.status, 'awaiting-approval');
});

test('reviewer cannot bind one run opinion to another run authentic token', async () => {
  const f = fixture(), token = f.plan.capture('run');
  const second = { ...clone(f.run), id: 'other-run', goal: 'Other request', pendingActions: [{ type: 'create_task', title: 'Different intent' }] };
  f.c.state.agentRuns.push(second); f.chat.messages.push({ id: 'other-message', pendingRunId: second.id, text: 'Another plan' });
  assert.equal(await f.c.requestReviewerOpinion(second, token), false);
  assert.equal(f.calls.requests.length, 0); assert.equal(second.reviewer?.status === 'done', false);
});

test('delegate flag alone cannot approve without a matching completed reviewer opinion', async () => {
  for (const opinion of [undefined, { status: 'done', verdict: 'caution' }, { status: 'done', verdict: 'approve', planFingerprint: 'different-plan' }]) {
    const f = fixture(), token = f.plan.capture('run'); f.run.reviewer = opinion;
    assert.equal(await f.c.approveRun('run', { token, reviewer: true }), false);
    assert.equal(f.calls.execute, 0); assert.equal(f.run.status, 'awaiting-approval');
  }
});

test('restart recovery requires remote confirmation and cannot replay a locally cached completed receipt', async () => {
  const f = fixture(); let disk;
  f.setDurable(async c => { disk = clone(c.state); throw Error('Lost acknowledgement'); }); await f.c.approveRun('run');
  const cached = fixture(undefined, disk);
  assert.equal(cached.c.recoverApprovalReceipts(null), true); assert.equal(cached.run.status, 'awaiting-save'); assert.equal(cached.chat.messages[0].pendingRunId, 'run');
  assert.equal(await cached.c.approveRun('run'), false); assert.equal(await cached.c.retryApprovalSave('run'), true); assert.equal(cached.calls.execute, 0);
  const confirmed = fixture(undefined, disk);
  assert.equal(confirmed.c.recoverApprovalReceipts(disk), true); assert.equal(confirmed.run.status, 'completed'); assert.equal(confirmed.run.approvalReceipt.savePending, false);
  assert.equal(confirmed.calls.goal, 0); assert.equal(confirmed.calls.sound, 0); assert.equal(await confirmed.c.approveRun('run'), false); assert.equal(await confirmed.c.retryApprovalSave('run'), false); assert.equal(confirmed.calls.execute, 0);
});

test('a remote receipt with a different id cannot confirm a local applied outcome', async () => {
  const f = fixture(); let disk;
  f.setDurable(async c => { disk = clone(c.state); throw Error('Lost acknowledgement'); }); await f.c.approveRun('run');
  const remote = clone(disk); remote.agentRuns[0].approvalReceipt.id = 'unrelated-receipt';
  const cached = fixture(undefined, disk); cached.c.recoverApprovalReceipts(remote);
  assert.equal(cached.run.status, 'awaiting-save'); assert.equal(cached.run.approvalReceipt.savePending, true); assert.equal(cached.calls.execute, 0);
});

test('a late delegate approval rechecks its enablement after filesystem validation too', async () => {
  const f = fixture(), gate = f.pauseValidation(), reviewing = f.c.runDelegatedReview('run');
  await until(() => !!f.c.approveRun.busy?.size); f.chat.reviewerApprove = false; gate.resolve();
  assert.equal(await reviewing, false); assert.equal(f.calls.execute, 0); assert.equal(f.run.status, 'awaiting-approval');
});

test('render exceptions after acknowledgement cannot turn a committed approval into a retry', async () => {
  const f = fixture(); f.c.renderAll = () => { throw Error('Synthetic renderer failed'); };
  assert.equal(await f.c.approveRun('run'), true); assert.equal(f.run.status, 'completed'); assert.equal(f.run.approvalReceipt.savePending, false); assert.equal(await f.c.retryApprovalSave('run'), false); assert.equal(f.calls.execute, 1);
});


test('project rename during approval leaves a reviewable plan and explicit recheck can proceed', async () => {
  const f = fixture();
  f.run.expectedProjectTargets = [{ id:'project', name:'Research', workspace:'科研' }];
  f.plan.draft('run');
  const gate=f.pauseValidation(), approving=f.c.approveRun('run');
  f.c.state.projects[0].name='Reviewed new name'; gate.resolve();
  assert.equal(await approving, false); assert.equal(f.run.status,'awaiting-approval'); assert.equal(f.calls.execute,0);
  f.plan.recheck('run'); assert.equal(await f.c.approveRun('run'),true);
  assert.equal(f.c.state.tasks.length,1); assert.equal(f.c.state.tasks[0].projectId,'project');
});

test('explicit task recheck refreshes already read content and next approval uses that exact target version', async () => {
  const f=fixture([{type:'update_task',taskId:'existing',patch:{status:'done'}}]);
  f.c.state.tasks.push({id:'existing',title:'Before',projectId:'project',workspace:'科研',status:'todo'});
  f.run.taskContext=TaskContext.build(f.c.state,f.chat,{candidateTaskIds:['existing']});
  f.plan.draft('run');
  f.c.state.tasks[0].title='Human changed title';
  assert.equal(await f.c.approveRun('run'),false); assert.equal(f.run.status,'awaiting-approval');
  f.plan.recheck('run');
  assert.equal(await f.c.approveRun('run'),true);
  assert.equal(f.c.state.tasks[0].title,'Human changed title'); assert.equal(f.c.state.tasks[0].status,'done');
});

test('task recheck cannot expand allowed scope or accept a moved target', () => {
  const f=fixture([{type:'update_task',taskId:'existing',patch:{status:'done'}}]);
  f.c.state.tasks.push({id:'existing',title:'Before',projectId:'project',workspace:'科研',status:'todo'});
  f.run.taskContext=TaskContext.build(f.c.state,f.chat,{candidateTaskIds:['existing']});
  const before=clone(f.run.taskContext); f.plan.draft('run');
  f.c.state.projects.push({id:'other',name:'Other',workspace:'科研'}); f.c.state.tasks[0].projectId='other';
  assert.throws(()=>f.plan.recheck('run'));
  assert.deepEqual(f.run.taskContext,before); assert.equal(f.calls.execute,0);
});

test('all-rejected task fields can be rechecked and later accepted without widening the read scope', async () => {
  const f=fixture([{type:'update_task',taskId:'existing',patch:{title:'Proposed title'}}]);
  f.c.state.tasks.push({id:'existing',title:'Before',description:'Original',projectId:'project',workspace:'科研',status:'todo'});
  f.run.taskContext=TaskContext.build(f.c.state,f.chat,{candidateTaskIds:['existing']});
  const row=f.plan.draft('run').rows[0]; f.plan.decideField('run',row.key,'patch.title',false); await f.plan.save('run');
  assert.equal(f.run.pendingActions.length,0);
  f.c.state.tasks[0].description='Human update'; f.plan.recheck('run');
  assert.equal(f.c.state.tasks[0].title,'Before'); assert.equal(f.calls.execute,0);
  const before=clone(f.run.taskContext);
  assert.throws(()=>f.c.recheckApprovalPlan(f.run,[],()=>true,[{type:'update_task',taskId:'unread',patch:{title:'No'}}]),/已读取/);
  assert.deepEqual(f.run.taskContext,before);
  f.plan.decideField('run',row.key,'patch.title',true); await f.plan.save('run');
  assert.equal(await f.c.approveRun('run'),true);
  assert.equal(f.c.state.tasks[0].title,'Proposed title'); assert.equal(f.c.state.tasks[0].description,'Human update');
});

function explicitReviewFixture() {
  const f=fixture([{type:'update_task',taskId:'task',patch:{workflowCategory:'P3'}}]);
  f.c.state.tasks.push({id:'task',title:'Synthetic course task',projectId:'project',workspace:'科研',status:'todo',workflowCategory:'P1'});
  f.run.taskContext=TaskContext.build(f.c.state,f.chat,{candidateTaskIds:['task']});
  f.run.permissionMode=f.chat.permissionMode='smart';f.c.state.settings.permissions.科研='auto';
  const submittedMessage={id:'user',role:'user',text:'把任务分类改成日常，生成修改审阅让我确认。'};
  f.chat.messages.push(submittedMessage);
  f.c.run=f.run;f.c.submittedMessage=submittedMessage;f.c.options={};
  // Execute the current production run-capture seam, not a test-only setter.
  vm.runInContext(cut('  run.userMessageId = submittedMessage?.id', '\n  const readScope ='),f.c);
  f.chat.messages[0].text=ApprovalIntent.messageFor(f.run,'pending','分类 P1 → P3');
  return f;
}

test('E28 actual host risk policy honors current user preview before session allowance',()=>{
  const f=explicitReviewFixture();f.chat.sessionAllows={update_task:1};
  assert.ok(f.run.approvalIntent);
  for(const mode of ['smart','legacy']) {
    f.run.permissionMode=mode;
    assert.equal(f.c.actionsNeedApproval(f.run),true,mode+' + space auto cannot bypass current review intent');
    assert.equal(f.c.actionsNeedApproval({...f.run,approvalIntent:null}),false,mode+' ordinary update remains automatic');
  }
  assert.equal(f.c.sessionAllowsRun(f.run),false);assert.equal(f.c.sessionAllowMarkup(f.run),'');
  assert.equal(f.c.state.tasks[0].workflowCategory,'P1','Dry-run must not apply the patch');
  const ordinary={...f.run,approvalIntent:null};
  assert.equal(f.c.actionsNeedApproval(ordinary),false,'Same ordinary update remains automatic under risk mode');
  f.run.status='awaiting-save';f.run.approvalReceipt={id:'receipt'};f.c.approveRun.busy=new Set(['run']);
  assert.equal(f.c.grantSessionAllow(f.run,'receipt'),false);
});

test('E28 real checkpoint host refuses automatic apply even after current mode switches to full',async()=>{
  const f=explicitReviewFixture();f.run.status='running';f.chat.permissionMode='full';
  await assert.rejects(f.c.runCheckpoints().prepare('run','message',{answer:'请审阅确认'}),{code:'CHECKPOINT_REVIEW_REQUIRED'});
  assert.equal(f.calls.execute,0);assert.equal(f.c.state.tasks[0].workflowCategory,'P1');
  assert.equal(f.run.executionReceipt.phase,'prepared');
  const restarted=fixture(undefined,clone(f.c.state));
  await assert.rejects(restarted.c.runCheckpoints().continue('run'),{code:'CHECKPOINT_REVIEW_REQUIRED'});
  assert.equal(restarted.calls.execute,0);assert.equal(restarted.c.state.tasks[0].workflowCategory,'P1');
});

test('E28 scheduled delegate and forged reviewer entry cannot satisfy personal confirmation',async()=>{
  const f=explicitReviewFixture();
  f.c.scheduleDelegatedReview(f.run);
  assert.equal(vm.runInContext('delegatedReviewTimer',f.c),null);
  assert.equal(await f.c.runDelegatedReview('run'),false);assert.equal(f.calls.requests.length,0);
  const token=f.plan.capture('run');
  f.run.reviewer={status:'done',verdict:'approve',planFingerprint:Core.contentStamp(token.fingerprint)};
  assert.equal(await f.c.approveRun('run',{token,reviewer:true}),false);
  assert.equal(f.calls.execute,0);assert.equal(f.c.state.tasks[0].workflowCategory,'P1');
});

test('E28 actual human approval applies the selected category once and replaces pending wording',async()=>{
  const f=explicitReviewFixture();
  assert.equal(await f.c.approveRun('run',{sessionAllow:true}),true);
  assert.equal(f.c.state.tasks[0].workflowCategory,'P3');assert.equal(f.calls.execute,1);
  assert.equal(f.run.approvedBy,'user');assert.equal(f.chat.sessionAllows,undefined);
  assert.match(f.chat.messages[0].text,/执行并保存/);
  assert.doesNotMatch(f.chat.messages[0].text,/尚未执行|请核对|待确认|请审阅/);
  assert.equal(await f.c.approveRun('run'),false);assert.equal(f.calls.execute,1);
});

test('E28 approval save failure says applied but unsaved and retry cannot replay',async()=>{
  const f=explicitReviewFixture();f.setDurable(async()=>{throw Error('Synthetic unavailable disk');});
  assert.equal(await f.c.approveRun('run'),false);
  assert.equal(f.run.status,'awaiting-save');assert.equal(f.c.state.tasks[0].workflowCategory,'P3');
  assert.match(f.chat.messages[0].text,/正在保存/);assert.doesNotMatch(f.chat.messages[0].text,/尚未执行|请核对/);
  f.setDurable(async()=>true);assert.equal(await f.c.retryApprovalSave('run'),true);
  assert.equal(f.calls.execute,1);assert.match(f.chat.messages[0].text,/执行并保存/);
});

test('E28 final reviewer guard observes a newly imposed review constraint after an await',async()=>{
  const f=explicitReviewFixture(),intent=f.run.approvalIntent;f.run.approvalIntent=null;
  const token=f.plan.capture('run');f.run.reviewer={status:'done',verdict:'approve',planFingerprint:Core.contentStamp(token.fingerprint)};
  const gate=f.pauseValidation(),pending=f.c.approveRun('run',{token,reviewer:true});
  f.run.approvalIntent=intent;gate.resolve();
  assert.equal(await pending,false);assert.equal(f.calls.execute,0);assert.equal(f.c.state.tasks[0].workflowCategory,'P1');
});

test('E28 automatic job and model prose do not invent a current-user review constraint',()=>{
  const f=explicitReviewFixture();
  for(const options of [{automaticJobId:'scheduled'},{researchQueueId:'queue'},{goalLoopContinuation:true}]) {
    f.run.approvalIntent=null;f.c.options=options;
    vm.runInContext(cut('  run.userMessageId = submittedMessage?.id', '\n  const readScope ='),f.c);
    assert.equal(f.run.approvalIntent,null);
  }
  f.c.options={retry:true};f.c.submittedMessage.intentSource='automatic';
  vm.runInContext(cut('  run.userMessageId = submittedMessage?.id', '\n  const readScope ='),f.c);
  assert.equal(f.run.approvalIntent,null,'Retry of an automatic message retains its non-human origin');
  f.run.goal='ordinary task update';f.chat.messages[0].text='请审阅确认';
  assert.equal(f.c.actionsNeedApproval(f.run),false,'A model reply is not user intent');
});

test('E28 actual Halaska review hook hides session approval only for the constrained run',()=>{
  const f=explicitReviewFixture();
  // Execute the function supplied by the real host to PlanReview, not the old
  // fallback markup. This hook feeds PlanReviewSurface.canSessionApprove.
  const expression=source.match(/canSessionApprove:\s*(run\s*=>[^\n]+)/)?.[1];
  assert.ok(expression);const canSessionApprove=vm.runInContext('('+expression+')',f.c);
  assert.equal(canSessionApprove(f.run),false);
  assert.equal(canSessionApprove({...f.run,approvalIntent:null}),true);
});
