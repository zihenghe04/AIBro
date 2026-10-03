const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const AttachmentAnalysis = require('../app/attachment-analysis');
const Reading = require('../app/reading-pane');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
function dom({withMain=false}={}) {
  const placements=[];
  class Node {
    constructor(tag){this.tagName=tag;this.children=[];this.listeners={};this.attributes={};this.dataset={};this.style={};this.hidden=false;this.value='';this.className='';this._text='';this._html='';const classes=new Set();this.classList={toggle:(v,on)=>{if(on===undefined)on=!classes.has(v);on?classes.add(v):classes.delete(v);return on;},contains:v=>classes.has(v)};if(tag==='details'||tag==='dialog')this.open=false;if(tag==='dialog'){this.show=function(){this.open=true;};this.showModal=function(){this.open=true;};this.close=function(){this.open=false;this.fire('close');};}}
    set textContent(v){this._text=String(v);this.children=[];} get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}
    set innerHTML(v){this._html=String(v);this.children=[];} get innerHTML(){return this._html;}
    append(...nodes){for(const n of nodes){if(n.parent)n.parent.children=n.parent.children.filter(x=>x!==n);n.parent=this;this.children.push(n);placements.push({node:n,parent:this});}}
    insertBefore(node,reference){if(node===reference)return node;if(node.parent)node.parent.children=node.parent.children.filter(x=>x!==node);const index=this.children.indexOf(reference);if(index<0)throw Error('Reference is not a child');node.parent=this;this.children.splice(index,0,node);placements.push({node,parent:this});return node;}
    before(node){const p=this.parent;if(p)p.insertBefore(node,this);}
    insertAdjacentElement(_,node){this.before(node);}
    replaceChildren(...nodes){this.children=[];this._text='';this._html='';this.append(...nodes);}
    setAttribute(k,v){this.attributes[k]=String(v);} removeAttribute(k){delete this.attributes[k];delete this[k];}
    getAttribute(k){return this.attributes[k];}
    get parentElement(){return this.parent;}
    get offsetLeft(){return this.parent?.children.indexOf(this)*150;}
    get offsetWidth(){return 150;}
    addEventListener(k,fn){(this.listeners[k]||=[]).push(fn);} fire(k,e={}){const event={target:this,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.cancelBubble=true;},...e};for(const fn of this.listeners[k]||[])fn(event);this['on'+k]?.(event);if(event.bubbles&&!event.cancelBubble)this.parent?.fire(k,event);return event;}
    dispatchEvent(event){this.fire(event.type,{detail:event.detail});return true;}
    all(){return [this,...this.children.flatMap(x=>x.all())];}
    matches(q){if(q.startsWith('#'))return this.id===q.slice(1);if(q.startsWith('.'))return this.className.split(' ').includes(q.slice(1));const attribute=/^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(q);if(attribute)return Object.hasOwn(this.attributes,attribute[1])&&(attribute[2]===undefined||this.attributes[attribute[1]]===attribute[2]);return this.tagName===q;}
    closest(q){return this.matches(q)?this:this.parent?.closest(q)||null;}
    contains(node){return this.all().includes(node);}
    querySelector(q){return this.all().find(n=>n.matches(q))||null;}
    querySelectorAll(q){return this.all().filter(n=>n.matches(q));}
    click(){return this.fire('click',{bubbles:true});} focus(){document.activeElement=this;}
  }
  const document={createElement:tag=>new Node(tag),body:new Node('body'),getElementById:id=>document.body.all().find(n=>n.id===id)||null,querySelector:q=>document.body.querySelector(q)};
  const add=(id,tag='div',parent=document.body)=>{const n=new Node(tag);n.id=id;parent.append(n);return n;};
  const main=withMain?add('main','main'):null;if(main)main.className='main';
  const actions=add('topActions','div',main||document.body);actions.className='top-actions';const input=add('agentInput','textarea',main||document.body);document.activeElement=input;
  const region=add('previewDialog','section');region.hidden=true;const frame=add('previewFrame','div',region);frame.className='reader-document-frame';
  for(const id of ['previewEyebrow','previewTitle','previewMeta','previewAnalysisStatus','previewRelations','previewVisual','previewContent','previewDownload','previewBack','previewOrganize'])add(id,'div',frame);
  for(const id of ['previewHeaderClose','previewFooterClose']){const close=add(id,'button',frame);close.type='button';close.setAttribute('data-reader-close','');}
  add('taskDialog','dialog');add('paperDialog','dialog');
  return {document,add,placements,$:q=>document.querySelector(q)};
}
function harness({real=false,getBlob,beforeLeave,WorkspaceLayout,HalaskaUI,nativeShell,withMain=false,reading=Reading,hooks={}}={}) {
  const d=dom({withMain});const state={projects:[{id:'p',name:'课程'}],imports:[{id:'a',name:'原件.pdf',mimeType:'application/pdf',projectId:'p'},{id:'b',name:'图片.png',mimeType:'image/png',projectId:'p'}],notes:[{id:'n',title:'研究笔记',content:'实际笔记',projectId:'p',sourceAttachmentIds:['a']}],papers:[],tasks:[{id:'t',title:'任务'}],previewRecord:null,openTaskId:'t'};
  const calls=[],revoked=[];let api,serial=0,context;
  if(real){
    context=vm.createContext({NoteMarkdown:require('../app/note-markdown'),state,$:d.$,document:d.document,window:{AttachmentAnalysis,TaskWorkflow:require('../app/task-workflow')},AttachmentAnalysis,URL:{createObjectURL:()=>`blob:test-${++serial}`,revokeObjectURL:url=>revoked.push(url)},Blob,AbortController,previewObjectUrl:null,pdfPreviewVersion:0,pdfPreviewAbort:{abort:()=>calls.push(['abort'])},
      esc:String,uiIcon:()=>'',toast:message=>calls.push(['toast',message]),renderRichText:content=>`<p>${content}</p>`,visibleProject:p=>!p.archived,visibleImport:i=>!i.archived,visibleNote:n=>!n.archived,
      fileStoreGet:async (id,options)=>getBlob?getBlob(id,options):new Blob(['file'],{type:state.imports.find(x=>x.id===id)?.mimeType}),mountPdfPreview:(container,item,blob,page)=>{container.innerHTML='PDF rendered';calls.push(['pdf',item.id,page]);},renderTaskDialog:()=>calls.push(['render-task']),openPaper:()=>{},openProject:()=>{},dataUrlToBlob:()=>new Blob(['file'])});
    vm.runInContext(source.slice(source.indexOf('const taskEditorContexts ='), source.indexOf('function taskSources(')), context);
    vm.runInContext(source.slice(source.indexOf('function importAnalysis('), source.indexOf('function entityImport(')) + source.slice(source.indexOf('function renderPreviewAnalysis('), source.indexOf('// Stage a focused analysis request')), context);
    vm.runInContext(source.slice(source.indexOf('let previewRequestVersion ='),source.indexOf('\nconst searchTypeLabel =')),context);
  }
  const getItem=(kind,id)=>real?context.previewItem(kind,id):(kind==='note'?state.notes:state.imports).find(x=>x.id===id&&!x.archived&&!x.deletedAt&&state.projects.some(p=>p.id===x.projectId&&!p.archived));
  api=reading.createController({getItem,beforeLeave,beforeSwitch:real?(options)=>context.beforePreviewSwitch(options):undefined,onSuspend:()=>real?context.suspendPreview():calls.push(['suspend']),onSelect:(kind,id,page)=>{calls.push(['select',kind,id,page]);return real?context.openPreview(kind,id,page):api.present(kind,id,page);},...hooks},{document:d.document,WorkspaceLayout,HalaskaUI,nativeShell,matchMedia:()=>({matches:false})});
  if(real){context.window.ReadingPane=api;context.ReadingPane=api;}
  return {...d,state,api,calls,context,revoked,open:(kind,id,page)=>real?context.openPreview(kind,id,page):api.present(kind,id,page)};
}
test('native reader is first mounted before main while web keeps its existing trailing order',()=>{
  for(const nativeShell of [true,false]){
    const h=harness({nativeShell,withMain:true}),body=h.document.body,pane=h.$('#readingPane'),main=h.$('.main');
    assert.equal(pane.parentElement,body);assert.equal(pane.hidden,true);
    assert.equal(body.children.indexOf(pane)<body.children.indexOf(main),nativeShell);
    if(nativeShell)assert.equal(body.children[body.children.indexOf(pane)+1],main);
    else assert.equal(body.children.at(-1),pane);
    assert.equal(h.placements.filter(change=>change.node===pane).length,1,'the reader must be mounted in its final position immediately');
    assert.equal(h.$('#previewDialog').parentElement,pane);
    assert.equal(h.document.activeElement,h.$('#agentInput'),'initial placement must not steal composer focus');
    assert.equal(h.$('#readingToggle').parentElement,h.$('.top-actions'));
  }
});

