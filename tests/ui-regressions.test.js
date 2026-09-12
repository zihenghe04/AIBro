const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
function extractFunction(name, dependencies = '') {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} should remain available in app.js`);
  const next = source.indexOf('\nfunction ', start + 1);
  const body = source.slice(start, next === -1 ? source.length : next);
  return vm.runInNewContext(`(() => { ${dependencies}; ${body}; return ${name}; })()`);
}

const workspaceDependencies = 'const workspaceName = value => value === "课程" || value === "科研" ? value : "日常"';
const recordMatchesSpace = extractFunction('recordMatchesSpace', workspaceDependencies);
const taskMatchesSpace = extractFunction('taskMatchesSpace', `${workspaceDependencies}; const recordMatchesSpace = ${recordMatchesSpace.toString()}`);
const dedupeResultEntries = extractFunction('dedupeResultEntries');

const researchProjects = [{ id: 'p-research', workspace: '科研', archived: false }];
assert.equal(taskMatchesSpace({ id: 't-unassigned', workspace: '科研', projectId: null }, '科研', researchProjects), true, 'unassigned research tasks stay visible');
assert.equal(taskMatchesSpace({ id: 't-stale', workspace: '科研', projectId: 'deleted-project' }, '科研', researchProjects), true, 'tasks with stale project references stay visible as unassigned');
assert.equal(taskMatchesSpace({ id: 't-daily', workspace: '日常', projectId: null }, '科研', researchProjects), false, 'tasks from another workspace stay hidden');

const merged = dedupeResultEntries([
  { type: 'import', id: 'a-paper', text: '重命名资料：研究 · paper.pdf' },
  { type: 'import', id: 'a-paper', text: '归档资料：研究 · paper.pdf' },
  { type: 'task', id: 't-1', text: '创建任务：阅读论文' }
]);
assert.equal(merged.filter(result => result.type === 'import' && result.id === 'a-paper').length, 1, 'rename and assign actions render one attachment result');
assert.match(merged[0].text, /重命名资料/);
assert.match(merged[0].text, /归档资料/);
assert.equal(merged.length, 2, 'unrelated result entities remain visible');

console.log('ui regression tests passed');
