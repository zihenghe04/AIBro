const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const Core=require('../app/workstation-core');
const Evidence=require('../app/citation-evidence');
const PrivateMode=require('../app/private-mode');
function fixture(options={}){
 const posted=[],calls=[],timers=[]; const classes=new Set(),listeners=new Map();
 const state=options.state||{projects:[{id:'p',name:'Travel',workspace:'日常'}],conversations:[],tasks:[{id:'t',title:'Plan',projectId:'p',status:'todo',dueAt:'2026-09-20T12:00:00Z'},{id:'gone',deletedAt:1}],notes:[{id:'n',title:'Note',projectId:'p'}],imports:[],ui:{}};
 const env={state,storageHydrated:true,sendMessage:{busy:false},setInterval(){},document:{hidden:false,addEventListener:(name,handler)=>listeners.set(name,handler),body:{dataset:{view:'daily'},classList:{add:x=>classes.add(x),contains:x=>classes.has(x),toggle:(x,force)=>{const add=force===undefined?!classes.has(x):!!force;add?classes.add(x):classes.delete(x);return add;}}},querySelector:()=>null,getElementById:()=>({click(){calls.push('reader')}})},window:{__aibroPresentationVisible:options.presentationVisible,addEventListener:(name,handler)=>listeners.set(name,handler),dispatchEvent:event=>listeners.get(event.type)?.(event),webkit:{messageHandlers:{workspace:{postMessage:x=>posted.push(x)}}}},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail}},openTask:id=>{calls.push(id);return true;},openNote:id=>calls.push(id),openImport:id=>calls.push(id),openProject:(id,options)=>{calls.push(id);return true},PlanningWorkbench:{createTask:x=>calls.push(x.workspace)}};
 env.setInterval=(callback,ms)=>timers.push({callback,ms});env.window.CitationEvidence=Evidence;
 // The native receiver acknowledges successful projection; posting alone is
 // no longer a delivery receipt. Existing feature fixtures model that peer.
 env.window.webkit.messageHandlers.workspace.postMessage=value=>{posted.push(structuredClone(value));env.window.NativeSnapshotChannel.acknowledge(value._nativeSnapshot);};
 vm.runInNewContext(fs.readFileSync('native/Resources/bridge.js','utf8'),env);return{env,state,posted,calls,classes,listeners,timers,tick:()=>timers.find(timer=>timer.ms===500).callback(),run:x=>env.window.NativeShell.perform(x)};
}
test('native snapshot uses persisted ownership and dates; omits deleted records',()=>{const f=fixture(),s=f.posted[0];assert.equal(s.tasks.length,1);assert.equal(s.tasks[0].workspace,'日常');assert.equal(s.tasks[0].due,Date.parse('2026-09-20T12:00:00Z'));assert.equal(s.documents[0].kind,'note');assert.equal(s.taskCount,1);});
test('native content commands reject missing, archived and unknown targets',()=>{const f=fixture();assert.equal(f.run({type:'task',id:'gone'}),false);assert.equal(f.run({type:'note',id:'missing'}),false);assert.equal(f.run({type:'evil',id:'t'}),false);f.state.projects[0].archivedAt=1;assert.equal(f.run({type:'project',id:'p'}),false);assert.equal(f.calls.length,0);assert.equal(f.run({type:'task',id:'t'}),true);assert.deepEqual(f.calls,['t']);});
test('native document commands forward their visible origin despite a different hidden WebKit project',()=>{
 const f=fixture(),opened=[];f.state.currentProjectId='background-project';f.env.document.body.dataset.view='project';
 f.env.openPreview=(...args)=>opened.push(args);f.state.imports.push({id:'source',name:'Source.pdf',projectId:'another-project'});
 assert.equal(f.run({type:'note',id:'n',origin:{view:'overview'}}),true);
 assert.equal(f.run({type:'import',id:'source',origin:{view:'research',section:'knowledge'}}),true);
 assert.equal(opened.length,2);assert.equal(opened[0][0],'note');assert.equal(opened[1][0],'import');
 for(const args of opened){assert.equal(args.length,6);assert.deepEqual(args.slice(2,5),[undefined,undefined,undefined]);}
 assert.deepEqual(JSON.parse(JSON.stringify(opened[0][5])),{origin:{view:'overview'}});
 assert.deepEqual(JSON.parse(JSON.stringify(opened[1][5])),{origin:{view:'research',section:'knowledge'}});
 assert.equal(f.state.currentProjectId,'background-project');assert.deepEqual(f.calls,[],'explicit native opens do not use implicit-origin wrappers');
});
test('native document origin preserves legacy commands and does not bypass target lifecycle guards',()=>{
 const f=fixture();f.state.imports.push({id:'source',name:'Source.pdf'});let opened=0;f.env.openPreview=()=>opened++;
 assert.equal(f.run({type:'note',id:'n'}),true);assert.equal(f.run({type:'import',id:'source'}),true);assert.deepEqual(f.calls,['n','source']);
 f.state.notes[0].archivedAt=1;f.state.imports[0].private=true;
 assert.equal(f.run({type:'note',id:'n',origin:{view:'overview'}}),false);assert.equal(f.run({type:'import',id:'source',origin:{view:'agenda'}}),false);assert.equal(opened,0);
});
test('native explicit document origin retains the existing command error path',()=>{
 const f=fixture();f.env.openPreview=()=>{throw new Error('reader unavailable')};
 assert.throws(()=>f.run({type:'note',id:'n',origin:{view:'overview'}}),/reader unavailable/);
});
test('quick capture document navigation waits for the real reader and preserves its guarded origin',async()=>{
 for(const type of ['note','import']){
  const f=fixture();if(type==='import')f.state.imports.push({id:'n',name:'Source.pdf',projectId:'p'});
  let release,args,active=false,settled=false;
  f.env.window.ReadingPane={isActive:(kind,id)=>active&&kind===type&&id==='n'};
  f.env.openPreview=(...values)=>{args=values;return new Promise(resolve=>release=resolve);};
  const result=f.run({type,id:'n',quickEntry:true,origin:{view:'overview'}}).then(value=>{settled=true;return value;});
  await Promise.resolve();assert.equal(settled,false,'draft leave and reader opening must finish before ACK');
  assert.equal(args[0],type);assert.equal(args[1],'n');assert.equal(typeof args[4],'function');
  assert.equal(args[5].isCurrent,args[4]);assert.equal(args[4](),true);
  assert.deepEqual(JSON.parse(JSON.stringify(args[5].origin)),{view:'overview'});
  f.state.previewRecord={type,id:'n'};active=true;
  release(undefined);assert.equal(await result,true,'ordinary openPreview success can return undefined');
 }
});
test('quick capture document navigation does not acknowledge a rejected editor leave',async()=>{
 const f=fixture();let reader=true;f.state.previewRecord={type:'note',id:'n'};
 f.env.window.ReadingPane={isActive:()=>reader};f.env.openPreview=async()=>false;
 assert.equal(await f.run({type:'note',id:'n',quickEntry:true}),false,'an already selected reader cannot override a rejected leave guard');
 assert.equal(f.state.previewRecord.id,'n');assert.equal(reader,true);
});
test('quick capture document navigation requires both actual reader selection and matching persisted preview',async()=>{
 for(const mismatch of ['missing-selection','other-selection','inactive-reader','other-reader']){
  const f=fixture();f.env.openPreview=async()=>true;
  f.state.previewRecord=mismatch==='missing-selection'?undefined:{type:'note',id:mismatch==='other-selection'?'other':'n'};
  f.env.window.ReadingPane={isActive:(kind,id)=>mismatch!=='inactive-reader'&&mismatch!=='other-reader'&&kind==='note'&&id==='n'};
  assert.equal(await f.run({type:'note',id:'n',quickEntry:true}),false,mismatch+' must not be reported as opened');
 }
});
test('quick capture document navigation rechecks deletion and inherited privacy after an awaited leave',async()=>{
 for(const revoke of ['removed','project-private','private-mode','hydration','modal']){
  const f=fixture();let release,guard;f.env.window.ReadingPane={isActive:()=>true};
  f.env.openPreview=(type,id,_a,_b,isCurrent)=>{guard=isCurrent;return new Promise(resolve=>release=resolve);};
  const result=f.run({type:'note',id:'n',quickEntry:true});
  assert.equal(guard(),true);
  if(revoke==='removed')f.state.notes=[];
  if(revoke==='project-private')f.state.projects[0].private=true;
  if(revoke==='private-mode')f.env.window.PrivateMode={isOn:()=>true};
  if(revoke==='hydration')f.env.storageHydrated=false;
  if(revoke==='modal')f.env.document.querySelector=selector=>selector==='dialog:modal'?{}:null;
  assert.equal(guard(),false,revoke+' must invalidate the preview callback before it commits');
  f.state.previewRecord={type:'note',id:'n'};release(undefined);
  assert.equal(await result,false,revoke+' must also invalidate a late ACK');
 }
});
test('quick capture document navigation checks fresh access context after state replacement',async()=>{
 const f=fixture();let release,guard;f.env.window.ReadingPane={isActive:()=>true};
 f.env.openPreview=(type,id,_a,_b,isCurrent)=>{guard=isCurrent;return new Promise(resolve=>release=resolve);};
 const result=f.run({type:'import',id:'source',quickEntry:true});
 assert.equal(result,false,'a missing import must never start navigation');
 f.state.imports.push({id:'source',name:'Original.pdf',projectId:'p'});
 const pending=f.run({type:'import',id:'source',quickEntry:true});
 f.env.state={...f.state,projects:[{...f.state.projects[0],private:true}],previewRecord:{type:'import',id:'source'}};
 assert.equal(guard(),false,'access must be evaluated against current state, not the original object');
 release(true);assert.equal(await pending,false);
});
test('quick capture document navigation cannot win after another route claims navigation',async()=>{
 const f=fixture();let release,guard;f.env.window.ReadingPane={isActive:()=>true};
 f.env.openPreview=(type,id,_a,_b,isCurrent)=>{guard=isCurrent;return new Promise(resolve=>release=resolve);};
 const pending=f.run({type:'note',id:'n',quickEntry:true});
 f.env.window.NativeShell.cancelNavigation();assert.equal(guard(),false);
 f.state.previewRecord={type:'note',id:'n'};release(undefined);
 assert.equal(await pending,false,'superseded route cannot acknowledge a hidden old reader');
});
test('a newer quick capture document supersedes an older open still waiting on drafts',async()=>{
 const f=fixture();f.state.imports.push({id:'source',name:'Source.pdf',projectId:'p'});
 const pending=new Map();let actual;
 f.env.window.ReadingPane={isActive:(type,id)=>actual?.type===type&&actual?.id===id};
 f.env.openPreview=(type,id,_a,_b,isCurrent)=>new Promise(resolve=>pending.set(type,{resolve,isCurrent}));
 const old=f.run({type:'note',id:'n',quickEntry:true}),newer=f.run({type:'import',id:'source',quickEntry:true});
 assert.equal(pending.get('note').isCurrent(),false);assert.equal(pending.get('import').isCurrent(),true);
 actual=f.state.previewRecord={type:'import',id:'source'};pending.get('import').resolve(undefined);assert.equal(await newer,true);
 pending.get('note').resolve(undefined);assert.equal(await old,false);
 assert.deepEqual(actual,{type:'import',id:'source'});
});
test('quick capture navigation rejects missing, ambiguous and private targets before opening',()=>{
 for(const revoke of ['missing','duplicate','private','private-mode','modal']){
  const f=fixture();let opened=0;f.env.openPreview=()=>opened++;
  if(revoke==='missing')f.state.notes=[];
  if(revoke==='duplicate')f.state.notes.push({...f.state.notes[0]});
  if(revoke==='private')f.state.notes[0].private=true;
  if(revoke==='private-mode')f.env.window.PrivateMode={isOn:()=>true};
  if(revoke==='modal')f.env.document.querySelector=selector=>selector==='dialog:modal'?{}:null;
  assert.equal(f.run({type:'note',id:'n',quickEntry:true}),false,revoke);assert.equal(opened,0,revoke);
 }
});
test('quick capture reader errors reject without producing a successful snapshot ACK',async()=>{
 const f=fixture();f.env.openPreview=async()=>{throw new Error('draft persist failed');};
 await assert.rejects(f.run({type:'note',id:'n',quickEntry:true}),/draft persist failed/);
 assert.equal(f.state.previewRecord,undefined);assert.deepEqual(f.calls,[]);
});
test('native task open carries its committed entry and reports task lifetime separately from other modals',()=>{
 const f=fixture(),opened=[];let taskOpen=false,modalOpen=false;
 f.env.openTask=(id,options)=>{opened.push({id,...options});taskOpen=modalOpen=true;return true;};
 f.env.taskDocumentOrigin=()=>({view:'task',id:'t',entry:{view:'agenda'}});
 f.env.document.querySelector=selector=>selector==='#taskDialog[open]'&&taskOpen||selector==='dialog:modal'&&modalOpen?{}:null;
 assert.equal(f.run({type:'task',id:'t',origin:{view:'agenda'}}),true);
 assert.deepEqual(JSON.parse(JSON.stringify(opened)),[{id:'t',origin:{view:'agenda'}}]);
 assert.equal(f.posted.at(-1).taskOpen,true);assert.equal(f.posted.at(-1).modalOpen,true);
 assert.equal(f.posted.at(-1).taskEntry.view,'agenda');
 taskOpen=false;f.run({type:'reader'});
 assert.equal(f.posted.at(-1).taskOpen,false);assert.equal(f.posted.at(-1).modalOpen,true);
 assert.equal(f.posted.at(-1).taskEntry,null);
 modalOpen=false;f.classes.add('reading-open');f.run({type:'reader'});
 assert.equal(f.posted.at(-1).readingOpen,true);assert.equal(f.posted.at(-1).modalOpen,false);
});
test('a rejected task cannot be acknowledged as an opened modal',()=>{
 const f=fixture();f.env.openTask=()=>false;
 assert.equal(f.run({type:'task',id:'t',origin:{view:'agenda'}}),false);
 assert.equal(f.posted.at(-1).taskOpen,false);
});
test('task return request stays current only until a newer native or renderer route claims ownership',async()=>{
 const f=fixture();f.env.taskDocumentReturnCurrent=id=>id==='return-A';f.env.workspaceRouteIntent=0;
 f.env.prepareWorkspaceRoute=async options=>{f.env.workspaceRouteIntent++;return ()=>options.isCurrent();};
 f.env.window.ReadingPane={revealWorkspace(){}};
 const accepted=await f.run({type:'workspace-view',id:'agenda',requestId:'return-A'});
 assert.equal(accepted.accepted,true);assert.equal(f.env.window.NativeShell.isWorkspaceRequestCurrent('return-A'),true);
 f.env.workspaceRouteIntent++;
 assert.equal(f.env.window.NativeShell.isWorkspaceRequestCurrent('return-A'),false);
 assert.equal((await f.run({type:'workspace-view',id:'overview',requestId:'return-A'})).accepted,true);
 f.env.window.NativeShell.cancelNavigation();
 assert.equal(f.env.window.NativeShell.isWorkspaceRequestCurrent('return-A'),false);
 assert.equal((await f.run({type:'workspace-view',id:'agenda',requestId:'revoked'})).accepted,false);
});
test('native activity command opens the real host and keeps its navigation overlay visible',()=>{
 const f=fixture();let opened=false;
 const center={open:()=>{opened=true;},isOpen:()=>opened,unreadCount:()=>3};
 f.env.window.ActivityCenter=center;f.env.ActivityCenter=center;
 assert.equal(f.run({type:'activity-center'}),true);
 assert.equal(f.posted.at(-1).activityCenterOpen,true);assert.equal(f.posted.at(-1).activityUnread,3);
 opened=false;f.listeners.get('aibro-activity-center-change')();
 assert.equal(f.posted.at(-1).activityCenterOpen,false);
});
test('native activity badge hides ordinary activity counts in private mode',()=>{
 const f=fixture();f.env.window.ActivityCenter={isOpen:()=>false,unreadCount:()=>9};
 f.env.window.PrivateMode={isOn:()=>true};f.run({type:'reader'});
 assert.equal(f.posted.at(-1).activityUnread,0);
});
test('task creation accepts only valid spaces and reader can reopen',()=>{const f=fixture();assert.equal(f.run({type:'create-task',id:'unknown'}),false);assert.equal(f.run({type:'create-task',id:'课程'}),true);assert.equal(f.run({type:'reader'}),true);assert.deepEqual(f.calls,['课程','reader']);});
test('project task creation binds the exact project and rejects stale destinations',()=>{const f=fixture();let received;f.env.PlanningWorkbench.createTask=x=>{received=x};assert.equal(f.run({type:'create-project-task',id:'p'}),true);assert.equal(received.projectId,'p');assert.equal(received.workspace,'日常');f.state.projects[0].deletedAt=1;received=null;assert.equal(f.run({type:'create-project-task',id:'p'}),false);assert.equal(received,null);});
test('new project conversation awaits its guard, binds persisted owner and rejects archived project',async()=>{const f=fixture();f.env.navigateWorkspaceNewConversation=(workspace,projectId)=>{f.calls.push({workspace,projectId});return true;};assert.equal((await f.run({type:'new-project-conversation',id:'p'})).accepted,true);assert.deepEqual(f.calls,[{workspace:'日常',projectId:'p'}]);f.state.projects[0].archived=true;assert.equal(f.run({type:'new-project-conversation',id:'p'}),false);assert.equal(f.calls.length,1);});