test('a PDF-named URL bookmark uses ordinary reader layout until content is actually available', () => {
  const h = harness(), source = h.state.imports[0];
  Object.assign(source, { parser: 'bookmark', url: 'https://example.org/reference.pdf', fileStored: false, content: '', pages: [] });
  h.open('import', source.id);
  assert.equal(h.document.body.classList.contains('reading-pdf'), false);
  assert.equal(h.$('#readingTabs').parentElement, h.$('#readingPane'));
  source.fileStored = true; h.open('import', source.id);
  assert.equal(h.document.body.classList.contains('reading-pdf'), true);
  assert.notEqual(h.$('#readingTabs').parentElement, h.$('#readingPane'));
});
test('native detection uses the injected workspace bridge before native CSS classes exist and respects an explicit web override',()=>{
  const context=vm.createContext({webkit:{messageHandlers:{workspace:{postMessage(){}}}}});
  vm.runInContext(fs.readFileSync(require.resolve('../app/reading-pane'),'utf8'),context);
  for(const nativeShell of [undefined,false]){
    const h=harness({reading:context.ReadingPane,nativeShell,withMain:true}),body=h.document.body;
    assert.equal(body.classList.contains('aibro-native'),false,'this is the document initialization path before the native bridge adds CSS classes');
    assert.equal(body.children.indexOf(h.$('#readingPane'))<body.children.indexOf(h.$('.main')),nativeShell!==false);
  }
});
test('native reader without a main element still mounts once and opens an original',()=>{
  const h=harness({nativeShell:true}),pane=h.$('#readingPane');
  assert.equal(pane.parentElement,h.document.body);assert.equal(h.placements.filter(change=>change.node===pane).length,1);
  h.open('import','a',2);assert.equal(pane.hidden,false);assert.equal(h.api.snapshot().tabs[0].page,2);
});
test('native expansion and route-driven layout updates retain the mounted PDF subtree, page and focus',()=>{
  let refreshes=0;const h=harness({nativeShell:true,withMain:true,WorkspaceLayout:{refresh(){refreshes++;}}});
  h.$('#agentInput').value='未发送草稿';h.open('import','a',2);
  const pane=h.$('#readingPane'),surface=h.$('#previewDialog'),frame=h.$('#previewFrame');
  const pdf=h.add('mountedPdf','section',h.$('#previewVisual'));pdf.className='pdf-reader';
  const viewport=h.add('mountedViewport','div',pdf);viewport.className='pdf-viewport';viewport.scrollTop=184;
  const page=h.add('mountedPage','input',pdf);page.value='2';page.focus();
  const documentNodes=new Set([pane,surface,frame,pdf,viewport,page]),before=h.placements.length;
  const check=()=>{
    assert.equal(h.$('#readingPane'),pane);assert.equal(pane.parentElement,h.document.body);
    assert.equal(h.document.body.children[h.document.body.children.indexOf(pane)+1],h.$('.main'));
    assert.equal(surface.parentElement,pane);assert.equal(frame.parentElement,surface);
    assert.equal(h.$('#mountedPdf'),pdf);assert.equal(pdf.parentElement,h.$('#previewVisual'));
    assert.equal(viewport.parentElement,pdf);assert.equal(page.parentElement,pdf);
    assert.equal(viewport.scrollTop,184);assert.equal(page.value,'2');assert.equal(h.document.activeElement,page);
    assert.equal(h.api.snapshot().tabs[0].page,2);assert.equal(h.$('#agentInput').value,'未发送草稿');
    assert.deepEqual(h.placements.slice(before).filter(change=>documentNodes.has(change.node)),[],'pane and document ancestors must never be reinserted to refresh layout');
    assert.equal(h.calls.length,0,'layout changes must neither suspend nor select the original again');
  };
  h.api.setExpanded(true);check();h.api.setExpanded(false);check();
  // Native routes own host visibility; the retained reader sees route metadata
  // and reconciliation. Exercise those updates without treating navigation as hide().
  for(const view of ['settings','overview','agent','project','agent']){
    h.document.body.dataset.view=view;h.state.imports[0].name=`原件-${view}.pdf`;h.api.reconcile();
    h.api.setExpanded(view==='agent');check();
  }
  assert.ok(refreshes>=9,'the retained nodes survived repeated real updateShell geometry refreshes');
});
test('native-first reader keeps Escape focus restoration and remembered-page reopening',()=>{
  const h=harness({nativeShell:true,withMain:true}),input=h.$('#agentInput'),pane=h.$('#readingPane');
  input.value='继续输入';input.focus();h.open('import','a',2);h.api.setExpanded(true);
  h.$('#readingTabs').querySelector('[aria-selected="true"]').focus();const before=h.placements.filter(change=>change.node===pane).length;
  const escape=pane.fire('keydown',{key:'Escape'});
  assert.equal(escape.defaultPrevented,true);assert.equal(h.document.activeElement,input);assert.equal(input.value,'继续输入');
  assert.equal(pane.hidden,true);assert.equal(h.api.snapshot().tabs[0].page,2);assert.deepEqual(h.calls,[['suspend']]);
  h.$('#readingToggle').click();assert.equal(pane.hidden,false);assert.deepEqual(h.calls.at(-1),['select','import','a',2]);
  assert.equal(h.placements.filter(change=>change.node===pane).length,before);assert.equal(h.$('#readingPane'),pane);
});
test('navigation parks an expanded reader without closing or replacing its document and reopens the same page',()=>{
  const h=harness({withMain:true});h.open('import','a',2);h.api.setExpanded(true);
  const pane=h.$('#readingPane'),surface=h.$('#previewDialog'),page=h.add('parkedPage','input',h.$('#previewVisual'));
  page.value='2';page.scrollTop=81;const changes=h.placements.length;
  h.api.revealWorkspace();
  assert.equal(h.api.snapshot().visible,false);assert.equal(h.api.snapshot().retained,true);assert.equal(h.api.snapshot().expanded,true);
  assert.equal(pane.hidden,true);assert.equal(surface.hidden,true);assert.equal(h.document.body.classList.contains('reading-open'),false);
  assert.equal(h.api.isActive('import','a'),true,'in-flight loading still owns its retained document');assert.deepEqual(h.calls,[]);
  h.$('#readingToggle').click();
  assert.equal(h.api.snapshot().visible,true);assert.equal(h.api.snapshot().retained,false);assert.equal(pane.hidden,false);
  assert.equal(h.$('#parkedPage'),page);assert.equal(page.value,'2');assert.equal(page.scrollTop,81);assert.equal(h.api.snapshot().tabs[0].page,2);
  assert.deepEqual(h.calls,[],'resume must not select the document again');assert.equal(h.placements.length,changes);
});
test('reader owner announces parking before geometry hides and resuming after the layout has fitted',()=>{
  const events=[];let h;
  h=harness({WorkspaceLayout:{refresh(){if(h)events.push(['layout',h.$('#previewDialog').hidden]);}}});
  const surface=h.$('#previewDialog');
  surface.addEventListener('aibro:reader-visibility',event=>events.push(['visibility',event.detail.visible,surface.hidden]));
  h.open('note','n');assert.deepEqual(events,[['layout',false],['visibility',true,false]]);events.length=0;
  h.api.revealWorkspace({force:true});assert.deepEqual(events,[['visibility',false,false],['layout',true]]);events.length=0;
  h.api.resume();assert.deepEqual(events,[['layout',false],['visibility',true,false]]);events.length=0;
  h.api.refreshTabs();h.api.setExpanded(true);
  assert(events.every(event=>event[0]==='layout'),'metadata and width-only updates do not replay visibility transitions');
});
test('a parked owner retains its saved reading position even when the platform resets the hidden surface',()=>{
  const saves=[];let position=1701,saved=1701;
  const h=harness({hooks:{captureView:()=>({scrollTop:saved}),saveSession:value=>saves.push(value)}}),surface=h.$('#previewDialog');
  surface.addEventListener('aibro:reader-visibility',event=>{if(event.detail.visible)position=saved;else saved=position;});
  h.open('note','n');position=3402;h.api.revealWorkspace({force:true});
  position=0;h.api.remember();assert.equal(saves.at(-1).tabs[0].bookmark.scrollTop,3402);
  h.api.resume();assert.equal(position,3402);assert.equal(h.api.snapshot().visible,true);
});
test('ordinary wide navigation keeps split reading, settings can park it, and automatic full-reader layout also yields',()=>{
  const h=harness();h.open('import','a',2);h.api.revealWorkspace();assert.equal(h.api.snapshot().visible,true);
  h.api.revealWorkspace({force:true});assert.equal(h.api.snapshot().retained,true);h.api.resume();
  h.document.body.classList.toggle('workspace-reader-focus',true);h.api.revealWorkspace();assert.equal(h.api.snapshot().retained,true);
  assert.equal(h.api.snapshot().expanded,false,'automatic reader focus is distinct from explicit expansion');assert.deepEqual(h.calls,[]);
});
test('navigation itself does not ask to discard an editor, but explicit close retains the leave guard',async()=>{
  let leaves=0;const wait=deferred();const h=harness({beforeLeave:()=>{leaves++;return wait.promise;}});
  h.open('note','n');h.api.setExpanded(true);h.api.revealWorkspace();
  assert.equal(leaves,0);assert.equal(h.api.isActive('note','n'),true);assert.deepEqual(h.calls,[]);
  h.api.resume();const closing=h.api.close();assert.equal(leaves,1);wait.resolve(false);await closing;
  assert.equal(h.api.snapshot().visible,true);assert.equal(h.api.snapshot().activeKey,JSON.stringify(['note','n']));assert.deepEqual(h.calls,[]);
});
test('removing a parked active document releases it without revealing a different tab behind navigation',()=>{
  const h=harness();h.open('note','n');h.open('import','a',2);h.api.setExpanded(true);h.api.revealWorkspace();
  h.state.imports=[];h.api.reconcile();assert.equal(h.api.snapshot().visible,false);assert.equal(h.api.snapshot().retained,false);
  assert.equal(h.api.snapshot().activeKey,JSON.stringify(['note','n']));assert.equal(h.$('#readingPane').hidden,true);
  assert.deepEqual(h.calls,[['suspend']]);h.$('#readingToggle').click();assert.equal(h.api.snapshot().visible,true);assert.deepEqual(h.calls.at(-1),['select','note','n',1]);
});
test('an original loading while parked finishes in place without showing over the navigation destination',async()=>{
  const wait=deferred(),h=harness({real:true,getBlob:()=>wait.promise});const loading=h.open('import','a',2);
  h.api.setExpanded(true);h.api.revealWorkspace();wait.resolve(new Blob(['pdf']));await loading;
  assert.equal(h.$('#readingPane').hidden,true);assert.equal(h.$('#previewDialog').hidden,true);assert.equal(h.api.snapshot().retained,true);
  assert.equal(h.state.previewRecord.id,'a');assert.equal(h.$('#previewVisual').innerHTML,'PDF rendered');assert.deepEqual(h.revoked,[]);
  const url=h.$('#previewDownload').href;h.$('#readingToggle').click();assert.equal(h.$('#previewDownload').href,url);
  assert.equal(h.api.snapshot().visible,true);assert.equal(h.api.snapshot().tabs[0].page,2);assert.equal(h.calls.filter(x=>x[0]==='pdf').length,1);
});
test('reader is a section without dialog APIs, keeps escaped labels, main input and unique tabs',()=>{
  const h=harness();h.state.notes[0].title='<img src=x onerror=alert(1)>';h.$('#agentInput').value='草稿';h.open('note','n');h.open('import','a');h.open('import','a',2);
  const region=h.$('#previewDialog');assert.equal(region.tagName,'section');assert.equal(region.getAttribute('role'),'region');assert.equal(region.getAttribute('aria-modal'),undefined);for(const key of ['open','show','showModal','close'])assert.equal(key in region,false,key+' must not be emulated on the reader');assert.equal(region.hidden,false);assert.equal(h.$('#agentInput').value,'草稿');assert.equal(h.$('#agentInput').inert,undefined);
  assert.equal(h.api.snapshot().tabs.length,2);assert.match(h.$('#readingTabs').textContent,/<img src=x onerror=alert\(1\)>/);assert.equal(h.api.snapshot().tabs[1].page,2);
});
test('tabs preserve actual page and re-read renamed/current records on selection',()=>{
  const h=harness();h.open('import','a');h.api.setPage('import','a',7);h.open('note','n');h.state.imports[0].name='重命名原件.pdf';h.api.reconcile();h.$('#readingTabs').querySelectorAll('[role="tab"]')[0].onclick();
  assert.deepEqual(h.calls.at(-1),['select','import','a',7]);assert.equal(h.api.snapshot().tabs[0].title,'重命名原件.pdf');assert.equal(h.api.isActive('import','a'),true);
});
test('ordinary source reopening retains its page while explicit citation pages and closed tabs reset appropriately',async()=>{
  const h=harness({real:true});
  await h.context.openImport('a');
  h.api.setPage('import','a',7);
  h.api.setExpanded(true);h.api.revealWorkspace({force:true});
  await h.context.openImport('a');
  assert.deepEqual(h.calls.filter(call=>call[0]==='pdf').at(-1),['pdf','a',7]);
  assert.equal(h.api.snapshot().tabs.find(tab=>tab.id==='a').page,7);
  await h.context.openImport('a',1);
  assert.deepEqual(h.calls.filter(call=>call[0]==='pdf').at(-1),['pdf','a',1]);
  h.api.setPage('import','a',9);
  await h.open('note','n');
  await h.open('import','a');
  assert.deepEqual(h.calls.filter(call=>call[0]==='pdf').at(-1),['pdf','a',9]);
  h.api.close(h.api.snapshot().activeKey);
  await h.context.openImport('a');
  assert.deepEqual(h.calls.filter(call=>call[0]==='pdf').at(-1),['pdf','a',1]);
});
test('present without an explicit page retains the existing tab but an explicit first page still wins',()=>{
  const h=harness();h.open('import','a',4);h.open('note','n');h.open('import','a');
  assert.equal(h.api.snapshot().tabs.find(tab=>tab.id==='a').page,4);
  h.open('import','a',1);assert.equal(h.api.snapshot().tabs.find(tab=>tab.id==='a').page,1);
});
test('collapse retains tabs, expand is reversible, re-open and keyboard navigation preserve input',()=>{
  const h=harness();h.open('import','a');h.open('note','n');h.$('#agentInput').value='继续写';h.$('#readingExpand').onclick();assert.equal(h.api.snapshot().expanded,true);
  h.$('#readingCollapse').onclick();assert.equal(h.api.snapshot().visible,false);assert.equal(h.api.snapshot().expanded,false);assert.equal(h.api.snapshot().tabs.length,2);assert.equal(h.$('#readingToggle').hidden,false);
  h.$('#readingToggle').onclick();assert.equal(h.api.snapshot().visible,true);assert.equal(h.$('#agentInput').value,'继续写');
  h.$('#readingTabs').querySelectorAll('[role="tab"]')[1].onkeydown({key:'Home',preventDefault(){}});assert.equal(h.api.isActive('import','a'),true);
});
test('deleting or archiving an active record activates the next valid tab; final close hides reader',()=>{
  const h=harness();h.open('note','n');h.open('import','a');h.state.imports=[];h.api.reconcile();assert.equal(h.api.isActive('note','n'),true);assert.equal(h.api.snapshot().tabs.length,1);
  h.state.projects[0].archived=true;h.api.reconcile();assert.equal(h.api.snapshot().tabs.length,0);assert.equal(h.api.snapshot().visible,false);assert.equal(h.$('#previewDialog').hidden,true);assert.equal(h.$('#readingToggle').hidden,true);
});
test('closing an inactive tab does not reload or invalidate the current original',()=>{
  const h=harness();h.open('note','n');h.open('import','a');h.api.close(h.api.snapshot().tabs[0].key);assert.equal(h.api.isActive('import','a'),true);assert.equal(h.calls.length,0);
  h.api.close();assert.equal(h.api.snapshot().visible,false);
});
test('mouse-selected tabs retain focus after rerender, so Escape remains available inside the reader',()=>{
  const h=harness();h.open('import','a');h.open('note','n');const tab=h.$('#readingTabs').querySelectorAll('[role="tab"]')[0];tab.focus();tab.onclick();const current=h.document.activeElement;
  assert.notEqual(current,tab);assert.equal(current.dataset.readingKey,h.api.snapshot().activeKey);assert.ok(h.$('#readingTabs').all().includes(current));
  h.$('#readingPane').fire('keydown',{key:'Escape',preventDefault(){}});assert.equal(h.api.snapshot().visible,false);assert.equal(h.$('#previewDialog').hidden,true);
});
test('PDF tabs share one toolbar node and return to the original note layout without moving the document',()=>{
  const h=harness(),strip=h.$('#readingTabs'),region=h.$('#previewDialog'),frame=h.$('#previewFrame'),toolbar=h.$('.reading-toolbar');
  h.open('note','n');assert.equal(strip.parentElement,h.$('#readingPane'));assert.equal(region.parentElement,h.$('#readingPane'));
  h.open('import','a');assert.equal(h.$('#readingTabs'),strip);assert.equal(strip.parentElement,toolbar);assert.equal(h.$('#readingExpand').parentElement,toolbar);assert.equal(region.parentElement,h.$('#readingPane'));assert.equal(frame.parentElement,region);
  const active=strip.querySelector('[aria-selected="true"]');active.focus();h.api.setExpanded(true);h.api.setExpanded(false);assert.equal(h.document.activeElement,active);assert.equal(h.$('#readingTabs'),strip);assert.equal(strip.parentElement,toolbar);
  strip.querySelectorAll('[role="tab"]')[0].onkeydown({key:'Home',preventDefault(){}});assert.equal(h.api.isActive('note','n'),true);assert.equal(strip.parentElement,h.$('#readingPane'));assert.equal(h.document.activeElement.dataset.readingKey,h.api.snapshot().activeKey);
  h.open('import','a');h.api.hide();assert.equal(h.$('#readingTabs'),strip);assert.equal(strip.parentElement,h.$('#readingPane'));h.$('#readingToggle').click();assert.equal(strip.parentElement,toolbar);assert.equal(h.$('#previewDialog'),region);
});
test('new active tabs scroll into the tab strip without moving the reading document',()=>{
  const h=harness();const strip=h.$('#readingTabs');strip.clientWidth=200;strip.scrollLeft=0;h.$('#previewDialog').scrollTop=97;
  h.open('note','n');h.open('import','a');h.open('import','b');assert.equal(strip.scrollLeft,250);assert.equal(h.$('#previewDialog').scrollTop,97);
  strip.querySelectorAll('[role="tab"]')[0].onclick();assert.equal(strip.scrollLeft,0);assert.equal(h.$('#previewDialog').scrollTop,97);
});
test('real preview opens immediately and a slow previous original cannot overwrite another tab',async()=>{
  // Images still use the asynchronous Blob path. PDFs now mount the page reader
  // directly, whose original lifecycle is covered in pdf-original-host.test.cjs.
  const wait=deferred();let signal;const h=harness({real:true,getBlob:(id,options)=>{assert.equal(id,'b');signal=options.signal;return wait.promise;}});const pending=h.open('import','b');assert.equal(h.$('#previewDialog').hidden,false);assert.match(h.$('#previewVisual').innerHTML,/正在载入原件/);assert.equal(signal.aborted,false);
  await h.open('note','n');assert.equal(signal.aborted,true);wait.resolve(new Blob(['image'],{type:'image/png'}));await pending;assert.equal(h.$('#previewTitle').textContent,'研究笔记');assert.equal(h.context.state.previewRecord.id,'n');assert.equal(h.$('#previewVisual').innerHTML,'');assert.equal(h.calls.filter(x=>x[0]==='pdf').length,0);assert.equal(h.$('#previewDownload').href,'blob:test-1');
});
test('known PDF mounts the page reader without entering the whole-file Blob loading path',async()=>{
  let reads=0;const h=harness({real:true,getBlob:()=>{reads++;throw Error('PDF original must not be loaded by openPreview');}});await h.open('import','a',3);
  assert.equal(reads,0);assert.deepEqual(h.calls.filter(x=>x[0]==='pdf'),[['pdf','a',3]]);assert.equal(h.$('#previewVisual').innerHTML,'PDF rendered');assert.equal(h.$('#previewDownload').href,'/__files/a');assert.equal(h.$('#previewDownload').hidden,false);assert.equal(h.api.snapshot().tabs[0].page,3);
});
test('close during blob load invalidates late success and late failure without re-opening or leaking URLs',async()=>{
  for(const fail of [false,true]){const wait=deferred();let signal;const h=harness({real:true,getBlob:(id,options)=>{assert.equal(id,'b');signal=options.signal;return wait.promise;}});const pending=h.open('import','b');assert.equal(signal.aborted,false);assert.match(h.$('#previewVisual').innerHTML,/正在载入原件/);h.api.hide();assert.equal(signal.aborted,true);fail?wait.reject(new Error('offline')):wait.resolve(new Blob(['image'],{type:'image/png'}));await pending;assert.equal(h.$('#previewDialog').hidden,true);assert.equal(h.api.snapshot().visible,false);assert.equal(h.$('#previewVisual').innerHTML,'');assert.equal(h.context.state.previewRecord,null);assert.equal(h.$('#previewDownload').hidden,true);assert.equal(h.$('#previewDownload').href,undefined);assert.deepEqual(h.revoked,[]);}
});
test('switch and repeated hide release each old URL once; reopening renders a fresh visible section',async()=>{
  const h=harness({real:true});await h.open('note','n');const first=h.$('#previewDownload').href;await h.open('import','b');assert.deepEqual(h.revoked,[first]);const second=h.$('#previewDownload').href;h.api.hide();h.api.hide();assert.deepEqual(h.revoked,[first,second]);await h.open('note','n');assert.equal(h.api.snapshot().visible,true);assert.equal(h.$('#previewDialog').hidden,false);assert.notEqual(h.$('#previewDownload').href,first);
});
test('task source opening removes the modal, carries return context across tabs, and retains unsaved task fields',async()=>{
  const h=harness({real:true});h.add('taskTitleInput','input').value='尚未保存的修改';h.$('#taskDialog').open=true;await h.open('import','a');assert.equal(h.$('#taskDialog').open,false);assert.equal(h.state.previewReturnTaskId,'t');await h.open('note','n');assert.equal(h.state.previewReturnTaskId,'t');
  const handler=source.slice(source.indexOf("$('#previewBack').onclick ="),source.indexOf("$('#previewOrganize').onclick ="));vm.runInContext(handler,h.context);await h.$('#previewBack').onclick();assert.equal(h.$('#taskDialog').open,true);assert.equal(h.$('#taskTitleInput').value,'尚未保存的修改');assert.equal(h.calls.filter(x=>x[0]==='render-task').length,1);
});
test('returning to a task rebinds checklist callbacks to the current object after lifecycle replaces it, preserving draft fields',async()=>{
  const h=harness({real:true});const fields=['taskTitleInput','taskDescriptionInput','taskStatusInput','taskPriorityInput','taskDueInput','taskTimeInput','taskProjectInput','newChecklistItem'];for(const id of fields)h.add(id,'input').value=`draft-${id}`;
  const old=h.state.tasks[0];old.checklist=[{text:'材料',done:false}];h.$('#taskDialog').open=true;await h.open('note','n');h.state.tasks=JSON.parse(JSON.stringify(h.state.tasks));
  let checkbox;h.context.renderTaskDialog=task=>{for(const id of fields)h.$(`#${id}`).value='renderer reset';checkbox=()=>task.checklist[0].done=true;};
  vm.runInContext(source.slice(source.indexOf("$('#previewBack').onclick ="),source.indexOf("$('#previewOrganize').onclick =")),h.context);await h.$('#previewBack').onclick();checkbox();
  assert.equal(h.state.tasks[0].checklist[0].done,true);assert.equal(old.checklist[0].done,false);for(const id of fields)assert.equal(h.$(`#${id}`).value,`draft-${id}`);
});
test('deleted or archived sources cannot start preview, and archive during read invalidates the pending result',async()=>{
  const wait=deferred();let signal;const h=harness({real:true,getBlob:(id,options)=>{assert.equal(id,'b');signal=options.signal;return wait.promise;}});const pending=h.open('import','b');assert.equal(signal.aborted,false);h.state.projects[0].archived=true;h.api.reconcile();assert.equal(signal.aborted,true);wait.resolve(new Blob(['image'],{type:'image/png'}));await pending;assert.equal(h.api.snapshot().tabs.length,0);assert.equal(h.$('#previewDialog').hidden,true);assert.equal(h.$('#previewDownload').href,undefined);await h.open('note','n');assert.equal(h.$('#previewDialog').hidden,true);assert.match(h.calls.at(-1)[1],/归档/);
});
test('actual reader uses user-facing metadata and folds source links instead of filling PDF header',async()=>{
  const h=harness({real:true});h.state.imports[0].parser='local';await h.open('import','a');assert.match(h.$('#previewMeta').textContent,/PDF 文档/);assert.doesNotMatch(h.$('#previewMeta').textContent,/local/);assert.equal(h.$('#previewRelatedSources').open,false);assert.equal(h.$('#previewExtracted').open,false);assert.match(h.$('#previewExtracted').querySelector('summary').textContent,/可搜索文字/);
});
test('actual source reader marks only fixed headings, relationship counts and page labels for translation',async()=>{
  const h=harness({real:true,getBlob:()=>null});h.state.projects[0].name='所属项目';h.state.notes[0].title='分析笔记';h.state.imports[0].name='资料库.pptx';h.state.imports[0].mimeType='application/vnd.openxmlformats-officedocument.presentationml.presentation';h.state.imports[0].pages=[{page:1,text:'关联资料：这是用户原文'}];
  const original=JSON.stringify(h.state.imports[0]);await h.open('import','a');
  assert.equal(h.$('#previewEyebrow').getAttribute('data-i18n'),'');
  assert.match(h.$('#previewRelatedSources').querySelector('summary').innerHTML,/<span data-i18n>关联资料<\/span>/);
  assert.match(h.$('#previewRelatedSources').querySelector('summary').innerHTML,/<span data-i18n>1 篇笔记<\/span>/);
  assert.match(h.$('#previewRelations').innerHTML,/<span data-user-content>所属项目<\/span>/);
  assert.match(h.$('#previewRelations').innerHTML,/<span data-user-content>分析笔记<\/span>/);
  assert.match(h.$('#previewVisual').innerHTML,/<b data-i18n>第 1 页<\/b><p data-user-content>关联资料：这是用户原文<\/p>/);
  assert.equal(h.$('#previewTitle').textContent,'资料库.pptx');assert.equal(JSON.stringify(h.state.imports[0]),original);
});
test('persistent tabs label their actual owning workspace and project independently of navigation, including unassigned sources',async()=>{
  const h=harness({real:true});h.state.projects[0].name='同名项目';h.state.projects[0].workspace='课程';h.state.projects.push({id:'research',name:'同名项目',workspace:'科研'});h.state.currentProjectId='research';h.state.imports[0].workspace='科研';await h.open('import','a');assert.match(h.$('#previewMeta').textContent,/课程 › 同名项目/);assert.doesNotMatch(h.$('#previewMeta').textContent,/科研/);
  h.state.imports[1].projectId=null;h.state.imports[1].workspace='日常';await h.open('import','b');assert.match(h.$('#previewMeta').textContent,/日常 › 未归属项目/);
});
test('dirty document guard can cancel active close or hide without removing tabs or suspending the editor',async()=>{
  let wait=deferred();const h=harness({beforeLeave:()=>wait.promise});h.open('note','n');h.open('import','a');
  const closing=h.api.close();assert.equal(h.api.snapshot().tabs.length,2);assert.equal(h.calls.length,0);
  wait.resolve(false);await closing;assert.equal(h.api.isActive('import','a'),true);assert.equal(h.api.snapshot().tabs.length,2);
  wait=deferred();const hiding=h.api.hide();wait.resolve(false);await hiding;assert.equal(h.api.snapshot().visible,true);assert.equal(h.$('#previewDialog').hidden,false);assert.equal(h.calls.length,0);
  wait=deferred();const approved=h.api.hide();wait.resolve(true);await approved;assert.equal(h.api.snapshot().visible,false);assert.ok(h.calls.some(x=>x[0]==='suspend'));
});
test('only latest guarded navigation wins and deleted target cannot be reopened after save completes',async()=>{
  const wait=deferred();const h=harness({beforeLeave:()=>wait.promise});h.open('import','a');h.open('import','b');h.open('note','n');
  const controls=h.$('#readingTabs').querySelectorAll('[role="tab"]');controls[0].onclick();controls[1].onclick();wait.resolve(true);await Promise.resolve();await Promise.resolve();
  assert.equal(h.api.isActive('import','b'),true);assert.deepEqual(h.calls.filter(x=>x[0]==='select'),[['select','import','b',1]]);
  const next=deferred();const h2=harness({beforeLeave:()=>next.promise});h2.open('import','a');h2.open('note','n');h2.$('#readingTabs').querySelectorAll('[role="tab"]')[0].onclick();h2.state.imports=[];next.resolve(true);await Promise.resolve();await Promise.resolve();
  assert.equal(h2.api.isActive('note','n'),true);assert.equal(h2.calls.some(x=>x[0]==='select'&&x[2]==='a'),false);
});
test('a delayed document leave cannot reopen over a newer settings route or invalidate the retained reader',async()=>{
  const h=harness({real:true});await h.open('note','n');h.api.setExpanded(true);
  const gate=deferred();let unmounted=0;
  h.context.window.NoteEditor={suspendInline:()=>gate.promise,unmountInline(){unmounted++;}};
  h.context.showView=()=>{};h.context.showView.navigationVersion=0;
  const requestVersion=vm.runInContext('previewRequestVersion',h.context),opening=h.open('import','a');
  assert.equal(vm.runInContext('previewRequestVersion',h.context),requestVersion,'waiting for leave does not invalidate the mounted document');
  h.context.showView.navigationVersion++;h.document.body.dataset.view='settings';h.api.revealWorkspace({force:true});
  gate.resolve(true);assert.equal(await opening,false);
  assert.equal(h.document.body.dataset.view,'settings');assert.equal(h.api.snapshot().visible,false);assert.equal(h.api.snapshot().retained,true);
  assert.equal(h.state.previewRecord.id,'n');assert.equal(h.api.isActive('note','n'),true);assert.equal(unmounted,0);
  assert.equal(vm.runInContext('previewRequestVersion',h.context),requestVersion);
  assert.equal(h.$('#previewTitle').textContent,'研究笔记');assert.equal(h.calls.some(call=>call[0]==='pdf'),false);
});
test('two direct document requests waiting on leave allow only the newest target to mount',async()=>{
  const h=harness({real:true});await h.open('note','n');const first=deferred(),second=deferred();let leaves=0;
  h.context.window.NoteEditor={suspendInline:()=>++leaves===1?first.promise:second.promise,unmountInline(){}};
  const earlier=h.open('import','a'),later=h.open('import','b');
  second.resolve(true);await later;assert.equal(h.state.previewRecord.id,'b');assert.equal(h.api.isActive('import','b'),true);
  const version=vm.runInContext('previewRequestVersion',h.context);
  first.resolve(true);assert.equal(await earlier,false);assert.equal(h.state.previewRecord.id,'b');assert.equal(h.api.isActive('import','b'),true);
  assert.equal(vm.runInContext('previewRequestVersion',h.context),version);assert.equal(h.calls.some(call=>call[0]==='pdf'),false);
});
test('source access guards change only after an approved current document intent and are rechecked after waiting',async()=>{
  for(const canceled of ['route','access','decision']){
    const h=harness({real:true});await h.open('note','n');const gate=deferred();let available=true;
    h.context.window.NoteEditor={suspendInline:()=>gate.promise,unmountInline(){}};
    h.context.window.CitationEvidence={access:()=>({available})};h.context.showView=()=>{};
    const opening=h.context.openPreview('import','a',1,{type:'import',id:'a'});
    assert.equal(vm.runInContext('sourcePreviewGuards.size',h.context),0,'a pending intent must not change current access guards');
    if(canceled==='route')h.context.showView.navigationVersion=1;
    if(canceled==='access')available=false;
    gate.resolve(canceled!=='decision');await opening;
    assert.equal(vm.runInContext('sourcePreviewGuards.size',h.context),0);assert.equal(h.state.previewRecord.id,'n');
  }
});
test('saving a retained note preserves and persists its source scope, including privacy and archive revalidation',async()=>{
  for(const revoke of [conversation=>{conversation.private=true;},conversation=>{conversation.archived=true;}]){
    const h=harness({real:true});
    h.state.conversations=[{id:'c',messages:[{role:'user',fileReferences:[{type:'note',id:'n'}]}]}];h.state.agentRuns=[];h.state.ui={};
    h.context.window.CitationEvidence=require('../app/citation-evidence');h.context.window.DocumentFiles=require('../app/document-files');
    const sourceGuard={type:'note',id:'n',conversationId:'c',documentScope:{scope:'conversation',conversationId:'c',projectId:null,localDirectory:false}};
    await h.context.openPreview('note','n',undefined,sourceGuard);
    // NoteEditor.onSaved and analysis refresh both call the real openNote path.
    await h.context.openNote('n');
    const retained=JSON.parse(JSON.stringify(h.context.documentTabSource({kind:'note',id:'n'})));
    assert.deepEqual(retained,sourceGuard);
    h.context.storageHydrated=true;h.context.save=()=>{};h.context.saveDocumentWorkspace(h.api.snapshot());
    assert.deepEqual(JSON.parse(JSON.stringify(h.state.ui.documentWorkspace.tabs[0].source)),sourceGuard);
    revoke(h.state.conversations[0]);
    assert.equal(await h.context.openNote('n'),false);assert.equal(h.context.previewItem('note','n'),null);
    const restored=harness({real:true});restored.state.conversations=h.state.conversations;restored.state.agentRuns=[];restored.state.ui=h.state.ui;
    restored.context.window.CitationEvidence=require('../app/citation-evidence');restored.context.window.DocumentFiles=require('../app/document-files');
    await restored.context.restoreDocumentWorkspace();
    assert.equal(restored.api.snapshot().tabs.length,0,'restoring a refreshed tab must not revive revoked source access');
  }
});
test('explicit document entries replace retained source context without inheriting another document or type',async()=>{
  const h=harness({real:true});h.state.agentRuns=[];h.state.conversations=[{id:'old'},{id:'new'}];
  h.context.window.CitationEvidence=require('../app/citation-evidence');
  const original={type:'note',id:'n',conversationId:'old'},replacement={type:'note',id:'n',conversationId:'new'};
  await h.context.openPreview('note','n',undefined,original);
  h.state.notes.push({id:'other',projectId:'p',title:'Other',content:'different note'});
  await h.context.openNote('other');assert.equal(h.context.documentTabSource({kind:'note',id:'other'}),null);
  h.state.imports.push({id:'n',projectId:'p',name:'Same ID.pdf',mimeType:'application/pdf'});
  await h.context.openImport('n');assert.equal(h.context.documentTabSource({kind:'import',id:'n'}),null);
  await h.context.openPreview('note','n',undefined,replacement);
  assert.equal(h.context.documentTabSource({kind:'note',id:'n'}).conversationId,'new');
  h.state.conversations[0].private=true;assert.ok(h.context.previewItem('note','n'));
  assert.equal(await h.context.openPreview('note','n',undefined,original),false);
  assert.equal(h.context.documentTabSource({kind:'note',id:'n'}).conversationId,'new','denied replacement must keep the current context');
  h.state.conversations[1].private=true;assert.equal(h.context.previewItem('note','n'),null);
});
test('direct and restored document entries respect durable private origins after the session is purged',async()=>{
  for (const [kind,id] of [['note','n'],['import','a']]) {
    const h=harness({real:true});h.state.conversations=[];h.state.agentRuns=[];
    h.context.window.CitationEvidence=require('../app/citation-evidence');
    const record=(kind==='note'?h.state.notes:h.state.imports).find(item=>item.id===id);
    record.provenance={version:1,output:{type:kind,id,variant:'body'},origin:{recorded:true,private:true,conversationId:'purged-chat',runId:'purged-run'}};
    assert.equal(h.context.previewItem(kind,id),null);
    await h.open(kind,id);
    assert.equal(h.state.previewRecord,null);
    h.api.restoreSession({version:1,tabs:[{kind,id,title:record.title||record.name}],activeKey:JSON.stringify([kind,id])});
    assert.equal(h.api.snapshot().tabs.length,0);
    assert.equal(h.state.previewRecord,null);
    assert.equal(h.$('#previewTitle').textContent,'');
    // Removing a public origin is not a deletion of its saved project document.
    record.provenance.origin.private=false;
    assert.ok(h.context.previewItem(kind,id));
    assert.notEqual(await h.open(kind,id),false);
  }
});
test('an inherited source guard is rechecked after waiting to reopen an inactive tab',async()=>{
  const h=harness({real:true});h.state.conversations=[{id:'c'}];h.state.agentRuns=[];
  h.context.window.CitationEvidence=require('../app/citation-evidence');
  await h.context.openPreview('note','n',undefined,{type:'note',id:'n',conversationId:'c'});
  await h.open('import','a');const gate=deferred();
  h.context.window.NoteEditor={inlineActive:()=>false,suspendInline:()=>gate.promise,unmountInline(){}};
  const reopening=h.context.openNote('n');h.state.conversations[0].private=true;gate.resolve(true);
  assert.equal(await reopening,false);assert.equal(h.state.previewRecord.id,'a');
  assert.equal(h.context.documentTabSource({kind:'note',id:'n'}).conversationId,'c');
});
test('a newer workspace route cancels delayed close, hide and tab selection even when split reading stays visible',async()=>{
  for(const expanded of [false,true])for(const action of ['close','hide','select']){
    const gate=deferred(),h=harness({beforeLeave:()=>gate.promise});h.open('import','a');h.open('import','b');h.api.setExpanded(expanded);
    const pending=action==='select'?h.$('#readingTabs').querySelectorAll('[role="tab"]')[0].onclick():h.api[action]();
    h.api.revealWorkspace();gate.resolve(true);await pending;
    assert.equal(h.api.isActive('import','b'),true,`${action} must not replace the reader after navigation`);
    assert.equal(h.api.snapshot().visible,!expanded);assert.equal(h.api.snapshot().retained,expanded);
    assert.equal(h.api.snapshot().tabs.length,2);assert.deepEqual(h.calls,[]);
  }
});
test('both explicit reader close buttons respect denied and asynchronous dirty guards without early cleanup',async()=>{
  for(const button of ['#previewHeaderClose','#previewFooterClose']){
    let decision=true;const h=harness({real:true,beforeLeave:()=>decision});await h.open('note','n');
    const url=h.$('#previewDownload').href,body=h.$('#previewContent').innerHTML,title=h.$('#previewTitle').textContent;
    let destroys=0,aborts=0;h.context.pdfPreviewAbort={abort(){aborts++;}};h.context.testReaderHandle={destroy(){destroys++;}};vm.runInContext('pdfReaderHandle=testReaderHandle',h.context);
    const intact=()=>{assert.equal(h.$('#previewDialog').hidden,false);assert.equal(h.$('#readingPane').hidden,false);assert.equal(h.api.snapshot().visible,true);assert.equal(h.state.previewRecord.id,'n');assert.equal(h.$('#previewDownload').href,url);assert.equal(h.$('#previewContent').innerHTML,body);assert.equal(h.$('#previewTitle').textContent,title);assert.deepEqual(h.revoked,[]);assert.equal(aborts,0);assert.equal(destroys,0);};
    decision=false;h.$(button).click();intact();
    const denied=deferred();decision=denied.promise;h.$(button).click();intact();denied.resolve(false);await Promise.resolve();await Promise.resolve();intact();
    const approved=deferred();decision=approved.promise;h.$(button).click();intact();approved.resolve(true);await Promise.resolve();await Promise.resolve();
    assert.equal(h.$('#previewDialog').hidden,true);assert.equal(h.$('#readingPane').hidden,true);assert.equal(h.state.previewRecord,null);assert.equal(h.$('#previewContent').textContent,'');assert.equal(h.$('#previewDownload').hidden,true);assert.equal(h.$('#previewDownload').href,undefined);assert.deepEqual(h.revoked,[url]);assert.equal(aborts,1);assert.equal(destroys,1);
    h.$(button).click();assert.deepEqual(h.revoked,[url]);assert.equal(aborts,1);assert.equal(destroys,1);
  }
});
test('closing or reconciling the final tab suspends reader resources exactly once',async()=>{
  for(const method of ['close','reconcile']){const h=harness();h.open('note','n');if(method==='reconcile')h.state.notes=[];await h.api[method]();assert.equal(h.api.snapshot().visible,false);assert.equal(h.api.snapshot().tabs.length,0);assert.deepEqual(h.calls,[['suspend']]);}
});
test('return-to-task waits for the dirty reader guard and never opens a task after refusal',async()=>{
  let decision=true;const h=harness({real:true,beforeLeave:()=>decision});h.$('#taskDialog').showModal();await h.open('note','n');
  vm.runInContext(source.slice(source.indexOf("$('#previewBack').onclick ="),source.indexOf("$('#previewOrganize').onclick =")),h.context);
  const url=h.$('#previewDownload').href;let wait=deferred();decision=wait.promise;const refused=h.$('#previewBack').onclick();
  assert.equal(h.$('#taskDialog').open,false);assert.equal(h.$('#previewDialog').hidden,false);assert.deepEqual(h.revoked,[]);wait.resolve(false);await refused;
  assert.equal(h.$('#taskDialog').open,false);assert.equal(h.$('#previewDialog').hidden,false);assert.deepEqual(h.revoked,[]);assert.equal(h.calls.filter(x=>x[0]==='render-task').length,0);
  wait=deferred();decision=wait.promise;const approved=h.$('#previewBack').onclick();assert.equal(h.$('#taskDialog').open,false);wait.resolve(true);await approved;
  assert.equal(h.$('#taskDialog').open,true);assert.equal(h.$('#previewDialog').hidden,true);assert.deepEqual(h.revoked,[url]);assert.equal(h.calls.filter(x=>x[0]==='render-task').length,1);
});
test('cloud reconciliation waits for visible or retained document sessions, including the no-controller fallback',()=>{
  const h=harness();const context=vm.createContext({window:{ReadingPane:h.api},state:{},serverSaveInFlight:false,serverConflict:false,importMaterials:{},storageHydrated:true,approvalBusy:()=>false,stageAnswerFeedbackDraft:{},commitConversationOrganization:{},commitConversationPath:{},draftSaveTimer:null,sendMessage:{},purgeTrash:{},contentDeletePending:false,$:h.$,document:{activeElement:null,querySelector:selector=>selector==='#previewDialog:not([hidden])'&&!h.$('#previewDialog').hidden?h.$('#previewDialog'):null}});
  vm.runInContext(source.slice(source.indexOf('function cloudHostBusy()'),source.indexOf('\nfunction adoptCloudSnapshot(')),context);
  assert.equal(context.cloudHostBusy(),false);h.open('note','n');assert.equal(context.cloudHostBusy(),true);
  assert.equal(context.cloudConnectionBusy(),false,'reading a document does not prevent opening a connection');
  h.api.revealWorkspace({force:true});assert.equal(h.$('#previewDialog').hidden,true);assert.equal(context.cloudHostBusy(),true,'a parked draft must not be replaced by an adopted cloud snapshot');
  assert.equal(context.cloudConnectionBusy(),false,'retained document sessions are protected by the durable flush at submit');
  h.api.hide();assert.equal(context.cloudHostBusy(),false);
  delete context.window.ReadingPane;h.$('#previewDialog').hidden=false;assert.equal(context.cloudHostBusy(),true);h.$('#previewDialog').hidden=true;assert.equal(context.cloudHostBusy(),false);
});

