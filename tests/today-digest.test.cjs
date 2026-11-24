process.env.TZ='Asia/Shanghai';
const test=require('node:test'),assert=require('node:assert/strict');
const D=require('../app/today-digest');
const at=(s)=>Date.parse(s+'+08:00');
const now=at('2026-10-30T10:00:00');
const ev=(id,start,end,extra={})=>({eventId:id,title:id,kind:'event',start:at(start),end:at(end),allDay:false,...extra});
test('day bounds follow the local zone and events get a state',()=>{
 const d=D.build({now,occurrences:[ev('早会','2026-10-30T09:00:00','2026-10-30T09:30:00'),ev('组会','2026-10-30T09:45:00','2026-10-30T11:00:00'),ev('午饭','2026-10-30T12:00:00','2026-10-30T13:00:00'),ev('晚课','2026-10-30T19:00:00','2026-10-30T21:00:00'),ev('明天','2026-10-31T00:00:00','2026-10-31T01:00:00'),ev('昨夜跨天','2026-10-29T23:00:00','2026-10-30T00:30:00'),{...ev('全天','2026-10-30T00:00:00','2026-10-31T00:00:00'),allDay:true}]});
 assert.equal(d.date,'2026-10-30');
 assert.deepEqual(d.events.items.map(e=>[e.title,e.state]),[['全天','allDay'],['昨夜跨天','past'],['早会','past'],['组会','now'],['午饭','next'],['晚课','later']]);
});
test('task deadlines split into due, carryover and overdue; done ones drop out',()=>{
 const tasks=[{id:'a',title:'交报告',dueAt:'2026-10-30',status:'todo'},{id:'b',title:'九点提交',dueAt:'2026-10-30T09:00:00+08:00',status:'todo'},{id:'c',title:'下午改稿',dueAt:'2026-10-30T15:00:00+08:00',status:'in_progress',priority:'high'},
  {id:'d',title:'昨天的作业',dueAt:'2026-10-29',status:'todo'},{id:'e',title:'上周的',dueAt:'2026-10-20',status:'todo'},{id:'f',title:'已完成',dueAt:'2026-10-30',status:'done'},{id:'g',title:'没日期',status:'todo'},{id:'h',title:'坏日期',dueAt:'2026-02-30',status:'todo'},{id:'i',title:'明天',dueAt:'2026-10-31',status:'todo'}];
 const d=D.build({now,tasks});
 assert.deepEqual(d.due.items.map(x=>[x.title,x.late]),[['交报告',false],['九点提交',true],['下午改稿',false]]);
 assert.deepEqual(d.carryover.items.map(x=>x.title),['昨天的作业']);
 assert.deepEqual(d.overdue.items.map(x=>x.title),['上周的']);
 assert.equal(d.counts.late,1);assert.equal(d.empty,false);
});
test('agenda to-dos count as deadlines unless the occurrence is done',()=>{
 const d=D.build({now,occurrences:[ev('打卡','2026-10-30T08:00:00','2026-10-30T08:30:00',{kind:'task'}),ev('昨天打卡','2026-10-29T08:00:00','2026-10-29T08:30:00',{kind:'task'}),ev('已打卡','2026-10-30T08:00:00','2026-10-30T08:30:00',{kind:'task',isDone:true})]});
 assert.deepEqual(d.events.items,[]);
 assert.deepEqual(d.due.items.map(x=>[x.title,x.late]),[['打卡',true]]);
 assert.deepEqual(d.carryover.items.map(x=>x.title),['昨天打卡']);
});
test('occurrence fields from agenda_list win over the series start',()=>{
 const row={...ev('周会','2026-10-02T14:00:00','2026-10-02T15:00:00'),occurrenceStart:at('2026-10-30T14:00:00'),occurrenceEnd:at('2026-10-30T15:00:00')};
 const d=D.build({now,occurrences:[row]});
 assert.equal(d.events.items[0].start,at('2026-10-30T14:00:00'));assert.equal(d.events.items[0].occurrenceStart,at('2026-10-30T14:00:00'));
});
test('lists are capped with a count of the rest',()=>{
 const tasks=Array.from({length:15},(_,i)=>({id:'t'+i,title:'任务'+i,dueAt:'2026-10-30',status:'todo'}));
 const d=D.build({now,tasks,limit:5});
 assert.equal(d.due.items.length,5);assert.equal(d.due.more,10);assert.equal(d.counts.due,15);
});
test('plain lines need no model and say when the day is empty',()=>{
 assert.deepEqual(D.lines(D.build({now})),['10月30日 星期五','今天没有日程，也没有到期或遗留的任务。']);
 const d=D.build({now,occurrences:[ev('组会','2026-10-30T09:45:00','2026-10-30T11:00:00')],tasks:[{id:'d',title:'昨天的作业',dueAt:'2026-10-29',status:'todo'}]});
 assert.deepEqual(D.lines(d),['10月30日 星期五','今天 1 个日程，正在进行：09:45 组会','昨天没做完 1 项：昨天的作业']);
});
test('model input carries titles and times only',()=>{
 const d=D.build({now,occurrences:[{...ev('组会','2026-10-30T09:45:00','2026-10-30T11:00:00'),details:'私密备注',location:'A101'}],tasks:[{id:'b',title:'九点提交',dueAt:'2026-10-30T09:00:00+08:00',status:'todo',notes:'不该出现'}]});
 const m=D.forModel(d),text=JSON.stringify(m);
 assert.ok(!text.includes('私密备注')&&!text.includes('不该出现')&&!text.includes('A101'));
 assert.deepEqual(m.events,[{title:'组会',time:'09:45-11:00',state:'now'}]);
 assert.deepEqual(m.due,[{title:'九点提交',due:'2026-10-30 09:00',late:true}]);
});
