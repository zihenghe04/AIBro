const test = require('node:test');
const assert = require('node:assert/strict');
const Layout = require('../app/workspace-layout');
const wait = () => { let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject}; };
const context = values => ({width:1440,view:'agent',...values});
test('layout clamps all requested widths and reserves a usable main area across desktop widths',()=>{
  for(const width of [800,980,1001,1100,1177,1440,1920])for(const readingOpen of [false,true])for(const sidebarCollapsed of [false,true]){
    const result=Layout.fitLayout(context({width,readingOpen,sidebarCollapsed}),{sidebar:10000,navigator:10000,reader:10000});
    if(result.fullReader){assert.equal(result.main,0);assert.ok(Object.values(result.handles).every(v=>!v));}
    else{assert.ok(result.main>=(width>1000?360:280),JSON.stringify(result));assert.ok(result.sidebar+result.navigator+result.reader+result.main<=width);}
  }
});
test('small/fullscreen reading hides split handles while original width preferences remain reusable on expansion',()=>{
  const preferred={sidebar:280,navigator:310,reader:790},before=JSON.stringify(preferred);
  for(const values of [{width:650,readingOpen:true},{readingOpen:true,readingExpanded:true}])assert.deepEqual(Layout.fitLayout(context(values),preferred).handles,{sidebar:false,navigator:false,reader:false});
  const shrunk=Layout.fitLayout(context({width:1100,readingOpen:true}),preferred);assert.ok(shrunk.reader<790);
  assert.equal(Layout.fitLayout(context({width:1920,readingOpen:true}),preferred).reader,790);assert.equal(JSON.stringify(preferred),before);
  assert.equal(Layout.fitLayout(context({width:650}),preferred).handles.sidebar,false);
});
test('nonnumeric preferences cannot produce NaN or oversized panes',()=>{
  const result=Layout.fitLayout(context(),{sidebar:'evil',navigator:Infinity,reader:NaN});for(const key of ['sidebar','navigator','reader','main'])assert.ok(Number.isFinite(result[key]));assert.ok(result.main>=360);
});
test('the open context inspector cannot consume the minimum chat width when other panes are expanded',()=>{
  for(const width of [800,1100,1260,1440]){
    const result=Layout.fitLayout(context({width,inspectorOpen:true}),{sidebar:330,navigator:380});
    const inspector=width<=980?240:260;assert.ok(result.main-inspector>=(width>1000?360:280),JSON.stringify(result));
  }
});
function harness(options={}){
  class Node{
    constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.dataset={};this.listeners={};this.hidden=false;this.className='';this._text='';this.value='';this.style={setProperty:(key,value)=>this.style[key]=value};const values=new Set();this.classList={add:(...v)=>v.forEach(x=>values.add(x)),remove:(...v)=>v.forEach(x=>values.delete(x)),contains:v=>values.has(v),toggle:(v,on)=>{if(on===undefined)on=!values.has(v);on?values.add(v):values.delete(v);return on;}};}
    append(...nodes){for(const n of nodes){if(n.parent)n.remove();n.parent=this;this.children.push(n);}}
    insertBefore(node,before){if(!before){this.append(node);return;}node.parent=this;this.children.splice(this.children.indexOf(before),0,node);}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);this.parent=null;}
    all(){return[this,...this.children.flatMap(n=>n.all())];}contains(n){return this.all().includes(n);}
    querySelector(selector){return this.all().find(n=>selector.startsWith('#')?n.id===selector.slice(1):selector.startsWith('.')?n.className.split(' ').includes(selector.slice(1)):n.tagName===selector)||null;}
    set textContent(value){this._text=String(value);this.children=[];}get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}
    setAttribute(k,v){this.attributes[k]=String(v);}getAttribute(k){return this.attributes[k];}
    addEventListener(k,fn){(this.listeners[k]||=[]).push(fn);}removeEventListener(k,fn){this.listeners[k]=(this.listeners[k]||[]).filter(x=>x!==fn);}
    fire(k,values={}){const e={target:this,button:0,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...values};const results=(this.listeners[k]||[]).map(fn=>fn(e));return{event:e,done:Promise.all(results)};}
    focus(){document.activeElement=this;}setPointerCapture(id){this.capture=id;}releasePointerCapture(){this.capture=null;}
    getBoundingClientRect(){return this.rect?.()||{left:0,right:100,top:0,width:100,height:800};}
  }
  const document=new Node('document');document.body=new Node('body');document.append(document.body);document.createElement=tag=>new Node(tag);const win=new Node('window');win.innerWidth=options.width||1440;win.requestAnimationFrame=fn=>fn();
  const add=(id,className,parent=document.body)=>{const n=new Node('div');n.id=id;n.className=className;parent.append(n);return n;};
  const sidebar=add('sidebar','sidebar');add('bottom','sidebar-bottom',sidebar);const navigator=add('navigator','conversation-navigator');const main=add('main','main');const top=add('top','top-actions',main);const theme=add('themeBtn','icon',top);theme.append(new Node('svg'));const agent=add('agent','agent-view',main);const message=add('message','message',agent);const input=add('agentInput','',agent);const reader=add('readingPane','reading-pane');const toolbar=add('toolbar','reading-toolbar',reader);add('readingExpand','reading-control',toolbar);
  const projectView=add('project','project-view',main);const projectTree=add('projectTree','project-tree',projectView);const projectContent=add('projectContent','project-content',projectView);
  const state={ui:{theme:'light',panelWidths:{...(options.preferred||{})}},currentConversationId:'c',conversations:[{id:'c'}],currentProjectId:'p1',projects:[{id:'p1',name:'同名项目',workspace:'课程'},{id:'p2',name:'同名项目',workspace:'科研'}]},saves=[],notices=[],staged=[],projectStaged=[];let themeCalls=0,api;
  document.body.dataset.view='agent';document.body.classList.add('light-mode');
  const css=key=>parseFloat(document.body.style[`--workspace-${key}-width`])||0;
  sidebar.rect=()=>({left:0,right:css('sidebar'),top:0,width:css('sidebar'),height:800});navigator.rect=()=>({left:css('sidebar'),right:css('sidebar')+css('navigator'),top:8,width:css('navigator'),height:784});
  reader.rect=()=>({left:win.innerWidth-css('reader')-8,right:win.innerWidth-8,top:8,width:css('reader'),height:784});
  agent.rect=()=>document.body.classList.contains('reading-open')&&(win.innerWidth<=1000||document.body.classList.contains('reading-expanded'))?{left:0,top:0,right:0,width:0,height:0}:{left:css('sidebar')+css('navigator'),right:win.innerWidth-css('reader')-8,top:60,width:Math.max(0,win.innerWidth-css('sidebar')-css('navigator')-css('reader')-16),height:720};
  projectView.rect=agent.rect;
  const hooks={getState:()=>state,save:()=>{saves.push(JSON.parse(JSON.stringify(state.ui.panelWidths)));return options.save?.();},toast:message=>notices.push(message),isImportBusy:()=>!!options.busy,stageDroppedFiles:async files=>{staged.push(files);return options.stage?.(files);},onTheme:()=>{themeCalls++;state.ui.theme=state.ui.theme==='light'?'dark':'light';document.body.classList.toggle('light-mode',state.ui.theme==='light');}};
  if(!options.noProjectHook)hooks.stageProjectFiles=async(files,id)=>{projectStaged.push({files,id});return options.stageProject?.(files,id);};
  api=Layout.createController(hooks,{document,window:win});
  const $=selector=>document.querySelector(selector),transfer=(files=[{name:'lecture.pdf'}],extra={})=>({types:['Files'],files,items:[],...extra});
  return{api,state,saves,notices,staged,projectStaged,projectTree,projectContent,document,win,message,input,$,transfer,themeCalls:()=>themeCalls,drop:(values={})=>document.fire('drop',{target:message,dataTransfer:transfer(),...values})};
}
test('pointer resizing previews without saves, commits once, and cancellation restores stored widths',()=>{
  const h=harness();const handle=h.$('#resize-sidebar');handle.fire('pointerdown',{clientX:210,pointerId:1});h.win.fire('pointermove',{clientX:290,pointerId:1});assert.equal(h.api.snapshot().layout.sidebar,290);assert.equal(h.saves.length,0);h.win.fire('pointerup',{pointerId:1});assert.equal(h.state.ui.panelWidths.sidebar,290);assert.equal(h.saves.length,1);
  handle.fire('pointerdown',{clientX:290,pointerId:2});h.win.fire('pointermove',{clientX:180,pointerId:2});h.win.fire('pointercancel',{pointerId:2});assert.equal(h.api.snapshot().layout.sidebar,290);assert.equal(h.saves.length,1);
  handle.fire('pointerdown',{clientX:290,pointerId:3});h.win.fire('pointerup',{pointerId:3});assert.equal(h.saves.length,1,'Click without moving is not a stored resize');
  handle.fire('pointerdown',{clientX:290,pointerId:4});h.win.fire('pointermove',{clientX:200,pointerId:4});handle.fire('lostpointercapture',{pointerId:4});assert.equal(h.api.snapshot().dragging,false);assert.equal(h.api.snapshot().layout.sidebar,290);assert.equal(h.saves.length,1);
});
test('accessible separators support arrow/Home/End and doubleclick reset; reader direction follows its left edge',()=>{
  const h=harness();const nav=h.$('#resize-navigator');assert.equal(nav.getAttribute('role'),'separator');nav.fire('keydown',{key:'ArrowRight'});assert.equal(h.state.ui.panelWidths.navigator,264);nav.fire('keydown',{key:'Home'});assert.equal(h.api.snapshot().layout.navigator,170);nav.fire('keydown',{key:'End'});assert.equal(h.api.snapshot().layout.navigator,380);nav.fire('dblclick');assert.equal(h.state.ui.panelWidths.navigator,undefined);assert.equal(h.api.snapshot().layout.navigator,248);
  h.document.body.classList.add('reading-open');h.api.refresh();const reader=h.$('#resize-reader'),before=h.api.snapshot().layout.reader;reader.fire('keydown',{key:'ArrowRight'});assert.ok(h.api.snapshot().layout.reader<before);assert.equal(reader.getAttribute('aria-orientation'),'vertical');assert.match(reader.getAttribute('aria-valuetext'),/阅读区宽度/);
});
test('window shrinking clamps only rendered widths and growing reuses durable preferences',()=>{
  const h=harness({width:1920,preferred:{sidebar:280,reader:790}});h.document.body.classList.add('reading-open');h.api.refresh();assert.equal(h.api.snapshot().layout.reader,790);h.win.innerWidth=1100;h.win.fire('resize');assert.ok(h.api.snapshot().layout.reader<790);assert.equal(h.state.ui.panelWidths.reader,790);assert.equal(h.saves.length,0);h.win.innerWidth=1920;h.win.fire('resize');assert.equal(h.api.snapshot().layout.reader,790);
  h.win.innerWidth=650;h.win.fire('resize');assert.equal(h.$('#resize-reader').hidden,true);assert.equal(h.$('#resize-sidebar').hidden,true);
});
test('theme entry points are explicit in all panes without changing the user theme during setup',()=>{
  const h=harness();assert.equal(h.state.ui.theme,'light');assert.equal(h.themeCalls(),0);assert.match(h.$('#themeBtn').textContent,/切换深色/);assert.ok(h.$('#themeBtn').querySelector('svg'));assert.match(h.$('#sidebarThemeBtn').textContent,/切换深色/);h.$('#readerThemeBtn').onclick();assert.equal(h.state.ui.theme,'dark');assert.equal(h.themeCalls(),1);assert.match(h.$('#themeBtn').textContent,/切换浅色/);
  h.$('#themeBtn').textContent='';h.api.refresh();assert.match(h.$('#themeBtn').textContent,/切换浅色/);
});
test('file drags use the whole conversation overlay, and other areas prevent default navigation',async()=>{
  const h=harness();h.input.value='未发送草稿';const over=h.document.fire('dragover',{target:h.message,dataTransfer:h.transfer()});assert.equal(over.event.prevented,true);assert.equal(h.$('#conversationDropOverlay').hidden,false);await h.drop().done;assert.equal(h.staged.length,1);assert.equal(h.input.value,'未发送草稿');assert.equal(h.$('#conversationDropOverlay').hidden,true);
  const outside=h.drop({target:h.$('#sidebar')});await outside.done;assert.equal(outside.event.prevented,true);assert.equal(outside.event.stopped,true);assert.equal(h.staged.length,1);assert.match(h.notices.at(-1),/对话区域/);
  const text=h.document.fire('dragover',{target:h.message,dataTransfer:{types:['text/plain'],files:[]}});assert.equal(text.event.prevented,undefined);assert.equal(h.$('#conversationDropOverlay').hidden,true);
});
test('the same captured drop event and simultaneous drops cannot import twice',async()=>{
  const pending=wait();const h=harness({stage:()=>pending.promise});const first=h.drop();await Promise.resolve();await Promise.resolve();const second=h.drop();await second.done;assert.match(h.notices.at(-1),/正在添加/);pending.resolve();await first.done;assert.equal(h.staged.length,1);
  const listener=h.document.listeners.drop[0];await listener(first.event);assert.equal(h.staged.length,1);
});
test('folders reject the whole drop explicitly and keep the existing conversation draft',async()=>{
  const h=harness();h.input.value='请整理';await h.drop({dataTransfer:h.transfer([{name:'folder'}],{items:[{kind:'file',webkitGetAsEntry:()=>({isDirectory:true})}]})}).done;assert.equal(h.staged.length,0);assert.match(h.notices.at(-1),/文件夹/);assert.equal(h.input.value,'请整理');
});
test('files and handle requests are captured before protected DataTransfer clears asynchronously',async()=>{
  const pending=wait(),file={name:'source.pdf'},other={name:'figure.png'};let started=0;const transfer={files:[file,other],items:[file,other].map(value=>({kind:'file',getAsFileSystemHandle:()=>{started++;return pending.promise;},getAsFile:()=>value}))};const result=Layout.droppedFiles(transfer);assert.equal(started,2);transfer.files=[];transfer.items=[];pending.resolve({kind:'file'});assert.deepEqual(await result,[file,other]);
});
test('conversation switching during async directory inspection cannot reparent dropped files',async()=>{
  const pending=wait();const h=harness();const result=h.drop({dataTransfer:h.transfer(undefined,{items:[{kind:'file',getAsFileSystemHandle:()=>pending.promise}]})});h.state.currentConversationId='other';pending.resolve({kind:'file'});await result.done;assert.equal(h.staged.length,0);assert.match(h.notices.at(-1),/对话已切换/);
});
test('stream rerender removing the original drop target does not cancel a valid same-conversation file',async()=>{
  const pending=wait();const h=harness();const result=h.drop({dataTransfer:h.transfer(undefined,{items:[{kind:'file',getAsFileSystemHandle:()=>pending.promise}]})});h.message.remove();pending.resolve({kind:'file'});await result.done;assert.equal(h.staged.length,1);
});
test('failed/busy imports recover cleanly and do not consume text drags',async()=>{
  const h=harness({stage:()=>{throw new Error('磁盘不可用');}});await h.drop().done;assert.equal(h.api.snapshot().dropBusy,false);assert.match(h.notices.at(-1),/磁盘不可用/);
  const busy=harness({busy:true});await busy.drop().done;assert.equal(busy.staged.length,0);assert.match(busy.notices.at(-1),/正在添加/);
  const text=busy.drop({dataTransfer:{types:['text/plain'],files:[]}});await text.done;assert.equal(text.event.prevented,undefined);
});
test('both project tree and main content accept files for the exact project without creating or consuming conversation drafts',async()=>{
  const h=harness();h.document.body.dataset.view='project';h.input.value='尚未发送的对话指令';const before=JSON.stringify(h.state.conversations);
  for(const target of [h.projectTree,h.projectContent]){
    const over=h.document.fire('dragover',{target,dataTransfer:h.transfer()});assert.equal(over.event.prevented,true);assert.equal(h.$('#conversationDropOverlay').dataset.dropTarget,'project');assert.match(h.$('#conversationDropOverlay').textContent,/保存到当前项目/);assert.match(h.$('#conversationDropOverlay').textContent,/原件先保存，待 AI 分析/);
    await h.drop({target}).done;
  }
  assert.deepEqual(h.projectStaged.map(entry=>entry.id),['p1','p1']);assert.equal(h.staged.length,0);assert.equal(h.input.value,'尚未发送的对话指令');assert.equal(JSON.stringify(h.state.conversations),before);
});
test('project switching during asynchronous file probes cannot attach to a same-name project in another space',async()=>{
  const pending=wait();const h=harness();h.document.body.dataset.view='project';const result=h.drop({target:h.projectTree,dataTransfer:h.transfer(undefined,{items:[{kind:'file',getAsFileSystemHandle:()=>pending.promise}]})});h.state.currentProjectId='p2';pending.resolve({kind:'file'});await result.done;assert.equal(h.projectStaged.length,0);assert.equal(h.staged.length,0);assert.match(h.notices.at(-1),/项目已切换/);
});
test('project archive, removal or navigation during probing invalidates the captured drop destination',async()=>{
  for(const change of [h=>h.state.projects[0].archived=true,h=>h.state.projects=[],h=>h.document.body.dataset.view='agent']){
    const pending=wait();const h=harness();h.document.body.dataset.view='project';const result=h.drop({target:h.projectContent,dataTransfer:h.transfer(undefined,{items:[{kind:'file',getAsFileSystemHandle:()=>pending.promise}]})});change(h);pending.resolve({kind:'file'});await result.done;assert.equal(h.projectStaged.length,0);assert.equal(h.staged.length,0);assert.match(h.notices.at(-1),/项目已切换、删除或归档/);
  }
});
test('project probes survive its content rerender, and conversation changes do not redirect the pinned project import',async()=>{
  const pending=wait();const h=harness();h.document.body.dataset.view='project';const result=h.drop({target:h.projectContent,dataTransfer:h.transfer(undefined,{items:[{kind:'file',getAsFileSystemHandle:()=>pending.promise}]})});h.projectContent.remove();h.state.currentConversationId='other';pending.resolve({kind:'file'});await result.done;assert.equal(h.projectStaged.length,1);assert.equal(h.projectStaged[0].id,'p1');assert.equal(h.staged.length,0);
});
test('project directories, duplicate drops and unsupported surfaces preserve the file-only and single-flight boundary',async()=>{
  const pending=wait();const h=harness({stageProject:()=>pending.promise});h.document.body.dataset.view='project';const first=h.drop({target:h.projectTree});await Promise.resolve();await Promise.resolve();await h.drop({target:h.projectContent}).done;assert.match(h.notices.at(-1),/正在添加/);pending.resolve();await first.done;assert.equal(h.projectStaged.length,1);
  await h.drop({target:h.projectTree,dataTransfer:h.transfer([{name:'folder'}],{items:[{kind:'file',webkitGetAsEntry:()=>({isDirectory:true})}]})}).done;assert.equal(h.projectStaged.length,1);assert.match(h.notices.at(-1),/文件夹/);
  const outside=h.drop({target:h.$('#readingPane')});await outside.done;assert.equal(outside.event.prevented,true);assert.equal(h.projectStaged.length,1);
  const missing=harness({noProjectHook:true});missing.document.body.dataset.view='project';await missing.drop({target:missing.projectTree}).done;assert.equal(missing.staged.length,0);assert.equal(missing.projectStaged.length,0);
});
test('conversation overlay promises pending materials rather than automatic AI analysis',()=>{
  const h=harness();h.document.fire('dragover',{target:h.message,dataTransfer:h.transfer()});assert.equal(h.$('#conversationDropOverlay').dataset.dropTarget,'conversation');assert.match(h.$('#conversationDropOverlay').textContent,/待发送材料/);assert.match(h.$('#conversationDropOverlay').textContent,/随下一条指令/);
});
