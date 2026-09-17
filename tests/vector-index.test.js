const test=require('node:test'),assert=require('node:assert/strict');
const V=require('../app/vector-index');
const cfg=patch=>V.configuration({base:'https://embedding.example/v1',model:'multilingual',enabled:true,...patch});
function memory(){const rows=new Map();return {rows,async load(profile){return [...rows.values()].filter(r=>r.profile===profile).map(r=>structuredClone(r));},async write(profile,puts=[],removes=[]){for(const id of removes)rows.delete(profile+id);for(const r of puts)rows.set(profile+r.id,{...structuredClone(r),profile});}};}
const state=()=>({projects:[{id:'p',workspace:'科研'},{id:'q',workspace:'课程'}],notes:[{id:'a',projectId:'p',title:'Transport',content:'automobile vehicle'},{id:'b',projectId:'q',title:'Fruit',content:'apple'}]});
const vector=text=>/automobile|vehicle|汽车/.test(text)?[1,0]:[0,1];
function setup(s=state(),extra={}){const store=memory(),calls=[];const engine=V.create({getState:()=>s,store,embed:async(c,texts)=>{calls.push({config:c,texts});return texts.map(vector);},...extra});return {s,store,calls,engine};}
test('independent normalized provider profile includes model and dimensions, never keys',async()=>{
 assert.equal(cfg().base,'https://embedding.example/v1/embeddings');assert.equal(cfg({base:'http://127.0.0.1:11434/v1',noKey:true}).noKey,true);
 assert.notEqual(await V.profile(cfg()),await V.profile(cfg({model:'other'})));assert.notEqual(await V.profile(cfg()),await V.profile(cfg({dimensions:2})));
 for(const base of ['https://key:secret@example.com','https://example.com/v1?key=secret','file:///tmp/local','https://example.com/v1/responses'])assert.throws(()=>cfg({base}));
 assert.throws(()=>cfg({dimensions:-1}));assert.equal(JSON.stringify(cfg({token:'SECRET'})).includes('SECRET'),false);
});
test('incremental update persists vectors and retries unchanged workspace without another API call',async()=>{
 const {s,engine,store,calls}=setup();const before=JSON.stringify(s);assert.equal((await engine.update(cfg())).ready,2);assert.equal(calls.length,1);
 await engine.update(cfg());assert.equal(calls.length,1);assert.equal(JSON.stringify(s),before);
 const restarted=V.create({getState:()=>s,store,embed:async()=>{throw Error('Unchanged content must not re-embed');}});assert.equal((await restarted.status(cfg())).ready,2);await restarted.update(cfg());
 s.notes[0].content='automobile updated';await engine.update(cfg());assert.equal(calls.length,2);assert.equal(calls[1].texts.length,1);
 s.notes.pop();await engine.update(cfg());assert.equal(calls.length,2);assert.equal(store.rows.size,1);
});
test('semantic match bridges vocabulary and only searches the selected project',async()=>{
 const {engine,calls}=setup();await engine.update(cfg());const r=await engine.search(cfg(),'汽车',{projectId:'p'});
 assert.equal(r.entries[0].recordId,'a');assert.equal(r.coverage.strategy,'hybrid-rrf');assert.equal(r.entries.some(e=>e.recordId==='b'),false);
 await engine.search(cfg(),'汽车',{projectId:'p'});assert.equal(calls.length,2,'query vector reused');
});
test('changing model starts an independent index and never mixes dimensions',async()=>{
 const {engine,calls}=setup();await engine.update(cfg());assert.equal((await engine.status(cfg({model:'new-model'}))).ready,0);await engine.update(cfg({model:'new-model'}));assert.equal(calls.length,2);
 const result=await engine.status(cfg());assert.equal(result.ready,2);
});
test('source edits/deletions during embedding cannot write a stale vector back',async()=>{
 const s=state(),store=memory();let changed=false;const engine=V.create({getState:()=>s,store,embed:async(c,texts)=>{if(!changed){s.notes[0].content='changed while running';s.notes[1].deletedAt=1;changed=true;}return texts.map(vector);}});
 const r=await engine.update(cfg());assert.equal(r.ready,0);assert.equal(r.pending,1);assert.equal(store.rows.size,0);
 await engine.update(cfg());assert.equal((await engine.status(cfg())).ready,1);
});
test('failed later batches keep completed batches; retry embeds only missing chunks',async()=>{
 const s=state();s.notes=Array.from({length:35},(_,i)=>({id:'n'+i,projectId:'p',content:'row '+i}));const store=memory();let calls=0,fail=true;
 const engine=V.create({getState:()=>s,store,embed:async(c,texts)=>{calls++;if(fail&&calls===2)throw Error('Temporary failure');return texts.map(()=>[1,0]);}});
 await assert.rejects(engine.update(cfg()),/Temporary/);assert.equal((await engine.status(cfg())).ready,16);
 fail=false;await engine.update(cfg());assert.equal((await engine.status(cfg())).ready,35);assert.equal(calls,4);
});
test('stop aborts updates and does not commit an in-flight response',async()=>{
 const controller=new AbortController();const {engine,store}=setup(state(),{embed:async(c,texts)=>{controller.abort();return texts.map(vector);}});
 await assert.rejects(engine.update(cfg(),{signal:controller.signal}),{code:'CANCELLED'});assert.equal(store.rows.size,0);
});
test('edited evidence is excluded from old vectors until updated; archived projects vanish',async()=>{
 const {s,engine}=setup();await engine.update(cfg());s.notes[0].content='unrelated';const r=await engine.search(cfg(),'汽车',{projectId:'p'});assert.equal(r.entries.length,0);
 s.projects[0].archived=true;assert.equal((await engine.search(cfg(),'汽车',{projectId:'p'})).entries.length,0);
});
test('deleting a source while query embedding is running cannot leak it into results',async()=>{
 const s=state(),store=memory();let query=false;const engine=V.create({getState:()=>s,store,embed:async(c,texts)=>{if(query)s.notes[0].deletedAt=1;return texts.map(vector);}});
 await engine.update(cfg());query=true;assert.equal((await engine.search(cfg(),'汽车',{projectId:'p'})).entries.length,0);
});
test('invalid provider vectors fail explicitly',()=>{
 for(const vectors of [[],[[0,0]],[[NaN,2]],[[1,2],[1]],['base64'],[[Infinity]]])assert.throws(()=>V.validate(vectors,2));
 assert.throws(()=>V.validate([[1,2]],1,3));assert.equal(V.validate([[1,0],[0,1]],2),2);
});

test('hybrid search uses a payload budget and reaches all 180 sources with cached query vector',async()=>{
 const s=state();s.notes=Array.from({length:180},(_,i)=>({id:'n'+i,projectId:'p',title:'Transport '+i,content:'automobile vehicle '+i}));
 const {engine,calls}=setup(s);await engine.update(cfg());const before=calls.length;let offset=0;const seen=[];
 do{const r=await engine.search(cfg(),'汽车',{projectId:'p',maxTokens:4000},offset);seen.push(...r.entries.map(e=>e.recordId));offset=r.coverage.nextOffset;assert.ok(r.coverage.estimatedTokens<=4000);}while(offset!==null);
 assert.equal(new Set(seen).size,180);assert.equal(calls.length,before+1,'one query embedding across every page');
});
