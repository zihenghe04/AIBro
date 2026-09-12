const test = require('node:test');
const assert = require('node:assert/strict');
const Planning = require('../planning-workbench');

function fixture() {
  return {
    projects: [{ id: 'daily', name: '个人主页', workspace: '日常' }, { id: 'course', name: '课程项目', workspace: '课程' }, { id: 'research', name: '科研项目', workspace: '科研' }, { id: 'archived', workspace: '日常', archived: true }],
    tasks: [
      { id: 'range', title: '制作主页', workspace: '日常', projectId: 'daily', project: '个人主页', status: 'in_progress', priority: 'high', startAt: '2026-09-10', dueAt: '2026-09-13', sourceAttachmentIds: ['source'], checklist: [{ text: '核对内容', done: true }] },
      { id: 'deadline', title: '交作业', workspace: '课程', projectId: 'course', status: 'todo', dueAt: '2026-09-12' },
      { id: 'done', title: '完成', workspace: '科研', projectId: 'research', status: 'done', dueAt: '2020-01-01' },
      { id: 'unassigned', title: '未排期', workspace: '日常', projectId: null, status: 'blocked' },
    ],
    notes: [{ id: 'source', title: '主页笔记', projectId: 'daily', workspace: '日常', sourceAttachmentIds: ['source'] }],
    imports: [{ id: 'source', name: '主页设计.md', projectId: 'daily', workspace: '日常' }],
  };
}
const fixed = { now: new Date('2026-09-11T12:00:00').getTime() };

