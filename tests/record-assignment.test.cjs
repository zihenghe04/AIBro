const test=require('node:test');
const assert=require('node:assert/strict');
const Core=require('../app/workstation-core');
const Assignment=require('../app/record-assignment');
const Knowledge=require('../app/knowledge-access');
const Tasks=require('../app/task-context');
const Agent=require('../app/agent-context');
const Plan=require('../app/plan-review');
const Policy=require('../app/permission-policy');
const Checkpoint=require('../app/run-checkpoint');
const clone=x=>JSON.parse(JSON.stringify(x));
function fixture(){return {projects:[{id:'daily',name:'随手记录',workspace:'日常',updatedAt:1},{id:'course',name:'交互设计方法',workspace:'课程',updatedAt:1},{id:'research',name:'论文项目',workspace:'科研',updatedAt:1}],notes:[{id:'capture',title:'观察记录',kind:'随记',content:'保留原始手写内容 👩🏽‍💻\n',workspace:'日常',projectId:null,project:null,sourceAttachmentIds:['material'],sourceNoteIds:['earlier'],revisions:[{content:'旧内容',at:1}],aiDraft:{content:'未合并草稿'},provenance:{origin:{type:'manual'}},updatedAt:2,createdAt:1}],tasks:[{id:'task',title:'检查汇报',description:'原任务说明',workspace:'日常',projectId:'daily',project:'随手记录',status:'todo',checklist:[{text:'阅读',done:false}],dueAt:'2030-10-12',reminderMinutes:10,dependsOn:[],updatedAt:2}],imports:[],attachments:[],papers:[],links:[{id:'link',sourceId:'capture',targetId:'task'}],trash:[],conversations:[{id:'chat',workspace:'日常',projectId:null,messages:[{id:'message',text:'处理中',live:true}]}],agentRuns:[]};}
function action(state,type='note',target='course'){const record=state[type==='task'?'tasks':'notes'][0];return {type:'assign_record',recordType:type,recordId:record.id,targetProjectId:target,expectedRecordVersion:Assignment.version(record)};}
const context=()=>({workspace:'日常',projectId:null,conversationId:'chat',allowedNoteIds:['capture'],allowedTaskIds:['task'],protectNoteUpdates:true,now:100});
function approve(state,actions,ctx=context()){return {...ctx,recordAssignmentApprovals:Assignment.approvalKeys(state,actions,ctx)};}
const preview=(state,actions,ctx=context())=>Core.applyPlan(state,actions,{...ctx,recordAssignmentPreview:true});

