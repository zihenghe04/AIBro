const test = require('node:test');
const assert = require('node:assert/strict');
const Collection = require('../collection-ui.js');
const { records, filteredItems, completeSelected, timestamp } = Collection._private;

const ui = overrides => ({ query: '', type: 'all', sort: 'updated', dir: 'desc', ...overrides });
function useState(state, hooks = {}) { Collection.init({ getState: () => state, deleteItems: undefined, save: () => true, toast: () => {}, renderAll: () => {}, ...hooks }); return state; }

// A small DOM contract double tests event lifetime and IME behavior without
// requiring a browser or an additional runtime dependency.
class Container {
  constructor() { this.dataset = {}; this.listeners = {}; this.renders = 0; this.html = ''; }
  set innerHTML(html) {
    this.html = html; this.renders += 1;
    this.search = { value: /data-cui-search value="([^"]*)"/.exec(html)?.[1] || '', selectionStart: 0, selectionEnd: 0,
      matches: selector => selector === '[data-cui-search]', focus: () => { this.focused = true; },
      setSelectionRange: (start, end) => { this.selection = [start, end]; } };
    this.all = {};
  }
  get innerHTML() { return this.html; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  querySelector(selector) { return selector === '[data-cui-search]' ? this.search : selector === '[data-cui-all]' && this.html.includes('data-cui-all') ? this.all : null; }
  event(type, target, extras = {}) { return this.listeners[type]?.({ target, ...extras }); }
}

function openTarget(key) {
  const row = { dataset: { cuiKey: key } };
  const button = { closest: selector => selector === '[data-cui-key]' ? row : null };
  return { closest: selector => selector === '[data-cui-open]' ? button : null };
}

function selectionTarget(key, checked = true) {
  return { checked, matches: selector => selector === '[data-cui-check]', closest: () => ({ dataset: { cuiKey: key } }) };
}

const buttonTarget = selector => ({ closest: target => target === selector ? {} : null });
const deleteTarget = key => ({ closest: selector => selector === '[data-cui-delete]' ? {} : selector === '[data-cui-key]' ? { dataset: { cuiKey: key } } : null });

test('project collections exclude unassigned/other/archived records and use current project workspace', () => {
  useState({ projects: [{ id: 'a', name: '智能控制', workspace: '课程' }, { id: 'b', workspace: '科研' }, { id: 'old', workspace: '课程', archived: true }],
    tasks: [{ id: 'a-task', projectId: 'a', workspace: '日常' }, { id: 'b-task', projectId: 'b' }, { id: 'loose' }, { id: 'archived-task', projectId: 'a', archived: true }, { id: 'old-task', projectId: 'old' }], notes: [], imports: [] });
  assert.deepEqual(records({ workspace: '课程', projectId: 'a' }).map(item => item.id), ['a-task']);
  assert.deepEqual(records({ projectId: 'old' }), []);
  assert.deepEqual(records({ workspace: '科研' }).map(item => item.id), ['b-task']);
});

test('date sorting accepts ISO and numeric timestamps without inventing dates', () => {
  useState({ imports: [{ id: 'first', name: '第一份', updatedAt: '2026-09-10T12:00:00Z' }, { id: 'last', name: '第二份', updatedAt: Date.parse('2026-09-11T12:00:00Z') }, { id: 'missing', name: '无日期', updatedAt: 'invalid' }] });
  assert.deepEqual(filteredItems(records(), ui()).map(item => item.id), ['last', 'first', 'missing']);
  assert.equal(timestamp(''), 0);
  const container = new Container(); Collection.render(container);
  assert.match(container.innerHTML, /<time >—<\/time>/);
  assert.doesNotMatch(container.innerHTML, /Invalid Date/);
});

test('bulk completion respects entity type, project scope and existing completion dates', () => {
  const state = useState({ projects: [{ id: 'p' }, { id: 'q' }], tasks: [{ id: 'shared', projectId: 'p', status: 'todo' }, { id: 'new', projectId: 'p', status: 'todo' }, { id: 'other', projectId: 'q', status: 'todo' }, { id: 'done', projectId: 'p', status: 'done', completedAt: 10 }], notes: [{ id: 'shared', projectId: 'p' }] });
  const count = completeSelected(new Set(['note:shared', 'task:new', 'task:other', 'task:done']), { projectId: 'p' }, 1234);
  assert.equal(count, 1); assert.equal(state.tasks[0].status, 'todo');
  assert.deepEqual([state.tasks[1].status, state.tasks[1].completedAt, state.tasks[1].updatedAt], ['done', 1234, 1234]);
  assert.equal(state.tasks[2].status, 'todo'); assert.equal(state.tasks[3].completedAt, 10);
});

