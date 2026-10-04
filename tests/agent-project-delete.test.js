const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Core = require('../app/workstation-core');
const Lifecycle = require('../app/project-lifecycle');
const clone = value => JSON.parse(JSON.stringify(value));
function fixture() {
  return {
    projects: [{ id: 'a', name: '课程演示', workspace: '课程' }, { id: 'b', name: '科研演示', workspace: '科研' }],
    conversations: [
      { id: 'current-chat', projectId: 'a', project: '课程演示', workspace: '课程', attachments: ['shared', 'private'], messages: [{ role: 'user', text: '删除课程演示项目' }] },
      { id: 'old-chat', projectId: 'a', workspace: '课程', attachments: ['standalone-source'], messages: [] },
      { id: 'other-chat', projectId: 'b', workspace: '科研', attachments: [], messages: [] }
    ],
    agentRuns: [
      { id: 'current-run', conversationId: 'current-chat', projectId: 'a', workspace: '课程', status: 'running', activity: [] },
      { id: 'receipt-history', conversationId: 'current-chat', projectId: 'a', workspace: '课程', status: 'completed' },
      { id: 'old-run', conversationId: 'old-chat', projectId: 'a', workspace: '课程', status: 'completed' }
    ],
    tasks: [
      { id: 'owned-task', projectId: 'a', workspace: '课程', title: '课程任务', sourceAttachmentIds: ['private'] },
      { id: 'origin-task', projectId: null, workspace: '课程', title: '未归属任务', agentRunId: 'old-run' },
      { id: 'moved-task', projectId: 'b', workspace: '科研', title: '已移走任务', agentRunId: 'old-run' }
    ],
    notes: [
      { id: 'owned-note', projectId: 'a', workspace: '课程', title: '课程笔记', content: '课程正文' },
      { id: 'moved-note', projectId: 'b', workspace: '科研', title: '跨项目成果', content: '保留正文', agentRunId: 'old-run', sourceAttachmentIds: ['shared'] },
      { id: 'agenda-mirror', projectId: 'a', workspace: '课程', kind: '日程', content: '{"format":"aibro.agenda.v1","id":"native-event"}' }
    ],
    papers: [{ id: 'owned-paper', projectId: 'a', workspace: '课程', title: '论文演示', sourceAttachmentIds: ['private'] }],
    imports: [
      { id: 'shared', projectId: 'a', project: '课程演示', workspace: '课程', name: '共用资料.pdf', content: '唯一原文' },
      { id: 'private', projectId: 'a', workspace: '课程', name: '项目原件.pdf' },
      { id: 'standalone-source', projectId: null, workspace: '课程', name: '会话原件.pdf' }
    ],
    attachments: [
      { id: 'shared', conversationId: 'current-chat' }, { id: 'private', conversationId: 'current-chat' }, { id: 'standalone-source', conversationId: 'old-chat' }
    ],
    links: [
      { id: 'owner-shared', sourceId: 'a', targetId: 'shared' },
      { id: 'source-moved', sourceId: 'shared', targetId: 'moved-note' },
      { id: 'owner-private', sourceId: 'a', targetId: 'private' }
    ],
    trash: [], lastResults: [], currentProjectId: 'a', currentConversationId: 'current-chat'
  };
}
const context = (state, ids = ['a']) => ({ projectSnapshots: Core.projectSnapshots(state, { projectIds: ids }), conversationId: 'current-chat', runId: 'current-run', now: 100, uid: prefix => `${prefix}-100` });
const deletion = id => ({ type: 'delete_project', projectId: id });
function restoreWithRealUI(state, entry) {
  const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
  const start = source.indexOf('function restoreTrash('), end = source.indexOf('\nasync function purgeTrash(', start);
  assert.ok(start >= 0 && end > start);
  const sandbox = vm.createContext({ state, window: {ProjectLifecycle:Lifecycle}, ProjectLifecycle: Lifecycle, sharedImportSnapshot: Lifecycle.sharedImportSnapshot,
    purgeTrash: {}, toast() {}, normalizeStateShape() {}, repairRelationships() {}, save() {}, renderAll() {}, renderTrash() {}, $$: () => [] });
  vm.runInContext(source.slice(start, end), sandbox);
  assert.ok(source.slice(start, end).includes('restoreRoutingMoves'), 'Native UI recovery must restore retained routing through the shared module');
  sandbox.restoreTrash(entry.id);
  return sandbox.state;
}

