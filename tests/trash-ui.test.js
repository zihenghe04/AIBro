const test = require('node:test');
const assert = require('node:assert/strict');
const Trash = require('../trash-ui.js');

const fixture = (count = 3) => ({trash:Array.from({length:count},(_,index)=>({
  id:`bin-${index}`,title:`已删除内容 ${index}`,type:'content',deletedAt:1000+index,
  data:{notes:[{id:`note-${index}`}],imports:index===0?[{id:'source'}]:[]}
}))});

function harness(state=fixture()) {
  const purges=[],restores=[],toasts=[],delegated=[]; let working=false;
  class Element {
    constructor(tag){this.tagName=tag;this.children=[];this.parentNode=null;this.listeners={};this.dataset={};this.textContent='';this.disabled=false;this.open=false;this.classes=new Set();this.classList={toggle:(name,value)=>{if(value===undefined)value=!this.classes.has(name);value?this.classes.add(name):this.classes.delete(name);return value;},contains:name=>this.classes.has(name)};}
    set innerHTML(_){throw Error('Stored trash text must never be interpreted as HTML');}
    append(...nodes){for(const child of nodes){child.remove();child.parentNode=this;this.children.push(child);}}
    replaceChildren(...nodes){for(const child of this.children)child.parentNode=null;this.children=[];this.append(...nodes);}
    remove(){if(this.parentNode){this.parentNode.children=this.parentNode.children.filter(child=>child!==this);this.parentNode=null;}}
    setAttribute(name,value){this[name]=value;}
    addEventListener(type,fn,options={}){(this.listeners[type]||=[]).push({fn,once:!!options.once});}
    async fire(type){
      if(this.disabled&&['click','change'].includes(type))return;
      const event={target:this,type,stopped:false,stopPropagation(){this.stopped=true;}},path=[];
      for(let current=this;current;current=current.parentNode)path.push(current);
      for(const current of (type==='close'?path.slice(0,1):path)){
        for(const listener of [...(current.listeners[type]||[])]){await listener.fn(event);if(listener.once)current.listeners[type]=current.listeners[type].filter(item=>item!==listener);}
        if(event.stopped)break;
      }
    }
    focus(){document.activeElement=this;}
    showModal(){this.open=true;}
    close(){if(!this.open)return;this.open=false;void this.fire('close');}
  }
  const document=new Element('document');document.createElement=tag=>new Element(tag);document.body=new Element('body');document.append(document.body);
  const flatten=node=>[node,...node.children.flatMap(flatten)],active=()=>flatten(document.body);
  const matches=(node,selector)=>selector.startsWith('#')?node.id===selector.slice(1):selector==='[data-trash-select]'?node.dataset.trashSelect!==undefined:false;
  document.querySelector=selector=>active().find(node=>matches(node,selector))||null;
  document.querySelectorAll=selector=>active().filter(node=>matches(node,selector));
  const toolbar=new Element('div');toolbar.id='trashToolbar';const list=new Element('div');list.id='trashList';const opener=new Element('button');opener.id='opener';document.body.append(toolbar,list,opener);opener.focus();
  // Reproduce app.js's legacy delegation to detect accidental double actions.
  document.addEventListener('click',event=>{const data=event.target.dataset;if(data.restoreTrash){delegated.push('restore');restores.push(data.restoreTrash);}if(data.purgeTrash){delegated.push('purge');purges.push({ids:[data.purgeTrash]});}});
  const controller=Trash.createController({getState:()=>state,isBusy:()=>working,purge:(ids,options)=>purges.push({ids,options}),restore:id=>restores.push(id),toast:value=>toasts.push(value)},{document});
  controller.render();
  const el=id=>document.querySelector('#'+id),check=id=>active().find(node=>node.dataset.trashSelect===id),button=(name,id)=>active().find(node=>node.dataset[name]===id);
  const toggle=async(id,value)=>{const node=check(id);node.checked=value;await node.fire('change');};
  return {state,controller,document,opener,toolbar,list,active,el,check,button,toggle,purges,restores,toasts,delegated,busy(value){working=value;controller.render();},content:()=>active().map(node=>node.textContent).join('\n')};
}

test('empty trash hides bulk toolbar and has no actionable selection',()=>{
  const h=harness(fixture(0));assert.equal(h.toolbar.hidden,true);assert.equal(h.list.classList.contains('empty-list'),true);
  assert.match(h.content(),/回收站为空/);assert.equal(h.el('trashDeleteSelected').disabled,true);assert.equal(h.el('trashEmpty').disabled,true);assert.deepEqual(h.controller.selection(),[]);
});

test('render preserves source data and displays untrusted titles as literal text',()=>{
  const state=fixture();state.trash[0].title='<img src=x onerror=alert(1)>';const before=JSON.stringify(state),h=harness(state);
  assert.deepEqual(h.list.children.map(row=>row.dataset.trashId),['bin-2','bin-1','bin-0']);assert.match(h.content(),/<img src=x onerror=alert\(1\)>/);assert.match(h.content(),/1 项知识/);assert.match(h.content(),/1 项资料/);assert.equal(JSON.stringify(state),before);
});

