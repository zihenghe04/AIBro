const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Queue = require('../app/agent-queue');

const clone = value => JSON.parse(JSON.stringify(value));
const entry = (id, at = 1) => ({ id, goal: `Text ${id}\n  keep indentation`, attachmentIds: [`file-${id}`],
  fileReferences: [{ type: 'note', id: `note-${id}` }], skillSnapshot: [{ id: 'skill', instructions: 'Original instructions' }], pdfReadMode: 'text', at });
const conversation = id => ({ id, messages: [], pendingSubmits: [], pendingInjections: [], draft: 'Unsent draft',
  draftAttachmentIds: ['draft-file'], draftFileReferences: [{ type: 'note', id: 'draft-note' }] });

test('new queue and injection submissions share eight slots; freeing one admits exactly one', () => {
  const c = conversation('capacity');
  for (let n = 0; n < 4; n++) assert.ok(Queue.enqueue(c, { goal: `queue ${n}` }, n));
  for (let n = 0; n < 4; n++) assert.ok(Queue.inject(c, { goal: `injection ${n}` }, n));
  const before = clone(c);
  assert.equal(Queue.pendingCount(c), 8);
  assert.equal(Queue.enqueue(c, { goal: 'ninth queue' }), null);
  assert.equal(Queue.inject(c, { goal: 'ninth injection' }), null);
  assert.deepEqual(c, before);
  Queue.shift(c);
  assert.ok(Queue.inject(c, { goal: 'one free slot' }, 99));
  assert.equal(Queue.enqueue(c, { goal: 'still full' }), null);
});

test('legacy full queue plus eight accepted injections settle losslessly in FIFO order and survive reload', () => {
  const c = conversation('legacy');
  c.pendingSubmits = Array.from({ length: 8 }, (_, n) => entry(`queue-${n}`, n));
  c.pendingInjections = Array.from({ length: 8 }, (_, n) => ({ ...entry(`inject-${n}`, n + 10), usedAt: 0 }));
  const originals = c.pendingSubmits.slice(), accepted = clone(c.pendingInjections), composer = [c.draft, clone(c.draftAttachmentIds), clone(c.draftFileReferences)];
  const result = Queue.settleInjections(c);
  assert.equal(result.used.length, 0); assert.deepEqual(result.queued, accepted);
  assert.deepEqual(c.pendingSubmits.slice(8), accepted);
  assert.ok(originals.every((item, n) => c.pendingSubmits[n] === item));
  assert.deepEqual(c.pendingInjections, []);
  assert.deepEqual([c.draft, c.draftAttachmentIds, c.draftFileReferences], composer);
  const restored = clone(c), ids = [];
  assert.equal(Queue.enqueue(restored, { goal: 'new input cannot bypass capacity' }), null);
  assert.equal(Queue.inject(restored, { goal: 'new injection cannot bypass capacity' }), null);
  assert.deepEqual(Queue.settleInjections(restored), { used: [], queued: [] });
  while (Queue.count(restored)) ids.push(Queue.shift(restored).id);
  assert.deepEqual(ids, [...originals, ...accepted].map(item => item.id));
});

test('used supplements remain separate from queued supplements and absent attachment context stays empty', () => {
  const c = conversation('mixed');
  c.pendingInjections = [{ id: 'used', goal: 'Already sent', at: 10, usedAt: 20 }, { id: 'unused', goal: 'Not sent', at: 11, usedAt: 0 }];
  const result = Queue.settleInjections(c);
  assert.deepEqual(result.used.map(item => item.id), ['used']);
  assert.equal(result.queued[0].id, 'unused'); assert.equal(result.queued[0].at, 11);
  assert.deepEqual(result.queued[0].attachmentIds, []);
  assert.deepEqual(c.draftAttachmentIds, ['draft-file']);
  assert.deepEqual(Queue.settleInjections(null), { used: [], queued: [] });
});

function host() {
  const source = fs.readFileSync('app/app.js', 'utf8');
  const segment = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const a = conversation('owner'), b = conversation('other');
  const input = { value: a.draft, style: {}, events: 0, dispatchEvent() { this.events++; context.current.draft = this.value; } };
  const notices = [], saves = [], calls = { consume: 0, render: 0, timer: 0 };
  let serial = 0;
  const context = { window: { AgentQueue: Queue, FileContext: {
    references: c => c.draftFileReferences,
    consume: () => { calls.consume++; }, render() {}
  } }, state: { conversations: [a, b], agentRuns: [{ id: 'run-owner', conversationId: a.id, status: 'running' }] },
  current: a, currentConversation: () => context.current, activeRunId: 'run-owner', activeRunController: { signal: { aborted: false } },
  sendMessage: { busy: true }, $: () => input, toast: value => notices.push(value), save: () => saves.push(clone(context.state)),
  renderComposerQueue: () => calls.render++, currentAttachments: () => context.current.draftAttachmentIds.map(id => ({ id })),
  draftSaveTimer: 1, clearTimeout: () => calls.timer++, Event: class {}, uid: () => `message-${++serial}`, Date };
  vm.createContext(context);
  vm.runInContext([
    segment('function queueComposerSubmit()', 'function submitComposer()'),
    segment('function injectComposer()', '// 放在文件尾部'),
    segment('function settleComposerInjections(', '\nwindow.GoalLoop?.init')
  ].join('\n'), context);
  return { context, a, b, input, notices, saves, calls };
}

