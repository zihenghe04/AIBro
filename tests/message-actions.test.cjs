const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { transformSync } = require('esbuild');
const actions = require('../app/message-actions.js');

const user = { id: 'user-1', role: 'user', text: '原始问题' };
const assistant = { id: 'agent-1', role: 'agent', text: '来源\n\n结论' };
const button = (key, value, label, disabled = false) => ({ dataset: { [key]: value }, textContent: label, title: label + '说明', disabled });
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
class Input extends EventTarget {
  value = '现有草稿'; isConnected = true; focusCount = 0;
  focus() { this.focusCount++; }
  setSelectionRange(start, end) { this.selection = [start, end]; }
}
function controllerFixture(options = {}) {
  const state = { conversation: { id: 'c1', messages: [{ ...user }, { ...assistant }], draftAttachmentIds: ['pdf'] }, input: new Input(), changes: [] };
  state.controller = actions.createQuoteController({ getConversation: () => state.conversation, getInput: () => state.input,
    onChange: value => state.changes.push(value), ...options });
  return state;
}

test('complete quotes preserve blank lines, Unicode, and long material without truncation', () => {
  const body = '观察 👩🏽‍🔬\r\n\r\n' + '证据'.repeat(30000);
  assert.equal(actions.quoteText(body), '> 观察 👩🏽‍🔬\n> \n> ' + '证据'.repeat(30000));
  assert.equal(actions.quoteText(' \n '), '');
});
test('adding a quote preserves existing draft bytes and only adds a separating paragraph', () => {
  assert.equal(actions.appendQuote('  我的草稿  ', '回答'), '  我的草稿  \n\n> 回答\n\n');
  assert.equal(actions.appendQuote('草稿\n', '回答'), '草稿\n\n> 回答\n\n');
  assert.equal(actions.appendQuote('草稿\n\n', '回答'), '草稿\n\n> 回答\n\n');
  assert.equal(actions.appendQuote('草稿', '  '), '草稿');
});
test('the action plan preserves the exact existing handlers and adds user copy and quote', () => {
  const planned = actions.plan(user, [button('editMessage', user.id, '编辑并重发')]);
  assert.deepEqual(planned.map(item => item.key), ['copyMessage', 'editMessage', 'quoteMessage']);
  assert.deepEqual(planned.find(item => item.key === 'editMessage').dataset, { editMessage: user.id });
  assert.equal(planned[0].dataset.copyMessage, user.text);
  const original = [button('retryRun', 'run-a', '重新提出方案', true), button('branchMessage', 'agent-1', '从此处分支')];
  const settled = actions.plan(assistant, original, '可复制的正文');
  assert.equal(settled[0].disabled, true);
  assert.equal(settled[0].label, '重新提出方案');
  assert.deepEqual(settled[1].dataset, { branchMessage: 'agent-1' });
  assert.equal(settled.filter(item => item.key === 'copyMessage').length, 0, 'Do not duplicate failure-card copy');
});
test('live, deleted, unsupported messages and blank text do not gain quote actions', () => {
  for (const extra of [{ live: true }, { deletedAt: 1 }, { role: 'tool' }]) assert.deepEqual(actions.plan({ ...assistant, ...extra }), []);
  assert.deepEqual(actions.plan({ ...user, text: ' ' }), []);
});
test('quote resolves canonical message and updates only the active input draft', () => {
  const h = controllerFixture();
  assert.deepEqual(h.controller.request('agent-1'), { ok: true, queued: false });
  assert.equal(h.input.value, '现有草稿\n\n> 来源\n> \n> 结论\n\n');
  assert.equal(h.changes.length, 1);
  assert.equal(h.changes[0].message, h.conversation.messages[1]);
  assert.deepEqual(h.conversation.draftAttachmentIds, ['pdf']);
  assert.deepEqual(h.input.selection, [h.input.value.length, h.input.value.length]);
  assert.equal(h.conversation.messages.length, 2);
  h.controller.destroy();
});
test('IME defers quoting until final input, then appends to the final composed draft', async () => {
  const h = controllerFixture(); h.input.dispatchEvent(new Event('compositionstart'));
  assert.deepEqual(h.controller.request('user-1'), { ok: true, queued: true });
  assert.equal(h.input.value, '现有草稿');
  h.input.dispatchEvent(new Event('compositionend')); h.input.value = '现有草稿 中文';
  await pause();
  assert.equal(h.input.value, '现有草稿 中文\n\n> 原始问题\n\n');
  assert.equal(h.changes.length, 1); h.controller.destroy();
});
test('queued quotes cannot leak into a different conversation or replaced input', async () => {
  for (const change of ['conversation', 'input']) {
    const h = controllerFixture(), oldInput = h.input;
    oldInput.dispatchEvent(new Event('compositionstart')); h.controller.request('user-1');
    oldInput.dispatchEvent(new Event('compositionend'));
    if (change === 'conversation') h.conversation = { id: 'other', messages: [{ ...user }] };
    else h.input = new Input();
    await pause(); assert.equal(oldInput.value, '现有草稿'); assert.equal(h.input.value, '现有草稿');
    assert.equal(h.changes.length, 0); h.controller.destroy();
  }
});
test('queued quote rechecks deletion and never uses body captured before IME finishes', async () => {
  for (const deleted of [true, false]) {
    const h = controllerFixture(); h.input.dispatchEvent(new Event('compositionstart')); h.controller.request('agent-1');
    h.conversation.messages[1].text = '最新正文';
    if (deleted) h.conversation.messages[1].deletedAt = 1;
    h.input.dispatchEvent(new Event('compositionend')); await pause();
    assert.equal(h.input.value, deleted ? '现有草稿' : '现有草稿\n\n> 最新正文\n\n'); h.controller.destroy();
  }
});
test('destroy cancels queued work, and invalid/export failures preserve drafts', async () => {
  const h = controllerFixture(); h.input.dispatchEvent(new Event('compositionstart')); h.controller.request('user-1');
  h.input.dispatchEvent(new Event('compositionend')); h.controller.destroy(); await pause();
  assert.equal(h.input.value, '现有草稿'); assert.equal(h.changes.length, 0);
  assert.equal(h.controller.request('user-1').reason, 'destroyed');
  const failed = controllerFixture({ exportText: () => { throw Error('missing output'); } });
  assert.equal(failed.controller.request('missing').ok, false); assert.equal(failed.controller.request('agent-1').ok, false);
  assert.equal(failed.input.value, '现有草稿'); failed.controller.destroy();
});

