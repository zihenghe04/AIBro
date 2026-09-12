const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const TaskContext = require('../task-context');
const anchor = { now: '2026-09-11T17:05:06.000Z', timeZone: 'Asia/Shanghai' };
const conversation = (extra = {}) => ({ id: 'c', workspace: 'auto', messages: [], ...extra });
const task = (id, extra = {}) => ({ id, title: `任务 ${id}`, status: 'todo', priority: 'medium', workspace: '日常', dueAt: null, ...extra });
const rows = context => context.text.split('\n').filter(line => line.startsWith('{')).map(JSON.parse);
const build = (state, conv, options = {}) => TaskContext.build(state, conv, { ...anchor, ...options });

test('UMD exposes its pure API in the browser without requiring Node', () => {
  const context = vm.createContext({ Intl });
  vm.runInContext(fs.readFileSync(require.resolve('../task-context'), 'utf8'), context);
  assert.equal(typeof context.TaskContext.build, 'function'); assert.equal(typeof context.TaskContext.assertUnchanged, 'function');
});

test('an unbound follow-up receives only its own tasks and successful result references, recent result first', () => {
  const state = { projects: [{ id: 'p', workspace: '日常' }], tasks: [task('own', { sourceConversationId: 'c' }), task('message', { projectId: 'p' }), task('run'), task('failed'), task('other', { sourceConversationId: 'other' })],
    agentRuns: [{ id: 'done', conversationId: 'c', status: 'completed', finishedAt: '2026-09-11T16:00:00Z', results: [{ type: 'task', id: 'run', operation: 'updated' }] },
      { id: 'bad', conversationId: 'c', status: 'failed', results: [{ type: 'task', id: 'failed' }] },
      { id: 'other-run', conversationId: 'other', status: 'completed', results: [{ type: 'task', id: 'other' }] }] };
  const conv = conversation({ messages: [{ at: '2026-09-11T15:00:00Z', results: [{ type: 'task', id: 'message' }, { type: 'note', id: 'other' }] }] });
  const before = JSON.stringify(state); const context = build(state, conv, { goal: '它的 ddl 是下周五' });
  assert.deepEqual(context.taskIds, ['run', 'message', 'own']); assert.deepEqual(rows(context).map(row => row.id), context.taskIds);
  assert.match(context.text, /多个候选且指代不明时先询问/); assert.equal(JSON.stringify(state), before);
});

test('bound project stays strict even when old messages and exact titles mention another project', () => {
  const state = { projects: [{ id: 'p', workspace: '课程' }, { id: 'q', workspace: '科研' }], tasks: [task('p', { projectId: 'p', workspace: '日常' }), task('q', { projectId: 'q', sourceConversationId: 'c', title: '另一项目的研究任务' }), task('loose', { sourceConversationId: 'c' })] };
  const context = build(state, conversation({ projectId: 'p', workspace: '科研', messages: [{ results: [{ type: 'task', id: 'q' }] }] }), { goal: '把另一项目的研究任务改为周五' });
  assert.deepEqual(context.taskIds, ['p']); assert.equal(rows(context)[0].workspace, '课程');
});

test('exact unique complete title can resolve an unbound task, but fragments and duplicate titles cannot', () => {
  const state = { projects: [{ id: 'p', workspace: '课程' }, { id: 'q', workspace: '科研' }], tasks: [task('one', { title: '完成智能控制实验报告', projectId: 'p' }), task('two', { title: '提交论文', projectId: 'p' }), task('three', { title: '提交论文', projectId: 'q' })] };
  assert.deepEqual(build(state, conversation(), { goal: '请把「完成智能控制实验报告」的截止日期改成明天' }).taskIds, ['one']);
  for (const goal of ['实验报告改成明天', '提交论文改成明天', '它周五到期']) assert.deepEqual(build(state, conversation(), { goal }).taskIds, []);
  assert.deepEqual(build(state, conversation({ workspace: '科研' }), { goal: '完成智能控制实验报告改成明天' }).taskIds, []);
});

