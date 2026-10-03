const test=require('node:test'),assert=require('node:assert/strict');
const D=require('../app/composer-dictation');
const gate=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j});return{promise,resolve,reject}};
function fixture(){
 const context={available:true,conversationId:'a',workspace:'课程',projectId:'p',routeVersion:1,inputValue:'原草稿'};
 const calls=[],applied=[],states=[];let verifier,n=0,tick;
 const api={status:async()=>({configured:true,available:true}),start:async lease=>({status:'recording',...lease}),finish:async lease=>({status:'completed',text:'识别文字',...lease}),retry:async lease=>({status:'completed',text:'重试文字',...lease}),cancel:async lease=>{calls.push(['cancel',lease]);return{status:'cancelled',...lease}},bindVerifier(fn){verifier=fn;return()=>{verifier=null}},openSettings:async()=>calls.push(['settings'])};
 const c=D.createController({api,context:()=>context,uuid:()=>`nonce-${++n}`,setInterval(fn){tick=fn;return 1},clearInterval(){tick=null},onChange:s=>states.push(s),appendDraft(p){applied.push(p);context.inputValue=p.text;return true;}});
 return{c,api,context,calls,applied,states,verify:l=>verifier(l),tick:()=>tick?.()};
}
test('recording receives actual lease, appends once, preserves original draft, never sends',async()=>{
 const f=fixture();let lease;f.api.start=async l=>{lease=l;assert.equal(f.verify(l),true);return{status:'recording',...l}};
 assert.equal(await f.c.start(),true);assert.equal(f.c.snapshot().phase,'recording');assert.equal(await f.c.finish(),true);
 assert.equal(f.context.inputValue,'原草稿\n识别文字');assert.equal(f.applied.length,1);assert.equal(await f.c.finish(),false);assert.equal(f.verify(lease),false);f.c.destroy();
});
test('typing including A→B→A and IME permanently revoke late transcription',async()=>{
 for(const change of ['typing','ime']){const f=fixture(),g=gate();await f.c.start();f.api.finish=()=>g.promise;const pending=f.c.finish();
  if(change==='typing'){f.context.inputValue='B';f.c.edited();f.context.inputValue='原草稿';f.c.edited();}else{f.c.composition(true);f.c.composition(false);}
  g.resolve({status:'completed',text:'late',nonce:'nonce-1',conversationId:'a',revision:0});assert.equal(await pending,false);assert.equal(f.applied.length,0);assert.equal(f.context.inputValue,'原草稿');f.c.destroy();}
});
test('route, scope, permission changes reject replies and verifier; cancelled authorization cannot begin UI recording',async()=>{
 for(const mutate of [f=>f.context.routeVersion++,f=>f.context.projectId='other',f=>f.context.available=false,f=>f.c.cancel()]){
  const f=fixture(),g=gate();let lease;f.api.start=l=>{lease=l;return g.promise};const start=f.c.start();await Promise.resolve();mutate(f);assert.equal(f.verify(lease),false);
  g.resolve({status:'recording',...lease});assert.equal(await start,false);assert.equal(f.c.snapshot().phase,'idle');assert.equal(f.applied.length,0);f.c.destroy();}
});
test('noncooperative old finish cannot clear a newer session',async()=>{
 const f=fixture(),g=gate();await f.c.start();f.api.finish=()=>g.promise;const old=f.c.finish();f.c.cancel();await f.c.start();
 g.resolve({status:'completed',text:'old',nonce:'nonce-1',conversationId:'a',revision:0});assert.equal(await old,false);assert.equal(f.c.snapshot().phase,'recording');assert.equal(f.applied.length,0);f.c.destroy();
});
test('only retained-audio error offers retry; missing config/permission leave text and allow settings',async()=>{
 const f=fixture();f.api.status=async()=>({available:true,configured:false});assert.equal(await f.c.start(),false);assert.equal(f.c.snapshot().phase,'unconfigured');await f.c.settings();assert.equal(f.calls.at(-1)[0],'settings');
 f.api.status=async()=>({available:true,configured:true});f.api.start=async lease=>({status:'error',reason:'permission',message:'未授权',...lease});await f.c.start();assert.equal(f.c.snapshot().retryAvailable,false);assert.equal(await f.c.retry(),false);
 f.api.start=async lease=>({status:'recording',...lease});await f.c.start();f.api.finish=async lease=>({status:'error',reason:'provider',message:'连接失败',retryAvailable:true,...lease});await f.c.finish();assert.equal(f.c.snapshot().retryAvailable,true);assert.equal(f.context.inputValue,'原草稿');assert.equal(await f.c.retry(),true);assert.equal(f.context.inputValue,'原草稿\n重试文字');f.c.destroy();
});
test('duration limit stops without upload; stale status cannot regress transcribing to recording',async()=>{
 const f=fixture();let lease;f.api.start=async l=>(lease=l,{status:'recording',...l});await f.c.start();
 f.api.status=async()=>({phase:'recorded',elapsed:300,...lease});await f.c.poll();assert.equal(f.c.snapshot().phase,'recorded');assert.equal(f.applied.length,0);
 const s=gate(),finish=gate();f.api.status=()=>s.promise;const p=f.c.poll();f.api.finish=()=>finish.promise;const t=f.c.finish();s.resolve({phase:'recording',elapsed:4,...lease});await p;assert.equal(f.c.snapshot().phase,'transcribing');finish.resolve({status:'completed',text:'end',...lease});assert.equal(await t,true);f.c.destroy();
});
test('missing/foreign completion never changes draft and disposal removes verifier',async()=>{
 const f=fixture();await f.c.start();f.api.finish=async l=>({status:'completed',text:'wrong',...l,conversationId:'b'});assert.equal(await f.c.finish(),false);assert.equal(f.applied.length,0);f.c.destroy();assert.equal(f.c.snapshot().active,false);
});
test('opening settings waits for native cancel acknowledgement before settings RPC',async()=>{
 const f=fixture(),g=gate();await f.c.start();f.api.cancel=()=>g.promise;let opened=0;f.api.openSettings=async()=>opened++;const p=f.c.settings();await Promise.resolve();assert.equal(opened,0);g.resolve({status:'cancelled'});await p;assert.equal(opened,1);f.c.destroy();
});
test('native ownerless idle/error and foreign global busy retire recording without touching another lease',async()=>{
 for(const status of [{phase:'idle',available:true},{phase:'error',message:'录音失败',available:true},{phase:'busy',status:'busy',available:false},{phase:'recording',nonce:'other',conversationId:'b',revision:4}]){
  const f=fixture();await f.c.start();f.api.status=async()=>status;await f.c.poll();assert.equal(f.c.snapshot().active,false);assert.notEqual(f.c.snapshot().phase,'recording');assert.equal(f.c.snapshot().retryAvailable,false);await Promise.resolve();assert.equal(f.calls.at(-1)[1].nonce,'nonce-1');assert.equal(f.context.inputValue,'原草稿');f.c.destroy();
 }
});
