/* Headless kernel host (P8b). Runs inside kernel.html, which the native shell
   loads into a hidden WKWebView when /__kernel/runs has work (and which a test
   can load anywhere). It claims queued runs and drives each one through the
   shared tool loop (AIBroRunLoop.toolLoop, the loop the kernel bench runs):
   - tools: the P1 registry's snapshot reads (host "node") plus two workspace
     writes, create_task and create_note, all through ToolGateway, so the
     three safety rules hold here as everywhere: approval only tightens
     (ApprovalBroker), quotes must be text a tool returned in this run, one
     call id executes at most once;
   - nobody is watching: a step that needs a person registers an approval
     with the run registry and waits (status "awaiting-approval") until the
     user answers in the main window or from the notification, or the run is
     cancelled. Writes are never applied here: an allowed write becomes an
     effect the main window (the single writer of the workspace) applies and
     acknowledges; the tool result is that receipt;
   - permission mode: ApprovalBroker.headlessMode — the user's background
     setting (default: follow the main window's per-space automation setting),
     tightened by the run's request; destructive steps always ask;
   - run-internal compaction (kernel-compaction.js) and cancellation (heartbeat
     → AbortController) come from the shared loop;
   - events: model/*, tool/*, approval/*, run/* go to the run's stream;
   - scheduled runs (M1 scheduler, request.schedule): the task's declared scope
     is one more approval layer (a step outside it waits for a person, which
     the notification says), questions and self-scheduling are off, the time
     limit excludes waiting for a person, and the run only counts as done when
     the model called mark_task_done;
   - up to HOST_SLOTS runs at once, so one run waiting for a person does not
     hold up the others (the service decides who goes first).
   The model (P9b): the run's own choice (request.model, set by a schedule or
   a conversation), else the user's kernel setting (Connections role
   "kernel", which follows 问答 unless set), else the main window's saved
   connection. An API service: base and model from the workspace snapshot,
   the key from the native credential store through the kernelHost bridge
   (kept in memory for one request only). Codex CLI: steps go to
   /__kernel/host/codex/* (app/codex_kernel.py), always in the text protocol,
   with usage-driven compaction; a usage limit pauses the run (status
   "paused", native notification) until someone resumes it. No DOM. */
