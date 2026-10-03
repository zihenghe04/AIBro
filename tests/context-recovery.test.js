const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),vm=require('node:vm'),fs=require('node:fs');
const C=require('../app/agent-context'),K=require('../app/knowledge-access'),S=require('../app/tool-scheduler');
const source=fs.readFileSync(require.resolve('../app/sse-frame-scanner'), 'utf8') + '\n' + fs.readFileSync(require.resolve('../app/agent-transport'),'utf8');
const OVERFLOW={error:{code:'context_length_exceeded',message:'Input exceeds the context window limit'}};
const json=(response,value,status=200)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value));};
const sse=(response,events)=>{response.writeHead(200,{'content-type':'text/event-stream'});response.end(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''));};
const done=text=>({type:'response.completed',response:{status:'completed',output_text:text}});
async function fixture(t,respond){
 const calls=[];const server=http.createServer(async(req,res)=>{let data='';for await(const chunk of req)data+=chunk;calls.push({url:req.url,body:JSON.parse(data),headers:req.headers});await respond(res,calls.length,calls);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const address='http://127.0.0.1:'+server.address().port;
 const context=vm.createContext({fetch:(url,options)=>fetch(address+url,options),AbortController,TextDecoder,URL,WorkstationCore:require('../app/workstation-core')});vm.runInContext(source,context);
 return {calls,transport:context.AgentTransport};
}
function contextFixture(){
 const messages=[{id:'u-old',role:'user',text:'An older request '+('old context '.repeat(300))},{id:'a-old',role:'assistant',text:'Old assistant reasoning '+('details '.repeat(800))},{id:'u-correction',role:'user',text:'最新纠正：只读分析，保留 archive 文件。'},{id:'a-recent',role:'assistant',text:'Already completed command '+('output '.repeat(200))},{id:'u-recent',role:'user',text:'补充：不要重新执行命令，给出结果。'}];
 const envelope={sourceLinkedSummary:[{messageId:'u-old',quote:'An older request'}],sourceLinkedAnchors:{items:[{value:'old'}]},messages,omittedMessages:3,operations:[{runId:'prior',status:'completed',results:[{id:'existing-note',type:'note',text:'saved'}]}],historyAccess:'history_search / history_read / evidence_log'};
 const past={text:JSON.stringify(envelope),coverage:{includedMessages:5,omittedMessages:3,totalMessages:8}};
 const agent=C.create({fullInstruction:'你是个人助手。动作类型与字段：create_task(title)。\n本机终端：只能显式审批，禁止未经审阅写文件。',history:past,projectId:'p',workspace:'日常',userMessageId:'current'});agent.capability('files');
 return {agent,past,envelope};
}
const options={base:'https://provider.invalid/v1',protocol:'responses',model:'fixture'};

test('history reduction keeps recent exact corrections, loaded policy, receipts, current prompt and attachments',()=>{
 const {agent,past,envelope}=contextFixture(),before=JSON.stringify(past),tail='\n用户当前目标：继续\n当前工具证据：{"commandId":"cmd-1","status":"succeeded"}\n排队纠正：请保留源文件\n修复提示：返回 actions=[]';
 const image={type:'input_image',image_url:'data:image/png;base64,fixture'},input=[{role:'user',content:[{type:'input_text',text:agent.instructions()+tail},image]}];
 const original=JSON.stringify(input),result=agent.compactHistory(input);assert.ok(result);assert.ok(result.afterCharacters<result.beforeCharacters);
 assert.equal(JSON.stringify(past),before);assert.equal(JSON.stringify(input),original);assert.deepEqual(result.input[0].content[1],image);
 const text=result.input[0].content[0].text;assert.ok(text.endsWith(tail));assert.match(text,/只能显式审批/);assert.match(text,/最新纠正：只读分析，保留 archive 文件/);assert.match(text,/不要重新执行命令/);assert.match(text,/existing-note/);assert.doesNotMatch(text,/Old assistant reasoning/);
 assert.equal(result.coverage.includedMessages,2);assert.equal(result.coverage.omittedMessages,6);assert.equal(result.coverage.totalMessages,8);assert.equal(result.coverage.recovered,true);
 assert.ok(agent.instructions().includes('provider_context_length_exceeded'));assert.equal(agent.compactHistory(result.input),null);assert.equal(agent.compactHistory('unrelated'+original),null);
 assert.deepEqual(envelope.messages.map(m=>m.id),['u-old','a-old','u-correction','a-recent','u-recent']);
});

test('real HTTP overflow reduces history once with the same selected protocol and a visible recovery activity',async t=>{
 const recoveryIds=new Set();
 for(const protocol of ['responses','chat']){
  const f=await fixture(t,(res,n)=>n===1?json(res,OVERFLOW,400):json(res,protocol==='chat'?{choices:[{message:{content:'recovered'}}]}:{output_text:'recovered'}));
  const {agent}=contextFixture(),activities=[],input=agent.instructions()+'\nCURRENT_GOAL';let recovered;
  assert.equal(await f.transport.requestPlan({...options,protocol,input,onActivity:value=>activities.push(value),recoverInput:({input})=>(recovered=agent.compactHistory(input))?.input}),'recovered');
  assert.equal(f.calls.length,2);assert.equal(f.calls[0].url,f.calls[1].url);assert.ok(recovered.coverage.recovered);
  assert.match(JSON.stringify(f.calls[1].body),/最新纠正/);assert.match(JSON.stringify(f.calls[1].body),/CURRENT_GOAL/);assert.ok(JSON.stringify(f.calls[1].body).length<JSON.stringify(f.calls[0].body).length);
  const recovery=activities.filter(value=>value.id?.endsWith(':context-recovery'));
  assert.equal(recovery.length,1);assert.match(recovery[0].id,/^commentary:.+:context-recovery$/);
  assert.equal(recovery[0].source,'transport');assert.equal(recovery[0].kind,'commentary');assert.equal(recovery[0].status,'completed');
  assert.equal(recovery[0].name,'上下文恢复');assert.match(recovery[0].text,/缩减较早对话并重试一次/);
  assert.equal(recoveryIds.has(recovery[0].id),false,'each request keeps a distinct recovery activity identity');recoveryIds.add(recovery[0].id);
 }
});

test('SSE rejection before content can recover, while final text, public progress and host tool events prohibit replay',async t=>{
 const introductions=[null,{type:'response.output_text.delta',delta:'partial plan'},{type:'response.reasoning_summary_text.delta',item_id:'summary',delta:'Checking files'},{type:'response.output_item.added',item:{type:'local_shell_call',id:'shell',status:'in_progress'}},{type:'response.tool_activity',id:'cmd',name:'terminal',status:'completed',text:'命令执行'}];
 for(const intro of introductions){
  const f=await fixture(t,(res,n)=>n===1?sse(res,[...(intro?[intro]:[]),{type:'response.failed',response:OVERFLOW}]):sse(res,[done('ok')]));let reductions=0;
  const pending=f.transport.requestPlan({...options,input:'Long input',recoverInput:()=>{reductions++;return 'short';}});
  if(intro){await assert.rejects(pending,{code:'CONTEXT_LENGTH_EXCEEDED',contextRecoveryAllowed:false});assert.equal(f.calls.length,1);assert.equal(reductions,0);}else{assert.equal(await pending,'ok');assert.equal(f.calls.length,2);assert.equal(reductions,1);}
 }
});

test('ordinary format, authentication, quota, output truncation and attachment-size errors never trigger history recovery',async t=>{
 const cases=[[400,{error:{message:'Invalid model'}}],[401,OVERFLOW],[429,OVERFLOW],[413,{error:{message:'Payload too large'}}],[422,{error:{message:'Unsupported image'}}],[200,{status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output_text:'partial'}]];
 for(const [status,body] of cases){const f=await fixture(t,res=>json(res,body,status));let reductions=0;await assert.rejects(f.transport.requestPlan({...options,input:'original',recoverInput:()=>{reductions++;return 'small';}}));assert.equal(reductions,0);assert.equal(f.calls.length,1);}
});

test('a second overflow terminates, and unchanged or unavailable derived history is never resent',async t=>{
 const f=await fixture(t,res=>json(res,OVERFLOW,400));let reductions=0;
 await assert.rejects(f.transport.requestPlan({...options,input:'Long input',recoverInput:()=>{reductions++;return 'short';}}),error=>error.code==='CONTEXT_LENGTH_EXCEEDED'&&/重试一次/.test(error.message));assert.equal(f.calls.length,2);assert.equal(reductions,1);
 for(const replacement of [null,'Long input','Longer than original input']){const before=f.calls.length;await assert.rejects(f.transport.requestPlan({...options,input:'Long input',recoverInput:()=>replacement}),{code:'CONTEXT_LENGTH_EXCEEDED'});assert.equal(f.calls.length,before+1);}
});

test('provider wording without a machine code can recover only explicit context overflow',async t=>{
 for(const message of ['This model\'s maximum context length is 8192 tokens. However, your messages resulted in 9200 tokens.','prompt is too long: 1000 tokens > 500 maximum']){
  const f=await fixture(t,(res,n)=>n===1?json(res,{error:{type:'invalid_request_error',message}},400):json(res,{output_text:'ok'}));assert.equal(await f.transport.requestPlan({...options,input:'original text',recoverInput:()=> 'small'}),'ok');assert.equal(f.calls.length,2);
 }
});

test('stopping while recovery is pending does not send another request or wait for that callback',async t=>{
 const f=await fixture(t,res=>json(res,OVERFLOW,400)),controller=new AbortController();let entered;const entry=new Promise(resolve=>entered=resolve);
 const pending=f.transport.requestPlan({...options,input:'Long input',signal:controller.signal,recoverInput:()=>{entered();return new Promise(()=>{});}});await entry;controller.abort();await assert.rejects(pending,{code:'CANCELLED'});assert.equal(f.calls.length,1);
});

test('context recovery after a real scheduler command result preserves its receipt and does not replay host execution',async t=>{
 const {agent}=contextFixture(),run={id:'run-1'};let executions=0,checkpoints=0;
 const scheduler=S.create({run,checkpoint:async()=>{checkpoints++;},execute:async()=>{executions++;return {type:'terminal',id:'cmd-1',status:'succeeded',exitCode:0,output:'SIDE_EFFECT_RECEIPT'};}});
 const f=await fixture(t,(res,n)=>n===1?json(res,OVERFLOW,400):sse(res,[done('{"message":"command already completed","actions":[]}')]));
 const output=await K.continuePlan('{"knowledgeRequests":[{"type":"terminal","argv":["fixture-command"]}],"actions":[]}',{batch:scheduler.batch,ask:async extra=>f.transport.requestPlan({...options,input:agent.instructions()+extra,recoverInput:({input})=>agent.compactHistory(input)?.input})});
 assert.match(output,/already completed/);assert.equal(executions,1);assert.equal(run.toolCalls.length,1);assert.ok(checkpoints>0);assert.equal(f.calls.length,2);
 for(const call of f.calls){assert.match(JSON.stringify(call.body),/SIDE_EFFECT_RECEIPT/);assert.match(JSON.stringify(call.body),/cmd-1/);assert.match(JSON.stringify(call.body),/succeeded/);}
});

test('embedded tool receipts in failed JSON and chat tool-call deltas block recovery even without text callbacks',async t=>{
 for(const mode of ['json-tool','http-tool','json-text','chat-tool','unknown-tool']){
  const f=await fixture(t,res=>{
   if(mode==='json-tool'||mode==='http-tool')return json(res,{...OVERFLOW,output:[{type:'shell_call',id:'server-command',status:'completed'}]},mode==='http-tool'?400:200);
   if(mode==='json-text')return json(res,{...OVERFLOW,output_text:'partial'});
   sse(res,[mode==='chat-tool'?{choices:[{index:0,delta:{tool_calls:[{id:'request-1',type:'function',function:{name:'write_file',arguments:'{}'}}]}}]}:{type:'response.output_item.added',item:{type:'future_write_tool',id:'unknown'}},{type:'error',...OVERFLOW}]);
  });let reductions=0;
  await assert.rejects(f.transport.requestPlan({...options,input:'original text',recoverInput:()=>{reductions++;return 'small';}}),{code:'CONTEXT_LENGTH_EXCEEDED',contextRecoveryAllowed:false});assert.equal(f.calls.length,1);assert.equal(reductions,0);
 }
});

test('a protocol fallback followed by overflow recovers using the failed protocol without restarting the route probe',async t=>{
 const f=await fixture(t,(res,n)=>n===1?json(res,{message:'No enabled endpoints are available after routing filters'},503):n===2?json(res,OVERFLOW,400):json(res,{choices:[{message:{content:'ok'}}]}));
 assert.equal(await f.transport.requestPlan({...options,protocol:undefined,input:'original text',recoverInput:()=> 'small'}),'ok');assert.equal(f.calls.length,3);assert.match(decodeURIComponent(f.calls[0].url),/responses/);assert.match(decodeURIComponent(f.calls[1].url),/chat\/completions/);assert.equal(f.calls[1].url,f.calls[2].url);
});
