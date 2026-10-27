/* 计划任务 (M1 scheduler) in the main window: one dialog for manual reminders
   and unattended automatic tasks (/__scheduler).
   - new / edit: an automatic task always shows its declared scope, smallest
     by default (read only, no external tools, computer use off) and editable;
     a task saved without one (older clients, the API) is flagged until the
     person confirms a scope here;
   - per-task model: stored for P9b, the connection (API or Codex CLI) is applied through the run's own model (P9b);
   - history: every execution with its status, catch-up mark, completion
     summary or error, and a link to its background run;
   - 待你批准: executions paused for a step outside their scope open the
     background-run panel (AIBroKernelRuns), where the person answers;
   - reminders due now can be marked done here (the system notification was
     already scheduled by the native shell).
   Project automations (the main window runs them) stay in each project's own
   dialog; they are listed here read-only. No credentials pass through here. */
(function(root){
  'use strict';
  const t=(zh,en)=>/^en(?:-|$)/i.test(document.documentElement?.lang||'')?en:zh;
  const request=async(action,data)=>{
    const response=await fetch('/__scheduler'+(action?'/'+action:''),data?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{cache:'no-store'});
    const value=await response.json().catch(()=>({}));
    if(!response.ok)throw Object.assign(Error(value.error||t('计划任务服务不可用','The scheduler is unavailable')),{code:value.code});
    return value;
  };
  const el=(tag,text,cls)=>{const x=document.createElement(tag);if(text!==undefined&&text!==null)x.textContent=text;if(cls)x.className=cls;return x;};
  const button=(text,fn,cls='secondary')=>{const x=el('button',text,cls);x.type='button';x.onclick=fn;return x;};
  const when=seconds=>seconds?new Date(seconds*1000).toLocaleString():'';
  const localInput=seconds=>new Date(seconds*1000-new Date(seconds*1000).getTimezoneOffset()*60000).toISOString().slice(0,16);
  const STATUS={active:t('等待到点','Scheduled'),paused:t('已暂停','Paused'),completed:t('已完成','Completed'),done:t('已完成','Done'),expired:t('已过期','Expired'),deleted:t('已归档','Archived'),
    starting:t('提交中','Starting'),queued:t('排队中','Queued'),running:t('执行中','Running'),'awaiting-approval':t('待你批准','Waiting for you'),paused:t('已暂停（模型额度）','Paused (model limit)'),reminded:t('已提醒，待处理','Reminded'),
    unverified:t('未通过完成验收','Not verified'),failed:t('失败','Failed'),cancelled:t('已停止','Stopped'),interrupted:t('已中断','Interrupted')};
  const label=s=>STATUS[s]||s||'';
  const ACCESS=[['read',t('只读（默认）','Read only (default)')],['ask',t('可写，每次写入先问我','May write, ask me each time')],['write',t('可写，普通写入直接执行','May write without asking')]];
  const scopeText=scope=>{
    if(!scope)return t('未声明范围','No declared scope');
    const access=(ACCESS.find(([v])=>v===scope.access)||ACCESS[0])[1];
    return t('范围：','Scope: ')+access+' · '+t('外部工具 ','External tools ')+(scope.tools?.length||0)+' · '+t('电脑操作','Computer use')+(scope.computerUse?t('开','on'):t('关','off'));
  };
  // External (P3 MCP) tools the scope may list; built-in tools follow the access level.
  const externalTools=()=>{try{return (root.AIBroTools?.registry?.list?.()||[]).filter(spec=>spec.mcp).map(spec=>({name:spec.name,label:(spec.title?.zh||spec.name)+' · '+(spec.mcp.plugin||spec.plugin)}));}catch{return [];}};

  let dialog=null,data=null,editing=null,saving=false;
  async function load(){data=await request('');return data;}

  function choice(form,title,values,initial,onPick){
    const row=el('div',undefined,'task-field automation-choice-row');row.append(el('strong',title));
    let current=initial;const buttons=values.map(([value,text])=>{const b=button(text,()=>{if(saving)return;set(value);onPick?.(value);});row.append(b);return b;});
    const set=value=>{current=value;buttons.forEach((b,i)=>b.setAttribute('aria-pressed',String(values[i][0]===value)));};
    set(initial);form.append(row);return {row,get:()=>current,set};
  }

  function renderList(list){
    list.replaceChildren();
    const attention=data.attention||[];
    if(attention.length){
      const box=el('section',undefined,'scheduler-attention');box.dataset.schedulerAttention=String(attention.length);
      box.append(el('strong',t(`${attention.length} 个计划任务已暂停，等你批准`,`${attention.length} scheduled task(s) paused for your approval`)),
        el('p',t('它们要做超出声明范围或需要审批的操作。批准或拒绝后会继续。','They want to do something outside their declared scope or that needs approval. They continue after you answer.'),'muted'),
        button(t('去批准','Review'),()=>{dialog.close();root.AIBroKernelRuns?.show(attention[0].runId);},'primary'));
      list.append(box);
    }
    for(const row of data.reminders||[]){
      const task=(data.tasks||[]).find(item=>item.id===row.taskId);if(!task)continue;
      const box=el('section',undefined,'scheduler-reminder');box.dataset.schedulerReminder=task.id;
      box.append(el('strong',t('提醒：','Reminder: ')+task.name),el('p',when(row.scheduledFor)+(task.prompt?' · '+task.prompt:''),'muted'),button(t('标记完成','Mark done'),()=>act(task,'done')));
      list.append(box);
    }
    if(!(data.tasks||[]).length&&!(data.jobs||[]).length)list.append(el('p',t('还没有计划任务。','No scheduled tasks yet.'),'muted'));
    for(const task of data.tasks||[]){
      const row=el('section',undefined,'tool-ledger-row scheduler-task');row.dataset.schedulerTask=task.id;row.dataset.kind=task.kind;
      const kind=task.kind==='reminder'?t('人工提醒','Reminder'):t('自动任务','Automatic');
      const open=task.openExecution&&(data.executions||[]).find(e=>e.id===task.openExecution);
      const state=open?label(open.status):task.waiting==='dependencies'?t('等依赖完成','Waiting for dependencies'):label(task.status);
      row.append(el('strong',task.name),el('p',kind+' · '+state+(task.status==='active'?' · '+t('下次 ','Next ')+when(task.dueAt):'')+(task.intervalMinutes?' · '+(task.intervalMinutes===1440?t('每天','Daily'):t('每周','Weekly')):''),'muted'));
      if(task.kind==='auto'){
        const scope=el('p',scopeText(task.scope),'muted scheduler-scope');scope.dataset.schedulerScope=task.scope?.access||'';row.append(scope);
        if(task.needsScopeConfirmation)row.append(el('p',t('这个任务保存时没有声明范围，现按最小范围（只读）保存且不会运行；请编辑并确认范围。','Saved without a declared scope: kept at the smallest one and not run until you edit and confirm it.'),'scheduler-warning'));
        if(task.modelOverride?.model||task.modelOverride?.connectionId)row.append(el('p',t('指定模型：','Model: ')+connectionLabel(task.modelOverride.connectionId)+(task.modelOverride.model?' / '+task.modelOverride.model:'')+'','muted'));
      }
      if(task.dependsOn?.length){const names=task.dependsOn.map(id=>(data.tasks||[]).find(item=>item.id===id)?.name||id);row.append(el('p',t('依赖：','Depends on: ')+names.join('、'),'muted'));}
      const history=(data.executions||[]).filter(e=>e.taskId===task.id);
      if(history.length){
        const details=el('details');details.append(el('summary',t('执行历史 · ','History · ')+history.length));
        for(const e of history){
          const item=el('div',undefined,'scheduler-execution');item.dataset.schedulerExecution=e.id;item.dataset.status=e.status;
          item.append(el('span',when(e.startedAt)+' · '+label(e.status)+(e.catchUp?t(' · 补跑',' · catch-up'):'')+(e.sideEffects?t(' · 有写入',' · wrote'):'')));
          if(e.summary)item.append(el('p',e.summary,'muted'));
          if(e.error)item.append(el('p',e.error,'muted'));
          if(e.runId)item.append(button(t('查看运行','Open run'),()=>{dialog.close();root.AIBroKernelRuns?.show(e.runId);}));
          details.append(item);
        }
        row.append(details);
      }
      if(!open)row.append(button(t('编辑','Edit'),()=>edit(task)));
      if(task.status==='active')row.append(button(t('暂停','Pause'),()=>act(task,'pause')));
      else if(!['deleted'].includes(task.status))row.append(button(t('继续','Resume'),()=>act(task,'resume')));
      if(task.kind==='auto'&&!open)row.append(button(t('立即运行','Run now'),()=>act(task,'now')));
      row.append(button(t('归档','Archive'),()=>act(task,'delete')));
      list.append(row);
    }
    if((data.jobs||[]).length){
      const box=el('section',undefined,'scheduler-jobs');box.append(el('strong',t('项目自动任务（主窗口执行，在项目里编辑）','Project automations (run by the main window; edit them in the project)')));
      for(const job of data.jobs){const p=el('p',job.name+' · '+label(job.status)+(job.status==='active'?' · '+when(job.dueAt):'')+(job.scopeDeclared?'':' · '+t('未声明外部工具','no declared external tools')),'muted');p.dataset.schedulerJob=job.id;box.append(p);}
      list.append(box);
    }
  }

  async function act(task,action){
    if(saving)return;
    try{await request(action,{id:task.id});await refresh();}catch(error){if(typeof toast==='function')toast(error.message);}
  }

  // Connections a task may pick (P9b run-level model): Codex CLI or an API service; Claude CLI cannot run in the background.
  function connectionChoices(){
    const C=root.Connections,settings=(typeof state==='object'&&state)?state.settings:null;
    return C&&settings?C.items(settings).filter(item=>item.kind!=='claude-cli').map(item=>({id:item.id,name:item.name||item.id,kind:item.kind})):[];
  }
  function connectionLabel(id){
    if(!id)return t('默认','Default');
    const found=connectionChoices().find(item=>item.id===id);
    return found?found.name:id;
  }

  let form=null,fields=null;
  function buildForm(){
    form=el('form');form.id='schedulerForm';
    const kind=choice(form,t('类型','Kind'),[['reminder',t('人工提醒（到点通知我）','Reminder (notify me)')],['auto',t('自动任务（到点由 AI 无人值守执行）','Automatic (AI runs it unattended)')]],'auto',value=>sync(value));
    const field=(text,input,cls)=>{const row=el('label',undefined,'task-field'+(cls?' '+cls:''));row.append(el('span',text),input);form.append(row);return row;};
    const name=el('input'),prompt=el('textarea'),date=el('input'),budget=el('input'),model=el('input'),connection=el('select'),project=el('select'),deps=el('select');
    name.name='name';name.required=true;name.maxLength=120;prompt.name='prompt';prompt.maxLength=8000;date.name='dueAt';date.type='datetime-local';date.required=true;
    budget.type='number';budget.min=1;budget.max=120;budget.value=15;budget.name='budgetMinutes';model.name='model';model.maxLength=200;
    model.placeholder=t('留空则用默认模型','Leave empty for the default model');deps.multiple=true;deps.name='dependsOn';
    field(t('名称','Name'),name);const promptRow=field(t('任务目标','Goal'),prompt);field(t('时间（本地）','Time (local)'),date);
    const repeat=choice(form,t('重复','Repeat'),[[0,t('单次','Once')],[1440,t('每天','Daily')],[10080,t('每周','Weekly')]],0);
    field(t('所属项目（可选）','Project (optional)'),project);
    // Declared scope: visible and editable whenever the task is automatic.
    const scope=el('fieldset',undefined,'scheduler-scope-field');scope.append(el('legend',t('声明范围（无人值守时只能做这些；超出就暂停等你批准）','Declared scope (what it may do unattended; anything more pauses for your approval)')));
    const scopeNote=el('p','', 'scheduler-warning');scopeNote.hidden=true;scope.append(scopeNote);
    const accessRow=el('div',undefined,'automation-choice-row');scope.append(accessRow);
    let access='read';const accessButtons=ACCESS.map(([value,text])=>{const b=button(text,()=>{if(saving)return;setAccess(value);});b.dataset.access=value;accessRow.append(b);return b;});
    const setAccess=value=>{access=value;accessButtons.forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.access===value)));};setAccess('read');
    const toolsBox=el('div',undefined,'scheduler-tools');scope.append(el('p',t('允许使用的外部工具（插件）：','External tools it may use (plugins):'),'muted'),toolsBox);
    const computer=el('input');computer.type='checkbox';computer.name='computerUse';const computerRow=el('label',undefined,'scheduler-check');
    computerRow.append(computer,el('span',t('允许电脑操作（独立开关，默认关闭；开启后每一步仍要你批准）','Allow computer use (separate switch, off by default; each step still asks you)')));scope.append(computerRow);
    form.append(scope);
    connection.name='modelConnection';connection.addEventListener('change',()=>{model.disabled=!connection.value;if(!connection.value)model.value='';});
    const connectionRow=field(t('模型连接（可选；默认跟随「模型」页里的内核用途）','Model connection (optional; default follows the background purpose on the Models page)'),connection);
    const modelRow=field(t('指定模型（可选；留空用该连接的默认模型）','Model (optional; empty uses the connection default)'),model);
    // With UIKit the connection + model pair is one grouped picker (same list as the in-chat picker); the two plain fields stay as hidden carriers.
    let syncPicker=()=>{};
    if(root.UIKit&&root.ModelChoices&&root.Providers){
      connection.dataset.native='';connection.hidden=true;modelRow.dataset.carrier='';
      const holder=el('div',undefined,'scheduler-model-picker');connectionRow.append(holder);
      const optionsNow=()=>{
        const list=[{value:'',label:t('默认（后台内核设置）','Default (background kernel setting)')}];
        for(const group of root.ModelChoices.groups(state.settings,{claudeEnabled:false}).filter(item=>!item.needsKey))for(const entry of group.models)list.push({value:group.id+'\n'+entry.model,label:entry.label,group:group.name});
        const wanted=connection.value?connection.value+'\n'+model.value:'';
        if(wanted&&!list.some(item=>item.value===wanted))list.push({value:wanted,label:(model.value||connectionLabel(connection.value))+t('（当前不可用）',' (unavailable now)'),group:connectionLabel(connection.value)});
        return list;
      };
      const picker=root.UIKit.select({label:t('模型连接与模型','Model connection and model'),options:optionsNow(),value:'',searchable:'auto',className:'uk-block',
        onChange(value){
          if(!value){connection.value='';model.value='';model.disabled=true;return;}
          const [id,name]=value.split('\n');connection.value=id;model.disabled=false;model.value=name||'';
        }});
      holder.append(picker.el);
      syncPicker=()=>{const options=optionsNow();picker.setOptions(options);const exact=connection.value?connection.value+'\n'+model.value:'';picker.setValue(options.some(item=>item.value===exact)?exact:'');};
    }
    const budgetRow=field(t('最长运行分钟数（等你批准的时间不算）','Time limit in minutes (waiting for you does not count)'),budget);
    const depsRow=field(t('依赖（这些自动任务完成后才运行，可多选）','Depends on (runs after these automatic tasks complete)'),deps);
    const status=el('p','', 'automation-form-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const save=el('button',t('保存','Save'),'primary');save.type='submit';
    const cancel=button(t('取消编辑','Cancel edit'),()=>{if(!saving)reset();});
    const actions=el('div',undefined,'automation-form-actions');actions.append(save,cancel);form.append(status,actions);
    const sync=value=>{const auto=value==='auto';for(const node of [scope,connectionRow,modelRow,budgetRow,depsRow])node.hidden=!auto;promptRow.querySelector('span').textContent=auto?t('任务目标','Goal'):t('备注（可选）','Note (optional)');prompt.required=auto;};
    fields={syncPicker:()=>syncPicker(),kind,name,prompt,date,repeat,project,scope,scopeNote,setAccess,get access(){return access;},toolsBox,computer,model,connection,budget,deps,status,save,sync};
    form.onsubmit=submit;
    return form;
  }

  function fillChoices(task){
    const choices=connectionChoices(),chosenId=task?.modelOverride?.connectionId||'';
    if(chosenId&&!choices.some(item=>item.id===chosenId))choices.push({id:chosenId,name:chosenId+t('（当前不可用）',' (unavailable now)')});
    fields.connection.replaceChildren(el('option',t('默认（后台内核设置）','Default (background kernel setting)')));fields.connection.firstChild.value='';
    for(const item of choices){const o=el('option',item.name+(item.kind==='codex-cli'?' · Codex':''));o.value=item.id;fields.connection.append(o);}
    fields.connection.value=chosenId;fields.model.disabled=!chosenId;
    const projects=((typeof state==='object'&&state)?state.projects||[]:[]).filter(p=>!p.archived&&!p.deletedAt);
    fields.project.replaceChildren(el('option',t('不属于项目','No project')));fields.project.firstChild.value='';
    for(const p of projects){const o=el('option',p.name||p.id);o.value=p.id;fields.project.append(o);}
    fields.project.value=task?.projectId||'';
    fields.deps.replaceChildren();
    for(const other of (data?.tasks||[]).filter(item=>item.kind==='auto'&&item.id!==task?.id)){const o=el('option',other.name);o.value=other.id;o.selected=(task?.dependsOn||[]).includes(other.id);fields.deps.append(o);}
    fields.toolsBox.replaceChildren();
    const tools=externalTools(),chosen=new Set(task?.scope?.tools||[]);
    for(const name of chosen)if(!tools.some(tool=>tool.name===name))tools.push({name,label:name+t('（当前不可用）',' (unavailable now)')});
    if(!tools.length)fields.toolsBox.append(el('p',t('没有已启用的外部工具。','No external tools are enabled.'),'muted'));
    for(const tool of tools){const row=el('label',undefined,'scheduler-check'),box=el('input');box.type='checkbox';box.value=tool.name;box.checked=chosen.has(tool.name);row.append(box,el('span',tool.label));fields.toolsBox.append(row);}
  }

  function reset(){
    editing=null;fillChoices(null);
    fields.kind.set('auto');fields.sync('auto');fields.name.value='';fields.prompt.value='';fields.date.value=localInput(Date.now()/1000+3600);
    fields.repeat.set(0);fields.setAccess('read');fields.computer.checked=false;fields.model.value='';fields.connection.value='';fields.model.disabled=true;fields.budget.value=15;
    fields.scopeNote.hidden=true;fields.status.textContent='';fields.save.textContent=t('创建计划任务','Create scheduled task');
    fields.kind.row.querySelectorAll('button').forEach(b=>b.disabled=false);
    fields.syncPicker();
  }

  function edit(task){
    if(saving)return;editing=task;fillChoices(task);
    fields.kind.set(task.kind);fields.sync(task.kind);fields.kind.row.querySelectorAll('button').forEach(b=>b.disabled=true);
    fields.name.value=task.name;fields.prompt.value=task.prompt||'';fields.date.value=localInput(task.dueAt);fields.repeat.set(task.intervalMinutes);
    fields.setAccess(task.scope?.access||'read');fields.computer.checked=task.scope?.computerUse===true;fields.model.value=task.modelOverride?.model||'';fields.connection.value=task.modelOverride?.connectionId||'';fields.model.disabled=!fields.connection.value;fields.budget.value=task.budgetMinutes||15;
    fields.scopeNote.hidden=!task.needsScopeConfirmation;
    fields.scopeNote.textContent=t('这个任务原先没有声明范围。保存即按上面显示的范围声明，之后才会运行。','This task had no declared scope. Saving declares the scope shown here; it runs only after that.');
    fields.status.textContent='';fields.save.textContent=t('保存修改','Save changes');
    fields.syncPicker();form.scrollIntoView({block:'nearest'});fields.name.focus();
  }

  function payload(){
    const kind=fields.kind.get(),body={kind,name:fields.name.value,prompt:fields.prompt.value,dueAt:new Date(fields.date.value).toISOString(),
      intervalMinutes:Number(fields.repeat.get()),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,projectId:fields.project.value||null};
    if(editing)Object.assign(body,{id:editing.id,version:editing.version});
    if(kind==='auto'){
      body.scope={access:fields.access,tools:[...fields.toolsBox.querySelectorAll('input:checked')].map(box=>box.value),computerUse:fields.computer.checked};
      body.modelOverride=fields.connection.value?{connectionId:fields.connection.value,...(fields.model.value.trim()?{model:fields.model.value.trim()}:{})}:null;
      body.budgetMinutes=Number(fields.budget.value);body.dependsOn=[...fields.deps.selectedOptions].map(o=>o.value);
    }
    return body;
  }

  async function submit(event){
    event.preventDefault();if(saving)return;saving=true;fields.status.dataset.error='false';fields.status.textContent=t('正在保存…','Saving…');
    const controls=[...form.querySelectorAll('button,input,textarea,select')],disabled=controls.map(c=>c.disabled);controls.forEach(c=>c.disabled=true);
    let saved=false;
    try{
      let body=payload();
      try{await request('upsert',body);}
      catch(error){
        // Only API-made tasks lack a scope; the form always declares one. Kept for completeness.
        if(error.code!=='SCOPE_UNDECLARED'||!root.confirm?.(error.message))throw error;
        body={...body,confirmUndeclared:true};await request('upsert',body);
      }
      saved=true;
    }catch(error){fields.status.dataset.error='true';fields.status.textContent=error.message;}
    finally{saving=false;controls.forEach((c,i)=>c.disabled=disabled[i]);}
    if(saved){reset();fields.status.textContent=t('计划任务已保存。','Scheduled task saved.');await refresh().catch(()=>{});}
  }

  let list=null,timer=null;
  async function refresh(){if(!dialog?.open||saving)return;await load();renderList(list);}
  async function open(){
    if(!dialog){
      dialog=el('dialog',undefined,'task-dialog');dialog.id='schedulerDialog';dialog.setAttribute('aria-labelledby','schedulerTitle');
      const header=el('div',undefined,'dialog-header'),title=el('h2',t('计划任务','Scheduled tasks'));title.id='schedulerTitle';
      header.append(title,button(t('关闭','Close'),()=>{if(!saving)dialog.close();}));
      dialog.append(header,el('p',t('人工提醒到点由系统通知（App 关闭也会送达），2 小时未处理标为过期。自动任务到点由 AI 在后台无人值守执行，只做声明范围内的事；App 关闭期间错过的，下次打开只补最近一次。','Reminders arrive as system notifications even when the app is closed and expire after two hours. Automatic tasks run unattended in the background within their declared scope; times missed while the app was closed run once on next launch.'),'muted'));
      list=el('div',undefined,'automation-job-list scheduler-list');dialog.append(list,buildForm());
      dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
      dialog.addEventListener('close',()=>{clearInterval(timer);timer=null;});
      document.body.append(dialog);
    }
    if(dialog.open){dialog.focus();return;}
    dialog.showModal();
    try{await load();reset();renderList(list);}catch(error){list.replaceChildren(el('p',error.message,'automation-form-status'));}
    clearInterval(timer);timer=setInterval(()=>refresh().catch(()=>{}),3000);
  }

  // Entry points: the overview's hero actions and the automation permissions card in settings.
  function mountEntry(){
    const hero=document.querySelector('#dashboard .hero-actions');
    if(hero&&!hero.querySelector('#schedulerOpen')){const b=button(t('计划任务','Scheduled tasks'),open);b.id='schedulerOpen';hero.append(b);}
    // The native app draws its own overview hero, so settings is the entry that always exists.
    const card=[...document.querySelectorAll('#settings .card')].find(c=>c.querySelector('h2')?.textContent.trim()==='自动化权限');
    if(card&&!card.querySelector('#schedulerOpenSettings')){const b=button(t('计划任务','Scheduled tasks'),open);b.id='schedulerOpenSettings';b.className='secondary';b.style.marginTop='10px';card.append(b);}
  }
  root.SchedulerUI=Object.freeze({open,refresh,scopeText,get data(){return data;}});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mountEntry);else mountEntry();
})(globalThis);
