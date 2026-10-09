import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, MemoryAdapter, addMessage } from '../src/store.js';
import { createAgentTools, applyPlan } from '../src/agent-tools.js';
import { canonicalTaskStatus, taskStatusLabel, taskStatusOptions, taskStatusSelection,
  taskPriorityOptions, taskPrioritySelection, taskStatePatch } from '../src/task-status.js';
import { plannerTasks, plannerTaskStatus } from '../src/ui/home-planner-model.js';

async function fixture(status, priority, completion = { completedAt: 77 }) {
  const store = await new Store(new MemoryAdapter()).load();
  await store.put('conversations', { id: 'chat', title: '跨端合成任务', projectId: null });
  const task = { id: 'mac', title: 'Mac 原任务', description: '原说明', status, priority, ...completion,
    dueAt: '2030-01-02', startAt: '2030-01-01', reminderMinutes: 73, workspace: '科研', projectId: null,
    checklist: [{ id: 'legacy-step', title: '保留原清单格式', done: false, extra: { origin: 'synthetic' } }],
    workflowCategory: null, dependsOn: ['prior'], deliverable: { kind: 'text', ref: '合成产出' },
    sourceAttachmentIds: ['source'], sourceConversationId: 'original-chat', agentRunId: 'original-run', createdAt: 100, updatedAt: 101 };
  if (status === undefined) delete task.status;
  if (priority === undefined) delete task.priority;
  await store.put('tasks', task);
  return { store, task };
}
async function propose(store, changes, create = false) {
  const tools = createAgentTools({ store, conversationID: 'chat' });
  if (!create) assert.equal((await tools.execute('knowledge_read', { kind: 'tasks', id: 'mac' })).error, undefined);
  const result = await tools.execute('propose_changes', { actions: [{ operation: create ? 'create' : 'update', kind: 'tasks',
    ...(create ? {} : { id: 'mac' }), changes }] });
  return { result, plan: tools.pendingPlan() };
}
async function approve(store, plan) {
  await addMessage(store, 'chat', 'assistant', '待审阅合成修改', { status: 'completed', pendingPlan: plan });
  return applyPlan(store, plan);
}

test('Mac in_progress and legacy doing have a selected in-progress option, never implicit todo', () => {
  for (const status of ['todo', 'in_progress', 'doing', 'done', 'blocked']) {
    const selected = taskStatusSelection(status), options = taskStatusOptions(status);
    assert.equal(options.filter(row => row.value === selected).length, 1);
    assert.equal(selected, status === 'doing' ? 'in_progress' : status);
    assert.equal(canonicalTaskStatus(status), selected);
  }
  assert.equal(taskStatusLabel('doing'), '进行中'); assert.equal(taskStatusLabel('in_progress'), '进行中');
});

test('unknown original status/priority stay selectable; absent fields retain their display defaults', () => {
  assert.deepEqual(taskStatusOptions('awaiting_review').at(-1), { value: 'awaiting_review', label: '其他状态：awaiting_review', retained: true });
  assert.equal(taskStatusSelection('awaiting_review'), 'awaiting_review');
  assert.deepEqual(taskPriorityOptions('urgent').at(-1), { value: 'urgent', label: '其他优先级：urgent', retained: true });
  assert.equal(taskPrioritySelection(undefined), 'medium'); assert.equal(taskStatusSelection(null), 'todo');
  assert.throws(() => taskStatusSelection({ status: 'todo' }), /格式/);
});

test('form round-trip changing only description preserves all raw states, priorities and completion metadata', () => {
  for (const status of ['todo', 'in_progress', 'doing', 'done', 'blocked', 'awaiting_review', undefined, null]) {
    const old = { status, priority: 'urgent', completedAt: 0, description: '原说明' };
    const form = { status: taskStatusSelection(old.status), priority: taskPrioritySelection(old.priority), description: '新说明' };
    const changes = {};
    if (form.status !== taskStatusSelection(old.status)) changes.status = form.status;
    if (form.priority !== taskPrioritySelection(old.priority)) changes.priority = form.priority;
    assert.deepEqual({ ...old, ...taskStatePatch(old, changes), description: form.description }, { ...old, description: '新说明' });
  }
});

