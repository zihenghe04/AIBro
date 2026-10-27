/* Browser plugin: site permissions and "a person must do this" detection.
   Order of a site decision (first match wins):
     deny list (permanent) → allow list (permanent) → this conversation →
     this run ("once") → a URL the user wrote in this run's message (allowed
     for this run) → unknown site: ask when the run is in request-approval mode
     or the browser setting says so, otherwise allowed as before.
   A question waits for at most 10 minutes, then counts as a refusal. The
   wait is not part of any tool timeout: the browser operation has not
   started. Answers: once (this run), session (this conversation while the
   app runs), always (device-local allow list), deny (device-local deny list,
   removable in settings). Nothing here comes from the model. No DOM. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.AIBroBrowserSites=api;})(globalThis,root=>{
  'use strict';
  const PENDING_MS=10*60*1000;
  const CHOICES=['once','session','always','deny'];
  function originOf(value){
    try{const url=new URL(String(value));return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.origin:null;}catch{return null;}
  }
  // http(s) addresses written in the user's own message. Full-width and CJK
  // punctuation ends an address, so "打开 https://a.org/x，然后" yields a.org.
  function explicitOrigins(text){
    const out=new Set();
    for(const match of String(text||'').matchAll(/https?:\/\/[^\s<>"'`，。；、）】」》,;)\]]+/gi)){const origin=originOf(match[0].replace(/[.!?！？]+$/,''));if(origin)out.add(origin);}
    return [...out];
  }
  // Pages that need a person: a password field (sign-in) or a CAPTCHA / human check.
  const CAPTCHA=/captcha|recaptcha|hcaptcha|cf-turnstile|verify (?:that )?you(?:'| a)re (?:a )?human|are you a robot|i'?m not a robot|人机验证|验证码|安全验证|滑块验证|请完成验证/i;
  function humanCheck(result){
    if(!result||typeof result!=='object'||!Array.isArray(result.elements))return null;
    const names=result.elements.map(e=>String(e?.name||'')).join('\n');
    if(CAPTCHA.test([result.title,result.url,names,String(result.text||'').slice(0,4000)].join('\n')))return 'captcha';
    if(result.elements.some(e=>e&&e.sensitive===true))return 'login';
    return null;
  }
  // store: {read():{allow:[],deny:[],unknownSites:'auto'|'ask'}, save(origin,decision):Promise}
  function create({store,now=()=>Date.now(),pendingMs=PENDING_MS,setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id),changed=()=>{}}={}){
    const sessions=new Map(),runs=new Map(),pending=new Map();let seq=0;
    const lists=()=>{let value={};try{value=store?.read?.()||{};}catch{}return {allow:new Set(value.allow||[]),deny:new Set(value.deny||[]),unknownSites:value.unknownSites==='ask'?'ask':'auto'};};
    const grant=(map,key,origin)=>{if(!key)return;if(!map.has(key))map.set(key,new Set());map.get(key).add(origin);};
    function check({run,url,userText=''}){
      const origin=originOf(url);
      if(!origin)return {decision:'allow',reason:'not-a-site'};// the executor refuses invalid addresses itself
      const saved=lists();
      if(saved.deny.has(origin))return {decision:'deny',reason:'denied',origin};
      if(saved.allow.has(origin))return {decision:'allow',reason:'always',origin};
      if(sessions.get(run.conversationId)?.has(origin))return {decision:'allow',reason:'session',origin};
      if(runs.get(run.id)?.has(origin))return {decision:'allow',reason:'once',origin};
      if(explicitOrigins(userText).includes(origin)){grant(runs,run.id,origin);return {decision:'allow',reason:'explicit',origin};}
      const ask=run.permissionMode==='request'||saved.unknownSites==='ask';
      return ask?{decision:'ask',reason:'unknown',origin}:{decision:'allow',reason:'auto',origin};
    }
    // One open question per run and site; a second request joins the first.
    function ask({run,url,origin,signal}){
      for(const item of pending.values())if(item.runId===run.id&&item.origin===origin)return item.promise;
      const id='site-'+(++seq)+'-'+now().toString(36);
      let settle;const promise=new Promise(resolve=>{settle=resolve;});
      const item={id,runId:run.id,conversationId:run.conversationId,origin,url:String(url).slice(0,2048),createdAt:now(),expiresAt:now()+pendingMs,promise};
      const finish=answer=>{if(!pending.has(id))return;pending.delete(id);clearTimer(item.timer);signal?.removeEventListener?.('abort',abort);settle(answer);changed();};
      const abort=()=>finish('cancelled');
      item.finish=finish;item.timer=setTimer(()=>finish('timeout'),pendingMs);
      pending.set(id,item);
      if(signal?.aborted)abort();else signal?.addEventListener?.('abort',abort,{once:true});
      changed();
      return promise;
    }
    async function decide(id,choice){
      const item=pending.get(id);if(!item)return false;
      if(!CHOICES.includes(choice))throw TypeError('Unknown site decision: '+choice);
      if(choice==='once')grant(runs,item.runId,item.origin);
      if(choice==='session')grant(sessions,item.conversationId,item.origin);
      if(choice==='always'||choice==='deny')await store?.save?.(item.origin,choice==='always'?'allow':'deny');
      item.finish(choice);return true;
    }
    const list=runId=>[...pending.values()].filter(item=>!runId||item.runId===runId).map(({id,runId:r,conversationId,origin,url,createdAt,expiresAt})=>({id,runId:r,conversationId,origin,url,createdAt,expiresAt}));
    function endRun(runId){runs.delete(runId);for(const item of [...pending.values()])if(item.runId===runId)item.finish('cancelled');}
    const endConversation=conversationId=>{sessions.delete(conversationId);};
    return {check,ask,decide,list,endRun,endConversation};
  }
  return {PENDING_MS,CHOICES,originOf,explicitOrigins,humanCheck,create};
});
