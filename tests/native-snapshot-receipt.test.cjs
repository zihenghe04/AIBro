// Real production bridge, synthetic state and a controlled transport/clock.
// This tests sender and diagnostic contracts, not native navigation or WebKit.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../native/Resources/bridge.js'),'utf8');
const Evidence=require('../app/citation-evidence');
function fixture(options={}){
 let now=0,modal=false,failures=options.throws||0,opened=0;
 const posted=[],intervals=[],listeners=new Map(),classes=new Set();
 const state={projects:[],conversations:[],tasks:[{id:'synthetic-task',title:'Fixture',workspace:'日常',status:'todo'}],notes:[],imports:[],ui:{}};
 const env={state,storageHydrated:options.hydrated!==false,sendMessage:{busy:false},setInterval:(callback,ms)=>intervals.push({callback,ms}),
  document:{hidden:false,addEventListener(){},body:{dataset:{view:'agent'},classList:{add:x=>classes.add(x),contains:x=>classes.has(x),toggle:(x,on)=>{on?classes.add(x):classes.delete(x);return on;}}},querySelector:selector=>selector==='dialog:modal'&&modal?{}:null},
  openTask:()=>{opened++;return true},
  window:{crypto:{randomUUID:()=> '01234567-89ab-4cde-8fab-0123456789ab'},performance:{now:()=>now},CitationEvidence:Evidence,addEventListener:(name,callback)=>listeners.set(name,callback),webkit:{messageHandlers:{workspace:{postMessage(value){posted.push(value);if(failures-->0)throw Error('Synthetic send failure');}}}}}
 };
 vm.runInNewContext(source,env,{filename:'production-bridge.js'});
 return {env,state,posted,get opened(){return opened},frames:()=>posted.filter(x=>x._nativeSnapshot.type==='snapshot'),
  tick:time=>{now=time;intervals.find(item=>item.ms===500).callback()},emit:(name,event={})=>listeners.get(name)?.(event),modal:value=>modal=value,
  ack:(frame,changes={})=>env.window.NativeSnapshotChannel.acknowledge({...frame._nativeSnapshot,...changes}),retry:()=>env.window.NativeSnapshotChannel.retry()};
}
test('a thrown first post retries the same projection then stops unchanged traffic only after ACK',()=>{
 const f=fixture({throws:1});assert.equal(typeof f.env.window.NativeShell.perform,'function');
 const first=f.frames()[0];f.tick(499);assert.equal(f.frames().length,1);f.tick(500);
 assert.equal(f.frames().length,2);assert.deepEqual(f.frames()[1],first);
 assert.equal(f.ack(f.frames()[1]),true);
 for(let i=1;i<=120;i++)f.tick(500+i*500);
 assert.equal(f.frames().length,2);assert.equal(Object.hasOwn(f.state,'_nativeSnapshot'),false);
});
test('a silently lost first delivery or ACK remains eligible for a bounded same-sequence resend',()=>{
 const f=fixture(),first=f.frames()[0];f.tick(500);
 assert.equal(f.frames().length,2);assert.equal(f.frames()[1]._nativeSnapshot.sequence,first._nativeSnapshot.sequence);
 assert.equal(f.ack(first),true);f.tick(1500);assert.equal(f.frames().length,2);
});
test('wrong version, document nonce and sequence cannot acknowledge a pending snapshot',()=>{
 const f=fixture(),first=f.frames()[0];
 for(const changes of [{version:2},{nonce:'other-document'},{sequence:0},{sequence:first._nativeSnapshot.sequence+1}])assert.equal(f.ack(first,changes),false);
 f.tick(500);assert.equal(f.frames().length,2);assert.equal(f.ack(first),true);
});
test('new data supersedes an unacknowledged projection and a late ACK cannot clear the new one',()=>{
 const f=fixture(),first=f.frames()[0];f.state.tasks[0].title='Changed';f.tick(100);
 const latest=f.frames().at(-1);assert.ok(latest._nativeSnapshot.sequence>first._nativeSnapshot.sequence);
 assert.equal(f.ack(first),false);f.tick(600);assert.equal(f.frames().length,3);assert.equal(f.ack(latest),true);
 f.tick(5000);assert.equal(f.frames().length,3);
});
test('returning to acknowledged content still sends a newer correction while another projection is in flight',()=>{
 const f=fixture(),first=f.frames()[0];f.ack(first);
 f.state.tasks[0].title='Temporary';f.tick(100);const temporary=f.frames().at(-1);
 f.state.tasks[0].title='Fixture';f.tick(200);const restored=f.frames().at(-1);
 assert.ok(restored._nativeSnapshot.sequence>temporary._nativeSnapshot.sequence);assert.equal(restored.tasks[0].title,'Fixture');
 assert.equal(f.ack(temporary),false);assert.equal(f.ack(restored),true);
});
test('four sends and one content-free timeout report are followed by no automatic retries; explicit retry can recover',()=>{
 const f=fixture();for(const time of [500,1500,3500,7500,15000,60000])f.tick(time);
 assert.equal(f.frames().length,4);const reports=f.posted.filter(x=>x._nativeSnapshot.type==='ack-timeout');assert.equal(reports.length,1);
 assert.deepEqual(Object.keys(reports[0]),['_nativeSnapshot']);
 assert.equal(f.retry(),true);assert.equal(f.frames().length,5);assert.equal(f.ack(f.frames().at(-1)),true);
 f.tick(100000);assert.equal(f.frames().length,5);
});
test('a hidden old page cannot accept ACKs or publish; a persisted page resume has a new sequence',()=>{
 const f=fixture(),first=f.frames()[0];f.emit('pagehide');assert.equal(f.ack(first),false);assert.equal(f.retry(),false);
 f.tick(5000);assert.equal(f.frames().length,1);
 f.emit('pageshow',{persisted:true});assert.equal(f.frames().length,2);assert.ok(f.frames()[1]._nativeSnapshot.sequence>first._nativeSnapshot.sequence);
 assert.equal(f.ack(first),false);assert.equal(f.ack(f.frames()[1]),true);
});
test('explicit retry does not claim to hydrate or send an unavailable workspace',()=>{
 const f=fixture({hydrated:false});assert.equal(f.frames().length,0);assert.equal(f.retry(),false);
 f.env.storageHydrated=true;f.tick(500);assert.equal(f.frames().length,1);
});
test('diagnostic commands preserve guards and report only fixed categories, not record or exception text',async()=>{
 const f=fixture(),command={type:'task',id:'synthetic-task',quickEntry:true};
 f.modal(true);let result=await f.env.window.NativeShell.performWithDiagnostics(command);
 assert.equal(result.accepted,false);assert.equal(result.reason,'web_modal');assert.equal(f.opened,0);
 f.modal(false);f.env.openTask=()=>{throw new TypeError('secret-like fixture body must not be logged')};
 result=await f.env.window.NativeShell.performWithDiagnostics(command);
 assert.equal(result.reason,'renderer_exception');assert.equal(result.exceptionCategory,'TypeError');assert.ok(!JSON.stringify(result).includes('secret-like'));
 f.env.openTask=()=>true;result=await f.env.window.NativeShell.performWithDiagnostics(command);
 assert.equal(result.accepted,true);assert.equal(result.reason,'opened');assert.equal(result.ackKind,'boolean');
});
