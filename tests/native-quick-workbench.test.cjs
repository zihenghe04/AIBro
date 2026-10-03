const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const root = path.join(__dirname, '..');
const copy = value => JSON.parse(JSON.stringify(value));
const quickId = 'quick_task_01234567-89ab-4cde-8fab-0123456789ab';
const create = changes => ({ action: 'create-task', id: quickId, title: '整理本周阅读计划', ...changes });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const task = (changes = {}) => ({ id: 'task-one', title: '阅读论文', description: 'TASK_BODY_MUST_NOT_LEAK', workspace: '科研', projectId: 'project-one', status: 'todo', priority: 'medium', startAt: null, dueAt: '2030-10-03', checklist: [], sourceAttachmentIds: [], createdAt: 1, updatedAt: 2, completedAt: null, ...changes });
const run = (changes = {}) => ({ id: 'run-one', goal: '整理文献', title: '整理文献', conversationId: 'conversation-one', projectId: 'project-one', workspace: '科研', status: 'running', createdAt: 1, startedAt: 2, message: 'RUN_BODY_MUST_NOT_LEAK', output: 'RUN_OUTPUT_MUST_NOT_LEAK', ...changes });

function fixture(options = {}) {
  const calls = { persist: 0, create: 0, apply: [], cancel: 0, access: 0, protocol: 0, events: [] };
  const listeners = new Map();
  const state = options.state || {
    tasks: [task()], notes: [], imports: [], papers: [], links: [], trash: [],
    projects: [{ id: 'project-one', name: '合成科研项目', workspace: '科研' }],
    conversations: [{ id: 'conversation-one', title: '合成对话', projectId: 'project-one', draft: '保留未发送草稿' }],
    agentRuns: [run()], currentConversationId: 'conversation-one', currentProjectId: 'project-one',
    ui: { captureDraft: { text: '随记草稿', tags: '', id: null }, inspectorOpen: true, inspector: 'context' },
    previewRecord: { type: 'note', id: 'open-document' }, settings: {}
  };
  const forbidden = () => { throw Error('A quick command must not navigate, replace an editor, or send a model request'); };
  const context = {
    state, storageHydrated: true, serverConflict: false, purgeTrash: { syncPaused: false }, activeRunId: options.activeRunId ?? 'run-one',
    TextEncoder, URL, crypto: options.crypto || webcrypto, console,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    document: { body: { dataset: { view: 'project' } },
      addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener); },
      dispatchEvent(event) { calls.events.push(event); for (const listener of listeners.get(event.type) || []) listener(event); return true; }
    },
    PrivateMode: { isOn: () => !!options.privateMode },
    showView: forbidden, openTask: forbidden, openConversation: forbidden, openNote: forbidden, renderAll: forbidden, flushLocalDrafts: forbidden,
    sendMessage: Object.assign(forbidden, { busy: true }),
    stopCurrentRun: () => { calls.cancel++; options.stop?.(context); },
    saveDocumentDurably: async () => { calls.persist++; return options.persist ? options.persist(context, calls) : true; }
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['task-workflow.js', 'content-lifecycle.js', 'citation-evidence.js', 'task-dependencies.js', 'task-deliverable.js', 'planning-workbench.js', 'workstation-core.js', 'agent-transport.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'app', file), 'utf8'), context, { filename: file });
  }
  const planCreate = context.PlanningWorkbench.planCreate;
  context.PlanningWorkbench.planCreate = (...args) => { calls.create++; return planCreate(...args); };
  const applyPlan = context.WorkstationCore.applyPlan;
  context.WorkstationCore.applyPlan = (...args) => { calls.apply.push(copy({ actions: args[1], scope: args[2] })); return applyPlan(...args); };
  context.Core = context.WorkstationCore;
  const access = context.CitationEvidence.createAccessContext;
  context.CitationEvidence.createAccessContext = (...args) => { calls.access++; return access(...args); };
  const inspect = context.AgentTransport.inspectProtocolOutput;
  context.AgentTransport.inspectProtocolOutput = (...args) => { calls.protocol++; return inspect(...args); };
  context.WorkstationRunHistory = { presentation: () => { throw Error('Lightweight snapshots must not build full transcript presentation'); } };
  vm.runInContext(fs.readFileSync(path.join(root, 'native/Resources/quick-workbench.js'), 'utf8'), context, { filename: 'quick-workbench.js' });
  const api = context.NativeQuickWorkbench;
  return { context, calls, get state() { return context.state; }, snapshot: () => api.snapshot(), command: value => api.command(value),
    complete(id = 'task-one', completed = true) { return { action: 'set-task-completed', id, completed, expectedVersion: api.snapshot().tasks.find(item => item.id === id)?.version }; } };
}

function installTaskRefresh(f, options = {}) {
  const { context, calls } = f;
  calls.board = []; calls.schedule = []; calls.widgets = [];
  context.state.ui.projectTab = 'tasks';
  const panel = { dataset: { projectId: context.state.currentProjectId } };
  const scheduleHost = { id: 'projectSchedule' };
  context.$ = selector => selector === '#projectTreePanel' ? panel : selector === '#project'
    ? { querySelector: () => scheduleHost } : selector === '#planningCreateForm' ? { dataset: { dirty: options.planningDirty ? 'true' : 'false' } } : null;
  context.document.querySelector = () => options.modal ? { open: true } : null;
  context.taskEditorHasDrafts = () => !!options.taskDirty;
  context.ProjectBoard = { render: id => { calls.board.push(id); }, isBusy: () => !!options.boardBusy };
  context.ProjectSchedule = { mount: (host, id) => { calls.schedule.push({ host, id }); }, isBusy: () => !!options.scheduleBusy, isDirty: () => !!options.scheduleDirty };
  context.NoteEditor = { isDirty: () => !!options.noteDirty };
  context.ProjectFiles = { isDirty: () => !!options.fileDirty };
  context.renderWorkspaceWidgets = (...args) => { calls.widgets.push(args); };
  context.resolveSpaceSection = view => context.state.ui.spaceTabs?.[view] || 'projects';
  context.taskMatchesSpace = (task, space) => task.workspace === space;
  const app = fs.readFileSync(path.join(root, 'app/app.js'), 'utf8');
  const start = app.indexOf('function renderProjectSchedule(container) {');
  const end = app.indexOf('let projectOutputsController = null;', start);
  assert.ok(start >= 0 && end > start, 'Use the production schedule and committed-record listener');
  vm.runInContext(app.slice(start, end), context, { filename: 'app.js:committed-task-refresh' });
  return { panel, options };
}

