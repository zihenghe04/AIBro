/* Allowlisted migration bridge. Existing JS remains the sole workspace writer. */
(()=>{
document.body.classList.add('aibro-native');
// WKWebView suspends animations while the native dashboard or another window
// covers it. Background work must not leave a reader/modal at opacity zero.
const syncVisibility=()=>document.body.classList.toggle('native-background-render',document.hidden);
syncVisibility();document.addEventListener('visibilitychange',syncVisibility);
let previousNativeView=null;let entranceTimer=null;
function tidyReaderHeading(){
 const title=document.querySelector('#previewTitle'),first=document.querySelector('.reading-pane .note-document[data-mode=read] .note-document-preview > h1:first-child');
 if(!title)return;
 const duplicate=!!first&&first.textContent.trim()===title.textContent.trim();
 if(duplicate)title.setAttribute('data-native-duplicate-title','true');else title.removeAttribute('data-native-duplicate-title');
}
function snapshot(){refreshNativeChoices();tidyReaderHeading();const view=document.body.dataset.view;if(view!==previousNativeView){previousNativeView=view;if(document.body.classList.remove){document.body.classList.remove('native-enter');void document.body.offsetWidth;document.body.classList.add('native-enter');clearTimeout(entranceTimer);entranceTimer=setTimeout(()=>document.body.classList.remove('native-enter'),500);}}if(typeof storageHydrated==='undefined'||!storageHydrated)return;const active=x=>!x.deletedAt&&!x.deleted&&!x.archivedAt&&!x.archived&&!(["archived","deleted"].includes(x.status));
 const date=x=>{if(x==null||x==='')return null;const n=typeof x==='number'?x:Date.parse(x);return Number.isFinite(n)?n:null;};
 const records=(items,kind)=>items.filter(active).map(x=>({id:x.id,title:x.title||x.name||'',workspace:state.projects.find(p=>p.id===x.projectId)?.workspace||x.workspace||'日常',projectId:x.projectId||'',kind,status:x.status||'todo',priority:x.priority||'medium',waitingOnDependencies:kind==='task'&&(x.dependsOn||[]).some(id=>!state.tasks.some(t=>active(t)&&t.id===id&&t.status==='done'&&(t.projectId||null)===(x.projectId||null)&&t.workspace===x.workspace)),start:date(x.startAt),due:date(x.dueAt),dueDay:typeof x.dueAt==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x.dueAt)?x.dueAt:null,completed:date(x.completedAt),updated:date(x.updatedAt||x.createdAt),reminderMinutes:Number.isInteger(x.reminderMinutes)&&x.reminderMinutes>=0&&x.reminderMinutes<=10080?x.reminderMinutes:null,reminderDisabled:Object.hasOwn(x,'reminderMinutes')&&x.reminderMinutes===null}));
 const library=state.conversations.filter(x=>!x.deletedAt&&!x.deleted).map(x=>({id:x.id,title:x.title||'新对话',folderId:x.folderId||'',projectId:x.projectId||'',updatedAt:Number(x.updatedAt)||0,archived:!active(x)}));
 const folders=(state.folders?.conversations||[]).filter(x=>!x.deletedAt&&!x.deleted).map(x=>({id:x.id,title:x.name||'文件夹',archived:!active(x)}));
 const data={conversationLibrary:library,conversationFolders:folders,tasks:records(state.tasks,'task'),documents:[...records(state.notes,'note'),...records(state.imports,'import')],modalOpen:!!document.querySelector('dialog[open]:not(#previewDialog)'),readingOpen:document.body.classList.contains('reading-open'),readerAvailable:!!document.querySelector('#readingToggle:not([hidden])'),projects:state.projects.filter(active).map(x=>({id:x.id,title:x.name||'Project',workspace:x.workspace||''})),conversations:state.conversations.filter(active).map(x=>({id:x.id,title:x.title||'Conversation',workspace:x.workspace||''})),taskCount:state.tasks.filter(x=>active(x)&&x.status!=='done').length,noteCount:state.notes.filter(active).length,sourceCount:state.imports.filter(active).length,projectId:state.currentProjectId||'',view:document.body.dataset.view||'agent',conversationId:state.currentConversationId||'',busy:!!sendMessage.busy};
 const json=JSON.stringify(data);if(json!==snapshot.last){snapshot.last=json;window.webkit.messageHandlers.workspace.postMessage(data);}}

// Progressive enhancement: every single-value select keeps its original form and change handlers.
const choiceRegistry=new WeakMap();let activeChoice=null;let choiceSerial=0;
const shortChoices='#provider,#conversationProvider,#polishStyle,#interfaceLanguage,.permission-row select';
const english=()=>document.documentElement.lang.startsWith('en');
function chooseValue(select,value){const option=[...select.options].find(o=>o.value===value);if(select.disabled||!option||option.disabled||option.hidden||option.parentElement?.disabled)return;select.value=value;select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));refreshNativeChoices();}
function choiceLabel(select){return (select.labels?.[0]?.textContent||select.getAttribute('aria-label')||select.title||(english()?'Choose':'选择')).trim();}
function closeChoice(focus=false){if(!activeChoice)return;const c=activeChoice;activeChoice=null;c.trigger.setAttribute('aria-expanded','false');c.panel.remove();if(focus&&c.trigger.isConnected)c.trigger.focus();}
function openChoice(select,trigger){
 if(activeChoice?.trigger===trigger){closeChoice(true);return;}closeChoice();if(select.disabled)return;
 const panel=document.createElement('div');panel.className='native-select-panel';panel.setAttribute('popover','manual');
 const label=choiceLabel(select), options=[...select.options].filter(o=>!o.hidden), searchable=options.length>6;
 const caption=document.createElement('div');caption.className='native-select-caption';caption.textContent=label;panel.append(caption);
 let search;if(searchable){search=document.createElement('input');search.type='search';search.placeholder=english()?'Search options…':'搜索选项…';search.setAttribute('aria-label',search.placeholder);panel.append(search);}
 const list=document.createElement('div');list.className='native-select-options';list.id='native-options-'+(++choiceSerial);list.setAttribute('role','listbox');list.setAttribute('aria-label',label);panel.append(list);
 const empty=document.createElement('p');empty.className='native-select-empty';empty.textContent=english()?'No matching options':'没有匹配的选项';empty.hidden=true;panel.append(empty);
 let buttons=[];
 function render(query=''){
  list.replaceChildren();buttons=[];let lastGroup=null;
  options.filter(o=>o.textContent.toLocaleLowerCase().includes(query.toLocaleLowerCase())).forEach(option=>{
   const group=option.parentElement?.tagName==='OPTGROUP'?option.parentElement:null;
   if(group&&group!==lastGroup){const heading=document.createElement('div');heading.className='native-select-caption';heading.textContent=group.label;list.append(heading);}lastGroup=group;
   const button=document.createElement('button');button.type='button';button.setAttribute('role','option');button.setAttribute('aria-selected',String(option.value===select.value));button.disabled=option.disabled||!!group?.disabled;button.dataset.value=option.value;button.tabIndex=-1;
   const dot=document.createElement('span');dot.className='native-option-dot';dot.dataset.value=option.value;dot.setAttribute('aria-hidden','true');button.append(dot);
   const title=document.createElement('span');title.textContent=option.textContent;button.append(title);
   const check=document.createElement('span');check.className='native-option-check';check.textContent=option.value===select.value?'✓':'';check.setAttribute('aria-hidden','true');button.append(check);
   button.addEventListener('click',()=>{if(button.disabled)return;closeChoice(true);chooseValue(select,option.value);});list.append(button);if(!button.disabled)buttons.push(button);
  });empty.hidden=!!buttons.length;
 }
 render();search?.addEventListener('input',()=>render(search.value));
 panel.addEventListener('keydown',e=>{
  if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeChoice(true);return;}
  if(e.key==='Tab'){closeChoice(true);return;}
  if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){
   if(search===document.activeElement&&['Home','End'].includes(e.key))return;
   e.preventDefault();const index=buttons.indexOf(document.activeElement),step=e.key==='ArrowUp'?-1:1;
   const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:index<0?(step>0?0:buttons.length-1):(index+step+buttons.length)%buttons.length;buttons[next]?.focus();
  }else if(!search&&e.key.length===1&&!e.metaKey&&!e.ctrlKey){buttons.find(b=>b.textContent.trim().toLocaleLowerCase().startsWith(e.key.toLocaleLowerCase()))?.focus();}
 });
 // A popover belongs to the top layer even when its trigger is inside a modal dialog.
 (select.closest('dialog[open]')||document.body).append(panel);if(panel.showPopover)panel.showPopover();
 const r=trigger.getBoundingClientRect(), width=Math.min(Math.max(r.width,250),window.innerWidth-24);
 panel.style.width=width+'px';panel.style.left=Math.max(12,Math.min(r.left,window.innerWidth-width-12))+'px';
 const below=window.innerHeight-r.bottom-12,above=r.top-12,up=below<230&&above>below;
 panel.style.maxHeight=Math.max(100,Math.min(360,up?above:below))+'px';
 panel.style.top=(up?Math.max(12,r.top-Math.min(panel.scrollHeight,360,above)-6):r.bottom+6)+'px';
 trigger.setAttribute('aria-expanded','true');trigger.setAttribute('aria-controls',list.id);activeChoice={select,trigger,panel,optionKey:JSON.stringify([...select.options].map(o=>[o.value,o.textContent,o.disabled,o.hidden])),value:select.value};
 (search||buttons.find(b=>b.getAttribute('aria-selected')==='true')||buttons[0])?.focus();
}
function refreshNativeChoices(){
 if(!document.querySelectorAll)return;
 if(activeChoice&&(!activeChoice.select.isConnected||activeChoice.select.closest('dialog:not([open])')||!activeChoice.trigger.getClientRects().length||activeChoice.select.disabled))closeChoice();
 document.querySelectorAll('select:not([multiple])').forEach(select=>{
  if(select.size>1)return;
  let control=choiceRegistry.get(select);const short=select.matches(shortChoices);
  if(!control||!control.isConnected){
   control=document.createElement(short?'div':'button');control.className=short?'native-choices'+(select.id==='provider'?' native-connection-cards':' native-segments'):'native-select-trigger';
   if(short){control.setAttribute('role','radiogroup');control.addEventListener('click',e=>{const button=e.target.closest('[data-choice]');if(button&&!button.disabled)chooseValue(select,button.dataset.choice);});
    control.addEventListener('keydown',e=>{const buttons=[...control.querySelectorAll('button:not(:disabled)')],i=buttons.indexOf(document.activeElement);if(i<0||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key))return;e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(['ArrowRight','ArrowDown'].includes(e.key)?1:-1)+buttons.length)%buttons.length;buttons[next]?.focus();buttons[next]?.click();});
   }else{control.type='button';control.setAttribute('aria-haspopup','listbox');control.setAttribute('aria-expanded','false');control.addEventListener('click',()=>openChoice(select,control));control.addEventListener('keydown',e=>{if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();openChoice(select,control);}});}
   select.after(control);select.classList.add('native-choice-source');choiceRegistry.set(select,control);
   select.addEventListener('change',refreshNativeChoices);select.addEventListener('invalid',()=>control.focus());
   for(const label of select.labels||[])label.addEventListener('click',e=>{if(e.target===label||e.target.closest('label')===label){e.preventDefault();(short?control.querySelector('[aria-checked=true]'):control)?.focus();}});
  }
  const label=choiceLabel(select);control.setAttribute('aria-label',label);control.hidden=select.hidden||select.classList.contains('hidden')||select.style.display==='none';
  const options=[...select.options],key=JSON.stringify(options.map(o=>[o.value,o.textContent,o.disabled,o.hidden]));
  if(activeChoice?.select===select&&(activeChoice.optionKey!==key||activeChoice.value!==select.value))closeChoice();
  if(short){if(control.dataset.options!==key){control.replaceChildren();control.dataset.options=key;for(const option of options){const button=document.createElement('button');button.type='button';button.dataset.choice=option.value;button.setAttribute('role','radio');
    if(select.id==='provider'){const icon=document.createElement('span');icon.className='native-choice-icon';icon.setAttribute('aria-hidden','true');icon.textContent=option.value==='api'?'⌘':'◎';button.append(icon);}
    const copy=document.createElement('span');copy.className='native-choice-copy';const title=document.createElement('strong');title.textContent=option.textContent;copy.append(title);
    if(select.id==='provider'){const detail=document.createElement('small');detail.textContent=option.value==='api'?(english()?'Your endpoint, key and model':'使用自己的服务地址、密钥与模型'):(english()?'Connect your existing account':'连接已有账号，选择可用模型');copy.append(detail);}
    const check=document.createElement('span');check.className='native-choice-check';check.setAttribute('aria-hidden','true');check.textContent='✓';button.append(copy,check);control.append(button);
   }}[...control.children].forEach((button,i)=>{const checked=button.dataset.choice===select.value;button.hidden=options[i].hidden;button.disabled=select.disabled||options[i].disabled;button.setAttribute('aria-checked',String(checked));button.tabIndex=checked?0:-1;});
  }else{control.disabled=select.disabled;const title=select.selectedOptions[0]?.textContent|| (english()?'Choose…':'请选择…');if(control.dataset.title!==title){control.dataset.title=title;control.replaceChildren();const text=document.createElement('span');text.textContent=title;const chevron=document.createElement('span');chevron.className='native-select-chevron';chevron.textContent='⌄';chevron.setAttribute('aria-hidden','true');control.append(text,chevron);}control.setAttribute('aria-label',label+'：'+title);}
 });
}
if(typeof MutationObserver!=='undefined'){
 let scheduled=false;new MutationObserver(records=>{if(!records.some(r=>r.target.tagName==='SELECT'||r.target.tagName==='OPTION'||r.target.tagName==='DIALOG'||[...(r.addedNodes||[])].some(n=>n.nodeType===1&&(n.matches?.('select')||n.querySelector?.('select')))))return;if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;refreshNativeChoices();});}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','hidden','style','open']});
 document.addEventListener('pointerdown',e=>{if(activeChoice&&!activeChoice.panel.contains(e.target)&&!activeChoice.trigger.contains(e.target))closeChoice();},true);
 document.addEventListener('scroll',e=>{if(activeChoice&&!activeChoice.panel.contains(e.target))closeChoice();},true);
 document.addEventListener('close',()=>closeChoice(),true);window.addEventListener('resize',()=>closeChoice());
}

