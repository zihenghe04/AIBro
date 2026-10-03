const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { parseHTML } = require(process.env.AIBRO_TEST_DOM_MODULE || 'linkedom');
const ROOT = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'app/app.js'), 'utf8');
const start = app.indexOf("document.addEventListener('click'", app.indexOf('// 执行过程段的“呼吸”状态'));
const end = app.indexOf('// Tab choices belong', start);
assert.ok(start > 0 && end > start);

function fixture(options = {}) {
  const { window } = parseHTML('<html><body></body></html>'), { document } = window;
  Object.defineProperty(window.HTMLElement.prototype, 'open', { configurable: true, get() { return this.hasAttribute('open'); }, set(value) { value ? this.setAttribute('open', '') : this.removeAttribute('open'); } });
  let focus = document.body, selection = null, saves = 0;
  window.HTMLElement.prototype.focus = function() { focus = this; };
  Object.defineProperty(document, 'activeElement', { get: () => focus });
  const context = { document, console, Date, getSelection: () => selection, WorkstationI18n: { getLanguage: () => 'zh' } };
  context.window = context; vm.createContext(context);
  for (const file of ['conversation-flow.js', 'stream-code.js', 'stream-markdown.js', 'streaming-body.js', 'tool-scheduler.js', 'agent-progress.js', 'conversation-process.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', file), 'utf8'), context);
  }
  const run = { id: 'run-1', status: 'running', toolCalls: [] };
  const message = { id: 'message-1', role: 'agent', runId: run.id, live: true, text: '', steps: [{ id: 'step-1', text: '准备资料', status: 'done' }] };
  const flow = context.ConversationFlow.create(message);
  context.state = { agentRuns: [run], conversations: [{ messages: [message] }] };
  context.save = () => saves++;
  vm.runInContext(app.slice(start, end), context);
  document.addEventListener('click', event => {
    const summary = event.target.closest?.('summary');
    if (!summary || event.defaultPrevented) return;
    summary.parentElement.open = !summary.parentElement.open;
    summary.parentElement.dispatchEvent(new window.Event('toggle'));
  });
  function render() {
    const node = document.createElement('article'); node.className = 'message-wrap'; node.dataset.messageId = message.id;
    node.innerHTML = context.AgentProgress.markup(message);
    const body = document.createElement('div'); body.className = 'message-body'; body.textContent = message.text; node.append(body);
    context.ConversationProcess.compose(node, message, run, options); return node;
  }
  let wrapper = render(); document.body.append(wrapper);
  return { context, document, run, message, flow, saves: () => saves, get wrapper() { return wrapper; },
    update() { const next = render(); context.AgentProgress.patchLive(wrapper, next); if (!wrapper.isConnected) wrapper = next; },
    tool(id, text = 'Recorded output', status = 'completed') { const call = { id, type: 'read', status, request: { type: 'read', id: 'note-1' }, result: { text } }; run.toolCalls.push(call); flow.tool(call); return call; },
    select(node, from = 2, to = 8) { selection = { rangeCount: 1, isCollapsed: false, anchorNode: node, focusNode: node, anchorOffset: from, focusOffset: to, toString: () => 'selected', getRangeAt() { return { startContainer: this.anchorNode, startOffset: this.anchorOffset }; }, setBaseAndExtent(a, ao, b, bo) { Object.assign(this, { anchorNode: a, anchorOffset: ao, focusNode: b, focusOffset: bo }); } }; return selection; },
  };
}
const rows = f => [...f.wrapper.querySelector('.conversation-flow').children];

test('real recorder produces one ordered process with safe inline prose, exact tools, collapsed diagnostics and one final body', () => {
  const f = fixture();
  f.flow.activity({ id: 'reason-1', kind: 'summary', attemptId: 'attempt-1', text: '先核对记录。\n随后检查日期。', status: 'completed' });
  f.flow.response('attempt-1', '<img src=x onerror=bad()>先读取资料', { status: 'completed' });
  f.tool('read-1', '真实读取结果');
  f.flow.response('attempt-2', '最终回答', { status: 'completed' }); f.message.text = '最终回答';
  f.message.live = false; f.run.status = 'completed';
  const stored = JSON.stringify([f.message, f.run]); f.update();
  assert.deepEqual(rows(f).map(row => row.dataset.flowKind), ['reasoning', 'response', 'tool']);
  assert.equal(f.wrapper.querySelectorAll('[role="tab"],.conversation-process-navigation').length, 0);
  assert.equal(f.wrapper.querySelectorAll('.tool-ledger-row').length, 1);
  assert.match(f.wrapper.querySelector('.tool-ledger-row').textContent, /真实读取结果/);
  assert.equal(f.wrapper.querySelector('img'), null);
  assert.match(f.wrapper.querySelector('.conversation-flow-response').textContent, /<img src=x onerror=bad\(\)>/);
  assert.equal(f.wrapper.textContent.split('最终回答').length - 1, 1);
  assert.equal(f.wrapper.querySelector('.conversation-flow-diagnostics').open, false);
  assert.equal(f.wrapper.querySelector('.conversation-flow-diagnostics').textContent, '阶段记录准备资料');
  assert.equal(JSON.stringify([f.message, f.run]), stored, 'composition does not write pins or records');
});

