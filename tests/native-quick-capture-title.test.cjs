const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const CaptureNotes = require('../app/capture-notes.js'), CitationEvidence = require('../app/citation-evidence.js');
const source = fs.readFileSync('native/Resources/quick-capture.js','utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done=>resolve=done); return {resolve,promise}; };
const requestID = n => 'quick_capture_title_' + String(n).padStart(8,'0') + '-89ab-4cde-8fab-0123456789ab';
function fixture(options = {}) {
  const calls = {model:[],config:[],credentials:0,persist:0,write:0};
  const state = options.state || {notes:[{id:'capture-1',kind:'随记',title:'Study notes',titleSource:'content',content:'Study notes\nSynthetic comparison of sample A and B.',tags:['fixture'],createdAt:1,updatedAt:10,projectId:'project-1',workspace:'科研',sourceAttachmentIds:[]}],projects:[{id:'project-1',workspace:'科研'}],imports:[],tasks:[],trash:[],links:[],ui:{}};
  const context = {state,storageHydrated:true,serverConflict:false,purgeTrash:{},TextEncoder,AbortController,setTimeout:options.timer || setTimeout,clearTimeout,setInterval,clearInterval,
    document:{body:{dataset:{view:'project'}},dispatchEvent(){}},CustomEvent:class {constructor(type,options){Object.assign(this,{type,...options});}},
    captureApiConnection:()=>({base:'https://example.invalid',token:'synthetic-key',protocol:'chat'}),
    resolveRunModel:(chat,scope)=>{calls.config.push({chat,scope});return {provider:'api',model:'fixture-model'};},
    getApiConnection:async()=>{calls.credentials++;return options.credentials?options.credentials(context):{base:'https://example.invalid',token:'synthetic-key'};},
    saveDocumentDurably:async()=>{calls.persist++;return options.persist?options.persist(context):true;},
    window:{crypto:webcrypto,PrivateMode:{isOn:()=>false},CitationEvidence,CaptureNotes:{...CaptureNotes,write(...args){calls.write++;return CaptureNotes.write(...args);}},
      ConversationModels:{resolve:async config=>options.config?options.config(context,config):config},
      AgentTransport:{requestPlan:async request=>{calls.model.push(request);return options.model?options.model(context,request):'{"title":"Comparing synthetic samples"}';}}}};
  vm.runInNewContext(source,context);
  const api = value=>context.window.NativeQuickCapture.library(value);
  const payload = async (n=1,changes={}) => {const read=await api({action:'get',id:'capture-1'});return {action:'title-generate',id:'capture-1',requestId:requestID(n),expectedVersion:10,expectedRecordVersion:read.note.recordVersion,text:state.notes[0].content,...changes};};
  return {context,calls,api,payload,get state(){return context.state;}};
}

test('explicit title generation sends whole draft through scoped configured transport, returns only candidate, deduplicates in-flight request',async()=>{
  const gate=deferred(),started=deferred(),f=fixture({model:async(_,request)=>{started.resolve();await gate.promise;return '{"title":"Comparison study"}';}});
  const request=await f.payload(1,{text:'Synthetic '.repeat(1800)}),before=copy(f.state);
  const first=f.api(request),duplicate=f.api(copy(request));assert.equal(first,duplicate);await started.promise;
  assert.equal(f.calls.model.length,1);assert.equal(JSON.parse(f.calls.model[0].input[1].content).note,request.text);
  assert.deepEqual(copy(f.calls.config),[{chat:null,scope:{projectId:'project-1',workspace:'科研'}}]);
  assert.equal(f.calls.model[0].webSearch,false);assert.equal(f.calls.model[0].protocol,'chat');
  gate.resolve();const reply=await first;assert.equal(reply.status,'generated');assert.equal(reply.title,'Comparison study');
  assert.equal(reply.model,'fixture-model');assert.deepEqual(f.state,before);assert.equal(f.calls.persist,0);
  assert.ok(!JSON.stringify(reply).includes('synthetic-key'));
});
test('opening or refreshing never generates and manual titles win before model/credential access',async()=>{
  const f=fixture();await f.api({action:'list',query:'',offset:0});await f.api({action:'get',id:'capture-1'});assert.equal(f.calls.model.length,0);
  f.state.notes[0].titleSource='user';const reply=await f.api(await f.payload());assert.equal(reply.reason,'manual_title');assert.equal(f.calls.credentials,0);
  delete f.state.notes[0].titleSource;f.state.notes[0].title='Legacy independently named note';assert.equal((await f.api(await f.payload())).reason,'manual_title');
});
test('full-record CAS catches same-timestamp change; config wait rechecks record and permission before sending body',async()=>{
  const first=fixture(),p=await first.payload();first.state.notes[0].tags=['changed'];assert.equal((await first.api(p)).reason,'changed');assert.equal(first.calls.model.length,0);
  for(const mutate of [c=>c.state.notes[0].content='new body',c=>c.state.notes[0].titleSource='user',c=>c.state.projects[0].private=true,c=>c.window.PrivateMode.isOn=()=>true,c=>c.state=copy(c.state)]) {
    const f=fixture({config:(context,config)=>{mutate(context);return config;}});assert.notEqual((await f.api(await f.payload())).status,'generated');assert.equal(f.calls.model.length,0);
  }
});
test('cancel aborts pending transport, ignores late output and cancels a queued request before it starts',async()=>{
  const started=deferred(),f=fixture({model:(_,request)=>{started.resolve(request);return new Promise(()=>{});}}),p=await f.payload();
  const pending=f.api(p),request=await started.promise;assert.equal((await f.api({action:'title-cancel',requestId:p.requestId})).status,'cancelled');
  assert.equal((await pending).reason,'cancelled');assert.equal(request.signal.aborted,true);
  const next=await f.payload(2);await f.api({action:'title-cancel',requestId:next.requestId});assert.equal((await f.api(next)).reason,'cancelled');assert.equal(f.calls.model.length,1);
});
test('private transition aborts hanging request with no title returned or write',async()=>{
  const started=deferred(),f=fixture({model:()=>{started.resolve();return new Promise(()=>{});}});
  const pending=f.api(await f.payload());await started.promise;f.context.window.PrivateMode.isOn=()=>true;
  const reply=await pending;assert.equal(reply.reason,'cancelled');assert.equal(reply.title,undefined);assert.equal(f.calls.write,0);
});
test('all pending phases have timeout, with no silent truncation/context recovery',async()=>{
  const f=fixture({credentials:()=>new Promise(()=>{}),timer:(fn,ms)=>setTimeout(fn,ms===30000?5:ms)});
  assert.equal((await f.api(await f.payload())).reason,'timeout');assert.equal(f.calls.model.length,0);
  const g=fixture({model:()=>{throw Object.assign(Error('capacity'),{code:'CONTEXT_LENGTH_EXCEEDED'});}});
  assert.equal((await g.api(await g.payload())).reason,'context_length');assert.equal(g.calls.model[0].recoverInput,undefined);
  assert.equal((await g.api(await g.payload(2,{text:'x'.repeat(200001)}))).reason,'invalid');assert.equal(g.calls.model.length,1);
});
test('late deletion/manual title/private/source replacement cannot return a candidate',async()=>{
  for(const mutate of [c=>c.state.notes.splice(0),c=>c.state.notes[0].title='human name',c=>c.state.notes[0].private=true,c=>c.state=copy(c.state)]) {
    const f=fixture({model:c=>{mutate(c);return '{"title":"Obsolete title"}';}});assert.notEqual((await f.api(await f.payload())).status,'generated');assert.equal(f.calls.persist,0);
  }
});
test('strict output rejects empty, multiline, oversized, instruction envelopes and malformed responses',async()=>{
  for(const response of ['', 'A plain title', '{}', '{"title":""}', '{"title":"two\\nlines"}', JSON.stringify({title:'字'.repeat(81)}),'{"title":"Fine","actions":["delete"]}','{"title":12}']) {
    const f=fixture({model:()=>response});assert.equal((await f.api(await f.payload())).reason,'invalid_response');assert.equal(f.calls.write,0);
  }
});
const editPayload = (p,title='Comparison study')=>({action:'update',requestId:'quick_capture_edit_01234567-89ab-4cde-8fab-0123456789ab',id:p.id,expectedVersion:p.expectedVersion,expectedRecordVersion:p.expectedRecordVersion,text:p.text,tags:['fixture'],title,titleSource:'model'});
test('reviewed model title uses existing durable write/receipt and preserves full original body/attachments',async()=>{
  const f=fixture(),p=await f.payload(),before=copy(f.state.notes[0]),payload=editPayload(p);
  const reply=await f.api(payload);assert.equal(reply.status,'saved');assert.equal(reply.note.titleSource,'model');assert.equal(f.calls.write,1);
  assert.equal(f.state.notes[0].content,before.content);assert.deepEqual(f.state.notes[0].sourceAttachmentIds,before.sourceAttachmentIds);
  assert.equal(f.state.notes[0].revisionHistory[0].title,before.title);
  const saved=f.state.notes[0];CaptureNotes.write(f.state,{id:saved.id,version:saved.updatedAt,text:'Changed body',tags:[]});assert.equal(saved.title,payload.title);assert.equal(saved.titleSource,'model');
});
test('generated save strong CAS and human title protection; failed persistence retries same exact title once',async()=>{
  for(const mutate of [f=>f.state.notes[0].content='same time different body',f=>f.state.notes[0].titleSource='user',f=>f.state.notes[0].tags=['different']]) {
    const f=fixture(),p=await f.payload();mutate(f);assert.equal((await f.api(editPayload(p))).reason,'changed');assert.equal(f.calls.write,0);
  }
  let retained;const f=fixture({persist:c=>{retained=copy(c.state);throw Error('lost ACK');}}),p=await f.payload(),request=editPayload(p);
  assert.equal((await f.api(request)).reason,'storage_failed');const resumed=fixture({state:retained});assert.equal((await resumed.api(request)).status,'saved');assert.equal(resumed.calls.write,0);
  resumed.state.notes[0].title='Later human title';assert.equal((await resumed.api(request)).reason,'changed');
});
test('missing model configuration gives actionable status without attempting transport',async()=>{
  const f=fixture({credentials:()=>({base:'https://example.invalid',token:''})});assert.equal((await f.api(await f.payload())).reason,'not_configured');assert.equal(f.calls.model.length,0);
});
