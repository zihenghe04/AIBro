const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { parseHTML } = require(process.env.AIBRO_TEST_DOM_MODULE || 'linkedom');
const ROOT = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'app/app.js'), 'utf8');
const pinStart = app.indexOf("document.addEventListener('click'", app.indexOf('// 工具执行记录的开合'));
const pinEnd = app.indexOf('// Tab choices belong', pinStart);
assert.ok(pinStart > 0 && pinEnd > pinStart);
const long = suffix => 'Fictional content. '.repeat(800) + suffix;
const makeCall = (text = long('TAIL-A')) => ({ id: 'tool-1', type: 'read', status: 'completed', request: { id: 'note-1' }, result: { text } });
function fixture({ calls = [makeCall()], run: runFields = {}, message: messageFields = {}, language = 'zh' } = {}) {
  const { window } = parseHTML('<html><body></body></html>');
  const { document } = window;
  Object.defineProperty(window.HTMLElement.prototype, 'open', { configurable: true, get() { return this.hasAttribute('open'); }, set(value) { value ? this.setAttribute('open', '') : this.removeAttribute('open'); } });
  let focused = document.body, selection = null, saves = 0;
  window.HTMLElement.prototype.focus = function() { focused = this; };
  Object.defineProperty(document, 'activeElement', { get: () => focused });
  const context = { document, console, Date, getSelection: () => selection, WorkstationI18n: { getLanguage: () => language } };
  context.window = context; vm.createContext(context);
  for (const file of ['tool-scheduler.js', 'agent-progress.js', 'conversation-process.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', file), 'utf8'), context);
  const run = { id: 'run-1', status: 'completed', toolCalls: calls, ...runFields };
  const message = { id: 'msg-1', role: 'agent', runId: run.id, activities: [{ id: 'activity-1', kind: 'commentary', status: 'completed', text: 'Recorded event' }], ...messageFields };
  context.state = { agentRuns: [run], conversations: [{ id: 'conv-1', messages: [message] }] };
  context.save = () => saves++;
  vm.runInContext(app.slice(pinStart, pinEnd), context);
  // LinkeDOM has no native details default action. Keep that one platform
  // action explicit; the actual production click/pin/keyboard handlers run.
  document.addEventListener('click', event => {
    const summary = event.target.closest?.('summary');
    if (!summary || event.defaultPrevented) return;
    summary.parentElement.open = !summary.parentElement.open;
    summary.parentElement.dispatchEvent(new window.Event('toggle'));
  });
  const mount = () => {
    const wrapper = document.createElement('article'); wrapper.className = 'message-wrap'; wrapper.dataset.messageId = message.id;
    wrapper.innerHTML = context.AgentProgress.markup(message) + '<div class="message-body">Final answer remains intact</div>';
    context.ConversationProcess.compose(wrapper, message, run); return wrapper;
  };
  let wrapper = mount(); document.body.append(wrapper);
  const key = (node, value, extras = {}) => {
    const event = new window.Event('keydown', { bubbles: true, cancelable: true }); Object.assign(event, { key: value, ...extras });
    node.dispatchEvent(event); return event;
  };
  return { context, document, run, message, saves: () => saves,
    get wrapper() { return wrapper; },
    field: (index = 0) => wrapper.querySelectorAll('.tool-ledger-text-field')[index],
    update() { const next = mount(); context.AgentProgress.patchLive(wrapper, next); if (!wrapper.isConnected) wrapper = next; },
    click(node) { node.click(); }, key,
    focus(node) { node.focus(); },
    select(node) { selection = { rangeCount: 1, isCollapsed: false, anchorNode: node, focusNode: node, anchorOffset: 5, focusOffset: 15, toString: () => 'selected', setBaseAndExtent(a, ao, b, bo) { this.anchorNode = a; this.anchorOffset = ao; this.focusNode = b; this.focusOffset = bo; } }; return selection; },
  };
}
const trigger = field => field.querySelector(':scope > summary');
const full = field => field.querySelector(':scope > .tool-ledger-full-text');

