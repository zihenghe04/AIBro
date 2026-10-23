/* A read-only tour of real workspace controls. No task execution or content writes. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.WorkspaceTour=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root){
 'use strict';
 const VERSION=1;
 const steps=Object.freeze([
  {id:'conversation',label:'开始对话',title:'一句话，开始一起做事',body:'说清你想完成什么，也可以先附上文件或网页。发送前，模型、项目和操作权限都在输入框附近。',hint:'导览不会替你发送消息，也不会调用模型。',selectors:['#composer','#agentInput'],scene:['附上资料','写下想法','一起完成']},
  {id:'files',label:'资料与项目',title:'资料有自己的位置',body:'上方路径显示当前空间和项目。在同一项目中切换对话、资料与任务，文件树里可以直接打开笔记、原件和已连接的本机文件。',hint:'还没选项目时，先从项目入口开始。',selectors:['#conversationProjectFiles','#workspaceProjectTabs','#workspaceBreadcrumbs','#readerFilesToggle','#workspaceFilesToggle','#composerContext','#chatContextBtn','#projectList'],scene:['项目','资料 / 笔记','点击预览']},
  {id:'review',label:'编辑与审阅',title:'把产出变成可修改的文档',body:'点击产出的文档，直接编辑排版或切换源码。文件修改可以查看差异；确认保存后，改动才会写入。',hint:'离开未保存的文档时，会先提示你保留或放弃修改。',selectors:['.note-document-toolbar','.local-document-toolbar','.file-change-card','#conversationOutputs','#readingToggle','#messageList'],scene:['查看差异','编辑正文','明确保存']},
  {id:'activity',label:'执行记录',title:'随时展开，看看做到了哪一步',body:'思考状态、资料读取和工具操作会出现在回复上方。展开一条记录，就能核对过程、来源或执行结果。',hint:'第一轮完成后，这里才会出现真实记录。动画只演示展开方式。',selectors:['.agent-progress>summary','.agent-progress','#messageList'],scene:['正在读取资料','展开过程','核对结果']},
  {id:'browser',label:'内置浏览器',title:'网页工作，也留在工作台里',body:'原生 macOS 版可以打开网页、读取页面、点击和填写内容。浏览器沿用当前任务的执行策略，默认连续完成操作；遇到登录等用户步骤，再交由你接管。',hint:'你也可以随时接管页面，处理后让任务继续。',selectors:['#composerBrowserToggle','#workspaceBrowserToggle','.browser-tools-card','#composer'],scene:['连续浏览与操作','需要时由你接管','继续任务']}
 ].map(Object.freeze));
 function shouldStart(state){return !state?.ui?.workspaceTour;}
 function placement(anchor,card,viewport){
  const margin=14,gap=14,vw=Math.max(0,viewport.width),vh=Math.max(0,viewport.height),width=Math.min(card.width||352,Math.max(0,vw-margin*2)),height=Math.min(card.height||418,Math.max(0,vh-margin*2));
  const clamp=(n,lo,hi)=>Math.max(lo,Math.min(n,Math.max(lo,hi)));
  let left=(vw-width)/2,top=(vh-height)/2,side='center';
  if(anchor){const choices=[{side:'left',space:anchor.left-margin-gap,left:anchor.left-gap-width,top:anchor.top},{side:'right',space:vw-anchor.right-margin-gap,left:anchor.right+gap,top:anchor.top},{side:'top',space:anchor.top-margin-gap,left:anchor.left,top:anchor.top-gap-height},{side:'bottom',space:vh-anchor.bottom-margin-gap,left:anchor.left,top:anchor.bottom+gap}];const fit=choices.find(c=>c.space>=(c.side==='left'||c.side==='right'?width:height));if(fit){({left,top,side}=fit);}else{top=anchor.top>vh/2?margin:vh-height-margin;side=anchor.top>vh/2?'top':'bottom';}}
  return {left:clamp(left,margin,vw-width-margin),top:clamp(top,margin,vh-height-margin),width,maxHeight:Math.max(0,vh-margin*2),side};
 }
 function createController(hooks={},env=root){
  const doc=env.document;if(!doc)throw Error('工作台导览需要界面。');
  let automaticAt=0,opened=false,destroyed=false,index=0,generation=0,pendingFrame=null,opener=null,anchor=null,starting=null,waiting=false,seen=false,mutation=null,resize=null,startupObserver=null,startupTimer=null,readyRetries=0;
  const make=(tag,cls,value)=>{const n=doc.createElement(tag);n.className=cls||'';if(value!==undefined)n.textContent=value;return n;};
  const button=(cls,label,handler)=>{const n=make('button',cls,label);n.type='button';n.onclick=handler;return n;};
  const layer=make('div','workspace-tour');layer.id='workspaceTour';layer.hidden=true;
  const spot=make('div','workspace-tour-spotlight');spot.id='workspaceTourSpotlight';spot.setAttribute('aria-hidden','true');spot.hidden=true;
  const card=make('section','workspace-tour-card');card.id='workspaceTourCard';card.tabIndex=-1;card.setAttribute('role','dialog');card.setAttribute('aria-modal','false');card.setAttribute('aria-labelledby','workspaceTourTitle');card.setAttribute('aria-describedby','workspaceTourBody');
  const top=make('div','workspace-tour-top'),brand=make('span','workspace-tour-brand','熟悉 AI Bro'),skip=button('workspace-tour-skip','跳过',()=>close('skipped'));skip.id='workspaceTourSkip';skip.setAttribute('aria-label','跳过工作台导览');top.append(brand,skip);
  const track=make('div','workspace-tour-track');track.setAttribute('aria-label','导览步骤');const trackButtons=steps.map((step,i)=>{const n=button('workspace-tour-dot',String(i+1),()=>go(i));n.setAttribute('aria-label',`${i+1}. ${step.label}`);track.append(n);return n;});
  const label=make('p','workspace-tour-label');label.id='workspaceTourStep';label.setAttribute('aria-live','polite');
  const title=make('h2');title.id='workspaceTourTitle';const body=make('p','workspace-tour-body');body.id='workspaceTourBody';
  const demo=make('div','workspace-tour-demo');demo.setAttribute('aria-hidden','true');const caption=make('span','workspace-tour-demo-caption','交互示意'),scene=make('div','workspace-tour-scene');
  const glyph=make('span','workspace-tour-demo-glyph'),lines=make('div','workspace-tour-demo-lines'),line1=make('span'),line2=make('span'),line3=make('span'),pointer=make('span','workspace-tour-demo-pointer');lines.append(line1,line2,line3);scene.append(glyph,lines,pointer);demo.append(caption,scene);
  const hint=make('p','workspace-tour-hint'),notice=make('p','workspace-tour-notice');notice.setAttribute('role','status');
  const footer=make('div','workspace-tour-footer'),back=button('workspace-tour-back','上一步',()=>go(index-1)),next=button('workspace-tour-next','下一步',()=>index===steps.length-1?close('completed'):go(index+1));back.id='workspaceTourBack';next.id='workspaceTourNext';
  const count=make('span','workspace-tour-count');footer.append(back,count,next);card.append(top,track,label,title,body,demo,hint,notice,footer);layer.append(spot,card);doc.body.append(layer);
  const entry=button('secondary workspace-tour-entry','工作台导览',()=>start());entry.id='openWorkspaceTour';entry.setAttribute('aria-controls',card.id);entry.setAttribute('aria-expanded','false');if(hooks.entry!==false)(doc.querySelector('#settings .page-heading-actions')||doc.querySelector('#settings .page-heading')||doc.querySelector('#settings'))?.append(entry);
  function visible(node){if(!node||node.hidden||node.isConnected===false)return false;const r=node.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<env.innerHeight&&r.left<env.innerWidth;}
  function modalBlocked(){return !!doc.querySelector('dialog:modal, .note-document-leave:not([hidden])');}
  function blocked(){return modalBlocked()||!!doc.querySelector('#onboardingLayer:not([hidden])');}
  function browserAvailable(){return hooks.browserAvailable?!!hooks.browserAvailable():!!env.BrowserTools?.available?.();}
  function findAnchor(){for(const selector of steps[index].selectors){const found=Array.from(doc.querySelectorAll(selector)).find(visible);if(found)return found;}return null;}
  function layout(){
   pendingFrame=null;if(!opened||destroyed)return;card.style.width=Math.max(0,Math.min(352,env.innerWidth-28))+'px';
   const nextAnchor=findAnchor();if(nextAnchor!==anchor){if(anchor)resize?.unobserve(anchor);anchor=nextAnchor;if(anchor)resize?.observe(anchor);}
   const rect=anchor?.getBoundingClientRect();spot.hidden=!rect;
   if(rect){const left=Math.max(3,rect.left-5),top=Math.max(3,rect.top-5);Object.assign(spot.style,{left:left+'px',top:top+'px',width:Math.max(0,Math.min(rect.right+5,env.innerWidth-3)-left)+'px',height:Math.max(0,Math.min(rect.bottom+5,env.innerHeight-3)-top)+'px'});}
   const p=placement(rect,card.getBoundingClientRect(),{width:env.innerWidth,height:env.innerHeight});Object.assign(card.style,{left:p.left+'px',top:p.top+'px',width:p.width+'px',maxHeight:p.maxHeight+'px'});card.dataset.side=p.side;
   if(!rect)notice.textContent='当前窗口没有显示这个入口；可以先了解操作，再回到工作区查看。';else if(notice.dataset.missing==='true')notice.textContent='';notice.dataset.missing=String(!rect);
  }
  function schedule(){if(!opened||pendingFrame!==null)return;pendingFrame=env.requestAnimationFrame(layout);}
  function paint(){
   const step=steps[index];layer.dataset.step=step.id;card.dataset.step=step.id;title.textContent=step.title;body.textContent=step.body;hint.textContent=step.hint;notice.textContent='';notice.dataset.missing='false';
   if(step.id==='browser'&&!browserAvailable()){body.textContent='原生 macOS 版的内置浏览器沿用当前任务的执行策略，默认连续完成网页操作，也可随时由你接管。当前运行环境没有连接该浏览器。';hint.textContent='当前仍可把网页链接发进对话；这不会启用网页点击或电脑控制。';}
   label.textContent=`${index+1} / ${steps.length} · ${step.label}`;count.textContent=`${index+1} / ${steps.length}`;back.disabled=index===0;next.textContent=index===steps.length-1?'开始使用':'下一步';trackButtons.forEach((n,i)=>{n.setAttribute('aria-current',i===index?'step':'false');n.classList.toggle('is-complete',i<index);});
   glyph.textContent=['↗','▱','≡','⌄','◎'][index];[line1,line2,line3].forEach((n,i)=>n.textContent=step.scene[i]);demo.dataset.scene=step.id;demo.classList.remove('is-playing');void demo.offsetWidth;demo.classList.add('is-playing');layout();card.focus({preventScroll:true});hooks.onStep?.(step.id,index);
  }
  function listen(on){const method=on?'addEventListener':'removeEventListener';env[method]('resize',schedule);doc[method]('scroll',schedule,true);doc[method]('keydown',keydown,true);doc[method]('pointerdown',pointerdown,true);}
  // The card floats over a live workspace. Working elsewhere (another page,
  // a click outside the card, Esc) tucks it away; settings can resume it.
  function dismiss(options={}){if(!opened)return false;close('skipped',{...options,resumeStep:index});hooks.toast?.(env.WorkstationI18n?.getLanguage?.()==='en'?'Workspace tour hidden. Resume it from Settings → Workspace tour.':'工作台导览已收起，可在“设置”里点“工作台导览”继续。');return true;}
  function pointerdown(event){if(!opened||blocked())return;const target=event.target;if(!target||card.contains(target)||entry.contains(target))return;dismiss({restoreFocus:false});}
  function routeChanged(view){if(!opened||view===(hooks.view||'agent'))return false;
   // The native shell restores the last location right after launch; that is not the user leaving.
   if(automaticAt&&Date.now()-automaticAt<2500){schedule();return false;}return dismiss({restoreFocus:false});}
  function keydown(event){if(!opened||blocked())return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();dismiss();return;}if(!card.contains(doc.activeElement)||event.altKey||event.ctrlKey||event.metaKey||event.isComposing)return;if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();event.stopPropagation();go(index+(event.key==='ArrowRight'?1:-1));}if(event.key==='Home'||event.key==='End'){event.preventDefault();go(event.key==='Home'?0:steps.length-1);}}
  function observe(){if(env.ResizeObserver){resize=new env.ResizeObserver(schedule);resize.observe(card);}if(env.MutationObserver){mutation=new env.MutationObserver(records=>{if(records.some(r=>!layer.contains(r.target)))schedule();});mutation.observe(doc.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden','open']});}}
  async function start(options={}){
   if(destroyed)return false;if(opened)return true;if(starting)return starting;
   // Explicit replay may replace the other guide, but never a save/login decision.
   if(modalBlocked()){if(!options.automatic)hooks.onError?.(env.WorkstationI18n?.getLanguage?.()==='en'?'Finish or close the current dialog before opening the workspace tour.':'请先完成或关闭当前弹窗，再打开工作台导览。');return false;}
   if(doc.querySelector('#onboardingLayer:not([hidden])')){if(options.automatic)return false;env.WorkstationOnboarding?.close?.('skipped',{restoreFocus:false,returnToOrigin:false});if(blocked())return false;}
   waiting=false;const own=++generation;opener=doc.activeElement;
   starting=(async()=>{try{await hooks.showWorkspace?.();}catch(_){if(own===generation)hooks.onError?.('当前界面暂不能切换。');return false;}if(destroyed||own!==generation||blocked())return false;stopStartup();automaticAt=options.automatic?Date.now():0;const resume=options.automatic?0:hooks.getState?.()?.ui?.workspaceTour?.resumeStep;opened=true;index=Number.isInteger(resume)&&resume>0&&resume<steps.length?resume:0;layer.hidden=false;entry.setAttribute('aria-expanded','true');listen(true);observe();paint();return true;})().finally(()=>{if(own===generation)starting=null;});return starting;
  }
  function close(status='skipped',options={}){
   if(!opened&&!starting)return false;const wasOpen=opened;stopStartup();opened=false;starting=null;waiting=false;seen=true;generation++;layer.hidden=true;spot.hidden=true;entry.setAttribute('aria-expanded','false');listen(false);mutation?.disconnect();resize?.disconnect();mutation=resize=null;anchor=null;if(pendingFrame!==null){env.cancelAnimationFrame(pendingFrame);pendingFrame=null;}
   if(options.restoreFocus!==false){const target=[opener,doc.querySelector('#agentInput'),entry].find(visible);target?.focus({preventScroll:true});}if(wasOpen&&options.notify!==false)hooks.onFinish?.({version:VERSION,status,...(Number.isInteger(options.resumeStep)?{resumeStep:options.resumeStep}:{})});return true;
  }
  function go(nextIndex){if(!opened)return false;index=Math.max(0,Math.min(steps.length-1,nextIndex));paint();return true;}
  function stopStartup(){startupObserver?.disconnect();startupObserver=null;if(startupTimer!==null){env.clearTimeout(startupTimer);startupTimer=null;}}
  function queueStartup(delay=40){if(destroyed||seen||opened||startupTimer!==null)return;startupTimer=env.setTimeout(()=>{startupTimer=null;void maybeStart().catch(()=>{});},delay);}
  function watchStartup(){if(hooks.autoStart!==true||startupObserver||!env.MutationObserver)return;startupObserver=new env.MutationObserver(records=>{if(records.some(r=>!layer.contains(r.target)))queueStartup();});startupObserver.observe(doc.body,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','class','open']});}
  async function maybeStart(){
   if(destroyed||opened||seen||!shouldStart(hooks.getState?.())){stopStartup();return false;}watchStartup();
   if(await hooks.ready?.()===false){waiting=true;if(hooks.autoStart===true&&readyRetries++<60)queueStartup(500);return false;}
   if(destroyed||seen||!shouldStart(hooks.getState?.())){stopStartup();return false;}
   // Automatic startup waits for the workspace page instead of pulling the user off the page they chose.
   if(blocked()||hooks.isBusy?.()||hooks.onWorkspace?.()===false){waiting=true;return false;}waiting=false;return start({automatic:true});
  }
  function destroy(){close('skipped',{notify:false});stopStartup();destroyed=true;layer.remove();entry.remove();}
  const api={start,open:start,close,dismiss,routeChanged,next:()=>index===steps.length-1?close('completed'):go(index+1),previous:()=>go(index-1),go,layout,maybeStart,destroy,isOpen:()=>opened,currentStep:()=>steps[index].id,isWaiting:()=>waiting};if(hooks.autoStart===true)void maybeStart().catch(()=>{});return api;
 }
 let controller=null;return {VERSION,steps,shouldStart,placement,createController,init(hooks){if(!controller)controller=createController(hooks);return controller;},start:options=>controller?.start(options),open:options=>controller?.start(options),close:(...args)=>controller?.close(...args),maybeStart:()=>controller?.maybeStart(),isOpen:()=>!!controller?.isOpen(),routeChanged:view=>!!controller?.routeChanged(view)};
});
