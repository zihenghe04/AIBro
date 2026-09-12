const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const AttachmentAnalysis = require('../app/attachment-analysis');
const Reading = require('../app/reading-pane');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
function dom() {
  class Node {
    constructor(tag){this.tagName=tag;this.children=[];this.listeners={};this.attributes={};this.dataset={};this.style={};this.hidden=false;this.open=false;this.value='';this.className='';this._text='';this._html='';const classes=new Set();this.classList={toggle:(v,on)=>{if(on===undefined)on=!classes.has(v);on?classes.add(v):classes.delete(v);return on;},contains:v=>classes.has(v)};}
    set textContent(v){this._text=String(v);this.children=[];} get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}
    set innerHTML(v){this._html=String(v);this.children=[];} get innerHTML(){return this._html;}
    append(...nodes){for(const n of nodes){if(n.parent)n.parent.children=n.parent.children.filter(x=>x!==n);n.parent=this;this.children.push(n);}}
    before(node){const p=this.parent;if(p){node.parent=p;p.children.splice(p.children.indexOf(this),0,node);}}
    insertAdjacentElement(_,node){this.before(node);}
    replaceChildren(...nodes){this.children=[];this._text='';this._html='';this.append(...nodes);}
    setAttribute(k,v){this.attributes[k]=String(v);} removeAttribute(k){delete this.attributes[k];delete this[k];}
    getAttribute(k){return this.attributes[k];}
    get parentElement(){return this.parent;}
    get offsetLeft(){return this.parent?.children.indexOf(this)*150;}
    get offsetWidth(){return 150;}
    addEventListener(k,fn){(this.listeners[k]||=[]).push(fn);} fire(k,e={}){for(const fn of this.listeners[k]||[])fn({target:this,...e});}
    all(){return [this,...this.children.flatMap(x=>x.all())];}
    querySelector(q){return this.all().find(n=>q.startsWith('#')?n.id===q.slice(1):q.startsWith('.')?n.className.split(' ').includes(q.slice(1)):q==='[aria-selected="true"]'?n.attributes['aria-selected']==='true':n.tagName===q)||null;}
    querySelectorAll(q){return this.all().filter(n=>q==='[role="tab"]'?n.attributes.role==='tab':n.className.split(' ').includes(q.slice(1)));}
    show(){this.open=true;this.shown=(this.shown||0)+1;} showModal(){throw new Error('Reader must never invoke showModal');}
    close(){this.open=false;this.fire('close');} focus(){document.activeElement=this;}
  }
  const document={createElement:tag=>new Node(tag),body:new Node('body'),getElementById:id=>document.body.all().find(n=>n.id===id)||null,querySelector:q=>document.body.querySelector(q)};
  const add=(id,tag='div',parent=document.body)=>{const n=new Node(tag);n.id=id;parent.append(n);return n;};
  const actions=add('topActions');actions.className='top-actions';const input=add('agentInput','textarea');document.activeElement=input;
  const dialog=add('previewDialog','dialog');const form=add('previewForm','form',dialog);
  for(const id of ['previewEyebrow','previewTitle','previewMeta','previewAnalysisStatus','previewRelations','previewVisual','previewContent','previewDownload','previewBack','previewOrganize'])add(id,'div',form);
  add('taskDialog','dialog');add('paperDialog','dialog');
  return {document,add,$:q=>document.querySelector(q)};
}
function harness({real=false,getBlob,beforeLeave}={}) {
  const d=dom();const state={projects:[{id:'p',name:'课程'}],imports:[{id:'a',name:'原件.pdf',mimeType:'application/pdf',projectId:'p'},{id:'b',name:'图片.png',mimeType:'image/png',projectId:'p'}],notes:[{id:'n',title:'研究笔记',content:'实际笔记',projectId:'p',sourceAttachmentIds:['a']}],papers:[],tasks:[{id:'t',title:'任务'}],previewRecord:null,openTaskId:'t'};
  const calls=[],revoked=[];let api,serial=0,context;
  if(real){
    context=vm.createContext({NoteMarkdown:require('../app/note-markdown'),state,$:d.$,document:d.document,window:{AttachmentAnalysis},AttachmentAnalysis,URL:{createObjectURL:()=>`blob:test-${++serial}`,revokeObjectURL:url=>revoked.push(url)},Blob,previewObjectUrl:null,pdfPreviewVersion:0,pdfPreviewAbort:{abort:()=>calls.push(['abort'])},
      esc:String,uiIcon:()=>'',toast:message=>calls.push(['toast',message]),renderRichText:content=>`<p>${content}</p>`,visibleProject:p=>!p.archived,visibleImport:i=>!i.archived,visibleNote:n=>!n.archived,
      fileStoreGet:async id=>getBlob?getBlob(id):new Blob(['file'],{type:state.imports.find(x=>x.id===id)?.mimeType}),mountPdfPreview:(container,item,blob,page)=>{container.innerHTML='PDF rendered';calls.push(['pdf',item.id,page]);},renderTaskDialog:()=>calls.push(['render-task']),openPaper:()=>{},openProject:()=>{},dataUrlToBlob:()=>new Blob(['file'])});
    vm.runInContext(source.slice(source.indexOf('function importAnalysis('), source.indexOf('function entityImport(')) + source.slice(source.indexOf('function renderPreviewAnalysis('), source.indexOf('// Stage a focused analysis request')), context);
    vm.runInContext(source.slice(source.indexOf('let previewRequestVersion ='),source.indexOf('\nconst searchTypeLabel =')),context);
  }
  const getItem=(kind,id)=>real?context.previewItem(kind,id):(kind==='note'?state.notes:state.imports).find(x=>x.id===id&&!x.archived&&!x.deletedAt&&state.projects.some(p=>p.id===x.projectId&&!p.archived));
  api=Reading.createController({getItem,beforeLeave,onSuspend:()=>real?context.suspendPreview():calls.push(['suspend']),onSelect:(kind,id,page)=>{calls.push(['select',kind,id,page]);return real?context.openPreview(kind,id,page):api.present(kind,id,page);}},{document:d.document,matchMedia:()=>({matches:false})});
  if(real)context.window.ReadingPane=api;
  return {...d,state,api,calls,context,revoked,open:(kind,id,page)=>real?context.openPreview(kind,id,page):api.present(kind,id,page)};
}
test('reader uses nonmodal show with stable escaped labels, keeps main input and unique tabs',()=>{
  const h=harness();h.state.notes[0].title='<img src=x onerror=alert(1)>';h.$('#agentInput').value='草稿';h.open('note','n');h.open('import','a');h.open('import','a',2);
  assert.equal(h.$('#previewDialog').getAttribute('aria-modal'),'false');assert.equal(h.$('#previewDialog').open,true);assert.equal(h.$('#agentInput').value,'草稿');assert.equal(h.$('#agentInput').inert,undefined);
  assert.equal(h.api.snapshot().tabs.length,2);assert.match(h.$('#readingTabs').textContent,/<img src=x onerror=alert\(1\)>/);assert.equal(h.api.snapshot().tabs[1].page,2);
});
test('tabs preserve actual page and re-read renamed/current records on selection',()=>{
  const h=harness();h.open('import','a');h.api.setPage('import','a',7);h.open('note','n');h.state.imports[0].name='重命名原件.pdf';h.api.reconcile();h.$('#readingTabs').querySelectorAll('[role="tab"]')[0].onclick();
  assert.deepEqual(h.calls.at(-1),['select','import','a',7]);assert.equal(h.api.snapshot().tabs[0].title,'重命名原件.pdf');assert.equal(h.api.isActive('import','a'),true);
});
test('collapse retains tabs, expand is reversible, re-open and keyboard navigation preserve input',()=>{
  const h=harness();h.open('import','a');h.open('note','n');h.$('#agentInput').value='继续写';h.$('#readingExpand').onclick();assert.equal(h.api.snapshot().expanded,true);
  h.$('#readingCollapse').onclick();assert.equal(h.api.snapshot().visible,false);assert.equal(h.api.snapshot().expanded,false);assert.equal(h.api.snapshot().tabs.length,2);assert.equal(h.$('#readingToggle').hidden,false);
  h.$('#readingToggle').onclick();assert.equal(h.api.snapshot().visible,true);assert.equal(h.$('#agentInput').value,'继续写');
  h.$('#readingTabs').querySelectorAll('[role="tab"]')[1].onkeydown({key:'Home',preventDefault(){}});assert.equal(h.api.isActive('import','a'),true);
});
test('deleting or archiving an active record activates the next valid tab; final close hides reader',()=>{
  const h=harness();h.open('note','n');h.open('import','a');h.state.imports=[];h.api.reconcile();assert.equal(h.api.isActive('note','n'),true);assert.equal(h.api.snapshot().tabs.length,1);
  h.state.projects[0].archived=true;h.api.reconcile();assert.equal(h.api.snapshot().tabs.length,0);assert.equal(h.api.snapshot().visible,false);assert.equal(h.$('#previewDialog').open,false);assert.equal(h.$('#readingToggle').hidden,true);
});
test('closing an inactive tab does not reload or invalidate the current original',()=>{
  const h=harness();h.open('note','n');h.open('import','a');h.api.close(h.api.snapshot().tabs[0].key);assert.equal(h.api.isActive('import','a'),true);assert.equal(h.calls.length,0);
  h.api.close();assert.equal(h.api.snapshot().visible,false);
});
test('mouse-selected tabs retain focus after rerender, so Escape remains available inside the reader',()=>{
  const h=harness();h.open('import','a');h.open('note','n');const tab=h.$('#readingTabs').querySelectorAll('[role="tab"]')[0];tab.focus();tab.onclick();const current=h.document.activeElement;
  assert.notEqual(current,tab);assert.equal(current.dataset.readingKey,h.api.snapshot().activeKey);assert.ok(h.$('#readingTabs').all().includes(current));
  h.$('#readingPane').fire('keydown',{key:'Escape',preventDefault(){}});assert.equal(h.api.snapshot().visible,false);assert.equal(h.$('#previewDialog').open,false);
});
test('new active tabs scroll into the tab strip without moving the reading document',()=>{
  const h=harness();const strip=h.$('#readingTabs');strip.clientWidth=200;strip.scrollLeft=0;h.$('#previewDialog').scrollTop=97;
  h.open('note','n');h.open('import','a');h.open('import','b');assert.equal(strip.scrollLeft,250);assert.equal(h.$('#previewDialog').scrollTop,97);
  strip.querySelectorAll('[role="tab"]')[0].onclick();assert.equal(strip.scrollLeft,0);assert.equal(h.$('#previewDialog').scrollTop,97);
});
test('real preview opens immediately and a slow previous original cannot overwrite another tab',async()=>{
  const wait=deferred();const h=harness({real:true,getBlob:id=>id==='a'?wait.promise:new Blob(['b'])});const pending=h.open('import','a',3);assert.equal(h.$('#previewDialog').open,true);assert.match(h.$('#previewVisual').innerHTML,/正在载入原件/);
  await h.open('note','n');wait.resolve(new Blob(['pdf'],{type:'application/pdf'}));await pending;assert.equal(h.$('#previewTitle').textContent,'研究笔记');assert.equal(h.context.state.previewRecord.id,'n');assert.equal(h.calls.filter(x=>x[0]==='pdf').length,0);assert.match(h.$('#previewDownload').href,/^blob:/);
});
test('close during blob load invalidates late success and late failure without re-opening or leaking URLs',async()=>{
  for(const fail of [false,true]){const wait=deferred();const h=harness({real:true,getBlob:()=>wait.promise});const pending=h.open('import','a');h.api.hide();fail?wait.reject(new Error('offline')):wait.resolve(new Blob(['pdf']));await pending;assert.equal(h.$('#previewDialog').open,false);assert.equal(h.api.snapshot().visible,false);assert.equal(h.$('#previewVisual').innerHTML,'');assert.equal(h.context.state.previewRecord,null);assert.equal(h.$('#previewDownload').hidden,true);}
});
test('switch and hide revoke old object URLs; delayed native close event cannot hide reopened reader',async()=>{
  const h=harness({real:true});await h.open('note','n');const first=h.$('#previewDownload').href;await h.open('import','b');assert.ok(h.revoked.includes(first));const second=h.$('#previewDownload').href;h.api.hide();assert.ok(h.revoked.includes(second));await h.open('note','n');h.$('#previewDialog').fire('close');assert.equal(h.api.snapshot().visible,true);assert.equal(h.$('#previewDialog').open,true);
});
test('task source opening removes the modal, carries return context across tabs, and retains unsaved task fields',async()=>{
  const h=harness({real:true});h.add('taskTitleInput','input').value='尚未保存的修改';h.$('#taskDialog').open=true;await h.open('import','a');assert.equal(h.$('#taskDialog').open,false);assert.equal(h.state.previewReturnTaskId,'t');await h.open('note','n');assert.equal(h.state.previewReturnTaskId,'t');
  const handler=source.slice(source.indexOf("$('#previewBack').onclick ="),source.indexOf("$('#previewOrganize').onclick ="));vm.runInContext(handler,h.context);h.$('#taskDialog').showModal=function(){this.open=true;};h.$('#previewBack').onclick();assert.equal(h.$('#taskDialog').open,true);assert.equal(h.$('#taskTitleInput').value,'尚未保存的修改');assert.equal(h.calls.filter(x=>x[0]==='render-task').length,1);
});
test('returning to a task rebinds checklist callbacks to the current object after lifecycle replaces it, preserving draft fields',async()=>{
  const h=harness({real:true});const fields=['taskTitleInput','taskDescriptionInput','taskStatusInput','taskPriorityInput','taskDueInput','taskTimeInput','taskProjectInput','newChecklistItem'];for(const id of fields)h.add(id,'input').value=`draft-${id}`;
  const old=h.state.tasks[0];old.checklist=[{text:'材料',done:false}];h.$('#taskDialog').open=true;await h.open('note','n');h.state.tasks=JSON.parse(JSON.stringify(h.state.tasks));
  let checkbox;h.context.renderTaskDialog=task=>{for(const id of fields)h.$(`#${id}`).value='renderer reset';checkbox=()=>task.checklist[0].done=true;};
  vm.runInContext(source.slice(source.indexOf("$('#previewBack').onclick ="),source.indexOf("$('#previewOrganize').onclick =")),h.context);h.$('#taskDialog').showModal=function(){this.open=true;};h.$('#previewBack').onclick();checkbox();
  assert.equal(h.state.tasks[0].checklist[0].done,true);assert.equal(old.checklist[0].done,false);for(const id of fields)assert.equal(h.$(`#${id}`).value,`draft-${id}`);
});
test('deleted or archived sources cannot start preview, and archive during read invalidates the pending result',async()=>{
  const wait=deferred();const h=harness({real:true,getBlob:()=>wait.promise});const pending=h.open('import','a');h.state.projects[0].archived=true;h.api.reconcile();wait.resolve(new Blob(['pdf']));await pending;assert.equal(h.api.snapshot().tabs.length,0);assert.equal(h.$('#previewDialog').open,false);await h.open('note','n');assert.equal(h.$('#previewDialog').open,false);assert.match(h.calls.at(-1)[1],/归档/);
});
test('actual reader uses user-facing metadata and folds source links instead of filling PDF header',async()=>{
  const h=harness({real:true});h.state.imports[0].parser='local';await h.open('import','a');assert.match(h.$('#previewMeta').textContent,/PDF 文档/);assert.doesNotMatch(h.$('#previewMeta').textContent,/local/);assert.equal(h.$('#previewRelatedSources').open,false);assert.equal(h.$('#previewExtracted').open,false);assert.match(h.$('#previewExtracted').querySelector('summary').textContent,/可搜索文字/);
});
test('actual source reader marks only fixed headings, relationship counts and page labels for translation',async()=>{
  const h=harness({real:true,getBlob:()=>null});h.state.projects[0].name='所属项目';h.state.notes[0].title='分析笔记';h.state.imports[0].name='资料库.pdf';h.state.imports[0].pages=[{page:1,text:'关联资料：这是用户原文'}];
  const original=JSON.stringify(h.state.imports[0]);await h.open('import','a');
  assert.equal(h.$('#previewEyebrow').getAttribute('data-i18n'),'');
  assert.match(h.$('#previewRelatedSources').querySelector('summary').innerHTML,/<span data-i18n>关联资料<\/span>/);
  assert.match(h.$('#previewRelatedSources').querySelector('summary').innerHTML,/<span data-i18n>1 篇笔记<\/span>/);
  assert.match(h.$('#previewRelations').innerHTML,/<span data-user-content>所属项目<\/span>/);
  assert.match(h.$('#previewRelations').innerHTML,/<span data-user-content>分析笔记<\/span>/);
  assert.match(h.$('#previewVisual').innerHTML,/<b data-i18n>第 1 页<\/b><p data-user-content>关联资料：这是用户原文<\/p>/);
  assert.equal(h.$('#previewTitle').textContent,'资料库.pdf');assert.equal(JSON.stringify(h.state.imports[0]),original);
});
test('persistent tabs label their actual owning workspace and project independently of navigation, including unassigned sources',async()=>{
  const h=harness({real:true});h.state.projects[0].name='同名项目';h.state.projects[0].workspace='课程';h.state.projects.push({id:'research',name:'同名项目',workspace:'科研'});h.state.currentProjectId='research';h.state.imports[0].workspace='科研';await h.open('import','a');assert.match(h.$('#previewMeta').textContent,/课程 › 同名项目/);assert.doesNotMatch(h.$('#previewMeta').textContent,/科研/);
  h.state.imports[1].projectId=null;h.state.imports[1].workspace='日常';await h.open('import','b');assert.match(h.$('#previewMeta').textContent,/日常 › 未归属项目/);
});
test('dirty document guard can cancel active close or hide without removing tabs or suspending the editor',async()=>{
  let wait=deferred();const h=harness({beforeLeave:()=>wait.promise});h.open('note','n');h.open('import','a');
  const closing=h.api.close();assert.equal(h.api.snapshot().tabs.length,2);assert.equal(h.calls.length,0);
  wait.resolve(false);await closing;assert.equal(h.api.isActive('import','a'),true);assert.equal(h.api.snapshot().tabs.length,2);
  wait=deferred();const hiding=h.api.hide();wait.resolve(false);await hiding;assert.equal(h.api.snapshot().visible,true);assert.equal(h.$('#previewDialog').open,true);assert.equal(h.calls.length,0);
  wait=deferred();const approved=h.api.hide();wait.resolve(true);await approved;assert.equal(h.api.snapshot().visible,false);assert.ok(h.calls.some(x=>x[0]==='suspend'));
});
test('only latest guarded navigation wins and deleted target cannot be reopened after save completes',async()=>{
  const wait=deferred();const h=harness({beforeLeave:()=>wait.promise});h.open('import','a');h.open('import','b');h.open('note','n');
  const controls=h.$('#readingTabs').querySelectorAll('[role="tab"]');controls[0].onclick();controls[1].onclick();wait.resolve(true);await Promise.resolve();await Promise.resolve();
  assert.equal(h.api.isActive('import','b'),true);assert.deepEqual(h.calls.filter(x=>x[0]==='select'),[['select','import','b',1]]);
  const next=deferred();const h2=harness({beforeLeave:()=>next.promise});h2.open('import','a');h2.open('note','n');h2.$('#readingTabs').querySelectorAll('[role="tab"]')[0].onclick();h2.state.imports=[];next.resolve(true);await Promise.resolve();await Promise.resolve();
  assert.equal(h2.api.isActive('note','n'),true);assert.equal(h2.calls.some(x=>x[0]==='select'&&x[2]==='a'),false);
});
test('native dialog close keeps the unsaved-change decision visible until it is resolved',async()=>{
  const wait=deferred();const h=harness({beforeLeave:()=>wait.promise});h.open('note','n');h.$('#previewDialog').close();
  assert.equal(h.$('#previewDialog').open,true);assert.equal(h.api.snapshot().visible,true);
  wait.resolve(false);await Promise.resolve();await Promise.resolve();assert.equal(h.api.snapshot().visible,true);assert.equal(h.$('#previewDialog').open,true);
});
