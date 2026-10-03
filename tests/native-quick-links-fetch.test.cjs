const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {webcrypto, randomUUID} = require('node:crypto');
const Core = require('../app/workstation-core.js');
const CitationEvidence = require('../app/citation-evidence.js');
const ContentLifecycle = require('../app/content-lifecycle.js');
const source = fs.readFileSync(require.resolve('../native/Resources/quick-links.js'),'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const rid = () => 'quick_link_' + randomUUID();
function fixture(options={}) {
  const calls={save:0,network:0,events:[],indexed:[]};
  const context={state:options.state || {imports:[],notes:[],tasks:[],papers:[],links:[],trash:[],attachments:[],agentRuns:[],conversations:[],projects:[{id:'p',name:'Project',workspace:'科研'}],ui:{composerDraft:'keep'}},
    storageHydrated:true,serverConflict:false,purgeTrash:{},URL,TextEncoder,CustomEvent:class {constructor(type,value){this.type=type;this.detail=value.detail;}},
    document:{dispatchEvent(event){calls.events.push(event.detail);}},
    saveDocumentDurably:async()=>{calls.save++; return options.save ? options.save(context,calls) : true;},
    fetch:async(url,input)=>{
      calls.network++; const payload=JSON.parse(input.body);
      assert.equal(url,'/__fetch'); assert.equal(input.method,'POST');
      if (options.fetch) return options.fetch(payload,context,calls);
      return {ok:true,json:async()=>result(payload)};
    }};
  context.window={crypto:webcrypto,WorkstationCore:Core,CitationEvidence,ContentLifecycle,
    PrivateMode:{isOn:()=>!!context.privateMode},PdfTextIndex:{enqueue:id=>calls.indexed.push(id)}};
  vm.runInNewContext(source,context);
  return {get state(){return context.state;},context,calls,request:payload=>context.window.NativeQuickLinks.request(payload)};
}
function result(payload,patch={}) {
  return {id:payload.bookmark.id,bookmarkRequestId:payload.bookmark.requestId,fileStored:true,storedLocally:true,
    name:'Page title',url:payload.url,finalUrl:'https://example.org/redirected',mimeType:'text/html',size:90,
    content:'A real saved paragraph',pages:[],parser:'web',truncated:false,...patch};
}
async function add(f,patch={}) {
  await f.request({action:'add',requestId:rid(),url:'https://example.org/source#section',title:'',folder:'Reading',workspace:'科研',projectId:'p',...patch});
  return f.state.imports.at(-1);
}
async function envelope(f,id) {
  const row=(await f.request({action:'list'})).rows.find(row=>row.id===id);
  return {action:'fetch',requestId:rid(),items:[{id,expectedVersion:row.version}]};
}

test('explicit fetch persists original identity, human title, scope, tags and source references after durable CAS',async()=>{
  let savedBeforeNetwork;
  const f=fixture({fetch:async(payload,ctx,calls)=>{
    assert.equal(calls.save,2); savedBeforeNetwork=copy(ctx.state.imports[0]);
    assert.equal(payload.bookmark.id,savedBeforeNetwork.id); assert.equal(payload.bookmark.identity,savedBeforeNetwork.quickLinkIdentity);
    assert.equal(payload.url,savedBeforeNetwork.url); return {ok:true,json:async()=>result(payload)};
  }});
  const row=await add(f,{title:'My annotated title'}); row.tags=['methods']; f.state.notes.push({id:'note',sourceAttachmentIds:[row.id]});
  const response=await f.request(await envelope(f,row.id));
  assert.equal(response.status,'saved'); assert.equal(response.fetchStatus,'ready'); assert.equal(f.calls.network,1);
  assert.equal(row.name,'My annotated title'); assert.equal(row.url,'https://example.org/source#section'); assert.equal(row.finalUrl,'https://example.org/redirected');
  assert.equal(row.content,'A real saved paragraph'); assert.equal(row.fileStored,true); assert.equal(row.projectId,'p'); assert.deepEqual(copy(row.tags),['methods']);
  assert.equal(row.id,savedBeforeNetwork.id); assert.deepEqual(copy(f.state.notes[0].sourceAttachmentIds),[row.id]); assert.equal(f.state.imports.length,1);
  assert.equal(f.state.ui.composerDraft,'keep'); assert.equal(f.calls.events.at(-1).owner,f.state); assert.equal(f.calls.events.at(-1).action,'fetch');
});
test('untitled bookmark receives real fetched title without another import or automatic initial network access',async()=>{
  const f=fixture(), row=await add(f); assert.equal(f.calls.network,0); assert.equal(row.quickLinkTitleEdited,false);
  await f.request(await envelope(f,row.id)); assert.equal(row.name,'Page title'); assert.equal(row.originalName,'Page title'); assert.equal(f.state.imports.length,1);
});
test('offline failure is saved honestly; manual retry uses latest version and same bookmark ID',async()=>{
  let online=false;
  const f=fixture({fetch:async(payload)=>{if(!online)throw TypeError('offline');return {ok:true,json:async()=>result(payload)};}}),row=await add(f);
  const failed=await f.request(await envelope(f,row.id)); assert.equal(failed.status,'saved'); assert.equal(failed.fetchStatus,'failed');
  assert.equal(row.parser,'bookmark'); assert.equal(row.fileStored,false); assert.equal(row.content,'');
  assert.equal((await f.request({action:'list'})).rows[0].fetchStatus,'failed');
  online=true; const retried=await f.request(await envelope(f,row.id)); assert.equal(retried.fetchStatus,'ready'); assert.equal(f.state.imports.length,1); assert.equal(f.calls.network,2);
});
test('durable save must succeed before any public fetch is submitted',async()=>{
  let allow=true; const f=fixture({save:()=>allow}),row=await add(f); allow=false;
  assert.equal((await f.request(await envelope(f,row.id))).reason,'storage_failed'); assert.equal(f.calls.network,0); assert.equal(row.fileStored,false);
});
test('concurrent title edit, scope reassignment or replacement aborts late content without overwriting the new record',async()=>{
  for (const mutate of [r=>r.name='Later title',r=>r.projectId=null,(r,ctx)=>ctx.state.imports=[{...r}]]) {
    const f=fixture({fetch:async(payload,ctx)=>{mutate(ctx.state.imports[0],ctx);return {ok:true,json:async()=>result(payload)};}}), row=await add(f);
    assert.equal((await f.request(await envelope(f,row.id))).reason,'changed'); assert.equal(f.state.imports[0].content,''); assert.equal(f.state.imports[0].fileStored,false);
  }
});
test('new privacy during download hides rows and refuses late content; no receipt claims saved',async()=>{
  const f=fixture({fetch:async(payload,ctx)=>{ctx.state.projects[0].private=true;return {ok:true,json:async()=>result(payload)};}}),row=await add(f);
  assert.equal((await f.request(await envelope(f,row.id))).reason,'private'); assert.equal(row.content,''); assert.equal((await f.request({action:'list'})).rows.length,0);
});
test('lost final durable ACK replays exact receipt after renderer restart without another network request or title overwrite',async()=>{
  let durable;
  const f=fixture({save:(ctx,calls)=>{durable=copy(ctx.state);return calls.save!==3;}}),row=await add(f),command=await envelope(f,row.id);
  assert.equal((await f.request(command)).reason,'storage_failed'); assert.equal(f.calls.network,1);
  const next=fixture({state:durable}); next.state.imports[0].name='A later human edit';
  assert.equal((await next.request(command)).fetchStatus,'ready'); assert.equal(next.calls.network,0); assert.equal(next.state.imports[0].name,'A later human edit');
});
test('failed network receipt also replays without silently retrying external access',async()=>{
  const f=fixture({fetch:async()=>{throw TypeError('offline');}}),row=await add(f),command=await envelope(f,row.id);
  assert.equal((await f.request(command)).fetchStatus,'failed'); assert.equal((await f.request(command)).fetchStatus,'failed'); assert.equal(f.calls.network,1);
});
test('wrong original or request ACK is a failed attempt, never attached to the bookmark',async()=>{
  for (const patch of [{id:'another'}, {bookmarkRequestId:'other'}, {fileStored:false}, {finalUrl:'file:///private'}]) {
    const f=fixture({fetch:async payload=>({ok:true,json:async()=>result(payload,patch)})}),row=await add(f);
    assert.equal((await f.request(await envelope(f,row.id))).fetchStatus,'failed'); assert.equal(row.fileStored,false); assert.equal(row.parser,'bookmark');
  }
});
test('backend public-network rejection remains an explicit saved failure; never falls back to direct fetch',async()=>{
  const f=fixture({fetch:async()=>({ok:false,json:async()=>({code:'NON_PUBLIC_URL',error:'只能读取公网地址'})})}),row=await add(f,{url:'http://127.0.0.1'});
  assert.equal(f.calls.network,0); const response=await f.request(await envelope(f,row.id));
  assert.equal(response.fetchStatus,'failed'); assert.match(response.fetchError,/公网/); assert.equal(f.calls.network,1); assert.equal(row.fileStored,false);
});
test('existing saved content cannot be overwritten through the bookmark fetch action',async()=>{
  const f=fixture(),row=await add(f); row.fileStored=true; row.content='Saved version'; row.parser='web';
  assert.equal((await f.request(await envelope(f,row.id))).reason,'changed'); assert.equal(f.calls.network,0); assert.equal(row.content,'Saved version');
});
test('PDF download preserves original ID and starts existing local index only after durable metadata',async()=>{
  const f=fixture({fetch:async payload=>({ok:true,json:async()=>result(payload,{mimeType:'application/pdf',content:'',parser:'web-original'})})}),row=await add(f);
  const response=await f.request(await envelope(f,row.id)); assert.equal(response.fetchStatus,'ready'); assert.equal(response.hasText,false);
  assert.equal(row.status,'original-only'); assert.equal(row.indexStatus,'pending'); assert.deepEqual(f.calls.indexed,[row.id]); assert.equal(f.calls.save,3);
});
test('private mode and changed owner block network or discard late output without reopening any editor',async()=>{
  const f=fixture(),row=await add(f),command=await envelope(f,row.id); f.context.privateMode=true;
  assert.equal((await f.request(command)).reason,'private'); assert.equal(f.calls.network,0);
  const other=fixture({fetch:async(payload,ctx)=>{ctx.state=copy(ctx.state);return {ok:true,json:async()=>result(payload)};}}),record=await add(other);
  assert.equal((await other.request(await envelope(other,record.id))).reason,'changed'); assert.equal(other.state.imports[0].content,'');
});