test('individual selection, select-all, cancellation and rerender reconciliation preserve exact IDs',async()=>{
  const h=harness();await h.toggle('bin-1',true);assert.deepEqual(h.controller.selection(),['bin-1']);assert.equal(h.el('trashSelectAll').indeterminate,true);assert.equal(h.document.activeElement,h.check('bin-1'));
  h.el('trashSelectAll').checked=true;await h.el('trashSelectAll').fire('change');assert.deepEqual(h.controller.selection(),['bin-0','bin-1','bin-2']);assert.equal(h.el('trashSelectAll').checked,true);
  await h.el('trashClearSelection').fire('click');assert.deepEqual(h.controller.selection(),[]);assert.equal(h.el('trashDeleteSelected').disabled,true);
  await h.toggle('bin-0',true);await h.toggle('bin-2',true);h.state.trash=h.state.trash.filter(row=>row.id!=='bin-0');h.controller.render();assert.deepEqual(h.controller.selection(),['bin-2']);assert.deepEqual(h.purges,[]);
});

test('bulk and empty controls dispatch only their exact current scope',async()=>{
  const h=harness();await h.toggle('bin-2',true);await h.toggle('bin-0',true);await h.el('trashDeleteSelected').fire('click');
  assert.deepEqual(h.purges,[{ids:['bin-2','bin-0'],options:{bulk:true}}]);await h.el('trashEmpty').fire('click');assert.deepEqual(h.purges[1],{ids:['bin-0','bin-1','bin-2'],options:{empty:true}});
  h.controller.clearSelection();assert.deepEqual(h.controller.selection(),[]);assert.equal(h.el('trashClearSelection').hidden,true);
});

test('row restore and purge each fire once and stop legacy document delegation',async()=>{
  const h=harness();await h.button('restoreTrash','bin-1').fire('click');await h.button('purgeTrash','bin-2').fire('click');
  assert.deepEqual(h.restores,['bin-1']);assert.deepEqual(h.purges,[{ids:['bin-2'],options:undefined}]);assert.deepEqual(h.delegated,[]);
});

test('busy state disables selection, row actions and both destructive bulk actions',async()=>{
  const h=harness();await h.toggle('bin-0',true);h.busy(true);
  for(const node of h.active().filter(node=>['button','input'].includes(node.tagName)&&node!==h.opener))assert.equal(node.disabled,true);
  await h.button('restoreTrash','bin-1').fire('click');await h.el('trashEmpty').fire('click');assert.deepEqual(h.restores,[]);assert.deepEqual(h.purges,[]);
  h.busy(false);assert.equal(h.el('trashDeleteSelected').disabled,false);assert.deepEqual(h.controller.selection(),['bin-0']);
});

test('2000-item cap blocks clear-all above limit without silently splitting deletion',async()=>{
  const h=harness(fixture(2001));assert.equal(Trash.MAX_BATCH,2000);assert.equal(h.el('trashEmpty').disabled,true);
  h.el('trashSelectAll').checked=true;await h.el('trashSelectAll').fire('change');assert.equal(h.controller.selection().length,2000);assert.equal(h.el('trashSelectAll').indeterminate,true);assert.match(h.toasts[0],/2000/);
  await h.toggle('bin-2000',true);assert.equal(h.check('bin-2000').checked,false);assert.equal(h.controller.selection().length,2000);
  await h.toggle('bin-0',false);await h.toggle('bin-2000',true);assert.equal(h.controller.selection().includes('bin-2000'),true);assert.equal(h.controller.selection().includes('bin-0'),false);
  await h.el('trashDeleteSelected').fire('click');assert.equal(h.purges[0].ids.length,2000);assert.equal(h.purges.length,1);
});

test('confirmation is cancelled by default, shows scope and does not allow a second dialog',async()=>{
  const h=harness(fixture(10)),before=JSON.stringify(h.state),pending=h.controller.confirmDelete(h.state.trash,{empty:true});
  assert.equal(h.el('trashPurgeDialog').open,true);assert.equal(h.document.activeElement.textContent,'取消');assert.match(h.el('trashPurgeTitle').textContent,/清空 10 条/);assert.match(h.content(),/另外 2 条记录/);assert.match(h.content(),/不会立即擦除云端历史和备份/);
  assert.equal(await h.controller.confirmDelete(h.state.trash),false);assert.equal(h.active().filter(node=>node.tagName==='dialog').length,1);
  await h.document.activeElement.fire('click');assert.equal(await pending,false);assert.equal(h.el('trashPurgeDialog'),null);assert.equal(h.document.activeElement,h.opener);assert.equal(JSON.stringify(h.state),before);assert.deepEqual(h.purges,[]);
});

test('only explicit confirmation resolves true; Escape-style close resolves false and restores focus',async()=>{
  const h=harness();let pending=h.controller.confirmDelete(h.state.trash.slice(0,2));assert.match(h.el('trashPurgeTitle').textContent,/永久删除 2 条/);
  await h.el('confirmTrashPurge').fire('click');assert.equal(await pending,true);assert.equal(h.el('trashPurgeDialog'),null);
  pending=h.controller.confirmDelete(h.state.trash);h.el('trashPurgeDialog').close();assert.equal(await pending,false);assert.equal(h.document.activeElement,h.opener);
});
