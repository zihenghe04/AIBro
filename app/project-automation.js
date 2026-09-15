/* Durable schedules run through the same conversation, permission and memory path. */
(function(root){
 'use strict';let active=null,ticking=false;
 const request=async(action,data)=>{const response=await fetch('/__project/jobs'+(action?'/'+action:''),data?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{cache:'no-store'});const value=await response.json();if(!response.ok)throw Error(value.error||'自动任务服务不可用');return value;};
 const el=(tag,text,cls)=>{const x=document.createElement(tag);if(text!==undefined)x.textContent=text;if(cls)x.className=cls;return x;};
 const button=(text,fn)=>{const x=el('button',text,'secondary');x.type='button';x.onclick=fn;return x;};
 const stateLabel=s=>({active:'等待运行',running:'执行中',completed:'已完成',paused:'已暂停',deleted:'已归档',failed:'失败',cancelled:'已停止',interrupted:'已中断','awaiting-approval':'待审批'})[s]||s;
 async function executeClaim(claim){
  const job=claim.job,lease={id:job.id,token:claim.token,valid:true};active=lease;let runId=null,poll,timer;
  try{
   const project=state.projects.find(p=>p.id===job.projectId&&p.workspace===job.workspace&&!p.archived&&!p.deletedAt);if(!project)throw Error('项目不可用');
   if(job.skillId&&state.settings.skillsEnabled===false)throw Error('请先在设置中启用 Skills，或移除此任务的 Skill');
   if(job.skillId&&!WorkstationSkillsCore.get(state,job.skillId))throw Error('此自动任务的 Skill 已删除或失效，请重新设置');
   const chatId='auto_'+job.id;let chat=state.conversations.find(c=>c.id===chatId);
   if(chat&&(chat.archived||chat.deletedAt))throw Error('自动任务的对话已归档，请恢复该对话后继续');
   if(!chat){chat={id:chatId,title:'自动任务 · '+job.name,titleEdited:true,messages:[],attachments:[],projectId:project.id,workspace:project.workspace,createdAt:Date.now(),updatedAt:Date.now()};state.conversations.push(chat);}
   if(chat.projectId!==project.id)throw Error('自动任务对话归属已变化');
   chat.permissionMode=job.permissionMode;chat.skillId=job.skillId;await saveDocumentDurably();
   timer=setTimeout(()=>{active.valid=false;stopCurrentRun();},Math.max(1,job.attempt.expiresAt*1000-Date.now()));
   poll=setInterval(async()=>{if(!active)return;try{const check=await request('check',{id:job.id,token:claim.token});if(active===lease&&!check.valid){lease.valid=false;stopCurrentRun();}}catch{if(active===lease){lease.valid=false;stopCurrentRun();}}},2000);
   await sendMessage({goal:job.prompt,conversationId:chat.id,background:true,automaticJobId:job.id,automaticAttemptId:job.attempt.id});
   const run=state.agentRuns.filter(r=>r.automaticJobId===job.id&&r.automaticAttemptId===job.attempt.id).at(-1);runId=run?.id;
   await saveDocumentDurably();await request('finish',{id:job.id,token:claim.token,runId});
   toast('自动任务「'+job.name+'」'+stateLabel(run?.status||'failed')+'，可在项目会话中查看。');
  }catch(e){try{await request('finish',{id:job.id,token:claim.token,runId,error:e.message});}catch{}toast('自动任务已暂停：'+e.message);}
  finally{clearTimeout(timer);clearInterval(poll);active=null;}
 }
 function idle(){return storageHydrated&&!serverConflict&&!sendMessage.busy&&!sendMessage.preparingWiki&&!importMaterials.busy&&!document.querySelector('dialog:modal')&&!$('#agentInput')?.value?.trim()&&!currentConversation()?.draftAttachmentIds?.length;}
 async function tick(){if(ticking||active||!idle())return;ticking=true;try{const {jobs}=await request('');const job=jobs.find(j=>j.status==='active'&&j.dueAt*1000<=Date.now()&&j.attempt?.status!=='running');if(!job||!idle())return;const claim=await request('claim',{id:job.id});if(claim.claimed)await executeClaim(claim);}catch{}finally{ticking=false;}}
 function assertLease(run){if(run.automaticJobId&&run.status==='running'&&(!active?.valid||active.id!==run.automaticJobId))throw Object.assign(Error('自动任务已暂停、超时或权限记录变化'),{code:'CANCELLED'});}
 async function validateRun(run){if(!run.automaticJobId||run.status!=='running')return;assertLease(run);const result=await request('check',{id:active.id,token:active.token});if(!result.valid){active.valid=false;assertLease(run);}}
 async function open(project){
  let dialog=document.querySelector('#projectAutomationDialog');if(!dialog){dialog=el('dialog',undefined,'task-dialog');dialog.id='projectAutomationDialog';document.body.append(dialog);}dialog.replaceChildren();
  const heading=el('div',undefined,'dialog-header');heading.append(el('h2','项目自动任务'),button('关闭',()=>dialog.close()));dialog.append(heading);
  dialog.append(el('p','App 打开且空闲时运行。关闭期间错过的日程，下次打开补一次；中断或失败会暂停，核对结果后再继续。终端与文件写入仍使用原有审批。','muted'));
  let editing=null;const list=el('div');dialog.append(list);
  const refresh=async()=>{const {jobs}=await request('');list.replaceChildren();for(const job of jobs.filter(j=>j.projectId===project.id)){
   const row=el('section',undefined,'tool-ledger-row');row.append(el('strong',job.name),el('p',stateLabel(job.attempt?.status==='running'?'running':job.status)+' · '+new Date(job.dueAt*1000).toLocaleString()));
   if(job.attempt?.error)row.append(el('p',job.attempt.error));if(job.attempt?.conversationId)row.append(button('查看结果',()=>{dialog.close();openConversation(job.attempt.conversationId);}));
   if(job.history?.length){const history=el('details');history.append(el('summary','历史执行 · '+job.history.length));for(const a of [...job.history].reverse()){const item=el('p',new Date(a.startedAt*1000).toLocaleString()+' · '+stateLabel(a.status));if(a.conversationId)item.append(button('查看会话',()=>{dialog.close();openConversation(a.conversationId);}));history.append(item);}row.append(history);}
   if(job.status!=='deleted'&&job.attempt?.status!=='running')row.append(button('编辑',()=>{editing=job;name.value=job.name;prompt.value=job.prompt;date.value=new Date(job.dueAt*1000-new Date(job.dueAt*1000).getTimezoneOffset()*60000).toISOString().slice(0,16);budget.value=job.budgetMinutes;selectInterval(job.intervalMinutes);selectMode(job.permissionMode);selectSkill(job.skillId);saveButton.textContent='保存修改';form.scrollIntoView({block:'nearest',behavior:'smooth'});name.focus();}));
   const act=async action=>{try{await request(action,{id:job.id});if(active?.id===job.id&&['pause','delete'].includes(action)){active.valid=false;stopCurrentRun();}await refresh();}catch(e){toast(e.message);}};
   if(job.status==='deleted')row.append(button('恢复',()=>act('resume')));else{row.append(button(job.status==='active'?'暂停':'继续',()=>act(job.status==='active'?'pause':'resume')),button('立即运行',()=>act('now')),button('归档',()=>act('delete')));}list.append(row);
  }};
  const form=el('form');const name=el('input'),prompt=el('textarea'),date=el('input'),budget=el('input');name.placeholder='名称，例如每周研究回顾';prompt.placeholder='具体目标、需要检查的资料与希望生成的结果';date.type='datetime-local';date.value=new Date(Date.now()+3600000-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16);budget.type='number';budget.min=1;budget.max=120;budget.value=15;
  const field=(title,input)=>{const row=el('label',title,'task-field');row.append(input);form.append(row);};field('名称',name);field('任务目标',prompt);field('首次运行（本地时间）',date);field('最长运行分钟数',budget);
  let interval=0,mode='legacy',skillId=null;
  const timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone;form.append(el('p','每天／每周按本地钟点重复 · '+timeZone+'。夏令时跳过的钟点顺延，重复钟点只运行一次。','muted'));
  const choices=(title,values,select,initial)=>{const row=el('div',undefined,'task-field');row.append(el('strong',title));const buttons=values.map(([value,label])=>{const b=button(label,()=>{buttons.forEach(x=>x.setAttribute('aria-pressed','false'));b.setAttribute('aria-pressed','true');select(value);});b.setAttribute('aria-pressed',String(value===initial));row.append(b);return b;});form.append(row);return value=>{buttons.forEach((b,i)=>b.setAttribute('aria-pressed',String(values[i][0]===value)));select(value);};};
  const selectInterval=choices('重复',[[0,'单次'],[1440,'每天'],[10080,'每周']],v=>interval=v,0);
  const selectMode=choices('权限',[['legacy','跟随空间设置'],['request','审批确认'],['smart','自动执行，风险操作审批']],v=>mode=v,'legacy');
  const selectSkill=choices('工作流 Skill',[[null,'不指定'],...WorkstationSkillsCore.list(state).map(s=>[s.id,s.name])],v=>skillId=v,null);
  const saveButton=el('button','创建自动任务','primary');saveButton.type='submit';form.append(saveButton,button('取消编辑',()=>{editing=null;name.value='';prompt.value='';saveButton.textContent='创建自动任务';}));form.onsubmit=async event=>{event.preventDefault();try{saveButton.disabled=true;await request('upsert',{...(editing?{id:editing.id,version:editing.version}:{}),projectId:project.id,name:name.value,prompt:prompt.value,dueAt:new Date(date.value).toISOString(),budgetMinutes:Number(budget.value),intervalMinutes:interval,timeZone,permissionMode:mode,skillId});editing=null;saveButton.textContent='创建自动任务';name.value='';prompt.value='';await refresh();}catch(e){toast(e.message);}finally{saveButton.disabled=false;}};dialog.append(form);if(!dialog.open)dialog.showModal();await refresh();
 }
 root.ProjectAutomation={open,tick,assertLease,validateRun,executeClaim};
 setInterval(tick,15000);
})(globalThis);
