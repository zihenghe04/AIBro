/* One durable ledger for read tools, provider tools and controlled commands. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.ToolScheduler=api;})(globalThis,root=>{
  'use strict';
  const reads=new Set(['task_list','list','search','neighbors','read','read_page','read_file','wiki_list','memory_read','delegate','capabilities','history_search','history_read','library_overview','evidence_log']);
  const pending=new Set(['queued','running','awaiting-approval']);
  const clone=x=>JSON.parse(JSON.stringify(x));
  const cancelled=()=>Object.assign(Error('已停止工具执行'),{code:'CANCELLED'});
  const label=type=>({evidence_log:'读取账本',library_overview:'资料概览',capabilities:'操作说明',history_search:'搜索对话',history_read:'读取对话',task_list:'任务目录',list:'资料目录',search:'检索',neighbors:'相邻证据',read:'读取正文',read_page:'读取原件',read_file:'工作区文件',wiki_list:'Wiki 目录',memory_read:'项目记忆',delegate:'子代理',terminal:'终端',web_read:'网页读取',web_search:'网页搜索'})[type]||type;
  function safeRequest(request){
    const out={};for(const key of ['type','id','recordType','query','offset','page','refKey','variant','chunkId','version','radius','argv','cwd','timeout','task','title','url','name','messageId','maxTokens','runId'])if(request[key]!==undefined)out[key]=clone(request[key]);
    return out;
  }
  function resultSnapshot(value){
    const {blocks,...data}=value||{}; const raw=JSON.stringify(data);
    return raw.length<=32768?{result:data,truncated:false}:{result:{preview:raw.slice(0,32768)},truncated:true};
  }
  function create({run,execute,signal,checkpoint=async()=>{},changed=()=>{},validate=()=>{},concurrency=3,parentId=null}){
    run.toolCalls ||= []; let serial=Promise.resolve();
    // Saves are ordered even while independent network/file reads overlap.
    const persist=()=>{changed();const next=serial.then(checkpoint);serial=next.catch(()=>{});return next;};
    const check=()=>{if(signal?.aborted)throw cancelled();validate();};
    async function batch(requests){
      check();if(!Array.isArray(requests)||requests.length>32)throw Error('每批最多 32 个工具请求，请分批继续。');
      const entries=requests.map(request=>{if(!request||typeof request.type!=='string')throw Error('无效工具请求');return {id:'tool_'+Date.now()+'_'+Math.random().toString(36).slice(2),parentId,type:request.type,request:safeRequest(request),status:'queued',createdAt:Date.now()};});
      run.toolCalls.push(...entries);try{await persist();check();}catch(error){for(const entry of entries){entry.status=signal?.aborted?'cancelled':'failed';entry.error=error.message;entry.finishedAt=Date.now();}throw error;}const results=new Array(entries.length);
      async function invoke(i){
        const entry=entries[i];
        try{
          check();entry.status='running';entry.startedAt=Date.now();await persist();check();
          const result=await execute(clone(entry.request),{signal,entry});check();
          const value=result||{};entry.status=value.error||['failed','timed_out','interrupted'].includes(value.status)?'failed':['cancelled','rejected'].includes(value.status)?'cancelled':'completed';
          Object.assign(entry,resultSnapshot(value));results[i]=value;
        }catch(error){entry.status=error.code==='CANCELLED'||signal?.aborted?'cancelled':'failed';entry.error=error.message;results[i]={error:error.message};if(error.code==='CANCELLED')throw error;}
        finally{entry.finishedAt=Date.now();await persist();}
      }
      try{
        let start=0;
        while(start<entries.length){
          check();if(!reads.has(entries[start].type)){await invoke(start++);continue;}
          let end=start;while(end<entries.length&&reads.has(entries[end].type))end++;
          let cursor=start;const workers=Array.from({length:Math.min(Math.max(1,concurrency),end-start)},async()=>{while(cursor<end){check();const i=cursor++;await invoke(i);}});
          const settled=await Promise.allSettled(workers);const failure=settled.find(x=>x.status==='rejected');if(failure)throw failure.reason;start=end;
        }
        return results;
      }finally{
        for(const entry of entries)if(pending.has(entry.status)){entry.status='cancelled';entry.error='本批中止，未执行或未完成';entry.finishedAt=Date.now();}
        await persist();
      }
    }
    return {batch,persist};
  }
  function provider(run,activity,parentId=null){
    if(activity?.kind!=='tool')return false;run.toolCalls ||= [];
    const id='provider:'+String(parentId||'main')+':'+activity.id;
    let entry=run.toolCalls.find(x=>x.id===id);
    if(!entry){entry={id,parentId,type:activity.name||'provider',createdAt:Date.now(),request:{type:activity.name||'provider'}};run.toolCalls.push(entry);}
    if(!pending.has(entry.status)&&entry.finishedAt)return false;
    if(activity.url)entry.request.url=activity.url;
    entry.status=activity.status==='pending'?'queued':activity.status||'running';entry.summary=activity.text;
    if(entry.status==='running')entry.startedAt ||= Date.now();if(!pending.has(entry.status))entry.finishedAt=Date.now();return true;
  }
  function finish(run,status){for(const entry of run.toolCalls||[])if(pending.has(entry.status)){entry.status=status==='cancelled'?'cancelled':'interrupted';entry.finishedAt=Date.now();entry.error='未收到工具完成结果，请核对执行记录。';}}
  function recover(state,instanceId){
    if(!instanceId)return false;let changed=false;
    for(const run of state.agentRuns||[])if(run.status==='running'&&run.executionInstanceId&&run.executionInstanceId!==instanceId){
      run.status='interrupted';run.error='上次执行随本机服务结束而中断。已保存的输出保留，请核对后继续。';run.finishedAt=Date.now();finish(run,'interrupted');
      for(const child of run.delegations||[])if(pending.has(child.status)){child.status='interrupted';child.finishedAt=Date.now();}
      for(const step of run.steps||[])if(step.status==='running')step.status='interrupted';
      const c=(state.conversations||[]).find(x=>x.id===run.conversationId);const m=c?.messages?.find(x=>x.runId===run.id);
      if(m){m.live=false;m.runStatus='interrupted';m.retryRunId=run.id;m.text=(m.text||'')+'\n\n'+run.error;}
      changed=true;
    }return changed;
  }
  function card(run){
    if(!run?.toolCalls?.length||!root.document)return null;
    const el=(tag,text,cls)=>{const x=root.document.createElement(tag);if(text!==undefined)x.textContent=text;if(cls)x.className=cls;return x;};
    const en=root.WorkstationI18n?.getLanguage?.()==='en';
    const box=el('details',undefined,'tool-ledger message-steps');box.append(el('summary',(en?'Tool history · ':'工具执行记录 · ')+run.toolCalls.length));
    const names=en?{queued:'Queued',running:'Running',completed:'Completed',failed:'Failed',cancelled:'Cancelled',interrupted:'Interrupted'}:{queued:'等待',running:'进行中',completed:'完成',failed:'失败',cancelled:'已停止',interrupted:'已中断'};
    for(const call of run.toolCalls){const row=el('details',undefined,'tool-ledger-row');row.dataset.toolId=call.id;
      const title=(en?call.type:label(call.type))+' · '+(call.request?.title||call.request?.query||call.request?.id||'');
      row.append(el('summary',`${call.parentId?'↳ ':''}${title} · ${names[call.status]||call.status}`));
      row.append(el('pre',JSON.stringify(call.request,null,2)));
      if(call.result)row.append(el('pre',JSON.stringify(call.result,null,2)));if(call.error)row.append(el('p',call.error));if(call.summary)row.append(el('p',call.summary));if(call.truncated)row.append(el('p',en?'History preview truncated; original tool pagination remains available.':'日志预览已截断；原工具仍可分页读取。'));
      box.append(row);
    }return box;
  }
  return {create,provider,finish,recover,card,safeRequest,resultSnapshot};
});
