'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../app/message-actions.js'),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
class Button extends EventTarget {
  dataset={};isConnected=true;disabled=false;attributes=new Map();textContent='Copy';title='';
  getAttribute(name){return this.attributes.has(name)?this.attributes.get(name):null;}
  setAttribute(name,value){this.attributes.set(name,String(value));}
  removeAttribute(name){this.attributes.delete(name);}
  closest(){return this.wrapper;}
}
class Input extends EventTarget {
  value='原有草稿';isConnected=true;focusCount=0;
  focus(){this.focusCount++;}setSelectionRange(start,end){this.selection=[start,end];}
}
function environment(){
 const timers=new Map();let nextTimer=0;
 const env={Date,setTimeout(fn){const id=++nextTimer;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);}};
 vm.createContext(env);vm.runInContext(source,env);
 return{env,api:env.MessageActions,timers,flush(){for(const [id,fn] of [...timers]){timers.delete(id);fn();}}};
}
function quoteFixture(){
 const h=environment(),message={id:'answer',role:'agent',text:'第一段\n\n需要追问的段落\n第二行\n\n末段'},changes=[];
 const anchor={},focus={},body={hidden:false,isConnected:true,textContent:'第一段\n\n需要追问的段落\n第二行\n\n末段',contains:node=>node===anchor||node===focus};
 const wrapper={dataset:{messageId:message.id},classList:{contains:name=>name==='live-message'&&h.live},querySelector:selector=>selector.includes('message-body')?body:bar};
 const old={dataset:{copyMessage:message.text},textContent:'复制',title:'',remove(){bar.childNodes=bar.childNodes.filter(item=>item!==old);}};
 const bar={childNodes:[old],querySelectorAll:()=>[old],append(host){this.childNodes.push(host);host.parentElement=this;h.host=host;}};
 wrapper.ownerDocument={createElement(){return{querySelectorAll(){return this.slots;},remove(){},className:''};}};
 h.env.HalaskaUI={mount(host,name,props){host.slots=props.actions.map(action=>{const button=new Button();button.wrapper=wrapper;return{dataset:{messageActionKey:action.key},querySelector:()=>button};});}};
 h.selection={isCollapsed:false,rangeCount:1,anchorNode:anchor,focusNode:focus,toString:()=> '需要追问的段落\n第二行'};
 h.env.getSelection=()=>h.selection;
 assert.equal(h.api.enhance(wrapper,message,{sourceText:message.text}),true);
 h.button=h.host.slots.find(slot=>slot.dataset.messageActionKey==='quoteMessage').querySelector();
 Object.assign(h,{message,body,wrapper,input:new Input(),conversation:{id:'chat',messages:[message],draftAttachmentIds:['pdf'],queuedMessages:[{text:'队列'}]},changes});
 h.controller=h.api.createQuoteController({getConversation:()=>h.conversation,getInput:()=>h.input,onChange:value=>changes.push(value)});
 h.activate=(type='pointerdown',extra={})=>{const event=new Event(type);Object.assign(event,{button:0,key:'Enter',...extra});h.button.dispatchEvent(event);};
 h.quote=()=>h.controller.request('answer',{selection:h.api.takeQuoteSelection(h.button)});
 return h;
}

test('actual enhance activation retains a selected paragraph across native click selection collapse',()=>{
 const h=quoteFixture();h.activate();h.selection={isCollapsed:true,rangeCount:0};
 assert.equal(h.quote().ok,true);
 assert.equal(h.input.value,'原有草稿\n\n> 需要追问的段落\n> 第二行\n\n');
 assert.equal(h.changes.length,1);assert.equal(h.input.focusCount,1);
 assert.deepEqual(h.conversation.draftAttachmentIds,['pdf']);assert.deepEqual(h.conversation.queuedMessages,[{text:'队列'}]);
 assert.equal(h.message.text,'第一段\n\n需要追问的段落\n第二行\n\n末段');
 // Consumed activation cannot quote the old selection for the next click.
 h.input.value='';assert.equal(h.quote().ok,true);assert.match(h.input.value,/第一段/);assert.match(h.input.value,/末段/);
 h.controller.destroy();
});
test('keyboard activation captures the same selection without manufacturing pointer or focus events',()=>{
 const h=quoteFixture();h.activate('keydown',{key:' '});h.selection={isCollapsed:true,rangeCount:0};
 assert.equal(h.quote().ok,true);assert.doesNotMatch(h.input.value,/第一段|末段/);h.controller.destroy();
});
test('cross-message, outside-body, multi-range and live-body selections fail without falling back to the entire message',()=>{
 for(const change of [h=>h.selection.focusNode={},h=>h.selection.anchorNode={},h=>h.selection.rangeCount=2,h=>h.live=true,h=>h.body.hidden=true]){
  const h=quoteFixture();change(h);h.activate();assert.equal(h.quote().ok,false);assert.equal(h.input.value,'原有草稿');assert.equal(h.changes.length,0);h.controller.destroy();
 }
});
test('a stale rendered message cannot lend its selection to a changed canonical message',()=>{
 const h=quoteFixture();h.message.text='新版本，与画面不同';h.activate();assert.equal(h.quote().ok,false);
 assert.equal(h.input.value,'原有草稿');h.controller.destroy();
});
test('selected quote waits for final IME input and retains exact selected text',()=>{
 const h=quoteFixture();h.input.dispatchEvent(new Event('compositionstart'));h.activate();assert.equal(h.quote().queued,true);
 assert.equal(h.input.value,'原有草稿');h.input.dispatchEvent(new Event('compositionend'));h.input.value+=' 输入法确认';h.flush();
 assert.equal(h.input.value,'原有草稿 输入法确认\n\n> 需要追问的段落\n> 第二行\n\n');h.controller.destroy();
});
test('queued selected quotes recheck body, version, record, owner and input before touching the final draft',()=>{
 const changes=[h=>h.body.textContent+=' changed',h=>h.message.text+=' changed',h=>h.body.isConnected=false,
  h=>h.message.deletedAt=1,h=>h.conversation={...h.conversation,id:'different'},h=>h.input=new Input()];
 for(const change of changes){
  const h=quoteFixture(),input=h.input;input.dispatchEvent(new Event('compositionstart'));h.activate();h.quote();input.dispatchEvent(new Event('compositionend'));change(h);h.flush();
  assert.equal(input.value,'原有草稿');assert.equal(h.input.value,'原有草稿');assert.equal(h.changes.length,0);h.controller.destroy();
 }
});
test('expired or mismatched selected-message identity is rejected instead of silently quoting everything',()=>{
 const h=quoteFixture();const selection=h.api.selectedQuote(h.button);selection.messageId='other';
 assert.equal(h.controller.request('answer',{selection}).ok,false);
 h.activate();h.env.Date={now:()=>Date.now()+3000};assert.equal(h.quote().ok,false);assert.equal(h.input.value,'原有草稿');h.controller.destroy();
});

