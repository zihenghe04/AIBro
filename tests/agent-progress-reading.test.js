const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/agent-progress.js'), 'utf8');

// A DOM contract for the real patchLive reconciler, including retained nodes,
// grouping moves, disclosure attributes and focus/selection ownership. Native
// Range painting and keyboard acceptance remain separate renderer/native gates.
class Node {
  constructor(name, value = '') { this.nodeName = name.toUpperCase(); this.nodeType = name === '#text' ? 3 : 1; this.nodeValue = value; this.childNodes = []; this.attrs = new Map(); this.parentNode = null; }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  get parentElement() { return this.parentNode; }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] || null; }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  get dataset() { return Object.fromEntries([...this.attrs].filter(([name]) => name.startsWith('data-')).map(([name, value]) => [name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), value])); }
  get open() { return this.hasAttribute('open'); }
  set open(value) { if (value) this.setAttribute('open', ''); else this.removeAttribute('open'); }
  get isConnected() { return !!this.connected || !!this.parentNode?.isConnected; }
  get length() { return this.nodeValue.length; }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  hasAttribute(name) { return this.attrs.has(name); }
  removeAttribute(name) { this.attrs.delete(name); }
  contains(node) { return this === node || this.childNodes.some(child => child.contains(node)); }
  matches(selector) {
    if (selector.startsWith('.')) return (this.getAttribute('class') || '').split(' ').includes(selector.slice(1));
    const attr = /^(\w+)?\[([^\]]+)\]$/.exec(selector);
    if (attr) return (!attr[1] || attr[1].toUpperCase() === this.nodeName) && this.hasAttribute(attr[2]);
    return selector.toUpperCase() === this.nodeName;
  }
  querySelectorAll(selector) {
    if (selector.startsWith(':scope > ')) return this.children.filter(child => child.matches(selector.slice(9)));
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, ref) { if (node === ref) return node; node.remove(); const index = ref ? this.childNodes.indexOf(ref) : this.childNodes.length; assert.notEqual(index, -1); this.childNodes.splice(index, 0, node); node.parentNode = this; return node; }
  remove() { if (!this.parentNode) return; const list = this.parentNode.childNodes; list.splice(list.indexOf(this), 1); this.parentNode = null; }
  removeChild(node) { node.remove(); }
  replaceWith(node) { if (node === this) return; this.parentNode.insertBefore(node, this); this.remove(); }
  isEqualNode(other) { return this.nodeName === other.nodeName && this.nodeValue === other.nodeValue && JSON.stringify([...this.attrs]) === JSON.stringify([...other.attrs]) && this.childNodes.length === other.childNodes.length && this.childNodes.every((child, index) => child.isEqualNode(other.childNodes[index])); }
}
const node = (name, attrs = {}, ...children) => { const result = new Node(name); for (const [key, value] of Object.entries(attrs)) result.setAttribute(key, value); result.append(...children.map(child => typeof child === 'string' ? new Node('#text', child) : child)); return result; };
function tree({ open = true, group = false, close = null } = {}) {
  const row = id => {
    const text = node('div', { class: 'progress-item-body' }, '正在阅读的完整过程 ' + id);
    const control = node('button', {}, '查看记录'); text.append(control);
    const details = node('details', { 'data-progress-key': id }, node('summary', {}, '过程 ' + id), text); details.open = open;
    if (close === id) { details.open = false; details.setAttribute('data-progress-user-open', 'false'); }
    return { row: node('li', { 'data-activity-id': id, 'data-activity-state': open ? 'running' : 'completed' }, details), details, text: text.firstChild, control };
  };
  const first = row('a'), second = row('b');
  let children = [first.row, second.row], groupDetails;
  if (group) { groupDetails = node('details', { 'data-progress-key': 'group:a' }, node('summary', {}, '读取 ×2'), node('ol', {}, ...children)); groupDetails.open = open; children = [node('li', { 'data-progress-group-id': 'group:a' }, groupDetails)]; }
  const feed = node('details', { class: 'agent-progress', 'data-progress-key': 'feed', 'data-progress-phase': open ? 'thinking' : 'settled' }, node('summary', {}, open ? '进行中' : '已完成'), node('ol', {}, ...children)); feed.open = open;
  if (close === 'feed') { feed.open = false; feed.setAttribute('data-progress-user-open', 'false'); }
  return { wrapper: node('article', {}, feed), feed, groupDetails, first, second };
}
function setup(options = {}) {
  const current = tree(options); current.wrapper.connected = true;
  const document = { activeElement: null };
  const selection = { rangeCount: 0, anchorNode: null, focusNode: null, anchorOffset: 0, focusOffset: 0,
    getRangeAt() { return { startContainer: this.anchorNode, startOffset: this.anchorOffset }; },
    setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) { Object.assign(this, { anchorNode, anchorOffset, focusNode, focusOffset }); } };
  const context = { module: { exports: {} }, document, getSelection: () => selection };
  vm.runInNewContext(source, context);
  const select = value => Object.assign(selection, { rangeCount: 1, anchorNode: value, focusNode: value, anchorOffset: 1, focusOffset: 8 });
  const patch = options => context.AgentProgress.patchLive(current.wrapper, tree({ open: false, ...options }).wrapper);
  return { ...current, document, selection, select, patch, Progress: context.AgentProgress };
}

