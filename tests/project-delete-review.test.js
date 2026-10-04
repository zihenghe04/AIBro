const test = require('node:test');
const assert = require('node:assert/strict');
const Plan = require('../app/plan-review.js');
const Core = require('../app/workstation-core.js');
const Lifecycle = require('../app/project-lifecycle.js');
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(actions = [{type:'delete_project',projectId:'research'}]) {
  const state = {
    projects:[{id:'research',name:'虚构课程',workspace:'科研',localPath:'/fictional/retained-folder'},{id:'course',name:'虚构课程',workspace:'课程'}],
    tasks:[{id:'task',title:'虚构作业',projectId:'research',workspace:'科研',status:'todo'}],
    notes:[{id:'note',title:'虚构笔记',projectId:'research',workspace:'科研',content:'Keep until approval'}],
    papers:[{id:'paper',title:'虚构论文分析',projectId:'research',workspace:'科研'}],
    imports:[{id:'original',name:'虚构原件.pdf',projectId:'research',workspace:'科研',content:'Local content'}],
    attachments:[{id:'original',conversationId:'past'}],
    conversations:[{id:'receipt',projectId:'research',workspace:'科研',messages:[],attachments:[]},{id:'past',projectId:'research',workspace:'科研',messages:[],attachments:['original']}],
    agentRuns:[{id:'run',conversationId:'receipt',projectId:'research',workspace:'科研',status:'awaiting-approval',pendingActions:clone(actions)},{id:'old-run',conversationId:'past',projectId:'research',status:'completed'}],
    links:[],trash:[],currentConversationId:'receipt',currentProjectId:'research'
  };
  const run = state.agentRuns[0];
  run.projectSnapshots = Core.projectSnapshots(state,{projectIds:actions.map(action=>action.projectId)});
  let saves = 0;
  const host = {
    getState:()=>state, getRun:id=>state.agentRuns.find(item=>item.id===id),
    contextForRun:run=>({workspace:run.workspace,projectId:run.projectId,conversationId:run.conversationId,runId:run.id,projectSnapshots:run.projectSnapshots}),
    applyPlan:(...args)=>Core.applyPlan(...args), save:async()=>{saves++;return true;},
    recheckPlan:(_run,_actions,validate,targets)=>{
      const before = run.projectSnapshots;
      try {
        const authorizedIds = targets.filter(action=>action.type==='delete_project'&&Object.hasOwn(before,action.projectId)).map(action=>action.projectId);
        run.projectSnapshots={...before,...Core.projectSnapshots(state,{projectIds:authorizedIds})};
        return validate();
      } catch(error) {run.projectSnapshots=before;throw error;}
    }
  };
  const api = Plan.createController(host);
  return {state,run,host,api,get row(){return api.draft('run').rows[0];},get saves(){return saves;}};
}

test('project approval resolves the actual stable target and shows recoverable cascade without altering data',()=>{
  const f=fixture(),before=clone(f.state),draft=f.api.draft('run');
  assert.equal(draft.validation.ok,true);assert.deepEqual(f.state,before);assert.equal(f.saves,0);
  const misleading={...f.row.action,name:'Wrong project name',title:'Wrong title',workspace:'课程'};
  const view=Plan.describe(misleading,f.state,draft.context,[misleading],draft.validation.results[0]);
  assert.equal(view.label,'项目移入回收站');assert.equal(view.title,'虚构课程');assert.equal(view.workspace,'科研');assert.equal(view.targetId,'research');assert.equal(view.danger,true);
  for(const label of ['关联任务','笔记','资料','论文分析','对话'])assert.match(view.changes.find(change=>change.label===label).after,/1 项移入回收站/);
  assert.match(view.consequence,/回收站，可恢复/);assert.match(view.consequence,/其他项目引用的原件保留/);assert.match(view.consequence,/本机目录与文件保留/);assert.match(view.consequence,/当前指令对话保留/);
  assert.match(view.changes.find(change=>change.label==='本机目录').after,/保留目录/);
});

test('deletion IDs cannot be edited or partly accepted and whole-step refusal does not execute',async()=>{
  const f=fixture([{type:'delete_project',projectId:'research'},{type:'delete_project',projectId:'course'}]),rows=f.api.draft('run').rows;
  assert.deepEqual(Plan.fieldsFor(rows[0].action,f.state,f.api.draft('run').context,rows.map(row=>row.action)),[]);
  for(const path of ['projectId','project','projectName','type'])assert.throws(()=>f.api.edit('run',rows[0].key,path,'course'),{code:'PLAN_FIELD'});
  assert.throws(()=>f.api.decideField('run',rows[0].key,'projectId',false),{code:'PLAN_FIELD'});
  f.api.toggle('run',rows[0].key,false);await f.api.save('run');
  const token=f.api.capture('run');assert.deepEqual(token.actions,[{type:'delete_project',projectId:'course'}]);assert.deepEqual(f.api.assertCurrent(token),token.actions);assert.equal(f.state.projects.length,2);assert.equal(f.state.trash.length,0);
  f.api.toggle('run',rows[1].key,false);await assert.rejects(f.api.save('run'),{code:'PLAN_INVALID'});assert.equal(f.state.projects.length,2);
});

