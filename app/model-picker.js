/* Conversation preferences are separate from connection defaults and immutable run snapshots. */
(function(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ConversationModels = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
  'use strict';
  const labels = { none: '不使用推理', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '非常高', max: '最大', ultra: '极高' };
  const idOf = entry => entry?.model || entry?.id || '';
  const claudeModels = ['', 'sonnet', 'opus', 'haiku'];
  const configured = value => value && (String(value.model || '').trim() || ['openai-auth','claude-auth'].includes(value.provider));
  let pendingPreference=null;
  function committedConversation(conversation){
    if(!pendingPreference||pendingPreference.conversation!==conversation)return conversation;
    const view={...conversation},before=pendingPreference.before.get('modelConfig');
    if(before.exists)view.modelConfig=structuredClone(before.value);else delete view.modelConfig;
    return view;
  }
  // The host retires the Claude login entry: until Claude is switched back on, a conversation (or default)
  // that still points at it uses the fallback model instead. Unset (tests, old hosts) keeps the old behaviour.
  let claudeGate = null, claudeFallbackHook = null;
  function configure(options) {
    if (options && typeof options.claudeEnabled === 'function') claudeGate = options.claudeEnabled;
    if (options && typeof options.claudeFallback === 'function') claudeFallbackHook = options.claudeFallback;
  }
  function retiredClaude(source) {
    if (source?.provider !== 'claude-auth' || !claudeGate || claudeGate()) return null;
    const replacement = claudeFallbackHook ? claudeFallbackHook(source) : null;
    return replacement && replacement.provider !== 'claude-auth' ? replacement : { provider: 'api', model: '', effort: '' };
  }
  function configuration(conversation, defaults = {}) {
    const preferred = committedConversation(conversation)?.modelConfig;
    let source = configured(preferred) ? preferred : defaults;
    source = retiredClaude(source) || source;
    const provider = ['openai-auth','claude-auth'].includes(source.provider) ? source.provider : 'api', connection = provider === 'api' && typeof source.connection === 'string' ? source.connection.trim() : '';
    return { provider, ...(connection ? { connection } : {}), model: String(source.model || '').trim(), effort: source.effort && source.effort !== 'auto' ? String(source.effort) : '' };
  }
  function remember(state, config) {
    if (!state) return;
    state.settings ||= {};
    state.settings.recentConversationModel = configuration({ modelConfig: config });
  }
  function forNewConversation(state, defaults = {}) {
    if(pendingPreference?.state===state){
      const pending=pendingPreference,settings={...state.settings};
      if(pending.hadRecent)settings.recentConversationModel=pending.recent;else delete settings.recentConversationModel;
      state={...state,settings,conversations:(state.conversations||[]).map(committedConversation)};
    }
    if (configured(state?.settings?.recentConversationModel)) return configuration({ modelConfig: state.settings.recentConversationModel }, defaults);
    // Migrate existing workspaces from their latest chosen/used configuration.
    const candidates = (state?.conversations || []).flatMap(c => {
      if (c.deleted || c.deletedAt) return [];
      const result = (c.messages || []).filter(m => configured(m.modelConfig)).map(m => ({ config: m.modelConfig, at: Number(m.at) || 0 }));
      if (configured(c.modelConfig)) result.push({ config: c.modelConfig, at: Number(c.updatedAt || c.createdAt) || 0 });
      return result;
    }).sort((a, b) => b.at - a.at);
    return configuration(candidates.length ? { modelConfig: candidates[0].config } : null, defaults);
  }
  function effortsFor(models, model) {
    const entry = model ? models.find(x => idOf(x) === model) : models.find(x => x.isDefault);
    return (entry?.supportedReasoningEfforts || []).map(x => typeof x === 'string' ? x : x.reasoningEffort).filter(x => typeof x === 'string' && x);
  }
  function setSelection(conversation, value) {
    const next = configuration({ modelConfig: value });
    conversation.modelConfig = next;
    conversation.modelChoices = { ...conversation.modelChoices, [next.provider]: { model: next.model, effort: next.effort } };
    return { ...next };
  }
  function describe(config) {
    return `${config.model || (config.provider === 'claude-auth' ? 'Claude 官方默认' : config.provider === 'openai-auth' ? '账号默认模型' : '选择模型')} · ${config.effort ? (labels[config.effort] || config.effort) : '默认推理'}`;
  }

  const t=(zh,en)=>root.WorkstationI18n?.getLanguage?.()==='en'||/^en(?:-|$)/i.test(root.document?.documentElement?.lang||'')?en:zh;
  const effortLabel=value=>({none:t('不使用推理','No reasoning'),minimal:t('最少','Minimal'),low:t('低','Low'),medium:t('中','Medium'),high:t('高','High'),xhigh:t('非常高','Extra high'),max:t('最大','Maximum'),ultra:t('极高','Ultra')})[value]||value;
  const active=value=>value&&!value.archived&&!value.archivedAt&&!value.deleted&&!value.deletedAt;
  // live: the signed-in account's model catalogue (read when the panel opens); pending: the choice being saved.
  let hooks={},live=[],version=0,targetId=null,loading=false,modelError='',saveError='',saving=false,fetchAbort=null,initialized=false,returnFocus=null,presented=false,closing=false,pending=null,query='',activeIndex=0,ui=null;
  const $=id=>root.document.getElementById(id);
  const isOpen=()=>presented&&$('modelPicker')?.hidden===false;
  const defaults=()=>hooks.getDefaults?.()||{};
  const resolved=conversation=>hooks.getResolvedConfig?.(committedConversation(conversation))||configuration(conversation,defaults());
  const current=()=>resolved(hooks.getConversation?.());
  const target=()=>hooks.getState?.()?.conversations?.find(value=>value.id===targetId&&active(value));
  const sourceLabel=source=>({conversation:t('对话设定','Conversation'),project:t('项目设定','Project'),workspace:t('工作区设定','Workspace'),default:t('全局默认','Global default')})[source]||t('继承默认','Inherited default');
  const choices=()=>root.ModelChoices;
  const settings=()=>hooks.getState?.()?.settings||{};
  const claudeOn=()=>!!(claudeGate&&claudeGate());
  const groups=()=>choices()?choices().groups(settings(),{live,claudeEnabled:claudeOn()}):[];
  const selectionOf=config=>choices().selectionFrom(settings(),config,{activeBase:hooks.getActiveBase?.()||''});
  const shownSelection=()=>pending||selectionOf(current());
  const sourceOf=conversation=>{const config=conversation?resolved(conversation):current();return config.source||(conversation?.modelConfig?'conversation':null);};
  async function fetchModels(parentSignal){
    const controller=new AbortController(),abort=()=>controller.abort();parentSignal?.addEventListener?.('abort',abort,{once:true});if(parentSignal?.aborted)abort();
    const timeout=setTimeout(abort,20000);
    try{const response=await root.fetch(root.OpenAIAuth?.mode?.()==='shared'?'/__auth/models?mode=shared&cache=1':root.OpenAIAuth?.mode?.()==='oauth'?'/__auth/models?mode=oauth':'/__auth/models',{signal:controller.signal});const result=await response.json();if(!response.ok)throw Error(result.error?.message||result.message||t('请先在设置中连接 OpenAI 账号。','Connect your OpenAI account in settings first.'));return (result.data||result.models||[]).filter(entry=>idOf(entry));}
    catch(error){if(error.name==='AbortError')throw Error(t('读取模型超时，请重试。','Loading models timed out. Try again.'));throw error;}
    finally{clearTimeout(timeout);parentSignal?.removeEventListener?.('abort',abort);}
  }

  function position(){
    const dialog=$('modelPicker');if(!isOpen())return;const anchor=$('composerModel')?.getBoundingClientRect?.(),bounds=dialog.getBoundingClientRect?.();if(!anchor||!bounds)return;
    dialog.style.left=`${Math.max(12,Math.min(anchor.right-bounds.width,root.innerWidth-bounds.width-12))}px`;
    dialog.style.top=`${Math.max(12,Math.min(anchor.top-bounds.height-10,root.innerHeight-bounds.height-12))}px`;
    dialog.style.maxHeight=`${Math.max(280,anchor.top-24)}px`;
  }
  async function persist(conversation,change){
    const state=hooks.getState?.(),fields=['modelConfig','modelChoices'],before=new Map(fields.map(key=>[key,{exists:Object.hasOwn(conversation,key),value:structuredClone(conversation[key])}]));
    const hadSettings=!!state.settings,hadRecent=!!state.settings&&Object.hasOwn(state.settings,'recentConversationModel'),recent=structuredClone(state.settings?.recentConversationModel);
    const pending={state,conversation,before,hadRecent,recent};pendingPreference=pending;
    change();const applied=new Map(fields.map(key=>[key,JSON.stringify(conversation[key])])),appliedRecent=JSON.stringify(state.settings?.recentConversationModel);
    try{if(await hooks.save?.()===false)throw Error(t('模型设置未能保存，请重试。','Model settings could not be saved. Try again.'));}
    catch(error){for(const key of fields)if(JSON.stringify(conversation[key])===applied.get(key)){const old=before.get(key);if(old.exists)conversation[key]=old.value;else delete conversation[key];}if(JSON.stringify(state.settings?.recentConversationModel)===appliedRecent){if(hadRecent)state.settings.recentConversationModel=recent;else if(state.settings)delete state.settings.recentConversationModel;if(!hadSettings&&state.settings&&!Object.keys(state.settings).length)delete state.settings;}throw error;}
    finally{if(pendingPreference===pending)pendingPreference=null;}
  }

  // ---- panel (UIKit controls; built once, repainted from state) ----
  const kit=()=>root.UIKit;
  const h=(...args)=>kit().h(...args);
  function build(panel){
    const K=kit();
    const search=h('input',{class:'mp-search',type:'search',id:'modelPickerSearch',autocomplete:'off',spellcheck:'false','aria-label':t('搜索模型','Search models'),'aria-controls':'modelPickerList',placeholder:t('搜索模型或供应商','Search models or providers')});
    ui={
      title:h('b',{id:'modelPickerTitle'}),source:h('small',{id:'modelPickerSource'}),
      reset:h('button',{type:'button',class:'mp-reset',id:'resetModelSelection'}),
      close:h('button',{type:'button',class:'mp-close',id:'closeModelPicker','aria-label':t('关闭模型选择','Close model picker')},K.glyph('check',1)),
      search,list:h('div',{class:'mp-list',id:'modelPickerList',role:'listbox','aria-label':t('模型','Models')}),
      effort:h('div',{class:'mp-effort',id:'modelPickerEffort',hidden:true}),
      status:h('p',{class:'mp-status',id:'modelPickerStatus',role:'status','aria-live':'polite'}),
      settings:h('button',{type:'button',class:'mp-manage',id:'modelPickerSettings'})
    };
    ui.close.replaceChildren(h('span',{'aria-hidden':'true',text:'×'}));
    panel.replaceChildren(
      h('header',{class:'mp-head'},h('span',{class:'mp-spark','aria-hidden':'true'},K.glyph('spark',18)),h('div',{class:'mp-heading'},ui.title,ui.source),ui.reset,ui.close),
      h('div',{class:'mp-searchrow'},K.glyph('search',14),search),
      ui.list,ui.effort,ui.status,
      h('footer',{class:'mp-foot'},h('span',{class:'mp-hint'},h('kbd',{text:'Esc'}),' ',t('关闭','Close')),ui.settings));
    ui.close.addEventListener('click',()=>close());
    ui.reset.addEventListener('click',()=>{void resetInherit();});
    ui.settings.addEventListener('click',()=>{if(saving)return;close();hooks.openSettings?.();});
    search.addEventListener('input',()=>{query=search.value;activeIndex=0;paintList();});
    panel.addEventListener('keydown',onPanelKey);
  }
  function onPanelKey(event){
    if(event.isComposing||event.keyCode===229)return;
    const options=[...ui.list.querySelectorAll('[role=option]:not([aria-disabled=true])')];
    const step={ArrowDown:1,ArrowUp:-1}[event.key];
    if(step&&options.length){event.preventDefault();activeIndex=(activeIndex+step+options.length)%options.length;markActive(options);}
    else if(event.key==='Enter'&&event.target===ui.search&&options[activeIndex]){event.preventDefault();options[activeIndex].click();}
  }
  function markActive(options=[...ui.list.querySelectorAll('[role=option]:not([aria-disabled=true])')]){
    options.forEach((node,index)=>node.classList.toggle('is-active',index===activeIndex));
    const node=options[activeIndex];if(node){ui.search.setAttribute('aria-activedescendant',node.id);node.scrollIntoView?.({block:'nearest'});}
  }
  const matches=(group,entry,needle)=>!needle||needle.split(/\s+/).every(part=>`${group.name} ${group.host} ${entry.label} ${entry.model}`.toLowerCase().includes(part));
  function paintList(){
    const K=kit(),shown=shownSelection(),all=groups(),needle=query.trim().toLowerCase();
    ui.list.replaceChildren();let index=0;
    const found=choices().findChoice(all,shown);
    // The current choice may point at a model or provider that is no longer listed: keep it visible instead of silently switching.
    if(!found.model&&(shown.model||shown.connection)&&!needle){
      ui.list.append(h('div',{class:'mp-opt is-selected is-stale',role:'option','aria-selected':'true','aria-disabled':'true',id:'modelPickerOption-stale'},h('span',{class:'mp-opt-text'},h('span',{class:'mp-opt-label',text:shown.model||t('账号默认模型','Account default model')}),h('span',{class:'mp-opt-sub',text:t('不在已启用的供应商里','Not in your enabled providers')})),h('span',{class:'mp-check'},K.glyph('check',14))));
    }
    for(const group of all){
      const rows=group.models.filter(entry=>matches(group,entry,needle));if(!rows.length)continue;
      ui.list.append(h('div',{class:'mp-group',role:'presentation'},K.iconTile(group.kind==='account'?{glyph:'spark',tone:'accent'}:group.kind==='claude'?{glyph:'spark',tone:'accent'}:null,group.name,22),h('span',{class:'mp-group-name',text:group.name}),group.host?h('span',{class:'mp-group-host',text:group.host}):null));
      for(const entry of rows){
        const selected=shown.connection===group.id&&shown.model===entry.model,id=`modelPickerOption-${index}`;
        const tags=choices().capTags(entry.caps).map(tag=>h('span',{class:'mp-tag',title:tag.text,text:tag.text}));
        const node=h('div',{class:`mp-opt${selected?' is-selected':''}${group.needsKey?' needs-key':''}${index===activeIndex?' is-active':''}`,role:'option',id,'aria-selected':String(selected),...(saving?{'aria-disabled':'true'}:{}),dataset:{connection:group.id,model:entry.model}},
          h('span',{class:'mp-opt-text'},h('span',{class:'mp-opt-label',text:entry.label}),group.needsKey?h('span',{class:'mp-opt-sub',text:t('待补密钥：点此去设置','Key needed: open settings')}):entry.label!==entry.model&&entry.model?h('span',{class:'mp-opt-sub',text:entry.model}):null),
          tags.length?h('span',{class:'mp-tags'},tags):null,
          entry.isDefault?K.badge(t('默认','Default'),{tone:'accent'}):null,
          h('span',{class:'mp-check'},selected?K.glyph('check',14):null));
        node.addEventListener('click',()=>{if(group.needsKey){if(!saving){close();hooks.openSettings?.();}return;}void chooseModel(group,entry);});
        node.addEventListener('pointermove',()=>{const options=[...ui.list.querySelectorAll('[role=option]:not([aria-disabled=true])')],at=options.indexOf(node);if(at>=0&&at!==activeIndex){activeIndex=at;markActive(options);}});
        ui.list.append(node);index++;
      }
    }
    if(!index&&!ui.list.firstChild)ui.list.append(h('div',{class:'mp-empty'},h('p',{text:all.length?t('没有匹配的模型。','No matching models.'):t('还没有可用的模型。先添加一个供应商。','No models yet. Add a provider first.')})));
    markActive();
  }
  function paintEffort(){
    const K=kit(),shown=shownSelection(),found=choices().findChoice(groups(),shown),levels=found.model?found.model.efforts:[];
    ui.effort.hidden=!levels.length;ui.effort.replaceChildren();if(!levels.length)return;
    const picker=K.effortPicker({levels:levels.map(value=>({value,label:effortLabel(value)})),value:choices().fitEffort(found.model,shown.effort),defaultLabel:t('默认','Default'),label:t('推理强度','Reasoning effort'),onChange:value=>{void chooseEffort(value);}});
    picker.setDisabled(saving);
    ui.effort.append(h('div',{class:'mp-effort-head'},h('span',{text:t('推理强度','Reasoning effort')}),h('small',{text:t('只列出该模型支持的档位','Only levels this model supports')})),picker.el);
  }
  function paint(){
    if(!ui)return;const conversation=target(),source=sourceOf(conversation),own=source==='conversation';
    ui.title.textContent=t('模型','Model');
    ui.source.textContent=`${conversation?.title||t('新对话','New conversation')} · ${own?sourceLabel('conversation'):source?t('继承自','Inherited from')+' '+sourceLabel(source):sourceLabel(null)}`;
    ui.reset.textContent=t('恢复继承','Inherit');ui.reset.hidden=!own;ui.reset.disabled=saving;
    ui.settings.replaceChildren(t('管理模型','Manage models'),kit().glyph('arrow',13));
    ui.search.placeholder=t('搜索模型或供应商','Search models or providers');
    paintList();paintEffort();
    ui.status.textContent=saveError||(loading?t('正在读取账号可用模型…','Loading account models…'):modelError)||'';ui.status.dataset.tone=saveError?'error':'';
    $('modelPicker')?.setAttribute('aria-busy',saving?'true':'false');
    position();
  }
  function finishClose(restoreFocus=true){
    if(!presented)return;presented=false;++version;fetchAbort?.abort();$('composerModel')?.setAttribute('aria-expanded','false');query='';
    if(restoreFocus){const dialog=$('modelPicker');if(returnFocus?.isConnected&&returnFocus.tabIndex>=0&&!returnFocus.disabled&&!dialog.contains?.(returnFocus))returnFocus.focus({preventScroll:true});else $('composerModel')?.focus({preventScroll:true});}
  }
  function close({restoreFocus=true,force=false}={}){
    if(saving&&!force)return false;if(closing)return true;closing=true;
    try{const panel=$('modelPicker');if(panel&&!panel.hidden)panel.hidden=true;finishClose(restoreFocus);return true;}
    finally{closing=false;}
  }
  async function loadCatalogue(){
    if(!isOpen()||!groups().some(group=>group.kind==='account'))return;
    fetchAbort?.abort();fetchAbort=new AbortController();const own=version,request=fetchAbort;loading=true;modelError='';paint();
    try{const next=await fetchModels(request.signal);if(own===version&&fetchAbort===request)live=next;}
    catch(error){if(own===version&&fetchAbort===request){live=[];modelError=t('账号模型暂时读不到，显示已保存的模型。','Account models could not be read; showing the saved ones.');}}
    finally{if(own===version&&fetchAbort===request&&isOpen()){loading=false;paint();}}
  }
  async function open(){
    const conversation=hooks.getConversation?.();if(!active(conversation)||saving||!ui)return;
    targetId=conversation.id;saveError='';modelError='';query='';ui.search.value='';activeIndex=0;pending=null;
    returnFocus=root.document.activeElement;
    // Anchored to the composer; reading and navigation stay available. Keep it after the persistent regions (see WKWebView AX note in git history).
    const panel=$('modelPicker');root.document.body?.append?.(panel);
    presented=true;panel.hidden=false;paint();$('composerModel').setAttribute('aria-expanded','true');position();
    const selected=ui.list.querySelector('.is-selected');selected?.scrollIntoView?.({block:'center'});
    ui.search.focus?.({preventScroll:true});
    await loadCatalogue();
  }
  // Persist one change to the open conversation; the panel shows it at once and rolls back with a message if the save fails.
  async function commit(change,{done}={}){
    if(saving||!isOpen())return false;const conversation=target();
    if(!conversation||hooks.getConversation?.()?.id!==targetId){close({restoreFocus:false,force:true});return false;}
    if(hooks.canSave?.()===false){saveError=t('正在准备请求，请稍后再应用模型设置。','A request is being prepared. Apply model settings after it starts.');paint();return false;}
    const own=version;saving=true;saveError='';paint();
    try{await persist(conversation,()=>change(conversation));}
    catch(error){saving=false;pending=null;sync();if(own===version&&isOpen()){saveError=String(error.message||error);paint();}else hooks.toast?.(t('模型设置未保存：','Model settings were not saved: ')+String(error.message||error));return false;}
    saving=false;pending=null;sync();if(own===version&&isOpen()){paint();done?.();}return true;
  }
  function applySelection(next,done){
    const config=choices().toConfig(next);
    pending=next;
    return commit(conversation=>{setSelection(conversation,config);remember(hooks.getState?.(),config);},{done});
  }
  async function chooseModel(group,entry){
    const shown=shownSelection(),next={connection:group.id,model:entry.model,effort:choices().fitEffort(entry,shown.effort)};
    if(shown.connection===group.id&&shown.model===entry.model){if(!entry.efforts.length)close();return true;}
    const ok=await applySelection(next,()=>{if(!entry.efforts.length)close();});
    return ok;
  }
  const chooseEffort=effort=>applySelection({...shownSelection(),effort});
  function resetInherit(){
    return commit(conversation=>{delete conversation.modelConfig;remember(hooks.getState?.(),hooks.getResolvedConfig?.({...conversation})||configuration({...conversation},defaults()));},{done:()=>hooks.toast?.(t('已恢复继承的模型设置','Inherited model settings restored'))});
  }
  function sync(){
    const button=$('composerModel');if(!button)return;const config=current();
    let label='',group=null;
    if(choices()){const found=choices().findChoice(groups(),selectionOf(config));group=found.group;label=found.model?.label||'';}
    label=label||config.model||(config.provider==='claude-auth'?t('Claude 官方默认','Claude official default'):config.provider==='openai-auth'?t('账号默认模型','Account default model'):t('选择模型','Choose a model'));
    const detail=config.effort?effortLabel(config.effort):t('默认推理','Default reasoning'),title=`${group?group.name:config.provider==='claude-auth'?t('Claude 官方账号','Claude account'):config.provider==='openai-auth'?t('OpenAI 账号','OpenAI account'):t('自定义 API','Custom API')} · ${sourceLabel(config.source||(hooks.getConversation?.()?.modelConfig?'conversation':null))} · ${t('点击切换','Click to change')}`;
    if(root.ComposerUI?.setModel)root.ComposerUI.setModel({label,detail,title,disabled:false});
    else{const name=root.document.createElement('span');name.className='model-name';name.textContent=label;const effort=root.document.createElement('small');effort.textContent=detail;button.replaceChildren(name,effort);button.title=title;}
    if(isOpen()&&(!target()||hooks.getConversation?.()?.id!==targetId))close({restoreFocus:false,force:true});
  }
  async function resolve(config) {
    const snapshot = { ...config };
    if (snapshot.provider === 'claude-auth') {
      if(!claudeModels.includes(snapshot.model||''))throw new Error('请选择官方默认或 sonnet / opus / haiku 模型别名。');
      if(snapshot.effort&&!['auto','default'].includes(snapshot.effort))throw new Error('Claude Code 当前仅支持默认推理，请重新选择。');
      if(!root.ClaudeAuth)throw new Error('本机 Claude 连接组件尚未就绪。');
      await root.ClaudeAuth.ensureReady();snapshot.effort='';
    } else if (snapshot.provider === 'openai-auth') {
      await root.OpenAIAuth.ensureReady();
      const available = await fetchModels();
      const entry = snapshot.model ? available.find(x => idOf(x) === snapshot.model) : available.find(x => x.isDefault);
      if (!entry) throw new Error('当前模型不可用，请在输入框旁重新选择模型。');
      if (snapshot.effort && !effortsFor(available, idOf(entry)).includes(snapshot.effort)) throw new Error(`此模型不支持 ${snapshot.effort} 推理强度，请重新选择。`);
      snapshot.model = idOf(entry);
      snapshot.effort = snapshot.effort || entry.defaultReasoningEffort || '';
    }
    return snapshot;
  }

  const modalOpen=()=>{try{return !!root.document.querySelector?.('dialog:modal');}catch(_){return false;}};
  function init(options){
    hooks=options;const dialog=$('modelPicker');if(!dialog)return;if(initialized){sync();return;}initialized=true;
    if(root.UIKit)build(dialog);
    dialog.classList.remove('model-picker-dialog');dialog.classList.add('mp');dialog.hidden=true;dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','false');dialog.setAttribute('aria-labelledby','modelPickerTitle');
    $('composerModel').addEventListener('click',()=>isOpen()?close():open());
    const outside=event=>{if(isOpen()&&!dialog.contains(event.target)&&!$('composerModel')?.contains(event.target))close({restoreFocus:false});};
    root.document.addEventListener?.('pointerdown',outside,true);
    root.document.addEventListener?.('focusin',outside);
    root.document.addEventListener?.('keydown',event=>{if(isOpen()&&event.key==='Escape'&&!event.defaultPrevented&&!event.isComposing&&event.keyCode!==229&&!modalOpen()){event.preventDefault();close();}});
    root.addEventListener('resize',position);root.document.addEventListener?.('scroll',event=>{if(!dialog.contains(event.target))position();},true);root.document.addEventListener?.('workstation-language-change',()=>{sync();paint();});sync();
  }
  return {init,configure,configuration,setSelection,remember,forNewConversation,effortsFor,describe,current,resolve,sync,open,close,committedConversation,isOpen,isSaving:()=>saving};
});
