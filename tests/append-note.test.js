const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../app/workstation-core');
const copy = value => JSON.parse(JSON.stringify(value));
const fixture = () => ({projects:[{id:'project',name:'Research',workspace:'科研'}],
  notes:[{id:'note',title:'Complete master',content:'# Complete original\n\nFirst part.\n\n## Later part\n\nKeep these exact bytes.\n',workspace:'科研',projectId:'project',folderPath:'文献/DemoGraph',kind:'论文分析',sourceAttachmentIds:['original'],updatedAt:10,revisionHistory:[{content:'Earlier version'}]}],
  imports:[{id:'original',name:'Source.pdf',workspace:'科研',projectId:'project'},{id:'extra',name:'Extra.pdf',workspace:'科研',projectId:'project'}],tasks:[],papers:[],links:[],trash:[],attachments:[],conversations:[],agentRuns:[]});
const addition='## New knowledge\n\nOnly the new Markdown needs to come from the model.';
const action=()=>({type:'append_note',noteId:'note',content:addition});

test('append_note adds to the exact complete local body with one stable ID and a recoverable previous revision',()=>{
  const state=fixture(), before=copy(state), result=Core.applyPlan(state,[action()],{now:100,allowedNoteIds:['note']});
  assert.equal(Core.actionLabels.append_note,'追加笔记');assert.equal(result.state.notes.length,1);
  const note=result.state.notes[0];assert.equal(note.id,'note');assert.equal(note.content,state.notes[0].content+'\n\n'+addition);
  for(const field of ['title','folderPath','kind','projectId','workspace','sourceAttachmentIds']) assert.deepEqual(note[field],state.notes[0][field],field);
  assert.equal(note.revisionHistory.at(-1).content,state.notes[0].content);assert.equal(note.aiDraft,undefined);
  assert.ok(result.results.some(item=>item.id==='note'&&item.operation==='updated'&&item.text.startsWith('追加笔记')));
  assert.deepEqual(state,before);
});

for(const flags of [{userEdited:true},{protectNoteUpdates:true}]) test(`append preserves the approved body and stages a full draft: ${JSON.stringify(flags)}`,()=>{
  const state=fixture();if(flags.userEdited)Object.assign(state.notes[0],{userEdited:true,userEditedAt:20});
  const previous=copy(state.notes[0]);const result=Core.applyPlan(state,[{...action(),sourceAttachmentIds:['extra']}],{now:100,allowedNoteIds:['note'],...flags});
  const note=result.state.notes[0];assert.equal(note.content,previous.content);assert.equal(note.title,previous.title);
  assert.deepEqual(note.revisionHistory,previous.revisionHistory);assert.equal(note.userEditedAt,previous.userEditedAt);
  assert.equal(note.aiDraft.content,previous.content+'\n\n'+addition);assert.equal(note.aiDraft.createdAt,100);
  assert.deepEqual(note.aiDraft.sourceAttachmentIds,['original','extra']);assert.deepEqual(note.sourceAttachmentIds,['original','extra']);
  assert.ok(result.state.links.some(link=>link.sourceId==='extra'&&link.targetId==='note'));
  assert.ok(result.results.some(item=>item.type==='note'&&item.operation==='drafted'));
});

test('retries do not duplicate accepted additions, draft content, draft timestamps or source links',()=>{
  for(const protectNoteUpdates of [false,true]) {
    const state=fixture(), append={...action(),sourceAttachmentIds:['extra']};
    const first=Core.applyPlan(state,[append],{now:100,protectNoteUpdates}).state;
    const second=Core.applyPlan(first,[append],{now:200,protectNoteUpdates});
    assert.equal(second.state.notes[0].content,first.notes[0].content);
    assert.deepEqual(second.state.notes[0].aiDraft,first.notes[0].aiDraft);
    assert.deepEqual(second.state.notes[0].revisionHistory,first.notes[0].revisionHistory);
    assert.deepEqual(second.state.links,first.links);
    if(!protectNoteUpdates)assert.ok(second.results.some(item=>item.operation==='matched'));
  }
});

