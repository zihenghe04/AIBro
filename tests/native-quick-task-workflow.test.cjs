const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const root = path.resolve(__dirname,'..'), copy = value => JSON.parse(JSON.stringify(value));
const Workflow = require('../app/task-workflow.js');
const Merge = require('../app/sync-merge.js');
const id = 'quick_task_01234567-89ab-4cde-8fab-0123456789ab';
const task = (changes={}) => ({id:'one',title:'Synthetic coursework',workspace:'课程',projectId:'project',priority:'high',status:'todo',createdAt:1,updatedAt:1,...changes});
const deferred = () => {let resolve; const promise=new Promise(done=>resolve=done); return {promise,resolve};};
function fixture(options={}) {
  const state=options.state || {tasks:[task()],projects:[{id:'project',name:'Synthetic course',workspace:'课程'}],notes:[],imports:[],papers:[],links:[],trash:[],agentRuns:[],conversations:[],ui:{},settings:{}};
  const calls={saves:0,events:[]};
  const c={state,storageHydrated:true,serverConflict:false,purgeTrash:{syncPaused:false},crypto:webcrypto,TextEncoder,URL,console,
    PrivateMode:{isOn:()=>false},document:{documentElement:{lang:'en'},dispatchEvent:event=>calls.events.push(event)},CustomEvent:class{constructor(type,data){this.type=type;Object.assign(this,data);}},
    saveDocumentDurably:async()=>{calls.saves++; return options.persist?options.persist(c):true;}};
  c.window=c;vm.createContext(c);
  for(const name of ['task-workflow','content-lifecycle','citation-evidence','task-dependencies','task-deliverable','planning-workbench','workstation-core']) vm.runInContext(fs.readFileSync(path.join(root,'app',name+'.js'),'utf8'),c);
  vm.runInContext(fs.readFileSync(path.join(root,'native/Resources/quick-workbench.js'),'utf8'),c);
  return {c,calls,api:c.NativeQuickWorkbench,get state(){return c.state;}};
}
const edit=(f,patch)=>({action:'update-task',id:'one',expectedVersion:f.api.snapshot().tasks.find(x=>x.id==='one')?.version,patch});
const create=changes=>({action:'create-task',id,title:'Synthetic new task',workspace:'课程',projectId:'project',dueAt:null,...changes});
const rename=(f,changes={})=>({action:'rename-task-workflow',id:'quick_task_workflow_names',category:'P0',name:'Literature',expectedVersion:f.api.snapshot().workflowVersion,...changes});
test('canonical projection distinguishes inbox fallback, explicit null, ordinary legacy and private owners',()=>{
  const f=fixture(); f.state.tasks=[task(),task({id:'inbox',sourceTaskInbox:{version:1,id:'external',category:'P1'}}),task({id:'clear',workflowCategory:null,sourceTaskInbox:{category:'P2'}}),task({id:'explicit',workflowCategory:'P3'}),task({id:'private',private:true,workflowCategory:'P0'}),task({id:'retired',archived:true,workflowCategory:'P0'})];
  const before=JSON.stringify(f.state.tasks), rows=copy(f.api.snapshot().tasks);
  assert.deepEqual(Object.fromEntries(rows.map(row=>[row.id,row.workflowCategory])),{one:null,inbox:'P1',clear:null,explicit:'P3'});
  assert.equal(JSON.stringify(f.state.tasks),before); assert.equal(f.calls.saves,0);
});
test('create keeps canonical scope and priority, exact category fingerprint and legacy retry compatibility',async()=>{
  const f=fixture();const payload=create({workflowCategory:'P2'});
  assert.equal((await f.api.command(payload)).status,'saved');const item=f.state.tasks.find(t=>t.id===id);
  assert.equal(item.workflowCategory,'P2');assert.equal(item.workspace,'课程');assert.equal(item.projectId,'project');assert.equal(item.priority,'medium');
  const next=fixture({state:copy(f.state)});assert.equal((await next.api.command(payload)).status,'saved');assert.equal(next.state.tasks.length,2);
  assert.equal((await next.api.command({...payload,workflowCategory:'P3'})).reason,'collision');
  const old=fixture();const legacy=create({});await old.api.command(legacy); const restarted=fixture({state:copy(old.state)});
  assert.equal((await restarted.api.command(legacy)).status,'saved');assert.equal(restarted.state.tasks.length,2);assert.equal(Object.hasOwn(restarted.state.tasks[1],'workflowCategory'),false);
});
test('category edit and clear retain inbox provenance, priority, scope and subsequent agent patches',async()=>{
  const f=fixture();f.state.tasks[0].sourceTaskInbox={version:1,id:'original',category:'P0'};
  assert.equal((await f.api.command(edit(f,{workflowCategory:'P2'}))).status,'saved');
  assert.equal((await f.api.command(edit(f,{workflowCategory:null}))).status,'saved');
  const item=f.state.tasks[0];assert.equal(Workflow.category(item),null);assert.equal(item.sourceTaskInbox.category,'P0');assert.equal(item.priority,'high');assert.equal(item.projectId,'project');
  const after=f.c.WorkstationCore.applyPlan(f.state,[{type:'update_task',taskId:'one',patch:{title:'Updated by a scoped run'}}],{workspace:'课程',projectId:'project',allowedTaskIds:['one']}).state;
  assert.equal(after.tasks[0].workflowCategory,null);assert.equal(after.tasks[0].sourceTaskInbox.category,'P0');
  assert.equal(f.calls.events.length,2);
});
test('invalid categories and private/stale task edits never write',async()=>{
  for(const category of ['', 'P4', 1, {}, undefined]) {const f=fixture();assert.equal((await f.api.command(create({workflowCategory:category}))).reason,'invalid');assert.equal(f.calls.saves,0);}
  const f=fixture();const p=edit(f,{workflowCategory:'P3'}); f.state.tasks[0].title='Concurrent edit';assert.equal((await f.api.command(p)).reason,'changed');
  f.state.tasks[0].private=true;assert.equal((await f.api.command(p)).reason,'private');assert.equal(f.calls.saves,0);
});
test('rename waits for durable ACK, rejects duplicate names, and is retry-safe after a lost reply',async()=>{
  const gate=deferred(),entered=deferred(),f=fixture({persist:()=>{entered.resolve();return gate.promise;}}),request=rename(f);
  const pending=f.api.command(request);await entered.promise;
  assert.equal(f.api.snapshot().workflowNames.P0,'课程');gate.resolve(true);const ack=await pending;
  assert.equal(ack.status,'saved');assert.equal(ack.workflowNames.P0,'Literature');assert.equal(f.api.snapshot().workflowNames.P0,'Literature');
  const restarted=fixture({state:copy(f.state)});assert.equal((await restarted.api.command(request)).status,'saved');
  assert.equal((await restarted.api.command(rename(restarted,{name:'日常'}))).reason,'duplicate_name');
  assert.equal((await restarted.api.command(rename(restarted,{name:'bad\nname'}))).reason,'invalid');
  assert.equal((await restarted.api.command(rename(restarted,{name:'Later name',expectedVersion:ack.workflowVersion}))).status,'saved');
  assert.equal(restarted.state.ui.taskWorkflowNames.P0,'Later name');
  assert.equal(restarted.state.tasks.length,1);assert.equal(restarted.state.tasks[0].title,'Synthetic coursework');
});
test('failed rename rollback and owner/privacy changes cannot acknowledge the wrong document',async()=>{
  const fail=fixture({persist:()=>false});const original=copy(fail.state.ui);assert.equal((await fail.api.command(rename(fail))).reason,'storage_failed');assert.deepEqual(copy(fail.state.ui),original);
  const newer=fixture({persist:c=>{c.state.ui.taskWorkflowNames.P0='Newer concurrent label';return false;}});
  assert.equal((await newer.api.command(rename(newer))).reason,'storage_failed');assert.equal(newer.state.ui.taskWorkflowNames.P0,'Newer concurrent label');
  for(const mutation of [c=>c.PrivateMode.isOn=()=>true,c=>c.state=copy(c.state),c=>c.state.ui={...c.state.ui}]) {
    const f=fixture({persist:c=>{mutation(c);return true;}});assert.notEqual((await f.api.command(rename(f))).status,'saved');
  }
  const f=fixture();const request=rename(f);f.state.ui.taskWorkflowNames={...Workflow.defaults,P1:'New category'};
  assert.equal((await f.api.command(request)).reason,'changed');assert.equal(f.calls.saves,0);
});
test('task category field participates in real sync merge without replacing local category labels',()=>{
  const old=fixture().state,local=copy(old),cloud=copy(old);local.ui.taskWorkflowNames={...Workflow.defaults,P0:'Local only'};cloud.tasks[0].workflowCategory='P1';
  const merged=Merge.merge(old,local,cloud);assert.equal(merged.tasks[0].workflowCategory,'P1');assert.equal(merged.ui.taskWorkflowNames.P0,'Local only');
  const conflict=copy(local);conflict.tasks[0].workflowCategory='P2';assert.throws(()=>Merge.merge(old,conflict,cloud),/workflowCategory/);
});

test('AI Bro defaults adapt topic labels without resetting saved custom names or changing stable IDs',()=>{
  assert.deepEqual(Workflow.defaults,{P0:'课程',P1:'科研',P2:'创作',P3:'日常'});
  assert.deepEqual(Workflow.names({ui:{taskWorkflowNames:{P0:'Lab reading',P1:'自媒体&写作',P2:'My scripts',P3:'Home'}}}),{P0:'Lab reading',P1:'自媒体&写作',P2:'My scripts',P3:'Home'});
  assert.deepEqual(Workflow.keys,['P0','P1','P2','P3']);
});