test('reader visibility refreshes geometry even when no animation frame can run',()=>{
 let h;const observed=[];h=harness({WorkspaceLayout:{refresh(){if(h)observed.push(h.document.body.classList.contains('reading-open'));}}});
 h.open('note','n');assert.equal(observed.at(-1),true);
 h.api.hide();assert.equal(observed.at(-1),false);h.api.reopen();assert.equal(observed.at(-1),true);
});

test('document bookmarks persist safe identity and geometry, never body/title or private records', () => {
  const saves=[];
  const h=harness({hooks:{saveSession:value=>saves.push(value),canPersist:(_kind,id)=>id!=='b',captureView:()=>({mode:'edit',scrollTop:143,editorScrollTop:87,content:'secret body',title:'secret title',selection:{start:2,end:9,value:'secret body'}})}});
  h.open('note','n');h.api.remember();h.open('import','b');h.api.remember();
  const saved=h.api.sessionMetadata();assert.deepEqual(saved.tabs.map(x=>x.id),['n']);assert.equal(saved.activeKey,null);
  assert.equal(saved.tabs[0].bookmark.mode,'edit');assert.equal(saved.tabs[0].bookmark.selection.start,2);
  assert.doesNotMatch(JSON.stringify(saved),/secret|研究笔记|图片/);assert.ok(saves.length>=4);
  h.state.notes[0].archived=true;assert.equal(h.api.sessionMetadata().tabs.length,0);
});

