const test = require('node:test');
const assert = require('node:assert/strict');
const Progress = require('../app/agent-progress');

test('public event deltas update one row; unrelated raw reasoning is ignored', () => {
  const message = {};
  Progress.update(message, {id:'s1',kind:'summary',text:'读取',status:'running'}, 10);
  Progress.update(message, {id:'s1',kind:'summary',text:'读取课程要求',status:'completed'}, 20);
  Progress.update(message, {id:'raw',kind:'reasoning',text:'DO_NOT_DISPLAY'}, 21);
  assert.equal(message.activities.length,1);
  assert.deepEqual(message.activities[0], {id:'s1',kind:'summary',name:'',text:'读取课程要求',status:'completed',at:10,updatedAt:20});
  assert.doesNotMatch(Progress.markup(message), /DO_NOT_DISPLAY/);
});
test('status remains truthful for stop, failure, pending approval, and old messages', () => {
  const source = {steps:[{text:'读取课件',status:'done'}]};
  for (const [status,title] of [['cancelled','已停止'],['failed','执行失败'],['awaiting-approval','等待审批'],['rejected','已拒绝']]) {
    assert.ok(Progress.markup({...source,runStatus:status}).includes(title));
  }
  assert.doesNotMatch(Progress.markup(source), /progress-heading-text">已完成/);
  assert.match(Progress.markup({...source,retryRunId:'old'}), /执行失败/);
  const message = {activities:[{id:'a',kind:'tool',text:'Tool',status:'completed'}, {id:'b',kind:'summary',text:'...',status:'running'}, {id:'c',kind:'tool',text:'Proposed',status:'pending'}]};
  Progress.finish(message,'cancelled');
  assert.deepEqual(message.activities.map(row=>row.status),['completed','cancelled','pending']);
});
test('feed escapes streamed source text and sorts real operation timestamps', () => {
  const message={live:true,at:1,steps:[{id:'s',text:'存入项目',at:5,status:'running'}]};
  Progress.update(message,{id:'a\" onclick=\"bad',kind:'summary',name:'x',text:'<img src=x onerror=alert(1)>',status:'completed'},2);
  assert.deepEqual(Progress.entries(message).map(x=>x.kind),['summary','step']);
  const html=Progress.markup(message);
  assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);assert.match(html,/id="a&quot;/);
});
test('activity storage is bounded, ids stable after normalization, and snapshots contain final status', () => {
  const message={};
  for(let n=0;n<110;n++)Progress.update(message,{id:'activity-'+n,kind:'summary',text:'a'.repeat(6000)},n+1);
  assert.equal(message.activities.length,100);assert.equal(message.activities[0].id,'activity-10');
  assert.equal(message.activities[0].text.length,4000);
  const id='x'.repeat(200); Progress.update(message,{id,kind:'tool',status:'running'},200);Progress.update(message,{id,kind:'tool',status:'failed'},210);
  assert.equal(message.activities.filter(x=>x.id===id.slice(0,180)).length,1);
  const restored=JSON.parse(JSON.stringify(message));assert.equal(restored.activities.at(-1).status,'failed');
});
