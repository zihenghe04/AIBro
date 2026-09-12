const assert = require('node:assert/strict');
const Core = require('../workstation-core.js');

const baseState = {
  projects: [{ id: 'p-visa', name: '示例差旅资料准备', workspace: '日常', archived: false }],
  imports: [{ id: 'a-ds', name: 'DS-160.pdf', originalName: 'DS-160.pdf', workspace: null, projectId: null, project: null, archived: false }],
  tasks: [], notes: [], links: [], conversations: [], trash: [], agentRuns: []
};

assert.equal(Core.endpoint('https://example.test/v1'), 'https://example.test/v1/responses');
assert.equal(Core.endpoint('https://example.test/v1/responses'), 'https://example.test/v1/responses');
assert.equal(Core.partialMessage('{"message":"正在分析\\n材料"'), '正在分析\n材料');
assert.equal(Core.runLabel('completed-local-fallback'), '已完成 · 本地');
assert.deepEqual(Core.parsePlan('收到，我会执行：\n{"message":"已完成","actions":[]}'), { message: '已完成', actions: [] });

const first = Core.applyPlan(baseState, [
  { type: 'rename_attachment', attachmentId: 'a-ds', newName: '签证 / DS-160 提交确认.pdf' },
  { type: 'create_task', title: '准备签证材料', workspace: '日常', projectId: 'p-visa', priority: 'high', dueAt: '2026-09-20', sourceAttachmentIds: ['a-ds'], checklist: ['护照', '照片'] },
  { type: 'create_knowledge_item', title: '材料清单', kind: '材料清单', workspace: '日常', projectId: 'p-visa', sourceAttachmentIds: ['a-ds'], content: '护照、照片' }
], { now: Date.parse('2026-09-10T00:00:00Z'), uid: prefix => `${prefix}-new` });
assert.equal(first.state.tasks.length, 1);
assert.equal(first.state.notes.length, 1);
assert.equal(first.state.imports[0].name, '签证 - DS-160 提交确认.pdf');
assert.deepEqual(first.state.tasks[0].sourceAttachmentIds, ['a-ds']);
assert.equal(first.state.imports[0].projectId, 'p-visa');

const routed = Core.applyPlan({ ...baseState, projects: [], imports: [{ ...baseState.imports[0] }] }, [
  { type: 'create_project', id: 'new-project-ref', name: '差旅准备', workspace: '日常' },
  { type: 'rename_attachment', attachmentId: 'a-ds', newName: '差旅准备 · DS-160.pdf' },
  { type: 'assign_attachment', attachmentId: 'a-ds', projectId: 'new-project-ref', project: '差旅准备', workspace: '日常', folderPath: '原始资料' },
  { type: 'create_task', title: '整理材料', workspace: '日常', projectId: 'new-project-ref', project: '差旅准备', sourceAttachmentIds: ['a-ds'] }
], { uid: prefix => `${prefix}-routed` });
assert.equal(routed.state.projects[0].name, '差旅准备');
assert.equal(routed.state.imports[0].projectId, routed.state.projects[0].id);
assert.equal(routed.state.tasks[0].projectId, routed.state.projects[0].id);

const duplicate = Core.applyPlan(first.state, [{ type: 'create_task', title: '准备签证材料', workspace: '日常', projectId: 'p-visa', sourceAttachmentIds: ['a-ds'] }], { uid: prefix => `${prefix}-duplicate` });
assert.equal(duplicate.state.tasks.length, 1, '重复计划不应创建第二个任务');

assert.throws(() => Core.applyPlan(baseState, [{ type: 'create_task', title: '坏日期', workspace: '日常', projectId: 'p-visa', dueAt: 'not-a-date' }]), /截止时间无效/);
assert.equal(baseState.tasks.length, 0, '计划校验失败时不能部分写入原状态');
assert.equal(Core.dueInWeek({ status: 'todo', dueAt: '2026-09-15' }, Date.parse('2026-09-10T00:00:00Z')), true);
console.log('workstation core tests passed');
