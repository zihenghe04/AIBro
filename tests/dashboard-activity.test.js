const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const start = source.indexOf('const projectIsActive =');
const end = source.indexOf('const currentAttachments =', start);
assert.ok(start >= 0 && end > start, 'Extract actual dashboard visibility predicates');
const predicates = source.slice(start, end);
function harness() {
  const state = {
    projects: [{ id: 'origin', workspace: '科研' }, { id: 'target', workspace: '日常' }],
    conversations: [{ id: 'conversation', projectId: 'origin' }],
    agentRuns: [{ id: 'run', conversationId: 'conversation', projectId: 'target' }]
  };
  const context = vm.createContext({ state });
  vm.runInContext(`${predicates}\nglobalThis.isVisibleRun = visibleRun;`, context);
  return { state, run: state.agentRuns[0], visible: context.isVisibleRun };
}

test('dashboard activity hides archived or deleted conversations while preserving execution history records', () => {
  const { state, run, visible } = harness();
  assert.equal(visible(run), true);
  state.conversations[0].archived = true;
  assert.equal(visible(run), false);
  state.conversations[0].archived = false;
  assert.equal(visible(run), true);
  state.conversations[0].deletedAt = 1;
  assert.equal(visible(run), false);
  state.conversations = [];
  assert.equal(visible(run), false);
  assert.equal(state.agentRuns.length, 1, 'A dashboard filter must not mutate execution history');
  assert.equal(state.agentRuns[0], run);
});

test('both a run project and its conversation project must be active even when they differ', () => {
  for (const projectId of ['origin', 'target']) {
    const { state, run, visible } = harness();
    const project = state.projects.find(item => item.id === projectId);
    project.archived = true;
    assert.equal(visible(run), false, `Archived ${projectId} must hide the run`);
    project.archived = false;
    project.deletedAt = 1;
    assert.equal(visible(run), false, `Deleted ${projectId} must hide the run`);
    delete project.deletedAt;
    assert.equal(visible(run), true);
    state.projects = state.projects.filter(item => item.id !== projectId);
    assert.equal(visible(run), false, `Missing ${projectId} must hide the run`);
  }
});

test('unassigned active conversations remain actionable, while missing destinations and archived runs stay out of homepage', () => {
  const { state, run, visible } = harness();
  run.projectId = null; state.conversations[0].projectId = null;
  assert.equal(visible(run), true);
  run.archived = true; assert.equal(visible(run), false);
  run.archived = false; run.deletedAt = 1; assert.equal(visible(run), false);
  delete run.deletedAt;
  for (const destination of [null, '', undefined, 'missing-conversation']) {
    run.conversationId = destination;
    assert.equal(visible(run), false, 'Every homepage activity row must have a valid conversation destination');
  }
  assert.equal(visible(null), false);
});

test('recent activity renders only the current visibility selection, without rewriting the original run list', () => {
  const { state } = harness();
  state.agentRuns.push({ id: 'historical', conversationId: 'archived-conversation', goal: 'ARCHIVED_ACTIVITY' });
  state.conversations.push({ id: 'archived-conversation', archived: true });
  state.agentRuns[0].goal = 'ACTIVE_ACTIVITY';
  state.agentRuns[0].startedAt = 1;
  const dashboardStart = source.indexOf('function renderDashboard(');
  const activityStart = source.indexOf("  const activity = $('#dashboardActivity');", dashboardStart);
  const activityEnd = source.indexOf("\n  renderWorkspaceWidgets('dashboard');", activityStart);
  assert.ok(dashboardStart >= 0 && activityStart > dashboardStart && activityEnd > activityStart);
  const container = { innerHTML: '', classList: { toggle() {} } };
  const context = vm.createContext({ state, $: () => container, esc: String, Core: {} });
  vm.runInContext(`${predicates}\n${source.slice(activityStart, activityEnd)}`, context);
  assert.match(container.innerHTML, /ACTIVE_ACTIVITY/);
  assert.doesNotMatch(container.innerHTML, /ARCHIVED_ACTIVITY/);
  assert.equal(state.agentRuns.length, 2);
});
