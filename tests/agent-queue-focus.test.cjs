// Real queue controller/context/persistence, with a synthetic focus/event surface.
// No GUI, provider, user workspace, or real IME is exercised here.
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const requireContext=createRequire(path.join(__dirname,'../app/queue-context.js'));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const turn=()=>new Promise(setImmediate);
async function fixture(){
 const c={id:'c',draft:'Untouched composer',draftAttachmentIds:['draft-pdf'],pendingSubmits:[{id:'one',goal:'Queued source',attachmentIds:[],fileReferences:[],skillSnapshot:[]},{id:'two',goal:'Next item',attachmentIds:[],fileReferences:[],skillSnapshot:[]}]};
 const other={id:'other',pendingSubmits:[{id:'else',goal:'Elsewhere',attachmentIds:[],fileReferences:[],skillSnapshot:[]}]};
 const state={conversations:[c,other],projects:[],imports:[],notes:[],skills:[],settings:{}};
 const listeners=new Map(),nodes=new Map(),storage=new Map();let props,save=async()=>true,saveCount=0;
 const doc={documentElement:{lang:'en'},body:{},hidden:false,hasFocus:()=>true,
  addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},removeEventListener(type,fn){listeners.get(type)?.delete(fn);},
  getElementById:id=>nodes.get(id)};doc.activeElement=doc.body;
 const emit=(type,target,extra={})=>{for(const fn of [...(listeners.get(type)||[])])fn({type,target,...extra});};
 const node=(id,value)=>{if(nodes.has(id))return nodes.get(id);const n={id,value,selectionStart:0,selectionEnd:0,selectionDirection:'none',disabled:false,isConnected:true,
  focus(){if(this.disabled||!this.isConnected)return;doc.activeElement=this;emit('focusin',this);},
  setSelectionRange(a,b,d='none'){this.selectionStart=a;this.selectionEnd=b;this.selectionDirection=d;}};nodes.set(id,n);return n;};
 const composer=node('agentInput',c.draft),search=node('global-search',''),box={isConnected:true,hidden:false,contains:n=>n?.id?.startsWith('queue-')};
 const renderDOM=value=>{props=value;const live=new Set(['agentInput','global-search','queueSendNext']);
  node('queueSendNext');
  for(const item of value.items){for(const action of ['edit','remove','up','down']){const n=node(`queue-${action}-${item.id}`);n.disabled=value.busy||!!value.editingId;live.add(n.id);}
   if(value.editingId===item.id){for(const action of ['text','save','check']){const n=node(`queue-${action}-${item.id}`,action==='text'?value.draft:undefined);n.disabled=value.busy;live.add(n.id);if(action==='text')n.value=value.draft;}}
  }
  for(const n of nodes.values()){n.isConnected=live.has(n.id);if(doc.activeElement===n&&(!n.isConnected||n.disabled))doc.activeElement=doc.body;}
 };
 const env={require:requireContext,console,structuredClone,TextEncoder,URL,document:doc,localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
  HalaskaUI:{componentNames:['QueueSurface'],mount:(_,__,value)=>renderDOM(value),unmount(){}}};
 vm.createContext(env);for(const file of ['agent-queue.js','queue-context.js','agent-queue-ui.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../app',file),'utf8'),env);
 const UI=env.AgentQueueUI;UI.init({getState:()=>state,getConversation:id=>state.conversations.find(c=>c.id===id),save:()=>{saveCount++;return save();},onChanged:()=>{},onSend:()=>assert.fail('Focus repair must never send')});
 const render=(current=c)=>UI.render(box,{conversation:current,canSend:true,hasDraft:true});render();
 const edit=async()=>{props.onEdit('one');while(UI.isBusy())await turn();node('queue-text-one').focus();};
 return{env,UI,c,other,state,doc,emit,node,box,composer,search,listeners,render,edit,get props(){return props;},get saveCount(){return saveCount;},setSave:fn=>save=fn};
}
test('late successful queue save never steals composer focus or IME text/selection',async()=>{
 const f=await fixture();await f.edit();f.props.onDraft('Revised queue');const held=deferred();f.setSave(()=>held.promise);f.node('queue-save-one').focus();const saving=f.props.onCommand({action:'edit',id:'one'});await turn();
 f.composer.focus();f.emit('compositionstart',f.composer);f.composer.value='Untouched composer 输入中';f.composer.setSelectionRange(18,21);held.resolve(true);assert.equal(await saving,true);
 assert.equal(f.doc.activeElement,f.composer);assert.equal(f.composer.value,'Untouched composer 输入中');assert.deepEqual([f.composer.selectionStart,f.composer.selectionEnd],[18,21]);assert.equal(f.c.pendingSubmits[0].goal,'Revised queue');assert.deepEqual(f.c.draftAttachmentIds,['draft-pdf']);assert.equal(f.saveCount,1);
});
test('failed keyboard save returns to same editor selection and keeps the unsaved draft',async()=>{
 const f=await fixture();await f.edit();f.props.onDraft('Keep this queue draft');const input=f.node('queue-text-one');input.focus();input.setSelectionRange(5,9,'backward');const held=deferred();f.setSave(()=>held.promise);const saving=f.props.onCommand({action:'edit',id:'one'});await turn();assert.equal(f.doc.activeElement,f.doc.body);held.resolve(false);assert.equal(await saving,false);
 assert.equal(f.doc.activeElement,input);assert.deepEqual([input.selectionStart,input.selectionEnd,input.selectionDirection],[5,9,'backward']);assert.equal(f.props.draft,'Keep this queue draft');assert.equal(f.c.pendingSubmits[0].goal,'Queued source');assert.match(f.props.error,/could not be saved/);
});
test('moving focus elsewhere then back to body revokes an old save restoration',async()=>{
 const f=await fixture();await f.edit();const held=deferred();f.setSave(()=>held.promise);f.node('queue-save-one').focus();const saving=f.props.onCommand({action:'edit',id:'one'});await turn();f.search.focus();f.doc.activeElement=f.doc.body;held.resolve(false);await saving;assert.equal(f.doc.activeElement,f.doc.body);
});
test('view round-trip, destroyed host, same-ID owner replacement and privacy change invalidate old focus',async()=>{
 for(const mode of ['round-trip','destroy','replace','private']){
  const f=await fixture();await f.edit();const held=deferred();f.setSave(()=>held.promise);f.node('queue-save-one').focus();const saving=f.props.onCommand({action:'edit',id:'one'});await turn();
  if(mode==='round-trip'){f.render(f.other);f.render();}if(mode==='destroy')f.UI.destroy();if(mode==='replace'){f.state.conversations[0]=structuredClone(f.c);f.render(f.state.conversations[0]);}if(mode==='private'){f.c.private=true;f.render();}
  f.doc.activeElement=f.doc.body;held.resolve(true);await saving;assert.equal(f.doc.activeElement,f.doc.body,mode);
 }
});
test('uninterrupted edit save returns to the row; failed button save restores its trigger',async()=>{
 for(const success of [true,false]){const f=await fixture();await f.edit();const button=f.node('queue-save-one');button.focus();f.setSave(async()=>success);await f.props.onCommand({action:'edit',id:'one'});assert.equal(f.doc.activeElement,f.node(success?'queue-edit-one':'queue-save-one'));}
});
test('async focus lease listeners are removed after completion and during destroy',async()=>{
 const f=await fixture();await f.edit();const held=deferred();f.setSave(()=>held.promise);const saving=f.props.onCommand({action:'edit',id:'one'});await turn();assert.ok((f.listeners.get('focusin')?.size||0)>0);f.UI.destroy();assert.equal(f.listeners.get('focusin')?.size||0,0);held.resolve(true);await saving;
 for(const type of ['focusin','pointerdown','keydown','compositionstart','visibilitychange'])assert.equal(f.listeners.get(type)?.size||0,0,type);
});
