/* Model output is a proposal. Only the native editor's Save schedules an event. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.AgendaProposals=api;})(globalThis,root=>{
 'use strict';const active=n=>n&&!n.archived&&!n.archivedAt&&!n.deleted&&!n.deletedAt&&!n.private&&!n.ephemeral&&!n.incognito&&!['archived','deleted'].includes(n.status);
 const Access=()=>typeof module==='object'&&module.exports?require('./agenda-access'):root.AgendaAccess;
 function projectID(proposal,state,run={}){
  const aliases=['projectID','projectId','courseId'].filter(key=>Object.hasOwn(proposal,key));
  const explicit=aliases.map(key=>{const value=proposal[key];if(value===null||value==='')return '';if(typeof value!=='string'||!value.trim()||value.length>200)throw Error('日程提案的所属项目无效。');return value;});
  if(new Set(explicit).size>1)throw Error('日程提案的所属项目字段不一致。');
  const noteID=proposal.sourceMessageId?'':proposal.documentID||proposal.sourceNoteId;
  const note=noteID?(state.notes||[]).filter(n=>n.id===noteID&&active(n)):[];
  const chats=(state.conversations||[]).filter(c=>c.id===(proposal.conversationId||run.conversationId)&&active(c));
  if(noteID&&note.length!==1)throw Error('日程来源随记不可用。');
  const inherited=noteID?(note[0].projectId||''):(run.projectId|| (chats.length===1?chats[0].projectId:'') ||'');
  const id=aliases.length?explicit[0]:inherited;
  if(noteID&&id!==(note[0].projectId||''))throw Error('日程不能改变来源随记的项目归属，请在审阅时解除资料关联后选择其他项目。');
  if(!id)return '';
  const matches=(state.projects||[]).filter(project=>project.id===id),project=matches[0];
  const access=root.CitationEvidence?.createAccessContext?.(state);
  if(matches.length!==1||!active(project)||access&&!access.access({type:'local',projectId:id,candidateId:project.localFolder?.id}).available)throw Error('日程所属项目已不可用，请重新选择后生成提案。');
  return id;
 }
 function validate(values,state,run){
  if(values===undefined)return [];if(!Array.isArray(values)||values.length>12)throw Error('日程提案最多 12 项。');
  if(typeof run.userMessageId!=='string'||!run.userMessageId||run.userMessageId.length>160)throw Error('日程提案缺少原始消息身份。');
  return values.map((v,index)=>{
   if(v?.operation&&v.operation!=='create'){
    const {patch}=Access().validateMutation(v,state,run);
    return {id:'agenda_mutation_'+run.id+'_'+index,operation:v.operation,eventId:v.eventId,expectedVersion:v.expectedVersion,sourceMessageId:run.userMessageId,conversationId:run.conversationId,runId:run.id,quote:v.quote,scope:v.scope,...(v.operation==='update'?{patch}:{}),status:'pending'};
   }
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
   return {id:'agenda_'+run.userMessageId+'_'+index,title:v.title.trim(),start:Date.parse(v.start),end:Date.parse(v.end),timeZone:v.timeZone,frequency,interval,weekdays:[...new Set(weekdays)],reminderMinutes:reminder,count:v.count??null,until:v.until?Date.parse(v.until):null,location:String(v.location||'').slice(0,2000),details:String(v.details||'').slice(0,10000),documentID:fromMessage?'':note.id,projectID:projectID(v,state,run),sourceVersion:fromMessage?null:note.updatedAt,sourceMessageId:fromMessage?message.id:null,conversationId:fromMessage?conversation.id:null,endEstimated,quote:v.quote,status:'pending'};
  });
 }
 let savedIds=new Set(),creationReceipts=new Set();const receipts=new Map();let refreshEpoch=0;
 const receiptKey=(run,p)=>Access().canonical([run.id,p]);
 const committedReceipt=(value,p)=>value?.version===1&&value.status==='committed'&&value.persisted===true&&value.requestId===p.id&&value.eventId===p.eventId&&/^[a-f0-9]{64}$/.test(value.receiptFingerprint);
 function hasPending(run){return (run?.agendaProposals||[]).some(p=>p.operation&&p.operation!=='create'?receipts.get(receiptKey(run,p))?.status!=='committed':!creationReceipts.has(p.id));}
 function settledSummary(run){if(!run?.agendaProposals?.length||hasPending(run))return null;return run.agendaProposals.map(p=>{const event=run.agendaReads?.find(r=>r.event.eventId===p.eventId)?.event;return (p.operation==='delete'?t('已删除：','Deleted: '):p.operation==='update'?t('已更新：','Updated: '):t('已保存：','Saved: '))+(p.patch?.title||event?.title||p.title||'');}).join('；');}
 async function refresh(){
  const epoch=++refreshEpoch;if(!root.workstationDesktop?.agendaRelated)return;
  try{const ids=await root.workstationDesktop.agendaRelated({includeCancelled:true});if(epoch!==refreshEpoch)return;creationReceipts=new Set(ids.map(e=>e.id));savedIds=new Set(ids.filter(e=>!e.deleted).map(e=>e.id));
   const current=typeof state!=='undefined'?state:null;
   for(const run of current?.agentRuns||[])for(const p of run.agendaProposals||[])if(p.operation&&p.operation!=='create'){
    const context=Access().contextFor(run);if(Access().authorize(context,p).status!=='authorized')continue;
    const receipt=await root.workstationDesktop.agendaMutationStatus(p.id,context,p);if(epoch!==refreshEpoch)return;
    if(Access().authorize(context,p).status==='authorized'&&committedReceipt(receipt,p))receipts.set(receiptKey(run,p),receipt);
   }
   if(typeof renderConversation==='function')renderConversation();root.NativeSnapshotChannel?.retry?.();
  }catch{/* Unknown is pending, never an inferred successful write. */}
 }
 root.document?.addEventListener('aibro-agenda-changed',refresh);
 const t=(zh,en)=>root.WorkstationI18n?.getLanguage?.()==='en'?en:zh;
 const creationLabel=p=>creationReceipts.has(p.id)&&!savedIds.has(p.id)?t('已保存（现已取消）','Saved (now cancelled)'):savedIds.has(p.id)?t('打开已保存日程','Open saved event'):t('审阅日程','Review event');
 function mutationRow(run,p){
  const row=document.createElement('article');row.className='agenda-proposal-row';
  const info=document.createElement('div');info.className='agenda-proposal-info';const title=document.createElement('strong');title.dataset.userContent='';
  const event=run.agendaReads?.find(r=>r.event.eventId===p.eventId)?.event;
  title.textContent=(p.operation==='delete'?t('删除日程：','Delete event: '):t('修改日程：','Update event: '))+(event?.title||p.eventId);
  const details=document.createElement('p');details.className='agenda-proposal-details';details.textContent=p.scope==='series'?t('整个重复系列 · 审阅后保存','Entire series · Review before saving'):t('审阅后保存','Review before saving');
  const quote=document.createElement('blockquote');quote.dataset.userContent='';quote.textContent=p.quote;
  const button=document.createElement('button');button.type='button';button.className='secondary agenda-proposal-review';button.dataset.agendaProposal=p.id;
  const committed=receipts.get(receiptKey(run,p))?.status==='committed';button.textContent=committed?t('已保存','Saved'):t('审阅日程','Review event');button.disabled=committed||!root.workstationDesktop?.agendaMutation||run.status!=='completed';
  button.onclick=async()=>{button.disabled=true;try{
   let context=Access().contextFor(run);if(Access().authorize(context,p).status!=='authorized')throw Error(t('来源或读取范围已变化，请重新查询日程。','The source or scope changed. Query the event again.'));
   if(await saveDocumentDurably()!==true)throw Error(t('提案尚未确认保存，请重试。','The proposal has not been confirmed saved. Retry.'));
   context=Access().contextFor(run);if(Access().authorize(context,p).status!=='authorized')throw Error(t('日程提案已失效，请重新查询。','This proposal is no longer current. Query it again.'));
   const reply=await root.workstationDesktop.agendaMutation(p,context);
   if(committedReceipt(reply,p)&&Access().authorize(context,p).status==='authorized')receipts.set(receiptKey(run,p),reply);
   else if(reply?.status!=='pending_review')throw Error(t('日程尚未确认保存，请核对后重试。','The calendar change is not confirmed saved. Check it and retry.'));
   await refresh();
  }catch(e){toast(e.message);}finally{button.disabled=receipts.get(receiptKey(run,p))?.status==='committed';}};
  info.append(title,details,quote);row.append(info,button);return row;
 }
 function card(run){if(!run?.agendaProposals?.length)return null;const card=document.createElement('section');card.className='file-change-card agenda-proposal-card';const heading=document.createElement('div');heading.className='agenda-proposal-heading';const title=document.createElement('h3');title.textContent=t('建议日程','Proposed events');const subtitle=document.createElement('span');subtitle.textContent=t('待确认时间与提醒','Review times and reminders');heading.append(title,subtitle);card.append(heading);
  for(const proposal of run.agendaProposals){if(proposal.operation&&proposal.operation!=='create'){card.append(mutationRow(run,proposal));continue;}const row=document.createElement('article');row.className='agenda-proposal-row';const text=document.createElement('div');text.className='agenda-proposal-info';const name=document.createElement('strong');name.className='agenda-proposal-name';name.dataset.userContent='';name.textContent=proposal.title;
   const when=document.createElement('p');when.className='agenda-proposal-time';when.textContent=new Date(proposal.start).toLocaleString(t('zh-CN','en-US'),{timeZone:proposal.timeZone,year:'numeric',month:'short',day:'numeric',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})+' · '+proposal.timeZone;
   text.append(name,when);const owner=document.createElement('p');owner.className='agenda-proposal-project';owner.dataset.userContent='';try{const id=projectID(proposal,state,run);owner.textContent=t('提案归属：','Proposed project: ')+(id?(state.projects||[]).find(p=>p.id===id)?.name||id:t('独立日程','Standalone event'));}catch{owner.textContent=t('所属项目不可用，请重新生成提案','Project unavailable; generate a new proposal');}text.append(owner);const details=document.createElement('p');details.className='agenda-proposal-details';details.textContent=[proposal.frequency==='weekly'?t('每周重复','Repeats weekly'):'',proposal.endEstimated?t('默认时长 1 小时，待确认','Default 1-hour duration; review required'):''].filter(Boolean).join(' · ');if(details.textContent)text.append(details);const b=document.createElement('button');b.className='secondary agenda-proposal-review';b.type='button';b.dataset.agendaProposal=proposal.id;b.textContent=creationLabel(proposal);b.disabled=!root.workstationDesktop?.agendaProposal||run.status!=='completed'||creationReceipts.has(proposal.id)&&!savedIds.has(proposal.id);b.onclick=async()=>{try{const saved=await root.workstationDesktop.agendaRelated();if(saved.some(e=>e.id===proposal.id)){await root.workstationDesktop.agendaOpen(proposal.id);return;}if(proposal.sourceMessageId){const source=state.conversations.find(c=>c.id===proposal.conversationId&&active(c))?.messages?.find(m=>m.id===proposal.sourceMessageId&&m.role==='user'&&!m.deletedAt);if(!source?.text.includes(proposal.quote))throw Error(t('来源消息已变化，请重新分析。','The source message changed. Analyze it again.'));}else{const note=state.notes.find(n=>n.id===proposal.documentID&&active(n));if(!note||note.updatedAt!==proposal.sourceVersion)throw Error(t('来源随记已变化，请重新分析。','The source capture changed. Analyze it again.'));}const id=projectID(proposal,state,run);if(await saveDocumentDurably()!==true)throw Error(t('提案尚未确认保存，请重试。','The proposal has not been confirmed saved. Retry.'));if(projectID(proposal,state,run)!==id)throw Error(t('日程所属项目已变化，请重新审阅。','The proposed project changed. Review it again.'));await root.workstationDesktop.agendaProposal({...proposal,projectID:id});}catch(e){toast(e.message);}};row.append(text,b);const quote=document.createElement('blockquote');quote.className='agenda-proposal-quote';quote.textContent=proposal.quote;quote.dataset.userContent='';row.append(quote);card.append(row);}
  return card;
 }
 return {validate,card,refresh,projectID,hasPending,settledSummary};
});
