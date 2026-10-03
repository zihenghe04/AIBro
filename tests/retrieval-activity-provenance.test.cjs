'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const R=require('../app/context-retrieval'),V=require('../app/vector-index'),M=require('../app/project-memory'),K=require('../app/knowledge-access'),Evidence=require('../app/citation-evidence');
const scope={projectId:'study'},query='echoquartz resonance comparison';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const cfg=V.configuration({base:'https://fixture.invalid/v1',model:'synthetic',enabled:true,noKey:true});
function fixture(){
 const state={projects:[{id:'study',name:'Fictional research',workspace:'科研'},{id:'other',name:'Other project',workspace:'科研'}],notes:[{id:'ordinary',projectId:'study',title:'Observation',content:'A saved harbor observation.'}],tasks:[],papers:[],imports:[],conversations:[{id:'chat',projectId:'study',messages:[]}],agentRuns:[],trash:[]};
 M.settle(state,{id:'synthetic-readonly',projectId:'study',conversationId:'chat',userMessageId:'synthetic-user',status:'completed',startedAt:Date.UTC(2030,0,2,12),goal:query,results:[],commands:[]});
 const daily=state.notes.find(n=>n.projectMemoryType==='daily'),long=state.notes.find(n=>n.projectMemoryType==='long'),plan=state.notes.find(n=>n.projectMemoryType==='plan');
 long.content+='\nSaved harbor research preference.';long.aiDraft={content:'NEVER_DRAFT_BODY'};
 plan.content+='\nSaved harbor next step.';
 daily.content+='\nManual addition: notebooktrail.';
 return {state,daily,long,plan};
}
const recordIDs=result=>result.entries.map(e=>e.recordId);
async function legacyRows(state){
 // A pre-policy cache contains identical text/hashes but lacks the daily type.
 // Only the isolated clone is changed; originals and their metadata stay intact.
 const old=structuredClone(state);
 for(const note of old.notes)delete note.projectMemoryType;
 return (await V.snapshot(old)).map(e=>({id:e.id,hash:e.hash,vector:[1,0]}));
}

test('actual read-only settle echo is excluded without deleting activity or approved knowledge',async()=>{
 const {state,daily,long,plan}=fixture(),before=JSON.stringify(state);
 assert.ok(daily.content.includes(query));assert.deepEqual(daily.memoryRunIds,['synthetic-readonly']);
 const result=R.searchIndex(state,{...scope,query});
 assert.deepEqual(recordIDs(result),[]);assert.equal(result.coverage.excludedProjectActivityRecords,1);
 assert.equal(result.coverage.eligibleRecords,state.notes.length-1);
 const knowledge=R.searchIndex(state,{...scope,query:'harbor'});
 assert.deepEqual(new Set(recordIDs(knowledge)),new Set(['ordinary',long.id,plan.id]));
 assert.equal(knowledge.entries.find(e=>e.recordId===long.id).projectMemoryType,'long');
 assert.equal(knowledge.entries.find(e=>e.recordId===plan.id).projectMemoryType,'plan');
 assert.doesNotMatch(JSON.stringify(knowledge),/NEVER_DRAFT_BODY/);
 assert.equal(R.buildContext(state,{...scope,query}).entries.some(e=>e.recordId===daily.id),false,'legacy excerpt adapter uses the same evidence policy');
 const catalog=R.listIndex(state,scope);
 assert.equal(catalog.entries.find(e=>e.id===daily.id).projectMemoryType,'daily');
 assert.equal(R.readableRecords(state,scope).some(e=>e.record.id===daily.id),true);
 const read=await K.execute(state,scope,{type:'read',recordType:'note',id:daily.id});
 assert.equal(read.text,daily.content,'explicit access retains both generated and manually added content');
 assert.equal(JSON.stringify(state),before,'retrieval never mutates or migrates the durable notes');
 M.settle(state,{id:'synthetic-readonly-2',projectId:'study',conversationId:'chat',status:'completed',startedAt:Date.UTC(2030,0,2,13),goal:query,results:[],commands:[]});
 assert.deepEqual(daily.memoryRunIds,['synthetic-readonly','synthetic-readonly-2']);
 assert.deepEqual(recordIDs(R.searchIndex(state,{...scope,query})),[]);
});

