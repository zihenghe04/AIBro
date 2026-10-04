const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = path.resolve(__dirname, '../app');
const index = fs.readFileSync(path.join(app, 'index.html'), 'utf8');
const relevant = new Set(['research-library.js', 'artifact-provenance.js', 'research-wiki.js', 'context-retrieval.js', 'record-assignment.js', 'task-dependencies.js', 'project-lifecycle.js', 'workstation-core.js']);
// Read the actual desktop page, not a hand-authored dependency sequence or
// CommonJS exports. WKWebView runs these scripts through their browser UMD path.
const scripts = [...index.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map(match => match[1]).filter(file => relevant.has(file));
function browser() {
  const context = { URL }; context.window = context;
  return vm.createContext(context);
}
function load(context, files) {
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(app, file), 'utf8'), context, { filename: file });
}
function state() {
  return {
    projects: [{ id: 'demo-project', name: '删除演示', workspace: '课程' }],
    conversations: [{ id: 'receipt', projectId: 'demo-project', workspace: '课程', messages: [{ role: 'user', text: '删除演示项目' }], attachments: [] }],
    agentRuns: [{ id: 'run', conversationId: 'receipt', projectId: 'demo-project', status: 'running' }],
    tasks: [{ id: 'owned-task', projectId: 'demo-project', title: '项目任务' }], notes: [], papers: [], imports: [], attachments: [], links: [], trash: [],
    currentProjectId: 'demo-project', currentConversationId: 'receipt'
  };
}
function deleteThroughBrowser(context, original) {
  const core = context.WorkstationCore;
  const snapshots = core.projectSnapshots(original, { projectIds: ['demo-project'] });
  return core.applyPlan(original, [{ type: 'delete_project', projectId: 'demo-project' }], { projectSnapshots: snapshots, conversationId: 'receipt', runId: 'run', now: 100, uid: prefix => `${prefix}-100` });
}

test('actual desktop HTML loads ProjectLifecycle before Core and browser UMD deletion completes with an inspectable receipt', () => {
  assert.equal(scripts.length, relevant.size, 'Every real browser dependency must be present exactly once');
  assert.ok(scripts.indexOf('project-lifecycle.js') < scripts.indexOf('workstation-core.js'), 'The native page loads the lifecycle dependency before its consumer');
  const manifest = JSON.parse(fs.readFileSync(path.join(app, 'asset-manifest.json'), 'utf8'));
  assert.ok(manifest.web.includes('project-lifecycle.js'), 'Native packaging must include the loaded resource');
  const context = browser(); load(context, scripts);
  assert.equal(typeof context.module, 'undefined'); assert.equal(typeof context.require, 'undefined', 'CommonJS must not conceal browser loader bugs');
  assert.equal(context.WorkstationCore.actionLabels.delete_project, '项目移入回收站');
  const original = state(), serialized = JSON.stringify(original), outcome = deleteThroughBrowser(context, original);
  assert.equal(JSON.stringify(original), serialized, 'Browser dry-run leaves live state unchanged');
  assert.equal(outcome.state.projects.length, 0); assert.equal(outcome.state.tasks.length, 0);
  assert.equal(outcome.state.trash[0].data.projects[0].id, 'demo-project');
  assert.equal(outcome.state.conversations[0].id, 'receipt'); assert.equal(outcome.state.conversations[0].projectId, null);
  assert.equal(outcome.state.agentRuns[0].id, 'run'); assert.equal(outcome.results[0].operation, 'deleted');
});

test('an older browser shell loading Core first can resolve a later lifecycle module instead of retaining undefined forever', () => {
  const context = browser(); load(context, scripts.filter(file => file !== 'project-lifecycle.js'));
  const original = state(), before = JSON.stringify(original);
  assert.equal(typeof context.ProjectLifecycle, 'undefined');
  assert.throws(() => context.WorkstationCore.projectSnapshots(original, { projectIds: ['demo-project'] }), /项目管理模块尚未加载/);
  assert.throws(() => context.WorkstationCore.applyPlan(original, [{ type: 'delete_project', projectId: 'demo-project' }], {}), /项目管理模块尚未加载/);
  assert.equal(JSON.stringify(original), before, 'An absent module fails before mutation');
  load(context, ['project-lifecycle.js']);
  const outcome = deleteThroughBrowser(context, original);
  assert.equal(outcome.state.projects.length, 0); assert.equal(outcome.state.trash.length, 1);
  assert.equal(outcome.results[0].operation, 'deleted');
});
