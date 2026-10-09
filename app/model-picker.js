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
  function configuration(conversation, defaults = {}) {
    const preferred = committedConversation(conversation)?.modelConfig;
    const source = configured(preferred) ? preferred : defaults;
    return { provider: ['openai-auth','claude-auth'].includes(source.provider) ? source.provider : 'api', model: String(source.model || '').trim(), effort: source.effort && source.effort !== 'auto' ? String(source.effort) : '' };
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
  let hooks={},models=[],version=0,targetId=null,drafts={},loading=false,modelError='',saveError='',notice='',selection={provider:'api',model:'',effort:''},saving=false,island=null,fetchAbort=null,initialized=false,returnFocus=null,presented=false,closing=false;
  const $=id=>root.document.getElementById(id);
  const isOpen=()=>presented&&$('modelPicker')?.hidden===false;
  const defaults=()=>hooks.getDefaults?.()||{};
  const resolved=conversation=>hooks.getResolvedConfig?.(committedConversation(conversation))||configuration(conversation,defaults());
  const current=()=>resolved(hooks.getConversation?.());
  const target=()=>hooks.getState?.()?.conversations?.find(value=>value.id===targetId&&active(value));
  const selected=()=>configuration({modelConfig:selection});
  const sourceLabel=source=>({conversation:t('对话设定','Conversation'),project:t('项目设定','Project'),workspace:t('工作区设定','Workspace'),default:t('全局默认','Global default')})[source]||t('继承默认','Inherited default');
  async function fetchModels(parentSignal){
    const controller=new AbortController(),abort=()=>controller.abort();parentSignal?.addEventListener?.('abort',abort,{once:true});if(parentSignal?.aborted)abort();
    const timeout=setTimeout(abort,20000);
    try{const response=await root.fetch('/__auth/models',{signal:controller.signal});const result=await response.json();if(!response.ok)throw Error(result.error?.message||result.message||t('请先在设置中连接 OpenAI 账号。','Connect your OpenAI account in settings first.'));return (result.data||result.models||[]).filter(entry=>idOf(entry));}
    catch(error){if(error.name==='AbortError')throw Error(t('读取模型超时，请重试。','Loading models timed out. Try again.'));throw error;}
    finally{clearTimeout(timeout);parentSignal?.removeEventListener?.('abort',abort);}
  }
  function position(){
    const dialog=$('modelPicker');if(!isOpen())return;const anchor=$('composerModel')?.getBoundingClientRect(),bounds=dialog.getBoundingClientRect();if(!anchor)return;
    dialog.style.left=`${Math.max(12,Math.min(anchor.right-bounds.width,root.innerWidth-bounds.width-12))}px`;
    dialog.style.top=`${Math.max(12,Math.min(anchor.top-bounds.height-10,root.innerHeight-bounds.height-12))}px`;
  }
  function normalizeEffort(wanted=selection.effort){
    const available=selection.provider==='openai-auth'?effortsFor(models,selection.model):Object.keys(labels);notice='';
    if(selection.provider==='claude-auth'&&wanted){selection.effort='';notice=t('Claude Code 当前使用官方默认推理。','Claude Code currently uses default reasoning.');}
    if(selection.provider==='openai-auth'&&!loading&&wanted&&!available.includes(wanted)){selection.effort='';notice=t('此模型不支持原推理档位，已选择模型默认。','This model does not support the previous reasoning level. Model default is selected.');}
  }
  function props(){
    const conversation=target(),config=conversation?resolved(conversation):current(),auth=selection.provider==='openai-auth',claude=selection.provider==='claude-auth',efforts=claude?[]:auth?effortsFor(models,selection.model):Object.keys(labels);
    const accountOptions=claude?claudeModels.map(value=>({value,label:value||t('Claude 官方默认（不指定模型）','Claude official default (no override)')})):[{value:'',label:t('账号默认模型','Account default model')},...models.map(entry=>({value:idOf(entry),label:entry.displayName||idOf(entry)}))];
    if(selection.model&&!(claude?claudeModels.includes(selection.model):models.some(entry=>idOf(entry)===selection.model)))accountOptions.push({value:selection.model,label:t(`${selection.model}（暂不可用）`,`${selection.model} (unavailable)`),disabled:true});
    const effortOptions=[{value:'',label:t('模型默认','Model default')},...efforts.map(value=>({value,label:`${effortLabel(value)} · ${value}`}))];
    if(loading&&selection.effort&&!efforts.includes(selection.effort))effortOptions.push({value:selection.effort,label:effortLabel(selection.effort)});
    const unavailable=auth&&(!models.length||!!modelError||!!selection.model&&!models.some(entry=>idOf(entry)===selection.model)||!selection.model&&!models.some(entry=>entry.isDefault));
    return {ownerKey:`${targetId}:${version}`,title:conversation?.title||t('新对话','New conversation'),selection:{...selection},source:sourceLabel(config.source||(conversation?.modelConfig?'conversation':null)),currentModel:config.model||(config.provider==='claude-auth'?t('Claude 官方默认','Claude official default'):config.provider==='openai-auth'?t('账号默认模型','Account default model'):t('未选择模型','No model selected')),accountOptions,effortOptions,loading,saving,accountDisabled:claude?false:loading||!models.length,effortDisabled:claude||auth&&(loading||!efforts.length),applyDisabled:saving||claude&&!claudeModels.includes(selection.model)||auth&&(loading||unavailable),error:saveError||(auth?modelError:''),status:claude?t('官方别名，不是账号模型目录；仅本机登录，使用默认推理。','Official aliases, not an account catalogue. Local login and default reasoning only.'):auth?(loading?t('正在读取账号可用模型…','Loading available account models…'):notice||t('使用账号支持的模型与推理档位。切换从下一条消息生效。','Use supported account models and reasoning levels. Changes apply to your next message.')):t('API 推理能力由服务商决定；不确定时使用模型默认。','Reasoning support depends on your API provider. Use the model default when unsure.'),onProvider:changeProvider,onModel:value=>{if(saving)return;selection.model=value;saveError='';normalizeEffort();paint();},onEffort:value=>{if(saving)return;selection.effort=value;saveError='';paint();},onSubmit:apply,onReset:reset,onClose:close,onSettings:()=>{if(!saving){close();hooks.openSettings?.();}},onRetry:loadCatalogue};
  }
  function paint(){if(!island)return;island.update(props());position();}
  function finishClose(restoreFocus=true){
    if(!presented)return;presented=false;++version;fetchAbort?.abort();$('composerModel')?.setAttribute('aria-expanded','false');
    if(restoreFocus){const dialog=$('modelPicker');if(returnFocus?.isConnected&&returnFocus.tabIndex>=0&&!returnFocus.disabled&&!dialog.contains?.(returnFocus))returnFocus.focus({preventScroll:true});else $('composerModel')?.focus({preventScroll:true});}
  }
  function close({restoreFocus=true,force=false}={}){
    if(saving&&!force)return false;if(closing)return true;closing=true;
    try{
      // Hide the ordinary panel before restoring focus. This surface never
      // enters HTMLDialogElement's focus or top-layer lifecycle.
      const panel=$('modelPicker');if(panel&&!panel.hidden)panel.hidden=true;finishClose(restoreFocus);return true;
    }finally{closing=false;}
  }
  function changeProvider(provider){
    if(saving||!['api','openai-auth','claude-auth'].includes(provider)||provider===selection.provider)return;
    drafts[selection.provider]={model:selection.model,effort:selection.effort};const fallback=defaults();selection=configuration({modelConfig:{provider,...(drafts[provider]||(fallback.provider===provider?fallback:{model:'',effort:''}))}});saveError='';if(provider==='claude-auth'){fetchAbort?.abort();fetchAbort=null;loading=false;}normalizeEffort();paint();if(provider==='openai-auth'&&!models.length&&!loading)void loadCatalogue();
  }
  async function loadCatalogue(){
    if(!isOpen()||saving||selection.provider==='claude-auth')return;fetchAbort?.abort();fetchAbort=new AbortController();const ownVersion=version,ownRequest=fetchAbort;loading=true;modelError='';paint();
    try{const next=await fetchModels(ownRequest.signal);if(ownVersion===version&&fetchAbort===ownRequest){models=next;if(!next.length)modelError=t('账号没有返回可用模型，请检查连接后重试。','No account models were returned. Check the connection and retry.');}}
    catch(error){if(ownVersion===version&&fetchAbort===ownRequest){models=[];modelError=String(error.message||error);}}
    finally{if(ownVersion===version&&fetchAbort===ownRequest&&isOpen()){loading=false;normalizeEffort();paint();}}
  }
  async function open(){
    const conversation=hooks.getConversation?.();if(!active(conversation)||saving)return;targetId=conversation.id;selection=configuration({modelConfig:current()});drafts={...conversation.modelChoices,[selection.provider]:{...selection}};modelError='';saveError='';notice='';loading=true;++version;returnFocus=$('composerModel');
    // Model preferences are anchored to the composer. Reading and navigation
    // stay available; this surface never makes the whole workspace inert.
    // Keep the transient surface after persistent workspace regions. Native
    // WKWebView AX drops following siblings after this panel is hidden; a
    // terminal overlay preserves the reader and splitter without rebuilding them.
    // Reassert on open because the reader and other workspaces mount lazily.
    const panel=$('modelPicker');root.document.body?.append?.(panel);
    presented=true;panel.hidden=false;paint();$('composerModel').setAttribute('aria-expanded','true');position();$('conversationProvider')?.focus();if(selection.provider==='claude-auth'){loading=false;normalizeEffort();paint();}else await loadCatalogue();
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
  async function saveChange(resetSelection){
    if(saving||!isOpen())return false;const conversation=target();if(!conversation||hooks.getConversation?.()?.id!==targetId){close({restoreFocus:false,force:true});return false;}const value=selected();
    if(hooks.canSave?.()===false){saveError=t('正在准备请求，请稍后再应用模型设置。','A request is being prepared. Apply model settings after it starts.');paint();return false;}
    if(!resetSelection&&value.provider==='api'&&!value.model){saveError=t('请输入模型名称','Enter a model name');paint();$('conversationApiModel')?.focus();hooks.toast?.(saveError);return false;}
    if(!resetSelection&&value.provider==='openai-auth'&&(loading||modelError||!models.some(entry=>value.model?idOf(entry)===value.model:entry.isDefault))){saveError=t('该模型当前不可用，请重新选择。','This model is unavailable. Choose another model.');paint();hooks.toast?.(saveError);return false;}
    if(!resetSelection&&value.provider==='claude-auth'&&!claudeModels.includes(value.model)){saveError=t('请选择官方默认或受支持的 Claude 模型别名。','Choose the official default or a supported Claude alias.');paint();return false;}
    const ownVersion=version;saving=true;saveError='';paint();
    try{await persist(conversation,()=>{if(resetSelection){delete conversation.modelConfig;remember(hooks.getState?.(),hooks.getResolvedConfig?.({...conversation})||configuration({...conversation},defaults()));}else{conversation.modelChoices={...drafts};setSelection(conversation,value);remember(hooks.getState?.(),value);}});saving=false;sync();if(ownVersion===version){close();hooks.toast?.(resetSelection?t('已恢复继承的模型设置','Inherited model settings restored'):t('当前对话的模型已更新','Conversation model updated'));}return true;}
    catch(error){saving=false;sync();if(ownVersion===version&&isOpen()){saveError=String(error.message||error);paint();}else hooks.toast?.(t('模型设置未保存：','Model settings were not saved: ')+String(error.message||error));return false;}
  }
  const apply=()=>saveChange(false),reset=()=>saveChange(true);
  function sync(){
    const button=$('composerModel');if(!button)return;const config=current(),label=config.model||(config.provider==='claude-auth'?t('Claude 官方默认','Claude official default'):config.provider==='openai-auth'?t('账号默认模型','Account default model'):t('选择模型','Choose a model')),detail=config.effort?effortLabel(config.effort):t('默认推理','Default reasoning'),title=`${config.provider==='claude-auth'?t('Claude 官方账号','Claude account'):config.provider==='openai-auth'?t('OpenAI 账号','OpenAI account'):t('自定义 API','Custom API')} · ${sourceLabel(config.source||(hooks.getConversation?.()?.modelConfig?'conversation':null))} · ${t('点击切换','Click to change')}`;
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
  function init(options){
    hooks=options;if(!$('modelPicker'))return;if(initialized){sync();return;}initialized=true;
    const dialog=$('modelPicker'),host=root.document.createElement('div');host.id='modelPickerKit';dialog.replaceChildren(host);dialog.classList.add('model-picker-kit');dialog.hidden=true;dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','false');island=root.HalaskaUI.mount(host,'ModelPickerSurface',props());
    $('composerModel').addEventListener('click',()=>isOpen()?close():open());
    const outside=event=>{if(isOpen()&&!dialog.contains(event.target)&&!$('composerModel')?.contains(event.target))close({restoreFocus:false});};
    root.document.addEventListener?.('pointerdown',outside,true);
    root.document.addEventListener?.('focusin',outside);
    root.document.addEventListener?.('keydown',event=>{if(isOpen()&&event.key==='Escape'&&!event.defaultPrevented&&!event.isComposing&&event.keyCode!==229&&!root.document.querySelector?.('dialog:modal')){event.preventDefault();close();}});
    root.addEventListener('resize',position);root.document.addEventListener?.('scroll',event=>{if(!dialog.contains(event.target))position();},true);root.document.addEventListener?.('workstation-language-change',()=>{sync();paint();});sync();
  }
  return {init,configuration,setSelection,remember,forNewConversation,effortsFor,describe,current,resolve,sync,open,close,committedConversation,isOpen,isSaving:()=>saving};
});
