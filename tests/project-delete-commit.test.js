const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const Core = require('../app/workstation-core');
const Lifecycle = require('../app/project-lifecycle');
const source = fs.readFileSync(require.resolve('../app/app.js'),'utf8');

test('the host commits cascade membership while keeping the live receipt conversation and run', () => {
  const message = {id:'reply',text:'Pending approval'}, receipt = {id:'receipt',messageId:'reply'};
  const conversation = {id:'current',projectId:'p',workspace:'日常',messages:[message],attachments:['pdf']};
  const run = {id:'run',conversationId:'current',projectId:'p',workspace:'日常',projectIds:['p'],expectedProjectTargets:[{id:'p'}],approvalReceipt:receipt};
  const oldRun = {id:'past',conversationId:'current',projectId:'p'};
  const state = {projects:[{id:'p',name:'Deletion QA',workspace:'日常'}],conversations:[conversation,{id:'retire',projectId:'p',messages:[],attachments:[]}],agentRuns:[run,oldRun,{id:'retire-run',conversationId:'retire',projectId:'p'}],imports:[{id:'pdf',projectId:'p',name:'QA.pdf'}],notes:[],tasks:[],papers:[],attachments:[],links:[],trash:[],currentConversationId:'current',currentProjectId:'p'};
  run.projectSnapshots = Core.projectSnapshots(state,{projectIds:['p']});
  let serial=0;
  const context = vm.createContext({Core,state,window:{},uid:prefix=>`${prefix}-${++serial}`,normalizeStateShape:()=>{},addRunStep:()=>{},save:()=>{},renderAll:()=>{}});
  const start=source.indexOf('function executeActions('),end=source.indexOf('function fallbackWorkflow(',start);
  vm.runInContext(source.slice(start,end),context);
  context.executeActions([{type:'delete_project',projectId:'p'}],run);
  assert.deepEqual(state.projects,[]); assert.deepEqual(state.imports,[]);
  assert.equal(state.conversations.length,1);assert.equal(state.conversations[0],conversation);
  assert.equal(conversation.messages[0],message);assert.equal(run.approvalReceipt,receipt);
  assert.equal(state.agentRuns.find(row=>row.id==='run'),run);assert.equal(state.agentRuns.find(row=>row.id==='past'),oldRun);
  assert.equal(state.agentRuns.some(row=>row.id==='retire-run'),false);
  assert.equal(conversation.projectId,null);assert.equal(run.projectId,null);assert.equal(oldRun.projectId,null);
  assert.equal(run.expectedProjectTargets.length,0);assert.equal(run.projectIds.length,0);assert.equal(state.currentProjectId,null);
  assert.equal(conversation.attachments.length,0);assert.equal(run.results[0].operation,'deleted');
  assert.equal(state.trash[0].data.projects[0].id,'p');assert.equal(state.trash[0].data.conversations[0].id,'retire');
});

test('restoring a deleted project keeps a new user message and subsequent routing edits', () => {
  const original={projects:[{id:'p',name:'QA',workspace:'日常'}],conversations:[{id:'chat',projectId:'p',workspace:'日常',messages:[{id:'user',text:'Delete QA'}]}],agentRuns:[{id:'run',conversationId:'chat',projectId:'p'}],tasks:[],notes:[],papers:[],imports:[],attachments:[],links:[],trash:[]};
  const outcome=Lifecycle.remove(original,'p',{conversationId:'chat',runId:'run'}),state=outcome.state;
  state.conversations[0].messages.push({id:'followup',text:'Continue here'});state.projects.push(...outcome.entry.data.projects);
  Lifecycle.restoreRoutingMoves(state,outcome.entry);
  assert.equal(state.conversations[0].projectId,'p');assert.equal(state.conversations[0].messages.at(-1).text,'Continue here');
  const second=Lifecycle.remove(original,'p',{conversationId:'chat',runId:'run'});second.state.projects.push(...second.entry.data.projects);
  second.state.conversations[0].projectId='different';Lifecycle.restoreRoutingMoves(second.state,second.entry);
  assert.equal(second.state.conversations[0].projectId,'different');
});
