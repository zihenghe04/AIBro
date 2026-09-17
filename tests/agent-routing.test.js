const test=require('node:test'),assert=require('node:assert/strict'),R=require('../app/agent-routing');
const now=new Date('2026-09-17T09:00:00+08:00');
test('mixed and context-dependent requests always retain retrieval',()=>{
 for(const goal of ['找到机器学习课程的相关内容，并帮我设置提醒','明天下午两点提醒我，根据课件安排复习','根据刚才的论文每周四两点安排组会','把那个任务标记为已完成','查找课程后再提醒我','find my course notes and then set a reminder','每周四下午两点开会，顺便总结论文','不要明天下午两点提醒我买牛奶'])assert.equal(R.decide({goal,now,hasAgenda:true}).mode,'full',goal);
});
test('self-contained reminders are compact but attached and skill context prevents shortcut',()=>{
 const input={goal:'明天下午两点提醒我买牛奶',now};const route=R.decide(input);assert.equal(route.mode,'reminder');assert.equal(route.reminder.reminderMinutes,0);
 for(const extra of [{attachments:[{}]},{references:[{}]},{skillId:'paper'},{webSearch:true},{localContext:'source'}])assert.equal(R.decide({...input,...extra}).mode,'full');
 const prompt=R.prompt(route,{goal:input.goal,now:now.toISOString()});assert.ok(prompt.length<1800);
});
test('completion requires one active task in scope and preserves ID',()=>{
 const input={goal:'把买牛奶标记为已完成',tasks:[{id:'t',title:'买牛奶',workspace:'日常'}],workspace:'日常'};
 assert.equal(R.decide(input).task.id,'t');assert.equal(R.decide({...input,tasks:[...input.tasks,{...input.tasks[0],id:'t2'}]}).mode,'full');assert.equal(R.decide({...input,workspace:'科研'}).mode,'full');
});
test('explicit weekly meeting is compact only where native review exists',()=>{
 const goal='#腾讯会议：123-4567-8901 我每周四下午两点半都要参加这个组会';
 assert.equal(R.decide({goal,hasAgenda:true}).mode,'schedule');assert.equal(R.decide({goal}).mode,'full');
});
test('unexpected model requests escalate before mutations; valid exact proposal remains light',()=>{
 const r=R.decide({goal:'明天下午两点提醒我买牛奶',now});
 for(const raw of ['bad json',{needsFullContext:true,actions:[]},{knowledgeRequests:[{type:'search'}],actions:[]},{actions:[{type:'delete_task'}]},{actions:[]},{actions:[{type:'create_task',...r.reminder},{type:'create_project'}]}])assert.equal(R.needsFull(r,raw),true);
 assert.equal(R.needsFull(r,{workspace:'日常',message:'待保存',actions:[{type:'create_task',...r.reminder}]}),false);
});
