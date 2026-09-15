const test=require('node:test'),assert=require('node:assert/strict');const W=require('../app/research-wiki.js'),Core=require('../app/workstation-core.js'),K=require('../app/knowledge-access.js'),D=require('../app/draft-review.js'),E=require('../app/note-editor.js');
let i=0;const uid=p=>p+'-'+(++i);const state=()=>({projects:[{id:'p',workspace:'科研'},{id:'other',workspace:'科研'},{id:'daily',workspace:'日常'}],notes:[],imports:[],tasks:[],links:[],agentRuns:[],conversations:[],trash:[]});
const action={type:'upsert_wiki',wikiType:'experiment',title:'时间采样对照',sections:{hypothesis:'稀疏采样是否漏掉关键帧？',results:'还未运行，未有数值。'},projectId:'p',workspace:'科研'};
const create=s=>Core.applyPlan(s,[action],{uid,protectNoteUpdates:true}).state;
function update(s){const n=s.notes[0],run={};W.trackRead(s,run,{type:'note',id:n.id,offset:0,text:n.content,totalChars:n.content.length});return {action:{...action,noteId:n.id,baseUpdatedAt:n.updatedAt,sections:Object.fromEntries(Object.keys(W.fields('experiment')).map(k=>[k,k==='results'?'观测到一次失败，待复现。':'原有内容保留']))},context:{uid,protectNoteUpdates:true,wikiReadVersions:run.wikiReadVersions}};}
test('Wiki is persistent typed Markdown, titles are scoped, existing paper guides are reused without cloning',()=>{
 let s=create(state());assert.equal(W.typeOf(s.notes[0]),'experiment');assert.match(s.notes[0].content,/代码与数据版本/);assert.match(s.notes[0].content,/推断与待验证结论/);
 s.notes.push({id:'paper',paperId:'paper-record',title:'旧导读',workspace:'科研',content:'已保存',updatedAt:1});assert.equal(W.entries(s).length,2);assert.equal(W.entries(s,{projectId:'p'}).length,1);
 assert.throws(()=>Core.applyPlan(s,[{...action,projectId:'daily'}],{uid}),/科研项目|归属不一致/);
 const other=Core.applyPlan(s,[{...action,projectId:'other'}],{uid}).state;assert.equal(W.entries(other).length,3);
 assert.equal(W.typeOf(JSON.parse(JSON.stringify(s)).notes[0]),'experiment');
});
test('sources require project scope or explicit reference, and deleted sources cannot leak into a Wiki',()=>{
 const s=state();s.notes=[{id:'capture',kind:'随记',workspace:'日常',content:'观察'}];
 assert.throws(()=>Core.applyPlan(s,[{...action,sourceNoteIds:['capture']}],{uid}),/来源/);
 const result=Core.applyPlan(s,[{...action,sourceNoteIds:['capture']}],{uid,explicitReferences:[{type:'note',id:'capture'}]});assert.deepEqual(result.state.notes[1].sourceNoteIds,['capture']);assert.equal(W.related(result.state,result.state.notes[0]).backlinks.length,1);
 s.notes[0].deletedAt=1;assert.throws(()=>Core.applyPlan(s,[{...action,sourceNoteIds:['capture']}],{uid,explicitReferences:[{type:'note',id:'capture'}]}),/来源/);
});
test('Wiki updates require complete same-version reads and preserve approved body until adoption',()=>{
 const s=create(state()),n=s.notes[0],u=update(s);const original=JSON.stringify(s);
 assert.throws(()=>Core.applyPlan(s,[u.action],{uid,protectNoteUpdates:true}),/全部正文/);
 assert.throws(()=>Core.applyPlan(s,[{...u.action,baseUpdatedAt:0}],u.context),/版本/);
 assert.throws(()=>Core.applyPlan(s,[{...u.action,sections:{results:'丢掉其他章节'}}],u.context),/全部章节/);
 const changed=Core.applyPlan(s,[u.action],u.context).state;assert.equal(changed.notes[0].content,n.content);assert.match(changed.notes[0].aiDraft.content,/一次失败/);assert.equal(JSON.stringify(s),original);
 const review=D.begin(changed,n.id);const adopted=D.prepare(changed,review,'adopt');assert.match(adopted.after.content,/一次失败/);assert.equal(adopted.after.revisionHistory.at(-1).content,n.content);assert.ok(!adopted.after.aiDraft);
 const discarded=D.prepare(changed,review,'discard');assert.equal(discarded.after.content,n.content);
});
test('paged read coverage rejects gaps and stale reads, list and search never count as full reading',()=>{
 const s=create(state()),n=s.notes[0];n.content='a'.repeat(25000);const r={};
 W.trackRead(s,r,{type:'note',id:n.id,offset:12000,text:n.content.slice(12000,24000),totalChars:25000});assert.ok(!r.wikiReadVersions);
 W.trackRead(s,r,{type:'note',id:n.id,offset:0,text:n.content.slice(0,12000),totalChars:25000});assert.ok(!r.wikiReadVersions);
 W.trackRead(s,r,{type:'note',id:n.id,offset:24000,text:n.content.slice(24000),totalChars:25000});assert.equal(r.wikiReadVersions[n.id],W.revision(n));
 n.content='b'+n.content.slice(1);assert.notEqual(r.wikiReadVersions[n.id],W.revision(n));
});
test('cross-conversation Wiki discovery is paginated and project-scoped; evidence is readable without old chats',async()=>{
 const s=state();for(let j=0;j<43;j++)W.apply(s,{...action,title:'实验 '+j},{uid,projectId:j===42?'other':'p'});
 const first=await K.execute(s,{projectId:'p',workspace:'科研'},{type:'wiki_list'});assert.equal(first.entries.length,20);assert.equal(first.total,42);assert.equal(first.nextOffset,20);
 const last=await K.execute(s,{projectId:'p',workspace:'科研'},{type:'wiki_list',offset:40});assert.equal(last.entries.length,2);assert.equal(last.nextOffset,null);
 assert.equal(W.catalog(s,{workspace:'日常'}).total,0);await assert.rejects(K.execute(s,{projectId:'other'},{type:'read',recordType:'note',id:first.entries[0].id}),/范围/);
 const read=await K.execute(JSON.parse(JSON.stringify(s)),{projectId:'p'},{type:'read',recordType:'note',id:first.entries[0].id});assert.match(read.text,/稀疏采样/);assert.equal(read.kind,'科研 Wiki/experiment');
 s.projects[0].archived=true;assert.equal(W.catalog(s,{projectId:'p'}).total,0);
});
test('adopting a Wiki proposal merges proposed sources and retains previous provenance; discard does not',()=>{
 const s=create(state()),u=update(s);s.notes.push({id:'origin',workspace:'科研',projectId:'p',title:'依据',content:'原文'});u.action.sourceNoteIds=['origin'];
 const changed=Core.applyPlan(s,[u.action],u.context).state,n=changed.notes[0];assert.deepEqual(n.sourceNoteIds,[]);assert.deepEqual(n.aiDraft.sourceNoteIds,['origin']);
 const review=D.begin(changed,n.id);assert.deepEqual(D.prepare(changed,review,'discard').after.sourceNoteIds,[]);assert.deepEqual(D.prepare(changed,review,'adopt').after.sourceNoteIds,['origin']);
 const session=E.begin(changed,n.id);session.appliedAiDraft=JSON.stringify(n.aiDraft);session.content=n.aiDraft.content;assert.deepEqual(E.prepare(changed,session).after.sourceNoteIds,['origin']);
});
test('a later supplement can extend an existing draft after reading it, preserving earlier draft and approved body',async()=>{
 const s=create(state()),u=update(s),changed=Core.applyPlan(s,[u.action],u.context).state,n=changed.notes[0],previous=n.aiDraft.content;
 const run={};W.trackRead(changed,run,await K.execute(changed,{projectId:'p'},{type:'read',recordType:'note',id:n.id}));
 const next={...u.action,baseUpdatedAt:n.updatedAt,sections:{...u.action.sections,results:'观测到一次失败；新增证据：第二次出现相同症状。'}};
 assert.throws(()=>Core.applyPlan(changed,[next],{uid,protectNoteUpdates:true,...run}),/variant:draft/);
 W.trackRead(changed,run,await K.execute(changed,{projectId:'p'},{type:'read',recordType:'note',id:n.id,variant:'draft'}));
 const output=Core.applyPlan(changed,[next],{uid,protectNoteUpdates:true,...run}).state.notes[0];
 assert.equal(output.content,n.content);assert.equal(output.aiDraftHistory.at(-1).draft.content,previous);assert.match(output.aiDraft.content,/新增证据/);
});