test('complete recorded tail mounts only on explicit expansion, stays escaped, and is released on collapse', () => {
  const text = long('<img src=x onerror=bad()>\nTAIL-END'); const f = fixture({ calls: [makeCall(text)] });
  const field = f.field(), raw = f.wrapper.querySelector('.tool-ledger-raw').textContent;
  assert.equal(full(field), null); assert.equal(field.textContent.includes('TAIL-END'), false);
  const before = JSON.stringify(f.run.toolCalls); f.click(trigger(field));
  assert.equal(full(field).textContent, text); assert.equal(full(field).querySelector('img'), null);
  assert.equal(full(field).getAttribute('tabindex'), '0'); assert.equal(full(field).getAttribute('aria-label'), '结果 · text');
  assert.equal(f.run.toolLedgerPins[field.dataset.toolLedgerKey], true); assert.equal(f.saves(), 1);
  f.click(trigger(field)); assert.equal(full(field), null); assert.equal(f.run.toolLedgerPins[field.dataset.toolLedgerKey], false);
  assert.equal(f.wrapper.querySelector('.tool-ledger-raw').textContent, raw); assert.equal(JSON.stringify(f.run.toolCalls), before);
});

test('a pinned field keeps the current tool inspection available after completion, while explicit outer closes win', () => {
  const f = fixture({ run: { status: 'running' }, message: { live: true } });
  f.run.toolCalls[0].status = 'running'; f.update();
  f.click(trigger(f.field())); f.run.status = 'completed'; f.run.toolCalls[0].status = 'completed'; f.message.live = false; f.update();
  assert.equal(f.field().open, true); assert.ok(full(f.field()));
  assert.equal(f.wrapper.querySelector('.tool-ledger-row').open, true);
  assert.equal(f.wrapper.querySelector('.conversation-process-navigation').dataset.view, 'tools');
  f.run.toolLedgerPins['tool-1'] = false; f.message.progressPins = { feed: false }; f.update();
  assert.equal(f.wrapper.querySelector('.tool-ledger-row').open, false);
  assert.equal(f.wrapper.querySelector('.agent-progress').open, false);
});

test('an unchanged closed preview refreshes its retained payload before DOM equality, never opening stale output', () => {
  const f = fixture(), field = f.field();
  f.run.toolCalls[0].result.text = long('TAIL-B'); f.update();
  assert.equal(f.field(), field); assert.equal(full(field), null);
  f.click(trigger(field)); assert.equal(full(field).textContent, long('TAIL-B')); assert.equal(full(field).textContent.includes('TAIL-A'), false);
});

test('unrelated live records preserve the open field, full text node, keyboard focus and selection', () => {
  const f = fixture(); f.click(trigger(f.field()));
  const field = f.field(), body = full(field), text = body.firstChild, answer = f.wrapper.querySelector('.message-body');
  f.focus(body); const selection = f.select(text);
  f.run.toolCalls.push({ ...makeCall('Short new response'), id: 'tool-2' }); f.update();
  assert.equal(f.field(), field); assert.equal(full(field), body); assert.equal(body.firstChild, text);
  assert.equal(f.document.activeElement, body); assert.equal(selection.anchorNode, text); assert.equal(selection.anchorOffset, 5);
  assert.equal(f.wrapper.querySelector('.message-body').textContent, answer.textContent);
  assert.equal(f.saves(), 1, 'Renderer never manufactures another user pin');
});

test('run, tool and parameter/result field identities isolate equal-prefix records and stale pins', () => {
  const entry = makeCall(long('RESULT')); entry.request.text = long('PARAMETER');
  const f = fixture({ calls: [entry] }); const parameter = f.field(0), result = f.field(1);
  assert.notEqual(parameter.dataset.toolLedgerKey, result.dataset.toolLedgerKey);
  f.click(trigger(parameter)); assert.equal(full(parameter).textContent, entry.request.text); assert.equal(full(result), null);
  f.run.id = 'run-2'; f.message.runId = f.run.id; entry.request.text = long('NEW-RUN'); f.update();
  assert.notEqual(f.field(0), parameter); assert.equal(f.field(0).open, false); assert.equal(full(f.field(0)), null);
  f.click(trigger(f.field(0))); assert.equal(full(f.field(0)).textContent, long('NEW-RUN'));
  delete entry.request.text; f.update(); assert.equal(f.context.ToolScheduler.inspectingCall(f.run, entry), false);
});