test('reusing a collection container routes clicks and selections to its current project', () => {
  const state = useState({ projects: [{ id: 'p' }, { id: 'q' }], tasks: [{ id: 'p1', projectId: 'p' }, { id: 'q1', projectId: 'q' }] }, { openTask: id => opened.push(id), save: () => {}, renderAll: () => {}, toast: () => {} });
  const opened = []; const container = new Container();
  Collection.render(container, { projectId: 'p' });
  container.event('change', selectionTarget('task:p1'));
  Collection.render(container, { projectId: 'q' });
  container.event('click', openTarget('task:q1'));
  assert.deepEqual(opened, ['q1']);
  assert.doesNotMatch(container.innerHTML, /已选择/);
  container.event('change', selectionTarget('task:q1'));
  container.event('click', buttonTarget('[data-cui-complete]'));
  assert.equal(state.tasks[1].status, 'done'); assert.equal(state.tasks[0].status, undefined);
});

test('Chinese IME composition survives background renders and search preserves cursor', () => {
  useState({ tasks: [{ id: 'one', title: '智能控制' }] });
  const container = new Container(); Collection.render(container, { workspace: '日常' });
  const original = container.search; original.value = 'zhi';
  container.event('compositionstart', original);
  container.event('input', original, { isComposing: true });
  Collection.render(container, { workspace: '日常' });
  assert.equal(container.search, original); assert.equal(container.renders, 1);
  original.value = '智能'; original.selectionStart = 2; original.selectionEnd = 2;
  container.event('compositionend', original);
  assert.equal(container.renders, 2); assert.equal(container.focused, true); assert.deepEqual(container.selection, [2, 2]);
  assert.match(container.innerHTML, /智能控制/);
});

test('select all uses the same trimmed tag search as rendered rows', () => {
  const state = useState({ tasks: [{ id: 'tagged', title: '复习', tags: ['智能控制'] }, { id: 'other', title: '别的' }] }, { save: () => {}, renderAll: () => {}, toast: () => {} });
  const container = new Container(); Collection.render(container);
  container.search.value = '  智能控制  '; container.event('input', container.search);
  assert.match(container.innerHTML, /data-cui-id="tagged"/); assert.doesNotMatch(container.innerHTML, /data-cui-id="other"/);
  container.event('change', { checked: true, matches: selector => selector === '[data-cui-all]' });
  container.event('click', buttonTarget('[data-cui-complete]'));
  assert.equal(state.tasks[0].status, 'done'); assert.equal(state.tasks[1].status, undefined);
});

test('single deletion sends exact typed ID and scope, without confusing same IDs across entity types', async () => {
  const calls = [], opened = []; const state = useState({ projects: [{ id: 'p', workspace: '科研' }], tasks: [{ id: 'shared', title: '任务', projectId: 'p' }], notes: [{ id: 'shared', title: '<img onerror="alert(1)">', projectId: 'p' }] }, {
    deleteItems: async (...args) => { calls.push(args); return false; }, openNote: id => opened.push(id)
  });
  const container = new Container(); Collection.render(container, { workspace: '科研', projectId: 'p' });
  const before = JSON.stringify(state); await container.event('click', deleteTarget('note:shared'));
  assert.deepEqual(calls, [[[ { type: 'note', id: 'shared' } ], { workspace: '科研', projectId: 'p' }]]);
  assert.equal(JSON.stringify(state), before); assert.deepEqual(opened, []);
  assert.match(container.innerHTML, /aria-label="移入回收站：&lt;img onerror=&quot;alert\(1\)&quot;&gt;"/);
  assert.doesNotMatch(container.innerHTML, /<img/);
});

