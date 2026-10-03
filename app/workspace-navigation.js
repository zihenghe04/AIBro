/* A project's chats, sources and tasks share one navigation context.
   This controller never closes or remounts the reader while changing sections. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkspaceNavigation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const active = item => !!item && !item.archived && !item.archivedAt && !item.deleted && !item.deletedAt && !['archived','deleted'].includes(item.status);
  const sections = ['conversations', 'knowledge', 'outputs', 'tasks', 'schedule', 'overview'];
  const ordinaryConversation = conversation => !conversation?.ephemeral;
  const sectionName = value => value === 'conversation' ? 'conversations' : sections.includes(value) ? value : null;
  function resolveProjectSection(state, projectId, {section, resume = true} = {}) {
    if (!state.projects?.some(project => project.id === projectId && active(project))) return null;
    return sectionName(section) || (resume ? sectionName(state.ui?.workspaceNavigation?.projects?.[projectId]?.section) : null) || 'conversations';
  }
  function timestamp(item) {
    for (const value of [item.updatedAt, item.createdAt]) {
      if (value === undefined || value === null || value === '') continue;
      const number = Number(value), time = Number.isFinite(number) ? number : Date.parse(value);
      if (Number.isFinite(time)) return time;
    }
    return 0;
  }
  function spaceFor(project, conversation, english = false) {
    const value=project?.workspace || conversation?.workspace || 'auto';
    const view=({'日常':'daily',daily:'daily','课程':'courses',courses:'courses','科研':'research',research:'research'})[value] || null;
    const labels=english?{daily:'Daily',courses:'Courses',research:'Research',auto:'Automatic assignment'}:{daily:'日常',courses:'课程',research:'科研',auto:'自动归属'};
    return {value,view,label:labels[view || value] || value};
  }
  function projectFor(state, view, visible = ordinaryConversation) {
    const id = view === 'agent' ? state.conversations?.find(x => x.id === state.currentConversationId && active(x) && visible(x))?.projectId : view === 'project' ? state.currentProjectId : null;
    return state.projects?.find(x => x.id === id && active(x)) || null;
  }
  function conversationFor(state, projectId, visible = ordinaryConversation) {
    if (!state.projects?.some(project => project.id === projectId && active(project))) return null;
    const conversations = (state.conversations || []).filter(x => active(x) && x.projectId === projectId && visible(x));
    const current = conversations.find(x => x.id === state.currentConversationId);
    const remembered = state.ui?.workspaceNavigation?.projects?.[projectId]?.conversationId;
    return conversations.find(x => x.id === remembered) || current || conversations.sort((a,b) => timestamp(b) - timestamp(a))[0] || null;
  }
  function routeFor(state, view, visible = ordinaryConversation) {
    const project = projectFor(state, view, visible);
    const conversation = view === 'agent' ? state.conversations?.find(x => x.id === state.currentConversationId && active(x) && visible(x)) || null : null;
    const section = view === 'agent' ? 'conversations' : sectionName(state.ui?.projectTab) || 'conversations';
    return { view, project, conversation, section, key:view === 'agent' ? `chat:${conversation?.id || ''}` : view === 'project' ? `project:${project?.id || ''}:${section}` : view };
  }
  function createController(hooks, env = {}) {
    const doc = env.document || globalThis.document;
    const raf = env.requestAnimationFrame || globalThis.requestAnimationFrame || (fn => setTimeout(fn,0));
    const getState = hooks.getState;
    const visible = conversation => active(conversation) && (hooks.visibleConversation ? hooks.visibleConversation(conversation) : globalThis.PrivateMode?.shows ? globalThis.PrivateMode.shows(conversation) : ordinaryConversation(conversation));
    const currentRoute = () => routeFor(getState(), doc.body.dataset.view, visible);
    const scrollPositions = new Map(), composerPositions = new Map();
    let previous = null, pending = false, restoreVersion = 0, host = null, crumbs = null, tabs = null, rendered = '', conversationMenu = null, conversationMenuCleanup = null, kitTabsHost = null, pathHost = null, navigationVersion = 0, transition = null;
    const english = () => doc.documentElement?.lang?.startsWith('en');
    const t = (zh,en) => english() ? en : zh;
    const memory = state => { state.ui ||= {}; state.ui.workspaceNavigation ||= {projects:{}}; state.ui.workspaceNavigation.projects ||= {}; return state.ui.workspaceNavigation; };
    const node = (tag, cls, text) => {const e=doc.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
    const button = (text, action, cls = '') => {const e=node('button',cls,text);e.type='button';e.onclick=action;return e;};
    function mount() {
      if (host?.isConnected) return true;
      const main=doc.querySelector('.main');if(!main)return false;
      host=node('nav','workspace-navigation');host.id='workspaceNavigation';host.setAttribute('aria-label',t('当前位置与项目导航','Current location and project navigation'));host.hidden=true;
      crumbs=node('div','workspace-breadcrumbs');crumbs.id='workspaceBreadcrumbs';
      tabs=node('div','workspace-project-tabs section-tabs');tabs.id='workspaceProjectTabs';tabs.setAttribute('aria-label',t('项目工作区','Project workspace'));
      host.append(crumbs,tabs);const topbar=main.querySelector(':scope > .topbar');if(topbar)topbar.after(host);else main.prepend(host);
      doc.addEventListener('pointerdown',event=>{if(conversationMenu&&!conversationMenu.contains(event.target)&&!event.target.closest?.('#workspaceConversationsToggle'))closeConversations();},true);
      host.addEventListener('keydown',event=>{if(event.target.closest?.('[data-halaska-root]'))return;const list=[...tabs.querySelectorAll('button')],i=list.indexOf(doc.activeElement);if(i<0||!['ArrowRight','ArrowLeft','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?list.length-1:(i+(event.key==='ArrowRight'?1:-1)+list.length)%list.length;list[next]?.focus();});
      return true;
    }
    function closeConversations(focus = false) {
      if(!conversationMenu)return;
      conversationMenuCleanup?.();conversationMenuCleanup=null;conversationMenu.remove();conversationMenu=null;
      const toggle=doc.getElementById('workspaceConversationsToggle');toggle?.setAttribute('aria-expanded','false');if(focus){if(toggle?.getClientRects().length)toggle.focus();else doc.getElementById('readingCollapse')?.focus();}
    }
    function openConversations() {
      if(conversationMenu){closeConversations(true);return;}
      const toggle=doc.getElementById('workspaceConversationsToggle');if(!toggle)return;
      const menu=node('section','workspace-conversation-menu');conversationMenu=menu;menu.id='workspaceConversationMenu';menu.setAttribute('role','dialog');menu.setAttribute('aria-label',t('切换对话','Switch chat'));menu.setAttribute('popover','manual');
      const heading=node('div','workspace-conversation-menu-heading');heading.append(node('strong','',t('切换对话','Switch chat')),button(t('关闭','Close'),()=>closeConversations(true),'workspace-conversation-menu-close'));menu.append(heading);
      const search=node('input','workspace-conversation-search');search.type='search';search.placeholder=t('搜索对话或项目…','Search chats or projects…');search.setAttribute('aria-label',search.placeholder);menu.append(search);
      const list=node('div','workspace-conversation-options');menu.append(list);
      function update() {
        const state=getState(),query=search.value.trim().toLocaleLowerCase();list.replaceChildren();
        const items=(state.conversations||[]).filter(visible).map(c=>({conversation:c,project:state.projects?.find(p=>p.id===c.projectId&&active(p))})).filter(x=>`${x.conversation.title||''} ${x.project?.name||''}`.toLocaleLowerCase().includes(query)).sort((a,b)=>timestamp(b.conversation)-timestamp(a.conversation));
        if(!items.length){list.append(node('p','workspace-conversation-empty',t('没有匹配的对话','No matching chats')));return;}
        for(const {conversation:c,project} of items){
          const row=button('',()=>{closeConversations();openConversation(c.id);},'workspace-conversation-option');row.dataset.workspaceConversation=c.id;
          row.append(node('span','workspace-conversation-option-title',c.title||t('新对话','New chat')),node('small','',project?`${spaceFor(project,c,english()).label} / ${project.name}`:c.projectId?t('原项目不可用','Project unavailable'):`${spaceFor(null,c,english()).label} / ${t('未归属项目','No project')}`));
          if(c.id===state.currentConversationId)row.setAttribute('aria-current','page');list.append(row);
        }
      }
      update();search.addEventListener('input',update);
      menu.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeConversations(true);return;}const options=[...list.querySelectorAll('button')],index=options.indexOf(doc.activeElement);if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key)||(doc.activeElement===search&&['Home','End'].includes(event.key)))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?options.length-1:index<0?(event.key==='ArrowUp'?options.length-1:0):(index+(event.key==='ArrowUp'?-1:1)+options.length)%options.length;options[next]?.focus();options[next]?.scrollIntoView?.({block:'nearest'});});
      doc.body.append(menu);menu.showPopover?.();toggle.setAttribute('aria-expanded','true');
      const owner=doc.defaultView||globalThis,viewport=owner.visualViewport;let lastAnchor=toggle.getBoundingClientRect();
      const position=()=>{if(conversationMenu!==menu)return;const anchor=doc.getElementById('workspaceConversationsToggle');if(anchor?.getClientRects().length)lastAnchor=anchor.getBoundingClientRect();const rect=lastAnchor,vw=viewport?.width||doc.documentElement.clientWidth,vh=viewport?.height||owner.innerHeight||800,x=viewport?.offsetLeft||0,y=viewport?.offsetTop||0,width=Math.min(360,Math.max(120,vw-24));let top=rect.bottom+8;if(vh+y-top<180)top=Math.max(y+12,rect.top-Math.min(520,vh-24)-8);top=Math.max(y+12,Math.min(top,y+vh-100));menu.style.width=`${width}px`;menu.style.left=`${Math.max(x+12,Math.min(rect.right-width,x+vw-width-12))}px`;menu.style.top=`${top}px`;menu.style.maxHeight=`${Math.max(76,Math.min(520,y+vh-top-12))}px`;};
      const onScroll=event=>{if(!event.target?.nodeType||!menu.contains(event.target))position();};
      owner.addEventListener('resize',position);doc.addEventListener('scroll',onScroll,true);viewport?.addEventListener('resize',position);viewport?.addEventListener('scroll',position);
      conversationMenuCleanup=()=>{owner.removeEventListener('resize',position);doc.removeEventListener('scroll',onScroll,true);viewport?.removeEventListener('resize',position);viewport?.removeEventListener('scroll',position);};position();
      search.focus();
    }
    function beforeRoute() {
      if (pending) return;
      pending=true;
      const state=getState(),view=doc.body.dataset.view;
      const route=previous || currentRoute();
      if (view === 'agent') {
        const input=doc.getElementById('agentInput'),list=doc.getElementById('messageList');
        // The renderer's owner is authoritative while a caller is updating currentConversationId.
        const id=list?.dataset.conversationId || route.conversation?.id;
        const conversation=state.conversations?.find(x=>x.id===id);
        if (conversation && visible(conversation) && input) {
          conversation.draft=input.value;
          composerPositions.set(id,{start:input.selectionStart,end:input.selectionEnd,direction:input.selectionDirection,scrollTop:input.scrollTop});
          if(!conversation.ephemeral && active(state.projects?.find(p=>p.id===conversation.projectId))){const p=memory(state).projects[conversation.projectId] ||= {};p.conversationId=id;}
        }
        if(list&&id){globalThis.ConversationReading?.remember(list);scrollPositions.set(`chat:${id}`,list.scrollTop);}
      } else if(view==='project') {
        const panel=doc.getElementById('project');if(panel)scrollPositions.set(route.key,panel.scrollTop);
      }
    }
    function restore(route, version) {
      if(version!==restoreVersion)return;
      if(route.view==='agent') {
        const input=doc.getElementById('agentInput'),list=doc.getElementById('messageList'),id=route.conversation?.id;
        if (list?.dataset.conversationId!==id)return;
        const selection=composerPositions.get(id);
        if(input&&selection){input.setSelectionRange(Math.min(selection.start,input.value.length),Math.min(selection.end,input.value.length),selection.direction||'none');input.scrollTop=selection.scrollTop;}
        if(list&&!globalThis.ConversationReading?.restore(list,id)&&scrollPositions.has(route.key))list.scrollTop=scrollPositions.get(route.key);
      } else if(route.view==='project'&&scrollPositions.has(route.key)) {
        const panel=doc.getElementById('project');if(panel)panel.scrollTop=scrollPositions.get(route.key);
      }
    }
    function afterRoute() {
      const state=getState(),route=currentRoute(),changed=previous?.key!==route.key;
      // A host may call this while its protected route is still awaiting a draft flush.
      // Only the accepted transition may persist the destination.
      if(transition)return route;
      pending=false;
      if(route.project&&route.conversation&&!route.conversation.ephemeral){const p=memory(state).projects[route.project.id] ||= {};p.conversationId=route.conversation.id;p.section='conversations';}
      if(route.project&&route.view==='project'){const p=memory(state).projects[route.project.id] ||= {};p.section=route.section;}
      previous=route;render(route);
      if(changed){const version=++restoreVersion;raf(()=>restore(route,version));}
      return route;
    }
    function navigate(action, matches) {
      beforeRoute();
      const token={version:++navigationVersion};transition=token;
      const isCurrent=()=>transition===token && token.version===navigationVersion;
      function finish(result, error) {
        if(!isCurrent())return false;
        transition=null;pending=false;
        const actual=currentRoute(),changed=previous?.key!==actual.key;
        if(error || result===false || !matches(actual)){
          // An external route may have committed while this guard was pending.
          // Its earlier afterRoute was deferred too; reconcile the actual page,
          // never the rejected target, so breadcrumbs and restoration stay current.
          afterRoute();if(changed)hooks.save?.();
          if(error)hooks.onError?.(error);
          return false;
        }
        afterRoute();hooks.save?.();return true;
      }
      try {
        const result=action({isCurrent});
        return result && typeof result.then==='function' ? Promise.resolve(result).then(value=>finish(value),error=>finish(false,error)) : finish(result);
      } catch(error){return finish(false,error);}
    }
    function openConversation(conversationId) {
      const conversation=getState().conversations?.find(item=>item.id===conversationId && visible(item));
      if(!conversation)return false;
      return navigate(options=>(hooks.navigateConversation || hooks.openConversation)(conversation.id,{...options,isCurrent:()=>options.isCurrent() && !!getState().conversations?.some(item=>item.id===conversation.id && visible(item))}),route=>route.view==='agent' && route.conversation?.id===conversation.id);
    }
    function go(section, projectId) {
      section=sectionName(section);
      const state=getState(),project=state.projects?.find(p=>p.id===(projectId||projectFor(state,doc.body.dataset.view,visible)?.id)&&active(p));
      if(!project||!section)return false;
      return navigate(options=>{
        const navigation={...options,section,isCurrent:()=>options.isCurrent() && !!getState().projects?.some(item=>item.id===project.id && active(item))};
        if(hooks.navigateProject)return hooks.navigateProject(project.id,navigation);
        // Legacy hosts may ignore the second argument. Wait for their accepted route
        // before applying its section, so a rejected async hook cannot change the page.
        const apply=result=>{
          if(result===false || !navigation.isCurrent())return false;
          if(doc.body.dataset.view!=='project'||getState().currentProjectId!==project.id)return false;
          getState().ui ||= {};getState().ui.projectTab=section;
          return hooks.applySectionTabs?.('project');
        };
        const result=hooks.openProject(project.id,navigation);
        return result && typeof result.then==='function' ? Promise.resolve(result).then(apply) : apply(result);
      },route=>route.view==='project' && route.project?.id===project.id && route.section===section);
    }
    function enterProject(projectId, options = {}) {
      const section=resolveProjectSection(getState(),projectId,options);
      return section ? go(section,projectId) : false;
    }
    function resumeProject(projectId) {
      const conversation=conversationFor(getState(),projectId,visible);
      return conversation ? openConversation(conversation.id) : false;
    }
    function showView(view,label) {
      if (hooks.navigateLocation) { closeConversations(); return hooks.navigateLocation(view); }
      return navigate(options=>hooks.showView(view,label,options),route=>route.view===view);
    }
    function projectHome(projectId) {return enterProject(projectId);}
    function crumb(text, action, {current=false,id}={}) {
      const e=action?button(text,action,'workspace-crumb'):node('span','workspace-crumb',text);
      e.title=text;if(current)e.setAttribute('aria-current','page');if(id)e.id=id;crumbs.append(e);return e;
    }
    function separator(){const e=node('span','workspace-crumb-separator','/');e.setAttribute('aria-hidden','true');crumbs.append(e);}
    function render(route) {
      if(!mount())return;
      const relevant=['agent','project'].includes(route.view),state=getState();host.hidden=!relevant;
      if(route.view==='project'){const page=doc.getElementById('project');if(page)page.dataset.workspaceSection=route.section;const title=doc.getElementById('projectSectionTitle');if(title)title.textContent=({knowledge:t('资料','Sources'),tasks:t('任务','Tasks'),overview:t('项目总览','Project overview'),schedule:t('排期','Schedule'),outputs:t('成果','Outputs'),conversations:t('对话','Chats')})[route.section]||t('项目总览','Project overview');}
      const matched=relevant?route.project?.id:null;
      for(const row of doc.querySelectorAll('button[data-project-id]')){const scoped=row.dataset.projectId===matched;row.classList.toggle('workspace-current-project',scoped);if(scoped)row.setAttribute('aria-current','location');else if(row.getAttribute('aria-current')==='location')row.removeAttribute('aria-current');}
      doc.body.classList.toggle('workspace-navigation-ready',relevant);if(!relevant){closeConversations();return;}
      const resumed=route.project ? conversationFor(state,route.project.id,visible) : null;
      const paths=route.conversation ? hooks.conversationPathCount?.(route.conversation) || 0 : 0;
      const key=JSON.stringify([resumed?.id,resumed?.title,route.key,route.project?.name,route.project?.workspace,route.conversation?.title,route.conversation?.projectId,route.conversation?.workspace,paths,english()]);
      if(key===rendered)return;rendered=key;
      if(pathHost){globalThis.HalaskaUI?.unmount?.(pathHost);pathHost=null;}
      crumbs.replaceChildren();
      const useKit=!!route.project&&!!globalThis.HalaskaUI;
      if(!useKit){tabs.replaceChildren();kitTabsHost=null;}
      else{for(const child of [...tabs.children])if(child!==kitTabsHost)child.remove();}
      tabs.classList.toggle('kit-workspace-tabs',useKit);tabs.classList.toggle('section-tabs',!useKit);
      crumb(t('工作区','Workspace'),()=>showView(hooks.navigateLocation ? 'overview' : 'dashboard',t('总览','Overview')));separator();
      if(route.project){
        const scope=spaceFor(route.project,route.conversation,english()),space=scope.label,spaceView=scope.view;
        crumb(space,spaceView?()=>showView(spaceView,space):null);separator();
        crumb(route.project.name||t('未命名项目','Untitled project'),()=>projectHome(route.project.id),{id:'workspaceProjectCrumb'});
        if(route.conversation){separator();crumb(route.conversation.title||t('新对话','New chat'),null,{current:true,id:'workspaceConversationCrumb'});}
        else{separator();crumb(({knowledge:t('资料','Sources'),tasks:t('任务','Tasks'),schedule:t('排期','Schedule'),overview:t('总览','Overview'),outputs:t('成果','Outputs'),conversations:t('对话','Chats')})[route.section]||t('总览','Overview'),null,{current:true});}
        const labels={conversations:t('对话','Chats'),knowledge:t('资料','Sources'),outputs:t('成果','Outputs'),tasks:t('任务','Tasks'),schedule:t('排期','Schedule'),overview:t('总览','Overview')};
        if(useKit){
          if(!kitTabsHost){kitTabsHost=node('div','kit-workspace-tabs-host');tabs.prepend(kitTabsHost);}
          globalThis.HalaskaUI.mount(kitTabsHost,'KitTabs',{value:route.section,label:t('项目工作区','Project workspace'),options:sections.map(section=>({value:section,label:labels[section],id:`workspace-tab-${section}`,controls:section==='conversations'&&route.view==='agent'?'agent':`project-panel-${section}`,attributes:{'data-workspace-route':section,'aria-label':section==='conversations'?t('查看项目对话列表','View project chats'):labels[section]}})),onChange:section=>go(section,route.project.id)});
        }else for(const section of sections){const b=button(labels[section],()=>go(section,route.project.id),'section-tab');b.dataset.workspaceRoute=section;const selected=route.section===section;b.classList.toggle('active',selected);if(selected)b.setAttribute('aria-current','page');b.setAttribute('aria-label',section==='conversations'?t('查看项目对话列表','View project chats'):labels[section]);tabs.append(b);}
        // The tab is always the list. Resuming a thread is a separate, explicit action.
        if(resumed && (route.view!=='agent' || route.conversation?.id!==resumed.id)){
          const title=t(`继续对话：${resumed.title||'新对话'}`,`Continue chat: ${resumed.title||'New chat'}`);
          const action=()=>getState().conversations?.some(item=>item.id===resumed.id && item.projectId===route.project.id && visible(item)) ? openConversation(resumed.id) : false;
          if(useKit){
            const resumeHost=node('div','workspace-resume-chat');tabs.append(resumeHost);
            globalThis.HalaskaUI.mount(resumeHost,'Button',{id:'workspaceResumeChat',children:t('继续对话','Continue chat'),variant:'ghost',size:'sm',title,'aria-label':title,onClick:action});
          }else{
            const resume=button(t('继续对话','Continue chat'),action,'workspace-resume-chat');resume.id='workspaceResumeChat';resume.title=title;resume.setAttribute('aria-label',title);tabs.append(resume);
          }
        }
      }else{
        const unavailable=!!route.conversation?.projectId;
        const scope=spaceFor(null,route.conversation,english());
        crumb(scope.label,scope.view?()=>showView(scope.view,scope.label):null);separator();
        crumb(unavailable?t('原项目不可用','Project unavailable'):t('未归属项目','No project'),null,{id:'workspaceUnassignedCrumb'});separator();
        crumb(route.conversation?.title||t('新对话','New chat'),null,{current:true,id:'workspaceConversationCrumb'});
        const choose=button(unavailable?t('更换项目','Change project'):t('选择项目','Choose project'),()=>hooks.chooseProject?.(),'workspace-choose-project');choose.id='workspaceChooseProject';tabs.append(choose);
        const hint=node('span','workspace-scope-hint',t('在同一项目中连续处理对话、资料与任务','Keep chats, sources and tasks together in a project'));tabs.append(hint);
      }
      if(paths>0 && hooks.openConversationPaths){
        const id=route.conversation.id;
        const open=()=>{const current=currentRoute();if(current.view==='agent'&&current.conversation?.id===id){closeConversations();hooks.openConversationPaths();}};
        const label=t(`${paths+1} 个分支`,`${paths+1} branches`),title=t('切换这条对话的分支','Switch branches in this chat');
        pathHost=node('span','workspace-paths');crumbs.append(pathHost);
        if(globalThis.HalaskaUI){globalThis.HalaskaUI.mount(pathHost,'Button',{id:'workspacePathsToggle',children:label,variant:'ghost',size:'sm',title,'aria-label':label,'aria-haspopup':'dialog',onClick:open,style:{padding:'4px 8px',minHeight:28,height:28,fontSize:11,boxShadow:'none'}});}
        else{const toggle=button(label,open);toggle.id='workspacePathsToggle';toggle.title=title;toggle.setAttribute('aria-haspopup','dialog');pathHost.append(toggle);}
      }
      const allChats=button(t('切换对话','Switch chat'),openConversations,'workspace-all-chats');allChats.id='workspaceConversationsToggle';allChats.setAttribute('aria-haspopup','dialog');allChats.setAttribute('aria-expanded',String(!!conversationMenu));allChats.setAttribute('aria-controls','workspaceConversationMenu');crumbs.append(allChats);
    }
    return {beforeRoute,afterRoute,refresh:afterRoute,dismissTransient:()=>closeConversations(false),go,projectHome,enterProject,resumeProject,openConversation,get route(){return previous;}};
  }
  let controller;
  return {active,sections,resolveProjectSection,spaceFor,projectFor,conversationFor,routeFor,createController,init(hooks,env){controller=createController(hooks,env);controller.afterRoute();return controller;},dismissTransient:()=>controller?.dismissTransient(),beforeRoute:()=>controller?.beforeRoute(),afterRoute:()=>controller?.afterRoute(),refresh:()=>controller?.afterRoute(),go:(...args)=>controller?.go(...args),enterProject:(...args)=>controller?.enterProject(...args),projectHome:(...args)=>controller?.projectHome(...args),resumeProject:(...args)=>controller?.resumeProject(...args)};
});
