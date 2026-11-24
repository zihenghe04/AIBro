process.env.TZ='Asia/Shanghai';
const test=require('node:test'),assert=require('node:assert/strict');
const Plugins=require('../app/plugin-host'),Tools=require('../app/tool-specs'),Today=require('../app/plugin-today');

// Friday 2026-10-30 10:00 local.
const now=Date.parse('2026-10-30T10:00:00+08:00'),at=s=>Date.parse(s+'+08:00');
Date.now=()=>now;
const tasks=[
  {id:'t-due',title:'交开题报告',dueAt:'2026-10-30',status:'todo',priority:'high'},
  {id:'t-late',title:'整理文献',dueAt:'2026-10-29',status:'todo'},
  {id:'t-old',title:'回邮件',dueAt:'2026-10-20',status:'todo'},
  {id:'t-done',title:'已完成',dueAt:'2026-10-30',status:'done'},
  {id:'t-gone',title:'已删除',dueAt:'2026-10-30',status:'todo',deletedAt:1},
];
const mirror=(id,value)=>({id,kind:'日程',content:JSON.stringify({format:'aibro.agenda.v1',...value})});
const notes=[
  mirror('e-meet',{title:'组会',start:at('2026-10-30T15:00:00'),end:at('2026-10-30T16:00:00'),timeZone:'Asia/Shanghai'}),
  mirror('e-run',{title:'跑步',start:at('2026-10-01T07:00:00'),end:at('2026-10-01T07:30:00'),timeZone:'Asia/Shanghai',recurrence:{frequency:'daily',interval:1}}),
  mirror('e-ics',{title:'外部',start:at('2026-10-02T09:00:00'),end:at('2026-10-02T10:00:00'),ics:'RRULE',recurrence:{frequency:'weekly',interval:1}}),
  mirror('e-del',{title:'取消了',start:at('2026-10-30T11:00:00'),end:at('2026-10-30T12:00:00'),deleted:true}),
];
const state={tasks,notes,projects:[]};
// AgendaAccess and the native bridge are faked; the real TaskContext pages tasks.
function context({agenda}={}){
  const calls=[];
  globalThis.AgendaAccess={execute:async(request)=>{calls.push(request);if(agenda==='down'){throw Object.assign(Error('x'),{code:'AGENDA_UNAVAILABLE'});}
    return {type:'agenda_list',entries:request.offset?[]:[{eventId:'e-meet',title:'组会',kind:'event',start:at('2026-10-30T15:00:00'),end:at('2026-10-30T16:00:00'),allDay:false,completed:[]}],nextOffset:null};}};
  const run={id:'r1',userMessageId:'m1',projectId:''};
  return {calls,run,ctx:{run,conversation:{id:'c1',workspace:'auto'},scope:{},getState:()=>state,lookup:name=>globalThis[name],validate:()=>{}}};
}

test('installs as a builtin with four read tools and the daily brief trigger',async()=>{
  const h=Plugins.create({registry:Tools.build(),transport:{load:async()=>({builtin:{},mcp:[]})}});
  Today.install(h);
  const t=h.triggers();
  assert.equal(t.length,1);assert.equal(t[0].key,'today.daily-brief');assert.equal(t[0].at,'08:30');assert.equal(t[0].enabled,true);
  assert.deepEqual(Today.specs.map(s=>s.name),Today.manifest.tools);
  for(const s of Today.specs)assert.equal(s.effect,'none');
});

test('today_query groups the day and keeps task snapshots for update_task',async()=>{
  const {ctx,run,calls}=context();
  const r=await Today.execute({type:'today_query'},ctx);
  assert.equal(r.type,'today_query');assert.equal(r.date,'2026-10-30');assert.equal(r.agenda,'native');
  assert.equal(calls[0].from,at('2026-10-16T00:00:00'));assert.equal(calls[0].to,at('2026-10-31T00:00:00'));
  assert.deepEqual(r.events.map(x=>x.eventId),['e-meet']);
  assert.deepEqual(r.due.map(x=>x.taskId),['t-due']);
  assert.deepEqual(r.carryover.map(x=>x.taskId),['t-late']);
  assert.deepEqual(r.overdue.map(x=>x.taskId),['t-old']);
  assert.deepEqual([...run.taskContext.taskIds].sort(),['t-due','t-late','t-old']);
  assert.equal(typeof run.taskContext.snapshots['t-due'].task,'string');
});

test('an unreadable agenda still lists tasks and says so',async()=>{
  const {ctx}=context({agenda:'down'});
  const r=await Today.execute({type:'today_query'},ctx);
  assert.equal(r.agenda,'unavailable');assert.equal(r.events.length,0);assert.equal(r.due.length,1);assert.match(r.hint,/读不到/);
  await assert.rejects(Today.execute({type:'today_query',date:'10/30'},ctx),/YYYY-MM-DD/);
  await assert.rejects(Today.execute({type:'today_query',extra:1},ctx),/声明的参数/);
});

test('today_create drafts an event proposal or a task, never writes',async()=>{
  const {ctx}=context();
  const e=await Today.execute({type:'today_create',text:'明天下午3点开组会'},ctx);
  assert.equal(e.status,'draft');assert.equal(e.kind,'event');
  assert.equal(e.agendaProposal.start,'2026-10-31T15:00:00+08:00');assert.equal(e.agendaProposal.quote,'明天下午3点开组会');assert.equal(e.agendaProposal.sourceMessageId,'m1');
  const t=await Today.execute({type:'today_create',text:'周五之前交开题报告'},ctx);
  assert.deepEqual(t.action,{type:'create_task',title:'交开题报告',dueAt:'2026-10-30',priority:'medium'});
  const vague=await Today.execute({type:'today_create',text:'后天下午'},ctx);
  assert.equal(vague.status,'needs-details');assert.ok(vague.reasons.length);
});

