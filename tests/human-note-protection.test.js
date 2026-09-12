const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../workstation-core');
const fixture = (human = true) => ({
  projects:[{id:'project',name:'Course',workspace:'课程'}],imports:[{id:'source-old',name:'Original.pdf'},{id:'source-new',name:'Increment.pdf'}],tasks:[],papers:[],links:[],trash:[],conversations:[],agentRuns:[],
  notes:[{id:'note',title:'Course summary',content:'Human correction',projectId:'project',workspace:'课程',sourceAttachmentIds:['source-old'],createdAt:10,updatedAt:20,userEdited:human,userEditedAt:human?20:undefined,revisionHistory:[{title:'Course summary',content:'Before correction',savedAt:20,updatedAt:10,userEdited:false}]}],
});
const create = type => ({type,title:'Course summary',content:'New AI analysis',projectId:'project',workspace:'课程',sourceAttachmentIds:['source-new']});

for(const type of ['create_knowledge_item','create_note']) test(`${type} stages changed content and preserves the complete human note`,()=>{
  const state=fixture();const before=JSON.stringify(state);
  const result=Core.applyPlan(state,[create(type)],{now:100});const note=result.state.notes[0];
  assert.equal(note.content,'Human correction');assert.equal(note.title,'Course summary');
  assert.equal(note.userEdited,true);assert.equal(note.userEditedAt,20);
  assert.deepEqual(note.revisionHistory,state.notes[0].revisionHistory);
  assert.deepEqual(note.sourceAttachmentIds,['source-old','source-new']);
  assert.deepEqual(note.aiDraft,{content:'New AI analysis',title:'Course summary',createdAt:100,sourceAttachmentIds:['source-old','source-new']});
  assert.ok(result.results.some(item=>item.id==='note'&&item.operation==='drafted'&&/生成待合并草稿/.test(item.text)));
  assert.equal(result.state.links.some(link=>link.sourceId==='source-new'&&link.targetId==='note'),true);
  assert.equal(JSON.stringify(state),before);
});

test('update_note preserves human title/body and stages the proposed title with its draft',()=>{
  const state=fixture();const result=Core.applyPlan(state,[{type:'update_note',noteId:'note',patch:{title:'AI proposed title',content:'AI changed body'},sourceAttachmentIds:['source-new']}],{now:100});
  const note=result.state.notes[0];assert.equal(note.title,'Course summary');assert.equal(note.content,'Human correction');
  assert.equal(note.aiDraft.title,'AI proposed title');assert.equal(note.aiDraft.content,'AI changed body');
  assert.deepEqual(note.sourceAttachmentIds,['source-old','source-new']);assert.deepEqual(note.revisionHistory,state.notes[0].revisionHistory);
  assert.ok(result.results.some(item=>item.id==='note'&&item.operation==='drafted'));
});

test('identical human content creates no draft, including title-only suggestions',()=>{
  const state=fixture();
  for(const action of [{...create('create_note'),content:'Human correction'},{type:'update_note',noteId:'note',patch:{content:'Human correction',title:'Suggested rename'}}]) {
    const result=Core.applyPlan(state,[action],{now:100});
    assert.equal(result.state.notes[0].aiDraft,undefined);assert.equal(result.state.notes[0].title,'Course summary');
    assert.deepEqual(result.state.notes[0].revisionHistory,state.notes[0].revisionHistory);
    assert.equal(result.results.some(item=>item.operation==='drafted'),false);
  }
});

test('repeated identical AI proposal does not replace the pending draft timestamp or erase human revisions',()=>{
  const first=Core.applyPlan(fixture(),[create('create_note')],{now:100}).state;
  const second=Core.applyPlan(first,[create('create_note')],{now:200}).state;
  assert.deepEqual(second.notes[0].aiDraft,first.notes[0].aiDraft);
  assert.equal(second.notes[0].content,'Human correction');assert.deepEqual(second.notes[0].revisionHistory,first.notes[0].revisionHistory);
});

test('AI updates of machine notes preserve previous content in bounded revision history',()=>{
  let state=fixture(false);
  for(let i=0;i<25;i++) state=Core.applyPlan(state,[{...create('create_knowledge_item'),content:`AI revision ${i}`}],{now:100+i}).state;
  const note=state.notes[0];assert.equal(note.content,'AI revision 24');assert.equal(note.aiDraft,undefined);
  assert.equal(note.revisionHistory.length,20);assert.equal(note.revisionHistory.at(-1).content,'AI revision 23');
  assert.equal(note.revisionHistory.at(-1).savedAt,124);assert.equal(note.revisionHistory.at(-1).updatedAt,123);
  assert.equal(note.revisionHistory.at(-1).userEdited,false);
  const unchanged=Core.applyPlan(state,[{...create('create_note'),content:note.content}],{now:200}).state;
  assert.deepEqual(unchanged.notes[0].revisionHistory,note.revisionHistory);
});

