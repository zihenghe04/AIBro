/* Model output is a proposal. Only the native editor's Save schedules an event. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.AgendaProposals=api;})(globalThis,root=>{
 'use strict';const active=n=>n&&!n.archived&&!n.archivedAt&&!n.deleted&&!n.deletedAt;
 function validate(values,state,run){
  if(values===undefined)return [];if(!Array.isArray(values)||values.length>12)throw Error('日程提案最多 12 项。');
  if(typeof run.userMessageId!=='string'||!run.userMessageId||run.userMessageId.length>160)throw Error('日程提案缺少原始消息身份。');
  return values.map((v,index)=>{
   if(!v||typeof v.title!=='string'||!v.title.trim()||v.title.length>200)throw Error('日程提案需要有效标题。');
   const note=(state.notes||[]).find(n=>n.id===v.sourceNoteId&&active(n));
   const conversation=(state.conversations||[]).find(c=>c.id===run.conversationId&&!c.deletedAt&&!c.archived);
   const message=conversation?.messages?.find(m=>m.id===run.userMessageId&&m.id===v.sourceMessageId&&m.role==='user'&&!m.deletedAt);
   const fromMessage=!!v.sourceMessageId;
   if(typeof v.quote!=='string'||v.quote.trim().length<4||(fromMessage?(!message||!message.text.includes(v.quote)):(!note||!(run.captureNoteIds||[]).includes(note.id)||!note.content.includes(v.quote))))throw Error('日程提案必须引用本轮随记或当前用户消息中的准确原话。');
   const endEstimated=fromMessage&&v.end==null;
   if(endEstimated){const startDate=new Date(v.start);if(!Number.isFinite(startDate.getTime()))throw Error('日程开始时间无效');const offset=v.start.match(/(Z|[+-]\d{2}:\d{2})$/)?.[0];const shifted=new Date(startDate.getTime()+3600000+(offset&&offset!=='Z'?(offset[0]==='-'?-1:1)*(Number(offset.slice(1,3))*60+Number(offset.slice(4)))*60000:0));v={...v,end:shifted.toISOString().slice(0,19)+(offset||'Z')};}

   const stamp=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
   if(!stamp(v.start)||!stamp(v.end)||Date.parse(v.end)<=Date.parse(v.start))throw Error('日程提案必须包含明确时区偏移的起止时间；日期不明时请只提出待确认问题。');
   try{new Intl.DateTimeFormat('en',{timeZone:v.timeZone}).format();if(!v.timeZone)throw Error();}catch{throw Error('日程提案需要有效的 IANA 时区。');}
   for(const value of [v.start,v.end,...(v.until?[v.until]:[])]){const parts=Object.fromEntries(new Intl.DateTimeFormat('en',{timeZone:v.timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).map(p=>[p.type,p.value]));if(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`!==value.slice(0,16))throw Error('日期无效或时间偏移与所选时区不一致。');}
   const frequency=v.frequency||'none',interval=v.interval??1,weekdays=v.weekdays||[],reminder=v.reminderMinutes??null;
   if(!['none','daily','weekly','monthly'].includes(frequency)||!Number.isInteger(interval)||interval<1||interval>52||!Array.isArray(weekdays)||weekdays.some(x=>!Number.isInteger(x)||x<1||x>7)||reminder!==null&&(!Number.isInteger(reminder)||reminder<0||reminder>10080)||v.count!=null&&(!Number.isInteger(v.count)||v.count<1||v.count>1000)||v.until!=null&&(!stamp(v.until)||Date.parse(v.until)<Date.parse(v.start)))throw Error('日程的重复或提醒规则无效。');
   return {id:'agenda_'+run.userMessageId+'_'+index,title:v.title.trim(),start:Date.parse(v.start),end:Date.parse(v.end),timeZone:v.timeZone,frequency,interval,weekdays:[...new Set(weekdays)],reminderMinutes:reminder,count:v.count??null,until:v.until?Date.parse(v.until):null,location:String(v.location||'').slice(0,2000),details:String(v.details||'').slice(0,10000),documentID:fromMessage?'':note.id,sourceVersion:fromMessage?null:note.updatedAt,sourceMessageId:fromMessage?message.id:null,conversationId:fromMessage?conversation.id:null,endEstimated,quote:v.quote,status:'pending'};
  });
 }
 let savedIds=new Set();
 async function refresh(){if(!root.workstationDesktop?.agendaRelated)return;try{savedIds=new Set((await root.workstationDesktop.agendaRelated()).map(e=>e.id));if(typeof renderConversation==='function')renderConversation();}catch{}}
 root.document?.addEventListener('aibro-agenda-changed',refresh);
 const t=(zh,en)=>root.WorkstationI18n?.getLanguage?.()==='en'?en:zh;
 function card(run){if(!run?.agendaProposals?.length)return null;const card=document.createElement('section');card.className='file-change-card';const title=document.createElement('h3');title.textContent=t('建议日程 · 待确认时间与提醒','Proposed events · Review times and reminders');card.append(title);
  for(const proposal of run.agendaProposals){const row=document.createElement('div');row.className='file-change-row';const text=document.createElement('span');text.textContent=proposal.title+' · '+new Date(proposal.start).toLocaleString(undefined,{timeZone:proposal.timeZone})+' · '+proposal.timeZone+(proposal.frequency==='weekly'?t(' · 每周重复',' · Repeats weekly'):'')+(proposal.endEstimated?t(' · 默认时长 1 小时，待确认',' · Default 1-hour duration; review required'):'');const b=document.createElement('button');b.className='secondary';b.type='button';b.dataset.agendaProposal=proposal.id;b.textContent=savedIds.has(proposal.id)?t('打开已保存日程','Open saved event'):t('审阅日程','Review event');b.disabled=!root.workstationDesktop?.agendaProposal||run.status!=='completed';b.onclick=async()=>{try{const saved=await root.workstationDesktop.agendaRelated();if(saved.some(e=>e.id===proposal.id)){await root.workstationDesktop.agendaOpen(proposal.id);return;}if(proposal.sourceMessageId){const source=state.conversations.find(c=>c.id===proposal.conversationId&&active(c))?.messages?.find(m=>m.id===proposal.sourceMessageId&&m.role==='user'&&!m.deletedAt);if(!source?.text.includes(proposal.quote))throw Error(t('来源消息已变化，请重新分析。','The source message changed. Analyze it again.'));}else{const note=state.notes.find(n=>n.id===proposal.documentID&&active(n));if(!note||note.updatedAt!==proposal.sourceVersion)throw Error(t('来源随记已变化，请重新分析。','The source capture changed. Analyze it again.'));}await saveDocumentDurably();await root.workstationDesktop.agendaProposal(proposal);}catch(e){toast(e.message);}};row.append(text,b);card.append(row);const quote=document.createElement('blockquote');quote.textContent=proposal.quote;quote.dataset.userContent='';card.append(quote);}
  return card;
 }
 return {validate,card,refresh};
});
