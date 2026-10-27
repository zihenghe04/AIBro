/* Kernel run loop (P8a): the DOM-free part of one agent run, shared by the
   main window and headless hosts. The host builds the model input and owns
   presentation; this module owns what happens between the first model reply
   and an accepted final plan:
   - the read/tool loop (KnowledgeAccess.continuePlan: batches, evidence view,
     loop guards, corrections);
   - writes in the tool phase: actions/fileEdits/agendaProposals/memoryUpdates
     sent alongside knowledgeRequests are staged, never executed. Staged writes
     are merged into the final plan, so they reach the same RunCheckpoint,
     approval and save path as writes in the final plan;
   - repairs: a malformed tool batch, a reply in a private tool syntax and a
     final plan that fails validation share one budget of at most two
     consecutive repairs. Running a tool batch is progress and resets it;
   - result bookkeeping (search/read ledgers, retrieved sources).
   Host: {ask(extra, blocks), execute, batch, validate, finalize: {accept,
   repair}, ...continuePlan options}. Nothing here touches the DOM.
   P8b adds toolLoop(), the loop of a kernel speaking provider tool calls over
   gateway tools (the bench kernel and the headless host), with run-internal
   compaction and cancellation, and readModelStream() for its replies. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.AIBroRunLoop=api;})(globalThis,()=>{
  'use strict';
  const REPAIR_LIMIT=2;
  const WRITE_KINDS=Object.freeze(['actions','fileEdits','agendaProposals','memoryUpdates']);
  const list=value=>Array.isArray(value)?value:[];
  const stable=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);

  // Repair budget, kept on the run record (or a bench session): formatRepairCount
  // is the run's total, formatRepairStreak the consecutive count since the last
  // tool batch ran. take() answers "may we ask the model to fix this once more?".
  function budget(owner,limit=REPAIR_LIMIT){
    return {
      take(){
        if(!owner||(owner.formatRepairStreak||0)>=limit)return false;
        owner.formatRepairStreak=(owner.formatRepairStreak||0)+1;
        owner.formatRepairCount=(owner.formatRepairCount||0)+1;
        return true;
      },
      reset(){if(owner&&owner.formatRepairStreak)owner.formatRepairStreak=0;},
      get streak(){return owner?.formatRepairStreak||0;},
      limit,
    };
  }

  // Staged writes live on run.stagedWrites (persisted with the run) until the
  // final plan is accepted. A record is {id, kind, round, item}.
  function staging(run,{emit,uid}={}){
    const records=()=>(run.stagedWrites||=[]);
    let seq=(run.stagedWrites||[]).length;
    const nextId=()=>typeof uid==='function'?uid('staged'):`staged-${++seq}`;
    return {
      get records(){return records();},
      // A tool-phase plan's write fields. Identical items are staged once.
      stage(plan,round=0){
        const added=[];
        for(const kind of WRITE_KINDS)for(const item of list(plan?.[kind])){
          if(!item||typeof item!=='object')continue;
          const key=kind+':'+stable(item);
          if(records().some(record=>record.kind+':'+stable(record.item)===key))continue;
          const record={id:nextId(),kind,round,item:structuredClone(item),at:Date.now()};
          records().push(record);added.push(record);
        }
        if(added.length)emit?.('tool/staged',{count:added.length,kinds:[...new Set(added.map(r=>r.kind))],types:added.map(r=>r.item.type||null).filter(Boolean),staged:records().length});
        return added;
      },
      // The final plan plus staged writes. withdrawStaged:[id] drops staged
      // items the model replaced; an item restated verbatim is kept once.
      merge(plan){
        if(!plan||typeof plan!=='object'||!run.stagedWrites?.length)return plan;
        const withdrawn=new Set(list(plan.withdrawStaged).filter(id=>typeof id==='string'));
        const kept=records().filter(record=>!withdrawn.has(record.id));
        const merged={...plan};delete merged.withdrawStaged;
        for(const kind of WRITE_KINDS){
          const own=list(plan[kind]),seen=new Set(own.map(item=>stable(item)));
          const staged=kept.filter(record=>record.kind===kind&&!seen.has(stable(record.item))).map(record=>record.item);
          if(staged.length||Object.hasOwn(plan,kind))merged[kind]=[...staged,...own];
        }
        return merged;
      },
      // Text form for the final validator: unchanged when nothing is staged.
      mergeOutput(output,parsePlan){
        if(!run.stagedWrites?.length)return output;
        let plan;try{plan=(parsePlan||JSON.parse)(output);}catch{return output;}
        if(!plan||typeof plan!=='object'||Array.isArray(plan))return output;
        return JSON.stringify(this.merge(plan));
      },
      // After a failed final validation every staged write is withdrawn; the
      // repaired plan must state all of its writes itself.
      withdrawAll(){
        const out=(run.stagedWrites||[]).splice(0);
        if(out.length){(run.withdrawnStagedWrites||=[]).push(...out.map(({id,kind,round})=>({id,kind,round})));emit?.('tool/staged',{withdrawn:out.length,staged:0});}
        return out;
      },
      // Accepted: the items now live in the final plan (run.pendingActions etc.);
      // the run keeps only which writes were staged in which round.
      settle(){
        if(run.stagedWrites?.length)run.stagedWrites=run.stagedWrites.map(({id,kind,round,item})=>({id,kind,round,type:item?.type||null,settled:true}));
      },
      notice(){
        if(!run.stagedWrites?.length)return '';
        const view=records().map(({id,kind,item})=>({id,kind,type:item.type||null,title:item.title||item.name||item.path||null}));
        return `\n已暂存的写操作（尚未执行，没有任何效果；本轮结束时与最终计划一起审批和保存）：${JSON.stringify(view)}。最终计划不必重复这些项；要撤回或替换某项，在最终 JSON 中写 "withdrawStaged":["暂存ID"] 并给出替代项。`;
      },
    };
  }

  // finalize for continuePlan: null accepts, a string is the repaired reply.
  // before(output) runs outside the repairable part: a run that is no longer
  // active (cancelled, scope revoked) is never repaired.
  function finalizer({before,accept,repair,budget:repairs,staging:staged,parsePlan}){
    return async output=>{
      await before?.(output);
      try{await accept(staged?staged.mergeOutput(output,parsePlan):output);staged?.settle();return null;}
      catch(error){
        if(error?.code==='CANCELLED'||!repairs?.take())throw error;
        const withdrawn=staged?staged.withdrawAll():[];
        const repaired=await repair(error,output,withdrawn);
        return repaired==null?output:repaired;
      }
    };
  }

  // One run from the first model reply to the accepted final output.
  async function run(initial,{knowledge,run:record,ask,finalize,parsePlan,emit,uid,repairs,onBatch,...options}){
    const repairBudget=repairs||budget(record);
    const staged=staging(record,{emit,uid});
    const final=finalizer({...finalize,budget:repairBudget,staging:staged,parsePlan});
    if(!knowledge?.continuePlan){
      let output=initial;
      for(;;){const repaired=await final(output);if(repaired==null)return output;output=repaired;}
    }
    let round=0;
    return knowledge.continuePlan(initial,{...options,parsePlan,finalize:final,repairs:repairBudget,
      stageWrites:plan=>staged.stage(plan,++round),
      onBatch:requests=>{repairBudget.reset();onBatch?.(requests);},
      prepareFinal:options.prepareFinal?plan=>options.prepareFinal(staged.merge(plan)):undefined,
      ask:(extra,blocks)=>ask((extra||'')+staged.notice(),blocks)});
  }

  // Run-record bookkeeping for one tool result. Returns the progress step
  // to show ({text,status,save}) or null; the host renders it.
  const sourceKey=e=>e.chunkId||`${e.type}:${e.id}:${e.page||0}`;
  function mergeSources(live,returned){live.retrievedSources=[...new Map([...(live.retrievedSources||[]),...returned].map(e=>[sourceKey(e),e])).values()];}
  function recordResult(record,live,request,result,{trackRead}={}){
    const type=String(request?.type||''),failed=!!result.error;
    if(['agenda_list','agenda_read'].includes(type))return {text:failed?'日程读取未完成：'+result.error:type==='agenda_read'?'已读取日程详情':'已查询日程',status:failed?'failed':'done',save:true};
    if(['evidence_log','library_overview'].includes(type))return {text:failed?'资料索引读取失败：'+result.error:'已读取资料索引，可按需继续',status:failed?'failed':'done'};
    if(type==='capabilities')return {text:failed?'能力加载失败：'+result.error:'已按需加载操作说明',status:failed?'failed':'done'};
    if(type.startsWith('history_'))return {text:'已回查当前对话历史',status:'done'};
    trackRead?.(result);
    if(type==='delegate')return {text:failed?'子代理未完成：'+result.error:'子代理研究已返回，待综合核验',status:failed?'failed':'done',save:true};
    if(type==='terminal')return {text:result.status==='succeeded'?'本机命令已完成':'本机命令：'+(result.status||result.error),status:result.status==='succeeded'?'done':'failed',save:true};
    if(type.startsWith('browser_'))return {text:failed?'浏览器操作未完成：'+result.error:'浏览器已返回页面状态',status:failed?'failed':'done',save:true};
    if(type==='neighbors'&&!failed){
      const returned=(result.entries||[]).map(e=>({id:e.recordId,chunkId:e.id,type:e.type,title:e.title,page:e.page,projectId:e.projectId,heading:e.heading,offset:e.offset,end:e.end,version:e.version}));
      mergeSources(live,returned);
      (record.knowledgeReads||=[]).push(...returned.map(e=>({...e,type:'neighbors',recordType:e.type,originalRead:false})));
      return {text:'已读取相邻证据片段，可继续查看原件',status:'done',save:true};
    }
    if(type==='search'&&!failed){
      record.knowledgeSearches||=[];
      record.retrievalCoverage=result.coverage||record.retrievalCoverage;live.retrievalCoverage=record.retrievalCoverage;
      record.knowledgeSearches.push({query:request.query,offset:result.offset,nextOffset:result.nextOffset,totalChunks:result.total,coverage:result.coverage});
      mergeSources(live,(result.entries||[]).map(e=>({id:e.id,chunkId:e.chunkId,type:e.type,title:e.title,page:e.page,projectId:e.projectId})));
    }
    if(type==='read'&&result.type==='note'&&!failed&&Array.isArray(record.noteContextIds)&&!record.noteContextIds.includes(result.id))record.noteContextIds.push(result.id);
    (record.knowledgeReads||=[]).push({type,recordType:result.type||request.recordType||null,title:result.title||null,id:result.id||null,page:result.page||null,offset:result.offset??null,nextOffset:result.nextOffset??null,readMode:result.readMode||null,textAvailable:result.textAvailable??null,error:result.error||null});
    const pageStage=result.readMode==='extracted_text'?result.textAvailable===false?`第 ${result.page} 页没有可提取文字`:`已读取第 ${result.page} 页文字${result.nextOffset!=null?'片段，可继续读取':''}`:`已读取原件第 ${result.page} 页`;
    return {text:failed?'知识库读取未完成：'+result.error:type==='read_page'?pageStage:type==='read'?'已读取知识库正文片段':'已检索知识库，可继续读取',status:failed?'failed':'done',save:true};
  }

  // ---- tool-calling loop (P8b) ---------------------------------------------
  // The loop of a kernel that speaks provider tool calls (native, or the text
  // JSON protocol) over gateway tools. The bench kernel (route A) and the
  // headless host run this same function. It owns the transcript
  // (session.turns, see tool-calls.js), the repeat guard, the shared repair
  // budget, run-internal compaction (kernel-compaction.js) and cancellation.
  // Host: {calls (tool-calls.js), request(body,{signal,purpose}) → reply
  //   {content,reasoning,raw,finish,usage}, invoke(call,{signal}) → result text,
  //   specs, known, protocol, wire, model, emit(type,data), save(session),
  //   signal, compaction:{compactor, thresholdTokens, retainTokens, usage} | null,
  //   resumePrompt, maxSteps, repeatLimit}.
  // compaction.usage (P9b, the Codex model): the provider's reported input
  // tokens also trigger compaction; an estimated count (usage.estimated)
  // triggers it earlier, at USAGE_EARLY of the threshold.
  // A request error with pause:true (usage limit) ends the run as "paused"
  // with {pause:{code,message}}; nothing here retries it.
  // A cancelled run stops before the next model request or tool call; a call
  // already running gets graceMs to settle, otherwise its outcome is recorded
  // as unknown (never retried). Remaining calls of that turn are answered
  // "cancelled, not started".
  const CANCELLED_RESULT=JSON.stringify({ok:false,code:'CANCELLED',message:'运行已取消，未执行。',outcome:'not-started'});
  const UNKNOWN_RESULT=JSON.stringify({ok:false,code:'OUTCOME_UNKNOWN',message:'运行在该调用执行期间被取消，结果未知；不会重做。',outcome:'unknown'});
  const USAGE_EARLY=0.75;
  const usageOf=u=>u?{input:u.prompt_tokens??u.input_tokens??null,output:u.completion_tokens??u.output_tokens??null,...(u.estimated===true?{estimated:true}:{})}:null;
  async function toolLoop(session,host){
    const {calls:Calls,request,invoke,specs=[],known=new Set(specs.map(spec=>spec.name)),protocol='native',wire='chat',model='kernel',
      emit=async()=>{},save=()=>{},signal=null,compaction=null,resumePrompt=null,maxSteps=40,repeatLimit=4,prefix='a',
      temperature=0.2,graceMs=3000}=host;
    if(!Calls||typeof request!=='function'||typeof invoke!=='function')throw TypeError('toolLoop needs calls, request and invoke');
    const stopped=()=>!!signal?.aborted;
    const tools=protocol==='native'?Calls.render(specs,wire):null;
    const body=(messages,withTools=true)=>wire==='chat'
      ?{model,messages,temperature,stream:true,stream_options:{include_usage:true},...(withTools&&tools?{tools}:{})}
      :{model,input:messages,temperature,stream:true,store:false,...(withTools&&tools?{tools}:{})};
    const Compactor=compaction?.compactor||null;
    const capResult=text=>Compactor?Compactor.cap(text):String(text).slice(0,20000);
    session.repeats||={};session.steps||=0;
    const record=(call,content)=>{session.turns.push({role:'tool',callId:call.callId,providerId:call.providerId,name:call.name,content:capResult(content)});save(session);};
    const settle=promise=>{
      if(!signal)return promise;
      return new Promise((resolve,reject)=>{
        let timer=null;const onAbort=()=>{timer=setTimeout(()=>resolve(UNKNOWN_RESULT),graceMs);};
        const done=()=>{clearTimeout(timer);signal.removeEventListener?.('abort',onAbort);};
        if(signal.aborted)onAbort();else signal.addEventListener('abort',onAbort,{once:true});
        promise.then(value=>{done();resolve(value);},error=>{done();reject(error);});
      });
    };
    const answer=async call=>{
      if(stopped())return record(call,CANCELLED_RESULT);
      if(call.error)return record(call,Calls.errorResult(call));
      const sig=call.name+JSON.stringify(call.args);
      session.repeats[sig]=(session.repeats[sig]||0)+1;
      if(session.repeats[sig]>=repeatLimit)return record(call,JSON.stringify({ok:false,code:'REPEAT_BLOCKED',message:`同一调用已重复 ${repeatLimit} 次，已阻断。换个办法或结束。`}));
      let content;
      try{content=await settle(Promise.resolve().then(()=>invoke(call,{signal})));}
      catch(error){content=JSON.stringify({ok:false,code:error?.code||'TOOL_FAILED',message:String(error?.message||error).slice(0,500)});}
      record(call,typeof content==='string'?content:JSON.stringify(content));
    };
    const finish=async(stop,final=null,pause=null)=>{
      await emit('run/finished',{status:stop==='final'?'completed':stop,steps:session.steps,compactions:session.compactions||0,...(pause?{pause}:{})});
      return {final,stop,steps:session.steps,formatErrors:session.formatErrors||0,compactions:session.compactions||0,...(pause?{pause}:{})};
    };
    const paused=error=>finish('paused',null,{code:String(error.code||'PAUSED').slice(0,40),message:String(error.message||error).slice(0,300)});
    // Reported (or estimated) context of the last reply, when the host asks for it.
    const pressure=()=>{
      const last=session.lastUsage;
      if(!compaction?.usage||!last||!Number.isFinite(last.input))return false;
      const limit=last.estimated?Math.floor(compaction.thresholdTokens*USAGE_EARLY):compaction.thresholdTokens;
      return last.input>=limit&&Compactor.estimate(session.turns)>compaction.retainTokens;
    };
    // Resume: calls of the last assistant turn without a result are asked
    // again under the same call id; the gateway answers from its ledger.
    for(const call of Calls.unanswered(session.turns))await answer(call);
    if(resumePrompt){session.turns.push({role:'user',content:resumePrompt});save(session);}
    const repairs=budget(session);
    const summarize=async(messages,{signal:s}={})=>{
      const t0=Date.now();
      await emit('model/request',{purpose:'compaction',step:session.steps,messages:messages.length,tools:0});
      let reply;
      try{reply=await request(body(messages,false),{signal:s,purpose:'compaction'});}
      catch(error){await emit('model/response',{purpose:'compaction',status:stopped()?'cancelled':'failed',step:session.steps,ms:Date.now()-t0,error:String(error?.message||error).slice(0,200)});throw error;}
      await emit('model/response',{purpose:'compaction',status:'completed',step:session.steps,ms:Date.now()-t0,finish:reply.finish,usage:usageOf(reply.usage),textChars:String(reply.content||'').length,calls:[]});
      return reply.content;
    };
    while(session.steps<maxSteps){
      if(stopped())return finish('cancelled');
      if(Compactor){
        let result;
        const force=pressure();
        try{result=await Compactor.compact(session,{thresholdTokens:compaction.thresholdTokens,retainTokens:compaction.retainTokens,signal,summarize,...(force?{force:true}:{})});}
        catch(error){if(stopped())return finish('cancelled');if(error?.pause)return paused(error);throw error;}
        if(force){session.lastUsage=null;result={...result,trigger:'usage'};}
        if(result.compacted||result.reason){(session.compactionLog||=[]).push({step:session.steps,...result});save(session);await emit('run/compacted',{step:session.steps,...result});}
      }
      if(stopped())return finish('cancelled');
      session.steps++;
      const msgs=Calls.messages(session.turns,{protocol,wire});
      const t0=Date.now();
      await emit('model/request',{protocol,wire,step:session.steps,messages:msgs.length,tools:tools?tools.length:0});
      let reply;
      try{reply=await request(body(msgs),{signal,purpose:'step'});}
      catch(error){
        await emit('model/response',{status:stopped()?'cancelled':error?.pause?'paused':'failed',step:session.steps,ms:Date.now()-t0,error:String(error?.message||error).slice(0,200),...(error?.code?{code:String(error.code).slice(0,40)}:{})});
        if(stopped())return finish('cancelled');
        // The step never happened: the next attempt (after a resume) asks again.
        if(error?.pause){session.steps--;save(session);return paused(error);}
        throw error;
      }
      let raw=reply.raw,textFinal=null,textError=null;
      if(protocol==='text')({calls:raw,final:textFinal,error:textError}=Calls.parseText(reply.content));
      const list=Calls.normalize(raw,{prefix,session:session.id,turn:session.steps,known});
      const used=usageOf(reply.usage);
      if(used)session.lastUsage=used;
      await emit('model/response',{status:'completed',step:session.steps,ms:Date.now()-t0,finish:reply.finish,usage:used,textChars:String(reply.content||'').length,calls:list.map(c=>({callId:c.callId,name:c.name,error:c.error?.code||null})),...(reply.codex?{codex:reply.codex}:{})});
      session.turns.push({role:'assistant',content:reply.content,...(reply.reasoning?{reasoning:reply.reasoning}:{}),calls:list});
      save(session);
      if(!list.length){
        if(protocol==='text'&&textFinal===null&&repairs.take()){
          // Neither calls nor final: remind (twice in a row at most), then take it as final.
          session.formatErrors=(session.formatErrors||0)+1;
          session.turns.push({role:'user',content:`上一条回复不符合约定格式（${textError}）。请只回复一个 JSON 对象：调用工具用 {"tool_calls":[…]}，完成时用 {"final":"…"}。`});
          save(session);
          continue;
        }
        return finish('final',textFinal??reply.content);
      }
      repairs.reset();
      for(const call of list)await answer(call);
    }
    return finish('max_steps');
  }

  // One streamed provider reply (Chat Completions or Responses SSE) →
  // {content, reasoning, raw, finish, usage, completed}; raw tool calls are
  // assembled by the tool-calls.js accumulator. Reads res.body with a reader,
  // so it runs in WebKit (no async iteration of streams) and in Node 18+.
  async function readModelStream(res,wire,Calls){
    const acc=Calls.accumulator();
    let content='',reasoning='',finish=null,usage=null,buffer='',completed=false;
    const onData=data=>{
      if(data==='[DONE]'){completed=true;return;}
      let event;try{event=JSON.parse(data);}catch{return;}
      if(wire==='chat'){
        if(event.usage)usage=event.usage;
        const choice=event.choices?.[0];
        if(!choice)return;
        if(typeof choice.delta?.content==='string')content+=choice.delta.content;
        if(typeof choice.delta?.reasoning_content==='string')reasoning+=choice.delta.reasoning_content;
        acc.chat(choice);
        if(choice.finish_reason)finish=choice.finish_reason;
      }else{
        const type=event.type||'';
        if(type==='response.output_text.delta')content+=event.delta||'';
        else if(type==='response.reasoning_text.delta'||type==='response.reasoning_summary_text.delta')reasoning+=event.delta||'';
        acc.responses(event);
        if(['response.completed','response.done','response.incomplete','response.failed'].includes(type)){
          const r=event.response||{};
          usage=r.usage||usage;finish=r.status||type.slice(9);completed=true;
          if(!content)content=(r.output||[]).filter(i=>i.type==='message').flatMap(i=>i.content||[]).map(c=>c.text||'').join('');
        }
      }
    };
    const take=frame=>{const data=frame.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');if(data)onData(data);};
    const decoder=new TextDecoder(),reader=res.body.getReader();
    for(;;){
      const {value,done}=await reader.read();
      if(done)break;
      buffer+=decoder.decode(value,{stream:true});
      let m;
      while((m=/\r?\n\r?\n/.exec(buffer))){take(buffer.slice(0,m.index));buffer=buffer.slice(m.index+m[0].length);}
    }
    if(buffer.trim())take(buffer);
    return {content,reasoning,raw:acc.raw(),finish,usage,completed};
  }

  return Object.freeze({REPAIR_LIMIT,WRITE_KINDS,USAGE_EARLY,budget,staging,finalizer,run,recordResult,toolLoop,readModelStream,CANCELLED_RESULT,UNKNOWN_RESULT});
});
