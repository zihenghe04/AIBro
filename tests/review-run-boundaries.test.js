const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Core = require('../app/workstation-core');
const AttachmentAnalysis = require('../app/attachment-analysis');
const AttachmentContext = require('../app/attachment-context');
const AttachmentDelivery = require('../app/attachment-delivery');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const cut = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const empty = () => ({ projects: [{id:'research', name:'控制实验', workspace:'科研'}], tasks:[], notes:[], imports:[], papers:[], links:[], trash:[], agentRuns:[], conversations:[{id:'conversation',title:'Existing conversation',projectId:'research',workspace:'科研',messages:[],attachments:[]}], currentConversationId:'conversation', settings:{permissions:{'日常':'auto','课程':'auto','科研':'approval'}} });
function executionContext() {
  let next=0;
  const c=vm.createContext({state:empty(),Core,AttachmentContext,AttachmentDelivery,AttachmentAnalysis,window:{AttachmentAnalysis},workspaceName:v=>v==='科研'||v==='课程'?v:'日常',uid:prefix=>`${prefix}-${++next}`,normalizeStateShape:()=>{},addRunStep:()=>{},save:()=>{},renderAll:()=>{}});
  vm.runInContext(cut('function activeResultRecord(', '\nfunction conversationProjectIds(') + cut('function dedupeResultEntries(', '\nfunction groupedEntities(') + cut('function commitAttachmentAnalysis(', '\nfunction executeActions(')+cut('function executeActions(', '\nfunction fallbackWorkflow(')+cut('function actionsNeedApproval(', '\nfunction actionSummary('),c);
  return c;
}

test('approval considers actual action targets, even when the model declares a different top-level workspace', () => {
  const c=executionContext();
  const run={workspace:'日常',conversationId:'conversation',pendingActions:[{type:'create_task',workspace:'科研',projectId:'research',title:'Protected experiment'}]};
  assert.equal(c.actionsNeedApproval(run),true,'A research write requires research approval regardless of the model workspace label');
  c.state.tasks.push({id:'research-task',title:'Review experiment',workspace:'科研',projectId:'research',status:'todo'});
  run.pendingActions=[{type:'delete_task',taskId:'research-task'}];
  assert.equal(c.actionsNeedApproval(run),true,'Delete must use the existing object workspace');
});

test('run creation freezes the current project for both plan validation and actual commit', () => {
  const c=executionContext();
  Object.assign(c,{goal:'创建任务',conversation:c.state.conversations[0],attachmentsBefore:[],provider:'api',model:'fixture-model',effort:'',classifyWorkspace:()=> '科研'});
  const line=source.split('\n').find(line=>line.startsWith('  const run = { id: uid(\'run\'),'));
  assert.ok(line,'Cannot locate actual run construction');
  vm.runInContext(cut('function activeResultRecord(', '\nfunction conversationProjectIds(') + cut('function dedupeResultEntries(', '\nfunction groupedEntities(') + `${line}\nglobalThis.runUnderTest=run;`,c);
  const action={type:'create_task',title:'Current project task',sourceAttachmentIds:[]};
  const expected=Core.applyPlan(c.state,[action],{workspace:'科研',projectId:'research'}).state.tasks[0].projectId;
  c.executeActions([action],c.runUnderTest);
  assert.equal(c.state.tasks[0].projectId,expected,'Execution must use the same project context as preflight validation');
});