test('moves an original capture through the real transactional Core and keeps all non-routing fields',()=>{
 const s=fixture(),before=clone(s),a=action(s),out=Core.applyPlan(s,[a],approve(s,[a]));
 const {workspace,projectId,project,updatedAt,...original}=s.notes[0],{workspace:w,projectId:p,project:n,updatedAt:t,...moved}=out.state.notes[0];
 assert.deepEqual(moved,original);assert.deepEqual([w,p,n,t],['课程','course','交互设计方法',100]);assert.deepEqual(s,before);assert.deepEqual(out.state.links,s.links);
 assert.equal(out.results[0].id,'capture');assert.equal(out.results[0].operation,'updated');assert.equal(out.results[0].actionType,'assign_record');assert.deepEqual(out.results[0].before,{workspace:'日常',projectId:null,project:null});assert.deepEqual(out.results[0].after,{workspace:'课程',projectId:'course',project:'交互设计方法'});assert.equal(out.results[0].recordVersion,Assignment.version(out.state.notes[0]));assert.deepEqual(out.projectIds,['course']);assert.equal(out.requiresAssignmentReview,false);
});
test('task cross-project move refreshes both projects while leaving schedule and checklist untouched',()=>{
 const s=fixture(),a=action(s,'task','research'),out=Core.applyPlan(s,[a],approve(s,[a]));
 assert.deepEqual(new Set(out.projectIds),new Set(['daily','research']));assert.equal(out.state.projects[0].updatedAt,100);assert.equal(out.state.projects[2].updatedAt,100);
 assert.equal(out.state.tasks[0].dueAt,s.tasks[0].dueAt);assert.equal(out.state.tasks[0].reminderMinutes,10);assert.deepEqual(out.state.tasks[0].checklist,s.tasks[0].checklist);assert.equal(out.state.tasks[0].project,'论文项目');
});
test('explicit null detaches and retains the effective source workspace, never current conversation space',()=>{
 const s=fixture();Object.assign(s.notes[0],{workspace:'课程',projectId:'course',project:'交互设计方法'});
 const ctx={...context(),workspace:'科研',recordAssignmentScope:{workspace:'课程',projectId:'course'}},a=action(s,'note',null),out=Core.applyPlan(s,[a],approve(s,[a],ctx));
 assert.deepEqual(out.results[0].after,{workspace:'课程',projectId:null,project:null});assert.equal(out.state.notes[0].projectId,null);assert.deepEqual(out.projectIds,['course']);
});
test('same canonical routing is unchanged, does not touch timestamps or create provenance',()=>{
 const s=fixture(),a=action(s,'task','daily'),out=Core.applyPlan(s,[a],{...context(),provenanceRun:{id:'new-run'}});
 assert.deepEqual(out.state,s);assert.equal(out.results[0].operation,'unchanged');assert.equal(out.requiresAssignmentReview,false);assert.deepEqual(out.projectIds,[]);
});
test('schema rejects omitted/null-like destinations, extra body fields, wrong types and guessed versions',()=>{
 const s=fixture(),valid=action(s);for(const patch of [{targetProjectId:undefined},{targetProjectId:''},{targetProjectId:'null'},{targetProjectId:0},{patch:{content:'replace'}},{workspace:'科研'},{recordType:'paper'},{recordId:' capture'},{expectedRecordVersion:'2'},{expectedRecordVersion:'v1-1-2-3'}]){
  assert.throws(()=>preview(s,[{...valid,...patch}]));
 }
 const missing={...valid};delete missing.targetProjectId;assert.throws(()=>preview(s,[missing]),{code:'ASSIGN_RECORD_SCHEMA'});
});
test('full-record CAS covers same-timestamp edits, nested fields and drafts, not object key order',()=>{
 const s=fixture(),a=action(s);const reversed=Object.fromEntries(Object.entries(s.notes[0]).reverse());assert.equal(Assignment.version(reversed),a.expectedRecordVersion);
 for(const mutate of [r=>r.content+='x',r=>r.revisions[0].content+='x',r=>r.aiDraft.content+='x',r=>r.sourceAttachmentIds.push('new'),r=>r.provenance.origin.extra=true,r=>r.updatedAt++,r=>r.futureField={x:1}]){
  const next=clone(s);mutate(next.notes[0]);assert.throws(()=>preview(next,[a]),{code:'ASSIGN_RECORD_STALE'});
 }
 assert.ok(a.expectedRecordVersion.length<60);assert.ok(!a.expectedRecordVersion.includes(s.notes[0].content));
});
test('read scope, read grants and private ancestry cannot be widened by action, approval, or current goal',()=>{
 const s=fixture(),a=action(s);assert.throws(()=>preview(s,[a],{...context(),allowedNoteIds:[]}),{code:'ASSIGN_RECORD_SCOPE'});
 assert.throws(()=>preview(s,[a],{...context(),recordAssignmentScope:{projectId:'daily',workspace:'日常'}}),{code:'ASSIGN_RECORD_SCOPE'});
 for(const mutate of [x=>x.notes[0].private=true,x=>x.notes[0].provenance.origin.private=true,x=>{x.notes[0].sourceConversationId='hidden';x.conversations.push({id:'hidden',private:true});},x=>x.notes.push(clone(x.notes[0])),x=>x.notes[0].archived=true,x=>x.notes[0].deletedAt=2,x=>x.notes[0].hidden=true]){
  const next=clone(s);mutate(next);assert.throws(()=>preview(next,[action(next)]),{code:'ASSIGN_RECORD_SCOPE'});
 }
});
test('target uniqueness, active state and private project/run ancestry are rechecked',()=>{
 const s=fixture(),a=action(s);for(const mutate of [x=>x.projects[1].private=true,x=>x.projects[1].archivedAt=2,x=>x.projects[1].hidden=true,x=>x.projects.push(clone(x.projects[1])),x=>{x.projects[1].sourceConversationId='hidden';x.conversations.push({id:'hidden',private:true});},x=>{x.projects[1].runId='secret';x.agentRuns.push({id:'secret',incognito:true});},x=>x.projects[1].workspace='other']){
  const next=clone(s);mutate(next);assert.throws(()=>preview(next,[a]),{code:'ASSIGN_RECORD_TARGET'});
 }
});
test('ephemeral existing read grants permit source reads, not destination writes',()=>{
 const s=fixture();Object.assign(s.notes[0],{projectId:'research',project:'论文项目',workspace:'科研'});
 const ctx={...context(),recordAssignmentScope:{workspace:'日常',projectId:'daily',readProjects:[{id:'research',name:'论文项目',workspace:'科研'}]}},a=action(s);
 assert.equal(preview(s,[a],ctx).requiresAssignmentReview,true);assert.throws(()=>Core.applyPlan(s,[a],ctx),{code:'ASSIGN_RECORD_APPROVAL'});
 s.projects[2].name='renamed';assert.throws(()=>preview(s,[a],ctx),{code:'ASSIGN_RECORD_SCOPE'});
});
test('same-space standalone task follows existing task_list scope; explicit notes retain existing reference scope',()=>{
 const s=fixture();Object.assign(s.tasks[0],{projectId:null,project:null});
 const ctx={...context(),recordAssignmentScope:{projectId:'daily',workspace:'日常'}};
 assert.equal(preview(s,[action(s,'task')],ctx).results[0].id,'task');
 assert.equal(preview(s,[action(s)],{...ctx,explicitReferences:[{type:'note',id:'capture'}]}).results[0].id,'capture');
 s.notes[0].private=true;assert.throws(()=>preview(s,[action(s)],{...ctx,explicitReferences:[{type:'note',id:'capture'}]}),{code:'ASSIGN_RECORD_SCOPE'});
 s.projects[0].archived=true;assert.throws(()=>preview(s,[action(s,'task')],ctx),{code:'ASSIGN_RECORD_SCOPE'});
});
test('review keys bind source identity/version, destination/null and target naming; model fields cannot approve',()=>{
 const s=fixture(),a=action(s),approved=approve(s,[a]);assert.equal(preview(s,[a]).requiresAssignmentReview,true);
 assert.throws(()=>Core.applyPlan(s,[a],context()),{code:'ASSIGN_RECORD_APPROVAL'});
 assert.throws(()=>Core.applyPlan(s,[{...a,approved:true}],approved),{code:'ASSIGN_RECORD_SCHEMA'});
 assert.throws(()=>Core.applyPlan(s,[{...a,targetProjectId:'research'}],approved),{code:'ASSIGN_RECORD_APPROVAL'});
 for(const key of ['name','workspace']){const next=clone(s);next.projects[1][key]=key==='name'?'new title':'科研';assert.throws(()=>Core.applyPlan(next,[a],approved),{code:'ASSIGN_RECORD_APPROVAL'});}
 const moved=Core.applyPlan(s,[a],approved).state,detach=action(moved,'note',null);
 assert.throws(()=>Core.applyPlan(moved,[detach],{...approved,recordAssignmentScope:{projectId:'course',workspace:'课程'}}),{code:'ASSIGN_RECORD_APPROVAL'});
});
test('transaction rejects stale or duplicated assignment before any other action affects original state',()=>{
 const s=fixture(),a=action(s),before=clone(s);assert.throws(()=>preview(s,[{type:'create_task',title:'must not leak'},a,a]));assert.deepEqual(s,before);
 assert.throws(()=>preview(s,[{type:'update_task',taskId:'task',patch:{title:'edited'}},action(s,'task')]),{code:'ASSIGN_RECORD_CONFLICT'});assert.deepEqual(s,before);
});
test('assignment excludes same-record edit/delete in either order, including identity deduplication',()=>{
 for(const type of ['note','task'])for(const first of [true,false])for(const remove of [true,false]){
  const s=fixture();s.notes[0].kind='笔记';const a=action(s,type),other=remove?{type:`delete_${type}`,[`${type}Id`]:a.recordId}:{type:`update_${type}`,[`${type}Id`]:a.recordId,patch:{title:'Changed'}};const before=clone(s);
  assert.throws(()=>preview(s,first?[a,other]:[other,a]),{code:'ASSIGN_RECORD_CONFLICT'});assert.deepEqual(s,before);
 }
 for(const first of [true,false]){const s=fixture();s.notes[0].kind='笔记';const a=action(s),other={type:'create_note',title:'观察记录',content:'deduplicated content',projectId:first?'course':null,workspace:first?'课程':'日常'};assert.throws(()=>preview(s,first?[a,other]:[other,a]),{code:'ASSIGN_RECORD_CONFLICT'});}
 const s=fixture(),out=preview(s,[action(s),{type:'update_task',taskId:'task',patch:{title:'Separate task'}}]);assert.equal(out.state.notes[0].projectId,'course');assert.equal(out.state.tasks[0].title,'Separate task');
});
test('task dependency and reverse dependency constraints still block cross-project movement atomically',()=>{
 for(const reverse of [false,true]){const s=fixture();s.tasks.push({...clone(s.tasks[0]),id:'other',title:'other'});(reverse?s.tasks[1]:s.tasks[0]).dependsOn=[reverse?'task':'other'];const before=clone(s),a=action(s,'task');assert.throws(()=>Core.applyPlan(s,[a],approve(s,[a])),/依赖/);assert.deepEqual(s,before);}
});
test('original capture body stays protected under update_note; assignment does not loosen the old guard',()=>{
 const s=fixture();assert.throws(()=>Core.applyPlan(s,[{type:'update_note',noteId:'capture',patch:{content:'overwrite'}}],context()),/随记/);
});
test('note read/list and task_list expose exact compact versions used by the executor',async()=>{
 const s=fixture(),scope={workspace:'日常'};
 const read=await Knowledge.execute(s,scope,{type:'read',recordType:'note',id:'capture'}),catalog=await Knowledge.execute(s,scope,{type:'list'}),tasks=Tasks.search(s,s.conversations[0],{query:'检查汇报'});
 assert.equal(read.recordVersion,Assignment.version(s.notes[0]));assert.equal(catalog.entries[0].recordVersion,read.recordVersion);assert.equal(catalog.contentRead,false);assert.equal(tasks.entries[0].recordVersion,Assignment.version(s.tasks[0]));
 const a={...action(s),expectedRecordVersion:read.recordVersion};assert.equal(preview(s,[a]).results[0].operation,'updated');
});
test('agent capability routing recognizes task/note assignment and supplies complete protocol',()=>{
 const agent=Agent.create({fullInstruction:'你是测试助手',history:{text:'{}'}});
 assert.deepEqual(agent.missing({actions:[{type:'assign_record',recordType:'task'}]}),['tasks']);
 const task=agent.capability('tasks');assert.match(task.instructions,/expectedRecordVersion/);assert.match(task.instructions,/targetProjectId:null/);assert.deepEqual(agent.missing({actions:[{type:'assign_record',recordType:'task'}]}),[]);
 assert.deepEqual(agent.missing({actions:[{type:'assign_record',recordType:'note'}]}),['knowledge']);assert.match(agent.capability('knowledge').instructions,/assign_record/);
});
test('known assignment preserves permission modes while neither delegated nor session approval authorizes routing',()=>{
 const actions=[{type:'assign_record'}];assert.equal(Policy.needsApproval({mode:'request',actions}),true);assert.equal(Policy.needsApproval({mode:'full',actions}),false);
 assert.equal(Policy.canDelegateReview({enabled:true,actions}),false);assert.equal(Policy.canSessionAllow({actions,allows:{assign_record:true}}),false);assert.deepEqual(Policy.allowableTypes(actions),[]);
});
test('actual plan review edits only destination, retains explicit null, displays before/after and detects stale records',async()=>{
 const s=fixture(),a=action(s);s.agentRuns.push({id:'run',status:'awaiting-approval',workspace:'日常',pendingActions:[a]});const run=s.agentRuns[0];
 const review=Plan.createController({getState:()=>s,getRun:()=>run,contextForRun:()=>context(),applyPlan:Core.applyPlan,save:async()=>true});
 const d=review.draft('run');assert.equal(d.validation.ok,true);assert.equal(d.validation.results[0].requiresAssignmentReview,true);
 const description=Plan.describe(a,s,context(),[a]);assert.deepEqual(description.changes[0],{label:'归属项目',before:'独立内容',after:'交互设计方法'});assert.equal(description.targetId,'capture');
 for(const field of ['recordId','expectedRecordVersion','recordType','patch.content'])assert.throws(()=>review.edit('run',d.rows[0].key,field,'bad'),{code:'PLAN_FIELD'});
 review.edit('run',d.rows[0].key,'targetProjectId',null);await review.save('run');assert.equal(review.capture('run').actions[0].targetProjectId,null);
 const field=Plan.fieldsFor(run.pendingActions[0],s,context(),run.pendingActions)[0];assert.equal(field.value,'__standalone');assert.ok(!field.options.some(x=>x.value===''));
 s.notes[0].content+='edit';assert.throws(()=>review.capture('run'),{code:'PLAN_TARGET_CHANGED'});
});
test('plan selector omits private and duplicate project identities and does not allow future aliases',()=>{
 const s=fixture(),a=action(s);s.projects[2].private=true;s.projects.push(clone(s.projects[0]));const fields=Plan.fieldsFor(a,s,context(),[{type:'create_project',id:'future',name:'Future'},a]);assert.deepEqual(fields[0].options.map(x=>x.value),['__standalone','course']);
});
test('production checkpoint persists routing and real receipt together; lost save acknowledgement retries save only',async()=>{
 const s=fixture(),a=action(s),ctx=approve(s,[a]);s.agentRuns.push({id:'run',conversationId:'chat',status:'running',pendingActions:[a],steps:[]});const run=s.agentRuns[0];let count=0,fail=true,disk;
 const api=Checkpoint.create({getState:()=>s,uid:()=> 'receipt',now:()=>100,persist:async()=>{disk=clone(s);if(fail&&run.executionReceipt.phase==='applied')throw Error('save acknowledgement lost');},apply:(actions,r,beforeCommit)=>{count++;const out=Core.applyPlan(s,actions,ctx);beforeCommit();for(const key of ['notes','tasks','projects'])s[key]=out.state[key];r.results=out.results;return out.results;}});
 await assert.rejects(api.prepare('run','message',{answer:'归属已保存'}),{code:'CHECKPOINT_SAVE_FAILED'});assert.equal(run.status,'awaiting-save');assert.equal(run.executionReceipt.phase,'applied');assert.equal(s.conversations[0].messages[0].text,'处理中');assert.equal(disk.notes[0].id,'capture');assert.equal(disk.notes[0].projectId,'course');assert.deepEqual(disk.agentRuns[0].executionReceipt.results[0].after,{projectId:'course',project:'交互设计方法',workspace:'课程'});
 fail=false;await api.save('run');await api.continue('run');assert.equal(count,1);assert.equal(run.status,'completed');assert.equal(api.view(run).hasSavedResult,true);assert.equal(s.notes.length,1);assert.equal(s.notes[0].content,fixture().notes[0].content);
});
test('prepared save failure keeps both original routing and approved plan without applying',async()=>{
 const s=fixture(),a=action(s);s.agentRuns.push({id:'run',conversationId:'chat',status:'running',pendingActions:[a],steps:[]});let applies=0;
 const api=Checkpoint.create({getState:()=>s,uid:()=> 'prepared-receipt',now:()=>100,persist:async()=>{throw Error('disk unavailable');},apply:()=>{applies++;throw Error('must not apply');}});
 await assert.rejects(api.prepare('run','message',{answer:'尚未保存'}),{code:'CHECKPOINT_SAVE_FAILED'});assert.equal(applies,0);assert.equal(s.notes[0].projectId,null);assert.equal(s.agentRuns[0].executionReceipt.phase,'prepared');assert.deepEqual(s.agentRuns[0].executionReceipt.actions,[a]);assert.notEqual(s.agentRuns[0].status,'completed');
});
