'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const app=fs.readFileSync(path.join(root,'app/app.js'),'utf8');
function section(start,end){
  const first=app.indexOf(start),last=app.indexOf(end,first+start.length);
  assert.ok(first>=0&&last>first,`Production host section not found: ${start}`);
  return app.slice(first,last);
}
const production=[
  section('async function prepareWorkspaceRoute(', 'async function navigateWorkspaceView('),
  section('async function navigateWorkspaceNewConversation(', 'async function openProject('),
  section('async function navigateWorkspaceConversation(', 'let pdfPreviewVersion'),
  section('function resolveDocumentOrigin(', 'async function returnToDocumentOrigin('),
  section('const contextSelection = window.ContextSelection?.create({', 'window.FileContextUI?.init({'),
].join('\n');
const FileContext=require('../app/file-context.js');
const ContextWorkbench=require('../app/context-workbench.js');
const DocumentOrigin=require('../app/document-origin.js');
const ContextSelection=require('../app/context-selection.js');
const DocumentChat=require('../app/document-chat.js');
const clone=value=>JSON.parse(JSON.stringify(value));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
async function until(condition){for(let count=0;count<30;count++){if(condition())return;await new Promise(resolve=>setImmediate(resolve));}assert.fail('Host operation did not reach expected await');}

function fixture(options={}){
  const state={
    projects:[{id:'p',name:'Research project',workspace:'research',localFolder:{id:'folder-p'}},{id:'q',name:'Another project',workspace:'日常'}],
    notes:[{id:'note-a',title:'A saved document',content:'Original saved body',projectId:'p',workspace:'日常'}],
    imports:[{id:'pdf-a',name:'Source.pdf',projectId:'p',workspace:'科研',createdAt:1,size:99,originalName:'Source.pdf'}],
    conversations:[
      {id:'origin',title:'Original source conversation',projectId:'q',workspace:'日常',draft:'Origin draft',messages:[]},
      {id:'current',title:'Current target',projectId:'p',workspace:'科研',draft:'Unsent prompt stays intact',messages:[{id:'already-sent',role:'user',text:'A previous turn'}],queuedMessages:[{id:'queued',text:'A queued message'}]},
      {id:'recent',title:'Recent project chat',projectId:'p',workspace:'科研',updatedAt:100,draft:'Recent draft',messages:[]},
      {id:'other-project',title:'Unrelated chat',projectId:'q',workspace:'日常',messages:[]},
      {id:'private-chat',title:'Private chat',projectId:'p',private:true,messages:[]},
      {id:'archived-chat',title:'Archived chat',projectId:'p',archived:true,messages:[]},
    ],
    currentConversationId:'current',agentRuns:[],tasks:[],papers:[],links:[],ui:{},
  };
  const reader={visible:true,retained:false,activeKey:'note:note-a',tabs:[{key:'note:note-a',kind:'note',id:'note-a',origin:{view:'agent',conversationId:'origin'}}]};
  let inlineDraft=null,localEditor={id:'local-id',version:'actual-filesystem-version',dirty:false},privateMode=false,nativeVersion=0;
  const localRef={type:'local',candidateId:'folder-p',projectId:'p',path:'notes/topic.md',title:'topic.md'};
  let menu,saveInlineCalls=0,saveLocalCalls=0,selectCalls=0,persistCalls=0,openCalls=0,newCalls=0,focusCalls=0,switchCalls=0;
  const notifications=[],selected=[];
  const input={value:'Unsent prompt stays intact',focus(){focusCalls++;}};
  const current=()=>state.conversations.find(item=>item.id===state.currentConversationId);
  const document={body:{dataset:{view:'agent'}}};
  function showView(view){document.body.dataset.view=view;showView.navigationVersion++;}
  showView.navigationVersion=0;
  const workbench={access:ContextWorkbench.access,refresh(){}};
  const privateAPI={isOn:()=>privateMode,shows:item=>!item.private&&!item.ephemeral&&!item.incognito};
  const window={
    DocumentChat,ContextSelection,ContextWorkbench:workbench,DocumentOrigin,PrivateMode:privateAPI,
    WorkstationI18n:{getLanguage:()=> 'en'},
    NativeShell:{getNavigationVersion:()=>nativeVersion},
    ReadingPane:{snapshot:()=>reader,reconcile(){},revealWorkspace(){reader.visible=false;reader.retained=true;menu?.onClose?.();}},
    NoteEditor:{getInlineDraft:id=>id==='note-a'?inlineDraft:null,saveInline:async()=>{
      saveInlineCalls++;
      if(options.saveInline)return options.saveInline(api);
      state.notes[0].content=inlineDraft?.text||state.notes[0].content;inlineDraft=null;
      context.previewOpenIntent++; // Saving can legitimately remount the same note.
      return true;
    }},
    ProjectFiles:{parseLocal:id=>id==='local-id'?clone(localRef):null,current:()=>localEditor,
      save:async()=>{saveLocalCalls++;if(options.saveLocal)return options.saveLocal(api);localEditor.dirty=false;localEditor.version='saved-filesystem-version';return true;}},
    FileContextUI:{refresh(){},selectRef:async(ref,args)=>{
      selectCalls++;selected.push({ref:clone(ref),conversationId:args.conversationId,signal:args.signal});
      if(options.selectRef)return options.selectRef(ref,args,api);
      return ref.type==='local'?{...ref,version:localEditor.version,selectedAt:1}:FileContext.libraryRef(state,ref.type,ref.id);
    }},
    ComposerAddMenu:{open(config){menu=config;return true;}},
  };
  const context={window,document,state,structuredClone,AbortController,console,
    DocumentOrigin,PrivateMode:privateAPI,ContextWorkbench:workbench,
    documentChatController:null,documentChatNavigating:false,documentChatRoute:null,
    workspaceRouteIntent:0,previewOpenIntent:0,
    storageHydrated:true,serverConflict:false,purgeTrash:{syncPaused:false},sendMessage:{preflight:false,preparingWiki:false},
    currentConversation:current,showView,
    $:selector=>selector==='#agentInput'?input:null,
    workspaceName:value=>({research:'科研',daily:'日常',courses:'课程'})[value]||value,
    recordMatchesSpace:item=>!!item&&!item.archived&&!item.deleted&&!item.private,
    previewItem:(kind,id)=>kind==='local-file'?{id,name:'topic.md',projectId:'p',version:'WRONG-index-metadata-version'}:(kind==='note'?state.notes:state.imports).find(item=>item.id===id),
    beforePreviewSwitch:async guard=>{switchCalls++;return options.beforeSwitch?options.beforeSwitch(guard,api):true;},
    openConversation:id=>{openCalls++;state.currentConversationId=id;input.value=current().draft||'';showView('agent');},
    newConversation:(workspace,projectId)=>{newCalls++;state.conversations.push({id:'created',workspace,projectId,title:'New',draft:'',messages:[]});state.currentConversationId='created';input.value='';showView('agent');},
    saveDocumentDurably:async()=>{persistCalls++;return options.persist?options.persist(api):true;},
    save(){},renderStagedAttachments(){},toast:message=>notifications.push(message),
  };
  vm.createContext(context);vm.runInContext(production,context);
  const api={context,state,reader,input,notifications,selected,showView,
    source:()=>context.documentChatSource(),targets:()=>context.documentChatTargets(context.documentChatSource()),
    action:()=>context.documentChatAction(reader.tabs.find(tab=>tab.key===reader.activeKey)),
    open:()=>context.openDocumentChat(reader.tabs.find(tab=>tab.key===reader.activeKey),{anchor:{},isCurrent:()=>true}),
    select:async key=>{api.open();const item=menu.items.find(item=>item.id===key);assert.ok(item,`Expected target ${key}`);return item.onSelect();},
    get menu(){return menu;},get saveInlineCalls(){return saveInlineCalls;},get saveLocalCalls(){return saveLocalCalls;},
    get selectCalls(){return selectCalls;},get persistCalls(){return persistCalls;},get openCalls(){return openCalls;},
    get newCalls(){return newCalls;},get focusCalls(){return focusCalls;},get switchCalls(){return switchCalls;},
    get localEditor(){return localEditor;},set localEditor(value){localEditor=value;},
    draft:value=>{inlineDraft=value;},setPrivate:value=>{privateMode=value;},nativeNavigate:()=>{nativeVersion++;},
    local:()=>{reader.tabs=[{key:'local-file:local-id',kind:'local-file',id:'local-id'}];reader.activeKey='local-file:local-id';},
    imported:()=>{reader.tabs=[{key:'import:pdf-a',kind:'import',id:'pdf-a'}];reader.activeKey='import:pdf-a';},
  };
  return api;
}

