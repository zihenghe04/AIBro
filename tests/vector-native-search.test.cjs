const test=require('node:test'),assert=require('node:assert/strict');
const V=require('../app/vector-index');
const cfg=V.configuration({base:'https://embedding.example/v1',model:'multilingual',enabled:true});
function memory(){const rows=new Map();return {rows,async load(profile){return [...rows.values()].filter(r=>r.profile===profile).map(r=>structuredClone(r));},async write(profile,puts=[],removes=[]){for(const id of removes)rows.delete(profile+id);for(const r of puts)rows.set(profile+r.id,{...structuredClone(r),profile});}};}
// Mirrors NativeVectorStore: metadata-only summary, in-place scoring, and no full load on the hot path.
function native(){const base=memory(),calls=[];return {calls,write:base.write,
  async load(){throw Error('The page must not load whole vectors from the native store');},
  async summary(profile){calls.push('summary');return (await base.load(profile)).map(({id,hash,updatedAt,vector})=>({id,hash,updatedAt,dimensions:vector.length}));},
  async search(profile,query,entries){calls.push('search');return (await base.load(profile)).filter(r=>entries[r.id]===r.hash).map(r=>r.vector.length===query.length?{id:r.id,dimensions:r.vector.length,similarity:V.cosine(query,r.vector)}:{id:r.id,dimensions:r.vector.length});}};}
const words=['transport','vehicle','apple','orbit','protein','theorem','river','market','neuron','glacier','violin','syntax'];
const state=()=>({projects:[{id:'p',workspace:'科研'}],notes:Array.from({length:30},(_,i)=>({id:`n${i}`,projectId:'p',title:`Note ${i}`,content:`${words[i%12]} ${words[(i*7)%12]} ${words[(i*5+3)%12]} sample ${i}`}))});
const embed=async(c,texts)=>texts.map(text=>Array.from({length:32},(_,d)=>{let h=d+1;for(const ch of text)h=(h*31+ch.charCodeAt(0))%9973;return (h%200-100)/100+(words.findIndex(w=>text.includes(w))===d%12?1:0);}));
test('native-side scoring returns the same ranked entries and coverage as loading vectors into the page',async()=>{
  const s=state(),plain=V.create({getState:()=>s,store:memory(),embed}),store=native(),fast=V.create({getState:()=>s,store,embed});
  const counts=({updatedAt,...rest})=>(assert.ok(updatedAt>0),rest);
  assert.deepEqual(counts(await fast.update(cfg)),counts(await plain.update(cfg)));
  assert.deepEqual(counts(await fast.status(cfg)),counts(await plain.status(cfg)));
  for(const query of ['vehicle transport','protein neuron','syntax theorem river','glacier']){
    const [a,b]=[await plain.search(cfg,query),await fast.search(cfg,query)];
    assert.ok(a.entries.length>0);assert.deepEqual(b,a,query);
  }
  assert.ok(store.calls.includes('summary')&&store.calls.includes('search'));
  s.notes[4].content='edited after indexing';
  assert.deepEqual(await fast.search(cfg,'protein neuron'),await plain.search(cfg,'protein neuron'),'stale rows stay out of semantic ranking');
});
test('native dimension mismatch still asks the user to rebuild the index',async()=>{
  const s=state(),store=native(),engine=V.create({getState:()=>s,store,embed});await engine.update(cfg);
  const narrow=V.create({getState:()=>s,store,embed:async(c,t)=>t.map(()=>[1,0,0])});
  await assert.rejects(narrow.search(cfg,'vehicle'),/维度不匹配/);
});
