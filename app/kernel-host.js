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
   - events: model/*, tool/*, approval/*, run/* go to the run's stream.
   The model connection is the main window's saved one: base and model from
   the workspace snapshot, the key from the native credential store through
   the kernelHost bridge (kept in memory for one request only). No DOM. */
(function(root){
  'use strict';
  // Injected by the native shell at document start: {hostToken, hostId, protocol, wire}.
  const cfg=()=>root.__aibroKernel||{};
  const Calls=root.AIBroToolCalls,RunLoop=root.AIBroRunLoop,Compaction=root.AIBroCompaction,Gateway=root.ToolGateway,Broker=root.ApprovalBroker;
  const Events=root.AIBroEvents,Tools=root.AIBroTools,Rules=root.AIBroKernelRules;
  const HEARTBEAT_MS=15000,IDLE_POLL_MS=3000,MAX_STEPS=30,ANSWER_WAIT_MS=7*24*3600*1000;
  const hostHeaders=()=>({'Content-Type':'application/json','X-AIBro-Kernel-Host':cfg().hostToken||''});
  const bridge=()=>root.webkit?.messageHandlers?.kernelHost||null;
  const notifyNative=message=>{try{bridge()?.postMessage(message);}catch{}};
  const status={state:'idle',runId:null,completed:0,failed:0,lastError:null};
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

  function registry(){
    const reg=Tools.build();
    reg.plugin('kernel');
    for(const spec of WRITE_SPECS)reg.register(spec);
    return reg;
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
  async function connection(state){
    const base=String(state?._apiBase||'').trim(),model=String(state?._apiModel||'').trim();
    if(!base||!model)throw Object.assign(Error('后台运行需要先在设置里配置模型服务（API 地址和模型）。'),{code:'NO_CONNECTION'});
    let token='';
    if(bridge()){
      const reply=await bridge().postMessage({type:'connection',base});
      token=typeof reply?.token==='string'?reply.token:'';
    }
    const local=/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i.test(base.endsWith('/')?base:base+'/');
    if(!token&&!local)throw Object.assign(Error('后台运行需要已保存的 API Key（在设置里保存后重试）。'),{code:'NO_CREDENTIAL'});
    return {base:base.replace(/\/+$/,''),model,token};
  }

  async function execute(claim){
    const run=claim.run,lease=claim.leaseToken,controller=new AbortController();
    status.state='running';status.runId=run.id;
    const events=Events.create({sink:Events.httpSink('/__events/append',root.fetch.bind(root)),source:{kind:'kernel',id:'headless'},onError:()=>{}});
    const emit=async(type,data)=>{try{events.emit(type,{runId:run.id,data});await events.flush();}catch{}};
    let beat=null,finished=false;
    const finish=async(status_,result,error)=>{
      if(finished)return;finished=true;clearInterval(beat);
      await events.flush();
      await call(`/__kernel/host/runs/${run.id}/finish`,{leaseToken:lease,status:status_,result:result||null,error:error||null}).catch(()=>{});
    };
    beat=setInterval(()=>{call(`/__kernel/host/runs/${run.id}/heartbeat`,{leaseToken:lease}).then(r=>{if(r.cancelRequested)controller.abort();}).catch(error=>{if(error.code==='LEASE_LOST')controller.abort();});},HEARTBEAT_MS);
    try{
      const state=await (await root.fetch('/__state',{cache:'no-store'})).json();
      const scope={projectId:run.request.projectId||null,workspace:run.request.workspace||null,allowedTaskIds:[]};
      if(scope.projectId&&!(state.projects||[]).some(p=>p.id===scope.projectId&&!p.deletedAt))throw Object.assign(Error('指定的项目不存在或已删除。'),{code:'NO_PROJECT'});
      const conn=await connection(state);
      const reg=registry();
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
        const {approval}=await call(`/__kernel/host/runs/${run.id}/ask`,{leaseToken:lease,callId,tool:name,args,effect,destructive,reasons:['permission-mode:'+mode]});
        notifyNative({type:'attention',runId:run.id,approvalId:approval.id,title:run.request.title,tool:name,destructive:destructive===true});
        for(;;){
          if(controller.signal.aborted)return 'cancelled';
          const out=await call(`/__kernel/host/runs/${run.id}/approvals/${approval.id}?leaseToken=${encodeURIComponent(lease)}&wait=20`);
          if(out.cancelRequested){controller.abort();return 'cancelled';}
          if(out.approval.status!=='pending')return out.approval.status;
        }
      };
      const gateway=Gateway.create({registry:reg,host:'node',ledger:Gateway.memoryLedger(),events,runId:run.id,ask,answerTimeoutMs:ANSWER_WAIT_MS,
        execute:(name,args,context)=>WRITE_SPECS.some(spec=>spec.name===name)?applyEffect(name,args,context):reads(name,args,context)});
      const specs=Calls.fromRegistry(reg,{host:'node'});
      const protocol=Calls.toolProtocol(cfg().protocol||'text'),wire=cfg().wire==='responses'?'responses':'chat';
      const system=`你是 AI Bro，用户在 macOS 上的个人 AI 助理（学生/科研场景）。用提供的工具完成用户的任务。\n${Rules.text('headless')}`;
      const session={id:run.id.slice(-10),steps:0,repeats:{},turns:[{role:'system',content:protocol==='text'?system+'\n\n'+Calls.textCatalog(specs):system},{role:'user',content:run.request.prompt}]};
      const request=async(body,{signal})=>{
        const url=`/__proxy?url=${encodeURIComponent(conn.base+(wire==='responses'?'/responses':'/chat/completions'))}`;
        const response=await root.fetch(url,{method:'POST',signal,headers:{'Content-Type':'application/json',Accept:'text/event-stream',...(conn.token?{Authorization:'Bearer '+conn.token}:{})},body:JSON.stringify({...body,model:conn.model})});
        if(!response.ok){const text=await response.text().catch(()=>'');throw Object.assign(Error('模型服务返回 HTTP '+response.status+' '+text.slice(0,200)),{code:'MODEL_HTTP'});}
        const reply=await RunLoop.readModelStream(response,wire,Calls);
        if(!reply.completed)throw Object.assign(Error('模型回复中断'),{code:'MODEL_STREAM'});
        return reply;
      };
      const result=await RunLoop.toolLoop(session,{
        calls:Calls,specs,protocol,wire,model:conn.model,signal:controller.signal,emit,
        compaction:{compactor:Compaction,...runBudget(state,conn)},
        maxSteps:Math.min(run.request.maxSteps||MAX_STEPS,60),repeatLimit:4,prefix:'h',request,
        invoke:async(call_,{signal})=>JSON.stringify(await gateway.invoke(call_,{runId:run.id,permissionMode:mode,readOnly:policy.readOnly,unattended:true},{signal})),
      });
      const outcome=result.stop==='cancelled'?'cancelled':result.stop==='final'?'completed':'failed';
      await finish(outcome,{final:result.final,stop:result.stop,steps:result.steps,compactions:result.compactions},outcome==='failed'?'运行未完成：'+result.stop:null);
      status[outcome==='failed'?'failed':'completed']++;
    }catch(error){
      status.failed++;status.lastError=String(error?.message||error).slice(0,200);
      await emit('run/finished',{status:controller.signal.aborted?'cancelled':'failed',error:status.lastError});
      await finish(controller.signal.aborted?'cancelled':'failed',null,status.lastError);
    }finally{
      clearInterval(beat);status.state='idle';status.runId=null;
      notifyNative({type:'run-ended',runId:run.id});
    }
  }

  let running=false;
  async function loop(){
    if(running)return;running=true;
    try{
      for(;;){
        let claim=null;
        try{claim=await call('/__kernel/host/claim',{host:cfg().hostId||'headless'});}
        catch(error){status.lastError=String(error.message||error).slice(0,200);}
        if(claim?.run)await execute(claim);
        else{notifyNative({type:'idle'});await wait(IDLE_POLL_MS);}
      }
    }finally{running=false;}
  }
  root.AIBroKernelHost=Object.freeze({start:loop,status,WRITE_SPECS,registry});
  if(cfg().autostart!==false&&cfg().hostToken)loop();
})(globalThis);