test('native search opens the existing controller and reports overlay visibility without changing route',()=>{
 const f=fixture();let open=false;f.env.openSearchDialog=()=>{open=true;f.calls.push('search')};f.env.document.querySelector=selector=>selector==='#searchDialog[open]'&&open?{}:null;
 assert.equal(f.run({type:'search'}),true);assert.deepEqual(f.calls,['search']);assert.equal(f.posted.at(-1).commandSearchOpen,true);assert.equal(f.posted.at(-1).view,'daily');assert.equal(f.posted.at(-1).commandSearchNavigationVersion,0);
 open=false;f.listeners.get('close')({target:{id:'searchDialog'}});assert.equal(f.posted.at(-1).commandSearchOpen,false);assert.equal(f.posted.at(-1).commandSearchNavigationVersion,0);assert.equal(f.posted.at(-1).view,'daily');
});
test('only successful search activation advances native navigation; pending execution keeps WebKit visible',()=>{
 const f=fixture();let executing=true;f.env.window.CommandSearch={isExecuting:()=>executing};f.run({type:'reader'});assert.equal(f.posted.at(-1).commandSearchOpen,true);assert.equal(f.posted.at(-1).commandSearchNavigationVersion,0);
 f.env.document.body.dataset.view='settings';executing=false;f.listeners.get('aibro-command-search-success')();assert.equal(f.posted.at(-1).commandSearchNavigationVersion,1);assert.equal(f.posted.at(-1).view,'settings');assert.equal(f.posted.at(-1).commandSearchOpen,false);
 f.run({type:'reader'});assert.equal(f.posted.at(-1).commandSearchNavigationVersion,1);
});
test('a fresh bridge resets its search sequence and the Swift receiver accepts that reset before routing again',()=>{
 const old=fixture();for(let i=0;i<3;i++)old.listeners.get('aibro-command-search-success')();assert.equal(old.posted.at(-1).commandSearchNavigationVersion,3);
 const reloaded=fixture();assert.equal(reloaded.posted[0].commandSearchNavigationVersion,0);reloaded.listeners.get('aibro-command-search-success')();assert.equal(reloaded.posted.at(-1).commandSearchNavigationVersion,1);
 // Receiver source is the native integration contract; compiling and native
 // reload acceptance remain part of the root's actual SwiftUI stage check.
 const swift=fs.readFileSync('native/Sources/AIBro/AIBro.swift','utf8');
 const reset=swift.indexOf('if searchVersion < lastCommandSearchNavigation');const advance=swift.indexOf('if searchVersion > lastCommandSearchNavigation');
 assert.ok(reset>=0&&advance>reset);const body=swift.slice(reset,advance);
 assert.match(body,/lastCommandSearchNavigation=searchVersion/);assert.match(body,/commandSearchFollowup=false;commandSearchFollowupOrigin=nil/);
});
test('conversation snapshots retain project IDs independently of folders',()=>{const f=fixture();f.state.conversations.push({id:'chat',title:'Discussion',projectId:'p',folderId:'f',updatedAt:42});f.run({type:'reader'});const row=f.posted.at(-1).conversationLibrary[0];assert.equal(row.projectId,'p');assert.equal(row.folderId,'f');assert.equal(row.updatedAt,42);});

