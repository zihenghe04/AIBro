/* Run event log (P2): run/*, step/*, tool/* and approval/* events written as
   JSONL next to the existing snapshot (dual write; the snapshot stays the
   source of truth). One stream per run ("run:<runId>"), seq increasing within
   the stream. Events that must survive a crash (dispatch, approval decision,
   run end) are sent at once; the rest are batched for 200 ms.
   Nothing secret goes in: credential-like keys and header objects are dropped
   and token-like strings are masked before an event leaves this module.
   fold(events) rebuilds a run's tool ledger from the log; a call dispatched
   without a result folds to outcome "unknown" (never "retry"). No DOM. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.AIBroEvents=api;})(globalThis,root=>{
  'use strict';
  const FSYNC=new Set(['tool/dispatched','approval/decided','run/finished','run/interrupted']);
  const TYPE=/^(run|step|tool|approval|model|artifact|reminder|data|plugin|tools)\/[a-z][a-z-]{0,31}$/;
  const SECRET_KEY=/(api[-_]?key|apikey|secret|token|password|passwd|authorization|cookie|credential|headers?)$/i;
  const SECRET_TEXT=/(Bearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{8,}|\b(?:api[-_]?key|token|secret)\s*[=:]\s*[A-Za-z0-9._~+/-]{8,})/gi;
  const TEXT_MAX=4000,DEPTH_MAX=8,ITEMS_MAX=200;
  function redact(value,depth=0){
    if(depth>DEPTH_MAX)return '[depth]';
    if(typeof value==='string'){const text=value.replace(SECRET_TEXT,'[redacted]');return text.length>TEXT_MAX?text.slice(0,TEXT_MAX)+'…[truncated]':text;}
    if(value==null||typeof value==='number'||typeof value==='boolean')return value;
    if(Array.isArray(value))return value.slice(0,ITEMS_MAX).map(item=>redact(item,depth+1));
    if(typeof value==='object'){const out={};for(const [key,item] of Object.entries(value).slice(0,ITEMS_MAX)){if(typeof item==='function'||item===undefined)continue;out[key]=SECRET_KEY.test(key)?'[redacted]':redact(item,depth+1);}return out;}
    return undefined;
  }
  let counter=0;
  const eventId=now=>'evt_'+now.toString(36)+'_'+(++counter).toString(36)+'_'+Math.random().toString(36).slice(2,8);
  // sink(batch) resolves {ok:true} or rejects; a {code:'SEQ',last:{stream:n}}
  // rejection renumbers that stream after the server's last seq and retries once.
  function create({sink,now=()=>Date.now(),source={kind:'kernel',id:'main'},delay=200,onError=()=>{}}={}){
    if(typeof sink!=='function')throw TypeError('event log needs a sink');
    const seqs=new Map();let queue=[],timer=null,chain=Promise.resolve(true);
    const nextSeq=stream=>{const seq=(seqs.get(stream)||0)+1;seqs.set(stream,seq);return seq;};
    async function send(batch){
      try{await sink(batch);return true;}
      catch(error){
        if(error?.code!=='SEQ'||!error.last)throw error;
        for(const [stream,last] of Object.entries(error.last)){let seq=Number(last)||0;for(const event of batch)if(event.stream===stream)event.seq=++seq;seqs.set(stream,Math.max(seqs.get(stream)||0,seq));}
        await sink(batch);return true;
      }
    }
    function flush(){
      clearTimeout(timer);timer=null;
      if(!queue.length)return chain;
      const batch=queue;queue=[];
      // Batches go out in order; a failed batch is reported, not retried forever.
      chain=chain.then(()=>send(batch)).catch(error=>{onError(error);return false;});
      return chain;
    }
    function emit(type,{runId=null,parentId=null,callId=null,data={},model=false,durability='durable'}={}){
      if(!TYPE.test(type))throw TypeError('Unknown event type '+type);
      const ts=now(),stream=runId?'run:'+runId:'app';
      const event={v:1,id:eventId(ts),stream,seq:durability==='durable'?nextSeq(stream):0,ts,type,...(runId?{runId}:{}),...(parentId?{parentId}:{}),...(callId?{callId}:{}),source,durability,model,data:redact(data)};
      if(durability!=='durable')return Promise.resolve(true);
      queue.push(event);
      if(FSYNC.has(type))return flush();
      if(!timer)timer=setTimeout(flush,delay);
      return Promise.resolve(true);
    }
    return {emit,flush,redact};
  }
  // Same-origin POST to the local server.
  function httpSink(url='/__events/append',fetchImpl=root.fetch?.bind(root)){
    return async batch=>{
      const response=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({events:batch})});
      if(response.ok)return response.json();
      const body=await response.json().catch(()=>({}));
      throw Object.assign(Error(body.error||'event log HTTP '+response.status),{code:body.error==='SEQ'?'SEQ':'HTTP_'+response.status,last:body.last});
    };
  }
  // The tool ledger a log describes: callId -> {type,status,outcome,...}.
  // Unless the run is known to be still live, a call left pending was cut off
  // (crash, kill): dispatched with no result is "unknown" unless it is
  // read-only, in which case a missing receipt only means the read failed.
  function fold(events,{readOnly=()=>false,live=false}={}){
    const runs=new Map();
    const runOf=id=>{if(!runs.has(id))runs.set(id,{id,status:null,tools:new Map(),steps:[]});return runs.get(id);};
    for(const event of [...events].sort((a,b)=>a.stream<b.stream?-1:a.stream>b.stream?1:a.seq-b.seq)){
      if(!event.runId)continue;const run=runOf(event.runId),data=event.data||{};
      if(event.type==='run/started')run.status='running';
      else if(event.type==='run/finished'||event.type==='run/interrupted')run.status=data.status||event.type.slice(4);
      else if(event.type==='step/added')run.steps.push({text:data.text,status:data.status});
      else if(event.type.startsWith('tool/')&&event.callId){
        const call=run.tools.get(event.callId)||{id:event.callId,parentId:event.parentId||null,type:data.type,status:'queued'};
        if(event.type==='tool/dispatched'){call.status='running';call.dispatched=true;}
        if(event.type==='tool/result'){call.status=data.status;call.received=true;for(const key of ['error','errorCode'])if(data[key]!==undefined)call[key]=data[key];}
        if(event.type==='tool/outcome'){call.status=data.status;if(data.outcome)call.outcome=data.outcome;if(data.error!==undefined)call.error=data.error;}
        run.tools.set(event.callId,call);
      }
    }
    if(!live)for(const run of runs.values())for(const call of run.tools.values()){
      if(!['queued','running'].includes(call.status))continue;
      call.status='interrupted';
      if(!call.dispatched)call.outcome='not-started';else if(!readOnly(call))call.outcome='unknown';
    }
    return runs;
  }
  const api={create,httpSink,fold,redact,FSYNC};
  // The page's shared log, posting to this app's local server.
  if(typeof module!=='object'&&root.fetch&&root.location?.protocol?.startsWith('http'))api.default=create({sink:httpSink(),onError:error=>{try{console.warn('event log:',error.message);}catch{}}});
  return api;
});
