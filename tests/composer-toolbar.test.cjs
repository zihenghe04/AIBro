'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../app/interaction-system.js'),'utf8');

// A DOM ownership fixture, not a rendering substitute. Real native widths,
// materials and focus navigation are checked in the packaged WKWebView.
function fixture(){
 let document;
 class Element {
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.style={};this.listeners={};this.attributes={};this.className='';this.hidden=false;this.classList={contains:name=>this.className.split(' ').includes(name),add:name=>{if(!this.classList.contains(name))this.className+=' '+name;},remove:name=>{this.className=this.className.split(' ').filter(x=>x!==name).join(' ');}};}
  append(...nodes){for(const node of nodes){node.remove();node.parentElement=this;this.children.push(node);}}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(n=>n!==this);this.parentElement=null;}
  all(){return [this,...this.children.flatMap(n=>n.all())];}
  matches(selector){if(selector.includes(','))return selector.split(',').some(s=>this.matches(s));if(selector[0]==='#')return this.id===selector.slice(1);if(selector[0]==='.')return this.classList.contains(selector.slice(1));if(selector==='[data-composer-control]')return !!this.dataset.composerControl;return this.tagName===selector.toUpperCase();}
  querySelector(selector){return this.all().slice(1).find(n=>n.matches(selector))||null;}
  querySelectorAll(selector){return this.all().slice(1).filter(n=>n.matches(selector));}
  closest(selector){for(let n=this;n;n=n.parentElement)if(n.matches(selector))return n;return null;}
  contains(target){return this.all().includes(target);}
  addEventListener(type,handler){(this.listeners[type]||=[]).push(handler);}
  removeEventListener(type,handler){this.listeners[type]=(this.listeners[type]||[]).filter(f=>f!==handler);}
  fire(type,options={}){const event={target:this,preventDefault(){this.defaultPrevented=true;},...options};for(const handler of this.listeners[type]||[])handler(event);return event;}
  setAttribute(name,value){this.attributes[name]=String(value);}
  focus(){document.activeElement=this;}
  getClientRects(){return [];}
 }
 const body=new Element('body'),composer=new Element('section'),main=new Element('div'),input=new Element('textarea'),footer=new Element('div');
 composer.id='composer';main.className='composer-main';input.id='agentInput';input.value='尚未提交的输入法草稿';input.selectionStart=3;input.selectionEnd=6;input.isComposing=true;footer.className='composer-footer';main.append(input);composer.append(main,footer);body.append(composer);body.dataset.view='agent';
 document=new Element('document');document.body=body;document.append(body);document.createElement=tag=>new Element(tag);document.getElementById=id=>body.all().find(n=>n.id===id)||null;document.activeElement=input;
 const records=new Map(),actions=[];
 function kit(id){if(records.has(id))return records.get(id);const host=new Element('span'),button=new Element('button');host.dataset.composerControl=id;host.dataset.halaskaRoot='ComposerAction';button.id=id;host.append(button);const record={host,button};records.set(id,record);return record;}
 for(const id of ['chatAttach','composerContext','composerModel','composerPermission','composerLocal','agentSend']){const r=kit(id);r.button.addEventListener('click',()=>actions.push(id));footer.append(r.host);}
 for(const id of ['composerReference','composerBrowserToggle','composerSkill','lateExtension']){const button=new Element('button');button.id=id;footer.append(button);}
 const workbench=new Element('span'),contextButton=new Element('button');workbench.id='composerContextWorkbench';contextButton.id='contextWorkbenchEntry';contextButton.addEventListener('click',()=>actions.push('context'));workbench.append(contextButton);footer.append(workbench);
 let inputEvents=0;input.addEventListener('input',()=>inputEvents++);
 const root={document,ComposerUI:{createAction:kit,rootFor:node=>node.closest('[data-composer-control]')||node},requestAnimationFrame:()=>1,cancelAnimationFrame(){},matchMedia:()=>({matches:false}),addEventListener(){},removeEventListener(){},MutationObserver:class {observe(){}disconnect(){}},module:{exports:{}}};
 vm.runInNewContext(source,root);const api=root.module.exports;
 return {api,document,body,composer,main,input,footer,records,actions,contextButton,node:id=>document.getElementById(id),get inputEvents(){return inputEvents;}};
}

test('one action rail moves complete Kit roots and keeps the live editor and bound actions',()=>{
 const h=fixture(),roots=new Map([...h.records].map(([id,r])=>[id,{...r}]));h.api.init();
 const primary=h.footer.querySelector('.composer-primary-row');
 assert.deepEqual(primary.querySelectorAll('button').map(n=>n.id),['chatAttach','composerReference','composerContext','composerModel','composerPermission','composerMore','agentSend']);
 assert.equal(h.footer.children.filter(n=>n.classList.contains('composer-context-row')).length,0);
 for(const [id,r] of roots){assert.equal(h.node(id),r.button);assert.equal(r.button.parentElement,r.host);assert.equal(h.body.all().filter(n=>n.id===id).length,1);}
 assert.equal(h.input.parentElement,h.main);assert.equal(h.input.value,'尚未提交的输入法草稿');assert.deepEqual([h.input.selectionStart,h.input.selectionEnd,h.input.isComposing],[3,6,true]);assert.equal(h.document.activeElement,h.input);
 h.input.fire('input');assert.equal(h.inputEvents,1);h.node('composerModel').fire('click');assert.deepEqual(h.actions,['composerModel']);
 assert.equal(h.node('composerContextWorkbench').parentElement,h.node('composerExtraTools'));assert.equal(h.node('lateExtension').parentElement,h.node('composerExtraTools'));
});

test('More keeps context controls reachable, restores focus on Escape, and closes on a chosen tool',()=>{
 const h=fixture();h.api.init();const more=h.node('composerMore'),extras=h.node('composerExtraTools');
 more.fire('click');assert.equal(extras.hidden,false);assert.equal(more.attributes['aria-expanded'],'true');assert.equal(h.document.activeElement,h.contextButton);
 const event=h.document.fire('keydown',{key:'Escape'});assert.equal(event.defaultPrevented,true);assert.equal(extras.hidden,true);assert.equal(h.document.activeElement,more);
 more.fire('click');h.contextButton.fire('click');extras.fire('click',{target:h.contextButton});assert.equal(extras.hidden,true);assert.deepEqual(h.actions,['context']);
 more.fire('click');h.document.fire('pointerdown',{target:h.input});assert.equal(extras.hidden,true);assert.equal(more.attributes['aria-expanded'],'false');
});

test('reinitialization and destroy retain extensions and do not duplicate controls or event handlers',()=>{
 const h=fixture();h.api.init();const second=h.api.init();
 assert.equal(h.footer.querySelectorAll('.composer-primary-row').length,1);assert.equal(h.body.all().filter(n=>n.id==='composerMore').length,1);
 h.node('composerMore').fire('click');assert.equal(h.node('composerExtraTools').hidden,false,'one click must open rather than toggle twice');
 second.destroy();assert.equal(h.footer.querySelector('.composer-primary-row'),null);assert.ok(h.node('lateExtension'));assert.equal(h.node('composerModel').parentElement,h.records.get('composerModel').host);
 h.api.init();assert.equal(h.footer.querySelectorAll('.composer-primary-row').length,1);h.node('composerModel').fire('click');assert.deepEqual(h.actions,['composerModel']);assert.equal(h.input.value,'尚未提交的输入法草稿');
});
