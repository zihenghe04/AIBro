const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const M = require('../app/project-memory');
const A = require('../app/agent-context');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const memoryStart = source.indexOf('    const projectMemoryContext = () => {');
const memoryEnd = source.indexOf("    let knowledgeEvidence =", memoryStart);
const inputStart = source.indexOf('    const buildRequestInput =', memoryEnd);
const inputEnd = source.indexOf('    const recoverInput=', inputStart);
assert.ok(memoryStart > 0 && memoryEnd > memoryStart && inputEnd > inputStart);
const host = new Function('initialState', 'ProjectMemory', 'AgentContext', 'onDemand', `
 let state=initialState;
 const run={projectId:'p',userMessageId:'u',contextWorkspace:'科研'};
 const readScope={projectId:'p',workspace:'科研',readProjects:[]};
 const window={ProjectMemory};
 const conversation={messages:[{id:'u',role:'user',text:'请查看现有资料'}]};
 let instruction='BASE RULES';
 ${source.slice(memoryStart, memoryEnd)}
 let knowledgeEvidence='', knowledgeBlocks=[], citationManifest='';
 const delivery={blocks:[]},context='REQUEST',demandContext='REQUEST';
 const agentContext=onDemand?AgentContext.create({fullInstruction:instruction,projectId:'p',workspace:'科研'}):null;
 ${source.slice(inputStart,inputEnd)}
 return {input:buildRequestInput,run,replace:value=>state=value,capability:name=>agentContext?.capability(name)};
`);
function fixture(){return {projects:[{id:'p',name:'Fictional research',workspace:'科研'}],notes:[
 {id:'l',projectId:'p',projectMemoryType:'long',content:'APPROVED_OLD',title:'Long',aiDraft:{content:'UNAPPROVED_DRAFT'}},
 {id:'plan',projectId:'p',projectMemoryType:'plan',content:'PLAN_CONTENT',title:'Plan'},
 {id:'day',projectId:'p',projectMemoryType:'daily',content:'QUESTION_ECHO',title:'Daily'},
 ],conversations:[],agentRuns:[],trash:[]};}
for (const onDemand of [false,true]){
 test(`actual ${onDemand?'on-demand':'full'} request builder separates memory and rebuilds it after edits`,()=>{
  const state=fixture(),before=JSON.stringify(state),h=host(state,M,A,onDemand);
  const first=h.input();
  assert.match(first,/APPROVED_OLD/);assert.match(first,/PLAN_CONTENT/);
  assert.doesNotMatch(first,/QUESTION_ECHO|UNAPPROVED_DRAFT/);
  assert.deepEqual(h.run.memoryContext.map(x=>x.id).sort(),['l','plan']);
  assert.equal(JSON.stringify(state),before);
  state.notes[0].content='APPROVED_NEW';
  assert.match(h.input(),/APPROVED_NEW/);assert.doesNotMatch(h.input(),/APPROVED_OLD/);
  state.notes[0].projectMemoryType='daily';
  assert.doesNotMatch(h.input(),/APPROVED_NEW/);
 });
 test(`actual ${onDemand?'on-demand':'full'} request builder drops revoked memory and follows state replacement`,()=>{
  const state=fixture(),h=host(state,M,A,onDemand);
  assert.match(h.input(),/APPROVED_OLD/);
  state.notes[0].private=true;
  assert.doesNotMatch(h.input(),/APPROVED_OLD/);
  const replacement=fixture();replacement.notes[0].content='REPLACED_STATE';h.replace(replacement);
  assert.match(h.input(),/REPLACED_STATE/);assert.doesNotMatch(h.input(),/APPROVED_OLD/);
  replacement.projects[0].private=true;
  assert.doesNotMatch(h.input(),/REPLACED_STATE|PLAN_CONTENT/);
 });
}
test('capability snapshots do not retain automatic memory after it becomes private',()=>{
 const state=fixture(),h=host(state,M,A,true);
 assert.match(h.input(),/APPROVED_OLD/);
 h.capability('research');state.notes[0].private=true;
 assert.doesNotMatch(h.input(),/APPROVED_OLD|QUESTION_ECHO|UNAPPROVED_DRAFT/);
});
test('memory-off host retains its ordinary prompt without injecting synthetic state',()=>{
 const h=host(fixture(),null,A,false);
 assert.match(h.input(),/REQUEST/);assert.equal(h.run.memoryContext,undefined);
});
test('memory capability retains proposal schema and quote rules without a data snapshot',()=>{
 const h=host(fixture(),M,A,true),instructions=h.capability('memory').instructions;
 assert.match(instructions,/memoryUpdates/);assert.match(instructions,/quote/);
 assert.doesNotMatch(instructions,/APPROVED_OLD|PLAN_CONTENT|QUESTION_ECHO|UNAPPROVED_DRAFT/);
});
const requestStart=source.indexOf('async function requestAgentPlan(options, run) {');
const requestEnd=source.indexOf('\nasync function sendMessage(',requestStart);
const requestHost=new Function('AgentTransport','window',source.slice(requestStart,requestEnd)+'\nreturn requestAgentPlan;');
for (const recovery of ['protocol','context']){
 test(`actual ${recovery} recovery blocks a new send with changed automatic memory`,async()=>{
  let memory='ORIGINAL',calls=0,recovered=0;
  const ask=requestHost({requestPlan:async options=>{
   calls++;assert.equal(options.currentMemory,undefined);
   if(calls===1){memory='NOW_PRIVATE';
    if(recovery==='protocol')throw Object.assign(Error('protocol'),{code:'MODEL_PROTOCOL_ERROR'});
    return options.recoverInput({input:options.input});
   }
   return 'unexpected retry';
  }},{});
  await assert.rejects(ask({input:'original prompt',currentMemory:()=>memory,recoverInput:()=>{recovered++;return {input:'reduced'};}},{}),{code:'KNOWLEDGE_SOURCE_CHANGED'});
  assert.equal(calls,1);assert.equal(recovered,0);
 });
 test(`actual ${recovery} recovery preserves allowed unchanged-memory recovery`,async()=>{
  let calls=0,recovered=0;
  const ask=requestHost({requestPlan:async options=>{
   calls++;assert.equal(options.currentMemory,undefined);
   if(calls===1){
    if(recovery==='protocol')throw Object.assign(Error('protocol'),{code:'MODEL_PROTOCOL_ERROR'});
    const next=await options.recoverInput({input:options.input});assert.equal(next.input,'reduced');return 'done';
   }
   assert.match(options.input,/JSON/);return 'done';
  }},{});
  assert.equal(await ask({input:'original prompt',currentMemory:()=> 'UNCHANGED',recoverInput:()=>{recovered++;return {input:'reduced'};}},{}),'done');
  assert.equal(calls,recovery==='protocol'?2:1);assert.equal(recovered,recovery==='context'?1:0);
 });
}