test('Agent deletes the owned project cascade atomically and leaves moved work, shared bytes and the receipt history live', () => {
  const original = fixture(), before = clone(original), outcome = Core.applyPlan(original, [deletion('a')], context(original));
  assert.deepEqual(original, before, 'Dry-run/execution must not mutate the live state');
  assert.deepEqual(outcome.state.projects.map(item => item.id), ['b']);
  assert.deepEqual(outcome.state.tasks.map(item => item.id), ['moved-task']);
  assert.deepEqual(outcome.state.notes.map(item => item.id), ['moved-note', 'agenda-mirror']);
  assert.deepEqual(outcome.state.conversations.map(item => item.id), ['current-chat', 'other-chat']);
  assert.deepEqual(outcome.state.agentRuns.map(item => item.id), ['current-run', 'receipt-history']);
  assert.deepEqual(outcome.state.conversations[0].attachments, ['shared']);
  assert.equal(outcome.state.conversations[0].projectId, null);
  for (const run of outcome.state.agentRuns) assert.equal(run.projectId, null);
  assert.equal(outcome.state.imports[0].content, '唯一原文');
  assert.equal(outcome.state.imports[0].projectId, null);
  assert.equal(outcome.state.notes[1].projectId, null);
  assert.equal(outcome.state.notes[1].content, before.notes[2].content);
  assert.deepEqual(outcome.state.links.map(item => item.id), ['source-moved']);
  assert.equal(outcome.state.currentConversationId, 'current-chat');
  assert.equal(outcome.state.currentProjectId, null);
  assert.deepEqual(outcome.projectIds, [], 'Deleted projects cannot receive follow-up work');
  const bundle = outcome.state.trash[0];
  assert.equal(bundle.id, 'trash-100');
  assert.equal(bundle.type, 'project');
  assert.deepEqual(bundle.data.imports.map(item => item.id), ['private', 'standalone-source']);
  assert.deepEqual(bundle.data.runs.map(item => item.id), ['old-run']);
  assert.equal(bundle.data.notes.some(item => item.id === 'agenda-mirror'), false);
  assert.equal(outcome.results[0].sharedImportsRetained, 1);
  assert.equal(outcome.results[0].agendaMirrorsRetained, 1);
});

test('a receipt conversation alone does not protect every project original as shared content', () => {
  const state = fixture(); state.notes = state.notes.filter(item => item.id !== 'moved-note'); state.links = state.links.filter(item => item.id !== 'source-moved');
  const outcome = Core.applyPlan(state, [deletion('a')], context(state));
  assert.deepEqual(outcome.state.imports, []);
  assert.deepEqual(outcome.state.conversations[0].attachments, []);
});

test('single-source references and external project edges retain their original file', () => {
  const state = fixture(); state.notes = [{ id: 'outside', projectId: 'b', sourceAttachmentId: 'private', title: '外部成果' }];
  state.links = [{ id: 'external-edge', sourceId: 'b', targetId: 'shared' }];
  const result = Core.applyPlan(state, [deletion('a')], context(state));
  assert.deepEqual(result.state.imports.map(item => item.id).sort(), ['private', 'shared']);
  assert.equal(result.results[0].sharedImportsRetained, 2);
});

test('the existing recovery bundle restores content and unchanged routing without overwriting an active reply', () => {
  const state = fixture(), outcome = Core.applyPlan(state, [deletion('a')], context(state));
  const current = outcome.state.conversations.find(item => item.id === 'current-chat'); current.messages.push({ role: 'assistant', text: '项目已移入回收站' });
  outcome.state.agentRuns[0].status = 'completed';
  const restored = restoreWithRealUI(outcome.state, outcome.state.trash[0]);
  assert.equal(restored.projects.some(item => item.id === 'a'), true);
  assert.equal(restored.tasks.some(item => item.id === 'owned-task'), true);
  assert.equal(restored.conversations.find(item => item.id === 'current-chat').messages.at(-1).text, '项目已移入回收站');
  assert.equal(restored.conversations.find(item => item.id === 'current-chat').projectId, 'a');
  assert.equal(restored.agentRuns.find(item => item.id === 'current-run').status, 'completed');
  assert.equal(restored.agentRuns.find(item => item.id === 'current-run').projectId, 'a');
  assert.equal(restored.imports.find(item => item.id === 'shared').projectId, 'a');
  assert.equal(restored.notes.find(item => item.id === 'agenda-mirror').projectId, 'a');
  assert.equal(restored.trash.length, 0);
});

