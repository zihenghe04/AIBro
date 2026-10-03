/* Actual production MessageActions + offline Halaska/React in a Node DOM.
 * Selection, focus and layout APIs are explicit adapters, not native WebKit QA.
 * No model, workspace, clipboard or GUI access. */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { parseHTML } = require(process.env.AIBRO_TEST_DOM_MODULE || '/tmp/aibro-stream-dom.7i7LZ9/node_modules/linkedom');
const dir = path.resolve(__dirname, '..');
const bundle = fs.readFileSync(path.join(dir, 'app/halaska-ui.js'), 'utf8');
const source = fs.readFileSync(path.join(dir, 'app/message-actions.js'), 'utf8');
const explainSource = fs.readFileSync(path.join(dir, 'app/selection-explain.js'), 'utf8');
const app = fs.readFileSync(path.join(dir, 'app/app.js'), 'utf8');
const begin = app.lastIndexOf("document.addEventListener('click', event => {", app.indexOf('const quoteMessage ='));
const delegate = app.slice(begin, app.indexOf('}, true);', begin) + '}, true);'.length);
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
async function fixture({ language = 'zh' } = {}) {
  const { window } = parseHTML('<html lang="zh"><head></head><body><div class="message-list"><article class="message-wrap agent-message" data-message-id="answer"><div class="message-body"><p>读课件时，先记录观察事实，再区分自己的解释。</p><p>需要追问的证据：这条结论来自第2页。</p><pre><code>example()</code><button>复制代码</button></pre><p>最后检查原文与课堂笔记。</p></div><div class="message-meta"><span class="meta-actions"><button data-copy-message="完整回复">复制</button></span></div></article><article class="message-wrap agent-message"><div class="message-body">另一条回复</div></article></div><textarea id="agentInput"></textarea><button id="other">其它操作</button></body></html>');
  const document = window.document, frames = new Map(), timers = new Map(), events = new Map(), errors = [];
  let id = 0, selection = null, focused = document.body;
  Object.defineProperty(document, 'activeElement', { get: () => focused });
  window.HTMLElement.prototype.focus = function () { focused = this; this.dispatchEvent(new window.Event('focusin', { bubbles: true })); };
  window.HTMLElement.prototype.getBoundingClientRect = function () { return this._rect || (this.id === 'selectionBar' ? rect(0, 0, 260, 36) : this.classList.contains('message-selection-action') ? rect(0, 0, 140, 36) : rect(0, 0, 10, 10)); };
  window.HTMLElement.prototype.getClientRects = function () { return this._hidden ? [] : [this.getBoundingClientRect()]; };
  const env = { document, console: { ...console, error: (...a) => errors.push(a.join(' ')) }, Date, queueMicrotask, AbortController,
    performance: { now: () => 0 }, navigator: { userAgent: 'Node DOM adapter' }, innerWidth: 1000, innerHeight: 760,
    getComputedStyle: () => ({ visibility: 'visible' }), getSelection: () => selection,
    requestAnimationFrame(fn) { const n = ++id; frames.set(n, fn); return n; }, cancelAnimationFrame(n) { frames.delete(n); },
    setTimeout(fn) { const n = ++id; timers.set(n, fn); return n; }, clearTimeout(n) { timers.delete(n); },
    setInterval: () => 0, clearInterval() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener(type, fn) { if (!events.has(type)) events.set(type, new Set()); events.get(type).add(fn); },
    removeEventListener(type, fn) { events.get(type)?.delete(fn); },
    WorkstationI18n: { getLanguage: () => language }
  };
  for (const key of ['MutationObserver', 'Element', 'HTMLElement', 'HTMLIFrameElement', 'Node', 'Event', 'CustomEvent']) env[key] = window[key];
  env.window = env; env.self = env; document.getSelection = () => selection;
  vm.createContext(env); vm.runInContext(bundle, env); vm.runInContext(source, env); vm.runInContext(explainSource, env);
  const wrapper = document.querySelector('.message-wrap'), body = wrapper.querySelector('.message-body'), scroll = document.querySelector('.message-list');
  body._rect = rect(180, -100, 700, 1300); scroll._rect = rect(160, 90, 740, 520);
  const message = { id: 'answer', role: 'agent', text: body.textContent }, conversation = { id: 'chat', messages: [message], draftAttachmentIds: ['fixture-pdf'], queuedMessages: [{ text: '之后继续' }] };
  const input = document.querySelector('textarea'); input.value = '已有草稿'; input.setSelectionRange = () => {};
  const h = { env, document, wrapper, body, scroll, message, conversation, input, changes: 0, notices: [] };
  env.MessageActions.enhance(wrapper, message, { sourceText: message.text });
  const footer = wrapper.querySelector('.message-meta');
  env.messageQuoteController = env.MessageActions.createQuoteController({ getConversation: () => h.conversation, getInput: () => h.input, onChange: () => h.changes++ });
  h.explanationRequests = [];
  env.ConversationModels = { resolve: async () => ({ provider: 'fixture', model: 'offline' }) };
  env.AgentTransport = { requestPlan: async request => { h.explanationRequests.push(request); return '合成解释结果'; } };
  env.SelectionExplain.init({ getConversation: () => h.conversation, getCurrentModel: () => ({}), toast: text => h.notices.push(text) });
  env.conversationPathSaving = () => false; env.toast = text => h.notices.push(text);
  vm.runInContext(delegate, env);
  h.fire = (target, type, values = {}) => { const event = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(event, values); target.dispatchEvent(event); return event; };
  h.select = (options = {}) => {
    const node = body.querySelectorAll('p')[1].firstChild;
    const range = { startContainer: node, startOffset: 0, getClientRects: () => options.rects || [rect(220, 280, 220, 26)], getBoundingClientRect: () => (options.rects || [rect(220, 280, 220, 26)])[0],
      intersectsNode: el => (options.controls || []).includes(el), cloneRange() { return this; } };
    selection = { isCollapsed: false, rangeCount: 1, anchorNode: node, focusNode: node, anchorOffset: 0, focusOffset: 8,
      toString: () => options.text || '需要追问的证据', getRangeAt: () => range,
      removeAllRanges() {}, addRange() { selection.anchorNode = range.startContainer; selection.anchorOffset = range.startOffset; selection.focusNode = node; selection.focusOffset = 8; h.fire(document, 'selectionchange'); }, ...options.selection };
    h.fire(document, 'selectionchange'); return selection;
  };
  h.collapse = () => { selection = { isCollapsed: true, rangeCount: 0, toString: () => '' }; h.fire(document, 'selectionchange'); };
  h.drain = async () => { for (let i = 0; i < 5; i++) { for (const [n, fn] of [...frames]) { frames.delete(n); fn(); } await new Promise(setImmediate); } assert.deepEqual(errors, []); };
  h.flushIME = async () => { for (const [n, fn] of [...timers]) { timers.delete(n); fn(); } await h.drain(); };
  h.pendingFrames = () => frames.size;
  h.button = () => document.querySelector('.message-selection-action button');
  h.emit = type => [...(events.get(type) || [])].forEach(fn => fn());
  h.destroy = () => { env.messageQuoteController.destroy(); env.SelectionExplain.close(); env.HalaskaUI.unmount(footer.querySelector('[data-halaska-root]')); };
  h.footer = footer;
  await h.drain(); return h;
}
test('real Kit root gives a selected long response one nearby action and keeps its footer; actual host delegate quotes once', async () => {
  const h = await fixture(); h.select(); await h.drain(); const button = h.button();
  assert.equal(button.textContent, '引用提问'); assert.equal(button.closest('[data-halaska-root]').dataset.halaskaRoot, 'Button');
  assert.ok(h.footer.querySelector('[data-quote-message]')); assert.equal(h.document.querySelectorAll('.message-selection-action').length, 1);
  assert.equal(button.closest('#selectionBar').querySelectorAll('button').length, 3, 'One shared shell retains explain and annotate');
  assert.equal(h.document.querySelectorAll('.selection-bar').length, 1);
  const down = h.fire(button, 'pointerdown', { button: 0 }); assert.equal(down.defaultPrevented, true);
  h.fire(button, 'click'); await h.drain();
  assert.equal(h.input.value, '已有草稿\n\n> 需要追问的证据\n\n'); assert.equal(h.changes, 1); assert.equal(h.button(), null);
  assert.deepEqual(h.conversation.draftAttachmentIds, ['fixture-pdf']); assert.equal(h.conversation.queuedMessages.length, 1);
  h.fire(button, 'click'); assert.equal(h.changes, 1, 'A detached stale action cannot quote the full reply'); h.destroy();
});
test('short/user/live bodies, cross-message/multiple ranges and interactive text do not offer nearby quote', async () => {
  const variants = [h => h.body._rect.height = 100, h => h.message.role = 'user', h => h.message.live = true,
    h => h.select({ selection: { focusNode: h.document.querySelectorAll('.message-body')[1].firstChild } }),
    h => h.select({ selection: { rangeCount: 2 } }), h => h.select({ controls: [h.body.querySelector('button')] }),
    h => h.select({ selection: { anchorNode: h.body.querySelector('button').firstChild } })];
  for (const change of variants) { const h = await fixture(); h.select(); change(h); await h.drain(); assert.equal(h.button(), null); assert.equal(h.changes, 0); h.destroy(); }
});
test('viewport edges clamp the action inside the reading region; offscreen selection endpoints stay hidden', async () => {
  const h = await fixture({ language: 'en' }); h.select({ rects: [rect(840, 102, 40, 22)] }); await h.drain();
  const host = h.button().closest('#selectionBar');
  assert.equal(h.button().textContent, 'Ask about selection'); assert.ok(parseFloat(host.style.left) + 260 <= 892); assert.equal(parseFloat(host.style.top), 132);
  h.select({ rects: [rect(230, 580, 70, 80)] }); await h.drain(); assert.equal(h.button(), null); h.destroy();
});
test('Tab enters the nearby action without losing the captured paragraph; Escape returns focus without moving to footer', async () => {
  const h = await fixture(); h.select(); await h.drain(); const button = h.button();
  assert.equal(h.fire(h.document.body, 'keydown', { key: 'Tab' }).defaultPrevented, true); assert.equal(h.document.activeElement, button);
  h.collapse(); await h.drain(); assert.equal(h.button(), button);
  h.fire(button, 'keydown', { key: 'Escape' }); await h.drain(); assert.equal(h.button(), null); assert.equal(h.document.activeElement, h.body); assert.equal(h.body.hasAttribute('tabindex'), false); assert.equal(h.input.value, '已有草稿');
  h.select({ text: '另一段', selection: { focusOffset: 3 } }); await h.drain(); const next = h.button(); h.fire(h.body, 'keydown', { key: 'Tab' }); h.collapse(); h.fire(next, 'click');
  assert.equal(h.input.value, '已有草稿\n\n> 另一段\n\n'); h.destroy();
});
test('scroll, resize, blur and outside focus hide without reopening the unchanged selection', async () => {
  for (const action of [h => h.fire(h.scroll, 'scroll'), h => h.fire(h.scroll, 'wheel'), h => h.emit('resize'), h => h.emit('blur'), h => h.document.querySelector('#other').focus()]) {
    const h = await fixture(); h.select(); await h.drain(); assert.ok(h.button()); action(h); h.select(); await h.drain(); assert.equal(h.button(), null); h.destroy();
  }
});
test('pointer drag exposes no action until release inside the same body; release outside and cancelled gestures stay hidden', async () => {
  for (const end of ['inside', 'outside', 'cancel']) {
    const h = await fixture(); h.fire(h.body, 'pointerdown', { button: 0 }); h.select(); await h.drain(); assert.equal(h.button(), null);
    if (end === 'cancel') h.fire(h.document, 'pointercancel'); else h.fire(end === 'inside' ? h.body : h.document.querySelector('#other'), 'pointerup', { button: 0 });
    await h.drain(); assert.equal(!!h.button(), end === 'inside'); h.destroy();
  }
});
test('changed/deleted/hidden/detached bodies and different conversations invalidate even an already focused action', async () => {
  for (const change of [h => h.message.text += ' changed', h => h.message.deletedAt = 1, h => h.wrapper.hidden = true,
    h => h.wrapper.remove(), h => h.conversation = { ...h.conversation, id: 'other' }, h => h.body.firstChild.firstChild.textContent += ' revised']) {
    const h = await fixture(); h.select(); await h.drain(); const old = h.button(); h.fire(h.document.body, 'keydown', { key: 'Tab' }); change(h);
    h.fire(old, 'click'); await h.drain(); assert.equal(h.changes, 0); assert.equal(h.input.value, '已有草稿'); assert.equal(h.button(), null); h.destroy();
  }
});
test('the transient action still uses the existing IME queue and final canonical revalidation', async () => {
  for (const stale of [false, true]) {
    const h = await fixture(); h.fire(h.input, 'compositionstart'); h.select(); await h.drain(); h.fire(h.button(), 'click');
    assert.equal(h.changes, 0); h.fire(h.input, 'compositionend'); h.input.value += ' 中文'; if (stale) h.message.text += ' changed'; await h.flushIME();
    assert.equal(h.input.value, stale ? '已有草稿 中文' : '已有草稿 中文\n\n> 需要追问的证据\n\n'); h.destroy();
  }
});
test('teardown removes the owned root and listeners; later selection cannot mount a new one', async () => {
  const h = await fixture(); h.select(); await h.drain(); assert.ok(h.button()); h.destroy(); h.select({ text: 'new' }); await h.drain(); assert.equal(h.button(), null); assert.equal(h.env.HalaskaUI.diagnostics().mounts, 0);
});
test('unrelated stream updates do not scan selected body; body edits coalesce and invalidate before activation', async () => {
  const h = await fixture(); h.select(); await h.drain();
  let reads = 0; const bodyText = h.body.textContent;
  Object.defineProperty(h.body, 'textContent', { configurable: true, get() { reads++; return bodyText; } });
  const other = h.document.querySelectorAll('.message-body')[1];
  for (let i = 0; i < 25; i++) other.textContent = '其它流式更新' + i;
  await new Promise(setImmediate); assert.equal(reads, 0); assert.equal(h.pendingFrames(), 0); assert.ok(h.button());
  for (let i = 0; i < 25; i++) h.body.querySelector('p').setAttribute('style', `opacity:${i / 25}`);
  await new Promise(setImmediate); assert.equal(reads, 0); assert.equal(h.pendingFrames(), 1);
  await h.drain(); assert.equal(reads, 1); assert.ok(h.button());
  h.wrapper.hidden = true; await new Promise(setImmediate); assert.equal(h.button(), null); assert.equal(reads, 1); h.destroy();
});
test('host save guard prevents selection quoting; after it clears the same controller handles the action', async () => {
  const h = await fixture(); h.select(); await h.drain();
  h.env.conversationPathSaving = () => true; h.fire(h.button(), 'click'); assert.equal(h.changes, 0); assert.equal(h.input.value, '已有草稿');
  h.env.conversationPathSaving = () => false; h.fire(h.button(), 'click'); assert.equal(h.changes, 1); h.destroy();
});
test('Escape on a backward selection does not reopen when the native range fallback normalizes direction', async () => {
  const h = await fixture(); h.select({ selection: { anchorOffset: 8, focusOffset: 0 } }); await h.drain();
  h.fire(h.body, 'keydown', { key: 'Tab' }); h.fire(h.button(), 'keydown', { key: 'Escape' }); await h.drain();
  assert.equal(h.button(), null); assert.equal(h.document.activeElement, h.body); assert.equal(h.changes, 0); h.destroy();
});
test('shared toolbar retains both existing operations after keyboard focus collapses the selection', async () => {
  for (const mode of ['explain', 'annotate']) {
    const h = await fixture(); h.select(); await h.drain();
    const bar = h.document.querySelector('#selectionBar'), button = bar.querySelector(`[data-selection-mode="${mode}"]`);
    h.fire(h.document.body, 'keydown', { key: 'Tab' }); button.focus(); h.collapse(); await h.drain();
    assert.equal(bar.hidden, false); h.fire(button, 'click'); await h.drain();
    assert.equal(h.button(), null); assert.equal(bar.hidden, true); assert.equal(h.document.querySelector('#selectionPanel').hidden, false);
    assert.equal(h.explanationRequests.length, 1); assert.match(h.explanationRequests[0].input[1].content[0].text, /需要追问的证据/);
    assert.match(h.explanationRequests[0].input[0].content[0].text, mode === 'annotate' ? /写一条批注/ : /解释选中片段/);
    assert.equal(h.changes, 0, 'Explanation does not implicitly insert a quote'); h.destroy();
  }
});
test('one shared owner handles invalidation, old explanation fallback, and detached quote without double UI or whole-message fallback', async () => {
  const h = await fixture(); h.select(); await h.drain(); const old = h.button(), bar = h.document.querySelector('#selectionBar');
  h.fire(h.scroll, 'scroll'); h.select(); await h.drain(); assert.equal(bar.hidden, true); assert.equal(h.button(), null);
  h.fire(old, 'click'); assert.equal(h.changes, 0);
  h.body._rect.height = 100; h.select({ text: '新短句', selection: { focusOffset: 3 } }); await h.drain();
  assert.equal(h.button(), null); assert.equal(bar.hidden, false); assert.equal(bar.querySelectorAll('button').length, 2);
  h.fire(bar.querySelector('[data-selection-mode="explain"]'), 'click'); await h.drain(); assert.equal(h.explanationRequests.length, 1);
  assert.match(h.explanationRequests[0].input[1].content[0].text, /新短句/); h.destroy();
});
