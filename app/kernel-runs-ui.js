/* Background runs in the main window (P8b). The headless kernel host never
   asks a person directly and never writes the workspace; both land here:
   - approvals: runs waiting for a person show up in a small "后台运行" panel
     (and as a native notification); 批准/拒绝 answers through
     /__kernel/runs/<id>/approvals/<id>. Only this window or the native shell
     may answer, never the client that started the run;
   - effects: writes a run was allowed to make are claimed from
     /__kernel/effects/claim and applied here through the same transactional
     core as the agent's own actions (WorkstationCore.applyPlan), then saved
     and acknowledged with a receipt. An item that already carries the call id
     is not created twice.
   - paused runs (P9b: the model's usage limit) stay in the panel with the
     reason and 继续 / 停止 until someone decides.
   Polls only while the page is hydrated; quiet when nothing is running.
   While a conversation runs here, the window tells the service (foreground
   hint), so scheduled runs wait their turn (never for long). */
(function(root){
  'use strict';
  const BUSY_MS=3000,QUIET_MS=10000;
  const T={title:'后台运行',approve:'批准',reject:'拒绝',cancel:'停止',resume:'继续',empty:'没有需要处理的后台运行',
    status:{queued:'排队中',running:'运行中','awaiting-approval':'待审批',paused:'已暂停',completed:'已完成',failed:'失败',cancelled:'已停止',interrupted:'已中断'},
    tools:{create_task:'新建任务',create_note:'新建笔记',mark_task_done:'标记完成'},sources:{scheduler:'计划任务',user:'主窗口',mobile:'手机',external:'本机客户端'},outOfScope:'超出任务声明的范围'};
  let runs=[],timer=null,open=false,applying=false,panel=null,button=null;
  const api=async(path,body)=>{
    const response=await root.fetch(path,{method:body===undefined?'GET':'POST',cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const value=await response.json().catch(()=>({}));
    if(!response.ok)throw Object.assign(Error(value.error||'后台运行服务不可用'),{code:value.code});
    return value;
  };
  const ready=()=>typeof storageHydrated!=='undefined'&&storageHydrated&&typeof state==='object'&&state;
  const pending=run=>(run.approvals||[]).filter(a=>a.status==='pending');
  const active=run=>['queued','running','awaiting-approval'].includes(run.status);

  // ---- effects: this window is the single writer -------------------------
  function actionFor(effect){
    const a=effect.args||{};
    if(effect.tool==='create_task')return {type:'create_task',title:a.title,...(a.due?{dueAt:a.due+'T09:00'}:{}),...(a.notes?{description:a.notes}:{})};
    if(effect.tool==='create_note')return {type:'create_note',title:a.title,content:String(a.content||'')+(Array.isArray(a.citations)&&a.citations.length?'\n\n引用：\n'+a.citations.map(c=>`> ${c.quote}${c.sourceId?`（${c.sourceId}）`:''}`).join('\n'):'')};
    throw Object.assign(Error('后台运行请求了不支持的写入：'+effect.tool),{code:'UNSUPPORTED'});
  }
  async function applyOne(effect){
    const marker=`kernel:${effect.runId}:${effect.id}`;
    const collection=effect.tool==='create_task'?state.tasks:state.notes;
    const existing=(collection||[]).find(item=>item.kernelCallId===marker);
    if(existing)return {ok:true,result:{id:existing.id,already:true}};
    const outcome=Core.applyPlan(state,[actionFor(effect)],{workspace:effect.workspace||undefined,projectId:effect.projectId||null,conversationId:null,runId:effect.runId,allowedTaskIds:[],allowedNoteIds:[],uid});
    const result=(outcome.results||[]).find(r=>['task','note'].includes(r.type));
    ['projects','tasks','notes','imports','attachments','links','papers'].forEach(key=>{if(outcome.state[key])state[key]=outcome.state[key];});
    const item=result&&(effect.tool==='create_task'?state.tasks:state.notes).find(x=>x.id===result.id);
    if(item){item.kernelCallId=marker;item.kernelRunId=effect.runId;if(effect.tool==='create_note'&&Array.isArray(effect.args?.citations))item.citations=effect.args.citations;}
    if(await saveDocumentDurably()===false)throw Object.assign(Error('保存失败'),{code:'SAVE_FAILED'});
    return {ok:true,result:{id:result?.id||null,operation:result?.operation||null}};
  }
  async function applyEffects(){
    if(applying||!ready()||!root.WorkstationCore?.applyPlan)return 0;
    applying=true;let count=0;
    try{
      const {effects}=await api('/__kernel/effects/claim',{});
      for(const effect of effects||[]){
        let receipt;
        try{receipt=await applyOne(effect);}
        catch(error){receipt={ok:false,code:error.code||'APPLY_FAILED',message:String(error.message||error).slice(0,300),outcome:'unknown'};}
        await api(`/__kernel/effects/${encodeURIComponent(effect.runId)}/${encodeURIComponent(effect.id)}/receipt`,{claimToken:effect.claimToken,receipt}).catch(()=>{});
        count++;
      }
      if(count&&typeof render==='function')try{render();}catch{}
    }catch{}finally{applying=false;}
    return count;
  }

  // ---- panel ------------------------------------------------------------
  function el(tag,cls,text){const x=document.createElement(tag);if(cls)x.className=cls;if(text!=null)x.textContent=text;return x;}
  function ensure(){
    if(button||!document.body)return;
    const style=el('style');style.textContent=`
#kernelRunsButton{position:fixed;right:18px;bottom:18px;z-index:2147483000;border:1px solid var(--line);background:var(--glass,var(--bg));color:var(--text,inherit);border-radius:16px;padding:6px 12px;font:inherit;font-size:12px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.12)}
#kernelRunsButton[data-attention="1"]{border-color:var(--color-warning,#c80);font-weight:600}
#kernelRunsPanel{position:fixed;right:18px;bottom:56px;z-index:2147483000;width:min(380px,calc(100vw - 36px));max-height:60vh;overflow:auto;border:1px solid var(--line);background:var(--bg,#fff);color:var(--text,inherit);border-radius:14px;padding:12px;box-shadow:0 12px 36px rgba(0,0,0,.18);font-size:13px}
#kernelRunsPanel h3{margin:0 0 8px;font-size:13px}
.kernel-run{border-top:1px solid var(--line);padding:8px 0}.kernel-run:first-of-type{border-top:0}
.kernel-run-meta{color:var(--muted,var(--faint));font-size:12px}
.kernel-approval{margin-top:6px;padding:8px;border-radius:10px;background:var(--accent-soft,rgba(0,0,0,.04))}
.kernel-approval pre{white-space:pre-wrap;word-break:break-all;margin:4px 0;font-size:12px;max-height:120px;overflow:auto}
.kernel-actions{display:flex;gap:6px;margin-top:6px}.kernel-actions button{font:inherit;font-size:12px;border-radius:10px;padding:3px 10px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer}
.kernel-actions button[data-decision="allowed-once"]{background:var(--accent-solid,#2a6);color:#fff;border-color:transparent}`;
    document.head.append(style);
    button=el('button',null,T.title);button.id='kernelRunsButton';button.type='button';button.hidden=true;
    button.onclick=()=>{open=!open;paint();};
    panel=el('section');panel.id='kernelRunsPanel';panel.hidden=true;panel.setAttribute('aria-label',T.title);
    panel.addEventListener('click',async event=>{
      const target=event.target.closest('button[data-run]');if(!target)return;
      target.disabled=true;
      try{
        if(target.dataset.decision)await api(`/__kernel/runs/${encodeURIComponent(target.dataset.run)}/approvals/${encodeURIComponent(target.dataset.approval)}`,{decision:target.dataset.decision});
        else if(target.dataset.cancel)await api(`/__kernel/runs/${encodeURIComponent(target.dataset.run)}/cancel`,{});
        else if(target.dataset.resume)await api(`/__kernel/runs/${encodeURIComponent(target.dataset.run)}/resume`,{});
      }catch(error){if(typeof toast==='function')toast(error.message);}
      await refresh();
    });
    document.body.append(button,panel);
  }
  function paint(){
    ensure();if(!button)return;
    const shown=runs.filter(run=>active(run)||run.status==='paused'||pending(run).length);
    const waiting=shown.reduce((n,run)=>n+pending(run).length+(run.status==='paused'?1:0),0);
    button.hidden=!shown.length;button.dataset.attention=waiting?'1':'0';
    const paused=shown.filter(run=>run.status==='paused').length,notes=[];
    if(waiting-paused)notes.push(`待审批 ${waiting-paused}`);
    if(paused)notes.push(`已暂停 ${paused}`);
    button.textContent=`${T.title} · ${notes.length?notes.join(' · '):shown.length}`;
    panel.hidden=!open||!shown.length;
    if(panel.hidden)return;
    panel.replaceChildren(el('h3',null,T.title));
    for(const run of shown){
      const box=el('div','kernel-run');box.dataset.runId=run.id;
      box.append(el('div',null,run.request?.title||run.id),el('div','kernel-run-meta',`${T.status[run.status]||run.status} · 来源：${T.sources[run.source?.kind]||run.source?.kind||'?'}`));
      for(const approval of pending(run)){
        const card=el('div','kernel-approval');card.dataset.approvalId=approval.id;
        card.append(el('div',null,`${T.tools[approval.tool]||approval.tool}${approval.destructive?'（不可撤销）':''}${(approval.reasons||[]).includes('out-of-scope')?' · '+T.outOfScope:''}`),el('pre',null,approval.summary||''));
        const actions=el('div','kernel-actions');
        for(const [decision,label] of [['allowed-once',T.approve],['rejected',T.reject]]){const b=el('button',null,label);b.type='button';b.dataset.run=run.id;b.dataset.approval=approval.id;b.dataset.decision=decision;actions.append(b);}
        card.append(actions);box.append(card);
      }
      if(run.status==='paused'){
        box.append(el('div','kernel-approval kernel-paused',run.pause?.message||T.status.paused));
        const actions=el('div','kernel-actions');
        for(const [key,label] of [['resume',T.resume],['cancel',T.cancel]]){const b=el('button',null,label);b.type='button';b.dataset.run=run.id;b.dataset[key]='1';actions.append(b);}
        box.append(actions);
      }else if(active(run)){const actions=el('div','kernel-actions'),b=el('button',null,T.cancel);b.type='button';b.dataset.run=run.id;b.dataset.cancel='1';actions.append(b);box.append(actions);}
      panel.append(box);
    }
  }
  async function refresh(){
    if(!ready())return;
    try{runs=(await api('/__kernel/runs?limit=20')).runs||[];}catch{runs=[];}
    paint();
  }
  const conversing=()=>typeof sendMessage==='function'&&!!(sendMessage.busy||sendMessage.preflight);
  async function tick(){
    clearTimeout(timer);
    try{if(ready()&&conversing())await api('/__kernel/foreground',{busy:true});}catch{}
    try{await refresh();if(runs.some(active))await applyEffects();}catch{}
    timer=setTimeout(tick,runs.some(active)?BUSY_MS:QUIET_MS);
  }
  // Native notification click → show the panel at that run.
  function show(runId){open=true;refresh().then(()=>panel?.querySelector(`[data-run-id="${CSS.escape(String(runId||''))}"]`)?.scrollIntoView({block:'nearest'}));}
  root.AIBroKernelRuns=Object.freeze({refresh,applyEffects,show,tick,get runs(){return runs.slice();}});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(tick,1500));else setTimeout(tick,1500);
})(globalThis);
