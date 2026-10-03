const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const Context=require('../app/agent-context'),Evidence=require('../app/citation-evidence');
const Knowledge=require('../app/knowledge-access');
function fixture(text='请打开灵动岛的待办'){
 const user={id:'m',role:'user',text},conversation={id:'c',projectId:'p',workspace:'日常',messages:[user]},project={id:'p',workspace:'日常'};
 const run={id:'r',conversationId:'c',projectId:'p',contextWorkspace:'日常',userMessageId:'m',goal:text,status:'running',toolCalls:[]};
 const state={agentRuns:[run],conversations:[conversation],projects:[project],tasks:[],notes:[],imports:[],papers:[],trash:[],ui:{view:'research',activeConversation:'other'}};
 return {state,run,conversation,project,user};
}
function harness(text,options={}){
 const data=fixture(text),calls=[],receipts=[];
 class Storage {setItem(){} removeItem(){}}
 const events=new Map(),document={activeElement:null,addEventListener:(name,handler)=>events.set(name,handler)};
 const context={...data,Storage,localStorage:new Storage(),crypto,AbortController,URL,console,document,storageHydrated:true,activeRunId:'r',activeRunController:new AbortController(),serverConflict:null,purgeTrash:{},CitationEvidence:Evidence,PrivateMode:{isOn:()=>false}};
 context.window=context;
 context.webkit={messageHandlers:{desktop:{postMessage:async body=>{
  assert.equal(body.command,'quick-panel-open');calls.push(body);
  await options.beforeAuthorize?.(context,body);
  // Simulate NSDictionary's property order changing during the real Swift hop.
  const envelope={request:{...body.envelope.request,owner:{...body.envelope.request.owner}},token:body.envelope.token};
  const authorized=context.workstationDesktop.quickPanel.authorize(envelope);
  if(authorized.status!=='authorized')return authorized;
  await options.afterAuthorize?.(context,envelope,authorized);
  const live=context.workstationDesktop.quickPanel.revalidate(envelope);if(live.status!=='authorized')return live;
  const request=body.envelope.request;
  const receipt=options.receipt||{status:'opened',opened:true,section:request.section,...(request.recordId?{recordType:request.recordType,recordId:request.recordId,positioned:true}:{})};
  await options.beforeReceipt?.(context,envelope);
  const final=context.workstationDesktop.quickPanel.revalidate(envelope);if(final.status!=='authorized')return final;
  receipts.push(receipt);return receipt;
 }}}};
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(root,'native/Resources/desktop.js'),'utf8'),context);
 vm.runInContext(fs.readFileSync(path.join(root,'app/tool-scheduler.js'),'utf8'),context);
 const batch=(request={type:'quick_panel_open',section:'tasks'},extra={})=>context.ToolScheduler.create({run:data.run,execute:()=>{throw Error('Native UI requests must use the authenticated bridge');},...extra}).batch([request]);
 return {context,...data,calls,receipts,batch,events};
}
test('capability exists only when the native bridge is available and describes presentation-only receipts',()=>{
 const absent=Context.create({fullInstruction:'',hasQuickPanel:false});assert.throws(()=>absent.capability('quick_panel'),/未提供/);assert.doesNotMatch(absent.instructions(),/"quick_panel"/);
 const present=Context.create({fullInstruction:'',hasQuickPanel:true});assert.match(present.instructions(),/"quick_panel"/);
 const contract=present.capability('quick_panel');assert.match(contract.instructions,/本轮|当前这一条/);assert.match(contract.instructions,/opened.*saved/);assert.match(contract.instructions,/recordType\/recordId/);
 assert.match(contract.instructions,/home\|tasks\|capture\|runs\|agenda\|links/);assert.match(contract.instructions,/不自动打开网站或抓取正文/);
});
test('actual scheduler and desktop bridge open the explicit section despite unrelated current route, without writes',async()=>{
 const h=harness(),before=JSON.stringify({...h.state,agentRuns:[]});
 const [result]=await h.batch();assert.equal(result.status,'opened');assert.equal(result.section,'tasks');assert.equal(result.opened,true);assert.equal(result.saved,undefined);
 assert.equal(h.calls.length,1);assert.equal(h.receipts.length,1);assert.equal(h.run.toolCalls[0].result.status,'opened');assert.equal(JSON.stringify({...h.state,agentRuns:[]}),before);
 assert.equal(h.calls[0].envelope.request.owner.toolCallId,h.run.toolCalls[0].id);
});
test('supported section names correspond to explicit current-turn requests',async t=>{
 for(const [section,text] of [['home','打开灵动岛'],['tasks','请打开灵动岛的待办'],['capture','帮我展开灵动岛的随记'],['runs','显示灵动岛运行记录'],['agenda','能不能打开灵动岛日历'],['agenda','Please open the quick panel calendar'],['links','请打开灵动岛的链接'],['links','帮我展开灵动岛书签'],['links','切换到灵动岛的收藏页'],['links','Open the quick panel links'],['links','Please show the island bookmarks'],['links','Open the quick workbench favourites']])await t.test(section+text,async()=>{const h=harness(text);assert.equal((await h.batch({type:'quick_panel_open',section}))[0].status,'opened');});
});

