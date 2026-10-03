'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const M=require('../app/project-memory'),K=require('../app/knowledge-access'),R=require('../app/context-retrieval');
const fixture=()=>({projects:[{id:'p',name:'Fictional transit study',workspace:'科研',description:'Compare fictional waiting experiences'},{id:'q',name:'Fictional botany study',workspace:'科研'}],
 notes:[],tasks:[],conversations:[{id:'c',projectId:'p',messages:[{id:'m',role:'user',text:'CURRENT_QUESTION_ONLY_729'}]}],trash:[]});
function settled(){const s=fixture();M.settle(s,{id:'run',projectId:'p',conversationId:'c',userMessageId:'m',startedAt:Date.UTC(2031,5,1),status:'completed',goal:'CURRENT_QUESTION_ONLY_729',results:[],
 memoryUpdates:[{type:'question',text:'UNAPPROVED_HYPOTHESIS_311',quote:'CURRENT_QUESTION_ONLY_729',conversationId:'c',messageId:'m'}]});return s;}
const request=type=>JSON.stringify({knowledgeRequests:[{type}],actions:[]});

test('actual settle keeps daily/history, while automatic context excludes the current question and proposed draft',()=>{
 const s=settled(),daily=s.notes.find(n=>n.projectMemoryType==='daily'),long=s.notes.find(n=>n.projectMemoryType==='long');
 daily.content+='\nHand-written journal paragraph must remain.';long.content+='\nConfirmed project preference.';
 const before=JSON.stringify(s),automatic=M.context(s,'p',{purpose:'automatic'}),explicit=M.context(s,'p');
 assert.deepEqual(new Set(automatic.entries.map(n=>n.type)),new Set(['long','plan']));
 assert.match(automatic.text,/Confirmed project preference/);assert.doesNotMatch(automatic.text,/CURRENT_QUESTION_ONLY_729|UNAPPROVED_HYPOTHESIS_311|Hand-written journal/);
 assert.match(explicit.text,/CURRENT_QUESTION_ONLY_729/);assert.match(explicit.text,/Hand-written journal paragraph/);assert.match(explicit.evidenceNotice,/用户提问.*不等于原始材料/);
 assert.doesNotMatch(explicit.text,/UNAPPROVED_HYPOTHESIS_311/);assert.equal(explicit.entries.find(n=>n.id===long.id).pendingDraft,true);
 assert.equal(JSON.stringify(s),before,'both purposes are projections; no cleanup/migration of saved records');
});

test('approved plan content remains automatic with an outstanding draft, unknown memory kinds stay explicit',()=>{
 const s=settled(),plan=s.notes.find(n=>n.projectMemoryType==='plan');plan.content+='\nAPPROVED_PLAN';plan.aiDraft={content:'PENDING_PLAN_ONLY'};
 s.notes.push({id:'custom',projectId:'p',projectMemoryType:'custom',title:'Legacy custom memory',content:'CUSTOM_HISTORY'});
 assert.match(M.context(s,'p',{purpose:'automatic'}).text,/APPROVED_PLAN/);
 assert.doesNotMatch(M.context(s,'p',{purpose:'automatic'}).text,/PENDING_PLAN_ONLY|CUSTOM_HISTORY/);
 assert.match(M.context(s,'p').text,/CUSTOM_HISTORY/);
});

test('automatic and explicit cursors each reconstruct their own complete stream, including daily warnings on later pages',async()=>{
 const s=settled();s.notes.find(n=>n.projectMemoryType==='long').content='CONFIRMED_BEGIN\n'+'x'.repeat(33000)+'\nCONFIRMED_END';
 s.notes.find(n=>n.projectMemoryType==='daily').content+='\n'+'z'.repeat(18000)+'\nJOURNAL_END';
 for(const purpose of ['automatic','explicit']){
  let joined='',offset=0,pages=0;do{const page=M.context(s,'p',{purpose,offset});joined+=page.text;offset=page.nextOffset;pages++;if(purpose==='explicit')assert.match(page.evidenceNotice,/原始材料/);}while(offset!==null);
  assert.ok(pages>2);assert.equal(joined,M.context(s,'p',{purpose,limit:100000}).text);assert.match(joined,/CONFIRMED_END/);
  if(purpose==='automatic')assert.doesNotMatch(joined,/JOURNAL_END/);else assert.match(joined,/JOURNAL_END/);
 }
 const first=await K.execute(s,{projectId:'p'},{type:'memory_read'}),next=await K.execute(s,{projectId:'p'},{type:'memory_read',offset:first.nextOffset});
 assert.equal(first.purpose,'explicit');assert.equal(first.text+next.text,M.context(s,'p',{limit:32000}).text);
 assert.throws(()=>M.context(s,'p',{offset:-1}),/分页位置/);assert.throws(()=>M.context(s,'p',{limit:0}),/分页长度/);
});