const inboxCreate = changes => create({ workspace: '科研', projectId: 'project-one', dueAt: '2030-10-02T15:30:00.000Z', priority: 'high', sourceTaskInbox: { version: 1, id: 'external-agent-task', category: 'P0' }, ...changes });
test('inbox creates a canonical task with retained four-category provenance and no agent execution', async () => {
  const f = fixture(), drafts = copy({ ui: f.state.ui, conversations: f.state.conversations, previewRecord: f.state.previewRecord });
  assert.deepEqual(copy(await f.command(inboxCreate())), { status: 'saved', id: quickId, alreadyExists: false });
  const created = f.state.tasks.find(row => row.id === quickId);
  assert.equal(created.priority, 'high'); assert.equal(created.status, 'todo'); assert.equal(created.projectId, 'project-one');
  assert.deepEqual(copy(created.sourceTaskInbox), { version: 1, id: 'external-agent-task', category: 'P0' });
  assert.equal(f.calls.create, 1); assert.equal(f.calls.persist, 1); assert.equal(f.calls.events.length, 1);
  delete f.state.ui.nativeQuickTaskReceipts;
  assert.deepEqual(copy({ ui: f.state.ui, conversations: f.state.conversations, previewRecord: f.state.previewRecord }), drafts);
});
test('inbox ACK replay is append-only across restart, human edits, changed payload and deletion', async () => {
  const f = fixture(); await f.command(inboxCreate());
  f.state.tasks.find(row => row.id === quickId).title = 'The user edited this task';
  const restarted = fixture({ state: copy(f.state) });
  assert.equal((await restarted.command(inboxCreate())).alreadyExists, true);
  assert.equal(restarted.calls.create, 0); assert.equal(restarted.state.tasks.find(row => row.id === quickId).title, 'The user edited this task');
  assert.equal((await restarted.command(inboxCreate({ title: 'Replacement must not win' }))).reason, 'collision');
  assert.equal((await restarted.command(inboxCreate({ sourceTaskInbox: { version: 1, id: 'external-agent-task', category: 'P1' } }))).reason, 'collision');
  restarted.state.tasks = restarted.state.tasks.filter(row => row.id !== quickId);
  assert.equal((await restarted.command(inboxCreate())).reason, 'removed');
  assert.equal(restarted.state.tasks.length, 1);
});
test('inbox keeps unknown, retired, wrong-space and private projects out of the task database', async () => {
  for (const modify of [
    f => f.state.projects.splice(0), f => { f.state.projects[0].archived = true; },
    f => { f.state.projects[0].workspace = '课程'; }, f => { f.state.projects[0].private = true; },
    f => f.state.projects.push(copy(f.state.projects[0]))
  ]) {
    const f = fixture(); modify(f);
    assert.equal((await f.command(inboxCreate())).reason, 'invalid'); assert.equal(f.calls.persist, 0); assert.equal(f.state.tasks.length, 1);
  }
  const f = fixture(); const result = await f.command(inboxCreate({ workspace: '日常', projectId: null }));
  assert.equal(result.status, 'saved'); assert.equal(f.state.tasks.find(row => row.id === quickId).projectId, null);
});
test('inbox validates exact metadata and snapshots nested caller-owned source before hashing', async () => {
  for (const changes of [
    { priority: 'urgent' }, { priority: 'low' }, { sourceTaskInbox: null },
    { sourceTaskInbox: { version: 1, id: '../file', category: 'P0' } },
    { sourceTaskInbox: { version: 1, id: 'external', category: 'P0', command: 'run shell' } }
  ]) { const f = fixture(); assert.equal((await f.command(inboxCreate(changes))).reason, 'invalid'); assert.equal(f.calls.persist, 0); }
  const f = fixture(), payload = inboxCreate(), pending = f.command(payload);
  payload.sourceTaskInbox.id = 'changed-after-submit'; payload.sourceTaskInbox.category = 'P3';
  assert.equal((await pending).status, 'saved'); assert.equal(f.state.tasks.find(row => row.id === quickId).sourceTaskInbox.id, 'external-agent-task');
});
test('inbox waits for durable ACK and respects hydration, privacy, conflict and lost acknowledgements', async () => {
  const gate = deferred(), started = deferred(), f = fixture({ persist: () => { started.resolve(); return gate.promise; } });
  const pending = f.command(inboxCreate()); await started.promise;
  assert.equal(f.calls.events.length, 0); gate.resolve(false); assert.equal((await pending).reason, 'storage_failed');
  const restarted = fixture({ state: copy(f.state) });
  assert.equal((await restarted.command(inboxCreate())).alreadyExists, true); assert.equal(restarted.calls.create, 0); assert.equal(restarted.calls.persist, 1);
  for (const alter of [f => { f.context.storageHydrated = false; }, f => { f.context.serverConflict = true; }, f => { f.context.PrivateMode.isOn = () => true; }]) {
    const f = fixture(); alter(f); assert.equal((await f.command(inboxCreate())).status, 'deferred'); assert.equal(f.calls.persist, 0);
  }
});

test('successful native task ACK refreshes only the visible task owner and preserves unrelated editor state', async () => {
  const gate = deferred(), started = deferred(), f = fixture({ persist: () => { started.resolve(); return gate.promise; } });
  installTaskRefresh(f);
  const drafts = copy({ ui: f.state.ui, conversation: f.state.conversations[0], previewRecord: f.state.previewRecord });
  const pending = f.command(f.complete()); await started.promise;
  assert.equal(f.calls.events.length, 0); assert.deepEqual(f.calls.board, []);
  f.snapshot(); assert.equal(f.calls.events.length, 0, 'An optimistic snapshot is not a receipt');
  gate.resolve(true); assert.equal((await pending).status, 'saved');
  assert.deepEqual(f.calls.board, ['project-one']); assert.deepEqual(f.calls.schedule, []); assert.deepEqual(f.calls.widgets, []);
  const event = f.calls.events[0]; assert.equal(event.type, 'records-committed'); assert.equal(event.detail.owner, f.state);
  assert.deepEqual(copy(event.detail.ids), ['task-one']);
  assert.deepEqual(copy({ ui: f.state.ui, conversation: f.state.conversations[0], previewRecord: f.state.previewRecord }), drafts);
});

test('creation ACK updates the existing daily task surface without refreshing another space or project', async () => {
  const f = fixture(); installTaskRefresh(f); f.context.document.body.dataset.view = 'daily'; f.state.ui.spaceTabs = { daily: 'tasks' };
  assert.equal((await f.command(create())).status, 'saved');
  assert.deepEqual(copy(f.calls.widgets), [['daily', '日常', 'tasks']]); assert.deepEqual(f.calls.board, []);
  const other = fixture(); installTaskRefresh(other); other.context.document.body.dataset.view = 'research'; other.state.ui.spaceTabs = { research: 'tasks' };
  assert.equal((await other.command(create())).status, 'saved'); assert.deepEqual(other.calls.widgets, []);
});

test('failed, unconfirmed and changed saves publish no committed event and refresh no task surface', async () => {
  for (const persist of [() => false, () => undefined, () => { throw Error('offline'); }, context => { context.state.tasks[0].status = 'todo'; return true; }]) {
    const f = fixture({ persist }); installTaskRefresh(f);
    assert.notEqual((await f.command(f.complete())).status, 'saved');
    assert.deepEqual(f.calls.events, []); assert.deepEqual(f.calls.board, []); assert.deepEqual(f.calls.widgets, []);
  }
  const f = fixture({ persist: () => false }); installTaskRefresh(f);
  assert.notEqual((await f.command(create())).status, 'saved');
  assert.ok(f.state.tasks.find(task => task.id === quickId), 'The uncertain request stays available for an idempotent retry');
  f.snapshot(); assert.deepEqual(f.calls.events, []); assert.deepEqual(f.calls.board, []);
});

test('async task commits refresh the live section while route, project, privacy and state-owner changes stay guarded', async () => {
  for (const scenario of ['schedule', 'other-view', 'other-project', 'stale-panel', 'other-state', 'private']) {
    const gate = deferred(), started = deferred(), f = fixture({ persist: () => { started.resolve(); return gate.promise; } });
    const { panel } = installTaskRefresh(f); const pending = f.command(f.complete()); await started.promise;
    if (scenario === 'schedule') f.state.ui.projectTab = 'schedule';
    if (scenario === 'other-view') f.context.document.body.dataset.view = 'agent';
    if (scenario === 'other-project') { f.state.currentProjectId = 'project-two'; panel.dataset.projectId = 'project-two'; }
    if (scenario === 'stale-panel') panel.dataset.projectId = 'project-two';
    if (scenario === 'other-state') f.context.state = copy(f.state);
    if (scenario === 'private') f.state.projects[0].private = true;
    gate.resolve(true); const result = await pending;
    if (scenario === 'private') assert.notEqual(result.status, 'saved'); else assert.equal(result.status, 'saved');
    assert.deepEqual(f.calls.board, []); assert.deepEqual(f.calls.widgets, []);
    assert.equal(f.calls.schedule.length, scenario === 'schedule' ? 1 : 0, scenario);
    if (scenario === 'other-state' || scenario === 'private') assert.deepEqual(f.calls.events, [], scenario);
  }
});

test('editing or saving a task, plan or document never causes the committed event to replace its input', async () => {
  for (const guard of ['taskDirty', 'planningDirty', 'modal', 'boardBusy', 'scheduleBusy', 'scheduleDirty', 'noteDirty', 'fileDirty']) {
    const f = fixture(); installTaskRefresh(f, { [guard]: true });
    const before = copy({ ui: f.state.ui, previewRecord: f.state.previewRecord, conversations: f.state.conversations });
    assert.equal((await f.command(f.complete())).status, 'saved', guard);
    assert.equal(f.calls.events.length, 1); assert.deepEqual(f.calls.board, [], guard); assert.deepEqual(f.calls.schedule, [], guard);
    assert.deepEqual(copy({ ui: f.state.ui, previewRecord: f.state.previewRecord, conversations: f.state.conversations }), before);
  }
});

test('a task moved during the durable save invalidates both affected project owners using current task state', async () => {
  const f = fixture({ persist: context => { context.state.projects.push({ id: 'project-two', name: '另一项目', workspace: '科研' }); context.state.tasks[0].projectId = 'project-two'; return true; } });
  installTaskRefresh(f);
  assert.equal((await f.command(f.complete())).status, 'saved');
  assert.deepEqual(copy(f.calls.events[0].detail.projectIds), ['project-one', 'project-two']);
  assert.deepEqual(f.calls.board, ['project-one'], 'Remove the stale row from the still-visible old owner');
  assert.equal(f.state.tasks[0].projectId, 'project-two');
});

