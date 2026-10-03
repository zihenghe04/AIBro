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
 const cycles=[[{type:'search',query:'a'}],[{type:'read',id:'n'}],[{id:'n',offset:0,recordType:'note',variant:'current',type:'read'},{offset:0,type:'list',query:'   '}],[{query:'a',offset:0,type:'search'}]];
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

test('a productive scan can exceed 64 rounds without an arbitrary corpus limit',async()=>{
 let i=0;await K.continuePlan(JSON.stringify({knowledgeRequests:[{type:'read',id:'a',offset:0}]}),{execute:async r=>({id:'a',offset:r.offset,text:'page '+r.offset,nextOffset:r.offset+1}),ask:async()=>++i<70?JSON.stringify({knowledgeRequests:[{type:'read',id:'a',offset:i}]}):'{"actions":[]}'});assert.equal(i,70);
});

test('oversized text remains readable through an explicit context cursor instead of being dropped forever',async()=>{
 let turn=0;const content='start '+('large source '.repeat(3000))+' end';
 await K.continuePlan('{"knowledgeRequests":[{"type":"read","id":"large"}]}',{evidenceChars:4000,execute:async()=>({id:'large',offset:0,text:content,totalChars:content.length,nextOffset:null}),ask:async text=>{turn++;assert.match(text,/contextTruncated/);assert.match(text,/start/);assert.match(text,/nextOffset":\d+/);return '{"actions":[]}';}});assert.equal(turn,1);
});

test('capability fields survive cached retries and the model can then submit a final plan',async()=>{
 const C=require('../app/agent-context');
 const c=C.create({fullInstruction:'你是个人助手。动作类型与字段：create_knowledge_item(title,content,sourceAttachmentIds)。',history:{text:''}});
 const request=JSON.stringify({knowledgeRequests:[{type:'capabilities',name:'knowledge'}],actions:[]});
 let reads=0,turns=0;
 const output=await K.continuePlan(request,{execute:r=>{reads++;return c.capability(r.name);},ask:async input=>{
  assert.match(input,/create_knowledge_item\(title,content,sourceAttachmentIds\)/);
  if(++turns===1)return request;
  assert.match(input,/已复用结果/);
  return JSON.stringify({message:'归档提案',actions:[{type:'create_knowledge_item',title:'示例',content:'示例正文',sourceAttachmentIds:['mock']}]});
 }});
 assert.equal(reads,1);assert.equal(turns,2);assert.equal(JSON.parse(output).actions.length,1);
});
test('persistent capability repetition stops with a specific error, without executing mutations',async()=>{
 const plan=JSON.stringify({knowledgeRequests:[{type:'capabilities',name:'knowledge'}]});let reads=0;
 await assert.rejects(K.continuePlan(plan,{execute:async()=>{reads++;return {loaded:true,instructions:'schema'};},ask:async()=>plan}),e=>e.code==='KNOWLEDGE_STALLED'&&/重复请求已加载的操作说明（knowledge）/.test(e.message));
 assert.equal(reads,1);
});

test('oversized command output reaches the model once, stays bounded and cannot cause an endless cached replay',async()=>{
 const S=require('../app/tool-scheduler'),run={},request={type:'terminal',argv:['synthetic-check']};
 const original={type:'terminal',id:'cmd-safe',status:'succeeded',exitCode:0,output:'RESULT_BEGIN '+('synthetic evidence '.repeat(2000)),truncated:false};
 let executions=0,turns=0,checkpoint;
 const scheduler=S.create({run,execute:async()=>{executions++;return original}});
 const plan=JSON.stringify({knowledgeRequests:[request],actions:[]});
 await assert.rejects(K.continuePlan(plan,{batch:scheduler.batch,evidenceChars:1400,maxRounds:8,onCheckpoint:value=>{checkpoint=value},ask:async prompt=>{
  turns++;
  const retained=JSON.parse(prompt.split('包含此前读取的正文）：')[1].split('\n先前模型工作摘要')[0]);
  assert.equal(retained.length,1,'a result too large for the budget must still be represented');
  assert.ok(JSON.stringify(retained[0]).length<=1400);
  assert.equal(retained[0].result.status,'succeeded');assert.equal(retained[0].result.exitCode,0);
  assert.equal(retained[0].result.contextTruncated,true);assert.match(retained[0].result.contextPreview,/RESULT_BEGIN/);
  assert.ok(checkpoint.ledger[0].evidenceIncluded);
  return plan;
 }}),{code:'KNOWLEDGE_STALLED'});
 assert.equal(executions,1,'never rerun a side-effecting tool to reread its output');
 assert.equal(turns,2,'cached no-progress retries terminate instead of consuming the round limit');
 assert.equal(original.output.length,38013,'context trimming must not mutate the actual command result');
 assert.equal(run.toolCalls.length,1);
});

test('a single oversized search row remains identifiable and explicitly partial',async()=>{
 const request={type:'search',query:'dataset'},result={type:'search',offset:0,nextOffset:1,entries:[{id:'source-a',excerpt:'SOURCE_BEGIN '+('content '.repeat(1000))}]};
 await K.continuePlan(JSON.stringify({knowledgeRequests:[request]}),{execute:async()=>result,evidenceChars:1000,ask:async prompt=>{
  const retained=JSON.parse(prompt.split('包含此前读取的正文）：')[1].split('\n先前模型工作摘要')[0]);
  assert.equal(retained.length,1);assert.equal(retained[0].result.contextTruncated,true);
  assert.match(retained[0].result.contextPreview,/source-a/);assert.match(retained[0].result.contextPreview,/SOURCE_BEGIN/);
  assert.equal(retained[0].result.nextOffset,1,'do not invent a text cursor for an opaque structured result');
  return '{"actions":[]}';
 }});
});

test('default-equivalent history and evidence cursors reuse the same read and still detect no progress',async()=>{
 for(const type of ['history_read','history_search','evidence_log','library_overview']){
  let executions=0,turns=0;
  const request={type,...(type==='history_read'?{messageId:'m1'}:type==='history_search'?{query:'needle'}:{})};
  const plan=offset=>JSON.stringify({knowledgeRequests:[{...request,...offset}]});
  await assert.rejects(K.continuePlan(plan({}),{execute:async()=>{executions++;return {text:'exact original',nextOffset:null}},ask:async()=>{turns++;return plan({offset:0})}}),{code:'KNOWLEDGE_STALLED'});
  assert.equal(executions,1,type);assert.equal(turns,2,type);
 }
});

test('context-truncated local file pages keep server Unicode cursors and never skip emoji',async()=>{
 const source=Array.from('😀'.repeat(2600)+'完整结尾'),seen=[],request=offset=>JSON.stringify({knowledgeRequests:[{type:'read_file',refKey:'local-fixture',offset}]});
 await K.continuePlan(request(0),{evidenceChars:900,execute:async r=>({type:'local',refKey:r.refKey,offset:r.offset,totalChars:source.length,text:source.slice(r.offset).join(''),nextOffset:null}),ask:async prompt=>{
  const retained=JSON.parse(prompt.split('包含此前读取的正文）：')[1].split('\n先前模型工作摘要')[0]);
  const part=retained.at(-1).result;assert.equal(part.offset,seen.length);
  seen.push(...Array.from(part.text));
  return part.nextOffset===null?'{"actions":[]}':request(part.nextOffset);
 }});
 assert.equal(seen.join(''),source.join(''));
});

test('PDF page reads pass a canonical continuation offset and preserve text-only evidence metadata',async()=>{
 const s=state();s.imports=[{id:'pdf',name:'Document.pdf',projectId:'p'},{id:'foreign-pdf',projectId:'q'}];const calls=[];
 const readPage=async(record,page,offset)=>{calls.push({record,page,offset});return {text:'原页文字',totalChars:24000,nextOffset:offset+4,textAvailable:true,originalRead:true,imagesIncluded:false,readMode:'extracted_text',cursorUnit:'unicode_codepoints'};};
 const first=await K.execute(s,{projectId:'p'},{type:'read_page',recordType:'import',id:'pdf'},{readPage});
 assert.equal(calls[0].record,s.imports[0]);assert.equal(calls[0].page,1);assert.equal(calls[0].offset,0);assert.equal(first.offset,0);
 const next=await K.execute(s,{projectId:'p'},{type:'read_page',recordType:'import',id:'pdf',page:'2',offset:'12000'},{readPage});
 assert.equal(calls[1].page,2);assert.equal(calls[1].offset,12000);assert.equal(next.offset,12000);assert.equal(next.nextOffset,12004);
 for(const result of [first,next]){assert.equal(result.originalRead,true);assert.equal(result.imagesIncluded,false);assert.equal(result.readMode,'extracted_text');assert.equal(result.cursorUnit,'unicode_codepoints');assert.equal(result.textAvailable,true);assert.equal(result.type,'import');}
 await assert.rejects(K.execute(s,{projectId:'p'},{type:'read_page',recordType:'import',id:'foreign-pdf'},{readPage}),/范围/);
 assert.equal(calls.length,2,'an out-of-scope source never reaches the PDF adapter');
});

test('PDF continuation rejects invalid cursors before reading bytes',async()=>{
 const s=state();s.imports=[{id:'pdf',projectId:'p'}];let calls=0;
 for(const offset of [-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'',' ',null,true,{},'1e3','1.2','-1']){
  await assert.rejects(K.execute(s,{projectId:'p'},{type:'read_page',recordType:'import',id:'pdf',offset},{readPage:async()=>{calls++;return {text:'never'}}}),/cursor/);
 }
 for(const page of [0,-1,1.5,'',null,true])await assert.rejects(K.execute(s,{projectId:'p'},{type:'read_page',recordType:'import',id:'pdf',page},{readPage:async()=>{calls++;return {text:'never'}}}));
 assert.equal(calls,0);
});

test('default-equivalent PDF page cursors reuse evidence while a new offset performs a fresh read',async()=>{
 const base={type:'read_page',recordType:'import',id:'pdf'},plan=knowledgeRequests=>JSON.stringify({knowledgeRequests}),calls=[];let turn=0;
 const equivalent=[base,{...base,page:1,offset:0},{...base,page:'1',offset:'0'}];
 await K.continuePlan(plan(equivalent),{execute:async request=>{calls.push(request);return {type:'import',id:'pdf',page:1,offset:Number(request.offset||0),text:Number(request.offset)?'LAST':'FIRST',nextOffset:Number(request.offset)?null:12000};},ask:async prompt=>{
  if(++turn===1){assert.match(prompt,/FIRST/);return plan([{...base,page:1,offset:12000}]);}
  assert.match(prompt,/FIRST/);assert.match(prompt,/LAST/);
  if(turn===2)return plan([{...base,page:'1',offset:'0'}]);
  return '{"actions":[]}';
 }});
 assert.equal(calls.length,2);assert.equal(Number(calls[0].offset||0),0);assert.equal(calls[1].offset,12000);assert.equal(turn,3);
});

test('repeating a default-equivalent PDF cursor is detected as stalled, not fresh work',async()=>{
 const base={type:'read_page',recordType:'import',id:'pdf'},plan=offset=>JSON.stringify({knowledgeRequests:[{...base,...offset}]});let calls=0,turns=0;
 await assert.rejects(K.continuePlan(plan({}),{execute:async()=>{calls++;return {type:'import',id:'pdf',page:1,offset:0,text:'original',nextOffset:null}},ask:async()=>{turns++;return plan({page:'1',offset:'0'})}}),{code:'KNOWLEDGE_STALLED'});
 assert.equal(calls,1);assert.equal(turns,2);
});

test('context-truncated PDF text preserves Unicode codepoint continuation and ledger positions',async()=>{
 const source=Array.from('😀原文'.repeat(350)+'完整结尾'),seen=[],base={type:'read_page',recordType:'import',id:'pdf',page:1},request=offset=>JSON.stringify({knowledgeRequests:[{...base,offset}]});let checkpoints=0;
 await K.continuePlan(request(0),{evidenceChars:1000,execute:async r=>({type:'import',id:'pdf',page:1,offset:r.offset,totalChars:source.length,text:source.slice(r.offset).join(''),nextOffset:null,originalRead:true,imagesIncluded:false,textAvailable:true,readMode:'extracted_text',cursorUnit:'unicode_codepoints'}),onCheckpoint:value=>{
  checkpoints++;for(const row of value.ledger)assert.equal(row.end,source.length,'raw evidence ledger uses the server cursor unit');
 },ask:async prompt=>{
  const retained=JSON.parse(prompt.split('包含此前读取的正文）：')[1].split('\n先前模型工作摘要')[0]),part=retained.at(-1).result;
  assert.equal(part.offset,seen.length);assert.equal(part.imagesIncluded,false);assert.equal(part.readMode,'extracted_text');
  seen.push(...Array.from(part.text));
  return part.nextOffset===null?'{"actions":[]}':request(part.nextOffset);
 }});
 assert.ok(checkpoints>1);assert.equal(seen.join(''),source.join(''));
});

const pdfRequests=count=>Array.from({length:count},(_,i)=>({type:'read_page',recordType:'import',id:'synthetic-pdf',page:i+1}));
const toolPlan=knowledgeRequests=>JSON.stringify({knowledgeRequests,actions:[]});
test('33 and 65 independent page reads use sequential scheduler batches with bounded concurrency and ordered evidence',async()=>{
 const S=require('../app/tool-scheduler');
 for(const count of [33,65]){
  const run={},batches=[],completed=[],notifications=[];let active=0,peak=0,asks=0,checkpoints=0;
  const scheduler=S.create({run,execute:async request=>{
   peak=Math.max(peak,++active);await new Promise(resolve=>setTimeout(resolve,request.page%3));active--;completed.push(request.page);
   return {type:'import',id:request.id,page:request.page,text:'Evidence '+request.page,nextOffset:null};
  }});
  await K.continuePlan(toolPlan(pdfRequests(count)),{batch:async requests=>{
   assert.equal(active,0,'the previous batch has settled');assert.equal(completed.length,batches.reduce((a,b)=>a+b,0));batches.push(requests.length);return scheduler.batch(requests);
  },onResult:(request,result)=>{assert.equal(result.page,request.page);notifications.push(request.page);},onCheckpoint:checkpoint=>{
   checkpoints++;assert.equal(checkpoint.round,1,'batching does not spend extra model rounds');assert.deepEqual(checkpoint.ledger.map(row=>row.page),Array.from({length:count},(_,i)=>i+1));
  },ask:async prompt=>{
   asks++;assert.equal(completed.length,count);assert.equal(run.toolCalls.length,count);assert.ok(run.toolCalls.every(call=>call.status==='completed'));
   const retained=JSON.parse(prompt.split('包含此前读取的正文）：')[1].split('\n先前模型工作摘要')[0]);assert.deepEqual(retained.map(row=>row.result.page),Array.from({length:count},(_,i)=>i+1));return '{"message":"done","actions":[]}';
  }});
  assert.deepEqual(batches,count===33?[32,1]:[32,32,1]);assert.ok(peak>1&&peak<=3);assert.equal(asks,1);assert.equal(checkpoints,1);assert.deepEqual(notifications,Array.from({length:count},(_,i)=>i+1));
 }
});
test('large plans deduplicate canonical page requests before scheduling and still detect repeated no-progress reads',async()=>{
 const base=pdfRequests(33),requests=base.flatMap(r=>[r,{...r,page:String(r.page),offset:'0'}]),batches=[];let executions=0,asks=0;
 await assert.rejects(K.continuePlan(toolPlan(requests),{batch:async chunk=>{batches.push(chunk.length);executions+=chunk.length;return chunk.map(r=>({type:'import',id:r.id,page:r.page,text:'Evidence '+r.page,nextOffset:null}));},ask:async()=>{asks++;return toolPlan(requests);}}),{code:'KNOWLEDGE_STALLED'});
 assert.deepEqual(batches,[32,1]);assert.equal(executions,33);assert.equal(asks,2);
});
test('an invalid final item rejects the whole plan before any earlier tool executes and diagnostics contain no model text',async()=>{
 const sensitive='synthetic private request body';
 for(const invalid of [null,[],{},'bad',{type:7,body:sensitive},{type:'   ',body:sensitive},{type:'read_page',id:sensitive,offset:-1}]){
  let calls=0;
  await assert.rejects(K.continuePlan(toolPlan([...pdfRequests(32),invalid]),{batch:async()=>{calls++;return[];},execute:async()=>{calls++;},ask:async()=>{calls++;}}),error=>{
   assert.equal(error.code,'INVALID_KNOWLEDGE_REQUESTS');assert.deepEqual(error.knowledgeDiagnostic,{version:1,code:'INVALID_KNOWLEDGE_REQUESTS',requestCount:33,batchLimit:32,invalidCount:1,invalidIndices:[32]});assert.doesNotMatch(JSON.stringify(error.knowledgeDiagnostic),/private|body|synthetic/);return true;
  });assert.equal(calls,0);
 }
});
test('non-array tool plans have precise diagnostics while an empty array still finalizes normally',async()=>{
 for(const value of [null,'private body',{type:'read'}])await assert.rejects(K.continuePlan(toolPlan(value),{finalize:()=>{throw Error('not a final plan');}}),error=>{
  assert.equal(error.code,'INVALID_KNOWLEDGE_REQUESTS');assert.deepEqual(error.knowledgeDiagnostic,{version:1,code:'INVALID_KNOWLEDGE_REQUESTS',requestCount:null,batchLimit:32,invalidContainer:true,invalidCount:1,invalidIndices:[]});return true;
 });
 let finalized=0;const output=toolPlan([]);assert.equal(await K.continuePlan(output,{finalize:()=>{finalized++;return null;}}),output);assert.equal(finalized,1);
});
test('invalid-request diagnostics bound index detail without silently ignoring later errors',async()=>{
 await assert.rejects(K.continuePlan(toolPlan(Array(100).fill({type:null,content:'private'})),{}),error=>{
  assert.equal(error.knowledgeDiagnostic.invalidCount,100);assert.equal(error.knowledgeDiagnostic.requestCount,100);assert.deepEqual(error.knowledgeDiagnostic.invalidIndices,Array.from({length:32},(_,i)=>i));assert.doesNotMatch(JSON.stringify(error.knowledgeDiagnostic),/private/);return true;
 });
});
test('oversized plans with commands, live browser actions, delegation or unknown types do not execute or silently split',async()=>{
 for(const type of ['terminal','browser_observe','browser_click','delegate','unknown-private-text']){
  let calls=0;
  await assert.rejects(K.continuePlan(toolPlan([...pdfRequests(32),{type,argv:['private argument'],task:'private task'}]),{batch:async()=>{calls++;},execute:async()=>{calls++;}}),error=>{
   assert.equal(error.code,'KNOWLEDGE_BATCH_REQUIRES_SPLIT');assert.deepEqual(error.knowledgeDiagnostic,{version:1,code:'KNOWLEDGE_BATCH_REQUIRES_SPLIT',requestCount:33,batchLimit:32,nonReadOnlyCount:1,nonReadOnlyIndices:[32]});assert.doesNotMatch(JSON.stringify(error.knowledgeDiagnostic),/private|argv|task|unknown/);return true;
  });assert.equal(calls,0);
 }
});
test('cancellation or a changed scope between read batches starts no later tools and preserves saved receipts',async()=>{
 const S=require('../app/tool-scheduler');
 for(const kind of ['cancel','scope']){
  const controller=new AbortController(),run={},snapshots=[];let valid=true,asks=0,executions=0,batches=0;
  const validate=()=>{if(!valid)throw Object.assign(Error('scope changed'),{code:'CANCELLED'});};
  const scheduler=S.create({run,signal:controller.signal,validate,checkpoint:async()=>{snapshots.push(JSON.parse(JSON.stringify(run.toolCalls)));},execute:async request=>{executions++;return {page:request.page,receiptId:'receipt-'+request.page};}});
  await assert.rejects(K.continuePlan(toolPlan(pdfRequests(65)),{signal:controller.signal,validate,batch:async requests=>{
   batches++;const result=await scheduler.batch(requests);if(kind==='cancel')controller.abort();else valid=false;return result;
  },ask:async()=>{asks++;}}),{code:'CANCELLED'});
  assert.equal(batches,1);assert.equal(executions,32);assert.equal(asks,0);assert.equal(run.toolCalls.length,32);assert.ok(run.toolCalls.every(row=>row.status==='completed'&&row.result.receiptId));assert.deepEqual(snapshots.at(-1),run.toolCalls);
 }
});
test('a receipt checkpoint failure prevents later read batches without replaying successful reads',async()=>{
 const S=require('../app/tool-scheduler'),run={},saveError=Error('disk full');let failed=false,executions=0,batches=0,asks=0;
 const scheduler=S.create({run,checkpoint:async()=>{if(!failed&&run.toolCalls.length===32&&run.toolCalls.every(row=>row.status==='completed')){failed=true;throw saveError;}},execute:async request=>{executions++;return {page:request.page,receiptId:'receipt-'+request.page};}});
 await assert.rejects(K.continuePlan(toolPlan(pdfRequests(65)),{batch:requests=>{batches++;return scheduler.batch(requests);},ask:async()=>{asks++;}}),error=>error===saveError);
 assert.equal(batches,1);assert.equal(executions,32);assert.equal(asks,0);assert.equal(run.toolCalls.length,32);assert.ok(run.toolCalls.every(row=>row.status==='completed'&&row.result.receiptId));
});
test('large reads remain serial and cancellable without a scheduler adapter',async()=>{
 const controller=new AbortController();let calls=0,asks=0;
 await assert.rejects(K.continuePlan(toolPlan(pdfRequests(65)),{signal:controller.signal,execute:async()=>{if(++calls===32)controller.abort();return {text:'received'};},ask:async()=>{asks++;}}),{code:'CANCELLED'});
 assert.equal(calls,32);assert.equal(asks,0);
});
test('scheduler hard limit and ordinary mixed-tool sequencing remain unchanged',async()=>{
 const S=require('../app/tool-scheduler');let calls=0;
 await assert.rejects(S.create({run:{},execute:async()=>{calls++;}}).batch(pdfRequests(33)),/每批最多 32/);assert.equal(calls,0);
 const run={},seen=[],scheduler=S.create({run,execute:async request=>{seen.push(request.type);return {status:'completed'};}});
 await K.continuePlan(toolPlan([{type:'read',id:'a'},{type:'terminal',argv:['pwd']},{type:'browser_observe',tabId:'synthetic'}]),{batch:scheduler.batch,ask:async()=>'{"message":"done","actions":[]}'});
 assert.deepEqual(seen,['read','terminal','browser_observe']);assert.equal(run.toolCalls.length,3);
});
