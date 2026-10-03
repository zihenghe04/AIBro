const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {parseHTML}=require(process.env.AIBRO_TEST_DOM_MODULE||'linkedom');
const rootPath=require('node:path').resolve(__dirname,'../app');
const flush=()=>new Promise(r=>setImmediate(r));
function fixture(){
 const {window}=parseHTML('<!doctype html><html lang="zh-CN"><head></head><body><section id="composer" class="composer-kit"><div class="composer-main"><textarea id="agentInput">旧草稿</textarea></div><div class="composer-primary-row"><span data-composer-control="agentSend"><button id="agentSend">发送</button></span></div><div id="composerExtraTools"></div></section></body></html>');
 const context={document:window.document,Element:window.Element,HTMLElement:window.HTMLElement,Node:window.Node,MutationObserver:window.MutationObserver,Event:window.Event,navigator:{userAgent:'synthetic'},setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask,console,TextEncoder,crypto:require('node:crypto').webcrypto,requestAnimationFrame:fn=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),getComputedStyle:()=>({getPropertyValue:()=>'',display:'block'})};context.window=context;
 let lease=null,cancelled=0,configured=true,settings=0;context.workstationDesktop={dictation:{status:async()=>({available:true,configured}),start:async l=>(lease=l,{status:'recording',...l}),finish:async l=>({status:'completed',text:'语音文字',...l}),cancel:async()=>{cancelled++},bindVerifier:()=>()=>{},openSettings:async()=>{settings++}}};
 vm.createContext(context);for(const file of ['halaska-ui.js','composer-ui.js','composer-dictation.js'])vm.runInContext(fs.readFileSync(rootPath+'/'+file,'utf8'),context,{filename:file});
 const input=window.document.getElementById('agentInput');input.value='旧草稿';input.selectionStart=1;input.selectionEnd=2;let inputEvents=0;input.addEventListener('input',()=>inputEvents++);
 const ctx={available:true,conversationId:'a',workspace:'日常',projectId:null,routeVersion:1};
 const controller=context.ComposerDictation.init({context:()=>({...ctx,inputValue:input.value}),appendDraft:p=>{input.value=p.text;input.dispatchEvent(new window.Event('input',{bubbles:true}));return true;}});
 return{window:context,controller,input,ctx,setConfigured:v=>configured=v,get inputEvents(){return inputEvents},get settings(){return settings},get cancelled(){return cancelled},click:node=>node.dispatchEvent(new window.Event('click',{bubbles:true})),destroy:()=>{context.ComposerDictation.destroy();context.ComposerUI.destroy?.()}};
}
test('production Kit bundle mounts voice actions while retaining actual textarea identity/selection and routes stop to draft',async()=>{
 const h=fixture(),doc=h.window.document;
 const input=h.input;assert.ok(doc.getElementById('composerVoice'));assert.ok(doc.getElementById('composerVoiceSettings'));assert.equal(doc.querySelectorAll('#agentInput').length,1);
 h.click(doc.getElementById('composerVoice'));await flush();assert.match(doc.querySelector('.composer-dictation-status').textContent,/正在录音/);assert.equal(doc.getElementById('agentInput'),input);assert.deepEqual([input.value,input.selectionStart,input.selectionEnd],['旧草稿',1,2]);
 h.click(Array.from(doc.querySelectorAll('.composer-dictation-actions button')).find(n=>n.textContent==='转写'));await flush();assert.equal(input.value,'旧草稿\n语音文字');assert.equal(h.inputEvents,1);assert.match(doc.querySelector('.composer-dictation-status').textContent,/已加入草稿/);assert.equal(doc.getElementById('agentInput'),input);h.destroy();
});
test('config feedback has real Kit settings action, IME disables mic and destroy leaves original draft intact',async()=>{
 const h=fixture(),doc=h.window.document;h.setConfigured(false);h.click(doc.getElementById('composerVoice'));await flush();assert.match(doc.querySelector('.composer-dictation-status').textContent,/API 与 Key/);
 h.click(Array.from(doc.querySelectorAll('.composer-dictation-actions button')).find(n=>n.textContent==='语音设置'));await flush();assert.equal(h.settings,1);
 h.input.dispatchEvent(new h.window.Event('compositionstart'));assert.equal(doc.getElementById('composerVoice').disabled,true);h.input.dispatchEvent(new h.window.Event('compositionend'));assert.equal(doc.getElementById('composerVoice').disabled,false);h.destroy();assert.equal(h.input.value,'旧草稿');assert.equal(doc.querySelectorAll('.composer-dictation-status').length,0);
});
