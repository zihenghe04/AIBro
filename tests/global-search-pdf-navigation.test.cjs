'use strict';
// Synthetic DOM/network at the browser boundary; run the real search controller,
// host leave/access/page routing, and PDFReader through its actual page request.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Command=require('../app/command-search'),Evidence=require('../app/citation-evidence');
const source=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
function cut(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,start);return source.slice(a,b);}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};

function fixture(){
 const images=[],requests=[],toolbars=[],toasts=[],nodes=new Map(),frames=new Map();let doc,frame=0,active=null,privateMode=false,leave=()=>true,leaves=0;
 class Node{
  constructor(tag='div',id=''){this.tagName=tag.toUpperCase();this.id=id;this.children=[];this.dataset={};this.attributes={};this.listeners={};this.className='';this.value='';this.open=false;this.style={};this.scrollTop=0;this.scrollLeft=0;this.hidden=false;this.clientWidth=1000;this.clientHeight=700;this.textContent='';this.classList={contains:n=>this.className.split(' ').includes(n),add:n=>{if(!this.classList.contains(n))this.className+=' '+n;},remove:n=>this.className=this.className.split(' ').filter(v=>v!==n).join(' '),toggle:(n,on)=>on?this.classList.add(n):this.classList.remove(n)};}
  get firstElementChild(){return this.children[0]||null;}get isConnected(){for(let n=this;n;n=n.parentElement)if(n===doc.body)return true;return false;}
  all(){return [this,...this.children.flatMap(n=>n.all())];}append(...children){for(const child of children){child.remove();child.parentElement=this;this.children.push(child);}}
  prepend(child){child.remove();child.parentElement=this;this.children.unshift(child);}remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(n=>n!==this);this.parentElement=null;}
  replaceChildren(...children){for(const child of [...this.children])child.remove();this.append(...children);}before(){}after(){}
  get innerHTML(){return this.html||'';}set innerHTML(value){this.html=value;this.replaceChildren();}
  matches(s){return s[0]==='.'?this.classList.contains(s.slice(1)):s[0]==='#'?this.id===s.slice(1):this.tagName===s.toUpperCase();}
  querySelector(s){if(s==='summary')return this.summary ||= new Node('summary');return this.all().slice(1).find(n=>n.matches(s))||null;}querySelectorAll(s){return this.all().slice(1).filter(n=>n.matches(s));}
  closest(s){for(let n=this;n;n=n.parentElement)if(n.matches(s))return n;return null;}contains(n){return this.all().includes(n);}
  setAttribute(k,v){this.attributes[k]=String(v);}removeAttribute(k){delete this.attributes[k];if(k==='src')this._src='';}getAttribute(k){return this.attributes[k]??null;}hasAttribute(k){return Object.hasOwn(this.attributes,k);}
  addEventListener(t,f){(this.listeners[t]||=[]).push(f);}removeEventListener(t,f){this.listeners[t]=(this.listeners[t]||[]).filter(v=>v!==f);}
  fire(t,extra={}){const e={target:this,key:'',preventDefault(){this.defaultPrevented=true;},stopPropagation(){},...extra};for(const fn of this.listeners[t]||[])fn(e);return e;}
  focus(){doc.activeElement=this;}select(){}getClientRects(){return [{}];}getBoundingClientRect(){return {top:0,bottom:100};}
  showModal(){this.open=true;}close(){this.open=false;this.fire('close');}
  get src(){return this._src;}set src(value){this._src=value;images.push(value);}
 }
 const body=new Node('body');doc={body,documentElement:{lang:'zh'},createElement:t=>new Node(t),getElementById:id=>nodes.get('#'+id),addEventListener(){},removeEventListener(){},dispatchEvent(){}};
 for(const id of ['searchDialog','globalSearchInput','searchResults','searchMeta','previewDialog','previewEyebrow','previewTitle','previewMeta','previewContent','previewExtracted','previewAnalysisStatus','previewOrganize','previewBack','previewDownload','editPreviewNote','previewDelete','previewVisual','previewSourceLinks','previewProvenance','taskDialog','paperDialog','readingPane'])nodes.set('#'+id,new Node(id==='searchDialog'?'dialog':'div',id));
 const dialog=nodes.get('#searchDialog'),input=nodes.get('#globalSearchInput'),box=nodes.get('#searchResults');dialog.append(input,nodes.get('#searchMeta'),box);body.append(dialog);
 const target={id:'pdf:synthetic:3',name:'课件示例.pdf',mimeType:'application/pdf',projectId:'course',workspace:'课程',pages:[{page:1,text:'第一节课程说明。'},{page:2,text:'校园观察的准备。'},{page:3,text:'完成二十分钟的结构化观察。'}]};
 const state={projects:[{id:'course',name:'课程项目',workspace:'课程'},{id:'other',name:'其他项目',workspace:'课程'}],imports:[target],notes:[],tasks:[],papers:[],conversations:[],agentRuns:[],trash:[],ui:{}};
 const tabs=[];
 const reading={beforeNavigate:()=>{leaves++;return leave();},bookmark:()=>null,snapshot:()=>({tabs,expanded:false}),present:(kind,id,page)=>{active={kind,id,page};},isActive:(kind,id)=>active?.kind===kind&&active?.id===id,setPage:(kind,id,page)=>{if(active?.kind===kind&&active?.id===id)active.page=page;},reconcile(){}};
 const context={state,storageHydrated:true,serverConflict:false,AbortController,sourcePreviewGuards:new Map(),previewObjectUrl:null,document:doc,$:s=>nodes.get(s)||null,CitationEvidence:Evidence,
  ReadingPane:reading,PrivateMode:{isOn:()=>privateMode,searchable:item=>!item.private&&!item.ephemeral&&!item.incognito},
  ProjectFiles:{unmount:()=>true,markSelected(){}},captureDocumentOrigin:()=>undefined,previewSourceAvailable:ref=>Evidence.access(context.state,ref).available,
  renderPreviewAnalysis(){},showView(){},toast:text=>toasts.push(text),statusLabel:value=>value,projectForTask:()=>null,
  visibleProject:()=>true,visibleImport:()=>true,visibleNote:()=>true,
  requestAnimationFrame:fn=>{frames.set(++frame,fn);return frame;},cancelAnimationFrame:id=>frames.delete(id),setTimeout,clearTimeout,
  addEventListener(){},removeEventListener(){},getComputedStyle:()=>({paddingLeft:'12',paddingRight:'12',paddingTop:'12',paddingBottom:'12'}),
  fetch:async url=>{requests.push(url);if(url.endsWith('/preview-info'))return {ok:true,status:200,json:async()=>({pageCount:3,width:612,height:792})};if(url.includes('/preview-text?page='))return {ok:true,json:async()=>({page:Number(new URL(url,'http://synthetic').searchParams.get('page')),width:612,height:792,words:[]})};throw Error('Unexpected synthetic request: '+url);},
  HalaskaUI:{componentNames:[],mount:(node,name,props)=>{const mount={name,props,update(next){this.props=next;},unmount(){}};toolbars.push(mount);return mount;}},
  CommandSearch:{init:hooks=>hooks},uiIcon:()=>''
 };
 context.window=context;vm.createContext(context);
 vm.runInContext(cut('const esc =','\nlet state;')+'\n'+cut('let pdfPreviewVersion = 0;','function beforePreviewLeave(')+'\n'+cut('function previewItem(','function suspendPreview(')+'\n'+cut('async function openPreview(','function exportNoteMarkdown(')+'\n'+cut('function openNote(','function searchEntities(')+'\n'+cut('function searchEntities(','function renderSearchResults(')+'\n'+cut('async function openGlobalSearchResult(','function openCreateProjectDialog('),context);
 context.renderSearchResults=()=>{};
 vm.runInContext(fs.readFileSync(require.resolve('../app/pdf-reader'),'utf8'),context);
 const host=context.commandSearchController();
 let controller;controller=Command.createController({...host,commands:[],render:q=>controller.render(context.searchEntities(q),q)},context);
 function search(query='二十分钟的结构化观察'){controller.open();input.value=query;controller.render(context.searchEntities(query),query);return box.querySelector('.search-result');}
 return {context,state,target,tabs,images,requests,toolbars,toasts,nodes,dialog,input,box,controller,search,reading,get leaves(){return leaves;},get active(){return active;},setLeave:fn=>leave=fn,setPrivate:value=>privateMode=value,
  activate:(method='enter')=>method==='click'?box.fire('click',{target:box.querySelector('.search-result')}):dialog.fire('keydown',{target:input,key:'Enter'}),
  open:(query='二十分钟的结构化观察')=>context.openGlobalSearchResult('import:'+target.id,{query}),
  page:()=>toolbars.findLast(entry=>entry.name==='PDFReaderToolbar')?.props.page};
}