(function(root){
  'use strict';
  // Injected by the native shell at document start: {hostToken, hostId, protocol, wire}.
  const cfg=()=>root.__aibroKernel||{};
  const Calls=root.AIBroToolCalls,RunLoop=root.AIBroRunLoop,Compaction=root.AIBroCompaction,Gateway=root.ToolGateway,Broker=root.ApprovalBroker;
  const Events=root.AIBroEvents,Tools=root.AIBroTools,Rules=root.AIBroKernelRules,CodexKernel=root.AIBroCodexKernel;
  const HEARTBEAT_MS=15000,IDLE_POLL_MS=3000,MAX_STEPS=30,ANSWER_WAIT_MS=7*24*3600*1000,HOST_SLOTS=3;
  const hostHeaders=()=>({'Content-Type':'application/json','X-AIBro-Kernel-Host':cfg().hostToken||''});
  const bridge=()=>root.webkit?.messageHandlers?.kernelHost||null;
  const notifyNative=message=>{try{bridge()?.postMessage(message);}catch{}};
  const status={state:'idle',runId:null,runIds:[],completed:0,failed:0,paused:0,lastError:null};
  root.__aibroKernelStatus=status;

  async function call(path,body,{method=body===undefined?'GET':'POST',signal}={}){
    const response=await root.fetch(path,{method,headers:hostHeaders(),cache:'no-store',signal,...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const value=await response.json().catch(()=>({}));
    if(!response.ok)throw Object.assign(Error(value.error||('HTTP '+response.status)),{code:value.code||'HTTP_'+response.status,status:response.status});
    return value;
  }
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

  // Writes this host may request. Reads come from the registry (host "node").
  const str=(maxLength,extra={})=>({type:'string',maxLength,...extra});
  const WRITE_SPECS=[
    {name:'create_task',title:{zh:'新建任务',en:'Create task'},description:'在 AI Bro 里新建一个任务（需要用户在主窗口审批后才会写入）。due 为 YYYY-MM-DD。',effect:'local',approval:'policy',
      input:{type:'object',required:['title'],additionalProperties:false,properties:{title:str(200,{minLength:1}),due:str(10,{minLength:10}),notes:str(2000)}}},
    {name:'create_note',title:{zh:'新建笔记',en:'Create note'},description:'在 AI Bro 里新建一条笔记（需要用户在主窗口审批后才会写入）。citations 中每条 quote 必须是本次运行读到的资料原文中逐字的连续原话（4–600 字），否则拒绝执行。',effect:'local',approval:'policy',
      citations:{fields:['citations']},
      input:{type:'object',required:['title','content'],additionalProperties:false,properties:{title:str(200,{minLength:1}),content:str(20000),citations:{type:'array',maxItems:40,items:{type:'object',required:['quote'],additionalProperties:false,properties:{quote:str(600),sourceId:str(512)}}}}}},
  ].map(spec=>({...spec,plugin:'kernel',hosts:['node'],concurrency:'serial'}));
  // Scheduled runs only: the completion check. It changes nothing; the host records it.
  const MARK_DONE={name:'mark_task_done',title:{zh:'标记完成',en:'Mark task done'},description:'计划任务真正完成后调用一次，summary 写一两句结果摘要。没做完不要调用。',
    effect:'none',approval:'never',plugin:'kernel',hosts:['node'],concurrency:'serial',
    input:{type:'object',required:['summary'],additionalProperties:false,properties:{summary:str(2000,{minLength:1})}}};
  // Nobody answers a scheduled run and only the scheduler schedules: such tools never run there.
  const UNATTENDED_BLOCKED=/^(ask|clarify|question|schedule|cron|remind|automation|wake)/i;

  function registry(schedule=null){
    const reg=Tools.build();
    reg.plugin('kernel');
    for(const spec of WRITE_SPECS)reg.register(spec);
    if(schedule)reg.register(MARK_DONE);
    return reg;
  }
  // The task's declared scope as an approval layer: it can only tighten.
  // read: any change asks; external tools not declared ask; computer use has
  // its own switch (off unless declared, and still asks).
  function scopeLayer(scope){
    const s=scope||{access:'read',tools:[],computerUse:false};
    return spec=>{
      if(spec.name!=='mark_task_done'&&UNATTENDED_BLOCKED.test(spec.name))return 'deny';
      if(spec.plugin==='computer'||/^computer[_-]/.test(spec.name))return s.computerUse===true?'ask':'deny';
      if(spec.mcp&&!(s.tools||[]).includes(spec.name))return 'ask';
      if(!['none','view'].includes(spec.effect)&&s.access==='read')return 'ask';
      return 'allow';
    };
  }

  // Snapshot reads, the way the local MCP host executes them (scripts/aibro-mcp.cjs).
  function readExecutor(state,scope){
    const modules={AgentContext:root.AgentContext,ProjectAccess:root.ProjectAccess,TaskContext:root.TaskContext};
    const conversation={id:'kernel-headless',projectId:scope.projectId||null,workspace:scope.workspace||null,messages:[]};
    return async(name,args,{signal})=>{
      const run={id:'kernel-headless',conversationId:conversation.id,projectId:scope.projectId||null,contextWorkspace:scope.workspace||null};
      const tools=root.ReadTools.create({run,conversation,scope,signal,getState:()=>state,validate:()=>{},
        lookup:key=>modules[key],agentContext:()=>null,
        fallback:request=>root.KnowledgeAccess.execute(state,scope,request,{getState:()=>state})});
      return JSON.parse(JSON.stringify(await tools.execute({type:name,...args})));
    };
  }

  // The run's space: its project's, else the requested one, else 日常 (as for agenda proposals).
  const SPACE_KEYS={daily:'日常',course:'课程',research:'科研'};
  function spaceOf(state,run){
    const project=(state?.projects||[]).find(p=>p.id===run.request.projectId&&!p.deletedAt);
    const raw=String(project?.workspace||run.request.workspace||'').trim();
    return SPACE_KEYS[raw]||(['日常','课程','科研'].includes(raw)?raw:'日常');
  }
  const modeOf=(state,run)=>Broker.headlessMode({setting:state?.settings?.headlessPermissionMode,requested:run.request.permissionMode,
    spacePermission:state?.settings?.permissions?.[spaceOf(state,run)]||'auto'});

  // Run-internal compaction follows the context window saved in the model list
  // for this service/model; with none filled in it keeps the 32000/8000 defaults.
  function runBudget(state,conn){
    const fallback={thresholdTokens:Compaction.DEFAULTS.thresholdTokens,retainTokens:Compaction.DEFAULTS.retainTokens};
    const catalog=root.ModelCatalog;if(!catalog)return fallback;
    const entry=catalog.find(catalog.read(state?.settings,conn.base),conn.model),budget=catalog.kernelBudgets(entry?.contextWindow);
    return budget.configured?{thresholdTokens:budget.runCompactTokens,retainTokens:budget.runRetainTokens}:fallback;
  }
  // Which model this run uses: {kind:'codex', mode, model, effort} or {kind:'api', base, model, wire}.
  function modelSource(state,run){
    const C=root.Connections,settings=state?.settings;
    const own=run.request?.model;
    if(C&&settings){
      let chosen=null;
      if(own?.connection){
        const item=C.get(settings,own.connection);
        if(!item)throw Object.assign(Error('这个运行指定的模型连接不存在：'+own.connection),{code:'NO_CONNECTION'});
        chosen={kind:item.kind,base:item.base||'',model:own.model||'',effort:own.effort||'',protocol:item.kind==='api'?(C.detectProtocol(item.base,item.protocol)||''):''};
      }else chosen=C.resolveRole(settings,'kernel');
      // AI Bro's own ChatGPT sign-in speaks Responses + function tools through /__chatgpt/responses (route A);
      // the Codex CLI logins (private / shared) keep the text protocol through the Codex runtime (P9b).
      if(chosen?.kind==='codex-cli')return C.codexLogin(settings)==='oauth'?{kind:'chatgpt',model:chosen.model||null,effort:chosen.effort||null}:{kind:'codex',mode:C.codexLogin(settings),model:chosen.model||null,effort:chosen.effort||null};
      if(chosen?.kind==='claude-cli')throw Object.assign(Error('后台运行不支持 Claude CLI 连接，请在设置里为内核选择 API 或 Codex CLI。'),{code:'PROTOCOL_UNSUPPORTED'});
      if(chosen?.kind==='api'&&chosen.base&&chosen.model)return {kind:'api',base:chosen.base,model:chosen.model,wire:['responses','chat','anthropic'].includes(chosen.protocol)?chosen.protocol:null};
    }
    return {kind:'api',base:state?._apiBase,model:state?._apiModel,wire:null};
  }
  // Codex: the default budgets, plus compaction on the usage Codex reports (earlier when it is only estimated).
  const codexBudget=()=>({thresholdTokens:Compaction.DEFAULTS.thresholdTokens,retainTokens:Compaction.DEFAULTS.retainTokens,usage:true});
  async function connection(state,source=modelSource(state,{request:{}})){
    const base=String(source.base||'').trim(),model=String(source.model||'').trim();
    if(!base||!model)throw Object.assign(Error('后台运行需要先在设置里配置模型服务（API 地址和模型）。'),{code:'NO_CONNECTION'});
    // 后台运行内核目前只会说 Responses / Chat（Anthropic 走 P9b 之后的内核接入）。
    if(source.wire==='anthropic'||root.Connections?.isOfficialAnthropic(base))throw Object.assign(Error('后台运行暂不支持 Anthropic Messages 连接，请换用 Responses / Chat 服务或 Codex。'),{code:'PROTOCOL_UNSUPPORTED'});
    let token='';
    if(bridge()){
      const reply=await bridge().postMessage({type:'connection',base});
      token=typeof reply?.token==='string'?reply.token:'';
    }
    const local=/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i.test(base.endsWith('/')?base:base+'/');
    if(!token&&!local)throw Object.assign(Error('后台运行需要已保存的 API Key（在设置里保存后重试）。'),{code:'NO_CREDENTIAL'});
    return {base:base.replace(/\/+$/,''),model,token,wire:source.wire};
  }
  // A resumed run starts over; it is told which writes already happened so it does not repeat them.
  function resumeNote(run){
    if(!run.resumes)return '';
    const done=(run.effects||[]).filter(e=>e.status==='applied').map(e=>({tool:e.tool,title:e.args?.title||null}));
    return `\n\n（这个运行曾因模型额度暂停，现在重新开始。${done.length?'之前已经执行过这些写入，不要重复：'+JSON.stringify(done):'之前没有执行过写入。'}）`;
  }

  let usageRecorder=null;
  async function execute(claim){
    const run=claim.run,lease=claim.leaseToken,controller=new AbortController();
    status.state='running';status.runId=run.id;if(!status.runIds.includes(run.id))status.runIds.push(run.id);
    const events=Events.create({sink:Events.httpSink('/__events/append',root.fetch.bind(root)),source:{kind:'kernel',id:'headless'},onError:()=>{}});
    let usageTap=null;
    const emit=async(type,data)=>{if(type==='model/response'&&usageTap){try{usageTap(data);}catch{}}try{events.emit(type,{runId:run.id,data});await events.flush();}catch{}};
    let beat=null,finished=false,overBudget=false,closeModel=null;
    const finish=async(status_,result,error)=>{
      if(finished)return;finished=true;clearInterval(beat);
      await events.flush();
      await call(`/__kernel/host/runs/${run.id}/finish`,{leaseToken:lease,status:status_,result:result||null,error:error||null}).catch(()=>{});
    };
    beat=setInterval(()=>{call(`/__kernel/host/runs/${run.id}/heartbeat`,{leaseToken:lease}).then(r=>{if(r.cancelRequested)controller.abort();}).catch(error=>{if(error.code==='LEASE_LOST')controller.abort();});},HEARTBEAT_MS);
    try{
      const state=await (await root.fetch('/__state',{cache:'no-store'})).json();
      const schedule=run.request.schedule||null;
      const scope={projectId:run.request.projectId||null,workspace:run.request.workspace||null,allowedTaskIds:[]};
      if(scope.projectId&&!(state.projects||[]).some(p=>p.id===scope.projectId&&!p.deletedAt))throw Object.assign(Error('指定的项目不存在或已删除。'),{code:'NO_PROJECT'});
      const source=modelSource(state,run);
      const codex=source.kind==='codex',chatgpt=source.kind==='chatgpt';
      if(codex&&!CodexKernel)throw Object.assign(Error('内核页缺少 Codex 客户端模块。'),{code:'NO_CONNECTION'});
      const conn=chatgpt?{base:'/__chatgpt',model:source.model||'',token:'',wire:'responses'}:codex?{model:source.model||'codex',codex:CodexKernel.create({fetch:root.fetch.bind(root),url:action=>'/__kernel/host/codex/'+action,headers:hostHeaders(),runId:run.id,mode:source.mode,model:source.model,effort:source.effort})}:await connection(state,source);
      if(codex)closeModel=conn.codex.close;
      // Usage statistics: counts only (see usage-recorder.js).
      if(root.UsageRecorder&&!usageRecorder)usageRecorder=root.UsageRecorder.create({post:root.UsageRecorder.httpPost});
      if(usageRecorder)usageTap=usageRecorder.kernelTap({providerId:codex||chatgpt?'codex-cli':root.Connections?.apiId(conn.base)||'api',providerKind:codex||chatgpt?'account':'api',model:codex?(source.model||'codex'):chatgpt?(source.model||'chatgpt'):conn.model,runId:run.id});
      await emit('run/model',codex?{source:'codex-cli',mode:source.mode,model:source.model||null,effort:source.effort||null}:chatgpt?{source:'chatgpt-oauth',model:source.model||null,effort:source.effort||null}:{source:'api',model:conn.model});
      const reg=registry(schedule);

      const layers=schedule?[scopeLayer(schedule.scope)]:[];
      let markedDone=null,budgetTimer=null,budgetLeft=schedule?Math.max(1,Number(schedule.budgetMinutes)||15)*60000:0,budgetFrom=0;
      // The time limit counts working time only; waiting for a person pauses it.
      const budget={start(){if(!schedule)return;budgetFrom=Date.now();budgetTimer=setTimeout(()=>{overBudget=true;controller.abort();},budgetLeft);},
        pause(){if(!schedule||!budgetTimer)return;clearTimeout(budgetTimer);budgetTimer=null;budgetLeft=Math.max(1,budgetLeft-(Date.now()-budgetFrom));}};
      budget.start();
      const reads=readExecutor(state,scope);
      const policy=modeOf(state,run),mode=policy.mode;
      // An allowed write goes to the main window, which applies it and answers with a receipt.
      const applyEffect=async(name,args,{callId,signal})=>{
        await call(`/__kernel/host/runs/${run.id}/effects`,{leaseToken:lease,id:callId,tool:name,args});
        for(;;){
          if(signal?.aborted)throw Object.assign(Error('运行已取消，写入结果未知'),{code:'CANCELLED'});
          const out=await call(`/__kernel/host/runs/${run.id}/effects/${encodeURIComponent(callId)}?leaseToken=${encodeURIComponent(lease)}&wait=20`);
          const effect=out.effect;
          if(effect.status==='applied')return effect.receipt?.result??{applied:true};
          if(effect.status==='failed')throw Object.assign(Error(effect.receipt?.message||'主窗口写入失败'),{code:effect.receipt?.code||'APPLY_FAILED'});
          if(effect.status==='expired')throw Object.assign(Error(effect.receipt?.message||'未写入'),{code:effect.receipt?.code||'NOT_APPLIED'});
          if(out.cancelRequested)controller.abort();
        }
      };
      // A person answers; unattended, the run waits (and a cancel ends the wait).
      const ask=async({callId,name,args,effect,destructive})=>{
        const spec=reg.get(name),outOfScope=!!schedule&&!!spec&&layers.some(layer=>layer(spec)==='ask');
        const reasons=['permission-mode:'+mode,...(outOfScope?['out-of-scope']:[])];
        const {approval}=await call(`/__kernel/host/runs/${run.id}/ask`,{leaseToken:lease,callId,tool:name,args,effect,destructive,reasons});
        notifyNative({type:'attention',runId:run.id,approvalId:approval.id,title:run.request.title,tool:name,scheduled:!!schedule,outOfScope,destructive:destructive===true});
        budget.pause();
        try{
          for(;;){
            if(controller.signal.aborted)return 'cancelled';
            const out=await call(`/__kernel/host/runs/${run.id}/approvals/${approval.id}?leaseToken=${encodeURIComponent(lease)}&wait=20`);
            if(out.cancelRequested){controller.abort();return 'cancelled';}
            if(out.approval.status!=='pending')return out.approval.status;
          }
        }finally{if(!controller.signal.aborted)budget.start();}
      };
      const gateway=Gateway.create({registry:reg,host:'node',ledger:Gateway.memoryLedger(),events,runId:run.id,ask,answerTimeoutMs:ANSWER_WAIT_MS,layers,
        execute:(name,args,context)=>name==='mark_task_done'?(markedDone={summary:String(args.summary||'').slice(0,2000)},{recorded:true})
          :WRITE_SPECS.some(spec=>spec.name===name)?applyEffect(name,args,context):reads(name,args,context)});
      const specs=Calls.fromRegistry(reg,{host:'node'}).filter(spec=>!schedule||spec.name==='mark_task_done'||!UNATTENDED_BLOCKED.test(spec.name));
      // Codex only ever sees the text protocol: our tools are never its tools.
      const protocol=codex?'text':Calls.toolProtocol(cfg().protocol||'text'),wire=codex?'chat':chatgpt||(conn.wire||cfg().wire)==='responses'?'responses':'chat';
      const system=`你是 AI Bro，用户在 macOS 上的个人 AI 助理（学生/科研场景）。用提供的工具完成用户的任务。\n${Rules.text(schedule?['headless','scheduled','mark-done']:'headless')}`;
      const session={id:run.id.slice(-10),steps:0,repeats:{},turns:[{role:'system',content:protocol==='text'?system+'\n\n'+Calls.textCatalog(specs):system},{role:'user',content:run.request.prompt+resumeNote(run)}]};
      const request=codex?conn.codex.request:async(body,{signal})=>{
        const url=chatgpt?'/__chatgpt/responses':`/__proxy?url=${encodeURIComponent(conn.base+(wire==='responses'?'/responses':'/chat/completions'))}`;
        const payload=chatgpt?{...body,...(conn.model?{model:conn.model}:{}),...(source.effort?{reasoning:{effort:source.effort,summary:'auto'}}:{})}:{...body,model:conn.model};
        const response=await root.fetch(url,{method:'POST',signal,headers:{'Content-Type':'application/json',Accept:'text/event-stream',...(conn.token?{Authorization:'Bearer '+conn.token}:{})},body:JSON.stringify(payload)});
        if(chatgpt&&!response.ok){
          // The local channel answers with a category, never upstream text; a used-up quota pauses the run instead of failing it.
          const failure=await response.json().then(value=>value?.error||{}).catch(()=>({}));
          throw Object.assign(Error(failure.message||('ChatGPT 请求失败（HTTP '+response.status+'）')),{code:failure.code||'CHATGPT_HTTP_'+response.status,status:response.status,pause:failure.code==='chatgpt_quota'});
        }
        if(!response.ok){const text=await response.text().catch(()=>'');throw Object.assign(Error('模型服务返回 HTTP '+response.status+' '+text.slice(0,200)),{code:'MODEL_HTTP'});}
        const reply=await RunLoop.readModelStream(response,wire,Calls);
        if(!reply.completed)throw Object.assign(Error('模型回复中断'),{code:'MODEL_STREAM'});
        return reply;
      };
      const result=await RunLoop.toolLoop(session,{
        calls:Calls,specs,protocol,wire,model:conn.model,signal:controller.signal,emit,
        compaction:{compactor:Compaction,...(codex?codexBudget():runBudget(state,conn))},
        maxSteps:Math.min(run.request.maxSteps||MAX_STEPS,60),repeatLimit:4,prefix:'h',request,
        invoke:async(call_,{signal})=>JSON.stringify(await gateway.invoke(call_,{runId:run.id,permissionMode:mode,readOnly:policy.readOnly,unattended:true,
          ...(schedule?{declaredTools:schedule.scope?.tools||[]}:{})},{signal})),
      });
      budget.pause();
      if(result.stop==='paused'){
        // Usage limit: no retry here. The run waits (paused) and the user is told.
        finished=true;clearInterval(beat);await events.flush();
        await call(`/__kernel/host/runs/${run.id}/pause`,{leaseToken:lease,code:result.pause?.code,message:result.pause?.message,steps:result.steps}).catch(()=>{});
        notifyNative({type:'paused',runId:run.id,title:run.request.title,message:result.pause?.message||''});
        status.paused++;
        return;
      }
            const outcome=overBudget?'failed':result.stop==='cancelled'?'cancelled':result.stop==='final'?'completed':'failed';
      await finish(outcome,{final:result.final,stop:result.stop,steps:result.steps,compactions:result.compactions,...(markedDone?{markedDone}:{})},
        overBudget?'超过运行时间上限（'+(schedule.budgetMinutes||15)+' 分钟）':outcome==='failed'?'运行未完成：'+result.stop:null);
      status[outcome==='failed'?'failed':'completed']++;
    }catch(error){
      status.failed++;status.lastError=String(error?.message||error).slice(0,200);
      if(overBudget)status.lastError='超过运行时间上限（'+(run.request.schedule?.budgetMinutes||15)+' 分钟）';
      const ended=overBudget?'failed':controller.signal.aborted?'cancelled':'failed';
      await emit('run/finished',{status:ended,error:status.lastError});
      await finish(ended,null,status.lastError);
    }finally{
      clearInterval(beat);
      status.runIds=status.runIds.filter(id=>id!==run.id);status.runId=status.runIds.at(-1)||null;status.state=status.runIds.length?'running':'idle';
      closeModel?.();
      notifyNative({type:'run-ended',runId:run.id});
    }
  }

  let running=false;
  async function loop(){
    if(running)return;running=true;
    try{
      for(;;){
        let claim=null;
        if(status.runIds.length<HOST_SLOTS){
          try{claim=await call('/__kernel/host/claim',{host:cfg().hostId||'headless'});}
          catch(error){status.lastError=String(error.message||error).slice(0,200);}
        }
        if(claim?.run){status.runIds.push(claim.run.id);execute(claim);continue;}
        if(!status.runIds.length)notifyNative({type:'idle'});
        await wait(IDLE_POLL_MS);
      }
    }finally{running=false;}
  }
  root.AIBroKernelHost=Object.freeze({start:loop,status,modelSource,WRITE_SPECS,registry,scopeLayer,MARK_DONE,UNATTENDED_BLOCKED,HOST_SLOTS});
  if(cfg().autostart!==false&&cfg().hostToken)loop();
})(globalThis);
