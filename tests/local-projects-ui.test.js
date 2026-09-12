const test = require('node:test');
const assert = require('node:assert/strict');
const Local = require('../app/local-projects-ui.js');
const folder = { id: 'local_home', rootId: 'root_projects', name: '个人主页', path: '/tmp/Projects/homepage' };
const scope = { id: folder.rootId, name: 'Projects', path: '/tmp/Projects' };
const source = () => ({ folder: { ...folder }, tree: [{ path: 'src', type: 'directory' }, { path: 'src/index.html', type: 'file' }, { path: 'large.md', type: 'file' }], files: [{ path: 'src/index.html', content: '<script>steal()</script>', truncated: false }], summary: '2 个源文件', totalFiles: 2, truncated: false });
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(options = {}) {
  const elements = [], calls = [], opened = [], chats = [], toasts = [];
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.open = false; this.value = ''; this.hidden = false; elements.push(this); }
    set innerHTML(value) { throw new Error('untrusted HTML assignment'); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
    async fire(type, extra = {}) { const event = { target: this, preventDefault() { this.defaultPrevented = true; }, ...extra }; for (const callback of this.listeners[type] || []) await callback(event); return event; }
    querySelector(tag) { return this.children.find(child => child.tagName === tag); }
    querySelectorAll(selector) { const result = []; const walk = node => { if (selector === '[data-file-path]' && node.dataset?.filePath) result.push(node); node.children.forEach(walk); }; walk(this); return result; }
    focus() { doc.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; void this.fire('close'); }
  }
  const doc = { createElement: tag => new Element(tag), body: new Element('body'), activeElement: null };
  const state = options.state || { projects: [] }; let roots = options.authorized === false ? [] : [scope], saves = 0;
  const fetcher = async (url, init) => {
    const call = { url, method: init.method, payload: init.body ? JSON.parse(init.body) : undefined, signal: init.signal }; calls.push(call);
    const custom = await options.fetch?.(call); if (custom) return custom;
    let data;
    if (url === '/__local/roots' && init.method === 'GET') data = { roots, suggestedRoots: [scope] };
    else if (url === '/__local/roots' && init.method === 'POST') { roots = [scope]; data = { roots, suggestedRoots: [scope], connectedRoots: roots }; }
    else if (init.method === 'DELETE') { roots = []; data = { ok: true }; }
    else if (url === '/__local/search') data = { candidates: [{ ...folder, relativePath: 'homepage', reason: '名称匹配' }], truncated: false };
    else if (url === '/__local/snapshot') data = source();
    else throw new Error(`unexpected endpoint ${url}`);
    return { ok: true, json: async () => data };
  };
  const api = Local.createController({ getState: () => state, fetch: fetcher, save: async () => { saves++; return options.save?.(state); }, renderAll() {}, openProject: id => opened.push(id), newConversation: (...args) => chats.push(args), toast: value => toasts.push(value) }, { document: doc });
  const el = id => elements.find(item => item.id === id);
  const byText = value => elements.find(item => item.textContent === value);
  const prepare = async projectId => { await api.open(projectId); if (!projectId || !state.projects.find(item => item.id === projectId)?.localFolder) await elements.find(item => item.dataset?.candidateId === folder.id).fire('click'); };
  return { api, state, calls, elements, opened, chats, toasts, el, byText, prepare, get saves() { return saves; }, revoke: () => { roots = []; }, escape: async () => { const dialog = el('localProjectsDialog'); const event = await dialog.fire('cancel'); if (!event.defaultPrevented) dialog.close(); } };
}

test('connection plan stores metadata only and preserves the target project identity and workspace', () => {
  const state = { projects: [{ id: 'p', name: '我的课程', workspace: '课程', description: '原描述' }] };
  const plan = Local.connectionPlan(state, { ...folder, files: source().files, content: 'not persistent' }, { projectId: 'p', name: '新名称', workspace: '科研', expectedFolderId: null }, 42);
  assert.equal(plan.project.id, 'p'); assert.equal(plan.project.name, '我的课程'); assert.equal(plan.project.workspace, '课程');
  assert.equal(plan.project.description, '原描述'); assert.deepEqual(Object.keys(plan.project.localFolder).sort(), ['connectedAt', 'id', 'name', 'path', 'rootId']);
  assert.equal(state.projects[0].localFolder, undefined, 'preflight must not mutate');
});

