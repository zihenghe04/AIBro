(()=>{
 const rpc=body=>window.webkit.messageHandlers.desktop.postMessage(body);
 const keys=new Set(['workstation-api-base','workstation-api-model','workstation-api-protocol','workstation-api-protocol-learned','workstation-openai-model','workstation-provider','aibro-embedding-settings-v1','ai-bro-language','workstation-ui']);
 for(const [key,value] of Object.entries(window.__nativePreferences||{}))if(keys.has(key)||key==='aibro-connection-export-v1')localStorage.setItem(key,value);
 delete window.__nativePreferences;
 const originalSet=Storage.prototype.setItem,originalRemove=Storage.prototype.removeItem;
 Storage.prototype.setItem=function(key,value){originalSet.call(this,key,value);if(this===localStorage&&keys.has(key))rpc({command:'preferences',key,value:String(value)}).catch(()=>{});};
 Storage.prototype.removeItem=function(key){originalRemove.call(this,key);if(this===localStorage&&keys.has(key))rpc({command:'preferences',key}).catch(()=>{});};
 const credentials=channel=>({storageBackend:'encrypted-file',...Object.fromEntries(Object.entries({status:'status',read:'read',unlock:'unlock',save:'save',authorizeSave:'authorizeSave',remove:'remove',authorizeRemove:'authorizeRemove',profiles:'profile-list',saveProfile:'profile-save',selectProfile:'profile-select',removeProfile:'profile-remove',readProfile:'profile-read'}).map(([method,action])=>[method,async options=>{try{return await rpc({command:'credentials',channel,action,options:options||{}});}catch(error){const match=String(error?.message||error).match(/^\[((?:KEYCHAIN|CREDENTIAL|PROFILE)_[A-Z_]+)\]\s*(.*)$/s);if(!match)throw error;const failure=new Error(match[2]);failure.code=match[1];throw failure;}}]))});
 window.workstationDesktop={isDesktop:true,platform:'darwin',agendaProposal:proposal=>rpc({command:'agenda-proposal',proposal}),agendaDraft:id=>rpc({command:'agenda-draft',id}),agendaOpen:id=>rpc({command:'agenda-open',id}),agendaRelated:options=>rpc({command:'agenda-related',...(options?.includeCancelled===true?{includeCancelled:true}:{})}),agendaNotifications:enable=>rpc({command:'agenda-notifications',enable:enable===true}),apiCredentials:credentials('api'),embeddingCredentials:credentials('embedding'),setLanguage:value=>rpc({command:'language',value}),setAppearance:value=>rpc({command:'appearance',value}),openAuthURL:url=>rpc({command:'auth',url})};
 // Explicit ACK for the sharing preference. WK uses an ephemeral data store;
 // fire-and-forget localStorage mirroring could resurrect a revoked follow.
 window.workstationDesktop.connectionFollowing=Object.freeze({
  getItem:key=>key==='aibro-connection-export-v1'?localStorage.getItem(key):null,
  async setItem(key,value){if(key!=='aibro-connection-export-v1')throw Error('invalid preference');await rpc({command:'connection-following',value:JSON.parse(value)});originalSet.call(localStorage,key,value);},
  async removeItem(key){if(key!=='aibro-connection-export-v1')throw Error('invalid preference');await rpc({command:'connection-following',value:null});originalRemove.call(localStorage,key);}
 });
 window.workstationDesktop.connections=Object.freeze(Object.fromEntries(['sessionSnapshot','read','compareAndSwap','exportSavedAPI','verifySavedAPI','exportSavedSpeech','verifySavedSpeech'].map(action=>[action,async(options={})=>{
  try{return await rpc({command:'connections',action,options});}
  catch(error){const match=String(error?.message||error).match(/^\[(CONNECTION_[A-Z_]+)\]\s*(.*)$/s);const failure=new Error(match?.[2]||'连接配置未完成，已有配置已保留。');failure.code=match?.[1]||'CONNECTION_STORAGE_ERROR';throw failure;}
 }])));
 window.workstationDesktop.agendaCreateBatch=(proposals,runId,automatic=false)=>rpc({command:'agenda-create-batch',proposals,runId,automatic});
 window.workstationDesktop.agendaQuery=(request,context)=>rpc({command:'agenda-query',request,context});
 window.workstationDesktop.agendaRead=(request,context)=>rpc({command:'agenda-read',request,context});
 window.workstationDesktop.agendaMutation=(proposal,context)=>rpc({command:'agenda-mutation',proposal,context});
 window.workstationDesktop.agendaMutationStatus=(requestId,context,proposal)=>rpc({command:'agenda-mutation-status',requestId,context,proposal});
 window.workstationDesktop.navigateWorkspace=destination=>rpc({command:'navigate-workspace',destination});
 window.workstationDesktop.nativeWorkspacePersistence=true;
 // Settings changes require a real gesture in the retained settings card.
 // Agent quick-panel navigation has a separate, read-only presentation bridge.
 const quickEntryGesture=event=>{
  const nativeEvent=event?.nativeEvent||event;
  return typeof window.Event==='function'&&nativeEvent instanceof window.Event&&nativeEvent.isTrusted===true
   &&event.currentTarget?.isConnected===true&&!!event.currentTarget.closest('#quickEntrySettingsCard');
 };
 const quickEntryChange=(event,body)=>quickEntryGesture(event)
  ?rpc({command:'quick-entry-settings',...body}):Promise.resolve({status:'error',reason:'user_gesture_required'});
 window.workstationDesktop.quickEntry=Object.freeze({
  state:()=>rpc({command:'quick-entry-settings',action:'state'}),
  setEnabled:(enabled,event)=>typeof enabled==='boolean'?quickEntryChange(event,{action:'enabled',enabled}):Promise.resolve({status:'error',reason:'invalid_request'}),
  setMode:(mode,event)=>['island','edge','menuBar'].includes(mode)?quickEntryChange(event,{action:'mode',mode}):Promise.resolve({status:'error',reason:'invalid_request'}),
  openSettings:event=>quickEntryChange(event,{action:'open'})
 });
 // A composer-owned nonce grants recording, never message submission. The
 // separate native quick-voice panel has no RPC path through this controller.
 let dictationVerifier=null;
 const dictationLease=value=>!!value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).length===3&&['nonce','conversationId','revision'].every(key=>Object.hasOwn(value,key))
  &&typeof value.nonce==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.nonce)
  &&typeof value.conversationId==='string'&&value.conversationId.length>0&&value.conversationId.length<=512&&!/[\u0000-\u001f\u007f]/.test(value.conversationId)
  &&Number.isSafeInteger(value.revision)&&value.revision>=0;
 const dictationVerify=lease=>{
  if(!dictationLease(lease)||!dictationVerifier)return {status:'denied'};
  try{return dictationVerifier(lease)===true?{status:'authorized',...lease}:{status:'denied'};}catch{return {status:'denied'};}
 };
 const dictationRPC=(action,lease)=>dictationLease(lease)
  ?rpc({command:'speech-dictation',action,lease:{...lease}}):Promise.resolve({status:'error',reason:'invalid_request'});
 window.workstationDesktop.dictation={
  bindVerifier(verify){if(typeof verify!=='function')throw new TypeError('A dictation owner is required');dictationVerifier=verify;return()=>{if(dictationVerifier===verify)dictationVerifier=null;};},
  authorize:dictationVerify,revalidate:dictationVerify,
  status:()=>rpc({command:'speech-dictation',action:'status'}),
  start:lease=>dictationVerify(lease).status==='authorized'?dictationRPC('start',lease):Promise.resolve({status:'cancelled',...lease}),
  finish:lease=>dictationRPC('finish',lease),retry:lease=>dictationRPC('retry',lease),cancel:lease=>dictationRPC('cancel',lease),
  openSettings:()=>rpc({command:'speech-dictation',action:'settings'})
 };
 // This bridge grants only one immediate presentation request. It neither
 // queues a deferred open nor authorizes any module's write/capture controls.
 const quickSections=new Set(['home','tasks','capture','runs','agenda','links']),quickPending=new Map(),quickLeases=new Map();
 let quickComposing=false;
 if(typeof document!=='undefined'){
  document.addEventListener('compositionstart',()=>{quickComposing=true;},true);
  document.addEventListener('compositionend',()=>{quickComposing=false;},true);
  document.addEventListener('focusout',()=>{quickComposing=false;},true);
 }
 const quickObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
 const quickID=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
 const quickActive=value=>!!value&&!value.deleted&&!value.deletedAt&&!value.archived&&!value.archivedAt&&!['deleted','archived'].includes(value.status);
 const quickList=value=>Array.isArray(value)?value:[];
 const quickResult=(status,reason)=>({type:'quick_panel_open',status,opened:false,reason});
 const quickFingerprint=({token,request})=>JSON.stringify([token,request.section,request.recordType??null,request.recordId??null,...['runId','conversationId','projectId','workspace','userMessageId','toolCallId'].map(key=>request.owner[key])]);
 function quickShape(request){
  if(!quickObject(request)||Object.keys(request).some(key=>!['section','recordType','recordId','owner'].includes(key))||typeof request.section!=='string'||request.section.length>32)return false;
  if(('recordType' in request)!==('recordId' in request)||['recordType','recordId'].some(key=>key in request&&!quickID(request[key])))return false;
  const owner=request.owner;
  return quickObject(owner)&&Object.keys(owner).length===6&&Object.keys(owner).every(key=>['runId','conversationId','projectId','workspace','userMessageId','toolCallId'].includes(key))&&['runId','conversationId','workspace','userMessageId','toolCallId'].every(key=>quickID(owner[key]))&&(owner.projectId===null||quickID(owner.projectId));
 }
 function quickExplicitIntent(text,section){
  // Deliberately conservative: quotations, code and reported instructions
  // cannot become UI authority. Ambiguous natural language leaves the UI alone.
  const plain=String(text||'').replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g,'').replace(/^\s*>.*$/gm,'').replace(/`[^`]*`|“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g,'');
  if(/不要|不必|不用|别|无需|先不|暂不|\b(?:don['’]?t|do not|never|instead of)\b/i.test(plain))return false;
  const aliases={tasks:/待办|任务|\btasks?\b|\bto-?dos?\b/i,capture:/随记|速记|随手记|\bcaptures?\b|\bquick notes?\b/i,runs:/运行|执行记录|\bruns?\b|\bactivity\b/i,agenda:/日程|日历|\bagenda\b|\bcalendar\b/i,links:/链接|书签|收藏|\blinks?\b|\bbookmarks?\b|\bfavou?rites?\b/i};
  for(const clause of plain.split(/[。！？!?；;\n]/)){
   if(/不要|不必|不用|别|无需|先不|暂不|如果|假如|例如|比如|是什么意思|怎么实现|如何实现|为什么|\b(?:don['’]?t|do not|never|instead of|if|example|means?|why)\b/i.test(clause))continue;
   const zh=/^\s*(?:(?:请你?|麻烦你?|帮我|请帮我|现在|直接|先|再|顺便|也|为我|给我|能不能|能否|可不可以|可以|你|一下)[，,\s]*){0,8}(?:打开|展开|调出|唤出|显示|切到|切换到|聚焦)\s*(?:一下|这个|那个|我的|AI\s*Bro(?:的)?|\s)*(?:灵动岛|快捷工作台|快捷面板|快捷入口)/i;
   const en=/^\s*(?:(?:please|can you|could you|would you|now)\s+)*(?:open|show|expand|bring up|focus)\s+(?:the\s+)?(?:AI\s*Bro\s+)?(?:island|quick panel|quick workbench)\b/i;
   if(!zh.test(clause)&&!en.test(clause))continue;
   const explicit=Object.entries(aliases).filter(([,pattern])=>pattern.test(clause)).map(([key])=>key);
   if(explicit.includes(section)||section==='home'&&(!explicit.length||/首页|主页|\bhome\b/i.test(clause)))return true;
  }
  return false;
 }
 function quickRecord(request,access,message){
  if(request.recordId===undefined)return {};
  if(({tasks:'task',capture:'note',links:'import',agenda:'event'})[request.section]!==request.recordType)return {failure:quickResult('unsupported','record_type_unavailable')};
  // Events live in the original native AgendaStore. Its scoped record and the
  // current human title/ID are checked natively, not copied into JS state.
  if(request.recordType==='event')return {};
  const ref={type:request.recordType,id:request.recordId},found=access.access(ref),record=found.record;
  if(!found.available||access.isAmbiguous(ref))return {failure:quickResult('denied','record_unavailable')};
  const owner=request.owner,project=quickList(state.projects).find(p=>p.id===record.projectId),workspace=project?.workspace||record.workspace||'日常';
  if(owner.projectId?record.projectId!==owner.projectId:owner.workspace!=='auto'&&workspace!==owner.workspace)return {failure:quickResult('denied','record_outside_scope')};
  if(request.recordType==='note'&&record.kind!=='随记')return {failure:quickResult('unsupported','record_not_capture')};
  if(request.recordType==='import'){
   let url;try{url=new URL(record.url);}catch{}
   if(!url||!['http:','https:'].includes(url.protocol)||url.username||url.password)return {failure:quickResult('unsupported','record_not_link')};
  }
  const text=message.text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g,'').replace(/^\s*>.*$/gm,'');
  const title=String(record.title||record.name||record.originalName||'').trim(),id=record.id;
  const named=title.length>=2&&text.includes(title),identified=id.length>=4&&text.includes(id);
  const collection={task:'tasks',note:'notes',import:'imports'}[request.recordType];
  if(!identified&&(!named||quickList(state[collection]).filter(row=>quickActive(row)&&String(row.title||row.name||row.originalName||'').trim()===title).length!==1))return {failure:quickResult('denied','explicit_record_required')};
  return {record,recordStamp:JSON.stringify(record)};
 }
 function quickOwner(request){
  if(!quickShape(request))return {failure:quickResult('denied','invalid_request')};
  if(typeof storageHydrated==='undefined'||!storageHydrated||typeof state==='undefined'||!window.CitationEvidence?.createAccessContext)return {failure:quickResult('deferred','workspace_unavailable')};
  if(window.PrivateMode?.isOn?.())return {failure:quickResult('denied','private_context')};
  if(typeof serverConflict!=='undefined'&&serverConflict||typeof purgeTrash!=='undefined'&&purgeTrash.syncPaused)return {failure:quickResult('deferred','workspace_busy')};
  const owner=request.owner,unique=(rows,id)=>{const matches=quickList(rows).filter(item=>item?.id===id);return matches.length===1&&quickActive(matches[0])?matches[0]:null;};
  const run=unique(state.agentRuns,owner.runId),conversation=unique(state.conversations,owner.conversationId),project=owner.projectId?unique(state.projects,owner.projectId):null;
  if(!run||!conversation||owner.projectId&&!project||run.status!=='running'||run.automaticJobId||run.researchQueueId||run.researchBatchId||run.conversationId!==owner.conversationId||(run.projectId||null)!==owner.projectId||(conversation.projectId||null)!==owner.projectId||run.contextWorkspace!==owner.workspace||conversation.workspace!==owner.workspace||run.userMessageId!==owner.userMessageId)return {failure:quickResult('denied','owner_changed')};
  if(typeof activeRunId==='undefined'||activeRunId!==owner.runId||typeof activeRunController!=='undefined'&&activeRunController?.signal?.aborted)return {failure:quickResult('denied','run_inactive')};
  if(quickList(state.trash).some(bundle=>[...quickList(bundle?.data?.agentRuns),...quickList(bundle?.data?.runs)].some(item=>item?.id===owner.runId)||quickList(bundle?.data?.conversations).some(item=>item?.id===owner.conversationId)||owner.projectId&&quickList(bundle?.data?.projects).some(item=>item?.id===owner.projectId)))return {failure:quickResult('denied','retired_owner')};
  const message=unique(conversation.messages,owner.userMessageId),users=quickList(conversation.messages).filter(item=>item?.role==='user'&&quickActive(item)&&!item.live&&!item.retryRunId);
  if(!message||message.role!=='user'||message.live||message.retryRunId||users.at(-1)!==message||typeof message.text!=='string'||run.goal!==message.text)return {failure:quickResult('denied','current_turn_required')};
  const access=window.CitationEvidence.createAccessContext(state);
  if(access.access({runId:run.id}).kind==='private'||access.access({...message,conversationId:conversation.id}).kind==='private')return {failure:quickResult('denied','private_context')};
  const entry=unique(run.toolCalls,owner.toolCallId),expected={type:'quick_panel_open',section:request.section,...('recordType' in request?{recordType:request.recordType,recordId:request.recordId}:{})};
  if(!entry||entry.status!=='running'||entry.parentId||entry.type!=='quick_panel_open'||!quickObject(entry.request)||Object.keys(entry.request).length!==Object.keys(expected).length||Object.entries(expected).some(([key,value])=>entry.request[key]!==value))return {failure:quickResult('denied','tool_owner_changed')};
  if(!quickSections.has(request.section))return {failure:quickResult('unsupported','section_unavailable')};
  if(!quickExplicitIntent(message.text,request.section))return {failure:quickResult('denied','explicit_current_turn_required')};
  const record=quickRecord(request,access,message);if(record.failure)return record;
  const focused=typeof document==='undefined'?null:document.activeElement;
  if(quickComposing||focused&&!focused.disabled&&!focused.readOnly&&(focused.isContentEditable||focused.matches?.('textarea,input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio])')&&String(focused.value||'').trim()))return {failure:quickResult('deferred','user_edit_in_progress')};
  return {run,conversation,project,message,entry,...record};
 }
 window.workstationDesktop.quickPanel={
  async request(input,{signal}={}){
   if(signal?.aborted)return quickResult('denied','run_inactive');
   const request=JSON.parse(JSON.stringify(input)),owner=quickOwner(request);if(owner.failure)return owner.failure;
   const token=crypto.randomUUID(),envelope={token,request},serialized=quickFingerprint(envelope);
   const originalText=owner.message.text;
   quickPending.set(token,{serialized,owner,originalText});
   const cancel=()=>{quickPending.delete(token);quickLeases.delete(token);};signal?.addEventListener('abort',cancel,{once:true});
   try{
    const reply=await rpc({command:'quick-panel-open',envelope});
    if(!quickObject(reply)||!['opened','deferred','denied','unsupported'].includes(reply.status)||reply.status==='opened'&&(reply.opened!==true||reply.section!==request.section||request.recordId!==undefined&&(reply.recordType!==request.recordType||reply.recordId!==request.recordId||reply.positioned!==true)))return quickResult('deferred','invalid_native_receipt');
    return {...reply,type:'quick_panel_open',opened:reply.status==='opened'};
   }catch{return quickResult('deferred','native_unavailable');}
   finally{cancel();signal?.removeEventListener('abort',cancel);}
  },
  // Native re-enters the same trusted page after its async hop. The nonce is
  // single-use and bound to actual objects, message text and live tool ledger.
  authorize(envelope){
   const pending=quickPending.get(envelope?.token);quickPending.delete(envelope?.token);
   if(!pending||!quickObject(envelope)||Object.keys(envelope).length!==2||!quickShape(envelope.request)||pending.serialized!==quickFingerprint(envelope))return quickResult('denied','request_expired');
   const current=quickOwner(envelope.request);if(current.failure)return current.failure;
   if(['run','conversation','project','message','entry','record'].some(key=>current[key]!==pending.owner[key])||current.recordStamp!==pending.owner.recordStamp||current.message.text!==pending.originalText)return quickResult('denied','owner_changed');
   quickLeases.set(envelope.token,{...pending,expiresAt:Date.now()+8000});
   return {status:'authorized',token:envelope.token,...(envelope.request.recordType==='event'?{userText:current.message.text}:{})};
  },
  // Does not consume another nonce or issue a new request. Native uses this
  // short-lived lease after data preparation and the actual visible-row ACK.
  revalidate(envelope){
   const lease=quickLeases.get(envelope?.token);
   if(!lease||Date.now()>lease.expiresAt||!quickObject(envelope)||!quickShape(envelope.request)||lease.serialized!==quickFingerprint(envelope))return quickResult('denied','request_expired');
   const current=quickOwner(envelope.request);if(current.failure)return current.failure;
   if(['run','conversation','project','message','entry','record'].some(key=>current[key]!==lease.owner[key])||current.recordStamp!==lease.owner.recordStamp||current.message.text!==lease.originalText)return quickResult('denied','owner_changed');
   return {status:'authorized',token:envelope.token};
  }
 };
 window.workstationDesktop.browser={request:request=>rpc({command:'browser',request})};
 window.workstationDesktop.vectorIndex={load:profile=>rpc({command:'vector-index',action:'load',profile}),write:(profile,puts=[],removes=[])=>rpc({command:'vector-index',action:'write',profile,puts,removes})};
})();
