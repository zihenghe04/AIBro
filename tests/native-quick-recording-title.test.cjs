const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('native/Resources/quick-recording-title.js','utf8');
const copy=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {resolve,promise};};
const payload=(n=1,extra={})=>({action:'generate',id:'01234567-89ab-4cde-8fab-0123456789ab',requestId:'quick_recording_title_'+String(n).padStart(8,'0')+'-89ab-4cde-8fab-0123456789ab',fingerprint:'a'.repeat(64),text:'Fictional seminar on observation methods. Compare route notes and a diagram.',...extra});
function fixture(options={}) {
 const calls={config:[],model:[],credentials:0};
 const context={storageHydrated:true,state:{notes:[],ui:{}},serverConflict:false,purgeTrash:{},AbortController,
  setTimeout:options.timer||setTimeout,clearTimeout,setInterval,clearInterval,
  defaultModelConfiguration:()=>({provider:'api',model:'deepseek-v4.1-flash'}),
  captureApiConnection:()=>({base:'https://example.invalid',protocol:'chat',token:'fixture'}),
  getApiConnection:async()=>{calls.credentials++;return options.credentials?options.credentials(context):{base:'https://example.invalid',token:'fixture'};},
  window:{PrivateMode:{isOn:()=>false},ConversationModels:{resolve:async config=>{calls.config.push(config);return options.config?options.config(context,config):config;}},
   AgentTransport:{requestPlan:async request=>{calls.model.push(request);return options.model?options.model(context,request):'{"title":"Observation methods seminar","category":"Course"}';}}}};
 vm.runInNewContext(source,context);return {context,calls,request:value=>context.window.NativeQuickRecordingTitle.request(value)};
}
test('read-only full transcript uses global configured model and exact native lease; duplicate is one request',async()=>{
 const gate=deferred(),start=deferred(),f=fixture({model:async()=>{start.resolve();await gate.promise;return '{"title":"Study methods","category":"Course"}';}}),p=payload(1,{text:'Fictional transcript '.repeat(2000)}),before=copy(f.context.state);
 const first=f.request(p),second=f.request(copy(p));assert.equal(first,second);await start.promise;
 assert.equal(f.calls.model.length,1);assert.equal(JSON.parse(f.calls.model[0].input[1].content).transcript,p.text);
 assert.equal(f.calls.model[0].model,'deepseek-v4.1-flash');assert.equal(f.calls.model[0].webSearch,false);assert.equal(f.calls.model[0].recoverInput,undefined);
 assert.deepEqual(copy(f.calls.config),[{provider:'api',model:'deepseek-v4.1-flash'}]);
 assert.equal((await f.request(payload(2))).reason,'busy');gate.resolve();const result=await first;
 assert.equal(result.status,'generated');assert.equal(result.fingerprint,p.fingerprint);assert.equal(result.id,p.id);assert.equal(result.requestId,p.requestId);assert.deepEqual(f.context.state,before);
 assert.ok(!JSON.stringify(result).includes('fixture'));
});
test('no transcript, malformed identity, extra fields and oversized full text never access credentials',async()=>{
 const f=fixture();for(const p of [payload(1,{text:''}),payload(2,{text:' '}),payload(3,{text:'x'.repeat(200001)}),payload(4,{fingerprint:'wrong'}),payload(5,{audio:'/private/audio.m4a'}),payload(6,{id:'x'})]) assert.equal((await f.request(p)).reason,'invalid');
 assert.equal(f.calls.credentials,0);assert.equal(f.calls.model.length,0);
});
test('private or workspace replacement during config prevents transcript request',async()=>{
 for(const mutate of [c=>c.window.PrivateMode.isOn=()=>true,c=>c.state=copy(c.state),c=>c.storageHydrated=false,c=>c.serverConflict=true]) {
  const f=fixture({config:(c,config)=>{mutate(c);return config;}});assert.notEqual((await f.request(payload())).status,'generated');assert.equal(f.calls.model.length,0);
 }
});
test('stop aborts pending output and queued request; late model cannot return candidate',async()=>{
 const start=deferred(),gate=deferred(),f=fixture({model:async(c,r)=>{start.resolve(r);return gate.promise;}}),p=payload();const pending=f.request(p),request=await start.promise;
 assert.equal((await f.request({action:'cancel',requestId:p.requestId})).status,'cancelled');assert.equal((await pending).reason,'cancelled');assert.equal(request.signal.aborted,true);
 gate.resolve('{"title":"Late title","category":"Late"}');const p2=payload(2);await f.request({action:'cancel',requestId:p2.requestId});assert.equal((await f.request(p2)).reason,'cancelled');assert.equal(f.calls.model.length,1);
});
test('privacy watchdog aborts a hanging transport',async()=>{
 const start=deferred(),f=fixture({model:()=>{start.resolve();return new Promise(()=>{});}}),pending=f.request(payload());await start.promise;f.context.window.PrivateMode.isOn=()=>true;
 assert.equal((await pending).reason,'cancelled');
});
test('timeout includes credentials and remains distinct from user cancellation',async()=>{
 const f=fixture({credentials:()=>new Promise(()=>{}),timer:(fn,ms)=>setTimeout(fn,ms===30000?5:ms)});assert.equal((await f.request(payload())).reason,'timeout');assert.equal(f.calls.model.length,0);
 const g=fixture({model:()=>{throw Object.assign(Error(),{code:'CONTEXT_LENGTH_EXCEEDED'});}});assert.equal((await g.request(payload())).reason,'context_length');
});
test('strict metadata schema rejects instructions, Markdown and malformed fields',async()=>{
 for(const response of ['plain title','{}','{"title":"Fine","category":""}','{"title":"Bad\\nline","category":"Course"}',JSON.stringify({title:'字'.repeat(81),category:'Course'}),JSON.stringify({title:'Fine',category:'字'.repeat(41)}),'```json\n{"title":"Fine","category":"Course"}\n```','{"title":"Fine","category":"Course","action":"delete"}','{"title":12,"category":"Course"}']) {
  const f=fixture({model:()=>response});assert.equal((await f.request(payload())).reason,'invalid_response');
 }
});
test('post-model privacy/state revocation discards output, missing config returns actionable reason',async()=>{
 for(const mutate of [c=>c.window.PrivateMode.isOn=()=>true,c=>c.state=copy(c.state)]) {const f=fixture({model:c=>{mutate(c);return '{"title":"Fine","category":"Course"}';}});assert.notEqual((await f.request(payload())).status,'generated');}
 const f=fixture({credentials:()=>({base:'https://example.invalid',token:''})});assert.equal((await f.request(payload())).reason,'not_configured');assert.equal(f.calls.model.length,0);
});