// Render the real adapter JSX. The Kit primitive is stubbed only at this unit
// boundary; the production bundle/native component gate belongs to the host.
const jsx = fs.readFileSync(require.resolve('../app/ui/message-actions.jsx'), 'utf8');
const moduleBox = { exports: {} };
const Button = ({ children, ...props }) => { const { variant, size, ...dom } = props; return React.createElement('button', dom, children); };
vm.runInNewContext(transformSync(jsx, { loader: 'jsx', format: 'cjs' }).code, {
  module: moduleBox, exports: moduleBox.exports, require: name => name === 'react' ? React : { Button },
});
const { MessageActionBar, handleActionKeys } = moduleBox.exports;
test('the real adapter keeps copy/quote compact and existing workflows in the overflow', () => {
  const items = actions.plan(user, [button('editMessage', 'user-1', '编辑并重发')]);
  const html = renderToStaticMarkup(React.createElement(MessageActionBar, { actions: items }));
  assert.match(html, /aria-label="复制"/); assert.match(html, /aria-label="引用回复"/);
  assert.match(html, /<details[^>]+message-action-menu/); assert.match(html, /编辑并重发/);
  assert.equal((html.match(/<button/g) || []).length, 3);
  assert.doesNotMatch(html, /role="menu"/); assert.doesNotMatch(html, /onClick/);
});
function keyHarness() {
  const doc = { activeElement: null }, focused = [];
  const summary = { focus: () => { doc.activeElement = summary; focused.push('summary'); } };
  const buttons = [0, 1, 2].map(id => ({ focus() { doc.activeElement = this; focused.push(id); } }));
  const menu = { open: false, ownerDocument: doc, querySelector: () => summary, querySelectorAll: () => buttons };
  doc.activeElement = summary;
  const key = (key, extra = {}) => { const e = { key, currentTarget: menu, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra }; handleActionKeys(e); return e; };
  return { menu, key, focused, buttons, summary, doc };
}
test('overflow keyboard opens from either direction, wraps and restores the trigger on Escape', () => {
  const h = keyHarness();
  assert.equal(h.key('ArrowUp').prevented, true); assert.equal(h.menu.open, true); assert.equal(h.doc.activeElement, h.buttons[2]);
  h.key('ArrowDown'); assert.equal(h.doc.activeElement, h.buttons[0]);
  h.key('End'); assert.equal(h.doc.activeElement, h.buttons[2]);
  h.key('Home'); assert.equal(h.doc.activeElement, h.buttons[0]);
  h.key('Escape'); assert.equal(h.menu.open, false); assert.equal(h.doc.activeElement, h.summary);
});
test('overflow never intercepts composition, Tab or regular text keys', () => {
  const h = keyHarness();
  assert.equal(h.key('ArrowDown', { isComposing: true }).prevented, undefined);
  assert.equal(h.key('ArrowDown', { nativeEvent: { isComposing: true } }).prevented, undefined);
  assert.equal(h.key('Tab').prevented, undefined); assert.equal(h.key('a').prevented, undefined);
  assert.deepEqual(h.focused, []);
});
test('the production deferred mount binds the original canonical version, not transformed display text', () => {
  const app = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
  const start=app.indexOf('const actionsAnchor ='),end=app.indexOf('\n  }',start),afterAttach=[],calls=[];
  const owner={isConnected:false,dataset:{messageId:'m'}},wrapper={querySelector:()=>({closest:()=>owner})};
  const context={wrapper,afterAttach,message:{id:'m',text:'display notice'},markdownOwner:{text:'canonical model output'},exportedText:'export with sources',window:{MessageActions:{enhance:(...args)=>calls.push(args)}}};
  vm.runInNewContext(app.slice(start,end),context);
  assert.equal(calls.length,0);afterAttach[0]();assert.equal(calls.length,0);
  owner.isConnected=true;afterAttach[0]();assert.equal(calls.length,1);assert.equal(calls[0][0],owner);
  assert.equal(calls[0][2].sourceText,'canonical model output');assert.equal(calls[0][2].exportedText,'export with sources');
  owner.dataset.messageId='different';afterAttach[0]();assert.equal(calls.length,1);
});