test('reasoning defaults closed with a latest-line preview while explicit keyboard/click intent survives updates', () => {
  const f = fixture(); const item = f.flow.activity({ id: 'r1', kind: 'summary', attemptId: 'a1', text: '完整首段\n最新一行', status: 'running' }); f.update();
  let detail = f.wrapper.querySelector('.conversation-flow-reasoning-details');
  assert.equal(detail.open, false); assert.equal(detail.querySelector('.conversation-flow-reasoning-preview').textContent, '最新一行');
  assert.equal(detail.querySelector('.conversation-flow-text').textContent, item.text);
  detail.querySelector('summary').click();
  assert.equal(f.message.progressPins['flow:' + item.id], true);
  f.flow.activity({ id: 'r1', kind: 'summary', attemptId: 'a1', text: '完整首段\n最终一行', status: 'completed' }); f.message.live = false; f.update();
  assert.equal(f.wrapper.querySelector('.conversation-flow-reasoning-details'), detail); assert.equal(detail.open, true);
  detail.querySelector('summary').click(); f.update(); assert.equal(detail.open, false);
  assert.equal(f.saves(), 2);
});

test('same-name tool calls retain distinct original identities and a response followed by tools is not hidden', () => {
  const f = fixture(); f.flow.response('a1', '继续查看资料', { status: 'completed' }); f.message.text = '继续查看资料';
  f.tool('read-1', 'A'); f.tool('read-2', 'B'); f.update();
  assert.deepEqual(rows(f).map(row => row.dataset.flowKind), ['response', 'tool', 'tool']);
  assert.deepEqual([...f.wrapper.querySelectorAll('.tool-ledger-row')].map(node => node.dataset.toolId), ['read-1', 'read-2']);
  assert.equal(f.run.toolCalls[0].result.text, 'A'); assert.equal(f.run.toolCalls[1].result.text, 'B');
});

test('new process items preserve the materialized long tool field, raw nodes, focus, selection and exact current payload', () => {
  const f = fixture(), long = suffix => 'Fictional recorded output. '.repeat(700) + suffix;
  const call = f.tool('read-1', long('TAIL-A')); f.update();
  const field = f.wrapper.querySelector('.tool-ledger-text-field'); field.querySelector('summary').click();
  const full = field.querySelector('.tool-ledger-full-text'), raw = f.wrapper.querySelector('.tool-ledger-raw'), text = full.firstChild;
  full.focus(); const selection = f.select(text); call.result.text = long('TAIL-B');
  f.flow.response('a2', '根据结果继续核对。'); f.tool('read-2', 'New result'); f.update();
  assert.equal(f.wrapper.querySelector('.tool-ledger-text-field'), field);
  assert.equal(field.querySelector('.tool-ledger-full-text'), full); assert.equal(full.firstChild, text);
  assert.equal(f.wrapper.querySelector('.tool-ledger-raw'), raw); assert.equal(f.document.activeElement, full);
  assert.equal(selection.anchorNode, text); assert.equal(selection.anchorOffset, 2);
  assert.match(full.textContent, /TAIL-B$/); assert.equal(f.saves(), 1);
});

test('inline response edits remap selected surviving text without replacing its node', () => {
  const f = fixture(); f.flow.response('a1', 'start selected end'); f.update();
  const text = f.wrapper.querySelector('.conversation-flow-response .conversation-flow-text').firstChild;
  const selection = f.select(text, 6, 14);
  f.flow.response('a1', 'a longer prefix selected end'); f.update();
  assert.equal(f.wrapper.querySelector('.conversation-flow-response .conversation-flow-text').firstChild, text);
  assert.equal(selection.anchorOffset, 16); assert.equal(selection.focusOffset, 24);
  assert.equal(text.nodeValue.slice(selection.anchorOffset, selection.focusOffset), 'selected');
});