test('cold tab restoration resolves current titles/access, deduplicates identity and activates only when requested', async () => {
  const saved={version:1,tabs:[{kind:'note',id:'n',title:'stale',page:3,bookmark:{mode:'rich',scrollTop:203,content:'not allowed'}},{kind:'note',id:'n'},{kind:'import',id:'missing'},{kind:'script',id:'n'},{kind:'import',id:'b'},{kind:'import',id:'a',page:7}],activeKey:JSON.stringify(['import','a']),expanded:true,visible:true};
  const h=harness({hooks:{canPersist:(_kind,id)=>id!=='b'}});
  assert.equal(h.api.restoreSession(saved),true);assert.equal(h.api.snapshot().visible,false);
  assert.deepEqual(h.api.snapshot().tabs.map(x=>x.id),['n','a']);assert.equal(h.api.snapshot().tabs[0].title,'研究笔记');
  assert.deepEqual(h.api.bookmark('note','n'),{mode:'rich',scrollTop:203});assert.equal(h.calls.length,0);
  h.api.reopen();assert.equal(h.api.isActive('import','a'),true);assert.equal(h.api.snapshot().expanded,true);
  assert.deepEqual(h.calls.at(-1),['select','import','a',7]);
});

test('ordinary tab switching flushes drafts while explicit close still invokes the formal leave guard',async()=>{
  let switches=0,leaves=0,position={mode:'edit',selection:{start:3,end:5},scrollTop:91};const gate=deferred();
  const h=harness({beforeLeave:()=>{leaves++;return false;},hooks:{beforeSwitch:()=>{switches++;return gate.promise;},captureView:()=>position}});
  h.open('note','n');h.open('import','a');const selecting=h.$('#readingTabs').querySelectorAll('[role="tab"]')[0].onclick();
  assert.equal(switches,1);assert.equal(leaves,0);assert.equal(h.api.isActive('import','a'),true);
  gate.resolve(true);await selecting;assert.equal(h.api.isActive('note','n'),true);assert.equal(h.api.bookmark('import','a').scrollTop,91);
  await h.api.close();assert.equal(leaves,1);assert.equal(h.api.isActive('note','n'),true);
});

