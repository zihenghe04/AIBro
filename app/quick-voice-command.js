/* Explicit global voice commands create one independent conversation. A durable
   dispatch marker prevents blind replay after a lost native reply or restart. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.QuickVoiceCommand=api;})(globalThis,()=>{
 'use strict';
 const active=c=>!!c&&!c.archived&&!c.archivedAt&&!c.deleted&&!c.deletedAt&&!['deleted','archived'].includes(c.status)&&!c.private&&!c.ephemeral&&!c.incognito;
 function create(hooks){
  const pending=new Map();let inFlight=false;
  function valid(input){return !!input&&typeof input==='object'&&typeof input.requestId==='string'&&/^[a-zA-Z0-9_-]{8,160}$/.test(input.requestId)&&typeof input.text==='string'&&!!input.text.trim()&&Object.keys(input).every(k=>['requestId','text','workspace','projectId'].includes(k))&&['日常','课程','科研'].includes(input.workspace||'日常')&&(input.projectId==null||typeof input.projectId==='string'&&input.projectId.length<=512);}
  const result=(status,reason,conversation,extra={})=>({status,reason,...(conversation?{conversationId:conversation.id}:{}),...extra});
  function receipt(state,conversation){
   const marker=conversation.quickVoiceRequest;
   const runs=(state.agentRuns||[]).filter(r=>r.conversationId===conversation.id&&!r.deletedAt);
   const user=(conversation.messages||[]).filter(m=>m.role==='user'&&!m.deletedAt&&m.quickVoiceRequestId===marker.requestId);
   const run=runs.find(r=>user.some(m=>m.id===r.userMessageId));
   if(run)return result('accepted','already_submitted',conversation,{runId:run.id,userMessageId:run.userMessageId});
   if(user.length)return result('accepted','already_submitted',conversation,{userMessageId:user[0].id});
   if(marker.phase==='superseded')return result('deferred','conversation_changed',conversation);
   if(marker.phase==='dispatching'||marker.phase==='accepted')return result('uncertain','dispatch_receipt_missing',conversation);
   if((conversation.messages||[]).length||runs.length)return result('deferred','conversation_changed',conversation);
   return null;
  }
  async function perform(input){
   if(!valid(input))return result('error','invalid_request');
   const scope={workspace:input.workspace||'日常',projectId:input.projectId||null};
   const fingerprint=await hooks.fingerprint(JSON.stringify([input.text,scope.workspace,scope.projectId]));
   let state=hooks.getState();
   const matches=(state.conversations||[]).filter(c=>c.quickVoiceRequest?.requestId===input.requestId);
   const retired=(state.trash||[]).some(b=>(b.data?.conversations||[]).some(c=>c.quickVoiceRequest?.requestId===input.requestId));
   if(matches.length>1||retired)return result('error','request_retired_or_ambiguous');
   let conversation=matches[0];
   const ownsRequest=()=>conversation&&hooks.getState().conversations.includes(conversation)
    &&conversation.quickVoiceRequest?.version===1&&conversation.quickVoiceRequest.requestId===input.requestId&&conversation.quickVoiceRequest.fingerprint===fingerprint;
   if(conversation&&(!active(conversation)||conversation.quickVoiceRequest.fingerprint!==fingerprint))return result('error','request_changed');
   if(conversation){const saved=receipt(state,conversation);if(saved){
    if(saved.status==='accepted'){try{await hooks.save();}catch{return result('uncertain','submitted_save_unconfirmed',conversation,saved.runId?{runId:saved.runId}:{});}}
    return saved;
   }}
   const permitted=hooks.canStart(scope);if(permitted!==true)return result('deferred',typeof permitted==='string'?permitted:'workspace_unavailable',conversation);
   hooks.preserveDraft();
   try{await hooks.save();}catch{return result('deferred','draft_save_failed',conversation);}
   if(hooks.canContinue(scope)!==true)return result('deferred','context_changed',conversation);
   state=hooks.getState();
   if(!conversation){
    conversation=hooks.newConversation(scope,input.text);
    conversation.quickVoiceRequest={version:1,requestId:input.requestId,fingerprint,phase:'prepared'};
    state.conversations.push(conversation);
   }else if(!state.conversations.includes(conversation))return result('deferred','context_changed',conversation);
   const target=hooks.captureDispatch(conversation);
   try{await hooks.save();}catch{return result('deferred','conversation_save_failed',conversation);}
   if(hooks.canContinue(scope)!==true||!active(conversation)||!ownsRequest()||conversation.quickVoiceRequest.phase!=='prepared')return result('deferred','context_changed',conversation);
   // Preserve the prepared text if another surface edited this new draft.
   if(conversation.draft!==input.text)return result('deferred','draft_changed',conversation);
   conversation.quickVoiceRequest.phase='dispatching';
   try{await hooks.save();}catch{if(ownsRequest()&&conversation.quickVoiceRequest.phase==='dispatching')conversation.quickVoiceRequest.phase='prepared';return result('deferred','dispatch_save_failed',conversation);}
   if(hooks.canContinue(scope)!==true||!active(conversation)||!ownsRequest()){
    // No send was started. Keep a durable prepared marker before retrying; if
    // this write fails, the persisted dispatch marker fails closed on restart.
    if(ownsRequest()&&conversation.quickVoiceRequest.phase==='dispatching'){conversation.quickVoiceRequest.phase='prepared';try{await hooks.save();}catch{}}
    return result('deferred','context_changed',conversation);
   }
   // The spoken instruction owns this new chat, not the visible composer.
   // Browsing another chat never opens/reparents this background submission.
   if(hooks.canDispatch(target,conversation,scope,input.text)!==true){
    if(ownsRequest()&&conversation.quickVoiceRequest.phase==='dispatching'){conversation.quickVoiceRequest.phase='prepared';try{await hooks.save();}catch{}}
    return result('deferred','context_changed',conversation);
   }
   return new Promise(resolve=>{
    let done=false;
    const accepted=async ack=>{if(done)return;done=true;
     const live=hooks.getState().conversations.find(c=>c.id===conversation.id&&c.quickVoiceRequest?.requestId===input.requestId&&c.quickVoiceRequest.fingerprint===fingerprint);
     if(!live){resolve(result('uncertain','submitted_owner_changed',conversation,ack));return;}
     Object.assign(live.quickVoiceRequest,{phase:'accepted',runId:ack.runId,userMessageId:ack.userMessageId});
     try{await hooks.save();resolve(result('accepted','submitted',live,ack));}
     catch{resolve(result('uncertain','submitted_save_unconfirmed',live,ack));}
    };
    Promise.resolve().then(()=>hooks.send({goal:input.text,conversationId:conversation.id,background:true,voiceRequestId:input.requestId,canDispatch:()=>hooks.canDispatch(target,conversation,scope,input.text)===true,onAccepted:accepted})).then(async()=>{
     if(done)return;const actual=receipt(hooks.getState(),conversation);
     if(actual?.status==='accepted'){done=true;resolve(actual);return;}
     if(ownsRequest()&&conversation.quickVoiceRequest.phase==='dispatching'){conversation.quickVoiceRequest.phase='prepared';try{await hooks.save();}catch{}}
     done=true;resolve(result('deferred','send_not_started',conversation));
    }).catch(()=>{if(!done){done=true;resolve(result('uncertain','send_result_unavailable',conversation));}});
   });
  }
  return input=>{
   if(!valid(input))return Promise.resolve({...result('error','invalid_request'),requestId:typeof input?.requestId==='string'?input.requestId:''});
   input={...input};const key=input.requestId,signature=JSON.stringify(input),old=pending.get(key);
   if(old)return old.signature===signature?old.promise:Promise.resolve({...result('error','request_changed'),requestId:key});
   if(inFlight)return Promise.resolve({...result('deferred','voice_command_busy'),requestId:key});
   inFlight=true;const promise=perform(input).catch(()=>result('error','request_failed')).then(reply=>({...reply,requestId:key})).finally(()=>{inFlight=false;if(pending.get(key)?.promise===promise)pending.delete(key);});pending.set(key,{signature,promise});return promise;
  };
 }
 let handler=null;return {create,init(hooks){handler=create(hooks);},submit(input){return handler?handler(input):Promise.resolve({status:'deferred',reason:'workspace_not_ready',requestId:input?.requestId||''});}};
});
