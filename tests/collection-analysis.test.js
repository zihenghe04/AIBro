const test = require('node:test');
const assert = require('node:assert/strict');
const Collection = require('../collection-ui.js');

// Exercise delegated browser events while leaving persistent changes entirely
// to the host. The collection is deliberately not an AI invocation boundary.
class Container {
  constructor() { this.dataset = {}; this.listeners = {}; this.html = ''; }
  set innerHTML(value) {
    this.html = value;
    this.search = { value: '', selectionStart: 0, selectionEnd: 0,
      matches: selector => selector === '[data-cui-search]', focus() {}, setSelectionRange() {} };
    this.all = {};
  }
  get innerHTML() { return this.html; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  querySelector(selector) { return selector === '[data-cui-search]' ? this.search : selector === '[data-cui-all]' ? this.all : null; }
  event(type, target) { return this.listeners[type]?.({ target }); }
}
const button = selector => ({ closest: match => match === selector ? {} : null });
const choose = (container, key) => container.event('change', { checked: true, matches: selector => selector === '[data-cui-check]', closest: () => ({ dataset: { cuiKey: key } }) });
const filter = (container, value) => container.event('change', { value, matches: selector => selector === '[data-cui-type]' });
const selectAll = container => container.event('change', { checked: true, matches: selector => selector === '[data-cui-all]' });
const analyze = container => container.event('click', button('[data-cui-analyze-selected]'));
const pending = { status: 'pending', label: '待 AI 分析', detail: '原件已保存，发送指令后开始分析。' };
const analyzed = { status: 'analyzed', label: '已分析', detail: '已形成 1 篇笔记。', noteIds: ['n'] };
function setup(state, hooks = {}, options = {}) {
  Collection.init({ getState: () => state, getAnalysis: () => pending,
    analyzeImports: undefined, deleteItems: undefined, save: () => true,
    toast: () => {}, renderAll: () => {}, ...hooks });
  const container = new Container(); Collection.render(container, options); return container;
}

test('import status describes analysis results, never parser completion, and escapes explanations', () => {
  const state = { imports: [{ id: 'a', name: '课件.pdf', parser: 'local', status: '已解析' }, { id: 'b', name: '阅读.pdf', parser: 'web' }] };
  const container = setup(state, { getAnalysis: item => item.id === 'a' ? { ...pending, detail: '<img src=x onerror="bad()">' } : analyzed });
  assert.deepEqual(Collection._private.records().map(item => item._meta), ['待 AI 分析', '已分析']);
  assert.match(container.innerHTML, /collection-status analysis-pending/);
  assert.match(container.innerHTML, /&lt;img src=x onerror=&quot;bad\(\)&quot;&gt;/);
  assert.doesNotMatch(container.innerHTML, /<img|>local<|>web<|已解析/);
  const viewButton = { dataset: { cuiView: 'cards' } };
  container.event('click', { closest: selector => selector === '[data-cui-view]' ? viewButton : null });
  assert.match(container.innerHTML, /class="collection-cards"/);
  assert.match(container.innerHTML, /<small class="collection-status analysis-pending"/);
  assert.match(container.innerHTML, /<small class="collection-status done"/);
});

test('pending analysis filter respects real project scope, active status, search and entity type', async () => {
  const calls = [];
  const state = { projects: [{ id: 'course', workspace: '课程' }, { id: 'research', workspace: '科研' }, { id: 'old', workspace: '课程', archived: true }],
    imports: [{ id: 'a', name: '第 1 讲', projectId: 'course', workspace: '科研', tags: ['复习'] },
      { id: 'b', name: '第 2 讲', projectId: 'course' }, { id: 'c', name: '别处', projectId: 'research' },
      { id: 'd', name: '旧课件', projectId: 'old' }, { id: 'e', projectId: 'course', archived: true },
      { id: 'f', projectId: 'course', deletedAt: 1 }, { id: 'g', name: '其他材料', projectId: 'course' }],
    tasks: [{ id: 'a', title: '复习任务', projectId: 'course', status: 'todo' }] };
  const container = setup(state, { getAnalysis: item => item.id === 'b' ? analyzed : pending,
    analyzeImports: async (...args) => { calls.push(args); return true; } }, { workspace: '课程', projectId: 'course' });
  filter(container, 'pending-analysis');
  container.search.value = '  复习  '; container.event('input', container.search);
  selectAll(container); await analyze(container);
  assert.deepEqual(calls, [[['a'], { workspace: '课程', projectId: 'course' }]]);
  assert.match(container.innerHTML, /data-cui-kind="import"/);
  assert.doesNotMatch(container.innerHTML, /data-cui-kind="task"|data-cui-id="[bcdefg]"/);
});

test('mixed selection stages only originals and leaves task selection usable without marking files analyzed', async () => {
  const calls = []; let saves = 0;
  const state = { projects: [{ id: 'p', workspace: '课程' }], tasks: [{ id: 'same', projectId: 'p', status: 'todo' }],
    imports: [{ id: 'same', projectId: 'p', name: '原件.pdf' }], notes: [{ id: 'n', projectId: 'p', title: '笔记' }] };
  const container = setup(state, { analyzeImports: async (...args) => { calls.push(args); return true; }, save: () => { saves++; return true; } }, { projectId: 'p', workspace: '课程' });
  choose(container, 'task:same'); choose(container, 'import:same');
  const before = JSON.stringify(state);
  assert.match(container.innerHTML, /交给 AI 分析 · 1 份/);
  assert.match(container.innerHTML, /发送指令后才开始分析/);
  assert.equal(await analyze(container), true);
  assert.deepEqual(calls, [[['same'], { workspace: '课程', projectId: 'p' }]]);
  assert.equal(JSON.stringify(state), before); assert.equal(saves, 0);
  assert.match(container.innerHTML, /已选择 1 项/);
  assert.doesNotMatch(container.innerHTML, /data-cui-analyze-selected/);
  await container.event('click', button('[data-cui-complete]'));
  assert.equal(state.tasks[0].status, 'done'); assert.equal(saves, 1);
});

test('cancelled, failed or unavailable staging preserves the selection for retry', async () => {
  const notices = []; let result = false; let attempts = 0;
  const container = setup({ imports: [{ id: 'a' }] }, { toast: value => notices.push(value),
    analyzeImports: async () => { attempts++; if (result === 'throw') throw new Error('保存失败'); return result; } });
  choose(container, 'import:a');
  assert.equal(await analyze(container), false); assert.match(container.innerHTML, /已选择 1 项/);
  result = 'throw'; assert.equal(await analyze(container), false);
  assert.match(notices.at(-1), /保存失败/); assert.match(container.innerHTML, /已选择 1 项/);
  Collection.init({ analyzeImports: undefined });
  assert.equal(await analyze(container), false); assert.equal(attempts, 2);
  assert.match(notices.at(-1), /分析入口暂不可用/);
  assert.match(container.innerHTML, /已选择 1 项/);
});

test('staging is single flight and cannot concurrently complete tasks or delete selected content', async () => {
  let resolve; let stages = 0; let deletes = 0; let saves = 0;
  const state = { imports: [{ id: 'a' }], tasks: [{ id: 't', status: 'todo' }] };
  const container = setup(state, { analyzeImports: () => { stages++; return new Promise(done => { resolve = done; }); },
    deleteItems: () => { deletes++; return true; }, save: () => { saves++; return true; } });
  choose(container, 'import:a'); choose(container, 'task:t');
  const first = analyze(container);
  await analyze(container); await container.event('click', button('[data-cui-complete]'));
  await container.event('click', button('[data-cui-delete-selected]'));
  assert.equal(stages, 1); assert.equal(saves, 0); assert.equal(deletes, 0); assert.equal(state.tasks[0].status, 'todo');
  resolve(true); assert.equal(await first, true);
  assert.match(container.innerHTML, /已选择 1 项/);
});

test('a late staging response retains the current project view and never stages its files instead', async () => {
  let resolve; const calls = [];
  const state = { projects: [{ id: 'p', workspace: '课程' }, { id: 'q', workspace: '科研' }], imports: [{ id: 'a', projectId: 'p' }, { id: 'b', projectId: 'q' }] };
  const container = setup(state, { analyzeImports: (...args) => { calls.push(args); return new Promise(done => { resolve = done; }); } }, { projectId: 'p', workspace: '课程' });
  choose(container, 'import:a'); const waiting = analyze(container);
  Collection.render(container, { projectId: 'q', workspace: '科研' });
  resolve(true); await waiting;
  assert.deepEqual(calls, [[['a'], { workspace: '课程', projectId: 'p' }]]);
  assert.match(container.innerHTML, /data-cui-id="b"/); assert.doesNotMatch(container.innerHTML, /data-cui-id="a"/);
  choose(container, 'import:b'); assert.match(container.innerHTML, /已选择 1 项/);
});

test('deleted, archived or moved sources selected before a state change are revalidated before staging', async () => {
  let calls = 0;
  const state = { projects: [{ id: 'p' }, { id: 'q' }], imports: [{ id: 'deleted', projectId: 'p' }, { id: 'archived', projectId: 'p' }, { id: 'moved', projectId: 'p' }] };
  const container = setup(state, { analyzeImports: () => { calls++; return true; } }, { projectId: 'p' });
  selectAll(container); state.imports.shift(); state.imports[0].archived = true; state.imports[1].projectId = 'q';
  assert.equal(await analyze(container), false); assert.equal(calls, 0);
  assert.doesNotMatch(container.innerHTML, /已选择/);
});

test('a source that gains analysis results while selected is omitted by the pending-only filter', async () => {
  let ready = false; let calls = 0;
  const container = setup({ imports: [{ id: 'a' }] }, { getAnalysis: () => ready ? analyzed : pending,
    analyzeImports: () => { calls++; return true; } });
  filter(container, 'pending-analysis'); selectAll(container); ready = true;
  assert.equal(await analyze(container), false); assert.equal(calls, 0);
  assert.match(container.innerHTML, /没有匹配内容/); assert.doesNotMatch(container.innerHTML, /已选择/);
});
