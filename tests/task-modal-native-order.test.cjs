'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const planningSource = fs.readFileSync(require.resolve('../app/planning-workbench'), 'utf8');
const appSource = fs.readFileSync(require.resolve('../app/app'), 'utf8');
const requireApp = require('node:module').createRequire(require.resolve('../app/planning-workbench'));

// Exercise the retained production controllers. This models DOM order and
// ownership, not WKWebView's AX traversal; native acceptance remains separate.
function fixture({ bridge = true, nativeClass = false } = {}) {
  let document, moves = 0;
  class Node {
    constructor(tag, id = '') { this.tagName = tag.toUpperCase(); this.id = id; this.children = []; this.open = false; this.attributes = {}; this.listeners = {}; this.value = ''; }
    get ownerDocument() { return document; }
    get firstElementChild() { return this.children[0] || null; }
    get isConnected() { return this === document.body || !!this.parentElement?.isConnected; }
    append(node) { node.remove(); this.children.push(node); node.parentElement = this; }
    prepend(node) { node.remove(); this.children.unshift(node); node.parentElement = this; moves++; }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
    all() { return [this, ...this.children.flatMap(node => node.all())]; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(event, action) { this.listeners[event] = action; }
    focus() { document.activeElement = this; }
    showModal() { this.firstWhenShown = document.body.firstElementChild; this.open = true; this.shows = (this.shows || 0) + 1; }
    close() { this.open = false; this.onclose?.(); }
    set innerHTML(value) { assert.equal(value, '<div id="planningCreateSurface"></div>'); this.children = []; this.append(new Node('div', 'planningCreateSurface')); }
  }
  const body = new Node('body'), main = new Node('main', 'main'); body.classList = { contains: name => nativeClass && name === 'aibro-native' };
  document = { body, activeElement: null, createElement: tag => new Node(tag), querySelector: selector => body.all().find(node => `#${node.id}` === selector) || null };
  body.append(main);
  const context = vm.createContext({ module: { exports: {} }, require: requireApp, document, ...(bridge ? { webkit: { messageHandlers: { workspace: {} } } } : {}) });
  vm.runInContext(planningSource, context); const Planning = context.module.exports;
  let mounted = 0, props;
  const state = { tasks: [], projects: [], notes: [], imports: [] };
  Planning.init({ document, getState: () => state, mount(host, name, value) { assert.equal(name, 'TaskCreateForm'); mounted++; props = value; host.append(new Node('input', 'planningTaskTitle')); return { unmount() {}, update() {} }; } });
  const dialog = new Node('dialog', 'taskDialog'), input = new Node('input', 'draft'); dialog.append(input); body.append(dialog);
  return { document, body, main, dialog, input, Planning, Node, state, get moves() { return moves; }, get mounted() { return mounted; }, get props() { return props; } };
}

test('native prepare moves the closed body-owned dialog once, preserving field, selection and listeners', () => {
  for (const mode of [{ bridge: true }, { bridge: false, nativeClass: true }]) {
    const h = fixture(mode); let fired = 0; h.input.value = '未提交的标题'; h.input.selectionStart = 2; h.input.selectionEnd = 5; h.input.addEventListener('input', () => fired++);
    assert.equal(h.Planning.prepareDialog(h.dialog), h.dialog); h.dialog.showModal();
    assert.equal(h.dialog.firstWhenShown, h.dialog); assert.equal(h.moves, 1); assert.equal(h.dialog.firstElementChild, h.input);
    assert.equal(h.input.value, '未提交的标题'); assert.deepEqual([h.input.selectionStart, h.input.selectionEnd], [2, 5]); h.input.listeners.input(); assert.equal(fired, 1);
    const other = new h.Node('aside'); h.body.prepend(other); const moves = h.moves;
    h.Planning.prepareDialog(h.dialog); assert.equal(h.moves, moves); assert.equal(h.body.firstElementChild, other, 'never reparent an open modal');
    h.dialog.close(); h.Planning.prepareDialog(h.dialog); assert.equal(h.body.firstElementChild, h.dialog); assert.equal(h.moves, moves + 1);
  }
});

test('ordinary web, nested and detached owners are not reordered', () => {
  const web = fixture({ bridge: false }); web.Planning.prepareDialog(web.dialog); assert.equal(web.body.firstElementChild, web.main); assert.equal(web.moves, 0);
  const nested = fixture(); nested.main.append(nested.dialog); nested.Planning.prepareDialog(nested.dialog); assert.equal(nested.dialog.parentElement, nested.main); assert.equal(nested.moves, 0);
  nested.dialog.remove(); nested.Planning.prepareDialog(nested.dialog); assert.equal(nested.dialog.parentElement, null); assert.equal(nested.moves, 0);
});

test('real task-create shows the retained dialog before hidden workbench siblings without remounting an open draft', () => {
  const h = fixture(); assert.equal(h.Planning.createTask({ workspace: '课程' }), true);
  const dialog = h.document.querySelector('#planningCreateDialog'), input = h.document.querySelector('#planningTaskTitle');
  assert.equal(dialog.firstWhenShown, dialog); assert.equal(h.mounted, 1); input.value = '保留中文草稿';
  const other = new h.Node('aside'); h.body.prepend(other); const moves = h.moves;
  assert.equal(h.Planning.createTask({ workspace: '课程' }), true); assert.equal(h.moves, moves); assert.equal(h.mounted, 1); assert.equal(input.value, '保留中文草稿'); assert.equal(h.document.activeElement, input);
  h.props.onCancel(); assert.equal(dialog.open, false);
});

test('production detail entry and document return prepare before showing, then restore the same pending draft', () => {
  for (const [start, end, functionName] of [
    ['function openTask(', '// 产出要求编辑器', 'openTask'],
    ['function restorePreviewTask(', "\n$('#previewOrganize')", 'restorePreviewTask']
  ]) {
    const h = fixture(), task = { id: 'synthetic-task' }, draft = { title: '待保存标题' }; let restored;
    const context = vm.createContext({ window: { PlanningWorkbench: h.Planning }, document: h.document, $: selector => h.document.querySelector(selector),
      state: { ui: {} }, saveTaskDetails: { busy: false }, taskEditorContexts: new Map([[task.id, { draft }]]), taskEditorIntent: 0,
      pruneTaskEditorContexts() {}, taskEditorTask: () => task, parkTaskEditor() {}, taskEditorVersion: () => 'v1', renderTaskDialog() {},
      captureTaskFormDraft: () => draft, taskFormContent: value => value, applyTaskFormDraft(record, value) { assert.equal(record, task); restored = value; }, toast() { assert.fail('unexpected rejection'); } });
    const first = appSource.indexOf(start), last = appSource.indexOf(end, first); assert.ok(first >= 0 && last > first);
    vm.runInContext(appSource.slice(first, last), context);
    assert.equal(vm.runInContext(`${functionName}('synthetic-task')`, context), true);
    assert.equal(h.dialog.firstWhenShown, h.dialog, `${functionName} prep precedes native showModal`); assert.equal(h.dialog.firstElementChild, h.input); assert.equal(restored, draft);
  }
});
