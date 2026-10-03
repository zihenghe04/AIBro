const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const DocumentOrigin=require('../app/document-origin.js'),WorkspaceNavigation=require('../app/workspace-navigation.js');
const source=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
const cut=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,`Missing host boundary: ${start}`);return source.slice(a,b);};
const defer=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve};};
const plain=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
function harness({noteFlush=async()=>true,fileFlush=async()=>true}={}) {
 const state={projects:[{id:'p',name:'Origin project',workspace:'科研'},{id:'q',name:'Other project',workspace:'日常'}],conversations:[{id:'c',projectId:'p',title:'Origin chat',messages:[{id:'m'}]},{id:'other',projectId:'q',messages:[]}],notes:[{id:'n',projectId:'p',title:'Note'}],imports:[{id:'pdf',projectId:'p',name:'Paper.pdf'}],tasks:[{id:'t',projectId:'p'}],currentProjectId:'q',currentConversationId:'other',ui:{projectTab:'tasks',spaceTabs:{research:'papers'},workspaceNavigation:{projects:{p:{section:'knowledge'}}}}};
 const calls=[],frames=[],nodes=new Map();let privateMode=false;const snapshot={visible:false,tabs:[],activeKey:null};
 class Node {constructor(){this.dataset={};this.children=[];}contains(value){return value===this||this.children.some(child=>child.contains(value));}closest(selector){return selector==='[data-message-id]'&&this.dataset.messageId?this:this.parent?.closest(selector)||null;}append(child){child.parent=this;this.children.push(child);}scrollIntoView(options){calls.push(['scroll-message',this.dataset.messageId,options]);}focus(options){calls.push(['focus-message',this.dataset.messageId,options]);}}
 const document={body:{dataset:{view:'agent'}},activeElement:null,getElementById:id=>nodes.get(id),querySelectorAll:()=>[...nodes.values()].filter(node=>node.dataset.messageId)};
 for(const id of ['readingPane','messageList','taskDialog'])nodes.set(id,new Node());
 const message=new Node();message.dataset.messageId='m';nodes.get('messageList').append(message);nodes.set('m',message);
 const $=selector=>nodes.get(selector.replace(/^#/,''))||null;
 const showView=view=>{showView.navigationVersion=(showView.navigationVersion||0)+1;document.body.dataset.view=view;calls.push(['view',view]);};
 const window={DocumentOrigin,WorkspaceNavigation,PrivateMode:{isOn:()=>privateMode,shows:item=>!item.private&&!item.ephemeral},
  ReadingPane:{snapshot:()=>snapshot,revealWorkspace:options=>calls.push(['park',options]),refreshTabs:()=>calls.push(['refresh-tabs'])},
  NoteEditor:{suspendInline:options=>{calls.push(['note-draft',options]);return noteFlush(options);}},ProjectFiles:{suspend:options=>{calls.push(['file-draft',options]);return fileFlush(options);}},
  ConversationWindow:{active:()=>({ensure:id=>{calls.push(['ensure-message',id]);return nodes.get(id);}})},ConversationReading:{reveal:(node,options)=>{calls.push(['reveal-message',node.dataset.messageId]);node.scrollIntoView(options);return true;},remember:()=>{throw Error('remember would restore the old following intent');}}};
 const context=vm.createContext({state,document,window,DocumentOrigin,PrivateMode:window.PrivateMode,$,previewOpenIntent:0,taskEditorIntent:0,taskReturnSequence:0,taskReturnRequest:null,showView,requestAnimationFrame:callback=>frames.push(callback),workspaceName:value=>value,toast:message=>calls.push(['toast',message]),
  previewItem:(kind,id)=>(kind==='note'?state.notes:state.imports).find(item=>item.id===id),
  openConversation:id=>{state.currentConversationId=id;showView('agent');calls.push(['conversation',id]);},
  openPreview:(...args)=>{calls.push(['document',...args]);return Promise.resolve(true);},
  restorePreviewTask:(id,options)=>{calls.push(['task',id,options]);return true;},resolveSpaceSection:(_view,value)=>value||'projects'});
 vm.runInContext(cut('async function beforePreviewSwitch(', '\nfunction canPersistDocumentTab('),context);
 vm.runInContext(cut('let workspaceRouteIntent =','\nlet pdfPreviewVersion ='),context);
 vm.runInContext(cut('function captureDocumentOrigin(','\nasync function openPreview('),context);
 return {context,state,calls,document,window,snapshot,nodes,Node,$,frames,flushFrames:()=>{while(frames.length)frames.shift()();},private:value=>{privateMode=value;},capture:context.captureDocumentOrigin,back:context.returnToDocumentOrigin};
}

test('explicit native origin wins over the hidden renderer route without retaining display or DOM data',()=>{
 const h=harness();assert.deepEqual(plain(h.capture('note','n',{origin:{view:'overview',title:'not persisted',anchor:{id:'not persisted'}}})),{view:'overview'});
 assert.equal(h.capture('note','n',{origin:{view:'invalid'}}),null);assert.equal(h.capture('note','n',{origin:null}),null);
});
test('tab and save retention never replace their existing origin with the background route',()=>{
 const h=harness();assert.equal(h.capture('note','n',{retainOrigin:true,origin:{view:'overview'}}),undefined);
 let editor;h.window.NoteEditor.init=value=>{editor=value;};Object.assign(h.context,{saveDocumentDurably:()=>{},generateNoteSelection:()=>{},renderAll:()=>{},openSavedDocumentSource:(...args)=>h.calls.push(['source-link',...args]),openNote:(...args)=>h.calls.push(['open-note',...args])});
 const line=source.split('\n').find(value=>value.startsWith('window.NoteEditor?.init('));assert.ok(line);vm.runInContext(line,h.context);
 assert.equal(editor.onOpenLink,h.context.openSavedDocumentSource,'The host wires its actual source-link handler alongside save retention');
 editor.onSaved('n',{});assert.deepEqual(plain(h.calls.at(-1)),['open-note','n',{retainOrigin:true}]);const count=h.calls.length;editor.onSaved('n',{leaving:true});assert.equal(h.calls.length,count+1,'A leave-save refreshes tab metadata without reopening its document');
});
test('inline save refreshes metadata without reopening or moving the live editor',()=>{
 const h=harness();let editor,active='n';h.window.NoteEditor.init=value=>{editor=value;};h.window.NoteEditor.inlineActive=id=>id===active;
 h.window.ReadingPane.reconcile=()=>h.calls.push(['reconcile']);
 Object.assign(h.context,{saveDocumentDurably:()=>{},generateNoteSelection:()=>{},renderAll:()=>{},openSavedDocumentSource:()=>{},openNote:()=>{throw Error('reopening reparents the editor and resets viewport');}});
 const heading=new h.Node();heading.textContent='Before';h.nodes.set('previewTitle',heading);h.state.previewRecord={type:'note',id:'n'};h.state.notes[0].title='After';
 vm.runInContext(source.split('\n').find(value=>value.startsWith('window.NoteEditor?.init(')),h.context);
 const scroller={scrollTop:932},selection={start:421,end:421};h.nodes.set('previewDialog',scroller);h.document.activeElement=selection;
 editor.onSaved('n',{inline:true});assert.equal(heading.textContent,'After');assert.equal(scroller.scrollTop,932);assert.equal(h.document.activeElement,selection);assert.deepEqual(h.calls,[['refresh-tabs'],['reconcile']]);
 h.state.previewRecord={type:'note',id:'other'};active='other';heading.textContent='Other document';editor.onSaved('n',{inline:true});assert.equal(heading.textContent,'Other document','an old save cannot replace a new document header');
});
test('reader links capture their predecessor and an already open target retains its route to avoid cycles',()=>{
 const h=harness(),link=new h.Node();h.nodes.get('readingPane').append(link);Object.assign(h.snapshot,{visible:true,activeKey:'a',tabs:[{key:'a',kind:'note',id:'n'}]});
 assert.deepEqual(plain(h.capture('import','pdf',{anchor:link})),{view:'document',kind:'note',id:'n'});
 h.snapshot.tabs.push({key:'b',kind:'import',id:'pdf'});assert.equal(h.capture('import','pdf',{anchor:link}),undefined);
 h.snapshot.visible=false;assert.deepEqual(plain(h.capture('import','pdf',{anchor:link})),{view:'agent',conversationId:'other'},'A parked reader is not the current opening surface');
});
test('an external citation uses its actual message anchor even while portal focus and another reader are present',()=>{
 const h=harness(),anchor=new h.Node();h.nodes.get('m').append(anchor);h.state.currentConversationId='c';h.document.activeElement=new h.Node();Object.assign(h.snapshot,{visible:true,activeKey:'a',tabs:[{key:'a',kind:'note',id:'n'}]});
 assert.deepEqual(plain(h.capture('import','pdf',{anchor})),{view:'agent',conversationId:'c',messageId:'m'});
 h.private(true);assert.equal(h.capture('import','pdf',{anchor}),null);
});
test('project return commits the exact source project section only after both durable draft gates accept',async()=>{
 const gate=defer(),h=harness({noteFlush:()=>gate.promise}),origin={view:'project',projectId:'p',section:'outputs'},pending=h.back(origin);
 assert.equal(h.state.currentProjectId,'q');assert.equal(h.calls.some(call=>call[0]==='park'),false);assert.equal(h.calls[0][0],'note-draft');assert.equal(h.calls[0][1].release,false);
 gate.resolve(true);assert.equal(await pending,true);assert.equal(h.state.currentProjectId,'p');assert.equal(h.state.ui.projectTab,'outputs');assert.deepEqual(h.calls.filter(call=>['note-draft','file-draft','view','park'].includes(call[0])).map(call=>call[0]),['note-draft','file-draft','view','park']);assert.equal(h.calls[1][1].release,false);
});
test('chat return selects the exact conversation and positions its still-valid message',async()=>{
 const h=harness();assert.equal(await h.back({view:'agent',conversationId:'c',messageId:'m'}),true);h.flushFrames();assert.equal(h.state.currentConversationId,'c');assert.deepEqual(h.calls.filter(call=>['conversation','ensure-message','reveal-message','scroll-message','focus-message'].includes(call[0])).map(call=>call.slice(0,2)),[['conversation','c'],['ensure-message','m'],['reveal-message','m'],['scroll-message','m'],['focus-message','m']]);
});
test('return never focuses a retired message even when its original chat remains available',async()=>{
 for(const flag of [{deleted:true},{private:true},{hidden:true}]){const h=harness();Object.assign(h.state.conversations[0].messages[0],flag);assert.equal(await h.back({view:'agent',conversationId:'c',messageId:'m'}),true);h.flushFrames();assert.equal(h.calls.some(call=>call[0]==='ensure-message'||call[0]==='focus-message'),false);}
});
test('queued message positioning never steals focus after a new preview or revoked message and owner',async()=>{
 for(const change of ['preview','message','route','conversation','project','private-mode']){const h=harness();await h.back({view:'agent',conversationId:'c',messageId:'m'});assert.equal(h.frames.length,1);if(change==='preview')h.context.previewOpenIntent++;if(change==='message')h.state.conversations[0].messages[0].private=true;if(change==='route')h.context.showView('captures');if(change==='conversation')h.state.conversations[0].private=true;if(change==='project')h.state.projects[0].deleted=true;if(change==='private-mode')h.private(true);h.flushFrames();assert.equal(h.calls.some(call=>call[0]==='ensure-message'||call[0]==='focus-message'),false,change);}
});
test('unavailable origin or refused draft persistence retains the document without navigation or parking',async()=>{
 for(const target of ['project','agent','document']){const h=harness(),origin=target==='project'?{view:target,projectId:'p',section:'outputs'}:target==='agent'?{view:target,conversationId:'c'}:{view:target,kind:'note',id:'n'};h.state.projects[0].archived=true;assert.equal(await h.back(origin),false);assert.equal(h.calls.some(call=>['park','view','document','note-draft'].includes(call[0])),false);}
 const h=harness({fileFlush:async()=>false});assert.equal(await h.back({view:'project',projectId:'p',section:'outputs'}),false);assert.equal(h.calls.some(call=>['view','park'].includes(call[0])),false);assert.equal(h.state.currentProjectId,'q');
});
test('revoked source, a later preview, a later route and an expired return intent all invalidate an awaited draft gate',async()=>{
 for(const change of ['private','preview','route','intent']){let current=true;const gate=defer(),h=harness({noteFlush:()=>gate.promise}),pending=h.back({view:'project',projectId:'p',section:'outputs'},{isCurrent:()=>current});
  if(change==='private')h.state.projects[0].private=true;if(change==='preview')h.context.previewOpenIntent++;if(change==='route')h.context.showView('captures');if(change==='intent')current=false;
  gate.resolve(true);assert.equal(await pending,false,change);assert.equal(h.calls.some(call=>call[0]==='park'||call[0]==='file-draft'),false,change);assert.equal(h.state.currentProjectId,'q',change);
 }
});
test('returning to a preceding document passes live availability and keeps that document original trail',async()=>{
 const h=harness();assert.equal(await h.back({view:'document',kind:'note',id:'n'}),true);const call=h.calls.at(-1);assert.deepEqual(call.slice(0,3),['document','note','n']);assert.equal(call[6].retainOrigin,true);assert.equal(call[5](),true);h.state.notes[0].deleted=true;assert.equal(call[5](),false);assert.equal(call[6].isCurrent(),false);assert.equal(h.calls.some(call=>call[0]==='park'),false);
});
test('global return preserves its cancellation authority through the destination draft gate',async()=>{
 let current=true,calls=0;const second=defer(),h=harness({noteFlush:()=>++calls===2?second.promise:Promise.resolve(true)}),pending=h.back({view:'research',section:'papers'},{isCurrent:()=>current});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);current=false;second.resolve(true);assert.equal(await pending,false);assert.equal(h.calls.some(call=>call[0]==='park'||call[0]==='view'),false);
});
test('a native destination refusal does not park the reader or claim a successful return',async()=>{
 const h=harness();h.window.workstationDesktop={navigateWorkspace:async route=>{h.calls.push(['native-route',route]);return false;}};assert.equal(await h.back({view:'overview'}),false);assert.equal(h.calls.some(call=>call[0]==='park'),false);assert.equal(h.calls.filter(call=>call[0]==='native-route').length,1);
});
test('agenda is sent to the native workspace router and task return waits for its acknowledged request',async()=>{
 const gate=defer(),h=harness();let request;
 h.window.workstationDesktop={navigateWorkspace:async route=>{request=route;h.calls.push(['native-route',route]);return gate.promise;}};
 h.window.NativeShell={isWorkspaceRequestCurrent:id=>request?.requestId===id};
 const pending=h.back({view:'task',id:'t',entry:{view:'agenda'}});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(request.view,'agenda');assert.match(request.requestId,/^task-return-/);assert.equal(h.calls.some(c=>c[0]==='task'),false);
 gate.resolve(true);assert.equal(await pending,true);assert.deepEqual(plain(h.calls.at(-1)),['task','t',{origin:{view:'agenda'}}]);
});
test('native task return refuses a delayed ACK after a newer native or page route claims its token',async()=>{
 const gate=defer(),h=harness();let current=true;
 h.window.workstationDesktop={navigateWorkspace:()=>gate.promise};h.window.NativeShell={isWorkspaceRequestCurrent:()=>current};
 const pending=h.back({view:'task',id:'t',entry:{view:'overview'}});await new Promise(resolve=>setImmediate(resolve));current=false;gate.resolve(true);
 assert.equal(await pending,false);assert.equal(h.calls.some(c=>c[0]==='task'),false);
});
test('task entry restores its project section but never schedules chat message focus over its task form',async()=>{
 const h=harness();assert.equal(await h.back({view:'task',id:'t',entry:{view:'project',projectId:'p',section:'tasks'}}),true);
 assert.equal(h.state.currentProjectId,'p');assert.equal(h.state.ui.projectTab,'tasks');assert.equal(h.calls.at(-1)[0],'task');
 const chat=harness();assert.equal(await chat.back({view:'task',id:'t',entry:{view:'agent',conversationId:'c',messageId:'m'}}),true);assert.equal(chat.frames.length,0);
});
test('task return after a pure renderer entry cannot cover a later page or pending native navigation',async()=>{
 for(const newer of ['page','native']){
  const h=harness(),gate=defer(),open=h.context.openProject;let version=1;h.window.NativeShell={getNavigationVersion:()=>version};
  h.context.openProject=async(...args)=>{const accepted=await open(...args);await gate.promise;return accepted;};
  const pending=h.back({view:'task',id:'t',entry:{view:'project',projectId:'p',section:'tasks'}});await new Promise(resolve=>setImmediate(resolve));
  if(newer==='native')version++;else await h.context.navigateWorkspaceView('captures');
  gate.resolve(true);assert.equal(await pending,false,newer);assert.equal(h.calls.some(c=>c[0]==='task'),false,newer);
 }
});
test('revoked task entry or task while its draft gate waits leaves the reader and does not reopen task',async()=>{
 for(const revoke of ['entry','task']){
  const gate=defer(),h=harness({noteFlush:()=>gate.promise}),pending=h.back({view:'task',id:'t',entry:{view:'project',projectId:'q',section:'tasks'}});
  if(revoke==='entry')h.state.projects[1].private=true;else h.state.tasks=[];
  gate.resolve(true);assert.equal(await pending,false);assert.equal(h.calls.some(c=>c[0]==='park'||c[0]==='task'),false);
 }
});
