const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Lifecycle = require('../content-lifecycle');
const clone = value => JSON.parse(JSON.stringify(value));
const ids = items => items.map(item => item.id).sort();
const frozen = value => { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; };
function fixture(extra = {}) {
  return {
    projects: [{ id: 'daily', name: '个人主页', workspace: '日常' }, { id: 'course', name: '同名', workspace: '课程' }, { id: 'research', name: '同名', workspace: '科研' }],
    tasks: [{ id: 'task', title: '任务', projectId: 'daily', workspace: '日常', sourceAttachmentIds: ['source'] }],
    notes: [{ id: 'note', title: '分析笔记', projectId: 'research', workspace: '科研', sourceAttachmentIds: ['source'], content: '保留分析内容' }],
    papers: [{ id: 'paper', title: '论文', projectId: 'research', workspace: '科研', sourceAttachmentId: 'source', sourceAttachmentIds: ['source'], noteId: 'note' }],
    imports: [{ id: 'source', name: '来源.pdf', projectId: 'research', workspace: '科研', fileStored: true, content: '提取后的正文', dataUrl: 'data:application/pdf;base64,eA==' }],
    attachments: [{ id: 'source', conversationId: 'chat', name: '来源.pdf', fileStored: true }],
    conversations: [{ id: 'chat', title: '科研对话', attachments: ['before', 'source', 'after'], messages: [{ id: 'msg', role: 'user', text: '读取来源', attachmentIds: ['source'] }], draft: '保留草稿' }],
    links: [{ id: 'source-task', sourceId: 'source', targetId: 'task' }, { id: 'source-note', sourceId: 'source', targetId: 'note' }, { id: 'paper-note', sourceId: 'paper', targetId: 'note' }],
    trash: [], agentRuns: [{ id: 'run', status: 'running', results: [{ type: 'task', id: 'task' }] }],
    lastResults: [{ type: 'task', id: 'task' }, { type: 'note', id: 'note' }], currentConversationId: 'chat', currentProjectId: 'daily', ...extra
  };
}
const remove = (state, selections, scope = {}) => Lifecycle.remove(state, selections, scope, { now: 123, uid: () => 'trash-batch' });

test('mixed selection is typed, deduplicated and moved into one durable recoverable bundle without mutating input', () => {
  const state = frozen(fixture()), before = JSON.stringify(state);
  const selections = [{ type: 'task', id: 'task' }, { type: 'task', id: 'task' }, { type: 'note', id: 'note' }];
  const preview = Lifecycle.preview(state, selections);
  assert.deepEqual(preview.counts, { total: 2, task: 1, note: 1, import: 0, paper: 0 });
  assert.deepEqual(preview.retainedSources, [{ id: 'source', name: '来源.pdf' }]);
  assert.ok(preview.entries.every(item => !Object.hasOwn(item, 'content') && !Object.hasOwn(item, 'item')));
  const result = remove(state, selections);
  assert.equal(JSON.stringify(state), before);
  assert.equal(result.entry.id, 'trash-batch'); assert.equal(result.entry.type, 'content'); assert.equal(result.entry.deletedAt, 123);
  assert.equal(result.state.trash.length, 1); assert.equal(result.removed.length, 2);
  assert.deepEqual(result.state.tasks, []); assert.deepEqual(result.state.notes, []);
  assert.deepEqual(result.state.imports, state.imports); assert.deepEqual(result.state.papers, state.papers);
  assert.deepEqual(result.state.lastResults, []); assert.deepEqual(result.state.agentRuns, state.agentRuns);
  assert.deepEqual(ids(result.entry.data.links), ['paper-note', 'source-note', 'source-task']);
});

