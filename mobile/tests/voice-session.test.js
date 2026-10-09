import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceSession, waitForVoiceAcceptance } from '../src/voice-session.js';
import { speechConfiguration, saveSpeechCredential, transcribeSpeech } from '../src/speech.js';
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};};
function fixture(overrides={}) {
 const events=[],submitted=[],cancelled=[],timers=[];
 const voice=new VoiceSession({record:{start:async()=>{},stop:async()=>({data:'YQ==',mimeType:'audio/mp4',durationMs:1200}),cancel:async id=>cancelled.push(id)},transcribe:async()=> '明天下午三点打篮球，帮我新建日程',submit:async(text,id)=>{submitted.push({text,id});return {conversationID:'test'};},onChange:r=>events.push(r),schedule:fn=>{timers.push(fn);return timers.length;},unschedule:()=>{},...overrides});
 return {voice,events,submitted,cancelled,timers};
}
test('record -> transcript preview -> one submission; no command before countdown',async()=>{
 const f=fixture();await f.voice.start();await f.voice.stop();assert.equal(f.voice.current.stage,'preview');assert.equal(f.submitted.length,0);assert.ok(f.voice.current.text.includes('打篮球'));
 await f.timers[0]();await f.voice.send();assert.equal(f.submitted.length,1);assert.equal(f.voice.current.stage,'sent');
});
test('cancelling during native permission acquisition cancels late recorder success',async()=>{
 const wait=defer(),f=fixture({record:{start:()=>wait.promise,cancel:async()=>{},stop:async()=>assert.fail()}});const start=f.voice.start();await f.voice.cancel();wait.resolve();await start;assert.equal(f.voice.current.stage,'cancelled');assert.equal(f.submitted.length,0);
});
test('cancelled transcription cannot submit a late result',async()=>{
 const wait=defer(),f=fixture({transcribe:()=>wait.promise});await f.voice.start();const stop=f.voice.stop();await new Promise(r=>setTimeout(r,0));await f.voice.cancel();wait.resolve('late transcript');await stop;assert.equal(f.voice.current.stage,'cancelled');assert.equal(f.submitted.length,0);assert.equal(f.timers.length,0);
});
test('an old preview timer cannot send a new recording or preview',async()=>{
 const f=fixture();await f.voice.start();await f.voice.stop();const old=f.timers[0];await f.voice.cancel();await f.voice.start();await f.voice.stop();await old();assert.equal(f.submitted.length,0);assert.equal(f.voice.current.stage,'preview');
});
test('limit requires explicit confirmation; interruption cancels an unsent capture',async()=>{
 const f=fixture();await f.voice.start();await f.voice.interrupted({requestId:f.voice.current.requestId,type:'limit'});assert.equal(f.voice.current.stage,'preview');assert.equal(f.timers.length,0);await f.voice.interrupted({requestId:f.voice.current.requestId,type:'cancelled'});assert.equal(f.voice.current.stage,'cancelled');assert.equal(f.submitted.length,0);
});
test('submission errors retain transcript for retry and do not claim success',async()=>{
 const f=fixture({submit:async()=>{throw Error('storage unavailable');}});await f.voice.start();await f.voice.stop({autoSend:false});await f.voice.send();assert.equal(f.voice.current.stage,'failed');assert.ok(f.voice.current.text);assert.match(f.voice.current.error,/storage/);
});
function vaultFixture(){const data=new Map();return {get:async k=>data.get(k),set:async(k,v)=>data.set(k,v)};}
const audio={data:'YWJj',mimeType:'audio/mp4',durationMs:1200};
test('speech key bound to provider/endpoint; changed service needs explicit key',async()=>{
 const vault=vaultFixture(),config={provider:'qwen',base:'https://speech.example/v1',model:'asr'};await saveSpeechCredential(vault,config,'synthetic-test-key');await saveSpeechCredential(vault,{...config,model:'asr-2'},'');
 await assert.rejects(saveSpeechCredential(vault,{...config,base:'https://other.example/v1'},''),/API Key/);assert.throws(()=>speechConfiguration({...config,base:'https://user:password@host/v1'}),/HTTPS/);
});
test('three ASR protocols send the actual audio and return only transcription',async()=>{
 for(const provider of ['openai','qwen','aliyun']){
  const vault=vaultFixture(),config={provider,base:'https://speech.example'+(provider==='aliyun'?'/compatible-mode/v1':'/v1'),model:'asr',language:'zh'};
  await saveSpeechCredential(vault,config,'synthetic-test-key');let request;
  const text=await transcribeSpeech({config,audio,vault,http:async(url,opts)=>{request={url,...opts};return provider==='openai'?{text:'你好'}:provider==='qwen'?{choices:[{message:{content:'你好'}}]}:{output:{text:'你好'}};}});
  assert.equal(text,'你好');assert.match(request.headers.Authorization,/synthetic/);
  if(provider==='openai'){assert.ok(request.bytes instanceof Uint8Array);const body=new TextDecoder().decode(request.bytes);assert.match(body,/filename="recording.m4a"/);assert.match(body,/abc/);assert.match(request.url,/audio\/transcriptions$/);}
  else {const msgs=provider==='qwen'?request.body.messages:request.body.input.messages;assert.equal(msgs[0].content[0].input_audio.data,'data:audio/mp4;base64,YWJj');if(provider==='aliyun'){assert.deepEqual(request.body.parameters,{format:'m4a',language_hints:['zh']});assert.equal(request.headers['X-DashScope-SSE'],'disable');}}
 }
});
test('silent, failed, oversized and cancelled ASR never become a command',async()=>{
 const vault=vaultFixture(),config={provider:'qwen',base:'https://speech.example/v1',model:'asr'};await saveSpeechCredential(vault,config,'synthetic-test-key');
 await assert.rejects(transcribeSpeech({config,audio,vault,http:async()=>({choices:[{message:{content:' '}}]})}),/没有识别/);
 await assert.rejects(transcribeSpeech({config,audio:{...audio,durationMs:200000},vault,http:async()=>assert.fail()}),/录音/);
 const controller=new AbortController();const wait=defer();const operation=transcribeSpeech({config,audio,vault,signal:controller.signal,http:()=>wait.promise});await new Promise(r=>setTimeout(r,0));controller.abort();wait.resolve({choices:[{message:{content:'must not send'}}]});await assert.rejects(operation,{name:'AbortError'});
});

