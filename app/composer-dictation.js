/* Native recorded-speech input. The existing uncontrolled composer owns text,
   selection, IME and persistence; this controller never sends a message. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.ComposerDictation=api;})(globalThis,root=>{
 'use strict';
 const sameLease=(a,b)=>!!a&&!!b&&a.nonce===b.nonce&&a.conversationId===b.conversationId&&a.revision===b.revision;
 const t=(zh,en)=>/^en(?:-|$)/i.test(root.document?.documentElement?.lang||'')?en:zh;
 const append=(before,text)=>before+(before && !/\s$/.test(before)?'\n':'')+text;
 function createController(hooks){
  let current=null,revision=0,composing=false,disposed=false,phase='idle',message='',elapsed=0,poller=null,retryAvailable=false,polling=false,cancelling=Promise.resolve();
  const api=hooks.api;
  const snapshot=()=>({phase,message,elapsed,active:!!current,composing,revision,retryAvailable});
  const stopPoll=()=>{if(poller!==null){(hooks.clearInterval||root.clearInterval)(poller);poller=null;}};
  function publish(next,note=''){phase=next;message=note;hooks.onChange?.(snapshot());}
  const stamp=c=>JSON.stringify([c.conversationId,c.workspace||null,c.projectId||null,c.routeVersion]);
  function valid(lease){
   if(disposed||composing||!current||!sameLease(lease,current.lease)||revision!==lease.revision)return false;
   const c=hooks.context();return !!c?.available&&stamp(c)===current.stamp&&c.inputValue===current.before;
  }
  function cancel(note=''){
   stopPoll();const old=current;current=null;elapsed=0;retryAvailable=false;revision++;
   if(old)cancelling=Promise.resolve().then(()=>api.cancel(old.lease)).catch(()=>{});
   publish('idle',note);return !!old;
  }
  function reconcile(){if(current&&!valid(current.lease))cancel();return snapshot();}
  function edited(){revision++;if(current)cancel();}
  function composition(value){composing=!!value;if(value)edited();hooks.onChange?.(snapshot());}
  function failure(reply){retryAvailable=reply?.retryAvailable===true;publish(reply?.reason==='not_configured'?'unconfigured':'error',typeof reply?.message==='string'?reply.message:t('语音输入未完成，草稿保留。','Voice input did not finish. Your draft is retained.'));}
  async function poll(){
   if(polling)return;const session=current;if(!session||!['recording','recorded'].includes(phase)||!valid(session.lease)){reconcile();return;}
   try {
    polling=true;const reply=await api.status();if(current!==session||!['recording','recorded'].includes(phase)||!valid(session.lease))return;
    if(!sameLease(reply,session.lease)){
     // Native cancellation/failAndClear removes its lease. A foreign/global
     // session is never ours; retire only our old nonce and do not stay recording.
     cancel(t('录音已停止，草稿保留。','Recording stopped. Your draft is retained.'));
     if(reply.phase==='error')failure({...reply,retryAvailable:false});
     return;
    }
    elapsed=Number.isFinite(reply.elapsed)?Math.max(0,reply.elapsed):elapsed;
    if(reply.phase==='recorded'){stopPoll();publish('recorded');}
    else if(reply.phase==='error'){stopPoll();failure(reply);}
    else if(reply.phase==='idle'||reply.phase==='cancelled'){cancel();}
    else hooks.onChange?.(snapshot());
   }catch{if(current===session&&valid(session.lease)){stopPoll();publish('error',t('无法读取录音状态，可取消后重试。','Could not read recording status. Cancel and try again.'));}}finally{polling=false;}
  }
  async function start(){
   if(disposed||composing)return false;
   if(current)cancel();const c=hooks.context();if(!c?.available){publish('unavailable',c?.reason||t('请在可用对话中开始语音输入。','Open an available chat to use voice input.'));return false;}
   const lease={nonce:(hooks.uuid||(()=>root.crypto.randomUUID()))(),conversationId:c.conversationId,revision};
   const session={lease,stamp:stamp(c),before:c.inputValue};current=session;publish('checking');
   try {
    const status=await api.status();if(current!==session||!valid(lease)){if(current===session)cancel();return false;}
    if(!status.configured){publish('unconfigured',t('先配置语音服务的 API 与 Key。','Set up the speech service API and Key first.'));return false;}
    if(!status.available){publish('unavailable',t('语音服务当前不可用，请稍后重试。','Speech service is unavailable. Try again shortly.'));return false;}
    publish('authorizing');const reply=await api.start(lease);
    if(current!==session||!valid(lease)){if(current===session)cancel();return false;}
    if(!sameLease(reply,lease)||reply.status!=='recording'){failure(reply);return false;}
    elapsed=0;publish('recording');poller=(hooks.setInterval||root.setInterval)(poll,1000);return true;
   }catch{if(current===session&&valid(lease))failure();return false;}
  }
  async function finish(retry=false){
   const session=current;if(!session||!valid(session.lease)){reconcile();return false;}
   if(retry?phase!=='error'||!retryAvailable:!['recording','recorded'].includes(phase))return false;
   stopPoll();publish('transcribing');
   try {
    const reply=await api[retry?'retry':'finish'](session.lease);
    if(current!==session||!valid(session.lease)){if(current===session)cancel();return false;}
    if(!sameLease(reply,session.lease)||reply.status!=='completed'||typeof reply.text!=='string'||!reply.text.trim()){failure(reply);return false;}
    const c=hooks.context(),text=append(session.before,reply.text);
    // Commit is synchronous and compares again in the host; input listeners may
    // immediately run normal draft saving. Retire the lease before that event.
    current=null;revision++;elapsed=0;
    const applied=hooks.appendDraft({conversationId:session.lease.conversationId,before:session.before,text,context:c});
    cancelling=Promise.resolve().then(()=>api.cancel(session.lease)).catch(()=>{});
    publish('idle',applied===false?t('输入已变化，未覆盖草稿。','Input changed; the draft was not overwritten.'):t('已加入草稿，可编辑后发送。','Added to your draft. Edit it before sending.'));
    return applied!==false;
   }catch{if(current===session&&valid(session.lease))failure();return false;}
  }
  async function settings(){cancel();try{await cancelling;await api.openSettings();}catch{publish('error',t('无法打开语音设置。','Could not open speech settings.'));}}
  const unbind=api.bindVerifier?.(valid);
  return {start,finish,retry:()=>finish(true),cancel,edited,composition,reconcile,settings,poll,snapshot,valid,
   destroy(){cancel();disposed=true;unbind?.();}};
 }
 let controller=null,disposers=[],island=null;
 function init(hooks){
  destroy();const doc=root.document,api=root.workstationDesktop?.dictation,input=doc?.getElementById('agentInput'),rail=doc?.querySelector('.composer-primary-row');
  if(!api||!input||!rail||!root.ComposerUI||!root.HalaskaUI)return null;
  const mic=root.ComposerUI.createAction('composerVoice',{icon:'mic',iconOnly:true,label:t('语音输入','Voice input'),className:'attach-btn composer-voice'});
  const settings=root.ComposerUI.createAction('composerVoiceSettings',{icon:'mic',label:t('语音 API 与 Key…','Speech API and Key…'),className:'composer-voice-settings'});
  rail.insertBefore(mic.host,root.ComposerUI.rootFor(doc.getElementById('agentSend')));
  doc.getElementById('composerExtraTools')?.append(settings.host);
  const host=doc.createElement('div');host.className='composer-dictation-status';host.hidden=true;doc.getElementById('composer').append(host);
  const render=s=>{
   const active=['checking','authorizing','recording','recorded','transcribing'].includes(s.phase);
   root.ComposerUI.setVoice({icon:['recording','recorded'].includes(s.phase)?'stop':'mic',title:['recording','recorded'].includes(s.phase)?t('停止并转写','Stop and transcribe'):t('语音输入','Voice input'),disabled:s.composing||['checking','authorizing','transcribing'].includes(s.phase)});
   host.hidden=!active&&!s.message;const props={...s,onStop:()=>controller.finish(),onCancel:()=>controller.cancel(),onRetry:()=>controller.retry(),onSettings:()=>controller.settings(),onDismiss:()=>controller.cancel()};
   if(!island)island=root.HalaskaUI.mount(host,'ComposerDictationStatus',props);else island.update(props);
  };
  controller=createController({...hooks,api,onChange:render});
  const on=(node,name,fn,options)=>{node.addEventListener(name,fn,options);disposers.push(()=>node.removeEventListener(name,fn,options));};
  on(mic.button,'click',()=>['recording','recorded'].includes(controller.snapshot().phase)?controller.finish():controller.start());
  on(settings.button,'click',()=>controller.settings());
  on(input,'beforeinput',()=>controller.edited());on(input,'input',()=>controller.edited());
  on(input,'compositionstart',()=>controller.composition(true));on(input,'compositionend',()=>controller.composition(false));
  on(doc,'visibilitychange',()=>{if(doc.hidden)controller.cancel();});
  on(doc,'workstation-language-change',()=>render(controller.snapshot()));
  disposers.push(()=>host.remove());render(controller.snapshot());return controller;
 }
 function destroy(){controller?.destroy();controller=null;disposers.splice(0).forEach(fn=>fn());island?.unmount();island=null;}
 return {init,destroy,createController,sameLease,append,cancel:()=>controller?.cancel(),reconcile:()=>controller?.reconcile(),isComposing:()=>controller?.snapshot().composing===true,revision:()=>controller?.snapshot().revision||0};
});
