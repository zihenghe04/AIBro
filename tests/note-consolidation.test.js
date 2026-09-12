const test = require('node:test');
const assert = require('node:assert/strict');
const NC = require('../app/note-consolidation');
const Lifecycle = require('../app/content-lifecycle');
const copy = value => JSON.parse(JSON.stringify(value));
const note = (id, content, extra = {}) => ({id,title:id,content,workspace:'课程',projectId:'course',sourceAttachmentIds:['lecture'],createdAt:10,updatedAt:20,...extra});
const fixture = () => ({projects:[{id:'course',name:'Lecture course',workspace:'课程'}],notes:[note('main','# Human introduction\n\nShared paragraph.',{userEdited:true,revisionHistory:[{content:'Earlier text'}],aiDraft:{content:'Unaccepted proposal'}}),note('second','Shared paragraph.\n\nA different conclusion.',{kind:'summary',revisionHistory:[{content:'Earlier second text'}]})],imports:[{id:'lecture',name:'Lecture.pdf',analysis:{status:'analyzed',runId:'run',noteIds:['main','second']}}],papers:[],tasks:[],links:[],attachments:[],trash:[],conversations:[{id:'conversation',messages:[{results:[{type:'note',id:'second',projectId:'course'}]}]}]});
const apply = state => NC.apply(state,NC.preview(state,['main','second']),{now:100,uid:()=> 'merge-trash'});

test('preview is pure and a confirmed course merge preserves human text, history, drafts and provenance',()=>{
  const original=fixture(), before=copy(original), view=NC.preview(original,['main','second']);
  assert.deepEqual(original,before);assert.equal(view.canonicalId,'main');assert.equal(view.duplicateParagraphs,1);
  assert.equal(view.content.match(/Shared paragraph\./g).length,1);
  assert.ok(view.content.startsWith(original.notes[0].content));assert.match(view.content,/A different conclusion/);
  assert.match(view.content,/Lecture.pdf/);assert.doesNotMatch(view.content,/Unaccepted proposal/);
  const result=NC.apply(original,view,{now:100,uid:()=> 'merge-trash'}), master=result.state.notes[0];
  assert.equal(result.state.notes.length,1);assert.equal(master.id,'main');assert.equal(master.userEdited,true);
  assert.deepEqual(master.aiDraft,original.notes[0].aiDraft);assert.deepEqual(master.revisionHistory[0],original.notes[0].revisionHistory[0]);
  assert.equal(master.revisionHistory.at(-1).content,original.notes[0].content);
  assert.deepEqual(result.entry.data.notes,[original.notes[1]]);assert.deepEqual(master.mergedNoteIds,['second']);
  assert.deepEqual(master.consolidatedSections.map(section=>section.noteId),['main','second']);
  assert.deepEqual(original,before);assert.deepEqual(result.state.conversations,original.conversations);
  assert.equal(NC.resolveId(result.state,'second'),'main');
});

test('paper canonical ID wins and an existing main note is automatically included in a five-to-one merge',()=>{
  const state=fixture();state.projects[0].workspace='科研';
  state.notes=Array.from({length:5},(_,i)=>note(`n${i}`,`Unique analysis ${i}`,{workspace:'科研',paperId:i===0?'paper':undefined}));
  state.papers=[{id:'paper',noteId:'n0',workspace:'科研',projectId:'course',sourceAttachmentIds:['lecture'],structured:{tldr:'Structured remains intact'}}];
  const view=NC.preview(state,['n1','n2','n3','n4'],{canonicalId:'n2',title:'Combined analysis'});
  assert.equal(view.canonicalId,'n0');assert.equal(view.noteIds.length,5);assert.ok(view.warnings.some(text=>text.includes('现有主笔记')));
  const result=NC.apply(state,view,{now:100,uid:()=> 'trash'});
  assert.equal(result.state.notes.length,1);assert.equal(result.state.notes[0].id,'n0');
  for(let i=0;i<5;i++) assert.ok(result.state.notes[0].content.includes(`Unique analysis ${i}`));
  assert.deepEqual(result.state.papers,state.papers);assert.equal(result.entry.data.notes.length,4);
});

test('chosen course canonical remains stable and prior merge aliases flatten',()=>{
  const state=fixture();state.notes[1].mergedNoteIds=['old-fragment'];
  const result=NC.apply(state,NC.preview(state,['main','second'],{canonicalId:'second'}),{now:100});
  assert.equal(result.canonicalId,'second');assert.equal(NC.resolveId(result.state,'main'),'second');
  assert.equal(NC.resolveId(result.state,'old-fragment'),'second');
  result.state.notes[0].archived=true;assert.equal(NC.resolveId(result.state,'main'),null);
});

