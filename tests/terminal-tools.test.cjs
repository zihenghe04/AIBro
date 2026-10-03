const {test}=require('node:test'),assert=require('node:assert/strict'),T=require('../app/terminal-tools.js');
test('terminal requests bind trusted current project, ignoring model-provided roots',()=>{const s={projects:[{id:'p',localFolder:{id:'trusted'}},{id:'foreign',localFolder:{id:'other'}}]};assert.deepEqual(T.payload({argv:['pwd'],candidateId:'evil',projectId:'foreign'},s,{id:'r',projectId:'p'}),{candidateId:'trusted',projectId:'p',runId:'r',argv:['pwd'],cwd:'',timeout:60});assert.throws(()=>T.payload({argv:['pwd']},s,{id:'r'}));s.projects[0].archived=true;assert.throws(()=>T.payload({argv:['pwd']},s,{id:'r',projectId:'p'}));});
const F=require('../app/file-context.js');
test('trusted command uses authoritative results and returns stdout to the tool loop',async()=>{
 const original=F.request,calls=[],state={projects:[{id:'p',localFolder:{id:'c'}}],conversations:[{id:'chat',projectId:'p'}]},run={id:'r',projectId:'p',conversationId:'chat',status:'running'};
 F.request=async(path,p)=>{calls.push([path,p]);if(path.endsWith('/propose'))return {id:'cmd',candidateId:'c',projectId:'p',argv:['/bin/pwd'],trusted:true,status:'pending'};return {status:path.endsWith('/start')?'running':'succeeded',exitCode:0,output:'actual project path'};};
 try{const result=await T.execute({argv:['pwd']},state,run,{refresh(){},save(){}});assert.equal(result.output,'actual project path');assert.equal(calls[1][1].automatic,true);assert.equal(run.commands[0].status,'succeeded');}finally{F.request=original;}
});
test('stopping while approval is pending cancels the proposal without starting it',async()=>{
 const original=F.request,calls=[],controller=new AbortController(),state={projects:[{id:'p',localFolder:{id:'c'}}]},run={id:'r',projectId:'p'};
 F.request=async(path)=>{calls.push(path);return {id:'cmd-stop',candidateId:'c',projectId:'p',argv:['pwd'],status:path.endsWith('/propose')?'pending':'cancelled'};};
 try{await assert.rejects(T.execute({argv:['pwd']},state,run,{signal:controller.signal,refresh(){controller.abort();},save(){}}),{code:'CANCELLED'});assert(!calls.some(p=>p.endsWith('/start')));assert.equal(run.commands[0].status,'cancelled');}finally{F.request=original;}
});

const fs=require('node:fs'),vm=require('node:vm');
function isolatedTerminal(request,options={}){
 const delays=[];
 const context={module:{exports:{}},require:name=>name==='./file-context.js'?{active:x=>!!x&&!x.archived&&!x.deletedAt,request}:require(name),AbortController,
  setTimeout:options.setTimeout||((callback,ms)=>{delays.push(ms);return setImmediate(callback)}),clearTimeout:options.clearTimeout||clearImmediate};
 vm.runInNewContext(fs.readFileSync(require.resolve('../app/terminal-tools.js'),'utf8'),context);
 return {T:context.module.exports,delays};
}
const commandState=()=>({projects:[{id:'p',localFolder:{id:'c'}}],conversations:[{id:'chat',projectId:'p'}]});
const commandRun=()=>({id:'r',projectId:'p',conversationId:'chat',status:'running'});

test('quiet handle polling backs off without resaving or repainting, and progress resets observation cadence',async()=>{
 let gets=0,starts=0,saves=0,renders=0;
 const base={id:'cmd-quiet',candidateId:'c',projectId:'p',argv:['/bin/pwd'],trusted:true,status:'pending',output:''};
 const h=isolatedTerminal(async(path)=>{
  if(path.endsWith('/propose'))return {...base};
  if(path.endsWith('/start')){starts++;return {status:'running'};}
  gets++;
  return gets<5?{status:'running',output:''}:gets<7?{status:'running',output:'first\n'}:{status:'succeeded',output:'first\ndone\n',exitCode:0};
 });
 const run=commandRun(),result=await h.T.execute({argv:['pwd']},commandState(),run,{save(){saves++},refresh(){renders++}});
 assert.equal(starts,1);assert.equal(gets,7);assert.equal(result.output,'first\ndone\n');
 assert.equal(saves,4,'save only proposal, start, changed output and terminal receipt');assert.equal(renders,4);
 assert.deepEqual(h.delays,[350,560,896,1434,2000,350,560]);
 assert.equal(run.commands[0].status,'succeeded');
});

