const test=require('node:test'),assert=require('node:assert/strict');
const T=require('../app/task-context'),Core=require('../app/workstation-core'),K=require('../app/knowledge-access'),S=require('../app/tool-scheduler'),P=require('../app/permission-policy');
const fixture=()=>({projects:[{id:'p',workspace:'日常'},{id:'q',workspace:'课程'},{id:'other',workspace:'日常'}],tasks:[{id:'cash',title:'去银行取2张50元纸币',description:'取零钱',workspace:'日常',projectId:null,status:'todo'},{id:'other',title:'去银行取2张50元纸币',workspace:'课程',projectId:'q'},{id:'unrelated-project',title:'去银行取2张50元纸币',workspace:'日常',projectId:'other'}],notes:[],imports:[],papers:[],links:[],trash:[],conversations:[],agentRuns:[]});
const conv={id:'c',workspace:'日常',projectId:'p'};
test('task catalog resolves spoken numeral variants and standalone task in a project conversation, without cross-project leakage',()=>{
 for(const query of ['去银行取两张五十元纸币','50元纸币','银行']){const s=fixture(),before=JSON.stringify(s),r=T.search(s,conv,{query});assert.deepEqual(r.entries.map(t=>t.id),['cash']);assert.equal(JSON.stringify(s),before);assert.equal(r.entries[0].projectId,null);}
});
test('catalog returns ambiguous candidates and paginates all current tasks instead of hiding beyond initial prompt budget',()=>{
 const s=fixture();s.tasks=Array.from({length:45},(_,i)=>({id:String(i).padStart(2,'0'),title:'准备报告',workspace:'日常'}));
 const ids=[];let offset=0;do{const r=T.search(s,conv,{query:'报告',offset});assert.equal(r.total,45);ids.push(...r.entries.map(x=>x.id));offset=r.nextOffset;}while(offset!==null);
 assert.equal(new Set(ids).size,45);assert.throws(()=>T.search(s,conv,{offset:-1}));assert.equal(T.search(s,conv,{query:'完全不相关'}).entries.length,0);
});
test('deleted, duplicate or archived task IDs and unavailable parents cannot be authorized',()=>{
 const s=fixture();s.tasks.push({...s.tasks[0]});assert.equal(T.search(s,conv,{}).entries.length,0);
 s.tasks=fixture().tasks;s.tasks[0].archivedAt=1;assert.equal(T.search(s,conv,{}).entries.length,0);
 s.projects[0].archived=true;assert.equal(T.search(s,conv,{}).entries.length,0);
});
test('read snapshots cover deletion as well as updates and cannot refresh away intervening edits',()=>{
 const s=fixture(),run={};T.readCatalog(s,conv,{query:'纸币'},run);s.tasks[0].description='new user edit';T.readCatalog(s,conv,{query:'纸币'},run);
 assert.throws(()=>T.assertUnchanged(s,[{type:'delete_task',taskId:'cash'}],run.taskContext.snapshots),{code:'CANCELLED'});
 assert.throws(()=>T.assertUnchanged(s,[{type:'delete_task',taskId:'other'}],run.taskContext.snapshots),{code:'TASK_CONTEXT'});
 assert.throws(()=>Core.applyPlan(s,[{type:'delete_task',taskId:'other'}],{allowedTaskIds:['cash']}),/允许更新范围/);
});
test('Agent read-tool loop can find, approve and trash a standalone task while preserving restorable original and project ownership',async()=>{
 const s=fixture(),run={};const schedule=S.create({run,execute:req=>T.readCatalog(s,conv,req,run)});
 const result=await K.continuePlan(JSON.stringify({knowledgeRequests:[{type:'task_list',query:'取两张50元纸币'}],actions:[]}),{batch:schedule.batch,ask:async evidence=>{assert.match(evidence,/cash/);return JSON.stringify({message:'准备移入回收站',actions:[{type:'delete_task',taskId:'cash'}]});}});
 const {actions}=JSON.parse(result);assert.equal(P.needsApproval({mode:'smart',actions}),true);assert.equal(P.needsApproval({mode:'full',actions}),false);
 T.assertUnchanged(s,actions,run.taskContext.snapshots);const outcome=Core.applyPlan(s,actions,{projectId:'p',workspace:'日常',allowedTaskIds:run.taskContext.taskIds});
 assert.equal(outcome.state.tasks.length,2);assert.equal(outcome.state.trash[0].data.tasks[0].id,'cash');assert.equal(outcome.state.trash[0].data.tasks[0].projectId,null);assert.equal(outcome.results[0].operation,'deleted');assert.equal(s.tasks.length,3);
});