test('click and Enter follow the actual typed PDF search result to page 3 in the production reader',async()=>{
 for(const method of ['click','enter']){
  const h=fixture();h.search();assert.equal(h.context.searchEntities(h.input.value)[0].matchPage,3);h.activate(method);await settle();
  assert.equal(h.dialog.open,false);assert.equal(h.controller.isExecuting(),false);assert.equal(h.leaves,1);assert.equal(h.page(),3);assert.equal(h.active.page,3);
  assert.equal(h.images.length,1);assert.match(h.images[0],/pdf%3Asynthetic%3A3\/preview\?page=3&/);assert.ok(h.requests.some(url=>url.endsWith('/preview-text?page=3')));
  assert.equal(h.nodes.get('#previewExtracted').open,false,'PDF stays in original reading mode, not extracted-text editing');
 }
});

test('search query belongs to the activated row and IME Enter does not open a result',async()=>{
 const h=fixture();h.search();h.input.fire('compositionstart');h.activate();await settle();assert.equal(h.leaves,0);h.input.fire('compositionend');h.activate();h.input.value='different later query';await settle();assert.equal(h.page(),3);
});

test('page metadata is recomputed before activation and again after the real dirty-draft gate',async()=>{
 for(const timing of ['before-activation','during-draft']){
  const h=fixture(),gate=deferred();h.search();if(timing==='during-draft'){h.setLeave(()=>gate.promise);h.activate();await settle();}
  h.target.pages=[{page:1,text:'说明'},{page:2,text:'完成二十分钟的结构化观察。'},{page:3,text:'附录'}];
  if(timing==='before-activation')h.activate();else gate.resolve(true);
  await settle();assert.equal(h.page(),2,timing);assert.equal(h.images.length,1);assert.match(h.images[0],/page=2&/);
 }
});

