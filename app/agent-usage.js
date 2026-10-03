/* Host-owned provider usage snapshots. Never consume model/tool-result claims. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.AgentUsage=api;})(globalThis,function(){
 'use strict';
 const count=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
 const id=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/.test(value)?value:null;
 const terminal=new Set(['completed','failed','cancelled','interrupted']);
 const recorders=new WeakMap();
 function snapshot(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const usage={input:count(value.input),output:count(value.output),total:count(value.total)};
  return Object.values(usage).some(value=>value!==null)?usage:null;
 }
 const sum=values=>{let total=0;for(const value of values){total+=value;if(!Number.isSafeInteger(total))return null;}return total;};
 function project(ledger){
  if(ledger?.version!==1||!Array.isArray(ledger.attempts))return null;
  const seen=new Set(),attempts=[];let invalid=false;
  for(const item of ledger.attempts){
   if(!id(item?.id)||seen.has(item.id)||!['running',...terminal].includes(item.status)){invalid=true;continue;}
   seen.add(item.id);attempts.push({...item,usage:snapshot(item.usage)});
  }
  const reported=attempts.filter(item=>item.usage?.total!==null&&item.usage?.total!==undefined);
  const total=reported.length?sum(reported.map(item=>item.usage.total)):null;
  const part=key=>attempts.length&&attempts.every(item=>item.usage?.[key]!==null&&item.usage?.[key]!==undefined)?sum(attempts.map(item=>item.usage[key])):null;
  const routes=new Set(attempts.map(item=>JSON.stringify([item.provider,item.model])));
  const complete=!invalid&&attempts.length>0&&reported.length===attempts.length&&attempts.every(item=>item.status==='completed')&&total!==null;
  return {input:part('input'),output:part('output'),total,attempts:ledger.attempts.length,reportedAttempts:reported.length,complete,
   pendingAttempts:attempts.filter(item=>item.status==='running').length,
   interruptedAttempts:attempts.filter(item=>['failed','cancelled','interrupted'].includes(item.status)).length,
   mixedModels:routes.size>1,routeKnown:attempts.length>0&&attempts.every(item=>id(item.provider)&&id(item.model)),invalid};
 }
 function create(run,message){
  if(!run||typeof run!=='object')throw Error('Usage requires a host run');
  const cached=recorders.get(run);if(cached&&cached.ledger===run.usageLedger)return cached.api;
  if(run.usageLedger===undefined){
   if(run.usage)throw Error('Historical usage cannot be migrated into invented attempts');
   run.usageLedger={version:1,attempts:[]};
  }
  if(run.usageLedger?.version!==1||!Array.isArray(run.usageLedger.attempts))throw Error('Unsupported usage ledger');
  const ledger=run.usageLedger,active=new Map();let closed=false;
  const sync=()=>{const usage=project(ledger);run.usage=usage;if(message)message.usage={...usage};return usage;};
  const context=scope=>{
   const parentId=scope?.parentId===undefined?null:id(scope.parentId);
   if(scope?.parentId!==undefined&&(!parentId||!run.toolCalls?.some(call=>call.id===parentId&&call.type==='delegate')))return null;
   const purpose=scope?.purpose||'model';if(!['model','history-compaction'].includes(purpose))return null;
   return {parentId,purpose};
  };
  const matching=(item,scope)=>{const current=context(scope);return current&&item.parentId===current.parentId&&item.purpose===current.purpose;};
  const api={
   attempt(event,scope={}){
    if(closed||!id(event?.id)||!['running',...terminal].includes(event.status))return false;
    if(event.status==='running'){
     const current=context(scope);if(!current||!id(scope.provider)||!id(scope.model)||ledger.attempts.some(item=>item.id===event.id))return false;
     const item={id:event.id,status:'running',provider:scope.provider,model:scope.model,...current,usage:null};
     ledger.attempts.push(item);active.set(item.id,item);sync();return true;
    }
    const item=active.get(event.id);if(!item||!matching(item,scope))return false;
    item.status=event.status;active.delete(item.id);sync();return true;
   },
   report(value,meta,scope={}){
    const item=active.get(meta?.attemptId),usage=snapshot(value);
    if(closed||!item||!usage||!matching(item,scope))return false;
    // These are snapshots for one provider request, not token deltas. A later
    // partial snapshot stays partial rather than borrowing stale components.
    item.usage=usage;item.totalSource=meta.totalSource==='components'?'components':usage.total!==null?'reported':null;
    sync();return true;
   },
   finish(status){
    if(closed)return false;
    for(const item of active.values())item.status=status==='cancelled'?'cancelled':status==='failed'?'failed':'interrupted';
    active.clear();closed=true;sync();return true;
   }
  };
  recorders.set(run,{ledger,api});return api;
 }
 function view(message,run,{language='zh'}={}){
  const en=language==='en',ledger=run?.usageLedger;
  const projected=project(ledger),legacy=projected?null:snapshot(message?.usage||run?.usage);
  const usage=projected||legacy;if(!usage)return null;
  const parts=en?`Input ${usage.input??'not reported'} · Output ${usage.output??'not reported'}`:`输入 ${usage.input??'未提供'} · 输出 ${usage.output??'未提供'}`;
  if(!projected)return {usage,label:usage.total===null?(en?'Usage not reported':'用量未提供'):'',hint:parts+(en?' · Historical records saved only the last reported request; no per-request total is available.':' · 历史记录仅保存最后一次请求的用量，未按请求汇总。'),canEstimate:false};
  if(!usage.attempts)return null;
  const coverage=en?`${usage.reportedAttempts}/${usage.attempts} requests reported`:`${usage.reportedAttempts}/${usage.attempts} 次请求有用量`;
  const label=usage.complete?'':usage.total===null?(en?'Usage not reported':'用量未提供'):(en?'Reported':'已报告');
  const hint=parts+' · '+coverage+(usage.complete?'':en?' · Missing or interrupted requests may add unreported usage.':' · 缺失或中断请求可能还有未报告用量。')+(usage.mixedModels?(en?' · Multiple model routes; no combined price estimate.':' · 包含不同模型连接，不合并估价。'):'');
  // UsageCost's legacy fallback averages rates when a component is missing or
  // zero. Only its fully split, positive-component path can price this total.
  return {usage,label,hint,canEstimate:usage.complete&&!usage.mixedModels&&usage.routeKnown&&usage.input>0&&usage.output>0};
 }
 return {create,project,view};
});
