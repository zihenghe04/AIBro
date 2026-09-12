const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Native = require('../native-glass-ui');
const tick = async () => { for (let n=0;n<8;n++) await Promise.resolve(); };
function deferred() { let resolve,reject; const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject}; }
function classes(initial=[]) { const values=new Set(initial);return {values,contains:n=>values.has(n),add:(...names)=>names.forEach(n=>values.add(n)),remove:(...names)=>names.forEach(n=>values.delete(n)),toggle:(n,on)=>on?values.add(n):values.delete(n)}; }
function eventTarget(extra={}) { const listeners=new Map();return {...extra,listeners,addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeEventListener(name,fn){listeners.get(name)?.delete(fn);},emit(name,event={}){for(const fn of listeners.get(name)||[])fn(event);}}; }
function harness(options={}) {
  const nodes=new Map(),timers=new Map(),calls=[],glassCalls=[],queries=[];let timerId=0,resize,mutate;
  function element(selector,left,top,width,height) { const attrs=new Map();const el={nodeType:1,isConnected:true,hidden:false,selector,attrs,rect:{left,top,width,height},style:{display:'block',visibility:'visible'},getBoundingClientRect(){return this.rect;},setAttribute(k,v){attrs.set(k,v);},removeAttribute(k){attrs.delete(k);},closest(){return null;},matches(s){return s.split(',').map(x=>x.trim()).includes(selector);},querySelector(){return null;}};nodes.set(selector,el);return el; }
  element('#sidebar',0,0,220,900);element('#conversationNavigator',220,8,240,884);element('.topbar',460,8,972,48);element('#composer',510,700,800,170);
  const root={classList:classes()},body={dataset:{view:'agent'},classList:classes(['light-mode']),children:[],append(el){this.children.push(el);}};
  const document=eventTarget({body,documentElement:root,hidden:false,querySelector:s=>nodes.get(s)||null,querySelectorAll:s=>s.split(',').map(x=>nodes.get(x.trim())).filter(Boolean),createElementNS:(_ns,name)=>({name,attrs:new Map(),style:{},children:[],setAttribute(k,v){this.attrs.set(k,v);},append(el){this.children.push(el);},remove(){this.removed=true;}})});
  const env=eventTarget({document,innerWidth:1440,innerHeight:900,getComputedStyle:el=>el.style,setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),ResizeObserver:class{constructor(fn){resize=fn;}observe(){}unobserve(){}disconnect(){this.disconnected=true;}},MutationObserver:class{constructor(fn){mutate=fn;}observe(){}disconnect(){this.disconnected=true;}},matchMedia:query=>{const q=eventTarget({matches:false,media:query});queries.push(q);return q;}});
  const bridge={status:()=>options.status?options.status():Promise.resolve({supported:true,active:false,regions:0}),setRegions:regions=>{calls.push(structuredClone(regions));return options.setRegions?options.setRegions(regions,calls.length):Promise.resolve({supported:true,active:regions.length>0,regions:regions.length});}};
  const controller=Native.createController({bridge,glass:{setNativeActive:v=>glassCalls.push(v)}},env);
  const flush=async()=>{for(let n=0;n<6;n++){const jobs=[...timers.values()];timers.clear();jobs.forEach(fn=>fn());await tick();if(!timers.size)break;}};
  return {controller,env,document,root,body,nodes,element,calls,glassCalls,queries,timers,flush,resize:()=>resize?.(),mutate:r=>mutate?.(r),active:()=>root.classList.contains('native-liquid-glass')};
}

