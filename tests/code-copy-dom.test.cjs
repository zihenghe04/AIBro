'use strict';
// 对话代码块「复制代码」：浮动按钮不进消息 DOM，只复制 <code> 原文，生成中的回复不提供。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { parseHTML } = require(process.env.AIBRO_TEST_DOM_MODULE || 'linkedom');
const file = require.resolve('../app/code-copy.js');

function fixture({ clipboardFails = false } = {}) {
  const { window } = parseHTML(`<!doctype html><html><body><div id="messageList">
    <div class="message-wrap agent-message" data-message-id="a1"><div class="message-body"><p>说明</p><pre class="message-code"><span class="message-code-lang">js</span><code data-language="js"><span class="tok-keyword">const</span> x = 1;\nreturn x;</code></pre></div></div>
    <div class="message-wrap agent-message live-message" data-message-id="a2"><div class="message-body"><pre class="message-code"><code>still streaming</code></pre></div></div>
  </div><pre class="message-code" id="outside"><code>not a message</code></pre></body></html>`);
  const copied = [], notices = [];
  const context = { document: window.document, navigator: { clipboard: { writeText: async text => { if (clipboardFails) throw Error('denied'); copied.push(text); } } },
    setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {}, getSelection: () => null };
  context.window = context; vm.createContext(context);
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: 'code-copy.js' });
  const doc = window.document, list = doc.getElementById('messageList');
  const controller = context.CodeCopy.init({ getRoot: () => list, announce: text => notices.push(text) });
  const pres = [...doc.querySelectorAll('pre.message-code')];
  pres.forEach(pre => { pre.getBoundingClientRect = () => ({ width: 300, right: 400, bottom: 200 }); });
  return { doc, list, controller, copied, notices, settled: pres[0], live: pres[1], outside: pres[2], context };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('copies only the code text of a settled block, without the language label or token markup', async () => {
  const h = fixture();
  assert.equal(h.context.CodeCopy.codeText(h.settled), 'const x = 1;\nreturn x;');
  h.controller.show(h.settled);
  assert.equal(h.controller.button.hidden, false);
  h.controller.button.dispatchEvent(new h.doc.defaultView.Event('click', { bubbles: true }));
  await flush();
  assert.deepEqual(h.copied, ['const x = 1;\nreturn x;']);
  assert.equal(h.controller.button.textContent, '已复制');
  assert.deepEqual(h.notices, ['代码已复制。']);
  h.controller.destroy();
});

test('the button lives outside the transcript, so message text, copy-all and find never see it', () => {
  const h = fixture();
  h.controller.show(h.settled);
  assert.equal(h.list.contains(h.controller.button), false);
  assert.equal(h.list.textContent.includes('复制代码'), false);
  h.controller.destroy();
  assert.equal(h.doc.querySelector('.code-copy-float'), null);
});

test('streaming replies and code outside the conversation are not offered', () => {
  const h = fixture();
  h.controller.show(h.live); assert.equal(h.controller.button.hidden, true);
  h.controller.show(h.outside); assert.equal(h.controller.button.hidden, true);
  h.controller.destroy();
});

test('a clipboard failure is reported in place instead of claiming success', async () => {
  const h = fixture({ clipboardFails: true });
  h.controller.show(h.settled); await h.controller.copy();
  assert.equal(h.controller.button.textContent, '复制失败');
  assert.match(h.notices[0], /无法访问剪贴板/);
  h.controller.destroy();
});
