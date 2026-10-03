const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const Evidence = require('../app/citation-evidence');
const app = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const start = app.indexOf('function refreshNativeCommittedLinkSurfaces(event) {');
const end = app.indexOf("document.addEventListener('records-committed', refreshNativeCommittedLinkSurfaces);", start);
function fixture(options = {}) {
  const calls = [], state = { currentProjectId: 'p', projects: [{ id: 'p' }], ui: { projectTab: options.tab || 'knowledge' } };
  const context = { state, storageHydrated: true, serverConflict: false, purgeTrash: {},
    document: { body: { dataset: { view: options.view || 'project' } }, querySelector: () => options.modal || null },
    $: () => ({ dataset: { projectId: 'p' } }), taskEditorHasDrafts: () => !!options.taskDraft,
    renderProject: id => calls.push(['project', id]), renderWorkspaceWidgets: (...args) => calls.push(args),
    resolveSpaceSection: () => options.section || 'knowledge',
    window: { PrivateMode: { isOn: () => !!options.private }, NoteEditor: {
      capturePosition: () => options.noteMode ? {mode:options.noteMode} : null,
      currentContent: () => options.noteDraft ? {dirty:true} : null },
      ProjectFiles: { current: () => options.fileDraft || options.fileMode ? {mode:options.fileMode || 'read',dirty:!!options.fileDraft} : null },
      ProjectSchedule: { isDirty: () => !!options.scheduleDraft },
      CitationEvidence: { createAccessContext: () => ({ access: () => ({ available: !options.denied }), isAmbiguous: () => !!options.ambiguous }) } } };
  vm.runInNewContext(app.slice(start, end), context);
  const event = { detail: { owner: state, source: 'native-quick-links', collection: 'imports', ids: ['bookmark'] } };
  return { calls, context, event, refresh: e => context.refreshNativeCommittedLinkSurfaces(e || event) };
}
test('durable link update refreshes only the visible project source collection', () => {
  const f = fixture(); assert.equal(f.refresh(), true); assert.deepEqual(f.calls, [['project', 'p']]);
  for (const tab of ['tasks','conversations','outputs','schedule']) { const other = fixture({tab}); assert.equal(other.refresh(), false); assert.deepEqual(other.calls, []); }
});
test('space source list updates after a link save without navigating', () => {
  const f = fixture({view:'research'}); assert.equal(f.refresh(), true); assert.deepEqual(f.calls, [['research','科研','knowledge']]);
  assert.equal(fixture({view:'agent'}).refresh(), false);
});
test('pending editors, dialogs and private workspaces remain untouched', () => {
  for (const key of ['noteDraft','fileDraft','taskDraft','scheduleDraft','private','modal','denied','ambiguous']) {
    const f = fixture({[key]:true}); assert.equal(f.refresh(), false, key); assert.deepEqual(f.calls, []);
  }
});
test('old workspace owner, unrelated events and duplicate project identity cannot refresh', () => {
  for (const patch of [{owner:{}},{source:'other'},{collection:'notes'},{ids:[]}]) {
    const f = fixture(); Object.assign(f.event.detail,patch); assert.equal(f.refresh(), false); assert.deepEqual(f.calls, []);
  }
  const f=fixture(); f.context.state.projects.push({id:'p'}); assert.equal(f.refresh(),false);
});

const cut = (from,to) => {const begin=app.indexOf(from), stop=app.indexOf(to,begin); assert.ok(begin>=0 && stop>begin); return app.slice(begin,stop);};
const deferred = () => {let resolve; const promise=new Promise(done=>{resolve=done;}); return {promise,resolve};};
function readerFixture() {
  const f=fixture({view:'agent'}), {context,state}= {context:f.context,state:f.context.state};
  state.imports=[{id:'bookmark',projectId:'p',name:'Saved source',updatedAt:12,fileStored:true,quickLinkFetch:{status:'ready'}}];
  state.notes=[]; state.trash=[]; state.agentRuns=[]; state.conversations=[];
  state.previewRecord={type:'import',id:'bookmark'};
  const origin={view:'project',projectId:'p',section:'knowledge'}, bookmark={mode:'read',scrollTop:280};
  const tab={key:'import:bookmark',kind:'import',id:'bookmark',page:3,origin,bookmark};
  const pane={visible:true,retained:false,activeKey:tab.key,tabs:[tab]};
  const guard={type:'import',id:'bookmark',projectId:'p'};
  const calls={mounts:[],pending:[],leaves:0};
  let leave=()=>true;
  const ReadingPane={snapshot:()=>({...pane,tabs:pane.tabs.map(row=>({...row}))}),bookmark:()=>bookmark,
    beforeNavigate:()=>{calls.leaves++;return leave();},reconcile:()=>{}};
  Object.assign(context,{serverSaveInFlight:false,workspaceRouteIntent:8,previewOpenIntent:5,previewRequestVersion:9,
    showView:Object.assign(()=>{},{navigationVersion:4}),ReadingPane,sourcePreviewGuards:new Map([[JSON.stringify(['import','bookmark']),guard]]),
    toast:()=>{},beforePreviewLeave:()=>{throw Error('Expected actual ReadingPane navigation contract');},
    commitPreview:(kind,id,page,sourceGuard,navigation,originOptions)=>{
      calls.mounts.push({kind,id,page,sourceGuard,navigation,originOptions});
      if (Object.hasOwn(originOptions,'origin')) tab.origin=originOptions.origin;
      tab.bookmark=navigation.bookmark; return true;
    }});
  context.window.CitationEvidence=Evidence; context.window.ReadingPane=ReadingPane;
  context.window.NativeShell={getNavigationVersion:()=>context.nativeVersion}; context.nativeVersion=7;
  // Run the production source access and navigation code; replace only its
  // heavy DOM mounting tail, never the async leave / canOpen / route checks.
  for (const [from,to] of [['function previewSourceAvailable(','\nfunction documentTabSource('],
    ['function previewItem(','\nfunction suspendPreview('],['function captureDocumentOrigin(','\nfunction resolveDocumentOrigin(']]) {
    vm.runInNewContext(cut(from,to),context);
  }
  vm.runInNewContext(cut('async function openPreview(','  if (!sameLocalFile && window.ProjectFiles?.unmount()')+
    '\nreturn commitPreview(kind,id,requestedPage,sourceGuard,navigation,originOptions);\n}',context);
  context.window.DocumentOrigin={}; // retainOrigin must short-circuit recapture.
  const actualOpen=context.openPreview;
  context.openPreview=(...args)=>{const pending=actualOpen(...args); calls.pending.push(pending); return pending;};
  f.event.detail.action='fetch';
  return {...f,state,pane,tab,guard,calls,setLeave:fn=>{leave=fn;},settle:()=>Promise.all(calls.pending)};
}

