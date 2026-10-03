/* Native calendar evidence: host scope, fresh records, and reviewed mutations. */
(function(root,factory){const api=factory(root,typeof module==='object'&&module.exports?require('./context-retrieval'):root.ContextRetrieval);if(typeof module==='object'&&module.exports)module.exports=api;else root.AgendaAccess=api;})(globalThis,(root,R)=>{
 'use strict';
 const list=x=>Array.isArray(x)?x:[],clone=x=>JSON.parse(JSON.stringify(x));
 const active=x=>!!x&&!x.private&&!x.incognito&&!x.ephemeral&&!x.deleted&&!x.deletedAt&&!x.archived&&!x.archivedAt&&!['deleted','archived'].includes(x.status);
 const id=x=>typeof x==='string'&&x.length>0&&x.length<=512&&!/[\u0000-\u001f\u007f]/.test(x);
 const canonical=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
 const failure=(message='日程读取范围已变化，请重新查询。',code='CANCELLED')=>Object.assign(Error(message),{code});
 const unique=(rows,key)=>{const found=list(rows).filter(x=>x?.id===key);return found.length===1?found[0]:null;};
 const guard=Symbol('agendaCurrent');let hooks={};
 function init(options){hooks=options||{};}
 const scopeFor=run=>run.recordAssignmentScope||{projectId:run.projectId||null,workspace:run.contextWorkspace||null,readProjects:[]};
 function normalizeContext(value){
  if(!value||Object.keys(value).some(k=>!['runId','conversationId','userMessageId','scope'].includes(k)))throw failure();
  const scope=value.scope||{};if(Object.keys(scope).some(k=>!['projectId','workspace','readProjects'].includes(k))||scope.projectId!=null&&typeof scope.projectId!=='string'||scope.workspace!=null&&typeof scope.workspace!=='string'||scope.readProjects!==undefined&&(!Array.isArray(scope.readProjects)||scope.readProjects.some(p=>!id(p))))throw failure();
  return {runId:value.runId,conversationId:value.conversationId,userMessageId:value.userMessageId,scope:{projectId:scope.projectId||'',workspace:scope.workspace||'auto',readProjects:[...new Set(scope.readProjects||[])].sort()}};
 }
 function contextFor(run){const scope=scopeFor(run);return normalizeContext({runId:run.id,conversationId:run.conversationId,userMessageId:run.userMessageId,scope:{projectId:scope.projectId||'',workspace:scope.workspace||'auto',readProjects:list(scope.readProjects).map(p=>p.id)}});}
 function owner(state,context){
  if(!state||root.PrivateMode?.isOn?.()||hooks.available?.()===false||!context||!id(context.runId)||!id(context.conversationId)||!id(context.userMessageId))throw failure();
  const run=unique(state.agentRuns,context.runId),conversation=unique(state.conversations,context.conversationId);
  if(!active(run)||!active(conversation)||run.conversationId!==conversation.id||run.userMessageId!==context.userMessageId||['cancelled','failed','interrupted','rejected','error'].includes(run.status))throw failure();
  const message=unique(conversation.messages,run.userMessageId);
  if(!active(message)||message.role!=='user'||message.intentSource==='automatic'||typeof message.text!=='string')throw failure();
  if((conversation.projectId||'')!==(run.projectId||'')||(conversation.workspace||'auto')!==(run.contextWorkspace||'auto'))throw failure();
  const scope=scopeFor(run);if(!R.readScopeCurrent(state,scope)||canonical(normalizeContext(context))!==canonical(contextFor(run)))throw failure();
  if(run.projectId&&!R.accessibleProjects(state).some(p=>p.id===run.projectId))throw failure();
  return {run,conversation,message,scope};
 }
 function eventAllowed(state,context,event){
  const {scope}=owner(state,context);
  if(!event||!id(event.eventId)||!active(event)||!/^([a-f0-9]{64})$/.test(event.version)||typeof event.title!=='string'||!Number.isFinite(event.start)||!Number.isFinite(event.end)||event.end<=event.start)throw failure('原生日程回执无效，请重新查询。','INVALID_AGENDA_RESULT');
  if(event.projectId){if(!R.projectsInScope(state,scope).some(p=>p.id===event.projectId))throw failure();}
  else if(scope.projectId||scope.workspace&&!['auto','日常'].includes(scope.workspace))throw failure();
  if(event.documentId){const type=({note:'note',import:'import',paper:'paper'})[event.documentKind];if(!type)throw failure();const matches=R.readableRecords(state,scope).filter(x=>x.type===type&&x.record.id===event.documentId);if(matches.length!==1)throw failure();}
  return event;
 }
 function authorize(context,proposal){try{const state=hooks.getState?.(),current=owner(state,context);if(proposal){
   const stored=list(current.run.agendaProposals).filter(p=>p.id===proposal.id);
   if(stored.length!==1||canonical(stored[0])!==canonical(proposal))throw failure();
   validateMutation(proposal,state,current.run);
  }return {status:'authorized',context:normalizeContext(context)};}catch{return {status:'denied'};}}
 function queryTime(value){
  if(typeof value==='number')return value;
  if(typeof value!=='string')return NaN;
  const parts=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if(!parts||parts[0]!==value)return NaN;
  const [year,month,day,hour,minute,second]=parts.slice(1,7).map(Number),millisecond=Number((parts[7]||'').padEnd(3,'0'));
  const offsetHour=Number(parts[10]||0),offsetMinute=Number(parts[11]||0);
  if(offsetHour>23||offsetMinute>59)return NaN;
  // Validate wall-clock fields before applying the offset; Date normalizes invalid calendar dates.
  const local=new Date(0);local.setUTCFullYear(year,month-1,day);local.setUTCHours(hour,minute,second,millisecond);
  if(local.getUTCFullYear()!==year||local.getUTCMonth()!==month-1||local.getUTCDate()!==day||local.getUTCHours()!==hour||local.getUTCMinutes()!==minute||local.getUTCSeconds()!==second)return NaN;
  return local.getTime()-(parts[9]==='-'?-1:1)*(offsetHour*60+offsetMinute)*60000;
 }
 function requestFor(request){
  if(!request||!['agenda_list','agenda_read'].includes(request.type))throw failure('无效日程读取请求。','INVALID_AGENDA_REQUEST');
  const allowed=request.type==='agenda_list'?['type','query','from','to','limit','offset']:['type','eventId','expectedVersion'];
  if(Object.keys(request).some(k=>!allowed.includes(k)))throw failure('日程请求只能使用当前运行的读取范围。','INVALID_AGENDA_REQUEST');
  const {type,...out}=request;
  if(type==='agenda_read'){if(!id(out.eventId)||out.expectedVersion!==undefined&&!/^[a-f0-9]{64}$/.test(out.expectedVersion))throw failure('无效日程身份或版本。','INVALID_AGENDA_REQUEST');return out;}
  out.query=out.query??'';out.offset=out.offset??0;out.limit=out.limit??20;
  for(const key of ['from','to'])if(out[key]!==undefined)out[key]=queryTime(out[key]);
  if(typeof out.query!=='string'||out.query.length>1000||!Number.isSafeInteger(out.offset)||out.offset<0||out.offset>10000||!Number.isSafeInteger(out.limit)||out.limit<1||out.limit>50||(out.from===undefined)!==(out.to===undefined)||out.from!==undefined&&(!Number.isSafeInteger(out.from)||!Number.isSafeInteger(out.to)||out.to<=out.from||out.to-out.from>366*86400000))throw failure('日程查询需要有效分页；时间范围需成对提供毫秒时间戳或带时区的 ISO 8601 日期时间，且结束晚于开始、最多 366 天。','INVALID_AGENDA_REQUEST');
  return out;
 }
 async function execute(request,{state,run,scope,bridge=root.workstationDesktop,getState=()=>state,validate=()=>{}}={}){
  const input=requestFor(request),context=contextFor(run);const before=owner(getState(),context),messageText=before.message.text;
  if(before.run!==run||scope&&canonical({projectId:scope.projectId||null,workspace:scope.workspace||null,readProjects:scope.readProjects||[]})!==canonical({projectId:scopeFor(run).projectId||null,workspace:scopeFor(run).workspace||null,readProjects:scopeFor(run).readProjects||[]}))throw failure();
  const check=live=>{validate();const current=owner(live??getState(),context);if(current.run!==run||current.conversation!==before.conversation||current.message.text!==messageText)throw failure();return current;};check();
  const call=request.type==='agenda_list'?bridge?.agendaQuery:bridge?.agendaRead;
  if(typeof call!=='function')throw failure('当前版本未提供原生日程读取，请更新后再试。','AGENDA_UNAVAILABLE');
  const reply=await call(input,context);check();
  if(reply?.version!==1||reply.authority!=='native-agenda'||reply.status!=='ready')throw failure('日程未能完成读取；这不代表没有日程，请查看日程后重试。','AGENDA_UNAVAILABLE');
  let result,events;
  if(request.type==='agenda_read'){
   const event=eventAllowed(getState(),context,reply.event);if(event.eventId!==input.eventId||input.expectedVersion&&event.version!==input.expectedVersion)throw failure('日程已变化，请重新读取当前版本。','AGENDA_CHANGED');
   events=[event];run.agendaReads ||= [];run.agendaReads=run.agendaReads.filter(r=>r.event.eventId!==event.eventId);
   run.agendaReads.push({context:clone(context),sourceText:messageText,event:clone(event)});
   result={type:'agenda',eventId:event.eventId,version:event.version,event:clone(event),authority:reply.authority,contentRead:true};
  }else{
   if(!Array.isArray(reply.items)||reply.items.length>input.limit||!Number.isSafeInteger(reply.total)||reply.total<0||reply.offset!==input.offset||reply.limit!==input.limit||typeof reply.hasMore!=='boolean'||reply.hasMore&&!reply.items.length)throw failure('原生日程分页回执无效。','INVALID_AGENDA_RESULT');
   events=reply.items.map(e=>eventAllowed(getState(),context,e));
   result={type:'agenda_list',entries:clone(events),total:reply.total,offset:reply.offset,limit:reply.limit,nextOffset:reply.hasMore?reply.offset+events.length:null,authority:reply.authority,scope:clone(context.scope),hint:'日程与任务是不同记录。此结果来自原生日程；零结果仅代表当前范围/查询。修改或删除前须 agenda_read 获取精确版本，再提交日程提案等待用户审阅。'};
  }
  result[guard]=live=>{check(live);for(const event of events)eventAllowed(live??getState(),context,event);};return result;
 }
 function validateResult(result,state){result?.[guard]?.(state);return result;}
 const deletionIntent=text=>String(text).replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/gu,' [quoted] ').split(/[。！？!?\n；;]/u).some(clause=>{
  if(/(?:不要|别|禁止|不得|不许|无需|不能).*(?:删除|取消|移除|删掉|删了)|\b(?:do not|don't|never)\s+(?:delete|remove|cancel)\b/i.test(clause)||/例如|示例|原文|引用|论文.{0,8}(?:讲|说|讨论)/u.test(clause))return false;
  // A direct instruction can follow a lookup clause; a quoted command cannot.
  // Check negation across the sentence before splitting its comma clauses.
  return clause.split(/[，,]/u).some(part=>{
  const text=part.trim().replace(/^(?:并且|然后|同时|并|再)\s*/u,'');
  return /^(?:请(?:你)?|帮我|麻烦(?:你)?|我要|我想|想要)?\s*(?:删除|取消|移除|删掉|删了)\s*\S+/u.test(text)
   ||/^(?:请|帮我|麻烦)?\s*(?:把|将).+(?:删除|取消|移除|删掉|删了)(?:掉|吧|一下)?$/u.test(text)
   ||/^(?:please\s+|can you\s+|could you\s+|i want (?:you )?to\s+)?(?:delete|remove|cancel)\s+\S+/i.test(text);
  });
 });
 function validateMutation(value,state,run){
  const context=contextFor(run),{message}=owner(state,context);
  if(!value||!['update','delete'].includes(value.operation)||!id(value.eventId)||! /^[a-f0-9]{64}$/.test(value.expectedVersion)||value.sourceMessageId!==run.userMessageId||value.conversationId!==undefined&&value.conversationId!==run.conversationId||value.runId!==undefined&&value.runId!==run.id||typeof value.quote!=='string'||value.quote.trim().length<4||!message.text.includes(value.quote))throw failure('日程修改提案须绑定本轮用户原话与已读日程版本。','INVALID_AGENDA_PROPOSAL');
  const reads=list(run.agendaReads).filter(r=>r.event?.eventId===value.eventId&&r.event.version===value.expectedVersion&&r.sourceText===message.text&&canonical(r.context)===canonical(context));
  if(reads.length!==1)throw failure('请先用 agenda_read 读取要修改的日程，不可从任务或历史猜测日程 ID。','AGENDA_READ_REQUIRED');
  const event=eventAllowed(state,context,reads[0].event),repeating=!!event.recurrence&&event.recurrence.frequency!=='none';
  if(!['single','series'].includes(value.scope)||repeating&&value.scope!=='series')throw failure('重复日程须明确修改整个系列；当前不支持提案修改单次重复。','INVALID_AGENDA_PROPOSAL');
  if(repeating&&!/(?:整个|整组|全部|所有|系列|每次|每周|每天|每月)|\b(?:series|all|every)\b/i.test(value.quote))throw failure('请先明确是否操作整个重复系列。','INVALID_AGENDA_PROPOSAL');
  if(value.operation==='delete'&&(!deletionIntent(value.quote)||!deletionIntent(message.text)))throw failure('删除日程必须引用本轮明确的删除或取消请求。','INVALID_AGENDA_PROPOSAL');
  const patch=value.patch||{},allowed=['title','start','end','timeZone','allDay','location','details','reminderMinutes'];
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>!allowed.includes(k))||value.operation==='update'&&!Object.keys(patch).length||value.operation==='delete'&&Object.keys(patch).length)throw failure('日程修改字段无效；归属和重复规则需在原生日程编辑。','INVALID_AGENDA_PROPOSAL');
  const candidate={...event,...patch};
  if(typeof candidate.title!=='string'||!candidate.title.trim()||Object.hasOwn(patch,'title')&&candidate.title.length>200||!Number.isFinite(candidate.start)||!Number.isFinite(candidate.end)||Math.abs(candidate.start)>=8.64e15||Math.abs(candidate.end)>=8.64e15||candidate.end<=candidate.start||Object.hasOwn(patch,'allDay')&&typeof patch.allDay!=='boolean'||['location','details'].some(k=>Object.hasOwn(patch,k)&&(typeof patch[k]!=='string'||patch[k].length>(k==='location'?2000:10000)))||Object.hasOwn(patch,'reminderMinutes')&&patch.reminderMinutes!==null&&(!Number.isSafeInteger(patch.reminderMinutes)||patch.reminderMinutes<0||patch.reminderMinutes>10080))throw failure('日程修改值无效。','INVALID_AGENDA_PROPOSAL');
  try{if(typeof candidate.timeZone!=='string'||!candidate.timeZone)throw Error();new Intl.DateTimeFormat('en',{timeZone:candidate.timeZone}).format();}catch{throw failure('日程时区无效。','INVALID_AGENDA_PROPOSAL');}
  return {event,context,patch:clone(patch)};
 }
 return {init,execute,authorize,contextFor,validateMutation,validateResult,canonical};
});
