/* Commands are immutable server proposals. Models cannot approve or start them. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.TerminalTools=api;})(globalThis,root=>{
 'use strict';const F=root.FileContext||(typeof require==='function'?require('./file-context.js'):null);let hooks;const active=new Map();
 const t=(zh,en)=>root.WorkstationI18n?.getLanguage?.()==='en'?en:zh;
 const label=s=>({pending:t('等待命令审批','Awaiting approval'),running:t('命令执行中','Running'),succeeded:t('执行成功','Succeeded'),failed:t('执行失败','Failed'),cancelled:t('已停止 / 拒绝','Stopped / denied'),timed_out:t('执行超时','Timed out'),interrupted:t('执行中断，请核对实际效果','Interrupted; verify effects')})[s]||s;
 function payload(request,state,run){const project=state.projects.find(p=>F.active(p)&&p.id===run.projectId&&p.localFolder?.id);if(!project)throw Error(t('终端命令需要当前对话连接本机项目目录。','Connect the conversation project to a local folder first.'));if(!Array.isArray(request.argv)||!request.argv.length||request.argv.some(x=>typeof x!=='string'))throw Error('argv must be an array of strings');return {candidateId:project.localFolder.id,projectId:project.id,runId:run.id,argv:request.argv,cwd:request.cwd||'',timeout:request.timeout??60};}
 const el=(tag,cls,text)=>{const e=root.document.createElement(tag);e.className=cls||'';if(text!==undefined)e.textContent=text;return e;};
 const button=(text,fn)=>{const b=el('button','secondary',text);b.type='button';b.onclick=fn;return b;};
 const request=(action,data,signal)=>F.request('/__local/commands/'+action,data,signal);
 function card(run){
  if(!run?.commands?.length)return null;const box=el('section','command-card');box.setAttribute('aria-label',t('命令执行记录','Command history'));
  for(const command of run.commands){const item=el('div','command-entry');item.dataset.commandId=command.id;const summary=el('header');summary.append(el('strong','',label(command.status)),el('span','muted',command.exitCode==null?'':t('退出码 ','Exit ')+command.exitCode));item.append(summary);
   item.append(el('pre','command-argv',command.argv.map(x=>JSON.stringify(x)).join(' ')),el('p','command-directory',command.displayCwd));
   if(command.status==='pending')item.append(el('p','command-notice',t(`以你的本机权限运行，不是沙箱。可能修改文件或联网；输出会送入当前 AI 对话。超时 ${command.timeout} 秒。`,`Runs with your local privileges, without a sandbox. May modify files or access the network. Output is sent to this AI conversation. Timeout: ${command.timeout}s.`)));
   const actions=el('div','command-actions');const gate=active.get(command.id);
   const act=async(action,remember=false)=>{try{actions.querySelectorAll('button').forEach(b=>b.disabled=true);if(['start'].includes(action)){if(!gate||gate.signal?.aborted||run.status!=='running')throw Error(t('此请求已结束，请重新发起。','This request ended. Start a new turn.'));if(payload(command,hooks.getState(),run).candidateId!==command.candidateId)throw Error(t('项目连接已变化，请重新提出命令。','The project connection changed. Request a new command.'));}Object.assign(command,await request(action,{id:command.id,remember}));if(action==='forget')for(const r of hooks.getState().agentRuns)for(const c of r.commands||[])if(c.candidateId===command.candidateId&&c.cwd===command.cwd&&JSON.stringify(c.argv)===JSON.stringify(command.argv))c.trusted=false;hooks.save();gate?.refresh();gate?.wake?.();if(!gate)hooks.render();}catch(e){hooks.toast(e.message);actions.querySelectorAll('button').forEach(b=>b.disabled=false);}};
   if(command.status==='pending'&&gate){const allow=button(t('执行此次命令','Run once'),()=>act('start'));allow.dataset.commandAction='start';actions.append(allow);if(command.rememberable){const remember=button(t('允许并记住此只读命令','Allow and remember this check'),()=>act('start',true));remember.dataset.commandAction='remember';actions.append(remember);}const deny=button(t('拒绝','Deny'),()=>act('deny'));deny.dataset.commandAction='deny';actions.append(deny);}
   if(command.status==='running'){const stop=button(t('停止命令','Stop command'),()=>act('cancel'));stop.dataset.commandAction='cancel';actions.append(stop);}
   if(command.trusted){const forget=button(t('撤销此命令白名单','Forget this allowed command'),()=>act('forget'));forget.dataset.commandAction='forget';actions.append(forget);}
   item.append(actions);
   if(command.startedAt)item.append(el('p','command-notice',t('此命令已在本机执行：其效果不会随本轮的文件撤销回滚。','This command ran on your machine; undoing this turn does not revert its effects.')));
   if(command.cleanupWarning)item.append(el('p','command-notice',t('主进程已退出，但无法确认其余子进程是否已停止。','The main process exited, but remaining child processes could not be confirmed stopped.')));
   if(command.output||command.error){const details=el('details','command-output'),title=el('summary','',t('命令输出','Command output')+(command.truncated?t(' · 已截断',' · truncated'):''));details.open=command.status==='running';details.append(title,el('pre','',command.output||command.error));item.append(details);}box.append(item);
  }return box;
 }
 async function execute(req,state,run,{signal,refresh,save,toolCallId}){
  if((run.commands||[]).length>=8)throw Error(t('本轮已达到 8 次命令，请检查结果后继续对话。','Review this turn’s 8 commands before continuing.'));
  if(signal?.aborted)throw Object.assign(Error('Stopped'),{code:'CANCELLED'});
  const command=await request('propose',payload(req,state,run));
  // Link only the host scheduler's immutable call id; never infer by argv/time.
  if(typeof toolCallId==='string'&&toolCallId)command.toolCallId=toolCallId;
  (run.commands||=[]).push(command);
  let wake,delay=350,cancellation;
  const publish=result=>{let changed=false;for(const [key,value] of Object.entries(result||{})){if(JSON.stringify(command[key])!==JSON.stringify(value)){command[key]=value;changed=true;}}if(changed){save();refresh();}return changed;};
  // Quiet processes remain live. Back off only observation, never restart work,
  // and wake immediately on stop or a user approval instead of waiting 2s.
  const pollWait=ms=>new Promise(resolve=>{let timer;const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);if(wake===done)wake=null;resolve();};wake=done;timer=setTimeout(done,ms);signal?.addEventListener('abort',done,{once:true});if(signal?.aborted)done();});
  active.set(command.id,{signal,refresh,wake:()=>{delay=350;wake?.();}});save();refresh();
  const cancel=()=>cancellation||(cancellation=request('cancel',{id:command.id}).then(publish).catch(()=>{}));signal?.addEventListener('abort',cancel,{once:true});
  try{
   if(signal?.aborted){await cancel();throw Object.assign(Error('Stopped'),{code:'CANCELLED'});}
   if(payload(command,state,run).candidateId!==command.candidateId){await cancel();throw Error('Project connection changed');}
   if(command.trusted)publish(await request('start',{id:command.id,automatic:true}));
   while(['pending','running'].includes(command.status)){
    await pollWait(delay);
    if(signal?.aborted){await cancel();throw Object.assign(Error('Stopped'),{code:'CANCELLED'});}
    if(!state.projects.some(p=>F.active(p)&&p.id===command.projectId&&p.localFolder?.id===command.candidateId)||!state.conversations.some(c=>F.active(c)&&c.id===run.conversationId&&c.projectId===run.projectId)){await cancel();throw Object.assign(Error('命令所属项目或对话已变化。'),{code:'CANCELLED'});}
    // Always refresh from the authoritative process record; never infer success from elapsed time.
    const changed=publish(await request('get',{id:command.id},signal));
    delay=changed?350:Math.min(2000,Math.ceil(delay*1.6));
   }
   if(signal?.aborted){await cancel();throw Object.assign(Error('Stopped'),{code:'CANCELLED'});}
   return {type:'terminal',id:command.id,status:command.status,argv:command.argv,cwd:command.cwd,exitCode:command.exitCode,output:command.output,truncated:command.truncated,error:command.error||null,...(command.cleanupWarning?{cleanupWarning:command.cleanupWarning}:{})};
  }catch(error){if(signal?.aborted){await cancel();throw Object.assign(Error('Stopped'),{code:'CANCELLED'});}throw error;
  }finally{wake?.();signal?.removeEventListener('abort',cancel);active.delete(command.id);if(signal?.aborted||cancellation){try{for(let n=0;n<20;n++){publish(await request('get',{id:command.id}));if(!['pending','running'].includes(command.status))break;await new Promise(r=>setTimeout(r,100));}}catch{}}}
 }
 const reconciled=new Set();
 function reconcile(state){if(!hooks)return;for(const run of state.agentRuns||[])for(const c of run.commands||[])if(!active.has(c.id)&&!reconciled.has(c.id)){reconciled.add(c.id);request('get',{id:c.id}).then(result=>{Object.assign(c,result);hooks.save();hooks.render();}).catch(()=>{});}}
 return {payload,card,execute,reconcile,init(value){hooks=value;}};
});
