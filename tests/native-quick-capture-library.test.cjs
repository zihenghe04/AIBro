const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const CaptureNotes=require('../app/capture-notes.js'),CitationEvidence=require('../app/citation-evidence.js'),ContentLifecycle=require('../app/content-lifecycle.js');
const source=fs.readFileSync('native/Resources/quick-capture.js','utf8');
const copy=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {resolve,promise};};
const note=(changes={})=>({id:'capture-1',kind:'随记',title:'课程阅读记录',content:'  原始内容\n逐字保留  ',tags:['课程'],updatedAt:10,createdAt:1,sourceAttachmentIds:['attachment-1'],...changes});
const payload=(changes={})=>({action:'update',id:'capture-1',expectedVersion:10,text:'人工编辑\n保留缩进  ',tags:['研究'],requestId:'quick_capture_edit_01234567-89ab-4cde-8fab-0123456789ab',...changes});
function fixture(options={}){
 const calls={persist:0,write:0,events:[],fetch:[]};
 const context={state:options.state||{notes:[note(),note({id:'output',kind:'整理笔记',title:'分析成果',content:'processed',sourceNoteIds:['capture-1']})],imports:[{id:'attachment-1',name:'合成课件.pdf'}],tasks:[{id:'task',title:'课程任务',sourceNoteIds:['capture-1']}],projects:[],conversations:[],agentRuns:[],trash:[],links:[],ui:{captureDraft:{text:'页面草稿'}}},storageHydrated:true,serverConflict:false,purgeTrash:{syncPaused:false},TextEncoder,
 document:{body:{dataset:{view:'project'}},dispatchEvent:event=>calls.events.push(event)},CustomEvent:class {constructor(type,{detail}){this.type=type;this.detail=detail;}},window:{crypto:webcrypto,PrivateMode:{isOn:()=>!!options.privateMode},CitationEvidence,ContentLifecycle,fetch:async(path,init)=>{calls.fetch.push({path,init});return options.fetch?options.fetch(context):{ok:true,json:async()=>({session:null})};},CaptureNotes:{write(...args){calls.write++;return CaptureNotes.write(...args);}}},
 saveDocumentDurably:async()=>{calls.persist++;return options.persist?options.persist(context,calls):true;}};
 vm.runInNewContext(source,context);return {context,calls,get state(){return context.state;},api:value=>context.window.NativeQuickCapture.library(value)};
}
test('library searches real capture body and tags with pagination; no silent 200-item cap or processed copies',async()=>{
 const f=fixture();f.state.notes.push(...Array.from({length:241},(_,i)=>note({id:'many-'+i,updatedAt:i+100,content:'Ｑｕａｎｔｕｍ 课程 '+i,tags:['标签']})));
 const all=[];let offset=0;do{const page=await f.api({action:'list',query:'quantum 标签',offset});assert.equal(page.status,'ready');assert.equal(page.total,241);assert.ok(page.rows.every(row=>!('content' in row)));all.push(...page.rows);offset=page.nextOffset;}while(offset!==null);
 assert.equal(new Set(all.map(row=>row.id)).size,241);assert.equal(f.calls.persist,0);
 const page=await f.api({action:'list',query:'',offset:0});assert.equal(page.total,242);assert.ok(!page.rows.some(row=>row.id==='output'));
});
test('selection distinguishes original attachments and derived artifacts without leaking private titles',async()=>{
 const f=fixture();f.state.notes.push(note({id:'private-output',kind:'整理笔记',title:'PRIVATE_SECRET',sourceNoteIds:['capture-1'],private:true}));
 f.state.imports.push({id:'private-attachment',name:'PRIVATE_FILE',private:true});f.state.notes[0].sourceAttachmentIds.push('private-attachment');
 const result=copy(await f.api({action:'get',id:'capture-1'}));assert.equal(result.note.content,note().content);assert.deepEqual(result.note.attachments,[{type:'import',id:'attachment-1',title:'合成课件.pdf'}]);assert.deepEqual(result.note.derived.map(item=>item.id),['output','task']);assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
test('manual update uses production revision history/userEdited and retains attachments, provenance, processed artifacts and page draft',async()=>{
 const f=fixture(),before=copy(f.state);f.state.notes[0].provenance={source:'capture'};
 const result=await f.api(payload());assert.equal(result.status,'saved');assert.equal(result.requestId,payload().requestId);assert.equal(f.calls.write,1);assert.equal(f.calls.persist,1);
 const saved=f.state.notes[0];assert.equal(saved.content,payload().text);assert.equal(saved.userEdited,true);assert.equal(saved.revisionHistory[0].content,before.notes[0].content);assert.deepEqual(saved.sourceAttachmentIds,before.notes[0].sourceAttachmentIds);assert.deepEqual(saved.provenance,{source:'capture'});assert.deepEqual(f.state.notes[1],before.notes[1]);assert.deepEqual(f.state.ui.captureDraft,before.ui.captureDraft);
 assert.ok(!JSON.stringify(f.state.ui.nativeQuickCaptureEditReceipts).includes(payload().text));
});
test('stale expected version and ambiguous/private/deleted owners are rejected before mutation',async()=>{
 for(const mutate of [f=>f.state.notes[0].updatedAt++,f=>f.state.notes[0].private=true,f=>f.state.notes[0].deletedAt=3,f=>f.state.notes.push(note()),f=>{f.state.projects.push({id:'p',private:true});f.state.notes[0].projectId='p';}]){
  const f=fixture();mutate(f);const before=copy(f.state);assert.notEqual((await f.api(payload())).status,'saved');assert.equal(f.calls.write,0);assert.deepEqual(f.state,before);
 }
});
test('durable commit followed by lost ACK retries same receipt after bridge restart without a second revision',async()=>{
 let saved;const first=fixture({persist:ctx=>{saved=copy(ctx.state);throw Error('lost ACK');}});assert.equal((await first.api(payload())).reason,'storage_failed');
 const second=fixture({state:saved});assert.equal((await second.api(payload())).status,'saved');assert.equal(second.calls.write,0);assert.equal(second.state.notes[0].revisionHistory.length,1);
 second.state.notes[0].content='later human edit';assert.equal((await second.api(payload())).reason,'changed');assert.equal(second.state.notes[0].content,'later human edit');
});
test('pending duplicate shares one request; concurrent distinct expected-version edit cannot overwrite first',async()=>{
 const gate=deferred(),started=deferred(),f=fixture({persist:()=>{started.resolve();return gate.promise;}});
 const one=f.api(payload()),same=f.api(payload());assert.equal(one,same);await started.promise;
 assert.equal((await f.api(payload({text:'changed envelope'}))).reason,'busy');
 assert.equal((await f.api(payload({requestId:'quick_capture_edit_11234567-89ab-4cde-8fab-0123456789ab'}))).reason,'changed');gate.resolve(true);assert.equal((await one).status,'saved');assert.equal(f.calls.write,1);
});
test('late private, deletion, state replacement or same-version body mutation cannot ACK an edit',async()=>{
 for(const mutate of [f=>f.window.PrivateMode.isOn=()=>true,f=>f.state.notes[0].deletedAt=3,f=>f.state=fixture().state,f=>f.state.notes[0].content='a later replacement']){
  const f=fixture({persist:ctx=>{mutate(ctx);return true;}});const result=await f.api(payload());assert.notEqual(result.status,'saved');assert.equal(result.note,undefined);
 }
});
test('privacy mode and malformed actions reveal no notes and never persist',async()=>{
 const f=fixture({privateMode:true});for(const value of [{action:'list',query:'',offset:0},{action:'get',id:'capture-1'},payload()])assert.equal((await f.api(value)).reason,'private');assert.equal(f.calls.persist,0);
 const publicF=fixture();for(const value of [payload({requestId:'__proto__'}),payload({expectedVersion:-1}),payload({tags:[1]}),{action:'list',query:'',offset:-1},{action:'get',id:'capture-1',body:true}])assert.equal((await publicF.api(value)).reason,'invalid');assert.equal(publicF.calls.write,0);
});
test('only strict durable true ACK clears a save, and immutable request body survives caller mutation',async()=>{
 for(const ack of [false,undefined,null,{ok:true}]){const f=fixture({persist:()=>ack});assert.equal((await f.api(payload())).reason,'storage_failed');}
 const f=fixture(),request=payload(),promise=f.api(request);request.text='mutated';request.tags.push('mutated');const result=await promise;assert.equal(result.note.content,payload().text);assert.deepEqual(copy(result.note.tags),payload().tags);
});
const lifecycleId=index=>'quick_capture_lifecycle_'+String(index).padStart(8,'0')+'-89ab-4cde-8fab-0123456789ab';
async function removePayload(f,index=1){const row=await f.api({action:'get',id:'capture-1'});return {action:'remove',id:row.note.id,expectedVersion:row.note.updatedAt,expectedRecordVersion:row.note.recordVersion,requestId:lifecycleId(index)};}
async function restorePayload(f,index=2){const row=(await f.api({action:'trash'})).trash[0];return {action:'restore',trashId:row.id,expectedVersion:row.version,requestId:lifecycleId(index)};}
test('title-only update trims a manual title, revisions the title, and old envelopes preserve it',async()=>{
 const f=fixture(),body=f.state.notes[0].content,tags=f.state.notes[0].tags;
 const result=await f.api(payload({title:'  课程摘要  ',text:body,tags}));assert.equal(result.status,'saved');assert.equal(result.note.title,'课程摘要');assert.match(result.note.recordVersion,/^sha256:[a-f0-9]{64}$/);
 assert.equal(f.state.notes[0].titleSource,'user');assert.equal(f.state.notes[0].content,body);assert.equal(f.state.notes[0].revisionHistory[0].title,note().title);
 const next=await f.api(payload({expectedVersion:result.version,text:'New body',tags,requestId:'quick_capture_edit_11234567-89ab-4cde-8fab-0123456789ab'}));assert.equal(next.note.title,'课程摘要');
 assert.equal(f.calls.events.at(-1).detail.collection,'notes');assert.equal(f.calls.events.at(-1).detail.operation,'update');
});
test('malformed independent titles are rejected without writes or persistence',async()=>{
 const f=fixture();for(const title of ['', '  ', undefined,null,1,'x'.repeat(501),'bad\nTitle','\u0000'])assert.equal((await f.api(payload({title}))).reason,'invalid');
 assert.equal(f.calls.write,0);assert.equal(f.calls.persist,0);
});
test('full record versions are canonical and catch metadata changes without a timestamp change',async()=>{
 const f=fixture(),request=await removePayload(f),original=f.state.notes[0];
 f.state.notes[0]=Object.fromEntries(Object.entries(original).reverse());assert.equal((await f.api({action:'get',id:'capture-1'})).note.recordVersion,request.expectedRecordVersion);
 f.state.notes[0].tags.push('external update');assert.equal((await f.api(request)).reason,'changed');assert.equal(f.calls.persist,0);assert.equal(f.state.trash.length,0);
});
test('single delete uses production lifecycle, preserves live object identities, and fully restores sources and relationships',async()=>{
 const f=fixture(),owner=f.state,noteBefore=copy(owner.notes[0]),output=owner.notes[1],imports=owner.imports,task=owner.tasks[0];
 owner.conversations=[{id:'conversation',messages:[{id:'stream',content:'still streaming'}]}];const conversation=owner.conversations[0],message=conversation.messages[0],draft=owner.ui.captureDraft;
 owner.links=[{id:'derived',sourceId:'capture-1',sourceType:'note',targetId:'output',targetType:'note',relation:'derived-from-capture'}];owner.lastResults=[{type:'note',id:'capture-1'},{type:'task',id:'task'}];
 const request=await removePayload(f),result=await f.api(request);assert.equal(result.status,'saved');assert.equal(result.action,'remove');assert.equal(result.id,'capture-1');assert.equal(result.trashId,'trash_'+request.requestId);
 assert.equal(f.state,owner);assert.equal(owner.notes[0],output);assert.equal(owner.imports,imports);assert.equal(owner.tasks[0],task);assert.equal(owner.conversations[0],conversation);assert.equal(conversation.messages[0],message);assert.equal(owner.ui.captureDraft,draft);assert.equal(owner.links.length,0);
 assert.equal(owner.trash[0].data.notes[0].content,noteBefore.content);assert.deepEqual(owner.trash[0].data.notes[0].sourceAttachmentIds,noteBefore.sourceAttachmentIds);
 assert.equal(f.calls.fetch[0].path,'/__note-draft?id=capture-1');assert.equal(f.calls.fetch[0].init.method,undefined);
 const recycle=await f.api({action:'trash'});assert.equal(recycle.trash.length,1);assert.match(recycle.trash[0].version,/^sha256:/);assert.equal(recycle.trash[0].title,noteBefore.title);
 const restored=await f.api(await restorePayload(f));assert.equal(restored.status,'saved');assert.equal(restored.action,'restore');assert.equal(owner.notes.find(n=>n.id==='capture-1').content,noteBefore.content);assert.equal(owner.trash.length,0);assert.equal(owner.links[0].id,'derived');assert.equal(owner.notes.find(n=>n.id==='output'),output);assert.equal(owner.conversations[0],conversation);
 assert.deepEqual(f.calls.events.map(e=>e.detail.operation),['delete','restore']);assert.ok(f.calls.events.every(e=>e.detail.owner===owner && e.detail.source==='native-quick-capture'));
});
test('delete protects capture, inline, modal and locally persisted drafts, including changes during draft lookup',async()=>{
 for(const setup of [f=>f.state.ui.captureDraft.id='capture-1',f=>f.context.window.NoteEditor={getInlineDraft:()=>({content:'draft'})},f=>f.context.window.NoteEditor={currentContent:()=>({id:'capture-1',dirty:true})},f=>f.context.document.querySelector=()=>({open:true}),f=>f.context.window.NoteEditor={flushDrafts:async()=>false},f=>f.context.window.fetch=async()=>({ok:true,json:async()=>({session:{id:'capture-1',content:'draft'}})}),f=>f.context.window.fetch=async()=>{f.state.ui.captureDraft.id='capture-1';return {ok:true,json:async()=>({session:null})};}]){
  const f=fixture(),request=await removePayload(f);setup(f);const before=copy(f.state);assert.equal((await f.api(request)).reason,'editor_busy');assert.deepEqual(copy(f.state.notes),before.notes);assert.deepEqual(copy(f.state.trash),before.trash);assert.equal(f.state.ui.nativeQuickCaptureLifecycleReceipts,undefined);assert.equal(f.calls.persist,0);
 }
});
test('missing or failed draft service fails closed and does not erase local recovery slots',async()=>{
 for(const response of [{ok:false},{ok:true,json:async()=>({})}]){const f=fixture({fetch:()=>response}),request=await removePayload(f);assert.equal((await f.api(request)).reason,'unavailable');assert.equal(f.state.trash.length,0);assert.equal(f.calls.persist,0);}
 const f=fixture();delete f.context.window.fetch;assert.equal((await f.api(await removePayload(f))).reason,'unavailable');
});
test('lost delete and restore ACKs retry their exact receipts after restart without repeating lifecycle mutations',async()=>{
 let saved;const first=fixture({persist:ctx=>{saved=copy(ctx.state);throw Error('lost ACK');}}),remove=await removePayload(first);assert.equal((await first.api(remove)).reason,'storage_failed');
 const second=fixture({state:saved});assert.equal((await second.api(remove)).status,'saved');assert.equal(second.state.notes.filter(n=>n.id==='capture-1').length,0);assert.equal(second.state.trash.length,1);assert.equal(second.calls.fetch.length,0);
 const restore=await restorePayload(second);let restoredState;const third=fixture({state:copy(second.state),persist:ctx=>{restoredState=copy(ctx.state);throw Error('lost ACK');}});assert.equal((await third.api(restore)).reason,'storage_failed');
 const fourth=fixture({state:restoredState});assert.equal((await fourth.api(restore)).status,'saved');assert.equal(fourth.state.notes.filter(n=>n.id==='capture-1').length,1);assert.equal(fourth.calls.fetch.length,0);assert.equal((await fourth.api(remove)).reason,'removed');
});
test('old lifecycle receipts never resurrect purged content or acknowledge a same-ID replacement',async()=>{
 const f=fixture(),remove=await removePayload(f);await f.api(remove);const deleted=copy(f.state);f.state.trash=[];assert.equal((await f.api(remove)).reason,'removed');assert.equal(f.state.notes.some(n=>n.id==='capture-1'),false);
 const restoredFixture=fixture({state:deleted}),restore=await restorePayload(restoredFixture);await restoredFixture.api(restore);const original=restoredFixture.state.notes.find(n=>n.id==='capture-1');
 restoredFixture.state.notes=restoredFixture.state.notes.map(n=>n.id==='capture-1'?note({content:original.content,updatedAt:original.updatedAt}):n);assert.equal((await restoredFixture.api(restore)).reason,'collision');
 const secondDelete=await removePayload(restoredFixture,3);await restoredFixture.api(secondDelete);assert.equal((await restoredFixture.api(restore)).reason,'removed');assert.equal(restoredFixture.state.notes.some(n=>n.id==='capture-1'),false);
});
test('recycle projections hide foreign packages and private, archived, missing or ambiguous owners',async()=>{
 const original=fixture();await original.api(await removePayload(original));const deleted=copy(original.state);
 for(const mutate of [s=>s.trash[0].sourceQuickCaptureLifecycleRequestId='foreign',s=>s.trash[0].data.notes[0].private=true,s=>{s.trash[0].data.notes[0].projectId='p';s.projects=[{id:'p',private:true}];},s=>{s.trash[0].data.notes[0].projectId='missing';},s=>{s.trash[0].data.notes[0].projectId='p';s.projects=[{id:'p',archived:true}];},s=>{s.trash[0].data.notes[0].projectId='p';s.projects=[{id:'p'},{id:'p'}];}]){
  const s=copy(deleted);mutate(s);const f=fixture({state:s});assert.deepEqual(copy((await f.api({action:'trash'})).trash),[]);
 }
 const privateF=fixture({state:deleted,privateMode:true});assert.equal((await privateF.api({action:'trash'})).reason,'private');
});
test('restore refuses note collisions and partial relationship recovery without consuming the trash package',async()=>{
 const f=fixture();f.state.links=[{id:'dependency',sourceId:'capture-1',sourceType:'note',targetId:'output',targetType:'note'}];await f.api(await removePayload(f));const request=await restorePayload(f),deleted=copy(f.state);
 f.state.notes=f.state.notes.filter(n=>n.id!=='output');const before=copy(f.state);assert.equal((await f.api(request)).reason,'collision');assert.deepEqual(copy(f.state),before);
 const collision=fixture({state:deleted});collision.state.notes.push(note({content:'different new object'}));assert.equal((await collision.api(request)).reason,'removed');assert.equal(collision.state.trash.length,1);
});
test('strict durable true, owner changes and late privacy gate lifecycle acknowledgements',async()=>{
 for(const ack of [false,null,undefined,{ok:true}]){const f=fixture({persist:()=>ack}),request=await removePayload(f);assert.equal((await f.api(request)).reason,'storage_failed');assert.equal(f.state.trash.length,1);assert.ok(f.state.ui.nativeQuickCaptureLifecycleReceipts[request.requestId]);}
 for(const mutate of [ctx=>ctx.state=copy(ctx.state),ctx=>ctx.window.PrivateMode.isOn=()=>true,ctx=>ctx.state.trash[0].data.notes[0].private=true,ctx=>ctx.state.trash[0].data.notes[0].content='late change']){
  const f=fixture({persist:ctx=>{mutate(ctx);return true;}});assert.notEqual((await f.api(await removePayload(f))).status,'saved');assert.equal(f.calls.events.length,0);
 }
});
test('malformed lifecycle payloads and changed envelopes never mutate canonical notes',async()=>{
 const f=fixture(),request=await removePayload(f),before=copy(f.state);
 for(const value of [{...request,expectedRecordVersion:'v1-no-sha'},{...request,expectedVersion:-1},{...request,requestId:'__proto__'},{...request,extra:true},{action:'trash',query:'secret'}])assert.equal((await f.api(value)).reason,'invalid');assert.deepEqual(f.state,before);
 await f.api(request);assert.equal((await f.api({...request,expectedVersion:11})).reason,'collision');
});
test('pending lifecycle duplicates share one immutable request and reject a second transition',async()=>{
 const gate=deferred(),started=deferred(),f=fixture({persist:()=>{started.resolve();return gate.promise;}}),request=await removePayload(f);
 const first=f.api(request),duplicate=f.api({...request});assert.equal(first,duplicate);request.expectedVersion=100;await started.promise;
 assert.equal((await f.api({...request,requestId:lifecycleId(9)})).reason,'busy');gate.resolve(true);assert.equal((await first).status,'saved');assert.equal(f.calls.persist,1);
});
test('privacy and owner changes during async detail hashing never disclose stale metadata',async()=>{
 for(const mutate of [f=>f.context.window.PrivateMode.isOn=()=>true,f=>f.context.state=copy(f.state),f=>f.state.notes[0].private=true]){
  const f=fixture();let invoked=false;f.context.window.crypto={subtle:{digest:async(...args)=>{if(!invoked){invoked=true;mutate(f);}return webcrypto.subtle.digest(...args);}}};
  const result=await f.api({action:'get',id:'capture-1'});assert.notEqual(result.status,'ready');assert.equal(result.note,undefined);
 }
});
test('concurrent unrelated records during outcome hashing are retained instead of overwritten by a lifecycle clone',async()=>{
 const f=fixture(),request=await removePayload(f);let hashCalls=0;f.context.window.crypto={subtle:{digest:async(...args)=>{hashCalls++;if(hashCalls===3){f.state.notes.push(note({id:'new-capture',content:'new capture during delete'}));f.state.links.push({id:'new-link',sourceId:'new-capture',targetId:'output'});}return webcrypto.subtle.digest(...args);}}};
 assert.equal((await f.api(request)).reason,'changed');assert.ok(f.state.notes.some(n=>n.id==='capture-1'));assert.ok(f.state.notes.some(n=>n.id==='new-capture'));assert.ok(f.state.links.some(n=>n.id==='new-link'));assert.equal(f.state.trash.length,0);assert.equal(f.calls.persist,0);
});
test('title save lost acknowledgement remains compatible with trimmed immutable retry',async()=>{
 let saved;const req=payload({title:'  人工标题  '}),f=fixture({persist:ctx=>{saved=copy(ctx.state);throw Error('lost ACK');}});assert.equal((await f.api(req)).reason,'storage_failed');
 const restored=fixture({state:saved});assert.equal((await restored.api(req)).status,'saved');assert.equal(restored.calls.write,0);assert.equal(restored.state.notes[0].revisionHistory.length,1);assert.equal(restored.state.notes[0].titleSource,'user');
 assert.equal((await restored.api({...req,title:'other title'})).reason,'collision');
});
test('island edits cannot replace an actively edited capture or inline note draft',async()=>{
 for(const setup of [f=>f.state.ui.captureDraft.id='capture-1',f=>f.context.window.NoteEditor={getInlineDraft:()=>({content:'unsaved'})},f=>f.context.document.querySelector=()=>({open:true})]){
  const f=fixture();setup(f);const before=copy(f.state);assert.equal((await f.api(payload({title:'New title'}))).reason,'editor_busy');assert.deepEqual(f.state,before);assert.equal(f.calls.write,0);
 }
});

test('list projects visible metadata without hashing note bodies while get supplies one full CAS fingerprint',async()=>{
 const f=fixture();f.state.notes.push(...Array.from({length:60},(_,i)=>note({id:'bulk-'+i,content:'large content '.repeat(1000),updatedAt:i+20})));let digests=0;
 f.context.window.crypto={subtle:{digest:async(...args)=>{digests++;return webcrypto.subtle.digest(...args);}}};
 const page=await f.api({action:'list',query:'',offset:0});assert.equal(page.status,'ready');assert.equal(page.rows.length,60);assert.equal(digests,0);assert.ok(page.rows.every(row=>!('recordVersion' in row)&&!('content' in row)));
 const detail=await f.api({action:'get',id:'capture-1'});assert.equal(detail.status,'ready');assert.equal(digests,1);assert.match(detail.note.recordVersion,/^sha256:[a-f0-9]{64}$/);assert.equal(detail.note.content,note().content);
});
