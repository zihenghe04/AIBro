'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const V=require('../app/vector-index'),R=require('../app/context-retrieval');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function fixture(options={}){
  const cfg=V.configuration({base:'https://fixture.invalid/v1',model:'synthetic',enabled:true,noKey:false,...options.config});
  const nodes=new Map(),calls=[],requests=[],stored=new Map([['aibro-embedding-settings-v1',JSON.stringify(cfg)]]),mounts=[];
  function element(id=''){
    const el={id,textContent:'',value:'',checked:false,hidden:false,disabled:false,append(child){nodes.set(child.id,child);},querySelectorAll(){return [];},addEventListener(){}};
    Object.defineProperty(el,'innerHTML',{set(html){for(const match of html.matchAll(/\bid="([^"]+)"/g))nodes.set(match[1],element(match[1]));}});return el;
  }
  nodes.set('settings',element('settings'));
  let credential={hasKey:true,verified:true,available:true,storage:'encrypted-file',base:cfg.base,...options.credential};
  const bridge={storageBackend:'encrypted-file',status:async()=>{calls.push('status');return options.status?options.status():credential;},read:async()=>{calls.push('read');if(options.read) return options.read();if(options.readError)throw Error(options.readError);return {base:cfg.base,token:'saved-fixture-token'};},save:async value=>{calls.push('save');if(options.save)await options.save(value);credential={hasKey:true,available:true,storage:'encrypted-file',base:value.base};},remove:async()=>{calls.push('remove');if(options.remove)await options.remove();credential={hasKey:false};}};
  const state={notes:[{id:'n',title:'Cedar',content:'Spaced practice and active recall.'}]};
  const items=await V.snapshot(state),rows=items.map(item=>({id:item.id,hash:item.hash,vector:[1,0]}));
  const ctx={document:{getElementById:id=>nodes.get(id),createElement:()=>element()},localStorage:{getItem:key=>stored.get(key),setItem:(key,val)=>stored.set(key,val)},VectorIndex:V,ContextRetrieval:R,
    workstationDesktop:{embeddingCredentials:bridge,vectorIndex:{load:async()=>rows,write:async()=>{}}},AbortController,setTimeout,clearTimeout,
    HalaskaUI:{mount(host,name,props){mounts.push(name);host.textContent=props.children;return {update(next){if('children'in next)host.textContent=next.children;}};}},
    fetch:async(url,request)=>{requests.push({url,...request});return options.fetch?options.fetch(request):{ok:true,json:async()=>({data:[{index:0,embedding:[1,0]}]})};}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../app/vector-knowledge-ui'),'utf8'),ctx);
  ctx.VectorKnowledge.init({getState:()=>state,isBusy:()=>false});await ctx.VectorKnowledge.refresh();await turn();
  return {cfg,nodes,calls,requests,stored,mounts,api:ctx.VectorKnowledge,health:()=>nodes.get('embeddingReadiness').textContent,click:async id=>{nodes.get(id).onclick();await turn();},search:()=>ctx.VectorKnowledge.searchRequest(state,{}, {type:'search',query:'Cedar'})};
}

test('opening legacy settings reports unmigrated credentials without reading keys or invoking the provider',async()=>{
  const f=await fixture({credential:{available:false,verified:false,legacyLocked:true,needsReentry:true}});
  assert.match(f.health(),/尚未迁移/);assert.deepEqual(f.calls,['status']);assert.equal(f.requests.length,0);
  assert.match(f.nodes.get('embeddingCounts').textContent,/本机已索引段落 1 \/ 1/);assert.deepEqual(f.mounts,['Text']);
});
test('readable local ciphertext does not claim a successful service request',async()=>{
  const f=await fixture();assert.match(f.health(),/服务连接尚未验证/);assert.equal(f.requests.length,0);
});
test('missing, unreadable and endpoint-mismatched credentials remain distinct',async()=>{
  for(const [credential,expected] of [[{hasKey:false},/尚未保存/],[{storage:'unavailable'},/无法读取/],[{base:'https://different.invalid/v1'},/地址不匹配/]]){
    const f=await fixture({credential});assert.match(f.health(),expected);assert.equal(f.requests.length,0);
  }
});
test('a failed semantic request explicitly falls back despite a complete local index',async()=>{
  const f=await fixture({fetch:()=>({ok:false,status:401})}),result=await f.search();
  assert.equal(result.semanticStatus,'unavailable');assert.equal(result.strategy,'local-bm25');
  assert.match(f.health(),/语义检索暂不可用/);assert.match(f.nodes.get('embeddingCounts').textContent,/1 \/ 1/);
});
test('a successful request with the saved key establishes service health',async()=>{
  const f=await fixture();await f.click('embeddingTest');assert.match(f.health(),/最近一次 Embedding 请求成功/);
  assert.equal(f.requests[0].headers.Authorization,'Bearer saved-fixture-token');assert.equal(f.stored.size,1);
});
test('testing an unsaved key does not lend it to a concurrent retrieval or mark saved credentials usable',async()=>{
  const waiting=deferred();let requestNo=0;
  const f=await fixture({credential:{needsReentry:true},fetch:()=>++requestNo===1?waiting.promise:{ok:true,json:async()=>({data:[{index:0,embedding:[1,0]}]})}});
  f.nodes.get('embeddingKey').value='unsaved-fixture-token';await f.click('embeddingTest');
  assert.match(f.health(),/尚未迁移/);assert.equal(f.requests[0].headers.Authorization,'Bearer unsaved-fixture-token');
  await f.search();assert.equal(f.requests[1].headers.Authorization,'Bearer saved-fixture-token');
  waiting.resolve({ok:true,json:async()=>({data:[{index:0,embedding:[1,0]}]})});await turn();
  assert.equal(f.nodes.get('embeddingKey').value,'unsaved-fixture-token');assert.match(f.nodes.get('embeddingStatus').textContent,/未保存的 Key/);
  assert.ok([...f.stored.values()].every(value=>!value.includes('fixture-token')));
});
test('a successful draft-only test leaves missing saved credentials unresolved',async()=>{
  const f=await fixture({credential:{hasKey:false}});f.nodes.get('embeddingKey').value='unsaved-fixture-token';await f.click('embeddingTest');
  assert.match(f.nodes.get('embeddingStatus').textContent,/连接成功/);assert.match(f.health(),/尚未保存/);
});
test('no-key services do not touch the native credential store',async()=>{
  const f=await fixture({config:{noKey:true}});assert.deepEqual(f.calls,[]);await f.search();assert.deepEqual(f.calls,[]);assert.equal(f.requests[0].headers.Authorization,undefined);
});
test('late status cannot overwrite a newly saved configuration',async()=>{
  const old=deferred();let n=0;
  const f=await fixture({status:()=>++n===1?old.promise:({hasKey:true,base:'https://new.invalid/v1',storage:'encrypted-file'})});
  f.nodes.get('embeddingBase').value='https://new.invalid/v1';f.nodes.get('embeddingKey').value='new-fixture';await f.click('embeddingSave');
  old.resolve({hasKey:true,needsReentry:true});await turn();assert.doesNotMatch(f.health(),/尚未迁移/);assert.match(f.health(),/尚未验证/);
});
test('testing a different unsaved model does not clear a saved-service failure',async()=>{
  let n=0;const f=await fixture({fetch:()=>++n===1?{ok:false,status:401}:{ok:true,json:async()=>({data:[{index:0,embedding:[1,0]}]})}});
  await f.search();f.nodes.get('embeddingModel').value='different-model';await f.click('embeddingTest');
  assert.match(f.health(),/暂不可用/);assert.match(f.nodes.get('embeddingStatus').textContent,/连接成功/);
});
test('a no-key connection test never transmits leftover key input',async()=>{
  const f=await fixture({config:{noKey:true}});f.nodes.get('embeddingKey').value='leftover-fixture';await f.click('embeddingTest');
  assert.equal(f.requests[0].headers.Authorization,undefined);assert.deepEqual(f.calls,[]);
  assert.doesNotMatch(f.nodes.get('embeddingStatus').textContent,/未保存的 Key/);
});
test('a pending old query cannot overwrite a newly saved key at the same endpoint',async()=>{
  const old=deferred(),f=await fixture({fetch:()=>old.promise});const query=f.search();await turn();
  f.nodes.get('embeddingKey').value='replacement-fixture';await f.click('embeddingSave');
  old.resolve({ok:false,status:401});const result=await query;
  assert.equal(result.semanticStatus,'unavailable');assert.match(f.health(),/尚未验证/);
  assert.match(f.nodes.get('embeddingStatus').textContent,/配置已保存/);
});

test('credential read boundary: removed or empty saved keys never send an anonymous provider request',async()=>{
  for(const record of [{base:'https://fixture.invalid/v1',token:''},{base:'https://fixture.invalid/v1',token:'   '},null]){
    const f=await fixture({read:async()=>record}),result=await f.search();
    assert.equal(f.requests.length,0);assert.equal(result.strategy,'local-bm25');
    assert.equal(result.coverage.semanticErrorCode,'CREDENTIAL_KEY_MISSING');
    assert.match(f.nodes.get('embeddingStatus').textContent,/请保存 embedding API Key/);
  }
});
test('credential read boundary: native legacy refusal remains distinct without migration, retry or provider request',async()=>{
  const f=await fixture({credential:{needsReentry:true},read:async()=>{throw Object.assign(Error('旧 Key 无法静默读取，请重新保存。'),{code:'CREDENTIAL_REENTRY_REQUIRED'});}}),result=await f.search();
  assert.equal(f.requests.length,0);assert.equal(result.coverage.semanticErrorCode,'CREDENTIAL_REENTRY_REQUIRED');
  assert.equal(f.calls.filter(x=>x==='read').length,1);assert.match(f.nodes.get('embeddingStatus').textContent,/旧 Key 无法静默读取/);
});
test('credential read boundary: a changed configuration invalidates a late old key before any provider request',async()=>{
  const waiting=deferred(),f=await fixture({read:()=>waiting.promise});
  const query=f.search();await turn();
  f.nodes.get('embeddingBase').value='https://new.invalid/v1';f.nodes.get('embeddingKey').value='replacement-fixture';await f.click('embeddingSave');
  waiting.resolve({base:f.cfg.base,token:'late-old-fixture'});
  await assert.rejects(query,e=>e.code==='CANCELLED');assert.equal(f.requests.length,0);
  assert.match(f.nodes.get('embeddingStatus').textContent,/配置已保存/);
});
test('credential read boundary: pending and completed explicit deletion revoke late reads before network',async()=>{
  for(const pending of [true,false]){
    const waiting=deferred(),removal=deferred(),f=await fixture({read:()=>waiting.promise,remove:pending?()=>removal.promise:undefined});
    const query=f.search();await turn();await f.click('embeddingClearKey');
    waiting.resolve({base:f.cfg.base,token:'late-old-fixture'});
    await assert.rejects(query,e=>e.code==='CANCELLED');assert.equal(f.requests.length,0);
    removal.resolve();await turn();assert.match(f.nodes.get('embeddingStatus').textContent,/已删除/);
  }
});
test('credential read boundary: mutation while status waits does not begin a credential read',async()=>{
  const status=deferred();let calls=0;
  const f=await fixture({status:()=>++calls===1?{hasKey:true}:status.promise});
  const query=f.search();await turn();await f.click('embeddingClearKey');
  status.resolve({hasKey:true});await assert.rejects(query,e=>e.code==='CANCELLED');
  assert.equal(f.calls.filter(x=>x==='read').length,0);assert.equal(f.requests.length,0);
});