for (const phase of ['model preparation', 'model response']) test(`deleting the originating conversation during ${phase} prevents orphan workflow commits`, { timeout: 4000 }, async () => {
  const c=executionContext(); const nodes=new Map();
  const node=key=>{if(!nodes.has(key)) nodes.set(key,{value:'',textContent:'',disabled:false,scrollHeight:0,scrollTop:0,clientHeight:0,classList:{remove(){},add(){}},setAttribute(){},querySelector(){return null},appendChild(){},firstElementChild:{}});return nodes.get(key);};
  let ready, finishTransport, markTransportStarted; const pending=new Promise(resolve=>{ready=resolve}); const transportStarted=new Promise(resolve=>{markTransportStarted=resolve}); const transportResult=new Promise(resolve=>{finishTransport=resolve});
  const models={configuration:()=>({provider:'api',model:'fixture-model',effort:''}),resolve:()=>pending};
  Object.assign(c,{$:node,window:{ConversationModels:models,AttachmentAnalysis},ConversationModels:models,localStorage:{getItem:()=>''},document:{createElement:()=>node('temporary-holder')},AbortController,URL,setTimeout,clearTimeout,
    activeRunController:null,liveRenderTimer:null,currentConversation:()=>c.state.conversations[0],currentAttachments:()=>[],defaultModelConfiguration:()=>({provider:'api',model:'fixture-model',effort:''}),
    renderConversation(){},renderMessage(){},classifyWorkspace:()=> '科研',visiblePaper:()=>true,actionSummary:()=>'',
    AgentTransport:{requestPlan:async()=>{markTransportStarted();return transportResult}},
    addRunStep:(run,text,status)=>{run.steps.push({text,status})},
  });
  node('#agentInput').value='创建一个任务';node('#apiBase').value='https://example.invalid/v1';node('#apiKey').value='fixture-key';
  vm.runInContext(cut('function activeResultRecord(', '\nfunction conversationProjectIds(') + cut('function dedupeResultEntries(', '\nfunction groupedEntities(') + cut('function assertRunActive(', '\nlet activeRunController')+cut('function apiOrigin(', '\nfunction renderSettings(')+cut('async function sendMessage(', '\nfunction stopCurrentRun()'),c);
  const sending=c.sendMessage();
  assert.equal(c.state.agentRuns.length,1); const run=c.state.agentRuns[0];
  if(phase==='model response') { ready({provider:'api',model:'fixture-model',effort:''}); await Promise.race([transportStarted,sending.then(()=>{throw new Error('Workflow finished before transport request: '+run.error)})]); }
  // This is the same state transition as deleteManagedItem: both originating
  // conversation and its runs disappear while the model promise is pending.
  c.state.conversations=[];c.state.agentRuns=[];
  if(phase==='model preparation') ready({provider:'api',model:'fixture-model',effort:''});
  finishTransport(JSON.stringify({workspace:'日常',message:'Done',actions:[{type:'create_task',title:'Unexpected resurrected task',sourceAttachmentIds:[]}]}));await sending;
  assert.equal(run.status,'cancelled');assert.match(run.error,/原对话已删除或归档/);
  assert.equal(c.state.tasks.length,0,'A removed conversation must not create tasks after its response arrives');
});

test('archiving the bound project invalidates a running operation even if its conversation is still present', () => {
  const c=executionContext();
  vm.runInContext(cut('function activeResultRecord(', '\nfunction conversationProjectIds(') + cut('function dedupeResultEntries(', '\nfunction groupedEntities(') + cut('function assertRunActive(', '\nlet activeRunController'),c);
  const run={id:'running',conversationId:'conversation',projectId:'research',workspace:'科研'};
  c.state.agentRuns.push(run);c.state.projects[0].archived=true;
  assert.throws(()=>c.assertRunActive(run),/项目|归档|取消/);
});

test('local fallback preserves an explicitly bound project instead of resetting the task to unassigned', () => {
  const c=executionContext();c.state.projects[0].workspace='日常';c.state.conversations[0].workspace='日常';
  Object.assign(c,{currentAttachments:()=>[],classifyWorkspace:()=> '日常',normalize:value=>String(value).toLowerCase(),actionSummary:()=>''});
  vm.runInContext(cut('function activeResultRecord(', '\nfunction conversationProjectIds(') + cut('function dedupeResultEntries(', '\nfunction groupedEntities(') + cut('function fallbackWorkflow(', '\nfunction actionsNeedApproval('),c);
  const run={id:'local-run',conversationId:'conversation',projectId:'research',workspace:'日常'};
  c.fallbackWorkflow('创建任务：本周整理进度',run);
  assert.equal(c.state.tasks[0]?.projectId,'research');
});

