/* Today digest (M2): what "today" holds, from agenda occurrences and workspace
   tasks. Pure and synchronous, in the local time zone: the today plugin's
   tools and the morning brief group items with these rules, and the native
   today page (TodayDigest.swift) mirrors them. Never calls a model. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.TodayDigest=api;})(globalThis,()=>{
 'use strict';
 const DONE=['done','archived','deleted'],LIMIT=12,DAY=/^(\d{4})-(\d{2})-(\d{2})$/;
 const list=x=>Array.isArray(x)?x:[];
 const startOfDay=ms=>{const d=new Date(ms);d.setHours(0,0,0,0);return d.getTime();};
 const addDays=(ms,n)=>{const d=new Date(ms);d.setDate(d.getDate()+n);return d.getTime();};
 const dayKey=ms=>{const d=new Date(ms);return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');};
 // A calendar-day deadline is local midnight; a timed one keeps its instant.
 function deadline(value){
  if(typeof value==='number')return Number.isFinite(value)?{at:value,dayOnly:false}:null;
  if(typeof value!=='string'||!value)return null;
  const day=DAY.exec(value);
  if(day){const d=new Date(+day[1],+day[2]-1,+day[3]);return d.getMonth()===+day[2]-1&&d.getDate()===+day[3]?{at:d.getTime(),dayOnly:true}:null;}
  const at=Date.parse(value);return Number.isFinite(at)?{at,dayOnly:false}:null;
 }
 const priority=x=>x.priority==='high'?0:x.priority==='low'?2:1;
 const byTime=(a,b)=>a.at-b.at||priority(a)-priority(b)||String(a.id).localeCompare(String(b.id));
 function taskItem(task){
  const due=deadline(task.dueAt);if(!due)return null;
  return {source:'task',id:task.id,title:String(task.title||task.name||'').trim(),at:due.at,dayOnly:due.dayOnly,projectId:task.projectId||'',priority:task.priority||'medium',status:task.status||'todo'};
 }
 function occurrence(row){
  const start=Number(row.occurrenceStart??row.start),end=Number(row.occurrenceEnd??row.end);
  if(!Number.isFinite(start)||!Number.isFinite(end)||row.deleted)return null;
  return {source:'agenda',id:row.eventId||row.id,title:String(row.title||'').trim(),kind:row.kind==='task'?'task':'event',start,end,at:start,
   allDay:!!row.allDay,location:row.location||'',projectId:row.projectId||'',done:!!row.isDone,...(row.occurrenceStart!=null?{occurrenceStart:start}:{})};
 }
 const cap=(rows,limit)=>({items:rows.slice(0,limit),more:Math.max(0,rows.length-limit)});
 /* build({occurrences, tasks, now, limit}) -> groups for one local day.
    events: today's calendar items (state past/now/next/later); due: deadlines
    falling today (late once passed); carryover: yesterday's unfinished;
    overdue: older unfinished. Each list is capped; `more` counts the rest. */
 function build({occurrences=[],tasks=[],now=Date.now(),limit=LIMIT}={}){
  const today=startOfDay(now),tomorrow=addDays(today,1),yesterday=addDays(today,-1);
  const rows=list(occurrences).map(occurrence).filter(Boolean),pending=list(tasks).filter(t=>t&&!DONE.includes(t.status)&&!t.deletedAt&&!t.archived).map(taskItem).filter(Boolean);
  const events=rows.filter(r=>r.kind==='event'&&r.start<tomorrow&&r.end>today).sort((a,b)=>b.allDay-a.allDay||a.start-b.start);
  let nextMarked=false;
  for(const e of events){
   if(e.allDay)e.state='allDay';
   else if(e.end<=now)e.state='past';
   else if(e.start<=now)e.state='now';
   else if(!nextMarked){e.state='next';nextMarked=true;}
   else e.state='later';
  }
  // Agenda to-dos count like tasks; done occurrences drop out.
  const todos=rows.filter(r=>r.kind==='task'&&!r.done);
  const deadlines=[...pending,...todos];
  const due=deadlines.filter(x=>x.at>=today&&x.at<tomorrow).map(x=>({...x,late:x.source==='task'?!x.dayOnly&&x.at<now:!x.allDay&&x.end<=now})).sort(byTime);
  const carryover=deadlines.filter(x=>x.at>=yesterday&&x.at<today).sort(byTime);
  const overdue=deadlines.filter(x=>x.at<yesterday).sort(byTime);
  const groups={events:cap(events,limit),due:cap(due,limit),carryover:cap(carryover,limit),overdue:cap(overdue,limit)};
  return {version:1,date:dayKey(now),generatedAt:now,...groups,
   counts:{events:events.length,due:due.length,late:due.filter(x=>x.late).length,carryover:carryover.length,overdue:overdue.length},
   empty:!events.length&&!due.length&&!carryover.length&&!overdue.length};
 }
 const clock=ms=>{const d=new Date(ms);return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');};
 const WEEK=['日','一','二','三','四','五','六'];
 // The brief without a model: plain lines, what the page shows when no AI text exists.
 function lines(digest){
  const d=new Date(digest.generatedAt),out=[`${d.getMonth()+1}月${d.getDate()}日 星期${WEEK[d.getDay()]}`];
  if(digest.empty)return [...out,'今天没有日程，也没有到期或遗留的任务。'];
  const c=digest.counts;
  if(c.events){const first=digest.events.items.find(e=>e.state==='now'||e.state==='next');out.push(`今天 ${c.events} 个日程`+(first?`，${first.state==='now'?'正在进行':'接下来'}：${first.allDay?'':clock(first.start)+' '}${first.title}`:'，都已结束'));}
  if(c.due)out.push(`今天到期 ${c.due} 项`+(c.late?`，其中 ${c.late} 项已过时间`:''));
  if(c.carryover)out.push(`昨天没做完 ${c.carryover} 项：`+digest.carryover.items.slice(0,3).map(x=>x.title).join('、')+(c.carryover>3?' 等':''));
  if(c.overdue)out.push(`更早过期 ${c.overdue} 项`);
  return out;
 }
 // Compact input for the model brief: titles and times only, no details or notes.
 function forModel(digest){
  const row=x=>({title:x.title.slice(0,120),...(x.source==='agenda'&&x.kind==='event'?{time:x.allDay?'全天':clock(x.start)+'-'+clock(x.end),state:x.state}:{due:x.dayOnly?dayKey(x.at):dayKey(x.at)+' '+clock(x.at)}),...(x.late?{late:true}:{}),...(x.priority&&x.priority!=='medium'?{priority:x.priority}:{})});
  return {date:digest.date,events:digest.events.items.map(row),due:digest.due.items.map(row),carryover:digest.carryover.items.map(row),overdue:digest.overdue.items.map(row),counts:digest.counts};
 }
 return {LIMIT,build,lines,forModel,deadline,dayKey,startOfDay};
});
