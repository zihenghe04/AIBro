/* One keyboard surface for registered actions and real workspace search. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.CommandSearch=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root){
 'use strict';
 const RECENT_KEY='aibro.command-search.recent.v1';
 const normalize=value=>String(value||'').normalize('NFKC').trim().toLocaleLowerCase();
 const privateContext=context=>!!(context?.privateMode||context?.incognito||context?.ephemeral);
 function groups(rows){const found=new Map();for(const row of rows||[]){const type=row.groupKey||row.type;if(!found.has(type))found.set(type,[]);found.get(type).push(row);}return [...found].map(([type,items])=>({type,items}));}
 function createRegistry({commands=[],getContext=()=>({}),storage,key=RECENT_KEY,now=Date.now}={}){
  const registry=new Map();let memory=[],running=false;
  try{const saved=JSON.parse(storage?.getItem(key)||'[]');if(Array.isArray(saved))memory=saved.filter(item=>item&&typeof item.id==='string'&&Number.isFinite(item.at)).slice(0,12);}catch{}
  function register(command){if(!command||typeof command.id!=='string'||!command.id.trim()||typeof command.execute!=='function')throw new TypeError('Command requires a stable id and execute callback');registry.set(command.id,command);return()=>registry.delete(command.id);}
  commands.forEach(register);
  const read=(value,context)=>typeof value==='function'?value(context):value;
  function reason(command,context){const enabled=read(command.isEnabled,context);return typeof enabled==='string'?enabled:enabled===false?(read(command.disabledReason,context)||'当前状态不可用'):'';}
  function visible(command,context){return read(command.visible,context)!==false;}
  function rows(query=''){
   const context=getContext()||{},q=normalize(query).replace(/^>\s*/,''),recent=privateContext(context)?[]:memory;
   const recentIds=new Set(recent.map(item=>item.id));const result=[];
   for(const command of registry.values()){
    if(!visible(command,context))continue;
    const title=String(read(command.title,context)||command.id),description=String(read(command.description,context)||''),keywords=read(command.keywords,context)||[],needle=normalize([title,description,...(Array.isArray(keywords)?keywords:[keywords])].join(' '));
    if(q&&!q.split(/\s+/).every(word=>needle.includes(word)))continue;
    const disabledReason=reason(command,context),recentIndex=recent.findIndex(item=>item.id===command.id),at=recent[recentIndex]?.at||0;
    result.push({type:'command',id:command.id,title,meta:description,shortcut:read(command.shortcut,context)||'',disabledReason,disabled:!!disabledReason,groupKey:!q&&recentIds.has(command.id)?'recent-command':'command',recentAt:at,score:q?(normalize(title)===q?3:normalize(title).startsWith(q)?2:1):recentIndex<0?0:100-recentIndex});
   }
   return result.sort((a,b)=>b.score-a.score).slice(0,40);
  }
  async function execute(id){
   if(running)throw new Error('上一条命令仍在处理，请稍候。');
   const command=registry.get(id),context=getContext()||{};
   if(!command||!visible(command,context))throw new Error('这条命令已不可用，请刷新后重试。');
   const disabledReason=reason(command,context);if(disabledReason)throw new Error(disabledReason);
   const record=!privateContext(context);running=true;
   try{const result=await command.execute(context);if(result===false)throw new Error('命令未完成，请检查当前状态后重试。');
    // Recheck after async work: private mode can change while a command runs.
    if(record&&!privateContext(getContext()||{})&&registry.get(id)===command){memory=[{id,at:now()},...memory.filter(item=>item.id!==id)].slice(0,12);try{storage?.setItem(key,JSON.stringify(memory));}catch{}}
    return result;
   }finally{running=false;}
  }
  function clearRecent(){memory=[];try{storage?.removeItem(key);}catch{}}
  return {register,unregister:id=>registry.delete(id),rows,execute,clearRecent,isRunning:()=>running,recent:()=>memory.filter(item=>registry.has(item.id)).map(item=>({...item}))};
 }
 function nextIndex(current,count,key){if(!count)return -1;if(key==='Home')return 0;if(key==='End')return count-1;if(key==='ArrowDown')return Math.min(count-1,Math.max(0,current+1));if(key==='ArrowUp')return Math.max(0,current<0?count-1:current-1);return current;}
 function createController(hooks={},env=root){
  const doc=env.document,dialog=hooks.dialog||doc?.getElementById('searchDialog'),input=hooks.input||doc?.getElementById('globalSearchInput'),box=hooks.results||doc?.getElementById('searchResults'),meta=hooks.meta||doc?.getElementById('searchMeta');
  if(!dialog||!input||!box||!meta)throw Error('搜索界面尚未就绪。');
  let options=[],active=-1,query='',opener=null,closingReason='cancel',composing=false,focusFrame=null,destroyed=false,island=null,lastRows=[],error='',pending=false;
  let storage=hooks.storage;try{if(storage===undefined)storage=env.localStorage;}catch{}
  const registry=hooks.registry||createRegistry({commands:hooks.commands||[],getContext:hooks.getContext,storage});
  const text=(zh,en)=>env.WorkstationI18n?.getLanguage?.()==='en'?en:zh;
  const notifySuccess=()=>{if(env.CustomEvent)doc.dispatchEvent(new env.CustomEvent('aibro-command-search-success'));};
  const make=(tag,className,value)=>{const node=doc.createElement(tag);node.className=className||'';if(value!==undefined)node.textContent=value;return node;};
  input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-haspopup','listbox');input.setAttribute('aria-expanded',String(dialog.open));input.setAttribute('aria-controls',box.id);box.setAttribute('role','listbox');box.setAttribute('aria-label',text('命令与搜索结果','Commands and search results'));dialog.classList.add('command-search');meta.setAttribute('role','status');meta.setAttribute('aria-live','polite');
  const footer=dialog.querySelector('.search-footer');if(footer){const close=footer.querySelector('button');const hint=(key,label)=>{const n=make('span'),kbd=make('kbd','',key);n.append(kbd,doc.createTextNode(label));return n;};footer.replaceChildren(hint('↑ ↓',text('选择','Navigate')),hint('↵',text('打开所选','Open selected')),hint('Esc',text('关闭','Close')));if(close)footer.append(close);}
  const hiddenSubmit=dialog.querySelector('button.sr-only[type=submit]');if(hiddenSubmit)hiddenSubmit.textContent=text('打开所选结果','Open selected result');
  function ensureVisible(node){if(!node)return;const a=node.getBoundingClientRect(),b=box.getBoundingClientRect();if(a.top<b.top+4)box.scrollTop-=b.top+4-a.top;else if(a.bottom>b.bottom-4)box.scrollTop+=a.bottom-b.bottom+4;}
  function select(index,{scroll=true}={}){
   if(active>=0&&options[active]){options[active].node.setAttribute('aria-selected','false');options[active].node.classList.remove('is-active');}
   active=index>=0&&index<options.length?index:-1;const current=options[active];
   if(current){current.node.setAttribute('aria-selected','true');current.node.classList.add('is-active');input.setAttribute('aria-activedescendant',current.node.id);if(scroll)ensureVisible(current.node);}else input.removeAttribute('aria-activedescendant');return current?.value||null;
  }
  function render(rows,value=''){
   lastRows=rows||[];const nextQuery=String(value).trim(),previous=query===nextQuery?options[active]?.value:null;if(query!==nextQuery)error='';query=nextQuery;
   // React retains keyed rows. Clear the host-owned selection before updating
   // the island; React must not be expected to reset attributes it did not set.
   for(const option of options){option.node.setAttribute('aria-selected','false');option.node.classList.remove('is-active');}
   options=[];active=-1;input.removeAttribute('aria-activedescendant');
   const commandRows=registry.rows(query);rows=[...commandRows,...(query.startsWith('>')?[]:lastRows)];if(commandRows.length)input.placeholder=text('搜索内容或命令，输入 > 只看命令…','Search content or commands; type > for commands…');
   if(env.HalaskaUI?.componentNames?.includes('CommandSearchResults')){
    const buckets=groups(rows).map(group=>({...group,label:group.type==='recent-command'?text('最近使用','Recently used'):group.type==='command'?text('命令','Commands'):hooks.labels?.[group.type]||group.type}));
    meta.textContent=error||(!query?text('选择常用命令，或输入关键词查找工作区内容；> 只搜索命令','Choose an action or search your workspace; > shows commands only'):rows.length?text(`找到 ${rows.length} 个结果 · ↑↓ 选择，Enter 打开`,`Found ${rows.length} results · ↑↓ to choose, Enter to open`):text('没有找到匹配内容','No matching content'));
    meta.classList.toggle('command-search-error',!!error);
    const props={groups:buckets,query,pending,onEdit:()=>{input.focus();input.select();},onClear:()=>{input.value='';input.focus();input.dispatchEvent(new env.Event('input',{bubbles:true}));},onClearRecent:()=>{registry.clearRecent();render(lastRows,query);},icon:hooks.icon};
    if(island)island.update(props);else{box.replaceChildren();island=env.HalaskaUI.mount(box,'CommandSearchResults',props);}
    options=Array.from(box.querySelectorAll('.search-result')).map(node=>({value:node.dataset.searchResult,node,row:rows.find(row=>`${row.type}:${row.id}`===node.dataset.searchResult)}));
    select(Math.max(0,options.findIndex(option=>option.value===previous)),{scroll:false});if(!previous)box.scrollTop=0;else ensureVisible(options[active]?.node);return;
   }
   if(island){island.unmount();island=null;}box.replaceChildren();
   if(commandRows.length)input.placeholder=text('搜索内容或命令，输入 > 只看命令…','Search content or commands; type > for commands…');
   if(!query&&!rows.length){meta.textContent=text('输入关键词，搜索工作站中的可见内容','Search visible content in your workspace');box.scrollTop=0;return;}
   const buckets=groups(rows);meta.textContent=error||(rows.length?text(`找到 ${rows.length} 个结果 · ↑↓ 选择，Enter 打开`,`Found ${rows.length} results · ↑↓ to choose, Enter to open`):text('没有找到匹配内容','No matching content'));meta.classList.toggle('command-search-error',!!error);
   if(!rows.length){const empty=make('div','command-search-empty'),heading=make('strong','',text('换一个更短的关键词','Try a shorter keyword')),description=make('p','',text('可以搜索项目名称、正文中的词语，或附件标题。也可以检查是否有多余空格。','Search a project name, a word from its contents, or an attachment title. Check for extra spaces.')),actions=make('div','command-search-empty-actions');
    for(const [label,clear] of [[text('编辑关键词','Edit query'),false],[text('清空搜索','Clear search'),true]]){const button=make('button','',label);button.type='button';button.onclick=()=>{input.focus();if(clear){input.value='';input.dispatchEvent(new env.Event('input',{bubbles:true}));}else input.select();};actions.append(button);}empty.append(heading,description,actions);box.append(empty);box.scrollTop=0;return;
   }
   buckets.forEach((group,groupIndex)=>{const section=make('div','command-search-group'),heading=make('div','command-search-group-heading'),label=make('span','',group.type==='recent-command'?text('最近使用','Recently used'):group.type==='command'?text('命令','Commands'):hooks.labels?.[group.type]||group.type),count=make('small','',String(group.items.length));heading.id=`command-search-group-${groupIndex}`;heading.append(label,count);section.setAttribute('role','group');section.setAttribute('aria-labelledby',heading.id);section.append(heading);
    group.items.forEach(row=>{const value=`${row.type}:${row.id}`,node=make('button','search-result');node.type='button';node.tabIndex=-1;node.dataset.searchResult=value;node.id=`command-search-option-${options.length}`;node.setAttribute('role','option');node.setAttribute('aria-selected','false');if(row.disabled)node.setAttribute('aria-disabled','true');const icon=make('span','search-result-icon');icon.setAttribute('aria-hidden','true');if(row.type==='command')icon.textContent='›';else if(hooks.icon)icon.innerHTML=hooks.icon(row.type)||'';const copy=make('span','search-result-copy'),title=make('b','',row.title),detail=make('small','',row.disabledReason||row.meta||'');title.title=row.title;title.dataset.userContent='';detail.dataset.userContent='';copy.append(title,detail);const enter=make('span','command-search-enter','↵');enter.setAttribute('aria-hidden','true');node.append(icon,copy,enter);section.append(node);options.push({value,node,row});});box.append(section);
   });
   select(Math.max(0,options.findIndex(option=>option.value===previous)),{scroll:false});if(!previous)box.scrollTop=0;else ensureVisible(options[active]?.node);
  }
  function close(reason='cancel'){closingReason=reason;if(dialog.open)dialog.close();}
  function show(){
   if(dialog.open)return;
   // The native glass host hides the preceding workspace during a modal.
   // WK can then omit a later dialog from AX traversal, as with the retained
   // import dialog. Put this same closed node first; never move an open editor
   // or replace the search input/results and their existing listeners.
   const nativeShell=!!env.webkit?.messageHandlers?.workspace||doc.body?.classList.contains('aibro-native');
   if(nativeShell&&dialog.parentElement===doc.body&&doc.body.firstElementChild!==dialog)doc.body.prepend(dialog);
   dialog.showModal();
  }
  function failActivation(failure){pending=false;error=String(failure?.message||failure);if(destroyed)return;if(hooks.render)hooks.render(query);else render(lastRows,query);show();input.setAttribute('aria-expanded','true');input.focus({preventScroll:true});}
  function activate(value=options[active]?.value){if(composing||pending||!value)return false;const option=options.find(option=>option.value===value);if(!option)return false;
   if(option.row?.type==='command'){
    // Re-evaluate dynamic availability on activation, not just when displayed.
    const fresh=registry.rows(query).find(row=>row.id===option.row.id);if(!fresh||fresh.disabled){error=fresh?.disabledReason||text('这条命令已不可用。','This command is no longer available.');render(lastRows,query);return false;}
    pending=true;close('selection');Promise.resolve(registry.execute(option.row.id)).then(()=>{pending=false;error='';if(!destroyed){notifySuccess();if(dialog.open)render(lastRows,query);}},failActivation);return true;
   }
   // Keep the query that produced the activated row, not mutable input/DOM
   // page metadata. The host resolves this typed ID against current records.
   const selection={query};pending=true;close('selection');Promise.resolve().then(()=>hooks.open?.(value,selection)).then(result=>{
    if(result?.status==='obsolete'){
     pending=false;error='';
     // A newer route/privacy context owns focus now. Do not reopen the old
     // search or leave its cached record titles/excerpts in the closed host.
     if(!destroyed&&!dialog.open){island?.unmount();island=null;lastRows=[];options=[];active=-1;box.replaceChildren();meta.textContent='';input.value='';query='';input.removeAttribute('aria-activedescendant');}
     return;
    }
    if(result===false){failActivation(text('已保留当前位置，所选内容尚未打开。','Your current location was kept; the selected content was not opened.'));return;}
    pending=false;error='';if(!destroyed)notifySuccess();
   },failActivation);return true;
  }
  function open(){if(destroyed)return false;if(dialog.open){input.focus({preventScroll:true});input.select();return true;}opener=doc.activeElement;closingReason='cancel';input.value='';hooks.render?.('');show();input.setAttribute('aria-expanded','true');focusFrame=env.requestAnimationFrame(()=>{focusFrame=null;if(dialog.open)input.focus({preventScroll:true});});return true;}
  function onClose(){if(dialog.open)return;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');if(focusFrame!==null){env.cancelAnimationFrame(focusFrame);focusFrame=null;}if(closingReason!=='selection'&&opener?.isConnected&&opener.getClientRects().length)opener.focus({preventScroll:true});closingReason='cancel';}
  function onCancel(event){event.preventDefault();close();}
  function onKey(event){if(event.isComposing||event.keyCode===229||composing)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}if(event.metaKey||event.ctrlKey||event.altKey)return;if(event.target!==input&&!event.target.closest('.search-result'))return;
   if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){if(event.shiftKey)return;event.preventDefault();select(nextIndex(active,options.length,event.key));input.focus({preventScroll:true});}
   else if(event.key==='Enter'){event.preventDefault();event.stopPropagation();activate();}
  }
  function onClick(event){const node=event.target.closest('.search-result');if(!node||!box.contains(node))return;event.preventDefault();event.stopPropagation();select(options.findIndex(option=>option.node===node),{scroll:false});activate();}
  function onPointer(event){const node=event.target.closest('.search-result');if(node&&box.contains(node))select(options.findIndex(option=>option.node===node),{scroll:false});}
  function onFocus(event){const node=event.target.closest('.search-result');if(node&&box.contains(node))select(options.findIndex(option=>option.node===node),{scroll:false});}
  function onDown(event){if(event.target.closest('.search-result'))event.preventDefault();}
  function onCompositionStart(){composing=true;}function onCompositionEnd(){composing=false;}
  dialog.addEventListener('keydown',onKey);dialog.addEventListener('cancel',onCancel);dialog.addEventListener('close',onClose);box.addEventListener('click',onClick);box.addEventListener('pointermove',onPointer);box.addEventListener('focusin',onFocus);box.addEventListener('mousedown',onDown);input.addEventListener('compositionstart',onCompositionStart);input.addEventListener('compositionend',onCompositionEnd);
  function destroy(){destroyed=true;dialog.removeEventListener('keydown',onKey);dialog.removeEventListener('cancel',onCancel);dialog.removeEventListener('close',onClose);box.removeEventListener('click',onClick);box.removeEventListener('pointermove',onPointer);box.removeEventListener('focusin',onFocus);box.removeEventListener('mousedown',onDown);input.removeEventListener('compositionstart',onCompositionStart);input.removeEventListener('compositionend',onCompositionEnd);if(focusFrame!==null)env.cancelAnimationFrame(focusFrame);island?.unmount();island=null;}
  return {render,open,close,activate,select,selected:()=>options[active]?.value||null,isExecuting:()=>pending,destroy,register:registry.register,unregister:registry.unregister,registry};
 }
 let controller=null;return {groups,nextIndex,createRegistry,createController,RECENT_KEY,init(hooks){if(!controller)controller=createController(hooks);return controller;},register:command=>controller?.register(command),unregister:id=>controller?.unregister(id),open:()=>controller?.open(),render:(rows,query)=>controller?.render(rows,query),activate:()=>controller?.activate(),isExecuting:()=>controller?.isExecuting()||false,selected:()=>controller?.selected()};
});
