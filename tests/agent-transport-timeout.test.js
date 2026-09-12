const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../agent-transport'), 'utf8');
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function clock() {
  let now = 0, id = 0; const timers = new Map();
  return {
    setTimeout(fn, ms) { timers.set(++id, { at: now + ms, fn }); return id; }, clearTimeout(key) { timers.delete(key); },
    get size() { return timers.size; },
    async advance(ms) { const target=now+ms; await flush(); while(true){const entries=[...timers].filter(([,t])=>t.at<=target).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0]);if(!entries.length)break;const [key,timer]=entries[0];timers.delete(key);now=timer.at;timer.fn();await flush();}now=target;await flush(); }
  };
}
function channel(contentType='text/event-stream', status=200) {
  const queue=[]; let waiting, done=false, cancels=0, released=0;
  const reader={
    read(){if(queue.length)return Promise.resolve({done:false,value:queue.shift()});if(done)return Promise.resolve({done:true});return new Promise(resolve=>{waiting=resolve});},
    cancel(){cancels++;done=true;if(waiting){waiting({done:true});waiting=null;}return Promise.resolve();},
    releaseLock(){released++;}
  };
  return {
    response:{ok:status>=200&&status<300,status,headers:{get:()=>contentType},body:{getReader:()=>reader}},
    bytes(value){if(done)throw Error('channel closed');const bytes=typeof value==='string'?new TextEncoder().encode(value):value;if(waiting){waiting({done:false,value:bytes});waiting=null;}else queue.push(bytes);},
    event(value){this.bytes(`data: ${JSON.stringify(value)}\n\n`);},
    close(){done=true;if(waiting){waiting({done:true});waiting=null;}},
    get cancels(){return cancels;},get released(){return released;}
  };
}
function setup(fetch) {
  const timer=clock(),requests=[];
  const ctx=vm.createContext({WorkstationCore:require('../workstation-core'),AbortController,TextDecoder,setTimeout:timer.setTimeout,clearTimeout:timer.clearTimeout,fetch:(url,options)=>{requests.push({url,options});return fetch(url,options)}});
  vm.runInContext(source,ctx);
  return {timer,requests,transport:ctx.AgentTransport};
}
function start(h,options={}) {
  let result;const promise=h.transport.requestPlan({base:'https://example.invalid/v1',model:'fixture',input:'read',...options});
  // Attach rejection handling before advancing virtual time.
  const settled=promise.then(value=>(result={value}),error=>(result={error}));
  return {settled,get result(){return result}};
}

