const test=require('node:test'),assert=require('node:assert/strict');
const {parse}=require('../app/reminder-intent');
const Core=require('../app/workstation-core');
test('explicit local reminder preserves 20:00 and one shopping checklist',()=>{
 const now=new Date(2026,8,16,10), r=parse('今天晚上8点提醒我买熨斗，洗衣液，护发素，袜子。',now);
 assert.equal(new Date(r.dueAt).getHours(),20);assert.equal(r.checklist.length,4);assert.equal(r.reminderMinutes,0);
 assert.equal(parse('明天上午九点半提醒我开组会',now).dueAt,new Date(2026,8,17,9,30).toISOString());
 assert.ok(parse('今天早上8点提醒我买东西',now).error);
 assert.equal(parse('比如今天晚上8点提醒我买东西',now),null);
 assert.equal(parse('你能根据日程提醒吗',now),null);
 assert.ok(parse('今天25点提醒我开会',now).error);
});
test('task reminder is validated, preserved, changeable and explicitly disableable',()=>{
 const s={tasks:[],projects:[],notes:[],imports:[],links:[],trash:[],conversations:[],agentRuns:[]};
 let r=Core.applyPlan(s,[{type:'create_task',title:'购物',dueAt:'2026-09-20T20:00:00+08:00',reminderMinutes:0,checklist:['熨斗','洗衣液']}],{uid:()=> 'reminder-task'});
 assert.equal(r.state.tasks[0].reminderMinutes,0);
 r=Core.applyPlan(r.state,[{type:'update_task',taskId:'reminder-task',patch:{dueAt:'2026-09-21T20:00:00+08:00'}}]);assert.equal(r.state.tasks[0].reminderMinutes,0);
 assert.equal(Core.applyPlan(r.state,[{type:'update_task',taskId:'reminder-task',patch:{reminderMinutes:null}}]).state.tasks[0].reminderMinutes,null);
 for(const value of [-1,10081,1.5,'0',true,{},undefined]) assert.throws(()=>Core.applyPlan(r.state,[{type:'update_task',taskId:'reminder-task',patch:{reminderMinutes:value}}]),/提醒/);
});
