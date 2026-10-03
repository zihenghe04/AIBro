'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Command=require('../app/command-search');
// This exercises the retained controller's lifecycle/DOM contract only. It
// cannot claim to reproduce macOS WKWebView's accessibility traversal.
function fixture({bridge=false,nativeClass=false,nested=false,commands=[]}={}){
 let doc,showCount=0,moves=0;const frames=[];
 class Node {
  constructor(tag,id=''){this.tagName=tag.toUpperCase();this.id=id;this.children=[];this.dataset={};this.attributes={};this.listeners={};this.className='';this.value='';this.open=false;this.scrollTop=0;this.style={};this.classList={contains:n=>this.className.split(' ').includes(n),add:n=>{if(!this.classList.contains(n))this.className+=' '+n;},remove:n=>{this.className=this.className.split(' ').filter(v=>v!==n).join(' ');},toggle:(n,value)=>{value?this.classList.add(n):this.classList.remove(n);}};}
  get firstElementChild(){return this.children[0]||null;}
  get isConnected(){for(let n=this;n;n=n.parentElement)if(n===doc.body)return true;return false;}
  all(){return [this,...this.children.flatMap(n=>n.all())];}
  append(...nodes){for(const n of nodes){n.remove();n.parentElement=this;this.children.push(n);}}
  prepend(n){n.remove();n.parentElement=this;this.children.unshift(n);if(n.id==='searchDialog')moves++;}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(n=>n!==this);this.parentElement=null;}
  replaceChildren(...nodes){for(const n of [...this.children])n.remove();this.append(...nodes);}
  matches(s){return s[0]==='.'?this.classList.contains(s.slice(1)):s[0]==='#'?this.id===s.slice(1):this.tagName===s.toUpperCase();}
  querySelector(s){return this.all().slice(1).find(n=>n.matches(s))||null;}
  querySelectorAll(s){return this.all().slice(1).filter(n=>n.matches(s));}
  closest(s){for(let n=this;n;n=n.parentElement)if(n.matches(s))return n;return null;}
  contains(n){return this.all().includes(n);}
  setAttribute(k,v){this.attributes[k]=String(v);}
  removeAttribute(k){delete this.attributes[k];}
  addEventListener(t,f){(this.listeners[t]||=[]).push(f);}
  removeEventListener(t,f){this.listeners[t]=(this.listeners[t]||[]).filter(v=>v!==f);}
  fire(t,opts={}){const e={target:this,key:'',preventDefault(){this.defaultPrevented=true;},stopPropagation(){},...opts};for(const f of this.listeners[t]||[])f(e);return e;}
  focus(){doc.activeElement=this;}
  select(){this.selectionStart=0;this.selectionEnd=this.value.length;}
  getClientRects(){return [{}];}
  getBoundingClientRect(){return {top:0,bottom:100};}
  showModal(){showCount++;this.open=true;this.showParentFirst=this.parentElement.firstElementChild;}
  close(){this.open=false;this.fire('close');}
 }
 const body=new Node('body'),main=new Node('main'),reader=new Node('section'),opener=new Node('button','opener'),dialog=new Node('dialog','searchDialog'),input=new Node('input','globalSearchInput'),box=new Node('div','searchResults'),meta=new Node('div','searchMeta');
 doc={body,activeElement:opener,createElement:t=>new Node(t),getElementById:id=>body.all().find(n=>n.id===id),dispatchEvent(){}};
 if(nativeClass)body.classList.add('aibro-native');main.append(opener);dialog.append(input,meta,box);body.append(main,reader);if(nested){const host=new Node('section');body.append(host);host.append(dialog);}else body.append(dialog);
 const env={document:doc,requestAnimationFrame:f=>{frames.push(f);return frames.length;},cancelAnimationFrame:id=>{frames[id-1]=null;}};if(bridge)env.webkit={messageHandlers:{workspace:{}}};
 let controller;controller=Command.createController({commands,render:q=>controller.render([],q)},env);
 return {controller,body,dialog,input,box,meta,main,reader,opener,doc,node:()=>new Node('aside'),flush:()=>{frames.splice(0).forEach(f=>f?.());},get shows(){return showCount;},get moves(){return moves;}};
}

test('early native bridge puts the retained search dialog before hidden workbench regions',()=>{
 const h=fixture({bridge:true}),input=h.input,results=h.box;h.input.addEventListener('input',()=>{h.input.count=(h.input.count||0)+1;});
 h.controller.open();h.flush();assert.equal(h.body.firstElementChild,h.dialog);assert.equal(h.dialog.showParentFirst,h.dialog);assert.equal(h.moves,1);assert.equal(h.shows,1);assert.equal(h.input,input);assert.equal(h.box,results);assert.equal(h.doc.activeElement,input);h.input.fire('input');assert.equal(h.input.count,1);
 h.input.value='未提交的检索';const newFirst=h.node();h.body.prepend(newFirst);h.controller.open();assert.equal(h.body.firstElementChild,newFirst,'an already-open input must never be reparented');assert.equal(h.input.value,'未提交的检索');assert.equal(h.moves,1);assert.equal(h.shows,1);
 h.controller.close();assert.equal(h.doc.activeElement,h.opener);assert.equal(h.input.attributes['aria-expanded'],'false');h.controller.open();h.flush();assert.equal(h.body.firstElementChild,h.dialog);assert.equal(h.moves,2);
});

test('native class fallback applies, ordinary web and nested owners retain their established order',()=>{
 const native=fixture({nativeClass:true});native.controller.open();assert.equal(native.body.firstElementChild,native.dialog);
 for(const options of [{},{bridge:true,nested:true}]){const h=fixture(options),parent=h.dialog.parentElement,first=h.body.firstElementChild;h.controller.open();assert.equal(h.dialog.parentElement,parent);assert.equal(h.body.firstElementChild,first);assert.equal(h.moves,0);assert.equal(h.shows,1);}
});

test('failed native command reopens the same dialog ahead of newly mounted surfaces and preserves the query',async()=>{
 let reject;const h=fixture({bridge:true,commands:[{id:'test',title:'test',execute:()=>new Promise((_,fail)=>{reject=fail;})}]});h.controller.open();h.flush();h.input.value='test';h.controller.render([],'test');assert.equal(h.controller.activate('command:test'),true);assert.equal(h.dialog.open,false);
 const other=h.node();h.body.prepend(other);reject(Error('尚未打开'));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.dialog.open,true);assert.equal(h.body.firstElementChild,h.dialog);assert.equal(h.shows,2);assert.equal(h.input.value,'test');assert.equal(h.doc.activeElement,h.input);assert.match(h.meta.textContent,/尚未打开/);assert.equal(h.controller.isExecuting(),false);
});

test('search IME and Escape still use the original listeners after the native move',()=>{
 let executions=0;const h=fixture({bridge:true,commands:[{id:'run',title:'运行',execute:()=>executions++}]});h.controller.open();h.flush();h.input.fire('compositionstart');const enter=h.dialog.fire('keydown',{target:h.input,key:'Enter'});assert.equal(executions,0);assert.equal(enter.defaultPrevented,undefined);h.input.fire('compositionend');h.dialog.fire('keydown',{target:h.input,key:'Escape'});assert.equal(h.dialog.open,false);assert.equal(h.doc.activeElement,h.opener);
});
