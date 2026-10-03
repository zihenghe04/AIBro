'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Actions=require('../app/message-actions.js');
const app=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
const config=app.slice(app.indexOf('const messageCopyController ='),app.indexOf("$('#agentInput').addEventListener('keydown'",app.indexOf('const messageCopyController =')));
function clickSection(marker,endMarker){const start=app.lastIndexOf("document.addEventListener('click', event => {",app.indexOf(marker));const end=app.indexOf(endMarker,start);assert.ok(start>=0&&end>start);return app.slice(start,end+endMarker.length);}
const quoteClick=clickSection('const quoteMessage =', '}, true);');
const copyClick=clickSection("const target = event.target.closest('[data-open-paper]",'\n});');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
class Input extends EventTarget{value='existing draft';isConnected=true;focus(){}setSelectionRange(){}}
class Button{
 constructor(dataset){this.dataset=dataset;this.isConnected=true;this.attributes=new Map();}
 getAttribute(k){return this.attributes.has(k)?this.attributes.get(k):null;}setAttribute(k,v){this.attributes.set(k,String(v));}removeAttribute(k){this.attributes.delete(k);}
 closest(selector){return selector.includes(this.dataset.copyMessage!==undefined?'[data-copy-message]':'[data-quote-message]')?this:null;}
}
function fixture({language='en',feedback=true,writer}={}){
 const gate=deferred(),input=new Input(),events=[],unload=[],writes=[],announcements=[],notices=[],clears=[],copyCalls=[],quoteCalls=[],selections=[];
 const state={ui:{view:'agent'},agentRuns:[],conversations:[{id:'chat',messages:[{id:'m',role:'agent',text:'complete response'}],draftAttachmentIds:['file'],queuedMessages:[{text:'later'}]}]};
 const local={selection:null};
 const MessageActions={...Actions,
  createCopyController(options){const controller=Actions.createCopyController(options),request=controller.request.bind(controller);controller.request=(...args)=>{const promise=request(...args);copyCalls.push(promise);return promise;};return controller;},
  createQuoteController(options){const controller=Actions.createQuoteController(options),request=controller.request.bind(controller);controller.request=(...args)=>{quoteCalls.push(args);return request(...args);};return controller;},
  takeQuoteSelection(button){selections.push(button);return local.selection;}
 };
 const context={state,workspaceRouteIntent:1,conversationPathSaving:()=>false,currentConversation:()=>state.conversations[0],$:()=>input,Event,Core:{},toast:value=>notices.push(value),
  navigator:{clipboard:{writeText(text){writes.push(text);return writer?writer(text):gate.promise;}}},
  window:{MessageActions,WorkstationI18n:{getLanguage:()=>language},FeedbackMotion:{success(button,options){announcements.push({button,...options});return feedback;},clear:button=>clears.push(button)},addEventListener(type,fn){if(type==='unload')unload.push(fn);}},
  document:{addEventListener(type,fn){if(type==='click')events.push(fn);}}
 };
 input.addEventListener('input',()=>{state.conversations[0].draft=input.value;local.inputEvents=(local.inputEvents||0)+1;});
 vm.createContext(context);vm.runInContext(config+'\nglobalThis.controllers={messageCopyController,messageQuoteController};',context);vm.runInContext(quoteClick,context);vm.runInContext(copyClick,context);
 const dispatch=button=>{const e={target:button,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}};events.forEach(fn=>fn(e));return e;};
 return{context,state,input,local,gate,writes,announcements,notices,clears,copyCalls,quoteCalls,selections,dispatch,destroy:()=>unload.forEach(fn=>fn())};
}
test('actual host copy delegate invokes one controller write and language-aware success after clipboard acknowledgement',async()=>{
 const f=fixture(),button=new Button({copyMessage:'full export'});f.dispatch(button);f.dispatch(button);
 assert.equal(f.writes.length,1);assert.equal(f.announcements.length,0);f.gate.resolve();await Promise.all(f.copyCalls);
 assert.equal(f.announcements.length,1);assert.equal(f.announcements[0].label,'Copied');assert.deepEqual(f.notices,[]);f.destroy();
});
test('actual host copy fallback and errors do not depend on an undefined global translation function',async()=>{
 const success=fixture({feedback:false,writer:()=>Promise.resolve()});success.dispatch(new Button({copyMessage:'text'}));await Promise.all(success.copyCalls);assert.deepEqual(success.notices,['Copied to clipboard']);success.destroy();
 const failure=fixture({language:'zh',writer:()=>Promise.reject(Error('Denied'))});failure.dispatch(new Button({copyMessage:'text'}));await Promise.all(failure.copyCalls);assert.deepEqual(failure.notices,['复制失败，请手动选择文本']);assert.equal(failure.announcements.length,0);failure.destroy();
});
test('actual host context stamps invalidate late clipboard success or error after leaving and returning to the same conversation',async()=>{
 for(const failure of [false,true]){
  const f=fixture();f.dispatch(new Button({copyMessage:'text'}));f.context.workspaceRouteIntent+=2;
  if(failure)f.gate.reject(Error('Denied'));else f.gate.resolve();await Promise.all(f.copyCalls);
  assert.equal(f.announcements.length,0);assert.equal(f.notices.length,0);f.destroy();
 }
});
test('actual quote delegate passes the current selected body into the existing input event path only',()=>{
 const f=fixture(),body={textContent:'rendered body',isConnected:true};f.local.selection={messageId:'m',messageText:'complete response',text:'selected paragraph',body,bodyText:body.textContent};
 const button=new Button({quoteMessage:'m'});f.dispatch(button);
 assert.equal(f.selections[0],button);assert.equal(f.quoteCalls[0][1].selection,f.local.selection);
 assert.equal(f.input.value,'existing draft\n\n> selected paragraph\n\n');assert.equal(f.state.conversations[0].draft,f.input.value);assert.equal(f.local.inputEvents,1);
 assert.deepEqual(f.state.conversations[0].draftAttachmentIds,['file']);assert.deepEqual(f.state.conversations[0].queuedMessages,[{text:'later'}]);assert.equal(f.state.conversations[0].messages.length,1);f.destroy();
});
test('actual quote failure reports localized unavailable state without mutating the draft',()=>{
 for(const language of ['zh','en']){
  const f=fixture({language});f.local.selection={invalid:true};f.dispatch(new Button({quoteMessage:'m'}));
  assert.equal(f.input.value,'existing draft');assert.deepEqual(f.notices,[language==='en'?'This message cannot be quoted right now.':'这条消息当前无法引用。']);f.destroy();
 }
});
test('actual unload hook destroys both controllers and prevents late UI feedback or future quote writes',async()=>{
 const f=fixture();f.dispatch(new Button({copyMessage:'text'}));f.destroy();f.gate.resolve();await Promise.all(f.copyCalls);
 assert.equal(f.announcements.length,0);assert.equal(f.notices.length,0);assert.equal(f.clears.length,1);
 assert.equal(f.context.controllers.messageQuoteController.request('m').reason,'destroyed');assert.equal(f.input.value,'existing draft');
});
