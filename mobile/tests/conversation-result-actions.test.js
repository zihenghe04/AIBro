// Invoke the production main.js mount/click callback against durable Store
// reloads. Only the DOM/component boundary is replaced; no navigation rewrite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store, MemoryAdapter } from '../src/store.js';
import { conversationMessage, conversationResults } from '../src/conversation-results.js';
import { reviewRemoval, removeRecord } from '../src/lifecycle.js';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const mountSource = main.slice(main.indexOf('function mountMessageResults()'), main.indexOf('\nfunction liveHTML('));
const receipt = (id, kind = 'tasks') => ({ operation: 'create', kind, id, title: `${kind} ${id}` });

async function fixture(receipts = [receipt('a'), receipt('b')]) {
  let current = await new Store(new MemoryAdapter()).load();
  await current.put('conversations', { id: 'c', title: '合成结果会话' });
  for (const id of ['a', 'b']) {
    await current.put('tasks', { id, title: `任务 ${id}`, description: '原说明', status: 'todo' });
    await current.put('notes', { id, title: `笔记 ${id}`, content: '同 ID 不同类型', kind: 'note' });
  }
  await current.put('messages', { id: 'm', conversationId: 'c', role: 'assistant', status: 'completed',
    pendingPlan: { id: 'plan', conversationID: 'c', status: 'applied', receipts } });
  const root = { isConnected: true, replaceChildren() {} }, opens = [], recoveries = [], mounts = [];
  let unmounts = 0;
  const store = { get state() { return current.state; } };
  const mount = new Function('app', 'store', 'messageForAction', 'conversationResults',
    'mountConversationResults', 'openResultTarget', 'openRecoveryReview', 'resultIslands',
    mountSource + ';return mountMessageResults;')(
    { querySelectorAll: () => [root] }, store,
    () => conversationMessage(current, { conversationID: 'c', messageID: 'm', key: 'messages:m' }),
    conversationResults, (_root, props) => {
      mounts.push(props); return Promise.resolve({ unmount() { unmounts++; } });
    }, target => opens.push({ ...target, data: current.get(target.kind, target.id) }),
    key => recoveries.push(key), []);
  const remount = async () => { mount(); await Promise.resolve(); };
  await remount();
  return {
    root, opens, recoveries, mounts, remount, get unmounts() { return unmounts; },
    get store() { return current; },
    async update(fn) { await current.tx(fn); current = await new Store(current.adapter).load(); },
  };
}

test('real main result callback follows bound entity across reorder and edits, never replacement kind/plan/message', async () => {
  const f = await fixture(), rendered = f.mounts[0], first = rendered.model.items[0];
  await f.remount();
  assert.equal(f.mounts.length, 1, 'reconciliation must not mount the same root twice');
  await f.update(state => {
    state.records['messages:m'].data.pendingPlan.receipts.reverse();
    state.records['tasks:a'].data.description = '同一任务的新说明';
  });
  rendered.onOpen(first.key);
  assert.equal(f.opens.at(-1).id, 'a');
  assert.equal(f.opens.at(-1).data.description, '同一任务的新说明');
  await f.update(state => state.records['messages:m'].data.pendingPlan.receipts = [receipt('a', 'notes'), receipt('b')]);
  assert.throws(() => rendered.onOpen(first.key), /结果已变化/);
  assert.equal(f.opens.length, 1, 'old task card cannot redirect to a same-ID note or another task');
  await f.update(state => {
    const plan = state.records['messages:m'].data.pendingPlan;
    plan.receipts = [receipt('a')]; plan.id = 'other-plan';
  });
  assert.throws(() => rendered.onOpen(first.key), /结果已变化/);
  await f.update(state => {
    const message = state.records['messages:m'].data;
    message.pendingPlan.id = 'plan'; message.id = 'replacement-message';
  });
  assert.throws(() => rendered.onOpen(first.key), /结果已变化/);
  assert.equal(f.opens.length, 1);
});

test('real main callback binds individual restored targets and refreshes only its owned island', async () => {
  const restored = { operation: 'restore', lifecycleOperation: 'restore-trash', kind: 'trash', id: 'package',
    restored: [{ kind: 'tasks', id: 'a', title: '恢复任务' }, { kind: 'notes', id: 'a', title: '恢复笔记' }] };
  const f = await fixture([restored]), old = f.mounts[0], first = old.model.items[0];
  await f.update(state => state.records['messages:m'].data.pendingPlan.receipts[0].restored.reverse());
  old.onOpen(first.key);
  assert.equal(f.opens.at(-1).kind, 'tasks'); assert.equal(f.opens.at(-1).id, 'a');
  await f.remount();
  assert.equal(f.mounts.length, 2); assert.equal(f.unmounts, 1);
  await f.remount(); assert.equal(f.mounts.length, 2);
  await f.update(state => state.records['messages:m'].data.pendingPlan.receipts[0].restored = [{ kind: 'tasks', id: 'b' }]);
  assert.throws(() => old.onOpen(first.key), /结果已变化/);
  assert.equal(f.opens.length, 1);
  f.root.isConnected = false;
  assert.throws(() => old.onOpen(first.key), /结果已变化/);
});

test('real main recovery callback rejects a changed package even when receipt target is unchanged', async () => {
  const f = await fixture();
  const a = await removeRecord(f.store, reviewRemoval(f.store, 'tasks:a'));
  const b = await removeRecord(f.store, reviewRemoval(f.store, 'tasks:b'));
  await f.update(state => state.records['messages:m'].data.pendingPlan.receipts = [{
    operation: 'remove', lifecycleOperation: 'trash', kind: 'tasks', id: 'a', title: '移除任务 A', recoveryKey: a.recoveryKey,
  }]);
  await f.remount();
  const rendered = f.mounts.at(-1), card = rendered.model.items[0];
  assert.equal(card.recoveryKey, a.recoveryKey);
  rendered.onOpen(card.key); assert.deepEqual(f.recoveries, [a.recoveryKey]);
  await f.update(state => state.records['messages:m'].data.pendingPlan.receipts[0].recoveryKey = b.recoveryKey);
  assert.throws(() => rendered.onOpen(card.key), /结果已变化/);
  assert.deepEqual(f.recoveries, [a.recoveryKey]); assert.deepEqual(f.opens, []);
});