// Regression coverage for the explicit no-generation-deadline product setting.
// Virtual time advances by days; user cancellation ensures no test stays pending.
test('generation installs no automatic timeout or interval',()=>{
  assert.doesNotMatch(source,/\b(?:setTimeout|setInterval)\s*\(/);
  const h=setup(()=>{});assert.equal(h.transport.TIMEOUTS,undefined);
});

test('a fetch with no response headers can wait for days until the user stops it',async()=>{
  const h=setup(()=>new Promise(()=>{})),controller=new AbortController(),request=start(h,{signal:controller.signal});await flush();
  await h.timer.advance(7*24*60*60*1000);assert.equal(request.result,undefined);assert.equal(h.requests[0].options.signal.aborted,false);assert.equal(h.timer.size,0);
  controller.abort();await request.settled;assert.equal(request.result.error.code,'CANCELLED');assert.equal(h.requests[0].options.signal.aborted,true);assert.equal(h.timer.size,0);
});

test('silent stream and arbitrarily long pauses after partial output never auto-abort',async()=>{
  const stream=channel(),h=setup(async()=>stream.response),controller=new AbortController(),request=start(h,{signal:controller.signal});await flush();
  await h.timer.advance(24*60*60*1000);assert.equal(request.result,undefined);stream.event({type:'response.output_text.delta',delta:'partial'});await flush();
  await h.timer.advance(7*24*60*60*1000);assert.equal(request.result,undefined);assert.equal(h.requests[0].options.signal.aborted,false);assert.equal(h.timer.size,0);
  controller.abort();await request.settled;assert.equal(request.result.error.code,'CANCELLED');assert.equal(stream.cancels,1);assert.equal(stream.released,1);assert.equal(h.timer.size,0);
});

test('continuous output can exceed all former limits and still complete normally',async()=>{
  const stream=channel(),h=setup(async()=>stream.response),deltas=[];const request=start(h,{onDelta:value=>deltas.push(value)});await flush();
  for(let i=0;i<12;i++){await h.timer.advance(60*60*1000);assert.equal(request.result,undefined);stream.event({type:'response.output_text.delta',delta:String(i%10)});await flush();}
  stream.event({type:'response.completed'});stream.close();await request.settled;assert.equal(request.result.value,'012345678901');assert.equal(deltas.length,12);assert.equal(h.timer.size,0);assert.equal(stream.released,1);
});

test('empty keep-alives and hidden progress events have no deadline semantics and never create output',async()=>{
  const stream=channel(),h=setup(async()=>stream.response),request=start(h);await flush();
  for(const bytes of [': heartbeat\n\n','data: {"type":"response.in_progress"}\n\n','data: {"type":"response.in_progress","progress":true}\n\n']){
    await h.timer.advance(24*60*60*1000);stream.bytes(bytes);await flush();assert.equal(request.result,undefined);
  }
  stream.event({type:'response.output_text.delta',delta:'completed after waiting'});stream.event({type:'response.completed'});stream.close();await request.settled;
  assert.equal(request.result.value,'completed after waiting');assert.equal(h.timer.size,0);
});

test('explicit stop before headers or during stalled reads is immediate and listeners are removed',async()=>{
  for(const beforeHeaders of [true,false]){
    const stream=channel(),h=setup(()=>beforeHeaders?new Promise(()=>{}):Promise.resolve(stream.response)),controller=new AbortController();let added=0,removed=0;
    const signal={get aborted(){return controller.signal.aborted},addEventListener(...args){added++;controller.signal.addEventListener(...args);},removeEventListener(...args){removed++;controller.signal.removeEventListener(...args);}};
    const request=start(h,{signal});await flush();controller.abort();await request.settled;
    assert.equal(request.result.error.code,'CANCELLED');assert.equal(request.result.error.timeoutType,undefined);assert.equal(h.timer.size,0);assert.equal(added,1);assert.equal(removed,1);assert.equal(h.requests[0].options.signal.aborted,true);if(!beforeHeaders)assert.equal(stream.cancels,1);
  }
});

test('pre-aborted requests never reach fetch or leak cancellation listeners',async()=>{
  const h=setup(()=>{throw Error('must not fetch');}),controller=new AbortController();controller.abort();const request=start(h,{signal:controller.signal});await request.settled;
  assert.equal(request.result.error.code,'CANCELLED');assert.equal(h.requests.length,0);assert.equal(h.timer.size,0);
});

test('non-SSE JSON bodies may pause for days and preserve ordinary output',async()=>{
  const stream=channel('application/json'),h=setup(async()=>stream.response),request=start(h);await flush();
  stream.bytes('{"output_text":"');await flush();await h.timer.advance(3*24*60*60*1000);assert.equal(request.result,undefined);stream.bytes('完成"}');stream.close();await request.settled;
  assert.equal(request.result.value,'完成');assert.equal(h.timer.size,0);assert.equal(stream.released,1);
});

test('ordinary HTTP and explicit stream errors still end the request and release resources',async()=>{
  for(const mode of ['http','stream']){
    const stream=channel(mode==='http'?'application/json':'text/event-stream',mode==='http'?400:200),h=setup(async()=>stream.response),request=start(h);await flush();
    if(mode==='http'){stream.bytes('{"error":{"message":"请求格式无效"}}');stream.close();}else stream.event({type:'response.failed',response:{error:{message:'模型执行失败'}}});
    await request.settled;assert.equal(request.result.error.code,mode==='http'?'HTTP':'STREAM_ERROR');if(mode==='http')assert.equal(request.result.error.status,400);assert.match(request.result.error.message,/请求格式无效|模型执行失败/);assert.equal(h.timer.size,0);assert.equal(stream.released,1);
  }
});

test('network failure and stopping inside the last JSON delta do not produce false success',async()=>{
  const network=setup(async()=>{throw new Error('Failed to fetch');}),failed=start(network);await failed.settled;assert.equal(failed.result.error.message,'Failed to fetch');assert.equal(failed.result.error.code,undefined);assert.equal(network.timer.size,0);
  const stream=channel('application/json'),h=setup(async()=>stream.response),controller=new AbortController(),request=start(h,{signal:controller.signal,onDelta:()=>controller.abort()});await flush();stream.bytes('{"output_text":"text"}');stream.close();await request.settled;assert.equal(request.result.error.code,'CANCELLED');assert.equal(stream.released,1);
});

test('an unreadable HTTP error body still preserves known status and endpoint guidance',async()=>{
  const h=setup(async()=>({ok:false,status:404,headers:{get:()=> 'application/json'},body:{getReader:()=>({read:async()=>{throw Error('truncated body');},cancel:async()=>{},releaseLock(){}})}})),request=start(h);await request.settled;
  assert.equal(request.result.error.code,'HTTP');assert.equal(request.result.error.status,404);assert.match(request.result.error.message,/接口不存在/);assert.equal(h.timer.size,0);
});

test('an abrupt reader network rejection still aborts and releases the reader',async()=>{
  let released=0,cancelled=0;const h=setup(async()=>({ok:true,headers:{get:()=> 'text/event-stream'},body:{getReader:()=>({read:async()=>{throw new Error('connection reset');},cancel:async()=>{cancelled++;},releaseLock(){released++;}})}})),request=start(h);await request.settled;
  assert.equal(request.result.error.message,'connection reset');assert.equal(cancelled,1);assert.equal(released,1);assert.equal(h.requests[0].options.signal.aborted,true);assert.equal(h.timer.size,0);
});

test('complete-looking output without a terminal event fails instead of authorizing actions',async()=>{
  for(const ending of ['eof','text-done','responses-done-marker']) {
    const stream=channel(),h=setup(async()=>stream.response),request=start(h);await flush();
    stream.event({type:'response.output_text.delta',delta:'{"message":"looks complete","actions":[{"type":"create_task","title":"Must not execute"}]}'});
    if(ending==='text-done')stream.event({type:'response.output_text.done',text:'{"actions":[]}'});
    if(ending==='responses-done-marker')stream.bytes('data: [DONE]\n\n');
    stream.close();await request.settled;assert.equal(request.result.error.code,'STREAM_INCOMPLETE');assert.equal(stream.released,1);
  }
});

test('an explicit completion ends a still-open stream and its final payload replaces partial deltas',async()=>{
  const stream=channel(),h=setup(async()=>stream.response),request=start(h);await flush();
  stream.event({type:'response.output_text.delta',delta:'partial'});
  stream.event({type:'response.completed',response:{status:'completed',output_text:'the authoritative complete result'}});
  await request.settled;assert.equal(request.result.value,'the authoritative complete result');assert.equal(stream.cancels,1);assert.equal(stream.released,1);
});

test('Chat SSE needs DONE and rejects truncated finish reasons even when JSON looks executable',async()=>{
  for(const mode of ['done','eof','length','content_filter']) {
    const stream=channel(),h=setup(async()=>stream.response),request=start(h);await flush();
    stream.event({choices:[{index:0,delta:{content:'{"actions":[]}'},finish_reason:null}]});
    stream.event({choices:[{index:0,delta:{},finish_reason:['length','content_filter'].includes(mode)?mode:'stop'}]});
    if(mode!=='eof')stream.bytes('data: [DONE]\n\n');stream.close();await request.settled;
    if(mode==='done')assert.equal(request.result.value,'{"actions":[]}');else assert.ok(request.result.error.code.startsWith('STREAM'));
  }
});

test('SSE event-name framing and response.done compatibility still require an explicit successful completion',async()=>{
  for(const terminal of ['response.completed','response.done']) {
    const stream=channel(),h=setup(async()=>stream.response),request=start(h);await flush();
    stream.bytes('event: response.output_text.delta\ndata: {"delta":"ok"}\n\n');
    stream.bytes(`event: ${terminal}\ndata: {"response":{"status":"completed"}}\n\n`);
    await request.settled;assert.equal(request.result.value,'ok');
  }
});

test('non-stream failed, incomplete, pending, explicit errors and malformed JSON are not successful replies',async()=>{
  for(const payload of [...['failed','incomplete','in_progress','queued','cancelled'].map(status=>JSON.stringify({status,output_text:'{"actions":[]}'})),JSON.stringify({error:{message:'Explicit failure'},output_text:'{"actions":[]}'}),'{"output_text":"truncated']) {
    const stream=channel('application/json'),h=setup(async()=>stream.response),request=start(h);await flush();stream.bytes(payload);stream.close();await request.settled;
    assert.ok(['STREAM_ERROR','INVALID_RESPONSE'].includes(request.result.error.code));assert.equal(stream.released,1);
  }
});