test('native chat snapshot exposes pin and grounded preview, excluding ephemeral chats',()=>{
 const f=fixture();f.env.window.ConversationOrganization=require('../app/conversation-organization');
 f.state.conversations.push({id:'chat',title:'Plan',favorite:true,messages:[{id:'u',role:'user',text:'Organize the project milestones'},{id:'a',role:'assistant',text:'The proposed milestones are research and validation.'}]},{id:'private',ephemeral:true,messages:[]});
 f.run({type:'reader'});const rows=f.posted.at(-1).conversationLibrary;assert.equal(rows.length,1);assert.equal(rows[0].pinned,true);assert.match(rows[0].summaryGoal,/project milestones/);assert.match(rows[0].summaryOutcome,/research and validation/);assert.equal(rows[0].messageCount,2);
});
test('native chat preview completes when live or pending clears without a new text/timestamp',()=>{
 for(const flag of ['live','pending']){
  const f=fixture();f.env.window.ConversationOrganization=require('../app/conversation-organization');
  const answer={id:'a',role:'agent',text:'The reviewed notes are ready for the next seminar.',[flag]:true};
  const chat={id:'chat',title:'Seminar',updatedAt:42,messages:[{id:'u',role:'user',text:'Summarize the seminar preparation notes.'},answer]};
  f.state.conversations.push(chat);f.tick();assert.equal(f.posted.at(-1).conversationLibrary[0].summaryOutcome,'');
  answer[flag]=false;f.tick();assert.match(f.posted.at(-1).conversationLibrary[0].summaryOutcome,/reviewed notes/);
  assert.equal(chat.updatedAt,42);
 }
});
test('native preview invalidates earlier message edits and visibility changes in place',()=>{
 const f=fixture();f.env.window.ConversationOrganization=require('../app/conversation-organization');
 const user={id:'u',role:'user',text:'Compare the seminar notes and the course handbook.'};
 const answer={id:'a',role:'assistant',text:'The handbook contains the assessed learning objectives.'};
 const chat={id:'chat',title:'Notes',messages:[user,answer,{id:'internal',role:'assistant',text:'unchanged',internal:true}]};
 f.state.conversations.push(chat);f.tick();assert.match(f.posted.at(-1).conversationLibrary[0].summaryGoal,/seminar/);
 user.text='Explain how the assessed learning objectives changed.';f.tick();assert.match(f.posted.at(-1).conversationLibrary[0].summaryGoal,/objectives changed/);
 answer.hidden=true;f.tick();assert.equal(f.posted.at(-1).conversationLibrary[0].summaryOutcome,'');
 answer.hidden=false;answer.channel='analysis';f.tick();assert.equal(f.posted.at(-1).conversationLibrary[0].messageCount,1);
 delete answer.channel;answer.deletedAt=1;f.tick();assert.equal(f.posted.at(-1).conversationLibrary[0].summaryOutcome,'');
 delete answer.deletedAt;f.tick();assert.match(f.posted.at(-1).conversationLibrary[0].summaryOutcome,/handbook/);
});
test('native preview observes text content parts changed in the same array',()=>{
 const f=fixture();f.env.window.ConversationOrganization=require('../app/conversation-organization');
 const answer={id:'a',role:'assistant',content:[{type:'text',text:'The first report contains three observations.'}]};
 f.state.conversations.push({id:'chat',messages:[{id:'u',role:'user',text:'What does the report contain?'},answer]});
 f.tick();answer.content[0].text='The updated report now contains five observations.';f.tick();
 assert.match(f.posted.at(-1).conversationLibrary[0].summaryOutcome,/five observations/);
});
test('native preview skips resummarizing streamed text until the reply becomes eligible',()=>{
 const f=fixture(),core=require('../app/conversation-organization');let summaries=0;
 f.env.window.ConversationOrganization={summarize(...args){summaries++;return core.summarize(...args)}};
 const answer={id:'a',role:'agent',live:true,text:'Initial'};
 const chat={id:'chat',messages:[{id:'u',role:'user',text:'Organize my notes into a readable report.'},answer]};
 f.state.conversations.push(chat);f.tick();const posts=f.posted.length;
 for(let i=0;i<100;i++){answer.text+=' streamed word';f.tick();}
 assert.equal(summaries,1);assert.equal(f.posted.length,posts);
 answer.live=false;f.tick();assert.equal(summaries,2);assert.equal(f.posted.length,posts+1);
 f.tick();assert.equal(summaries,2);
 chat.messages.push({id:'u2',role:'user',text:'Now compare this report with last week.'});f.tick();
 assert.equal(f.posted.at(-1).conversationLibrary[0].summaryOutcome,'');
 assert.match(f.posted.at(-1).conversationLibrary[0].summaryGoal,/last week/);
 f.env.document.documentElement={lang:'en'};f.tick();assert.match(f.posted.at(-1).conversationLibrary[0].summary,/Awaiting a reply/);
});
test('native pin action awaits the organization persistence callback',async()=>{
 const f=fixture();let resolve;let command;f.env.commitConversationOrganization=async value=>{command=value;await new Promise(done=>resolve=done);};
 let settled=false;const pending=f.env.window.NativeConversationActions.perform({action:'pin',kind:'conversation',id:'chat',pinned:'true'}).then(()=>settled=true);
 await Promise.resolve();assert.equal(settled,false);assert.equal(command.conversationId,'chat');assert.equal(command.pinned,true);resolve();await pending;assert.equal(settled,true);
});

