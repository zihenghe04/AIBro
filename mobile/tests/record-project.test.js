import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, MemoryAdapter, addMessage } from '../src/store.js';
import { createAgentTools, applyPlan } from '../src/agent-tools.js';
import { editedProject, recordProjectSelection, recordProjectOptions } from '../src/record-project.js';
import { agendaNote, readEvent } from '../src/agenda.js';

const projects = [
  { id: 'p', name: '合成研究', workspace: '科研' },
  { id: 'q', name: '合成日常', workspace: '日常' },
  { id: 'other-space', name: '合成研究', workspace: '课程' },
  { id: 'archived', name: '旧归档项目', workspace: '科研', archived: true },
];

test('unchanged selection preserves original aliases, absent fields and unresolved stable IDs', () => {
  for (const old of [
    { projectId: 'p', project: '旧名称', workspace: '科研' },
    { projectId: 'missing', project: '合成研究', workspace: '科研' },
    { projectId: 'archived', project: '旧归档项目', workspace: '科研' },
    { projectId: null, workspace: '课程' }, { workspace: '科研' },
  ]) {
    const before = structuredClone(old), selected = recordProjectSelection(old, projects);
    assert.deepEqual(editedProject(old, selected, projects), {});
    assert.deepEqual(old, before);
    assert.equal(recordProjectOptions(old, projects).filter(row => row.value === selected).length, 1);
  }
  assert.equal(recordProjectSelection({ projectId: 'missing', project: '合成研究', workspace: '科研' }, projects), 'missing');
});

test('legacy names resolve only within their workspace and unchanged display does not write a guessed ID', () => {
  const old = { project: '合成研究', workspace: '科研' };
  assert.equal(recordProjectSelection(old, projects), 'p');
  assert.deepEqual(editedProject(old, 'p', projects), {});
  const ambiguous = [...projects, { id: 'duplicate', name: '合成研究', workspace: '科研' }];
  const selected = recordProjectSelection(old, ambiguous);
  assert.match(selected, /^legacy:/);
  assert.equal(recordProjectOptions(old, ambiguous).at(-1).retained, true);
  assert.deepEqual(editedProject(old, selected, ambiguous), {});
  assert.deepEqual(editedProject(old, '', ambiguous), { projectId: null, project: null, workspace: '科研' });
});

test('explicit detach clears both aliases while move writes the target ID/name/workspace and new independent records stay daily', () => {
  const old = { projectId: 'p', project: '合成研究', workspace: '科研', description: '不能动正文' };
  assert.deepEqual(editedProject(old, '', projects), { projectId: null, project: null, workspace: '科研' });
  assert.deepEqual(editedProject(old, 'q', projects), { projectId: 'q', project: '合成日常', workspace: '日常' });
  assert.deepEqual(editedProject(null, '', projects), { projectId: null, project: null, workspace: '日常' });
  assert.throws(() => editedProject(old, 'archived', projects), /不可用/);
  assert.throws(() => editedProject(old, 'missing', projects), /不可用/);
});

async function fixture(kind = 'tasks', relationship = { projectId: 'p', project: '合成研究' }) {
  const store = await new Store(new MemoryAdapter()).load();
  for (const project of projects) await store.put('projects', project);
  await store.put('conversations', { id: 'chat', title: '合成归属审批', projectId: null });
  let data = { id: 'record', title: '原合成记录', description: '原说明', content: '原正文', workspace: '科研', ...relationship,
    createdAt: 100, updatedAt: 101, sourceConversationId: 'chat', status: 'in_progress', priority: 'medium' };
  if (kind === 'agenda') data = { ...agendaNote({ title: '原合成日程', start: Date.parse('2030-01-02T07:00:00Z'), end: Date.parse('2030-01-02T08:00:00Z'),
    timeZone: 'Asia/Shanghai', workspace: '科研', projectId: relationship.projectId }, { id: 'record', createdAt: 100 }), ...relationship };
  await store.put(kind === 'agenda' ? 'notes' : kind, data);
  return { store, data };
}
async function approved(store, kind, changes) {
  const tools = createAgentTools({ store, conversationID: 'chat' });
  assert.equal((await tools.execute('knowledge_read', { kind, id: 'record' })).error, undefined);
  const output = await tools.execute('propose_changes', { actions: [{ operation: 'update', kind, id: 'record', changes }] });
  assert.equal(output.error, undefined, output.error);
  const plan = tools.pendingPlan(); await addMessage(store, 'chat', 'assistant', '待审阅归属', { status: 'completed', pendingPlan: plan });
  await applyPlan(store, plan); return store.get(kind === 'agenda' ? 'notes' : kind, 'record');
}

test('actual Agent detach of task/note/agenda clears Mac alias and preserves workspace/body/time', async () => {
  for (const kind of ['tasks', 'notes', 'agenda']) {
    const { store, data } = await fixture(kind);
    const saved = await approved(store, kind, { projectId: null });
    assert.equal(saved.projectId, null); assert.equal(saved.project, null); assert.equal(saved.workspace, '科研');
    assert.equal(saved.id, data.id); assert.equal(saved.title, data.title);
    if (kind === 'agenda') {
      const event = readEvent(saved), original = readEvent(data);
      assert.equal(event.projectId, null); assert.equal(event.start, original.start); assert.equal(event.end, original.end);
    } else assert.equal(saved.content, data.content);
  }
});

test('explicit Agent null clears a legacy name even when the old stable ID was absent', async () => {
  const { store } = await fixture('tasks', { project: '合成研究' });
  const saved = await approved(store, 'tasks', { projectId: null });
  assert.equal(saved.projectId, null); assert.equal(saved.project, null); assert.equal(saved.workspace, '科研');
});

test('Agent project change synchronizes both fields; unrelated edits preserve old aliases', async () => {
  const changed = await fixture();
  const moved = await approved(changed.store, 'tasks', { projectId: 'q' });
  assert.deepEqual([moved.projectId, moved.project, moved.workspace], ['q', '合成日常', '日常']);
  const untouched = await fixture('tasks', { projectId: 'p', project: '保留旧显示别名' });
  const saved = await approved(untouched.store, 'tasks', { description: '只改说明' });
  assert.deepEqual([saved.projectId, saved.project, saved.workspace], ['p', '保留旧显示别名', '科研']);
});

test('project-scoped Agent cannot silently attach an existing independent referenced task', async () => {
  const { store, data } = await fixture('tasks', { projectId: null, project: null });
  const tools = createAgentTools({ store, conversationID: 'chat', projectID: 'p', contextKeys: ['tasks:record'] });
  assert.equal((await tools.execute('knowledge_read', { kind: 'tasks', id: 'record' })).error, undefined);
  const output = await tools.execute('propose_changes', { actions: [{ operation: 'update', kind: 'tasks', id: 'record', changes: { description: '只改说明' } }] });
  assert.match(output.error, /当前项目/); assert.deepEqual(store.get('tasks', 'record'), data);
});