test('recovery respects later reassignment of the shared source, receipt conversation and agenda mirror', () => {
  const state = fixture(), outcome = Core.applyPlan(state, [deletion('a')], context(state)), result = outcome.state;
  for (const item of [result.imports[0], result.conversations[0], result.notes.find(item => item.id === 'agenda-mirror')]) { item.projectId = 'b'; item.project = '科研演示'; item.workspace = '科研'; }
  const restored = restoreWithRealUI(result, outcome.state.trash[0]);
  assert.equal(restored.imports.find(item => item.id === 'shared').projectId, 'b');
  assert.equal(restored.conversations.find(item => item.id === 'current-chat').projectId, 'b');
  assert.equal(restored.notes.find(item => item.id === 'agenda-mirror').projectId, 'b');
  assert.equal(restored.links.some(item => item.id === 'owner-shared'), false);
});

test('an unchanged membership survives current message streaming, run transitions and collection reorder', () => {
  const state = fixture(), ctx = context(state);
  state.conversations[0].messages.push({ role: 'assistant', text: '正在处理', live: true }); state.conversations[0].updatedAt = 101;
  state.agentRuns[0].status = 'awaiting-approval'; state.agentRuns[0].activity.push({ status: 'waiting' }); state.agentRuns[0].elapsed = 12;
  state.tasks.reverse(); state.links.reverse();
  assert.doesNotThrow(() => Core.applyPlan(state, [deletion('a')], ctx));
  assert.ok(Object.values(ctx.projectSnapshots).every(value => typeof value === 'string' && value.length < 64), 'Runs keep compact stamps, not full content');
});

for (const [name, edit] of [
  ['note edits', state => { state.notes[0].content = '待审批期间更新的正文'; }],
  ['new members', state => { state.tasks.push({ id: 'new-task', projectId: 'a', workspace: '课程', title: '新增任务' }); }],
  ['reassigned work', state => { state.notes[0].projectId = 'b'; }],
  ['new external references', state => { state.notes.push({ id: 'outside-reference', projectId: 'b', sourceAttachmentIds: ['private'] }); }],
  ['shared source edits', state => { state.imports[0].content = '修订原文'; }],
  ['attachment membership changes', state => { state.conversations[0].attachments.push('new-source'); }],
  ['legacy name ambiguity', state => { state.tasks.push({ id: 'legacy', project: '课程演示', workspace: '课程' }); }]
]) test(`a stale deletion plan after ${name} is rejected without any partial write`, () => {
  const state = fixture(), ctx = context(state); edit(state); const before = clone(state);
  assert.throws(() => Core.applyPlan(state, [deletion('a')], ctx), /发生变化/);
  assert.deepEqual(state, before);
});

test('duplicate targets, duplicate stored IDs, nonexistent and out-of-scope targets never fall back to a project name', () => {
  const state = fixture(), ctx = context(state);
  for (const actions of [[deletion('a'), deletion('a')], [deletion('missing')], [deletion('b')], [{ type: 'delete_project', project: '课程演示' }]]) {
    const before = clone(state); assert.throws(() => Core.applyPlan(state, actions, ctx)); assert.deepEqual(state, before);
  }
  const duplicated = fixture(); duplicated.projects.push(clone(duplicated.projects[0]));
  assert.throws(() => Core.projectSnapshots(duplicated, { projectIds: ['a'] }), /唯一/);
  const repeatedMember = fixture(); repeatedMember.notes.push(clone(repeatedMember.notes[0]));
  assert.throws(() => Core.projectSnapshots(repeatedMember, { projectIds: ['a'] }), /重复/);
});

test('snapshot authority supports an explicitly read other project but never silently extends scope', () => {
  const state = fixture();
  assert.throws(() => Core.applyPlan(state, [deletion('b')], context(state)), /允许删除范围/);
  const outcome = Core.applyPlan(state, [deletion('b')], context(state, ['b']));
  assert.deepEqual(outcome.state.projects.map(item => item.id), ['a']);
});

