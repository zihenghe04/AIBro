'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Nav=require('../app/workspace-navigation.js'),Branches=require('../app/conversation-branches.js');
class Element {
 constructor(tag='div'){this.tag=tag;this.children=[];this.dataset={};this.attributes={};this.isConnected=true;this.classList={toggle(){},add(){}};}
 append(...nodes){this.children.push(...nodes);for(const n of nodes)n.parentElement=this;}
 prepend(n){this.children.unshift(n);n.parentElement=this;}
 replaceChildren(...nodes){this.children=[];this.append(...nodes);}
 setAttribute(k,v){this.attributes[k]=v;}
 getAttribute(k){return this.attributes[k]??null;}
 addEventListener(){}
 querySelector(){return null;}
 querySelectorAll(){return [];}
 remove(){this.parentElement.children=this.parentElement.children.filter(x=>x!==this);}
}
function fixture({kit=false}={}){
 const main=new Element(),body=new Element(),documentElement={lang:'zh'};body.dataset.view='agent';
 const find=(n,id)=>n.id===id?n:n.children.map(x=>find(x,id)).find(Boolean);
 const doc={body,documentElement,createElement:t=>new Element(t),querySelector:s=>s==='.main'?main:null,querySelectorAll:()=>[],getElementById:id=>find(main,id),addEventListener(){}};
 const c={id:'a',title:'Fictional branch QA',messages:[{id:'u',role:'user',text:'Shared beginning'},{id:'a',role:'agent',text:'First reply'},{id:'u2',role:'user',text:'Original continuation'}]},other={id:'b',title:'Other',messages:[]};
 const state={ui:{},projects:[],conversations:[c,other],currentConversationId:'a'},calls=[],unmounted=[];
 if(kit)globalThis.HalaskaUI={mount(host,name,props){assert.equal(name,'Button');const n=new Element('button');n.id=props.id;n.textContent=props.children;n.onclick=props.onClick;n.setAttribute('aria-haspopup',props['aria-haspopup']);host.append(n);},unmount(host){unmounted.push(host);}};
 else delete globalThis.HalaskaUI;
 const controller=Nav.createController({getState:()=>state,conversationPathCount:Branches.count,openConversationPaths:()=>calls.push(state.currentConversationId)},{document:doc,requestAnimationFrame:()=>{}});
 controller.afterRoute();
 const fork=()=>{const f=Branches.fork(c,'a','archived',2);Object.assign(c,{messages:f.keep,branches:[f.branch],activeBranch:f.activeBranch});controller.afterRoute();};
 return {c,state,doc,controller,calls,unmounted,fork};
}
test('a newly saved path becomes reachable in the visible navigation without a route change',()=>{
 const h=fixture();assert.equal(h.doc.getElementById('workspacePathsToggle'),undefined);h.fork();
 const b=h.doc.getElementById('workspacePathsToggle');assert.ok(b);assert.equal(b.textContent,'2 个分支');assert.equal(b.getAttribute('aria-haspopup'),'dialog');
 b.onclick();assert.deepEqual(h.calls,['a']);assert.equal(h.c.messages.length,2);assert.equal(h.c.branches[0].messages.length,3);
});
test('stale entry cannot open branches for a different conversation, hidden record or project page',()=>{
 const h=fixture();h.fork();const b=h.doc.getElementById('workspacePathsToggle');
 h.state.currentConversationId='b';b.onclick();assert.equal(h.calls.length,0);h.controller.afterRoute();assert.equal(h.doc.getElementById('workspacePathsToggle'),undefined);
 h.state.currentConversationId='a';h.c.archived=true;b.onclick();assert.equal(h.calls.length,0);delete h.c.archived;
 h.doc.body.dataset.view='project';b.onclick();assert.equal(h.calls.length,0);
});
test('Kit root is released on replacement, language updates and removing the last archived path',()=>{
 const h=fixture({kit:true});try{h.fork();const old=h.doc.getElementById('workspacePathsToggle');assert.equal(old.textContent,'2 个分支');
 h.doc.documentElement.lang='en';h.controller.afterRoute();assert.equal(h.doc.getElementById('workspacePathsToggle').textContent,'2 branches');assert.equal(h.unmounted.length,1);
 h.c.branches=[];h.controller.afterRoute();assert.equal(h.doc.getElementById('workspacePathsToggle'),undefined);assert.equal(h.unmounted.length,2);
 }finally{delete globalThis.HalaskaUI;}
});