test('explicit state writes canonicalize doing; only real completion transitions change completedAt', () => {
  assert.deepEqual(taskStatePatch({ status: 'doing', completedAt: 0 }, { status: 'in_progress' }, { now: 123 }), { status: 'in_progress' });
  assert.deepEqual(taskStatePatch({ status: 'todo' }, { status: 'doing' }, { now: 123 }), { status: 'in_progress', completedAt: null });
  assert.deepEqual(taskStatePatch({ status: 'in_progress' }, { status: 'done' }, { now: 123 }), { status: 'done', completedAt: 123 });
  assert.deepEqual(taskStatePatch({ status: 'done', completedAt: 0 }, { status: 'done' }, { now: 123 }), { status: 'done' });
  assert.deepEqual(taskStatePatch({ status: 'done' }, { status: 'todo' }, { now: 123 }), { status: 'todo', completedAt: null });
  assert.deepEqual(taskStatePatch(null, {}, { now: 123 }), { status: 'todo', completedAt: null, priority: 'medium' });
  assert.deepEqual(taskStatePatch({ status: 'awaiting_review', priority: 'urgent' }, { status: 'awaiting_review', priority: 'urgent' }), {});
  assert.throws(() => taskStatePatch(null, { status: 'awaiting_review' }), /状态无效/);
  assert.throws(() => taskStatePatch({ status: 'todo' }, { status: 'awaiting_review' }), /状态无效/);
  assert.throws(() => taskStatePatch(null, { priority: 'urgent' }), /优先级无效/);
});

test('actual read -> proposal -> approval changes description without rewriting Mac/legacy state or other fields', async () => {
  for (const status of ['todo', 'in_progress', 'doing', 'done', 'blocked', 'awaiting_review', undefined, null]) {
    const { store, task } = await fixture(status, status === 'awaiting_review' ? 'urgent' : 'medium');
    const before = structuredClone(store.get('tasks', 'mac'));
    const { result, plan } = await propose(store, { description: '只改说明' });
    assert.equal(result.error, undefined, `status=${status}: ${result.error}`);
    assert.deepEqual(store.get('tasks', 'mac'), before, 'proposal does not execute');
    await approve(store, plan);
    const saved = store.get('tasks', 'mac');
    assert.deepEqual({ ...saved, updatedAt: task.updatedAt }, { ...task, description: '只改说明' });
    assert.equal(saved.completedAt, 77);
  }
});

test('description-only plans do not fabricate absent status, priority or completion fields', async () => {
  const { store } = await fixture(undefined, undefined, {});
  const { result, plan } = await propose(store, { description: '只改说明' });
  assert.equal(result.error, undefined); await approve(store, plan);
  const saved = store.get('tasks', 'mac');
  for (const key of ['status', 'priority', 'completedAt']) assert.equal(Object.hasOwn(saved, key), false, key);
});

test('Agent explicitly changes legacy doing to canonical Mac in_progress and cannot create unknown states', async () => {
  const { store } = await fixture('todo');
  const { result, plan } = await propose(store, { status: 'doing' });
  assert.equal(result.error, undefined); assert.equal(plan.actions[0].after.status, 'in_progress');
  await approve(store, plan); assert.equal(store.get('tasks', 'mac').status, 'in_progress');
  assert.equal(store.get('tasks', 'mac').completedAt, null);
  const create = await propose(store, { title: '不能新造状态', status: 'awaiting_review' }, true);
  assert.match(create.result.error, /状态无效/);
  assert.equal(store.list('tasks').length, 1);
});

test('directory in_progress/doing filters return both real stored values without mutating them', async () => {
  const { store } = await fixture('in_progress');
  await store.put('tasks', { id: 'phone', title: '手机旧任务', status: 'doing', priority: 'medium' });
  await store.put('tasks', { id: 'unknown', title: '未知原状态', status: 'awaiting_review' });
  const before = structuredClone(store.state), tools = createAgentTools({ store, conversationID: 'chat' });
  for (const status of ['doing', 'in_progress']) {
    const result = await tools.execute('workspace_list', { kind: 'tasks', status });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.entries.map(item => item.status).sort(), ['doing', 'in_progress']);
  }
  assert.deepEqual(store.state, before);
});

test('home planner preserves original task objects and displays known aliases or unknown states honestly', () => {
  const tasks = ['todo', 'in_progress', 'doing', 'done', 'blocked', 'awaiting_review'].map(status => ({ id: status, status }));
  const before = structuredClone(tasks), rows = plannerTasks(tasks, { today: '2030-01-02' }).flatMap(group => group.rows);
  assert.equal(rows.find(row => row.task.status === 'in_progress').statusLabel, '进行中');
  assert.equal(rows.find(row => row.task.status === 'doing').statusLabel, '进行中');
  assert.equal(rows.find(row => row.task.status === 'awaiting_review').statusLabel, '其他状态：awaiting_review');
  assert.equal(plannerTaskStatus({ status: 'blocked' }), '受阻'); assert.equal(plannerTaskStatus({}), '');
  assert.deepEqual(tasks, before); assert.ok(rows.every(row => tasks.includes(row.task)));
  assert.deepEqual(plannerTasks(tasks, { today: '2030-01-02', showCompleted: true })[0].rows.map(row => row.task.id), ['done']);
});
