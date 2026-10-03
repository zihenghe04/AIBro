'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const V=require('../app/vector-index'),R=require('../app/context-retrieval');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

// Actual Agent/settings wrapper + production vector engine, isolated storage,
// fake provider only. No UI session, user workspace or credential is opened.
async function fixture({fetch,credentials,deadline=30}={}) {
  const nodes=new Map(),requests=[];
  const element=(id='')=>{
    const node={id,value:'',checked:false,hidden:false,disabled:false,textContent:'',append(child){nodes.set(child.id,child);},querySelectorAll(){return [];},addEventListener(){}};
    Object.defineProperty(node,'innerHTML',{set(html){for(const m of html.matchAll(/\bid="([^"]+)"/g))nodes.set(m[1],element(m[1]));}});return node;
  };
  nodes.set('settings',element('settings'));
  const state={projects:[{id:'p',name:'Synthetic transport',workspace:'research'},{id:'q',name:'Excluded project',workspace:'research'}],notes:[
    {id:'target',projectId:'p',title:'Transport observation',content:'Platform uncertainty makes the perceived wait longer.'},
    {id:'other',projectId:'q',title:'Transport private',content:'NEVER_EXPOSE_FOREIGN'},
    {id:'secret',projectId:'p',private:true,title:'Transport personal',content:'NEVER_EXPOSE_PRIVATE'},
  ]};
  const config=V.configuration({base:'https://fixture.invalid/v1',model:'synthetic',enabled:true,noKey:!credentials});
  let currentState=state;
  const profile=await V.profile(config),items=await V.snapshot(state);
  const store={load:async id=>id===profile?items.map(e=>({id:e.id,hash:e.hash,vector:[1,0]})):[],write(){throw Error('Query must not persist vectors');}};
  const context={document:{getElementById:id=>nodes.get(id)||null,createElement:()=>element()},
    localStorage:{getItem:()=>JSON.stringify(config),setItem(){throw Error('Settings must not change');}},
    ContextRetrieval:R,VectorIndex:{...V,create:opts=>V.create({...opts,queryTimeoutMs:deadline})},
    workstationDesktop:{vectorIndex:store,...(credentials?{embeddingCredentials:credentials}:{})},
    AbortController,setTimeout,clearTimeout,
    fetch:async(url,options)=>{requests.push({url,options});return fetch?fetch(url,options):{ok:true,json:async()=>({data:[{index:0,embedding:[1,0]}]})};},
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../app/vector-knowledge-ui'),'utf8'),context);
  context.VectorKnowledge.init({getState:()=>currentState,isBusy:()=>false});
  return {state,requests,nodes,config,api:context.VectorKnowledge,replaceState(next){currentState=next;},search:(signal,scope={projectId:'p'})=>context.VectorKnowledge.searchRequest(state,scope,{type:'search',query:'Transport'},signal)};
}

for(const stall of ['headers','body'])test(`embedding stalled at ${stall} returns scoped BM25 and an explicit timeout`,async()=>{
  const pending=deferred();
  const f=await fixture({fetch:()=>stall==='headers'?pending.promise:{ok:true,json:()=>pending.promise}});
  const result=await f.search();
  assert.equal(result.strategy,'local-bm25');assert.equal(result.semanticStatus,'timeout');
  assert.equal(result.coverage.semanticErrorCode,'EMBEDDING_QUERY_TIMEOUT');
  assert.deepEqual(Array.from(result.entries,e=>e.id),['target']);assert.equal(result.contentRead,false);
  assert.equal(result.scope.projectId,'p');assert.doesNotMatch(JSON.stringify(result),/NEVER_EXPOSE|Excluded project/);
  assert.match(f.nodes.get('embeddingStatus').textContent,/超时/);
  assert.equal(f.requests[0].options.signal.aborted,true);
  // Release a non-cooperative response after the timeout. It must not install
  // a query-cache entry that suppresses the next real provider call.
  pending.resolve(stall==='headers'?{ok:true,json:async()=>({data:[{index:0,embedding:[1,0]}]})}:{data:[{index:0,embedding:[1,0]}]});
  await turn();
  const retry=await f.search();
  assert.equal(retry.strategy,'hybrid-rrf');assert.equal(f.requests.length,2);
});

test('human cancellation settles even when the provider ignores abort, and never turns into lexical success',async()=>{
  const f=await fixture({fetch:()=>new Promise(()=>{}),deadline:1000}),controller=new AbortController();
  const search=f.search(controller.signal);await turn();controller.abort();
  await assert.rejects(search,{code:'CANCELLED'});
  assert.equal(f.requests[0].options.signal.aborted,true);
  assert.equal(f.nodes.get('embeddingStatus').textContent,'');
});

test('fallback reconciles privacy changed during the pending provider response',async()=>{
  const f=await fixture({fetch:()=>new Promise(()=>{})});const search=f.search();await turn();f.state.notes[0].private=true;
  const result=await search;assert.equal(result.total,0);assert.equal(result.semanticStatus,'timeout');
  assert.doesNotMatch(JSON.stringify(result),/Platform uncertainty|NEVER_EXPOSE/);
});

test('initial conversation context also states that semantic lookup timed out',async()=>{
  const f=await fixture({fetch:()=>new Promise(()=>{})});
  const result=await f.api.retrieve(f.state,{projectId:'p',query:'Transport'});
  assert.equal(result.coverage.semanticStatus,'timeout');assert.match(result.text,/语义检索超时，本轮已使用 BM25/);
  assert.doesNotMatch(result.text,/NEVER_EXPOSE/);
});

for(const outcome of ['timeout','success'])for(const restriction of ['private','moved'])test(`${outcome} rechecks a replaced workspace object's ${restriction} source before returning context`,async()=>{
  const pending=deferred(),f=await fixture({fetch:()=>pending.promise});
  const search=f.api.retrieve(f.state,{projectId:'p',query:'Transport'});await turn();
  const next=structuredClone(f.state);if(restriction==='private')next.notes[0].private=true;else next.notes[0].projectId='q';f.replaceState(next);
  if(outcome==='success')pending.resolve({ok:true,json:async()=>({data:[{index:0,embedding:[1,0]}]})});
  const result=await search;
  assert.equal(result.coverage.semanticStatus,outcome==='timeout'?'timeout':'ready');assert.equal(result.entries.length,0);
  assert.doesNotMatch(result.text,/Platform uncertainty|Transport observation|NEVER_EXPOSE/);
});

for(const outcome of ['timeout','success'])test(`${outcome} describes current explicit-project scope after a replacement revokes a grant`,async()=>{
  const pending=deferred(),f=await fixture({fetch:()=>pending.promise});
  const scope={workspace:'daily',readProjects:[{id:'p',name:'Synthetic transport',workspace:'research'}]};
  const search=f.search(undefined,scope);await turn();const next=structuredClone(f.state);next.projects[0].name='Renamed project';f.replaceState(next);
  if(outcome==='success')pending.resolve({ok:true,json:async()=>({data:[{index:0,embedding:[1,0]}]})});
  const result=await search;assert.equal(result.entries.length,0);assert.deepEqual(result.scope.explicitProjects,[]);assert.deepEqual(result.coverage.scope.explicitProjects,[]);
});

test('successful search refreshes the chunk version after state replacement so an unchanged source can be read',async()=>{
  const pending=deferred(),f=await fixture({fetch:()=>pending.promise});const search=f.search();await turn();
  const next=structuredClone(f.state);f.replaceState(next);pending.resolve({ok:true,json:async()=>({data:[{index:0,embedding:[1,0]}]})});
  const result=await search;assert.equal(result.entries.length,1);const entry=result.entries[0];
  const body=R.neighbors(next,{projectId:'p'},{chunkId:entry.chunkId,version:entry.version});assert.equal(body.entries[0].text,entry.excerpt);
});

test('a nonsettling credential bridge is bounded without invoking unlock or another credential channel',async()=>{
  let reads=0;const f=await fixture({credentials:{status:()=>new Promise(()=>{}),read:()=>{reads++;},unlock(){throw Error('Must not authorize');}}});
  const result=await f.search();assert.equal(result.semanticStatus,'timeout');assert.equal(reads,0);assert.equal(f.requests.length,0);
});

test('authentication failure stays unavailable, and healthy query vectors are cached',async()=>{
  const rejected=await fixture({fetch:()=>({ok:false,status:401})});
  const result=await rejected.search();assert.equal(result.semanticStatus,'unavailable');assert.match(result.coverage.semanticError,/认证失败/);assert.equal(result.coverage.semanticErrorCode,undefined);
  const healthy=await fixture();assert.equal((await healthy.search()).semanticStatus,'ready');assert.equal((await healthy.search()).semanticStatus,'ready');assert.equal(healthy.requests.length,1);
});

test('slow indexing batches do not inherit the short interactive query deadline',async()=>{
  const state={notes:[{id:'synthetic',content:'Long-lived indexing batch'}]},rows=[];
  const engine=V.create({getState:()=>state,store:{load:async()=>rows,write:async(_,puts=[])=>rows.push(...puts)},
    queryTimeoutMs:5,embed:async()=>{await new Promise(resolve=>setTimeout(resolve,25));return [[1,0]];}});
  assert.equal((await engine.update(V.configuration({base:'https://fixture.invalid/v1',model:'fixture'}))).ready,1);
});
