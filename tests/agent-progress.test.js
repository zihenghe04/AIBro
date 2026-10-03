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
test('activity storage retains all supplied details, ids stay stable, and snapshots contain final status', () => {
  const message={};
  for(let n=0;n<110;n++)Progress.update(message,{id:'activity-'+n,kind:'summary',text:'a'.repeat(6000)},n+1);
  assert.equal(message.activities.length,110);assert.equal(message.activities[0].id,'activity-0');
  assert.equal(message.activities[0].text.length,6000);
  const id='x'.repeat(200); Progress.update(message,{id,kind:'tool',status:'running'},200);Progress.update(message,{id,kind:'tool',status:'failed'},210);
  assert.equal(message.activities.filter(x=>x.id===id.slice(0,180)).length,1);
  const restored=JSON.parse(JSON.stringify(message));assert.equal(restored.activities.at(-1).status,'failed');
});
test('streaming segments open automatically and settled segments collapse on the next paint', () => {
  const message={live:true,at:1};
  Progress.update(message,{id:'s1',kind:'summary',text:'正在阅读课程要求',status:'running'},2);
  assert.match(Progress.markup(message),/data-progress-key="s1" open/);
  Progress.update(message,{id:'s1',kind:'summary',text:'课程要求已读完',status:'completed'},3);
  Progress.update(message,{id:'s2',kind:'tool',name:'读取文件',text:'定位第 3 页',status:'running'},4);
  const html=Progress.markup(message);
  assert.doesNotMatch(html,/data-progress-key="s1" open/);assert.match(html,/data-progress-key="s2" open/);assert.match(html,/data-progress-key="feed" open/);
  const settled=Progress.markup({...message,live:false});
  assert.doesNotMatch(settled,/data-progress-key="feed" open/);assert.doesNotMatch(settled,/data-progress-key="s2" open/);
});
test('user pin overrides the automatic breathing rule in both directions and stays idempotent', () => {
  const message={live:true,at:1};
  Progress.update(message,{id:'s1',kind:'summary',text:'思考中',status:'running'},2);
  assert.equal(Progress.pin(message,'s1',false),true);assert.doesNotMatch(Progress.markup(message),/data-progress-key="s1" open/);
  Progress.update(message,{id:'s1',kind:'summary',text:'思考完成',status:'completed'},3);
  assert.equal(Progress.pin(message,'s1',true),true);assert.match(Progress.markup(message),/data-progress-key="s1" open/);
  assert.equal(Progress.pin(message,'s1',true),false);assert.equal(Progress.pin(message,'feed',true),true);
  assert.match(Progress.markup(message),/data-progress-key="feed" open/);
  assert.equal(Progress.pin(message,'',true),false);assert.equal(Progress.pin(null,'s1',true),false);
});
test('a live run with no active segment shows the waiting status line instead of a stale title', () => {
  const message={live:true,at:1};
  Progress.update(message,{id:'t1',kind:'tool',name:'读取文件',text:'定位第 3 页',status:'completed'},2);
  const waiting=Progress.markup(message);
  assert.match(waiting,/progress-heading-text">等待模型继续/);
  Progress.update(message,{id:'t2',kind:'summary',text:'继续思考中',status:'running'},3);
  assert.doesNotMatch(Progress.markup(message),/等待模型继续/);
  assert.match(Progress.markup(message),/progress-heading-text">继续思考中/);
  Progress.update(message,{id:'t2',kind:'summary',text:'思考完成',status:'completed'},4);
  assert.match(Progress.markup({...message,live:false}),/progress-heading-text">执行记录/);
});
test('segments with real timestamps show their own cost, and untimed segments stay clean', () => {
  const message={live:true,at:1};
  Progress.update(message,{id:'slow',kind:'tool',name:'读取大文件',text:'定位',status:'running'},1000);
  Progress.update(message,{id:'slow',kind:'tool',name:'读取大文件',text:'定位完成',status:'completed'},38000);
  Progress.update(message,{id:'fast',kind:'summary',text:'很短',status:'completed'},39000);
  const html=Progress.markup({...message,steps:[{id:'step-a',text:'没有结束时间的阶段',at:5,status:'done'}]});
  assert.match(html,/progress-cost">37 秒/,'有起止时间的段应显示实际用时');
  assert.doesNotMatch(html,/progress-cost">0 秒/,'过短的间隔不应显示为 0 秒');
  assert.equal((html.match(/progress-cost/g)||[]).length,1,'只有具备起止时间的段才显示耗时');
});
test('messages without pins keep the default rendering for live and settled runs', () => {
  const running=Progress.markup({live:true,at:1,steps:[{id:'a',text:'分析目标',at:2,status:'running'}]});
  const settled=Progress.markup({live:false,at:1,steps:[{id:'a',text:'分析目标',at:2,status:'done'}]});
  assert.match(running,/data-progress-key="feed" open/);assert.doesNotMatch(settled,/data-progress-key="feed" open/);
  assert.doesNotMatch(settled,/progressPins/);
});
function tool(id, status = 'completed', extra = {}) {
  return {id,kind:'tool',name:'读取文件',text:`文件 ${id} 的完整内容`,status,...extra};
}
function groupBody(html) {
  return /<ol class="progress-group-items">([\s\S]*?)<\/ol>/.exec(html)?.[1] || '';
}

test('consecutive tools are nested under one collapsed group with measured total and exact counts', () => {
  const message={live:true,at:1,activities:[tool('r1','completed',{at:1000,updatedAt:2500}),tool('r2','completed',{at:2600,updatedAt:4600})]};
  const html=Progress.markup(message), body=groupBody(html);
  assert.match(html,/progress-group-text">读取文件 ×2<\/span>/);
  assert.match(html,/progress-group-status">已完成 2<\/span>/);
  assert.match(html,/progress-group-cost">累计 3 秒<\/span>/);
  assert.match(html,/data-group-duration="3500"/);
  assert.doesNotMatch(html,/data-progress-key="group:r1" open/,'settled group really collapses its children');
  assert.match(body,/data-activity-id="r1"/); assert.match(body,/data-activity-id="r2"/);
  assert.equal((html.match(/data-activity-id=/g)||[]).length,2,'no duplicate call outside the group');
  assert.equal((html.match(/progress-group-text/g)||[]).length,1);
  assert.match(html,/2 项活动/,'group wrapper is not an additional event');
});
test('running and pending groups open automatically, then collapse when the actual calls finish', () => {
  const message={live:true,at:1,activities:[tool('a','completed',{at:1}),tool('b','running',{at:2})]};
  assert.match(Progress.markup(message),/data-progress-key="group:a" open/);
  assert.match(groupBody(Progress.markup(message)),/data-progress-key="b" open/);
  Progress.update(message,{...tool('b','completed')},3);
  assert.doesNotMatch(Progress.markup(message),/data-progress-key="group:a" open/);
  Progress.update(message,{...tool('c','pending')},4);
  const pending=Progress.markup(message);
  assert.match(pending,/data-progress-key="group:a" open/);
  assert.match(pending,/待执行 1 · 已完成 2/);
  assert.match(groupBody(pending),/data-progress-key="c" open/);
  assert.match(Progress.markup({...message,live:false}),/data-progress-key="group:a" open/,'pending state stays visible after the run stops');
});
test('group identity and saved choice survive append, delta, and a JSON restore', () => {
  const message={live:true,at:1,activities:[tool('a','completed',{at:1}),tool('b','running',{at:2})]};
  Progress.pin(message,'group:a',false);
  Progress.update(message,{...tool('b','running'),text:'追加中的真实内容'},3);
  Progress.update(message,{...tool('c','running')},4);
  const restored=JSON.parse(JSON.stringify(message)), html=Progress.markup(restored);
  assert.match(html,/data-progress-group-id="group:a"/);
  assert.match(html,/data-group-count="3"/);
  assert.doesNotMatch(html,/data-progress-key="group:a" open/,'manual collapse overrides automatic live expansion');
  assert.match(html,/进行中 2 · 已完成 1/,'closed group still signals its live children');
  assert.match(groupBody(html),/追加中的真实内容/);
  Progress.pin(restored,'group:a',true);
  Progress.finish(restored,'completed');
  assert.match(Progress.markup(restored),/data-progress-key="group:a" open/,'manual expansion remains when calls settle');
});
test('an individually pinned row keeps its new group open unless the user explicitly collapses that group', () => {
  const message={activities:[tool('a','completed',{at:1})]};
  Progress.pin(message,'a',true);
  Progress.update(message,tool('b'),2);
  assert.match(Progress.markup(message),/data-progress-key="group:a" open/);
  assert.match(groupBody(Progress.markup(message)),/data-progress-key="a" open/);
  Progress.pin(message,'group:a',false);
  assert.doesNotMatch(Progress.markup(message),/data-progress-key="group:a" open/);
  assert.match(groupBody(Progress.markup(message)),/data-progress-key="a" open/,'child preference is retained for reopening');
});
test('finishing a run does not hide a pinned detail inside its automatic feed disclosure', () => {
  for (const key of ['a','group:a']) {
    const message={live:true,activities:[tool('a','completed',{at:1}),tool('b','running',{at:2})]};
    Progress.pin(message,key,true);
    Progress.finish(message,'completed'); message.live=false;
    assert.match(Progress.markup(message),/data-progress-key="feed" open/,'active reading survives terminal repaint');
    Progress.pin(message,'feed',false);
    assert.doesNotMatch(Progress.markup(message),/data-progress-key="feed" open/,'explicit feed collapse always wins');
  }
  assert.doesNotMatch(Progress.markup({activities:[tool('a')],progressPins:{deleted:true}}),/data-progress-key="feed" open/,'obsolete pins do not hold a feed open');
});
test('failures, cancellations, rejections, and unknown states are never presented as successful tools', () => {
  const message={activities:[tool('a','completed'),tool('b','failed'),tool('c','cancelled'),tool('d','new-provider-state'),tool('e','rejected'),tool('f',undefined,{status:undefined})]};
  const html=Progress.markup(message);
  assert.match(html,/data-group-status="failed"/);
  assert.match(html,/progress-group-status">未确认 2 · 失败 1 · 已停止 1 · 已拒绝 1 · 已完成 1<\/span>/);
  assert.match(html,/data-activity-id="d" data-activity-state="pending"/);
  assert.match(html,/data-activity-id="f" data-activity-state="pending"/);
  assert.match(html,/data-group-counts="\{&quot;running&quot;:0,&quot;pending&quot;:0,&quot;unknown&quot;:2/);
  assert.doesNotMatch(html,/已完成 6/);
  const fresh={}; Progress.update(fresh,{id:'unknown',kind:'tool',status:'nonsense'},1);
  assert.equal(fresh.activities[0].status,'unknown');
  assert.match(Progress.markup(fresh),/data-activity-state="pending"/);
  assert.match(Progress.markup(fresh),/aria-label="未确认"/);
});
test('grouping never crosses another tool name, a thinking segment, or an unnamed call', () => {
  const single={activities:[tool('a'),tool('b','completed',{name:'运行命令'})]};
  assert.doesNotMatch(Progress.markup(single),/progress-group-text/);
  const split={activities:[tool('a','completed',{at:1}),{id:'thinking',kind:'summary',text:'思考',status:'completed',at:2},tool('b','completed',{at:3})]};
  assert.doesNotMatch(Progress.markup(split),/progress-group-text/);
  const unnamed={activities:[tool('a','completed',{name:''}),tool('b','completed',{name:''})]};
  assert.doesNotMatch(Progress.markup(unnamed),/progress-group-text/);
  const mixed={activities:[tool('a'),tool('b'),tool('c','completed',{name:'运行命令'}),tool('d','completed',{name:'运行命令'})]};
  assert.equal((Progress.markup(mixed).match(/progress-group-text/g)||[]).length,2);
});
test('untimed groups do not invent a duration and retain escaped long details and identifiers exactly once', () => {
  const long='<unsafe>完整日志\n'.repeat(1500);
  const message={activities:[tool('a"<&','completed',{text:long,name:'工具<&'}),tool('b','completed',{text:'末尾真实内容',name:'工具<&'})]};
  const html=Progress.markup(message), body=groupBody(html);
  assert.doesNotMatch(html,/progress-group-cost|progress-cost/);
  assert.match(html,/data-progress-key="group:a&quot;&lt;&amp;"/);
  assert.match(html,/progress-group-text">工具&lt;&amp; ×2/);
  assert.doesNotMatch(body,/<unsafe>/);
  assert.equal((body.match(/&lt;unsafe&gt;完整日志/g)||[]).length,1500);
  assert.match(body,/末尾真实内容/);
});

test('status-only stages do not manufacture hidden content; real detail and reasoning remain expandable', () => {
  const message = { live:false, runStatus:'completed', steps:[
    {id:'prep',text:'准备上下文',at:100,status:'done'},
    {id:'explicit',text:'读取结果',detail:'工具实际返回：2 项资料',at:200,status:'done'}
  ], activities:[{id:'reason-1',kind:'summary',text:'基于接口返回的真实内容',status:'completed',at:150}] };
  const original = JSON.stringify(message), html = Progress.markup(message);
  assert.doesNotMatch(html, /data-progress-key="prep"/);
  assert.match(html, /progress-stage-label">准备上下文/);
  assert.doesNotMatch(html, /该阶段没有单独的过程记录|阶段开始/);
  assert.match(html, /data-progress-key="explicit"/);
  assert.match(html, /工具实际返回：2 项资料/);
  assert.match(html, /data-progress-key="reason-1"/);
  assert.match(html, /基于接口返回的真实内容/);
  assert.equal(JSON.stringify(message), original);
});
