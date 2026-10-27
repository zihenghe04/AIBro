/* Project navigation and request evidence stay beside the conversation. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.AgentWorkspace=api;})(globalThis,function(root){
 'use strict';
 const t=(zh,en)=>root.WorkstationI18n?.getLanguage?.()==='en'?en:zh;
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let hooks={},treeKey='',contextKey='',home=null,initializedPane=null,fileTree=null;
 function hasContextWorkbench(){return !!(root.document?.getElementById('contextWorkbench')&&typeof root.ContextWorkbench?.refresh==='function');}
 function ensureEvidence(){
  const doc=root.document,context=doc?.getElementById('inspectorContext');if(!context)return null;
  if(hasContextWorkbench()){doc.getElementById('requestContextEvidence')?.remove();contextKey='';return null;}
  let evidence=doc.getElementById('requestContextEvidence');if(!evidence){evidence=doc.createElement('section');evidence.id='requestContextEvidence';evidence.className='request-evidence';context.append(evidence);}
  return evidence;
 }
 function fileScope(){
  const state=hooks.state?.(),doc=root.document;if(!state)return null;
  if(root.DocumentFileTree?.resolveScope)return root.DocumentFileTree.resolveScope(state,hooks.conversation?.(),doc.body.dataset.view,doc.body.classList.contains('reading-open'));
  const conversation=hooks.conversation?.(),project=state.projects?.find(item=>item.id===conversation?.projectId&&!item.archived&&!item.archivedAt&&!item.deleted&&!item.deletedAt);
  return doc.body.dataset.view==='agent'&&project?{conversationId:conversation.id,projectId:project.id,name:project.name,key:'conversation:'+conversation.id}:null;
 }
 function placePane(){
  const state=hooks.state?.(),doc=root.document,pane=doc?.getElementById('conversationInspector'),reader=doc?.getElementById('readingPane');if(!pane||!reader||!home)return;
  const scope=fileScope(),dock=!!(state?.ui?.inspectorOpen&&doc.body.classList.contains('reading-open')&&(doc.body.dataset.view==='agent'||state.ui.inspector==='files'&&scope));
  const destination=dock?reader:home;if(pane.parentElement!==destination)destination.append(pane);
  reader.classList.toggle('with-project-files',dock);
  reader.classList.toggle('with-context-workbench',dock&&state.ui.inspector==='context'&&hasContextWorkbench());
  pane.dataset.documentScope=doc.body.dataset.view==='agent'?'conversation':'library';
  const toggle=doc.getElementById('readerFilesToggle');if(toggle){toggle.hidden=!scope;toggle.setAttribute('aria-expanded',String(dock&&state.ui.inspector==='files'));}
 }
 function snapshot(state,conversation){
  const runs=(state.agentRuns||[]).filter(r=>r.conversationId===conversation?.id&&!r.deletedAt);
  const run=runs.reduce((last,r)=>(r.startedAt||r.requestedAt||0)>=(last?.startedAt||last?.requestedAt||0)?r:last,null);
  const metrics=run?.contextMetrics;
  const history=metrics?.history||run?.historyCoverage;
  return {runId:run?.id||null,status:run?.status||null,estimatedTokens:Number.isFinite(metrics?.estimatedTokens)?metrics.estimatedTokens:null,
   characters:Number.isFinite(metrics?.characters)?metrics.characters:null,history:history?{included:history.includedMessages,total:history.totalMessages,omitted:history.omittedMessages}:null,
   capabilities:Array.isArray(metrics?.loadedCapabilities)?metrics.loadedCapabilities:[],reads:run?.knowledgeReads||[],tools:run?.toolCalls||[],
   files:run?.fileReferences||[],summaryItems:conversation?.contextSummary?.items?.length||0};
 }
 function updateTabs(){
  const state=hooks.state?.();if(!state)return;
  const tab=state.ui?.inspector||'context',open=!!state.ui?.inspectorOpen;
  const pane=root.document.getElementById('conversationInspector');if(pane)pane.dataset.workspaceTab=tab;
  root.document.getElementById('inspectorFiles')?.classList.toggle('hidden',tab!=='files');
  const toggle=root.document.getElementById('workspaceFilesToggle');if(toggle){toggle.setAttribute('aria-expanded',String(open&&tab==='files'));toggle.classList.toggle('active',open&&tab==='files');}
  if(open&&tab==='files')syncTree();
  placePane();
 }
 function syncTree(){
  const state=hooks.state?.(),conversation=hooks.conversation?.(),host=root.document.getElementById('conversationProjectFiles');if(!state||!host)return;
  if(root.DocumentFileTree?.create&&root.HalaskaUI?.mount&&(root.DocumentFiles||root.DocumentFileCatalog)){
   if(!fileTree)fileTree=root.DocumentFileTree.create({host,state:()=>hooks.state(),scope:fileScope,open:(...args)=>hooks.open?.(...args),add:hooks.add?scope=>hooks.add(scope):undefined,toast:message=>hooks.toast?.(message),opened:()=>{
    const reader=root.document.getElementById('readingPane');if(reader&&reader.getBoundingClientRect().width<620){hooks.state().ui.inspectorOpen=false;hooks.apply?.();hooks.save?.();}
   }});
   fileTree.sync();return;
  }
  const project=state.projects.find(p=>p.id===conversation?.projectId&&!p.archived&&!p.deletedAt);
  if(!project){treeKey='';host.innerHTML=`<div class="workspace-empty"><strong>${t('为对话选择项目','Choose a project')}</strong><p>${t('选择后，项目资料和本机目录会显示在这里。','Project documents and connected files will appear here.')}</p><button type="button" class="secondary" data-workspace-choose>${t('选择项目','Choose project')}</button></div>`;host.querySelector('button').onclick=()=>root.document.getElementById('chatContextBtn')?.click();return;}
  const key=JSON.stringify([project.id,project.name,project.localFolder,state.notes.filter(n=>n.projectId===project.id).map(n=>[n.id,n.updatedAt,n.title,n.folderPath,n.deletedAt,n.archived]),state.imports.filter(n=>n.projectId===project.id).map(n=>[n.id,n.updatedAt,n.name,n.folderPath,n.deletedAt,n.archived])]);
  if(key!==treeKey||!host.firstElementChild){treeKey=key;root.ProjectFiles?.renderForProject?.(host,project.id);}
 }
 // Connected native browser and the built-in browser plugin enabled (plugin-host.js).
 const browserOn=()=>!!root.BrowserTools?.available?.()&&(root.AIBroPlugins?.default?root.AIBroPlugins.default.enabled('browser'):true);
 function sync(){
  const state=hooks.state?.(),conversation=hooks.conversation?.();if(!state)return;
  const button=root.document.getElementById('workspaceFilesToggle');if(button)button.hidden=root.DocumentFileTree? !fileScope() : !conversation?.projectId;
  const host=ensureEvidence();
  if(hasContextWorkbench()){root.ContextWorkbench.refresh();updateTabs();return;}
  if(!host||!conversation){if(host){host.replaceChildren();contextKey='';}updateTabs();return;}
  const browserAvailable=browserOn();
  // The browser plugin can be disabled in settings; its entry points follow at once.
  for(const id of ['workspaceBrowserToggle','composerBrowserToggle']){const node=root.document.getElementById(id);if(node)node.hidden=!browserAvailable;}
  const value=snapshot(state,conversation),run=(state.agentRuns||[]).find(item=>item.id===value.runId);
  const message=(conversation.messages||[]).find(item=>!item.deletedAt&&item.runId===run?.id);
  // Request excerpts are immutable. Stable IDs/versions avoid serializing the
  // entire retained document corpus on every streamed conversation refresh.
  const evidenceKey=(run?.evidenceSources||[]).map(source=>{
   const record=root.CitationEvidence?.recordFor(state,source.type,source.id);
   return [source.sourceId,source.version,source.bodyHash,source.excerpt?.length,record?.updatedAt,record?.deletedAt,record?.archived,!!record];
  });
  const key=JSON.stringify([value,evidenceKey,run?.evidenceLimitReached,message?.id,message?.webSources,browserAvailable,root.WorkstationI18n?.getLanguage?.()]);
  if(contextKey!==key){
   contextKey=key;
   const row=(label,value)=>`<div class="request-evidence-row"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
   const format=n=>Number(n).toLocaleString();
   const labels={tasks:t('任务','Tasks'),knowledge:t('知识库','Knowledge'),research:t('研究','Research'),files:t('文件','Files'),agenda:t('日程','Calendar'),memory:t('项目记忆','Memory')};
   host.innerHTML=`<h2>${t('最近一次请求','Latest request')}</h2><p class="request-evidence-note">${t('这里只展示已记录的请求信息。下一次发送可能不同。','Recorded request evidence. Your next request may differ.')}</p>`
    +row(t('文本规模（本地估算）','Text size (estimated)'),value.estimatedTokens===null?t('尚无请求记录','No request yet'):`~${format(value.estimatedTokens)} tokens`)
    +(value.history?row(t('带入的历史消息','History messages included'),`${value.history.included??'?'} / ${value.history.total??'?'}`):'')
    +(value.history?.omitted?`<p class="request-evidence-note">${t(`其余 ${value.history.omitted} 条原文仍保留，可由历史工具回查。`,`${value.history.omitted} other messages remain available through history tools.`)}</p>`:'')
    +row(t('读取记录','Read records'),value.reads.length)+row(t('工具调用记录','Tool records'),value.tools.length)
    +`<div class="request-capabilities">${value.capabilities.map(x=>`<span>${esc(labels[x]||x)}</span>`).join('')||`<span>${t('尚未加载操作能力','No action capability loaded')}</span>`}</div>`
    +(value.reads.length?`<details class="request-sources"><summary>${t('核对读取来源','Inspect read sources')}</summary><ul>${value.reads.map(r=>`<li><span>${esc(r.title||r.id||r.type)}</span><small>${esc(r.error||[r.type,r.page?`p.${r.page}`:'',r.offset!=null?`@${r.offset}`:''].filter(Boolean).join(' · '))}</small></li>`).join('')}</ul></details>`:'')
    +`<p class="request-evidence-note">${t('Token 数仅估算请求文本，不含图像等模态，也不是模型剩余额度或服务端实测用量。','Token estimates cover request text, not images, remaining model capacity, or billed usage.')}</p>`
    +`<details class="workspace-capability-notice"><summary>${t('网页与电脑操作能力','Browser and computer capabilities')}</summary><p>${browserAvailable?t('原生浏览器已连接：可打开网页、读取页面、点击控件、填写内容、截图，并交由你接管和继续。操作由所属任务和页面授权约束。当前不支持控制其他浏览器或 macOS 应用。','The native browser is connected: open pages, inspect content, click controls, type, take screenshots and hand over to you. Actions stay within the owning task and site permissions. Other browsers and macOS apps are not controlled.'):t('此运行环境支持网页搜索、链接阅读和已授权的本机工具。网页点击、截图与人工接管需要打开原生 macOS 版本；当前环境没有连接该浏览器。','Search, URL reading and authorized local tools are available. Browser clicks, screenshots and handoff require the native macOS app; this runtime has no browser connection.')}</p></details>`;
   const citations=message&&root.CitationEvidence?.section(message,run,state);
   if(citations){host.querySelector('.request-sources')?.remove();host.append(citations);}
  }
  updateTabs();
 }
 function init(options){
  hooks=options||{};const doc=root.document,pane=doc?.getElementById('conversationInspector');if(!pane)return;
  // Streaming and host reinitialization must keep the same file tree, DOM focus
  // and React root. ContextWorkbench owns its island lifecycle.
  if(initializedPane===pane){sync();return;}fileTree?.dispose();fileTree=null;initializedPane=pane;home=pane.parentElement;treeKey='';contextKey='';
  const tab=doc.createElement('button');tab.type='button';tab.className='inspector-tab';tab.dataset.inspector='files';tab.textContent=t('文件','Files');pane.querySelector('.inspector-tabs').prepend(tab);
  const files=doc.createElement('div');files.id='inspectorFiles';files.className='inspector-content hidden';const tree=doc.createElement('div');tree.id='conversationProjectFiles';files.append(tree);pane.append(files);
  ensureEvidence();
  pane.querySelector('[data-inspector="context"]')?.addEventListener('click',event=>{
   if(!hasContextWorkbench()||typeof root.ContextWorkbench.open!=='function')return;
   event.preventDefault();event.stopPropagation();root.ContextWorkbench.open();
  });
  const button=doc.createElement('button');button.id='workspaceFilesToggle';button.type='button';button.className='workspace-files-toggle';button.setAttribute('aria-controls','conversationInspector');button.setAttribute('aria-expanded','false');button.setAttribute('aria-label',t('文件工作区','File workspace'));button.title=t('文件工作区','File workspace');button.innerHTML=`<span aria-hidden="true" class="workspace-files-icon"></span><span>${t('文件','Files')}</span>`;
  button.onclick=()=>{const s=hooks.state();s.ui.inspectorOpen=!(s.ui.inspectorOpen&&s.ui.inspector==='files');s.ui.inspector='files';hooks.apply?.();hooks.save?.();sync();};
  doc.querySelector('.chat-header-actions')?.prepend(button);
  if(root.BrowserTools?.available?.()){
   const browse=doc.createElement('button');browse.id='workspaceBrowserToggle';browse.type='button';browse.className='workspace-files-toggle';browse.textContent=t('浏览器','Browser');browse.title=t('打开内置浏览器','Open built-in browser');browse.onclick=()=>root.BrowserTools.open().catch(()=>{});doc.querySelector('.chat-header-actions')?.prepend(browse);
   const composerBrowse=browse.cloneNode(true);composerBrowse.id='composerBrowserToggle';composerBrowse.className='composer-local native-browser-entry';composerBrowse.setAttribute('aria-label',browse.title);composerBrowse.innerHTML='<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18"/><circle cx="6.5" cy="6.5" r=".5"/><circle cx="9.5" cy="6.5" r=".5"/></svg>';composerBrowse.onclick=browse.onclick;doc.querySelector('.composer-footer')?.insertBefore(composerBrowse,root.ComposerUI?.rootFor(doc.getElementById('composerLocal'))||doc.getElementById('composerLocal'));
  }
  const readerToggle=button.cloneNode(true);readerToggle.id='readerFilesToggle';readerToggle.setAttribute('aria-label',t('文件工作区','File workspace'));readerToggle.onclick=button.onclick;doc.querySelector('.reading-toolbar')?.insertBefore(readerToggle,doc.getElementById('readingExpand'));
  const close=doc.createElement('button');close.type='button';close.className='workspace-inspector-close';close.textContent='×';close.setAttribute('aria-label',t('关闭面板','Close panel'));close.onclick=()=>{const s=hooks.state(),files=s.ui.inspector==='files',reader=doc.body.classList.contains('reading-open');s.ui.inspectorOpen=false;hooks.apply?.();hooks.save?.();updateTabs();const opener=files?doc.getElementById(reader?'readerFilesToggle':'workspaceFilesToggle'):doc.getElementById('inspectorToggle');(opener?.getClientRects().length?opener:doc.querySelector('#composerContextWorkbench button'))?.focus();};pane.querySelector('.inspector-tabs').append(close);
  files.addEventListener('click',event=>{if(!fileTree&&event.target.closest('[data-project-file-key]')&&doc.getElementById('readingPane')?.getBoundingClientRect().width<620){hooks.state().ui.inspectorOpen=false;hooks.apply?.();hooks.save?.();}});
  new MutationObserver(()=>{placePane();if(hooks.state?.()?.ui?.inspectorOpen&&hooks.state?.()?.ui?.inspector==='files')syncTree();}).observe(doc.body,{attributes:true,attributeFilter:['class','data-view']});
  // Opening another native pane can make a previously docked tree a drawer.
  // Collapse on that transition; an explicit narrow-window open stays open.
  if(root.ResizeObserver){let previousWidth=0;new ResizeObserver(entries=>{
   const width=entries[0]?.contentRect.width||0,s=hooks.state?.();
   const becameNarrow=previousWidth>=620&&width>0&&width<620;previousWidth=width;
   if(becameNarrow&&s?.ui?.inspectorOpen&&doc.body.classList.contains('reading-open')){s.ui.inspectorOpen=false;hooks.apply?.();hooks.save?.();}
  }).observe(doc.getElementById('readingPane'));}
  sync();
 }
 return {init,sync,updateTabs,snapshot,fileScope};
});