test('geometry clips viewport, skips invalid bounds, and produces bounded native regions',()=>{
  assert.deepEqual(Native.clippedRect({left:-4,top:10,width:100,height:80},{width:80,height:60}),{x:0,y:10,width:80,height:50});
  assert.equal(Native.clippedRect({left:NaN,top:0,width:2,height:2},{width:80,height:60}),null);
  assert.equal(Native.clippedRect({left:90,top:0,width:2,height:2},{width:80,height:60}),null);
  const h=harness();const {regions}=Native.collectRegions(h.document,h.env);assert.equal(regions.length,4);assert.deepEqual(regions[0],{id:'sidebar',x:8,y:8,width:207,height:884,radius:23,style:'regular'});
  for(const r of regions){assert.ok(r.x>=0&&r.y>=0);assert.ok(r.x+r.width<=1440&&r.y+r.height<=900);assert.ok(r.radius<=Math.min(r.width,r.height)/2);}
  h.controller.destroy();
});
test('only successful activation reveals the material; startup rejection keeps CSS fallback',async()=>{
  const pending=deferred();const h=harness({setRegions:(regions)=>regions.length?pending.promise:Promise.resolve({supported:true,active:false,regions:0})});await tick();assert.equal(h.active(),false);assert.equal(h.glassCalls.length,0);
  pending.resolve({supported:true,active:true,regions:4});await h.controller.ready;assert.equal(h.active(),true);assert.deepEqual(h.glassCalls,[true]);assert.equal(h.nodes.get('#composer').attrs.get('data-native-glass-region'),'composer');h.controller.destroy();await tick();assert.equal(h.active(),false);
  const failure=harness({status:()=>Promise.reject(new Error('no bridge'))});await failure.controller.ready;assert.equal(failure.active(),false);assert.equal(failure.calls.length,0);failure.controller.destroy();
});
test('unsupported runtime never starts region updates or leaves transparent controls',async()=>{
  const h=harness({status:()=>Promise.resolve({supported:false,active:false,regions:0,reason:'platform'})});await h.controller.ready;h.controller.refresh();h.env.emit('resize');await h.flush();assert.equal(h.calls.length,0);assert.equal(h.active(),false);h.controller.destroy();
  const absent=Native.createController({},{});assert.equal((await absent.ready).supported,false);
});
test('reader header unions toolbar and tabs; hidden or non-agent regions disappear',async()=>{
  const h=harness();await h.controller.ready;h.element('.reading-toolbar',900,8,530,47);h.element('.reading-tabs',900,55,530,41);
  h.nodes.get('#conversationNavigator').hidden=true;h.body.dataset.view='project';h.controller.refresh();await h.flush();const regions=h.calls.at(-1);assert.equal(regions.some(r=>r.id==='composer'||r.id==='navigator'),false);assert.deepEqual(regions.at(-1),{id:'reader-header',x:900,y:8,width:530,height:88,radius:16,style:'regular'});
  assert.equal(h.nodes.get('.reading-tabs').attrs.get('data-native-glass-region'),'reader-header');h.controller.destroy();
});
test('many resize signals coalesce, unchanged geometry does not IPC, and streaming text is ignored',async()=>{
  const h=harness();await h.controller.ready;h.nodes.get('#composer').rect.width=660;
  for(let n=0;n<100;n++)h.resize();assert.equal(h.active(),false);assert.equal(h.timers.size,1);await h.flush();assert.equal(h.calls.length,2);assert.equal(h.active(),true);
  for(let n=0;n<100;n++)h.mutate([{type:'childList',target:{},addedNodes:[{nodeType:3}],removedNodes:[]}]);assert.equal(h.timers.size,0);assert.equal(h.calls.length,2);
  h.resize();await h.flush();assert.equal(h.calls.length,2);h.controller.destroy();
});
test('CSS controller class bookkeeping does not cause a native feedback loop',async()=>{
  const h=harness();await h.controller.ready;h.body.classList.add('liquid-glass-static');h.mutate([{type:'attributes',target:h.body,attributeName:'class'}]);assert.equal(h.timers.size,0);assert.equal(h.calls.length,1);
  h.body.classList.add('reading-open');h.nodes.get('#conversationNavigator').hidden=true;h.mutate([{type:'attributes',target:h.body,attributeName:'class'}]);await h.flush();assert.equal(h.calls.length,2);h.controller.destroy();
});
test('late native activation is not exposed after layout changed; only latest geometry activates',async()=>{
  const pending=deferred();const h=harness({setRegions:(regions,index)=>index===1?pending.promise:Promise.resolve({supported:true,active:regions.length>0,regions:regions.length})});await tick();h.nodes.get('#composer').rect.width=500;h.controller.refresh();pending.resolve({supported:true,active:true,regions:4});await h.controller.ready;assert.equal(h.active(),false);await h.flush();assert.equal(h.active(),true);assert.equal(h.calls.at(-1).find(r=>r.id==='composer').width,500);h.controller.destroy();
});
test('reduced transparency clears native views and resumes native only after a new successful acknowledgement',async()=>{
  const h=harness();await h.controller.ready;for(const q of h.queries){q.matches=true;q.emit('change');assert.equal(h.active(),false);await h.flush();assert.deepEqual(h.calls.at(-1),[]);assert.equal(h.glassCalls.at(-1),false);q.matches=false;q.emit('change');await h.flush();assert.equal(h.active(),true);}h.controller.destroy();
});
test('resize dragging and hidden document clear regions, and stop creates no polling loop',async()=>{
  const h=harness();await h.controller.ready;h.body.classList.add('workspace-resizing');h.mutate([{type:'attributes',target:h.body}]);await h.flush();assert.deepEqual(h.calls.at(-1),[]);assert.equal(h.timers.size,0);
  h.body.classList.remove('workspace-resizing');h.document.emit('pointerup');await h.flush();assert.equal(h.active(),true);h.document.hidden=true;h.document.emit('visibilitychange');await h.flush();assert.deepEqual(h.calls.at(-1),[]);assert.equal(h.active(),false);h.controller.destroy();
});
test('destruction during in-flight activation clears after the response and cannot reactivate',async()=>{
  const pending=deferred();const h=harness({setRegions:(regions,index)=>index===1?pending.promise:Promise.resolve({supported:true,active:false,regions:0})});await tick();h.controller.destroy();assert.equal(h.active(),false);pending.resolve({supported:true,active:true,regions:4});await h.controller.ready;await tick();assert.deepEqual(h.calls.at(-1),[]);assert.equal(h.active(),false);assert.equal(h.timers.size,0);assert.ok(h.glassCalls.every(value=>!value));
});
test('native failures or malformed acknowledgements keep opaque fallback and clear stale views',async()=>{
  for(const result of ['reject',{supported:true,active:true,regions:99},{supported:true,active:false,regions:0,reason:'native-failure'}]){
    const h=harness({setRegions:(regions,index)=>index===1?(result==='reject'?Promise.reject(new Error('failure')):Promise.resolve(result)):Promise.resolve({supported:true,active:false,regions:0})});await h.controller.ready;assert.equal(h.active(),false);assert.deepEqual(h.calls.at(-1),[]);assert.equal(h.glassCalls.includes(true),false);h.controller.destroy();
  }
});
test('native CSS only exposes acknowledged surfaces and protects solid reading planes and reduced transparency',()=>{
  const css=fs.readFileSync(require.resolve('../native-glass-ui.css'),'utf8');assert.match(css,/html\.native-liquid-glass/);assert.match(css,/\[data-native-glass-region\]/);assert.match(css,/#previewDialog \{background:var\(--lg-content\)\}/);assert.match(css,/prefers-reduced-transparency/);assert.match(css,/forced-colors/);assert.match(css,/message-list[\s\S]*?mask-image/);
  assert.doesNotMatch(css,/[;{]\s*(?:transform|filter)\s*:/);assert.match(css,/backdrop-filter:none/);assert.match(css,/mask-composite:intersect/);
});

test('the opaque shell is present before activation and updates only to acknowledged rounded holes',async()=>{
  const h=harness();await h.controller.ready;const shell=h.body.children.find(el=>el.id==='nativeGlassShell');assert.ok(shell);assert.equal(shell.style.display,'block');assert.equal(shell.attrs.get('aria-hidden'),'true');assert.equal(shell.children[0].attrs.get('fill-rule'),'evenodd');
  assert.equal(shell.children[0].attrs.get('d'),Native.shellPath(h.calls[0],1440,900));assert.ok(shell.children[0].attrs.get('d').startsWith('M0 0H1440V900H0Z'));
  h.body.dataset.view='research';h.controller.refresh();assert.equal(shell.style.display,'none');await h.flush();assert.equal(shell.style.display,'block');assert.equal(shell.children[0].attrs.get('d'),Native.shellPath(h.calls.at(-1),1440,900));assert.equal(h.calls.at(-1).some(region=>region.id==='composer'),false);
  h.controller.destroy();assert.equal(shell.removed,true);assert.equal(shell.style.display,'none');
});

test('native text scrims guarantee 4.5 contrast on the worst possible external background in both themes',()=>{
  const css=fs.readFileSync(require.resolve('../native-glass-ui.css'),'utf8'),fallback=fs.readFileSync(require.resolve('../liquid-glass.css'),'utf8');
  const luminance=rgb=>rgb.map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
  for(const [suffix,external] of [['',255],['.light-mode',0]]){
    const selector=`body.liquid-glass[data-view]${suffix} {`,start=fallback.indexOf(selector),block=fallback.slice(start,fallback.indexOf('}',start));
    const pattern=role=>new RegExp(`body\\.liquid-glass\\[data-view\\]${suffix.replaceAll('.','\\.')} \\{[^}]*--native-${role}-scrim:rgba\\((\\d+),(\\d+),(\\d+),([.\\d]+)\\)`).exec(css);
    const material=pattern('content'),edge=pattern('edge');assert.ok(material&&edge);
    const alpha=Number(material[4]),edgeAlpha=Number(edge[4]),rim=edge.slice(1,4).map(n=>Number(n)*edgeAlpha+external*(1-edgeAlpha));
    const base=material.slice(1,4).map((n,i)=>Number(n)*alpha+rim[i]*(1-alpha));
    assert.ok(Math.max(...rim.map((n,i)=>Math.abs(n-base[i])))<16,'native highlight is softly attenuated, not an extreme outline');
    for(const role of ['text','muted','faint']){
      const hex=new RegExp(`--${role}:#([a-f0-9]{6});`).exec(block)[1],fg=hex.match(/../g).map(n=>parseInt(n,16)),ls=[luminance(fg),luminance(base)].sort((a,b)=>b-a);assert.ok((ls[0]+.05)/(ls[1]+.05)>=4.5,`${suffix||'dark'} ${role}`);
    }
  }
  assert.match(css,/#nativeGlassShell[^}]*fill:var\(--bg\)/);assert.match(css,/--native-feather-x:linear-gradient/);assert.match(css,/pointer-events:none/);
});