test('actual host rejects a ninth queued input without clearing text, attachments, references or timer', () => {
  const f = host();
  f.a.pendingInjections = Array.from({ length: 8 }, (_, n) => ({ id: `i-${n}`, goal: `supplement ${n}`, usedAt: 0 }));
  const before = clone(f.a);
  assert.equal(f.context.queueComposerSubmit(), false);
  assert.deepEqual(f.a, before); assert.equal(f.input.value, before.draft);
  assert.deepEqual(f.calls, { consume: 0, render: 0, timer: 0 });
  assert.equal(f.saves.length, 0); assert.match(f.notices.at(-1), /排队与中途补充合计最多 8.*已保留/);
});

test('actual host rejects a ninth supplement with full queue while retaining composer context', () => {
  const f = host(); f.a.pendingSubmits = Array.from({ length: 8 }, (_, n) => entry(`q-${n}`));
  const before = clone(f.a);
  assert.equal(f.context.injectComposer(), null);
  assert.deepEqual(f.a, before); assert.equal(f.input.events, 0); assert.equal(f.input.value, before.draft);
  assert.equal(f.saves.length, 0); assert.match(f.notices.at(-1), /合计最多 8.*已保留/);
});

test('actual host only admits a supplement to its currently running conversation', () => {
  for (const change of [f => { f.context.current = f.b; }, f => { f.context.activeRunController.signal.aborted = true; },
    f => { f.context.sendMessage.busy = false; }, f => { f.context.state.agentRuns[0].status = 'completed'; }]) {
    const f = host(); change(f);
    const before = clone(f.context.state);
    assert.equal(f.context.injectComposer(), null);
    assert.deepEqual(f.context.state, before); assert.equal(f.input.events, 0); assert.equal(f.saves.length, 0);
    assert.match(f.notices.at(-1), /当前对话没有正在接收补充/);
  }
});

test('actual host admission and settlement retain input exactly once without consuming staged files', () => {
  const f = host(); f.input.value = 'Supplement\n  preserve layout';
  const accepted = f.context.injectComposer(); assert.ok(accepted);
  assert.equal(f.input.value, ''); assert.equal(f.a.draft, ''); assert.equal(f.input.events, 1);
  assert.deepEqual(f.a.draftAttachmentIds, ['draft-file']); assert.equal(f.calls.consume, 0);
  f.context.settleComposerInjections(f.a);
  assert.equal(f.a.pendingSubmits.length, 1); assert.equal(f.a.pendingSubmits[0].id, accepted.id);
  assert.equal(f.a.pendingSubmits[0].goal, 'Supplement\n  preserve layout');
  assert.deepEqual(f.a.pendingSubmits[0].attachmentIds, []); assert.equal(f.a.messages.length, 0);
  f.context.settleComposerInjections(f.a);
  assert.equal(f.a.pendingSubmits.length, 1); assert.equal(f.saves.length, 2);
});

test('actual host settlement preserves accepted legacy overflow in the owner after switching conversations', () => {
  const f = host(); f.a.pendingSubmits = Array.from({ length: 8 }, (_, n) => entry(`q-${n}`, n));
  f.a.pendingInjections = [{ id: 'sent', goal: 'In request', at: 10, usedAt: 20 }, { ...entry('pending', 11), usedAt: 0 }];
  const accepted = clone(f.a.pendingInjections[1]), prefix = clone(f.a.pendingSubmits), other = clone(f.b);
  f.context.current = f.b; f.input.value = 'New draft in another conversation';
  f.context.settleComposerInjections(f.a);
  assert.deepEqual(f.a.pendingSubmits.slice(0, 8), prefix); assert.deepEqual(f.a.pendingSubmits[8], accepted);
  assert.equal(f.a.messages.length, 1); assert.equal(f.a.messages[0].text, 'In request'); assert.equal(f.a.messages[0].midRun, true);
  assert.deepEqual(f.a.pendingInjections, []); assert.deepEqual(f.b, other);
  assert.equal(f.input.value, 'New draft in another conversation'); assert.equal(f.calls.consume, 0);
  assert.deepEqual(f.saves.at(-1).conversations[0].pendingSubmits[8], accepted);
  assert.match(f.notices.at(-1), /1 条补充已转为排队/);
  f.context.settleComposerInjections(f.a);
  assert.equal(f.a.messages.length, 1); assert.equal(f.a.pendingSubmits.length, 9); assert.equal(f.saves.length, 1);
});