test('host target menu keeps source/current/project hierarchy, live access rules and project workspace for a new chat',()=>{
  const f=fixture(),targets=clone(f.targets());
  assert.deepEqual(targets.map(item=>item.key),['conversation:origin','conversation:current','conversation:recent','new']);
  assert.equal(targets[0].label,'Source conversation');assert.equal(targets[1].label,'Current conversation');
  assert.equal(targets.at(-1).projectId,'p');assert.equal(targets.at(-1).workspace,'科研');
  f.state.conversations.find(item=>item.id==='origin').deletedAt=1;
  assert.equal(f.targets().some(item=>item.key==='conversation:origin'),false);
  f.state.projects[0].private=true;
  assert.equal(f.source(),null);assert.equal(f.action(),null);
});

test('host saved-note reference preserves exact target composer, sent messages and queue without calling either document writer',async()=>{
  const f=fixture(),conversation=f.state.conversations.find(item=>item.id==='current'),before=clone(conversation);
  assert.equal(await f.select('conversation:current'),true);
  assert.equal(f.input.value,before.draft);assert.equal(conversation.draft,before.draft);
  assert.deepEqual(conversation.messages,before.messages);assert.deepEqual(conversation.queuedMessages,before.queuedMessages);
  assert.equal(conversation.draftFileReferences[0].version,(await FileContext.libraryRef(f.state,'note','note-a')).version);
  assert.equal(f.saveInlineCalls,0);assert.equal(f.saveLocalCalls,0);assert.equal(f.persistCalls,1);
  assert.equal(f.focusCalls,1);assert.equal(f.newCalls,0);
});

