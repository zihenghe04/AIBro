const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Core = require('../workstation-core');
const CourseRouting = require('../course-routing');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const code = section('function actionsNeedApproval(', 'function actionSummary(') + '\n' + section('function assertRunActive(', 'let activeRunController');
function fixture(mode = 'full', actions) {
  const run = { id: 'r', conversationId: 'c', workspace: '课程', projectId: null, permissionMode: mode, attachmentIds: ['pdf'], goal: '这门课的第一章 PPT 如下。', status: 'running', pendingActions: actions || [
    { type: 'rename_attachment', attachmentId: 'pdf', newName: '第一章.pdf' },
    { type: 'create_knowledge_item', title: '矩阵概览', content: '来源第1页', workspace: '课程', projectId: 'old', sourceAttachmentIds: ['pdf'] }
  ] };
  const state = { projects: [{ id: 'old', name: '智能系统：原理模型与算法', workspace: '课程' }], imports: [{ id: 'pdf', name: '矩阵代数.pdf', workspace: '课程', projectId: null, updatedAt: 1 }], notes: [], tasks: [], papers: [], links: [], conversations: [{ id: 'c', projectId: null, messages: [] }], agentRuns: [run], settings: { permissions: { '课程': 'auto' } } };
  const context = vm.createContext({ state, Core, window: { CourseRouting }, WorkstationPermissionPolicy: { needsApproval: () => false }, workspaceName: x => x || '日常', activeRunController: null });
  vm.runInContext(code, context);
  return { state, run, context };
}
const domain = state => JSON.stringify(['projects','imports','notes','tasks','papers','links'].map(key => state[key]));

for (const mode of ['full','smart','legacy']) test(`ambiguous reuse pauses the entire plan even in ${mode} mode`, () => {
  const { state, run, context } = fixture(mode); const before = domain(state);
  assert.equal(context.actionsNeedApproval(run), true);
  assert.equal(run.routingReview.required, true);
  assert.match(run.routingReview.message, /归属尚未确认/);
  assert.equal(domain(state), before, 'neither rename nor implicit source assignment writes before confirmation');
  assert.equal(run.pendingActions.length, 2);
  assert.equal(run.expectedAttachmentTargets[0].projectId, null);
  assert.equal(run.expectedProjectTargets[0].id, 'old');
});

test('course routing checks still run for legacy destructive mixed plans', () => {
  const { state, run, context } = fixture('legacy');
  state.trash = [];
  state.tasks.push({ id: 'obsolete', title: '旧测试任务', workspace: '课程' });
  run.pendingActions.push({ type: 'delete_task', taskId: 'obsolete' });
  assert.equal(context.actionsNeedApproval(run), true);
  assert.equal(run.routingReview.required, true);
  assert.equal(run.expectedAttachmentTargets[0].id, 'pdf');
});

test('explicit correct new course executes atomically while the old course is preserved', () => {
  const { state, run, context } = fixture();
  run.pendingActions = [{ type: 'create_project', id: 'new-course', name: '智能系统基础数学理论和算法', workspace: '课程' }, { type: 'assign_attachment', attachmentId: 'pdf', projectId: 'new-course', workspace: '课程' }, { type: 'create_knowledge_item', title: '矩阵代数', content: '第1章笔记', projectId: 'new-course', workspace: '课程', sourceAttachmentIds: ['pdf'] }];
  assert.equal(context.actionsNeedApproval(run), false);
  const result = Core.applyPlan(state, run.pendingActions, { workspace: run.workspace });
  const target = result.state.projects.find(p => p.name === '智能系统基础数学理论和算法');
  assert.ok(target); assert.equal(result.state.imports[0].projectId, target.id); assert.equal(result.state.notes[0].projectId, target.id);
  assert.deepEqual(result.state.projects[0], state.projects[0]);
  const before = domain(state);
  assert.throws(() => Core.applyPlan(state, [...run.pendingActions, { type: 'unsupported_action' }], { workspace: run.workspace }));
  assert.equal(domain(state), before);
});

test('waiting confirmation rejects moved, edited, deleted attachments and changed conversation/project scope', () => {
  const mutations = [s => { s.imports[0].projectId = 'other'; }, s => { s.imports[0].updatedAt = 2; }, s => { s.imports[0].archived = true; }, s => { s.imports = []; }, s => { s.conversations[0].projectId = 'old'; }, s => { s.projects[0].name = 'changed'; }, s => { s.projects[0].archived = true; }];
  for (const mutate of mutations) {
    const { state, run, context } = fixture(); context.actionsNeedApproval(run); run.status = 'awaiting-approval';
    assert.doesNotThrow(() => context.assertRunActive(run)); mutate(state);
    assert.throws(() => context.assertRunActive(run), error => error.code === 'CANCELLED');
    assert.equal(state.notes.length, 0);
  }
});

test('actual pending UI uses routing question rather than model assertion and retains explicit confirmation actions', () => {
  assert.match(source, /run\.routingReview\?\.required \? run\.routingReview\.message : payload\.message/);
  assert.match(source, /确认归属并执行/); assert.match(source, /暂不归入/);
  assert.match(source, /当前对话绑定项目为/);
  assert.match(source, /用户本轮明确纠正课程名称优先于历史助手判断与旧归属/);
});
