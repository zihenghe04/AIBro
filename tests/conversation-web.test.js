const test = require('node:test');
const assert = require('node:assert/strict');
const Web = require('../app/conversation-web');
const response = (id='url-pdf') => ({ ok:true, json:async()=>({id,name:'paper.pdf',mimeType:'application/pdf',size:100,storedLocally:true}) });

test('normal message and Markdown URLs acquire the arXiv original, once per version', () => {
  assert.deepEqual(Web.links('分析 [论文](https://arxiv.org/abs/2605.31468)，还有 https://arxiv.org/pdf/2605.31468。'), ['https://arxiv.org/pdf/2605.31468']);
  assert.deepEqual(Web.links('https://arxiv.org/pdf/2605.31468v1.pdf https://arxiv.org/abs/2605.31468v2'), ['https://arxiv.org/pdf/2605.31468v1','https://arxiv.org/pdf/2605.31468v2']);
  assert.deepEqual(Web.links('分析 https://example.org/foo_(bar). https://example.org/a#part'), ['https://example.org/foo_(bar)','https://example.org/a']);
  assert.equal(Web.sourceURL('https://name:secret@example.org/'), null);
  assert.equal(Web.sourceURL('file:///tmp/p.pdf'), null);
});
test('explicit offline requests do not acquire links or enable search', async()=>{
  for(const goal of ['不要联网，只改写 https://arxiv.org/abs/2605.31468','Do not browse https://example.org']) {
    assert.deepEqual(await Web.acquire({goal,fetch:()=>{throw Error('network must not run');}}),[]);
    assert.equal(Web.searchSupported('openai-auth','',goal),false);
  }
});
test('official auth/API search capability does not leak to compatible proxy providers',()=>{
  assert.equal(Web.searchSupported('openai-auth','','分析论文'),true);
  assert.equal(Web.searchSupported('api','https://api.openai.com/v1','分析论文'),true);
  assert.equal(Web.searchSupported('api','https://api.openai.com.other.example/v1','分析论文'),false);
  assert.equal(Web.searchSupported('api','https://chat.example/v1','分析论文'),false);
});
test('paper intent is separate from course and everyday link intent',()=>{
  assert.equal(Web.isPaperGoal('看看 https://arxiv.org/abs/2605.31468'),true);
  assert.equal(Web.isPaperGoal('请分析这篇文献'),true);
  assert.equal(Web.isPaperGoal('课程 https://example.org/'),false);
});
test('acquisition persists the original, pending analysis and provenance before model delivery',async()=>{
  const writes=[],calls=[],steps=[];
  const items=await Web.acquire({goal:'分析 https://arxiv.org/abs/2605.31468', fetch:async(url,options)=>{calls.push([url,JSON.parse(options.body)]);return response();},onSource:(item,created)=>writes.push([item,created]),stage:(text,status)=>steps.push([text,status])});
  assert.deepEqual(calls,[['/__fetch',{url:'https://arxiv.org/pdf/2605.31468',native:true}]]);
  assert.equal(writes.length,1);assert.equal(writes[0][1],true);
  assert.equal(items[0].workspace,'科研');assert.equal(items[0].projectId,null);assert.equal(items[0].analysis.status,'pending');assert.equal(items[0].fileStored,true);
  assert.equal(items[0].url,'https://arxiv.org/pdf/2605.31468');assert.ok(items[0].fetchedAt);assert.ok(steps.some(([text])=>text.includes('已保存原件')));
});
test('retry reuses saved URL metadata and identity without downloading or touching original ownership',async()=>{
  const item={id:'a',url:'https://arxiv.org/abs/2605.31468',fileStored:true,projectId:'existing',workspace:'科研',name:'DemoGraph.pdf'};const before=JSON.stringify(item);
  const items=await Web.acquire({goal:'https://arxiv.org/pdf/2605.31468',imports:[item],fetch:()=>{throw Error('duplicate download');},onSource:(_item,created)=>assert.equal(created,false)});
  assert.equal(items[0],item);assert.equal(JSON.stringify(item),before);
});
test('archived or failed source records are not revived by URL reuse',async()=>{
  let downloads=0;
  for(const bad of [{archived:true},{deletedAt:123},{status:'parse-error'}]) {
    const items=await Web.acquire({goal:'https://example.org/p.pdf',imports:[{id:'old',url:'https://example.org/p.pdf',fileStored:true,...bad}],fetch:async()=>{downloads++;return response('new');}});
    assert.equal(items[0].id,'new');
  }assert.equal(downloads,3);
});
test('failed link fetch stops before any model analysis or empty source is persisted',async()=>{
  const writes=[];
  await assert.rejects(Web.acquire({goal:'https://example.org/',fetch:async()=>({ok:false,status:404,json:async()=>({error:'not found'})}),onSource:x=>writes.push(x)}),/not found/);
  await assert.rejects(Web.acquire({goal:'https://example.org/',fetch:async()=>({ok:true,json:async()=>({id:'blank',fileStored:true,mimeType:'text/html',content:''})}),onSource:x=>writes.push(x)}),/没有可读取的正文/);
  assert.equal(writes.length,0);
});
test('cancel and deleted target during download never publish the returned source into a conversation',async()=>{
  for(const mode of ['cancel','delete']){
    const controller=new AbortController();let active=true,writes=0;
    await assert.rejects(Web.acquire({goal:'https://example.org/p.pdf',signal:controller.signal,assertActive:()=>{if(!active)throw Error('deleted target');},fetch:async()=>{if(mode==='cancel')controller.abort();else active=false;return response();},onSource:()=>writes++}));
    assert.equal(writes,0);
  }
});
test('request mode waits for per-run network approval; refusal never downloads',async()=>{
  let approved=0;
  await assert.rejects(Web.acquire({goal:'https://example.org',permissionMode:'request',confirmRead:async()=>{approved++;return false;},fetch:()=>{throw Error('must not run');}}),e=>e.code==='CANCELLED');
  assert.equal(approved,1);
});
test('partial success remains available and retry only fetches missing URLs',async()=>{
  const saved=[];let attempts=0;
  await assert.rejects(Web.acquire({goal:'https://a.example/p.pdf https://b.example/p.pdf',fetch:async()=>++attempts===1?response('a'):{ok:false,json:async()=>({error:'temporarily unavailable'})},onSource:(item,created)=>{if(created)saved.push(item);}}));
  assert.equal(saved.length,1);
  const results=await Web.acquire({goal:'https://a.example/p.pdf https://b.example/p.pdf',imports:saved,fetch:async()=>{attempts++;return response('b');}});
  assert.equal(attempts,3);assert.deepEqual(results.map(x=>x.id),['a','b']);
});


test('a saved web image is passed as a native attachment without requiring text extraction',async()=>{
 const items=await Web.acquire({goal:'请分析 https://example.org/diagram.png',fetch:async()=>({ok:true,json:async()=>({id:'image',name:'diagram.png',mimeType:'image/png',fileStored:true,size:12})})});
 assert.equal(items[0].mimeType,'image/png');assert.equal(items[0].status,'original-only');assert.equal(items[0].analysis.status,'pending');
});
