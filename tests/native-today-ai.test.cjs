const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
// Only a fake model service: no real request is ever made.
function fixture({request,role={kind:'api',model:'fake-model',base:'local-fixture',effort:'',configuredProtocol:'chat'},credentials={base:'local-fixture',token:'synthetic'},hydrated=true}={}){
  const files=new Map(),calls=[],writes=[];
  const digest={date:'2026-11-24',counts:{events:1}};
  const env={window:{},storageHydrated:hydrated,AbortController,setTimeout,clearTimeout,state:{settings:{}},
    ConversationModels:{resolve:async x=>x},
    credentialsForBase:async()=>credentials,
    AgentTransport:{requestPlan:async x=>{calls.push(x);return request(x)}},
    fetch:async(url,init={})=>{
      if(init.method==='POST'){const body=JSON.parse(init.body);writes.push(body);files.set(body.date,{...body.brief,date:body.date,savedAt:1});return {ok:true,json:async()=>({brief:files.get(body.date)})};}
      const date=new URL(url,'http://x').searchParams.get('date');return {ok:true,json:async()=>({brief:files.get(date)||null})};
    }};
  env.window.Connections={resolveRole:()=>role};
  env.window.AIBroTodayPlugin={brief:async()=>{files.set(digest.date,{version:1,source:'rules',digest,lines:['日程 1'],date:digest.date,savedAt:1});return {date:digest.date}}};
  vm.runInNewContext(fs.readFileSync('native/Resources/today-ai.js','utf8'),env);
  return {api:env.window.NativeTodayAI,calls,files,writes};
}
test('model success writes the AI paragraph back and keeps the structure',async()=>{
  const f=fixture({request:()=>'今天有 1 项日程。'});
  const out=await f.api.compose();
  assert.equal(out.ok,true);
  const saved=f.files.get('2026-11-24');
  assert.equal(saved.source,'ai');assert.equal(saved.text,'今天有 1 项日程。');assert.equal(saved.lines[0],'日程 1');assert.equal(saved.model,'fake-model');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].webSearch,false);assert.equal(f.calls[0].model,'fake-model');
});
test('model error keeps the rules brief and returns a notice',async()=>{
  const f=fixture({request:()=>{throw Error('boom')}});
  const out=await f.api.compose();
  assert.equal(out.ok,false);assert.ok(out.notice.zh&&out.notice.en);
  assert.equal(f.files.get('2026-11-24').source,'rules');assert.equal(f.files.get('2026-11-24').text,undefined);
});
test('timeout aborts the request and keeps the rules brief',async()=>{
  const f=fixture({request:x=>new Promise((_,reject)=>x.signal.addEventListener('abort',()=>reject(Error('aborted'))))});
  const out=await f.api.compose({timeoutMs:20});
  assert.equal(out.code,'timeout');assert.equal(f.files.get('2026-11-24').source,'rules');
});
test('offline or missing model/key never calls the model',async()=>{
  for(const opts of [{role:null},{credentials:{}},{role:{kind:'api',model:'',base:'b'}}]){
    const f=fixture({request:()=>'x',...opts});
    const out=await f.api.compose();
    assert.equal(out.code,'no-model');assert.equal(f.calls.length,0);assert.equal(f.files.get('2026-11-24').source,'rules');
  }
});
test('empty reply is not saved as AI text; unhydrated workspace does nothing',async()=>{
  const f=fixture({request:()=>'  '});
  assert.equal((await f.api.compose()).code,'empty');assert.equal(f.files.get('2026-11-24').source,'rules');
  const g=fixture({request:()=>'x',hydrated:false});
  assert.equal((await g.api.compose()).code,'not-ready');assert.equal(g.files.size,0);
});
test('overlapping compose is rejected',async()=>{
  let release;const f=fixture({request:()=>new Promise(r=>{release=r})});
  const first=f.api.compose();await new Promise(r=>setTimeout(r,10));
  assert.equal((await f.api.compose()).code,'busy');release('ok');assert.equal((await first).ok,true);
});