test('stop interrupts a stalled observation request and cancels the same immutable handle exactly once',async()=>{
 const controller=new AbortController();let starts=0,cancels=0,gets=0;
 const h=isolatedTerminal(async(path,payload,signal)=>{
  if(path.endsWith('/propose'))return {id:'cmd-stall',candidateId:'c',projectId:'p',argv:['/bin/pwd'],trusted:true,status:'pending'};
  if(path.endsWith('/start')){starts++;return {status:'running'};}
  if(path.endsWith('/cancel')){cancels++;assert.equal(payload.id,'cmd-stall');return {status:'running'};}
  gets++;
  if(!signal)return {status:'cancelled',exitCode:-9,output:'partial'};
  return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})),{once:true});setImmediate(()=>controller.abort());});
 });
 const run=commandRun();
 await assert.rejects(h.T.execute({argv:['pwd']},commandState(),run,{signal:controller.signal,save(){},refresh(){}}),{code:'CANCELLED'});
 assert.equal(starts,1);assert.equal(cancels,1);assert.equal(gets,2);assert.equal(run.commands[0].status,'cancelled');assert.equal(run.commands[0].output,'partial');
});

test('stop wakes a pending poll timer instead of waiting for its backoff delay',async()=>{
 const controller=new AbortController(),timers=new Map();let nextTimer=0,cancels=0;
 const h=isolatedTerminal(async(path)=>{
  if(path.endsWith('/propose'))return {id:'cmd-wait',candidateId:'c',projectId:'p',argv:['/bin/pwd'],trusted:true,status:'pending'};
  if(path.endsWith('/start'))return {status:'running'};
  if(path.endsWith('/cancel'))cancels++;
  return {status:'cancelled'};
 },{setTimeout(fn,ms){const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)});
 const pending=h.T.execute({argv:['pwd']},commandState(),commandRun(),{signal:controller.signal,save(){},refresh(){}});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(timers.size,1);
 controller.abort();
 await assert.rejects(pending,{code:'CANCELLED'});assert.equal(timers.size,0);assert.equal(cancels,1);
});

test('scope changes cancel and reconcile the real handle before returning interruption',async()=>{
 const state=commandState(),run=commandRun();let cancels=0,starts=0;
 const h=isolatedTerminal(async(path)=>{
  if(path.endsWith('/propose'))return {id:'cmd-scope',candidateId:'c',projectId:'p',argv:['/bin/pwd'],trusted:true,status:'pending'};
  if(path.endsWith('/start')){starts++;state.conversations[0].projectId='other';return {status:'running'};}
  if(path.endsWith('/cancel')){cancels++;return {status:'running'};}
  return {status:'cancelled',output:'before scope changed',exitCode:-9};
 });
 await assert.rejects(h.T.execute({argv:['pwd']},state,run,{save(){},refresh(){}}),{code:'CANCELLED'});
 assert.equal(starts,1);assert.equal(cancels,1);assert.equal(run.commands[0].status,'cancelled');assert.equal(run.commands[0].output,'before scope changed');
});

test('live command output retains the host tool-call relation through completion',async()=>{
 const snapshots=[];
 const h=isolatedTerminal(async(path)=>{
  if(path.endsWith('/propose'))return {id:'cmd-related',candidateId:'c',projectId:'p',argv:['pwd'],trusted:true,status:'pending'};
  if(path.endsWith('/start'))return {status:'running',output:'working'};
  return {status:'succeeded',output:'done',exitCode:0};
 });
 const run=commandRun();
 await h.T.execute({argv:['pwd'],toolCallId:'model-injected'},commandState(),run,{toolCallId:'host-call-7',save(){snapshots.push(JSON.parse(JSON.stringify(run.commands[0])));},refresh(){}});
 assert.ok(snapshots.some(c=>c.status==='running'&&c.output==='working'));
 assert.ok(snapshots.every(c=>c.toolCallId==='host-call-7'));
 assert.equal(run.commands[0].toolCallId,'host-call-7');
});