test('scoped deletion follows stable project IDs and actual owner workspace, never stale labels or a same-name project', () => {
  const tasks = [
    { id: 'own', title: '实际课程项目', projectId: 'course', project: '过期名字', workspace: '科研' },
    { id: 'other', title: '另一个同名项目', projectId: 'research', project: '同名', workspace: '课程' },
    { id: 'legacy', title: '没有稳定归属', project: '同名', workspace: '课程' }
  ];
  const state = fixture({ tasks }); const selections = tasks.map(item => ({ type: 'task', id: item.id }));
  const scoped = remove(state, selections, { workspace: '课程', projectId: 'course' });
  assert.deepEqual(ids(scoped.state.tasks), ['legacy', 'other']);
  assert.deepEqual(scoped.removed.map(item => item.id), ['own']);
  assert.equal(scoped.removed[0].workspace, '课程');
  assert.ok(scoped.warnings.some(value => value.includes('不在当前范围')));
  assert.throws(() => remove(state, selections, { workspace: '所有内容' }), /范围无效/);
});

test('stale, archived, deleted and duplicate-ID selections do not remove anything accidentally', () => {
  const state = fixture({ tasks: [
    { id: 'archived', archived: true }, { id: 'deleted', deletedAt: 1 },
    { id: 'child', projectId: 'course' }, { id: 'duplicate', title: '一' }, { id: 'duplicate', title: '二' }
  ] }); state.projects.find(item => item.id === 'course').archived = true;
  const result = remove(state, ['archived', 'deleted', 'child', 'duplicate', 'missing'].map(id => ({ type: 'task', id })).concat([{ type: 'constructor', id: 'task' }, null]));
  assert.equal(result.entry, null); assert.equal(result.counts.total, 0); assert.deepEqual(result.state, state);
  for (const detail of ['归档', 'ID 重复', '已不存在', '无效的内容选择']) assert.ok(result.warnings.some(value => value.includes(detail)), detail);
});

test('the scope is re-evaluated at commit after the previewed item moves', () => {
  const state = fixture(); const selection = [{ type: 'task', id: 'task' }];
  assert.equal(Lifecycle.preview(state, selection, { projectId: 'daily' }).counts.total, 1);
  state.tasks[0].projectId = 'research';
  const result = remove(state, selection, { projectId: 'daily' });
  assert.equal(result.entry, null); assert.equal(result.state.tasks.length, 1);
});

test('paper deletion preserves analysis notes, source PDFs and other derived records', () => {
  const state = fixture(); const summary = Lifecycle.preview(state, [{ type: 'paper', id: 'paper' }]);
  assert.ok(summary.warnings.some(value => value.includes('分析笔记') && value.includes('源 PDF')));
  const result = remove(state, [{ type: 'paper', id: 'paper' }]);
  assert.equal(result.state.papers.length, 0);
  for (const name of ['notes', 'tasks', 'imports', 'attachments', 'conversations']) assert.deepEqual(result.state[name], state[name]);
  assert.deepEqual(ids(result.state.links), ['source-note', 'source-task']);
});

test('a mixed selection that explicitly includes every derivative does not claim those selected records will survive', () => {
  const summary = Lifecycle.preview(fixture(), [{ type: 'task', id: 'task' }, { type: 'note', id: 'note' }, { type: 'paper', id: 'paper' }, { type: 'import', id: 'source' }]);
  assert.equal(summary.counts.total, 4); assert.deepEqual(summary.retainedSources, []);
  assert.ok(!summary.warnings.some(value => value.includes('所选资料仍被')));
});

test('deleting an original hides all attachment membership while keeping source IDs and messages for restoration', () => {
  const state = fixture(); state.conversations.push({ id: 'other-chat', attachments: ['source'], messages: [], archived: true });
  state.attachments.push({ id: 'source', conversationId: 'other-chat' });
  const result = remove(state, [{ type: 'import', id: 'source' }]);
  assert.deepEqual(result.state.imports, []); assert.deepEqual(result.state.attachments, []);
  assert.deepEqual(result.state.conversations.map(item => item.attachments), [['before', 'after'], []]);
  assert.deepEqual(result.entry.data.attachmentMemberships, [
    { conversationId: 'chat', attachmentId: 'source', index: 1 }, { conversationId: 'other-chat', attachmentId: 'source', index: 0 }
  ]);
  for (const name of ['notes', 'tasks', 'papers', 'agentRuns']) assert.deepEqual(result.state[name], state[name]);
  assert.deepEqual(result.state.conversations[0].messages, state.conversations[0].messages);
  assert.equal(result.state.conversations[0].draft, state.conversations[0].draft);
  assert.equal(result.entry.data.imports[0].dataUrl, state.imports[0].dataUrl);
  assert.ok(result.warnings.some(value => value.includes('来源 ID')));
});