test('Enter uses the real pin path and Escape closes only this field, retaining its summary focus', () => {
  const f = fixture(), field = f.field(), row = field.closest('.tool-ledger-row'); row.open = true;
  f.wrapper.querySelector('.agent-progress').open = true;
  const event = f.key(trigger(field), 'Enter'); assert.equal(event.defaultPrevented, true); assert.equal(field.open, true);
  f.focus(full(field)); const escape = f.key(full(field), 'Escape');
  assert.equal(escape.defaultPrevented, true); assert.equal(field.open, false); assert.equal(full(field), null);
  assert.equal(row.open, true); assert.equal(f.wrapper.querySelector('.agent-progress').open, true);
  assert.equal(f.document.activeElement, trigger(field));
  for (const extra of [{ repeat: true }, { isComposing: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
    assert.equal(f.key(trigger(field), 'Enter', extra).defaultPrevented, false); assert.equal(field.open, false);
  }
  assert.equal(f.key(trigger(field), 'Escape').defaultPrevented, false, 'Closed field does not swallow a higher-level Escape');
});

test('during a shared close animation the old body survives the patch, then releases at actual close', () => {
  const f = fixture(); f.click(trigger(f.field())); const field = f.field(), body = full(field);
  field._interactionDesiredOpen = false; f.run.toolLedgerPins[field.dataset.toolLedgerKey] = false;
  f.run.toolCalls.push({ ...makeCall('Another record'), id: 'tool-2' }); f.update();
  assert.equal(full(field), body); assert.equal(field.open, true);
  field.open = false; delete field._interactionDesiredOpen;
  field.dispatchEvent(new f.document.defaultView.Event('toggle'));
  assert.equal(full(field), null);
  f.click(trigger(field)); assert.equal(full(field).textContent, f.run.toolCalls[0].result.text);
});

test('collapsed large histories mount no readable full-text duplicates; short values stay inline', () => {
  const calls = Array.from({ length: 90 }, (_, i) => ({ ...makeCall(long('TAIL-' + i)), id: 'tool-' + i }));
  calls.push({ ...makeCall('Short\ncomplete output'), id: 'short' });
  const f = fixture({ calls, language: 'en' });
  assert.equal(f.wrapper.querySelectorAll('.tool-ledger-text-field').length, 90);
  assert.equal(f.wrapper.querySelectorAll('.tool-ledger-full-text').length, 0);
  assert.ok(trigger(f.field()).textContent.includes('Show full text'));
  assert.equal(f.wrapper.querySelector('[data-tool-id="short"] .tool-ledger-line').textContent.includes('note-1'), true);
  assert.ok(f.wrapper.querySelector('[data-tool-id="short"] [data-live-key="result"]').textContent.includes('Short\ncomplete output'));
  f.click(trigger(f.field(89))); assert.equal(f.wrapper.querySelectorAll('.tool-ledger-full-text').length, 1);
  f.click(trigger(f.field(89))); assert.equal(f.wrapper.querySelectorAll('.tool-ledger-full-text').length, 0);
});

test('only real string fields expose full-text controls; raw data and nested result content remain untouched', () => {
  const call = makeCall(); call.result = { result: { text: long('NESTED-RECEIPT'), complex: { text: long('JSON-ONLY') }, empty: '', number: 42 } };
  const f = fixture({ calls: [call] });
  assert.equal(f.wrapper.querySelectorAll('.tool-ledger-text-field').length, 1);
  f.click(trigger(f.field())); assert.equal(full(f.field()).textContent, call.result.result.text);
  const raw = f.wrapper.querySelector('.tool-ledger-raw'); assert.ok(raw.textContent.includes('JSON-ONLY'));
  assert.equal(raw.querySelectorAll('pre').length, 2);
  assert.equal(JSON.parse(raw.querySelectorAll('pre')[1].textContent).result.complex.text, call.result.result.complex.text);
});
