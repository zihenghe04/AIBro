/* Plugin trigger runner (M2): the window side of plugin timed actions. The
   scheduler (scheduler.py, kind "trigger") keeps the timetable and leaves a
   pending row when one is due; while the app is open this runner registers
   the host's triggers, claims due rows one at a time, runs the plugin handler
   and reports the result. Nothing runs while the app is closed; a missed time
   is caught up once on the next open (within 18 hours), then expires. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.AIBroPluginTriggers=api;})(globalThis,root=>{
 'use strict';
 const INTERVAL=60000,MAX_RUNS=4,RUN_LIMIT=9*60000; // the scheduler drops a claim after 10 minutes
 const zone=()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}catch{return 'UTC';}};
 const text=(value,max=300)=>value==null?null:String(value).slice(0,max);
 function create({host,fetch:fetchImpl=root.fetch?.bind(root),timeZone=zone,interval=INTERVAL,timers=root,runLimit=RUN_LIMIT}={}){
  let signature='',busy=null,timer=null,stopped=true;
  const post=async(path,body)=>{
   const response=await fetchImpl(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
   const value=await response.json().catch(()=>({}));
   if(!response.ok)throw Error(value.error||'调度请求失败');
   return value;
  };
  // Register the timetable when it changed (plugin switched, trigger turned off, time zone moved).
  async function sync(){
   const triggers=host.triggers().map(({key,name,schedule,at,weekday,enabled})=>({key,name,schedule,at,...(weekday?{weekday}:{}),enabled}));
   const next=JSON.stringify([timeZone(),triggers]);
   if(next===signature)return false;
   await post('/__scheduler/triggers',{triggers,timeZone:timeZone()});
   signature=next;return true;
  }
  async function runOne(){
   const {execution,token}=await post('/__scheduler/claim-trigger');
   if(!execution)return false;
   const abort=new AbortController(),limit=timers.setTimeout(()=>abort.abort(),runLimit);
   let status='completed',summary=null,error=null;
   try{
    const result=await host.runTrigger(execution.trigger,{executionId:execution.id,scheduledFor:execution.scheduledFor,catchUp:!!execution.catchUp,signal:abort.signal});
    summary=text(typeof result==='string'?result:result?.summary);
   }catch(failure){status='failed';error=text(failure?.message||failure)||'失败';}
   finally{timers.clearTimeout(limit);}
   await post('/__scheduler/finish-trigger',{id:execution.id,token,status,summary,error});
   return true;
  }
  // One pass: sync, then run what is due. Waits for the device settings so a
  // trigger switched off on this device is never registered as on.
  function tick(){
   if(busy)return busy;
   busy=(async()=>{
    if(!host.loaded())return {synced:false,ran:0};
    const synced=await sync();let ran=0;
    while(ran<MAX_RUNS&&await runOne())ran++;
    return {synced,ran};
   })().finally(()=>{busy=null;});
   return busy;
  }
  const quiet=()=>tick().catch(()=>{});
  function start(){
   if(!stopped)return;stopped=false;
   const loop=()=>{if(stopped)return;quiet().finally(()=>{if(!stopped)timer=timers.setTimeout(loop,interval);});};
   timer=timers.setTimeout(loop,1000);
  }
  function stop(){stopped=true;if(timer)timers.clearTimeout(timer);timer=null;}
  return {tick,sync,start,stop,reset:()=>{signature='';}};
 }
 const api={create,INTERVAL,MAX_RUNS};
 // The window's runner over the window's plugin host.
 if(root.AIBroPlugins?.default&&!(typeof module==='object'&&module.exports)){
  api.default=create({host:root.AIBroPlugins.default});
  root.AIBroPlugins.default.onChange(()=>{root.setTimeout(()=>api.default.tick().catch(()=>{}),0);});
  api.default.start();
 }
 return api;
});
