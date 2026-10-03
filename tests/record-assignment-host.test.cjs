const installConversationPathHost = require('./helpers/conversation-path-host.cjs');
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const Core=require('../app/workstation-core');
const Assignment=require('../app/record-assignment');
const Plan=require('../app/plan-review');
const Policy=require('../app/permission-policy');
const TaskContext=require('../app/task-context');
const CourseRouting=require('../app/course-routing');
const CaptureNotes=require('../app/capture-notes');
const FileReview=require('../app/file-review');
const ReviewerDelegate=require('../app/reviewer-delegate');
const installCheckpoint=require('./helpers/run-checkpoint-host.cjs');
const source=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
const copy=x=>JSON.parse(JSON.stringify(x));
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,`Production host boundary: ${start}`);return source.slice(a,b);}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function until(fn){for(let i=0;i<60;i++){if(fn())return;await Promise.resolve();}assert.ok(fn(),'Reached asynchronous host boundary');}
function fixture(options={}){
 const state={projects:[{id:'daily',name:'随手记录',workspace:'日常'},{id:'course',name:'交互设计方法',workspace:'课程'},{id:'research',name:'论文项目',workspace:'科研'}],notes:[{id:'note',kind:'随记',title:'观察',content:'用户原始记录',workspace:'日常',projectId:null,project:null,updatedAt:1,sourceNoteIds:['existing'],sourceAttachmentIds:[],revisionHistory:[{content:'以前'}]},{id:'source',kind:'随记',title:'另一个随记',content:'不应添加为迁移来源',workspace:'日常',projectId:null,updatedAt:1}],tasks:[],imports:[],links:[],papers:[],trash:[],attachments:[],ui:{},settings:{permissions:{日常:'auto',课程:'auto',科研:'auto'}},conversations:[{id:'chat',workspace:'日常',projectId:null,permissionMode:'full',reviewerApprove:true,sessionAllows:{assign_record:1},messages:[{id:'message',pendingRunId:'run',text:'等待审阅'}]}],agentRuns:[]};
 if(options.bound){Object.assign(state.notes[0],{projectId:'daily',project:'随手记录'});}
 const action={type:'assign_record',recordType:'note',recordId:'note',targetProjectId:options.detach?null:'course',expectedRecordVersion:Assignment.version(state.notes[0])};
 state.agentRuns.push({id:'run',conversationId:'chat',status:'awaiting-approval',workspace:'日常',contextWorkspace:'日常',projectId:null,permissionMode:'full',recordAssignmentScope:{workspace:'日常',projectId:null,readProjects:[]},noteContextIds:['note'],captureNoteIds:['source'],pendingActions:[action,...(options.extraActions||[])],steps:[],attachmentIds:[]});
 const calls={applies:0,previews:0,durable:[],queued:[],errors:[],requests:0};let serial=0,durable=async()=>true,plan;
 const window={RecordAssignment:Assignment,TaskContext,WorkstationPermissionPolicy:Policy,CourseRouting,CaptureNotes,FileReview,ReviewerDelegate};
 const c=vm.createContext({state,window,structuredClone,setTimeout,clearTimeout,AbortController,console,
  Core:{...Core,applyPlan:(s,a,ctx)=>{if(ctx.recordAssignmentPreview)calls.previews++;else calls.applies++;return Core.applyPlan(s,a,ctx);}},WorkstationPermissionPolicy:Policy,TaskContext,CourseRouting,ReviewerDelegate,
  uid:prefix=>prefix+'-'+ ++serial,workspaceName:value=>value==='auto'?'日常':value||'日常',normalizeStateShape(){},
  addRunStep:(run,text)=>run.steps.push({text}),save:()=>calls.queued.push(copy(c.state)),saveDocumentDurably:async()=>{calls.durable.push(copy(c.state));return durable(c,calls.durable.length);},renderAll(){},renderConversation(){},toast:message=>calls.errors.push(String(message)),
  sendMessage(){},activeRunController:null,document:{activeElement:null,body:{},querySelectorAll:()=>[]},requestReviewerOpinion:async()=>{calls.requests++;return {verdict:'approve'};}
 });
 vm.runInContext([section('function commitAttachmentAnalysis(','\nfunction fallbackWorkflow('),section('function actionsNeedApproval(','\nconst ACTION_LABELS'),section('function approvalBusy(','\nasync function fetchWithTimeout('),section('function assertRunActive(','\nlet activeRunController'),section('let delegatedReviewTimer =','\n// 人一旦亲自批准')].join('\n'),c);
  installConversationPathHost(c);
 installCheckpoint(c);
 c.window.PlanReview={init:hooks=>{plan=Plan.createController(hooks);c.window.PlanReview=plan;}};
 vm.runInContext(section('window.PlanReview?.init({','\nasync function openHistoryResult('),c);
 return {c,calls,plan,get run(){return c.state.agentRuns[0];},get chat(){return c.state.conversations[0];},setDurable:fn=>durable=fn};
}

