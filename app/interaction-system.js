/* Shared interaction behavior. Visual state follows real controls and never
   creates agent results or replaces an editor's DOM. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.InteractionSystem=api;})(globalThis,function(root){
 'use strict';
 const icon=(name)=>({more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',down:'<path d="M12 4v16m-6-6 6 6 6-6"/>'}[name]);
 const svg=name=>`<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icon(name)}</svg>`;
 const distanceFromEnd=node=>Math.max(0,node.scrollHeight-node.clientHeight-node.scrollTop);
 const reduced=()=>root.document.body.classList.contains('reduce-motion')||root.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
 let destroy;
 function init(){
  destroy?.();const doc=root.document;if(!doc)return;const disposers=[],q=s=>doc.querySelector(s);let frame=0;
  const on=(node,event,fn,options)=>{node?.addEventListener(event,fn,options);disposers.push(()=>node?.removeEventListener(event,fn,options));};
  const make=(tag,cls,text)=>{const n=doc.createElement(tag);n.className=cls;if(text)n.textContent=text;return n;};
  const list=q('#messageList'),composer=q('#composer'),footer=q('.composer-footer');
  const latest=make('button','conversation-latest');latest.id='conversationLatest';latest.type='button';latest.innerHTML=svg('down')+'<span>回到最新</span>';latest.title='回到对话最底部';latest.setAttribute('aria-label','回到对话最底部');latest.hidden=true;doc.body.append(latest);
  on(latest,'click',()=>{if(!root.ConversationReading?.follow(list,{behavior:reduced()?'instant':'smooth'}))list?.scrollTo({top:list.scrollHeight,behavior:reduced()?'auto':'smooth'});});
  let more,extras,primary,contextRow;
  if(footer){
   contextRow=make('div','composer-context-row');primary=make('div','composer-primary-row');extras=make('div','composer-extra-tools');extras.id='composerExtraTools';extras.hidden=true;extras.setAttribute('role','group');extras.setAttribute('aria-label','更多对话工具');
   const kitMore=root.ComposerUI?.createAction('composerMore',{className:'attach-btn composer-more'});
   more=kitMore?.button||make('button','attach-btn composer-more');more.id='composerMore';more.type='button';if(!kitMore){more.innerHTML=svg('more');more.title='更多工具';more.setAttribute('aria-label','更多工具');}more.setAttribute('aria-expanded','false');more.setAttribute('aria-controls',extras.id);
   const move=(ids,parent)=>ids.forEach(id=>{const n=doc.getElementById(id);if(n)parent.append(root.ComposerUI?.rootFor(n)||n);});
   // The prompt pattern has one action rail. Move whole Kit roots, so the
   // editor, popup anchors and their already-bound listeners retain identity.
   move(['chatAttach','composerReference'],primary);
   move(['composerContext','composerModel'],contextRow);primary.append(contextRow);
   move(['composerPermission'],primary);primary.append(kitMore?.host||more);move(['agentSend'],primary);
   move(['composerContextWorkbench','composerBrowserToggle','composerLocal','composerSkill','polishControls'],extras);
   // Preserve late-added extensions without losing their existing listeners.
   [...footer.children].forEach(node=>extras.append(node));footer.append(primary,extras);
   const closeMore=restore=>{if(extras.hidden)return;extras.hidden=true;more.setAttribute('aria-expanded','false');if(restore)more.focus();};
   on(more,'click',()=>{extras.hidden=!extras.hidden;more.setAttribute('aria-expanded',String(!extras.hidden));if(!extras.hidden)extras.querySelector('button')?.focus();});
   on(doc,'pointerdown',e=>{if(!extras.contains(e.target)&&!more.contains(e.target))closeMore(false);});
   on(doc,'keydown',e=>{if(e.key==='Escape'&&!extras.hidden){e.preventDefault();closeMore(true);}});
   on(extras,'click',e=>{if(e.target.closest('#composerContextWorkbench,#composerPermission,#composerLocal,#composerSkill'))closeMore(false);});
  }
  function indicators(){
   for(const group of doc.querySelectorAll('.inspector-tabs,.note-document-toolbar,.local-document-toolbar,.section-tabs,.review-tabs,.native-choices')){
    const selected=[...group.children].find(n=>n.matches?.('button.active,button[aria-selected="true"],button[aria-pressed="true"],button[aria-checked="true"]'));
    if(!selected||!selected.getClientRects().length){if(group.classList.contains('motion-selection'))group.classList.remove('motion-selection');continue;}
    const bounds=group.getBoundingClientRect(),rect=selected.getBoundingClientRect();if(!group.classList.contains('motion-selection'))group.classList.add('motion-selection');
    for(const [name,value] of Object.entries({x:rect.left-bounds.left+group.scrollLeft,y:rect.top-bounds.top+group.scrollTop,w:rect.width,h:rect.height}))group.style.setProperty('--selection-'+name,value+'px');
   }
  }
  function refresh(){
   frame=0;const rect=list?.getBoundingClientRect();const hidden=!rect||rect.width<1||rect.height<1||distanceFromEnd(list)<80||doc.body.dataset.view!=='agent';if(latest.hidden!==hidden)latest.hidden=hidden;
   if(!latest.hidden){latest.style.left=(rect.left+rect.width/2)+'px';latest.style.top=Math.max(rect.top+20,rect.bottom-48)+'px';}
   // The document controller owns a tab's explicit return label. The legacy
   // fallback describes only a reader without a recorded entry route.
   const back=q('#readingBack');if(back&&!back.closest('.reading-origin-action.has-origin')){
    const view=doc.body.dataset.view,section=q('#project')?.dataset.workspaceSection,english=doc.documentElement.lang==='en';
    const labels=english?{agent:'chat',settings:'settings',dashboard:'overview',daily:'personal',courses:'courses',research:'research',knowledge:'sources',tasks:'tasks',schedule:'schedule',overview:'project',conversations:'project chats'}:{agent:'对话',settings:'设置',dashboard:'总览',daily:'日常',courses:'课程',research:'科研',knowledge:'资料',tasks:'任务',schedule:'排期',overview:'项目',conversations:'项目对话'};
    const name=labels[view==='project'?section:view]||(english?'workspace':'工作区'),label=(english?'Back to ':'返回')+name;
    if(back.dataset.returnLabel!==label){back.dataset.returnLabel=label;back.title=label;back.setAttribute('aria-label',label+(english?', keep document tabs':'，保留阅读标签'));}
   }
   indicators();
  }
  function schedule(){if(!frame)frame=root.requestAnimationFrame(refresh);}
  const animations=new WeakMap();
  on(doc,'click',event=>{
   for(const menu of doc.querySelectorAll('.message-action-menu[open],.note-document-properties[open]'))if(!menu.contains(event.target)||(menu.classList.contains('message-action-menu')&&event.target.closest('button')))menu.open=false;
   const summary=event.target.closest?.('summary');if(!summary||event.defaultPrevented||event.target.closest('a,button,input,select,textarea'))return;
   const details=summary.parentElement;if(details?.tagName!=='DETAILS'||details.matches('.message-action-menu,.note-document-properties')||reduced())return;
   event.preventDefault();const current=animations.get(details),opening=current?!current.opening:!details.open;details._interactionDesiredOpen=opening;
   const from=details.getBoundingClientRect().height;current?.animation.cancel();details.style.height='';details.style.overflow='hidden';details.open=true;
   const to=opening?details.getBoundingClientRect().height:summary.getBoundingClientRect().height+parseFloat(root.getComputedStyle(details).paddingTop||0)+parseFloat(root.getComputedStyle(details).paddingBottom||0);
   const animation=details.animate([{height:from+'px'},{height:to+'px'}],{duration:opening?280:220,easing:'cubic-bezier(.2,0,0,1)'});animations.set(details,{animation,opening});
   animation.onfinish=()=>{details.open=opening;details.style.height='';details.style.overflow='';animations.delete(details);delete details._interactionDesiredOpen;schedule();};
   animation.oncancel=()=>{details.style.height='';details.style.overflow='';};
  });
  on(doc,'keydown',event=>{if(event.key==='Escape'){const menu=doc.querySelector('.message-action-menu[open]');if(menu){menu.open=false;menu.querySelector('summary')?.focus();event.preventDefault();}}});
  const observer=new MutationObserver(schedule);observer.observe(doc.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','aria-selected','aria-pressed','aria-checked','hidden','open']});disposers.push(()=>observer.disconnect());
  if(root.ResizeObserver){const resize=new ResizeObserver(schedule);[list,composer,q('#readingPane'),q('.main')].filter(Boolean).forEach(n=>resize.observe(n));disposers.push(()=>resize.disconnect());}
  on(list,'scroll',schedule,{passive:true});on(root,'resize',schedule);on(doc,'scroll',schedule,true);doc.body.classList.add('interaction-system-ready');refresh();
  destroy=()=>{disposers.forEach(fn=>fn());if(frame)root.cancelAnimationFrame(frame);latest.remove();if(footer){[contextRow,primary,extras].filter(Boolean).forEach(n=>{[...n.children].forEach(child=>{if(child!==more)footer.append(child);});n.remove();});}doc.body.classList.remove('interaction-system-ready');};
  return {refresh,destroy};
 }
 return {init,distanceFromEnd};
});
