/* Explicit, conversation-scoped context for supplemental material turns.
   Read-only: no model calls, file IO, cross-conversation search or source edits. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ConversationContinuity=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const list=v=>Array.isArray(v)?v:[],active=v=>!!v&&!v.deletedAt&&!v.archived&&!v.archivedAt;
 function collect(state,conversation){
  const messages=list(conversation?.messages).filter(m=>m.role==='user'&&!m.deletedAt);
  const sentIds=[...new Set(messages.flatMap(m=>[...list(m.attachmentIds),...list(m.attachments).map(a=>a.id)]))];
  const excluded=new Set(list(conversation?.excludedFileReferenceKeys).flatMap(value=>{try{const pair=JSON.parse(value);return pair[0]==='import'?[pair[1]]:[];}catch{return [];}}));
  for(const m of messages)if(Array.isArray(m.retryAttachmentIds))for(const id of list(m.attachmentIds))if(!m.retryAttachmentIds.includes(id))excluded.add(id);
  const runs=list(state.agentRuns).filter(r=>r.conversationId===conversation?.id&&!r.deletedAt);
  const read=new Set(runs.filter(r=>r.status==='completed').flatMap(r=>list(r.attachmentIds)));
  const ledger=sentIds.map(id=>{const item=list(state.imports).find(i=>i.id===id&&active(i));const snap=messages.flatMap(m=>list(m.attachments)).find(a=>a.id===id);return {id,name:item?.name||snap?.name||'附件',projectId:item?.projectId||null,status:!item?'unavailable':excluded.has(id)?'excluded':read.has(id)?'read':'pending'};});
  return {messages,ledger,pendingIds:ledger.filter(i=>i.status==='pending').map(i=>i.id)};
 }
 function build(state,conversation,{goal='',selectedIds=[],explicitSelection=false,retry=false}={}){
  const c=collect(state,conversation);
  // An explicit source restriction wins over automatic carry-over.
  const restrict=/(?:仅|只)(?:处理|分析|读取|看|使用|用|回答).{0,12}(?:本次|这次|新上传|这三|这\d|新附件)|不(?:要|用)(?:再|重新)?.{0,5}(?:读取|读|分析|参考).{0,8}(?:PDF|附件|前面|之前|原件)|(?:only|just).{0,15}(?:new|these|current).{0,12}(?:files|attachments)|(?:do not|don't).{0,12}(?:reread|read|use).{0,15}(?:previous|earlier|files|pdf)/i.test(goal);
  const reset=/(?:换个|新的|另一个)话题|忽略前文|忘掉前面|new topic|ignore (?:the )?(?:previous|earlier)/i.test(goal);
  const continuation=retry||selectedIds.length>0||/补充|补传|附[件加]|上传|继续|接着|重试|前[文面]|之前|还没|遗漏|supplement|attach|upload|continue|retry|previous|earlier/i.test(goal);
  const fullReview=!restrict&&!reset&&!explicitSelection&&/(?:核对|检查|审查|分析|读取|比较|对比).{0,16}(?:全部|所有|完整|每一|逐份|逐一)|(?:全部|所有|完整|每一|逐份|逐一).{0,16}(?:核对|检查|审查|分析|读取|比较|对比)|(?:review|check|read|analy[sz]e|compare|audit).{0,25}(?:all|every|entire)|(?:all|every|entire).{0,25}(?:review|check|read|analy[sz]e|compare|audit)/i.test(goal);
  const excluded=new Set(c.ledger.filter(i=>i.status==='excluded').map(i=>i.id));
  const project=list(state.projects).find(p=>p.id===conversation?.projectId&&active(p));
  const reviewIds=fullReview?(project?list(state.imports).filter(i=>active(i)&&i.projectId===project.id&&!excluded.has(i.id)).map(i=>i.id):c.ledger.filter(i=>!['excluded','unavailable'].includes(i.status)).map(i=>i.id)):[];
  const carriedIds=!explicitSelection&&!restrict&&!reset&&(fullReview||conversation?.carryPendingAttachments!==false&&continuation)?(fullReview?reviewIds:c.pendingIds).filter(id=>!selectedIds.includes(id)):[];
  const ids=[...new Set([...carriedIds,...selectedIds])];
  const original=reset?null:c.messages[0];
  const requirements=[];let budget=18000;
  for(const m of original?[original,...c.messages.slice(1).slice(-16)]:[]){const text=String(m.text||'');if(!text)continue;const part=text.slice(0,Math.min(budget,m===original?10000:2000));if(part){requirements.push({messageId:m.id,text:part,truncated:part.length<text.length});budget-=part.length;}if(budget<=0)break;}
  const reviewText=fullReview?`本轮要求全量核对，已选择范围内 ${ids.length} 份原件。必须逐份报告核对结果和无法读取的材料，不能用检索摘录代替全文核对。` : '';
  const text=reset?'':`[当前会话持续任务]\n${reviewText}\n以下用户需求来自本会话；最新明确修改优先。补充材料不是新任务，不要把“附加了”当作完整目标。此前失败不代表原始需求已完成。\n原始目标与后续要求：${JSON.stringify(requirements)}\n本会话此前附件清单（read=此前成功读取；pending=尚未成功处理；excluded=用户排除；unavailable=原件不可用）：${JSON.stringify(c.ledger)}\n本轮续接待处理附件：${JSON.stringify(carriedIds)}。仅清单不代表已读取内容，不得编造未提供文件的细节。结合本轮原件和已保存知识继续原任务；如果只完成归档而没有完成用户要求的分析/核对，不应声称任务完成。`;
  return {attachmentIds:ids,carriedIds,text,originMessageId:original?.id||null,ledger:c.ledger,fullReview};
 }
 return {collect,build};
});
