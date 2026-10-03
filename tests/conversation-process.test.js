const test = require('node:test');
const assert = require('node:assert/strict');

// This controller only moves owned DOM, sets attributes and renders existing
// tool records. Native interaction/streaming are exercised by renderer tests.
class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {}; this.className = ''; this._textContent = ''; this.hidden = false; this.open = false; this.parentElement = null; }
  get textContent() { return this._textContent + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._textContent = String(value); this.children = []; }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, reference) { node.remove(); const index = reference ? this.children.indexOf(reference) : this.children.length; this.children.splice(index, 0, node); node.parentElement = this; return node; }
  remove() { if (this.parentElement) { const parent = this.parentElement; parent.children.splice(parent.children.indexOf(this), 1); this.parentElement = null; } }
  replaceChildren(...nodes) { for (const node of [...this.children]) node.remove(); this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener() {} // Keyboard behavior uses the real DOM fixture in conversation-tool-text.
  getAttribute(name) { return this.attributes[name] ?? null; }
  matches(selector) {
    if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
    const data = /^\[data-([a-z-]+)="([^"]+)"\]$/.exec(selector);
    if (data) return this.dataset[data[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] === data[2];
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector) {
    if (selector.startsWith(':scope > ')) return this.children.filter(node => node.matches(selector.slice(9)));
    return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
globalThis.document = { createElement: tag => new Element(tag) };
globalThis.ToolScheduler = require('../app/tool-scheduler');
const Process = require('../app/conversation-process');
const tool = (id = 'tool1') => ({ id, type: 'read', status: 'completed', request: { type: 'read', id: 'note1' }, result: { text: 'Recorded output' } });
function fixture({ activities = true, tools = true, message: extraMessage = {}, run: extraRun = {} } = {}) {
  const message = { id: 'message:one', role: 'agent', activities: activities ? [{ id: 'event1', kind: 'commentary', text: 'Recorded progress' }] : [], ...extraMessage };
  const run = { id: 'run1', status: 'completed', toolCalls: tools ? [tool()] : [], ...extraRun };
  const wrapper = new Element('article'); wrapper.dataset.messageId = message.id;
  const body = new Element('div'); body.className = 'message-body'; wrapper.append(body);
  let timeline;
  if (message.activities.length || message.steps?.length) {
    const feed = new Element('details'); feed.className = 'agent-progress'; feed.dataset.progressKey = 'feed'; feed.open = !!message.live;
    const summary = new Element('summary'); timeline = new Element('ol'); timeline.className = 'progress-timeline';
    const row = new Element('li'); row.dataset.activityId = 'event1'; timeline.append(row); feed.append(summary, timeline); wrapper.insertBefore(feed, body);
  }
  return { wrapper, message, run, timeline, body };
}
const nav = wrapper => wrapper.querySelector('.conversation-process-navigation');
const panel = (wrapper, name) => wrapper.querySelector(`[data-live-key="process-${name}-panel"]`);

test('selection is pure, prefers an available saved tab, and falls back to recorded content', () => {
  const value = fixture({ message: { processView: 'progress' }, run: { toolLedgerPins: { ledger: true } } });
  const before = JSON.stringify({ message: value.message, run: value.run });
  assert.equal(Process.chooseView(value.message, value.run), 'progress');
  assert.equal(JSON.stringify({ message: value.message, run: value.run }), before);
  assert.equal(Process.chooseView({ processView: 'tools', steps: [{}] }, {}), 'progress');
  assert.equal(Process.chooseView({ processView: 'progress' }, { toolCalls: [tool()] }), 'tools');
  assert.equal(Process.chooseView({ processView: 'unknown', activities: [{text:'Recorded detail'}] }, {}), 'progress');
  assert.equal(Process.chooseView({}, {}), null);
});

test('only explicit current tool inspection pins affect the fallback choice', () => {
  for (const pins of [{ ledger: true }, { tool1: true }, { 'raw:tool1': true }]) {
    assert.equal(Process.chooseView({ activities: [{}] }, { toolCalls: [tool()], toolLedgerPins: pins }), 'tools');
  }
  for (const pins of [{ ledger: 'true' }, { 'raw:removed': true }, { tool1: false }]) {
    assert.equal(Process.chooseView({ activities: [{text:'Recorded detail'}] }, { toolCalls: [tool()], toolLedgerPins: pins }), 'progress');
  }
});

test('compose moves the original timeline into stable panels and leaves the answer outside', () => {
  const value = fixture(); const { wrapper, message, run, timeline, body } = value;
  const feed = Process.compose(wrapper, message, run);
  assert.deepEqual(wrapper.children, [feed, body]);
  assert.equal(panel(wrapper, 'progress').children[0], timeline);
  assert.equal(nav(wrapper).hidden, false);
  assert.equal(nav(wrapper).dataset.progressCount, '1');
  assert.equal(nav(wrapper).dataset.toolCount, '1');
  assert.equal(nav(wrapper).dataset.messageId, message.id);
  assert.equal(nav(wrapper).dataset.view, 'progress');
  assert.equal(panel(wrapper, 'progress').hidden, false);
  assert.equal(panel(wrapper, 'tools').hidden, true);
  assert.equal(panel(wrapper, 'tools').getAttribute('role'), 'tabpanel');
  assert.notEqual(panel(wrapper, 'tools').id, panel(wrapper, 'progress').id);
  assert.equal(feed.children[0].tagName, 'SUMMARY');
  assert.equal(feed.children[0].querySelector('.conversation-process-navigation'), null);
  assert.equal(wrapper.querySelectorAll('.tool-ledger').length, 1);
  assert.equal(wrapper.querySelector('.tool-ledger').tagName, 'DIV');
});

test('panels and navigation retain identity when the first tool arrives', () => {
  const { wrapper, message, run, timeline } = fixture({ tools: false });
  Process.compose(wrapper, message, run);
  const progress = panel(wrapper, 'progress'), tools = panel(wrapper, 'tools'), navigation = nav(wrapper);
  assert.equal(navigation.hidden, true); assert.equal(tools.hidden, true);
  run.toolCalls.push(tool()); Process.compose(wrapper, message, run);
  assert.equal(panel(wrapper, 'progress'), progress); assert.equal(panel(wrapper, 'tools'), tools);
  assert.equal(nav(wrapper), navigation); assert.equal(navigation.hidden, false);
  assert.equal(progress.children[0], timeline); assert.equal(navigation.dataset.toolCount, '1');
});

test('select changes only visibility and navigation selection, preserving the recorded DOM and state', () => {
  const { wrapper, message, run } = fixture(); Process.compose(wrapper, message, run);
  const row = wrapper.querySelector('.tool-ledger-row'), raw = wrapper.querySelector('.tool-ledger-raw');
  const before = JSON.stringify({ message, run });
  assert.equal(Process.select(wrapper, 'tools'), 'tools');
  assert.equal(panel(wrapper, 'tools').hidden, false); assert.equal(panel(wrapper, 'progress').hidden, true);
  assert.equal(Process.select(wrapper, 'progress'), 'progress');
  assert.equal(wrapper.querySelector('.tool-ledger-row'), row); assert.equal(wrapper.querySelector('.tool-ledger-raw'), raw);
  assert.equal(JSON.stringify({ message, run }), before);
});

test('tool-only historical records get a truthful outer disclosure and no redundant tab bar', () => {
  for (const status of ['failed', 'interrupted', 'unknown']) {
    const { wrapper, message, run } = fixture({ activities: false, run: { status } });
    const feed = Process.compose(wrapper, message, run);
    assert.equal(feed.dataset.progressKey, 'feed'); assert.equal(feed.open, false);
    assert.equal(nav(wrapper).hidden, true); assert.equal(nav(wrapper).dataset.view, 'tools');
    assert.equal(panel(wrapper, 'tools').hidden, false); assert.equal(panel(wrapper, 'progress').hidden, true);
    assert.notEqual(feed.children[0].children[0].textContent, '已完成');
    assert.equal(Process.select(wrapper, 'progress'), 'tools');
  }
});

test('explicit outer-close beats raw inspection and live auto-opening; defaults never write pins', () => {
  for (const activities of [true, false]) {
    const { wrapper, message, run } = fixture({ activities, message: { live: true, progressPins: { feed: false } }, run: { toolLedgerPins: { 'raw:tool1': true } } });
    assert.equal(Process.compose(wrapper, message, run).open, false);
    assert.equal(nav(wrapper).dataset.view, 'tools');
    assert.equal(wrapper.querySelector('.tool-ledger-raw').open, true);
  }
  const value = fixture({ run: { toolLedgerPins: { ledger: true } } });
  assert.equal(Process.compose(value.wrapper, value.message, value.run).open, true);
  assert.equal(value.message.progressPins, undefined);
});

test('embedded ledger removes only the outer disclosure; standalone and row/raw pins remain intact', () => {
  const run = { status: 'completed', toolCalls: [tool()], toolLedgerPins: { ledger: true, tool1: true, 'raw:tool1': true } };
  const standalone = ToolScheduler.card(run), embedded = ToolScheduler.card(run, { embedded: true });
  assert.equal(standalone.tagName, 'DETAILS'); assert.equal(standalone.open, true); assert.equal(standalone.children[0].tagName, 'SUMMARY');
  assert.equal(embedded.tagName, 'DIV'); assert.equal(embedded.children.length, 1); assert.equal(embedded.children[0].dataset.toolId, 'tool1');
  assert.equal(embedded.children[0].open, true); assert.equal(embedded.querySelector('.tool-ledger-raw').open, true);
  assert.equal(embedded.querySelector('.tool-ledger-raw').querySelectorAll('pre').length, 2);
});

test('no records and user messages do not create empty process UI', () => {
  const empty = fixture({ activities: false, tools: false });
  assert.equal(Process.compose(empty.wrapper, empty.message, empty.run), null);
  assert.deepEqual(empty.wrapper.children, [empty.body]);
  const user = fixture({ activities: false, message: { role: 'user' } });
  assert.equal(Process.compose(user.wrapper, user.message, user.run), null);
});

test('ledger summary uses the recorded source title and keeps unknown tool outcomes unconfirmed', () => {
  const call = { ...tool(), status: undefined, result: { result: { title: '已读取的课程原件.pdf', text: 'Recorded body' } } };
  const card = ToolScheduler.card({ toolCalls: [call], status: 'failed' }, { embedded: true });
  const title = card.children[0].children[0].textContent;
  assert.match(title, /已读取的课程原件\.pdf/);
  assert.match(title, /未确认/);
  assert.doesNotMatch(title, /note1|undefined|完成/);
  const capabilities = ToolScheduler.card({ toolCalls: [{ id: 'cap', type: 'capabilities', status: 'completed', request: {} }] });
  assert.equal(capabilities.querySelector('.tool-ledger-row').children[0].textContent, '操作说明 · 完成');
});

test('stage-only histories default to actual tool receipts without erasing the stage timeline', () => {
  const value = fixture({ activities:false, message:{steps:[{id:'prep',text:'准备上下文',status:'done'}]} });
  Process.compose(value.wrapper,value.message,value.run);
  assert.equal(nav(value.wrapper).dataset.view,'tools');
  assert.ok(panel(value.wrapper,'progress').querySelector('.conversation-reasoning-note'));
  assert.equal(value.message.processView,undefined);
  assert.equal(Process.chooseView({...value.message,processView:'progress'},value.run),'progress');
  const withReasoning={...value.message,activities:[{kind:'summary',text:'实际内容'}]};
  assert.equal(Process.chooseView(withReasoning,value.run),'progress');
  Process.compose(value.wrapper,withReasoning,value.run);
  assert.equal(panel(value.wrapper,'progress').querySelector('.conversation-reasoning-note'),null);
});
