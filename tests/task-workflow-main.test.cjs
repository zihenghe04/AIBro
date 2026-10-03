const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const Core = require('../app/workstation-core.js'), Plan = require('../app/plan-review.js');
const Planning = require('../app/planning-workbench.js'), Workflow = require('../app/task-workflow.js');
const TaskContext = require('../app/task-context.js'), AgentContext = require('../app/agent-context.js');
const root = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const appSource = fs.readFileSync(path.join(root, 'app/app.js'), 'utf8');
function state() {
  return { projects: [{ id: 'project', name: 'Synthetic project', workspace: '课程' }], tasks: [{ id: 'task', title: 'Synthetic task', workspace: '课程', projectId: 'project', status: 'todo', priority: 'high', description: 'Keep me', sourceTaskInbox: { category: 'P1', id: 'synthetic-inbox' } }], notes: [], imports: [], papers: [], attachments: [], links: [], trash: [], conversations: [{ id: 'chat', projectId: 'project', workspace: '课程' }], agentRuns: [], ui: { taskWorkflowNames: { P0: '阅读', P1: '研究', P2: '写作', P3: '生活' } } };
}
const context = { projectId: 'project', workspace: '课程', conversationId: 'chat', allowedTaskIds: ['task'], now: 10, uid: () => 'new-task' };
const update = patch => [{ type: 'update_task', taskId: 'task', patch }];
function review(f, actions) {
  f.agentRuns = [{ id: 'run', status: 'awaiting-approval', ...context, pendingActions: clone(actions) }];
  return Plan.createController({ getState: () => f, getRun: () => f.agentRuns[0], contextForRun: () => context, applyPlan: Core.applyPlan, save: async () => true });
}
test('Core creates each category and preserves ownership/priority; omitted, null and invalid values remain distinct', () => {
  const f = state(), original = clone(f);
  for (const value of Workflow.keys.concat(null)) {
    const result = Core.applyPlan(f, [{ type: 'create_task', title: 'New task', priority: 'low', workflowCategory: value }], context).state.tasks.at(-1);
    assert.equal(result.workflowCategory, value); assert.equal(result.projectId, 'project'); assert.equal(result.workspace, '课程'); assert.equal(result.priority, 'low');
  }
  const omitted = Core.applyPlan(f, [{ type: 'create_task', title: 'New task' }], context).state.tasks.at(-1);
  assert.equal(Object.hasOwn(omitted, 'workflowCategory'), false);
  for (const value of ['', 'P4', 'high', {}, 0, undefined]) assert.throws(() => Core.applyPlan(f, [{ type: 'create_task', title: 'New task', workflowCategory: value }], context), /分类无效/);
  assert.deepEqual(f, original);
});
test('Core update retains omitted metadata, clears legacy fallback with explicit null and rejects out-of-scope changes', () => {
  const f = state(), original = clone(f);
  const untouched = Core.applyPlan(f, update({ description: 'Changed description' }), context).state.tasks[0];
  assert.equal(Object.hasOwn(untouched, 'workflowCategory'), false); assert.equal(Workflow.category(untouched), 'P1');
  const changed = Core.applyPlan(f, update({ workflowCategory: 'P2' }), context).state.tasks[0];
  assert.equal(changed.workflowCategory, 'P2'); assert.equal(changed.priority, 'high'); assert.equal(changed.projectId, 'project'); assert.deepEqual(changed.sourceTaskInbox, original.tasks[0].sourceTaskInbox);
  const cleared = Core.applyPlan(f, update({ workflowCategory: null }), context).state.tasks[0];
  assert.equal(Object.hasOwn(cleared, 'workflowCategory'), true); assert.equal(Workflow.category(cleared), null);
  assert.throws(() => Core.applyPlan(f, update({ workflowCategory: 'P0' }), { ...context, allowedTaskIds: [] }), /允许更新范围/);
  assert.throws(() => Core.applyPlan(f, update({ workflowCategory: { category: 'P0' } }), context), /分类无效/);
  assert.deepEqual(f, original);
});
test('Planning create validates categories without converting omitted input or rewriting workspace', () => {
  const f = state(), input = { title: 'New task', projectId: 'project', workspace: '日常', priority: 'low' };
  assert.equal(Object.hasOwn(Planning.planCreate(f, input, context), 'workflowCategory'), false);
  for (const value of ['P3', null]) { const result = Planning.planCreate(f, { ...input, workflowCategory: value }, context); assert.equal(result.workflowCategory, value); assert.equal(result.workspace, '课程'); assert.equal(result.priority, 'low'); }
  for (const value of ['', 'P4', undefined]) assert.throws(() => Planning.planCreate(f, { ...input, workflowCategory: value }, context), /分类无效/);
});
test('main task editor reads real field selection, keeps legacy omission and lets users explicitly clear', () => {
  const f = state(), fields = new Map([['#taskWorkspaceInput', { value: '课程' }], ['#taskProjectInput', { value: 'project' }], ['#taskWorkflowInput', { value: 'P1' }]]);
  Planning.init({ getState: () => f, document: { querySelector: selector => fields.get(selector) || null } });
  assert.equal(Object.hasOwn(Planning.readTaskEditor(f.tasks[0]), 'workflowCategory'), false);
  fields.get('#taskWorkflowInput').value = ''; assert.equal(Planning.readTaskEditor(f.tasks[0]).workflowCategory, null);
  fields.get('#taskWorkflowInput').value = 'P3'; assert.equal(Planning.readTaskEditor(f.tasks[0]).workflowCategory, 'P3');
  fields.get('#taskWorkflowInput').value = 'P9'; assert.throws(() => Planning.readTaskEditor(f.tasks[0]), /分类无效/);
  fields.delete('#taskWorkflowInput'); assert.equal(Object.hasOwn(Planning.readTaskEditor(f.tasks[0]), 'workflowCategory'), false);
  f.tasks[0].private = true; assert.throws(() => Planning.readTaskEditor(f.tasks[0]), /不可用/);
});
test('category-only review keeps a real action, uses local labels, supports per-field rejection and clear after save/reload', async () => {
  const f = state(), api = review(f, update({ workflowCategory: 'P2' })), row = api.draft('run').rows[0];
  assert.equal(api.draft('run').validation.ok, true); assert.deepEqual(api.actions('run'), update({ workflowCategory: 'P2' }));
  const field = api.fieldReview('run').reviews.get(row.key).fields[0]; assert.equal(field.before, 'P1'); assert.equal(field.after, 'P2');
  const changes = Plan.describe(row.action, f, context, [row.action]).changes; assert.deepEqual(changes, [{ label: '任务分类', before: '研究', after: '写作' }]);
  const options = Plan.fieldsFor(row.action, f, context, [row.action]).find(x => x.key === 'patch.workflowCategory').options;
  assert.equal(options[0].label, '未分类'); assert.equal(options.find(x => x.value === 'P2').label, '写作');
  api.decideField('run', row.key, 'patch.workflowCategory', false); assert.deepEqual(api.actions('run'), []);
  api.decideField('run', row.key, 'patch.workflowCategory', true);
  api.edit('run', row.key, 'patch.workflowCategory', ''); assert.deepEqual(api.actions('run'), update({ workflowCategory: null }));
  await api.save('run'); api.forget('run'); const token = api.capture('run');
  assert.deepEqual(token.actions, update({ workflowCategory: null }));
  const result = Core.applyPlan(f, api.assertCurrent(token), context).state.tasks[0]; assert.equal(Workflow.category(result), null); assert.equal(result.priority, 'high');
  assert.equal(Workflow.category(f.tasks[0]), 'P1');
});
test('review inherits legacy category, edits creation and rejects invalid options or a concurrently changed task', () => {
  const f = state(), actions = update({ title: 'Renamed' });
  const inherited = Plan.fieldsFor(actions[0], f, context, actions).find(x => x.key === 'patch.workflowCategory'); assert.equal(inherited.value, 'P1'); assert.equal(inherited.inherited, true);
  const api = review(f, [{ type: 'create_task', title: 'New task' }]), row = api.draft('run').rows[0];
  api.edit('run', row.key, 'workflowCategory', 'P3'); assert.equal(api.actions('run')[0].workflowCategory, 'P3');
  api.edit('run', row.key, 'workflowCategory', ''); assert.equal(api.actions('run')[0].workflowCategory, null);
  assert.throws(() => api.edit('run', row.key, 'workflowCategory', 'P9'), /Invalid selection/);
  const updateApi = review(f, update({ workflowCategory: 'P0' })), token = updateApi.capture('run'); f.tasks[0].workflowCategory = 'P2';
  assert.throws(() => updateApi.assertCurrent(token), { code: 'PLAN_TARGET_CHANGED' });
});
test('task_list and model capability deliver canonical category and the same renamed labels', () => {
  const f = state(), run = {}, catalog = TaskContext.readCatalog(f, f.conversations[0], { query: '' }, run);
  assert.equal(catalog.entries[0].workflowCategory, 'P1'); assert.equal(catalog.entries[0].priority, 'high');
  f.tasks[0].workflowCategory = null; assert.equal(TaskContext.readCatalog(f, f.conversations[0], { query: '' }, {}).entries[0].workflowCategory, null);
  const instructionLine = appSource.split('\n').find(line => line.includes("instruction += '\\n任务工作流分类："));
  const sandbox = { instruction: '', window: { TaskWorkflow: Workflow }, state: f }; vm.runInNewContext(instructionLine, sandbox);
  const actionsSchema = appSource.match(/create_task\(title,description,[^)]+\)/)[0] + '\n' + appSource.match(/update_task\(taskId,patch:\{[^}]+\}\)/)[0];
  const text = AgentContext.create({ fullInstruction: '你是助手。' + actionsSchema + sandbox.instruction }).capability('tasks').instructions;
  assert.match(text, /workflowCategory/); assert.match(text, /P0\/P1\/P2\/P3 或 null/); assert.ok(text.includes(JSON.stringify(Workflow.names(f)))); assert.match(text, /未传保留已有分类/);
  assert.match(actionsSchema, /priority,workflowCategory,startAt/); assert.match(actionsSchema, /priority\?,workflowCategory\?,startAt/);
});
test('main editor baseline detects external category changes including explicit clear versus missing', () => {
  const start = appSource.indexOf('function taskEditorVersion(task) {'), end = appSource.indexOf('\nfunction taskFormContent', start);
  const sandbox = { window: { TaskWorkflow: Workflow } }; vm.runInNewContext(appSource.slice(start, end), sandbox);
  const task = state().tasks[0], version = sandbox.taskEditorVersion;
  assert.notEqual(version(task), version({ ...task, workflowCategory: null })); assert.notEqual(version(task), version({ ...task, workflowCategory: 'P2' }));
  const plain = { ...task }; delete plain.sourceTaskInbox; assert.notEqual(version(plain), version({ ...plain, workflowCategory: null }));
});
test('browser script load order resolves workflow lazily after Core and PlanReview boot', () => {
  const c = { console }; c.window = c; c.globalThis = c; vm.createContext(c);
  for (const name of ['task-dependencies', 'workstation-core', 'plan-review', 'task-context', 'task-workflow']) vm.runInContext(fs.readFileSync(path.join(root, 'app', name + '.js'), 'utf8'), c);
  const f = state(), action = { type: 'update_task', taskId: 'task', patch: { workflowCategory: 'P2' } };
  assert.equal(c.WorkstationCore.applyPlan(f, [action], context).state.tasks[0].workflowCategory, 'P2');
  assert.equal(c.PlanReview.fieldsFor(action, f, context, [action]).find(x => x.key === 'patch.workflowCategory').options[1].label, '阅读');
});
test('main creation mount reads local category names and waits for a durable save of selected category', async () => {
  const f = state(), nodes = new Map(); let props, saveCount = 0, resolve;
  const pending = new Promise(done => { resolve = done; });
  const document = {
    querySelector: key => nodes.get(key) || null, body: { append(node) { nodes.set('#' + node.id, node); } },
    createElement: () => ({ open: false, setAttribute() {}, set innerHTML(html) { nodes.set('#planningCreateSurface', { id: 'planningCreateSurface' }); }, showModal() { this.open = true; }, close() { this.open = false; this.onclose?.(); }, remove() { this.close(); } })
  };
  Planning.init({ getState: () => f, document, uid: () => 'new-task', save: async () => { saveCount++; return pending; }, mount: (host, component, values) => { assert.equal(component, 'TaskCreateForm'); props = values; return { update: patch => Object.assign(props, patch), unmount() {} }; } });
  assert.equal(Planning.createTask({ projectId: 'project' }), true);
  assert.deepEqual(props.workflowOptions, Workflow.keys.map(value => ({ value, label: Workflow.names(f)[value] })));
  const submission = props.onSubmit({ ...props.initial, title: 'New task', workflowCategory: 'P3' });
  assert.equal(props.busy, true); assert.equal(props.onCancel(), false); assert.equal(saveCount, 1);
  resolve(true); assert.equal(await submission, true);
  const created = f.tasks.find(task => task.id === 'new-task'); assert.equal(created.workflowCategory, 'P3'); assert.equal(created.projectId, 'project'); assert.equal(created.workspace, '课程'); assert.equal(created.priority, 'medium');
  Planning.init({});
});
test('real JSX surfaces compile and render named category choices with selected null/key and busy state', () => {
  const esbuild = require('esbuild'), React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
  const choices = Workflow.keys.map(value => ({ value, label: Workflow.names(state())[value] }));
  const document = { getElementById: () => ({}), documentElement: { lang: 'zh-CN' }, createElement: () => ({}), head: { appendChild() {}, append() {} } };
  for (const [file, component, id] of [['task-create', 'TaskCreateForm', 'planningTaskWorkflow'], ['task-detail', 'TaskDetailSurface', 'taskWorkflowInput']]) {
    const built = esbuild.buildSync({ entryPoints: [path.join(root, 'app/ui/' + file + '.jsx')], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'react-dom'], loader: { '.css': 'text' } });
    const module = { exports: {} }; vm.runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, require, document, console, React });
    for (const value of ['', 'P2']) for (const busy of [false, true]) {
      const props = { taskId: 'task', workflowOptions: choices, busy, initial: component === 'TaskCreateForm' ? { workflowCategory: value } : { fields: { taskWorkflowInput: value, taskStatusInput: 'todo', taskPriorityInput: 'high', taskReminderInput: 'inherit', taskWorkspaceInput: '课程' } } };
      const html = renderToStaticMarkup(React.createElement(module.exports[component], props));
      const select = html.match(new RegExp('<select[^>]+id="' + id + '"[^>]*>[\\s\\S]*?</select>'))?.[0];
      assert.ok(select); assert.ok(select.includes('aria-label="任务分类"'));
      assert.ok(select.includes('value="' + value + '" selected=""')); assert.equal(select.startsWith('<select') && / disabled=""/.test(select.split('>')[0]), busy);
      for (const option of choices) assert.ok(select.includes(option.label)); assert.ok(select.includes('未分类'));
      assert.ok(html.includes('分类独立于空间、项目和优先级'));
    }
  }
  // Parse the production review component as well; no generated UI asset is written.
  esbuild.buildSync({ entryPoints: [path.join(root, 'app/ui/plan-review-surfaces.jsx')], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'react-dom'], loader: { '.css': 'text' } });
});
test('real review surface has one explicit Uncategorized option, preserves custom labels, and renders clear proposal', () => {
  const esbuild = require('esbuild'), React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
  const built = esbuild.buildSync({ entryPoints: [path.join(root, 'app/ui/plan-review-surfaces.jsx')], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'react-dom'], loader: { '.css': 'text' } });
  const document = { getElementById: () => ({}), documentElement: { lang: 'en' }, createElement: () => ({}), head: { appendChild() {}, append() {} } };
  const module = { exports: {} }; vm.runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, require, document, console, React });
  const f = state(); f.ui.taskWorkflowNames.P0 = 'high'; const api = review(f, update({ workflowCategory: null })), draft = api.draft('run'), action = draft.rows[0].action;
  const row = { ...draft.rows[0], ...Plan.describe(action, f, context, [action]), fields: Plan.fieldsFor(action, f, context, [action]), fieldReview: api.fieldReview('run').reviews.get(draft.rows[0].key) };
  const html = renderToStaticMarkup(React.createElement(module.exports.PlanReviewSurface, { runId: 'run', draft, rows: [row] }));
  const select = html.match(/<select[^>]+aria-label="任务分类"[^>]*>[\s\S]*?<\/select>/)?.[0];
  assert.ok(select); assert.equal((select.match(/<option value=""/g) || []).length, 1); assert.match(select, /value="" selected="">未分类/); assert.doesNotMatch(select, /Unspecified/);
  assert.match(select, /value="P0">high<\/option>/); // User-defined names are not translated as built-in priority labels.
  assert.match(html, /class="plan-field-before"[^]*?>研究<\/span>/); assert.match(html, /class="plan-field-after"[^]*?>未分类<\/span>/);
});