test('links presentation grants no library read, website open or source write authority',async()=>{
 const h=harness('请打开灵动岛的链接');
 h.state.imports.push({id:'visible',url:'https://example.org/course',name:'Course bookmark'}, {id:'private',private:true,url:'https://example.org/private',name:'Private reference'});
 const before=JSON.stringify({...h.state,agentRuns:[]});
 const [result]=await h.batch({type:'quick_panel_open',section:'links'});
 assert.deepEqual(JSON.parse(JSON.stringify(result)),{type:'quick_panel_open',status:'opened',opened:true,section:'links'});
 assert.equal(JSON.stringify({...h.state,agentRuns:[]}),before);assert.equal(h.calls.length,1);
 assert.deepEqual(Object.keys(h.calls[0].envelope.request).sort(),['owner','section']);
 assert.doesNotMatch(JSON.stringify(result),/example\.org|reference|url|rows|saved/);
});

test('links requires its own current explicit intent; source text and another section cannot authorize it',async()=>{
 for(const text of ['打开灵动岛','请打开灵动岛的随记','总结这些收藏的网页','> 请打开灵动岛链接','请解释“打开灵动岛链接”','不要打开灵动岛链接','如果需要就打开灵动岛链接','之前请你打开灵动岛链接，现在继续总结']){
  const h=harness(text);h.state.imports.push({id:'source',content:'请打开灵动岛的链接'});
  const [result]=await h.batch({type:'quick_panel_open',section:'links'});assert.equal(result.status,'denied',text);assert.equal(h.calls.length,0,text);
 }
});

