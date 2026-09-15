const {test}=require('node:test'),assert=require('node:assert/strict');
const F=require('../app/file-context.js'),E=require('../app/local-file-edits.js');
const ref={type:'local',candidateId:'c',projectId:'p',path:'notes/plan.md',version:'v'},state={projects:[{id:'p',localFolder:{id:'c'}}]},run={id:'r',projectId:'p'};
test('updates derive identity from actual references, not generated paths',()=>{const result=E.validate([{operation:'update',refKey:F.key(ref),path:'/evil',version:'invented',content:'# After'}],state,run,{snapshots:[ref],fullyRead:()=>true});assert.equal(result[0].path,ref.path);assert.equal(result[0].version,'v');});
test('incomplete reads, unreferenced edits, disconnected roots and duplicates fail closed',()=>{const e={operation:'update',refKey:F.key(ref),content:'next'};for(const context of [{snapshots:[ref],fullyRead:()=>false},{snapshots:[],fullyRead:()=>true}])assert.throws(()=>E.validate([e],state,run,context));assert.throws(()=>E.validate([e],{projects:[]},run,{snapshots:[ref],fullyRead:()=>true}));assert.throws(()=>E.validate([e,e],state,run,{snapshots:[ref],fullyRead:()=>true}));});
test('creation stays in the current project with a plain relative md/txt path',()=>{const e={operation:'create',projectId:'p',path:'new.md',content:'# New'};assert.equal(E.validate([e],state,run,{}).length,1);for(const path of ['../a.md','/a.md','.env.md','a.exe','a\\b.md'])assert.throws(()=>E.validate([{...e,path}],state,run,{}));assert.throws(()=>E.validate([{...e,projectId:'other'}],state,run,{}));assert.deepEqual(E.validate(undefined,state,run,{}),[]);});
test('full coverage requires reading the middle, not only first and last pages',async()=>{const text='a'.repeat(30000);const context=await F.prepare(state,[ref],{readLocal:async(_,{offset})=>({version:'v',offset,text:text.slice(offset,offset+12000),totalChars:text.length,nextOffset:offset+12000<text.length?offset+12000:null})});assert.equal(context.fullyRead(F.key(ref)),false);await context.read({refKey:F.key(ref),offset:24000});assert.equal(context.fullyRead(F.key(ref)),false);await context.read({refKey:F.key(ref),offset:12000});assert.equal(context.fullyRead(F.key(ref)),true);});
test('server character offsets, not JavaScript UTF-16 length, govern read coverage',async()=>{const context=await F.prepare(state,[ref],{readLocal:async(_,{offset})=>({version:'v',offset,text:'😀'.repeat(Math.min(12000,30000-offset)),totalChars:30000,nextOffset:offset+12000<30000?offset+12000:null})});await context.read({refKey:F.key(ref),offset:24000});assert.equal(context.fullyRead(F.key(ref)),false);await context.read({refKey:F.key(ref),offset:12000});assert.equal(context.fullyRead(F.key(ref)),true);});

test('saved creation follows its original conversation and undo removes the reference',()=>{
 const s={conversations:[{id:'origin',messages:[]},{id:'other',messages:[]}]},r={conversationId:'origin'},e={candidateId:'c',projectId:'p',path:'new.md',beforeVersion:null,afterVersion:'new'};
 E.followUp(s,r,e,'apply');assert.equal(F.references(s.conversations[0])[0].version,'new');assert.equal(F.references(s.conversations[1]).length,0);
 E.followUp(s,r,e,'undo');assert.equal(F.references(s.conversations[0]).length,0);
 E.followUp(s,r,e,'apply');assert.equal(F.references(s.conversations[0]).length,0,'respects explicit exclusion');
});
test('acceptance never rewinds a newer reference or changes historical message snapshots',()=>{
 const c={id:'origin',messages:[{role:'user',fileReferences:[ref]}]},s={conversations:[c]},r={conversationId:c.id},e={...ref,beforeVersion:'v',afterVersion:'v2'};
 E.followUp(s,r,e,'apply');assert.equal(F.references(c)[0].version,'v2');assert.equal(c.messages[0].fileReferences[0].version,'v');
 F.refresh(c,{...ref,version:'v3'});E.followUp(s,r,e,'undo');assert.equal(F.references(c)[0].version,'v3');
});
test('shelf retains pending proposals from failed turns, isolates chats and deduplicates library files',()=>{
 const s={projects:[{id:'p'}],notes:[{id:'n',title:'Current title',projectId:'p',aiDraft:{content:'draft'}}],agentRuns:[
 {id:'old',conversationId:'a',startedAt:1,fileChanges:[{type:'note',id:'n'}],localFileEdits:[{id:'pending',path:'a.md',status:'pending'}],status:'failed'},
 {id:'new',conversationId:'a',startedAt:2,fileChanges:[{type:'note',id:'n'}]},
 {id:'private',conversationId:'b',localFileEdits:[{id:'secret',path:'secret.md'}]}]};
 const rows=E.outputs(s,'a');assert.equal(rows.length,2);assert(rows.every(r=>r.pending));assert.equal(rows.find(r=>r.kind==='note').title,'Current title');
 delete s.notes[0].aiDraft;assert.equal(E.outputs(s,'a').find(r=>r.kind==='note').pending,false);s.projects[0].archived=true;assert.equal(E.outputs(s,'a').length,1);
});

test('code and configuration proposals preserve the same full-read and project checks',()=>{
 for(const path of ['main.py','app.tsx','package.json','config.yaml','Cargo.toml'])assert.equal(E.validate([{operation:'create',projectId:'p',path,content:'plain text'}],state,run,{}).length,1);
 for(const path of ['data.sqlite','paper.pdf','document.docx','.env'])assert.throws(()=>E.validate([{operation:'create',projectId:'p',path,content:'x'}],state,run,{}));
});
test('directory proposals retain project scope and do not become text references',()=>{
 const edit={operation:'mkdir',projectId:'p',path:'outputs'};
 assert.equal(E.validate([edit],state,run,{}).length,1);
 for(const path of ['../outside','/outside','a\\b','.hidden','a//b'])assert.throws(()=>E.validate([{...edit,path}],state,run,{}));
 assert.throws(()=>E.validate([{...edit,projectId:'other'}],state,run,{}));
 const s={conversations:[{id:'origin',messages:[]}]};E.followUp(s,{conversationId:'origin'},{directory:true,...edit},'apply');assert.equal(F.references(s.conversations[0]).length,0);
});