test('changing the conversation scope during model preparation affects only the next turn retrieval', { timeout: 4000 }, async () => {
  const c=executionContext(); const nodes=new Map();
  const node=key=>{if(!nodes.has(key)) nodes.set(key,{value:'',textContent:'',disabled:false,scrollHeight:0,scrollTop:0,clientHeight:0,classList:{remove(){},add(){}},setAttribute(){},querySelector(){return null},appendChild(){},firstElementChild:{}});return nodes.get(key);};
  c.state.projects.push({id:'another-project',name:'另一项目',workspace:'日常'});
  let ready;const pending=new Promise(resolve=>{ready=resolve});let recalledScope, requestText;
  const models={configuration:()=>({provider:'api',model:'fixture-model',effort:''}),resolve:()=>pending};
  const retrieval={buildContext:(_state,scope)=>{recalledScope={...scope};return {text:'FROZEN_CONTEXT',entries:[],coverage:{}}}};
  Object.assign(c,{$:node,window:{ConversationModels:models,ContextRetrieval:retrieval,AttachmentAnalysis},ConversationModels:models,localStorage:{getItem:()=>''},document:{createElement:()=>node('holder')},AbortController,URL,setTimeout,clearTimeout,
    activeRunController:null,liveRenderTimer:null,currentConversation:()=>c.state.conversations[0],currentAttachments:()=>[],defaultModelConfiguration:()=>({provider:'api',model:'fixture-model',effort:''}),renderConversation(){},renderMessage(){},classifyWorkspace:()=> '科研',visiblePaper:()=>true,actionSummary:()=>'',
    AgentTransport:{requestPlan:async request=>{requestText=request.input;return JSON.stringify({workspace:'科研',message:'Read only result',actions:[]})}},addRunStep:(run,text,status)=>{run.steps.push({text,status})},
  });
  node('#agentInput').value='总结这个项目';node('#apiBase').value='https://example.invalid/v1';node('#apiKey').value='fixture-key';
  vm.runInContext(cut('function activeResultRecord(', '\nfunction conversationProjectIds(') + cut('function dedupeResultEntries(', '\nfunction groupedEntities(') + cut('function assertRunActive(', '\nlet activeRunController')+cut('function apiOrigin(', '\nfunction renderSettings(')+cut('async function sendMessage(', '\nfunction stopCurrentRun()'),c);
  const sending=c.sendMessage();const run=c.state.agentRuns[0];
  c.state.conversations[0].projectId='another-project';c.state.conversations[0].workspace='日常';
  ready({provider:'api',model:'fixture-model',effort:''});await sending;
  assert.equal(run.status,'completed',run.error);
  assert.equal(recalledScope.projectId,'research');assert.equal(recalledScope.workspace,'科研');
  assert.match(requestText,/FROZEN_CONTEXT/);
});

test('legacy content and new links use their owning project policy when workspace metadata is missing', () => {
  const c=executionContext();
  c.state.imports.push({id:'legacy-source',name:'Paper.pdf',projectId:'research',workspace:null});
  const run={workspace:'日常',pendingActions:[{type:'rename_attachment',attachmentId:'legacy-source',newName:'Renamed.pdf'}]};
  assert.equal(c.actionsNeedApproval(run),true);
  c.state.notes.push({id:'daily-note',title:'Daily note',workspace:'日常',projectId:null,content:'Text'});
  run.pendingActions=[{type:'create_link',sourceId:'legacy-source',targetId:'daily-note'}];
  assert.equal(c.actionsNeedApproval(run),true);
});

test('approving a stale plan after its project is archived does not create an unassigned task', { timeout: 4000 }, async () => {
  const c=executionContext();c.toast=()=>{};c.window={AttachmentAnalysis};
  vm.runInContext(cut('function activeResultRecord(', '\nfunction conversationProjectIds(') + cut('function dedupeResultEntries(', '\nfunction groupedEntities(') + cut('function assertRunActive(', '\nlet activeRunController')+cut('async function approveRun(', '\nfunction rejectRun('),c);
  const run={id:'pending',status:'awaiting-approval',conversationId:'conversation',projectId:'research',workspace:'科研',steps:[],pendingActions:[{type:'create_task',title:'Stale approval task',sourceAttachmentIds:[]}]};
  c.state.agentRuns.push(run);c.state.conversations[0].messages.push({pendingRunId:'pending',text:'Please approve'});
  c.state.projects[0].archived=true;
  await assert.doesNotReject(()=>c.approveRun('pending'),'Stale approval should provide an actionable UI outcome rather than an uncaught error');
  assert.equal(c.state.tasks.length,0,'Approval must revalidate the project lifecycle before commit');
  assert.notEqual(run.status,'completed');
});