test('successful fetch refreshes the same visible import through real preview navigation, retaining origin, page, bookmark and source authority',async()=>{
  const f=readerFixture(), origin=f.tab.origin, bookmark=f.tab.bookmark;
  assert.equal(f.refresh(),true); assert.deepEqual(await f.settle(),[true]); assert.equal(f.calls.leaves,1);
  const mount=f.calls.mounts[0]; assert.equal(f.calls.mounts.length,1);
  assert.equal(mount.kind,'import'); assert.equal(mount.id,'bookmark'); assert.equal(mount.page,3);
  assert.equal(mount.sourceGuard,f.guard); assert.equal(mount.navigation.bookmark,bookmark);
  assert.equal(mount.navigation.retainOrigin,true); assert.deepEqual(Object.keys(mount.originOptions),[]);
  assert.equal(f.tab.origin,origin); assert.equal(f.tab.bookmark,bookmark);
});

test('URL-only, failed, unrelated or parked imports do not reopen a reader',async()=>{
  for(const mutate of [f=>{f.event.detail.action='update';},f=>{f.event.detail.ids=['other'];},
    f=>{f.state.imports[0].quickLinkFetch.status='failed';},f=>{f.state.imports[0].fileStored=false;},
    f=>{f.pane.visible=false;f.pane.retained=true;},f=>{f.pane.activeKey='other';},
    f=>{f.state.previewRecord={type:'note',id:'other'};},f=>{f.tab.kind='note';}]) {
    const f=readerFixture();mutate(f);assert.equal(f.refresh(),false);assert.equal(f.calls.pending.length,0);assert.equal(f.calls.mounts.length,0);
  }
});

test('clean active rich/source editors are protected using exported editor contracts, not an absent isDirty method',()=>{
  for(const mode of ['rich','edit','preview']) for(const kind of ['note','file']) {
    const f=fixture({[kind+'Mode']:mode}); assert.equal(f.refresh(),false,`${kind}/${mode}`);assert.deepEqual(f.calls,[]);
    const r=readerFixture();
    if(kind==='note')r.context.window.NoteEditor.capturePosition=()=>({mode});
    else r.context.window.ProjectFiles.current=()=>({mode,dirty:false});
    assert.equal(r.refresh(),false);assert.equal(r.calls.pending.length,0);
  }
});

