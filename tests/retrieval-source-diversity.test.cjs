'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const W=require('../app/context-window'),R=require('../app/context-retrieval'),V=require('../app/vector-index'),K=require('../app/knowledge-access');
const {fixture,memory,query,scope,strong}=require('./fixtures/retrieval-source-diversity.cjs');
const cfg=V.configuration({base:'https://synthetic.invalid/v1',model:'injected-vectors',enabled:true,noKey:true});
const plan=(...requests)=>JSON.stringify({knowledgeRequests:requests});
const sourceIDs=entries=>entries.map(e=>e.recordId||e.id);

test('actual multi-document search protects two strongest passages and includes comparable alternate sources',async()=>{
 const state=fixture(),before=JSON.stringify(state),raw=R.searchIndex(state,{...scope,query,all:true}).entries;
 assert.ok(raw.slice(0,48).every(e=>e.recordId==='many'),'precondition: the long source occupies the first 48 raw ranks');
 const result=await K.execute(state,scope,{type:'search',query});
 assert.deepEqual(sourceIDs(result.entries.slice(0,5)),['many','many','experiment','limitations','survey']);
 assert.equal(result.coverage.matchedRecords,4);assert.equal(result.total,51);
 assert.deepEqual(result.entries.slice(0,2).map(e=>e.chunkId),raw.slice(0,2).map(e=>e.id));
 const byID=new Map(raw.map(e=>[e.id,e]));
 for(const e of result.entries){assert.equal(e.score,byID.get(e.chunkId).score);assert.equal(e.excerpt,byID.get(e.chunkId).text);}
 assert.equal(JSON.stringify(state),before,'search never writes the materials');
});

test('forty generic weak matches do not evict key pages of one strong source',async()=>{
 const state=fixture(true),raw=R.searchIndex(state,{...scope,query,all:true}).entries;
 const weak=raw.find(e=>e.recordId!=='many');assert.ok(weak.score/raw[0].score<0.01);
 const result=await K.execute(state,scope,{type:'search',query});
 assert.ok(result.entries.length>2);assert.ok(result.entries.every(e=>e.id==='many'));
 assert.deepEqual(result.entries.map(e=>e.chunkId),raw.slice(0,result.entries.length).map(e=>e.id));
 assert.equal(result.total,88,'weaker sources remain candidates, not discarded corpus');
});

test('count and token pages share one stable order; raw all ranking remains untouched and every chunk is reachable',async()=>{
 const state=fixture(),raw=R.searchIndex(state,{...scope,query,all:true}).entries;
 const allExpected=W.diversify(raw).map(e=>e.id),first=R.buildIndexedContext(state,{...scope,query});
 const seen=first.entries.map(e=>e.id);let offset=first.coverage.nextOffset;
 while(offset!==null){const result=await K.execute(state,scope,{type:'search',query,offset,maxTokens:256});seen.push(...result.entries.map(e=>e.chunkId));offset=result.nextOffset;}
 assert.deepEqual(seen,allExpected);assert.equal(new Set(seen).size,raw.length);
 assert.deepEqual(R.searchIndex(state,{...scope,query,all:true,offset:7,maxTokens:4000}).entries.map(e=>e.id),raw.slice(7).map(e=>e.id));
 assert.deepEqual(R.searchIndex(state,{...scope,query,maxTokens:16000}).entries.map(e=>e.id),allExpected.slice(0,R.searchIndex(state,{...scope,query,maxTokens:16000}).entries.length));
});

test('promotion policy is finite, typed-source aware, and does not invent relevance for invalid/missing scores',()=>{
 const rows=Array.from({length:10},(_,i)=>({id:'chunk'+i,type:'note',recordId:i<6?'primary':'n'+i,score:10-i/10}));
 const ordered=W.diversify(rows);assert.deepEqual(ordered.slice(0,5).map(e=>e.id),['chunk0','chunk1','chunk6','chunk7','chunk8']);
 assert.equal(ordered[5].id,'chunk2','the fifth source cannot keep pushing out primary evidence');
 assert.deepEqual(W.diversify(rows.map(e=>({...e,recordId:'same'}))).map(e=>e.id),rows.map(e=>e.id));
 for(const score of [NaN,undefined,-1,0,Infinity]){
  const invalid=[...rows.slice(0,6),{id:'bad',type:'note',recordId:'invalid',score}];
  assert.deepEqual(W.diversify(invalid).map(e=>e.id),invalid.map(e=>e.id));
 }
 const typed=[...rows.slice(0,6),{id:'paper',type:'paper',recordId:'primary',score:9}];
 assert.equal(W.diversify(typed)[2].type,'paper');
 assert.deepEqual([...W.promotionCandidates([{id:'negative',similarity:-0.1},{id:'zero',similarity:0},{id:'nan',similarity:NaN}],'similarity')],[]);
});