window.NativeConversationActions={perform(command){
 if(typeof storageHydrated==='undefined'||!storageHydrated)throw Error('工作区尚未就绪。');
 if(sendMessage.busy)throw Error('请等待当前对话生成完成后再整理。');
 state=NativeConversationLibrary.apply(state,command);
 normalizeStateShape(state);save();renderAll();snapshot();return true;
}};
window.NativeShell={perform(command){if(typeof storageHydrated==='undefined'||!storageHydrated)return false;const {type,id}=command;const active=x=>!x.deletedAt&&!x.deleted&&!x.archivedAt&&!x.archived&&!(["archived","deleted"].includes(x.status));
 switch(type){case'view':if(id==='history'){WorkstationRunHistory.open();break;}if(!['captures','wiki','agent','dashboard','overview','daily','courses','research','history','trash','settings'].includes(id))return false;showView(id,id);break;
 case'project':if(!state.projects.some(x=>x.id===id&&active(x)))return false;openProject(id);break;
 case'conversation':if(!state.conversations.some(x=>x.id===id&&active(x)))return false;openConversation(id);break;
 case'complete-task':case'reopen-task':{const task=state.tasks.find(x=>x.id===id&&active(x));if(!task)return false;const done=type==='complete-task';if((task.status==='done')!==done)toggleTaskStatus(id);break;}
 case'task':if(!state.tasks.some(x=>x.id===id&&active(x)))return false;openTask(id);break;
 case'note':if(!state.notes.some(x=>x.id===id&&active(x)))return false;openNote(id);break;
 case'import':if(!state.imports.some(x=>x.id===id&&active(x)))return false;openImport(id);break;
 case'create-task':if(!['日常','课程','科研'].includes(id))return false;PlanningWorkbench.createTask({workspace:id});break;
 case'create-project-task':{const project=state.projects.find(x=>x.id===id&&active(x));if(!project)return false;PlanningWorkbench.createTask({workspace:project.workspace,projectId:project.id});break;}
 case'reader':document.getElementById('readingToggle')?.click();break;
 case'new-research-conversation':newConversation('科研');break;
 case'new-project-conversation':{const project=state.projects.find(x=>x.id===id&&active(x));if(!project)return false;newConversation(project.workspace,project.id);break;}
 case'new':newConversation();break;
 case'theme':if(!['light','dark'].includes(id))return false;state.ui.theme=id;applyUiPreferences();save();break;
 default:return false;}snapshot();return true;}};
setInterval(snapshot,500);snapshot();
})();
