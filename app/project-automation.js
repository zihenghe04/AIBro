/* Durable schedules run through the same conversation, permission and memory path. */
(function(root){
 'use strict';let active=null,ticking=false;
 const t=(zh,en)=>/^en(?:-|$)/i.test(document.documentElement?.lang||'')?en:zh;
 const selectedSkills=job=>WorkstationSkillsCore.selectionIds(job).map(id=>WorkstationSkillsCore.get(state,id)).filter(Boolean);
 const persist=async()=>{if(await saveDocumentDurably()===false)throw Error(t('保存失败，请重试','Could not save. Please retry.'));};
 const request=async(action,data)=>{const response=await fetch('/__project/jobs'+(action?'/'+action:''),data?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{cache:'no-store'});const value=await response.json();if(!response.ok)throw Error(value.error||'自动任务服务不可用');return value;};
 const el=(tag,text,cls)=>{const x=document.createElement(tag);if(text!==undefined)x.textContent=text;if(cls)x.className=cls;return x;};
 const button=(text,fn)=>{const x=el('button',text,'secondary');x.type='button';x.onclick=fn;return x;};
 const stateLabel=s=>({active:'等待运行',running:'执行中',completed:'已完成',paused:'已暂停',deleted:'已归档',failed:'失败',cancelled:'已停止',interrupted:'已中断','awaiting-approval':'待审批'})[s]||s;
 // 实时执行详情：进行中的自动任务要能看到当前阶段与最近活动，而不是只有一行状态。
 function progressSummary(run,now){
  if(!run||!['running','awaiting-approval'].includes(run.status))return null;
  const waiting=run.status==='awaiting-approval';
  const steps=(run.steps||[]).filter(step=>step&&(step.text||step.label));
  const phase=(steps.filter(step=>step.status==='running').at(-1)||steps.at(-1));
  const elapsed=!waiting&&run.startedAt?(root.AgentProgress&&root.AgentProgress.duration?root.AgentProgress.duration(run.startedAt,Number.isFinite(now)?now:Date.now()):'')||'':'';
  const recent=(run.activities||[]).filter(item=>item&&(item.name||item.text)).slice(-3).reverse().map(item=>item.name||String(item.text).slice(0,40));
  return {waiting,phase:phase?String(phase.text||phase.label):'',elapsed,recent};
 }
 const modelEditing=()=>!!root.ConversationModels?.isSaving?.()||!!document.querySelector('#modelPicker:not([hidden])');
 function assertStartReady(requireIdle){
  if(modelEditing())throw Error(t('模型设置尚未完成，自动任务未启动；设置完成后可继续此任务。','Model settings are still being edited or saved. This automation did not start; resume it after finishing the settings.'));
  if(sendMessage.busy||sendMessage.preparingWiki||sendMessage.preflight||requireIdle&&!idle())throw Error(t('当前交互尚未结束，自动任务未启动；空闲后可继续此任务。','The app is no longer idle. This automation did not start; resume it when ready.'));
 }
 async function executeClaim(claim,{requireIdle=false}={}){
  const job=claim.job,lease={id:job.id,token:claim.token,valid:true};active=lease;let runId=null,poll,timer;
  try{
   // A claim is durable before its response reaches the UI. If the user began
   // editing meanwhile, finish with an explicit error; never resume a lease
   // automatically because that could undo a concurrent pause or archive.
   assertStartReady(requireIdle);
   const project=state.projects.find(p=>p.id===job.projectId&&p.workspace===job.workspace&&!p.archived&&!p.deletedAt);if(!project)throw Error('项目不可用');
   const chatId='auto_'+job.id;let chat=state.conversations.find(c=>c.id===chatId);const created=!chat;
   if(chat&&(chat.archived||chat.deletedAt))throw Error('自动任务的对话已归档，请恢复该对话后继续');
   if(!chat){chat={id:chatId,title:'自动任务 · '+job.name,titleEdited:true,messages:[],attachments:[],projectId:project.id,workspace:project.workspace,createdAt:Date.now(),updatedAt:Date.now()};state.conversations.push(chat);}
   if(chat.projectId!==project.id)throw Error('自动任务对话归属已变化');
   // The shared sendMessage path freezes enabled instructions at submission.
   // Disabled choices remain selected; deleted choices never return in a run.
   const previous={permissionMode:chat.permissionMode,skillId:chat.skillId,skillIds:chat.skillIds};
   const ids=selectedSkills(job).map(skill=>skill.id);
   chat.permissionMode=job.permissionMode;chat.skillId=ids[0]||null;chat.skillIds=ids;
   try{await persist();}catch(error){if(chat.skillIds===ids)Object.assign(chat,previous);if(created&&!chat.messages.length)state.conversations=state.conversations.filter(item=>item!==chat);throw error;}
   assertStartReady(requireIdle);
   timer=setTimeout(()=>{active.valid=false;stopCurrentRun();},Math.max(1,job.attempt.expiresAt*1000-Date.now()));
   poll=setInterval(async()=>{if(!active)return;try{const check=await request('check',{id:job.id,token:claim.token});if(active===lease&&!check.valid){lease.valid=false;stopCurrentRun();}}catch{if(active===lease){lease.valid=false;stopCurrentRun();}}},2000);
   const previousRuns=new Set(state.agentRuns.map(run=>run.id));
   await sendMessage({goal:job.prompt,conversationId:chat.id,background:true,automaticJobId:job.id,automaticAttemptId:job.attempt.id,declaredTools:job.scope?.tools||[]});
   const run=state.agentRuns.filter(r=>!previousRuns.has(r.id)&&r.automaticJobId===job.id&&r.automaticAttemptId===job.attempt.id).at(-1);runId=run?.id;
   if(!run)throw Error(t('发送前检查未通过，自动任务未启动；核对当前设置后可继续此任务。','Preflight did not start this automation. Review the current settings, then resume it.'));
   await persist();await request('finish',{id:job.id,token:claim.token,runId});
   toast('自动任务「'+job.name+'」'+stateLabel(run?.status||'failed')+'，可在项目会话中查看。');
  }catch(e){try{await request('finish',{id:job.id,token:claim.token,runId,error:e.message});}catch{}toast('自动任务已暂停：'+e.message);}
  finally{clearTimeout(timer);clearInterval(poll);active=null;}
 }
 function idle(){return storageHydrated&&!serverConflict&&!sendMessage.busy&&!sendMessage.preparingWiki&&!sendMessage.preflight&&!modelEditing()&&!importMaterials.busy&&!document.querySelector('dialog:modal')&&!$('#agentInput')?.value?.trim()&&!currentConversation()?.draftAttachmentIds?.length;}
 async function tick(){if(ticking||active||!idle())return;ticking=true;try{const {jobs}=await request('');const job=jobs.find(j=>j.status==='active'&&j.dueAt*1000<=Date.now()&&j.attempt?.status!=='running');if(!job||!idle())return;const claim=await request('claim',{id:job.id});if(claim.claimed)await executeClaim(claim,{requireIdle:true});}catch{}finally{ticking=false;}}
 function assertLease(run){if(run.automaticJobId&&run.status==='running'&&(!active?.valid||active.id!==run.automaticJobId))throw Object.assign(Error('自动任务已暂停、超时或权限记录变化'),{code:'CANCELLED'});}
 async function validateRun(run){if(!run.automaticJobId||run.status!=='running')return;assertLease(run);const result=await request('check',{id:active.id,token:active.token});if(!result.valid){active.valid=false;assertLease(run);}}
 async function open(project){
  let dialog=document.querySelector('#projectAutomationDialog');
  if(!dialog){dialog=el('dialog',undefined,'task-dialog');dialog.id='projectAutomationDialog';document.body.append(dialog);}
  if(dialog.open){dialog.focus();return;}
  for(const host of dialog.querySelectorAll('[data-halaska-root]'))root.HalaskaUI?.unmount(host);
  dialog.replaceChildren();dialog.setAttribute('aria-labelledby','projectAutomationTitle');
  let editing=null,saving=false,refreshing=false,interval=0,mode='legacy',skillIds=[];
  const heading=el('div',undefined,'dialog-header'),title=el('h2',t('项目自动任务','Project automations'));title.id='projectAutomationTitle';
  const close=button(t('关闭','Close'),()=>{if(!saving)dialog.close();});heading.append(title,close);dialog.append(heading);
  dialog.append(el('p',t('App 打开且空闲时运行。关闭期间错过的日程，下次打开补一次；中断或失败会暂停，核对结果后再继续。终端与文件写入仍使用原有审批。','Runs while the app is open and idle. Missed schedules run once next time. Interrupted or failed tasks pause for review; existing approval rules still apply.'),'muted'));
  const list=el('div',undefined,'automation-job-list');dialog.append(list);
  const form=el('form');form.id='projectAutomationForm';
  const name=el('input'),prompt=el('textarea'),date=el('input'),budget=el('input');
  name.name='name';prompt.name='prompt';date.name='dueAt';budget.name='budgetMinutes';name.required=true;prompt.required=true;date.required=true;
  name.placeholder=t('名称，例如每周研究回顾','Name, e.g. weekly research review');prompt.placeholder=t('具体目标、需要检查的资料与希望生成的结果','Goal, source materials and expected result');date.type='datetime-local';
  const defaultDate=()=>new Date(Date.now()+3600000-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16);
  date.value=defaultDate();budget.type='number';budget.min=1;budget.max=120;budget.value=15;
  const field=(label,input)=>{const row=el('label',undefined,'task-field');row.append(el('span',label),input);form.append(row);};
  field(t('名称','Name'),name);field(t('任务目标','Goal'),prompt);field(t('首次运行（本地时间）','First run (local time)'),date);field(t('最长运行分钟数','Time limit in minutes'),budget);
  const timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  form.append(el('p',t('每天／每周按本地钟点重复 · ','Daily / weekly at local clock time · ')+timeZone+t('。夏令时跳过的钟点顺延，重复钟点只运行一次。','. Skipped DST times move forward; repeated times run once.'),'muted'));
  const choices=(title,values,select,initial)=>{
   const row=el('div',undefined,'task-field automation-choice-row');row.append(el('strong',title));
   const buttons=values.map(([value,label])=>{const b=button(label,()=>{if(saving)return;buttons.forEach(x=>x.setAttribute('aria-pressed','false'));b.setAttribute('aria-pressed','true');select(value);});b.setAttribute('aria-pressed',String(value===initial));row.append(b);return b;});form.append(row);
   return value=>{buttons.forEach((b,i)=>b.setAttribute('aria-pressed',String(values[i][0]===value)));select(value);};
  };
  const selectInterval=choices(t('重复','Repeat'),[[0,t('单次','Once')],[1440,t('每天','Daily')],[10080,t('每周','Weekly')]],v=>interval=v,0);
  const selectMode=choices(t('权限','Permissions'),[['legacy',t('跟随空间设置','Use workspace settings')],['request',t('审批确认','Request approval')],['smart',t('自动执行，风险操作审批','Auto with risky actions approved')]],v=>mode=v,'legacy');
  const skillField=el('section',undefined,'automation-skills');skillField.setAttribute('aria-label',t('工作流 Skills，可多选','Workflow Skills, multiple selection'));
  const skillHeading=el('div',undefined,'automation-skills-heading');skillHeading.append(el('strong',t('工作流 Skills','Workflow Skills')));
  const clearHost=el('span');skillHeading.append(clearHost);skillField.append(skillHeading);
  const skillSummary=el('p','', 'muted automation-skills-summary');skillSummary.setAttribute('aria-live','polite');
  const chips=el('div',undefined,'automation-skill-chips'),catalog=el('div',undefined,'automation-skill-catalog');skillField.append(skillSummary,chips,catalog);form.append(skillField);
  const checks=new Map(),chipHosts=new Map();
  const mount=(host,component,props)=>{
   if(root.HalaskaUI)return root.HalaskaUI.mount(host,component,props);
   host.replaceChildren();if(component==='KitCheckbox'){const label=el('label'),input=el('input');input.type='checkbox';input.id=props.id;input.checked=props.checked;input.disabled=props.disabled;input.setAttribute('aria-label',props.label);input.onchange=()=>props.onChange(input.checked);label.append(input,el('span',props.label));host.append(label);}
   else{const control=button(props.children,props.onClick);control.disabled=props.disabled;control.setAttribute('aria-label',props['aria-label']||props.children);host.append(control);}
  };
  const updateSkills=()=>{
   const all=WorkstationSkillsCore.list(state),enabled=state.settings?.skillsEnabled!==false;
   const paused=skillIds.filter(id=>!enabled||WorkstationSkillsCore.get(state,id)?.enabled===false).length;
   skillSummary.textContent=skillIds.length?t('已选择 ','Selected ')+skillIds.length+t(' 项，按选择顺序使用',' skills, applied in selection order')+(paused?t(' · 已暂停 ',' · Paused ')+paused:''):t('可组合多个技能；不指定时按任务目标执行。','Combine skills, or leave empty to follow the goal.');
   for(const [id,host] of checks)if(!all.some(skill=>skill.id===id)){root.HalaskaUI?.unmount(host);host.parentElement.remove();checks.delete(id);}
   for(const skill of all){
    let host=checks.get(skill.id);if(!host){const row=el('div',undefined,'automation-skill-row');row.dataset.automationSkill=skill.id;host=el('div');row.append(host);if(skill.description)row.append(el('p',skill.description,'muted'));catalog.append(row);checks.set(skill.id,host);}
    const checked=skillIds.includes(skill.id),label=skill.name+(skill.enabled===false?t('（已停用）',' (disabled)'):'');
    mount(host,'KitCheckbox',{id:'automation-skill-'+skill.id,label,checked,disabled:saving||(skill.enabled===false&&!checked),onChange:checked=>{if(saving)return;skillIds=checked?[...skillIds,skill.id]:skillIds.filter(id=>id!==skill.id);updateSkills();}});
   }
   for(const [id,host] of chipHosts)if(!skillIds.includes(id)){root.HalaskaUI?.unmount(host);host.remove();chipHosts.delete(id);}
   for(const [index,id] of skillIds.entries()){
    const skill=WorkstationSkillsCore.get(state,id);let host=chipHosts.get(id);if(!host){host=el('span');host.dataset.automationSkillChip=id;chipHosts.set(id,host);}chips.append(host);
    mount(host,'Button',{size:'sm',variant:'secondary',children:(index+1)+'. '+(skill?.name||t('已删除技能','Deleted skill'))+' ×',disabled:saving,'aria-label':t('移除技能：','Remove skill: ')+(skill?.name||id),onClick:()=>{if(saving)return;skillIds=skillIds.filter(value=>value!==id);updateSkills();document.querySelector('#automation-skill-'+id)?.focus();}});
   }
   mount(clearHost,'Button',{size:'sm',variant:'ghost',children:t('清空','Clear'),disabled:saving||!skillIds.length,onClick:()=>{if(saving)return;skillIds=[];updateSkills();}});
  };
  const selectSkills=job=>{skillIds=selectedSkills(job).map(skill=>skill.id);updateSkills();};
  const saveButton=el('button',t('创建自动任务','Create automation'),'primary');saveButton.type='submit';
  const status=el('p','', 'automation-form-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const reset=()=>{editing=null;name.value='';prompt.value='';date.value=defaultDate();budget.value=15;selectInterval(0);selectMode('legacy');selectSkills({skillIds:[]});saveButton.textContent=t('创建自动任务','Create automation');};
  const cancel=button(t('取消编辑','Cancel edit'),()=>{if(!saving){reset();status.textContent='';}}),actions=el('div',undefined,'automation-form-actions');actions.append(saveButton,cancel);form.append(status,actions);dialog.append(form);
  const refresh=async()=>{
   if(refreshing||saving)return;refreshing=true;
   try{const {jobs}=await request('');if(!dialog.open||saving)return;list.replaceChildren();
    for(const job of jobs.filter(j=>j.projectId===project.id)){
     const row=el('section',undefined,'tool-ledger-row');row.dataset.automationJob=job.id;
     row.append(el('strong',job.name),el('p',stateLabel(job.attempt?.status==='running'?'running':job.status)+' · '+(job.status==='active'?'下次运行 ':'')+new Date(job.dueAt*1000).toLocaleString()));
     const names=selectedSkills(job).map(skill=>skill.name+(state.settings?.skillsEnabled===false||skill.enabled===false?t('（已暂停）',' (paused)'):''));
     if(names.length)row.append(el('p','Skills · '+names.join(' → '),'muted'));
     if(WorkstationSkillsCore.selectionIds(job).length>names.length)row.append(el('p',t('已删除的技能会跳过，编辑保存后从任务中移除。','Deleted skills are skipped and removed from this task when you save an edit.'),'muted'));
     if(job.attempt?.error)row.append(el('p',job.attempt.error));if(job.attempt?.conversationId)row.append(button('查看结果',()=>{dialog.close();openConversation(job.attempt.conversationId);}));
     if(job.attempt?.status==='running'){const live=state.agentRuns.filter(r=>r.automaticJobId===job.id&&r.automaticAttemptId===job.attempt.id).at(-1),summary=progressSummary(live);if(summary){row.append(el('p',(summary.waiting?'等待审批 · ':'进行中 · ')+(summary.phase||(summary.waiting?'有待批准的动作':'准备中'))+(summary.elapsed?' · '+summary.elapsed:''),'muted'));if(summary.recent.length&&!summary.waiting)row.append(el('p','最近：'+summary.recent.join(' · '),'muted'));if(live.conversationId)row.append(button(summary.waiting?'查看待审批动作':'查看过程',()=>{dialog.close();openConversation(live.conversationId);}));}else row.append(el('p','正在领取任务…','muted'));}
     if(job.history?.length){const history=el('details');history.append(el('summary','历史执行 · '+job.history.length));for(const a of [...job.history].reverse()){const item=el('p',new Date(a.startedAt*1000).toLocaleString()+' · '+stateLabel(a.status));if(a.conversationId)item.append(button('查看会话',()=>{dialog.close();openConversation(a.conversationId);}));history.append(item);}row.append(history);}
     if(job.status!=='deleted'&&job.attempt?.status!=='running')row.append(button(t('编辑','Edit'),()=>{if(saving)return;editing=job;name.value=job.name;prompt.value=job.prompt;date.value=new Date(job.dueAt*1000-new Date(job.dueAt*1000).getTimezoneOffset()*60000).toISOString().slice(0,16);budget.value=job.budgetMinutes;selectInterval(job.intervalMinutes);selectMode(job.permissionMode);selectSkills(job);status.textContent='';saveButton.textContent=t('保存修改','Save changes');form.scrollIntoView({block:'nearest',behavior:document.body.classList.contains('reduce-motion')||root.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});name.focus();}));
     const act=async action=>{if(saving)return;try{await request(action,{id:job.id});if(active?.id===job.id&&['pause','delete'].includes(action)){active.valid=false;stopCurrentRun();}await refresh();}catch(e){toast(e.message);}};
     if(job.status==='deleted')row.append(button('恢复',()=>act('resume')));else row.append(button(job.status==='active'?'暂停':'继续',()=>act(job.status==='active'?'pause':'resume')),button('立即运行',()=>act('now')),button('归档',()=>act('delete')));list.append(row);
    }
   }finally{refreshing=false;}
  };
  form.onsubmit=async event=>{
   event.preventDefault();if(saving)return;saving=true;status.textContent=t('正在保存…','Saving…');status.dataset.error='false';
   const controls=[...dialog.querySelectorAll('button,input,textarea')];controls.forEach(control=>control.disabled=true);form.setAttribute('aria-busy','true');updateSkills();
   let saved=false;
   try{const ids=skillIds.filter(id=>WorkstationSkillsCore.get(state,id));await request('upsert',{...(editing?{id:editing.id,version:editing.version}:{}),projectId:project.id,name:name.value,prompt:prompt.value,dueAt:new Date(date.value).toISOString(),budgetMinutes:Number(budget.value),intervalMinutes:interval,timeZone,permissionMode:mode,skillIds:ids,skillId:ids[0]||null});saved=true;reset();status.textContent=t('自动任务已保存。','Automation saved.');}
   catch(e){status.dataset.error='true';status.textContent=e.message;toast(e.message);}
   finally{saving=false;controls.forEach(control=>control.disabled=false);form.removeAttribute('aria-busy');updateSkills();}
   if(saved)try{await refresh();}catch(e){status.dataset.error='true';status.textContent=t('任务已保存，列表刷新失败：','Saved, but the list could not refresh: ')+e.message;}
  };
  const onCancel=event=>{if(saving)event.preventDefault();};dialog.addEventListener('cancel',onCancel);
  dialog.showModal();updateSkills();try{await refresh();}catch(e){status.dataset.error='true';status.textContent=e.message;}
  const liveTimer=setInterval(()=>{if(!dialog.open){clearInterval(liveTimer);return;}refresh().catch(()=>{});},2500);
  dialog.addEventListener('close',()=>{clearInterval(liveTimer);dialog.removeEventListener('cancel',onCancel);for(const host of dialog.querySelectorAll('[data-halaska-root]'))root.HalaskaUI?.unmount(host);},{once:true});
 }

 root.ProjectAutomation={open,tick,assertLease,validateRun,executeClaim,progressSummary,isStarting:()=>!!(ticking||active)};
 setInterval(tick,15000);
})(globalThis);