test('in-place source classification invalidates warm versions without changing read scope',()=>{
 const {state,daily}=fixture(),note=state.notes[0];
 const first=R.searchIndex(state,{...scope,query:'harbor'}).entries.find(e=>e.recordId===note.id);
 note.projectMemoryType='daily';
 assert.equal(R.searchIndex(state,{...scope,query:'harbor'}).entries.some(e=>e.recordId===note.id),false);
 assert.equal(R.indexEntries(state,scope).some(e=>e.recordId===note.id),false);
 assert.equal(R.listIndex(state,scope).entries.find(e=>e.id===note.id).projectMemoryType,'daily');
 assert.throws(()=>R.neighbors(state,scope,{chunkId:first.id,version:first.version}),/更新/,'old cached metadata cannot keep a valid neighbor version');
 assert.equal(R.readableRecords(state,scope).some(e=>e.record.id===note.id),true);
 note.projectMemoryType='long';
 const next=R.searchIndex(state,{...scope,query:'harbor'}).entries.find(e=>e.recordId===note.id);
 assert.ok(next);assert.equal(next.projectMemoryType,'long');assert.notEqual(next.version,first.version);
 assert.equal(R.neighbors(state,scope,{chunkId:next.id,version:next.version}).entries[0].projectMemoryType,'long');
 daily.private=true;
 assert.equal(R.listIndex(state,scope).entries.some(e=>e.id===daily.id),false,'activity visibility still follows privacy');
 daily.private=false;daily.projectId='other';
 assert.equal(R.readableRecords(state,scope).some(e=>e.record.id===daily.id),false,'explicit activity does not widen projects');
});

test('previously persisted journal vectors cannot re-enter hybrid results without an index rebuild',async()=>{
 const {state,daily,long}=fixture(),rows=await legacyRows(state),dailyChunk=rows.find(e=>e.id.includes(encodeURIComponent(daily.id)));
 assert.ok(dailyChunk,'precondition: old persisted vectors contain the daily log');
 let calls=0;
 const engine=V.create({getState:()=>state,store:{load:async()=>structuredClone(rows),write(){throw Error('Search must not rewrite cache');}},embed:async()=>{calls++;return [[1,0]];}});
 const status=await engine.status(cfg);
 assert.ok(status.obsolete>=1);assert.equal(status.pending,0,'ordinary vectors remain usable with their original profile/hash');
 const result=await engine.search(cfg,query,scope);
 assert.equal(result.coverage.strategy,'hybrid-rrf');assert.equal(calls,1);
 assert.equal(result.entries.some(e=>e.recordId===daily.id),false);
 assert.equal(result.entries.find(e=>e.recordId===long.id).projectMemoryType,'long');
 assert.equal(rows.includes(dailyChunk),true,'the fix is current candidate validation, not deleting history or requiring rebuilding');
});

for(const replace of [false,true])test(`classification changed during query await is rechecked (${replace?'replaced state':'same object'})`,async()=>{
 const {state}=fixture(),rows=await legacyRows(state);let current=state,release;
 const engine=V.create({getState:()=>current,store:{load:async()=>rows,write(){throw Error('No writes');}},embed:()=>new Promise(resolve=>{release=resolve;})});
 const pending=engine.search(cfg,'harbor',scope);
 while(!release)await turn();
 if(replace)current=structuredClone(state);
 current.notes[0].projectMemoryType='daily';release([[1,0]]);
 const result=await pending;
 assert.equal(result.entries.some(e=>e.recordId==='ordinary'),false);
 assert.equal(result.entries.some(e=>e.projectMemoryType==='daily'),false);
 assert.equal(result.coverage.excludedProjectActivityRecords,2);
});

test('incremental embedding sends only current knowledge and drops a late daily reclassification',async()=>{
 const {state,daily}=fixture(),persisted=new Map(),inputs=[];let reclassified=false;
 const engine=V.create({getState:()=>state,store:{load:async()=>[...persisted.values()],write:async(_profile,puts=[],removes=[])=>{for(const id of removes)persisted.delete(id);for(const row of puts)persisted.set(row.id,row);}},embed:async(_cfg,texts)=>{
  inputs.push(...texts);if(!reclassified){state.notes[0].projectMemoryType='daily';reclassified=true;}return texts.map(()=>[1,0]);
 }});
 await engine.update(cfg);
 assert.equal(inputs.some(text=>text.includes(query)),false,'query journals are not newly sent to embedding');
 assert.equal(inputs.some(text=>text.includes('Manual addition: notebooktrail')),false);
 assert.equal([...persisted].some(([id])=>id.startsWith('note:ordinary:')||id.includes(encodeURIComponent(daily.id))),false,'awaited embedding cannot persist a reclassified source');
 assert.ok(persisted.size>=2,'saved long and plan still index');
});

