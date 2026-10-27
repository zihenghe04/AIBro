/* Codex CLI as the kernel's model (P9b), client side: request() for
   AIBroRunLoop.toolLoop. The loop keeps its transcript, text tool protocol,
   tools, approvals and compaction; each step posts the messages to the
   Codex provider (app/codex_kernel.py: /__kernel/host/codex/* in the app, or
   the bench server), which runs them in the run's Codex thread and answers
   with {content, usage, newThread, sent, ms}. Only the text protocol works
   here: Codex never sees our tools as its own tools.
   - cancel: on abort the provider is told to interrupt the running turn; the
     loop then records the call as cancelled;
   - errors keep the provider's code; usage limits carry pause:true so the
     loop ends the run as "paused" instead of failing or retrying.
   Host: create({fetch, url(action) → endpoint, headers, runId, mode, model, effort}). */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.AIBroCodexKernel=api;})(globalThis,()=>{
  'use strict';
  const CANCEL_WAIT_MS=3000;
  const fail=(message,extra)=>Object.assign(Error(message),extra);

  // The loop's request body (chat messages or responses input) → plain text messages.
  function messagesOf(body){
    const list=Array.isArray(body?.messages)?body.messages:Array.isArray(body?.input)?body.input:[];
    return list.map(m=>({role:m.role==='developer'?'system':m.role,content:typeof m.content==='string'?m.content:(Array.isArray(m.content)?m.content.map(p=>p?.text||'').join(''):String(m.content??''))}));
  }

  function create({fetch:fetcher=globalThis.fetch,url,headers={},runId,mode='shared',model=null,effort=null}={}){
    if(typeof fetcher!=='function'||typeof url!=='function'||!runId)throw TypeError('codex kernel client needs fetch, url and runId');
    const post=(action,payload,options={})=>fetcher(url(action),{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({runId,...payload}),...options});
    const quiet=(action)=>post(action,{}).then(r=>r.json?.()).catch(()=>null);
    async function request(body,{signal}={}){
      if(signal?.aborted)throw fail('运行已取消',{code:'CANCELLED'});
      const messages=messagesOf(body);
      let onAbort=null;
      const aborted=new Promise((_,reject)=>{
        if(!signal)return;
        onAbort=()=>{quiet('cancel');setTimeout(()=>reject(fail('运行已取消',{code:'CANCELLED'})),CANCEL_WAIT_MS);};
        signal.addEventListener('abort',onAbort,{once:true});
      });
      aborted.catch(()=>{});
      try{
        const response=await Promise.race([post('step',{mode,model:model||null,effort:effort||null,messages}),aborted]);
        const value=await Promise.race([response.json().catch(()=>({})),aborted]);
        if(!response.ok){
          const error=value?.error||{};
          throw fail(error.message||('Codex 模型请求失败（HTTP '+response.status+'）'),{code:error.code||'CODEX_HTTP_'+response.status,status:response.status,pause:error.pause===true,detail:error.detail||null});
        }
        if(typeof value.content!=='string')throw fail('Codex 回复格式无效',{code:'CODEX_REPLY'});
        return {content:value.content,reasoning:'',raw:null,finish:value.finish||'stop',usage:value.usage||null,completed:true,
          codex:{newThread:value.newThread===true,sent:value.sent??null,ms:value.ms??null,thread:value.thread??null,version:value.version||null}};
      }finally{if(onAbort)signal.removeEventListener?.('abort',onAbort);}
    }
    return {request,close:()=>quiet('close'),cancel:()=>quiet('cancel'),messagesOf};
  }

  return Object.freeze({create,messagesOf,CANCEL_WAIT_MS});
});