test('direct opening and tab switches share one asynchronous navigation authority',async()=>{
  const wait=deferred();let options;const h=harness({hooks:{beforeSwitch:()=>wait.promise,onSelect:(_kind,_id,_page,value)=>{options=value;return true;}}});
  h.open('note','n');h.open('import','a');const selecting=h.$('#readingTabs').querySelectorAll('[role="tab"]')[0].onclick();
  h.api.beforeNavigate('import','a');wait.resolve(true);assert.equal(await selecting,false);assert.equal(options,undefined);
  h.$('#readingTabs').querySelectorAll('[role="tab"]')[1].onclick();assert.equal(options.navigationApproved,true);assert.equal(options.isCurrent(),true);
  h.api.revealWorkspace({force:true});assert.equal(options.isCurrent(),false);
});

test('inactive dirty tab close restores its own document and obeys its close decision',async()=>{
  const calls=[];let h;
  h=harness({beforeLeave:()=>{calls.push(['leave',h.api.snapshot().activeKey]);return false;},hooks:{beforeSwitch:()=>true,isDirty:(_kind,id)=>id==='n'}});
  h.open('note','n');h.open('import','a');await h.api.close(JSON.stringify(['note','n']));
  assert.equal(h.api.isActive('note','n'),true);assert.equal(h.api.snapshot().tabs.length,2);
  assert.deepEqual(calls,[['leave',JSON.stringify(['note','n'])]]);
});

