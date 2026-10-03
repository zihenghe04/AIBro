'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const K=require('../app/knowledge-access'),E=require('../app/citation-evidence'),S=require('../app/tool-scheduler'),R=require('../app/context-retrieval');
const text='Fictional source page two: the spaced retrieval schedule is one, three, seven days.';
const fixture=()=>({projects:[{id:'p',name:'Synthetic Project',workspace:'课程'},{id:'other',name:'Other',workspace:'课程'}],imports:[{id:'pdf',name:'Synthetic.pdf',createdAt:1,projectId:'p',workspace:'课程',mimeType:'application/pdf',fileStored:true,size:300,sourceHash:'original-a',pages:[{page:2,text}]}],notes:[],papers:[],tasks:[],trash:[],conversations:[{id:'chat',projectId:'p',workspace:'课程'}],agentRuns:[]});
const scope={projectId:'p',workspace:'课程',readProjects:[]},request={type:'read_page',recordType:'import',id:'pdf',page:2};
const plan=knowledgeRequests=>JSON.stringify({knowledgeRequests,workingSummary:'Synthetic summary',actions:[]});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function hostValidator(box,run){
 const source=fs.readFileSync(path.join(__dirname,'../app/app.js'),'utf8');
 const cut=(a,b)=>{const start=source.indexOf(a),end=source.indexOf(b,start);assert.ok(start>=0&&end>start);return source.slice(start,end);};
 const context={run,readScope:scope,activeRunController:null,projectIsActive:id=>box.state.projects.some(p=>p.id===id&&!p.archived),window:{ContextRetrieval:R}};
 Object.defineProperty(context,'state',{get:()=>box.state});vm.createContext(context);
 vm.runInContext(cut('function assertRunActive(', '\nlet activeRunController')+'\n'+cut('    const validateToolScope=()=>{','    const executeReadTool=')+'\nglobalThis.validateHost=validateToolScope;',context);
 return context.validateHost;
}
test('production scheduler + current host getter reject whole-state privacy replacement before storing page content',async()=>{
 const box={state:fixture()},run={id:'run',conversationId:'chat',projectId:'p',contextWorkspace:'课程',status:'running'};box.state.agentRuns.push(run);
 const source=fs.readFileSync(path.join(__dirname,'../app/app.js'),'utf8');assert.match(source,/KnowledgeAccess\.execute\(state, toolScope, request, \{\s*getState: \(\) => state,/);
 const started=deferred(),gate=deferred(),scheduler=S.create({run,validate:hostValidator(box,run),execute:r=>K.execute(box.state,scope,r,{getState:()=>box.state,readPage:async()=>{started.resolve();return gate.promise;}})});
 const pending=scheduler.batch([request]);await started.promise;box.state=structuredClone(box.state);box.state.imports[0].private=true;gate.resolve({text,blocks:[{type:'input_image',image_url:'synthetic-only'}],originalRead:true});
 const results=await pending;assert.equal(results[0].code,'KNOWLEDGE_SOURCE_CHANGED');assert.equal(results[0].text,undefined);
 const retained=E.captureRetained(run,[{request,result:results[0]}],box.state);assert.equal(retained[0].result.code,'KNOWLEDGE_SOURCE_CHANGED');assert.doesNotMatch(JSON.stringify({retained,toolCalls:run.toolCalls}),/Fictional source|synthetic-only/);assert.equal(run.evidenceSources,undefined);
});
test('replacement, in-place scope and source changes reject; unchanged clones and unrelated save metadata remain readable',async t=>{
 const mutations={private:s=>s.imports[0].private=true,projectPrivate:s=>s.projects[0].private=true,moved:s=>s.imports[0].projectId='other',deleted:s=>s.imports=[],duplicate:s=>s.imports.push({...s.imports[0]}),source:s=>s.imports[0].sourceHash='original-b',body:s=>s.imports[0].pages[0].text='changed',page:s=>s.imports[0].pages[0].page=3};
 for(const [name,mutate] of Object.entries(mutations))await t.test(name,async()=>{let state=fixture();const gate=deferred(),pending=K.execute(state,scope,request,{getState:()=>state,readPage:()=>gate.promise});state=structuredClone(state);mutate(state);gate.resolve({text});await assert.rejects(pending,e=>e.code==='KNOWLEDGE_SOURCE_CHANGED');});
 await t.test('in-place-content',async()=>{const state=fixture(),gate=deferred(),pending=K.execute(state,scope,request,{readPage:()=>gate.promise});state.imports[0].pages[0].text='mutated';gate.resolve({text});await assert.rejects(pending,e=>e.code==='KNOWLEDGE_SOURCE_CHANGED');});
 await t.test('stable-reload',async()=>{let state=fixture();const gate=deferred(),pending=K.execute(state,scope,request,{getState:()=>state,readPage:()=>gate.promise});state=JSON.parse(JSON.stringify(state));Object.assign(state.imports[0],{updatedAt:500,tags:['new-tag'],name:'Renamed.pdf'});gate.resolve({text,originalRead:true});const result=await pending;assert.equal(result.text,text);assert.equal(result.title,'Renamed.pdf');assert.equal(result.page,2);assert.equal(JSON.stringify(result).includes('knowledgeReadCurrent'),false);});
});
test('explicit reference allows its original cross-project read but never a mid-read reassignment',async()=>{
 let state=fixture();state.imports[0].projectId='other';const explicit={...scope,explicitReferences:[{type:'import',id:'pdf'}]};
 const okay=await K.execute(state,explicit,request,{readPage:async()=>({text})});assert.equal(okay.text,text);
 const gate=deferred(),pending=K.execute(state,explicit,request,{getState:()=>state,readPage:()=>gate.promise});state=structuredClone(state);state.imports[0].projectId='p';gate.resolve({text});await assert.rejects(pending,e=>e.code==='KNOWLEDGE_SOURCE_CHANGED');
});
test('retained page text/image, search rows and local source are removed on current permissions; nonrecord diagnostics survive',async()=>{
 let state=fixture();state.projects[0].localFolder={id:'folder'};
 const run={id:'r',fileReferences:[{refKey:'local-file',type:'local',projectId:'p',candidateId:'folder',path:'draft.md'}]},page=await K.execute(state,scope,request,{getState:()=>state,readPage:async()=>({text,originalRead:true})});
 const nonrecord=[{request:{type:'terminal'},result:{status:'succeeded',text:'kept terminal'}},{request:{type:'capabilities'},result:{text:'kept instructions'}},{request,result:{error:'kept read error',code:'HTTP'}}];
 state=structuredClone(state);state.projects[0].private=true;
 const entries=E.captureRetained(run,[{request,result:page,imagesIncluded:true},{request:{type:'search'},result:{entries:[{type:'import',id:'pdf',projectId:'p',excerpt:text}]}},{request:{type:'read_file',refKey:'local-file'},result:{type:'local',refKey:'local-file',text:'private local'}},...nonrecord],state);
 assert.equal(entries[0].imagesIncluded,false);assert.equal(entries[0].result.code,'KNOWLEDGE_SOURCE_CHANGED');assert.deepEqual(entries[1].result.entries,[]);assert.equal(entries[2].result.code,'KNOWLEDGE_SOURCE_CHANGED');assert.deepEqual(entries.slice(3),nonrecord);assert.equal(run.evidenceSources,undefined);assert.doesNotMatch(JSON.stringify(entries),/Fictional source|private local/);
});
test('checkpoint revocation cancels request including image blocks and older working summary',async()=>{
 let state=fixture(),asks=0;const run={id:'r'};
 await assert.rejects(K.continuePlan(plan([request]),{execute:r=>K.execute(state,scope,r,{getState:()=>state,readPage:async()=>({text,originalRead:true,blocks:[{type:'input_image',image_url:'synthetic-only'}]})}),mapRetained:entries=>E.captureRetained(run,entries,state),onCheckpoint:async()=>{state=structuredClone(state);state.imports[0].private=true;},ask:async()=>{asks++;return '{"message":"done","actions":[]}';}}),e=>e.code==='CANCELLED'&&e.reason==='KNOWLEDGE_SOURCE_CHANGED');
 assert.equal(asks,0);assert.equal(E.sourcesFor({runId:'r'},run,state)[0].private,true);
});
test('source mutation after first model request cancels cached evidence before any second request',async()=>{
 let state=fixture(),asks=0;const run={id:'r'};
 await assert.rejects(K.continuePlan(plan([request]),{execute:r=>r.type==='capabilities'?{text:'Synthetic capability'}:K.execute(state,scope,r,{getState:()=>state,readPage:async()=>({text})}),mapRetained:entries=>E.captureRetained(run,entries,state),ask:async()=>{asks++;state=structuredClone(state);state.imports[0].private=true;return plan([{type:'capabilities',name:'tasks'}]);}}),e=>e.code==='CANCELLED');assert.equal(asks,1);
});
test('normal checkpoint refresh preserves exact page text, evidence identity and the selected image budget',async()=>{
 let state=fixture(),asks=0;const run={id:'r'},requests=[request,{...request,page:3},{...request,page:4}];
 await K.continuePlan(plan(requests),{maxImages:2,execute:r=>K.execute(state,scope,r,{getState:()=>state,readPage:async(_item,page)=>({text:text+' '+page,blocks:[{type:'input_image',image_url:'synthetic-'+page}]})}),mapRetained:entries=>E.captureRetained(run,entries,state),onCheckpoint:async()=>{state=structuredClone(state);state.imports[0].updatedAt=99;},ask:async(prompt,images)=>{asks++;assert.match(prompt,/evidenceRef/);assert.match(prompt,/Fictional source/);assert.deepEqual(images.map(x=>x.image_url),['synthetic-3','synthetic-4']);return '{"message":"done","actions":[]}';}});
 assert.equal(asks,1);assert.equal(run.evidenceSources.length,3);
});
test('checkpoint scope filtering of previously supplied search text cancels instead of resending stale summary',async()=>{
 let state=fixture(),asks=0;await assert.rejects(K.continuePlan(plan([{type:'search',query:'fiction'}]),{execute:async()=>({type:'search',entries:[{type:'import',id:'pdf',projectId:'p',excerpt:text}]}),mapRetained:entries=>E.captureRetained({id:'r'},entries,state),onCheckpoint:async()=>{state=structuredClone(state);state.imports[0].projectId='other';},ask:async()=>{asks++;return '{}';}}),e=>e.code==='CANCELLED');assert.equal(asks,0);
});
test('checkpoint validates omitted read evidence and never resends its previous model summary',async()=>{
 let state=fixture(),asks=0,checkpoint=0;state.imports.push({...structuredClone(state.imports[0]),id:'pdf-b'});const run={id:'r'};
 await assert.rejects(K.continuePlan(plan([request]),{evidenceChars:2000,execute:r=>K.execute(state,scope,r,{getState:()=>state,readPage:async item=>({text:(item.id==='pdf'?'A':'B').repeat(1200)})}),mapRetained:entries=>E.captureRetained(run,entries,state),validateRetained:entries=>E.validateRetained(run,entries,state),onCheckpoint:async value=>{if(++checkpoint===2){assert.equal(value.ledger.find(x=>x.id==='pdf').evidenceIncluded,false);state=structuredClone(state);state.imports=state.imports.filter(x=>x.id!=='pdf');}},ask:async()=>{asks++;return JSON.stringify({knowledgeRequests:[{...request,id:'pdf-b'}],workingSummary:'OLDER_SOURCE_A_SUMMARY',actions:[]});}}),e=>e.code==='CANCELLED'&&e.reason==='KNOWLEDGE_SOURCE_CHANGED');assert.equal(asks,1);assert.equal(checkpoint,2);
});
test('omitted generic record evidence uses current-state validation without falsely archiving its full text',async()=>{
 let state=fixture(),asks=0;const run={id:'r'},long='OMITTED_NOTE_TEXT'.repeat(200);state.notes.push({id:'n',projectId:'p',content:long});
 await assert.rejects(K.continuePlan(plan([{type:'read',recordType:'note',id:'n'},request]),{evidenceChars:1400,execute:async r=>r.type==='read'?{type:'note',id:'n',projectId:'p',text:long}:K.execute(state,scope,r,{getState:()=>state,readPage:async()=>({text:text.repeat(8)})}),mapRetained:entries=>E.captureRetained(run,entries,state),validateRetained:entries=>E.validateRetained(run,entries,state),onCheckpoint:async()=>{assert.ok(!run.evidenceSources.some(s=>s.id==='n'));state=structuredClone(state);state.notes[0].private=true;},ask:async()=>{asks++;return '{}';}}),e=>e.code==='CANCELLED');assert.equal(asks,0);assert.ok(!run.evidenceSources.some(s=>s.id==='n'));
});
