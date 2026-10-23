'use strict';
// 内容删除（单个或批量）不弹确认框：直接移入回收站，撤销提示指向这一条回收记录。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const start = source.indexOf('function requestContentDelete(');
const block = source.slice(start, source.indexOf('\n}\n', start) + 3);
assert.ok(start >= 0);

function harness(removeResult) {
  const calls = [], state = { trash: [] };
  const context = { state, uid: () => 'id', calls,
    ContentLifecycle: { remove: (current, selections, scope) => { calls.push(['remove', selections.length, scope]); const outcome = removeResult(selections); if (outcome.entry) state.trash.push(outcome.entry); return { state, ...outcome }; } },
    commitContentState: next => calls.push(['commit', next === state]),
    toast: message => calls.push(['toast', message]),
    undoTrashToast: (message, entry) => calls.push(['undo', message, entry?.id]) };
  vm.createContext(context); vm.runInContext(block, context);
  return { context, calls, state };
}

test('a batch delete moves everything to the trash at once and offers one undo, with no dialog', async () => {
  const h = harness(selections => ({ entry: { id: 'trash-9' }, counts: { total: selections.length }, warnings: [] }));
  const result = await h.context.requestContentDelete([{ type: 'task', id: 'a' }, { type: 'note', id: 'b' }, { type: 'import', id: 'c' }], { workspace: '日常' });
  assert.equal(result, true);
  assert.deepEqual(h.calls.map(call => call[0]), ['remove', 'commit', 'undo']);
  assert.deepEqual(h.calls[0].slice(1), [3, { workspace: '日常' }]);
  assert.equal(h.calls[2][1], '已将 3 项内容移入回收站'); assert.equal(h.calls[2][2], 'trash-9');
});

test('what was kept is said in the same undo toast', async () => {
  const h = harness(() => ({ entry: { id: 'trash-1' }, counts: { total: 1 }, warnings: ['将保留 1 份未选中的来源原件。'] }));
  await h.context.requestContentDelete([{ type: 'note', id: 'b' }]);
  assert.match(h.calls.at(-1)[1], /已将 1 项内容移入回收站。将保留 1 份未选中的来源原件。/);
});

test('nothing deletable or a failure only toasts and changes nothing', async () => {
  const empty = harness(() => ({ entry: null, counts: { total: 0 }, warnings: [] }));
  assert.equal(await empty.context.requestContentDelete([{ type: 'note', id: 'gone' }]), false);
  assert.deepEqual(empty.calls.map(call => call[0]), ['remove', 'toast']);
  const broken = harness(() => { throw new Error('数据损坏'); });
  assert.equal(await broken.context.requestContentDelete([{ type: 'note', id: 'x' }]), false);
  assert.deepEqual(broken.calls.at(-1), ['toast', '数据损坏']);
});
