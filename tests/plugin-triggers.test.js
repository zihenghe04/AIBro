const test=require('node:test'),assert=require('node:assert/strict');
const Plugins=require('../app/plugin-host'),Tools=require('../app/tool-specs'),Runner=require('../app/plugin-triggers');

const spec={name:'demo_ping',description:'ping',effect:'none',approval:'never',concurrency:'parallel',input:{type:'object',properties:{},additionalProperties:false}};
const trigger={id:'daily-brief',name:{zh:'每日简报'},schedule:'daily',at:'07:30',handler:'brief'};
const manifest={id:'demo',version:'1.0.0',apiVersion:1,kind:'builtin',name:{zh:'演示'},summary:{zh:'一句话说明'},tools:['demo_ping'],triggers:[trigger]};
// A fake local service: /__scheduler/triggers, claim-trigger, finish-trigger.
function service(pending=[]){
  const calls=[],finished=[];let registered=null;
  const fetch=async(path,init)=>{
    const body=JSON.parse(init.body);calls.push(path);
    const reply=(value,status=200)=>({ok:status<400,status,json:async()=>value});
    if(path==='/__scheduler/triggers'){registered=body;return reply({triggers:body.triggers});}
    if(path==='/__scheduler/claim-trigger'){const row=pending.shift();return reply(row?{execution:row,token:'tok-'+row.id}:{execution:null});}
    if(path==='/__scheduler/finish-trigger'){finished.push(body);return reply({ok:true});}
    return reply({error:'no'},404);
  };
  return {fetch,calls,finished,registered:()=>registered};
}
const timers={setTimeout:(fn,ms)=>({fn,ms}),clearTimeout:()=>{}};
async function setup(handler,settings={}){
  const h=Plugins.create({registry:Tools.build(),transport:{load:async()=>({builtin:settings,mcp:[]})}});
  h.install({manifest,specs:[spec],handlers:{brief:handler}});
  return h;
}

test('waits for device settings, then registers the timetable once',async()=>{
  const h=await setup(async()=>null,{demo:{enabled:true,triggers:{'daily-brief':{enabled:false}}}}),s=service();
  const runner=Runner.create({host:h,fetch:s.fetch,timeZone:()=>'Asia/Shanghai',timers});
  assert.deepEqual(await runner.tick(),{synced:false,ran:0});assert.deepEqual(s.calls,[]);
  await h.load();
  assert.deepEqual(await runner.tick(),{synced:true,ran:0});
  assert.deepEqual(s.registered(),{timeZone:'Asia/Shanghai',triggers:[{key:'demo.daily-brief',name:{zh:'每日简报'},schedule:'daily',at:'07:30',enabled:false}]});
  await runner.tick();
  assert.equal(s.calls.filter(p=>p==='/__scheduler/triggers').length,1,'unchanged timetable is not sent again');
  await h.setTrigger('demo.daily-brief',true);await runner.tick();
  assert.equal(s.calls.filter(p=>p==='/__scheduler/triggers').length,2);assert.equal(s.registered().triggers[0].enabled,true);
});

test('claims due rows, runs the handler and reports each result',async()=>{
  const seen=[];
  const h=await setup(async ctx=>{seen.push(ctx);if(ctx.executionId==='e2')throw Error('offline');return {summary:'简报已生成'};});
  await h.load();
  const s=service([{id:'e1',trigger:'demo.daily-brief',scheduledFor:100,catchUp:true},{id:'e2',trigger:'demo.daily-brief',scheduledFor:200,catchUp:false}]);
  const runner=Runner.create({host:h,fetch:s.fetch,timeZone:()=>'UTC',timers});
  assert.deepEqual(await runner.tick(),{synced:true,ran:2});
  assert.deepEqual(seen.map(c=>[c.executionId,c.scheduledFor,c.catchUp,c.plugin,c.trigger,c.signal instanceof AbortSignal]),[['e1',100,true,'demo','daily-brief',true],['e2',200,false,'demo','daily-brief',true]]);
  assert.deepEqual(s.finished,[{id:'e1',token:'tok-e1',status:'completed',summary:'简报已生成',error:null},{id:'e2',token:'tok-e2',status:'failed',summary:null,error:'offline'}]);
});

test('a trigger switched off after it was claimed is reported failed, not run',async()=>{
  let ran=0;const h=await setup(async()=>{ran++;});await h.load();
  const s=service([{id:'e1',trigger:'demo.daily-brief',scheduledFor:1}]);
  const runner=Runner.create({host:h,fetch:s.fetch,timers});
  await runner.sync();await h.setEnabled('demo',false);
  const r=Runner.create({host:h,fetch:s.fetch,timers});await r.tick();
  assert.equal(ran,0);assert.equal(s.finished[0].status,'failed');assert.match(s.finished[0].error,/off/);
});

test('runs at most a few per pass, one pass at a time, and a failed sync is retried',async()=>{
  const h=await setup(async()=>'ok');await h.load();
  const rows=Array.from({length:6},(_,i)=>({id:'e'+i,trigger:'demo.daily-brief',scheduledFor:i}));
  const s=service(rows);let fail=true;
  const fetch=async(path,init)=>{if(path==='/__scheduler/triggers'&&fail){fail=false;return {ok:false,status:500,json:async()=>({error:'busy'})};}return s.fetch(path,init);};
  const runner=Runner.create({host:h,fetch,timers});
  await assert.rejects(runner.tick(),/busy/);
  const a=runner.tick(),b=runner.tick();
  assert.equal(a,b,'a second call joins the running pass');
  assert.deepEqual(await a,{synced:true,ran:Runner.MAX_RUNS});
  assert.equal(s.finished.length,Runner.MAX_RUNS);assert.equal(s.finished[0].summary,'ok');
});