test('current project, workspace, duplicate identity, private owners and tombstones retain ordinary read boundaries',async()=>{
 const mutations=[s=>s.projects[0].private=true,s=>s.projects[0].archivedAt=1,s=>s.projects[0].tombstone=true,s=>s.projects.push({...s.projects[0]}),s=>s.notes.forEach(n=>n.private=true),s=>s.notes.forEach(n=>n.deleted=true),s=>s.notes.forEach(n=>n.wikiFileError='missing')];
 for(const mutate of mutations){const s=settled();mutate(s);for(const purpose of ['automatic','explicit'])assert.equal(M.context(s,'p',{purpose}).entries.length,0);assert.equal((await K.execute(s,{projectId:'p'},{type:'memory_read'})).entries.length,0);}
 const s=settled();assert.equal(M.context(s,'p',{purpose:'automatic',scope:{projectId:'p',workspace:'课程'}}).entries.length,0);
 assert.equal(M.context(s,'p',{scope:{projectId:'q'}}).entries.length,0);assert.equal(M.context(s,'missing').entries.length,0);
 const grant=R.createReadScope(s,{projectId:'p'},'读取项目“Fictional botany study”');
 assert.equal(grant.readProjects.length,1);s.projects[1].name='Renamed botany';assert.equal(M.context(s,'p',{scope:grant}).entries.length,0);
});

test('daily log privacy follows its source conversation, while public approved memory remains readable',()=>{
 const s=settled();s.conversations[0].private=true;
 const context=M.context(s,'p');assert.deepEqual(new Set(context.entries.map(n=>n.type)),new Set(['long','plan']));assert.doesNotMatch(context.text,/CURRENT_QUESTION/);
 s.conversations=[];s.trash=[{data:{conversations:[{id:'c',private:true}]}}];assert.doesNotMatch(M.context(s,'p').text,/CURRENT_QUESTION/);
});

test('explicit note read and indexed search preserve memory provenance without labeling the daily question as source fact',async()=>{
 const s=settled(),long=s.notes.find(n=>n.projectMemoryType==='long'),daily=s.notes.find(n=>n.projectMemoryType==='daily');long.content+='\nConfirmed kumquat baseline.';
 const read=await K.execute(s,{projectId:'p'},{type:'read',id:daily.id});assert.equal(read.projectMemoryType,'daily');assert.match(read.evidenceNotice,/执行记录/);assert.equal(read.text,daily.content);
 const search=await K.execute(s,{projectId:'p'},{type:'search',query:'kumquat'});assert.equal(search.entries[0].projectMemoryType,'long');
 assert.equal((await K.execute(s,{projectId:'p'},{type:'search',query:'CURRENT_QUESTION_ONLY_729'})).entries.length,0);
 const list=await K.execute(s,{projectId:'p'},{type:'list'});assert.equal(list.entries.find(n=>n.id===daily.id).projectMemoryType,'daily');
});

test('memory_read is revalidated after checkpoint and refuses to send newly private contents',async()=>{
 const s=settled();let asks=0;
 await assert.rejects(K.continuePlan(request('memory_read'),{execute:r=>K.execute(s,{projectId:'p'},r),onCheckpoint:async()=>{s.projects[0].private=true;},ask:async()=>{asks++;return '{"actions":[]}';}}),e=>e.code==='CANCELLED'&&e.reason==='KNOWLEDGE_SOURCE_CHANGED');
 assert.equal(asks,0);
});

