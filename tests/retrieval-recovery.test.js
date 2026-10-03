'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const K=require('../app/knowledge-access');
const plan=(...requests)=>JSON.stringify({knowledgeRequests:requests});
const empty={type:'search',total:0,entries:[],nextOffset:null,scope:{workspace:'课程',projectId:'p'}};

test('three distinct empty searches recover through the ordinary scoped catalog and read the real candidate',async()=>{
 const calls=[],checkpoints=[];let turn=0;
 const state={projects:[{id:'p',workspace:'课程'},{id:'private',workspace:'科研',private:true}],notes:[{id:'n',projectId:'p',title:'课件',content:'已保存原文'},{id:'hidden',projectId:'private',title:'secret'}]};
 const out=await K.continuePlan(plan({type:'search',query:'词一'}),{
  batch:async requests=>Promise.all(requests.map(r=>{calls.push(r);return r.type==='search'?empty:K.execute(state,{projectId:'p'},r);})),
  onCheckpoint:checkpoint=>checkpoints.push(checkpoint),
  ask:async text=>{
   turn++;
   if(turn<3)return plan({type:'search',query:'词'+turn});
   if(turn===3){assert.match(text,/检索恢复/);assert.match(text,/课件/);assert.doesNotMatch(text,/secret|hidden/);return plan({type:'read',id:'n'});}
   assert.match(text,/已保存原文/);assert.doesNotMatch(text,/检索恢复/);return '{"message":"依据原文回答"}';
  }
 });
 assert.match(out,/依据原文/);assert.deepEqual(calls.map(r=>r.type),['search','search','search','list','read']);
 assert.ok(checkpoints.some(c=>c.ledger.some(e=>e.type==='list')));
});

test('changing search words cannot bypass the empty-result limit after catalog recovery',async()=>{
 let searches=0,lists=0;
 await assert.rejects(K.continuePlan(plan({type:'search',query:'0'}),{
  execute:async r=>{if(r.type==='search'){searches++;return empty;}lists++;return {type:'list',entries:[],total:0,nextOffset:null};},
  ask:async()=>plan({type:'search',query:String(searches)})
 }),error=>error.code==='KNOWLEDGE_SEARCH_STALLED'&&error.knowledgeDiagnostic.emptySearches===5);
 assert.equal(searches,5);assert.equal(lists,1);
});

test('real new text resets the empty-search streak and does not cap useful reads',async()=>{
 let turn=0,reads=0,lists=0;
 await K.continuePlan(plan({type:'search',query:'0'}),{
  execute:async r=>{if(r.type==='search')return empty;if(r.type==='read'){reads++;return {text:'actual '+r.id};}lists++;return {entries:[],total:0};},
  ask:async()=>{turn++;if(turn===3||turn===7)return plan({type:'read',id:'n'+turn});if(turn===8)return '{}';return plan({type:'search',query:String(turn)});}
 });
 assert.equal(reads,2);assert.equal(lists,1);
});

test('a paged zero-entry tail with nonzero total is not a failed search',async()=>{
 let searches=0,lists=0;
 await K.continuePlan(plan({type:'search',query:'0'}),{execute:async r=>{r.type==='list'?lists++:searches++;return {...empty,total:20};},ask:async()=>searches<7?plan({type:'search',query:String(searches)}):'{}'});
 assert.equal(searches,7);assert.equal(lists,0);
});

test('cancellation before automatic catalog lookup prevents recovery work',async()=>{
 const controller=new AbortController();let searches=0,lists=0;
 await assert.rejects(K.continuePlan(plan({type:'search',query:'0'}),{
  signal:controller.signal,execute:async r=>{if(r.type==='list'){lists++;return {entries:[]};}if(++searches===3)controller.abort();return empty;},
  ask:async()=>plan({type:'search',query:String(searches)})
 }),{code:'CANCELLED'});assert.equal(lists,0);
});

test('catalog failure remains an error and is never advertised as a supplied catalog',async()=>{
 let searches=0;
 await K.continuePlan(plan({type:'search',query:'0'}),{
  execute:async r=>{if(r.type==='search'){searches++;return empty;}throw Error('index unavailable');},
  ask:async text=>{if(searches<3)return plan({type:'search',query:String(searches)});assert.match(text,/检索恢复未完成/);assert.match(text,/index unavailable/);assert.doesNotMatch(text,/已提供同一范围/);return '{}';}
 });
});

test('automatic recovery does not reuse a catalog filtered by a different project query',async()=>{
 const state={projects:[{id:'a',name:'项目甲甲',workspace:'课程'},{id:'b',name:'项目乙乙',workspace:'课程'},{id:'foreign',name:'别的项目',workspace:'科研'}],notes:[
  {id:'n-a',projectId:'a',title:'甲资料',content:'甲原文'},
  {id:'n-b',projectId:'b',title:'乙资料',content:'乙原文'},
  {id:'hidden',projectId:'foreign',title:'范围外资料',content:'NEVER_EXPOSE'},
 ]};
 const calls=[];let turn=0;
 await K.continuePlan(plan({type:'list',query:'项目甲甲',offset:0}),{
  execute:async request=>{calls.push(request);return K.execute(state,{workspace:'课程'},request);},
  ask:async text=>{
   if(++turn<4)return plan({type:'search',query:'UNMATCHABLE_'+turn});
   assert.match(text,/检索恢复/);assert.match(text,/n-a/);assert.match(text,/n-b/);
   assert.doesNotMatch(text,/NEVER_EXPOSE|范围外资料/);return '{}';
  }
 });
 assert.deepEqual(calls.filter(r=>r.type==='list').map(r=>r.query||''),['项目甲甲','']);
});