test('stale or unrelated invalidations cannot refresh a task surface and display errors cannot revoke a saved receipt', async () => {
  const f = fixture(); installTaskRefresh(f);
  for (const patch of [{ source: 'other' }, { owner: copy(f.state) }, { collection: 'notes' }, { ids: ['missing'] }, { projectIds: ['other'] }]) {
    f.context.refreshNativeCommittedTaskSurfaces({ detail: { source: 'native-quick-workbench', owner: f.state, collection: 'tasks', ids: ['task-one'], projectIds: ['project-one'], ...patch } });
  }
  assert.deepEqual(f.calls.board, []);
  f.context.ProjectBoard.render = () => { throw Error('Renderer unavailable'); };
  assert.equal((await f.command(f.complete())).status, 'saved');
});

test('snapshot projects current task and run summaries without bodies or changing route and drafts', () => {
  const f = fixture(), before = copy(f.state), first = copy(f.snapshot());
  assert.equal(first.version, 1); assert.equal(first.status, 'ready');
  assert.equal(first.taskCount, 1); assert.equal(first.runCount, 1);
  assert.deepEqual(Object.keys(first.tasks[0]).sort(), ['createdAt', 'dueAt', 'dueLabel', 'id', 'isCompleted', 'isSaving', 'projectId', 'projectTitle', 'title', 'version', 'workflowCategory', 'workspace']);
  assert.deepEqual(Object.keys(first.runs[0]).sort(), ['canCancel', 'detail', 'finishedAt', 'id', 'isActive', 'notificationReady', 'startedAt', 'status', 'statusLabel', 'title']);
  assert.equal(first.tasks[0].title, '阅读论文'); assert.equal(first.tasks[0].projectTitle, '合成科研项目');
  assert.equal(typeof first.tasks[0].version, 'string'); assert.ok(first.tasks[0].version);
  assert.equal(first.runs[0].canCancel, true); assert.ok(f.calls.access > 0);
  assert.doesNotMatch(JSON.stringify(first), /TASK_BODY_MUST_NOT_LEAK|RUN_BODY_MUST_NOT_LEAK|RUN_OUTPUT_MUST_NOT_LEAK|保留未发送草稿/);
  assert.deepEqual(copy(f.state), before);
  f.state.tasks[0].title = '更新后的阅读任务'; f.state.projects[0].name = '已改名项目'; f.state.agentRuns[0].status = 'completed';
  const next = copy(f.snapshot());
  assert.equal(next.tasks[0].title, '更新后的阅读任务'); assert.equal(next.tasks[0].projectTitle, '已改名项目');
  assert.notEqual(next.tasks[0].version, first.tasks[0].version); assert.equal(next.runs[0].canCancel, false);
  assert.equal(f.calls.persist, 0);
});

test('snapshot includes every visible task without an arbitrary truncation limit', () => {
  const f = fixture(); f.state.tasks = Array.from({ length: 145 }, (_, i) => task({ id: `task-${i}`, title: `合成任务 ${i}` }));
  const value = f.snapshot(); assert.equal(value.tasks.length, 145); assert.equal(value.taskCount, 145);
  assert.equal(new Set(value.tasks.map(item => item.id)).size, 145);
});

test('run projections preserve checkpoint semantics instead of showing unconfirmed success', () => {
  for (const [status, phase, approvalReceipt, label, isActive] of [
    ['running', 'prepared', undefined, '执行中', true],
    ['awaiting-approval', 'prepared', undefined, '等待审批', true],
    ['completed', 'prepared', undefined, '已中断', false],
    ['completed', 'applied', undefined, '等待保存', true],
    ['rejected', 'applied', undefined, '已拒绝', false],
    ['completed', undefined, { savePending: true }, '等待保存', true],
    ['completed', 'applied', { savePending: false }, '已完成', false],
  ]) {
    const f = fixture(); Object.assign(f.state.agentRuns[0], { status, executionReceipt: phase ? { version: 1, phase } : undefined, approvalReceipt });
    const row = f.snapshot().runs[0]; assert.equal(row.statusLabel, label, `${status}/${phase}`); assert.equal(row.isActive, isActive);
  }
});

test('legacy protocol inspection caches unchanged text and refreshes only after actual content change', () => {
  const f = fixture(); f.state.agentRuns[0].status = 'completed';
  const message = { role: 'agent', runId: 'run-one', text: '已整理成正常的文献摘要。' }; f.state.conversations[0].messages = [message];
  for (let i = 0; i < 5; i++) assert.equal(f.snapshot().runs[0].statusLabel, '已完成');
  assert.equal(f.calls.protocol, 1);
  message.text = '<｜DSML｜calls>\n<｜DSML｜invoke name="read_page">\n</｜DSML｜invoke>\n</｜DSML｜calls>';
  const leaked = f.snapshot(); assert.equal(leaked.runs[0].statusLabel, '未完成'); assert.equal(f.calls.protocol, 2);
  assert.doesNotMatch(JSON.stringify(leaked), /DSML|read_page/);
  f.snapshot(); assert.equal(f.calls.protocol, 2);
  message.text = '更新后的正常摘要。'; assert.equal(f.snapshot().runs[0].statusLabel, '已完成'); assert.equal(f.calls.protocol, 3);
});

test('private and retired owners including trash ancestry cannot leak into snapshot or completion', async () => {
  const f = fixture();
  f.state.projects.push({ id: 'private-project', name: 'PRIVATE_PROJECT_TITLE', private: true }, { id: 'retired-project', name: 'RETIRED_PROJECT_TITLE', archived: true });
  f.state.trash.push({ data: { conversations: [{ id: 'private-conversation', private: true }], agentRuns: [{ id: 'private-origin-run', conversationId: 'private-conversation' }] } });
  f.state.tasks.push(
    task({ id: 'private-direct', title: 'PRIVATE_DIRECT', private: true }),
    task({ id: 'private-parent', title: 'PRIVATE_PARENT', projectId: 'private-project' }),
    task({ id: 'private-ancestry', title: 'PRIVATE_ANCESTRY', agentRunId: 'private-origin-run' }),
    task({ id: 'retired-owner', title: 'RETIRED_OWNER', projectId: 'retired-project' }),
    task({ id: 'retired-task', title: 'RETIRED_TASK', archived: true })
  );
  f.state.agentRuns.push(run({ id: 'private-run', title: 'PRIVATE_RUN', conversationId: 'private-conversation' }), run({ id: 'direct-private-run', title: 'DIRECT_PRIVATE_RUN', ephemeral: true }));
  const snapshot = copy(f.snapshot());
  assert.deepEqual(snapshot.tasks.map(item => item.id), ['task-one']); assert.deepEqual(snapshot.runs.map(item => item.id), ['run-one']);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_|RETIRED_/);
  const before = copy(f.state);
  for (const id of ['private-direct', 'private-parent', 'private-ancestry', 'retired-owner', 'retired-task']) {
    const result = await f.command({ action: 'set-task-completed', id, completed: true, expectedVersion: 'forged' });
    assert.notEqual(result.status, 'saved');
  }
  assert.equal(f.calls.persist, 0); assert.deepEqual(copy(f.state), before);
});

test('privacy follows duplicate private owner identities and retained provenance, not only live fields', () => {
  const f = fixture();
  f.state.tasks.push(task({ id: 'private-provenance', title: 'PROVENANCE_SECRET', provenance: { origin: { private: true } } }));
  f.state.trash.push({ data: { projects: [{ id: 'project-one', private: true }] } });
  const value = f.snapshot(); assert.deepEqual(copy(value.tasks), []); assert.deepEqual(copy(value.runs), []);
});

test('hydration, conflict, purge and global private mode defer snapshots and all mutations', async () => {
  for (const [field, value, reason] of [['storageHydrated', false, 'hydrating'], ['serverConflict', true, 'conflict'], ['purgeTrash', { syncPaused: true }, 'busy'], ['PrivateMode', { isOn: () => true }, 'private']]) {
    const f = fixture(), complete = f.complete(); f.context[field] = value;
    const before = copy(f.state), snapshot = f.snapshot();
    assert.equal(snapshot.status, 'deferred'); assert.equal(snapshot.reason, reason);
    assert.deepEqual(copy(snapshot.tasks), []); assert.deepEqual(copy(snapshot.runs), []);
    for (const command of [create(), complete, { action: 'cancel-run', id: 'run-one' }]) assert.equal((await f.command(command)).reason, reason);
    assert.equal(f.calls.persist, 0); assert.equal(f.calls.cancel, 0); assert.deepEqual(copy(f.state), before);
  }
});

