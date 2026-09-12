const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../app/workstation-core');

function fixture() {
  return { projects: [{ id: 'project', name: '课程项目', workspace: '课程' }, { id: 'other', name: '另一个项目', workspace: '课程' }], imports: [], notes: [], papers: [], links: [{ id: 'link', sourceId: 'old-source', targetId: 'task', relation: 'source' }], trash: [], conversations: [], agentRuns: [],
    tasks: [{ id: 'task', title: '提交课程作业', description: '现有要求', projectId: 'project', project: '课程项目', workspace: '课程', status: 'in_progress', priority: 'high', checklist: [{ text: '检查结果', done: true }, { text: '提交', done: false }], sourceAttachmentIds: ['old-source'], sourceNoteIds: ['old-note'], startAt: '2026-09-12', dueAt: null, createdAt: 100, updatedAt: 200 }, { id: 'other-task', title: '提交课程作业', projectId: 'other', workspace: '课程', status: 'todo', checklist: [] }] };
}
function apply(state, patch, context = {}) { return Core.applyPlan(state, [{ type: 'update_task', taskId: 'task', patch }], { workspace: '课程', projectId: 'project', now: 1000, ...context }); }

test('deadline follow-up updates the same task without attachments, new tasks, or changes to unspecified fields', () => {
  const state = fixture(), before = structuredClone(state), deadline = '2026-09-20T23:59:22.987+08:00';
  const outcome = apply(state, { dueAt: deadline }, { allowedTaskIds: ['task'] }), updated = outcome.state.tasks[0];
  assert.equal(outcome.state.tasks.length, 2); assert.equal(updated.id, 'task'); assert.equal(updated.dueAt, deadline); assert.equal(updated.updatedAt, 1000);
  for (const key of ['title', 'description', 'projectId', 'project', 'workspace', 'status', 'priority', 'checklist', 'sourceAttachmentIds', 'sourceNoteIds', 'startAt', 'createdAt']) assert.deepEqual(updated[key], state.tasks[0][key], key);
  assert.equal(Object.hasOwn(updated, 'completedAt'), false); assert.deepEqual(outcome.state.tasks[1], state.tasks[1]); assert.deepEqual(outcome.state.links, state.links); assert.deepEqual(outcome.state.imports, []);
  assert.deepEqual(outcome.results.map(row => [row.type, row.id, row.operation]), [['task', 'task', 'updated']]); assert.deepEqual(state, before);
});
test('explicit null or empty-string clears deadlines while omitted dates keep exact values', () => {
  const state = fixture(); state.tasks[0].dueAt = '2026-09-20T08:30:22.987+08:00';
  for (const value of [null, '']) { const updated = apply(state, { dueAt: value }).state.tasks[0]; assert.equal(updated.dueAt, null); assert.equal(updated.startAt, state.tasks[0].startAt); }
  assert.equal(apply(state, { description: '更新说明' }).state.tasks[0].dueAt, state.tasks[0].dueAt);
  assert.equal(apply(state, { startAt: null }).state.tasks[0].startAt, null);
});
test('startAt is supported for task creation and existing-task update', () => {
  const state = fixture();
  const updated = apply(state, { startAt: '2026-09-14', dueAt: '2026-09-15' }).state.tasks[0]; assert.equal(updated.startAt, '2026-09-14'); assert.equal(updated.dueAt, '2026-09-15');
  const created = Core.applyPlan(state, [{ type: 'create_task', title: '新任务', workspace: '课程', projectId: 'project', startAt: '2026-09-16', dueAt: '2026-09-17', sourceAttachmentIds: [] }], { uid: () => 'new-task' }).state.tasks.at(-1);
  assert.equal(created.startAt, '2026-09-16'); assert.equal(created.dueAt, '2026-09-17');
});
test('changing either date validates against the retained counterpart; both endpoints can change atomically', () => {
  const state = fixture(); state.tasks[0].dueAt = '2026-09-15';
  assert.throws(() => apply(state, { dueAt: '2026-09-11' }), /不能早于/);
  assert.throws(() => apply(state, { startAt: '2026-09-16' }), /不能早于/);
  assert.doesNotThrow(() => apply(state, { startAt: '2026-10-01', dueAt: '2026-10-02' }));
  assert.doesNotThrow(() => apply(state, { startAt: '2026-09-15T15:30:00', dueAt: '2026-09-15' }), 'an all-day deadline includes the whole local day');
});
test('strict calendar and time validation rejects normalization, booleans, arrays and objects', () => {
  const state = fixture();
  for (const value of ['2026-02-29', '2026-04-31', '2026-13-01', '0000-01-01', '2026-09-20T24:00', '2026-09-20T23:60', '2026-09-20T23:00:60', '2026-09-20T23:00+24:00', 'tomorrow', true, false, [], {}, undefined, Infinity, NaN]) {
    assert.throws(() => apply(state, { dueAt: value }), /截止时间无效/, String(value));
    assert.throws(() => apply(state, { startAt: value }), /开始时间无效/, String(value));
  }
  assert.doesNotThrow(() => apply(state, { startAt: '2028-02-29', dueAt: '2028-03-01T10:30Z' }));
  assert.equal(apply(state, { dueAt: Date.parse('2026-09-20T00:00Z') }).state.tasks[0].dueAt, Date.parse('2026-09-20T00:00Z'));
});
test('non-date edits do not get blocked by an unrelated invalid legacy deadline or rewrite it', () => {
  const state = fixture(); state.tasks[0].dueAt = 'corrupt-legacy-value';
  const updated = apply(state, { description: '先补充要求' }).state.tasks[0]; assert.equal(updated.description, '先补充要求'); assert.equal(updated.dueAt, 'corrupt-legacy-value');
});
test('date-only updates preserve completedAt, while explicit status changes maintain completion metadata', () => {
  const state = fixture(); state.tasks[0].status = 'done'; state.tasks[0].completedAt = 0;
  assert.equal(apply(state, { dueAt: '2026-09-20' }).state.tasks[0].completedAt, 0);
  assert.equal(apply(state, { status: 'done' }).state.tasks[0].completedAt, 0);
  assert.equal(apply(state, { status: 'todo' }).state.tasks[0].completedAt, null);
  delete state.tasks[0].completedAt; assert.equal(apply(state, { dueAt: '2026-09-20' }).state.tasks[0].completedAt, undefined);
  assert.equal(apply(state, { status: 'done' }).state.tasks[0].completedAt, 1000);
});
test('allowedTaskIds isolates same-named tasks in other projects and an empty allowlist permits no updates', () => {
  const state = fixture(), before = structuredClone(state);
  assert.throws(() => Core.applyPlan(state, [{ type: 'update_task', taskId: 'other-task', patch: { dueAt: '2026-10-01' } }], { allowedTaskIds: ['task'] }), /允许更新范围/);
  assert.throws(() => apply(state, { dueAt: '2026-09-20' }, { allowedTaskIds: [] }), /允许更新范围/);
  for (const allowedTaskIds of [null, 'task', [123]]) assert.throws(() => apply(state, { dueAt: '2026-09-20' }, { allowedTaskIds }), /范围无效/);
  assert.deepEqual(state, before);
  assert.doesNotThrow(() => Core.applyPlan(state, [{ type: 'update_task', taskId: 'other-task', patch: { dueAt: '2026-10-01' } }]), 'omitting scope keeps existing callers compatible');
});
test('optional task allowlist does not restrict other action types', () => {
  const state = fixture(); state.notes = [{ id: 'note', title: '说明', content: '旧内容' }];
  const outcome = Core.applyPlan(state, [{ type: 'update_note', noteId: 'note', patch: { content: '新内容' } }, { type: 'create_task', title: '新安排', sourceAttachmentIds: [] }], { allowedTaskIds: [], uid: () => 'new-task' });
  assert.equal(outcome.state.notes[0].content, '新内容'); assert.equal(outcome.state.tasks.length, 3);
});
test('bad IDs fail atomically after an earlier valid date update and never create a replacement task', () => {
  const state = fixture(), before = structuredClone(state);
  assert.throws(() => Core.applyPlan(state, [{ type: 'update_task', taskId: 'task', patch: { dueAt: '2026-09-20' } }, { type: 'update_task', taskId: 'missing', patch: { dueAt: '2026-09-21' } }]), /找不到任务/);
  assert.deepEqual(state, before); assert.equal(state.tasks.length, 2); assert.equal(state.tasks[0].dueAt, null);
});
test('deleted or archived tasks and inactive/missing parent projects cannot be updated', () => {
  for (const patch of [{ archived: true }, { archivedAt: 1 }, { deleted: true }, { deletedAt: 1 }, { projectId: 'missing' }]) {
    const state = fixture(); Object.assign(state.tasks[0], patch); assert.throws(() => apply(state, { dueAt: '2026-09-20' }), /找不到任务|归档|不可用/);
  }
  for (const key of ['archived', 'archivedAt', 'deleted', 'deletedAt']) { const state = fixture(); state.projects[0][key] = true; assert.throws(() => apply(state, { dueAt: '2026-09-20' }), /不可用/); }
});
test('patch cannot replace stable identity or source links, even when new files are not available', () => {
  const state = fixture(); const updated = apply(state, { id: 'replacement', sourceAttachmentIds: [], sourceNoteIds: [], projectId: 'other', dueAt: '2026-09-20' }).state.tasks[0];
  assert.equal(updated.id, 'task'); assert.equal(updated.projectId, 'project'); assert.deepEqual(updated.sourceAttachmentIds, ['old-source']); assert.deepEqual(updated.sourceNoteIds, ['old-note']);
});