test('late project move or daily content change cannot resend retained logs and model summaries',async()=>{
 for(const mutate of [s=>s.notes.find(n=>n.projectMemoryType==='daily').projectId='q',s=>s.notes.find(n=>n.projectMemoryType==='daily').content+='\nUpdated journal']){
  let s=settled(),asks=0;await assert.rejects(K.continuePlan(request('memory_read'),{execute:r=>K.execute(s,{projectId:'p'},r,{getState:()=>s}),ask:async()=>{asks++;s=structuredClone(s);mutate(s);return JSON.stringify({workingSummary:'CURRENT_QUESTION_ONLY_729',knowledgeRequests:[{type:'list'}]});}}),e=>e.reason==='KNOWLEDGE_SOURCE_CHANGED');assert.equal(asks,1);
 }
});

test('same-content state replacement and unrelated timestamps do not revoke an explicit read',async()=>{
 let s=settled();const result=await K.execute(s,{projectId:'p'},{type:'memory_read'},{getState:()=>s});
 s=structuredClone(s);for(const note of s.notes)note.updatedAt+=1000;
 assert.equal(K.validateReadResult(result),result);assert.equal(K.readValidationFailures([result],s).size,0);
 assert.equal(Object.getOwnPropertySymbols(result).length,1);assert.equal(Object.getOwnPropertySymbols(JSON.parse(JSON.stringify(result))).length,0,'ephemeral authority does not leak into saved JSON');
});

test('ordinary note provenance is rechecked before retain; current and draft snapshots remain independent',async()=>{
 const s=fixture();s.notes.push({id:'note',projectId:'p',title:'Synthetic note',content:'SAME_BODY',aiDraft:{content:'PROPOSED_BODY'}});
 const current=await K.execute(s,{projectId:'p'},{type:'read',id:'note'}),draft=await K.execute(s,{projectId:'p'},{type:'read',id:'note',variant:'draft'});
 assert.equal(current.projectMemoryType,undefined);assert.equal(current.evidenceNotice,undefined);assert.equal(K.readValidationFailures([current,draft],s).size,0);
 s.notes[0].aiDraft.content='NEW_DRAFT';assert.equal(K.validateReadResult(current),current);assert.throws(()=>K.validateReadResult(draft),e=>e.code==='KNOWLEDGE_SOURCE_CHANGED');
 s.notes[0].projectMemoryType='daily';assert.throws(()=>K.validateReadResult(current),e=>e.code==='KNOWLEDGE_SOURCE_CHANGED');
 const fresh=await K.execute(s,{projectId:'p'},{type:'read',id:'note'});assert.equal(fresh.projectMemoryType,'daily');assert.match(fresh.evidenceNotice,/不等于原始材料/);
 delete s.notes[0].projectMemoryType;let asks=0;
 await assert.rejects(K.continuePlan(JSON.stringify({knowledgeRequests:[{type:'read',id:'note'}]}),{
  execute:r=>K.execute(s,{projectId:'p'},r),onCheckpoint:async()=>{s.notes[0].projectMemoryType='daily';},ask:async()=>{asks++;return '{"actions":[]}';}
 }),e=>e.reason==='KNOWLEDGE_SOURCE_CHANGED');assert.equal(asks,0,'old unmarked ordinary text must not reach the provider after reclassification');
});

test('browser loading uses the real earlier retrieval module and fails closed when it is absent',()=>{
 const source=fs.readFileSync(require.resolve('../app/project-memory'),'utf8'),c={};vm.runInNewContext(source,c);
 assert.equal(c.ProjectMemory.context(settled(),'p').entries.length,0);
 const actual={};vm.runInNewContext(fs.readFileSync(require.resolve('../app/context-retrieval'),'utf8'),actual);vm.runInNewContext(source,actual);
 assert.equal(actual.ProjectMemory.context(settled(),'p',{purpose:'automatic'}).entries.length,2);
 const html=fs.readFileSync(require.resolve('../app/index.html'),'utf8');assert.ok(html.indexOf('src="context-retrieval.js"')<html.indexOf('src="project-memory.js"'));
});