test('settling retains an actively read process but an explicit outer close still wins', () => {
  const f = fixture(); f.flow.response('a1', '可选中的真实中间说明'); f.update();
  const feed = f.wrapper.querySelector('.agent-progress'), text = f.wrapper.querySelector('.conversation-flow-text').firstChild;
  f.select(text); f.message.live = false; f.run.status = 'completed'; f.update(); assert.equal(feed.open, true);
  f.message.progressPins = { feed: false }; f.update(); assert.equal(feed.open, false);
});

test('explicit closed tool pins are not reopened by a stale selection and missing ledger data never invents a receipt', () => {
  const f = fixture(); f.tool('read-1'); f.update();
  const row = f.wrapper.querySelector('.tool-ledger-row'); row.open = true;
  f.select(row.querySelector('.tool-ledger-raw pre').firstChild); f.run.toolLedgerPins = { 'read-1': false }; f.update(); assert.equal(row.open, false);
  f.run.toolCalls = []; f.update();
  assert.equal(f.wrapper.querySelectorAll('.tool-ledger-row').length, 0);
  assert.match(f.wrapper.querySelector('.conversation-flow').textContent, /详细记录不可用/);
  assert.equal(f.wrapper.querySelector('.conversation-flow').querySelector('details'), null);
});

test('a final-only response adds no empty process shell or invented content', () => {
  const f = fixture(); f.message.steps = []; f.flow.response('final', 'Only answer', { status: 'completed' }); f.message.text = 'Only answer'; f.message.live = false; f.update();
  assert.equal(f.wrapper.querySelector('.agent-progress'), null); assert.equal(f.wrapper.textContent, 'Only answer');
});

test('child prose and reasoning carry their exact delegation title and never masquerade as the main answer', () => {
  const f = fixture(); f.run.delegations = [{ id: 'child-1', title: '核验 <b>原件</b>' }];
  f.flow.response('main-a1', '主任务中间说明');
  f.flow.activity({ id: 'reason-child', kind: 'summary', attemptId: 'child-a1', text: '子任务的实际思考', status: 'completed' }, { parentId: 'child-1' });
  f.flow.response('child-a1', '子任务的实际结论', { parentId: 'child-1', status: 'completed' });
  f.flow.response('orphan-a1', '缺少名称的子任务结论', { parentId: 'missing-child', status: 'completed' });
  f.update();
  assert.equal(rows(f)[0].querySelector('.conversation-flow-owner'), null);
  assert.deepEqual([...f.wrapper.querySelectorAll('.conversation-flow-owner')].map(node => node.textContent),
    ['研究子任务 · 核验 <b>原件</b>', '研究子任务 · 核验 <b>原件</b>', '研究子任务']);
  assert.equal(f.wrapper.querySelector('.conversation-flow-owner b'), null);
  assert.deepEqual(rows(f).map(row => row.dataset.flowParent || null), [null, 'child-1', 'child-1', 'missing-child']);
});


test('flow uses the supplied safe renderer and a bounded cache with stable recorder ownership', () => {
  let parses = 0;
  const renderText = (text, wiki, cache) => {
    if (cache) cache.dependencies = [renderText];
    if (cache?.probeOnly) return '';
    parses++;
    return '<p>' + String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>') + '</p>';
  };
  const f = fixture({ renderText });
  f.flow.response('rich-a1', 'start selected end **bold** <script>bad()</script>'); f.update();
  const body = f.wrapper.querySelector('.conversation-flow-rich'), paragraph = body.querySelector('p'), text = paragraph.firstChild;
  assert.equal(body.querySelector('strong').textContent, 'bold'); assert.equal(body.querySelector('script'), null);
  const selection = f.select(text, 6, 14), before = parses;
  for (let i = 0; i < 12; i++) f.update();
  assert.equal(parses, before, 'unchanged text reuses dependency-validated parser output');
  assert.equal(f.context.StreamMarkdown.inspect().entries, 1);
  f.flow.response('rich-a1', 'a longer prefix selected end **bold** <script>bad()</script>'); f.update();
  assert.equal(f.wrapper.querySelector('.conversation-flow-rich p'), paragraph); assert.equal(paragraph.firstChild, text);
  assert.equal(text.nodeValue.slice(selection.anchorOffset, selection.focusOffset), 'selected');
  assert.equal(f.wrapper.querySelectorAll('.message-body').length, 1, 'intermediate prose never shares final-body ownership');
  f.message.live = false; f.update(); assert.equal(f.context.StreamMarkdown.inspect().entries, 0);
});
