'use strict';
// 移入回收站后的「撤销」：只恢复那一条回收记录；记录已不在（已恢复/已永久删除）时明确告知，不重复恢复。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { parseHTML } = require(process.env.AIBRO_TEST_DOM_MODULE || 'linkedom');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const start = source.indexOf('let toastTimer = null;');
const end = source.indexOf('\n', source.indexOf('function undoTrashToast', start) + 1);
const block = source.slice(start, source.indexOf('\n}\n', end) + 3);
assert.ok(start >= 0 && block.includes('function undoTrashToast'));

function fixture() {
  const { window } = parseHTML('<!doctype html><html><body></body></html>');
  const doc = window.document, restored = [], timers = [];
  const state = { trash: [{ id: 'trash-1', type: 'conversation' }, { id: 'trash-2', type: 'content' }] };
  const context = { document: doc, state, $: selector => doc.querySelector(selector),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
    restoreTrash: id => { restored.push(id); state.trash = state.trash.filter(entry => entry.id !== id); } };
  vm.createContext(context); vm.runInContext(block, context);
  const box = () => doc.getElementById('toast');
  return { context, state, restored, timers, box, action: () => box().querySelector('.toast-action') };
}

test('a deletion toast offers one Undo that restores exactly that trash entry and reopens it', () => {
  const h = fixture(); let reopened = 0;
  h.context.undoTrashToast('已将“示例”移入回收站', h.state.trash[0], () => reopened++);
  assert.match(h.box().textContent, /移入回收站/); assert.equal(h.action().textContent, '撤销');
  assert.equal(h.timers.at(-1).ms, 6000, 'an actionable toast stays long enough to reach');
  h.action().click();
  assert.deepEqual(h.restored, ['trash-1']); assert.equal(reopened, 1);
  assert.equal(h.state.trash.length, 1); assert.match(h.box().textContent, /已撤销/);
  assert.equal(h.action(), null, 'the confirmation has no second action');
});

test('Undo after the entry left the trash reports it instead of restoring anything', () => {
  const h = fixture(); const entry = h.state.trash[1];
  h.context.undoTrashToast('已将 1 项内容移入回收站', entry);
  h.state.trash = h.state.trash.filter(item => item !== entry);
  h.action().click();
  assert.deepEqual(h.restored, []); assert.match(h.box().textContent, /无法撤销/);
});

test('a plain toast stays plain and a later toast drops a stale Undo', () => {
  const h = fixture();
  h.context.undoTrashToast('已移入回收站', h.state.trash[0]);
  h.context.toast('另一条提示');
  assert.equal(h.action(), null); assert.equal(h.timers.at(-1).ms, 2300);
  assert.equal(h.box().classList.contains('has-action'), false);
});
