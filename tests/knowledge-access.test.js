const test=require('node:test'),assert=require('node:assert/strict'),K=require('../app/knowledge-access');
const state=()=>({projects:[{id:'p'},{id:'q'}],notes:Array.from({length:125},(_,i)=>({id:'n'+String(i).padStart(3,'0'),projectId:'p',title:'Paper '+i,content:i===124?'Late evidence quantum optics':'ordinary content'})).concat([{id:'secret',projectId:'q',content:'quantum optics'},{id:'deleted',projectId:'p',deletedAt:1,content:'quantum optics'}])});
test('125 documents are reachable through search and paging without crossing scope',async()=>{const s=state();const r=await K.execute(s,{projectId:'p'},{type:'search',query:'quantum optics'});assert.deepEqual(r.entries.map(x=>x.id),['n124']);const ids=[];let offset=0;do{const page=await K.execute(s,{projectId:'p'},{type:'list',offset});ids.push(...page.entries.map(x=>x.id));offset=page.nextOffset;}while(offset!==null);assert.equal(new Set(ids).size,125);});
test('read returns exact paged text and rejects foreign IDs',async()=>{const s=state();s.notes[0].content='A'.repeat(15000)+'ENDING';let result='';let offset=0;do{const r=await K.execute(s,{projectId:'p'},{type:'read',id:'n000',offset});result+=r.text;offset=r.nextOffset;}while(offset!==null);assert.equal(result,s.notes[0].content);await assert.rejects(K.execute(s,{projectId:'p'},{type:'read',id:'secret'}));});
test('model can search then read evidence before returning a plan; no writes during retrieval',async()=>{const s=state();let calls=0;const out=await K.continuePlan(JSON.stringify({knowledgeRequests:[{type:'search',query:'quantum optics'}],actions:[]}),{execute:r=>K.execute(s,{projectId:'p'},r),ask:async text=>{calls++;if(calls===1){assert.match(text,/n124/);return JSON.stringify({knowledgeRequests:[{type:'read',id:'n124'}],actions:[]});}assert.match(text,/Late evidence/);return JSON.stringify({message:'Evidence found',actions:[]});}});assert.match(out,/Evidence found/);assert.equal(calls,2);await assert.rejects(K.continuePlan(JSON.stringify({knowledgeRequests:[{type:'list'}],actions:[{type:'delete_note'}]}),{}));});
test('cancellation and repeated requests do not silently complete',async()=>{const controller=new AbortController();controller.abort();await assert.rejects(K.continuePlan('{}',{signal:controller.signal}),{code:'CANCELLED'});const p=JSON.stringify({knowledgeRequests:[{type:'list'}]});await assert.rejects(K.continuePlan(p,{execute:async()=>({entries:[]}),ask:async()=>p}),/重复/);});

test('fenced tool requests are executed instead of treated as a completed answer',async()=>{let calls=0;const out=await K.continuePlan('```json\n'+JSON.stringify({knowledgeRequests:[{type:'list'}],actions:[]})+'\n```',{execute:async()=>{calls++;return {entries:[]}},ask:async()=>JSON.stringify({message:'done',actions:[]})});assert.equal(calls,1);assert.match(out,/done/);});

test('multi-page evidence and PDF images survive later read and search turns',async()=>{
 const s=state();s.notes[0].content='FIRST_PAGE_'+ 'x'.repeat(12000)+'LAST_PAGE';let turn=0;
 const plan=requests=>JSON.stringify({knowledgeRequests:requests,actions:[]});
 await K.continuePlan(plan([{type:'read',id:'n000'}]),{execute:r=>r.type==='read_page'?{id:'pdf',page:1,blocks:[{type:'input_image',image_url:'synthetic'}]}:K.execute(s,{projectId:'p'},r),ask:async(text,images)=>{
  turn++;assert.match(text,/FIRST_PAGE/);
  if(turn===1)return plan([{type:'read',id:'n000',offset:12000}]);
  assert.match(text,/LAST_PAGE/);
  if(turn===2)return plan([{type:'read_page',recordType:'import',id:'pdf',page:1}]);
  assert.equal(images.length,1);
  if(turn===3)return plan([{type:'search',query:'quantum optics'}]);
  return '{"message":"done","actions":[]}';
 }});assert.equal(turn,4);
});

test('alternating reads and rebatched default-equivalent requests execute once and stop without progress',async()=>{
 const plan=r=>JSON.stringify({knowledgeRequests:r,actions:[]});let calls=0,turn=0,notifications=0;
 const cycles=[[{type:'search',query:'a'}],[{type:'read',id:'n'}],[{id:'n',offset:0,recordType:'note',variant:'current',type:'read'},{offset:0,type:'list',query:'ignored'}],[{query:'a',offset:0,type:'search'}]];
 await assert.rejects(K.continuePlan(plan([{type:'list'}]),{execute:async()=>{calls++;return {text:'saved',nextOffset:null}},onResult:()=>notifications++,ask:async text=>{
  if(turn===3)assert.match(text,/已复用结果/);
  return plan(cycles[turn++]);
 }}),{code:'KNOWLEDGE_STALLED'});
 assert.equal(calls,3);assert.equal(notifications,3);
});

test('context capacity is explicit and cached reads remain scoped and cancellable',async()=>{
 let turn=0,checks=0;
 await K.continuePlan('{"knowledgeRequests":[{"type":"read","id":"a"}]}',{evidenceChars:300,validate:()=>checks++,execute:async r=>({id:r.id,text:r.id.repeat(150)}),ask:async text=>{
  if(++turn===1)return '{"knowledgeRequests":[{"type":"read","id":"b"}]}';
  assert.match(text,/evidenceIncluded":false/);assert.match(text,/上下文容量/);return '{"actions":[]}';
 }});assert.ok(checks>=4);
});

test('unreadable Wiki cache is excluded from search, initial context and explicit file reads', async () => {
  const F = require('../app/file-context'), C = require('../app/context-retrieval');
  const s = {projects:[{id:'p'}], notes:[{id:'broken',projectId:'p',title:'experiment',content:'STALE_EVIDENCE',wikiFileError:'missing Markdown'}]};
  assert.deepEqual(K.records(s,{projectId:'p'}),[]);
  assert.deepEqual(F.search(s,''),[]);
  assert.doesNotMatch(C.buildContext(s,{projectId:'p',query:'experiment'}).text,/STALE_EVIDENCE/);
  await assert.rejects(K.execute(s,{projectId:'p',explicitReferences:[{type:'note',id:'broken'}]},{type:'read',id:'broken'}));
  await assert.rejects(F.libraryRef(s,'note','broken'));
});