test('mixed batch deletion preserves selection on cancel, clears it on success and delegates all changes to the host', async () => {
  const calls = []; let accept = false;
  const state = useState({ tasks: [{ id: 't' }], notes: [{ id: 'n' }], papers: [{ id: 'p' }], imports: [{ id: 'a' }] }, { deleteItems: async (...args) => { calls.push(args); return accept; } });
  const container = new Container(); Collection.render(container, { workspace: '日常' });
  container.event('change', { checked: true, matches: selector => selector === '[data-cui-all]' });
  const before = JSON.stringify(state); await container.event('click', buttonTarget('[data-cui-delete-selected]'));
  assert.match(container.innerHTML, /已选择 4 项/); assert.equal(JSON.stringify(state), before);
  assert.deepEqual(calls[0][0].map(item => `${item.type}:${item.id}`).sort(), ['import:a', 'note:n', 'paper:p', 'task:t']);
  accept = true; await container.event('click', buttonTarget('[data-cui-delete-selected]'));
  assert.doesNotMatch(container.innerHTML, /已选择/); assert.equal(calls.length, 2); assert.equal(JSON.stringify(state), before);
});

test('filter changes prune hidden selections and forged or stale row events cannot delete them', async () => {
  const calls = []; const state = useState({ tasks: [{ id: 't', title: '任务' }], notes: [{ id: 'n', title: '笔记' }] }, { deleteItems: async (...args) => { calls.push(args); return false; } });
  const container = new Container(); Collection.render(container);
  container.event('change', { checked: true, matches: selector => selector === '[data-cui-all]' });
  container.event('change', { value: 'note', matches: selector => selector === '[data-cui-type]' });
  assert.match(container.innerHTML, /已选择 1 项/);
  await container.event('click', deleteTarget('task:t')); assert.equal(calls.length, 0);
  await container.event('click', buttonTarget('[data-cui-delete-selected]')); assert.deepEqual(calls[0][0], [{ type: 'note', id: 'n' }]);
  state.notes = []; await container.event('click', deleteTarget('note:n')); assert.equal(calls.length, 1);
});

test('pending deletion is single flight and a late completion cannot clear a different project selection', async () => {
  let resolve; const calls = [];
  useState({ projects: [{ id: 'p' }, { id: 'q' }], tasks: [{ id: 'p1', projectId: 'p' }, { id: 'q1', projectId: 'q' }] }, { deleteItems: (...args) => { calls.push(args); return new Promise(done => { resolve = done; }); } });
  const container = new Container(); Collection.render(container, { projectId: 'p' }); container.event('change', selectionTarget('task:p1'));
  const deleting = container.event('click', buttonTarget('[data-cui-delete-selected]'));
  await container.event('click', buttonTarget('[data-cui-delete-selected]')); await container.event('click', deleteTarget('task:p1'));
  assert.equal(calls.length, 1); assert.match(container.innerHTML, /data-cui-delete-selected disabled/);
  Collection.render(container, { projectId: 'q' }); resolve(true); await deleting;
  assert.match(container.innerHTML, /data-cui-id="q1"/); assert.doesNotMatch(container.innerHTML, /data-cui-id="p1"/);
  container.event('change', selectionTarget('task:q1')); assert.match(container.innerHTML, /已选择 1 项/);
  assert.deepEqual(calls[0][1], { workspace: undefined, projectId: 'p' });
});

test('deletion rejection leaves selection available for retry and surfaces the failure', async () => {
  const messages = []; let count = 0;
  useState({ notes: [{ id: 'n' }] }, { deleteItems: async () => { count++; throw new Error('保存冲突'); }, toast: message => messages.push(message) });
  const container = new Container(); Collection.render(container); container.event('change', selectionTarget('note:n'));
  await container.event('click', buttonTarget('[data-cui-delete-selected]'));
  assert.match(container.innerHTML, /已选择 1 项/); assert.match(messages[0], /保存冲突/);
  await container.event('click', buttonTarget('[data-cui-delete-selected]')); assert.equal(count, 2);
});

test('completed-only selection exposes reopen action and preserves unrelated task metadata', async () => {
  let saves = 0; const state = useState({ tasks: [{ id: 't', status: 'done', completedAt: 40, dueAt: '2026-09-12T08:30:00+08:00', checklist: [{ text: '材料', done: true }] }] }, { save: () => { saves++; return true; } });
  const container = new Container(); Collection.render(container); container.event('change', selectionTarget('task:t'));
  assert.match(container.innerHTML, /标为未完成 · 1/); assert.doesNotMatch(container.innerHTML, /data-cui-complete/);
  await container.event('click', buttonTarget('[data-cui-reopen]'));
  assert.equal(state.tasks[0].status, 'todo'); assert.equal(state.tasks[0].completedAt, undefined); assert.equal(saves, 1);
  assert.equal(state.tasks[0].dueAt, '2026-09-12T08:30:00+08:00'); assert.equal(state.tasks[0].checklist[0].done, true);
  assert.doesNotMatch(container.innerHTML, /已选择/);
});

