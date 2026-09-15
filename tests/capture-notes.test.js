const test=require('node:test');const assert=require('node:assert/strict');
const C=require('../app/capture-notes.js'),Core=require('../app/workstation-core.js');
let serial=0;const uid=p=>p+'-'+(++serial);
const base=()=>({notes:[],tasks:[],imports:[],projects:[],links:[],trash:[],conversations:[],agentRuns:[]});
test('capture edits preserve original revisions and reject stale or deleted targets',()=>{
 const s=base(),n=C.write(s,{text:'观察\n试一试 #实验',tags:[' 实验 ','实验']},{uid,now:10});
 const second=C.write(s,{text:n.content},{uid,now:11});assert.notEqual(n.id,second.id,'separate captures never collapse by title');
 const v=n.updatedAt;C.write(s,{id:n.id,version:v,text:'新的观察'},{uid,now:10});
 assert.equal(n.revisionHistory[0].content,'观察\n试一试 #实验');assert.ok(n.updatedAt>v);
 const frozen=JSON.stringify(s);assert.throws(()=>C.write(s,{id:n.id,version:v,text:'旧编辑'},{uid}),/变化/);assert.equal(JSON.stringify(s),frozen);
 n.deletedAt=12;assert.throws(()=>C.write(s,{id:n.id,version:n.updatedAt,text:'已删除'},{uid}),/变化/);
 assert.throws(()=>C.write(s,{text:''},{uid}),/内容/);assert.throws(()=>C.write(s,{text:'x'.repeat(200001)},{uid}),/200,000/);
 assert.equal(C.write(s,{text:'',hasFiles:true},{uid}).title,'附件随记');
});
test('batch selection snapshots source versions, includes every attachment and excludes unavailable sources',()=>{
 const s=base(),a=C.write(s,{text:'alpha',tags:['方法']},{uid}),b=C.write(s,{text:'beta'},{uid});
 s.imports=[{id:'a',name:'原件'}];a.sourceAttachmentIds=['a'];b.sourceAttachmentIds=['a'];
 const picked=C.selection(s,[a.id,b.id]);assert.deepEqual(picked.attachments,['a']);assert.equal(C.selection(s,[b.id,a.id]).key,picked.key);
 a.content='changed';assert.equal(picked.notes[0].content,'alpha');assert.equal(C.search(s,'方法')[0].id,a.id);
 s.imports[0].archived=true;assert.throws(()=>C.selection(s,[a.id]),/附件/);assert.throws(()=>C.selection(s,['missing']),/变化/);
});
test('Agent transformations cannot overwrite, append, delete or title-match original captures',()=>{
 const s=base(),a=C.write(s,{text:'原始想法'},{uid});
 for(const action of [{type:'update_note',noteId:a.id,patch:{content:'changed'}},{type:'append_note',noteId:a.id,content:'added'},{type:'delete_note',noteId:a.id},{type:'create_note',title:a.title,content:'replace',workspace:'日常'}]){
  const original=JSON.stringify(s);assert.throws(()=>Core.applyPlan(s,[action],{protectNoteUpdates:true}),/原始随记/);assert.equal(JSON.stringify(s),original);
 }
 const outcome=Core.applyPlan(s,[{type:'create_note',title:'整理笔记',content:'分析',workspace:'日常'},{type:'create_task',title:'验证这个想法',workspace:'日常'}],{protectNoteUpdates:true,uid});
 C.linkResults(outcome.state,{captureNoteIds:[a.id]},outcome.results);C.linkResults(outcome.state,{captureNoteIds:[a.id]},outcome.results);
 assert.equal(outcome.state.notes[0].content,a.content);assert.deepEqual(outcome.state.notes[1].sourceNoteIds,[a.id]);assert.deepEqual(outcome.state.tasks[0].sourceNoteIds,[a.id]);assert.equal(outcome.state.links.length,2);
 assert.ok(!outcome.state.tasks[0].dueAt,'unknown schedule is not invented');
 assert.deepEqual(JSON.parse(JSON.stringify(outcome.state)).notes[1].sourceNoteIds,[a.id]);
});
test('capture batch filters use local inclusive dates, exact tags and active linked projects',()=>{
 const s=base();s.projects=[{id:'p',name:'Research'},{id:'old',archived:true}];
 const a=C.write(s,{text:'first',tags:['model']},{uid,now:new Date(2026,8,15,0).valueOf()});
 const b=C.write(s,{text:'second',tags:['models']},{uid,now:new Date(2026,8,15,23,59).valueOf()});
 const c=C.write(s,{text:'third',tags:['model']},{uid,now:new Date(2026,8,16).valueOf()});
 s.notes.push({id:'derived',projectId:'p',sourceNoteIds:[a.id]});s.tasks.push({id:'deleted',projectId:'p',sourceNoteIds:[b.id],deletedAt:1});
 s.imports.push({id:'source',projectId:'p'});c.sourceAttachmentIds=['source'];
 const frozen=JSON.stringify(s);
 assert.deepEqual(C.search(s,'',{from:'2026-09-15',to:'2026-09-15'}).map(n=>n.id),[b.id,a.id]);
 assert.deepEqual(C.search(s,'',{tag:'model',project:'p'}).map(n=>n.id),[c.id,a.id]);
 assert.equal(C.search(s,'',{from:'2026-09-16',to:'2026-09-15'}).length,0);
 assert.deepEqual(C.projectIds(s,b),[]);assert.equal(JSON.stringify(s),frozen);
 s.notes.find(n=>n.id==='derived').archived=true;assert.deepEqual(C.projectIds(s,a),[]);
 s.projects[0].archived=true;assert.deepEqual(C.projectIds(s,c),[]);
});
