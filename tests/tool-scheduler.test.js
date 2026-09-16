const test=require('node:test'),assert=require('node:assert/strict');
const S=require('../app/tool-scheduler'),D=require('../app/research-delegation'),K=require('../app/knowledge-access');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('neighbor requests keep their exact chunk version through scheduling',async()=>{
 const r={type:'neighbors',chunkId:'chunk:one',version:'v2',radius:2};let received;
 await S.create({run:{},execute:async request=>{received=request;return {entries:[]}}}).batch([r]);
 assert.deepEqual(received,r);
});
test('independent reads overlap, commands remain barriers and result order is stable',async()=>{
 const run={},events=[];let active=0,peak=0;const s=S.create({run,checkpoint:async()=>{},execute:async r=>{events.push('start'+r.id);peak=Math.max(peak,++active);if(r.type==='terminal')assert.equal(active,1);await delay(r.id==='a'?15:2);active--;events.push('end'+r.id);return {id:r.id};}});
 const result=await s.batch([{type:'read',id:'a'},{type:'read',id:'b'},{type:'terminal',id:'c'},{type:'search',id:'d'}]);
 assert.equal(peak,2);assert.deepEqual(result.map(x=>x.id),['a','b','c','d']);assert.ok(events.indexOf('startc')>events.indexOf('enda'));assert.ok(events.indexOf('startd')>events.indexOf('endc'));assert.ok(run.toolCalls.every(x=>x.status==='completed'));
});
test('queued entries are saved before execution; failed checkpoint never executes command',async()=>{
 const run={};let called=false;const s=S.create({run,checkpoint:async()=>{throw Error('disk full')},execute:async()=>{called=true}});
 await assert.rejects(s.batch([{type:'terminal',argv:['pwd']}]),/disk full/);assert.equal(called,false);
});
test('stop cancels in-flight reads and never launches queued command',async()=>{
 const c=new AbortController(),run={};let commands=0;
 const s=S.create({run,signal:c.signal,execute:async(r,{signal})=>{if(r.type==='terminal')commands++;await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('stopped'),{code:'CANCELLED'})),{once:true}));}});
 const pending=s.batch([{type:'read'},{type:'read'},{type:'terminal'}]);await delay(5);c.abort();await assert.rejects(pending,{code:'CANCELLED'});assert.equal(commands,0);assert.ok(run.toolCalls.every(x=>x.status==='cancelled'));
});
test('tool failure is recorded while independent results are retained',async()=>{const run={},s=S.create({run,execute:async r=>{if(r.id==='bad')throw Error('missing');return {text:'ok'}}});const result=await s.batch([{type:'read',id:'bad'},{type:'read',id:'good'}]);assert.equal(result[0].error,'missing');assert.equal(result[1].text,'ok');assert.equal(run.toolCalls[0].status,'failed');});
test('history strips binary blocks, caps output explicitly, and closes provider activities',()=>{assert.deepEqual(S.resultSnapshot({blocks:[{image_url:'private'}],text:'ok'}),{result:{text:'ok'},truncated:false});assert.equal(S.resultSnapshot({text:'x'.repeat(40000)}).truncated,true);const run={};S.provider(run,{kind:'tool',id:'x',name:'web_search',status:'running',text:'search'});S.finish(run,'cancelled');assert.equal(run.toolCalls[0].status,'cancelled');});
const fixture=()=>({projects:[{id:'p'},{id:'q'}],notes:[{id:'a',projectId:'p',content:'Synthetic fact'},{id:'private',projectId:'q',content:'OTHER_PROJECT'}]});
test('child uses scoped real reads and returns traceable analysis without mutating library',async()=>{
 const state=fixture(),before=JSON.stringify(state),run={};let turns=0;
 const result=await D.execute({task:'Analyze a',title:'Evidence'},{state,scope:{projectId:'p'},run,entry:{id:'child'},read:r=>K.execute(state,{projectId:'p'},r),ask:async text=>{turns++;assert.doesNotMatch(text,/OTHER_PROJECT/);return turns===1?JSON.stringify({knowledgeRequests:[{type:'read',id:'a'}],actions:[]}):JSON.stringify({message:'Evidence from a: Synthetic fact',actions:[]});}});
 assert.equal(turns,2);assert.equal(result.readEvidence[0].id,'a');assert.equal(result.verified,false);assert.equal(JSON.stringify(state),before);assert.equal(run.toolCalls[0].parentId,'child');
});
test('child cannot execute terminal or mutate files; repeated invalid requests terminate',async()=>{
 let reads=0;const run={};await assert.rejects(D.execute({task:'bad'},{state:fixture(),scope:{projectId:'p'},run,entry:{id:'child'},read:async()=>{reads++},ask:async()=>JSON.stringify({knowledgeRequests:[{type:'terminal',argv:['touch','file']}],actions:[]})}),/重复/);assert.equal(reads,0);assert.equal(run.delegations[0].status,'failed');
 await assert.rejects(D.execute({task:'bad'},{state:fixture(),scope:{},run:{},entry:{id:'c'},ask:async()=>JSON.stringify({message:'written',actions:[],fileEdits:[{path:'x'}]})}),/写入/);
});
test('child returns missing source error to its next turn and remains project-scoped',async()=>{const state=fixture();let calls=0;const result=await D.execute({task:'read private'},{state,scope:{projectId:'p'},run:{},entry:{id:'child'},read:r=>K.execute(state,{projectId:'p'},r),ask:async text=>{if(++calls===1)return JSON.stringify({knowledgeRequests:[{type:'read',id:'private'}]});assert.match(text,/范围/);assert.doesNotMatch(text,/OTHER_PROJECT/);return JSON.stringify({message:'Unavailable',actions:[]})}});assert.equal(result.readEvidence.length,0)});
test('restart marks only previous service running work interrupted and never replays tools',()=>{const state={agentRuns:[{id:'a',conversationId:'c',status:'running',executionInstanceId:'old',toolCalls:[{status:'running'}],delegations:[{status:'running'}]},{id:'b',status:'running',executionInstanceId:'current'},{id:'c',status:'awaiting-approval',executionInstanceId:'old'}],conversations:[{id:'c',messages:[{runId:'a',live:true,text:'Progress'}]}]};assert.equal(S.recover(state,'current'),true);assert.equal(state.agentRuns[0].status,'interrupted');assert.equal(state.agentRuns[0].toolCalls[0].status,'interrupted');assert.equal(state.conversations[0].messages[0].retryRunId,'a');assert.equal(state.agentRuns[1].status,'running');assert.equal(state.agentRuns[2].status,'awaiting-approval');assert.equal(S.recover(state,'current'),false);});
