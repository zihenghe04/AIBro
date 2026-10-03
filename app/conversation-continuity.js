/* Explicit, conversation-scoped context for supplemental material turns.
   Read-only: no model calls, file IO, cross-conversation search or source edits. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.ConversationContinuity=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root){
 'use strict';
 const list=v=>Array.isArray(v)?v:[],active=v=>!!v&&!v.deleted&&!v.deletedAt&&!v.archived&&!v.archivedAt&&!['deleted','archived'].includes(v.status);
 const privateItem=v=>!!(v?.private||v?.ephemeral||v?.incognito);
 const Analysis=()=>root.AttachmentAnalysis||(typeof require==='function'?require('./attachment-analysis.js'):null);
 const Evidence=()=>root.CitationEvidence||(typeof require==='function'?require('./citation-evidence.js'):null);
 const unique=(values,id)=>{const matches=list(values).filter(value=>value?.id===id);return matches.length===1?matches[0]:null;};
 function access(state,type,id){
  const evidence=Evidence();if(evidence?.access)return evidence.access(state,{type,id});
  // The app loads CitationEvidence before composer rendering. Fail closed when
  // that access contract is unavailable rather than exposing hidden sources.
  return {available:false,kind:'missing',record:null};
 }
 function completedRun(state,run,conversationId){
  if(!run||run.deleted||run.deletedAt||privateItem(run)||run.conversationId!==conversationId||run.status!=='completed'||run.error||run.cancelled)return false;
  if(run.mode!=='ai'&&!(['api','openai-auth'].includes(run.modelConfig?.provider)&&!run.mode&&String(run.modelConfig.model||'').trim()))return false;
  if(/(?:local|fallback|simulat)/i.test(String(run.modelConfig?.provider||'')))return false;
  const receipt=run.executionReceipt;
  return !(receipt&&(receipt.version!==1||receipt.phase!=='committed')||run.approvalReceipt?.savePending||run.approvalSaveError);
 }
 function completedRead(state,source,conversation){
  const evidence=Evidence(),presentation=root.RunOutcomePresentation||(typeof require==='function'?require('./run-outcome-presentation.js'):null);
  return list(state.agentRuns).some(run=>{
   // A direct answer is a usable result. Do not require the user to save a note
   // merely to stop carrying a document they already asked a question about.
   if(unique(state.agentRuns,run.id)!==run||!completedRun(state,run,conversation?.id)||list(run.results).length||list(run.pendingActions).length)return false;
   const message=list(conversation?.messages).find(message=>['agent','assistant'].includes(message.role)&&message.runId===run.id&&active(message)&&!privateItem(message)&&!message.live&&!message.retryRunId);
   if(!message||run.executionReceipt?.messageId&&run.executionReceipt.messageId!==message.id||!presentation?.preservePartial(message,run).trim())return false;
   return list(run.evidenceSources).some(row=>{
    if(row.type!=='import'||row.id!==source.id||row.provided!==true||!row.bodyHash||!['read','read_page','read_file','attachment_text','attachment_original','attachment_image','explicit_reference'].includes(row.origin))return false;
    // Actual provided bytes/text plus a current version and saved answer are
    // evidence; attachmentIds or a prepared delivery manifest alone are not.
    if(!Number.isFinite(source.updatedAt)||!Number.isFinite(row.recordUpdatedAt)||source.updatedAt>row.recordUpdatedAt)return false;
    return evidence?.status({...row,runId:run.id},state).kind==='snapshot';
   });
  });
 }
 function completedAnalysis(state,source,conversationId){
  if(Analysis()?.adoptedAnalysis(state,source,{conversationId}).some(output=>completedRun(state,unique(state.agentRuns,output.runId),conversationId)))return true;
  const stamp=source.analysis,at=stamp?.analyzedAt;
  if(stamp?.status!=='analyzed'||!Number.isFinite(at)||at<0)return false;
  const run=unique(state.agentRuns,stamp.runId);
  if(!completedRun(state,run,conversationId))return false;
  const receipt=run.executionReceipt;
  // markCompleted updates updatedAt together with the analysis stamp. A later
  // source revision is pending again, even when its old note still exists.
  if(!Number.isFinite(source.updatedAt)||source.updatedAt>at)return false;
  const evidence=Evidence(),cache=new Map();
  if(!evidence?.access(state,{type:'import',id:source.id,runId:run.id}).available)return false;
  for(const row of list(run.evidenceSources).filter(row=>row.type==='import'&&row.id===source.id&&row.provided&&row.bodyHash)){
   if(evidence?.status(row,state,cache).kind!=='snapshot')return false;
  }
  const derived=Analysis()?.derive(state,source);
  if(derived?.status!=='analyzed')return false;
  const rows=list(run.results).filter(row=>['created','updated'].includes(row.operation));
  const committed=row=>!receipt||list(receipt.results).some(saved=>saved.type===row.type&&saved.id===row.id&&saved.operation===row.operation);
  return rows.some(row=>{
   if(!committed(row))return false;
   if(row.type==='note'&&list(stamp.noteIds).includes(row.id)&&derived.noteIds.includes(row.id))return access(state,'note',row.id).available;
   if(row.type==='paper'&&list(stamp.paperIds).includes(row.id)&&derived.paperIds.includes(row.id))return access(state,'paper',row.id).available;
   // upsert_paper returns the generated note. The paired paper remains valid
   // when that note is removed, provided the stamp names the actual paper.
   return row.type==='note'&&list(stamp.paperIds).some(id=>derived.paperIds.includes(id)&&access(state,'paper',id).record?.noteId===row.id);
  });
 }
 function collect(state,conversation){
  const messages=list(conversation?.messages).filter(m=>m.role==='user'&&active(m)&&!privateItem(m));
  const sentIds=[...new Set(messages.flatMap(m=>[...list(m.attachmentIds),...list(m.attachments).map(a=>a.id)]))];
  const excluded=new Set(list(conversation?.excludedFileReferenceKeys).flatMap(value=>{try{const pair=JSON.parse(value);return pair[0]==='import'?[pair[1]]:[];}catch{return [];}}));
  for(const m of messages)if(Array.isArray(m.retryAttachmentIds))for(const id of list(m.attachmentIds))if(!m.retryAttachmentIds.includes(id))excluded.add(id);
  const hidden=privateItem(conversation)||privateItem(unique(state.projects,conversation?.projectId));
  if(hidden)return {messages:[],ledger:[],pendingIds:[]};
  const ledger=sentIds.map(id=>{
   const visibility=access(state,'import',id),item=visibility.record;
   const snap=messages.flatMap(m=>list(m.attachments)).find(a=>a.id===id);
   return {id,name:visibility.kind==='private'?'私密来源':item?.name||snap?.name||'附件',projectId:item?.projectId||null,
    status:!visibility.available?'unavailable':excluded.has(id)?'excluded':(completedAnalysis(state,item,conversation?.id)||completedRead(state,item,conversation))?'read':'pending'};
  });
  return {messages,ledger,pendingIds:ledger.filter(i=>i.status==='pending').map(i=>i.id)};
 }
 function build(state,conversation,{goal='',selectedIds=[],explicitSelection=false,retry=false}={}){
  const c=collect(state,conversation);
  // An explicit source restriction wins over automatic carry-over.
  const restrict=/(?:仅|只)(?:处理|分析|读取|看|使用|用|回答).{0,12}(?:本次|这次|新上传|这三|这\d|新附件)|不(?:要|用)(?:再|重新)?.{0,5}(?:读取|读|分析|参考).{0,8}(?:PDF|附件|前面|之前|原件)|(?:only|just).{0,15}(?:new|these|current).{0,12}(?:files|attachments)|(?:do not|don't).{0,12}(?:reread|read|use).{0,15}(?:previous|earlier|files|pdf)/i.test(goal);
  const reset=/(?:换个|新的|另一个)话题|忽略前文|忘掉前面|new topic|ignore (?:the )?(?:previous|earlier)/i.test(goal);
  const continuation=retry||selectedIds.length>0||/补充|补传|附[件加]|上传|继续|接着|重试|前[文面]|之前|还没|遗漏|supplement|attach|upload|continue|retry|previous|earlier/i.test(goal);
  const fullReview=!privateItem(conversation)&&!privateItem(unique(state.projects,conversation?.projectId))&&!restrict&&!reset&&!explicitSelection&&/(?:核对|检查|审查|分析|读取|比较|对比).{0,16}(?:全部|所有|完整|每一|逐份|逐一)|(?:全部|所有|完整|每一|逐份|逐一).{0,16}(?:核对|检查|审查|分析|读取|比较|对比)|(?:review|check|read|analy[sz]e|compare|audit).{0,25}(?:all|every|entire)|(?:all|every|entire).{0,25}(?:review|check|read|analy[sz]e|compare|audit)/i.test(goal);
  const excluded=new Set(c.ledger.filter(i=>i.status==='excluded').map(i=>i.id));
  const project=list(state.projects).find(p=>p.id===conversation?.projectId&&active(p));
  const reviewIds=fullReview?(project?list(state.imports).filter(i=>active(i)&&i.projectId===project.id&&access(state,'import',i.id).available&&!excluded.has(i.id)).map(i=>i.id):c.ledger.filter(i=>!['excluded','unavailable'].includes(i.status)).map(i=>i.id)):[];
  const carriedIds=!explicitSelection&&!restrict&&!reset&&(fullReview||conversation?.carryPendingAttachments!==false&&continuation)?(fullReview?reviewIds:c.pendingIds).filter(id=>!selectedIds.includes(id)):[];
  const ids=[...new Set([...carriedIds,...selectedIds])];
  const original=reset?null:c.messages[0];
  const requirements=[];let budget=18000;
  for(const m of original?[original,...c.messages.slice(1).slice(-16)]:[]){const text=String(m.text||'');if(!text)continue;const part=text.slice(0,Math.min(budget,m===original?10000:2000));if(part){requirements.push({messageId:m.id,text:part,truncated:part.length<text.length});budget-=part.length;}if(budget<=0)break;}
  const reviewText=fullReview?`本轮要求全量核对，已选择范围内 ${ids.length} 份原件。必须逐份报告核对结果和无法读取的材料，不能用检索摘录代替全文核对。` : '';
  const text=reset?'':`[当前会话持续任务]\n${reviewText}\n以下用户需求来自本会话；最新明确修改优先。补充材料不是新任务，不要把“附加了”当作完整目标。此前失败不代表原始需求已完成。\n原始目标与后续要求：${JSON.stringify(requirements)}\n本会话此前附件清单（read=此前已根据当前版本回答或保存关联分析成果；不代表逐页全文核验；pending=尚未成功处理；excluded=用户排除；unavailable=原件不可用）：${JSON.stringify(c.ledger)}\n本轮续接待处理附件：${JSON.stringify(carriedIds)}。仅清单不代表已读取内容，不得编造未提供文件的细节。结合本轮原件和已保存知识继续原任务；如果只完成归档而没有完成用户要求的分析/核对，不应声称任务完成。`;
  return {attachmentIds:ids,carriedIds,text,originMessageId:original?.id||null,ledger:c.ledger,fullReview};
 }
 return {collect,build};
});