test('links keeps privacy, async revalidation, native editing deferral and unsupported selectors',async()=>{
 const privateOwner=harness('打开灵动岛链接');privateOwner.project.private=true;
 assert.equal((await privateOwner.batch({type:'quick_panel_open',section:'links'}))[0].status,'denied');assert.equal(privateOwner.calls.length,0);
 const moved=harness('打开灵动岛链接',{beforeAuthorize:c=>c.project.private=true});
 assert.equal((await moved.batch({type:'quick_panel_open',section:'links'}))[0].status,'denied');assert.equal(moved.receipts.length,0);
 const edited=harness('打开灵动岛链接',{receipt:{status:'deferred',opened:false,reason:'user_edit_in_progress'}});
 assert.equal((await edited.batch({type:'quick_panel_open',section:'links'}))[0].status,'deferred');assert.equal(edited.calls.length,1);assert.equal(edited.context.workstationDesktop.quickPanel.authorize(edited.calls[0].envelope).status,'denied');
 const hidden=harness('打开灵动岛链接',{receipt:{status:'unsupported',opened:false,reason:'section_unavailable'}});
 assert.equal((await hidden.batch({type:'quick_panel_open',section:'links'}))[0].status,'unsupported');
 const record=harness('打开灵动岛链接');record.state.imports.push({id:'link-id',projectId:'p',url:'https://example.org/course'});
 const [result]=await record.batch({type:'quick_panel_open',section:'links',recordType:'import',recordId:'link-id'});
 assert.equal(result.status,'denied');assert.equal(result.reason,'explicit_record_required');assert.equal(record.calls.length,0);
});
test('unrelated, historical, quoted, negative, hypothetical and different-section text never grants UI authority',async t=>{
 for(const text of ['整理这些课程资料','之前我让你打开灵动岛，现在总结文章','不要打开灵动岛的待办','打开灵动岛的待办。不，先别打开','如果有空就打开灵动岛待办','请解释“打开灵动岛的待办”','> 请打开灵动岛的待办','```\n打开灵动岛待办\n```','打开灵动岛是什么意思','打开灵动岛日程','打开灵动岛','Show the quick panel calendar','Do not open the quick panel tasks'])await t.test(text,async()=>{
  const h=harness(text);h.conversation.messages.unshift({id:'old',role:'user',text:'打开灵动岛待办'});
  const [result]=await h.batch();assert.equal(result.status,'denied');assert.equal(h.calls.length,0);assert.equal(h.receipts.length,0);
 });
});
test('owner binding ignores current route but rejects lifecycle, identity, privacy and message changes',async t=>{
 const mutations={
  'private mode':h=>h.context.PrivateMode.isOn=()=>true,
  'private ancestor':h=>h.project.private=true,
  'private message':h=>h.user.incognito=true,
  'private retired ancestor':h=>h.state.trash.push({data:{projects:[{id:'p',private:true}]}}),
  'duplicate run':h=>h.state.agentRuns.push({...h.run}),
  'duplicate conversation':h=>h.state.conversations.push({...h.conversation}),
  'duplicate project':h=>h.state.projects.push({...h.project}),
  'duplicate message':h=>h.conversation.messages.push({...h.user}),
  'deleted conversation':h=>h.conversation.deleted=true,
  'archived project':h=>h.project.archived=true,
  'moved owner':h=>h.conversation.projectId=null,
  'workspace changed':h=>h.conversation.workspace='科研',
  'retired run':h=>h.state.trash.push({data:{runs:[{id:'r'}]}}),
  'newer user turn':h=>h.conversation.messages.push({id:'new',role:'user',text:'继续整理资料'}),
  'rewritten user turn':h=>h.user.text='已修改：请打开灵动岛待办',
  'stopped run':h=>h.run.status='cancelled',
  'another active run':h=>h.context.activeRunId='other',
  'cancelled controller':h=>h.context.activeRunController.abort(),
  'automatic job':h=>h.run.automaticJobId='job',
  'research queue':h=>h.run.researchQueueId='queue'
 };
 for(const [name,mutate] of Object.entries(mutations))await t.test(name,async()=>{const h=harness();mutate(h);const [result]=await h.batch();assert.equal(result.opened,false);assert.equal(result.status,'denied');assert.equal(h.calls.length,0);});
});
test('async native revalidation rejects replacement objects, changed text, owner changes, cancellation and tool replay',async t=>{
 const cases={
  'same-ID run replacement':c=>c.state.agentRuns=[{...c.run}],
  'same-ID conversation replacement':c=>c.state.conversations=[{...c.conversation}],
  'same-ID project replacement':c=>c.state.projects=[{...c.project}],
  'same-ID message replacement':c=>c.conversation.messages=[{...c.user}],
  'edited message with same explicit meaning':c=>{c.user.text='请打开灵动岛的待办！';c.run.goal=c.user.text;},
  'private after await':c=>c.project.private=true,
  'moved after await':c=>c.conversation.projectId=null,
  'tool no longer running':c=>c.run.toolCalls[0].status='completed',
  'tool destination changed':c=>c.run.toolCalls[0].request.section='agenda',
  'tool now belongs to child':c=>c.run.toolCalls[0].parentId='child',
  'signal cancelled':c=>c.activeRunController.abort()
 };
 for(const [name,mutate] of Object.entries(cases))await t.test(name,async()=>{const h=harness(undefined,{beforeAuthorize:mutate});const [result]=await h.batch();assert.equal(result.status,'denied');assert.equal(h.calls.length,1);assert.equal(h.receipts.length,0);});
});
test('native edit deferral is retained without replaying or claiming save',async()=>{
 const h=harness(undefined,{receipt:{status:'deferred',opened:false,reason:'unsaved_draft'}});const [result]=await h.batch();
 assert.equal(result.status,'deferred');assert.equal(result.opened,false);assert.equal(result.saved,undefined);assert.equal(h.calls.length,1);assert.equal(h.run.toolCalls[0].result.reason,'unsaved_draft');
 assert.equal(h.context.workstationDesktop.quickPanel.authorize(h.calls[0].envelope).status,'denied');
});
test('unknown modules and mismatched record pairs return unsupported with no native presentation request',async()=>{
 for(const request of [{type:'quick_panel_open',section:'clipboard'},{type:'quick_panel_open',section:'recordings'},{type:'quick_panel_open',section:'tasks',recordType:'note',recordId:'real-id'}]){
  const h=harness();const [result]=await h.batch(request);assert.equal(result.status,'unsupported');assert.equal(result.opened,false);assert.equal(h.calls.length,0);
 }
});
test('model cannot forge owner IDs, provide side-effect arguments or inject partial record selectors',async()=>{
 for(const addition of [{runId:'another'},{owner:{runId:'another'}},{text:'open'},{startRecording:true},{recordId:'id'},{recordType:'task'},{recordId:'',recordType:'task'},{section:['tasks']}]){
  const h=harness();await assert.rejects(h.batch({type:'quick_panel_open',section:'tasks',...addition}),{code:'INVALID_QUICK_PANEL_REQUEST'});assert.equal(h.calls.length,0);
 }
});
test('subagent, unavailable native and hydration states are honest and never use generic knowledge execution',async()=>{
 const child=harness();assert.equal((await child.batch(undefined,{parentId:'child'}))[0].status,'denied');assert.equal(child.calls.length,0);
 const absent=harness();delete absent.context.workstationDesktop.quickPanel;assert.equal((await absent.batch())[0].status,'unsupported');
 const hydrating=harness();hydrating.context.storageHydrated=false;assert.equal((await hydrating.batch())[0].status,'deferred');assert.equal(hydrating.calls.length,0);
});
test('checkpoint failure prevents opening; own cancellation removes the in-flight authorization',async()=>{
 const broken=harness();await assert.rejects(broken.batch(undefined,{checkpoint:async()=>{throw Error('disk full')}}),/disk full/);assert.equal(broken.calls.length,0);
 const signal=new AbortController(),cancelled=harness(undefined,{beforeAuthorize:()=>signal.abort()});
 await assert.rejects(cancelled.batch(undefined,{signal:signal.signal}),{code:'CANCELLED'});assert.equal(cancelled.receipts.length,0);assert.equal(cancelled.run.toolCalls[0].result.status,'denied');
});
test('invalid native receipt cannot be promoted to opened or saved',async()=>{
 for(const receipt of [{status:'saved',saved:true},{status:'opened',section:'agenda',opened:true},{status:'opened',section:'tasks',opened:false}]){const h=harness(undefined,{receipt});assert.equal((await h.batch())[0].status,'deferred');}
});
test('focused web drafts and active IME defer both before and after the native hop, empty composer permits opening',async()=>{
 for(const focused of [{isContentEditable:true},{matches:()=>true,value:'下一条尚未发送'},{matches:()=>true,value:'正文正在编辑'}]){
  const h=harness();h.context.document.activeElement=focused;const before=JSON.stringify(focused);
  assert.equal((await h.batch())[0].status,'deferred');assert.equal(h.calls.length,0);assert.equal(JSON.stringify(focused),before);
 }
 const ime=harness();ime.events.get('compositionstart')();assert.equal((await ime.batch())[0].status,'deferred');assert.equal(ime.calls.length,0);
 const later=harness(undefined,{beforeAuthorize:c=>{c.document.activeElement={isContentEditable:true};}});assert.equal((await later.batch())[0].status,'deferred');assert.equal(later.receipts.length,0);
 const empty=harness();empty.context.document.activeElement={matches:()=>true,value:''};assert.equal((await empty.batch())[0].status,'opened');
});
test('real knowledge-plan continuation retains native deferral and does not auto-replay the UI request',async()=>{
 const h=harness(undefined,{receipt:{status:'deferred',opened:false,reason:'user_edit_in_progress'}}),plan=JSON.stringify({knowledgeRequests:[{type:'quick_panel_open',section:'tasks'}],actions:[]});let rounds=0;
 const output=await Knowledge.continuePlan(plan,{batch:requests=>h.batch(requests[0]),ask:async text=>{assert.match(text,/deferred/);assert.match(text,/user_edit_in_progress/);return ++rounds===1?plan:JSON.stringify({message:'草稿保留，请编辑完成后再打开。',actions:[]});}});
 assert.equal(JSON.parse(output).actions.length,0);assert.equal(rounds,2);assert.equal(h.calls.length,1);assert.equal(h.run.toolCalls.length,1);
});

