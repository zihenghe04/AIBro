'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const K=require('../app/knowledge-access'),E=require('../app/citation-evidence');
const fixture=()=>({projects:[{id:'p',workspace:'课程'}],imports:[{id:'pdf',projectId:'p',workspace:'课程',createdAt:1,updatedAt:1,mimeType:'application/pdf',sourceHash:'synthetic-original',pages:Array.from({length:32},(_,i)=>({page:i+1,text:`Fictional content on page ${i+1}.`}))}]});
const scope={projectId:'p',workspace:'课程'},req=page=>({type:'read_page',recordType:'import',id:'pdf',page});
const readPage=async(_record,page)=>({text:'Synthetic page '+page});
function watchText(state){let reads=0;for(const page of state.imports[0].pages){let value=page.text;Object.defineProperty(page,'text',{enumerable:true,get(){reads++;return value;},set(x){value=x;}});}return {reset(){reads=0;},get count(){return reads;}};}
async function prepare(count=32){const state=fixture(),readSession=K.createReadSession(),reads=watchText(state),results=[];for(let i=0;i<count;i++)results.push(await K.execute(state,scope,req(i+1),{readPage,readSession,getState:()=>state}));reads.reset();return {state,readSession,reads,results};}
test('one synchronous validation serializes each record once instead of once per returned page',async()=>{
 const f=await prepare();assert.equal(K.readValidationFailures(f.results,f.state).size,0);assert.equal(f.reads.count,32);
 f.reads.reset();for(const r of f.results)K.validateReadResult(r,f.state);assert.equal(f.reads.count,32*32,'isolated calls have no long-lived cache');
});
test('citation current-access validation batches guards but still captures only the supplied excerpts',async()=>{
 const f=await prepare(8),run={id:'r'},entries=f.results.map((result,i)=>({request:req(i+1),result}));
 assert.equal(E.validateRetained(run,entries,f.state),true);assert.equal(f.reads.count,32);assert.equal(run.evidenceSources,undefined);
 f.reads.reset();const out=E.captureRetained(run,entries,f.state);assert.equal(f.reads.count,64,'one validation serialization and one citation-body snapshot');assert.equal(out.length,8);assert.equal(run.evidenceSources.length,8);assert.ok(run.evidenceSources.every(s=>s.excerpt.startsWith('Synthetic page ')));
});
test('later validation detects in-place changes even with unchanged timestamps and original hash',async()=>{
 const f=await prepare(8);assert.equal(K.readValidationFailures(f.results,f.state).size,0);
 f.state.imports[0].pages[31].text='Changed page not among the eight returned page numbers';f.reads.reset();
 const failures=K.readValidationFailures(f.results,f.state);assert.equal(failures.size,8);assert.equal(f.reads.count,32);assert.ok([...failures.values()].every(e=>e.code==='KNOWLEDGE_SOURCE_CHANGED'));
});
test('same-content object replacement remains valid; a later private replacement revokes every shared version',async()=>{
 let state=fixture();const readSession=K.createReadSession(),results=[];for(let p=1;p<=3;p++)results.push(await K.execute(state,scope,req(p),{readPage,readSession,getState:()=>state}));
 state=structuredClone(state);state.imports[0].updatedAt=999;assert.equal(K.readValidationFailures(results).size,0);
 await Promise.resolve();state=structuredClone(state);state.imports[0].private=true;assert.equal(K.readValidationFailures(results).size,3);
});
test('one run retains exact distinct versions rather than overwriting the snapshot expected by earlier pages',async()=>{
 const state=fixture(),readSession=K.createReadSession(),a=await K.execute(state,scope,req(1),{readPage,readSession});
 state.imports[0].pages[0].text='A new exact body';const b=await K.execute(state,scope,req(2),{readPage,readSession});
 const failures=K.readValidationFailures([a,b],state);assert.equal(failures.has(a),true);assert.equal(failures.has(b),false);
 state.imports[0].pages[0].text=fixture().imports[0].pages[0].text;const c=await K.execute(state,scope,req(3),{readPage,readSession});
 const restored=K.readValidationFailures([a,b,c],state);assert.equal(restored.size,1);assert.equal(restored.has(a),false);assert.equal(restored.has(b),true);assert.equal(restored.has(c),false);
});
test('sessions with the same stable ID remain isolated and serialized results contain no snapshot/session payload',async()=>{
 const a=fixture(),b=fixture(),sa=K.createReadSession(),sb=K.createReadSession();
 const ra=await K.execute(a,scope,req(1),{readPage,readSession:sa}),rb=await K.execute(b,scope,req(1),{readPage,readSession:sb});
 a.imports[0].private=true;const failures=K.readValidationFailures([ra,rb]);assert.equal(failures.has(ra),true);assert.equal(failures.has(rb),false);
 assert.doesNotMatch(JSON.stringify([ra,rb]),/Fictional content|readSession|knowledgeReadCurrent/);
 await assert.rejects(K.execute(b,scope,req(1),{readPage,readSession:{}}),/Invalid knowledge read session/);
});
test('sharing does not reuse a pre-await serialization when the source is edited before read completion',async()=>{
 let state=fixture(),release;const readSession=K.createReadSession();await K.execute(state,scope,req(1),{readPage,readSession,getState:()=>state});
 const waiting=K.execute(state,scope,req(2),{readSession,getState:()=>state,readPage:()=>new Promise(r=>release=r)});
 state=structuredClone(state);state.imports[0].pages[0].text='Changed while read was pending';release({text:'old page'});
 await assert.rejects(waiting,e=>e.code==='KNOWLEDGE_SOURCE_CHANGED');
});
test('batched failures are temporary diagnostics, not a reusable authorization cache',async()=>{
 const f=await prepare(2),before=K.readValidationFailures(f.results,f.state);assert.equal(before.size,0);
 f.state.imports[0].projectId=null;assert.equal(K.readValidationFailures(f.results,f.state).size,2);assert.equal(before.size,0);
});