test('background WebView rendering follows actual visibility changes',()=>{const f=fixture();assert.equal(f.classes.has('native-background-render'),false);f.env.document.hidden=true;f.listeners.get('visibilitychange')();assert.equal(f.classes.has('native-background-render'),true);f.env.document.hidden=false;f.listeners.get('visibilitychange')();assert.equal(f.classes.has('native-background-render'),false);});

test('native surface state is retained before readiness and combines with document visibility without stopping snapshots',()=>{
 const f=fixture({presentationVisible:false});assert.equal(f.classes.has('native-background-render'),true,'opacity-hidden host is paused even when WebKit reports visible');
 const host=fs.readFileSync('native/Sources/AIBro/WebGlassHost.swift','utf8');
 const source=host.match(/let script="([^\n]+)"/)[1];
 const publish=visible=>vm.runInNewContext(source.replaceAll('\\(value)',String(visible)),f.env);
 f.env.document.hidden=true;publish(true);assert.equal(f.env.window.__aibroPresentationVisible,true);assert.equal(f.classes.has('native-background-render'),true);
 f.env.document.hidden=false;f.listeners.get('visibilitychange')();assert.equal(f.classes.has('native-background-render'),false);
 publish(false);assert.equal(f.classes.has('native-background-render'),true);assert.equal(f.env.window.__aibroPresentationVisible,false);
 f.state.tasks[0].status='done';assert.equal(f.run({type:'reader'}),true);assert.equal(f.posted.at(-1).taskCount,0,'hidden presentation continues native data synchronization');
 publish(true);assert.equal(f.classes.has('native-background-render'),false);assert.equal(f.state.tasks[0].status,'done');
});

test('persistent native presentation integrates route, compact browser, actual window state and reload replay',()=>{
 const swift=fs.readFileSync('native/Sources/AIBro/AIBro.swift','utf8'),host=fs.readFileSync('native/Sources/AIBro/WebGlassHost.swift','utf8'),browser=fs.readFileSync('native/Sources/AIBro/NativeBrowserView.swift','utf8');
 assert.match(swift,/source:"window\.__aibroPresentationVisible=false;window\.__aibroSurfaceVisible=false;",injectionTime:\.atDocumentStart,forMainFrameOnly:true/);
 assert.match(swift,/WebContent\(model:model,surfaceVisible:workspaceVisible && !nativeContent\)/);
 assert.match(swift,/updateNSView[^\n]+view\.setSurfaceVisible\(surfaceVisible\)/);
 assert.match(browser,/content\(layout\.workspaceVisible\)/);
 const predicate=host.slice(host.indexOf('var presentationVisible:Bool'),host.indexOf('func beginPresentationNavigation'));
 for(const expected of ['surfaceVisible','bounds.width>0','bounds.height>0','isHiddenOrHasHiddenAncestor','window.isVisible','window.isMiniaturized','NSApp.isHidden','window.occlusionState.contains(.visible)'])assert.ok(predicate.includes(expected),expected);
 assert.doesNotMatch(predicate,/isKeyWindow|isMainWindow|firstResponder|isActive/,'focus is not presentation visibility');
 for(const event of ['didChangeOcclusionStateNotification','didMiniaturizeNotification','didDeminiaturizeNotification','didHideNotification','didUnhideNotification'])assert.ok(host.includes(event),event);
 const navigationStart=swift.slice(swift.indexOf('didStartProvisionalNavigation'),swift.indexOf('func webView(_ webView:WKWebView,didCommit'));
 assert.match(navigationStart,/beginPresentationNavigation\(\)/);
 for(const event of ['didCommit','didFinish'])assert.match(swift,new RegExp(event+'[^\\n]+publishPresentationVisibility\\(force:true\\)'));
 assert.match(host,/if error != nil,self\?\.publicationVersion == version\{self\?\.publishedVisibility=nil\}/);
 assert.match(host,/deinit\{NotificationCenter\.default\.removeObserver\(self\)\}/);
});

test('native refresh leaves an existing Kit selector and its single input owner intact',()=>{
 const f=fixture();let inserted=0;const owner={dataset:{halaskaRoot:'LibraryToolbar'}};
 const select={closest:selector=>selector==='[data-halaska-root]'?owner:null,after:()=>inserted++};
 f.env.document.querySelectorAll=selector=>selector==='select:not([multiple])'?[select]:[];
 f.env.document.createElement=()=>{throw Error('Native refresh must not add controls inside a React-owned selector');};
 for(let i=0;i<5;i++)assert.equal(f.run({type:'reader'}),true);
 assert.equal(inserted,0);
});

test('overview snapshot carries priority and updates dependency readiness without changing tasks',()=>{
 const f=fixture(),task=f.state.tasks[0];task.priority='high';task.dependsOn=['before'];
 const before={id:'before',projectId:task.projectId,status:'todo'};f.state.tasks.push(before);
 f.run({type:'reader'});let current=f.posted.at(-1).tasks.find(t=>t.id===task.id);
 assert.equal(current.priority,'high');assert.equal(current.waitingOnDependencies,true);
 before.status='done';f.run({type:'reader'});current=f.posted.at(-1).tasks.find(t=>t.id===task.id);
 assert.equal(current.waitingOnDependencies,false);assert.equal(task.status,'todo');
 before.deletedAt=1;f.run({type:'reader'});assert.equal(f.posted.at(-1).tasks[0].waitingOnDependencies,true);
});