test('empty state stays empty without fabricated progress, timeline, relationships, or divide by zero', () => {
  const model = Planning.derive({}, {}, fixed);
  assert.equal(model.counts.total, 0); assert.equal(model.percent, null);
  assert.deepEqual(model.timeline, []); assert.equal(model.extent, null);
  assert.deepEqual(model.graph, { nodes: [], edges: [], unassigned: [] });
});
test('global, workspace, and project counts derive from current explicit ownership', () => {
  const state = fixture(); state.tasks[0].workspace = '科研'; // Project is canonical when a legacy record disagrees.
  const all = Planning.derive(state, {}, fixed), daily = Planning.derive(state, { workspace: '日常' }, fixed), project = Planning.derive(state, { projectId: 'daily' }, fixed);
  assert.deepEqual(all.counts, { total: 4, done: 1, todo: 1, in_progress: 1, blocked: 1, overdue: 0, notes: 1, imports: 1, projects: 3 });
  assert.equal(all.percent, 25); assert.equal(daily.counts.total, 2); assert.equal(project.counts.total, 1);
  assert.equal(project.projects[0].percent, 0); assert.equal(project.timeline[0].workspace, '日常');
  assert.equal(Planning.derive(state, { workspace: '科研', projectId: 'daily' }).validScope, false);
});
test('all deletion/archive forms and missing or inactive parents are excluded from every chart', () => {
  const state = fixture();
  const hidden = [{ archived: true }, { archivedAt: 1 }, { deleted: true }, { deletedAt: 1 }, { projectId: 'archived' }, { projectId: 'missing' }];
  hidden.forEach((patch, i) => { for (const type of ['tasks', 'notes', 'imports']) state[type].push({ id: `hidden-${i}`, title: '不可见', workspace: '日常', ...patch }); });
  const model = Planning.derive(state, {}, fixed);
  assert.equal(model.counts.total, 4); assert.equal(model.counts.notes, 1); assert.equal(model.counts.imports, 1);
  assert.ok(model.graph.nodes.every(node => !node.id.startsWith('hidden')));
  for (const scope of [{ projectId: 'archived' }, { projectId: 'missing' }, { workspace: '不存在' }]) {
    const scoped = Planning.derive(state, scope, fixed); assert.equal(scoped.validScope, false); assert.equal(scoped.counts.total, 0); assert.deepEqual(scoped.graph.nodes, []);
  }
});
test('timeline preserves actual ranges and never manufactures a start or duration for deadline-only tasks', () => {
  const state = fixture(); state.tasks.push({ id: 'start', title: '开工', workspace: '日常', startAt: '2026-09-15' });
  const model = Planning.derive(state, {}, fixed), range = model.timeline.find(item => item.id === 'range'), deadline = model.timeline.find(item => item.id === 'deadline'), start = model.timeline.find(item => item.id === 'start');
  assert.equal(range.kind, 'range'); assert.equal(range.durationDays, 3); assert.equal(range.startAt, '2026-09-10'); assert.equal(range.dueAt, '2026-09-13');
  assert.equal(deadline.kind, 'deadline'); assert.equal(deadline.start, null); assert.equal(deadline.startAt, null); assert.equal(deadline.durationMs, null); assert.equal(deadline.durationDays, null);
  assert.equal(start.kind, 'start'); assert.equal(start.end, null); assert.equal(start.durationMs, null);
  assert.equal(model.unscheduled, 1); assert.equal(model.extent.max, Planning.parseDate('2026-09-15').timestamp);
});
test('invalid calendar dates, dates in reverse order, and malformed time values are rejected', () => {
  for (const value of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '0000-01-01', '2026-09-12T24:00', '2026-09-12T12:60', 'yesterday']) assert.equal(Planning.parseDate(value), null, value);
  assert.ok(Planning.parseDate('2024-02-29')); assert.ok(Planning.parseDate('2026-09-12T08:30:00+08:00'));
  assert.throws(() => Planning.validateDates('2026-09-13', '2026-09-12'), /不能早于/);
  assert.throws(() => Planning.planCreate(fixture(), { title: '任务', workspace: '日常', dueAt: '2026-02-30' }, { uid: () => 'new' }), /截止日期无效/);
  const state = fixture(); state.tasks.push({ id: 'bad', workspace: '日常', startAt: '2026-10-01', dueAt: '2026-09-01' });
  const model = Planning.derive(state, {}, fixed); assert.equal(model.invalidDates, 1); assert.ok(model.timeline.every(item => item.id !== 'bad')); assert.equal(model.counts.total, 5);
});
test('date-only deadlines remain current for the entire local day and completed tasks never become overdue', () => {
  const state = { tasks: [{ id: 'open', dueAt: '2026-09-12' }, { id: 'done', status: 'done', dueAt: '2020-01-01' }] };
  assert.equal(Planning.derive(state, {}, { now: new Date('2026-09-12T23:59:59').getTime() }).counts.overdue, 0);
  assert.equal(Planning.derive(state, {}, { now: new Date('2026-09-13T00:00:00').getTime() }).counts.overdue, 1);
  assert.doesNotThrow(() => Planning.validateDates('2026-09-12T15:00:00', '2026-09-12'));
});
test('timed range duration is measured from actual timestamps', () => {
  const model = Planning.derive({ tasks: [{ id: 'timed', startAt: '2026-09-12T08:00:00+08:00', dueAt: '2026-09-12T10:30:00+08:00' }] });
  assert.equal(model.timeline[0].durationMs, 2.5 * 3600000); assert.equal(model.timeline[0].datePrecision, false);
});
test('relationship graph uses typed IDs and only explicit project membership, never source/title similarity', () => {
  const state = fixture(); state.tasks.push({ id: 'source', title: '主页笔记', workspace: '日常', projectId: null, sourceAttachmentIds: ['source'] });
  const model = Planning.derive(state, {}, fixed), shared = model.graph.nodes.filter(node => node.id === 'source');
  assert.equal(shared.length, 3); assert.equal(new Set(shared.map(node => node.key)).size, 3);
  assert.ok(model.graph.edges.every(edge => edge.relation === 'project_membership' && JSON.parse(edge.from)[0] === 'project'));
  assert.ok(!model.graph.edges.some(edge => edge.to === JSON.stringify(['task', 'source'])));
  assert.equal(model.graph.unassigned.length, 2);
});
test('new tasks validate input, have durable IDs, explicit source-empty metadata, and leave source state untouched', () => {
  const state = fixture(), before = structuredClone(state);
  const task = Planning.planCreate(state, { title: '  发布个人主页  ', description: '手动安排', projectId: 'daily', workspace: '科研', status: 'done', priority: 'high', startAt: '2026-09-15', dueAt: '2026-09-16' }, { now: 123, uid: prefix => `${prefix}-new` });
  assert.equal(task.id, 'task-new'); assert.equal(task.title, '发布个人主页'); assert.equal(task.workspace, '日常'); assert.equal(task.project, '个人主页');
  assert.equal(task.completedAt, 123); assert.deepEqual(task.sourceAttachmentIds, []); assert.deepEqual(task.checklist, []); assert.deepEqual(state, before);
  assert.throws(() => Planning.planCreate(state, { title: ' ', workspace: '日常' }), /名称/);
  assert.throws(() => Planning.planCreate(state, { title: '任务', workspace: '日常', status: 'mystery' }), /状态/);
  assert.throws(() => Planning.planCreate(state, { title: '任务', workspace: '日常', priority: 'urgent' }), /优先级/);
  assert.throws(() => Planning.planCreate(state, { title: '任务', projectId: 'archived' }), /目标项目/);
  assert.throws(() => Planning.planCreate(state, { title: '任务', workspace: '日常' }, { uid: () => 'range' }), /编号冲突/);
});
test('cross-space move changes only ownership and update time, preserving originals, sources, dates, completion, and checklist', () => {
  const state = fixture(), before = structuredClone(state), task = state.tasks[0];
  const plan = Planning.planMove(state, ['range', 'range'], { workspace: '日常', projectId: 'course' }, { now: 456, scope: { workspace: '日常' } });
  assert.equal(plan.count, 1); assert.equal(plan.selectedCount, 1); assert.deepEqual(state, before);
  Object.assign(task, plan.updates[0].patch);
  assert.equal(task.workspace, '课程'); assert.equal(task.projectId, 'course'); assert.equal(task.project, '课程项目');
  for (const key of ['title', 'priority', 'status', 'startAt', 'dueAt', 'sourceAttachmentIds', 'checklist']) assert.deepEqual(task[key], before.tasks[0][key], key);
  assert.deepEqual(state.notes, before.notes); assert.deepEqual(state.imports, before.imports);
  assert.equal(Planning.derive(state, { workspace: '日常' }).counts.total, 1); assert.equal(Planning.derive(state, { workspace: '课程' }).counts.total, 2);
  const toSpace = Planning.planMove(state, ['range'], { workspace: '科研', projectId: '' });
  assert.equal(toSpace.destination.projectId, null); assert.equal(toSpace.destination.project, null); assert.equal(toSpace.destination.workspace, '科研');
});
test('batch movement validates every current record and target before returning any updates', () => {
  const state = fixture(), before = structuredClone(state);
  for (const ids of [[], ['range', 'missing'], ['range', 12], Array.from({ length: 2001 }, () => 'range')]) assert.throws(() => Planning.planMove(state, ids, { workspace: '科研' }));
  assert.throws(() => Planning.planMove(state, ['range', 'deadline'], { workspace: '科研' }, { scope: { workspace: '日常' } }), /当前范围/);
  assert.throws(() => Planning.planMove(state, ['range'], { projectId: 'archived' }), /目标项目/);
  assert.deepEqual(state, before);
  state.tasks[0].archived = true; assert.throws(() => Planning.planMove(state, ['range'], { workspace: '科研' }), /归档/);
});
test('same destination is a no-op and unassigned tasks can move to any active space', () => {
  const state = fixture(); assert.equal(Planning.planMove(state, ['range'], { projectId: 'daily' }).count, 0);
  assert.equal(Planning.planMove(state, ['unassigned'], { workspace: '科研' }).updates[0].patch.workspace, '科研');
});
test('existing task editor reads cross-space ownership, preserves an unchanged timed start, and validates before mutation', () => {
  const state = fixture(), task = state.tasks[0]; task.startAt = '2026-09-10T08:30:00+08:00';
  const nodes = { '#taskWorkspaceInput': { value: '课程' }, '#taskProjectInput': { value: 'course' }, '#taskStartInput': { value: Planning.dateField(task.startAt) }, '#taskDueInput': { value: '2026-09-13' }, '#taskTimeInput': { value: '10:30' } };
  Planning.init({ getState: () => state, document: { querySelector: selector => nodes[selector] || null } });
  const before = structuredClone(task), patch = Planning.readTaskEditor(task);
  assert.deepEqual(patch, { workspace: '课程', projectId: 'course', project: '课程项目', startAt: task.startAt }); assert.deepEqual(task, before);
  nodes['#taskStartInput'].value = '2026-09-14'; assert.throws(() => Planning.readTaskEditor(task), /不能早于/); assert.deepEqual(task, before);
  nodes['#taskStartInput'].value = ''; nodes['#taskDueInput'].value = ''; assert.throws(() => Planning.readTaskEditor(task), /先选择截止日期/);
  state.tasks = state.tasks.filter(item => item.id !== task.id); assert.throws(() => Planning.readTaskEditor(task), /不可用/);
});
test('renderer escapes entity text and uses a shared time axis with real range duration and conditional current-time marker', () => {
  const state = fixture(); state.tasks = state.tasks.slice(0, 2); state.tasks[0].title = '<script>alert(1)</script>';
  const container = { classList: { add() {} }, contains: () => true, innerHTML: '' };
  Planning.init({ getState: () => state, now: () => fixed.now });
  Planning.render(container);
  assert.match(container.innerHTML, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/); assert.doesNotMatch(container.innerHTML, /<script>/);
  assert.match(container.innerHTML, /planning-timeline-axis/); assert.match(container.innerHTML, /所有任务共用同一日期刻度/); assert.match(container.innerHTML, /跨度 3 天/);
  const ticks = [...container.innerHTML.matchAll(/class="planning-axis-tick[^"]*"[^>]*>([^<]+)<\/span>/g)].map(match => match[1]); assert.ok(ticks.length >= 2 && ticks.length <= 6); assert.equal(new Set(ticks).size, ticks.length); assert.match(container.innerHTML, /planning-today-marker/);
  Planning.init({ getState: () => state, now: () => new Date('2030-01-01').getTime() }); Planning.render(container);
  assert.doesNotMatch(container.innerHTML, /planning-today-marker/); assert.match(container.innerHTML, /data-planning-create/);
});
test('chart clicks revalidate current entity availability instead of reopening deleted data', () => {
  const state = fixture(), opens = [], toasts = [], container = { classList: { add() {} }, contains: () => true, innerHTML: '' };
  Planning.init({ getState: () => state, openEntity: (...args) => opens.push(args), toast: text => toasts.push(text) }); Planning.render(container);
  const button = { hasAttribute: () => false, dataset: { planningOpen: 'task', planningId: 'range' } }, event = { target: { closest: () => button } };
  container.onclick(event); assert.deepEqual(opens, [['task', 'range']]);
  state.tasks = state.tasks.filter(item => item.id !== 'range'); container.onclick(event);
  assert.equal(opens.length, 1); assert.match(toasts[0], /不可用/);
});

test('single-day calendar scales show unique hour ticks rather than repeating the same date', () => {
  const value = new Date('2026-09-13T00:00:00').getTime();
  for (const d3 of [undefined,require('../d3.min.js')]) {
    for (const width of [180,440,900]) {
      const scale=Planning.timelineScale({min:value,max:value},{width,d3});
      assert.equal(scale.hourly,true); assert.match(scale.caption,/2026-09-13/);
      assert.equal(new Set(scale.ticks.map(tick=>tick.label)).size,scale.ticks.length);
      assert.ok(scale.ticks.length>=2); assert.ok(scale.ticks.every(tick=>tick.position>=0&&tick.position<=100));
      assert.ok(scale.ticks.every(tick=>/\d\d:\d\d/.test(tick.label)));
    }
  }
});

test('multi-day calendar ticks align at actual midnight and do not round fractional dates into duplicates', () => {
  const min=new Date('2026-09-10T12:00:00').getTime(),max=new Date('2026-10-02T15:00:00').getTime();
  const scale=Planning.timelineScale({min,max},{width:440,d3:require('../d3.min.js')});
  assert.equal(scale.hourly,false); assert.equal(new Set(scale.ticks.map(tick=>tick.label)).size,scale.ticks.length);
  assert.ok(scale.ticks.every(tick=>new Date(tick.value).getHours()===0));
  assert.equal(scale.min,min);assert.equal(scale.max,max);
});