test('title matching does not confuse Latin word substrings or a shorter task with a named longer one', () => {
  const state = { tasks: [task('a', { title: 'Review paper' }), task('b', { title: 'Review paper appendix' }), task('c', { title: '论文整理' }), task('d', { title: '论文整理计划' })] };
  assert.deepEqual(build(state, conversation(), { goal: 'Preview paper tomorrow' }).taskIds, []);
  assert.deepEqual(build(state, conversation(), { goal: 'Review paper appendix tomorrow' }).taskIds, ['b']);
  assert.deepEqual(build(state, conversation(), { goal: '把论文整理计划设为明天完成' }).taskIds, ['d']);
});

test('archived/deleted tasks, missing or inactive parents, and duplicate IDs never enter context', () => {
  const state = { projects: [{ id: 'old', archived: true }, { id: 'duplicate' }, { id: 'duplicate' }], tasks: [task('a', { archived: true }), task('b', { deletedAt: 1 }), task('c', { status: 'deleted' }), task('d', { projectId: 'old' }), task('e', { projectId: 'missing' }), task('f', { projectId: 'duplicate' }), task('same'), task('same')] };
  state.tasks.forEach(item => { item.sourceConversationId = 'c'; });
  assert.deepEqual(build(state, conversation()).taskIds, []);
  assert.deepEqual(build(state, conversation({ projectId: 'missing' })).taskIds, []);
  state.tasks.push(task('live', { sourceConversationId: 'c' }));
  assert.deepEqual(build(state, conversation({ archived: true })).taskIds, []);
  state.conversations = [conversation({ deletedAt: 1 })]; assert.deepEqual(build(state, conversation()).taskIds, []);
});

test('pending and failed message results cannot impersonate a successful task result', () => {
  const state = { tasks: [task('pending'), task('failed')], agentRuns: [{ id: 'bad', conversationId: 'c', status: 'failed' }] };
  const context = build(state, conversation({ messages: [{ pendingRunId: 'pending-run', results: [{ type: 'task', id: 'pending' }] }, { runId: 'bad', results: [{ type: 'task', id: 'failed' }] }] }));
  assert.deepEqual(context.taskIds, []);
});

test('task rows contain actual fields, source identifiers and checklist while excluding unrelated credentials', () => {
  const item = task('t', { sourceConversationId: 'c', title: '签证材料', dueAt: '2026-09-18T09:30:00+08:00', startAt: '2026-09-17', description: '先核对官方清单', checklist: [{ id: 'check', text: '准备照片', done: true }], sourceAttachmentIds: ['pdf'], updatedAt: 7 });
  const context = build({ tasks: [item], settings: { apiKey: 'SECRET' }, imports: [{ id: 'pdf', rawBase64: 'PRIVATE_BYTES' }] }, conversation());
  const row = rows(context)[0];
  for (const key of ['id', 'title', 'dueAt', 'startAt', 'description', 'updatedAt', 'sourceAttachmentIds', 'checklist']) assert.deepEqual(row[key], item[key]);
  assert.doesNotMatch(context.text, /SECRET|PRIVATE_BYTES/); assert.equal(typeof context.snapshots.t.task, 'string');
});

test('budget is strict and snapshots authorize only task IDs whose complete JSON rows were output', () => {
  const state = { tasks: Array.from({ length: 25 }, (_, index) => task(`t${index}`, { sourceConversationId: 'c', title: '报告😀'.repeat(100), description: '长正文'.repeat(3000), checklist: Array.from({ length: 40 }, () => ({ text: '步骤'.repeat(100), done: false })) })) };
  for (const maxChars of [0, 1, 100, 250, 500, 800, 1500, 8000]) {
    const context = build(state, conversation(), { maxChars });
    assert.ok(context.text.length <= maxChars, `${context.text.length} > ${maxChars}`);
    assert.deepEqual(rows(context).map(row => row.id), context.taskIds);
    assert.deepEqual(Object.keys(context.snapshots).sort(), [...context.taskIds].sort());
    assert.ok(context.taskIds.length < 25);
    if (context.taskIds.length) assert.equal(rows(context)[0].truncated, true);
  }
});

