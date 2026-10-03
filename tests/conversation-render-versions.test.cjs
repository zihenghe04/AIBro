'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const helper = source.slice(source.indexOf('function conversationRenderVersions('), source.indexOf('function renderConversation()'));
function fixture() {
  const message = { id:'m', role:'agent', runId:'r', text:'Answer [[cite:ev1]]' };
  const conversation = { id:'c', workspace:'科研', projectId:'p', messages:[message] };
  const state = { conversations:[conversation], agentRuns:[{id:'r',conversationId:'c',status:'completed',evidenceSources:[{id:'i',type:'import',sourceId:'ev1',provided:true}]}],
    projects:[{id:'p',name:'Research',workspace:'科研'}], imports:[{id:'i',name:'Source',content:'original',projectId:'p'}], notes:[],papers:[],tasks:[],trash:[],settings:{} };
  const env = { state, document:{documentElement:{lang:'zh'}}, sendMessage(){}, approveRun(){}, runCheckpointController:null,
    WorkstationI18n:{getLanguage:()=>env.document.documentElement.lang}, PrivateMode:{isOn:()=>false} };
  env.window=env;vm.createContext(env);vm.runInContext(helper,env);
  const snapshot = () => { const value=env.conversationRenderVersions(env.state.conversations[0]);return {context:value.contextVersion,row:value.rowVersion(message)}; };
  return {env,state,conversation,message,snapshot};
}
test('unchanged snapshots are stable; mutable answer/run changes are not hidden by object identity',()=>{
  const h=fixture(), before=h.snapshot();assert.equal(typeof before.row,'number');assert.deepEqual(h.snapshot(),before);
  h.message.text+=' Changed';assert.notEqual(h.snapshot().row,before.row);
  const next=h.snapshot();h.state.agentRuns[0].error='new error';assert.notEqual(h.snapshot().row,next.row);
});
test('replacing message/run/state invalidates callbacks even for equal serialized content',()=>{
  const h=fixture(),initial=h.snapshot();h.state.agentRuns[0]={...h.state.agentRuns[0]};assert.notEqual(h.snapshot().row,initial.row);
  const next=h.snapshot();h.env.state=structuredClone(h.state);assert.notEqual(h.snapshot().context,next.context);
  const versions=h.env.conversationRenderVersions(h.env.state.conversations[0]);assert.notEqual(versions.rowVersion(h.env.state.conversations[0].messages[0]),next.row);
});
test('permissions and owner ancestry, including retired duplicates, invalidate visible source rows',()=>{
  for(const mutate of [
    h=>h.state.imports[0].private=true,
    h=>h.state.projects[0].archived=true,
    h=>h.state.trash.push({data:{runs:[{id:'ancestor',private:true}]}}),
    h=>h.state.imports[0].provenance={origin:{runId:'ancestor',private:true}},
    h=>h.state.imports.push({...h.state.imports[0]}),
    h=>h.state.projects[0].localFolder={id:'rebound'},
  ]){const h=fixture(),before=h.snapshot();mutate(h);assert.notEqual(h.snapshot().context,before.context);}
});
test('closed source panels do not read large bodies; opened panels track same-version body changes',()=>{
  const h=fixture();let reads=0,value='original';Object.defineProperty(h.state.imports[0],'content',{enumerable:true,get(){reads++;return value;}});
  h.snapshot();assert.equal(reads,0);
  h.message.evidenceOpen=true;const before=h.snapshot();assert.ok(reads>0);value='changed without updatedAt';assert.notEqual(h.snapshot().row,before.row);
});
test('result/draft/file-review dependencies track complete current notes and note aliases',()=>{
  for(const attach of [h=>h.message.results=[{type:'note',id:'n'}],h=>h.message.draftReviewCandidates=['n'],h=>h.state.agentRuns[0].memoryNoteIds=['n'],h=>h.state.agentRuns[0].fileChanges=[{type:'note',id:'n',operation:'updated'}]]){
    const h=fixture();h.state.notes=[{id:'n',title:'Note',content:'Before',aiDraft:{content:'Proposal'}}];attach(h);const before=h.snapshot();
    h.state.notes[0].aiDraft.content='Changed';assert.notEqual(h.snapshot().row,before.row);
    const next=h.snapshot();h.state.notes[0].content='Manual edit';assert.notEqual(h.snapshot().row,next.row);
  }
  const h=fixture();h.message.results=[{type:'note',id:'old'}];h.state.notes=[{id:'new',mergedNoteIds:['old'],content:'A'}];const before=h.snapshot();h.state.notes[0].content='B';assert.notEqual(h.snapshot().row,before.row);
});
test('latest draft owner, result routes, language and estimated cost invalidate shared inputs',()=>{
  for(const mutate of [h=>h.conversation.messages.push({id:'later',results:[{type:'note',id:'n'}]}),h=>h.state.projects[0].name='Renamed',
    h=>h.state.settings.usagePrice={input:2},h=>h.env.document.documentElement.lang='en',h=>h.conversation.sessionAllows={write:true},h=>h.env.sendMessage.busy=true]){
    const h=fixture(),before=h.snapshot();mutate(h);assert.notEqual(h.snapshot().context,before.context);
  }
});
test('inline attachment bytes invalidate media while unrelated document bodies do not',()=>{
  const h=fixture();h.message.attachmentIds=['i'];h.state.imports[0].dataUrl='data:image/png;base64,AAA';const before=h.snapshot();
  h.state.imports[0].dataUrl='data:image/png;base64,BBB';assert.notEqual(h.snapshot().row,before.row);
  const next=h.snapshot();h.state.imports[0].content='Unrelated extraction';assert.deepEqual(h.snapshot(),next);
});
test('active time-dependent cards and unserializable inputs use conservative rendering',()=>{
  const h=fixture();h.message.live=true;assert.equal(h.snapshot().row,null);delete h.message.live;
  h.state.agentRuns[0].status='awaiting-approval';assert.equal(h.snapshot().row,null);h.state.agentRuns[0].status='completed';
  h.state.agentRuns[0].agendaProposals=[{id:'event'}];assert.equal(h.snapshot().row,null);delete h.state.agentRuns[0].agendaProposals;
  h.state.agentRuns[0].fileChanges=[{type:'note',id:'n',operation:'drafted'}];assert.equal(h.snapshot().row,null);delete h.state.agentRuns[0].fileChanges;
  h.message.circular=h.message;assert.equal(h.snapshot().row,null);delete h.message.circular;
  h.state.projects[0].localFolder=h.state.projects[0];assert.deepEqual(Object.keys(h.env.conversationRenderVersions(h.conversation)),[]);
});

test('nested same-object changes, additions, removals and array order cannot reuse a stale version',()=>{
  const h=fixture();h.message.attachments=[{id:'i',name:'before',metadata:{pages:[1,2],preview:{text:'old'}}}];
  h.state.agentRuns[0].toolCalls=[{name:'read_page',result:{blocks:[{text:'before'}]}}];
  const changes=[
    ()=>h.message.attachments[0].metadata.preview.text='new',
    ()=>h.message.attachments[0].metadata.pages.reverse(),
    ()=>h.message.attachments[0].metadata.extra={private:true},
    ()=>delete h.message.attachments[0].metadata.extra,
    ()=>h.state.agentRuns[0].toolCalls[0].result.blocks[0].text='after',
    ()=>h.state.agentRuns[0].toolCalls[0].result.blocks.push({text:'second'}),
    ()=>h.state.agentRuns[0].toolCalls[0].result.blocks.shift(),
    ()=>h.message.attachments[0].metadata.pages.length=0,
    ()=>h.message.model='deepseek-v4.1-flash',
    ()=>h.state.agentRuns[0].cache={readTokens:10},
    ()=>h.state.agentRuns[0].cache.readTokens=20,
    ()=>h.message.deletedAt=1,
  ];
  for(const change of changes){const before=h.snapshot().row;change();assert.notEqual(h.snapshot().row,before);}
});

test('shared references are supported but mutable objects never escape into retained snapshots',()=>{
  const h=fixture(),shared={nested:['old']};h.message.extra=shared;h.state.agentRuns[0].extra=shared;
  const before=h.snapshot();const retained=h.env.conversationRenderVersions.snapshots.rows.get('m').snapshot;
  const originals=new Set([h.message,h.state.agentRuns[0],shared,shared.nested]);
  function check(value){if(!value||typeof value!=='object')return;assert.ok(!originals.has(value));for(const entry of Object.values(value))check(entry);}
  check(retained);shared.nested[0]='new';assert.notEqual(h.snapshot().row,before.row);check(retained);
});

test('same-id conversation replacement, deletion and active or unsupported rows release prior snapshots',()=>{
  const h=fixture();h.snapshot();const first=h.env.conversationRenderVersions.snapshots;
  h.state.conversations[0]={...h.conversation,messages:[{...h.message,text:'new conversation'}]};
  const versions=h.env.conversationRenderVersions(h.state.conversations[0]);versions.rowVersion(h.state.conversations[0].messages[0]);
  assert.equal(first.rows.size,0);assert.notEqual(h.env.conversationRenderVersions.snapshots,first);
  const current=h.env.conversationRenderVersions.snapshots;h.state.conversations[0].messages[0].deletedAt=1;
  h.env.conversationRenderVersions(h.state.conversations[0]);assert.equal(current.rows.size,0);
  delete h.state.conversations[0].messages[0].deletedAt;versions.rowVersion(h.state.conversations[0].messages[0]);assert.equal(current.rows.size,1);
  h.state.conversations[0].messages[0].live=true;assert.equal(versions.rowVersion(h.state.conversations[0].messages[0]),null);assert.equal(current.rows.size,0);
  delete h.state.conversations[0].messages[0].live;versions.rowVersion(h.state.conversations[0].messages[0]);
  h.state.conversations[0].messages[0].bad=1n;assert.equal(versions.rowVersion(h.state.conversations[0].messages[0]),null);assert.equal(current.rows.size,0);
});

test('removing a completed run retires its large primitive values after the next refresh',()=>{
  const h=fixture(),oldText='Retired run '+ 'R'.repeat(500000);h.state.agentRuns[0].reasoningText=oldText;h.snapshot();
  h.state.agentRuns.length=0;h.snapshot();
  function contains(value){return value===oldText || (!!value&&typeof value==='object'&&Object.values(value).some(contains));}
  assert.equal(contains(h.env.conversationRenderVersions.snapshots.rows.get('m')?.snapshot),false);
});

test('plain rows compare content without serialized answers and switch external dependencies without stale versions',()=>{
  const h=fixture();h.state.agentRuns=[];const first=h.snapshot();assert.equal(typeof first.row,'number');assert.equal(h.env.conversationRenderVersions.snapshots.rows.size,1);
  h.message.text='A'.repeat(9000);const large=h.snapshot();assert.equal(typeof large.row,'number');assert.equal(h.env.conversationRenderVersions.snapshots.rows.size,1);
  h.message.text='Small again';const small=h.snapshot();assert.notEqual(small.row,large.row);assert.deepEqual(h.snapshot(),small);
  h.message.attachments=[{id:'inline',dataUrl:'data:image/png;base64,'+'A'.repeat(100000)}];const rich=h.snapshot();assert.notEqual(rich.row,small.row);
  delete h.message.attachments;assert.notEqual(h.snapshot().row,rich.row);assert.equal(h.env.conversationRenderVersions.snapshots.rows.get('m').plain,true);
});

test('plain-message in-place corrections and equal replacements invalidate only their stable row identities',()=>{
  const h=fixture();h.state.agentRuns=[];h.conversation.messages.push({id:'second',role:'user',text:'Unchanged'});
  const rows=()=>{const v=h.env.conversationRenderVersions(h.conversation);return h.conversation.messages.map(v.rowVersion);};
  let previous=rows();
  for(const change of [()=>h.message.text='Corrected',()=>h.message.modelConfig={model:'first'},()=>h.message.modelConfig.model='second',
    ()=>h.message.progressPins={a:true},()=>h.message.progressPins.a=false,()=>delete h.message.progressPins,
    ()=>h.conversation.messages[0]={...h.conversation.messages[0]}]){
    change();const next=rows();assert.notEqual(next[0],previous[0]);assert.equal(next[1],previous[1]);previous=next;
  }
});

test('long text and media remain primitive values, do not allocate a serialized full-body snapshot, and still invalidate',()=>{
  const h=fixture();h.message.text='Unique answer '+ 'A'.repeat(500000);h.message.attachmentIds=['i'];h.state.imports[0].dataUrl='data:image/png;base64,'+'B'.repeat(1000000);
  const before=h.snapshot(),initial=h.env.conversationRenderVersions.snapshots.rows.get('m');
  assert.deepEqual(h.snapshot(),before);assert.equal(h.env.conversationRenderVersions.snapshots.rows.get('m'),initial);
  let originalStrings=0;const visit=value=>{if(value===h.message.text||value===h.state.imports[0].dataUrl)originalStrings++;if(value&&typeof value==='object')for(const child of Object.values(value))visit(child);};visit(initial.snapshot);assert.equal(originalStrings,2);
  h.message.text=h.message.text.slice(0,-1)+'Z';assert.notEqual(h.snapshot().row,before.row);const next=h.snapshot();
  h.state.imports[0].dataUrl=h.state.imports[0].dataUrl.slice(0,-1)+'C';assert.notEqual(h.snapshot().row,next.row);
});

test('getters are read on every comparison; changing, throwing and cyclic values cannot hide a mutation',()=>{
  const h=fixture();let value='first',reads=0;Object.defineProperty(h.message,'dynamic',{enumerable:true,get(){reads++;if(value==='throw')throw Error('unavailable');return value;}});
  const first=h.snapshot();assert.equal(reads,1);h.snapshot();assert.equal(reads,2);value='second';assert.notEqual(h.snapshot().row,first.row);
  value='throw';assert.equal(h.snapshot().row,null);assert.equal(h.env.conversationRenderVersions.snapshots.rows.size,0);
  value='restored';const restored=h.snapshot();assert.equal(typeof restored.row,'number');assert.deepEqual(h.snapshot(),restored);
  h.message.cycle={parent:h.message};assert.equal(h.snapshot().row,null);assert.equal(h.env.conversationRenderVersions.snapshots.rows.size,0);
});

test('Date conversion remains current; excessive nesting and non-JSON values conservatively refresh',()=>{
  const h=fixture();h.message.date=new Date('2026-01-01T00:00:00Z');const first=h.snapshot();h.message.date.setUTCDate(2);assert.notEqual(h.snapshot().row,first.row);
  for(const value of [()=>1,Symbol('local'),1n]){h.message.unsupported=value;assert.equal(h.snapshot().row,null);}delete h.message.unsupported;
  h.message.deep={};let cursor=h.message.deep;for(let i=0;i<140;i++)cursor=cursor.child={};assert.equal(h.snapshot().row,null);
});

test('throwing alias and message-identity getters retire snapshots and conservatively invalidate the transcript',()=>{
  for(const target of ['alias','message']){
    const h=fixture();h.snapshot();
    if(target==='alias'){h.state.notes=[{id:'n'}];Object.defineProperty(h.state.notes[0],'mergedNoteIds',{get(){throw Error('unavailable');}});}
    else Object.defineProperty(h.message,'id',{get(){throw Error('unavailable');}});
    assert.deepEqual(Object.keys(h.env.conversationRenderVersions(h.conversation)),[]);assert.equal(h.env.conversationRenderVersions.snapshots.rows.size,0);
  }
});