test('reschedule and complete need a task read this run',async()=>{
  const {ctx}=context();
  await assert.rejects(Today.execute({type:'today_complete',taskId:'t-due'},ctx),e=>e.code==='TASK_NOT_READ');
  await Today.execute({type:'today_query'},ctx);
  const done=await Today.execute({type:'today_complete',taskId:'t-due'},ctx);
  assert.deepEqual(done.action,{type:'update_task',taskId:'t-due',patch:{status:'done'}});
  assert.deepEqual((await Today.execute({type:'today_reschedule',taskId:'t-late',to:'明天'},ctx)).action.patch,{dueAt:'2026-10-31'});
  assert.deepEqual((await Today.execute({type:'today_reschedule',taskId:'t-late',to:'2026-11-02'},ctx)).action.patch,{dueAt:'2026-11-02'});
  assert.deepEqual((await Today.execute({type:'today_reschedule',taskId:'t-late',to:'明天下午3点'},ctx)).action.patch,{dueAt:'2026-10-31T15:00:00+08:00'});
  const ev=await Today.execute({type:'today_reschedule',eventId:'e-meet',to:'2026-11-02T15:00:00+08:00'},ctx);
  assert.equal(ev.status,'needs-read');assert.match(ev.hint,/agenda_read/);
  await assert.rejects(Today.execute({type:'today_reschedule',taskId:'t-late',to:'某天'},ctx),/看不懂/);
  await assert.rejects(Today.execute({type:'today_reschedule',taskId:'t-late',eventId:'e-meet',to:'明天'},ctx),/只能给一个/);
});

test('mirror notes expand like the agenda engine',()=>{
  const from=at('2026-10-16T00:00:00'),to=at('2026-10-31T00:00:00');
  const daily={eventId:'d',title:'跑步',start:at('2026-10-01T07:00:00'),end:at('2026-10-01T07:30:00'),timeZone:'Asia/Shanghai',recurrence:{frequency:'daily',interval:2},excluded:[at('2026-10-17T07:00:00')],completed:[at('2026-10-29T07:00:00')]};
  const d=Today.expand(daily,from,to,'Asia/Shanghai');
  // Every other day from Oct 1 (odd days), minus the 17th.
  assert.deepEqual(d.rows.map(r=>new Date(r.occurrenceStart).getDate()),[19,21,23,25,27,29]);
  assert.equal(d.rows.find(r=>r.isDone).occurrenceStart,at('2026-10-29T07:00:00'));assert.equal(d.partial,false);
  const weekly={eventId:'w',title:'课',start:at('2026-10-06T14:00:00'),end:at('2026-10-06T15:00:00'),timeZone:'Asia/Shanghai',recurrence:{frequency:'weekly',interval:1,weekdays:[3,5],count:5}};
  // Tue/Thu from Oct 6: 6, 8, 13, 15, 20 -> only the 20th is in range.
  assert.deepEqual(Today.expand(weekly,from,to,'Asia/Shanghai').rows.map(r=>new Date(r.occurrenceStart).getDate()),[20]);
  assert.equal(Today.expand({...weekly,timeZone:'Europe/Berlin'},from,to,'Asia/Shanghai').partial,true);
  assert.equal(Today.expand({...weekly,recurrence:{frequency:'monthly'}},from,to,'Asia/Shanghai').partial,true);
});

test('the brief handler gathers from state and saves through /__today/brief',async()=>{
  const posts=[];
  const fetch=async(path,init)=>{posts.push({path,body:JSON.parse(init.body)});return {ok:true,json:async()=>({ok:true})};};
  Today.init({getState:()=>null,fetch});
  await assert.rejects(Today.brief({}),/还没加载好/);
  Today.init({getState:()=>state,ready:()=>true,fetch});
  const r=await Today.brief({trigger:'daily-brief'});
  assert.equal(posts[0].path,'/__today/brief');
  const {date,brief}=posts[0].body;
  assert.equal(date,'2026-10-30');assert.equal(brief.source,'rules');assert.equal(brief.partial,true);
  // The imported (ICS) series is listed on a best effort and marks the brief partial.
  assert.deepEqual(brief.digest.events.map(x=>x.title),['跑步','外部','组会']);
  assert.equal(brief.digest.counts.due,1);assert.ok(brief.lines.length);
  assert.match(r.summary,/2026-10-30 简报：日程 3.*部分/);
  Today.init({getState:()=>state,fetch:async()=>({ok:false,json:async()=>({error:'简报太大'})})});
  await assert.rejects(Today.brief({}),/简报太大/);
});

test('runs through the plugin host trigger',async()=>{
  const h=Plugins.create({registry:Tools.build(),transport:{load:async()=>({builtin:{},mcp:[]})}});
  Today.install(h);
  let posted=0;Today.init({getState:()=>state,fetch:async()=>{posted++;return {ok:true,json:async()=>({})};}});
  const result=await h.runTrigger('today.daily-brief',{executionId:'x',scheduledFor:now,catchUp:false});
  assert.equal(posted,1);assert.match(JSON.stringify(result),/简报/);
});
