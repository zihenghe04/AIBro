'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const B = require('../app/conversation-branches.js');
const msg = (id, text = id, role = id.startsWith('u') ? 'user' : 'agent') => ({ id, role, text, at: 1 });
const ids = messages => messages.map(m => m.id);
const base = () => ({ id: 'fictional-course', createdAt: 1, messages: [msg('u1', '虚构材料：条件A'), msg('a1', '条件A摘要'), msg('u2', '比较条件B'), msg('a2', 'A与B不同')] });
function applyFork(c, result) { assert.equal(result.error, undefined); return { ...c, messages: result.keep, branches: [...B.branchList(c), result.branch], activeBranch: result.activeBranch }; }
function applySwitch(c, id) { const result = B.switchTo(c, id, 10); assert.equal(result.error, undefined); return { ...c, ...result }; }
function unchanged(c, action, reason) { const before = JSON.stringify(c); assert.equal(action().error, reason); assert.equal(JSON.stringify(c), before); }
const hostSource = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
function actualHostHistory(conversation) {
  const expression = hostSource.match(/const historyEntries = conversation\.messages\.filter\([^\n]+/)[0];
  const scope = { conversation }; vm.createContext(scope); vm.runInContext(expression + '\nglobalThis.result = historyEntries;', scope); return scope.result;
}

test('fork and return preserve the complete original path in the actual host history selector', () => {
  const c = base(); c.messages[0].attachmentIds = ['fictional-pdf'];
  const before = JSON.stringify(c), fork = B.fork(c, 'a1', 'old-path', 2);
  assert.deepEqual(ids(fork.keep), ['u1', 'a1']); assert.deepEqual(ids(fork.branch.messages), ['u1', 'a1', 'u2', 'a2']);
  assert.equal(fork.afterCount, 2); assert.equal(fork.branch.historyFormat, 'full-v1');
  assert.equal(B.label(fork.branch), '比较条件B', 'a branch is named for its own continuation, not the common opening');
  const current = applyFork(c, fork); current.messages.push(msg('u3', '换个方向'));
  const original = applySwitch(current, 'old-path');
  assert.deepEqual(ids(actualHostHistory(original)), ['u1', 'a1', 'u2', 'a2']);
  assert.deepEqual(original.messages[0].attachmentIds, ['fictional-pdf']);
  assert.deepEqual(ids(applySwitch(original, 'main').messages), ['u1', 'a1', 'u3']);
  assert.equal(JSON.stringify(c), before, 'pure transitions must not mutate the source conversation');
});

test('nested new forks retain their full ancestry across restart and repeated switches', () => {
  let c = applyFork(base(), B.fork(base(), 'a1', 'original', 2));
  c.messages.push(msg('u3'), msg('a3')); c = applyFork(c, B.fork(c, 'u3', 'second', 3));
  c = JSON.parse(JSON.stringify(c));
  const second = applySwitch(c, 'second'); assert.deepEqual(ids(second.messages), ['u1', 'a1', 'u3', 'a3']);
  const original = applySwitch(second, 'original'); assert.deepEqual(ids(original.messages), ['u1', 'a1', 'u2', 'a2']);
  assert.deepEqual(ids(applySwitch(original, 'main').messages), ['u1', 'a1', 'u3']);
});

test('a legacy archived tail recovers only the prefix through its exact fork point', () => {
  const c = base(); c.messages = [c.messages[0], c.messages[1], msg('u3', 'new direction')];
  c.branches = [{ id: 'old', fromMessageId: 'a1', messages: [msg('u2'), msg('a2')] }];
  const before = JSON.stringify(c), next = B.switchTo(c, 'old', 5);
  assert.deepEqual(ids(next.messages), ['u1', 'a1', 'u2', 'a2']); assert.equal(next.activeBranch.historyFormat, 'full-v1');
  assert.equal(JSON.stringify(c), before); assert.equal(next.branches[0].historyFormat, 'full-v1');
});

test('an active legacy tail also recovers before being parked', () => {
  const c = { id: 'c', messages: [msg('u2'), msg('a2')], activeBranch: { id: 'old', fromMessageId: 'a1' },
    branches: [{ id: 'main', fromMessageId: null, messages: [msg('u1'), msg('a1'), msg('u3')] }] };
  const next = B.switchTo(c, 'main', 4);
  assert.deepEqual(ids(next.messages), ['u1', 'a1', 'u3']);
  assert.deepEqual(ids(next.branches.find(b => b.id === 'old').messages), ['u1', 'a1', 'u2', 'a2']);
  assert.deepEqual(ids(B.fork(c, 'u2', 'again', 5).keep), ['u1', 'a1', 'u2']);
});

test('nested legacy tails resolve their proven ancestor chain without touching unrelated branches', () => {
  const c = { id: 'c', messages: [msg('u1'), msg('a1')], branches: [
    { id: 'first', fromMessageId: 'a1', messages: [msg('u2'), msg('a2')] },
    { id: 'second', fromMessageId: 'a2', messages: [msg('u3'), msg('a3')] },
    { id: 'unrelated-missing', fromMessageId: 'absent', messages: [msg('u9')] }
  ] };
  const next = B.switchTo(c, 'second', 6);
  assert.deepEqual(ids(next.messages), ['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
  assert.equal(next.branches.find(b => b.id === 'first'), c.branches[0]);
  assert.equal(next.branches.find(b => b.id === 'unrelated-missing'), c.branches[2]);
});

test('missing or unknown legacy ancestry fails explicitly and leaves saved arrays unchanged', () => {
  for (const branch of [{ id: 'old', fromMessageId: 'absent', messages: [msg('u2')] }, { id: 'old', messages: [msg('u2')] }]) {
    const c = { ...base(), branches: [branch] }; unchanged(c, () => B.switchTo(c, 'old', 1), 'history-missing');
  }
});

test('multiple conflicting ancestor prefixes are never guessed from IDs alone', () => {
  const c = { id: 'c', messages: [msg('u1', 'original'), msg('a1')], branches: [
    { id: 'alternative', fromMessageId: null, historyFormat: 'full-v1', messages: [msg('u1', 'edited'), msg('a1')] },
    { id: 'old', fromMessageId: 'a1', messages: [msg('u2')] }
  ] };
  unchanged(c, () => B.switchTo(c, 'old', 1), 'history-ambiguous');
  c.branches[0].messages[0].text = 'original';
  assert.deepEqual(ids(B.switchTo(c, 'old', 2).messages), ['u1', 'a1', 'u2']);
});

test('duplicate message or branch identities and ancestry cycles fail without dropping or copying data', () => {
  const duplicate = { ...base(), branches: [{ id: 'old', fromMessageId: 'a1', messages: [msg('u2'), msg('u2')] }] };
  unchanged(duplicate, () => B.switchTo(duplicate, 'old', 1), 'history-invalid');
  const duplicateBranches = { ...base(), branches: [{ id: 'same', historyFormat: 'full-v1', messages: [] }, { id: 'same', historyFormat: 'full-v1', messages: [] }] };
  unchanged(duplicateBranches, () => B.switchTo(duplicateBranches, 'same', 1), 'history-ambiguous');
  const cycle = { ...base(), branches: [{ id: 'x', fromMessageId: 'u9', messages: [msg('u8')] }, { id: 'y', fromMessageId: 'u8', messages: [msg('u9')] }] };
  unchanged(cycle, () => B.switchTo(cycle, 'x', 1), 'history-missing');
});

test('unknown future history formats are refused rather than silently treated as legacy tails', () => {
  const c = { ...base(), branches: [{ id: 'old', fromMessageId: 'a1', historyFormat: 'future-v9', messages: [msg('u2')] }] };
  unchanged(c, () => B.switchTo(c, 'old', 1), 'history-unsupported');
  const active = { ...base(), activeBranch: { id: 'main', historyFormat: 'future-v9' } };
  unchanged(active, () => B.fork(active, 'a1', 'branch', 2), 'history-unsupported');
});

test('live paths cannot be detached and deleted anchors cannot create a branch', () => {
  const c = base(); c.messages[3].live = true;
  unchanged(c, () => B.fork(c, 'a1', 'branch', 2), 'running');
  c.branches = [{ id: 'settled', historyFormat: 'full-v1', messages: [msg('u5')] }];
  unchanged(c, () => B.switchTo(c, 'settled', 2), 'running');
  delete c.messages[3].live; c.messages[1].deletedAt = 1;
  unchanged(c, () => B.fork(c, 'a1', 'branch', 2), 'not-found');
});

test('empty full paths remain valid and branch ID collisions never replace old paths', () => {
  const c = { ...base(), branches: [{ id: 'empty', historyFormat: 'full-v1', messages: [] }] };
  assert.deepEqual(B.switchTo(c, 'empty', 2).messages, []);
  unchanged(c, () => B.fork(c, 'a1', 'empty', 2), 'duplicate-branch');
  unchanged(c, () => B.fork(c, 'a1', 'main', 2), 'duplicate-branch');
});

test('derived transitions leave composer, attachments, queued work and other conversations untouched', () => {
  const c = Object.assign(base(), { draft: '输入法草稿', draftAttachmentIds: ['file'], queuedMessages: [{ id: 'q', text: 'later' }], contextSummary: { version: 1 } });
  const before = JSON.stringify(c), result = B.fork(c, 'a1', 'old', 2);
  const next = applyFork(c, result); next.messages.push(msg('u3'));
  const switched = applySwitch(next, 'old');
  assert.equal(switched.draft, c.draft); assert.equal(switched.draftAttachmentIds, c.draftAttachmentIds);
  assert.equal(switched.queuedMessages, c.queuedMessages); assert.equal(JSON.stringify(c), before);
});


test('archived prefixes remain independent when current messages gain retry fields or are dismissed', () => {
  const c = base(); c.messages[0].attachments = [{ id: 'fictional-pdf', name: 'original.pdf' }];
  const result = B.fork(c, 'a1', 'old', 2), current = applyFork(c, result);
  current.messages[0].retryAttachmentIds = []; current.messages[0].attachments[0].name = 'changed.pdf';
  current.messages[1].deletedAt = 3;
  assert.equal(current.branches[0].messages[0].retryAttachmentIds, undefined);
  assert.equal(current.branches[0].messages[0].attachments[0].name, 'original.pdf');
  assert.equal(current.branches[0].messages[1].deletedAt, undefined);
  const before = JSON.stringify(current), restored = applySwitch(current, 'old');
  restored.messages[0].attachments[0].name = 'after-switch.pdf'; restored.messages[1].text = 'new text';
  assert.equal(restored.branches[0].messages[0].attachments[0].name, 'changed.pdf');
  assert.equal(restored.branches[0].messages[1].text, '条件A摘要');
  assert.equal(JSON.stringify(current), before, 'destination and parked paths own separate serialized messages');
});