test('date anchor uses this message instant in Shanghai rather than its UTC calendar day', () => {
  const context = build({}, conversation());
  assert.match(context.text, /2026-09-12T01:05:06\+08:00/); assert.match(context.text, /时区 Asia\/Shanghai/); assert.match(context.text, /相对日期以此为准/);
  assert.match(build({}, conversation(), { timeZone: 'Invalid/Zone' }).text, /2026-09-11T17:05:06\+00:00.*UTC（无效时区已回退）/);
});

test('time anchor computes DST and fractional UTC offsets correctly', () => {
  assert.match(build({}, conversation(), { now: '2026-07-01T12:00:00Z', timeZone: 'America/New_York' }).text, /2026-07-01T08:00:00-04:00/);
  assert.match(build({}, conversation(), { now: '2026-01-01T12:00:00Z', timeZone: 'America/New_York' }).text, /2026-01-01T07:00:00-05:00/);
  assert.match(build({}, conversation(), { now: '2026-07-01T12:00:00Z', timeZone: 'Asia/Kathmandu' }).text, /2026-07-01T17:45:00\+05:45/);
});

test('optimistic task check tolerates object-key order and metadata timestamps but rejects changed content', () => {
  const state = { tasks: [task('t', { sourceConversationId: 'c', updatedAt: 1 })] };
  const context = build(state, conversation()); const actions = [{ type: 'update_task', taskId: 't', patch: { dueAt: '2026-09-20' } }];
  state.tasks[0].updatedAt = 100; state.tasks[0].createdAt = 99;
  state.tasks[0] = Object.fromEntries(Object.entries(state.tasks[0]).reverse());
  assert.equal(TaskContext.assertUnchanged(state, actions, context.snapshots), true);
  state.tasks[0].description = '用户新写的说明';
  assert.throws(() => TaskContext.assertUnchanged(state, actions, context.snapshots), error => error.code === 'CANCELLED' && /等待期间已修改.*请重新发送/.test(error.message));
});

test('deadline, checklist, source and project changes during approval all cancel instead of overwriting', () => {
  for (const mutate of [t => { t.dueAt = '2027-01-01'; }, t => { t.checklist[0].done = true; }, t => { t.sourceAttachmentIds.push('other'); }, t => { t.projectId = 'q'; }]) {
    const state = { projects: [{ id: 'p', workspace: '日常' }, { id: 'q', workspace: '日常' }], tasks: [task('t', { sourceConversationId: 'c', projectId: 'p', checklist: [{ text: '准备', done: false }], sourceAttachmentIds: ['pdf'] })] };
    const context = build(state, conversation()); mutate(state.tasks[0]);
    assert.throws(() => TaskContext.assertUnchanged(state, [{ type: 'update_task', taskId: 't' }], context.snapshots), { code: 'CANCELLED' });
  }
});

test('deletion, archival, duplicate IDs and parent lifecycle changes invalidate the same snapshot', () => {
  for (const mutate of [s => { s.tasks = []; }, s => { s.tasks[0].archived = true; }, s => { s.tasks.push({ ...s.tasks[0] }); }, s => { s.projects[0].archived = true; }, s => { s.projects = []; }, s => { s.projects[0].workspace = '课程'; }]) {
    const state = { projects: [{ id: 'p', workspace: '日常' }], tasks: [task('t', { projectId: 'p' })] };
    const context = build(state, conversation({ projectId: 'p' })); mutate(state);
    assert.throws(() => TaskContext.assertUnchanged(state, [{ type: 'update_task', taskId: 't' }], context.snapshots), { code: 'CANCELLED' });
  }
});

test('unknown task references require a valid context ID, while unrelated actions are unaffected', () => {
  const state = { tasks: [task('t')] };
  assert.throws(() => TaskContext.assertUnchanged(state, [{ type: 'update_task', taskId: 't' }], {}), { code: 'TASK_CONTEXT' });
  assert.throws(() => TaskContext.assertUnchanged(state, [{ type: 'update_task', taskId: '__proto__' }], {}), { code: 'TASK_CONTEXT' });
  assert.equal(TaskContext.assertUnchanged(state, [{ type: 'create_task', title: '新任务' }, { type: 'update_note', noteId: 'n' }], {}), true);
});