test('same canonical path reuses the original project across different authorization roots, archived matches block duplicates', () => {
  const existing = { id: 'p', name: '已有主页', workspace: '科研', localFolder: { ...folder } }, state = { projects: [existing] };
  assert.equal(Local.connectionPlan(state, folder).reused, true);
  const plan = Local.connectionPlan(state, { ...folder, id: 'new_folder_id', rootId: 'new_root' });
  assert.equal(plan.created, false); assert.equal(plan.project.id, 'p'); assert.equal(plan.project.workspace, '科研'); assert.equal(plan.project.localFolder.id, 'new_folder_id');
  assert.equal(existing.localFolder.id, folder.id); existing.archived = true;
  assert.throws(() => Local.connectionPlan(state, { ...folder, id: 'new' }), /归档/);
});

test('stale target deletion and changed folder associations cannot be overwritten', () => {
  assert.throws(() => Local.connectionPlan({ projects: [] }, folder, { projectId: 'gone' }), /删除/);
  assert.throws(() => Local.connectionPlan({ projects: [{ id: 'p', localFolder: { id: 'changed' } }] }, folder, { projectId: 'p', expectedFolderId: null }), /已经变化/);
});

test('discovery never grants access implicitly or opens a modal; keyword search uses only authorized roots', async () => {
  const h = harness({ authorized: false }); const before = JSON.stringify(h.state);
  assert.equal((await h.api.discover('个人主页')).requiresAccess, true);
  assert.deepEqual(h.calls.map(item => item.method), ['GET']); assert.equal(h.el('localProjectsDialog'), undefined);
  await h.api.ensureAccess('common-projects'); const result = await h.api.discover(' 个人主页 ');
  assert.equal(result.candidates[0].id, folder.id); assert.deepEqual(h.calls.at(-1).payload, { query: '个人主页', limit: 30 }); assert.equal(JSON.stringify(h.state), before);
});

test('requestAccess returns existing authorization immediately and presents concrete scopes before first grant', async () => {
  const ready = harness(); assert.equal(await ready.api.requestAccess(), true); assert.equal(ready.el('localProjectsDialog'), undefined);
  const h = harness({ authorized: false }); const pending = h.api.requestAccess(); await tick();
  assert.equal(h.el('localProjectsDialog').open, true); assert.equal(h.el('localProjectsDialog').dataset.accessOnly, 'true');
  assert.ok(h.elements.some(item => item.textContent?.includes(scope.path))); assert.equal(h.calls.some(item => item.method === 'POST'), false);
  await h.el('localProjectsAllow').fire('click'); assert.equal(await pending, true);
  assert.deepEqual(h.calls.find(item => item.method === 'POST').payload, { preset: 'common-projects' }); assert.equal(h.saves, 0);
});

test('Escape and abort resolve a pending authorization false without reading source files or mutating projects', async () => {
  for (const abort of [false, true]) {
    const h = harness({ authorized: false }); const controller = new AbortController(); const promise = h.api.requestAccess({ signal: controller.signal }); await tick();
    if (abort) controller.abort(); else await h.escape();
    assert.equal(await promise, false); assert.equal(h.el('localProjectsDialog').open, false); assert.equal(h.calls.some(item => item.method === 'POST'), false); assert.equal(h.saves, 0); assert.deepEqual(h.state.projects, []);
  }
});

test('late grant completion cannot resume a cancelled turn, and concurrent callers share one authorization dialog', async () => {
  let release;
  const h = harness({ authorized: false, fetch: call => call.method === 'POST' ? new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ roots: [scope] }) }); }) : undefined });
  const signal = new AbortController(); const first = h.api.requestAccess({ signal: signal.signal }); const second = h.api.requestAccess(); await tick();
  assert.equal(h.elements.filter(item => item.tagName === 'dialog').length, 1);
  const authorizing = h.el('localProjectsAllow').fire('click'); await tick(); signal.abort();
  assert.equal(await first, false); assert.equal(await second, false); release(); await authorizing;
  assert.equal(h.el('localProjectsDialog').open, false); assert.equal(h.saves, 0);
});