for(const content of ['````markdown\n```js\n# literal-heading\n```\n````','~~~~markdown\n~~~js\n# literal-heading\n~~~\n~~~~','````text\n```` not a closer\n# literal-heading\n````']) test(`nested fence body is byte-preserved: ${JSON.stringify(content)}`,()=>{
  const state=fixture();state.notes[1].content=content;
  assert.ok(NC.preview(state,['main','second']).content.includes(content));
});

test('only exact ordinary paragraphs deduplicate; differing wording, repeated lists and code remain',()=>{
  const state=fixture();const protectedBlock='- repeated checklist\n\n```js\nconst same = true;\n```';
  state.notes[0].content='Similar statement.\n\n'+protectedBlock;
  state.notes[1].content='Similar statement!\n\n'+protectedBlock;
  const text=NC.preview(state,['main','second']).content;
  assert.match(text,/Similar statement\./);assert.match(text,/Similar statement!/);
  assert.equal(text.match(/- repeated checklist/g).length,2);assert.equal(text.match(/const same = true/g).length,2);
});

test('backlinks, analysis proof and tags merge without losing unrelated associations or newer timestamps',()=>{
  const state=fixture();Object.assign(state.notes[0],{sourceNoteIds:['parent'],relatedNoteIds:['sibling'],tags:['first'],updatedAt:999});
  Object.assign(state.notes[1],{sourceNoteIds:['main','other-parent'],relatedNoteIds:['sibling','other-sibling'],tags:['second']});
  state.notes.push(note('consumer','Keep this body',{sourceNoteIds:['second','main','untouched'],relatedNoteIds:['second']}));
  state.tasks=[{id:'task',sourceNoteIds:['second','main','outside'],sourceAttachmentIds:['lecture'],status:'done',updatedAt:999}];
  state.attachments=[{id:'attachment-record',noteId:'second'}];
  const {state:result}=apply(state), main=result.notes.find(item=>item.id==='main');
  assert.deepEqual(main.sourceNoteIds,['parent','other-parent']);assert.deepEqual(main.relatedNoteIds,['sibling','other-sibling']);
  assert.deepEqual(main.tags,['first','second']);assert.equal(main.updatedAt,999);
  assert.deepEqual(result.tasks[0].sourceNoteIds,['main','outside']);assert.equal(result.tasks[0].status,'done');assert.equal(result.tasks[0].updatedAt,999);
  assert.deepEqual(result.notes.find(item=>item.id==='consumer').sourceNoteIds,['main','untouched']);
  assert.deepEqual(result.imports[0].analysis,{status:'analyzed',runId:'run',noteIds:['main']});assert.equal(result.attachments[0].noteId,'main');
});

test('typed links do not confuse equal task and note IDs, and only collapsed duplicate/self links enter trash',()=>{
  const state=fixture();state.tasks=[{id:'second'},{id:'main'}];
  state.links=[
    {id:'moved-first',sourceId:'lecture',targetId:'second',sourceType:'import',targetType:'note',relation:'source'},
    {id:'existing',sourceId:'lecture',targetId:'main',sourceType:'import',targetType:'note',relation:'source'},
    {id:'internal',sourceId:'main',targetId:'second',sourceType:'note',targetType:'note'},
    {id:'task-link',sourceId:'lecture',targetId:'second',sourceType:'import',targetType:'task'},
    {id:'typed-same-id',sourceId:'main',targetId:'second',sourceType:'task',targetType:'note'}];
  const result=apply(state);
  assert.deepEqual(result.state.links.map(item=>item.id),['existing','task-link','typed-same-id']);
  assert.equal(result.state.links.find(item=>item.id==='task-link').targetId,'second');
  assert.equal(result.state.links.find(item=>item.id==='typed-same-id').targetId,'main');
  assert.deepEqual(result.entry.data.links.map(item=>item.id),['moved-first','internal']);
});

test('untyped unique links become explicitly typed; ambiguous legacy endpoints abort without mutation',()=>{
  const state=fixture();state.links=[{id:'source',sourceId:'lecture',targetId:'second'}];
  assert.equal(apply(state).state.links[0].targetType,'note');
  state.tasks=[{id:'second'}];const before=copy(state);
  assert.throws(()=>NC.preview(state,['main','second']),/歧义/);assert.deepEqual(state,before);
});

