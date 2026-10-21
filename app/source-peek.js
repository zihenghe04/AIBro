/* One anchored source viewer for inline citations and historical source chips. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.SourcePeek=api;})(globalThis,function(root){
 'use strict';
 const evidence=()=>root.CitationEvidence||(typeof require==='function'?require('./citation-evidence.js'):null);
 function recordFor(state,type,id){return evidence()?.recordFor(state,type,id)||null;}
 function excerpt(record){return String(record?.content||record?.text||record?.summary||record?.abstract||'').replace(/^#{1,6}\s/gm,'').replace(/!\[[^\]]*\]\([^)]*\)/g,'').trim().slice(0,360);}
 const t=(zh,en)=>root.WorkstationI18n?.getLanguage?.()==='en'?en:zh;
 let destroy,publicShow,publicRefresh;
 function init(hooks){
  destroy?.();
  const doc=root.document,card=doc.createElement('section');card.id='sourcePeek';card.className='source-peek';card.hidden=true;card.setAttribute('role','region');card.setAttribute('aria-label',t('来源预览','Source preview'));doc.body.append(card);
  let anchor=null,current=null,siblings=[],index=0,timer,hideTimer,hoverTarget=null,pointerPoint=null,restoringFocus=false,island=null,busy=false,error='',generation=0,lastAccess='';
  const listeners=[],on=(node,name,fn,options)=>{node.addEventListener(name,fn,options);listeners.push(()=>node.removeEventListener(name,fn,options));};
  const undescribe=()=>{if(!anchor)return;const ids=(anchor.getAttribute('aria-describedby')||'').split(/\s+/).filter(id=>id&&id!==card.id);if(ids.length)anchor.setAttribute('aria-describedby',ids.join(' '));else anchor.removeAttribute('aria-describedby');anchor.setAttribute('aria-expanded','false');};
  const clearHover=()=>{clearTimeout(timer);hoverTarget=null;};
  const close=()=>{clearHover();clearTimeout(hideTimer);card.hidden=true;undescribe();anchor=null;current=null;siblings=[];generation++;busy=false;error='';lastAccess='';island?.unmount();island=null;card.replaceChildren();};
  const privateMode=()=>!!(hooks.isPrivate?.()??root.PrivateMode?.isOn?.());
  const visibility=value=>evidence()?.access(hooks.state(),value)||{kind:'missing',available:false};
  const closeAndRestore=()=>{const target=anchor;close();restoringFocus=true;try{target?.focus({preventScroll:true});}finally{restoringFocus=false;}};
  // A source is visible while any part of it is inside the message list's
  // viewport (or the window, for sources outside the list).
  function inView(node){
   const a=node.getBoundingClientRect(),scroll=node.closest('#messageList')?.getBoundingClientRect();
   const left=Math.max(0,scroll?.left||0),top=Math.max(0,scroll?.top||0),right=Math.min(root.innerWidth,scroll?.right??root.innerWidth),bottom=Math.min(root.innerHeight,scroll?.bottom??root.innerHeight);
   return !!(a.width&&a.height)&&a.bottom>top&&a.top<bottom&&a.right>left&&a.left<right;
  }
  function position(){
   if(!anchor?.isConnected||!inView(anchor)){close();return;}
   const a=anchor.getBoundingClientRect(),c=card.getBoundingClientRect();card.style.left=Math.max(12,Math.min(a.left,root.innerWidth-c.width-12))+'px';card.style.top=(a.bottom+c.height+12<root.innerHeight?a.bottom+8:Math.max(12,a.top-c.height-8))+'px';
  }
  function paint(){
   if(!current)return;
   const permitted=visibility(current);
   if(privateMode()||permitted.kind==='private'||current.legacyPreview!==undefined&&!permitted.available){close();return;}
   const status=current.legacyPreview!==undefined?{kind:'reference',canOpen:permitted.available,notice:t('当前资料开头预览；历史记录未保存本轮引用映射，不能视为回答的实际引用摘录。','Preview of the current document beginning. Historical request excerpts and attribution were not recorded.')}:evidence()?.status(current,hooks.state())||{kind:'missing',canOpen:false,notice:''};
   lastAccess=`${permitted.kind}:${permitted.available}`;
   const props={source:current,status,location:root.CitationEvidence?.location(current)||'',index,count:siblings.length,busy,error,onOpen:openOriginal,onPrevious:()=>navigate(-1),onNext:()=>navigate(1),onClose:closeAndRestore};
   if(root.HalaskaUI?.componentNames?.includes('CitationPeek')){if(island)island.update(props);else island=root.HalaskaUI.mount(card,'CitationPeek',props);}
   else {card.replaceChildren();const title=doc.createElement('strong'),copy=doc.createElement('p'),open=doc.createElement('button');title.textContent=current.title;copy.textContent=current.excerpt||current.legacyPreview||t('来源界面尚未加载','The source viewer is not loaded');open.type='button';open.textContent=t('打开原文 ↗','Open original ↗');open.disabled=!status.canOpen;open.onclick=openOriginal;card.append(title,copy,open);}
   position();
  }
  function refresh(){
   if(!current||card.hidden)return;
   const permitted=visibility(current);
   if(privateMode()||permitted.kind==='private'||!anchor?.isConnected||current.legacyPreview!==undefined&&!permitted.available){close();return;}
   // Streaming DOM mutations must not repeatedly hash an entire source body.
   // Permission changes repaint; content-version checks run on deliberate show.
   if(`${permitted.kind}:${permitted.available}`!==lastAccess)paint();
  }
  function navigate(delta){if(busy)return;const next=index+delta;if(next<0||next>=siblings.length)return;index=next;current=siblings[index];error='';generation++;paint();}
  async function openOriginal(){
   if(!current||busy)return;const value=current,permitted=visibility(value);if(privateMode()||!permitted.available){paint();return;}const version=generation;busy=true;error='';paint();
   try{
    const result=value.type==='web'?(hooks.openWeb?await hooks.openWeb(value.url):root.open(value.url,'_blank','noopener,noreferrer')):await hooks.open(value.type,value.id,value.page||1,value,{anchor});
    if(privateMode()||visibility(value).kind==='private'){if(version===generation)close();return;}
    if(result===false){if(version===generation){busy=false;paint();}return;}
    // Opening the reader can move focus or rerender the original message. That
    // legitimately closes this popover; still reveal the requested excerpt if
    // this exact source is now active. Never highlight a subsequently opened file.
    const preview=hooks.state()?.previewRecord,expectedType=value.type==='local'?'local-file':value.type,expectedId=value.type==='local'?root.ProjectFiles?.localId(value):value.id;
    if(value.excerpt&&preview?.type===expectedType&&preview.id===expectedId){
     // The host marks PDF words on the cited page once that page's text loads.
     const shown=hooks.reveal?await hooks.reveal(expectedType,expectedId,value):root.CitationEvidence?.reveal(value,doc.querySelector(value.type==='local'?'.local-document-preview':'#previewContent'));
     if(shown===false&&!privateMode())hooks.toast?.(t('已打开原文；未能唯一定位这段旧摘录。','Original opened; the saved excerpt could not be located uniquely.'));
    }
    if(version===generation)close();
   }catch(reason){if(version!==generation)return;if(privateMode()||visibility(value).kind==='private'){close();return;}busy=false;error=reason?.message||String(reason);paint();}
  }
  function show(target){
   clearHover();clearTimeout(hideTimer);
   if(privateMode()||!target?.isConnected||!target.getClientRects().length){close();return;}
   let found=root.CitationEvidence?.resolveTarget(hooks.state(),target);
   if(!found){
    const type=target.dataset.openNote?'note':target.dataset.openImport?'import':target.dataset.openTask?'task':'paper',id=target.dataset.openNote||target.dataset.openImport||target.dataset.openTask||target.dataset.openPaper,record=recordFor(hooks.state(),type,id);if(!record){close();return;}
    const page=Number(target.dataset.sourcePage),source={type,id,title:record.title||record.name||'Untitled',page:Number.isSafeInteger(page)&&page>0?page:null,offset:null,provided:false,legacyPreview:excerpt(record)};found={source,siblings:[source]};
   }
   if(visibility(found.source).kind==='private'){close();return;}
   // Keyboard focus can land on a source the message list has scrolled out of
   // view; its smooth scrolling would still leave it hidden when the card is
   // placed, which closes the card. Reveal it at once instead.
   if(!inView(target))target.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
   undescribe();anchor=target;current=found.source;siblings=found.siblings?.length?found.siblings:[current];index=Math.max(0,siblings.findIndex(s=>s.sourceId===current.sourceId));generation++;busy=false;error='';card.hidden=false;
   target.setAttribute('aria-describedby',[target.getAttribute('aria-describedby'),card.id].filter(Boolean).join(' '));target.setAttribute('aria-expanded','true');paint();
  }
  const targetOf=e=>e.target?.closest?.('#messageList [data-citation-source],#requestContextEvidence [data-citation-source],#contextWorkbench [data-citation-source],#messageList [data-open-note],#messageList [data-open-import],#messageList [data-open-paper],#messageList [data-open-task]');
  // Repositioning a popover can expose an old source underneath a stationary
  // pointer and emit pointerover. That is not new hover intent and must never
  // override a source the keyboard just focused. Only actual pointer movement
  // starts a new hover timer; moving within the same pending source keeps it.
  on(doc,'pointermove',e=>{const changed=!pointerPoint||pointerPoint.x!==e.clientX||pointerPoint.y!==e.clientY;pointerPoint={x:e.clientX,y:e.clientY};if(!changed||e.pointerType==='touch')return;const target=targetOf(e);if(!target)return;clearTimeout(hideTimer);if(target===anchor||target===hoverTarget)return;clearHover();hoverTarget=target;timer=setTimeout(()=>show(target),260);});
  on(doc,'pointerover',e=>{const target=targetOf(e);if(target===anchor||card.contains(e.target))clearTimeout(hideTimer);});
  on(doc,'pointerout',e=>{const target=targetOf(e);if(target&&!target.contains(e.relatedTarget)&&!card.contains(e.relatedTarget)){if(target===hoverTarget)clearHover();if(target===anchor&&!anchor.contains(doc.activeElement)&&!card.contains(doc.activeElement))hideTimer=setTimeout(close,180);}});
  on(doc,'focusin',e=>{if(restoringFocus)return;const target=targetOf(e);if(target)show(target);else if(!card.contains(e.target))close();});
  on(doc,'click',e=>{const target=targetOf(e);if(target?.hasAttribute('data-citation-source')){e.preventDefault();show(target);}});
  on(card,'pointerenter',()=>clearTimeout(hideTimer));on(card,'pointerleave',()=>{if(!card.contains(doc.activeElement)&&!anchor?.contains(doc.activeElement))hideTimer=setTimeout(close,180);});
  on(doc,'pointerdown',e=>{if(!card.contains(e.target)&&!anchor?.contains(e.target))close();});
  on(doc,'keydown',e=>{
   if(card.hidden||e.isComposing||e.keyCode===229)return;
   if(e.key==='ArrowDown'&&anchor?.contains(e.target)){card.querySelector('button:not([disabled])')?.focus({preventScroll:true});e.preventDefault();}
   if(['ArrowLeft','ArrowRight'].includes(e.key)&&(anchor?.contains(e.target)||card.contains(e.target))){navigate(e.key==='ArrowLeft'?-1:1);e.preventDefault();}
  });
  // The preview floats above the composer menu, popups and the reader, so it
  // takes Escape first and only it closes. Focus returns to the source only
  // from the preview or the source; a hover preview closes where focus is.
  on(doc,'keydown',e=>{
   if(e.key!=='Escape'||card.hidden||e.isComposing||e.keyCode===229)return;
   if(card.contains(doc.activeElement)||anchor?.contains(doc.activeElement))closeAndRestore();else close();
   e.preventDefault();e.stopPropagation();
  },true);
  on(doc,'scroll',()=>{if(!card.hidden)position();},true);on(root,'resize',()=>{if(!card.hidden)position();});
  const observer=new MutationObserver(refresh);observer.observe(doc.body,{childList:true,subtree:true});const privacyStrip=doc.getElementById('privateModeStrip');if(privacyStrip)observer.observe(privacyStrip,{attributes:true,attributeFilter:['hidden']});
  destroy=()=>{close();listeners.forEach(off=>off());observer.disconnect();island?.unmount();card.remove();};publicShow=show;publicRefresh=refresh;
  return {close,destroy,show,refresh};
 }
 return {init,recordFor,excerpt,show:target=>publicShow?.(target),refresh:()=>publicRefresh?.()};
});