test('a valid pending plan can be approved while an unrelated request controller is aborted', { timeout: 4000 }, async () => {
  const c=executionContext();c.toast=()=>{};c.window={AttachmentAnalysis};const controller=new AbortController();controller.abort();c.activeRunController=controller;
  vm.runInContext(cut('function activeResultRecord(', '\nfunction conversationProjectIds(') + cut('function dedupeResultEntries(', '\nfunction groupedEntities(') + cut('function assertRunActive(', '\nlet activeRunController')+cut('async function approveRun(', '\nfunction rejectRun('),c);
  const run={id:'pending',status:'awaiting-approval',conversationId:'conversation',projectId:'research',workspace:'科研',steps:[],pendingActions:[{type:'create_task',title:'Approved task',sourceAttachmentIds:[]}]};
  c.state.agentRuns.push(run);c.state.conversations[0].messages.push({pendingRunId:'pending',text:'Please approve'});
  await c.approveRun('pending');
  assert.equal(run.status,'completed',run.error);assert.equal(c.state.tasks.length,1);assert.equal(c.state.tasks[0].projectId,'research');
});

test('local fallback checks its actual queued actions under request and inherited space permissions',()=>{
 for (const permissionMode of ['request','legacy']) {
  const c=executionContext();c.WorkstationPermissionPolicy=require('../app/permission-policy');
  c.state.projects[0].workspace='日常';c.state.conversations[0].workspace='日常';c.state.settings.permissions['日常']='approval';
  Object.assign(c,{classifyWorkspace:()=> '日常',actionSummary:()=>'',makeProject:()=>{},norm:v=>v});
  vm.runInContext(cut('function activeResultRecord(', '\nfunction conversationProjectIds(') + cut('function dedupeResultEntries(', '\nfunction groupedEntities(') + cut('function fallbackWorkflow(', '\nfunction actionsNeedApproval('),c);
  const run={id:'queued',conversationId:'conversation',projectId:'research',workspace:'日常',permissionMode,attachmentIds:[]};
  c.fallbackWorkflow('创建下一步任务',run);
  assert.equal(run.status,'awaiting-approval');assert.ok(run.pendingActions.length>0);assert.equal(c.state.tasks.length,0);
 }
});

test('archiving a preflight-matched project cancels approval instead of creating a same-name replacement from an unbound conversation', { timeout: 4000 }, async () => {
  const c=executionContext();c.toast=()=>{};
  const LocalProjectAgent=require('../app/local-project-agent');
  const folder={id:'verified-local',rootId:'authorized-root',name:'homepage',path:'/fixture/homepage'};
  let snapshots=0;
  const LocalProjects={snapshot:async()=>{snapshots++;return {folder,tree:[],files:[]}},ensureAccess:async()=>({roots:[{id:folder.rootId}]})};
  Object.assign(c,{window:{LocalProjectAgent,LocalProjects,AttachmentAnalysis},LocalProjectAgent,LocalProjects,WorkstationPermissionPolicy:require('../app/permission-policy')});
  c.state.conversations[0].projectId=null;
  const run={id:'matched-pending',status:'awaiting-approval',conversationId:'conversation',projectId:null,workspace:'科研',permissionMode:'request',steps:[],localCandidates:[folder],localSearched:true,
    pendingActions:[{type:'create_project',id:'new-alias',name:c.state.projects[0].name,workspace:'科研'},{type:'link_local_project',projectId:'new-alias',candidateId:folder.id,workspace:'科研'}]};
  c.state.agentRuns.push(run);c.state.conversations[0].messages.push({pendingRunId:run.id,text:'Approve the matched project'});
  assert.equal(c.actionsNeedApproval(run),true);
  assert.deepEqual(Array.from(run.expectedProjectTargets,target=>target.id),['research']);
  vm.runInContext(cut('function activeResultRecord(', '\nfunction conversationProjectIds(') + cut('function dedupeResultEntries(', '\nfunction groupedEntities(') + cut('function assertRunActive(', '\nlet activeRunController')+cut('async function approveRun(', '\nfunction rejectRun('),c);
  c.state.projects[0].archived=true;
  await c.approveRun(run.id);
  assert.equal(run.status,'cancelled');
  assert.equal(c.state.projects.length,1,'Approval must not create a new active project after its matched target is archived');
  assert.equal(c.state.projects[0].localFolder,undefined);
  assert.equal(c.state.tasks.length,0);
  assert.equal(snapshots,0,'Lifecycle validation precedes any renewed local file access');
});
