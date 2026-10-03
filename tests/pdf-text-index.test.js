const test=require('node:test');const assert=require('node:assert/strict');
const Pdf=require('../app/pdf-text-index');const Retrieval=require('../app/context-retrieval');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function fixture(texts=['中文正文'],record={},options={}){
 const state={projects:[{id:'p',workspace:'课程'}],imports:[{id:'pdf',name:'lesson.pdf',mimeType:'application/pdf',fileStored:true,status:'original-only',content:'',pages:[],projectId:'p',...record}]};
 let durable=structuredClone(state),calls=[],saves=[],hash='a'.repeat(64),queue;
 const fetch=async(url,init)=>{
  assert.ok(url.startsWith('/__files/pdf/read-text?'),'only the loopback original endpoint is permitted');assert.equal(init.cache,'no-store');assert.ok(init.signal);
  const q=new URL(url,'http://127.0.0.1').searchParams,page=Number(q.get('page')),offset=Number(q.get('offset'));calls.push({page,offset,source:q.get('source')});
  if(options.beforeRead)await options.beforeRead({page,offset,state,queue});
  if(q.get('source')&&q.get('source')!==hash)return {ok:false,status:409,json:async()=>({error:'source changed',code:'PDF_SOURCE_CHANGED'})};
  let currentPage=page,currentOffset=offset,remaining=100000;const parts=[];
  while(currentPage<=texts.length&&parts.length<10&&remaining>0){
   const value=texts[currentPage-1]??'',characters=[...value],text=characters.slice(currentOffset,currentOffset+remaining).join('');
   const end=currentOffset+[...text].length,nextOffset=end<characters.length?end:null;
   parts.push({page:currentPage,offset:currentOffset,text,totalChars:characters.length,nextOffset});remaining-=[...text].length;
   if(nextOffset!==null){currentOffset=nextOffset;break;}currentPage++;currentOffset=0;
  }
  return {ok:true,json:async()=>({parts,pageCount:texts.length,nextPage:currentPage>texts.length?null:currentPage,nextOffset:currentPage>texts.length?null:currentOffset,sourceHash:hash})};
 };
 queue=Pdf.create({getState:()=>state,fetch,persist:async()=>{saves.push(structuredClone(state.imports[0]));if(options.persist)await options.persist(state,saves);durable=structuredClone(state);return true;},setTimer:()=>1,clearTimer(){},readable:r=>!r.private,...options.queue});
 return {state,queue,calls,saves,get durable(){return durable;},set hash(v){hash=v;}};
}
test('old original-only and abandoned pending imports become searchable body text using local extraction',async()=>{
 for(const record of [{},{indexStatus:'pending',indexingToken:'abandoned'}]){
  const f=fixture(['既存课程的非标题正文关键词'],record);await f.queue.pump();const r=f.state.imports[0];
  assert.equal(r.indexStatus,'ready');assert.equal(r.pages[0].text,'既存课程的非标题正文关键词');assert.equal(r.content,'','one durable copy');assert.equal(r.textIndex.status,'complete');
  assert.equal(Retrieval.searchIndex(f.state,{workspace:'课程',query:'非标题正文关键词'}).entries[0].recordId,'pdf');
  const count=f.calls.length;await f.queue.pump();assert.equal(f.calls.length,count,'complete PDFs are not scanned again');
 }
});
test('long Unicode pages and more than 500 pages survive complete indexing without character or page truncation',async()=>{
 const dense='字🧪'.repeat(88000)+'TAIL_UNIQUE',texts=[dense,...Array.from({length:501},(_,i)=>'page'+i)];const f=fixture(texts);await f.queue.pump();
 const r=f.state.imports[0];assert.equal(r.pages.length,502);assert.equal(r.pages[0].text,dense);assert.equal(r.pages.at(-1).text,'page500');assert.equal(r.contentTruncated,false);assert.equal(r.pageCount,502);
 assert.ok(f.saves.length<60,'checkpoint batches, never one full-state write per page');assert.ok(f.calls.some(c=>c.offset===100000));
});
test('checkpoint resumes after restart, pins the original SHA and avoids extracting already saved pages again',async()=>{
 const texts=Array.from({length:14},(_,i)=>'page '+(i+1));let f;
 f=fixture(texts,{}, {beforeRead:({page})=>{if(page===11)f.queue.stop();}});await f.queue.pump();
 const saved=f.durable.imports[0];assert.equal(saved.textIndex.nextPage,11);assert.equal(saved.pages.length,10);assert.equal(saved.indexStatus,'partial');
 const resumed=fixture(texts,saved);await resumed.queue.pump();assert.deepEqual(resumed.calls.map(x=>x.page),[1,11]);assert.equal(resumed.state.imports[0].pages.length,14);
 assert.ok(resumed.calls.slice(1).every(x=>x.source==='a'.repeat(64)));
});
test('a changed original invalidates the checkpoint and never mixes versions',async()=>{
 const f=fixture(['NEW1','NEW2'],{pages:[{page:1,text:'OLD1'}],textIndex:{version:1,status:'indexing',sourceHash:'b'.repeat(64),pageCount:2,nextPage:2},indexStatus:'partial'});await f.queue.pump();assert.deepEqual(f.state.imports[0].pages.map(p=>p.text),['NEW1','NEW2']);
});
test('source mutation between pages reports failure without pretending remaining content is indexed',async()=>{
 let f;f=fixture(Array.from({length:12},()=> 'old'),{}, {beforeRead:({page})=>{if(page===11)f.hash='b'.repeat(64);}});await f.queue.pump();assert.equal(f.state.imports[0].indexStatus,'failed');assert.equal(f.state.imports[0].textIndex.errorCode,'PDF_SOURCE_CHANGED');assert.equal(f.state.imports[0].pages.length,10);
 const count=f.calls.length;await f.queue.pump();assert.equal(f.calls.length,count,'one failed attempt per process');
});
test('ready is never visible until complete text persistence has acknowledged, and a failed save rolls back',async()=>{
 const ack=deferred();const f=fixture(['saved'],{}, {persist:async(state,saves)=>{if(saves.length===1)await ack.promise;}});
 const pending=f.queue.pump();await tick();assert.equal(f.state.imports[0].indexStatus,'saving');assert.equal(f.durable.imports[0].pages.length,0);ack.resolve();await pending;assert.equal(f.state.imports[0].indexStatus,'ready');assert.equal(f.durable.imports[0].pages[0].text,'saved');
 const failed=fixture(['lost'],{}, {persist:async()=>{throw Error('disk full');}});await failed.queue.pump();assert.equal(failed.state.imports[0].pages.length,0);assert.notEqual(failed.state.imports[0].indexStatus,'ready');assert.equal(failed.durable.imports[0].pages.length,0);
});
test('delete, move, archive, privacy change and human content edits invalidate an in-flight job',async()=>{
 for(const change of [s=>s.imports=[],s=>s.imports[0].projectId='other',s=>s.imports[0].archived=true,s=>s.imports[0].private=true,s=>s.imports[0].content='human correction']){
  const hold=deferred();const f=fixture(['extracted'],{}, {beforeRead:()=>hold.promise});const pending=f.queue.pump();await tick();change(f.state);const expected=structuredClone(f.state);hold.resolve();await pending;assert.deepEqual(f.state,expected);assert.equal(f.saves.length,0);const count=f.calls.length;await f.queue.pump();assert.equal(f.calls.length,count,'do not automatically overwrite a human change');
 }
});
test('healthy legacy text and scanned completed PDFs are not repeatedly re-extracted',async()=>{
 const f=fixture(['do not overwrite'],{content:'human corrected text',status:'parsed'});await f.queue.pump();assert.equal(f.calls.length,0);
 const scan=fixture(['','']);await scan.queue.pump();assert.equal(scan.state.imports[0].indexStatus,'unavailable');assert.deepEqual(scan.state.imports[0].textIndex.pagesWithoutText,[1,2]);const count=scan.calls.length;await scan.queue.pump();assert.equal(scan.calls.length,count);
});
test('truncated legacy text is replaced by full pages, but partial extraction never claims complete',async()=>{
 const f=fixture(['complete tail'],{content:'x'.repeat(60000),status:'parsed'});await f.queue.pump();assert.equal(f.state.imports[0].pages[0].text,'complete tail');assert.equal(f.state.imports[0].contentTruncated,false);
});
test('failed extraction retries only after explicitly enqueued, not every workspace save',async()=>{
 let broken=true;const f=fixture(['later'],{}, {beforeRead:()=>{if(broken)throw Error('temporarily unavailable');}});await f.queue.pump();const count=f.calls.length;await f.queue.pump();assert.equal(f.calls.length,count);broken=false;f.queue.enqueue('pdf');await f.queue.pump();assert.equal(f.state.imports[0].indexStatus,'ready');
});


test('restart finishes the ready acknowledgement when all page text was durable before the final status save failed',async()=>{
 const saved={pages:[{page:1,text:'kept'}],indexStatus:'failed',textIndex:{version:1,status:'failed',sourceHash:'a'.repeat(64),pageCount:1,nextPage:2,completedPages:1}};
 const f=fixture(['kept'],saved);await f.queue.pump();assert.equal(f.state.imports[0].indexStatus,'ready');assert.equal(f.state.imports[0].pages[0].text,'kept');assert.equal(f.calls.length,1);
});
