const test=require('node:test'),assert=require('node:assert/strict');
const Tour=require('../app/workspace-tour');
function fixture(options={}){
 const nodes=new Map(),listeners=new Map(),finishes=[],frames=new Map();let frameId=0;
 class Element{
  constructor(tag){this.tagName=tag;this.children=[];this.style={};this.dataset={};this.attributes={};this.hidden=false;this.isConnected=true;this.rect={left:420,top:540,right:1000,bottom:700,width:580,height:160};const classes=new Set();this.classList={add:v=>classes.add(v),remove:v=>classes.delete(v),toggle:(v,on)=>on?classes.add(v):classes.delete(v)};}
  set id(v){this._id=v;nodes.set('#'+v,this);}get id(){return this._id;}
  append(...items){items.forEach(item=>{item.parent=this;this.children.push(item);});}
  setAttribute(k,v){this.attributes[k]=String(v);}getAttribute(k){return this.attributes[k];}
  getBoundingClientRect(){return this.id==='workspaceTourCard'?{width:352,height:430}:this.rect;}
  contains(n){return n===this||this.children.some(c=>c.contains(n));}
  focus(){doc.activeElement=this;}remove(){this.isConnected=false;}
 }
 const doc={createElement:t=>new Element(t),querySelector:s=>nodes.get(s)||null,querySelectorAll:s=>nodes.has(s)?[nodes.get(s)]:[],addEventListener:(k,v)=>listeners.set('doc:'+k,v),removeEventListener:k=>listeners.delete('doc:'+k)};doc.body=new Element('body');
 for(const s of ['#settings .page-heading','#composer','#agentInput','#composerContext','#messageList'])nodes.set(s,new Element('div'));doc.activeElement=nodes.get('#agentInput');
 const state={ui:{},notes:[{id:'n',content:'keep this'}],conversations:[{draft:'unsent'}]};
 const env={document:doc,innerWidth:1280,innerHeight:800,requestAnimationFrame:fn=>{frames.set(++frameId,fn);return frameId;},cancelAnimationFrame:id=>frames.delete(id),addEventListener:(k,v)=>listeners.set('win:'+k,v),removeEventListener:k=>listeners.delete('win:'+k)};
 const api=Tour.createController({getState:()=>state,onFinish:r=>finishes.push(r),...options},env);
 const key=(key,target=nodes.get('#workspaceTourCard'))=>{doc.activeElement=target;let prevented=false;listeners.get('doc:keydown')?.({key,preventDefault(){prevented=true},stopPropagation(){}});return prevented;};
 return {api,state,nodes,doc,env,finishes,listeners,frames,key};
}

test('workspace guide has an independent first-use preference and does not reinterrupt existing records',()=>{
 assert.equal(Tour.shouldStart({ui:{onboarding:{version:1,status:'completed'}}}),true);
 for(const status of ['completed','skipped'])assert.equal(Tour.shouldStart({ui:{workspaceTour:{version:1,status}}}),false);
 assert.equal(Tour.shouldStart({ui:{workspaceTour:{version:0,status:'completed'}}}),false);
});
test('boolean readiness must become true before automatic startup',async()=>{let ready=false;const f=fixture({ready:()=>ready});assert.equal(await f.api.maybeStart(),false);assert.equal(f.api.isOpen(),false);ready=true;assert.equal(await f.api.maybeStart(),true);f.api.destroy();});
test('opening, step navigation and Escape do not mutate documents or drafts',async()=>{
 const f=fixture(),before=JSON.stringify(f.state),opener=f.doc.activeElement;await f.api.start();assert.equal(f.api.currentStep(),'conversation');assert.equal(f.key('ArrowRight'),true);assert.equal(f.api.currentStep(),'files');assert.equal(f.key('Escape'),true);assert.equal(f.api.isOpen(),false);assert.equal(JSON.stringify(f.state),before);assert.equal(f.doc.activeElement,opener);assert.deepEqual(f.finishes,[{version:1,status:'skipped',resumeStep:1}]);assert.equal(f.listeners.size,0);
});
test('completion can be replayed while automatic startup stays quiet in this session',async()=>{
 const f=fixture();assert.equal(await f.api.maybeStart(),true);for(let i=0;i<5;i++)f.api.next();assert.deepEqual(f.finishes,[{version:1,status:'completed'}]);assert.equal(await f.api.maybeStart(),false);assert.equal(await f.api.start(),true);assert.equal(f.api.currentStep(),'conversation');f.api.destroy();assert.equal(f.finishes.length,1);
});
test('configuration setup, confirmation modals and live work block automatic interruption',async()=>{
 const f=fixture({isBusy:()=>true});assert.equal(await f.api.maybeStart(),false);assert.equal(f.api.isWaiting(),true);
 const g=fixture();g.nodes.set('dialog:modal, .note-document-leave:not([hidden])',{});assert.equal(await g.api.start(),false);assert.equal(g.api.isOpen(),false);g.nodes.delete('dialog:modal, .note-document-leave:not([hidden])');assert.equal(await g.api.maybeStart(),true);g.api.destroy();
});
test('arrows in the message editor are not hijacked and modal Escape stays with its owner',async()=>{
 const f=fixture();await f.api.start();assert.equal(f.key('ArrowRight',f.nodes.get('#agentInput')),false);assert.equal(f.api.currentStep(),'conversation');f.nodes.set('dialog:modal, .note-document-leave:not([hidden])',{});assert.equal(f.key('Escape'),false);assert.equal(f.api.isOpen(),true);f.api.destroy();
});
test('late asynchronous setup cannot reopen a closed or destroyed guide',async()=>{
 let resolve;const p=new Promise(r=>resolve=r),f=fixture({showWorkspace:()=>p});const opening=f.api.start();f.api.destroy();resolve();assert.equal(await opening,false);assert.equal(f.api.isOpen(),false);assert.equal(f.finishes.length,0);
});
test('browser capabilities are truthful when the native bridge is absent',async()=>{
 const f=fixture({browserAvailable:()=>false});await f.api.start();f.api.go(4);assert.match(f.nodes.get('#workspaceTourBody').textContent,/当前运行环境没有连接/);f.api.destroy();
});
test('hidden anchors are skipped and resize recomputes the live target rectangle',async()=>{
 const f=fixture();f.nodes.get('#composer').hidden=true;f.nodes.get('#agentInput').rect={left:100,top:120,right:450,bottom:170,width:350,height:50};await f.api.start();assert.equal(f.nodes.get('#workspaceTourSpotlight').style.left,'95px');f.nodes.get('#agentInput').rect.left=150;f.api.layout();assert.equal(f.nodes.get('#workspaceTourSpotlight').style.left,'145px');f.api.destroy();
});
test('placement stays on screen in narrow, short and wide windows',()=>{
 for(const [width,height] of [[320,480],[390,320],[800,900],[1600,900]])for(const anchor of [null,{left:40,top:30,right:200,bottom:130},{left:900,top:600,right:1300,bottom:890}]){const p=Tour.placement(anchor,{width:352,height:430},{width,height});assert.ok(p.left>=14&&p.top>=14);assert.ok(p.left+p.width<=width-14);assert.ok(p.maxHeight<=height-28);}
});


