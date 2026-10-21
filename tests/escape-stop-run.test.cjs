'use strict';
// Esc 停止当前回复：只在对话页、确有执行、且没有更上层浮层持有 Escape 时生效。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const start = source.indexOf('function escapeStopsRun(event)');
const end = source.indexOf("window.addEventListener('keydown', event => { if (event.defaultPrevented", start);
assert.ok(start >= 0 && end > start, 'Esc handler stays next to the global shortcut listener');
const block = source.slice(start, end);

function harness({ busy = true, view = 'agent', overlay = null, focus = 'body' } = {}) {
  const calls = { stop: 0 };
  const body = { dataset: { view } }, input = { id: 'agentInput' }, inList = { id: 'x' }, other = { id: 'settingsField' };
  const env = {
    sendMessage: { busy }, stopCurrentRun: () => { calls.stop++; },
    document: { body, get activeElement() { return { body, composer: input, list: inList, other }[focus]; },
      querySelector: selector => overlay && selector.split(',').some(part => part.trim().startsWith(overlay)) ? {} : null },
    $: selector => selector === '#messageList' ? { contains: node => node === inList } : null,
    addEventListener: (type, fn) => { env.listener = fn; }
  };
  env.window = env; vm.createContext(env); vm.runInContext(block, env);
  const press = (init = {}) => { let prevented = false; env.listener({ key: 'Escape', defaultPrevented: false, isComposing: false, keyCode: 27, ...init, preventDefault() { prevented = true; } }); return prevented; };
  return { calls, press };
}

test('Esc stops a running reply from the composer, the transcript or an unfocused page', () => {
  for (const focus of ['body', 'composer', 'list']) {
    const h = harness({ focus });
    assert.equal(h.press(), true, focus); assert.equal(h.calls.stop, 1, focus);
  }
});

test('Esc does nothing when idle, off the conversation, or while typing elsewhere', () => {
  for (const options of [{ busy: false }, { view: 'project' }, { focus: 'other' }]) {
    const h = harness(options); assert.equal(h.press(), false); assert.equal(h.calls.stop, 0, JSON.stringify(options));
  }
});

test('an overlay keeps Escape: dialogs, message editor, menus, find bar and source peek close first', () => {
  for (const overlay of ['dialog[open]', '.message-edit', '.message-action-menu[open]', '#composerExtraTools', '#findBar', '#sourcePeek']) {
    const h = harness({ overlay }); assert.equal(h.press(), false, overlay); assert.equal(h.calls.stop, 0, overlay);
  }
});

test('IME composition, an Escape already consumed, or a modified Escape never stop the run', () => {
  for (const init of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { metaKey: true }, { shiftKey: true }]) {
    const h = harness(); assert.equal(h.press(init), false); assert.equal(h.calls.stop, 0, JSON.stringify(init));
  }
});