test('update_note title/body changes retain one prior machine version, while empty content is an explicit proposal',()=>{
  const state=fixture(false);
  const result=Core.applyPlan(state,[{type:'update_note',noteId:'note',patch:{title:'New title',content:''}}],{now:100}).state;
  assert.equal(result.notes[0].title,'New title');assert.equal(result.notes[0].content,'');
  assert.equal(result.notes[0].revisionHistory.length,2);assert.equal(result.notes[0].revisionHistory.at(-1).content,'Human correction');
  const human=Core.applyPlan(fixture(),[{...create('create_note'),content:''}],{now:100}).state;
  assert.equal(human.notes[0].content,'Human correction');assert.equal(human.notes[0].aiDraft.content,'');
});

test('invalid draft sources abort the whole transaction and preserve human content',()=>{
  const state=fixture();const before=JSON.stringify(state);
  assert.throws(()=>Core.applyPlan(state,[{type:'update_note',noteId:'note',patch:{content:'AI body'},sourceAttachmentIds:['ghost']}]),/不存在/);
  assert.equal(JSON.stringify(state),before);
});

function paperFixture(human = true) {
  const state=fixture(false);state.notes=[];state.projects[0].workspace='科研';
  const next=Core.applyPlan(state,[{type:'upsert_paper',title:'Paper title',projectId:'project',workspace:'科研',sourceAttachmentIds:['source-old'],structured:{tldr:'First AI summary'}}],{now:30}).state;
  if(human) Object.assign(next.notes[0],{title:'My consolidated paper',content:'# My paper\n\nHuman conclusions and merged evidence.',userEdited:true,userEditedAt:40,updatedAt:40,folderPath:'研究/方向/主笔记',tags:['my-tag'],revisionHistory:[{content:'Earlier complete body'}]});
  return next;
}
const paperUpdate = state => ({type:'upsert_paper',paperId:state.papers[0].id,title:'Updated bibliographic title',workspace:'科研',sourceAttachmentIds:['source-new'],structured:{tldr:'New AI summary',methods:'New method'}});

test('upsert_paper never replaces a human master body/title/history/hierarchy; analysis is a separate draft',()=>{
  const state=paperFixture(), before=JSON.stringify(state);
  const result=Core.applyPlan(state,[paperUpdate(state)],{now:100}), note=result.state.notes[0];
  for(const key of ['id','title','content','userEdited','userEditedAt','revisionHistory','folderPath']) assert.deepEqual(note[key],state.notes[0][key],key);
  assert.ok(note.tags.includes('my-tag'));assert.match(note.aiDraft.content,/New AI summary/);assert.equal(note.aiDraft.title,'Updated bibliographic title');
  assert.deepEqual(note.sourceAttachmentIds,['source-old','source-new']);
  assert.ok(result.results.some(item=>item.type==='note'&&item.operation==='drafted'));
  const again=Core.applyPlan(result.state,[paperUpdate(result.state)],{now:200});assert.deepEqual(again.state.notes[0].aiDraft,note.aiDraft);
  assert.equal(JSON.stringify(state),before);
});

test('machine paper notes retain prior body when updating, and unavailable master notes are not resurrected',()=>{
  const state=paperFixture(false);const result=Core.applyPlan(state,[paperUpdate(state)],{now:100});
  assert.match(result.state.notes[0].content,/New AI summary/);assert.equal(result.state.notes[0].aiDraft,undefined);
  assert.equal(result.state.notes[0].revisionHistory.at(-1).content,state.notes[0].content);
  for(const field of ['archived','archivedAt','deleted','deletedAt']) {
    const blocked=paperFixture();blocked.notes[0][field]=true;const before=JSON.stringify(blocked);
    assert.throws(()=>Core.applyPlan(blocked,[paperUpdate(blocked)]),/主笔记已归档或删除/);assert.equal(JSON.stringify(blocked),before);
  }
});

for(const type of ['create_note','create_knowledge_item','update_note','upsert_paper']) test(`protectNoteUpdates stages existing machine-note changes for ${type}`,()=>{
  const state=type==='upsert_paper'?paperFixture(false):fixture(false);
  const action=type==='upsert_paper'?paperUpdate(state):type==='update_note'?{type,noteId:'note',patch:{content:'Only the new section'}}:{...create(type),content:'Only the new section'};
  const previous=JSON.parse(JSON.stringify(state.notes[0])), result=Core.applyPlan(state,[action],{now:100,protectNoteUpdates:true,allowedNoteIds:[state.notes[0].id]});
  assert.equal(result.state.notes[0].content,previous.content);assert.equal(result.state.notes[0].title,previous.title);
  assert.deepEqual(result.state.notes[0].revisionHistory,previous.revisionHistory);assert.equal(result.state.notes[0].userEdited,previous.userEdited);
  assert.ok(result.state.notes[0].aiDraft);assert.ok(result.results.some(item=>item.type==='note'&&item.operation==='drafted'));
});