test('host dirty note advertises explicit save, accepts same-ID save remount and selects the new saved body',async()=>{
  const f=fixture();f.draft({text:'Edited text to save explicitly'});
  assert.equal(f.source().dirty,true);f.open();
  assert.ok(f.menu.items.every(item=>item.label.startsWith('Save and reference')));
  assert.equal(await f.menu.items.find(item=>item.id==='conversation:current').onSelect(),true);
  assert.equal(f.saveInlineCalls,1);assert.equal(f.state.notes[0].content,'Edited text to save explicitly');
  assert.equal(f.context.previewOpenIntent,1);
  assert.equal(f.state.conversations.find(item=>item.id==='current').draftFileReferences[0].version,(await FileContext.libraryRef(f.state,'note','note-a')).version);
  assert.equal(f.input.value,'Unsent prompt stays intact');
});

test('host local source uses current editor filesystem version, never index metadata, and rejects unavailable editor states',async t=>{
  const f=fixture();f.local();
  assert.equal(f.source().version,'actual-filesystem-version');
  assert.equal(f.source().ref.version,'actual-filesystem-version');
  f.localEditor.dirty=true;f.open();
  assert.equal(await f.menu.items.find(item=>item.id==='conversation:current').onSelect(),true);
  assert.equal(f.saveLocalCalls,1);assert.equal(f.saveInlineCalls,0);
  assert.equal(f.selected[0].ref.version,'saved-filesystem-version');
  assert.equal(f.state.conversations.find(item=>item.id==='current').draftFileReferences[0].version,'saved-filesystem-version');
  for(const state of [{loading:true},{imageBusy:true},{version:''},{id:'other-local-file'}])await t.test(JSON.stringify(state),()=>{
    const invalid=fixture();invalid.local();Object.assign(invalid.localEditor,state);
    assert.equal(invalid.source(),null);assert.equal(invalid.action(),null);
  });
});

test('host import version tracks actual immutable attachment identity and does not use a note writer',async()=>{
  const f=fixture();f.imported();
  assert.equal(f.source().version,JSON.stringify(['pdf-a',1,99,'Source.pdf']));
  assert.equal(await f.select('new'),true);
  const created=f.state.conversations.find(item=>item.id==='created');
  assert.equal(created.projectId,'p');assert.equal(created.workspace,'科研');assert.equal(created.draft,'');
  assert.deepEqual(created.messages,[]);assert.equal(created.draftFileReferences[0].type,'import');
  assert.equal(f.saveInlineCalls,0);assert.equal(f.saveLocalCalls,0);
});

test('changing renderer page, native page or a pending navigation while selectRef waits prevents hidden staging with same conversation',async t=>{
  for(const route of ['renderer','native','workspace-intent'])await t.test(route,async()=>{
    const gate=deferred(),f=fixture({selectRef:()=>gate.promise});
    const pending=f.select('conversation:current');await until(()=>f.selectCalls===1);
    assert.equal(f.state.currentConversationId,'current');
    if(route==='renderer')f.showView('captures');
    if(route==='native')f.nativeNavigate();
    if(route==='workspace-intent')f.context.workspaceRouteIntent++;
    gate.resolve({type:'note',id:'note-a',version:'saved-body'});
    assert.equal(await pending,false);
    assert.equal(f.persistCalls,0);assert.equal(f.focusCalls,0);assert.equal(f.notifications.length,0);
    assert.equal(f.state.conversations.find(item=>item.id==='current').draftFileReferences,undefined);
    assert.equal(f.input.value,'Unsent prompt stays intact');
  });
});

test('late preview-leave approval cannot open a conversation or create one after a newer renderer/native navigation',async t=>{
  for(const target of ['conversation:current','new'])for(const route of ['renderer','native'])await t.test(`${target} / ${route}`,async()=>{
    const gate=deferred(),f=fixture({beforeSwitch:()=>gate.promise});
    const pending=f.select(target);await until(()=>f.switchCalls===1);
    if(route==='renderer')f.showView('captures');else f.nativeNavigate();
    gate.resolve(true);
    assert.equal(await pending,false);
    assert.equal(f.openCalls,0,'Rejected old navigation must not call openConversation first');
    assert.equal(f.newCalls,0,'Rejected old navigation must not create a conversation first');
    assert.equal(f.selectCalls,0);assert.equal(f.persistCalls,0);assert.equal(f.focusCalls,0);
    assert.equal(f.input.value,'Unsent prompt stays intact');
  });
});