test('hybrid semantic-only ranking broadens comparable sources without promoting weak/negative cosine or changing scores',async()=>{
 const state=fixture(),store=memory(),calls=[];
 state.notes.push({id:'weak-semantic',projectId:'study',title:'Orchard',content:'Unrelated citrus observations'},{id:'negative',projectId:'study',title:'Counterpoint',content:'Opposite topic'});
 const semanticQuery='汽车发动机噪声为何不同';
 assert.equal(R.searchIndex(state,{...scope,query:semanticQuery,all:true}).entries.length,0,'no lexical terms: this must exercise actual vector fusion');
 const engine=V.create({getState:()=>state,store,embed:async(_cfg,texts)=>{
  calls.push(texts);return texts.map(text=>text===semanticQuery?[1,0]:text.includes('Opposite')?[-1,0]:text.includes('citrus')?[0.1,1]:text.includes('separate sample')?[0.999,0.02]:[1,0]);
 }});
 await engine.update(cfg);const before=calls.length;
 const first=await engine.search(cfg,semanticQuery,{...scope,maxTokens:4000});
 assert.deepEqual(sourceIDs(first.entries.slice(0,5)),['many','many','experiment','limitations','survey']);
 assert.equal(first.entries.some(e=>e.recordId==='weak-semantic'),false);
 assert.equal(first.entries[0].score,1/61);assert.equal(first.entries[2].score,1/109,'RRF is unchanged by presentation');
 const seen=first.entries.map(e=>e.id);let offset=first.coverage.nextOffset;
 while(offset!==null){const result=await engine.search(cfg,semanticQuery,{...scope,maxTokens:256},offset);seen.push(...result.entries.map(e=>e.id));offset=result.coverage.nextOffset;}
 assert.equal(seen.length,52);assert.equal(new Set(seen).size,52);assert.equal(calls.length,before+1,'one query embedding is reused across pages');
 assert.ok(first.coverage.totalChunks===52,'negative cosine does not become a candidate');
 assert.ok(!JSON.stringify(first.entries).includes('similarity'),'internal relevance signals are not emitted as source facts');
});

test('hybrid lexical-only fallback keeps breadth, while deleted/private/moved/daily records never re-enter promotion pool',async()=>{
 const state=fixture(),engine=V.create({getState:()=>state,store:memory(),embed:async()=>{throw Error('No vectors: never call provider');}});
 const first=await engine.search(cfg,query,{...scope,maxTokens:4000});
 assert.equal(first.coverage.semanticStatus,'not-indexed');assert.equal(new Set(sourceIDs(first.entries)).size,4);
 state.notes[1].private=true;state.notes[2].projectMemoryType='daily';state.notes[3].projectId='other';
 const next=await engine.search(cfg,query,{...scope,maxTokens:4000});
 assert.ok(next.entries.every(e=>e.recordId==='many'));assert.equal(next.coverage.excludedProjectActivityRecords,1);
 assert.ok(R.listIndex(state,scope).entries.some(e=>e.id==='experiment'),'daily stays explicitly discoverable');
 assert.equal((await K.execute(state,scope,{type:'read',id:'experiment'})).text,strong+' separate sample');
});

test('current source identity is rechecked after vector await before relevance-qualified promotion',async()=>{
 let current=fixture(),release;const store=memory();let wait=false;
 const engine=V.create({getState:()=>current,store,embed:async(_cfg,texts)=>wait?new Promise(resolve=>{release=()=>resolve([[1,0]]);}):texts.map(()=>[1,0])});
 await engine.update(cfg);wait=true;
 const pending=engine.search(cfg,'unshared semantic lookup',{...scope,maxTokens:4000});
 while(!release)await new Promise(resolve=>setImmediate(resolve));
 current=structuredClone(current);current.notes[1].private=true;current.notes[2].projectMemoryType='daily';current.notes[3].projectId='other';release();
 const result=await pending;assert.ok(result.entries.every(e=>e.recordId==='many'));assert.equal(result.coverage.excludedProjectActivityRecords,1);
});

test('equivalent search budgets reuse the actual run result and still stop a repeated-query loop',async()=>{
 const state=fixture(),calls=[],forms=[undefined,4000,'4000',null];let turn=0;
 await assert.rejects(K.continuePlan(plan({type:'search',query}),{
  execute:async request=>{calls.push(request);return K.execute(state,scope,request);},
  ask:async()=>plan({type:'search',query,maxTokens:forms[++turn%forms.length]})
 }),{code:'KNOWLEDGE_STALLED'});
 assert.equal(calls.length,1,'omitted, explicit and numeric-string default do not execute again');
});

test('256 and 16000 budgets, offset changes and case-sensitive queries cannot collide with the default',async()=>{
 const requests=[{type:'search',query},{type:'search',query,maxTokens:256},{type:'search',query,maxTokens:16000},{type:'search',query,offset:5},{type:'search',query:query.toUpperCase()}];
 const state=fixture(),calls=[];let turn=0;
 await K.continuePlan(plan(requests[0]),{execute:async request=>{calls.push(request);return K.execute(state,scope,request);},ask:async()=>++turn<requests.length?plan(requests[turn]):'{}'});
 assert.equal(calls.length,requests.length);assert.deepEqual(calls,requests);
});

test('invalid budget is still an explicit error and cannot reuse a valid search result',async()=>{
 let turn=0,calls=0;const state=fixture();
 await K.continuePlan(plan({type:'search',query}),{
  execute:async request=>{calls++;return K.execute(state,scope,request);},
  ask:async text=>{if(++turn===1)return plan({type:'search',query,maxTokens:0});assert.match(text,/Context budget must be 256/);return '{}';}
 });assert.equal(calls,2);
});