test('cold inactive draft hints restore the document before closing instead of silently closing an unloaded draft', async()=>{
  let leaves=0;const h=harness({beforeLeave:()=>{leaves++;return false;},hooks:{isDirty:()=>false,beforeSwitch:()=>true}});
  h.api.restoreSession({version:1,tabs:[{kind:'note',id:'n',draftPending:true},{kind:'import',id:'a'}],activeKey:JSON.stringify(['import','a'])});
  h.api.reopen();await h.api.close(JSON.stringify(['note','n']));
  assert.equal(leaves,1);assert.equal(h.api.isActive('note','n'),true);assert.equal(h.api.snapshot().tabs.length,2);
});

test('late editor refusal preserves active tab and pane during explicit hide and close',async()=>{
 const h=dom(),item={id:'x',title:'Late input'},api=Reading.createController({getItem:()=>item,beforeLeave:()=>true,onSuspend:()=>false,onSelect:()=>true},{document:h.document,matchMedia:()=>({matches:false})});
 api.present('note','x');assert.equal(await api.hide(),false);assert.equal(api.snapshot().visible,true);
 assert.equal(await api.close(),false);assert.equal(api.snapshot().tabs.length,1);assert.equal(api.snapshot().activeKey,JSON.stringify(['note','x']));
});

test('restored file provenance rechecks all aggregated sources and only persists identity metadata',()=>{
 const h=harness({real:true});h.context.window.CitationEvidence={access:()=>({available:true,kind:'available'})};
 let denied=false;h.context.window.DocumentFiles={build:()=>({items:[{kind:'note',id:'n',available:!denied,status:denied?'private':'available'}]})};
 const source={type:'note',id:'n',conversationId:'c',documentScope:{scope:'conversation',conversationId:'c',projectId:'p',localDirectory:false},excerpt:'never persist body'};
 assert.equal(h.context.previewSourceAvailable(source),true);denied=true;assert.equal(h.context.previewSourceAvailable(source),false);
 h.context.__guard=source;vm.runInContext('sourcePreviewGuards.set(JSON.stringify(["note","n"]),__guard)',h.context);
 const safe=h.context.documentTabSource({kind:'note',id:'n'});assert.equal(safe.excerpt,undefined);assert.equal(safe.documentScope.conversationId,'c');
});

test('saving clears the current dirty tab indicator and persisted draft flag',()=>{
 const h=dom();let dirty=true;const api=Reading.createController({getItem:()=>({id:'x',title:'Document'}),isDirty:()=>dirty,onSelect:()=>true},{document:h.document,matchMedia:()=>({matches:false})});
 api.present('note','x');api.remember();assert.equal(api.sessionMetadata().tabs[0].draftPending,true);dirty=false;api.refreshTabs();assert.equal(api.sessionMetadata().tabs[0].draftPending,undefined);assert.equal(h.$('[role="tab"]').getAttribute('aria-label'),'Document');
});

test('each tab origin survives a metadata roundtrip without title, body or transient anchor',()=>{
 const h=harness();h.api.present('note','n',1,{origin:{view:'project',projectId:'p',section:'outputs',title:'private title',anchor:{text:'private body'}}});h.api.present('import','a',4,{origin:{view:'agent',conversationId:'c',messageId:'m'}});
 const saved=h.api.sessionMetadata();assert.deepEqual(saved.tabs.map(tab=>tab.origin),[{view:'project',projectId:'p',section:'outputs'},{view:'agent',conversationId:'c',messageId:'m'}]);assert.doesNotMatch(JSON.stringify(saved),/private title|private body|anchor/);
 const restored=harness();assert.equal(restored.api.restoreSession(saved),true);assert.deepEqual(restored.api.sessionMetadata().tabs.map(tab=>tab.origin),saved.tabs.map(tab=>tab.origin));
 restored.api.present('note','n');assert.deepEqual(restored.api.snapshot().tabs[0].origin,saved.tabs[0].origin,'An internal refresh without an explicit origin retains it');
 restored.api.present('note','n',undefined,{origin:{view:'overview'}});assert.deepEqual(restored.api.snapshot().tabs[0].origin,{view:'overview'},'An explicit external entry replaces only that tab origin');assert.deepEqual(restored.api.snapshot().tabs[1].origin,saved.tabs[1].origin);
});

test('document chat action is opt-in, supports only described tabs, and rechecks live disabled state before dispatch',async()=>{
  const without=harness();without.open('note','n');assert.equal(without.$('.reading-chat-action').hidden,true);
  let disabled=false,count=0;
  const h=harness({hooks:{getItem:(_kind,id)=>({id,title:id}),chatAction:tab=>['note','import','local-file'].includes(tab.kind)?{label:'引用到对话',disabled}:null,onChat:()=>{count++;}}});
  for(const kind of ['note','import','local-file']){h.open(kind,'x');assert.equal(h.$('.reading-chat-action').hidden,false);}
  for(const kind of ['review','local-review']){h.open(kind,'x');assert.equal(h.$('.reading-chat-action').hidden,true);await h.$('#readingChat').onclick();}
  assert.equal(count,0);h.open('note','n');disabled=true;
  await h.$('#readingChat').onclick();assert.equal(count,0,'a changed target state is checked even before a repaint');
  h.api.reconcile();assert.equal(h.$('#readingChat').disabled,true);
  disabled=false;h.api.reconcile();assert.equal(h.$('#readingChat').disabled,false);
  h.api.revealWorkspace({force:true});await h.$('#readingChat').onclick();assert.equal(count,0,'a parked reader cannot dispatch its hidden action');
});

test('chat toolbar captures the current document bookmark before dispatch and gives the hook the real button anchor',async()=>{
  const saved=[],received=[];let selection=22;
  const h=harness({hooks:{chatAction:()=>({label:'引用到对话'}),captureView:()=>({mode:'edit',scrollTop:901,selection:{start:selection,end:selection+4},content:'never hand over the body'}),isDirty:()=>true,
    saveSession:value=>saved.push(value),onChat:(tab,options)=>{received.push({tab,options,persisted:saved.at(-1)});tab.bookmark.selection.start=0;return true;}}});
  h.api.present('note','n',1,{origin:{view:'project',projectId:'p',section:'outputs'}});
  h.api.present('import','a',7);selection=42;const anchor=h.$('#readingChat'),event={currentTarget:anchor};
  const content=h.add('editor-retained-for-chat','article',h.$('#previewContent'));
  assert.equal(await anchor.onclick(event),true);assert.equal(received.length,1);
  const result=received[0];assert.equal(result.tab.kind,'import');assert.equal(result.tab.id,'a');assert.equal(result.tab.page,7);
  assert.equal(result.options.anchor,anchor);assert.equal(result.options.event,event);assert.equal(result.options.isCurrent(),true);
  assert.equal(result.persisted.tabs.find(tab=>tab.id==='a').bookmark.selection.start,42);
  assert.equal(h.api.bookmark('import','a').selection.start,42,'delegated snapshot cannot mutate retained metadata');
  assert.doesNotMatch(JSON.stringify(result.tab),/never hand over|content/);
  assert.equal(result.tab.draftPending,true);assert.equal(h.$('#editor-retained-for-chat'),content);assert.deepEqual(h.calls,[]);
});

test('chat action mounts one Kit Button and updates labels and availability without replacing the focused node',()=>{
  let h,label='引用到对话',disabled=false;const mounts=[];
  const kit={mount(host,name,initial){
    const control=h.document.createElement('button');host.append(control);mounts.push({host,name,control});
    const update=props=>{control.id=props.id;control.textContent=props.children;control.title=props.title;control.disabled=!!(props.disabled||props.loading);control.onclick=props.onClick;control.setAttribute('aria-label',props['aria-label']);};
    update(initial);return {update};
  }};
  h=harness({HalaskaUI:kit,hooks:{chatAction:()=>({label,title:'引用已保存的版本',disabled}),onChat:()=>true}});
  h.open('note','n');const control=h.$('#readingChat');control.focus();
  label='Reference in chat';disabled=true;h.api.reconcile();
  assert.equal(h.$('#readingChat'),control);assert.equal(h.document.activeElement,control);assert.equal(control.textContent,label);assert.equal(control.disabled,true);assert.equal(control.title,'引用已保存的版本');
  disabled=false;h.api.refreshTabs();assert.equal(h.$('#readingChat'),control);assert.equal(control.disabled,false);assert.equal(h.document.activeElement,control);
  const own=mounts.filter(item=>item.host.className==='reading-chat-action');assert.equal(own.length,1);assert.equal(own[0].name,'Button');
});

