/* Read-tool registry: one table from a model read request type to the module
   that serves it. Dispatch only. Scope, run identity, cancellation and saves
   come from the host run through ctx; nothing here grants authority. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.ReadTools=api;})(globalThis,()=>{
  'use strict';
  const entries=[];
  // match: a type, a list of types, or a prefix ending in '*'.
  function matcher(match){
    if(typeof match==='string'&&match.endsWith('*')){const prefix=match.slice(0,-1);return type=>type.startsWith(prefix);}
    const types=new Set([].concat(match));return type=>types.has(type);
  }
  // Entries are tried in registration order. An unavailable entry is skipped;
  // an optional entry that returns null hands the request to the next one.
  function register(match,run,{available=()=>true,optional=false}={}){
    if(typeof run!=='function')throw TypeError('Read tool handler must be a function');
    entries.push({match,matches:matcher(match),run,available,optional});
  }
  const need=(ctx,name)=>{const value=ctx.lookup(name);if(!value)throw Error('读取工具暂不可用：'+name);return value;};
  function evidenceLog(request,ctx){
    const state=ctx.getState(),run=ctx.run;
    const target=request.runId?state.agentRuns.find(r=>r.id===request.runId&&r.conversationId===run.conversationId&&!r.deletedAt):run;
    if(!target)throw Error('读取记录不在当前对话');
    const ledger=target.contextCheckpoint?.ledger||[],offset=request.offset??0;
    if(!Number.isSafeInteger(offset)||offset<0)throw Error('Invalid evidence cursor');
    return {type:'evidence_log',runId:target.id,workingSummary:String(target.contextCheckpoint?.workingSummary||'').slice(0,4000),total:ledger.length,offset,entries:ledger.slice(offset,offset+20),nextOffset:offset+20<ledger.length?offset+20:null};
  }
  const has=name=>ctx=>!!ctx.lookup(name);
  register(['agenda_list','agenda_read'],(request,ctx)=>need(ctx,'AgendaAccess').execute(request,{run:ctx.run,scope:ctx.scope,getState:ctx.getState,bridge:ctx.lookup('workstationDesktop'),validate:ctx.validate}));
  register('evidence_log',evidenceLog);
  register('library_overview',(request,ctx)=>ctx.lookup('AgentContext').overview(ctx.getState(),ctx.scope,request),{available:has('AgentContext')});
  register('capabilities',(request,ctx)=>ctx.agentContext().capability(request.name),{available:ctx=>!!ctx.agentContext()});
  register(['history_search','history_read'],(request,ctx)=>ctx.lookup('AgentContext').readHistory(ctx.conversation,request),{available:has('AgentContext')});
  register('project_list',(request,ctx)=>need(ctx,'ProjectAccess').catalog(ctx.getState(),request,ctx.run));
  register('task_list',(request,ctx)=>need(ctx,'TaskContext').readCatalog(ctx.getState(),ctx.conversation,request,ctx.run));
  register('read_file',(request,ctx)=>ctx.fileContext.read(request));
  register('terminal',(request,ctx,{entry})=>need(ctx,'TerminalTools').execute(request,ctx.getState(),ctx.run,{signal:ctx.signal,save:ctx.save,refresh:ctx.refresh,toolCallId:entry?.id}));
  register('browser_*',(request,ctx,{approval})=>ctx.lookup('BrowserTools').execute(request,ctx.getState(),ctx.run,{signal:ctx.signal,save:ctx.save,refresh:ctx.refresh,approval}),{available:has('BrowserTools')});
  // Hybrid retrieval answers only when semantic search is enabled; otherwise
  // the ordinary keyword reader below serves the same request.
  register('search',(request,ctx)=>ctx.lookup('VectorKnowledge').searchRequest(ctx.getState(),ctx.scope,request,ctx.signal),{available:has('VectorKnowledge'),optional:true});
  function create(ctx){
    for(const key of ['run','getState','validate','lookup','agentContext','fallback'])if(!ctx?.[key])throw TypeError('Read tool host is missing '+key);
    async function execute(request,{entry,approval=null}={}){
      ctx.validate();
      for(const item of entries){
        if(!item.matches(request.type)||!item.available(ctx))continue;
        const result=await item.run(request,ctx,{entry,approval});
        if(item.optional&&result==null)continue;
        return result;
      }
      return ctx.fallback(request);
    }
    return {execute};
  }
  return {register,create};
});