// Exercise the existing task mutation (including persistence and timestamps), not a mock toggle.
test('native completion persists, updates counts, is idempotent and never opens details',()=>{
 const f=fixture();f.env.save=()=>f.calls.push('save');f.env.renderAll=()=>f.calls.push('render');f.env.toast=()=>{};
 const app=fs.readFileSync('app/app.js','utf8');
 vm.runInNewContext(app.match(/function toggleTaskStatus\(taskId\) \{[^\n]+/)[0],f.env);
 assert.equal(f.run({type:'complete-task',id:'t'}),true);
 assert.equal(f.state.tasks[0].status,'done');assert.ok(f.state.tasks[0].completedAt);assert.ok(f.state.tasks[0].updatedAt);
 assert.equal(f.posted.at(-1).taskCount,0);assert.deepEqual(f.calls,['save','render']);
 const completedAt=f.state.tasks[0].completedAt;
 assert.equal(f.run({type:'complete-task',id:'t'}),true);assert.equal(f.state.tasks[0].completedAt,completedAt);assert.equal(f.calls.length,2);
 assert.equal(f.run({type:'reopen-task',id:'t'}),true);assert.equal(f.state.tasks[0].status,'todo');assert.equal(f.state.tasks[0].completedAt,null);assert.equal(f.posted.at(-1).taskCount,1);
 for(const id of ['gone','missing'])assert.equal(f.run({type:'complete-task',id}),false);
 f.state.tasks[0].archivedAt=1;assert.equal(f.run({type:'reopen-task',id:'t'}),false);
 f.env.storageHydrated=false;assert.equal(f.run({type:'complete-task',id:'t'}),false);
});


test('comparison lifecycle snapshot preserves native overlay until async navigation settles',()=>{
 const f=fixture();let open=true;f.env.window.SourceComparison={isOpen:()=>open};
 f.listeners.get('aibro-comparison-change')();assert.equal(f.posted.at(-1).comparisonOpen,true);
 f.listeners.get('aibro-comparison-change')();assert.equal(f.posted.at(-1).comparisonOpen,true);
 open=false;f.listeners.get('aibro-comparison-change')();assert.equal(f.posted.at(-1).comparisonOpen,false);
 assert.equal(f.posted.at(-1).view,'daily');assert.equal(f.calls.length,0);
});

test('native routes and every WebKit hiding transition dismiss the transient model picker',()=>{
 const swift=fs.readFileSync('native/Sources/AIBro/AIBro.swift','utf8');
 const navigate=swift.match(/func navigate\(_ value: String\?\) \{([\s\S]*?)\n    \}/)[1];
 const openWorkspace=swift.match(/func openWorkspace\(_ view:String,section:String\?=nil\) \{([\s\S]*?)\n    \}/)[1];
 assert.match(openWorkspace,/dismissTransientModelPicker\(\)/);
 assert.match(openWorkspace,/command\("workspace-view",view == "dashboard" \? "overview":view,section:section\)/);
 // Use the same actual visibility predicate, covering space overview and
 // search/activity/comparison overlays returning to native dashboards.
 assert.match(swift,/WebContent\(model:model,surfaceVisible:workspaceVisible && !nativeContent\)\.opacity\(nativeContent \? 0 : 1\)/);
 assert.match(swift,/\.onChange\(of:nativeContent\)\{_,hidden in if hidden \{model\.dismissTransientModelPicker\(\)\}\}/);
 const visibility=swift.match(/var nativeContent:Bool \{([^\n]+)\}/)[1];
 assert.match(visibility,/spaceName != nil &&.*!model\.spaceContent/);
 assert.match(visibility,/if workspaceOverlay \{return false\}/);
 const overlays=swift.match(/var workspaceOverlay:Bool \{([^\n]+)\}/)[1];
 for(const overlay of ['modalOpen','tourOpen','commandSearchOpen','activityCenterOpen','comparisonOpen','commandSearchFollowup'])assert.ok(overlays.includes(overlay));
});

test('native dismissal executes the actual close lifecycle without cancelling a pending save or reader',()=>{
 const swift=fs.readFileSync('native/Sources/AIBro/AIBro.swift','utf8'),hook=swift.match(/func dismissTransientModelPicker\(\) \{([\s\S]*?)\n    \}/)[1];
 assert.match(hook,/guard ready else \{ return \}/);
 const script=hook.match(/web\.evaluateJavaScript\("([^"]+)"/)[1];
 const model=fs.readFileSync('app/model-picker.js','utf8'),closeLifecycle=model.slice(model.indexOf('  function finishClose('),model.indexOf('  function changeProvider('));
 let abortedCatalogue=0;const picker={hidden:false},reader={hidden:false},otherDialog={open:true},attributes={};
 const transaction={state:'waiting for durable ACK'},env={transaction,document:{},$:id=>id==='modelPicker'?picker:id==='composerModel'?{setAttribute:(key,value)=>attributes[key]=value}:null};
 env.window=env;vm.createContext(env);vm.runInContext(`let saving=true,presented=true,closing=false,version=4,pendingPreference=transaction,returnFocus=null;let fetchAbort={abort:()=>catalogueAbort()};${closeLifecycle};window.ConversationModels={close};`,Object.assign(env,{catalogueAbort:()=>abortedCatalogue++}));
 assert.equal(vm.runInContext('ConversationModels.close()',env),false,'ordinary close keeps an in-flight save visible');
 vm.runInContext(script,env);
 assert.equal(picker.hidden,true);assert.equal(attributes['aria-expanded'],'false');assert.equal(abortedCatalogue,1);
 assert.equal(vm.runInContext('saving',env),true);assert.equal(vm.runInContext('pendingPreference',env),transaction,'durable transaction still owns its ACK and rollback');
 assert.equal(vm.runInContext('version',env),5,'late catalogue/UI continuations are invalidated');
 assert.equal(reader.hidden,false);assert.equal(otherDialog.open,true);assert.equal(transaction.state,'waiting for durable ACK');
 assert.doesNotMatch(script,/ReadingPane|querySelectorAll|stop|abort|save/i);
});


test('route hiding dismisses only transient menus and window occlusion leaves them untouched',()=>{
 const f=fixture(),closed=[];
 f.env.window.ConversationModels={close:options=>closed.push(['model',options.restoreFocus,options.force])};
 f.env.window.ComposerAddMenu={close:options=>closed.push(['add',options.restoreFocus])};
 f.env.window.WorkspaceNavigation={dismissTransient:()=>closed.push(['conversation-menu'])};
 f.env.window.__aibroPresentationVisible=false;f.listeners.get('aibro:presentation-visibility')();
 assert.deepEqual(closed,[],'ordinary occlusion must not discard transient input state');
 const before=JSON.stringify(f.state);
 f.env.window.__aibroSurfaceVisible=false;f.listeners.get('aibro:surface-visibility')();
 assert.deepEqual(closed,[['model',false,true],['add',false],['conversation-menu']]);
 assert.equal(JSON.stringify(f.state),before,'hiding menus must not mutate workspace drafts or records');
 f.env.window.__aibroSurfaceVisible=true;f.listeners.get('aibro:surface-visibility')();
 assert.equal(closed.length,3,'returning does not replay close or steal focus');
});


test('project route carries a structured section and awaits the guarded controller ACK',async()=>{
 const f=fixture();let release,received,settled=false;
 f.env.openProject=(id,options)=>{received={id,options};return new Promise(resolve=>release=resolve)};
 const count=f.posted.length,pending=f.run({type:'project',id:'p',section:'knowledge'}).then(result=>{settled=true;return result});
 await Promise.resolve();assert.equal(settled,false);assert.equal(f.posted.length,count);
 assert.equal(received.id,'p');assert.equal(received.options.section,'knowledge');assert.equal(received.options.isCurrent(),true);
 f.env.document.body.dataset.view='project';f.state.currentProjectId='p';f.state.ui.projectTab='knowledge';release(true);
 assert.equal((await pending).accepted,true);assert.equal(f.posted.at(-1).projectSection,'knowledge');
});

test('project ID punctuation is never parsed as a section and missing section delegates restoration',async()=>{
 const f=fixture();const id='project:2026:科研/notes';f.state.projects[0].id=id;
 let received;f.env.openProject=(projectID,options)=>{received={projectID,options};return true;};
 assert.equal((await f.run({type:'project',id})).accepted,true);assert.equal(received.projectID,id);assert.equal(received.options.section,undefined);
 for(const section of ['sources','unknown','',null,{},'conversations:other'])assert.equal(f.run({type:'project',id,section}),false);
});

test('project draft cancellation or failure never reports successful route completion',async()=>{
 const f=fixture();const before=f.posted.length;
 f.env.openProject=()=>Promise.resolve(false);assert.equal((await f.run({type:'project',id:'p'})).accepted,false);assert.equal(f.posted.length,before);
 f.env.openProject=()=>Promise.reject(Error('draft flush failed'));
 await assert.rejects(f.run({type:'project',id:'p'}),/draft flush failed/);assert.equal(f.posted.length,before);
});

test('newer native intent invalidates a waiting project guard including native-only destinations',async()=>{
 for(const destination of ['project','conversation','native']){
  const f=fixture();let first,second;f.state.projects.push({id:'p2',name:'Other'});f.state.conversations.push({id:'c'});
  f.env.openProject=(id,options)=>new Promise(resolve=>{if(id==='p')first={options,resolve};else second={options,resolve};});
  f.env.navigateWorkspaceConversation=(id,options)=>new Promise(resolve=>second={options,resolve});
  const older=f.run({type:'project',id:'p',section:'outputs'});assert.equal(first.options.isCurrent(),true);
  let newer;
  if(destination==='native')f.env.window.NativeShell.cancelNavigation();
  else newer=f.run({type:destination,id:destination==='project'?'p2':'c'});
  assert.equal(first.options.isCurrent(),false,'the actual draft controller sees stale ownership before commit');
  first.resolve(true);assert.equal((await older).accepted,false);
  if(newer){assert.equal(second.options.isCurrent(),true);second.resolve(true);assert.equal((await newer).accepted,true);}
 }
});

test('conversation entry awaits the same durable route controller instead of raw openConversation',async()=>{
 const f=fixture();f.state.conversations.push({id:'chat'});let release,options;
 f.env.openConversation=()=>{throw Error('must use draft guard')};
 f.env.navigateWorkspaceConversation=(id,value)=>{assert.equal(id,'chat');options=value;return new Promise(resolve=>release=resolve)};
 const pending=f.run({type:'conversation',id:'chat'});assert.equal(options.isCurrent(),true);release(false);assert.equal((await pending).accepted,false);
});

test('project sidebar entry and project chat shortcut share a structured project command',()=>{
 const swift=fs.readFileSync('native/Sources/AIBro/AIBro.swift','utf8');
 const shortcut=swift.split('\n').find(line=>line.includes('"全部项目会话"'));
 assert.match(shortcut,/model\.openProject\(item\.id,section:"conversations"\)/);assert.doesNotMatch(shortcut,/conversationProjectFilter|selection="conversations"/);
 assert.match(swift,/func openProject\(_ id:String,section:String\?=nil\)/);
 assert.match(swift,/arguments:\["command":payload\]/);
 assert.match(swift,/return await window\.NativeShell\?\.perform\(command\);/);
 assert.match(swift,/if tag=="conversations"\{model\.conversationProjectFilter=""\}/,'global all chats retains its own unfiltered hub');
 assert.match(swift,/commandSearchSelection=selection == destination \? nil:destination/,'a committed page route never dispatches its draft gate a second time');
});


test('cancelled native navigation acknowledges the actual newer in-page destination',async()=>{
 const f=fixture();let release;f.env.showView=()=>{};f.env.showView.navigationVersion=7;f.env.workspaceRouteIntent=1;
 f.env.openProject=()=>{f.env.workspaceRouteIntent++;return new Promise(resolve=>release=resolve)};
 const pending=f.run({type:'project',id:'p'});
 f.env.showView.navigationVersion++;f.env.workspaceRouteIntent++;f.env.document.body.dataset.view='agent';f.state.currentConversationId='page:chosen';
 f.state.conversations.push({id:'page:chosen',projectId:'other'});
 release(false);const acknowledgment=await pending;
 assert.equal(acknowledgment.accepted,false);assert.equal(acknowledgment.supersededByPage,true);
 assert.equal(acknowledgment.destination.view,'agent');assert.equal(acknowledgment.destination.conversationId,'page:chosen');assert.equal(acknowledgment.destination.projectId,'other');
 assert.equal(f.posted.at(-1).conversationId,'page:chosen');
});

test('the controller own intent is not a superseding page route, while pending page or reader intent is',async()=>{
 for(const cause of ['failed-flush','pending-page','reader']){
  const f=fixture();let release;f.env.workspaceRouteIntent=2;f.env.previewOpenIntent=3;
  f.env.openProject=()=>{f.env.workspaceRouteIntent++;return new Promise(resolve=>release=resolve)};
  const pending=f.run({type:'project',id:'p'});
  if(cause==='pending-page')f.env.workspaceRouteIntent++;
  if(cause==='reader')f.env.previewOpenIntent++;
  release(false);const acknowledgment=await pending;
  assert.equal(acknowledgment.supersededByPage,cause!=='failed-flush',cause);
 }
});

test('a newer native destination cannot be mislabeled as superseding in-page navigation',async()=>{
 const f=fixture();let release;f.env.showView=()=>{};f.env.openProject=()=>new Promise(resolve=>release=resolve);
 const pending=f.run({type:'project',id:'p'});f.env.window.NativeShell.cancelNavigation();f.env.showView.navigationVersion=9;
 release(false);const acknowledgment=await pending;assert.equal(acknowledgment.accepted,false);assert.equal(acknowledgment.supersededByPage,false);
});


test('an older rejected flush cannot replace a later in-page destination with its native origin',async()=>{
 const f=fixture();let reject;f.env.showView=()=>{};f.env.showView.navigationVersion=1;
 f.env.openProject=()=>new Promise((resolve,fail)=>reject=fail);
 const pending=f.run({type:'project',id:'p'});f.env.showView.navigationVersion++;f.env.document.body.dataset.view='captures';
 reject(Error('old flush failed'));const acknowledgment=await pending;
 assert.equal(acknowledgment.accepted,false);assert.equal(acknowledgment.supersededByPage,true);assert.equal(acknowledgment.destination.view,'captures');
});


test('native-only global destinations await durable route preparation without changing renderer page',async()=>{
 for(const view of ['overview','conversations','agenda']){
  const f=fixture();let release,options,parked=0;f.env.prepareWorkspaceRoute=value=>{options=value;return new Promise(resolve=>release=resolve)};
  f.env.window.ReadingPane={revealWorkspace:()=>parked++};
  const pending=f.run({type:'workspace-view',id:view});assert.equal(parked,0);assert.equal(options.isCurrent(),true);
  release(()=>true);const ack=await pending;assert.equal(ack.accepted,true);assert.equal(ack.destination.view,view);assert.equal(parked,1);assert.equal(f.env.document.body.dataset.view,'daily');
 }
});

test('cancelled global route keeps retained reader and reports newer page ownership',async()=>{
 const f=fixture();let release,parked=0;f.env.prepareWorkspaceRoute=()=>new Promise(resolve=>release=resolve);f.env.window.ReadingPane={revealWorkspace:()=>parked++};f.env.workspaceRouteIntent=1;
 const pending=f.run({type:'workspace-view',id:'overview'});f.env.workspaceRouteIntent++;f.env.document.body.dataset.view='captures';release(null);
 const ack=await pending;assert.equal(ack.accepted,false);assert.equal(ack.supersededByPage,true);assert.equal(ack.destination.view,'captures');assert.equal(parked,0);
});

test('space navigation and all new conversation entries share guarded real APIs with explicit scope',async()=>{
 const f=fixture();let received;
 f.env.navigateWorkspaceView=(view,options)=>{received={view,options};f.env.document.body.dataset.view=view;f.state.ui.spaceTabs={[view]:options.section};return true;};
 for(const [view,section] of [['daily','projects'],['courses','tasks'],['research','papers']]){
  const ack=await f.run({type:'workspace-view',id:view,section});assert.equal(ack.accepted,true);assert.equal(received.view,view);assert.equal(received.options.section,section);assert.equal(ack.destination.spaceSection,section);
 }
 assert.equal(f.run({type:'workspace-view',id:'daily',section:'papers'}),false);assert.equal(f.run({type:'workspace-view',id:'unknown'}),false);
 f.env.navigateWorkspaceNewConversation=(workspace,projectId,options)=>{received={workspace,projectId,options};return false;};
 for(const [type,id,workspace,project] of [['new','','auto',null],['new-space-conversation','课程','课程',null],['new-research-conversation','','科研',null],['new-project-conversation','p','日常','p']]){
  assert.equal((await f.run({type,id})).accepted,false);assert.equal(received.workspace,workspace);assert.equal(received.projectId,project);assert.equal(received.options.isCurrent(),true);
 }
});

test('space header marker is tied to native ownership, not a hidden renderer route',()=>{
 const f=fixture();f.env.document.body.dataset.view='research';f.run({type:'reader'});assert.equal(f.classes.has('aibro-native-space-navigation'),false);
 f.env.window.__aibroSpaceNavigationView='research';f.listeners.get('aibro-native-space-navigation')();assert.equal(f.classes.has('aibro-native-space-navigation'),true);
 f.env.document.body.dataset.view='wiki';f.run({type:'reader'});assert.equal(f.classes.has('aibro-native-space-navigation'),true);
 f.env.window.__aibroSpaceNavigationView=null;f.listeners.get('aibro-native-space-navigation')();assert.equal(f.classes.has('aibro-native-space-navigation'),false);
});

test('native space projections exclude inaccessible parents and private records while retaining orphans',()=>{
 const f=fixture();f.state.projects.push({id:'archived',archived:true},{id:'private',private:true},{id:'dup'},{id:'dup'});
 f.state.tasks=[{id:'a',projectId:'archived'},{id:'b',projectId:'private'},{id:'c',projectId:'dup'},{id:'d',projectId:'missing',workspace:'课程'},{id:'e',private:true},{id:'f',workspace:'日常'}];
 f.state.notes=[{id:'n1',projectId:'archived'},{id:'n2',projectId:'missing'},{id:'n3',incognito:true}];
 f.state.imports=[{id:'i1',ephemeral:true},{id:'i2'}];f.run({type:'reader'});
 const s=f.posted.at(-1);assert.deepEqual(s.tasks.map(x=>x.id),['d','f']);assert.equal(s.taskCount,2);assert.equal(s.noteCount,1);assert.equal(s.sourceCount,1);assert.deepEqual(s.projects.map(x=>x.id),['p']);
});

test('snapshot space sections resolve the legacy content alias through the root canonical API',()=>{
 const f=fixture();f.state.ui.spaceTabs={daily:'content'};f.env.resolveSpaceSection=(view,value)=>value==='content'?'knowledge':value||'projects';f.run({type:'reader'});
 assert.equal(f.posted.at(-1).spaceSection,'knowledge');
});

function generatedNativeOutputs(privateOrigin,{purge=false}={}){
 let state={projects:[{id:'p',name:'Public project',workspace:'日常'}],conversations:[],agentRuns:[],notes:[],tasks:[],imports:[],papers:[],attachments:[],links:[],trash:[],ui:{}};
 PrivateMode.init({getState:()=>state,save(){}});
 const run={id:'origin-run',conversationId:'origin-chat',projectId:'p',workspace:'日常',status:'running',startedAt:1};
 state.conversations.push({id:run.conversationId,ephemeral:privateOrigin,projectId:'p',workspace:'日常',messages:[]});state.agentRuns.push(run);
 let sequence=0;
 state=Core.applyPlan(state,[
  {type:'create_knowledge_item',title:'DERIVED_NOTE_SENTINEL',content:'Synthetic retained output.'},
  {type:'create_task',title:'DERIVED_TASK_SENTINEL'}
 ],{workspace:'日常',projectId:'p',conversationId:run.conversationId,runId:run.id,provenanceRun:run,uid:prefix=>prefix+'-'+(++sequence),now:10}).state;
 for(const value of [state.notes[0],state.tasks[0]]){
  assert.equal(!!value.provenance.origin.private,privateOrigin);
  assert.equal(!!value.private,false,'the regression concerns inherited privacy, not a top-level flag');
 }
 // Imports do not use Core's artifact writer; exercise their persisted origin
 // contract separately while keeping note/task creation on the real path.
 state.imports.push({id:'derived-import',name:'DERIVED_IMPORT_SENTINEL',projectId:'p',provenance:{origin:structuredClone(state.notes[0].provenance.origin)}});
 if(purge){
  assert.deepEqual(PrivateMode.purge(),{removedConversations:1,removedRuns:1});
  assert.equal(state.conversations.length,0);assert.equal(state.agentRuns.length,0);
  assert.equal(state.notes.length,1);assert.equal(state.tasks.length,1);
 }
 state.notes.push({id:'public-note',title:'Public note'});state.tasks.push({id:'public-task',title:'Public task',status:'todo'});state.imports.push({id:'public-import',name:'Public import'});
 return state;
}

test('native privacy excludes real Core outputs after actual PrivateMode purge and persistence restart',()=>{
 const original=generatedNativeOutputs(true,{purge:true});
 for(const state of [original,JSON.parse(JSON.stringify(original))]){
  for(const [type,key] of [['note','notes'],['task','tasks'],['import','imports']])assert.equal(Evidence.access(state,{type,id:state[key][0].id}).kind,'private');
  const f=fixture({state}),snapshot=f.posted.at(-1);
  assert.doesNotMatch(JSON.stringify(snapshot),/DERIVED_(?:NOTE|TASK|IMPORT)_SENTINEL/);
  assert.deepEqual(snapshot.tasks.map(value=>value.id),['public-task']);
  assert.deepEqual(Array.from(snapshot.documents,value=>value.id),['public-note','public-import']);
  assert.equal(snapshot.taskCount,1);assert.equal(snapshot.noteCount,1);assert.equal(snapshot.sourceCount,1);
 }
});

test('native privacy preserves real public Core outputs when their original conversation and run retire',()=>{
 for(const retire of [
  state=>{state.conversations[0].archived=true;state.agentRuns[0].deletedAt=20;},
  state=>{state.trash.push({data:{runs:state.agentRuns,conversations:state.conversations}});state.agentRuns=[];state.conversations=[];},
  state=>{state.agentRuns=[];state.conversations=[];state.trash=[];}
 ]){
  const state=generatedNativeOutputs(false);retire(state);
  const f=fixture({state}),snapshot=f.posted.at(-1);
  for(const [type,key] of [['note','notes'],['task','tasks'],['import','imports']]){
   assert.notEqual(Evidence.access(state,{type,id:state[key][0].id}).kind,'private');
   assert.ok((type==='task'?snapshot.tasks:snapshot.documents).some(value=>value.id===state[key][0].id));
  }
  assert.equal(snapshot.taskCount,2);assert.equal(snapshot.noteCount,2);assert.equal(snapshot.sourceCount,2);
 }
});

test('native privacy matches CitationEvidence across live, retained, duplicate and cyclic ancestry',()=>{
 const cases={
  'direct-private':(state,item)=>{item.private=true;},
  'direct-ephemeral':(state,item)=>{item.ephemeral=true;},
  'direct-incognito':(state,item)=>{item.incognito=true;},
  'durable-origin':(state,item)=>{item.provenance={origin:{private:true}};},
  'live-run':(state,item)=>{item.agentRunId='r';state.agentRuns=[{id:'r',private:true}];},
  'live-conversation':(state,item)=>{item.sourceConversationId='c';state.conversations=[{id:'c',ephemeral:true}];},
  'origin-run':(state,item)=>{item.provenance={origin:{runId:'r'}};state.agentRuns=[{id:'r',incognito:true}];},
  'origin-conversation':(state,item)=>{item.provenance={origin:{conversationId:'c'}};state.conversations=[{id:'c',private:true}];},
  'trash-runs':(state,item)=>{item.runId='r';state.trash=[{data:{runs:[{id:'r',private:true}]}}];},
  'trash-agentRuns':(state,item)=>{item.runId='r';state.trash=[{data:{agentRuns:[{id:'r',private:true}]}}];},
  'trash-project':(state,item)=>{item.projectId='retired';state.trash=[{data:{projects:[{id:'retired',private:true}]}}];},
  'trash-chat':(state,item)=>{item.conversationId='c';state.trash=[{data:{conversations:[{id:'c',private:true}]}}];},
  'origin-project':(state,item)=>{item.provenance={origin:{projectId:'origin-project'}};state.projects.push({id:'origin-project',private:true});},
  'project-conversation':state=>{state.projects[0].sourceConversationId='c';state.conversations=[{id:'c',private:true}];},
  'project-durable-origin':state=>{state.projects[0].provenance={origin:{private:true}};},
  'same-id-private-copy':(state,item,key)=>{state[key].push({...item,private:true});},
  'same-id-private-trash':(state,item,key)=>{state.trash=[{data:{[key]:[{...item,private:true}]}}];},
  'cyclic-private-run':(state,item)=>{item.runId='a';state.agentRuns=[{id:'a',runId:'b'},{id:'b',runId:'a',conversationId:'c'}];state.conversations=[{id:'c',ephemeral:true}];},
  'cyclic-public-run':(state,item)=>{item.runId='a';state.agentRuns=[{id:'a',runId:'b'},{id:'b',runId:'a'}];},
  'missing-public-origin':(state,item)=>{item.provenance={origin:{runId:'missing',conversationId:'missing'}};},
  'missing-public-project':(state,item)=>{item.projectId='missing';},
  'archived-public-origin':(state,item)=>{item.runId='r';state.agentRuns=[{id:'r',archived:true}];},
  'input-is-not-origin':(state,item)=>{item.provenance={inputs:[{private:true}],origin:{private:false}};}
 };
 for(const [type,key,count] of [['note','notes','noteCount'],['import','imports','sourceCount'],['task','tasks','taskCount']])for(const [label,mutate] of Object.entries(cases)){
  const state={projects:[{id:'p',workspace:'日常'}],notes:[],imports:[],tasks:[],conversations:[],agentRuns:[],trash:[],ui:{}};
  const item={id:'candidate',title:'Candidate',projectId:'p'};state[key].push(item);mutate(state,item,key);
  const hidden=Evidence.access(state,{type,id:item.id}).kind==='private';
  const snapshot=fixture({state}).posted.at(-1),rows=type==='task'?snapshot.tasks:snapshot.documents;
  assert.equal(rows.some(value=>value.id===item.id),!hidden,`${type}: ${label}`);
  assert.equal(snapshot[count],hidden?0:1,`${type} count: ${label}`);
 }
});

test('native privacy is reevaluated on every 500 ms snapshot and shares visibility with counts',()=>{
 const state=generatedNativeOutputs(false),f=fixture({state});
 assert.equal(f.timers.find(timer=>timer.ms===500).ms,500);
 for(const key of ['notes','tasks','imports'])state[key][0].provenance.origin.private=true;
 f.tick();let snapshot=f.posted.at(-1);
 assert.equal(snapshot.documents.length,2);assert.equal(snapshot.tasks.length,1);
 assert.equal(snapshot.noteCount,1);assert.equal(snapshot.sourceCount,1);assert.equal(snapshot.taskCount,1);
 for(const key of ['notes','tasks','imports'])state[key][0].provenance.origin.private=false;
 f.tick();snapshot=f.posted.at(-1);
 assert.equal(snapshot.documents.length,4);assert.equal(snapshot.tasks.length,2);
 assert.equal(snapshot.noteCount,2);assert.equal(snapshot.sourceCount,2);assert.equal(snapshot.taskCount,2);
});

test('native privacy guards stale document and task commands against current inherited privacy',()=>{
 const f=fixture({state:generatedNativeOutputs(false)});let toggled=0;f.env.toggleTaskStatus=()=>toggled++;
 for(const [key,commands] of [['notes',['note']],['imports',['import']],['tasks',['task','complete-task','reopen-task']]]){
  const item=f.state[key][0];item.provenance.origin.private=true;
  // Deliberately do not tick: the command must not trust its old native row.
  for(const type of commands)assert.equal(f.run({type,id:item.id}),false,type);
 }
 assert.equal(toggled,0);assert.deepEqual(f.calls,[]);
});

test('native privacy indexes each snapshot without rescanning all records for every output',t=>{
 const state={projects:[{id:'p',workspace:'日常'}],notes:[],imports:[],tasks:[],conversations:[],agentRuns:[],trash:[],ui:{}};
 let reads=0;
 for(const key of ['notes','imports','tasks'])for(let index=0;index<180;index++){
  const item={title:`${key} ${index}`,projectId:'p',provenance:{origin:{runId:'public-run'}}};
  Object.defineProperty(item,'id',{enumerable:true,get(){reads++;return `${key}-${index}`;}});state[key].push(item);
 }
 state.agentRuns.push({id:'public-run'});
 const started=performance.now(),f=fixture({state}),firstElapsed=performance.now()-started,perPassLimit=540*15;
 assert.ok(reads<perPassLimit,`initial snapshot read ${reads} ids; expected indexed rather than per-record full scans`);
 const firstReads=reads;reads=0;state.agentRuns[0].private=true;const refreshed=performance.now();f.tick();
 t.diagnostic(`540 records: initial bridge evaluation/snapshot ${firstElapsed.toFixed(2)} ms, refreshed private snapshot ${(performance.now()-refreshed).toFixed(2)} ms; id reads ${firstReads}/${reads}; interval 500 ms`);
 assert.ok(reads<perPassLimit,`next snapshot read ${reads} ids`);
 const snapshot=f.posted.at(-1);assert.equal(snapshot.documents.length,0);assert.equal(snapshot.tasks.length,0);
 assert.equal(snapshot.noteCount+snapshot.taskCount+snapshot.sourceCount,0);
});

test('native privacy hides project ancestry from native rows and checks project commands without reusing old snapshots',()=>{
 const f=fixture(),project=f.state.projects[0];
 project.provenance={origin:{private:true}};
 assert.equal(Evidence.access(f.state,{type:'local',projectId:project.id}).kind,'private');
 for(const type of ['project','create-project-task','new-project-conversation'])assert.equal(f.run({type,id:project.id}),false,type);
 f.tick();assert.equal(f.posted.at(-1).projects.length,0);assert.equal(f.posted.at(-1).tasks.length,0);assert.equal(f.posted.at(-1).documents.length,0);
 project.provenance.origin.private=false;f.tick();assert.equal(f.posted.at(-1).projects.length,1);
 assert.equal(f.run({type:'task',id:'t'}),true,'a later public state is checked afresh');
});

test('native privacy does not disclose completion of a private prerequisite through the remaining task row',()=>{
 const f=fixture();Object.assign(f.state.tasks[0],{workspace:'日常',dependsOn:['hidden']});
 f.state.tasks.push({id:'hidden',projectId:'p',workspace:'日常',status:'done',provenance:{origin:{private:true}}});
 f.tick();let snapshot=f.posted.at(-1);assert.equal(snapshot.tasks.length,1);assert.equal(snapshot.tasks[0].waitingOnDependencies,true);assert.equal(snapshot.taskCount,1);
 f.state.tasks.at(-1).provenance.origin.private=false;f.tick();snapshot=f.posted.at(-1);
 assert.equal(snapshot.tasks.length,2);assert.equal(snapshot.tasks[0].waitingOnDependencies,false);assert.equal(snapshot.taskCount,1);
});

test('native privacy rechecks project ancestry after the real route controllers await draft parking',async()=>{
 const source=fs.readFileSync('app/app.js','utf8');
 const controllers=source.slice(source.indexOf('async function navigateWorkspaceNewConversation('),source.indexOf('async function navigateWorkspaceConversation('));
 const ownership=source.slice(source.indexOf('function recordMatchesSpace('),source.indexOf('function resolveSpaceSection('));
 for(const type of ['project','new-project-conversation'])for(const ancestry of ['durable','live-run','trash-run','missing-public']){
  const f=fixture();let release,commits=0;
  f.state.projects[0].provenance={origin:{runId:'origin-run'}};f.state.agentRuns=[{id:'origin-run'}];
  f.env.workspaceName=value=>value==='课程'||value==='科研'?value:'日常';f.env.toast=()=>{};
  f.env.prepareWorkspaceRoute=options=>{
   assert.equal(options.isCurrent(),true,'the route is public when draft parking begins');
   return new Promise(resolve=>{release=()=>resolve(options.isCurrent);});
  };
  f.env.showView=view=>{commits++;f.env.document.body.dataset.view=view;};
  f.env.newConversation=()=>{commits++;f.env.document.body.dataset.view='agent';};
  vm.runInNewContext(ownership+'\n'+controllers,f.env);
  const pending=f.run({type,id:'p'});assert.equal(commits,0);
  if(ancestry==='durable')f.state.projects[0].provenance.origin.private=true;
  if(ancestry==='live-run')f.state.agentRuns[0].private=true;
  if(ancestry==='trash-run'){f.state.trash=[{data:{runs:[{...f.state.agentRuns[0],private:true}]}}];f.state.agentRuns=[];}
  if(ancestry==='missing-public')f.state.agentRuns=[];
  release();const ack=await pending,accepted=ancestry==='missing-public';
  assert.equal(ack.accepted,accepted,`${type}: ${ancestry}`);
  assert.equal(commits,accepted?1:0,`${type}: ${ancestry} cannot commit after becoming private`);
 }
});