test('source preview uses literal text and explains files outside the bounded snapshot', async () => {
  const h = harness(); await h.prepare();
  assert.equal(h.elements.find(item => item.tagName === 'pre').textContent, '<script>steal()</script>');
  await h.elements.find(item => item.dataset?.filePath === 'large.md').fire('click');
  assert.match(h.elements.find(item => item.tagName === 'pre').textContent, /12 个重点文件/);
  assert.equal(h.saves, 0); assert.deepEqual(h.state.projects, []);
});

test('connecting revalidates current source and persists metadata once; repeat connection opens the original project', async () => {
  const h = harness(); await h.prepare(); h.el('localProjectsName').value = '我的主页'; h.el('localProjectsWorkspace').value = '课程';
  const project = await h.api.connectSelected(true);
  assert.equal(h.saves, 1); assert.equal(h.calls.filter(item => item.url === '/__local/snapshot').length, 2);
  assert.equal(h.state.projects.length, 1); assert.equal(project.name, '我的主页'); assert.equal(project.workspace, '课程'); assert.equal(JSON.stringify(project).includes('steal'), false);
  assert.deepEqual(h.chats, [['课程', project.id]]); await h.prepare(project.id); await h.api.connectSelected();
  assert.equal(h.saves, 1); assert.equal(h.state.projects.length, 1); assert.deepEqual(h.opened, [project.id]);
});

test('revoked access and unavailable source prevent project creation after an earlier valid preview', async () => {
  const revoked = harness(); await revoked.prepare(); revoked.revoke(); assert.equal(await revoked.api.connectSelected(), false); assert.equal(revoked.saves, 0); assert.deepEqual(revoked.state.projects, []);
  let missing = false; const moved = harness({ fetch: call => call.url === '/__local/snapshot' && missing ? { ok: false, status: 404, json: async () => ({ error: '目录已移动' }) } : undefined });
  await moved.prepare(); missing = true; assert.equal(await moved.api.connectSelected(), false); assert.equal(moved.saves, 0); assert.deepEqual(moved.state.projects, []);
});

test('failed save rolls back only its connection and retry still persists, without duplicating projects', async () => {
  let fail = true; const h = harness({ save: () => { if (fail) throw new Error('磁盘已满'); } }); await h.prepare();
  assert.equal(await h.api.connectSelected(), false); assert.equal(h.state.projects.length, 0); assert.equal(h.opened.length, 0); assert.match(h.el('localProjectsStatus').textContent, /磁盘已满/);
  fail = false; assert.ok(await h.api.connectSelected()); assert.equal(h.saves, 2); assert.equal(h.state.projects.length, 1);
});

test('revoking scope while final snapshot is in flight prevents commit even if the snapshot completes', async () => {
  let holdSnapshot = false, release;
  const h = harness({ fetch: call => call.url === '/__local/snapshot' && holdSnapshot ? new Promise(resolve => { release = () => resolve({ ok: true, json: async () => source() }); }) : undefined });
  await h.prepare(); holdSnapshot = true;
  const connecting = h.api.connectSelected(); await tick();
  assert.equal(typeof release, 'function'); h.revoke(); release();
  assert.equal(await connecting, false); assert.equal(h.saves, 0); assert.deepEqual(h.state.projects, []); assert.deepEqual(h.opened, []);
  assert.match(h.el('localProjectsStatus').textContent, /读取期间.*撤销/);
  assert.equal(h.calls.at(-1).url, '/__local/roots'); assert.equal(h.calls.at(-1).method, 'GET');
});

test('target archive during asynchronous revalidation blocks commit; source reads always refresh without modifying state', async () => {
  const state = { projects: [{ id: 'p', name: '课程', workspace: '课程' }] }; let archive = false;
  const h = harness({ state, fetch: call => { if (archive && call.url === '/__local/snapshot') state.projects[0].archived = true; } });
  await h.prepare('p'); archive = true; assert.equal(await h.api.connectSelected(), false); assert.equal(h.saves, 0); assert.equal(state.projects[0].localFolder, undefined);
  const before = JSON.stringify(state); await h.api.snapshot({ localFolder: folder }); await h.api.snapshot({ localFolder: folder }); assert.equal(JSON.stringify(state), before);
});