test('title-only and unpaged text matches retain the reading tab page instead of forcing page 1',async()=>{
 for(const query of ['课件示例','只存在无页正文']){
  const h=fixture();h.tabs.push({kind:'import',id:h.target.id,page:2});h.target.content='只存在无页正文';h.search(query);h.activate();await settle();assert.equal(h.page(),2);assert.equal(h.active.page,2);
 }
});

test('privacy, scope, identity and availability are rechecked during a pending draft without reading an old target',async()=>{
 const changes={private:h=>h.target.private=true,deleted:h=>h.target.deletedAt=1,duplicate:h=>h.state.imports.push({...h.target}),projectPrivate:h=>h.state.projects[0].private=true,projectMoved:h=>h.target.projectId='other',scopeMoved:h=>h.target.workspace='科研',bodyGone:h=>h.target.pages=[],replacedState:h=>{const current=structuredClone(h.state);current.imports[0].private=true;h.context.state=current;},privateMode:h=>h.setPrivate(true),conflict:h=>h.context.serverConflict=true,notReady:h=>h.context.storageHydrated=false};
 for(const [name,change]of Object.entries(changes)){
  const h=fixture(),gate=deferred();h.setLeave(()=>gate.promise);const pending=h.open();assert.equal(h.leaves,1);change(h);gate.resolve(true);assert.equal((await pending).status,'obsolete',name);assert.deepEqual(h.images,[],name);assert.deepEqual(h.requests,[],name);
 }
});

test('cancelled draft reports failure even when that same PDF was already active',async()=>{
 const h=fixture();h.context.state.previewRecord={type:'import',id:h.target.id};h.reading.present('import',h.target.id,1);h.setLeave(()=>false);h.search();h.activate();await settle();
 assert.equal(h.images.length,0);assert.equal(h.dialog.open,true);assert.match(h.nodes.get('#searchMeta').textContent,/保留当前位置/);assert.equal(h.active.page,1);
});

test('a newer route or preview intent wins over a late accepted dirty-draft decision',async()=>{
 for(const mode of ['route','preview']){
  const h=fixture(),gate=deferred();h.setLeave(()=>gate.promise);const pending=h.open();
  if(mode==='route')h.context.showView.navigationVersion=1;
  else vm.runInContext('++previewOpenIntent',h.context);
  gate.resolve(true);assert.equal((await pending).status,'obsolete');assert.deepEqual(h.images,[]);assert.deepEqual(h.requests,[]);
 }
});

test('fallback search activation resolves the current input without parsing page numbers into an ID',async()=>{
 const h=fixture();h.input.value='二十分钟的结构化观察';assert.equal(await h.context.openGlobalSearchResult('import:'+h.target.id),true);assert.equal(h.page(),3);assert.match(h.images[0],/pdf%3Asynthetic%3A3/);
 h.input.value='absent';assert.equal((await h.context.openGlobalSearchResult('import:'+h.target.id)).status,'obsolete');assert.equal(h.images.length,1);
});

test('controller closes obsolete searches without resurrecting cached excerpts or stealing newer route focus',async()=>{
 for(const change of [h=>h.setPrivate(true),h=>h.context.showView.navigationVersion=1,h=>h.target.projectId='other',h=>vm.runInContext('++previewOpenIntent',h.context)]){
  const h=fixture(),gate=deferred();h.setLeave(()=>gate.promise);h.search();h.activate();await settle();assert.equal(h.leaves,1);
  const laterFocus={synthetic:'newer-surface'};h.context.document.activeElement=laterFocus;change(h);gate.resolve(true);await settle();
  assert.equal(h.dialog.open,false);assert.equal(h.box.children.length,0);assert.equal(h.input.value,'');assert.equal(h.controller.selected(),null);assert.equal(h.controller.isExecuting(),false);assert.equal(h.context.document.activeElement,laterFocus);assert.deepEqual(h.images,[]);
 }
});

test('ordinary draft cancellation restores freshly searched rows rather than stale cached results',async()=>{
 const h=fixture(),gate=deferred();h.state.imports.push({...h.target,id:'second',name:'随后私密的资料.pdf'});h.setLeave(()=>gate.promise);h.search();assert.equal(h.box.querySelectorAll('.search-result').length,2);h.activate();await settle();h.state.imports[1].private=true;gate.resolve(false);await settle();
 assert.equal(h.dialog.open,true);assert.equal(h.box.querySelectorAll('.search-result').length,1);assert.equal(h.controller.selected(),'import:'+h.target.id);assert.match(h.nodes.get('#searchMeta').textContent,/保留当前位置/);assert.deepEqual(h.images,[]);
});