test('same IDs across content types do not cross-delete records or ambiguous untyped links', () => {
  const state = fixture({ tasks: [{ id: 'shared', title: '任务' }], notes: [{ id: 'shared', title: '笔记' }], links: [
    { id: 'ambiguous', sourceId: 'shared', targetId: 'source' },
    { id: 'typed-task', sourceId: 'shared', sourceType: 'task', targetId: 'source', targetType: 'import' },
    { id: 'typed-note', sourceId: 'shared', sourceType: 'note', targetId: 'source', targetType: 'import' }
  ] });
  const result = remove(state, [{ type: 'task', id: 'shared' }]);
  assert.deepEqual(result.state.tasks, []); assert.equal(result.state.notes.length, 1);
  assert.deepEqual(ids(result.state.links), ['ambiguous', 'typed-note']);
  assert.deepEqual(ids(result.entry.data.links), ['typed-task']);
  assert.ok(result.warnings.some(value => value.includes('ID 被其他内容共用')));
});

test('import and attachment metadata form the same source identity, while project IDs remain separate', () => {
  const state = fixture({ tasks: [{ id: 'source', title: '碰巧同ID的任务' }], links: [
    { id: 'typed-import', sourceId: 'source', sourceType: 'attachment', targetId: 'note', targetType: 'note' },
    { id: 'ambiguous', sourceId: 'source', targetId: 'note' }
  ] });
  const result = remove(state, [{ type: 'import', id: 'source' }]);
  assert.equal(result.state.tasks.length, 1); assert.deepEqual(ids(result.state.links), ['ambiguous']);
  assert.deepEqual(ids(result.entry.data.links), ['typed-import']);
});

test('restoration after JSON persistence recovers originals, attachment ordering and links without editing other conversation data', () => {
  const state = fixture(); const deleted = remove(state, [{ type: 'import', id: 'source' }]);
  const restored = Lifecycle.restore(clone(deleted.state), deleted.entry.id);
  assert.deepEqual(restored.state.imports, state.imports); assert.deepEqual(restored.state.attachments, state.attachments);
  assert.deepEqual(restored.state.conversations, state.conversations);
  assert.deepEqual(ids(restored.state.links), ids(state.links)); assert.deepEqual(restored.state.notes, state.notes);
  assert.equal(restored.state.trash.length, 0); assert.equal(restored.entry, null); assert.equal(restored.counts.import, 1);
  const again = Lifecycle.restore(restored.state, deleted.entry.id);
  assert.deepEqual(again.state, restored.state); assert.equal(again.counts.total, 0);
});

test('restoring a conflicting ID never overwrites current content and keeps old records recoverable', () => {
  const state = remove(fixture(), [{ type: 'import', id: 'source' }]).state;
  state.imports.push({ id: 'source', name: '后来创建的来源', content: '新数据' });
  const restored = Lifecycle.restore(state, 'trash-batch');
  assert.equal(restored.state.imports[0].content, '新数据');
  assert.equal(restored.state.trash[0].data.imports[0].content, '提取后的正文');
  assert.deepEqual(restored.state.conversations[0].attachments, ['before', 'after']);
  assert.ok(restored.warnings.some(value => value.includes('未覆盖')));
  assert.equal(restored.state.trash[0].data.attachmentMemberships.length, 1);
});

test('missing original project restores to unassigned in its original workspace without a same-name takeover', () => {
  const removed = remove(fixture(), [{ type: 'note', id: 'note' }]).state;
  removed.projects = removed.projects.filter(item => item.id !== 'research');
  const restored = Lifecycle.restore(removed, 'trash-batch');
  assert.equal(restored.state.notes[0].projectId, null); assert.equal(restored.state.notes[0].project, null);
  assert.equal(restored.state.notes[0].workspace, '科研');
  assert.ok(restored.warnings.some(value => value.includes('未归属')));
});

