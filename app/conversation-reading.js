/* Window-local reading intent and text anchors. No workspace writes, transcript
 * truncation, background polling, or ownership of message/React DOM. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.ConversationReading=api;})(globalThis,root=>{
 'use strict';
 const controllers=new WeakMap(),memories=new Map(),LIMIT=40,NEAR_END=70;
 const plain=anchor=>anchor?Object.fromEntries(Object.entries(anchor).filter(([key])=>key!=='node')):null;
 const remember=(id,value)=>{if(!id)return;memories.delete(id);memories.set(id,{following:value.following,anchor:plain(value.anchor),scrollTop:value.scrollTop});while(memories.size>LIMIT)memories.delete(memories.keys().next().value);};
 const distance=list=>Math.max(0,list.scrollHeight-list.clientHeight-list.scrollTop);
 const behavior=options=>root.document?.body?.classList.contains('reduce-motion')||root.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'instant':options.behavior||'smooth';
 function create(list){
  const doc=list.ownerDocument,win=doc.defaultView||root,disposers=[],observed=new Set();
  let id=list.dataset.conversationId||'',following=true,anchor=null,frame=0,depth=0,disposed=false;
  let ownedTop=null,userUntil=0,pointerHeld=false,navigating=false,navigationTimer=0;
  let selectionHeld=false,selectionOverride=null;
  let geometry='',scrollTop=list.scrollTop;
  const now=()=>win.performance?.now?.()||Date.now();
  const visible=()=>list.isConnected&&list.clientHeight>0&&list.clientWidth>0&&doc.visibilityState!=='hidden';
  const shape=()=>[list.scrollHeight,list.clientHeight,list.clientWidth].join(':');
  const userActive=()=>pointerHeld||now()<userUntil;
  const on=(target,type,fn,options)=>{target?.addEventListener(type,fn,options);disposers.push(()=>target?.removeEventListener(type,fn,options));};
  const messageFor=key=>[...list.children].find(node=>node.dataset?.messageId===key);
  const textWalker=scope=>doc.createTreeWalker(scope,4);
  function atOffset(scope,offset){const walker=textWalker(scope);let node,last;while((node=walker.nextNode())){last=node;if(offset<=node.length)return {node,offset};offset-=node.length;}return last?{node:last,offset:last.length}:null;}
  function textOffset(scope,target,offset){const walker=textWalker(scope);let node,total=0;while((node=walker.nextNode())){if(node===target)return total+offset;total+=node.length;}return null;}
  function textRect(node,offset){try{const range=doc.createRange(),start=Math.max(0,Math.min(offset,node.length-1));range.setStart(node,start);range.setEnd(node,Math.min(node.length,start+1));const rect=range.getBoundingClientRect();return rect.height?rect:null;}catch{return null;}}
  function scopeFor(message,value){
   if(value.scope==='body')return message.querySelector(':scope > .message-body');
   if(value.scope==='activity')return [...message.querySelectorAll('[data-activity-id]')].find(node=>node.dataset.activityId===value.scopeId);
   if(value.scope==='tool')return [...message.querySelectorAll('[data-tool-id]')].find(node=>node.dataset.toolId===value.scopeId);
   return message;
  }
  function capture(){
   if(!visible())return anchor;
   const bounds=list.getBoundingClientRect(),top=bounds.top+list.clientTop;
   const message=[...list.children].find(node=>node.dataset?.messageId&&node.getBoundingClientRect().bottom>top+3);
   if(!message)return null;
   const box=message.getBoundingClientRect(),value={messageId:message.dataset.messageId,messageOffset:box.top-top,scrollTop:list.scrollTop};
   const body=message.querySelector(':scope > .message-body'),bodyBox=body?.getBoundingClientRect();
   const y=Math.min(bounds.bottom-4,Math.max(top+18,box.top+4));
   const left=bodyBox&&bodyBox.top<=y&&bodyBox.bottom>y?bodyBox.left:box.left;
   const x=Math.max(bounds.left+4,Math.min(bounds.right-8,left+24));
   let point;
   if(doc.caretPositionFromPoint){const p=doc.caretPositionFromPoint(x,y);if(p)point={node:p.offsetNode,offset:p.offset};}
   else if(doc.caretRangeFromPoint){const range=doc.caretRangeFromPoint(x,y);if(range)point={node:range.startContainer,offset:range.startOffset};}
   if(point?.node?.nodeType===3&&message.contains(point.node)&&!point.node.parentElement.closest('input,textarea,[contenteditable="true"]')){
    const candidate=point.node.parentElement.closest('.message-body,[data-activity-id],[data-tool-id]');
    const scope=candidate&&message.contains(candidate)?candidate:message;
    const rect=textRect(point.node,point.offset),offset=textOffset(scope,point.node,point.offset);
    if(rect&&rect.top>=top-30&&rect.top<bounds.bottom&&offset!==null){
     value.scope=scope.classList.contains('message-body')?'body':scope.dataset.activityId?'activity':scope.dataset.toolId?'tool':'message';
     value.scopeId=scope.dataset.activityId||scope.dataset.toolId||'';
     Object.assign(value,{node:point.node,nodeOffset:point.offset,textOffset:offset,textScreenOffset:rect.top-top});
    }
   }
   return value;
  }
  function savePosition(){scrollTop=list.scrollTop;if(!following)anchor=capture();geometry=shape();remember(id,{following,anchor,scrollTop});}
  function selectedRanges(){
   if(id!==list.dataset.conversationId)return null;
   const selection=doc.getSelection?.()||win.getSelection?.();
   if(!selection||selection.isCollapsed||!selection.rangeCount)return null;
   const ranges=[];
   for(let index=0;index<selection.rangeCount;index++){
    try{const range=selection.getRangeAt(index);if(!range.collapsed&&(list.contains(range.startContainer)||list.contains(range.endContainer)||range.intersectsNode(list)))ranges.push([range.startContainer,range.startOffset,range.endContainer,range.endOffset]);}catch{}
   }
   return ranges.length?ranges:null;
  }
  const sameSelection=(a,b)=>a&&b&&a.length===b.length&&a.every((range,index)=>range.every((value,part)=>value===b[index][part]));
  function pauseForSelection(){
   const selected=selectedRanges();
   if(!selected){
    // Clearing a selection keeps the detached intent and adopts the reader's
    // current position; an old queued anchor must not jump on selection clear.
    if(selectionHeld){selectionHeld=false;ownedTop=null;savePosition();}
    selectionOverride=null;return false;
   }
   if(sameSelection(selected,selectionOverride))return false;
   if(!selectionHeld||following||navigating){
    selectionHeld=true;following=false;ownedTop=null;cancelNavigation();
    win.cancelAnimationFrame(frame);frame=0;savePosition();
   }
   return true;
  }
  function write(top,force=false){const value=Math.max(0,Math.min(top,Math.max(0,list.scrollHeight-list.clientHeight)));if(force||Math.abs(list.scrollTop-value)>.5){ownedTop=value;list.scrollTo({top:value,behavior:'instant'});}scrollTop=list.scrollTop;geometry=shape();}
  function restore(){
   if(disposed||depth||!visible()||pauseForSelection()||navigating||userActive())return;
   if(following)write(list.scrollHeight);
   else if(anchor){
    const message=messageFor(anchor.messageId),scope=message&&scopeFor(message,anchor);
    const point=scope&&anchor.textOffset!==undefined?(anchor.node?.isConnected&&scope.contains(anchor.node)?{node:anchor.node,offset:anchor.nodeOffset}:atOffset(scope,anchor.textOffset)):null;
    const rect=point&&textRect(point.node,point.offset),top=list.getBoundingClientRect().top+list.clientTop;
    if(rect){write(list.scrollTop+rect.top-top-anchor.textScreenOffset);anchor.node=point.node;anchor.nodeOffset=point.offset;}
    else if(message)write(list.scrollTop+message.getBoundingClientRect().top-top-anchor.messageOffset);
    else write(anchor.scrollTop??scrollTop);
   }
   geometry=shape();remember(id,{following,anchor,scrollTop:list.scrollTop});
  }
  function schedule(){if(!frame&&!disposed)frame=win.requestAnimationFrame(()=>{frame=0;restore();});}
  function settleNavigation(){win.clearTimeout(navigationTimer);navigationTimer=0;navigating=false;savePosition();restore();}
  function postponeNavigation(){win.clearTimeout(navigationTimer);navigationTimer=win.setTimeout(settleNavigation,180);}
  function cancelNavigation(){if(!navigating)return;navigating=false;win.clearTimeout(navigationTimer);navigationTimer=0;write(list.scrollTop,true);savePosition();}
  function userInput(up=false){
   cancelNavigation();userUntil=now()+220;
   if(up){
    // Reader intent wins even inside the near-end tolerance. Cancel an already
    // queued follow and capture the current compositor position before the
    // browser delivers this gesture's first (possibly tiny) scroll event.
    following=false;ownedTop=null;win.cancelAnimationFrame(frame);frame=0;savePosition();
   }
  }
  function scroll(){
   if(!visible()||depth)return;
   if(pauseForSelection()){savePosition();return;}
   if(ownedTop!==null&&Math.abs(list.scrollTop-ownedTop)<1){ownedTop=null;geometry=shape();return;}
   ownedTop=null;
   if(navigating){savePosition();postponeNavigation();return;}
   // A layout scroll must not change intent. Also accept accessibility/scrollbar
   // scrolling with unchanged geometry even if no wheel/key event is exposed.
   if(userActive()||shape()===geometry){
    const movement=list.scrollTop-scrollTop;
    // A small upward gesture must not immediately re-attach because it landed
    // within 70px of the bottom. Once reading history, only a real downward
    // arrival at the bottom (or explicit follow()) resumes automatic movement.
    if(movement<-.5)following=false;
    else following=following?distance(list)<NEAR_END:movement>.5&&distance(list)<=1;
    savePosition();if(userActive())userUntil=now()+220;
   }
   else schedule();
  }
  on(list,'scroll',scroll,{passive:true});
  on(doc,'selectionchange',()=>{if(!disposed&&!depth)pauseForSelection();});
  on(list,'wheel',event=>{if(event.deltaY)userInput(event.deltaY<0);},{passive:true});
  on(list,'touchstart',()=>userInput(),{passive:true});
  on(list,'keydown',event=>{
   if(event.defaultPrevented||event.isComposing||event.altKey||event.metaKey||event.ctrlKey||event.target.closest?.('input,textarea,select,button,summary,a,[contenteditable="true"]'))return;
   if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))userInput(['ArrowUp','PageUp','Home'].includes(event.key)||event.key===' '&&event.shiftKey);
  });
  on(list,'pointerdown',event=>{const rect=list.getBoundingClientRect();if(event.pointerType==='touch'||event.target===list&&event.clientX>=rect.right-20){pointerHeld=true;userInput();}},{passive:true});
  on(doc,'pointerup',()=>{if(pointerHeld){pointerHeld=false;userUntil=now()+220;}},{passive:true});
  on(doc,'pointercancel',()=>{pointerHeld=false;userUntil=0;schedule();},{passive:true});
  on(list,'scrollend',()=>{if(navigating)settleNavigation();});
  on(doc,'visibilitychange',()=>{if(doc.visibilityState!=='hidden')schedule();});
  // ResizeObserver follows actual message/viewport geometry, including native
  // PDF splitter changes, disclosure animations and delayed image/font sizes.
  const resize=win.ResizeObserver?new win.ResizeObserver(schedule):null;
  resize?.observe(list);
  function observeRows(){const current=new Set([...list.children]);for(const row of observed)if(!current.has(row)){resize?.unobserve(row);observed.delete(row);}for(const row of current)if(!observed.has(row)){resize?.observe(row);observed.add(row);}}
  const mutation=win.MutationObserver?new win.MutationObserver(()=>{observeRows();schedule();}):null;
  mutation?.observe(list,{childList:true});
  on(win,'resize',schedule);
  const oldAnchor=list.style.overflowAnchor;list.style.overflowAnchor='none';
  geometry=shape();observeRows();
  return {
   before(nextId){
    if(!depth){restore();if(id===list.dataset.conversationId)savePosition();if(nextId!==id){cancelNavigation();userUntil=0;pointerHeld=false;selectionOverride=selectedRanges();selectionHeld=false;id=nextId;const saved=memories.get(id);following=saved?.following??true;anchor=saved?.anchor||null;scrollTop=saved?.scrollTop||0;}}
    depth++;return {id};
   },
   after(token){depth=Math.max(0,depth-1);if(token?.id!==id)return;observeRows();restore();schedule();},
   remember(){if(!depth){restore();savePosition();}return true;},
   restore(routeId){if(routeId!==id||list.dataset.conversationId!==routeId)return false;restore();schedule();return true;},
   navigate(callback,wantsFollowing=false){userUntil=0;pointerHeld=false;selectionOverride=selectedRanges();selectionHeld=false;following=wantsFollowing;navigating=true;callback();savePosition();postponeNavigation();return true;},
   inspect(){return {id,following,anchor:plain(anchor),navigating,observedMessages:observed.size,rememberedConversations:memories.size};},
   destroy(){disposed=true;win.cancelAnimationFrame(frame);win.clearTimeout(navigationTimer);resize?.disconnect();mutation?.disconnect();disposers.forEach(fn=>fn());observed.clear();list.style.overflowAnchor=oldAnchor;controllers.delete(list);}
  };
 }
 function ensure(list){if(!list)return null;let controller=controllers.get(list);if(!controller){controller=create(list);controllers.set(list,controller);}return controller;}
 return {
  beforeRender:(list,id)=>ensure(list)?.before(id),afterRender:(list,token)=>ensure(list)?.after(token),
  remember:list=>controllers.get(list)?.remember(),restore:(list,id)=>controllers.get(list)?.restore(id)||false,
  reveal(node,options={}){const list=node?.closest?.('#messageList');if(!list)return false;return ensure(list).navigate(()=>node.scrollIntoView({block:'center',...options,behavior:behavior(options)}));},
  follow(list,options={}){if(!list)return false;return ensure(list).navigate(()=>list.scrollTo({top:list.scrollHeight,...options,behavior:behavior(options)}),true);},
  inspect:list=>controllers.get(list)?.inspect()||null,destroy:list=>controllers.get(list)?.destroy()
 };
});
