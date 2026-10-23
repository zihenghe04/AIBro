/* One durable ledger for read tools, provider tools and controlled commands. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.ToolScheduler=api;})(globalThis,root=>{
  'use strict';
  // Classification, labels and the argument whitelist come from the tool
  // declarations (tool-specs.js), not from lists kept here.
  const Tools=(typeof module==='object'&&module.exports?require('./tool-specs'):root.AIBroTools)?.registry;
  if(!Tools)throw Error('ToolScheduler needs the tool registry (tool-specs.js) loaded first');
  const reads=Tools.readTypes(),parallel=Tools.parallelTypes();
  const pending=new Set(['queued','running','awaiting-approval']);
  // A tool that settles without a receipt gets one of two recorded outcomes.
  // "unknown": it was dispatched (or a provider reported it running), so it may
  // have taken effect; it must be verified and is never replayed automatically.
  // "not-started": it never ran. Without local knowledge, a saved "running"
  // record counts as dispatched: it is saved immediately before dispatch.
  // Reads and provider-run tools cannot change local data, so a missing
  // receipt only means the read failed; there is nothing to verify.
  // Opening a panel or reading a page is not an effect to verify either. Any
  // type not listed here (terminal, browser_click/type, future tools) is
  // treated as able to act.
  const viewOnly=Tools.viewTypes();
  const readOnly=call=>reads.has(call?.type)||viewOnly.has(call?.type)||String(call?.id||'').startsWith('provider:');
  const LEGACY_UNRECEIVED='未收到工具完成结果，请核对执行记录。';
  const UNKNOWN_TEXT='已发出请求但未收到结果，无法确认是否已执行。请核对实际效果；不会自动重跑。';
  const NOT_STARTED_TEXT='尚未开始执行，没有产生效果。';
  function unreceived(entry,status,{dispatched=!!entry.dispatchedAt||entry.status==='running',reason}={}){
    entry.status=status;entry.finishedAt=Date.now();
    if(!dispatched){entry.outcome='not-started';entry.error=reason||NOT_STARTED_TEXT;}
    else if(!readOnly(entry)){entry.outcome='unknown';entry.error=UNKNOWN_TEXT;}
    else entry.error=LEGACY_UNRECEIVED;
  }
  const clone=x=>JSON.parse(JSON.stringify(x));
  const cancelled=()=>Object.assign(Error('已停止工具执行'),{code:'CANCELLED'});
  const label=Tools.label;
  const safeRequest=Tools.safeRequest;
  function resultSnapshot(value){
    // Model context is bounded separately by KnowledgeAccess. The durable
    // execution record must retain received text, including long tool output.
    const {blocks,...data}=value||{};
    return {result:data,truncated:false};
  }
  function create({run,execute,signal,checkpoint=async()=>{},changed=()=>{},validate=()=>{},concurrency=3,parentId=null}){
    run.toolCalls ||= []; let serial=Promise.resolve();
    // Freeze authority from the host run, never from provider-supplied fields.
    // Navigation may change independently; it is not this request's owner.
    const quickOwner={runId:run.id,conversationId:run.conversationId,projectId:run.projectId||null,workspace:run.contextWorkspace,userMessageId:run.userMessageId};
    const openQuickPanel=async(request,entry)=>{
      if(parentId)return {type:'quick_panel_open',status:'denied',opened:false,reason:'subagent_not_authorized'};
      if(!root.workstationDesktop?.quickPanel?.request)return {type:'quick_panel_open',status:'unsupported',opened:false,reason:'native_unavailable'};
      const {type,...destination}=request;
      return root.workstationDesktop.quickPanel.request({...destination,owner:{...quickOwner,toolCallId:entry.id}},{signal});
    };
    // Saves are ordered even while independent network/file reads overlap.
    const persist=()=>{changed();const next=serial.then(checkpoint);serial=next.catch(()=>{});return next;};
    const check=()=>{if(signal?.aborted)throw cancelled();validate();};
    async function batch(requests){
      check();if(!Array.isArray(requests)||requests.length>32)throw Error('每批最多 32 个工具请求，请分批继续。');
      // 空转预警：同一工具用相同参数被反复调用时先停下来，把"要不要继续"交回用户。
      // 判据是机械的（参数逐字相同 + 计数达阈值），参数变化的分页读取不会被误伤。
      const guard=root.ToolLoopGuard?.inspect(run.toolCalls.filter(call=>(call.parentId||null)===(parentId||null)),undefined,requests);
      if(guard&&guard.repeated.length){const item=guard.repeated[0];throw Object.assign(Error(root.ToolLoopGuard.describe(item,guard.limit)),{code:'REPEATED_TOOL',toolType:item.type,toolCount:item.count});}
      // Before that stop, warn the model on the result it receives (not on the
      // durable record) so it can change course while calls are still allowed.
      const Guard=root.ToolLoopGuard,prior=Guard?.reminder?Guard.tally(run.toolCalls.filter(call=>(call.parentId||null)===(parentId||null))):null;
      const notices=requests.map(request=>prior?Guard.reminder(request,prior.get(Guard.signature(request))?.count||0,Guard.LIMIT):'');
      const entries=requests.map(request=>{if(!request||typeof request.type!=='string')throw Error('无效工具请求');return {id:'tool_'+Date.now()+'_'+Math.random().toString(36).slice(2),parentId,type:request.type,request:safeRequest(request),status:'queued',createdAt:Date.now()};});
      // A control or persistence failure stops this batch, including workers
      // already waiting for their pre-execution checkpoint. Received results
      // still pass through save(), so stopping never discards a tool receipt.
      let stopped;
      const stop=error=>{stopped ||= error;};
      const checkBatch=()=>{if(stopped)throw stopped;try{check();}catch(error){stop(error);throw error;}};
      const save=async()=>{try{await persist();}catch(error){stop(error);throw error;}};
      run.toolCalls.push(...entries);try{await save();checkBatch();}catch(error){for(const entry of entries)unreceived(entry,error.code==='CANCELLED'||signal?.aborted?'cancelled':'failed',{dispatched:false,reason:error.message});throw error;}const results=new Array(entries.length);
      async function invoke(i){
        const entry=entries[i];
        try{
          checkBatch();entry.status='running';entry.startedAt=Date.now();await save();checkBatch();
          let result,received=false;entry.dispatchedAt=Date.now();
          // Only an execute rejection is an ordinary tool failure. Scope checks
          // and durable-save failures must escape and stop later operations.
          try{result=await (entry.type==='quick_panel_open'?openQuickPanel(clone(entry.request),entry):execute(clone(entry.request),{signal,entry}));received=true;}
          catch(error){entry.status=error.code==='CANCELLED'||signal?.aborted?'cancelled':'failed';entry.error=error.message;const code=typeof error.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)?error.code:undefined;if(code)entry.errorCode=code;if(typeof error.reason==='string')entry.reason=error.reason;results[i]={error:error.message,...(code?{code}:{}),...(typeof error.recoveryHint==='string'?{recoveryHint:error.recoveryHint.slice(0,1200)}:{})};if(error.code==='CANCELLED')stop(error);}
          if(received){
            const value=result||{};
            Object.assign(entry,resultSnapshot(value));results[i]=value;
            entry.status=['cancelled','rejected'].includes(value.status)?'cancelled':value.error||['failed','timed_out','interrupted'].includes(value.status)?'failed':'completed';
          }
          if(notices[i]&&results[i]&&typeof results[i]==='object')results[i]={...results[i],loopNotice:notices[i]};
        }catch(error){stop(error);if(pending.has(entry.status))unreceived(entry,error.code==='CANCELLED'||signal?.aborted?'cancelled':'failed',{dispatched:!!entry.dispatchedAt,reason:error.message});throw error;}
        finally{entry.finishedAt=Date.now();await save();}
        // Persist the authoritative returned outcome before honoring a stop or
        // scope change. Cancellation is not evidence that effects rolled back.
        checkBatch();
      }
      try{
        let start=0;
        while(start<entries.length){
          checkBatch();if(!parallel.has(entries[start].type)){await invoke(start++);continue;}
          let end=start;while(end<entries.length&&parallel.has(entries[end].type))end++;
          let cursor=start;const workers=Array.from({length:Math.min(Math.max(1,concurrency),end-start)},async()=>{while(cursor<end){checkBatch();const i=cursor++;await invoke(i);}});
          const settled=await Promise.allSettled(workers);const failure=settled.find(x=>x.status==='rejected');if(failure)throw failure.reason;start=end;
        }
        return results;
      }finally{
        for(const entry of entries)if(pending.has(entry.status))unreceived(entry,'cancelled',{dispatched:!!entry.dispatchedAt,reason:'本批中止，未执行。'});
        await save();
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
  function finish(run,status){for(const entry of run.toolCalls||[])if(pending.has(entry.status))unreceived(entry,status==='cancelled'?'cancelled':'interrupted');}
  function recover(state,instanceId){
    if(!instanceId)return false;let changed=false;
    for(const run of state.agentRuns||[])if(run.status==='running'&&run.executionInstanceId&&run.executionInstanceId!==instanceId){
      run.status='interrupted';run.error='上次执行随本机服务结束而中断。已保存的输出保留，请核对后继续。';run.finishedAt=Date.now();finish(run,'interrupted');
      for(const child of run.delegations||[])if(pending.has(child.status)){child.status='interrupted';child.finishedAt=Date.now();}
      for(const step of run.steps||[])if(step.status==='running')step.status='interrupted';
      const c=(state.conversations||[]).find(x=>x.id===run.conversationId);const m=c?.messages?.find(x=>x.runId===run.id);
      if(m){m.live=false;m.runStatus='interrupted';m.retryRunId=run.id;m.text=(m.text||'')+'\n\n'+run.error;
        if(m.conversationFlow?.version===1)root.ConversationFlow?.create(m).finish('interrupted');
      }
      changed=true;
    }return changed;
  }
  // A deliberate stop/decline is not a failed tool. Historical timeouts and
  // interruptions still deserve an inspectable issue even if the run recovered.
  // One reading of every tool record's effect. Records saved before outcomes
  // were kept only say "interrupted"; for a tool that can act that cannot
  // prove it never ran, so it reads as unknown. Read-only tools have no
  // effect to doubt: without a receipt they simply failed.
  function outcome(call){
    const status=call?.status;
    if(pending.has(status))return 'pending';
    if(['unknown','not-started'].includes(call?.outcome))return call.outcome;
    if(status==='completed')return 'completed';
    if(['failed','timed_out'].includes(status))return 'failed';
    // Earlier versions marked a stopped run's unanswered tools cancelled with
    // this exact host text; that was not the tool reporting a cancellation.
    if(['cancelled','rejected'].includes(status))return !readOnly(call)&&call?.error===LEGACY_UNRECEIVED?'unknown':'cancelled';
    return readOnly(call)?'failed':'unknown';
  }
  const unconfirmed=run=>(run?.toolCalls||[]).filter(call=>outcome(call)==='unknown');
  const isIssue=call=>['failed','interrupted','timed_out'].includes(call?.status)||outcome(call)==='unknown';
  const issueCount=run=>(run?.toolCalls||[]).filter(isIssue).length;
  const issueText=call=>{
    const result=call?.result?.result??call?.result;
    return typeof call?.error==='string'?call.error:typeof result?.error==='string'?result.error:'';
  };
  const textFields=new WeakMap();
  const textKey=(run,call,part,key)=>'text:'+JSON.stringify([String(run.id||''),String(call.id),part,key]);
  function linkedCommand(run,call){
    if(call.type!=='terminal'||!call.id||call.result!==undefined&&call.result!==null||!Array.isArray(run?.commands))return null;
    const matches=run.commands.filter(command=>command.toolCallId===call.id);return matches.length===1?matches[0]:null;
  }
  const resultData=(call,run)=>{
    if(call.result!==undefined&&call.result!==null)return typeof call.result==='object'&&call.result.result!==undefined?call.result.result:call.result;
    const command=linkedCommand(run,call);
    return command?Object.fromEntries(['argv','cwd','displayCwd','status','exitCode','stdout','stderr','output','truncated','error','cleanupWarning'].filter(key=>command[key]!==undefined).map(key=>[key,command[key]])):call.result;
  };
  // Display argv as a POSIX-quoted command without ever executing or rewriting it.
  const shellArg=value=>/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)?value:"'"+value.replace(/'/g,"'\"'\"'")+"'";
  const errorData=call=>Object.fromEntries(['error','errorCode','reason'].filter(key=>typeof call[key]==='string').map(key=>[key,call[key]]));
  function agendaDate(value,timeZone){
    if(typeof value!=='number'||!Number.isFinite(value))return value===undefined||value===null?'—':String(value);
    const date=new Date(value);if(!Number.isFinite(date.getTime()))return String(value);
    if(typeof timeZone==='string'&&timeZone){try{
      const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).map(part=>[part.type,part.value]));
      return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${timeZone}`;
    }catch{}}
    return date.toISOString();
  }
  function displayField(call,part,key,value,en){
    if(call.type==='terminal'&&key==='argv'&&Array.isArray(value)&&value.every(arg=>typeof arg==='string'))return value.map(shellArg).join(' ');
    if(call.type==='agenda_list'&&part==='result'&&key==='entries'&&Array.isArray(value)){
      const result=resultData(call);
      if(!value.length){
        if(call.status!=='completed'||result?.error||['deferred','failed','timed_out','interrupted'].includes(result?.status))return en?'No agenda entries were returned; the query did not complete.':'未返回日程条目；查询未完成。';
        if(result?.total===0)return en?'No matching events in this query scope.':'当前查询范围内没有匹配日程。';
        return en?'No events on this page.':'本页没有日程。';
      }
      return value.map((event,index)=>{
        if(!event||typeof event!=='object')return `${index+1}. ${JSON.stringify(event)}`;
        const title=typeof event.title==='string'&&event.title?event.title:(en?'Title not provided':'未提供标题');
        const start=event.occurrenceStart??event.start,end=event.occurrenceEnd??event.end;
        return `${index+1}. ${title}${event.allDay===true?(en?' · All day':' · 全天'):''}\n${en?'Start':'开始'}: ${agendaDate(start,event.timeZone)}\n${en?'End':'结束'}: ${agendaDate(end,event.timeZone)}`+(typeof event.location==='string'&&event.location?'\n'+(en?'Location: ':'地点：')+event.location:'');
      }).join('\n\n');
    }
    return value;
  }
  const isLongText=value=>typeof value==='string'&&value.length>300;
  const fieldKeys=value=>value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value).filter(key=>value[key]!==undefined&&value[key]!==null).slice(0,24):[];
  function inspectingText(run,call){
    return [['parameters',call.request],['result',resultData(call,run)],['error',errorData(call)]].some(([part,value])=>
      fieldKeys(value).some(key=>isLongText(displayField(call,part,key,value[key],root.WorkstationI18n?.getLanguage?.()==='en'))&&run.toolLedgerPins?.[textKey(run,call,part,key)]===true));
  }
  const inspectingCall=(run,call)=>run.toolLedgerPins?.[call.id]===true||run.toolLedgerPins?.['raw:'+call.id]===true||inspectingText(run,call);
  function materializeText(node,open){
    const data=textFields.get(node);if(!data)return;
    let body=node.querySelector(':scope > .tool-ledger-full-text');
    if(!open){body?.remove();return;}
    if(!body){body=root.document.createElement('pre');body.className='tool-ledger-text tool-ledger-full-text';body.dataset.liveKey='full-text';body.tabIndex=0;node.append(body);}
    body.setAttribute('aria-label',data.label);
    if(body.textContent!==data.text)body.textContent=data.text;
  }
  // The incremental renderer retains these disclosure nodes. Transfer the
  // current payload before comparing DOM, even when a closed preview is equal.
  // Data is kept outside attributes/DOM and is released with its owning node.
  function prepareText(previous,next,{keepOpen=()=>false}={}){
    // Equal ancestors can skip their entire subtree during patching. Reconcile
    // payload ownership first, not only after diffing reaches the field itself.
    const fields=new Map([...previous.querySelectorAll('.tool-ledger-text-field')].map(node=>[node.dataset.toolLedgerKey,node]));
    for(const field of next.querySelectorAll('.tool-ledger-text-field')){
      const current=fields.get(field.dataset.toolLedgerKey),data=textFields.get(field);
      if(!current||!data)continue;
      textFields.set(current,data);
      if(keepOpen(current,field)||(current._interactionDesiredOpen!==undefined&&current.open))field.open=true;
      materializeText(field,field.open);
    }
  }
  function bindLedgerKeyboard(box){
    box.addEventListener('keydown',event=>{
      if(event.defaultPrevented||event.repeat||event.isComposing||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey)return;
      const summary=event.target?.closest?.('summary');
      if(event.key==='Enter'&&summary===event.target&&box.contains(summary)){
        event.preventDefault();summary.click();return;
      }
      if(event.key!=='Escape')return;
      const field=event.target?.closest?.('.tool-ledger-text-field');
      if(!field||!box.contains(field)||!(field._interactionDesiredOpen??field.open))return;
      const trigger=field.querySelector(':scope > summary');
      event.preventDefault();event.stopPropagation();trigger.click();
      if(trigger.isConnected)trigger.focus({preventScroll:true});
    });
  }
  function card(run,{embedded=false,callIds}={}){
    if(!run?.toolCalls?.length||!root.document)return null;
    const requested=Array.isArray(callIds)?new Set(callIds):null;
    const calls=requested?run.toolCalls.filter(call=>requested.has(call.id)):run.toolCalls;
    if(!calls.length)return null;
    const el=(tag,text,cls)=>{const x=root.document.createElement(tag);if(text!==undefined)x.textContent=text;if(cls)x.className=cls;return x;};
    const en=root.WorkstationI18n?.getLanguage?.()==='en';
    // 工具记录与过程段一样“呼吸”：本轮未结束时自动展开（能实时看到正在调用什么工具、
    // 参数与结果），进入终态后自动收敛成一行摘要，把正文让给最终答案。用户手动开合过的
    // 以用户为准（run.toolLedgerPins）——流式重绘与完成收束都不会覆盖它。
    const settled=['completed','cancelled','rejected','failed','interrupted','awaiting-approval'].includes(run.status);
    const live=!settled&&!run.finishedAt;
    const picked=(key,auto)=>{const pins=run.toolLedgerPins;return pins&&Object.prototype.hasOwnProperty.call(pins,key)?pins[key]===true:!!auto;};
    const inspectingRaw=calls.some(call=>picked('raw:'+call.id,false)||inspectingText(run,call));
    // A conversation process panel already owns the outer disclosure. Keep
    // standalone cards unchanged for run history and other existing callers.
    const box=el(embedded?'div':'details',undefined,embedded?'tool-ledger tool-ledger-embedded':'tool-ledger message-steps');
    bindLedgerKeyboard(box);
    if(!embedded){if(picked('ledger',live||inspectingRaw))box.open=true;box.append(el('summary',(en?'Tool history · ':'工具执行记录 · ')+calls.length));}
    const names=en?{queued:'Queued',running:'Running',completed:'Completed',failed:'Failed',cancelled:'Cancelled',interrupted:'Interrupted',timed_out:'Timed out'}:{queued:'等待',running:'进行中',completed:'完成',failed:'失败',cancelled:'已停止',interrupted:'已中断',timed_out:'超时'};
    // 人类可读优先：参数与结果以键值行呈现，长文本字段（正文/摘要/说明）完整成块；
    // 原始 JSON 一律收进“查看原始数据”二级折叠——可核查性不变，但不再整屏灌 JSON。
    const BODY=new Set(['content','text','markdown','body','output','stdout','stderr','nextStep','summary','excerpt','abstract','chapter']);
    const shown=value=>{if(value===undefined||value===null)return'';if(typeof value==='string')return value;if(typeof value==='number'||typeof value==='boolean')return String(value);try{const raw=JSON.stringify(value);return raw.length>200?raw.slice(0,200)+' …':raw;}catch(_){return String(value);}};
    const list=(row,caption,value,part,call)=>{
      if(!value||typeof value!=='object'||Array.isArray(value))return;
      const keys=Object.keys(value).filter(key=>value[key]!==undefined&&value[key]!==null);
      if(!keys.length)return;
      const block=el('div',undefined,'tool-ledger-block');
      block.dataset.liveKey=part;
      block.append(el('div',caption,'tool-ledger-caption'));
      for(const key of keys.slice(0,24)){
        const formatted=displayField(call,part,key,value[key],en);
        const terminal=call.type==='terminal',agenda=call.type==='agenda_list'&&part==='result'&&key==='entries';
        const names=terminal?(en?{argv:'Command (argv)',cwd:'Working directory (cwd)',displayCwd:'Resolved working directory',exitCode:'Exit code',output:'Command output',stdout:'Standard output (stdout)',stderr:'Standard error (stderr)'}:{argv:'命令（argv）',cwd:'工作目录（cwd）',displayCwd:'实际工作目录',exitCode:'退出码',output:'命令输出',stdout:'标准输出（stdout）',stderr:'标准错误（stderr）'}):{};
        const keyLabel=names[key]||(agenda?(en?'Events':'日程'):(['error','errorCode','reason'].includes(key)?(en?{error:'Error',errorCode:'Error code',reason:'Reason'}:{error:'错误',errorCode:'错误代码',reason:'原因'})[key]:key));
        const text=formatted===''&&terminal&&['cwd','output','stdout','stderr'].includes(key)?(en?'(empty)':'（空）'):shown(formatted);
        if(!text)continue;
        if(isLongText(formatted)){
          const field=el('details',undefined,'tool-ledger-text-field');
          field.dataset.toolLedgerKey=textKey(run,call,part,key);
          textFields.set(field,{text:formatted,label:caption+' · '+keyLabel});
          const trigger=el('summary');
          trigger.append(el('span',keyLabel,'tool-ledger-field-name'),el('span',agenda?(en?'Show all events':'查看全部日程'):(en?'Show full text':'查看全文'),'tool-ledger-expand-label'),el('span',en?'Collapse text':'收起全文','tool-ledger-collapse-label'));
          // Avoid splitting a surrogate pair in the short, explicitly labelled preview.
          const end=/[\uD800-\uDBFF]/.test(text[299])?299:300;
          trigger.append(el('span',text.slice(0,end)+' …','tool-ledger-text-preview'));field.append(trigger);
          field.open=picked(field.dataset.toolLedgerKey,false);
          materializeText(field,field.open);
          field.addEventListener('click',event=>{
            if(event.target?.closest?.('summary')!==trigger||event.defaultPrevented)return;
            // Mount before the shared disclosure animation measures its target.
            // Keep content through closing motion; toggle releases it on close.
            if(!(field._interactionDesiredOpen??field.open))materializeText(field,true);
          });
          field.addEventListener('toggle',()=>materializeText(field,field.open));
          block.append(field);continue;
        }
        if(agenda||terminal&&['argv','output','stdout','stderr'].includes(key)){
          const evidence=el('div',undefined,'tool-ledger-evidence');evidence.append(el('div',keyLabel,'tool-ledger-key'),el('pre',text,'tool-ledger-text'));block.append(evidence);continue;
        }
        if(BODY.has(key)&&typeof value[key]==='string'&&text.length>120){block.append(el('pre',text,'tool-ledger-text'));continue;}
        const line=el('div',undefined,'tool-ledger-line');
        line.append(el('span',keyLabel+'：','tool-ledger-key'),el('span',text.length>300?text.slice(0,300)+' …':text));
        block.append(line);
      }
      if(keys.length>24)block.append(el('div',en?`… ${keys.length-24} more fields`:`…另有 ${keys.length-24} 项`,'tool-ledger-line'));
      row.append(block);
    };
    for(const call of calls){const row=el('details',undefined,'tool-ledger-row');row.dataset.toolId=call.id;row.dataset.toolStatus=call.status||'unknown';row.dataset.toolIssue=String(isIssue(call));
      if(picked(call.id,(live&&call.status==='running')||picked('raw:'+call.id,false)||inspectingText(run,call)))row.open=true;
      const data=resultData(call,run);
      const subject=call.request?.title||data?.title||call.request?.query||call.request?.name||call.request?.id||'';
      const title=[(en?call.type:label(call.type))||(en?'Tool operation':'工具操作'),subject].filter(Boolean).join(' · ');
      const heading=el('summary');
      const stateKey=call.outcome==='not-started'?'not-started':call.status&&outcome(call)==='unknown'?'unknown':call.status||'unconfirmed';const titleNode=el('span',`${call.parentId?'↳ ':''}${title}`,'tool-ledger-title');// The status stays in the title text for assistive technology and copying; a timeline marker may present it visually.
      const stateNode=el('span',` · ${call.outcome==='not-started'?(en?'Not started':'未执行'):call.status&&outcome(call)==='unknown'?(en?'Outcome unknown':'结果未知'):names[call.status]||(en?'Unconfirmed':'未确认')}`,'tool-ledger-state');stateNode.dataset.state=stateKey;titleNode.append(stateNode);heading.append(titleNode);
      if(isIssue(call)&&issueText(call))heading.append(el('span',issueText(call),'tool-ledger-error-preview'));
      row.append(heading);
      list(row,en?'Parameters':'参数',call.request,'parameters',call);
      list(row,en?'Result':'结果',data,'result',call);
      list(row,en?'Error details':'错误详情',errorData(call),'error',call);
      if(call.summary)row.append(el('p',call.summary));if(call.type==='terminal'&&data?.truncated===true)row.append(el('p',en?'Recorded command output was truncated at the source.':'已记录的命令输出在来源处被截断。','tool-ledger-notice'));if(call.truncated)row.append(el('p',en?'History preview truncated; original tool pagination remains available.':'日志预览已截断；原工具仍可分页读取。'));
      const raw=el('details',undefined,'tool-ledger-raw');
      raw.dataset.toolLedgerKey='raw:'+call.id;
      if(picked(raw.dataset.toolLedgerKey,false))raw.open=true;
      raw.append(el('summary',en?'Raw data':'查看原始数据'));
      raw.append(el('pre',JSON.stringify(call.request,null,2)));
      if(call.result)raw.append(el('pre',JSON.stringify(call.result,null,2)));
      else{const command=linkedCommand(run,call);if(command){raw.append(el('div',en?'Linked command record':'关联命令记录','tool-ledger-caption'));raw.append(el('pre',JSON.stringify(command,null,2)));}}
      const errors=errorData(call);if(Object.keys(errors).length)raw.append(el('pre',JSON.stringify(errors,null,2)));
      row.append(raw);
      box.append(row);
    }return box;
  }
  return {create,provider,finish,recover,outcome,unconfirmed,card,safeRequest,resultSnapshot,isIssue,issueCount,inspectingCall,prepareText};
});