test('a synchronous document chat hook opens the real menu with an enabled anchor and retains menu focus',async()=>{
  let menu,hookCalls=0;
  const h=harness({hooks:{chatAction:()=>({label:'引用到对话'}),onChat:(_tab,{anchor})=>{
    hookCalls++;assert.equal(anchor.disabled,false,'menu handoff must precede the toolbar busy paint');
    return menu.open({anchor,label:'引用到对话',items:[{id:'current',label:'当前对话',onSelect:()=>true}]});
  }}});
  const doc=h.document,create=doc.createElement;
  doc.createElement=tag=>{const node=create(tag);node.remove=()=>{if(node.parent)node.parent.children=node.parent.children.filter(child=>child!==node);};return node;};
  doc.documentElement={classList:{contains:()=>false}};
  doc.addEventListener=()=>{};doc.removeEventListener=()=>{};
  const context=vm.createContext({document:doc,innerWidth:900,innerHeight:700,
    addEventListener(){},removeEventListener(){},requestAnimationFrame:()=>1,cancelAnimationFrame(){},matchMedia:()=>({matches:false}),
    MutationObserver:class{observe(){}disconnect(){}},
    HalaskaUI:{componentNames:['BenchoAddMenu'],mount(host,name){
      assert.equal(name,'BenchoAddMenu');const panel=doc.createElement('div');panel.setAttribute('role','menu');host.append(panel);
      return {update(){},unmount(){host.replaceChildren();}};
    }}
  });
  vm.runInContext(fs.readFileSync(require.resolve('../app/composer-add-menu'),'utf8'),context);menu=context.ComposerAddMenu;
  h.open('note','n');const anchor=h.$('#readingChat');anchor.isConnected=true;
  anchor.getBoundingClientRect=()=>({left:600,top:30,right:690,bottom:58,width:90,height:28});anchor.getClientRects=()=>[anchor.getBoundingClientRect()];anchor.focus();
  try{
    assert.equal(await anchor.onclick({currentTarget:anchor}),true);assert.equal(hookCalls,1);assert.equal(menu.isOpen(),true);
    assert.equal(anchor.disabled,false);assert.equal(anchor.getAttribute('aria-expanded'),'true');
    const focused=doc.activeElement;assert.equal(focused.getAttribute('role'),'menu');assert.equal(h.$('#composerAddMenu').contains(focused),true);
    h.api.reconcile();assert.equal(doc.activeElement,focused,'toolbar refresh must not reclaim focus from the open menu');
  }finally{menu.close();}
  assert.equal(menu.isOpen(),false);assert.equal(doc.activeElement,anchor);
});

test('a pending document chat handoff cannot duplicate or claim a newer document and failures preserve the reader',async()=>{
  const gate=deferred(),errors=[];let called=0,current;
  const h=harness({hooks:{chatAction:()=>({label:'引用到对话'}),onChat:async(_tab,options)=>{called++;current=options.isCurrent;await gate.promise;throw Error('reference was not saved');},onError:error=>errors.push(error.message)}});
  h.open('note','n');h.api.setExpanded(true);const content=h.add('draft-retained','article',h.$('#previewContent'));
  const action=h.$('#readingChat'),pending=action.onclick({currentTarget:action});
  assert.equal(action.disabled,true);assert.equal(await action.onclick(),false);assert.equal(called,1);assert.equal(current(),true);
  await h.api.beforeNavigate('import','a');h.open('import','a',4);assert.equal(current(),false);
  gate.resolve();assert.equal(await pending,false);assert.deepEqual(errors,['reference was not saved']);
  assert.equal(h.api.snapshot().activeKey,JSON.stringify(['import','a']));assert.equal(h.api.snapshot().visible,true);assert.equal(h.api.snapshot().expanded,true);
  assert.equal(h.$('#draft-retained'),content);assert.equal(action.disabled,false);assert.equal(h.calls.some(call=>call[0]==='suspend'),false);
});

test('failed return retains active document, draft metadata, expansion and mounted content',async()=>{
 let called=0;const h=harness({hooks:{isDirty:()=>true,resolveOrigin:()=>({available:true,label:'返回成果',caption:'Project / 成果'}),onReturn:async()=>{called++;return false;}}});h.api.present('note','n',1,{origin:{view:'project',projectId:'p',section:'outputs'}});h.api.setExpanded(true);const content=h.add('retained-content','article',h.$('#previewContent'));
 assert.equal(await h.api.returnToOrigin(),false);assert.equal(called,1);assert.equal(h.api.snapshot().visible,true);assert.equal(h.api.snapshot().expanded,true);assert.equal(h.api.sessionMetadata().tabs[0].draftPending,true);assert.equal(h.$('#retained-content'),content);assert.equal(h.calls.some(call=>call[0]==='suspend'),false);assert.equal(h.$('#readingBack').disabled,false);
});

test('unavailable return source disables back while ordinary collapse remains independent',async()=>{
 let called=0,available=true;const h=harness({hooks:{resolveOrigin:()=>({available,label:available?'返回成果':'原入口不可用'}),onReturn:async()=>{called++;return true;}}});h.api.present('note','n',1,{origin:{view:'project',projectId:'p',section:'outputs'}});available=false;h.api.refreshTabs();assert.equal(h.$('#readingBack').disabled,true);assert.equal(await h.api.returnToOrigin(),false);assert.equal(called,0);assert.equal(h.api.snapshot().visible,true);assert.equal(await h.api.hide(),true);assert.equal(h.api.snapshot().visible,false);
});

test('pending origin return is deduplicated and a newer document opening cancels its parking authority',async()=>{
 const gate=deferred();let count=0,h;h=harness({hooks:{resolveOrigin:()=>({available:true,label:'返回成果'}),onReturn:async(_origin,options)=>{count++;await gate.promise;if(!options.isCurrent())return false;h.api.revealWorkspace({force:true});return true;}}});h.api.present('note','n',1,{origin:{view:'project',projectId:'p',section:'outputs'}});const pending=h.api.returnToOrigin();assert.equal(h.$('#readingBack').disabled,true);assert.equal(await h.api.returnToOrigin(),false);assert.equal(count,1);
 assert.equal(await h.api.beforeNavigate('import','a'),true);h.api.present('import','a',2,{origin:{view:'overview'}});gate.resolve();assert.equal(await pending,false);assert.equal(h.api.snapshot().visible,true);assert.equal(h.api.isActive('import','a'),true);assert.equal(h.$('#readingBack').disabled,false);
});

test('tab selection explicitly retains origin rather than recapturing a background workspace route',async()=>{
 let selected;const h=harness({hooks:{onSelect:(_kind,_id,_page,options)=>{selected=options;return true;}}});h.api.present('note','n',1,{origin:{view:'project',projectId:'p',section:'outputs'}});h.api.present('import','a',1,{origin:{view:'agent',conversationId:'c'}});await h.$('#readingTabs').querySelectorAll('[role="tab"]')[0].onclick();assert.equal(selected.retainOrigin,true);assert.equal(selected.navigationApproved,true);assert.equal(selected.isCurrent(),true);
});


test('tab keyboard focus waits for asynchronous draft flush and source load',async()=>{
  const gate=deferred(),loaded=deferred();let h;
  h=harness({hooks:{beforeSwitch:()=>gate.promise,onSelect:async(kind,id,page)=>{await loaded.promise;return h.api.present(kind,id,page);}}});
  h.open('note','n');h.open('import','a');const strip=h.$('#readingTabs');strip.clientWidth=200;
  const active=strip.querySelector('[aria-selected="true"]');active.focus();active.fire('keydown',{key:'Home'});
  assert.equal(h.api.snapshot().activeKey,JSON.stringify(['import','a']));assert.equal(h.document.activeElement,active);
  gate.resolve(true);await Promise.resolve();assert.equal(h.document.activeElement,active);
  loaded.resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.document.activeElement.dataset.readingKey,JSON.stringify(['note','n']));assert.equal(h.document.activeElement.tabIndex,0);assert.equal(strip.scrollLeft,0);
});
test('denied or superseded asynchronous tab keyboard navigation never steals focus',async()=>{
  for(const superseded of [false,true]){
    const gate=deferred();const h=harness({hooks:{beforeSwitch:()=>gate.promise}});h.open('note','n');h.open('import','a');
    const active=h.$('#readingTabs').querySelector('[aria-selected="true"]');active.focus();active.fire('keydown',{key:'Home'});
    if(superseded){h.$('#agentInput').focus();h.api.revealWorkspace({force:true});}
    gate.resolve(superseded);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(h.api.snapshot().activeKey,JSON.stringify(['import','a']));assert.equal(h.document.activeElement,superseded?h.$('#agentInput'):active);
  }
});
test('tab metadata refresh retains close focus and a deliberately scrolled strip',()=>{
  const h=harness();const strip=h.$('#readingTabs');strip.clientWidth=200;h.open('note','n');h.open('import','a');h.open('import','b');
  const activeClose=strip.querySelectorAll('.reading-tab-close').at(-1);activeClose.focus();strip.scrollLeft=0;
  h.api.refreshTabs();assert.equal(h.document.activeElement.dataset.readingCloseKey,JSON.stringify(['import','b']));assert.equal(strip.scrollLeft,0);
  h.document.activeElement.click();assert.equal(h.document.activeElement.dataset.readingKey,JSON.stringify(['import','a']));assert.equal(h.document.activeElement.tabIndex,0);
});
test('tab close exposes only the active close action to Tab and leaves a visible dirty marker outside truncated title',()=>{
  const h=harness({hooks:{isDirty:(_kind,id)=>id==='n'}});h.open('note','n');h.open('import','a');const strip=h.$('#readingTabs');
  assert.deepEqual(strip.querySelectorAll('.reading-tab-close').map(n=>n.tabIndex),[-1,0]);
  const note=strip.querySelectorAll('[role="tab"]')[0];assert.match(note.getAttribute('aria-label'),/未保存/);assert.match(note.title,/未保存/);
  assert.equal(note.querySelector('.reading-tab-dirty').parentElement,note);assert.equal(note.querySelector('.reading-tab-dirty').getAttribute('aria-hidden'),'true');
});
test('keyboard tab navigation ignores composition and modified editor shortcuts',()=>{
  const h=harness();h.open('note','n');h.open('import','a');const active=h.$('#readingTabs').querySelector('[aria-selected="true"]');
  for(const options of [{isComposing:true},{metaKey:true},{ctrlKey:true},{altKey:true},{shiftKey:true}])assert.equal(active.fire('keydown',{key:'Home',...options}).defaultPrevented,false);
  assert.equal(h.api.snapshot().activeKey,JSON.stringify(['import','a']));
});

test('late tab activation does not reclaim focus after the user moves to document content',async()=>{
  const loaded=deferred();let h;h=harness({hooks:{onSelect:async(kind,id,page)=>{await loaded.promise;return h.api.present(kind,id,page);}}});
  h.open('note','n');h.open('import','a');const active=h.$('#readingTabs').querySelector('[aria-selected="true"]');active.focus();active.fire('keydown',{key:'Home'});
  h.$('#previewContent').focus();loaded.resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.api.snapshot().activeKey,JSON.stringify(['note','n']));assert.equal(h.document.activeElement,h.$('#previewContent'));
});
test('same-name note tabs expose their current folderPath without saving titles or paths into preferences',()=>{
  const h=harness();h.state.notes[0].title='复习笔记';h.state.notes[0].folderPath='课程 / 第一章';
  h.state.notes.push({...h.state.notes[0],id:'n2',folderPath:'课程 / 第二章'});h.open('note','n');h.open('note','n2');
  assert.deepEqual(h.$('#readingTabs').querySelectorAll('[role="tab"]').map(n=>n.title),['复习笔记 · 课程 / 第一章','复习笔记 · 课程 / 第二章']);
  assert.doesNotMatch(JSON.stringify(h.api.sessionMetadata()),/第一章|第二章|复习笔记/);
});

