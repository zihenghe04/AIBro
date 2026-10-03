const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const begin = source.indexOf('function commandSearchController()');
const end = source.indexOf('\nfunction searchEntities(', begin);
assert.ok(begin >= 0 && end > begin, 'Exercise the actual host command registration');

function harness() {
  let release, hooks;
  const opened = [];
  const gate = new Promise(resolve => { release = resolve; });
  const context = {
    state: { currentProjectId: 'project-a', projects: [
      { id: 'project-a', name: 'Original project', workspace: '科研' },
      { id: 'project-b', name: 'Different project', workspace: '科研' },
    ] },
    window: { CommandSearch: { init: value => { hooks = value; return value; } } },
    storageHydrated: true, serverConflict: false,
    searchTypeLabel: {}, searchTypeIcon: {}, uiIcon: () => '',
    openSearchResult() {}, renderSearchResults() {},
    visibleProject: project => !project.archived,
    beforePreviewLeave: () => gate,
    openProject: id => { opened.push(id); },
    sendMessage() {},
  };
  vm.createContext(context);
  const globalOpen = source.indexOf('async function openGlobalSearchResult(');
  const localOpen = source.indexOf('\nasync function openSearchResult(', globalOpen);
  assert.ok(globalOpen >= 0 && localOpen > globalOpen);
  vm.runInContext(source.slice(globalOpen, localOpen), context);
  vm.runInContext(source.slice(begin, end), context);
  vm.runInContext('commandSearchController()', context);
  return { context, opened, release, command: hooks.commands.find(command => command.id === 'current-project') };
}

test('the project command opens its selected target after the editor durably permits leaving', async () => {
  const h = harness();
  assert.equal(h.command.description(), 'Original project');
  assert.equal(h.command.isEnabled(), true);
  const pending = h.command.execute();
  await Promise.resolve();
  assert.deepEqual(h.opened, []);
  h.release(true);
  assert.notEqual(await pending, false);
  assert.deepEqual(h.opened, ['project-a']);
});

test('cancelling a dirty editor keeps the current page and reports no completed command', async () => {
  const h = harness();
  const pending = h.command.execute();
  h.release(false);
  assert.equal(await pending, false);
  assert.deepEqual(h.opened, []);
});

test('changing current project during the editor wait cannot retarget the already selected command', async () => {
  const h = harness();
  const pending = h.command.execute();
  h.context.state.currentProjectId = 'project-b';
  h.release(true);
  assert.notEqual(await pending, false);
  assert.deepEqual(h.opened, ['project-a']);
});

test('archiving the target during an editor wait reports its unavailability without a JavaScript type error', async () => {
  const h = harness();
  const pending = h.command.execute();
  const rejected = assert.rejects(pending, /项目.*(?:不可用|归档|不存在|删除)|(?:不可用|归档|删除).*项目/);
  h.context.state.projects[0].archived = true;
  h.release(true);
  await rejected;
  assert.deepEqual(h.opened, []);
});

test('a save conflict that appears during the editor wait prevents a navigation success', async () => {
  const h = harness();
  const pending = h.command.execute();
  const rejected = assert.rejects(pending, /保存冲突|同步冲突/);
  h.context.serverConflict = true;
  h.release(true);
  await rejected;
  assert.deepEqual(h.opened, []);
});