test('new supplemental content extends a pending draft while preserving approved text and the prior proposal',()=>{
  const state=fixture();state.notes[0].aiDraft={title:'Pending',content:'UNACCEPTED draft text',createdAt:50};
  const before=copy(state);
  const extended=Core.applyPlan(state,[action()],{now:100,protectNoteUpdates:true}).state.notes[0];
  assert.equal(extended.content,state.notes[0].content);
  assert.equal(extended.aiDraft.content,'UNACCEPTED draft text\n\n'+addition);
  assert.equal(extended.aiDraftHistory[0].content,'UNACCEPTED draft text');
  assert.deepEqual(state,before);
  delete state.notes[0].aiDraft;
  state.notes[0].content+='\n\nA human edit since the model started.';
  const latest=Core.applyPlan(state,[action()],{now:100,protectNoteUpdates:true}).state.notes[0];
  assert.equal(latest.aiDraft.content,state.notes[0].content+'\n\n'+addition);
});

test('retry of an already adopted addition preserves an unrelated newer pending draft',()=>{
  const state=fixture();state.notes[0].content+='\n\n'+addition;
  state.notes[0].aiDraft={title:'A later proposal',content:'Keep this pending proposal',createdAt:50};
  const result=Core.applyPlan(state,[action()],{now:100,protectNoteUpdates:true});
  assert.equal(result.state.notes[0].content,state.notes[0].content);assert.deepEqual(result.state.notes[0].aiDraft,state.notes[0].aiDraft);
  assert.ok(result.results.some(item=>item.operation==='matched'));
});

test('empty original body accepts an addition once, while a mere suffix inside a paragraph is not falsely deduplicated',()=>{
  const state=fixture();state.notes[0].content='';
  const first=Core.applyPlan(state,[action()],{now:100}).state;assert.equal(first.notes[0].content,addition);
  const second=Core.applyPlan(first,[action()],{now:200});assert.equal(second.state.notes[0].content,addition);assert.ok(second.results.some(item=>item.operation==='matched'));
  state.notes[0].content='A word ends in something';
  assert.equal(Core.applyPlan(state,[{...action(),content:'thing'}],{now:100}).state.notes[0].content,'A word ends in something\n\nthing');
});

test('append ignores unrelated patch and destination fields and keeps the target stable',()=>{
  const state=fixture();state.projects.push({id:'other',name:'Other',workspace:'科研'});
  const result=Core.applyPlan(state,[{...action(),projectId:'other',patch:{title:'Replace title',kind:'summary',content:'Replace full body'}}],{now:100}).state.notes[0];
  assert.equal(result.projectId,'project');assert.equal(result.title,'Complete master');assert.equal(result.kind,'论文分析');
  assert.equal(result.content,state.notes[0].content+'\n\n'+addition);
});

test('invalid content, missing or disallowed IDs, unavailable notes and invalid sources fail atomically',()=>{
  const cases=[
    [s=>{},a=>({...a,noteId:'missing'}),{}],
    [s=>{},a=>a,{allowedNoteIds:[]}], [s=>{},a=>a,{allowedNoteIds:null}],
    [s=>{s.notes[0].archived=true;},a=>a,{}], [s=>{s.notes[0].deletedAt=50;},a=>a,{}],
    [s=>{s.projects[0].archived=true;},a=>a,{}],
    [s=>{},a=>({...a,sourceAttachmentIds:['missing']}),{}],
    ...[undefined,null,'','  \n ',7,{}].map(content=>[s=>{},a=>({...a,content}),{}])];
  for(const [mutate,make,context] of cases) {
    const state=fixture();mutate(state);const before=copy(state);
    assert.throws(()=>Core.applyPlan(state,[{type:'create_task',title:'Rollback me',workspace:'科研'},make(action())],{now:100,...context}));
    assert.deepEqual(state,before);
  }
});
