const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../app/workstation-core'),L=require('../app/content-lifecycle'),P=require('../app/permission-policy');
const fixture=()=>({projects:[{id:'p',workspace:'日常'},{id:'q',workspace:'科研'}],imports:[{id:'old',name:'old.pdf',workspace:'日常',projectId:'p',updatedAt:1},{id:'new',name:'new.pdf',workspace:'日常',projectId:'p'},{id:'foreign',name:'private.pdf',workspace:'科研',projectId:'q'}],attachments:[{id:'old',name:'old.pdf'}],notes:[{id:'n',title:'keep',content:'source evidence',sourceAttachmentIds:['old'],projectId:'p'}],tasks:[],papers:[],links:[{id:'link',sourceId:'old',sourceType:'import',targetId:'n',targetType:'note'}],conversations:[{id:'c',attachments:['old','new']}],agentRuns:[],trash:[]});
const context=s=>({projectId:'p',workspace:'日常',attachmentSnapshots:C.attachmentSnapshots(s,{projectId:'p',workspace:'日常'})});
test('attachment delete uses recoverable lifecycle, preserves derived notes and restores memberships',()=>{
 const s=fixture(),before=JSON.stringify(s),a=[{type:'delete_attachment',attachmentId:'old'}];
 assert.equal(P.needsApproval({mode:'smart',actions:a}),true);assert.equal(P.needsApproval({mode:'full',actions:a}),false);
 const result=C.applyPlan(s,a,context(s));assert.equal(JSON.stringify(s),before);
 assert.deepEqual(result.state.imports.map(x=>x.id),['new','foreign']);assert.equal(result.state.notes[0].content,'source evidence');
 assert.deepEqual(result.state.conversations[0].attachments,['new']);assert.equal(result.state.attachments.length,0);
 assert.equal(result.results[0].operation,'deleted');assert.equal(result.state.trash[0].type,'content');
 const restored=L.restore(result.state,result.state.trash[0].id).state;
 assert.equal(restored.imports.find(x=>x.id==='old').name,'old.pdf');assert.deepEqual(restored.conversations[0].attachments,['old','new']);assert.equal(restored.links.length,1);
});
test('delete rejects invented, cross-project, stale or duplicate targets atomically',()=>{
 for(const id of ['foreign','missing']){const s=fixture();assert.throws(()=>C.applyPlan(s,[{type:'delete_attachment',attachmentId:id}],context(s)),/允许删除范围/);}
 const s=fixture(),ctx=context(s);s.imports[0].name='user latest.pdf';assert.throws(()=>C.applyPlan(s,[{type:'delete_attachment',attachmentId:'old'}],ctx),/发生变化/);
 const moved=fixture(),scope=context(moved);moved.projects[0].workspace='课程';assert.throws(()=>C.applyPlan(moved,[{type:'delete_attachment',attachmentId:'old'}],scope),/允许删除范围/);
 const t=fixture(),before=JSON.stringify(t);assert.throws(()=>C.applyPlan(t,[{type:'delete_attachment',attachmentId:'old'},{type:'delete_attachment',attachmentId:'old'}],context(t)),/重复删除/);assert.equal(JSON.stringify(t),before);
});
test('rename then trash in one validated plan preserves the renamed recovery copy',()=>{
 const s=fixture();const r=C.applyPlan(s,[{type:'rename_attachment',attachmentId:'old',newName:'superseded.pdf'},{type:'delete_attachment',attachmentId:'old'}],context(s));
 assert.equal(r.state.trash[0].data.imports[0].name,'superseded.pdf');
});
