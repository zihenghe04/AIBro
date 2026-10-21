'use strict';
// 编辑并重发：⌘/Ctrl+Enter 提交，Esc 取消并把焦点还给「编辑」按钮；输入法组合期间两者都不生效。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { parseHTML } = require(process.env.AIBRO_TEST_DOM_MODULE || 'linkedom');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const start = source.indexOf('function openMessageEditor(messageId)');
const end = source.indexOf('\n// 对话目录', start);
assert.ok(start >= 0 && end > start);

function fixture() {
  const { window } = parseHTML('<!doctype html><html><body><div id="messageList"><div class="message-wrap user-message" data-message-id="u1"><div class="message-body">原文</div><div class="message-meta"><button data-edit-message="u1">编辑并重发</button></div></div></div></body></html>');
  const doc = window.document, sent = [];
  window.HTMLTextAreaElement.prototype.setSelectionRange ||= function () {};
  let focused = null; window.HTMLElement.prototype.focus = function () { focused = this; };
  const context = { document: doc, window: { ConversationWindow: null }, CSS: { escape: value => value }, toast() {}, conversationPathSaving: () => false,
    currentConversation: () => ({ messages: [{ id: 'u1', role: 'user', text: '原文' }] }),
    editUserMessageAndResend: async (id, text) => { sent.push([id, text]); } };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  context.openMessageEditor('u1');
  const form = doc.querySelector('.message-edit'), area = form.querySelector('textarea');
  // linkedom has no requestSubmit; route it through the real submit listener.
  form.requestSubmit = () => form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  const key = init => { const event = new window.Event('keydown', { bubbles: true, cancelable: true }); Object.assign(event, { key: 'Enter', metaKey: false, ctrlKey: false, isComposing: false, keyCode: 13, ...init }); area.dispatchEvent(event); return event; };
  return { doc, form, area, sent, key, get focused() { return focused; } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('⌘Enter and Ctrl+Enter save and resend the edited text', async () => {
  for (const modifier of ['metaKey', 'ctrlKey']) {
    const h = fixture(); h.area.value = '改过的问题';
    assert.equal(h.key({ [modifier]: true }).defaultPrevented, true);
    await flush(); assert.deepEqual(h.sent, [['u1', '改过的问题']], modifier);
  }
});

test('plain Enter keeps a newline and Escape cancels back to the edit button', async () => {
  const h = fixture();
  assert.equal(h.key({}).defaultPrevented, false); await flush(); assert.deepEqual(h.sent, []);
  h.key({ key: 'Escape', keyCode: 27 });
  assert.equal(h.doc.querySelector('.message-edit'), null);
  assert.equal(h.focused?.dataset?.editMessage, 'u1');
});

test('IME composition never submits or cancels the edit', async () => {
  const h = fixture();
  h.key({ metaKey: true, isComposing: true }); h.key({ key: 'Escape', keyCode: 229 });
  await flush(); assert.deepEqual(h.sent, []); assert.ok(h.doc.querySelector('.message-edit'));
});