for(const mutate of [s=>s.notes[1].projectId=null,s=>{s.notes.forEach(note=>note.projectId=null);s.notes[1].workspace='日常';},s=>s.projects[0].archived=true,s=>s.notes[1].deletedAt=30,s=>s.notes[1].paperId='missing',s=>s.papers=[{id:'p1',noteId:'main',projectId:'course',workspace:'课程'},{id:'p2',noteId:'second',projectId:'course',workspace:'课程'}]]) test('scope and availability errors reject an atomic merge',()=>{
  const state=fixture();mutate(state);const before=copy(state);
  assert.throws(()=>NC.preview(state,['main','second']));assert.deepEqual(state,before);
});

test('review detects edits, movement, deletion, changed references, or tampered preview before applying',()=>{
  for(const mutate of [s=>s.notes[0].content+=' Changed',s=>s.notes[1].projectId=null,s=>s.notes.pop(),s=>s.tasks.push({id:'new-task',sourceNoteIds:['second']})]) {
    const state=fixture(), view=NC.preview(state,['main','second']);mutate(state);const before=copy(state);
    assert.throws(()=>NC.apply(state,view));assert.deepEqual(state,before);
  }
  const state=fixture(), view=NC.preview(state,['main','second']);view.content='tampered';assert.throws(()=>NC.apply(state,view),/重新预览/);
  assert.throws(()=>NC.preview(state,['main','main']),/至少选择/);
});

test('restoring originals preserves full revisions and drafts without replacing later edits of the master',()=>{
  const state=fixture();state.notes[1].aiDraft={content:'Secondary pending proposal'};
  const result=apply(state);result.state.notes[0].content='A later human change';
  const restored=Lifecycle.restore(result.state,result.entry.id).state;
  assert.equal(restored.notes.find(item=>item.id==='main').content,'A later human change');
  assert.deepEqual(restored.notes.find(item=>item.id==='second'),state.notes[1]);
  assert.equal(NC.resolveId(restored,'second'),'second');assert.equal(restored.trash.length,0);
});

test('a same-source merge groups the master with the source, recording its original folder without moving raw materials',()=>{
  const state=fixture();Object.assign(state.imports[0],{workspace:'课程',projectId:'course',folderPath:'课件/第一讲'});
  delete state.imports[0].analysis;state.notes[0].folderPath='旧笔记/分散目录';
  const view=NC.preview(state,['main','second']);assert.equal(view.folderPath,'课件/第一讲');assert.ok(view.warnings.some(text=>text.includes('原件不会移动')));
  const result=NC.apply(state,view,{now:100,uid:()=> 'merged'});
  assert.equal(result.state.notes[0].folderPath,'课件/第一讲');assert.deepEqual(result.state.imports,state.imports);
  assert.equal(result.state.notes[0].revisionHistory.at(-1).folderPath,'旧笔记/分散目录');
  assert.deepEqual(result.entry.data.consolidation.rewired.find(item=>item.field==='folderPath'),{collection:'notes',id:'main',field:'folderPath',before:'旧笔记/分散目录',after:'课件/第一讲'});
});

test('folder inheritance requires exactly the same nonempty source set, scope, and one nonempty directory',()=>{
  for(const mutate of [s=>s.notes[1].sourceAttachmentIds=['extra'],s=>s.imports[1].folderPath='第二个目录',s=>s.imports[1].folderPath='',s=>s.imports[1].projectId=null,s=>s.imports[1].archived=true]) {
    const state=fixture();state.notes.forEach(note=>note.sourceAttachmentIds=['lecture','extra']);state.notes[0].folderPath='保留原目录';
    Object.assign(state.imports[0],{workspace:'课程',projectId:'course',folderPath:'共同目录'});
    state.imports.push({id:'extra',name:'Extra.pdf',workspace:'课程',projectId:'course',folderPath:'共同目录'});mutate(state);
    const view=NC.preview(state,['main','second']);assert.equal(view.folderPath,'保留原目录');
    assert.equal(NC.apply(state,view,{now:100}).state.notes[0].folderPath,'保留原目录');
  }
});

test('source directory or scope changes after preview invalidate a pending merge',()=>{
  for(const mutate of [s=>s.imports[0].folderPath='新目录',s=>s.imports[0].projectId=null,s=>s.imports[0].archived=true]) {
    const state=fixture();Object.assign(state.imports[0],{workspace:'课程',projectId:'course',folderPath:'原目录'});
    const view=NC.preview(state,['main','second']);mutate(state);const before=copy(state);
    assert.throws(()=>NC.apply(state,view),/重新预览/);assert.deepEqual(state,before);
  }
});
