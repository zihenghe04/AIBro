const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function harness(){
 const sent=[],frames=[],listeners={},elements=[],classes=new Set();let modal=null;
 const make=(rect)=>{const e={rect,hidden:false,attrs:{},getClientRects(){return this.hidden?[]:[this.rect]},closest(){return null},getBoundingClientRect(){return this.rect},setAttribute(k,v){this.attrs[k]=v},removeAttribute(k){delete this.attrs[k]}};elements.push(e);return e};
 const composer=make({left:20,top:400,right:620,bottom:550,width:600,height:150});
 const toolbar=make({left:630,top:0,right:930,bottom:40,width:300,height:40});
 const tabs=make({left:630,top:40,right:930,bottom:80,width:300,height:40});
 const document={body:{},documentElement:{classList:{toggle(k,v){v?classes.add(k):classes.delete(k)}}},
 querySelector(s){return s.startsWith('dialog')?modal:s==='#composer'?composer:s==='.reading-toolbar'?toolbar:tabs},
 querySelectorAll(s){return s==='[data-appkit-glass]'?elements.filter(e=>e.attrs['data-appkit-glass']):elements},addEventListener(k,f){listeners[k]=f}};
 const window={webkit:{messageHandlers:{glassRegions:{postMessage(v){sent.push(JSON.parse(JSON.stringify(v)))}}}},addEventListener(k,f){listeners[k]=f}};
 const observer=class{observe(){}};
 vm.runInNewContext(fs.readFileSync('native/Resources/glass-regions.js','utf8'),{document,window,ResizeObserver:observer,MutationObserver:observer,requestAnimationFrame:f=>frames.push(f),matchMedia:()=>({addEventListener(){}}),getComputedStyle:()=>({visibility:'visible'}),performance:{now:()=>1000}});
 const tick=()=>{const f=frames.shift();if(f)f()};
 return {document,make,sent,frames,classes,composer,toolbar,tabs,window,listeners,tick,modal(){modal=make({left:100,top:100,right:500,bottom:500,width:400,height:400});return modal},close(){modal=null}};
}
test('sends only geometry, unions reader chrome and avoids duplicate frames',()=>{
 const h=harness();h.tick();assert.equal(h.sent.length,1);assert.deepEqual(h.sent[0].map(x=>x.id),['composer','reader']);assert.equal(h.sent[0][1].height,80);assert.equal(h.sent[0][1].radius,0);assert.deepEqual(Object.keys(h.sent[0][0]),['id','x','y','width','height','radius']);h.listeners.resize();h.tick();assert.equal(h.sent.length,1);
});
test('material CSS waits for native acknowledgement and reverts on fallback',()=>{
 const h=harness();h.tick();assert.equal(h.composer.attrs['data-appkit-glass'],undefined);h.window.NativeGlassSurface.acknowledge(true);assert.equal(h.composer.attrs['data-appkit-glass'],'composer');h.window.NativeGlassSurface.acknowledge(false);assert.equal(h.classes.size,0);assert.equal(h.composer.attrs['data-appkit-glass'],undefined);
});
test('modal replaces background materials; closing restores composer and reader',()=>{
 const h=harness();h.tick();const modal=h.modal();h.window.NativeGlassSurface.refresh();h.tick();assert.deepEqual(h.sent.at(-1).map(x=>x.id),['modal']);h.window.NativeGlassSurface.acknowledge(true);assert.equal(modal.attrs['data-appkit-glass'],'modal');assert.equal(h.composer.attrs['data-appkit-glass'],undefined);h.close();h.window.NativeGlassSurface.refresh();h.tick();assert.deepEqual(h.sent.at(-1).map(x=>x.id),['composer','reader']);
});
test('hidden regions clear and resize/scroll updates preserve CSS point coordinates',()=>{
 const h=harness();h.tick();h.composer.rect.left=42;h.listeners.scroll();h.tick();assert.equal(h.sent.at(-1)[0].x,42);h.composer.hidden=h.toolbar.hidden=h.tabs.hidden=true;h.listeners.resize();h.tick();assert.deepEqual(h.sent.at(-1),[]);
});

test('focused top modal owns native material even when another dialog appears first in DOM',()=>{
 const h=harness();h.tick();const behind=h.modal(),front=h.make({left:200,top:120,right:700,bottom:600,width:500,height:480});
 h.document.activeElement={closest:()=>front};h.listeners.focusin();h.tick();h.window.NativeGlassSurface.acknowledge(true);
 assert.equal(h.sent.at(-1)[0].x,200);assert.equal(front.attrs['data-appkit-glass'],'modal');assert.equal(behind.attrs['data-appkit-glass'],undefined);
 h.document.activeElement={closest:()=>behind};h.listeners.focusin();h.tick();assert.equal(h.sent.at(-1)[0].x,100);assert.equal(front.attrs['data-appkit-glass'],undefined);
});
