// Geometry only: no messages, document text or credentials are sent to the material host.
(()=>{
 if(!window.webkit?.messageHandlers?.glassRegions)return;
 let pending=false,last='',enabled=false,movingUntil=0;
 const known=new Map();
 const visible=el=>el&&el.getClientRects().length&&!el.closest('[hidden]')&&getComputedStyle(el).visibility!=='hidden';
 function send(){
  pending=false;const items=[];known.clear();
  const add=(id,el,radius,extra)=>{if(!visible(el))return;let r=el.getBoundingClientRect();if(extra&&visible(extra)){const b=extra.getBoundingClientRect();r={left:Math.min(r.left,b.left),top:Math.min(r.top,b.top),right:Math.max(r.right,b.right),bottom:Math.max(r.bottom,b.bottom)};r.width=r.right-r.left;r.height=r.bottom-r.top;}
   if(r.width<1||r.height<1)return;items.push({id,x:r.left,y:r.top,width:r.width,height:r.height,radius});known.set(id,[el,...(extra?[extra]:[])]);};
  const modal=document.activeElement?.closest?.('dialog[open]:not(#previewDialog)')||document.querySelector('dialog[open]:not(#previewDialog)');
  if(modal)add('modal',modal,24);
  // The reader is docked edge-to-edge; its material must meet the square pane
  // bounds instead of looking like a rounded floating card behind two rows.
  else{add('composer',document.querySelector('#composer'),26);add('reader',document.querySelector('.reading-toolbar'),0,document.querySelector('.reading-tabs'));}
  const key=JSON.stringify(items);if(key!==last){last=key;window.webkit.messageHandlers.glassRegions.postMessage(items);}
  mark();if(performance.now()<movingUntil)schedule();
 }
 function mark(){document.querySelectorAll('[data-appkit-glass]').forEach(el=>el.removeAttribute('data-appkit-glass'));if(enabled)for(const[id,elements]of known)elements.forEach(el=>el.setAttribute('data-appkit-glass',id));}
 function schedule(){if(!pending){pending=true;requestAnimationFrame(send);}}
 window.NativeGlassSurface={acknowledge(value){enabled=!!value;document.documentElement.classList.toggle('appkit-web-glass',enabled);mark();},refresh(){last='';schedule();}};
 new ResizeObserver(schedule).observe(document.body);
 const tracked=new WeakSet();function track(){for(const el of document.querySelectorAll('#composer,.reading-toolbar,.reading-tabs,dialog'))if(!tracked.has(el)){tracked.add(el);new ResizeObserver(schedule).observe(el);}}
 new MutationObserver(records=>{if(records.every(r=>r.type==='attributes'&&r.attributeName==='data-appkit-glass'))return;track();schedule();}).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden','open','style']});
 document.addEventListener('focusin',schedule,true);document.addEventListener('scroll',schedule,true);window.addEventListener('resize',schedule);matchMedia('(prefers-reduced-transparency: reduce)').addEventListener('change',()=>{last='';schedule();});
 // Transform-only dialog/reader entrances do not fire ResizeObserver.
 // Follow only those short transitions, never run an idle rendering loop.
 for(const event of ['transitionrun','animationstart'])document.addEventListener(event,e=>{
  if(e.target.matches?.('dialog,.reading-pane,#composer')){movingUntil=performance.now()+450;schedule();}
 },true);
 track();schedule();
})();
