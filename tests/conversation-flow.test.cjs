const test = require('node:test');
const assert = require('node:assert/strict');
const Flow = require('../app/conversation-flow.js');

test('legacy projection is read only, explicit creation starts an empty event log', () => {
  const message = { text: 'historical answer', activities: [{ text: 'historical summary' }], steps: [{ text: 'old stage' }] };
  const before = JSON.stringify(message);
  assert.deepEqual(Flow.entries(message, { toolCalls: [{ id: 'old' }] }), []);
  assert.equal(JSON.stringify(message), before);
  const recorder = Flow.create(message);
  assert.equal(Flow.create(message), recorder);
  assert.deepEqual(message.conversationFlow, { version: 1, nextSeq: 1, items: [] });
  assert.equal(message.text, 'historical answer');
});

test('first observation shares a monotonic sequence across reasoning, response and tools', () => {
  const message = {}, recorder = Flow.create(message);
  const reasoning = recorder.activity({ id: 'thinking', attemptId: 'a1', kind: 'summary', text: 'Check', status: 'running' });
  const response = recorder.response('a1', 'I will query');
  const call = { id: 'query', status: 'queued', request: { query: 'basketball' } };
  const tool = recorder.tool(call);
  recorder.activity({ id: 'thinking', attemptId: 'a1', kind: 'summary', text: 'Check the calendar', status: 'completed' });
  recorder.response('a1', 'I will query the calendar');
  call.status = 'completed'; call.result = { entries: [{ title: 'basketball' }] }; recorder.tool(call);
  const later = recorder.response('a2', 'Your calendar has one event', { status: 'completed' });
  assert.deepEqual(message.conversationFlow.items.map(item => item.seq), [1, 2, 3, 4]);
  assert.deepEqual(message.conversationFlow.items, [reasoning, response, tool, later]);
  assert.equal(message.conversationFlow.nextSeq, 5);
  assert.equal(reasoning.text, 'Check the calendar');
  assert.equal(tool.status, 'completed');
  assert.equal(Object.hasOwn(tool, 'request'), false);
  assert.equal(Object.hasOwn(tool, 'result'), false);
  assert.equal(Object.hasOwn(tool, 'text'), false);
  assert.equal(Flow.entries(message, { toolCalls: [call] })[2].call, call);
});

test('incremental full text updates keep one item and one text copy without trimming', () => {
  const message = {}, recorder = Flow.create(message);
  let text = '  ';
  const item = recorder.response('attempt', text), at = item.at;
  for (let i = 0; i < 1000; i++) {
    text += '😀 long result\n';
    assert.equal(recorder.response('attempt', text), item);
  }
  assert.equal(message.conversationFlow.items.length, 1);
  assert.equal(item.text, text);
  assert.equal(item.at, at);
  assert.equal(recorder.response('attempt', ''), null);
  assert.equal(item.text, text, 'empty incomplete SAFE envelope does not erase already observed prose');
  assert.ok(JSON.stringify(message).length < text.length * 2, 'no retained cumulative snapshots');
});

test('provider-local activity IDs and responses remain distinct across attempts and parents', () => {
  const message = {}, recorder = Flow.create(message);
  for (const attemptId of ['a1', 'a2']) for (const parentId of [undefined, 'child']) {
    recorder.activity({ id: 'provider-reuses-id', attemptId, kind: 'summary', text: attemptId }, { parentId });
    recorder.response(attemptId, 'prose ' + attemptId, { parentId });
  }
  assert.equal(message.conversationFlow.items.length, 8);
  assert.equal(new Set(message.conversationFlow.items.map(item => item.id)).size, 8);
  recorder.settleAttempt('a1', 'cancelled', { parentId: 'child' });
  assert.deepEqual(message.conversationFlow.items.filter(item => item.attemptId === 'a1').map(item => item.status), ['running', 'running', 'cancelled', 'cancelled']);
});

test('rehydration retains identities and sequence when updates resume', () => {
  let message = {};
  Flow.create(message).response('a1', 'before reload');
  Flow.create(message).tool({ id: 'call', status: 'running', parentId: 'parent' });
  message = JSON.parse(JSON.stringify(message));
  const ids = message.conversationFlow.items.map(item => item.id), recorder = Flow.create(message);
  recorder.response('a1', 'after reload', { status: 'completed' });
  recorder.tool({ id: 'call', status: 'completed', parentId: 'parent' });
  recorder.response('a2', 'next');
  assert.deepEqual(message.conversationFlow.items.slice(0, 2).map(item => item.id), ids);
  assert.deepEqual(message.conversationFlow.items.map(item => item.seq), [1, 2, 3]);
});