test('generic note actions cannot bypass Wiki read and draft protection',()=>{
 const s=create(state()),id=s.notes[0].id;
 for(const a of [{type:'update_note',noteId:id,patch:{content:'replace'}},{type:'append_note',noteId:id,content:'addition'}])assert.throws(()=>Core.applyPlan(s,[a],{uid,protectNoteUpdates:true}),/upsert_wiki/);
});
test('archived project notes are unavailable as sources and backlinks',()=>{
 const s=create(state());s.notes.push({id:'source',title:'Archived evidence',projectId:'other'});s.notes[0].sourceNoteIds=['source','source'];
 s.notes[1].sourceNoteIds=[s.notes[0].id];s.projects[1].archived=true;
 const links=W.related(s,s.notes[0]);assert.deepEqual(links.sources,[{id:'source',unavailable:true}]);assert.equal(links.backlinks.length,0);
});

test('relative Markdown links resolve stable identities and add backlinks without opening arbitrary paths',()=>{
 const state={projects:[],notes:[{id:'a',workspace:'科研',title:'A',content:'[B](../methods/b.md)'},{id:'b',workspace:'科研',title:'B',content:''}],_wikiFiles:{a:{path:'questions/a.md'},b:{path:'methods/b.md'}}};
 assert.equal(W.resolveLink(state,'a','../methods/b.md'),'b');
 assert.equal(W.resolveLink(state,'a','../../etc/passwd'),null);
 assert.equal(W.resolveLink(state,'a','https://example.com/methods/b.md'),null);
 assert.equal(W.resolveLink(state,'a','file:///tmp/x'),null);
 assert.equal(W.related(state,state.notes[1]).backlinks[0].id,'a');
 state.notes[1].archived=true;assert.equal(W.resolveLink(state,'a','../methods/b.md'),null);
});