async function wrapperFixture({timeout=false}={}){
 const f=fixture(),rows=await legacyRows(f.state),nodes=new Map();let current=f.state,calls=0;
 const element=(id='')=>{
  const node={id,value:'',checked:false,hidden:false,disabled:false,textContent:'',append(child){nodes.set(child.id,child);},querySelectorAll(){return [];},addEventListener(){}};
  Object.defineProperty(node,'innerHTML',{set(html){for(const m of html.matchAll(/\bid="([^"]+)"/g))nodes.set(m[1],element(m[1]));}});return node;
 };
 nodes.set('settings',element('settings'));
 const context={document:{getElementById:id=>nodes.get(id)||null,createElement:()=>element()},localStorage:{getItem:()=>JSON.stringify(cfg),setItem(){throw Error('No settings writes');}},
  ContextRetrieval:R,VectorIndex:{...V,create:options=>V.create({...options,queryTimeoutMs:20})},AbortController,setTimeout,clearTimeout,
  workstationDesktop:{vectorIndex:{load:async()=>rows,write(){throw Error('No persistent vector writes');}}},
  fetch:async()=>{calls++;return timeout?new Promise(()=>{}):{ok:true,json:async()=>({data:[{index:0,embedding:[1,0]}]})};},
 };
 vm.runInNewContext(fs.readFileSync(require.resolve('../app/vector-knowledge-ui'),'utf8'),context);
 context.VectorKnowledge.init({getState:()=>current,isBusy:()=>false});
 return {...f,api:context.VectorKnowledge,setState:value=>{current=value;},calls:()=>calls};
}

test('actual timeout fallback excludes daily and rechecks the replaced current state',async()=>{
 const f=await wrapperFixture({timeout:true}),pending=f.api.searchRequest(f.state,scope,{type:'search',query:'harbor'});
 while(!f.calls())await turn();
 const current=structuredClone(f.state);current.notes[0].projectMemoryType='daily';f.setState(current);
 const result=await pending;
 assert.equal(result.strategy,'local-bm25');assert.equal(result.semanticStatus,'timeout');
 assert.equal(result.entries.some(e=>e.id===f.daily.id||e.id==='ordinary'),false);
 assert.equal(result.coverage.excludedProjectActivityRecords,2);
 assert.equal(result.entries.find(e=>e.id===f.long.id).projectMemoryType,'long','fallback Agent projection preserves source metadata');
 assert.equal(result.entries.find(e=>e.id===f.plan.id).projectMemoryType,'plan');
});

test('healthy Agent wrapper preserves long/plan source types and explicit catalog daily type',async()=>{
 const f=await wrapperFixture(),result=await f.api.searchRequest(f.state,scope,{type:'search',query:'harbor'});
 assert.equal(result.strategy,'hybrid-rrf');assert.equal(result.semanticStatus,'ready');
 assert.equal(result.entries.some(e=>e.id===f.daily.id),false);
 assert.equal(result.entries.find(e=>e.id===f.long.id).projectMemoryType,'long');
 const context=await f.api.retrieve(f.state,{...scope,query:'harbor'});
 const payload=JSON.parse(context.text.slice(context.text.indexOf('\n')+1));
 assert.equal(payload.catalog.find(e=>e.id===f.daily.id).projectMemoryType,'daily');
 assert.equal(payload.entries.some(e=>e.recordId===f.daily.id),false);
});

test('actual manual global search still discovers a daily log and its user-written text',()=>{
 const {state,daily}=fixture();
 const source=fs.readFileSync(require.resolve('../app/app.js'),'utf8'),start=source.indexOf('function searchEntities(query) {'),end=source.indexOf('function searchImportBodyMatch(',start);
 assert.ok(start>=0&&end>start,'use the actual manual-search host, not a duplicate implementation');
 const context={state,window:{CitationEvidence:Evidence},normalize:value=>String(value||'').normalize('NFKC').toLowerCase(),workspaceName:value=>value};
 vm.runInNewContext(source.slice(start,end),context);
 assert.equal(context.searchEntities(query).some(e=>e.type==='note'&&e.id===daily.id),true);
 assert.equal(context.searchEntities('notebooktrail').some(e=>e.type==='note'&&e.id===daily.id),true);
 daily.private=true;assert.equal(context.searchEntities('notebooktrail').some(e=>e.id===daily.id),false);
});