test('DashScope rejects encoded audio over 10 MB before any network request',async()=>{
 const vault=vaultFixture(),config={provider:'aliyun',base:'https://speech.example/compatible-mode/v1',model:'qwen-audio-3.0-asr-flash'};
 await saveSpeechCredential(vault,config,'synthetic-test-key');
 const data='AAAA'.repeat(2_500_000);
 assert.ok(data.length*3/4<16*1024*1024);
 await assert.rejects(transcribeSpeech({config,audio:{...audio,data},vault,http:()=>assert.fail('oversize audio must not be uploaded')}),/10 MB/);
});

test('durable submission frees voice while the model runs; later failure stays with its chat',async()=>{
 const model=defer(),reported=[];let accept;
 const f=fixture({submit:()=>waitForVoiceAcceptance(callback=>{accept=callback;return model.promise;},e=>reported.push(e.message))});
 await f.voice.start();await f.voice.stop({autoSend:false});const sending=f.voice.send();
 await new Promise(r=>setTimeout(r,0));assert.equal(f.voice.current.stage,'submitting');
 accept({conversationID:'first'});await sending;assert.equal(f.voice.current.stage,'sent');
 await f.voice.start();assert.equal(f.voice.current.stage,'recording');
 model.reject(Error('first chat provider failure'));await new Promise(r=>setTimeout(r,0));
 assert.deepEqual(reported,['first chat provider failure']);assert.equal(f.voice.current.stage,'recording');
});
test('pre-acceptance failure or cancelled preparation preserves the voice transcript for retry',async()=>{
 for(const result of ['reject','cancel']){
  const f=fixture({submit:()=>waitForVoiceAcceptance(async()=>{if(result==='reject')throw Error('disk full');})});
  await f.voice.start();await f.voice.stop({autoSend:false});await f.voice.send();
  assert.equal(f.voice.current.stage,'failed');assert.ok(f.voice.current.text);
 }
});
