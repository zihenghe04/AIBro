const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Collection = require('../collection-ui.js');

const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
function extractFunction(name, context) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1);
  const end = source.indexOf('\nfunction ', start + 1);
  return vm.runInNewContext(`${source.slice(start, end)}; ${name}`, context);
}
const workspaceName = value => value === '课程' || value === '科研' ? value : '日常';
const projects = [
  { id: 'visa', workspace: '日常' },
  { id: 'course', workspace: '课程' },
  { id: 'research', workspace: '科研' },
  { id: 'archived', workspace: '日常', archived: true },
  { id: 'deleted', workspace: '科研', deletedAt: 123 }
];
const fixtures = [
  { id: 'visa-stale-space', projectId: 'visa', workspace: '科研' },
  { id: 'course-stale-space', projectId: 'course', workspace: '科研' },
  { id: 'research-stale-space', projectId: 'research', workspace: '日常' },
  { id: 'unassigned-research', workspace: '科研' },
  { id: 'missing-project-research', projectId: 'missing', workspace: '科研' },
  { id: 'unassigned-daily', workspace: '日常' },
  { id: 'archived-project', projectId: 'archived', workspace: '科研' },
  { id: 'deleted-project', projectId: 'deleted', workspace: '科研' },
  { id: 'archived-record', workspace: '科研', archived: true },
  { id: 'deleted-record', workspace: '科研', deletedAt: 123 }
];
const researchIds = ['research-stale-space', 'unassigned-research', 'missing-project-research'];

test('workspace task totals and collections agree on project ownership, archives and orphaned tasks', () => {
  const state = { projects, tasks: fixtures };
  const recordMatchesSpace = extractFunction('recordMatchesSpace', { state, workspaceName });
  const taskMatchesSpace = extractFunction('taskMatchesSpace', { state, recordMatchesSpace });
  Collection.init({ getState: () => state });
  const before = JSON.stringify(state);
  for (const space of ['日常', '课程', '科研']) {
    const overviewIds = state.tasks.filter(task => taskMatchesSpace(task, space)).map(task => task.id);
    const collectionIds = Collection._private.records({ workspace: space }).map(task => task.id);
    assert.deepEqual(overviewIds, collectionIds, `${space} totals must use the same scope as all content`);
    if (space === '科研') assert.deepEqual(overviewIds, researchIds);
  }
  assert.equal(JSON.stringify(state), before, 'view filtering must not reclassify stored records');
});

test('research literature rows, count and network use research project scope before review filtering', () => {
  const state = { projects, ui: { paperFilter: 'reviewed' }, papers: fixtures.map(item => ({
    ...item, title: item.id, authors: [], tags: [], reviewed: item.id === 'unassigned-research'
  })) };
  const box = { innerHTML: '', classList: { remove() {} } };
  const count = { textContent: '' };
  let networkIds;
  const recordMatchesSpace = extractFunction('recordMatchesSpace', { state, workspaceName });
  const render = extractFunction('renderResearchLibrary', {
    state, recordMatchesSpace,
    $: selector => selector === '#researchLiterature' ? box : selector === '#literatureCount' ? count : null,
    uiIcon: () => '', esc: value => String(value ?? ''), Research: { sectionText: value => String(value || '') },
    renderPaperNetwork: papers => { networkIds = papers.map(paper => paper.id); }
  });
  render();
  assert.equal(count.textContent, '3 篇');
  assert.deepEqual(networkIds, researchIds);
  assert.match(box.innerHTML, /data-open-paper="unassigned-research"/);
  assert.doesNotMatch(box.innerHTML, /data-open-paper="(?:research-stale-space|missing-project-research|visa-stale-space|course-stale-space|archived-project|deleted-project|deleted-record)"/);
  state.ui.paperFilter = 'all';
  render();
  const renderedIds = [...box.innerHTML.matchAll(/data-open-paper="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(renderedIds, researchIds);
});
