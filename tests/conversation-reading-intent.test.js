const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Exercise the production controller with deterministic browser event ordering.
// Native wheel/compositor acceptance remains a separate gate.
const source = fs.readFileSync(path.join(__dirname, '../app/conversation-reading.js'), 'utf8');
function fixture() {
  let clock = 1, nextId = 0, selection = null;
  const frames = new Map(), timers = new Map(), observers = [], writes = [];
  const eventTarget = extra => Object.assign({
    listeners: new Map(),
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); },
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); },
    emit(type, fields = {}) { const event = { target: this, ...fields }; for (const fn of this.listeners.get(type) || []) fn(event); },
  }, extra);
  const win = eventTarget({
    performance: { now: () => clock },
    requestAnimationFrame(fn) { const id = ++nextId; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(fn, ms) { const id = ++nextId; timers.set(id, { at: clock + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    ResizeObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
  });
  const doc = eventTarget({ defaultView: win, visibilityState: 'visible', getSelection: () => selection, body: { classList: { contains: () => true } } });
  const list = eventTarget({
    ownerDocument: doc, dataset: { conversationId: 'one' }, isConnected: true,
    clientHeight: 500, clientWidth: 600, scrollHeight: 2000, scrollTop: 0, clientTop: 0, style: {},
    getBoundingClientRect() { return { top: 0, bottom: 500, left: 0, right: 600 }; },
    closest() { return this; },
    contains(node) { return node === this || this.children.includes(node); },
    scrollTo(options) { writes.push(options); if (options.behavior !== 'smooth') this.scrollTop = Math.max(0, Math.min(options.top, this.scrollHeight - this.clientHeight)); },
  });
  list.children = Array.from({ length: 4 }, (_, index) => ({
    dataset: { messageId: 'message-' + index },
    getBoundingClientRect() { return { top: index * 500 - list.scrollTop, bottom: (index + 1) * 500 - list.scrollTop, left: 0, right: 600 }; },
    querySelector() { return null; },
  }));
  const context = { module: { exports: {} }, document: doc, matchMedia: () => ({ matches: false }) };
  vm.runInNewContext(source, context);
  const api = context.module.exports;
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); };
  const advance = ms => { clock += ms; for (const [id, value] of [...timers]) if (value.at <= clock) { timers.delete(id); value.fn(); } };
  const scroll = top => { list.scrollTop = top; list.emit('scroll'); };
  const wheel = (deltaY, top) => { list.emit('wheel', { deltaY }); if (top !== undefined) scroll(top); };
  const resize = () => { observers.forEach(observer => observer.fn()); flush(); };
  const select = ({ inside = true, crossing = false, collapsed = false, notify = true, offset = 12 } = {}) => {
    const range = { startContainer: inside ? list.children[3] : {}, startOffset: 0, endContainer: inside ? list.children[3] : {}, endOffset: offset, collapsed, intersectsNode: node => crossing && node === list };
    selection = { isCollapsed: collapsed, rangeCount: 1, getRangeAt: () => range };
    if (notify) doc.emit('selectionchange');
  };
  const clearSelection = () => { selection = null; doc.emit('selectionchange'); };
  const token = api.beforeRender(list, 'one'); api.afterRender(list, token); flush();
  list.emit('scroll'); // Deliver the initial owned positioning before reader input.
  return { api, list, doc, win, writes, frames, timers, flush, advance, scroll, wheel, resize, select, clearSelection };
}

test('one small upward wheel releases bottom follow before the near-end threshold', () => {
  const f = fixture();
  assert.equal(f.list.scrollTop, 1500);
  f.wheel(-8, 1492);
  assert.equal(f.api.inspect(f.list).following, false);
  f.advance(250); f.resize();
  assert.equal(f.list.scrollTop, 1492, 'settled transcript stays where the first small wheel moved it');
  f.list.scrollHeight += 200; f.resize();
  assert.equal(f.list.scrollTop, 1492, 'later output cannot re-attach the opted-out reader');
});

test('upward wheel cancels a queued follow frame even before a scroll event arrives', () => {
  const f = fixture();
  const token = f.api.beforeRender(f.list, 'one'); f.api.afterRender(f.list, token);
  assert.equal(f.frames.size, 1);
  f.wheel(-1);
  assert.equal(f.frames.size, 0);
  assert.equal(f.api.inspect(f.list).following, false);
  f.scroll(1499); f.advance(250); f.resize();
  assert.equal(f.list.scrollTop, 1499);
});

test('once detached, approaching the bottom does not resume follow until actually reaching it', () => {
  const f = fixture();
  f.wheel(-30, 1470);
  f.wheel(20, 1490);
  assert.equal(f.api.inspect(f.list).following, false);
  f.wheel(10, 1500);
  assert.equal(f.api.inspect(f.list).following, true);
  f.advance(250); f.list.scrollHeight += 100; f.resize();
  assert.equal(f.list.scrollTop, 1600);
});

test('accessibility or scrollbar movement upwards also opts out without a wheel event', () => {
  const f = fixture();
  f.scroll(1494);
  assert.equal(f.api.inspect(f.list).following, false);
  f.advance(250); f.resize();
  assert.equal(f.list.scrollTop, 1494);
});

test('fractional wheel movement cannot be swallowed as an earlier owned positioning event', () => {
  const f = fixture();
  f.list.scrollHeight += 1; f.resize(); // Browser has not delivered this owned scroll yet.
  f.wheel(-0.25, 1500.75);
  assert.equal(f.api.inspect(f.list).anchor.scrollTop, 1500.75);
  f.advance(250); f.resize();
  assert.equal(f.api.inspect(f.list).following, false);
  assert.equal(f.list.scrollTop, 1500.75);
});

test('upward keyboard intent detaches immediately and End can resume at the actual bottom', () => {
  const f = fixture(), target = { closest() { return null; } };
  f.list.emit('keydown', { key: 'ArrowUp', target }); f.scroll(1496);
  assert.equal(f.api.inspect(f.list).following, false);
  f.advance(250); f.resize(); assert.equal(f.list.scrollTop, 1496);
  f.list.emit('keydown', { key: 'End', target }); f.scroll(1500);
  assert.equal(f.api.inspect(f.list).following, true);
});

test('a layout shrink cannot turn a detached reader into bottom-follow', () => {
  const f = fixture();
  f.wheel(-8, 1492); f.advance(250);
  f.list.clientHeight = 700; f.list.scrollTop = 1300; f.list.emit('scroll'); f.flush();
  assert.equal(f.api.inspect(f.list).following, false);
});

test('explicit return to latest restores following immediately after an upward gesture', () => {
  const f = fixture();
  f.wheel(-6, 1494);
  f.api.follow(f.list, { behavior: 'instant' });
  assert.equal(f.list.scrollTop, 1500);
  assert.equal(f.api.inspect(f.list).following, true);
  f.advance(200); f.list.scrollHeight += 100; f.resize();
  assert.equal(f.list.scrollTop, 1600);
});

test('tiny upward input interrupts a smooth return and no stale settle timer re-attaches it', () => {
  const f = fixture();
  f.doc.body.classList.contains = () => false;
  f.scroll(500);
  f.api.follow(f.list, { behavior: 'smooth' });
  f.scroll(1100);
  f.wheel(-4, 1096);
  assert.equal(f.api.inspect(f.list).navigating, false);
  assert.equal(f.api.inspect(f.list).following, false);
  assert.ok(f.writes.some(value => value.top === 1100 && value.behavior === 'instant'));
  f.advance(400); f.resize();
  assert.equal(f.list.scrollTop, 1096);
});

test('returning to a conversation remembers a small upward opt-out independently', () => {
  const f = fixture();
  f.wheel(-8, 1492); f.advance(250);
  let token = f.api.beforeRender(f.list, 'two'); f.list.dataset.conversationId = 'two'; f.api.afterRender(f.list, token); f.flush();
  assert.equal(f.api.inspect(f.list).following, true);
  token = f.api.beforeRender(f.list, 'one'); f.list.dataset.conversationId = 'one'; f.api.afterRender(f.list, token); f.flush();
  assert.equal(f.api.inspect(f.list).following, false);
  assert.equal(f.list.scrollTop, 1492);
});

test('a message selection at the bottom cancels a queued follow before output grows', () => {
  const f = fixture(), focus = f.doc.activeElement = {};
  const token = f.api.beforeRender(f.list, 'one'); f.api.afterRender(f.list, token);
  assert.equal(f.frames.size, 1);
  f.select();
  assert.equal(f.frames.size, 0);
  assert.equal(f.api.inspect(f.list).following, false);
  const writes = f.writes.length;
  f.list.scrollHeight += 200; f.resize();
  assert.equal(f.list.scrollTop, 1500);
  assert.equal(f.writes.length, writes, 'no anchor or follow write while the selection is held');
  assert.equal(f.doc.activeElement, focus);
});

test('restore detects a live selection before the asynchronous selectionchange event', () => {
  const f = fixture();
  f.select({ notify: false });
  f.list.scrollHeight += 200;
  const token = f.api.beforeRender(f.list, 'one'); f.api.afterRender(f.list, token); f.flush();
  assert.equal(f.api.inspect(f.list).following, false);
  assert.equal(f.list.scrollTop, 1500);
});

test('a range crossing the transcript pauses even when both endpoints are outside it', () => {
  const f = fixture();
  f.select({ inside: false, crossing: true });
  f.list.scrollHeight += 100; f.resize();
  assert.equal(f.api.inspect(f.list).following, false);
  assert.equal(f.list.scrollTop, 1500);
});

test('composer or outside ranges and collapsed message carets do not change follow intent', () => {
  const f = fixture();
  f.select({ inside: false }); f.list.scrollHeight += 100; f.resize();
  assert.equal(f.api.inspect(f.list).following, true);
  assert.equal(f.list.scrollTop, 1600);
  f.select({ collapsed: true }); f.list.scrollHeight += 100; f.resize();
  assert.equal(f.api.inspect(f.list).following, true);
  assert.equal(f.list.scrollTop, 1700);
});

test('selection clearing preserves the current position and does not restore an old anchor', () => {
  const f = fixture();
  f.select();
  f.list.scrollTop = 1400; // Selection dragging can move the browser before scroll is delivered.
  f.list.scrollHeight += 200;
  const writes = f.writes.length;
  f.clearSelection();
  assert.equal(f.writes.length, writes);
  assert.equal(f.api.inspect(f.list).following, false);
  f.resize();
  assert.equal(f.list.scrollTop, 1400);
  assert.equal(f.api.inspect(f.list).anchor.scrollTop, 1400);
});

test('held selections prevent bottom reattachment; clearing permits a deliberate downward return', () => {
  const f = fixture();
  f.select(); f.scroll(1450); f.scroll(1500);
  assert.equal(f.api.inspect(f.list).following, false);
  f.clearSelection(); f.wheel(-10, 1490); f.wheel(10, 1500);
  assert.equal(f.api.inspect(f.list).following, true);
  f.advance(250); f.list.scrollHeight += 100; f.resize();
  assert.equal(f.list.scrollTop, 1600);
});

test('explicit follow overrides an unchanged selection but a newly extended range pauses again', () => {
  const f = fixture();
  f.select(); f.list.scrollHeight += 100; f.resize();
  f.api.follow(f.list, { behavior: 'instant' }); f.advance(200);
  assert.equal(f.api.inspect(f.list).following, true);
  f.list.scrollHeight += 100; f.resize();
  assert.equal(f.list.scrollTop, 1700);
  f.select({ offset: 15 });
  assert.equal(f.api.inspect(f.list).following, false);
  f.list.scrollHeight += 100; f.resize();
  assert.equal(f.list.scrollTop, 1700);
});

test('a new selection stops smooth navigation and its stale settle timer', () => {
  const f = fixture();
  f.doc.body.classList.contains = () => false;
  f.scroll(500); f.api.follow(f.list, { behavior: 'smooth' }); f.scroll(1100);
  f.select();
  assert.equal(f.api.inspect(f.list).navigating, false);
  assert.equal(f.api.inspect(f.list).following, false);
  assert.equal(f.timers.size, 0);
  assert.ok(f.writes.some(value => value.top === 1100 && value.behavior === 'instant'));
  f.advance(400); f.clearSelection(); f.resize();
  assert.equal(f.list.scrollTop, 1100);
});

test('selection opt-out is remembered only for its conversation, even while old DOM is being replaced', () => {
  const f = fixture();
  f.select();
  let token = f.api.beforeRender(f.list, 'two'); f.list.dataset.conversationId = 'two'; f.api.afterRender(f.list, token); f.flush();
  assert.equal(f.api.inspect(f.list).following, true, 'old selected nodes cannot detach the next conversation');
  f.clearSelection();
  token = f.api.beforeRender(f.list, 'one'); f.list.dataset.conversationId = 'one'; f.api.afterRender(f.list, token); f.flush();
  assert.equal(f.api.inspect(f.list).following, false);
  assert.equal(f.list.scrollTop, 1500);
});

test('selection pause clears pending owned positioning and destroy removes selection listeners', () => {
  const f = fixture();
  f.list.scrollHeight += 1; f.resize();
  f.select(); f.scroll(1500.75);
  assert.equal(f.api.inspect(f.list).anchor.scrollTop, 1500.75);
  f.clearSelection();
  const token = f.api.beforeRender(f.list, 'one'); f.api.afterRender(f.list, token);
  assert.equal(f.doc.listeners.get('selectionchange').size, 1);
  f.api.destroy(f.list);
  assert.equal(f.doc.listeners.get('selectionchange').size, 0);
  assert.equal(f.frames.size, 0);
  const writes = f.writes.length;
  f.select(); f.advance(400); f.flush();
  assert.equal(f.writes.length, writes);
});
