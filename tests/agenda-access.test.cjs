const test=require('node:test'),assert=require('node:assert/strict');
const A=require('../app/agenda-access'),P=require('../app/agenda-proposals'),K=require('../app/knowledge-access'),S=require('../app/tool-scheduler'),C=require('../app/agent-context');
const copy=x=>JSON.parse(JSON.stringify(x));
function fixture(){
 const message={id:'u',role:'user',text:'请删除明天下午三点的打篮球日程。'},conversation={id:'c',workspace:'日常',messages:[message]},run={id:'r',conversationId:'c',userMessageId:'u',contextWorkspace:'日常',projectId:null,status:'running',recordAssignmentScope:{workspace:'日常',projectId:null,readProjects:[]}};
 let state={conversations:[conversation],agentRuns:[run],projects:[],notes:[],imports:[],papers:[],tasks:[]};
 const event={eventId:'e',title:'打篮球',start:1791097200000,end:1791100800000,timeZone:'Asia/Shanghai',projectId:'',documentId:'',documentKind:'note',deleted:false,version:'a'.repeat(64),recurrence:{frequency:'none'}};
 const calls=[];const bridge={agendaQuery:async(request,context)=>{calls.push({request,context});return {version:1,status:'ready',authority:'native-agenda',items:[copy(event)],total:1,offset:request.offset,limit:request.limit,hasMore:false};},agendaRead:async(request,context)=>{calls.push({request,context});return {version:1,status:'ready',authority:'native-agenda',event:copy(event)};}};
 A.init({getState:()=>state});return {get state(){return state},set state(v){state=v},run,conversation,message,event,bridge,calls,read:request=>A.execute(request,{run,scope:run.recordAssignmentScope,getState:()=>state,bridge})};
}
const proposal=f=>({operation:'delete',eventId:f.event.eventId,expectedVersion:f.event.version,sourceMessageId:'u',quote:'请删除明天下午三点的打篮球日程',scope:'single'});
test('compound lookup and explicit deletion preserves negation and quoted non-instructions',async()=>{
 const actual='请查找日程“E52 合成篮球验收”，告诉我日期和时间，并把这个测试日程给删了。';
 for(const [text,quote,allowed] of [[actual,actual,true],[actual,'并把这个测试日程给删了',true],['请查找日程“E52 合成篮球验收”，告诉我日期和时间，但不要把这个测试日程给删了。',null,false],['请查找日程“E52 合成篮球验收”，告诉我日期和时间，并别把这个测试日程给删了。',null,false],['请分析“先查询，并把这个测试日程给删了”的语气。',null,false],['Please delete "the fictional event".',null,true]]){
  const f=fixture();f.event.title='E52 合成篮球验收';f.message.text=text;await f.read({type:'agenda_read',eventId:'e'});const value={...proposal(f),quote:quote||text};
  if(allowed)assert.equal(P.validate([value],f.state,f.run)[0].operation,'delete');else assert.throws(()=>P.validate([value],f.state,f.run),{code:'INVALID_AGENDA_PROPOSAL'});
 }
});
test('literal terminal deletion verbs accept the reported request and preserve negative intent',async()=>{
 for(const [text,allowed] of [['帮我把明天下午3点打篮球的那个日程给删了。',true],['把明天下午3点打篮球的那个日程删掉。',true],['别把明天下午3点打篮球的那个日程给删了。',false],['不要把明天下午3点打篮球的那个日程给删了。',false],['Please delete the fictional basketball event.',true]]){
  const f=fixture();f.message.text=text;await f.read({type:'agenda_read',eventId:'e'});const value={...proposal(f),quote:text};
  if(allowed)assert.equal(P.validate([value],f.state,f.run)[0].operation,'delete');else assert.throws(()=>P.validate([value],f.state,f.run),{code:'INVALID_AGENDA_PROPOSAL'});
 }
});
test('production desktop IPC forwards exact query/read/review/status envelopes',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),calls=[];class Storage{setItem(){}removeItem(){}}
 const window={webkit:{messageHandlers:{desktop:{postMessage:async body=>{calls.push(structuredClone(body));return {status:'ready'};}}}}};
 vm.runInNewContext(fs.readFileSync('native/Resources/desktop.js','utf8'),{window,Storage,localStorage:new Storage()});
 const f=fixture(),context=A.contextFor(f.run),q={query:'篮球',offset:0,limit:20},r={eventId:'e'},p=proposal(f),api=window.workstationDesktop;
 await api.agendaQuery(q,context);await api.agendaRead(r,context);await api.agendaMutation(p,context);await api.agendaMutationStatus('request',context,p);
 assert.deepEqual(calls,[{command:'agenda-query',request:q,context},{command:'agenda-read',request:r,context},{command:'agenda-mutation',proposal:p,context},{command:'agenda-mutation-status',requestId:'request',context,proposal:p}]);
});
test('fresh native list/read, exact owner, mutation requires actual same-run read',async()=>{
 const f=fixture();assert.throws(()=>P.validate([proposal(f)],f.state,f.run),/agenda_read/);
 const rows=await f.read({type:'agenda_list',query:'篮球'});assert.equal(rows.total,1);assert.equal(rows.entries[0].eventId,'e');assert.match(rows.hint,/不同记录/);
 assert.throws(()=>P.validate([proposal(f)],f.state,f.run),/agenda_read/);
 await f.read({type:'agenda_read',eventId:'e'});f.run.agendaProposals=P.validate([proposal(f)],f.state,f.run);
 assert.equal(A.authorize(A.contextFor(f.run),f.run.agendaProposals[0]).status,'authorized');assert.equal(P.hasPending(f.run),true);
 assert.equal(A.authorize({...A.contextFor(f.run),conversationId:'other'}).status,'denied');
 assert.equal(A.authorize(A.contextFor(f.run),{...f.run.agendaProposals[0],quote:'another'}).status,'denied');
});
test('state replacement/privacy, deleted owner and in-flight new scope never publish old evidence',async()=>{
 for(const change of [f=>{f.state={...f.state,conversations:[{...f.conversation,private:true}]};},f=>{f.state.agentRuns=[];},f=>{f.conversation.workspace='科研';},f=>{f.message.text='新的指令';}]){
  const f=fixture();let release;f.bridge.agendaRead=()=>new Promise(r=>release=r);const pending=f.read({type:'agenda_read',eventId:'e'});change(f);release({version:1,status:'ready',authority:'native-agenda',event:f.event});await assert.rejects(pending,{code:'CANCELLED'});assert.equal(f.run.agendaReads,undefined);
 }
 const f=fixture(),r=await f.read({type:'agenda_read',eventId:'e'});f.conversation.private=true;assert.throws(()=>K.validateReadResult(r,f.state),{code:'CANCELLED'});
});
test('real private mode and normalized context fail closed without widening scope',async()=>{
 const f=fixture();const saved=global.PrivateMode;try{global.PrivateMode={isOn:()=>true};await assert.rejects(f.read({type:'agenda_list'}),{code:'CANCELLED'});}finally{global.PrivateMode=saved;}
 const context=A.contextFor(f.run);context.scope.projectId=null;assert.equal(A.authorize(context).status,'authorized');context.scope.readProjects=['secret'];assert.equal(A.authorize(context).status,'denied');
 await assert.rejects(f.read({type:'agenda_list',scope:{workspace:'auto'}}),{code:'INVALID_AGENDA_REQUEST'});
});
test('linked PDF remains readable; revoked source or out-of-scope/retired events are denied',async()=>{
 const f=fixture();f.state.imports=[{id:'pdf',workspace:'日常',content:'synthetic'}];f.event.documentId='pdf';f.event.documentKind='import';await f.read({type:'agenda_read',eventId:'e'});
 f.state.imports[0].private=true;await assert.rejects(f.read({type:'agenda_read',eventId:'e'}));
 f.event.documentId='';f.event.projectId='foreign';await assert.rejects(f.read({type:'agenda_list'}));f.event.projectId='';f.event.deleted=true;await assert.rejects(f.read({type:'agenda_list'}));
});
test('native error is not an empty calendar; version mismatch and pagination are explicit',async()=>{
 const f=fixture();await assert.rejects(f.read({type:'agenda_read',eventId:'e',expectedVersion:'b'.repeat(64)}),{code:'AGENDA_CHANGED'});
 f.bridge.agendaQuery=async()=>({status:'deferred',reason:'busy'});await assert.rejects(f.read({type:'agenda_list'}),{code:'AGENDA_UNAVAILABLE'});
 for(const r of [{type:'agenda_list',from:0},{type:'agenda_list',from:0,to:367*86400000},{type:'agenda_list',limit:51}])await assert.rejects(f.read(r),{code:'INVALID_AGENDA_REQUEST'});
});
test('reported October 4 queries and equivalent timezone offsets reach the native bridge as milliseconds',async()=>{
 const f=fixture(),from=1791043200000,to=1791129599000;
 for(const [start,end,limit] of [
  ['2026-10-04T00:00:00+08:00','2026-10-04T23:59:59+08:00',20],
  ['2026-10-04T00:00:00+08:00','2026-10-04T23:59:59+08:00',50],
  ['2026-10-03T16:00:00Z','2026-10-04T15:59:59Z',20],
  ['2026-10-03T09:00:00-07:00','2026-10-04T08:59:59-07:00',20],
  ['2026-10-03T21:30:00+05:30','2026-10-04T21:29:59+05:30',20]
 ]){
  const request={type:'agenda_list',query:'篮球',from:start,to:end,offset:0,limit},original=copy(request);
  const rows=await f.read(request),call=f.calls.at(-1);
  assert.deepEqual(call.request,{query:'篮球',from,to,offset:0,limit});assert.deepEqual(call.context,A.contextFor(f.run));
  assert.deepEqual(request,original,'the caller and tool evidence retain the original ISO values');assert.equal(rows.entries[0].eventId,'e');
 }
});
test('query dates support millisecond precision, leap days and mixed numeric endpoints without changing numeric inputs',async()=>{
 const f=fixture();
 for(const [from,to,start,end] of [
  ['2026-10-04T00:00:00.1+08:00','2026-10-04T00:00:00.123+08:00',1791043200100,1791043200123],
  ['2026-10-03T16:00:00.12Z',1791043200123,1791043200120,1791043200123],
  [0,'1970-01-01T00:00:00.001Z',0,1],[-1000,0,-1000,0],
  ['2028-02-29T00:00:00Z','2028-03-01T00:00:00Z',Date.UTC(2028,1,29),Date.UTC(2028,2,1)],
  ['2000-02-29T00:00:00Z','2000-03-01T00:00:00Z',Date.UTC(2000,1,29),Date.UTC(2000,2,1)]
 ]){
  await f.read({type:'agenda_list',from,to});assert.equal(f.calls.at(-1).request.from,start);assert.equal(f.calls.at(-1).request.to,end);
 }
 await f.read({type:'agenda_list',from:'0099-10-04T00:00:00Z',to:'0099-10-05T00:00:00Z'});
 assert.equal(new Date(f.calls.at(-1).request.from).toISOString(),'0099-10-04T00:00:00.000Z','years below 100 must not become 1900-based years');
});
test('query rejects missing timezones, invalid calendar dates and coercible values before any native call',async()=>{
 const f=fixture();
 for(const from of [
  '2026-10-04T00:00:00','2026-10-04','2026-10-04T00:00:00+0800','2026-10-04T00:00:00+08',
  '2026-10-04T00:00:00+24:00','2026-10-04T00:00:00+08:60','2026-10-04T00:00:00.1234Z',
  '2026-02-29T00:00:00Z','2026-04-31T00:00:00Z','2026-00-01T00:00:00Z','2026-10-00T00:00:00Z',
  '2026-10-04T24:00:00Z','2026-10-04T00:60:00Z','2026-10-04T00:00:60Z',
  ' 2026-10-04T00:00:00Z','2026-10-04T00:00:00Z ','2026-10-04T00:00:00Z\n','2026-10-04T00:00:00Z\r','1791043200000','tomorrow','',null,true,{},NaN,Infinity,0.5
 ])await assert.rejects(f.read({type:'agenda_list',from,to:'2026-10-06T00:00:00Z'}),{code:'INVALID_AGENDA_REQUEST'},String(from));
 for(const [from,to] of [['1900-02-29T00:00:00Z','1900-03-02T00:00:00Z'],['2026-13-01T00:00:00Z','2027-01-02T00:00:00Z']])await assert.rejects(f.read({type:'agenda_list',from,to}),{code:'INVALID_AGENDA_REQUEST'});
 await assert.rejects(f.read({type:'agenda_list',from:'2026-10-04T00:00:00Z',to:'2026-10-05T00:00:00'}),{code:'INVALID_AGENDA_REQUEST'});
 assert.equal(f.calls.length,0);
});
test('normalized ISO ranges retain paired endpoints, strict order, the 366-day boundary and pagination limits',async()=>{
 const f=fixture(),from='2026-01-01T00:00:00Z',to='2027-01-02T00:00:00Z';
 await f.read({type:'agenda_list',from,to,offset:10000,limit:50});assert.equal(f.calls[0].request.to-f.calls[0].request.from,366*86400000);
 const invalid=[{from},{to},{from,to:from},{from:to,to:from},{from,to:'2027-01-02T00:00:00.001Z'},
  {from:'2026-10-04T00:00:00+08:00',to:'2026-10-03T16:00:00Z'},
  ...[{offset:-1},{offset:10001},{offset:0.5},{limit:0},{limit:51},{limit:'20'}].map(page=>({from,to,...page}))];
 for(const request of invalid)await assert.rejects(f.read({type:'agenda_list',...request}),{code:'INVALID_AGENDA_REQUEST'});
 assert.equal(f.calls.length,1);
});
test('ISO queries preserve scheduler evidence and cannot bypass owner or in-flight permission checks',async()=>{
 const request={type:'agenda_list',query:'篮球',from:'2026-10-04T00:00:00+08:00',to:'2026-10-04T23:59:59+08:00',offset:0,limit:20};
 const f=fixture(),scheduler=S.create({run:f.run,execute:f.read});await scheduler.batch([request]);
 assert.equal(f.calls[0].request.from,1791043200000);assert.deepEqual(f.run.toolCalls[0].request,request);assert.equal(f.run.toolCalls[0].status,'completed');
 const denied=fixture();denied.conversation.private=true;await assert.rejects(denied.read(request),{code:'CANCELLED'});assert.equal(denied.calls.length,0);
 const changed=fixture();let release;changed.bridge.agendaQuery=()=>new Promise(resolve=>release=resolve);const pending=changed.read(request);changed.conversation.workspace='科研';
 release({version:1,status:'ready',authority:'native-agenda',items:[changed.event],total:1,offset:0,limit:20,hasMore:false});await assert.rejects(pending,{code:'CANCELLED'});
 const mutation=fixture();await mutation.read({type:'agenda_read',eventId:'e'});
 assert.throws(()=>P.validate([{...proposal(mutation),operation:'update',patch:{start:request.from,end:request.to}}],mutation.state,mutation.run),{code:'INVALID_AGENDA_PROPOSAL'},'query ISO support must not change mutation timestamp semantics');
 const instructions=C.create({hasAgenda:true,fullInstruction:''}).capability('agenda').instructions;
 assert.match(instructions,/from\/to.*ISO 8601.*2026-10-04T00:00:00\+08:00.*无需自行换算/);assert.match(instructions,/start\/end 是毫秒时间戳/);
});
test('mutation allowlist, exact quote, negative deletion, recurrence and changed message are protected',async()=>{
 const f=fixture();await f.read({type:'agenda_read',eventId:'e'});
 for(const delta of [{expectedVersion:'b'.repeat(64)},{sourceMessageId:'history'},{quote:'not in this message'},{operation:'update',patch:{projectId:'other'}},{operation:'update',patch:{end:1}},{scope:'occurrence'}])assert.throws(()=>P.validate([{...proposal(f),...delta}],f.state,f.run));
 assert.equal(P.validate([{...proposal(f),operation:'update',patch:{location:'室内'}}],f.state,f.run)[0].patch.location,'室内');
 f.message.text='不要删除明天下午三点的打篮球日程';await f.read({type:'agenda_read',eventId:'e'});assert.throws(()=>P.validate([{...proposal(f),quote:'删除明天下午三点的打篮球日程'}],f.state,f.run));
 f.message.text='请删除整个每周篮球日程系列';f.event.recurrence={frequency:'weekly'};await f.read({type:'agenda_read',eventId:'e'});assert.throws(()=>P.validate([{...proposal(f),quote:f.message.text}],f.state,f.run));assert.equal(P.validate([{...proposal(f),quote:f.message.text,scope:'series'}],f.state,f.run)[0].scope,'series');
});
test('actual scheduler retains event IDs/context args and rejects model authority fields',async()=>{
 const f=fixture();const scheduler=S.create({run:f.run,execute:f.read});const [r]=await scheduler.batch([{type:'agenda_read',eventId:'e',expectedVersion:f.event.version}]);assert.equal(r.eventId,'e');assert.equal(f.run.toolCalls[0].request.eventId,'e');assert.equal(f.run.toolCalls[0].status,'completed');
 await assert.rejects(scheduler.batch([{type:'agenda_list',context:{conversationId:'other'}}]),{code:'INVALID_AGENDA_REQUEST'});
 const ctx=C.create({hasAgenda:true,fullInstruction:''});assert.match(ctx.capability('agenda').instructions,/agenda_read/);assert.match(ctx.instructions(),/task_list.*不能证明日程不存在/);
});
test('live agenda observations are reread and checkpoint revocation stops the next model call',async()=>{
 const f=fixture(),first=JSON.stringify({knowledgeRequests:[{type:'agenda_list'}]});let asks=0;
 await K.continuePlan(first,{execute:f.read,ask:async()=>++asks===1?first:JSON.stringify({message:'done',actions:[]}),maxRounds:3});
 assert.equal(f.calls.length,2);assert.equal(asks,2);
 const g=fixture();let sent=0;await assert.rejects(K.continuePlan(JSON.stringify({knowledgeRequests:[{type:'agenda_read',eventId:'e'}]}),{execute:g.read,ask:async()=>{sent++;return '{}'},onCheckpoint:async()=>{g.conversation.private=true;}}),{code:'CANCELLED',reason:'KNOWLEDGE_SOURCE_CHANGED'});assert.equal(sent,0);
});
test('only durable matching mutation receipt settles pending; save failure never opens review',async()=>{
 const f=fixture();await f.read({type:'agenda_read',eventId:'e'});f.run.status='completed';f.run.agendaProposals=P.validate([proposal(f)],f.state,f.run);
 class Node{constructor(){this.children=[];this.dataset={};}append(...x){this.children.push(...x);}}
 const keys=['document','state','toast','saveDocumentDurably','workstationDesktop','NativeSnapshotChannel'];const old=keys.map(k=>[k,Object.getOwnPropertyDescriptor(global,k)]);let opened=0,retries=0,status='unknown';const issues=[];
 const find=(n,c)=>n.className===c?n:n.children.map(x=>find(x,c)).find(Boolean);
 try{Object.assign(global,{document:{createElement:()=>new Node()},state:f.state,toast:x=>issues.push(x),saveDocumentDurably:async()=>false,NativeSnapshotChannel:{retry:()=>retries++},workstationDesktop:{agendaRelated:async()=>[],agendaMutation:async()=>{opened++;return {status:'pending_review'}},agendaMutationStatus:async requestId=>({version:1,status,requestId,eventId:'e',persisted:true,receiptFingerprint:'b'.repeat(64)})}});
  const button=find(P.card(f.run),'secondary agenda-proposal-review');await button.onclick();assert.equal(opened,0);assert.equal(P.hasPending(f.run),true);
  global.saveDocumentDurably=async()=>true;await button.onclick();assert.equal(opened,1);assert.equal(P.hasPending(f.run),true);
  status='committed';await P.refresh();assert.equal(P.hasPending(f.run),false);assert.match(P.settledSummary(f.run),/已删除.*打篮球/);assert.ok(retries>0);
 }finally{for(const [k,v] of old)if(v)Object.defineProperty(global,k,v);else delete global[k];}
});
test('a saved then cancelled creation remains settled and is not offered for reopening',async()=>{
 const f=fixture();f.run.status='completed';const text=f.message.text;
 f.run.agendaProposals=P.validate([{title:'synthetic',sourceMessageId:'u',quote:text,start:'2026-10-04T15:00:00+08:00',end:'2026-10-04T16:00:00+08:00',timeZone:'Asia/Shanghai'}],f.state,f.run);
 class Node{constructor(){this.children=[];this.dataset={};}append(...x){this.children.push(...x);}}
 const before=['state','document','workstationDesktop'].map(k=>[k,Object.getOwnPropertyDescriptor(global,k)]);let options;
 try{Object.assign(global,{state:f.state,document:{createElement:()=>new Node()},workstationDesktop:{agendaProposal:async()=>{},agendaRelated:async value=>{options=value;return [{id:f.run.agendaProposals[0].id,deleted:true}];}}});await P.refresh();assert.deepEqual(options,{includeCancelled:true});assert.equal(P.hasPending(f.run),false);
  const row=P.card(f.run).children[1],button=row.children[1];assert.equal(button.disabled,true);assert.match(button.textContent,/已取消/);
 }finally{for(const [k,d]of before)if(d)Object.defineProperty(global,k,d);else delete global[k];}
});

test('existing long titles remain deletable and editable without allowing oversized replacement titles',async()=>{
 const f=fixture();f.event.title='长'.repeat(201);await f.read({type:'agenda_read',eventId:'e'});
 assert.equal(P.validate([proposal(f)],f.state,f.run)[0].operation,'delete');
 assert.equal(P.validate([{...proposal(f),operation:'update',patch:{location:'室内'}}],f.state,f.run)[0].patch.location,'室内');
 assert.throws(()=>P.validate([{...proposal(f),operation:'update',patch:{title:'新'.repeat(201)}}],f.state,f.run),{code:'INVALID_AGENDA_PROPOSAL'});
});