test('mixed edit/delete transactions fail before any mutation and explain how to split them', () => {
  const state = fixture(), before = clone(state);
  assert.throws(() => Core.applyPlan(state, [deletion('a'), { type: 'create_task', title: '不应保存' }], context(state)), /分批执行/);
  assert.deepEqual(state, before);
});

test('joint project deletion removes cross-project shared originals once in one recoverable transaction', () => {
  const state = fixture(), ctx = context(state, ['a', 'b']);
  const outcome = Core.applyPlan(state, [deletion('a'), deletion('b')], ctx);
  assert.deepEqual(outcome.state.projects, []);
  assert.deepEqual(outcome.state.imports, []);
  assert.equal(outcome.state.trash.length, 1);
  assert.equal(outcome.state.trash[0].data.projects.length, 2);
  assert.equal(outcome.state.trash[0].data.imports.filter(item => item.id === 'shared').length, 1);
  assert.equal(outcome.projectDeletionSummary.sharedImportsRetained, 0);
  assert.equal(outcome.results[0].sharedImportsRetained, 0, 'Approval impact reflects the actual joint selection');
  const invalid = fixture(), invalidContext = context(invalid, ['a', 'b']); invalid.projects[1].archived = true; const before = clone(invalid);
  assert.throws(() => Core.applyPlan(invalid, [deletion('a'), deletion('b')], invalidContext));
  assert.deepEqual(invalid, before, 'An invalid second target cannot delete the first');
});

test('legacy name-only records cascade only for unique workspace-qualified project names', () => {
  const state = fixture(); state.tasks.push({ id: 'legacy-ok', project: '课程演示', workspace: '课程' }, { id: 'legacy-outside', project: '课程演示', workspace: '科研' });
  let outcome = Lifecycle.remove(state, 'a', { now: 100 });
  assert.equal(outcome.state.tasks.some(item => item.id === 'legacy-ok'), false);
  assert.equal(outcome.state.tasks.some(item => item.id === 'legacy-outside'), true);
  state.projects.push({ id: 'duplicate-name', name: '课程演示', workspace: '课程' });
  outcome = Lifecycle.remove(state, 'a', { now: 100 });
  assert.equal(outcome.state.tasks.some(item => item.id === 'legacy-ok'), true);
});

test('retained receipt history that already belongs to another project keeps that ownership', () => {
  const state = fixture(); state.agentRuns[1].projectId = 'b'; state.agentRuns[1].workspace = '科研';
  const result = Core.applyPlan(state, [deletion('a')], context(state));
  assert.equal(result.state.agentRuns.find(item => item.id === 'receipt-history').projectId, 'b');
});

test('typed links and ambiguous old links cannot be removed through another entity type using the same ID', () => {
  const state = fixture(); state.tasks.push({ id: 'a', projectId: 'b', title: '同 ID 外部任务' });
  state.links.push({ id: 'outside-typed', sourceId: 'a', sourceType: 'task', targetId: 'moved-note', targetType: 'note' },
    { id: 'outside-ambiguous', sourceId: 'a', targetId: 'moved-note' }, { id: 'project-typed', sourceId: 'a', sourceType: 'project', targetId: 'moved-note', targetType: 'note' });
  state.lastResults.push({ type: 'task', id: 'a', text: '外部任务回执' });
  const result = Core.applyPlan(state, [deletion('a')], context(state));
  assert.equal(result.state.links.some(item => item.id === 'outside-typed'), true);
  assert.equal(result.state.links.some(item => item.id === 'outside-ambiguous'), true);
  assert.equal(result.state.links.some(item => item.id === 'project-typed'), false);
  assert.equal(result.state.lastResults[0].text, '外部任务回执');
});

test('routing restoration skips obsolete owner edges after the receipt conversation or native schedule is reassigned', () => {
  const state = fixture(); state.links.push({ id: 'owner-current-chat', sourceId: 'a', targetId: 'current-chat' }, { id: 'owner-agenda', sourceId: 'a', targetId: 'agenda-mirror' });
  const result = Core.applyPlan(state, [deletion('a')], context(state)).state;
  result.conversations[0].projectId = 'b'; result.conversations[0].workspace = '科研';
  result.notes.find(item => item.id === 'agenda-mirror').projectId = 'b';
  const restored = restoreWithRealUI(result, result.trash[0]);
  assert.equal(restored.links.some(item => item.id === 'owner-current-chat'), false);
  assert.equal(restored.links.some(item => item.id === 'owner-agenda'), false);
});