const destinations={tasks:{type:'task',collection:'tasks',row:{id:'task-focus',title:'Finish synthetic assignment',projectId:'p'}},capture:{type:'note',collection:'notes',row:{id:'capture-focus',title:'Synthetic observation',kind:'随记',projectId:'p',content:'Test body'}},links:{type:'import',collection:'imports',row:{id:'link-focus',name:'Synthetic reference',url:'https://example.org/reference',projectId:'p'}}};
function recordHarness(section,options={}){
 const d=destinations[section],h=harness(`Open the quick panel ${section==='capture'?'quick notes':section} ${d.row.title||d.row.name}`,options);
 h.state[d.collection].push({...d.row});
 return {...h,d,request:{type:'quick_panel_open',section,recordType:d.type,recordId:d.row.id}};
}
test('existing scoped tasks, captures and links use exact selectors and truthful visible-record ACK',async t=>{
 for(const section of Object.keys(destinations))await t.test(section,async()=>{
  const h=recordHarness(section),before=JSON.stringify({...h.state,agentRuns:[]});
  const [result]=await h.batch(h.request);assert.equal(result.status,'opened');assert.equal(result.recordId,h.d.row.id);assert.equal(result.positioned,true);assert.equal(result.saved,undefined);
  assert.equal(JSON.stringify({...h.state,agentRuns:[]}),before,'navigation must not create records, editors or a second library');
  assert.equal(h.context.workstationDesktop.quickPanel.revalidate(h.calls[0].envelope).reason,'request_expired','lease must end with request');
 });
});
test('record authorization rejects private, cross-scope, ambiguous or unsupported originals',async t=>{
 const cases={private:h=>h.state.tasks[0].private=true,'other project':h=>{h.state.projects.push({id:'elsewhere',workspace:'日常'});h.state.tasks[0].projectId='elsewhere';},'duplicate ID':h=>h.state.tasks.push({...h.state.tasks[0]}),'duplicate title':h=>h.state.tasks.push({...h.state.tasks[0],id:'second'}),'deleted':h=>h.state.tasks[0].deleted=true};
 for(const [name,mutate] of Object.entries(cases))await t.test(name,async()=>{const h=recordHarness('tasks');mutate(h);assert.equal((await h.batch(h.request))[0].status,'denied');assert.equal(h.calls.length,0);});
 const note=recordHarness('capture');note.state.notes[0].kind='文档';assert.equal((await note.batch(note.request))[0].reason,'record_not_capture');
 const link=recordHarness('links');link.state.imports[0].url='file:///secret';assert.equal((await link.batch(link.request))[0].reason,'record_not_link');
});
test('live lease checks the current record and draft after preparation and after mounted ACK',async t=>{
 const cases={private:c=>c.state.tasks[0].private=true,'record replacement':c=>c.state.tasks=[{...c.state.tasks[0]}],'new content':c=>c.state.tasks[0].title+=' changed','move project':c=>c.state.tasks[0].projectId=null,'new draft':c=>c.document.activeElement={isContentEditable:true},'IME':(c,e)=>{c.document.activeElement={matches:()=>true,value:'editing'};},'cancelled run':c=>c.activeRunController.abort(),'expired lease':c=>vm.runInContext('Date.now=()=>'+(Date.now()+9000),c),'newer user turn':c=>c.conversation.messages.push({id:'new',role:'user',text:'stop'})};
 for(const phase of ['afterAuthorize','beforeReceipt'])for(const [name,mutation] of Object.entries(cases))await t.test(phase+' '+name,async()=>{const h=recordHarness('tasks',{[phase]:mutation});const [result]=await h.batch(h.request);assert.equal(result.opened,false);assert.equal(h.receipts.length,0);assert.equal(h.calls.length,1);});
});
test('record selectors cannot be acknowledged by page setters or wrong record receipts',async()=>{
 for(const receipt of [{status:'opened',opened:true,section:'tasks'},{status:'opened',opened:true,section:'tasks',recordType:'task',recordId:'wrong',positioned:true},{status:'opened',opened:true,section:'tasks',recordType:'task',recordId:'task-focus',positioned:false}]){
  const h=recordHarness('tasks',{receipt});assert.equal((await h.batch(h.request))[0].reason,'invalid_native_receipt');
 }
});
test('nonce remains single use while live lease cannot change destination or survive cancellation',async()=>{
 let checked=0;
 const h=recordHarness('tasks',{afterAuthorize:(c,e)=>{
  assert.equal(c.workstationDesktop.quickPanel.authorize(e).status,'denied');
  assert.equal(c.workstationDesktop.quickPanel.revalidate({...e,request:{...e.request,recordId:'another'}}).status,'denied');
  assert.equal(c.workstationDesktop.quickPanel.revalidate(e).status,'authorized');checked++;
 }});assert.equal((await h.batch(h.request))[0].status,'opened');assert.equal(checked,1);
});
test('native calendar receives current human intent through trusted authorization only',async()=>{
 let checked=false;const h=harness('打开灵动岛日程 Synthetic event',{afterAuthorize:(_c,_e,auth)=>{assert.equal(auth.userText,'打开灵动岛日程 Synthetic event');checked=true;}});
 const [result]=await h.batch({type:'quick_panel_open',section:'agenda',recordType:'event',recordId:'event-synthetic'});assert.equal(result.positioned,true);assert.ok(checked);
});
