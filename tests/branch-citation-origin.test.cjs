const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const E = require('../app/citation-evidence.js');

function fixture() {
  const message = {id:'answer',role:'assistant',runId:'execution',text:'',usage:{total:12000}};
  const conversation = {id:'original',workspace:'科研',messages:[message]};
  const run = {id:'execution',conversationId:conversation.id,status:'completed',retrievalCoverage:{strategy:'hybrid-rrf',eligibleRecords:99}};
  const state = {conversations:[conversation],agentRuns:[run],imports:[{id:'paper',name:'Synthetic notes',content:'Observed only in this fictional example.'}],notes:[],projects:[]};
  const source = E.capture(run,{type:'import',id:'paper',title:'Synthetic notes',excerpt:'Observed only in this fictional example.'},state);
  message.text = `A qualified finding. [[cite:${source.sourceId}]]`;
  return {state,run,conversation,message,source};
}
function branch(f) {
  const source = fs.readFileSync(require.resolve('../app/app.js'),'utf8');
  const start = source.indexOf('function branchConversationFrom(');
  const end = source.indexOf('\n\n// 会话内分支',start);
  let current = f.conversation;
  const context = {state:f.state,window:{CitationEvidence:E},Date,uid:()=>`branch-${f.state.conversations.length}`,
    conversationPathSaving:()=>false,currentConversation:()=>current,save(){},toast(){},openConversation(id){current=f.state.conversations.find(c=>c.id===id)}};
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  const copied = context.branchConversationFrom(f.message.id);
  return {conversation:copied,message:copied.messages[0]};
}

test('actual fork retains citations without attaching the original execution to its progress',()=>{
  const f=fixture(),before=JSON.stringify(f.state),copy=branch(f);
  assert.equal(copy.message.runId,undefined);
  assert.equal(copy.message.steps,undefined);
  assert.equal(copy.message.usage,undefined);
  assert.equal(copy.message.citationOrigin.runId,f.run.id);
  assert.equal(E.sourcesFor(copy.message,null,f.state)[0].sourceId,f.source.sourceId);
  assert.equal(E.evidenceOutline(copy.message,null,f.state).sourceCount,1);
  const model=E.evidenceModel(copy.message,null,f.state);
  assert.equal(model.retrieval,null); assert.equal(model.attachments,null);
  assert.match(E.documentText(copy.message,null,f.state),/#aibro-source-/);
  assert.equal(JSON.stringify({...f.state,conversations:f.state.conversations.slice(0,1)}),before);
});
test('nested branch keeps the original attribution and survives serialization',()=>{
  const f=fixture(),first=branch(f);
  const origin=E.originForBranch(first.message,first.conversation,f.state);
  const copy=JSON.parse(JSON.stringify({...first.message,citationOrigin:origin}));
  assert.equal(E.runForCitations(copy,null,f.state),f.run);
  assert.equal(copy.citationOrigin.conversationId,'original');
});
test('legacy branches do not guess an origin from a duplicated message ID',()=>{
  const f=fixture();const copy={...f.message};delete copy.runId;
  f.state.conversations.push({id:'branch',messages:[copy]});
  assert.equal(E.runForCitations(copy,null,f.state),null);
  assert.match(E.documentText(copy,null,f.state),/引用不可用/);
});
test('stale or ambiguous ownership cannot recover a different run',()=>{
  for(const change of [f=>f.state.agentRuns.push({...f.run}),f=>f.state.conversations.push({...f.conversation}),f=>f.run.conversationId='elsewhere',f=>f.conversation.deletedAt=1,f=>f.state.agentRuns=[],f=>f.run.archived=true]){
    const f=fixture(),copy=branch(f).message;change(f);
    assert.equal(E.runForCitations(copy,null,f.state),null);
    assert.equal(E.sourcesFor(copy,null,f.state).filter(s=>s.provided).length,0);
  }
});
test('new execution and changed message identity cannot reuse inherited citations',()=>{
  for(const patch of [{runId:'new'},{pendingRunId:'new'},{retryRunId:'new'},{id:'other'},{live:true},{role:'user'}]){
    const f=fixture(),copy={...branch(f).message,...patch};
    assert.equal(E.runForCitations(copy,null,f.state),null);
  }
});
test('source privacy remains live, including original conversation and retired owners',()=>{
  for(const change of [f=>f.run.private=true,f=>f.conversation.private=true,f=>f.state.imports[0].private=true,f=>{f.state.conversations=[];f.state.trash=[{data:{conversations:[{...f.conversation,private:true}]}}]}]){
    const f=fixture(),copy=branch(f).message;
    copy.retrievedSources=[{type:'import',id:'paper',title:'Synthetic notes'}];change(f);
    const sources=E.sourcesFor(copy,null,f.state);
    assert.doesNotMatch(JSON.stringify(sources),/Synthetic notes|Observed only/);
    assert.doesNotMatch(E.documentText(copy,null,f.state),/#aibro-source-/);
  }
});
test('original document updates keep the old excerpt and report the change',()=>{
  const f=fixture(),copy=branch(f).message;f.state.imports[0].content='Newly corrected content.';
  const source=E.sourcesFor(copy,null,f.state)[0];
  assert.equal(source.excerpt,f.source.excerpt);assert.equal(E.status(source,f.state).kind,'changed');
});