test('approved dirty close waits for replacement load and restores focus lost when its confirmation disappears',async()=>{
  const decision=deferred(),loaded=deferred();let h;
  h=harness({beforeLeave:()=>decision.promise,hooks:{isDirty:(_kind,id)=>id==='n',onSelect:async(kind,id,page)=>{await loaded.promise;return h.api.present(kind,id,page);}}});
  h.open('import','a');h.open('note','n');h.$('#readingTabs').querySelectorAll('.reading-tab-close').at(-1).focus();
  const closing=h.api.close();h.document.body.focus();decision.resolve(true);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.api.snapshot().tabs.length,1);assert.equal(h.document.activeElement,h.document.body);
  loaded.resolve();await closing;
  assert.equal(h.document.activeElement.dataset.readingKey,JSON.stringify(['import','a']));assert.equal(h.document.activeElement.tabIndex,0);
});
test('canceling dirty close preserves the editor focus chosen by Continue editing',async()=>{
  const decision=deferred(),h=harness({beforeLeave:()=>decision.promise,hooks:{isDirty:()=>true}});
  h.open('import','a');h.open('note','n');const closing=h.api.close();h.$('#previewContent').focus();decision.resolve(false);await closing;
  assert.equal(h.api.snapshot().tabs.length,2);assert.equal(h.api.snapshot().activeKey,JSON.stringify(['note','n']));assert.equal(h.document.activeElement,h.$('#previewContent'));
});
test('approved dirty close does not steal a meaningful focus moved during the replacement load',async()=>{
  const decision=deferred(),loaded=deferred();let h;
  h=harness({beforeLeave:()=>decision.promise,hooks:{isDirty:()=>true,onSelect:async(kind,id,page)=>{await loaded.promise;return h.api.present(kind,id,page);}}});
  h.open('import','a');h.open('note','n');const closing=h.api.close();h.document.body.focus();decision.resolve(true);await new Promise(resolve=>setImmediate(resolve));
  h.$('#agentInput').focus();loaded.resolve();await closing;
  assert.equal(h.api.snapshot().tabs.length,1);assert.equal(h.document.activeElement,h.$('#agentInput'));
});
test('a later workspace route cancels post-close focus recovery while replacement loading is pending',async()=>{
  const loaded=deferred();let h;
  h=harness({beforeLeave:()=>true,hooks:{onSelect:async(kind,id,page,options)=>{await loaded.promise;return options.isCurrent()?h.api.present(kind,id,page):false;}}});
  h.open('import','a');h.open('note','n');h.document.body.focus();const closing=h.api.close();
  h.api.revealWorkspace({force:true});h.$('#agentInput').focus();loaded.resolve();await closing;
  assert.equal(h.api.snapshot().visible,false);assert.equal(h.document.activeElement,h.$('#agentInput'));
});

// E46: real reader + production citation/route functions; only document drawing
// and the final workspace renderer are synthetic. No user workspace is read.
function referenceTrailHarness() {
  const Origin = require('../app/document-origin'), Evidence = require('../app/citation-evidence'), Provenance = require('../app/artifact-provenance');
  let h, leave = () => true, privateMode = false;
  const views = new Map([['note:n', {mode:'edit',scrollTop:247,selection:{start:2,end:8,direction:'forward'}}],['import:a',{scrollTop:91}]]);
  h = harness({real:true,hooks:{
    captureView:(kind,id)=>views.get(`${kind}:${id}`),
    resolveOrigin:origin=>h.context.resolveDocumentOrigin(origin),
    onReturn:(origin,options)=>h.context.returnToDocumentOrigin(origin,options),
    onSelect:(kind,id,page,options)=>h.context.openPreview(kind,id,page,undefined,undefined,options)
  }});
  Object.assign(h.state,{currentConversationId:'branch',currentProjectId:'p',ui:{},agentRuns:[],trash:[],conversations:[
    {id:'original',projectId:'p',title:'Original',messages:[]},{id:'branch',projectId:'p',title:'Branch',messages:[]}
  ]});
  h.document.body.dataset.view='agent';
  const run={id:'run',conversationId:'original',projectId:'p',status:'completed'};h.state.agentRuns.push(run);
  const citation=Evidence.capture(run,{type:'import',id:'a',page:2,title:'Original PDF',projectId:'p',excerpt:'Fictional evidence'},h.state);
  h.state.notes[0].sourceConversationId='branch';
  h.state.notes[0].provenance=Provenance.capture(h.state,run,{type:'note',id:'n',record:h.state.notes[0],variant:'body',operation:'captured',at:5});
  const showView=view=>{showView.navigationVersion++;h.document.body.dataset.view=view;};showView.navigationVersion=0;
  Object.assign(h.context,{DocumentOrigin:Origin,storageHydrated:true,serverConflict:false,showView,
    openConversation:id=>{h.state.currentConversationId=id;showView('agent');},requestAnimationFrame:fn=>fn()});
  Object.assign(h.context.window,{DocumentOrigin:Origin,CitationEvidence:Evidence,PrivateMode:{isOn:()=>privateMode,shows:item=>!item.private}});
  h.context.PrivateMode=h.context.window.PrivateMode;
  const cut=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
  vm.runInContext(cut('let workspaceRouteIntent =','\nlet pdfPreviewVersion ='),h.context);
  vm.runInContext(cut('async function openSavedDocumentSource(',"\ndocument.addEventListener('click'"),h.context);
  h.context.beforePreviewSwitch=async options=>(await leave())!==false && (!options?.isCurrent||options.isCurrent());
  h.seed=async()=>{
    await h.context.openPreview('import','a',3,undefined,undefined,{origin:{view:'agent',conversationId:'original'}});
    await h.context.openPreview('note','n',undefined,undefined,undefined,{origin:{view:'agent',conversationId:'branch'}});
  };
  h.reference=(options={anchor:h.$('#previewContent')})=>h.context.openSavedDocumentSource('n','#aibro-source-'+encodeURIComponent(citation.sourceId),options);
  h.tab=(kind,id)=>h.api.snapshot().tabs.find(tab=>tab.kind===kind&&tab.id===id);
  h.setLeave=fn=>{leave=fn;};h.setPrivate=value=>{privateMode=value;};h.views=views;
  return h;
}

test('E46 reused PDF citation returns to the current note then branch, preserving pages and editor bookmark',async()=>{
  const h=referenceTrailHarness();await h.seed();const body=h.state.notes[0].content;
  assert.equal(await h.reference(),true);
  assert.deepEqual(h.tab('import','a').origin,{view:'document',kind:'note',id:'n'});
  assert.equal(h.tab('import','a').page,2);assert.deepEqual(h.calls.filter(c=>c[0]==='pdf').at(-1),['pdf','a',2]);
  assert.notEqual(await h.api.returnToOrigin(),false);assert.equal(h.api.isActive('note','n'),true);
  assert.deepEqual(h.api.bookmark('note','n'),h.views.get('note:n'));assert.equal(h.state.notes[0].content,body);
  assert.equal(await h.api.returnToOrigin(),true);assert.equal(h.state.currentConversationId,'branch');assert.equal(h.api.snapshot().visible,false);
  assert.equal(h.tab('import','a').page,2,'returning does not reset the retained PDF page');
});

test('E46 explicit entry never makes direct or longer typed document cycles',async()=>{
  const h=referenceTrailHarness();await h.seed();
  for(const trail of ['direct','long']){
    h.api.present('note','n',undefined,{origin:{view:'agent',conversationId:'branch'}});
    h.api.present('import','a',2,{origin:{view:'document',kind:'note',id:'n'}});
    if(trail==='long'){h.api.present('import','b',1,{origin:{view:'document',kind:'import',id:'a'}});}
    const from=trail==='long'?{kind:'import',id:'b'}:{kind:'import',id:'a'};
    assert.equal(h.api.referenceOrigin('note','n',from),undefined);
    const before=h.tab('note','n').origin;
    await h.context.openPreview('note','n',undefined,undefined,undefined,{sourceDocument:from});
    assert.deepEqual(h.tab('note','n').origin,before);
  }
  // Same IDs in different collections are different documents.
  h.state.imports.push({id:'n',name:'Different.pdf',projectId:'p',mimeType:'application/pdf'});
  assert.deepEqual(h.api.referenceOrigin('import','n',{kind:'note',id:'n'}),{view:'document',kind:'note',id:'n'});
});

test('E46 ordinary tab switches and inline save refresh retain the accepted reference trail',async()=>{
  const h=referenceTrailHarness();await h.seed();await h.reference();
  const before=JSON.stringify(h.api.sessionMetadata());
  h.api.refreshTabs();assert.equal(JSON.stringify(h.api.sessionMetadata()),before);
  await h.$('#readingTabs').querySelectorAll('[role="tab"]')[1].onclick();
  await h.$('#readingTabs').querySelectorAll('[role="tab"]')[0].onclick();
  assert.deepEqual(h.tab('import','a').origin,{view:'document',kind:'note',id:'n'});assert.equal(h.tab('import','a').page,2);
  const restored=harness();restored.api.restoreSession(h.api.sessionMetadata());
  assert.deepEqual(restored.api.snapshot().tabs.find(t=>t.id==='a').origin,h.tab('import','a').origin);
});

test('E46 editor source navigation uses its verified note identity when its link has no reader DOM anchor',async()=>{
  const h=referenceTrailHarness();await h.seed();h.$('#agentInput').focus();
  assert.equal(await h.reference({}),true);
  assert.deepEqual(h.tab('import','a').origin,{view:'document',kind:'note',id:'n'});
});

test('E46 dirty-note cancellation keeps the old PDF entry and source draft untouched; save accepts the new entry',async()=>{
  const h=referenceTrailHarness();await h.seed();const gate=deferred(),before=JSON.stringify(h.tab('import','a'));h.setLeave(()=>gate.promise);
  const pending=h.reference();assert.equal(h.api.isActive('note','n'),true);assert.equal(JSON.stringify(h.tab('import','a')),before);
  gate.resolve(false);assert.equal(await pending,false);assert.equal(h.api.isActive('note','n'),true);assert.equal(JSON.stringify(h.tab('import','a')),before);
  h.setLeave(()=>{h.state.notes[0].content+='\nSaved edit';return true;});assert.equal(await h.reference(),true);assert.match(h.state.notes[0].content,/Saved edit/);
  assert.deepEqual(h.tab('import','a').origin,{view:'document',kind:'note',id:'n'});
});

test('E46 revoked source or owner and newer navigation during draft approval cannot replace the old entry',async()=>{
  for(const change of ['source','owner','private','route','document','close']){
    const h=referenceTrailHarness();await h.seed();const gate=deferred(),before=JSON.stringify(h.tab('import','a'));h.setLeave(()=>gate.promise);
    const pending=h.reference();
    if(change==='source')h.state.imports[0].private=true;
    if(change==='owner')h.state.notes[0].private=true;
    if(change==='private')h.setPrivate(true);
    if(change==='route')h.context.showView('settings');
    if(change==='document')void h.api.beforeNavigate('import','b');
    if(change==='close')h.api.revealWorkspace({force:true});
    gate.resolve(true);assert.equal(await pending,false,change);
    assert.equal(JSON.stringify(h.tab('import','a')),before,change);
  }
});

test('E46 return rechecks the saved note after approval and never opens an unavailable predecessor',async()=>{
  const h=referenceTrailHarness();await h.seed();await h.reference();const gate=deferred();h.setLeave(()=>gate.promise);
  const pending=h.api.returnToOrigin();h.state.notes[0].deletedAt=100;gate.resolve(true);
  assert.equal(await pending,false);assert.equal(h.api.isActive('import','a'),true);assert.equal(h.state.currentConversationId,'branch');
});
