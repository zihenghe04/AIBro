'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Branches = require('../app/conversation-branches.js');

const message = (id, role, text) => ({ id, role, text, at: 1 });

test('fork preserves the complete original path and keeps the current path up to that message', () => {
  const conversation = { id: 'c1', createdAt: 5, messages: [message('m1', 'user', '第一问'), message('m2', 'agent', '答一'), message('m3', 'user', '第二问'), message('m4', 'agent', '答二')] };
  const result = Branches.fork(conversation, 'm2', 'br1', 100);
  assert.deepEqual(result.activeBranch, { id: 'main', fromMessageId: null, createdAt: 5, historyFormat: 'full-v1' }, '分支时必须留住当前路径的元数据');
  assert.deepEqual(result.keep.map(item => item.id), ['m1', 'm2'], '当前路径应截断到分支点');
  assert.deepEqual(result.branch.messages.map(item => item.id), ['m1', 'm2', 'm3', 'm4'], '旧路径携带分叉点以前的完整上下文');
  assert.equal(result.branch.fromMessageId, 'm2');
  assert.equal(result.afterCount, 2);
  assert.equal(result.branch.historyFormat, 'full-v1');
  // 不改动入参：分支只是新值，写回由调用方决定。
  assert.equal(conversation.messages.length, 4);
  assert.equal(conversation.branches, undefined);
});

test('fork refuses to make an empty branch or a branch from a missing message', () => {
  const conversation = { messages: [message('m1', 'user', '问')] };
  assert.deepEqual(Branches.fork(conversation, 'm1', 'br1', 1), { error: 'empty' }, '末尾没有内容时不制造空分支');
  assert.deepEqual(Branches.fork(conversation, 'nope', 'br1', 1), { error: 'not-found' });
});

test('switching paths swaps the active messages and parks the previous path with its metadata', () => {
  const parkedTail = [message('m1', 'user', '第一问'), message('m2', 'agent', '答一'), message('m3', 'user', '第二问'), message('m4', 'agent', '答二')];
  const conversation = { id: 'c1', createdAt: 5, activeBranchId: 'main', messages: [message('m1', 'user', '第一问'), message('m5', 'agent', '另一个方向')], branches: [{ id: 'br1', fromMessageId: 'm2', messages: parkedTail, historyFormat: 'full-v1', createdAt: 50, at: 60 }] };
  const result = Branches.switchTo(conversation, 'br1', 200);
  assert.equal(result.activeBranchId, 'br1');
  assert.deepEqual(result.messages.map(item => item.id), ['m1', 'm2', 'm3', 'm4'], '应载入目标分支的完整消息');
  const mainEntry = result.branches.find(item => item.id === 'main');
  assert.deepEqual(mainEntry.messages.map(item => item.id), ['m1', 'm5'], '原路径必须完整存档，不丢消息');
  assert.equal(result.branches.some(item => item.id === 'br1'), false, '被激活的分支不应同时留在存档里（否则会出现两份）');
  // 切回主线：调用方必须把 activeBranch / activeBranchId / messages / branches 一并写回（真实调用点即如此）。
  const switched = { ...conversation, activeBranchId: result.activeBranchId, activeBranch: result.activeBranch, messages: result.messages, branches: result.branches };
  const back = Branches.switchTo(switched, 'main', 300);
  assert.deepEqual(back.messages.map(item => item.id), ['m1', 'm5']);
  const brEntry = back.branches.find(item => item.id === 'br1');
  assert.deepEqual(brEntry.messages.map(item => item.id), ['m1', 'm2', 'm3', 'm4'], '切回后原分支内容仍完整');
  assert.equal(brEntry.fromMessageId, 'm2', '激活过一次之后，分支的来源消息仍必须保留');
  assert.equal(back.activeBranch.id, 'main', '活跃路径的元数据必须跟着换回来');
  assert.equal(Branches.activeMeta({ activeBranch: { id: 'br9', fromMessageId: 'm7', createdAt: 9 } }).fromMessageId, 'm7');
  assert.deepEqual(Branches.activeMeta({ activeBranchId: 'br9', createdAt: 3 }), { id: 'br9', fromMessageId: null, createdAt: 3 });
  // Unknown legacy active ancestry must not be parked as a supposedly full path.
  const degraded = Branches.switchTo({ ...switched, activeBranch: undefined }, 'main', 400);
  assert.deepEqual(degraded, { error: 'history-missing' });
});

test('switching never loses messages: every path stays reachable from messages or branches', () => {
  const conversation = { id: 'c1', createdAt: 1, activeBranchId: 'main', messages: [message('m1', 'user', 'A'), message('m2', 'agent', 'B')], branches: [{ id: 'br1', messages: [message('m3', 'user', 'C')], historyFormat: 'full-v1', createdAt: 2, at: 3 }] };
  const collect = value => [...(value.messages || []), ...(value.branches || []).flatMap(item => item.messages || [])].map(item => item.id).sort();
  const before = collect(conversation);
  const result = Branches.switchTo(conversation, 'br1', 400);
  assert.deepEqual(collect({ messages: result.messages, branches: result.branches }), before, '切换前后全部消息必须守恒');
});

test('switching to the current path or an unknown branch is refused, and a stale marker falls back to main', () => {
  const conversation = { messages: [], branches: [{ id: 'br1', messages: [] }], activeBranchId: 'br1' };
  assert.deepEqual(Branches.switchTo(conversation, 'br1', 1), { error: 'same' });
  assert.deepEqual(Branches.switchTo(conversation, 'nope', 1), { error: 'not-found' });
  // 被激活的分支不在 branches 里属于正常状态：不能因此把它当成失效而跳回主线（那会让用户看到错的路径）。
  assert.equal(Branches.currentId({ activeBranchId: 'br1', branches: [] }), 'br1');
  assert.equal(Branches.currentId({ activeBranchId: 'ghost', branches: [{ id: 'other', messages: [] }] }), 'ghost');
  assert.equal(Branches.currentId({ activeBranchId: '   ' }), 'main', '空白标记按未设置处理');
  assert.equal(Branches.currentId({ activeBranchId: 'br1', branches: [{ id: 'br1', messages: [] }] }), 'br1');
  assert.equal(Branches.currentId({}), 'main');
  assert.equal(Branches.count({ messages: [], branches: [{ id: 'br1', messages: [] }, { id: 'br2', messages: [] }] }), 2);
  assert.equal(Branches.count({ messages: [], activeBranchId: 'br1', branches: [{ id: 'br1', messages: [] }, { id: 'br2', messages: [] }] }), 1, '当前所在的分支不计入“其他分支”');
});

test('labels come from the first human message and never invent content', () => {
  assert.equal(Branches.label({ messages: [message('a', 'agent', '模型先说话'), message('b', 'user', '我想换个方向重做这部分')] }), '我想换个方向重做这部分', '短文本不加省略号');
  const long = '我想换个方向重做这部分内容并且写得更长一些用来验证截断行为';
  assert.equal(Branches.label({ messages: [message('b', 'user', long)] }), long.slice(0, 24) + '…', '超长文本才截断');
  assert.equal(Branches.label({ messages: [message('a', 'agent', '只有模型发言')] }), '只有模型发言');
  assert.equal(Branches.label({ messages: [] }), '空分支');
  assert.equal(Branches.label({}), '空分支');
  assert.equal(Branches.describe({ messages: [message('a', 'user', '问')] }), '问 · 1 条');
});