test('async preview handoff abandons refresh on newer route, changed reader, saving or editing without stealing focus',async()=>{
  const mutations={
    workspace:f=>f.context.workspaceRouteIntent++,native:f=>f.context.nativeVersion++,route:f=>f.context.showView.navigationVersion++,
    preview:f=>f.context.previewOpenIntent++,view:f=>{f.context.document.body.dataset.view='daily';},
    parked:f=>{f.pane.visible=false;f.pane.retained=true;},closed:f=>{f.pane.visible=false;},
    active:f=>{f.pane.activeKey='another';},page:f=>f.tab.page++,origin:f=>{f.tab.origin={view:'daily'};},
    bookmark:f=>{f.tab.bookmark={mode:'read',scrollTop:900};},target:f=>{f.state.previewRecord={type:'note',id:'other'};},
    editor:f=>{f.context.window.NoteEditor.capturePosition=()=>({mode:'rich'});},
    file:f=>{f.context.window.ProjectFiles.current=()=>({mode:'read',saving:true});},
    saving:f=>{f.context.serverSaveInFlight=true;},pending:f=>{f.state._pendingLocalSave=true;},
    modal:f=>{f.context.document.querySelector=()=>({});},conflict:f=>{f.context.serverConflict=true;},
    owner:f=>{f.context.state={...f.state};},replaced:f=>{f.state.imports=[{...f.state.imports[0]}];},
    version:f=>f.state.imports[0].updatedAt++,removed:f=>{f.state.imports=[];},
    private:f=>{f.state.projects[0].private=true;},duplicate:f=>{f.state.imports.push({...f.state.imports[0]});},
    source:f=>{f.context.sourcePreviewGuards.set(JSON.stringify(['import','bookmark']),{...f.guard});},
    ancestry:f=>{f.guard.sourceConversationId='private-origin';f.state.conversations.push({id:'private-origin',private:true});}
  };
  for(const [name,mutate] of Object.entries(mutations)) {
    const f=readerFixture(), gate=deferred();f.setLeave(()=>gate.promise);
    assert.equal(f.refresh(),true,name);assert.equal(f.calls.leaves,1,name);mutate(f);gate.resolve(true);
    assert.deepEqual(await f.settle(),[false],name);assert.equal(f.calls.mounts.length,0,name);
  }
});

test('cancelled leave neither mounts a reader nor replaces retained reading state',async()=>{
  const f=readerFixture(), before=JSON.stringify(f.pane);f.setLeave(()=>false);
  assert.equal(f.refresh(),true);assert.deepEqual(await f.settle(),[false]);
  assert.equal(f.calls.mounts.length,0);assert.equal(JSON.stringify(f.pane),before);
});

test('real NativeQuickLinks durable fetch event drives the host refresh; failed attempts and failed final saves do not',async()=>{
  const {webcrypto,randomUUID}=require('node:crypto');
  for(const outcome of ['ready','offline','uncommitted']) {
    const f=readerFixture(), context=f.context, id='quick_link_'+randomUUID();let saves=0;
    Object.assign(f.state.imports[0],{id,url:'https://example.org/source',workspace:'科研',parser:'bookmark',content:'',pages:[],fileStored:false,
      importOrigin:'quick-links',quickLinkIdentity:'saved:'+id,quickLinkFetch:undefined});
    f.state.previewRecord.id=id;f.tab.id=id;f.guard.id=id;
    context.sourcePreviewGuards=new Map([[JSON.stringify(['import',id]),f.guard]]);
    Object.assign(context,{URL,TextEncoder,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},
      saveDocumentDurably:async()=>++saves===2 && outcome==='uncommitted' ? false : true,
      fetch:async(_url,request)=>{if(outcome==='offline')throw TypeError('offline');const payload=JSON.parse(request.body);
        return {ok:true,json:async()=>({id,bookmarkRequestId:payload.bookmark.requestId,fileStored:true,storedLocally:true,
          name:'Fetched title',finalUrl:payload.url,mimeType:'text/html',size:90,content:'Saved webpage body',pages:[],parser:'web'})};}});
    context.document.dispatchEvent=event=>context.refreshNativeCommittedLinkSurfaces(event);
    Object.assign(context.window,{crypto:webcrypto,WorkstationCore:require('../app/workstation-core'),ContentLifecycle:require('../app/content-lifecycle')});
    vm.runInNewContext(fs.readFileSync(require.resolve('../native/Resources/quick-links.js'),'utf8'),context);
    const version=(await context.window.NativeQuickLinks.request({action:'list'})).rows[0].version;
    const response=await context.window.NativeQuickLinks.request({action:'fetch',requestId:'quick_link_'+randomUUID(),items:[{id,expectedVersion:version}]});
    await f.settle();
    assert.equal(f.calls.mounts.length,outcome==='ready'?1:0,outcome);
    assert.equal(response.status,outcome==='uncommitted'?'error':'saved',outcome);
    if(outcome==='ready'){assert.equal(f.calls.mounts[0].id,id);assert.equal(f.state.imports[0].content,'Saved webpage body');}
  }
});


test('shared empty-folder commits refresh the project tree without fake import IDs and keep all editor guards',()=>{
  for(const action of ['folder-create','folder-rename','folder-delete']) {
    const f=fixture();Object.assign(f.event.detail,{collection:'folders',action,ids:[],folderIds:['shared-folder-id']});
    assert.equal(f.refresh(),true);assert.deepEqual(f.calls,[['project','p']]);
  }
  for(const key of ['noteDraft','fileDraft','taskDraft','scheduleDraft','private','modal','denied','ambiguous']) {
    const f=fixture({[key]:true});Object.assign(f.event.detail,{collection:'folders',action:'folder-create',ids:[],folderIds:['shared-folder-id']});
    assert.equal(f.refresh(),false,key);assert.deepEqual(f.calls,[]);
  }
  for(const patch of [{folderIds:[]},{folderIds:null},{action:'other'},{owner:{}}]) {
    const f=fixture();Object.assign(f.event.detail,{collection:'folders',action:'folder-create',ids:[],folderIds:['shared-folder-id']},patch);
    assert.equal(f.refresh(),false);assert.deepEqual(f.calls,[]);
  }
});
