'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Pacer = require('../app/stream-pacer');

// A manual frame clock: run() advances one frame of the given length.
function harness({ immediate = false } = {}) {
  const frames = new Map(); let next = 1, now = 0;
  const seen = [];
  const pacer = Pacer.create((text, meta) => seen.push({ text, meta }), {
    frame: callback => { const id = next++; frames.set(id, callback); return id; },
    cancelFrame: id => frames.delete(id),
    immediate: () => immediate
  });
  const run = (ms = 16) => { now += ms; const due = [...frames]; frames.clear(); for (const [, callback] of due) callback(now); };
  return { pacer, seen, run, frames };
}

test('a burst is revealed over several frames, in order, without skipping text', () => {
  const { pacer, seen, run, frames } = harness();
  pacer.push('ab', { attemptId: 1 });
  pacer.flush();
  assert.equal(seen.at(-1).text, 'ab');
  pacer.push('ab' + 'x'.repeat(160), { attemptId: 1 });
  assert.equal(seen.length, 1);
  let guard = 0;
  while (frames.size && guard++ < 200) run();
  const texts = seen.map(item => item.text);
  assert.ok(texts.length > 6, 'spread over frames');
  for (let i = 1; i < texts.length; i++) assert.ok(texts[i].startsWith(texts[i - 1]) && texts[i].length > texts[i - 1].length);
  assert.equal(texts.at(-1), 'ab' + 'x'.repeat(160));
  assert.ok(guard < 60, 'catches up within about a second');
});

test('flush shows the full text synchronously and stops pending frames', () => {
  const { pacer, seen, run, frames } = harness();
  pacer.push('a', { attemptId: 1 });
  pacer.push('a' + 'b'.repeat(300), { attemptId: 1 });
  run();
  pacer.flush();
  assert.equal(seen.at(-1).text, 'a' + 'b'.repeat(300));
  assert.equal(frames.size, 0);
  assert.equal(pacer.pending, 0);
});

test('a new attempt, rewrite or shrink is shown immediately', () => {
  const { pacer, seen } = harness();
  pacer.push('hello', { attemptId: 1 });
  pacer.flush();
  pacer.push('hello world and more', { attemptId: 2 });
  assert.equal(seen.at(-1).text, 'hello world and more');
  pacer.push('other text entirely!!', { attemptId: 2 });
  assert.equal(seen.at(-1).text, 'other text entirely!!');
  pacer.push('', { attemptId: 2 });
  assert.equal(seen.at(-1).text, '');
});

test('reduced motion passes every delta straight through', () => {
  const { pacer, seen, frames } = harness({ immediate: true });
  pacer.push('a', { attemptId: 1 });
  pacer.push('a' + 'b'.repeat(100), { attemptId: 1 });
  assert.equal(seen.at(-1).text, 'a' + 'b'.repeat(100));
  assert.equal(frames.size, 0);
});

test('never splits a surrogate pair', () => {
  const { pacer, seen, run, frames } = harness();
  pacer.push('x', { attemptId: 1 });
  pacer.flush();
  pacer.push('x' + '😀'.repeat(80), { attemptId: 1 });
  let guard = 0;
  while (frames.size && guard++ < 200) run();
  for (const { text } of seen) assert.ok(!/[\ud800-\udbff]$/.test(text), 'no lone high surrogate at the cut');
});