test('task creation uses production planning shape, immutable receipt and existing durable writer', async () => {
  const f = fixture(), before = copy(f.state);
  assert.deepEqual(copy(await f.command(create())), { status: 'saved', id: quickId });
  const item = f.state.tasks.find(item => item.id === quickId);
  assert.equal(f.calls.create, 1); assert.equal(f.calls.persist, 1);
  assert.equal(item.title, create().title); assert.equal(item.workspace, '日常'); assert.equal(item.projectId, null); assert.equal(item.status, 'todo');
  assert.equal(item.sourceQuickTaskId, quickId); assert.match(item.quickTaskFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(f.state.ui.nativeQuickTaskReceipts[quickId], item.quickTaskFingerprint);
  const after = copy(f.state); after.tasks = after.tasks.filter(item => item.id !== quickId); delete after.ui.nativeQuickTaskReceipts;
  assert.deepEqual(after, before);
  assert.equal(f.snapshot().tasks.some(row => row.id === quickId), true);
});

test('same pending creation shares one save; a changed request under the same identity is busy', async () => {
  const saving = deferred(), gate = deferred(), f = fixture({ persist: () => { saving.resolve(); return gate.promise; } });
  const first = f.command(create()), again = f.command(create()); assert.equal(first, again);
  assert.equal(f.command({ title: create().title, id: quickId, action: 'create-task' }), first);
  await saving.promise;
  assert.equal((await f.command(create({ title: '不同请求' }))).reason, 'busy');
  assert.equal(f.calls.persist, 1); gate.resolve(true); assert.equal((await first).status, 'saved');
});

test('lost creation acknowledgement survives restart and acknowledges without overwriting human edits', async () => {
  let durable;
  const first = fixture({ persist: context => { durable = copy(context.state); throw Error('lost acknowledgement'); } });
  assert.equal((await first.command(create())).reason, 'storage_failed');
  const edited = durable.tasks.find(item => item.id === quickId); Object.assign(edited, { title: '人工修改', description: '新详情', status: 'done', updatedAt: 998 });
  const before = copy(edited), restarted = fixture({ state: durable });
  assert.equal((await restarted.command(create())).status, 'saved');
  assert.equal(restarted.calls.create, 0); assert.equal(restarted.calls.persist, 1);
  assert.deepEqual(copy(restarted.state.tasks.find(item => item.id === quickId)), before);
  assert.equal((await restarted.command(create({ title: 'different' }))).reason, 'collision');
});

test('creation never resurrects archived, trashed or permanently purged task receipts', async () => {
  for (const lifecycle of ['archived', 'trash', 'purged']) {
    const f = fixture(); await f.command(create());
    if (lifecycle === 'archived') f.state.tasks.find(item => item.id === quickId).archived = true;
    else { const item = f.state.tasks.find(item => item.id === quickId); f.state.tasks = f.state.tasks.filter(item => item.id !== quickId); if (lifecycle === 'trash') f.state.trash.push({ data: { tasks: [item] } }); }
    const restarted = fixture({ state: copy(f.state) }), before = copy(restarted.state);
    assert.equal((await restarted.command(create())).reason, 'removed'); assert.equal(restarted.calls.persist, 0); assert.equal(restarted.calls.create, 0);
    assert.deepEqual(copy(restarted.state), before);
  }
});

test('new and duplicate identity collisions preserve existing task data', async () => {
  for (const where of ['tasks', 'trash']) {
    const f = fixture(), collision = task({ id: quickId });
    if (where === 'tasks') f.state.tasks.push(collision); else f.state.trash.push({ data: { tasks: [collision] } });
    const before = copy(f.state); assert.equal((await f.command(create())).reason, where === 'trash' ? 'removed' : 'collision');
    assert.equal(f.calls.persist, 0); assert.deepEqual(copy(f.state), before);
  }
  const f = fixture(); await f.command(create()); f.state.tasks.push(copy(f.state.tasks.find(item => item.id === quickId)));
  assert.equal((await f.command(create())).reason, 'collision'); assert.equal(f.calls.persist, 1);
});

test('strict creation persistence confirmation and current live receipt are both required', async () => {
  for (const result of [false, undefined, { ok: true }]) {
    const f = fixture({ persist: () => result });
    assert.equal((await f.command(create())).reason, 'storage_failed'); assert.equal(f.state.tasks.filter(item => item.id === quickId).length, 1);
  }
  const removed = fixture({ persist: context => { context.state = { ...context.state, tasks: context.state.tasks.filter(item => item.id !== quickId) }; return true; } });
  assert.equal((await removed.command(create())).reason, 'removed');
  const merged = fixture({ persist: context => { context.state = copy(context.state); return true; } });
  assert.equal((await merged.command(create())).status, 'saved');
});

test('malformed or conflicting creation ledgers are preserved rather than replaced or backfilled', async () => {
  for (const ledger of [null, false, [], 'invalid']) {
    const f = fixture(); f.state.ui.nativeQuickTaskReceipts = ledger; const before = copy(f.state);
    assert.equal((await f.command(create())).reason, 'unavailable'); assert.equal(f.calls.persist, 0); assert.deepEqual(copy(f.state), before);
  }
  const f = fixture(); await f.command(create());
  f.state.ui.nativeQuickTaskReceipts[quickId] = 'sha256:' + 'f'.repeat(64); const before = copy(f.state);
  assert.equal((await f.command(create())).reason, 'collision'); assert.deepEqual(copy(f.state), before);
});

test('creation snapshots caller-owned input before hashing and rechecks privacy after the await', async () => {
  const gate = deferred(), f = fixture({ crypto: { subtle: { digest: async (...args) => { await gate.promise; return webcrypto.subtle.digest(...args); } } } });
  const value = create(), original = copy(value), pending = f.command(value); value.title = 'later caller mutation'; gate.resolve();
  assert.equal((await pending).status, 'saved'); assert.equal(f.state.tasks.find(item => item.id === quickId).title, original.title);
  const privateGate = deferred(), blocked = fixture({ crypto: { subtle: { digest: async (...args) => { await privateGate.promise; return webcrypto.subtle.digest(...args); } } } });
  const command = blocked.command(create()); blocked.context.PrivateMode = { isOn: () => true }; privateGate.resolve();
  assert.equal((await command).reason, 'private'); assert.equal(blocked.calls.create, 0); assert.equal(blocked.calls.persist, 0);
});

test('completion uses production Core with an exact allowed target and can reopen the same task', async () => {
  const f = fixture(), initial = copy(f.state);
  assert.deepEqual(copy(await f.command(f.complete())), { status: 'saved', id: 'task-one' });
  assert.equal(f.calls.apply.length, 1); assert.deepEqual(f.calls.apply[0].actions, [{ type: 'update_task', taskId: 'task-one', patch: { status: 'done' } }]);
  assert.deepEqual(f.calls.apply[0].scope.allowedTaskIds, ['task-one']);
  assert.equal(f.state.tasks[0].status, 'done'); assert.ok(f.state.tasks[0].completedAt);
  const after = copy(f.state); for (const key of ['status', 'completedAt', 'updatedAt']) after.tasks[0][key] = initial.tasks[0][key];
  assert.deepEqual(after, initial);
  assert.equal((await f.command(f.complete('task-one', false))).status, 'saved'); assert.equal(f.state.tasks[0].status, 'todo'); assert.equal(f.state.tasks[0].completedAt, null);
});

test('completion refuses stale versions even when edited tasks retain their timestamp', async () => {
  for (const patch of [{ title: 'different title' }, { description: 'changed details' }, { dueAt: '2030-10-04' }, { status: 'blocked' }, { checklist: [{ text: 'new step', done: false }] }]) {
    const f = fixture(), command = f.complete(); Object.assign(f.state.tasks[0], patch); const before = copy(f.state);
    assert.equal((await f.command(command)).reason, 'changed'); assert.equal(f.calls.persist, 0); assert.deepEqual(copy(f.state), before);
  }
});

test('in-place nested task changes invalidate a previously projected completion version', async () => {
  const f = fixture(); f.state.tasks[0].checklist = [{ text: '第一步', done: false }];
  const command = f.complete(); f.state.tasks[0].checklist[0].done = true;
  const before = copy(f.state), updated = f.snapshot().tasks[0].version;
  assert.notEqual(updated, command.expectedVersion);
  assert.equal((await f.command(command)).reason, 'changed'); assert.equal(f.calls.persist, 0); assert.deepEqual(copy(f.state), before);
});

test('completion preserves production deliverable validation', async () => {
  const f = fixture(); f.state.tasks[0].deliverable = { kind: 'note', ref: 'missing-output' };
  const before = copy(f.state), result = await f.command(f.complete());
  assert.equal(result.reason, 'unmet_deliverable'); assert.equal(f.calls.persist, 0); assert.deepEqual(copy(f.state), before);
  f.state.notes.push({ id: 'missing-output', title: '合成产出', projectId: 'project-one', content: 'verified artifact' });
  assert.equal((await f.command(f.complete())).status, 'saved');
});

test('private or retired deliverables do not silently satisfy a public task requirement', async () => {
  for (const extra of [{ private: true }, { deletedAt: 123 }, { provenance: { origin: { private: true } } }]) {
    const f = fixture(); f.state.tasks[0].deliverable = { kind: 'note', ref: 'private-output' };
    f.state.notes.push({ id: 'private-output', title: 'PRIVATE_OUTPUT', projectId: 'project-one', content: 'private content', ...extra });
    const before = copy(f.state); assert.equal((await f.command(f.complete())).reason, 'unmet_deliverable');
    assert.equal(f.calls.persist, 0); assert.deepEqual(copy(f.state), before);
  }
});

test('pending identical completion is shared while opposing status commands are busy', async () => {
  const gate = deferred(), saving = deferred(), f = fixture({ persist: () => { saving.resolve(); return gate.promise; } });
  const command = f.complete(), first = f.command(command), second = f.command(copy(command)); assert.equal(first, second);
  await saving.promise;
  const row = f.snapshot().tasks.find(item => item.id === 'task-one'); assert.equal(row.isSaving, true); assert.equal(row.isCompleted, false);
  assert.equal((await f.command({ ...command, completed: false })).reason, 'busy'); assert.equal(f.calls.persist, 1);
  gate.resolve(true); assert.equal((await first).status, 'saved');
  assert.equal(f.snapshot().tasks.find(item => item.id === 'task-one').isSaving, false);
});

test('failed completion rolls back only its fields and preserves a concurrent human title edit', async () => {
  const f = fixture({ persist: context => { Object.assign(context.state.tasks[0], { title: '人工并发修改', updatedAt: 9999999999999 }); return false; } });
  assert.equal((await f.command(f.complete())).reason, 'storage_failed');
  assert.equal(f.state.tasks[0].title, '人工并发修改'); assert.equal(f.state.tasks[0].updatedAt, 9999999999999);
  assert.equal(f.state.tasks[0].status, 'todo'); assert.equal(f.state.tasks[0].completedAt, null);
});

test('failed completion does not replace a later status edit or resurrect a removed record', async () => {
  const changed = fixture({ persist: context => { Object.assign(context.state.tasks[0], { status: 'blocked', completedAt: null, updatedAt: 777 }); throw Error('save failed'); } });
  assert.equal((await changed.command(changed.complete())).reason, 'storage_failed');
  assert.equal(changed.state.tasks[0].status, 'blocked'); assert.equal(changed.state.tasks[0].updatedAt, 777);
  const removed = fixture({ persist: context => { context.state.tasks = []; return false; } });
  assert.equal((await removed.command(removed.complete())).reason, 'storage_failed'); assert.deepEqual(copy(removed.state.tasks), []);
});

test('completion requires exact durable acknowledgement and verifies the live post-save task', async () => {
  for (const result of [false, undefined, { ok: true }]) {
    const f = fixture({ persist: () => result }), before = copy(f.state.tasks[0]);
    assert.equal((await f.command(f.complete())).reason, 'storage_failed'); assert.deepEqual(copy(f.state.tasks[0]), before);
  }
  const changed = fixture({ persist: context => { context.state.tasks[0].status = 'todo'; return true; } });
  assert.notEqual((await changed.command(changed.complete())).status, 'saved');
  const removed = fixture({ persist: context => { context.state = { ...context.state, tasks: [] }; return true; } });
  assert.notEqual((await removed.command(removed.complete())).status, 'saved');
  const copied = fixture({ persist: context => { context.state = copy(context.state); return true; } });
  assert.equal((await copied.command(copied.complete())).status, 'saved');
  const edited = fixture({ persist: context => { Object.assign(context.state.tasks[0], { title: '另一处修改的标题', updatedAt: 1234567 }); return true; } });
  assert.equal((await edited.command(edited.complete())).status, 'saved'); assert.equal(edited.state.tasks[0].title, '另一处修改的标题');
  const privateAfterSave = fixture({ persist: context => { context.state.projects[0].private = true; return true; } });
  assert.equal((await privateAfterSave.command(privateAfterSave.complete())).reason, 'private');
  assert.deepEqual(copy(privateAfterSave.snapshot().tasks), []);
});

test('cancellation only targets the exact active run and never navigates or claims finished state', async () => {
  const f = fixture(); f.state.agentRuns.push(run({ id: 'other-running' }), run({ id: 'completed-run', status: 'completed', finishedAt: 3 }));
  const before = copy(f.state);
  for (const id of ['other-running', 'completed-run', 'missing']) assert.notEqual((await f.command({ action: 'cancel-run', id })).status, 'cancel_requested');
  assert.equal(f.calls.cancel, 0);
  assert.deepEqual(copy(await f.command({ action: 'cancel-run', id: 'run-one' })), { status: 'cancel_requested', id: 'run-one' });
  assert.equal(f.calls.cancel, 1); assert.equal(f.calls.persist, 0); assert.deepEqual(copy(f.state), before);
  f.context.activeRunId = 'other-running';
  assert.equal(f.snapshot().runs.find(item => item.id === 'run-one').canCancel, false);
  assert.notEqual((await f.command({ action: 'cancel-run', id: 'run-one' })).status, 'cancel_requested'); assert.equal(f.calls.cancel, 1);
  f.context.activeRunId = 'run-one'; f.context.activeRunController = { signal: { aborted: true } };
  assert.equal(f.snapshot().runs.find(item => item.id === 'run-one').canCancel, false);
  assert.notEqual((await f.command({ action: 'cancel-run', id: 'run-one' })).status, 'cancel_requested'); assert.equal(f.calls.cancel, 1);
});

test('malformed commands and unsupported fields fail before mutation', async () => {
  const f = fixture(), before = copy(f.state), complete = f.complete();
  for (const value of [null, [], {}, create({ id: 'foreign' }), create({ id: quickId.toUpperCase() }), create({ title: ' \n' }), create({ title: '😀'.repeat(251) }), { ...create(), projectId: 'injected' }, { ...complete, completed: 1 }, { ...complete, expectedVersion: null }, { ...complete, patch: { title: 'injected' } }, { action: 'cancel-run', id: 'run-one', force: true }, { action: 'delete-task', id: 'task-one' }]) {
    assert.equal((await f.command(value)).reason, 'invalid');
  }
  assert.equal(f.calls.persist, 0); assert.equal(f.calls.cancel, 0); assert.deepEqual(copy(f.state), before);
  assert.equal((await f.command(create({ title: '😀'.repeat(250) }))).status, 'saved');
});

const update = (f, patch, changes = {}) => ({ action: 'update-task', id: 'task-one', expectedVersion: f.snapshot().tasks.find(item => item.id === 'task-one')?.version, patch, ...changes });

test('project/date creation uses the existing planner, stores exact raw dates and refreshes the actual owner after ACK', async () => {
  const f = fixture(); installTaskRefresh(f);
  const input = create({ workspace: '科研', projectId: 'project-one', dueAt: '2030-10-04T14:30:00+08:00' });
  assert.equal((await f.command(input)).status, 'saved');
  const item = f.state.tasks.find(task => task.id === quickId);
  assert.equal(item.workspace, '科研'); assert.equal(item.projectId, 'project-one'); assert.equal(item.dueAt, input.dueAt);
  const row = f.snapshot().tasks.find(task => task.id === quickId);
  assert.equal(row.dueAt, input.dueAt); assert.equal(row.projectId, 'project-one'); assert.equal(row.workspace, '科研');
  assert.deepEqual(f.calls.board, ['project-one']); assert.equal(f.calls.create, 1);
});

test('V2 creation retries fingerprint the full original request and never duplicate or overwrite a human edit', async () => {
  let saved = false; const f = fixture({ persist: () => saved });
  const payload = create({ workspace: '科研', projectId: 'project-one', dueAt: '2030-10-04' });
  assert.equal((await f.command(payload)).reason, 'storage_failed');
  const item = f.state.tasks.find(task => task.id === quickId); item.title = '人工更名'; item.dueAt = null;
  for (const change of [{ dueAt: '2030-10-05' }, { projectId: null }, { workspace: '课程' }]) {
    assert.equal((await f.command({ ...payload, ...change })).reason, 'collision');
  }
  saved = true; assert.equal((await f.command(payload)).status, 'saved');
  assert.equal(f.calls.create, 1); assert.equal(item.title, '人工更名'); assert.equal(item.dueAt, null);
  assert.equal(f.state.tasks.filter(task => task.id === quickId).length, 1);
});

test('task snapshots expose unique public project choices and preserve numeric and date-only deadline values', () => {
  const f = fixture();
  f.state.tasks[0].dueAt = 1917302400000;
  f.state.projects.push({ id: 'private', name: 'PRIVATE', workspace: '课程', private: true }, { id: 'archived', name: 'ARCHIVED', workspace: '日常', archived: true },
    { id: 'duplicate', name: 'DUPLICATE_ONE', workspace: '科研' }, { id: 'duplicate', name: 'DUPLICATE_TWO', workspace: '科研' }, { id: 'course', name: '课程', workspace: '课程' });
  assert.deepEqual(copy(f.snapshot().projects), [{ id: 'project-one', title: '合成科研项目', workspace: '科研' }, { id: 'course', title: '课程', workspace: '课程' }]);
  assert.equal(f.snapshot().tasks[0].dueAt, 1917302400000);
  f.state.tasks[0].dueAt = '2030-10-03'; assert.equal(f.snapshot().tasks[0].dueAt, '2030-10-03');
});

test('task edits use the existing Core and move rules, clear deadline/project explicitly and preserve unrelated fields', async () => {
  const f = fixture(); installTaskRefresh(f); const original = copy(f.state.tasks[0]);
  const payload = update(f, { title: '人工修改任务', workspace: '课程', projectId: null, dueAt: null });
  assert.equal((await f.command(payload)).status, 'saved');
  const item = f.state.tasks[0]; assert.equal(item.title, '人工修改任务'); assert.equal(item.workspace, '课程'); assert.equal(item.projectId, null); assert.equal(item.project, null); assert.equal(item.dueAt, null);
  for (const key of ['description', 'checklist', 'sourceAttachmentIds', 'status', 'completedAt', 'createdAt']) assert.deepEqual(item[key], original[key]);
  assert.equal(f.calls.persist, 1); assert.deepEqual(f.calls.apply[0].scope.allowedTaskIds, ['task-one']);
  assert.deepEqual(f.calls.board, ['project-one'], 'Old project rows are invalidated when the task moves out');
});

test('invalid edit dates, stale versions, hidden projects and incompatible dependency moves reject before persistence', async () => {
  const f = fixture(); f.state.projects.push({ id: 'private', name: 'PRIVATE', workspace: '科研', private: true });
  const original = copy(f.state);
  for (const patch of [{ title: '' }, { dueAt: '2030-02-30' }, { dueAt: '2030-10-04T10:00:00' }, { dueAt: {} }, { projectId: 'missing' }, { projectId: 'private' }, { workspace: '课程', projectId: 'project-one' }, { status: 'done' }, { description: 'INJECTION' }]) {
    assert.notEqual((await f.command(update(f, patch))).status, 'saved', JSON.stringify(patch));
  }
  assert.equal((await f.command(update(f, { title: '新标题' }, { expectedVersion: 'old' }))).reason, 'changed');
  assert.equal(f.calls.persist, 0); assert.deepEqual(copy(f.state), original);
  f.state.tasks[0].startAt = '2030-10-04';
  assert.equal((await f.command(update(f, { dueAt: '2030-10-03' }))).reason, 'invalid');
  f.state.tasks.push(task({ id: 'depends-on', dueAt: null })); f.state.tasks[0].dependsOn = ['depends-on'];
  assert.equal((await f.command(update(f, { workspace: '日常', projectId: null }))).reason, 'invalid');
  assert.equal(f.calls.persist, 0);
});

test('failed task edit rolls back only its owned fields and retains concurrent title/date edits and their version', async () => {
  const f = fixture({ persist: context => { context.state.tasks[0].title = '保存期间的人工标题'; context.state.tasks[0].updatedAt = 777; return false; } });
  const before = copy(f.state.tasks[0]);
  assert.equal((await f.command(update(f, { title: '岛内标题', dueAt: null, workspace: '日常', projectId: null }))).reason, 'storage_failed');
  assert.equal(f.state.tasks[0].title, '保存期间的人工标题'); assert.equal(f.state.tasks[0].updatedAt, 777);
  assert.equal(f.state.tasks[0].dueAt, before.dueAt); assert.equal(f.state.tasks[0].projectId, before.projectId); assert.equal(f.state.tasks[0].workspace, before.workspace);
  assert.deepEqual(f.calls.events, []);
});

test('pending edits share only the exact request; caller mutation cannot alter a sent patch and changed ACK retains new state', async () => {
  const gate = deferred(), started = deferred(), f = fixture({ persist: () => { started.resolve(); return gate.promise; } });
  const payload = update(f, { title: '发送的标题', dueAt: null });
  const pending = f.command(payload); const duplicate = f.command(copy(payload)); await started.promise;
  payload.patch.title = '调用者后来改动';
  assert.equal(f.state.tasks[0].title, '发送的标题');
  assert.equal((await f.command({ ...payload, patch: { title: '另一次请求' } })).reason, 'busy');
  f.state.tasks[0].dueAt = '2031-01-01'; gate.resolve(true);
  assert.equal((await pending).reason, 'changed'); assert.equal((await duplicate).reason, 'changed');
  assert.equal(f.state.tasks[0].dueAt, '2031-01-01'); assert.equal(f.calls.persist, 1); assert.deepEqual(f.calls.events, []);
});

test('edit ACK belongs to the original workspace and record even when replacement fields are identical', async () => {
  for (const replacement of ['workspace', 'record', 'project-scope']) {
    const f = fixture({ persist: context => {
      if (replacement === 'workspace') context.state = copy(context.state);
      else if (replacement === 'record') context.state.tasks[0] = copy(context.state.tasks[0]);
      else context.state.projects[0].workspace = '课程';
      return true;
    } });
    assert.equal((await f.command(update(f, { title: '正确提交标题' }))).reason, 'changed', replacement);
    assert.deepEqual(f.calls.events, [], replacement);
    assert.equal(f.state.tasks[0].title, '正确提交标题', 'A durable write is not rolled back after ownership becomes uncertain');
  }
});

const deletionId = 'quick_task_delete_01234567-89ab-4cde-8fab-0123456789ab';
const deleting = (f, changes = {}) => ({action:'delete-task',id:'task-one',trashId:deletionId,expectedVersion:f.snapshot().tasks.find(row=>row.id==='task-one')?.version,...changes});
const undoing = (changes = {}) => ({action:'restore-task',id:'task-one',trashId:deletionId,...changes});
const batchId = 'quick_task_batch_01234567-89ab-4cde-8fab-0123456789ab';
const batchDelete = (f, ids = ['task-one', 'task-two']) => ({ action: 'delete-tasks', id: batchId, trashId: deletionId,
  items: ids.map(id => ({ id, expectedVersion: f.snapshot().tasks.find(row => row.id === id)?.version })) });
const batchUndo = (ids = ['task-one', 'task-two']) => ({ action: 'restore-tasks', id: batchId, trashId: deletionId, ids });
const batchFixture = options => { const f = fixture(options); if (!options?.state) f.state.tasks.push(task({ id: 'task-two', title: '第二份阅读' })); return f; };

test('bulk delete and undo use one canonical trash entry with all original task and relation content', async () => {
  const f = batchFixture(); installTaskRefresh(f);
  const keep = task({ id: 'keep' }), source = { id: 'source', name: 'synthetic.pdf' }; f.state.tasks.push(keep); f.state.imports.push(source);
  f.state.tasks[0].sourceAttachmentIds = ['source'];
  f.state.links.push({ id: 'source-link', sourceType: 'import', sourceId: 'source', targetType: 'task', targetId: 'task-one' },
    { id: 'task-link', sourceType: 'task', sourceId: 'task-one', targetType: 'task', targetId: 'task-two' });
  const originals = copy(f.state.tasks.slice(0, 2)), links = copy(f.state.links), request = batchDelete(f, ['task-two', 'task-one']);
  f.state.tasks.reverse();
  assert.deepEqual(copy(await f.command(request)), { status: 'deleted', id: batchId, trashId: deletionId, ids: ['task-two', 'task-one'] });
  assert.equal(f.calls.persist, 1); assert.equal(f.state.trash.length, 1); assert.equal(f.state.trash[0].data.tasks.length, 2);
  assert.equal(f.state.tasks.length, 1); assert.equal(f.state.tasks[0], keep); assert.equal(f.state.imports[0], source);
  assert.equal(f.calls.events.length, 1); assert.deepEqual(copy(f.calls.events[0].detail.ids), ['task-two', 'task-one']);
  assert.deepEqual(copy(await f.command(batchUndo(['task-two', 'task-one']))), { status: 'restored', id: batchId, trashId: deletionId, ids: ['task-two', 'task-one'] });
  assert.equal(f.calls.persist, 2); assert.equal(f.state.trash.length, 0); assert.equal(f.state.tasks.find(row => row.id === 'keep'), keep);
  for (const original of originals) assert.deepEqual(copy(f.state.tasks.find(row => row.id === original.id)), original);
  assert.deepEqual(copy(f.state.links), links); assert.deepEqual(copy(f.calls.board), ['project-one', 'project-one']);
});

test('every batch member is preflighted before mutation, including version/privacy/missing/collision and editors', async () => {
  for (const change of [f => f.state.tasks[1].description = 'new content', f => f.state.tasks[1].private = true,
    f => f.state.tasks.pop(), f => f.state.tasks.push(copy(f.state.tasks[1])), f => f.context.taskEditorHasDrafts = () => true,
    f => f.context.serverConflict = true]) {
    const f = batchFixture(), request = batchDelete(f); change(f); const before = copy(f.state);
    assert.notEqual((await f.command(request)).status, 'deleted'); assert.equal(f.calls.persist, 0); assert.deepEqual(copy(f.state), before);
  }
});

test('batch replay survives unknown durable delete/restore ACK and cannot retarget or repeat a restored batch', async () => {
  let durable;
  const first = batchFixture({ persist: context => { durable = copy(context.state); throw Error('ACK lost'); } }), request = batchDelete(first);
  assert.equal((await first.command(request)).reason, 'storage_failed'); assert.equal(first.calls.events.length, 0);
  const second = batchFixture({ state: durable });
  assert.equal((await second.command(request)).status, 'deleted'); assert.equal(second.state.trash.length, 1);
  const altered = copy(request); altered.items.reverse(); assert.equal((await second.command(altered)).reason, 'collision');
  const third = batchFixture({ state: copy(second.state), persist: context => { durable = copy(context.state); return false; } });
  assert.equal((await third.command(batchUndo())).reason, 'storage_failed'); assert.equal(third.calls.events.length, 0);
  const fourth = batchFixture({ state: durable }); assert.equal((await fourth.command(batchUndo())).status, 'restored');
  assert.equal(fourth.state.tasks.length, 2); assert.equal((await fourth.command(request)).reason, 'changed');
  fourth.state.tasks[1].title = 'later edit'; assert.equal((await fourth.command(batchUndo())).reason, 'changed');
  assert.equal(fourth.state.tasks[1].title, 'later edit');
});

test('batch restore rejects partial collisions, archived owners, purged or changed members without restoring any subset', async () => {
  for (const change of [f => f.state.tasks.push(task({ id: 'task-two', title: 'replacement' })), f => f.state.trash[0].data.tasks.pop(),
    f => f.state.trash[0].data.tasks[1].title = 'changed retained content', f => f.state.trash[0].data.tasks[1].private = true,
    f => f.state.projects[0].archived = true, f => f.state.trash = []]) {
    const f = batchFixture(); await f.command(batchDelete(f)); change(f); const before = copy(f.state);
    assert.notEqual((await f.command(batchUndo())).status, 'restored'); assert.equal(f.calls.persist, 1); assert.deepEqual(copy(f.state), before);
  }
});

test('batch locks all member identities, coalesces exact calls, freezes caller arrays and rejects a changed late ACK', async () => {
  const gate = deferred(), started = deferred(), f = batchFixture({ persist: () => { started.resolve(); return gate.promise; } });
  const request = batchDelete(f), original = copy(request), pending = f.command(request);
  assert.equal(f.command(copy(request)), pending);
  request.items[1].id = 'other'; request.items.push({ id: 'keep', expectedVersion: 'none' });
  await started.promise;
  for (const item of original.items) {
    assert.equal((await f.command({ action: 'set-task-completed', id: item.id, expectedVersion: item.expectedVersion, completed: true })).reason, 'busy');
    assert.equal((await f.command({ action: 'delete-task', id: item.id, trashId: deletionId, expectedVersion: item.expectedVersion })).reason, 'busy');
  }
  const overlapping = copy(original); overlapping.id = 'quick_task_batch_11111111-2222-4333-8444-555555555555';
  assert.equal((await f.command(overlapping)).reason, 'busy'); assert.equal(f.calls.persist, 1);
  assert.deepEqual(copy(f.state.trash[0].data.tasks.map(row => row.id)), ['task-one', 'task-two']);
  f.state.trash[0].data.tasks[1].title = 'concurrent change'; gate.resolve(true);
  assert.equal((await pending).reason, 'changed'); assert.equal(f.calls.events.length, 0);
});

test('in-flight ordinary task changes block a bulk operation before it removes other members', async () => {
  const gate = deferred(), started = deferred(), f = batchFixture({ persist: () => { started.resolve(); return gate.promise; } });
  const request = batchDelete(f), pending = f.command(f.complete('task-two')); await started.promise;
  assert.equal((await f.command(request)).reason, 'busy'); assert.equal(f.state.tasks.length, 2); assert.equal(f.state.trash.length, 0);
  assert.equal(f.snapshot().tasks.find(row => row.id === 'task-two').isSaving, true);
  gate.resolve(true); assert.equal((await pending).status, 'saved');
});

test('batch input validation rejects ambiguous membership without writes', async () => {
  const f = batchFixture(), valid = batchDelete(f), before = copy(f.state);
  for (const request of [{ ...valid, items: [] }, { ...valid, items: [valid.items[0], valid.items[0]] },
    { ...valid, items: [{ id: 'task-one', expectedVersion: '' }] }, { ...valid, items: [{ ...valid.items[0], task: {} }] },
    { ...valid, id: 'task-one' }, { ...valid, ids: ['task-one'] }, { ...batchUndo(), ids: [] }, { ...batchUndo(), ids: ['task-one', 'task-one'] }]) {
    assert.equal((await f.command(request)).reason, 'invalid');
  }
  assert.equal(f.calls.persist, 0); assert.deepEqual(copy(f.state), before);
});

test('bulk ACK cannot publish after owner/privacy/conflict/receipt changes during persistence', async () => {
  for (const change of [context => context.state = copy(context.state), context => context.state.projects[0].private = true,
    context => context.serverConflict = true, context => context.state.ui.nativeQuickTaskBatchLifecycleReceipts[deletionId].ids.reverse()]) {
    const f = batchFixture({ persist: context => { change(context); return true; } });
    assert.notEqual((await f.command(batchDelete(f))).status, 'deleted'); assert.equal(f.calls.events.length, 0);
  }
});

test('batch request and trash identities cannot be reused for a different batch or the single-task protocol', async () => {
  const f = batchFixture(); const request = batchDelete(f);
  assert.equal((await f.command(request)).status, 'deleted'); assert.equal((await f.command(batchUndo())).status, 'restored');
  const changed = batchDelete(f); changed.trashId = 'quick_task_delete_11111111-2222-4333-8444-555555555555';
  assert.equal((await f.command(changed)).reason, 'collision');
  assert.equal((await f.command(deleting(f))).reason, 'collision'); assert.equal(f.calls.persist, 2);
  const single = batchFixture(); assert.equal((await single.command(deleting(single))).status, 'deleted');
  assert.equal((await single.command(undoing())).status, 'restored');
  assert.equal((await single.command(batchDelete(single))).reason, 'collision'); assert.equal(single.state.tasks.length, 2);
});

test('task projection is deadline-first and stable by creation time then ID, with unfinished before completed',()=>{
 const f=fixture();f.state.tasks=[
  task({id:'undated',dueAt:null,createdAt:0}),task({id:'invalid',dueAt:'2030-02-31',createdAt:2}),
  task({id:'same-b',dueAt:'2030-10-03T10:00:00Z',createdAt:10}),task({id:'same-a',dueAt:'2030-10-03T10:00:00Z',createdAt:10}),
  task({id:'early-created',dueAt:'2030-10-03T10:00:00Z',createdAt:1}),task({id:'early-deadline',dueAt:'2030-10-02',createdAt:100}),
  task({id:'finished',dueAt:'2000-01-01',createdAt:0,status:'done'})];
 const expected=['early-deadline','early-created','same-a','same-b','undated','invalid','finished'];
 assert.deepEqual(copy(f.snapshot().tasks.map(row=>row.id)),expected);f.state.tasks.reverse();assert.deepEqual(copy(f.snapshot().tasks.map(row=>row.id)),expected);
 assert.equal(f.snapshot().tasks[0].createdAt,100);
});

test('delete and undo use canonical content trash, retain unrelated identities and original sources, and refresh visible task owner',async()=>{
 const f=fixture();installTaskRefresh(f);const keep=task({id:'keep'});f.state.tasks.push(keep);
 const source={id:'source',name:'source.pdf'},derived={id:'derived',title:'derived work'};f.state.imports.push(source);f.state.notes.push(derived);
 f.state.tasks[0].sourceAttachmentIds=['source'];f.state.links.push({id:'link',sourceType:'import',sourceId:'source',targetType:'task',targetId:'task-one'});
 const original=copy(f.state.tasks[0]),beforeDraft=copy(f.state.ui),request=deleting(f);
 assert.deepEqual(copy(await f.command(request)),{status:'deleted',id:'task-one',trashId:deletionId});
 assert.equal(f.state.tasks[0],keep);assert.equal(f.state.imports[0],source);assert.equal(f.state.notes[0],derived);
 assert.equal(f.state.trash[0].type,'content');assert.deepEqual(copy(f.state.trash[0].data.tasks),[original]);assert.equal(f.state.trash[0].data.links.length,1);assert.equal(f.state.links.length,0);
 assert.deepEqual(copy(f.calls.board),['project-one']);assert.equal(f.calls.events[0].detail.operation,'delete');
 assert.deepEqual(copy(await f.command(undoing())),{status:'restored',id:'task-one',trashId:deletionId});
 assert.deepEqual(copy(f.state.tasks.find(row=>row.id==='task-one')),original);assert.equal(f.state.trash.length,0);assert.equal(f.state.links[0].id,'link');assert.equal(f.state.tasks.find(row=>row.id==='keep'),keep);
 assert.deepEqual(f.state.ui.captureDraft,beforeDraft.captureDraft);assert.deepEqual(copy(f.calls.board),['project-one','project-one']);
});

test('deletion checks complete version and editor/privacy ownership before any mutation',async()=>{
 for(const mutate of [f=>f.state.tasks[0].description='new human content',f=>f.context.taskEditorHasDrafts=()=>true,f=>f.context.document.querySelector=()=>({open:true}),f=>f.state.tasks[0].private=true,f=>f.state.projects[0].private=true]){
  const f=fixture(),request=deleting(f);mutate(f);const before=copy(f.state);assert.notEqual((await f.command(request)).status,'deleted');assert.equal(f.calls.persist,0);assert.deepEqual(copy(f.state),before);
 }
});

test('uncertain deletion and restoration retry same canonical receipt across bridge restarts without another delete or task copy',async()=>{
 let durable;const first=fixture({persist:context=>{durable=copy(context.state);throw Error('lost ACK');}}),request=deleting(first);
 assert.equal((await first.command(request)).reason,'storage_failed');assert.equal(first.calls.events.length,0);assert.equal(durable.trash.length,1);
 const second=fixture({state:durable});assert.equal((await second.command(request)).status,'deleted');assert.equal(second.state.trash.length,1);
 const third=fixture({state:copy(second.state),persist:context=>{durable=copy(context.state);return false;}});
 assert.equal((await third.command(undoing())).reason,'storage_failed');assert.equal(third.calls.events.length,0);
 const fourth=fixture({state:durable});assert.equal((await fourth.command(undoing())).status,'restored');assert.equal(fourth.state.tasks.filter(row=>row.id==='task-one').length,1);
 fourth.state.tasks[0].title='newer manual edit';assert.equal((await fourth.command(undoing())).reason,'changed');assert.equal(fourth.state.tasks[0].title,'newer manual edit');
 assert.equal((await fourth.command(request)).reason,'changed');assert.equal(fourth.state.tasks.length,1);
});

test('undo never overwrites an ID collision or resurrects purged/private canonical trash',async()=>{
 for(const mutate of [f=>f.state.tasks.push(task({title:'new current task'})),f=>f.state.trash=[],f=>f.state.trash[0].data.tasks[0].private=true,f=>f.state.projects[0].archived=true]){
  const f=fixture();await f.command(deleting(f));mutate(f);const before=copy(f.state);assert.notEqual((await f.command(undoing())).status,'restored');assert.deepEqual(copy(f.state),before);
 }
});

test('delete in flight serializes task actions and does not confirm on late mutation, privacy, or replaced owner',async()=>{
 const gate=deferred(),started=deferred(),f=fixture({persist:()=>{started.resolve();return gate.promise;}}),request=deleting(f),version=request.expectedVersion;
 const first=f.command(request);assert.equal(f.command(request),first);await started.promise;
 assert.equal((await f.command({action:'set-task-completed',id:'task-one',completed:true,expectedVersion:version})).reason,'busy');
 f.state.trash[0].data.tasks[0].title='sync changed retained task';gate.resolve(true);assert.equal((await first).reason,'changed');assert.equal(f.calls.events.length,0);
 for(const mutate of [context=>context.PrivateMode.isOn=()=>true,context=>context.state=copy(context.state)]){
  const f=fixture({persist:context=>{mutate(context);return true;}});assert.notEqual((await f.command(deleting(f))).status,'deleted');assert.equal(f.calls.events.length,0);
 }
});

test('deletion ACK refreshes only current task surfaces and never private/dirty or unrelated project boards',async()=>{
 for(const mode of ['daily','wrong-project','dirty','private-owner']){
  const f=fixture(),ui=installTaskRefresh(f);if(mode==='daily'){f.context.document.body.dataset.view='daily';f.state.ui.spaceTabs={daily:'tasks'};f.state.tasks[0].workspace='日常';f.state.tasks[0].projectId=null;}
  if(mode==='wrong-project'){f.state.currentProjectId='other';ui.panel.dataset.projectId='other';}
  if(mode==='dirty')f.context.NoteEditor.isDirty=()=>true;
  if(mode==='private-owner'){const persist=f.context.saveDocumentDurably;f.context.saveDocumentDurably=async()=>{const saved=await persist();f.state.projects[0].private=true;return saved;};}
  const result=await f.command(deleting(f));if(mode==='private-owner')assert.equal(result.reason,'private');else assert.equal(result.status,'deleted');
  assert.equal(f.calls.widgets.length,mode==='daily'?1:0);assert.equal(f.calls.board.length,0);
 }
});


test('notification projection exposes normalized terminal status only after a finished final message', () => {
  const f = fixture();
  const current = f.state.agentRuns[0];
  const message = { role: 'agent', runId: current.id, text: '合成阅读结果已整理。', live: true };
  f.state.conversations[0].messages = [message];
  Object.assign(current, { status: 'completed', finishedAt: 2000000000000 });
  let row = f.snapshot().runs[0];
  assert.equal(row.status, 'completed'); assert.equal(row.finishedAt, 2000000000000);
  assert.equal(row.notificationReady, false, 'Live output is not a completed notification');
  message.live = false;
  assert.equal(f.snapshot().runs[0].notificationReady, true);
  current.approvalReceipt = { savePending: true };
  row = f.snapshot().runs[0]; assert.equal(row.status, 'awaiting-save'); assert.equal(row.notificationReady, false);
  delete current.approvalReceipt;
  message.text = '<｜DSML｜calls>\n<｜DSML｜invoke name="read_page">\n</｜DSML｜invoke>\n</｜DSML｜calls>';
  row = f.snapshot().runs[0]; assert.equal(row.status, 'failed'); assert.equal(row.notificationReady, true);
  assert.doesNotMatch(JSON.stringify(row), /DSML|read_page/);
  for (const status of ['failed', 'cancelled', 'interrupted', 'rejected']) {
    current.status = status;
    row = f.snapshot().runs[0]; assert.equal(row.status, status); assert.equal(row.notificationReady, true);
  }
  current.executionReceipt = { version: 1, phase: 'applied' }; current.status = 'completed';
  row = f.snapshot().runs[0]; assert.equal(row.status, 'awaiting-save'); assert.equal(row.notificationReady, false);
  delete current.executionReceipt;
  current.finishedAt = NaN;
  assert.equal(f.snapshot().runs[0].notificationReady, false, 'Missing completion identity cannot notify');
  current.finishedAt = 2000000000000; f.state.conversations[0].messages = [];
  assert.equal(f.snapshot().runs[0].notificationReady, false, 'A flag without a final message is not enough');
});