test('settling an automatically open process preserves its selected content and ancestors', () => {
  const f = setup(); f.select(f.first.text); f.patch();
  assert.equal(f.feed.open, true); assert.equal(f.first.details.open, true);
  assert.equal(f.second.details.open, false, 'unread sibling settles normally');
  assert.equal(f.selection.anchorNode, f.first.text); assert.equal(f.first.text.isConnected, true);
  assert.equal(f.first.details.getAttribute('data-progress-user-open'), null, 'reading never creates a durable pin');
});

test('keyboard focus inside the process remains reachable after completion', () => {
  const f = setup(); f.document.activeElement = f.first.control; f.patch();
  assert.equal(f.feed.open, true); assert.equal(f.first.details.open, true);
  assert.equal(f.document.activeElement, f.first.control); assert.equal(f.first.control.isConnected, true);
});

test('a new aggregate around a selected row also stays open without preserving siblings', () => {
  const f = setup(); f.select(f.first.text); f.patch({ group: true });
  const aggregate = f.feed.querySelector('[data-progress-group-id]');
  assert.equal(aggregate.querySelector('details').open, true);
  assert.equal(f.first.details.open, true); assert.equal(f.second.details.open, false);
  assert.equal(f.first.text.isConnected, true);
});

test('explicit user close of the outer process wins over a retained selection', () => {
  const f = setup(); f.select(f.first.text); f.patch({ close: 'feed' });
  assert.equal(f.feed.open, false);
});

test('explicit user close of a segment wins while other parent reading context remains', () => {
  const f = setup(); f.select(f.first.text); f.patch({ close: 'a' });
  assert.equal(f.first.details.open, false);
});

test('an in-flight manual close animation is not reversed by a completion update', () => {
  const f = setup(); f.select(f.first.text); f.first.details._interactionDesiredOpen = false; f.patch();
  // The animation owner closes on finish; the reconciler must leave its intent.
  assert.equal(f.first.details._interactionDesiredOpen, false);
  f.first.details.open = false; delete f.first.details._interactionDesiredOpen; f.patch({ close: 'a' });
  assert.equal(f.first.details.open, false);
});

test('selection release allows the next ordinary redraw to use the normal closed history', () => {
  const f = setup(); f.select(f.first.text); f.patch(); assert.equal(f.feed.open, true);
  f.selection.rangeCount = 0; f.patch();
  assert.equal(f.feed.open, false); assert.equal(f.first.details.open, false);
});

test('collapsed caret and a focused outer summary do not pin historical process bodies', () => {
  for (const kind of ['caret', 'summary']) {
    const f = setup();
    if (kind === 'caret') { f.select(f.first.text); f.selection.focusOffset = f.selection.anchorOffset; }
    else f.document.activeElement = f.feed.firstChild;
    f.patch(); assert.equal(f.feed.open, false); assert.equal(f.first.details.open, false);
  }
});

test('markup carries only actual explicit open/closed choices and does not mutate source records', () => {
  const f = setup();
  const message = { live: false, activities: [{ id: 'a', kind: 'summary', text: '已记录的公开过程', status: 'completed' }], progressPins: { feed: false, a: true } };
  const before = JSON.stringify(message), html = f.Progress.markup(message);
  assert.match(html, /data-progress-key="feed" data-progress-user-open="false"/);
  assert.match(html, /data-progress-key="a" open data-progress-user-open="true"/);
  assert.equal(JSON.stringify(message), before);
});