test('manual replay switches away from setup, while automatic startup waits',async()=>{
 const f=fixture(),layer={};let closed=0;
 f.nodes.set('#onboardingLayer:not([hidden])',layer);
 f.env.WorkstationOnboarding={close:(status,options)=>{assert.equal(status,'skipped');assert.equal(options.restoreFocus,false);closed++;f.nodes.delete('#onboardingLayer:not([hidden])');}};
 assert.equal(await f.api.maybeStart(),false);assert.equal(closed,0);
 assert.equal(await f.api.start(),true);assert.equal(closed,1);assert.equal(f.api.currentStep(),'conversation');f.api.destroy();
});
test('manual replay reports a blocking modal without closing setup or changing drafts',async()=>{
 const errors=[],f=fixture({onError:text=>errors.push(text)}),before=JSON.stringify(f.state);
 f.nodes.set('dialog:modal, .note-document-leave:not([hidden])',{});
 f.env.WorkstationOnboarding={close:()=>{throw Error('Must preserve active decisions');}};
 assert.equal(await f.api.start(),false);assert.match(errors[0],/弹窗/);assert.equal(JSON.stringify(f.state),before);f.api.destroy();
});


test('blocked replay feedback follows the selected interface language',async()=>{
 const errors=[],f=fixture({onError:text=>errors.push(text)});f.env.WorkstationI18n={getLanguage:()=> 'en'};
 f.nodes.set('dialog:modal, .note-document-leave:not([hidden])',{});
 assert.equal(await f.api.start(),false);assert.match(errors[0],/Finish or close the current dialog/);f.api.destroy();
});
test('leaving the page or clicking outside tucks the tour away and settings resume the same step',async()=>{
 const toasts=[],f=fixture({toast:t=>toasts.push(t)}),card=f.nodes.get('#workspaceTourCard'),spot=f.nodes.get('#workspaceTourSpotlight');
 await f.api.start();f.api.go(2);f.listeners.get('doc:pointerdown')({target:card.children[0]});assert.equal(f.api.isOpen(),true);
 assert.equal(f.api.routeChanged('agent'),false);assert.equal(f.api.isOpen(),true);
 assert.equal(f.api.routeChanged('captures'),true);assert.equal(f.api.isOpen(),false);assert.equal(spot.hidden,true);assert.equal(f.nodes.get('#workspaceTour').hidden,true);assert.equal(f.listeners.size,0);
 assert.deepEqual(f.finishes.at(-1),{version:1,status:'skipped',resumeStep:2});assert.match(toasts.at(-1),/设置/);f.state.ui.workspaceTour=f.finishes.at(-1);
 await f.api.start();assert.equal(f.api.currentStep(),'review');
 f.listeners.get('doc:pointerdown')({target:f.nodes.get('#composer')});assert.equal(f.api.isOpen(),false);assert.equal(spot.hidden,true);
 assert.equal(await f.api.maybeStart(),false);
});
test('automatic startup waits on another page instead of navigating the user away',async()=>{
 let view='captures',shown=0;const f=fixture({onWorkspace:()=>view==='agent',showWorkspace:()=>{shown++;}});
 assert.equal(await f.api.maybeStart(),false);assert.equal(f.api.isOpen(),false);assert.equal(f.api.isWaiting(),true);assert.equal(shown,0);
 view='agent';assert.equal(await f.api.maybeStart(),true);assert.equal(f.api.isOpen(),true);
});
test('a location restore right after an automatic start does not dismiss the tour',async()=>{
 const realNow=Date.now;let now=5_000_000;Date.now=()=>now;
 try{const f=fixture();assert.equal(await f.api.maybeStart(),true);now+=500;assert.equal(f.api.routeChanged('dashboard'),false);assert.equal(f.api.isOpen(),true);now+=3000;assert.equal(f.api.routeChanged('captures'),true);assert.equal(f.api.isOpen(),false);}
 finally{Date.now=realNow;}
});