test('actual approval host persists exact human keys before effects and keeps assignment-only routing and sources intact',async()=>{
 const f=fixture(),original=copy(f.c.state.notes[0]),gate=deferred();f.setDurable((_,n)=>n===1?gate.promise:true);
 assert.equal(f.c.actionsNeedApproval(f.run),true);assert.equal(f.run.requiresAssignmentReview,true);assert.equal(f.run.routingReview.required,false);assert.equal(f.c.sessionAllowsRun(f.run),false);
 const promise=f.c.approveRun('run');await until(()=>f.calls.durable.length===1);assert.equal(f.calls.applies,0);assert.equal(f.c.state.notes[0].projectId,null);assert.ok(f.calls.durable[0].agentRuns[0].recordAssignmentApprovals.length);assert.equal(f.calls.durable[0].notes[0].projectId,null);assert.equal(await f.c.approveRun('run'),false);
 gate.resolve(true);assert.equal(await promise,true);assert.equal(f.calls.applies,1);assert.equal(f.run.status,'completed');assert.equal(f.c.state.notes[0].projectId,'course');assert.equal(f.chat.projectId,null);assert.equal(f.run.projectId,null);
 assert.deepEqual(f.c.state.notes[0].sourceNoteIds,original.sourceNoteIds);assert.deepEqual(f.c.state.notes[0].revisionHistory,original.revisionHistory);assert.equal(f.c.state.notes[0].content,original.content);assert.deepEqual(f.c.state.links,[]);assert.deepEqual(f.run.fileChanges,[]);assert.equal(f.run.results[0].recordVersion,Assignment.version(f.c.state.notes[0]));
 assert.equal(f.calls.durable[1].notes[0].projectId,'course');assert.ok(f.calls.durable[1].agentRuns[0].approvalReceipt.savePending);
});
test('actual host detach retains record space without binding the conversation to its old touched project',async()=>{
 const f=fixture({bound:true,detach:true});assert.equal(await f.c.approveRun('run'),true);assert.equal(f.c.state.notes[0].projectId,null);assert.equal(f.c.state.notes[0].project,null);assert.equal(f.c.state.notes[0].workspace,'日常');assert.equal(f.chat.projectId,null);assert.equal(f.run.projectId,null);assert.deepEqual(copy(f.run.projectIds),['daily']);
});
test('mixed host transaction derives conversation routing only from non-assignment outputs',async()=>{
 const f=fixture({extraActions:[{type:'create_task',title:'独立步骤',projectId:'research',workspace:'科研'}]});assert.equal(await f.c.approveRun('run'),true);assert.equal(f.c.state.notes[0].projectId,'course');assert.equal(f.run.projectId,'research');assert.equal(f.chat.projectId,'research');assert.equal(f.chat.workspace,'科研');assert.deepEqual(f.c.state.notes[0].sourceNoteIds,['existing']);assert.deepEqual(f.c.state.tasks[0].sourceNoteIds,['source']);
});
for(const failure of ['reject','false'])test(`approval-key persistence ${failure} applies nothing and restores absent/previous keys`,async()=>{
 for(const previous of [undefined,['prior-receipt']]){const f=fixture();if(previous)f.run.recordAssignmentApprovals=previous;f.setDurable(async()=>{if(failure==='reject')throw Error('disk unavailable');return false;});assert.equal(await f.c.approveRun('run'),false);assert.equal(f.calls.applies,0);assert.equal(f.c.state.notes[0].projectId,null);assert.deepEqual(f.run.recordAssignmentApprovals,previous);assert.equal(f.run.status,'awaiting-approval');}
});
for(const [name,mutate] of [
 ['record body',f=>f.c.state.notes[0].content+=' changed'],
 ['destination name',f=>f.c.state.projects[1].name='renamed'],
 ['destination privacy',f=>f.c.state.projects[1].private=true],
 ['allowed scope',f=>f.run.noteContextIds=[]],
 ['same-id state replacement',f=>f.c.state=copy(f.c.state)],
 ['plan destination',f=>f.run.pendingActions[0].targetProjectId='research'],
])test(`approval rechecks after durable keys: ${name}`,async()=>{
 const f=fixture(),gate=deferred();f.setDurable(()=>gate.promise);const originalRun=f.run,pending=f.c.approveRun('run');await until(()=>f.calls.durable.length===1);mutate(f);gate.resolve(true);assert.equal(await pending,false);assert.equal(f.calls.applies,0);assert.equal(f.c.state.notes[0].projectId,null);if(f.run===originalRun)assert.equal(f.run.recordAssignmentApprovals,undefined);
});
test('applied receipt ACK failure remains save-only; retry does not repeat assignment',async()=>{
 const f=fixture();f.setDurable((_,n)=>{if(n===2)throw Error('lost ACK after commit');return true;});assert.equal(await f.c.approveRun('run'),false);assert.equal(f.calls.applies,1);assert.equal(f.run.status,'awaiting-save');assert.equal(f.c.state.notes[0].projectId,'course');assert.equal(f.chat.messages[0].text,'等待审阅');assert.ok(f.run.recordAssignmentApprovals.length);assert.equal(await f.c.approveRun('run'),false);
 f.setDurable(async()=>true);assert.equal(await f.c.retryApprovalSave('run'),true);assert.equal(f.calls.applies,1);assert.equal(f.run.status,'completed');assert.equal(f.chat.projectId,null);assert.equal(f.run.results[0].after.projectId,'course');
});
test('actual delegated and direct reviewer entry points cannot mint assignment approval',async()=>{
 const f=fixture();assert.equal(await f.c.runDelegatedReview('run'),false);assert.equal(f.calls.requests,0);const token=f.plan.capture('run');f.run.reviewer={status:'done',verdict:'approve',planFingerprint:Core.contentStamp(token.fingerprint)};assert.equal(await f.c.approveRun('run',{token,reviewer:true}),false);assert.equal(f.calls.applies,0);assert.equal(f.calls.durable.length,0);assert.equal(f.run.recordAssignmentApprovals,undefined);
});
test('CourseRouting remains a separate gate after assignment has an exact prior human approval',()=>{
 const f=fixture();f.c.state.imports.push({id:'material',name:'Unknown course.pdf',workspace:'日常',projectId:null});f.run.attachmentIds=['material'];f.run.goal='整理这份材料';assert.equal(f.c.actionsNeedApproval(f.run),true);assert.equal(f.run.routingReview.required,true);assert.equal(f.run.requiresAssignmentReview,true);
 f.run.recordAssignmentApprovals=Assignment.approvalKeys(f.c.state,f.run.pendingActions,f.c.approvalContext(f.run));assert.equal(f.c.actionsNeedApproval(f.run),true);assert.equal(f.run.requiresAssignmentReview,false);assert.equal(f.run.routingReview.required,true);
});
test('real editable-plan onChanged invalidates earlier keys and null remains explicit through new approval',async()=>{
 const f=fixture();f.run.recordAssignmentApprovals=Assignment.approvalKeys(f.c.state,f.run.pendingActions,f.c.approvalContext(f.run));const d=f.plan.draft('run');f.plan.edit('run',d.rows[0].key,'targetProjectId',null);await f.plan.save('run');assert.equal(f.run.recordAssignmentApprovals,undefined);assert.equal(f.run.pendingActions[0].targetProjectId,null);assert.equal(await f.c.approveRun('run'),true);assert.equal(f.run.results[0].operation,'unchanged');assert.equal(f.c.state.notes[0].projectId,null);
});
test('real checkpoint host cannot continue an unapproved assignment despite full mode and session type permission',async()=>{
 const f=fixture();f.run.status='running';await assert.rejects(f.c.runCheckpoints().prepare('run','message',{answer:'not yet'}),{code:'CHECKPOINT_REVIEW_REQUIRED'});assert.equal(f.calls.applies,0);assert.equal(f.run.executionReceipt.phase,'prepared');assert.equal(f.c.state.notes[0].projectId,null);assert.equal(f.calls.durable[0].agentRuns[0].recordAssignmentApprovals,undefined);
 assert.equal(await f.c.continueRunCheckpoint('run'),false);assert.equal(f.run.status,'awaiting-approval');assert.equal(f.calls.applies,0);assert.equal(await f.c.approveRun('run'),true);assert.equal(f.calls.applies,1);assert.equal(f.run.executionReceipt.phase,'committed');assert.equal(f.run.results[0].actionType,'assign_record');
});
test('actual send scope statements freeze only current human intent or the original retry message',()=>{
 const f=fixture();f.c.window.ContextRetrieval=require('../app/context-retrieval');
 vm.runInContext(`function scopeFromActualSend(options,modeMessage,goal,run){${section('const readIntent =','  // 规划模式')}${section('const readScope = window.ContextRetrieval','  run.skillSnapshot =')}return readScope;}`,f.c);
 const run=()=>({projectId:null,contextWorkspace:'日常'}),goal='请归入课程项目「交互设计方法」。';
 const human=run(),scope=f.c.scopeFromActualSend({},null,goal,human);assert.equal(human.recordAssignmentScope.readProjects[0].id,'course');scope.readProjects.length=0;assert.equal(human.recordAssignmentScope.readProjects.length,1);
 for(const options of [{automaticJobId:'auto'},{researchQueueId:'queue'}]){const automatic=run();f.c.scopeFromActualSend(options,null,goal,automatic);assert.deepEqual(copy(automatic.recordAssignmentScope.readProjects),[]);}
 const retry=run();f.c.scopeFromActualSend({retry:true},{text:goal},'模型建议归入科研项目「论文项目」。',retry);assert.deepEqual(copy(retry.recordAssignmentScope.readProjects.map(p=>p.id)),['course']);
});
test('reviewed destination replaces a prepared checkpoint plan before its applied receipt is saved',async()=>{
 const f=fixture();f.run.status='running';await assert.rejects(f.c.runCheckpoints().prepare('run','message',{answer:'pending'}),{code:'CHECKPOINT_REVIEW_REQUIRED'});await f.c.continueRunCheckpoint('run');
 const draft=f.plan.draft('run');f.plan.edit('run',draft.rows[0].key,'targetProjectId','research');await f.plan.save('run');assert.equal(await f.c.approveRun('run'),true);assert.equal(f.c.state.notes[0].projectId,'research');
 assert.deepEqual(copy(f.run.executionReceipt.actions),copy(f.run.pendingActions));assert.equal(f.run.executionReceipt.actionCount,f.run.pendingActions.length);assert.equal(f.run.executionReceipt.results[0].after.projectId,'research');
 assert.equal(f.run.executionReceipt.preReviewPlan.actions[0].targetProjectId,'course');const applies=f.calls.applies;
 // Exercise RunCheckpoint's own canonical stamp verification, not a mirrored
 // implementation of its serializer. A committed receipt must remain reusable.
 await f.c.runCheckpoints().save('run');assert.equal(f.calls.applies,applies);assert.equal(f.run.executionReceipt.phase,'committed');
});