test('protected new notes still save, while title-only existing proposals are drafts',()=>{
  const state=fixture(false), next=Core.applyPlan(state,[{...create('create_note'),title:'A genuinely new note'}],{now:100,protectNoteUpdates:true}).state;
  assert.equal(next.notes.length,2);assert.equal(next.notes[1].content,'New AI analysis');assert.equal(next.notes[1].aiDraft,undefined);
  const result=Core.applyPlan(state,[{type:'update_note',noteId:'note',patch:{title:'Proposed title'}}],{now:100,protectNoteUpdates:true});
  assert.equal(result.state.notes[0].title,state.notes[0].title);assert.equal(result.state.notes[0].aiDraft.title,'Proposed title');assert.equal(result.state.notes[0].aiDraft.content,state.notes[0].content);
});

test('allowedNoteIds only permits exact current IDs; violations roll back earlier actions',()=>{
  for(const allowedNoteIds of [[],['other'],null,[false]]) {
    const state=fixture(), before=JSON.stringify(state);
    assert.throws(()=>Core.applyPlan(state,[{...create('create_note'),title:'New note'}, {type:'update_note',noteId:'note',patch:{content:'Changed'}}],{allowedNoteIds,protectNoteUpdates:true}),/笔记.*范围/);
    assert.equal(JSON.stringify(state),before);
  }
  const state=fixture(false);const allowed=Core.applyPlan(state,[{type:'update_note',noteId:'note',patch:{content:'Permitted draft'}}],{allowedNoteIds:['note'],protectNoteUpdates:true});
  assert.equal(allowed.state.notes[0].aiDraft.content,'Permitted draft');
});

test('new paper master follows the common scoped source directory, including preceding assignment actions',()=>{
  const state=fixture(false);state.notes=[];state.projects[0].workspace='科研';
  const actions=state.imports.map(source=>({type:'assign_attachment',attachmentId:source.id,projectId:'project',workspace:'科研',folderPath:'文献/DemoGraph'}));
  actions.push({type:'upsert_paper',title:'Full paper title',workspace:'科研',projectId:'project',sourceAttachmentIds:['source-old','source-new'],structured:{tldr:'Analysis'}});
  const next=Core.applyPlan(state,actions,{now:100}).state;
  assert.equal(next.notes[0].folderPath,'文献/DemoGraph');assert.equal(next.notes.length,1);
  assert.deepEqual(next.imports.map(source=>source.folderPath),['文献/DemoGraph','文献/DemoGraph']);
});

test('different source paths, absent paths and cross-scope sources never choose one source folder arbitrarily',()=>{
  for(const mutate of [s=>s.imports[1].folderPath='Other',s=>s.imports[1].folderPath='',s=>s.imports[1].projectId=null]) {
    const state=fixture(false);state.notes=[];state.projects[0].workspace='科研';
    state.imports.forEach(source=>Object.assign(source,{folderPath:'文献/DemoGraph',projectId:'project',workspace:'科研'}));mutate(state);
    const next=Core.applyPlan(state,[{type:'upsert_paper',title:'Paper title',year:2026,workspace:'科研',projectId:'project',sourceAttachmentIds:['source-old','source-new']}],{now:100}).state;
    assert.equal(next.notes[0].folderPath,'文献库/2026/Paper title');
  }
});

test('independent research source directory is inherited and an existing manually organized machine note stays put',()=>{
  const state=fixture(false);state.notes=[];
  Object.assign(state.imports[0],{folderPath:'文献/DemoGraph',workspace:'科研',projectId:null});
  const next=Core.applyPlan(state,[{type:'upsert_paper',title:'Independent paper',projectId:null,workspace:'科研',sourceAttachmentIds:['source-old']}],{now:100}).state;
  assert.equal(next.notes[0].folderPath,'文献/DemoGraph');assert.equal(next.notes[0].projectId,null);
  next.notes[0].folderPath='我的层级/长期阅读';assert.notEqual(next.notes[0].userEdited,true);
  const updated=Core.applyPlan(next,[{type:'upsert_paper',paperId:next.papers[0].id,title:'New bibliographic title',projectId:null,workspace:'科研',sourceAttachmentIds:['source-old']}],{now:200}).state;
  assert.equal(updated.notes[0].folderPath,'我的层级/长期阅读');
});