test('only real public summary and commentary become flow, not stages or provider tools', () => {
  const message = {}, recorder = Flow.create(message);
  for (const value of [
    { id: 'stage', kind: 'phase', text: 'preparing' },
    { id: 'host-tool', kind: 'tool', text: 'tool running' },
    { id: 'retry', kind: 'commentary', source: 'transport', text: 'context retry' },
    { id: 'empty', kind: 'summary', text: '' },
    { id: 'raw', kind: 'reasoning', text: 'unsupported raw reasoning' }
  ]) assert.equal(recorder.activity(value), null);
  recorder.activity({ id: 'actual', kind: 'commentary', text: 'Model public commentary' });
  assert.equal(message.conversationFlow.items.length, 1);
  assert.equal(message.conversationFlow.items[0].kind, 'commentary');
});

test('settlement marks partial records cancelled while preserving old failures and actual completed tools', () => {
  const message = {}, recorder = Flow.create(message);
  const response = recorder.response('attempt', 'partial prose');
  const thinking = recorder.activity({ id: 'think', attemptId: 'attempt', kind: 'summary', text: 'partial reasoning' });
  const failed = recorder.tool({ id: 'bad', status: 'failed' });
  const completed = recorder.tool({ id: 'done', status: 'completed' });
  const pending = recorder.tool({ id: 'still-running', status: 'running' });
  recorder.settleAttempt('attempt', 'cancelled');
  assert.equal(response.status, 'cancelled'); assert.equal(thinking.status, 'cancelled');
  assert.equal(pending.status, 'running', 'attempt completion is not a tool receipt');
  recorder.finish('cancelled');
  recorder.tool({ id: 'bad', status: 'completed' });
  recorder.finish('completed');
  assert.equal(failed.status, 'failed'); assert.equal(completed.status, 'completed'); assert.equal(pending.status, 'cancelled');
  assert.equal(response.text, 'partial prose'); assert.equal(thinking.text, 'partial reasoning');
});

test('successful run finish cannot invent success for an unreturned tool', () => {
  const message = {}, recorder = Flow.create(message);
  recorder.tool({ id: 'missing-receipt', status: 'running' });
  recorder.response('attempt', 'received answer');
  recorder.finish('completed');
  assert.deepEqual(message.conversationFlow.items.map(item => item.status), ['interrupted', 'completed']);
});

test('projection hides only a last top-level response matching main text', () => {
  const message = { text: 'final' }, recorder = Flow.create(message);
  const first = recorder.response('a1', 'final');
  const tool = recorder.tool({ id: 'tool', status: 'completed' });
  assert.deepEqual(Flow.entries(message).map(item => item.id), [first.id, tool.id], 'later tool makes preceding response intermediate');
  recorder.activity({ id: 'reasoning', attemptId: 'a2', kind: 'summary', text: 'more checking' });
  const final = recorder.response('a2', 'final', { status: 'completed' });
  const child = recorder.response('child-attempt', 'final', { parentId: 'child-call' });
  const ids = Flow.entries(message).map(item => item.id);
  assert.ok(ids.includes(first.id)); assert.ok(ids.includes(child.id)); assert.ok(!ids.includes(final.id));
  assert.equal(message.conversationFlow.items.length, 5, 'dedupe is projection only');
});

test('projection never borrows an unrelated tool payload', () => {
  const message = {}, recorder = Flow.create(message);
  recorder.tool({ id: 'missing', status: 'running' });
  const entries = Flow.entries(message, { toolCalls: [{ id: 'other', result: { output: 'must not borrow' } }] });
  assert.equal(Object.hasOwn(entries[0], 'call'), false);
});

test('identifiers and statuses are bounded while full returned text stays intact', () => {
  const message = {}, recorder = Flow.create(message);
  for (const id of ['', 'x'.repeat(257), 'bad\nidentity', 7]) {
    assert.equal(recorder.response(id, 'text'), null);
    assert.equal(recorder.activity({ id, kind: 'summary', text: 'text' }), null);
    assert.equal(recorder.tool({ id, status: 'running' }), null);
  }
  assert.equal(recorder.response('ok', 'text', { parentId: 'bad id' }), null);
  assert.equal(recorder.activity({ id: 'ok', kind: 'summary', text: 'text', status: 'execute-shell' }), null);
  assert.equal(recorder.tool({ id: 'ok', status: { bad: true } }), null);
  assert.equal(message.conversationFlow.items.length, 0);
  const text = 'x'.repeat(100000) + '\nexact tail';
  assert.equal(recorder.response('valid', text).text, text);
  assert.throws(() => Flow.create({ conversationFlow: { version: 99, items: ['keep me'] } }), /Unsupported/);
});

test('maximum escaped identifiers remain readable and malformed ledger entries are not borrowed', () => {
  const message = {}, recorder = Flow.create(message), id = '"'.repeat(256), parentId = '\\'.repeat(256);
  const item = recorder.response(id, 'literal response', { parentId });
  assert.ok(item.id.length <= 1600);
  assert.equal(Flow.entries(message)[0], item);
  const tool = recorder.tool({ id: 'actual', status: 'running' });
  assert.equal(Flow.entries(message, { toolCalls: [null, undefined, {}, { id: 'other' }] }).at(-1).callId, tool.callId);
});