test('archived original project keeps explicit ownership and explains why its restored content remains hidden', () => {
  const removed = remove(fixture(), [{ type: 'task', id: 'task' }]).state;
  removed.projects.find(item => item.id === 'daily').archived = true;
  const restored = Lifecycle.restore(removed, 'trash-batch');
  assert.equal(restored.state.tasks[0].projectId, 'daily');
  assert.ok(restored.warnings.some(value => value.includes('请先恢复该项目')));
});

test('restoration keeps relations and memberships pending when their other endpoint was subsequently deleted', () => {
  const removed = remove(fixture(), [{ type: 'import', id: 'source' }]).state;
  removed.notes = []; removed.conversations = [];
  const restored = Lifecycle.restore(removed, 'trash-batch');
  assert.equal(restored.state.imports.length, 1);
  assert.ok(!restored.state.links.some(link => link.id === 'source-note'));
  assert.ok(restored.entry.data.links.some(link => link.id === 'source-note'));
  assert.equal(restored.entry.data.attachmentMemberships.length, 1);
  restored.state.notes.push({ id: 'note' }); restored.state.conversations.push({ id: 'chat', attachments: [], messages: [] });
  const retry = Lifecycle.restore(restored.state, 'trash-batch');
  assert.ok(retry.state.links.some(link => link.id === 'source-note'));
  assert.deepEqual(retry.state.conversations[0].attachments, ['source']); assert.equal(retry.entry, null);
});

test('restoring part of a mixed batch keeps just conflicts in its original trash record', () => {
  const state = remove(fixture(), [{ type: 'task', id: 'task' }, { type: 'note', id: 'note' }]).state;
  state.tasks.push({ id: 'task', title: '新任务' });
  const restored = Lifecycle.restore(state, 'trash-batch');
  assert.equal(restored.state.notes.length, 1); assert.equal(restored.state.tasks[0].title, '新任务');
  assert.equal(restored.entry.id, 'trash-batch'); assert.equal(restored.entry.data.tasks.length, 1); assert.equal(restored.entry.data.notes.length, 0);
  assert.deepEqual(restored.counts, { total: 1, task: 0, note: 1, import: 0, paper: 0 });
});

test('a restoration conflict in one type cannot block explicit links of a restored same-ID different type', () => {
  const initial = fixture({ tasks: [{ id: 'shared', title: '旧任务' }], notes: [{ id: 'shared', title: '笔记' }], links: [
    { id: 'task-link', sourceId: 'shared', sourceType: 'task', targetId: 'source', targetType: 'import' },
    { id: 'note-link', sourceId: 'shared', sourceType: 'note', targetId: 'source', targetType: 'import' }
  ] });
  const state = remove(initial, [{ type: 'task', id: 'shared' }, { type: 'note', id: 'shared' }]).state;
  state.tasks.push({ id: 'shared', title: '新任务' });
  const restored = Lifecycle.restore(state, 'trash-batch');
  assert.deepEqual(ids(restored.state.links), ['note-link']);
  assert.deepEqual(ids(restored.entry.data.links), ['task-link']);
  assert.equal(restored.state.notes[0].title, '笔记');
});

test('invalid batch identifiers reject rather than collide with existing trash', () => {
  const state = fixture(); state.trash.push({ id: 'trash-batch', type: 'content', data: {} });
  assert.throws(() => remove(state, [{ type: 'task', id: 'task' }]), /ID 无效或已存在/);
  assert.equal(state.tasks.length, 1);
});

test('browser export is a pure API with no filesystem, network or DOM capability', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../content-lifecycle'), 'utf8'), context);
  assert.deepEqual(Object.keys(context.ContentLifecycle).sort(), ['preview', 'remove', 'restore']);
  assert.equal(Object.isFrozen(context.ContentLifecycle), true);
});
