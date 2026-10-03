const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const CitationEvidence = require('../app/citation-evidence.js');
const app = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const start = app.indexOf('function refreshNativeCommittedNoteSurfaces(event) {');
const end = app.indexOf("document.addEventListener('records-committed', refreshNativeCommittedNoteSurfaces);", start);
function fixture(options = {}) {
  const calls = [], note = { id: 'n', title: 'Saved title', projectId: 'p', workspace: '课程' };
  const state = { currentProjectId: 'p', projects: [{ id: 'p', workspace: '课程' }],
    notes: options.deleted ? [] : [note], trash: options.deleted ? [{type:'content',data:{notes:[note]}}] : [],
    ui: { projectTab: options.tab || 'knowledge' }, previewRecord: options.preview ? {type:'note',id:'n'} : null };
  const position = options.mode ? { mode: options.mode, scrollTop: 250 } : null;
  const context = { state, storageHydrated: true, serverConflict: false, purgeTrash: {},
    document: { body: { dataset: { view: options.view || 'project' } }, querySelector: () => options.modal || null },
    $: () => ({dataset:{projectId:'p'}}), taskEditorHasDrafts: () => !!options.taskDraft,
    renderProject: id => calls.push(['project',id]), renderProjectOutputs: () => calls.push(['outputs']),
    renderTrash: () => calls.push(['trash']),
    renderWorkspaceWidgets: (...args) => calls.push(args), resolveSpaceSection: () => 'knowledge',
    recordMatchesSpace: (n,s) => n.workspace === s,
    previewItem: (type,id) => state.notes.find(n=>n.id===id),
    openNote: (id,opts) => calls.push(['open',id,opts.bookmark?.scrollTop,opts.retainOrigin]),
    window: { CitationEvidence, PrivateMode:{isOn:()=>!!options.private}, CaptureNotes:{render:()=>calls.push(['captures'])},
      NoteEditor:{capturePosition:()=>position,currentContent:()=>({dirty:!!options.dirty}),getInlineDraft:()=>options.draft || null},
      ProjectFiles:{isDirty:()=>!!options.fileDraft}, ProjectSchedule:{isDirty:()=>!!options.scheduleDraft},
      ReadingPane:{reconcile:()=>calls.push(['reconcile'])} } };
  vm.runInNewContext(app.slice(start,end),context);
  const event = {detail:{owner:state,source:'native-quick-capture',collection:'notes',operation:options.deleted?'delete':'update',ids:['n'],projectIds:['forged-scope']}};
  return {calls,context,state,note,event,refresh:()=>context.refreshNativeCommittedNoteSurfaces(event)};
}
test('canonical note scope updates visible collection and count; event metadata cannot redirect it',()=>{
  const f=fixture(); assert.equal(f.refresh(),true); assert.deepEqual(f.calls,[['reconcile'],['project','p']]);
  const space=fixture({view:'courses'}); space.refresh(); assert.deepEqual(space.calls,[['reconcile'],['courses','课程','knowledge']]);
  const other=fixture({view:'research'}); other.refresh(); assert.deepEqual(other.calls,[['reconcile']]);
});
test('read-only preview refresh retains position and origin; deletion reconciles without reopening retired note',()=>{
  const f=fixture({preview:true,mode:'read'}); f.refresh(); assert.deepEqual(f.calls,[['reconcile'],['open','n',250,true],['project','p']]);
  const removed=fixture({preview:true,mode:'read',deleted:true}); removed.refresh(); assert.deepEqual(removed.calls,[['reconcile'],['project','p']]);
});
test('clean editors as well as unsaved drafts keep DOM, selection and undo history',()=>{
  for(const opts of [{mode:'rich'},{mode:'edit'},{mode:'preview'},{dirty:true},{draft:{}},{fileDraft:true},{taskDraft:true},{scheduleDraft:true},{modal:true}]) {
    const f=fixture(opts); assert.equal(f.refresh(),false,JSON.stringify(opts)); assert.deepEqual(f.calls,[]);
  }
});
test('real privacy ancestry rejects retired private runs and live private projects',()=>{
  const f=fixture({deleted:true}); f.note.agentRunId='r'; f.state.agentRuns=[{id:'r',private:true}]; assert.equal(f.refresh(),false); assert.deepEqual(f.calls,[]);
  const live=fixture(); live.state.projects[0].private=true; assert.equal(live.refresh(),false); assert.deepEqual(live.calls,[]);
});
test('missing, duplicated and archived identities never drive visible refresh',()=>{
  for(const setup of [f=>f.state.notes=[],f=>f.state.notes.push({...f.note}),f=>f.state.projects.push({id:'p'}),f=>f.state.projects[0].archived=true]) {
    const f=fixture(); setup(f); assert.equal(f.refresh(),false); assert.deepEqual(f.calls,[]);
  }
  const f=fixture({deleted:true}); f.state.trash.push({type:'content',data:{notes:[{...f.note}]}}); assert.equal(f.refresh(),false);
});
test('only exact-owner acknowledged operations can refresh; conflicts and private mode are inert',()=>{
  for(const patch of [{owner:{}},{source:'other'},{collection:'tasks'},{operation:'purge'},{ids:[]}]) {
    const f=fixture(); Object.assign(f.event.detail,patch); assert.equal(f.refresh(),false); assert.deepEqual(f.calls,[]);
  }
  for(const key of ['serverConflict','storageHydrated']) {const f=fixture(); f.context[key]=key==='serverConflict'; assert.equal(f.refresh(),false);}
  assert.equal(fixture({private:true}).refresh(),false);
});
test('restore refreshes outputs; active conversation, tasks and schedule routes receive no page refresh',()=>{
  const f=fixture({tab:'outputs'}); f.event.detail.operation='restore'; f.refresh(); assert.deepEqual(f.calls,[['reconcile'],['outputs']]);
  for(const opts of [{view:'agent'},{tab:'tasks'},{tab:'conversations'},{tab:'schedule'}]) {const g=fixture(opts);g.refresh();assert.deepEqual(g.calls,[['reconcile']]);}
});
test('island delete and restore refresh an already visible captures or trash list',()=>{
  for(const view of ['captures','trash']) for(const deleted of [true,false]) {
    const f=fixture({view,deleted}); if(!deleted) f.event.detail.operation='restore';
    assert.equal(f.refresh(),true); assert.deepEqual(f.calls,[[view]]);
  }
});
test('parked rich/source editor and unrelated task draft do not leave acknowledged deletions in simple lists',()=>{
  for(const view of ['captures','trash']) for(const opts of [{mode:'rich'},{mode:'edit',dirty:true},{taskDraft:true}]) {
    const f=fixture({view,deleted:true,preview:true,...opts});
    assert.equal(f.refresh(),true); assert.deepEqual(f.calls,[[view]]);
  }
});
