'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Guard = require('../app/tool-loop-guard.js');

const call = (request, status = 'completed', id = 't') => ({ id, type: request.type, request, status });

test('the same tool with the same key parameters is one signature; a changed parameter is not', () => {
  assert.equal(Guard.signature({ type: 'read', id: 'note_1' }), Guard.signature({ type: 'read', id: 'note_1' }));
  assert.notEqual(Guard.signature({ type: 'read', id: 'note_1' }), Guard.signature({ type: 'read', id: 'note_2' }));
  assert.notEqual(Guard.signature({ type: 'read', id: 'note_1' }), Guard.signature({ type: 'search', id: 'note_1' }));
  // 分页读取（offset 变化）必须被当成不同调用——正常分批读取不能被误判成空转。
  assert.notEqual(Guard.signature({ type: 'read', id: 'note_1', offset: 0 }), Guard.signature({ type: 'read', id: 'note_1', offset: 800 }));
  assert.equal(Guard.signature(null), '');
  assert.equal(Guard.signature({}), '', '没有工具类型的请求不参与判定');
});

test('only finished calls count, and only the identical-signature ones accumulate', () => {
  const calls = [
    call({ type: 'read', id: 'a' }, 'completed', 't1'),
    call({ type: 'read', id: 'a' }, 'completed', 't2'),
    call({ type: 'read', id: 'a' }, 'queued', 't3'),      // 排队中：还没真的执行过
    call({ type: 'read', id: 'a' }, 'running', 't4'),     // 进行中：同上
    call({ type: 'read', id: 'b' }, 'completed', 't5'),   // 不同对象：不计入同一签名
  ];
  const tally = Guard.tally(calls);
  assert.equal(tally.get(Guard.signature({ type: 'read', id: 'a' })).count, 2);
  assert.equal(tally.get(Guard.signature({ type: 'read', id: 'b' })).count, 1);
});

test('the guard reports only after reaching the limit, and says how many times it happened', () => {
  const once = [call({ type: 'read', id: 'a' }, 'completed', 't1')];
  assert.deepEqual(Guard.inspect(once).repeated, [], '一次调用不是空转');
  const many = Array.from({ length: Guard.LIMIT }, (_, index) => call({ type: 'read', id: 'a' }, 'completed', 't' + index));
  const report = Guard.inspect(many);
  assert.equal(report.limit, Guard.LIMIT);
  assert.equal(report.repeated.length, 1);
  assert.equal(report.repeated[0].count, Guard.LIMIT);
  assert.equal(report.repeated[0].type, 'read');
  // 恰好在阈值下方一次时仍然不报。
  assert.deepEqual(Guard.inspect(many.slice(0, Guard.LIMIT - 1)).repeated, []);
  // 失败也会累计：反复失败的同一个调用同样属于空转。
  const failing = Array.from({ length: Guard.LIMIT }, (_, index) => call({ type: 'web_read', url: 'https://x.invalid/a' }, 'failed', 'f' + index));
  assert.equal(Guard.inspect(failing).repeated.length, 1);
});

test('the message states the mechanism and the cost honestly, and never claims a cause it cannot know', () => {
  const report = Guard.inspect(Array.from({ length: Guard.LIMIT + 2 }, (_, index) => call({ type: 'read', id: 'a' }, 'completed', 't' + index)));
  const text = Guard.describe(report.repeated[0], report.limit);
  assert.match(text, /重复调用/);
  assert.match(text, /调用 6 次/);
  assert.match(text, /完整上下文/, '必须说明代价来自每步重发上下文');
  assert.match(text, /调整指令或参数后重发/);
  assert.doesNotMatch(text, /模型出错|模型有 bug|肯定是/, '不确定的归因不能说死');
  assert.equal(Guard.describe(null), '');
});

test('changed budgets and argv boundaries are distinct while default cursors are equivalent',()=>{
 assert.notEqual(Guard.signature({type:'search',query:'a',maxTokens:500}),Guard.signature({type:'search',query:'a',maxTokens:2000}));
 assert.notEqual(Guard.signature({type:'terminal',argv:['tool','a\u0001b']}),Guard.signature({type:'terminal',argv:['tool','a','b']}));
 assert.notEqual(Guard.signature({type:'terminal',argv:['tool'],timeout:10}),Guard.signature({type:'terminal',argv:['tool'],timeout:60}));
 assert.equal(Guard.signature({type:'read',id:'a'}),Guard.signature({type:'read',id:'a',recordType:'note',variant:'current',offset:0}));
 const unstarted=Array.from({length:4},()=>call({type:'terminal',argv:['pwd']},'cancelled'));
 assert.deepEqual(Guard.inspect(unstarted).repeated,[],'queued cancellations are not actual attempts');
 assert.equal(Guard.inspect(unstarted.map(c=>({...c,startedAt:1}))).repeated.length,1);
});

test('repeated snapshots count as spinning only while the page content is unchanged', () => {
  const snap = (text, id) => ({ id, type: 'browser_snapshot', request: { type: 'browser_snapshot' }, status: 'completed', result: { url: 'https://x.test/', title: 'T', elements: [1, 2], text } });
  const same = [1, 2, 3, 4].map(n => snap('same page', 's' + n));
  assert.equal(Guard.inspect(same, 4).repeated.length, 1, 'identical content still trips the guard');
  const changing = [snap('loading', 's1'), snap('loading', 's2'), snap('login form', 's3'), snap('signed in', 's4')];
  assert.equal(Guard.inspect(changing, 4).repeated.length, 0, 'content that changed is progress');
});