test('different queries returning only the same chunks are not new evidence; unrelated tools do not reset progress',async()=>{
 let searches=0,lists=0;
 await assert.rejects(K.continuePlan(plan({type:'search',query:'0'}),{
  execute:async r=>{if(r.type==='search'){searches++;return {total:1,entries:[{type:'note',id:'n',chunkId:'n:0',version:'v1',excerpt:'same evidence'}]};}if(r.type==='list'){lists++;return {total:1,entries:[{id:'n'}]};}return {description:'operation'};},
  ask:async()=>plan({type:'search',query:String(searches)},{type:'capabilities',name:'cap'+searches})
 }),error=>error.code==='KNOWLEDGE_SEARCH_STALLED'&&error.knowledgeDiagnostic.emptySearches===0&&error.knowledgeDiagnostic.unproductiveSearches===5);
 assert.equal(searches,6);assert.equal(lists,1);
});

test('new chunks and versions are productive even when they belong to the same file',async()=>{
 let searches=0,lists=0;
 await K.continuePlan(plan({type:'search',query:'0'}),{execute:async r=>{if(r.type==='list'){lists++;return {total:0,entries:[]};}searches++;return {total:1,entries:[{id:'n',chunkId:'n:'+searches,excerpt:'actual new excerpt'}]};},ask:async()=>searches<8?plan({type:'search',query:String(searches)}):'{}'});
 assert.equal(searches,8);assert.equal(lists,0);
});

test('adding an already-cached read cannot disguise repeated unproductive searches',async()=>{
 let searches=0,reads=0;
 await assert.rejects(K.continuePlan(plan({type:'read',id:'n'}),{
  execute:async r=>{if(r.type==='read'){reads++;return {text:'real original'};}if(r.type==='list')return {total:0,entries:[]};searches++;return empty;},
  ask:async()=>plan({type:'search',query:String(searches)},{type:'read',id:'n'})
 }),{code:'KNOWLEDGE_SEARCH_STALLED'});assert.equal(searches,5);assert.equal(reads,1);
});

test('fresh failed or empty reads cannot indefinitely exempt unproductive searches',async t=>{
 for(const mode of ['failed','empty'])await t.test(mode,async()=>{
  let searches=0,reads=0;
  await assert.rejects(K.continuePlan(plan({type:'search',query:'0'}),{
   execute:async request=>{
    if(request.type==='list')return {type:'list',total:0,entries:[]};
    if(request.type==='read'){reads++;if(mode==='failed')throw Error('Not found');return {id:request.id,text:'',nextOffset:null};}
    searches++;return empty;
   },
   ask:async()=>plan({type:'search',query:String(searches)},{type:'read',id:'unread-'+searches})
  }),{code:'KNOWLEDGE_SEARCH_STALLED'});
  assert.equal(searches,6,'one fresh read attempt is allowed after five unproductive searches');
  assert.equal(reads,5,'changing the read ID again cannot grant another exemption');
 });
});

test('a successful fresh read after five misses restores later search and recovery attempts',async()=>{
 const state={projects:[{id:'p',workspace:'课程'}],notes:[{id:'n5',projectId:'p',content:'First actual source'},{id:'n11',projectId:'p',content:'Second actual source'}]};
 let searches=0,reads=0;
 await K.continuePlan(plan({type:'search',query:'0'}),{
  execute:async request=>{
   if(request.type==='search'){searches++;return empty;}
   if(request.type==='read')reads++;
   return K.execute(state,{projectId:'p'},request);
  },
  ask:async()=>{
   if(searches>=14)return '{}';
   return plan({type:'search',query:String(searches)},...([5,11].includes(searches)?[{type:'read',id:'n'+searches}]:[]));
  }
 });
 assert.equal(searches,14);assert.equal(reads,2);
});

test('typed tool failures remain distinct from no match in model context',async()=>{
 await K.continuePlan(plan({type:'search',query:'topic'}),{
  execute:async()=>{throw Object.assign(Error('unavailable'),{code:'INDEX_UNAVAILABLE',recoveryHint:'Refresh the local index'});},
  ask:async text=>{assert.match(text,/INDEX_UNAVAILABLE/);assert.match(text,/Refresh the local index/);assert.doesNotMatch(text,/检索恢复/);return '{}';}
 });
});

test('scheduler preserves a typed retrieval failure in both response and saved tool record',async()=>{
 const S=require('../app/tool-scheduler'),run={};
 const scheduler=S.create({run,execute:async()=>{throw Object.assign(Error('not readable'),{code:'READ_SCOPE_CHANGED',recoveryHint:'Select the project again'});}});
 const [result]=await scheduler.batch([{type:'read',id:'n'}]);
 assert.equal(result.code,'READ_SCOPE_CHANGED');assert.equal(result.recoveryHint,'Select the project again');assert.equal(run.toolCalls[0].errorCode,'READ_SCOPE_CHANGED');assert.equal(run.toolCalls[0].status,'failed');
});