test('approved project deletion becomes stale after child edits or new external citation, even though the project itself did not change',()=>{
  for(const mutate of [state=>{state.tasks[0].title='Edited while approval awaited';},state=>{state.notes.push({id:'external',projectId:'course',sourceAttachmentIds:['original']});},state=>{state.conversations.push({id:'new-chat',projectId:'research',attachments:[]});}]){
    const f=fixture(),token=f.api.capture('run');mutate(f.state);
    assert.throws(()=>f.api.assertCurrent(token),{code:'PLAN_TARGET_CHANGED'});assert.equal(f.state.trash.length,0);assert.equal(f.state.projects.length,2);
  }
});

test('typing in receipt conversation and transient run progress do not falsely invalidate project approval',()=>{
  const f=fixture(),token=f.api.capture('run');
  f.state.conversations[0].messages.push({role:'user',content:'A later draft'});f.state.conversations[0].updatedAt=20;
  f.run.events=[{type:'status',text:'Checking approval'}];f.run.updatedAt=20;
  assert.deepEqual(f.api.assertCurrent(token),token.actions);
});

test('explicit recheck refreshes only previously read project versions and invalidates old approval tokens',()=>{
  const f=fixture(),token=f.api.capture('run'),before=f.run.projectSnapshots.research;
  f.state.tasks[0].description='Updated after display';assert.throws(()=>f.api.capture('run'),{code:'PLAN_TARGET_CHANGED'});
  f.api.recheck('run');assert.notEqual(f.run.projectSnapshots.research,before);assert.equal(f.api.draft('run').context.projectSnapshots.research,f.run.projectSnapshots.research);
  assert.throws(()=>f.api.assertCurrent(token),{code:'PLAN_CHANGED'});const next=f.api.capture('run');assert.deepEqual(f.api.assertCurrent(next),next.actions);assert.equal(f.state.trash.length,0);
});

test('host recheck cannot expand project authorization or change workspace and rolls back the displayed context',()=>{
  for(const change of ['new-project','workspace']){
    const f=fixture(),draft=f.api.draft('run'),before=clone(draft.context);f.state.tasks[0].title='Latest child';
    f.host.recheckPlan=(_run,_actions,validate)=>{
      const oldSnapshots=f.run.projectSnapshots,oldSpace=f.run.workspace;
      try {f.run.projectSnapshots={...oldSnapshots,...Core.projectSnapshots(f.state,{projectIds:['research']})};if(change==='new-project')f.run.projectSnapshots.course=Lifecycle.snapshot(f.state,'course');else f.run.workspace='课程';return validate();}
      catch(error){f.run.projectSnapshots=oldSnapshots;f.run.workspace=oldSpace;throw error;}
    };
    assert.throws(()=>f.api.recheck('run'),{code:'PLAN_SCOPE_CHANGED'});assert.deepEqual(draft.context,before);assert.equal(draft.stale,true);assert.equal(f.state.projects.length,2);
  }
});

test('joint project deletion review uses exact union impact and recomputes sharing when one project is excluded',async()=>{
  const f=fixture([{type:'delete_project',projectId:'research'},{type:'delete_project',projectId:'course'}]);
  f.state.notes.push({id:'course-note',title:'Other project citation',projectId:'course',sourceAttachmentIds:['original']});
  f.run.projectSnapshots=Core.projectSnapshots(f.state,{projectIds:['research','course']});
  const draft=f.api.draft('run'),rows=draft.rows;
  const unionView=Plan.describe(rows[0].action,f.state,draft.context,rows.map(row=>row.action),draft.validation.results[0]);
  assert.match(unionView.changes.find(change=>change.label==='资料').after,/本次 2 个项目合计 · 1 项移入回收站/);
  assert.match(unionView.changes.find(change=>change.label==='共享原件').after,/0 项保留/);
  f.api.toggle('run',rows[1].key,false);await f.api.save('run');
  const current=f.api.draft('run'),view=Plan.describe(rows[0].action,f.state,current.context,f.api.actions('run'),current.validation.results[0]);
  assert.equal(view.changes.find(change=>change.label==='资料').after,'0 项移入回收站');assert.equal(view.changes.find(change=>change.label==='共享原件').after,'1 项保留在待归类');
  assert.equal(f.state.imports.length,1);assert.equal(f.state.trash.length,0);
});

test('reviewed result counts are authoritative and standalone agenda retention is explicit',()=>{
  const f=fixture(),draft=f.api.draft('run'),result={...draft.validation.results[0],counts:{tasks:7,notes:4,imports:3,papers:2,conversations:1},sharedImportsRetained:2,agendaMirrorsRetained:1};delete result.projectDeletionSummary;
  const view=Plan.describe(f.row.action,f.state,draft.context,[f.row.action],result);
  assert.equal(view.changes.find(change=>change.label==='关联任务').after,'7 项移入回收站');assert.equal(view.changes.find(change=>change.label==='共享原件').after,'2 项保留在待归类');assert.match(view.changes.find(change=>change.label==='独立日程').after,/不修改或删除真实日程/);
});