test('mixed completion states offer both meaningful actions; failed persistence restores status and keeps selection', async () => {
  const state = useState({ tasks: [{ id: 't', status: 'todo' }, { id: 'd', status: 'done', completedAt: 4 }] }, { save: () => false });
  const container = new Container(); Collection.render(container); container.event('change', { checked: true, matches: selector => selector === '[data-cui-all]' });
  assert.match(container.innerHTML, /标为完成 · 1/); assert.match(container.innerHTML, /标为未完成 · 1/);
  await container.event('click', buttonTarget('[data-cui-reopen]'));
  assert.equal(state.tasks[1].status, 'done'); assert.equal(state.tasks[1].completedAt, 4); assert.match(container.innerHTML, /已选择 2 项/);
});

test('card view retains its own deletion control and accessible title', async () => {
  const calls = []; useState({ imports: [{ id: 'a', name: '原始资料.pdf' }] }, { deleteItems: async selections => { calls.push(selections); return false; } });
  const container = new Container(); Collection.render(container);
  await container.event('click', { closest: selector => selector === '[data-cui-view]' ? { dataset: { cuiView: 'cards' } } : null });
  assert.match(container.innerHTML, /<article class="collection-card/); assert.match(container.innerHTML, /aria-label="移入回收站：原始资料.pdf"/);
  await container.event('click', deleteTarget('import:a')); assert.deepEqual(calls, [[{ type: 'import', id: 'a' }]]);
});

test('tree view groups persistent folders and does not duplicate paper main Markdown', () => {
  useState({ notes:[{id:'main',title:'论文主笔记',workspace:'科研',folderPath:'文献库/2026/DemoGraph'}], papers:[{id:'paper',title:'论文',workspace:'科研',noteId:'main'}], imports:[{id:'pdf',name:'DemoGraph.pdf',workspace:'科研',folderPath:'文献库/2026/DemoGraph'}] });
  const container = new Container(); Collection.render(container,{workspace:'科研',defaultView:'tree'});
  assert.match(container.innerHTML,/collection-tree/); assert.match(container.innerHTML,/独立科研资料/); assert.match(container.innerHTML,/文献库/); assert.match(container.innerHTML,/DemoGraph/);
  assert.match(container.innerHTML,/data-cui-key="note:main"/); assert.doesNotMatch(container.innerHTML,/data-cui-key="paper:paper"/);
  container.event('change',{checked:true,matches:selector=>selector==='[data-cui-all]'});
  assert.match(container.innerHTML,/已选择 2 项/);
});

test('tree folder paths retain hierarchy and escape untrusted labels', () => {
  useState({notes:[{id:'x',title:'<script>x</script>',workspace:'课程',folderPath:'课程\\第1讲/笔记',project:'<b>课</b>'}]});
  const container=new Container();Collection.render(container,{workspace:'课程',defaultView:'tree'});
  assert.match(container.innerHTML,/&lt;b&gt;课/); assert.doesNotMatch(container.innerHTML,/<script>x/);
  const groups=Collection._private.treeGroups(Collection._private.records());
  assert.equal(groups.children.get('<b>课</b>').children.get('课程').children.get('第1讲').children.get('笔记').count,1);
});

test('merge action only accepts selected notes and clears only after successful commit', async () => {
  let received;useState({notes:[{id:'a',title:'A'},{id:'b',title:'B'}],tasks:[{id:'t',title:'T'}]}, {mergeNotes:async ids=>{received=ids;return true;}});
  const container=new Container();Collection.render(container);
  container.event('change',selectionTarget('note:a'));container.event('change',selectionTarget('note:b'));
  assert.match(container.innerHTML,/data-cui-merge/);
  await container.event('click',buttonTarget('[data-cui-merge]'));assert.deepEqual(received,['a','b']);assert.doesNotMatch(container.innerHTML,/已选择/);
  container.event('change',selectionTarget('note:a'));container.event('change',selectionTarget('task:t'));assert.doesNotMatch(container.innerHTML,/data-cui-merge/);
});
