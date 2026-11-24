/* Built-in today plugin (M2): what is on today, one-sentence capture, and the
   daily brief. The tools only read and draft: a new event becomes an
   agendaProposals entry and a task change a create_task / update_task action,
   both of which still go through the ordinary review. The daily-brief trigger
   gathers the day from the workspace state (agenda mirror notes and tasks),
   builds the rule-based brief with TodayDigest and saves it via
   /__today/brief; no model request is made here. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.AIBroTodayPlugin=api;})(globalThis,root=>{
  'use strict';
  const node=typeof module==='object'&&module.exports;
  const MODULES={TodayDigest:'./today-digest',TodayParse:'./today-parse',TaskContext:'./task-context',AgendaAccess:'./agenda-access'};
  const lookup=name=>root[name]||(node&&MODULES[name]?require(MODULES[name]):null);
  const list=x=>Array.isArray(x)?x:[];
  const DAY=/^\d{4}-\d{2}-\d{2}$/,AGENDA_PAGES=4,TASK_PAGES=25,BACK_DAYS=14;
  const manifest=Object.freeze({
    id:'today',version:'1.0.0',apiVersion:1,kind:'builtin',prefix:'today_',
    name:{zh:'今天',en:'Today'},
    summary:{zh:'今天的日程、到期和遗留任务；把一句话整理成待审阅的日程或任务草稿；改期、完成草稿；每日简报',en:'Today\'s agenda and due tasks; draft events or tasks from one sentence; reschedule and complete drafts; daily brief'},
    enabledByDefault:true,permissions:[],capability:{name:'today'},
    tools:['today_query','today_create','today_reschedule','today_complete'],
    triggers:[{id:'daily-brief',name:{zh:'每日简报',en:'Daily brief'},schedule:'daily',at:'08:30',handler:'brief'}],
  });
  let hooks={};
  const zone=()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}catch{return 'UTC';}};
  const failure=(message,code='INVALID_TODAY_REQUEST')=>Object.assign(Error(message),{code});
  const addDays=(ms,n)=>{const d=new Date(ms);d.setDate(d.getDate()+n);return d.getTime();};
  // Local wall-clock ISO 8601 with the offset, as agendaProposals and dueAt expect.
  function iso(ms){
    const d=new Date(ms),pad=n=>String(Math.abs(n)).padStart(2,'0'),off=-d.getTimezoneOffset();
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off<0?'-':'+'}${pad(Math.trunc(off/60))}:${pad(off%60)}`;
  }
  const gate={gate:'keys',gateError:{code:'INVALID_TODAY_REQUEST',message:'今天工具只接受声明的参数'}};
  const read=(name,zh,en,description,properties,catalog,required)=>({
    name,title:{zh,en},description,effect:'none',approval:'never',concurrency:'parallel',cache:{mode:'live',key:Object.keys(properties),normalize:{}},
    input:{type:'object',properties,...(required?{required}:{}),additionalProperties:false},hosts:['webview'],evidence:true,...gate,prompt:{catalog},
  });
  const id={type:'string',minLength:1,maxLength:512};
  const specs=[
    read('today_query','查看今天','Today','今天（或指定日期）的日程、今天到期、昨天没做完和更早过期的任务。只读。',
      {date:{type:'string',description:'YYYY-MM-DD，缺省为今天'},limit:{type:'integer',minimum:1,maximum:30}},'today_query(date,limit)'),
    read('today_create','整理一句话','Draft from a sentence','把用户的一句话按规则整理成日程提案或任务草稿；不写入。',
      {text:{type:'string',minLength:1,maxLength:500}},'today_create(text)',['text']),
    read('today_reschedule','改期草稿','Draft a reschedule','为任务生成改期 update_task 草稿；日程给出改期步骤。不写入。',
      {taskId:id,eventId:id,to:{type:'string',minLength:1,maxLength:100,description:'YYYY-MM-DD、带时区 ISO 8601 或“明天下午3点”'}},'today_reschedule(taskId|eventId,to)',['to']),
    read('today_complete','完成草稿','Draft a completion','为任务生成标记完成的 update_task 草稿。不写入。',
      {taskId:id},'today_complete(taskId)',['taskId']),
  ];

  // Tasks in the conversation's scope, paged through TaskContext so the same
  // filter as task_list applies; snapshots are kept for update_task review.
  function scopedTasks(ctx){
    const T=lookup('TaskContext'),state=ctx.getState(),tasks=[],snapshots={};let offset=0,partial=false;
    const byId=new Map(list(state?.tasks).filter(t=>t?.id).map(t=>[t.id,t]));
    for(let page=0;page<TASK_PAGES;page++){
      const result=T.search(state,ctx.conversation,{offset});
      for(const taskId of result.context.taskIds){const snap=result.context.snapshots[taskId];if(snap&&byId.has(taskId)){tasks.push(byId.get(taskId));snapshots[taskId]=snap;}}
      if(result.nextOffset==null)break;offset=result.nextOffset;if(page===TASK_PAGES-1)partial=true;
    }
    return {tasks,snapshots,partial};
  }
  function keepSnapshots(run,snapshots,ids){
    run.taskContext ||= {taskIds:[],snapshots:{}};
    for(const taskId of ids)if(snapshots[taskId]&&!run.taskContext.taskIds.includes(taskId)){
      run.taskContext.taskIds.push(taskId);
      Object.defineProperty(run.taskContext.snapshots,taskId,{value:snapshots[taskId],enumerable:true,writable:true,configurable:true});
    }
  }
  // Native agenda rows for [from, to): recurring events come expanded.
  async function agendaRows(ctx,from,to){
    const A=lookup('AgendaAccess'),rows=[];let offset=0;
    try{
      for(let page=0;page<AGENDA_PAGES;page++){
        const result=await A.execute({type:'agenda_list',from,to,limit:50,offset},{run:ctx.run,scope:ctx.scope,getState:ctx.getState,bridge:ctx.lookup?.('workstationDesktop'),validate:ctx.validate});
        for(const e of result.entries)rows.push({...e,isDone:e.isDone??list(e.completed).includes(e.start)});
        if(result.nextOffset==null)return {rows,partial:false};
        offset=result.nextOffset;
      }
      return {rows,partial:true};
    }catch(error){
      if(error?.code==='AGENDA_UNAVAILABLE')return {rows,partial:true,unavailable:true};
      throw error;
    }
  }
  function dayNow(date){
    if(date===undefined)return Date.now();
    if(typeof date!=='string'||!DAY.test(date))throw failure('date 应为 YYYY-MM-DD');
    const at=lookup('TodayDigest').deadline(date);if(!at)throw failure('日期无效');
    const today=lookup('TodayDigest').startOfDay(Date.now());
    return at.at===today?Date.now():at.at+12*3600000;
  }
  // forModel rows plus the ids the agent needs for a follow-up draft.
  function present(digest){
    const D=lookup('TodayDigest'),model=D.forModel(digest),out={date:digest.date,counts:digest.counts,empty:digest.empty};
    for(const group of ['events','due','carryover','overdue']){
      out[group]=digest[group].items.map((x,i)=>({...(x.source==='task'?{taskId:x.id}:{eventId:x.id,kind:x.kind}),...model[group][i]}));
      if(digest[group].more)out[group+'More']=digest[group].more;
    }
    return out;
  }
  async function query(request,ctx){
    const D=lookup('TodayDigest'),now=dayNow(request.date),today=D.startOfDay(now);
    const limit=request.limit===undefined?D.LIMIT:request.limit;
    if(!Number.isSafeInteger(limit)||limit<1||limit>30)throw failure('limit 应为 1-30');
    const agenda=await agendaRows(ctx,addDays(today,-BACK_DAYS),addDays(today,1));
    const tasks=scopedTasks(ctx);
    const digest=D.build({occurrences:agenda.rows,tasks:tasks.tasks,now,limit});
    const shown=['due','carryover','overdue'].flatMap(g=>digest[g].items).filter(x=>x.source==='task').map(x=>x.id);
    keepSnapshots(ctx.run,tasks.snapshots,shown);
    const notes=[];
    if(agenda.unavailable)notes.push('原生日程暂时读不到，下面只有任务；这不代表今天没有日程。');
    else if(agenda.partial)notes.push('日程条目太多，只列出了前 '+agenda.rows.length+' 条。');
    if(tasks.partial)notes.push('任务太多，只统计了前 '+tasks.tasks.length+' 项。');
    notes.push(`更早的日程待办只看最近 ${BACK_DAYS} 天。改期或完成任务用 today_reschedule / today_complete 取草稿，再放进 actions 等用户确认。`);
    return {type:'today_query',...present(digest),lines:D.lines(digest),agenda:agenda.unavailable?'unavailable':'native',hint:notes.join('')};
  }

  const NEEDS={'no-title':'没有可用的标题','vague-time':'时间只到上午/下午/晚上','no-time':'没有日期或时间','model-invalid':'模型结果无效','model-failed':'模型不可用'};
  function create(request,ctx){
    const text=String(request.text||'').trim();if(!text)throw failure('text 不能为空');
    const parsed=lookup('TodayParse').parseRules(text,{now:Date.now(),timeZone:zone()});
    if(parsed.needsModel)return {type:'today_create',status:'needs-details',reasons:parsed.reasons.map(r=>NEEDS[r]||r),guess:{kind:parsed.kind,title:parsed.title||null,...(parsed.start!=null?{start:iso(parsed.start)}:{}),...(parsed.dueAt?{dueAt:parsed.dueAt}:{})},
      hint:'规则无法确定。按用户原话直接写 agendaProposals 或 create_task；仍缺信息就向用户问一个具体问题，不要猜。'};
    const run=ctx.run||{};
    if(parsed.kind==='event'){
      const proposal={title:parsed.title,sourceMessageId:run.userMessageId,projectId:run.projectId||'',quote:text,start:iso(parsed.start),end:parsed.end!=null?iso(parsed.end):null,timeZone:parsed.timeZone,
        frequency:parsed.frequency||'none',interval:parsed.interval||1,weekdays:list(parsed.weekdays),reminderMinutes:parsed.reminderMinutes??null,location:'',details:'',count:null,until:null};
      return {type:'today_create',status:'draft',kind:'event',agendaProposal:proposal,...(parsed.endEstimated?{endEstimated:true}:{}),
        hint:'把 agendaProposal 放进 agendaProposals，等用户在审阅里确认。quote 必须是用户消息里的原话；不是原话就改成原话。'};
    }
    const action={type:'create_task',title:parsed.title,dueAt:parsed.dueAt??null,priority:'medium',...(parsed.reminderMinutes!=null?{reminderMinutes:parsed.reminderMinutes}:{}),...(run.projectId?{projectId:run.projectId}:{})};
    return {type:'today_create',status:'draft',kind:'task',action,hint:'把 action 放进 actions，等用户确认后才会创建。'};
  }
  // "to": a day, an ISO instant, or a short phrase the rules understand.
  function target(to){
    const value=String(to||'').trim(),D=lookup('TodayDigest');
    const exact=D.deadline(value);
    if(exact&&(DAY.test(value)||/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)))return exact.dayOnly?{dueAt:value,start:exact.at,dayOnly:true}:{dueAt:iso(exact.at),start:exact.at,dayOnly:false};
    const parsed=lookup('TodayParse').parseRules(value,{now:Date.now(),timeZone:zone()});
    if(parsed.dueAt){const d=D.deadline(parsed.dueAt);return {dueAt:parsed.dueAt,start:d?.at,dayOnly:!!d?.dayOnly};}
    if(parsed.start!=null)return {dueAt:iso(parsed.start),start:parsed.start,dayOnly:false};
    throw failure('看不懂新时间：'+value.slice(0,40)+'。请给 YYYY-MM-DD 或带时区的 ISO 8601。');
  }
  function knownTask(ctx,taskId){
    if(!ctx.run?.taskContext?.snapshots?.[taskId])throw failure('这个任务不在本轮读取过的范围里。先调用 today_query 或 task_list 找到它。','TASK_NOT_READ');
    // Snapshots hold the serialized task that update_task review compares against.
    const task=ctx.run.taskContext.snapshots[taskId].task;
    return typeof task==='string'?JSON.parse(task):task;
  }
  function reschedule(request,ctx){
    if(!!request.taskId===!!request.eventId)throw failure('taskId 和 eventId 只能给一个');
    const when=target(request.to);
    if(request.eventId)return {type:'today_reschedule',status:'needs-read',eventId:request.eventId,newStart:iso(when.start),
      hint:'日程改期须先 agenda_read 取得 expectedVersion，再提交 operation:"update" 的日程提案（保持原时长），等用户审阅。'};
    const task=knownTask(ctx,request.taskId);
    return {type:'today_reschedule',status:'draft',title:task.title,from:task.dueAt??null,action:{type:'update_task',taskId:request.taskId,patch:{dueAt:when.dueAt}},
      hint:'把 action 放进 actions，等用户确认后才会改期。'};
  }
  function complete(request,ctx){
    const task=knownTask(ctx,request.taskId);
    if(task.status==='done')return {type:'today_complete',status:'already-done',taskId:request.taskId,title:task.title};
    return {type:'today_complete',status:'draft',title:task.title,action:{type:'update_task',taskId:request.taskId,patch:{status:'done'}},hint:'把 action 放进 actions，等用户确认后才会标记完成。日程里的待办请在日程页勾选。'};
  }
  const TOOLS={today_query:query,today_create:create,today_reschedule:reschedule,today_complete:complete};
  async function execute(request,ctx){
    const run=TOOLS[request?.type];if(!run)throw failure('未知的今天工具');
    const {type,...rest}=request,allowed=Object.keys(specs.find(s=>s.name===type).input.properties);
    if(Object.keys(rest).some(k=>!allowed.includes(k)))throw failure('今天工具只接受声明的参数');
    return run(request,ctx);
  }

  // Agenda mirror notes (format aibro.agenda.v1) expanded for [from, to), the
  // same day-walk as AgendaEngine.occurrences. Rules this cannot follow
  // (imported ICS, another time zone, a very old daily series) set partial.
  function mirrorEvents(notes){
    const out=[];
    for(const note of list(notes)){
      if(!note||note.deletedAt||note.deleted||note.archived||note.archivedAt)continue;
      let v;try{v=JSON.parse(note.content||'{}');}catch{continue;}
      if(v?.format!=='aibro.agenda.v1'||v.deleted)continue;
      out.push({...v,eventId:note.id});
    }
    return out;
  }
  function expand(event,from,to,localZone){
    const start=Number(event.start),end=Number(event.end);
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)return {rows:[],partial:false};
    const excluded=new Set(list(event.excluded)),completed=new Set(list(event.completed));
    const row=(s,e)=>({eventId:event.eventId,title:event.title,kind:event.eventKind==='task'?'task':'event',start,end,occurrenceStart:s,occurrenceEnd:e,allDay:!!event.allDay,location:event.location||'',projectId:event.projectId||'',isDone:completed.has(s)});
    const r=event.recurrence&&typeof event.recurrence==='object'?event.recurrence:{frequency:'none'};
    const frequency=r.frequency||'none';
    if(frequency==='none')return {rows:start<to&&end>from&&!excluded.has(start)?[row(start,end)]:[],partial:false};
    const partial=!!event.ics||(event.timeZone&&event.timeZone!==localZone);
    if(!['daily','weekly'].includes(frequency))return {rows:[],partial:true};
    const interval=Math.max(1,r.interval|0),until=Number.isFinite(r.until)?r.until:Infinity,stop=Math.min(to,until);
    const base=new Date(start);base.setHours(0,0,0,0);
    const weekdays=list(r.weekdays).length?list(r.weekdays):[new Date(start).getDay()+1];
    const monday=d=>{const x=new Date(d);x.setDate(x.getDate()-((x.getDay()+6)%7));x.setHours(0,0,0,0);return x;};
    const firstWeek=monday(base),days=Math.round((stop-base.getTime())/86400000)+1;
    if(days>3660)return {rows:[],partial:true};
    const s0=new Date(start),rows=[];let total=0;
    for(let offset=0;offset<=days;offset++){
      const day=new Date(base);day.setDate(day.getDate()+offset);
      const matches=frequency==='daily'?offset%interval===0:Math.round((monday(day)-firstWeek)/(7*86400000))%interval===0&&weekdays.includes(day.getDay()+1);
      if(!matches)continue;
      day.setHours(s0.getHours(),s0.getMinutes(),s0.getSeconds(),0);const s=day.getTime();
      if(s<start)continue;if(s>stop)break;total++;
      if(Number.isInteger(r.count)&&total>r.count)break;
      let e;
      if(event.allDay){const n=new Date(s);n.setDate(n.getDate()+Math.max(1,Math.round((end-start)/86400000)));e=n.getTime();}else e=s+(end-start);
      if(s<to&&e>from&&!excluded.has(s))rows.push(row(s,e));
    }
    return {rows,partial};
  }
  function gather(state,now){
    const D=lookup('TodayDigest'),today=D.startOfDay(now),from=addDays(today,-BACK_DAYS),to=addDays(today,1),localZone=zone();
    const occurrences=[];let partial=false;
    for(const event of mirrorEvents(state?.notes)){const x=expand(event,from,to,localZone);occurrences.push(...x.rows);partial||=x.partial;}
    const projects=new Map(list(state?.projects).map(p=>[p.id,p]));
    const tasks=list(state?.tasks).filter(t=>t&&!t.deletedAt&&!(t.projectId&&(projects.get(t.projectId)?.deletedAt)));
    return {digest:D.build({occurrences,tasks,now}),partial};
  }
  // Trigger handler: the rule-based brief for today, saved for the today page.
  async function brief(ctx={}){
    const state=hooks.getState?.();
    if(!state||hooks.ready?.()===false)throw Error('工作区还没加载好，稍后再试');
    const D=lookup('TodayDigest'),now=hooks.now?.()??Date.now(),{digest,partial}=gather(state,now);
    const body={date:digest.date,brief:{version:1,source:'rules',partial,digest:D.forModel(digest),lines:D.lines(digest),trigger:ctx.trigger||'daily-brief',...(ctx.catchUp?{catchUp:true}:{})}};
    const fetchImpl=hooks.fetch||root.fetch?.bind(root);
    const response=await fetchImpl('/__today/brief',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:ctx.signal});
    const value=await response.json().catch(()=>({}));
    if(!response.ok)throw Error(value.error||'简报没有保存');
    const c=digest.counts;
    return {date:digest.date,summary:`${digest.date} 简报：日程 ${c.events}，今天到期 ${c.due}，昨天遗留 ${c.carryover}，更早过期 ${c.overdue}`+(partial?'（部分重复日程未展开）':'')};
  }

  const instructions=({tools})=>[
    '今天插件：查看当天安排，并把用户的话整理成待审阅的草稿。工具都只读，不会写入任何东西。',
    `可用：${tools.join('、')}。调用方式：knowledgeRequests 里写 {"type":"工具名",...参数}。`,
    '- today_query(date?,limit?)：今天的日程（state=now/next/later/past）、今天到期、昨天没做完、更早过期。结果里的 taskId 可直接用于 update_task。',
    '- today_create(text)：一句话→日程提案（agendaProposal）或任务草稿（create_task）。status=needs-details 时按用户原话自己补全或问用户。',
    '- today_reschedule(taskId|eventId,to)：任务给出 update_task 改期草稿；日程给出改期步骤。',
    '- today_complete(taskId)：给出标记完成的 update_task 草稿。',
    '草稿须放进 agendaProposals 或 actions，由用户在审阅里确认后才生效；不要声称已经写入。',
  ].join('\n');
  const plugin={
    manifest,specs,handlers:{brief},
    available:()=>!!lookup('TodayDigest')&&!!lookup('TodayParse'),
    instructions,
    nextStep:'先 today_query 看今天，再按需要取草稿；草稿要经用户确认。',
  };
  function install(host){return host.install(plugin);}
  if(root.AIBroPlugins?.default&&!node)install(root.AIBroPlugins.default);
  return {manifest,specs,plugin,install,execute,brief,gather,expand,iso,init(value){hooks=value||{};}};
});