function copyFixture(options={}){
 const h=environment(),target=new Button(),gate=deferred(),writes=[],successes=[],failures=[],cleared=[];
 target.dataset.copyMessage='完整消息与来源';h.context='chat-a:route-1';
 const controller=h.api.createCopyController({getContext:()=>h.context,writeText:text=>{writes.push(text);return gate.promise;},
  onSuccess:button=>successes.push(button),onError:error=>failures.push(error.message),clearFeedback:button=>cleared.push(button),...options});
 return Object.assign(h,{target,gate,writes,successes,failures,cleared,controller});
}
test('clipboard pending and confirmed feedback both suppress duplicate writes, then release for a new request',async()=>{
 const h=copyFixture();h.target.setAttribute('aria-disabled','false');const first=h.controller.request(h.target);
 assert.equal(h.target.getAttribute('aria-busy'),'true');assert.equal(h.target.getAttribute('aria-disabled'),'true');
 assert.equal(h.successes.length,0);assert.equal((await h.controller.request(h.target)).reason,'pending');assert.equal(h.writes.length,1);
 h.gate.resolve();assert.equal((await first).ok,true);assert.equal(h.successes.length,1);assert.equal(h.target.getAttribute('aria-busy'),null);assert.equal(h.target.getAttribute('aria-disabled'),'false');
 assert.equal((await h.controller.request(h.target)).reason,'pending');assert.equal(h.writes.length,1);
 h.flush();assert.equal((await h.controller.request(h.target)).ok,true);assert.equal(h.writes.length,2);h.controller.destroy();
});
test('unavailable, synchronous failure, rejected or unacknowledged clipboard never shows success and is retryable',async()=>{
 for(const writeText of [()=>undefined,()=>{throw Error('Denied');},()=>Promise.reject(Error('Denied')),()=>Promise.resolve(false)]){
  const h=copyFixture({writeText});assert.equal((await h.controller.request(h.target)).reason,'failed');assert.equal(h.successes.length,0);assert.equal(h.failures.length,1);
  assert.equal(h.target.getAttribute('aria-busy'),null);assert.equal(h.target.getAttribute('aria-disabled'),null);
  assert.equal((await h.controller.request(h.target)).reason,'failed');assert.equal(h.failures.length,2);h.controller.destroy();
 }
});
test('late clipboard acknowledgement cannot announce success after detach, navigation or message refresh',async()=>{
 for(const change of [h=>h.target.isConnected=false,h=>h.context='chat-b:route-2',h=>h.target.dataset.copyMessage='new body',h=>h.context='chat-a:route-3']){
  const h=copyFixture(),pending=h.controller.request(h.target);change(h);h.gate.resolve();assert.equal((await pending).reason,'stale');
  assert.equal(h.successes.length,0);assert.equal(h.failures.length,0);assert.equal(h.timers.size,0);assert.equal(h.target.getAttribute('aria-busy'),null);h.controller.destroy();
 }
});
test('destroy releases pending accessibility state and prevents late success or failure feedback',async()=>{
 for(const fails of [false,true]){
  const h=copyFixture(),pending=h.controller.request(h.target);h.controller.destroy();assert.equal(h.target.getAttribute('aria-busy'),null);
  if(fails)h.gate.reject(Error('Denied'));else h.gate.resolve();assert.equal((await pending).reason,'stale');
  assert.equal(h.successes.length,0);assert.equal(h.failures.length,0);assert.equal(h.cleared.length,1);assert.equal(h.timers.size,0);
  assert.equal((await h.controller.request(h.target)).reason,'destroyed');
 }
});
test('independent buttons can copy independently; failed visual feedback does not reverse a real clipboard success',async()=>{
 const h=copyFixture({onSuccess(){throw Error('UI gone');}}),second=new Button();second.dataset.copyMessage='other';
 const one=h.controller.request(h.target),two=h.controller.request(second);assert.deepEqual(h.writes,['完整消息与来源','other']);h.gate.resolve();
 assert.equal((await one).ok,true);assert.equal((await two).ok,true);assert.equal(h.failures.length,0);h.controller.destroy();assert.equal(h.timers.size,0);
});
