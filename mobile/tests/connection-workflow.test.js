import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {webcrypto,createHash} from 'node:crypto';
import {Store,MemoryAdapter} from '../src/store.js';
import {ask} from '../src/ai.js';
import {createConnectionManager,parseOwnerPairing,supportsConnectionProfile} from '../src/connection-sync.js';
import {createNativeConnectionSync} from '../src/connection-sync-native.js';
import {transcribeWithConnections} from '../src/connection-speech.js';
import {saveModelSettings} from '../src/model-credentials.js';
import {saveSpeechCredential} from '../src/speech.js';
import {connectionServer} from './fixtures/connection-server.js';
const require=createRequire(import.meta.url);
const {createConnectionSyncClient}=require('../../app/connection-sync-client.js');
const {createConnectionVault}=require('../../app/connection-vault.js');
const cryptoAPI=createConnectionVault(webcrypto);
const origin='https://sync.example.test', accountId='account_fixture';
const clone=structuredClone;
const profile=(purpose='chat',key='synthetic-profile-key',model='synthetic-model')=>({format:'aibro.connection-profile.v1',purpose,
 provider:'openai-compatible',authKind:'api-key',apiFormat:{chat:'chat-completions',speech:'audio-transcriptions',embedding:'embeddings'}[purpose],
 baseUrl:'https://provider.example.test/v1',model,apiKey:key});
const aliyunSpeech=(overrides={})=>({...profile('speech'),provider:'aliyun',apiFormat:'aliyun-multimodal',
 baseUrl:'https://speech.example.test/api/v1/services/aigc/multimodal-generation/generation',model:'qwen-audio-3.0-asr-flash',language:'zh',...overrides});
function ownerDevice(cloud) {
 const session={serverOrigin:origin,accountId,sessionId:'owner_session',generation:1};let entry={revision:0,value:null};
 const atomicVault={read:async()=>clone(entry),compareAndSwap:async request=>{if(request.expectedRevision!==entry.revision)return false;entry={revision:entry.revision+1,value:clone(request.value)};return true;}};
 return createConnectionSyncClient({cryptoProvider:webcrypto,atomicVault,currentSession:()=>session,transport:request=>cloud.transport(request)});
}
async function phoneFixture(t,{supported=true,manual=false,sharedSpeech=profile('speech')}={}) {
 const cloud=await connectionServer(t),owner=ownerDevice(cloud),ownerInfo=await owner.initializeOwner();
 await owner.saveProfiles(['chat','speech','embedding'].map(purpose=>({profileId:purpose,profile:purpose==='speech'?sharedSpeech:profile(purpose)})));
 const store=await new Store(new MemoryAdapter()).load();
 await store.tx(s=>{s.binding={base:origin,accountID:accountId,deviceID:'phone_session',username:'fixture'};});
 let raw=JSON.stringify({base:origin,accountId,sessionId:'phone_session',token:'synthetic-cloud-token'}),fence='A'.repeat(43),entry={revision:0,value:null};
 const legacy=new Map();const vault={get:async key=>key==='sync'?raw:legacy.get(key),set:async(key,value)=>{if(key==='sync'){raw=value;fence='B'.repeat(43);}else legacy.set(key,value);},remove:async key=>{if(key==='sync'){raw=null;fence='C'.repeat(43);}else legacy.delete(key);}};
 const validate=args=>{assert.equal(args.sessionFence.nativeFence,fence);assert.ok(raw);assert.equal(args.binding.accountId,accountId);};
 const bridge={
  connectionSessionFence:async({expectedSyncSha256})=>{if(!raw||createHash('sha256').update(raw).digest('hex')!==expectedSyncSha256)throw Error('请重新连接');return {fence};},
  connectionVaultRead:async args=>{validate(args);return clone(entry);},
  connectionVaultCompareAndSwap:async args=>{validate(args);if(args.expectedRevision!==entry.revision)return {swapped:false};entry={revision:entry.revision+1,value:clone(args.value)};return {swapped:true};}
 };
 const http=async(url,options={})=>{
  if(url.endsWith('/v1/sync/capabilities'))return supported?{encryptedConnectionProfiles:{version:1,origin}}:{};
  assert.equal(options.headers.Authorization,'Bearer synthetic-cloud-token');
  const response=await cloud.transport({operation:url.split('/').at(-1),session:{accountId,sessionId:'phone_session'},deviceId:options.headers['X-AIBro-Connection-Device'],deviceSecret:options.headers['X-AIBro-Connection-Secret'],payload:options.body});
  if(response.status!==200)throw Object.assign(Error('synthetic server error'),{status:response.status});return response.body;
 };
 const opts={store,vault,bridge,http,native:true,cryptoAPI,createClient:createConnectionSyncClient,
  createTransport:options=>createNativeConnectionSync({...options,cryptoProvider:webcrypto})};
 const manager=createConnectionManager(opts);
 if(manual)await saveModelSettings(store,vault,{base:'https://manual.example.test/v1',model:'manual-model',format:'chat',key:'synthetic-manual-key'});
 const pairing={format:'aibro.connection-pairing.v1',serverOrigin:origin,accountId,publicJwk:ownerInfo.publicJwk,fingerprint:ownerInfo.deviceId};
 const pair=async()=>{
  await manager.refresh();assert.equal(manager.snapshot().stage,'available');
  await manager.refresh({register:true});assert.equal(manager.snapshot().stage,'pairing');
  const checked=await manager.previewPairing(JSON.stringify(pairing));
  await manager.pinOwner(checked,true);assert.equal(manager.snapshot().stage,'pending');
  const phoneId=manager.snapshot().deviceFingerprint;
  await owner.approveDevice({deviceId:phoneId,confirmedFingerprint:phoneId});await manager.refresh();assert.equal(manager.snapshot().stage,'ready');
  return phoneId;
 };
 return {cloud,owner,ownerInfo,store,vault,bridge,manager,pairing,pair,opts,entry:()=>entry,legacy};
}
async function answer(f,expectedKey='synthetic-profile-key',base='https://provider.example.test/v1',model='synthetic-model') {
 const calls=[];
 const result=await ask({store:f.store,vault:f.vault,connectionSync:f.manager,prompt:'解释这段合成资料',http:async(url,options)=>{calls.push({url,options});return {choices:[{message:{content:'合成模型回答。'},finish_reason:'stop'}]};}});
 assert.equal(result.status,'completed');assert.equal(calls[0].url,base+'/chat/completions');assert.equal(calls[0].options.headers.Authorization,'Bearer '+expectedKey);assert.equal(calls[0].options.body.model,model);
 return result;
}
test('actual crypto/server/native adapter pairing activates a chat model and updates it without putting keys in Store',async t=>{
 const f=await phoneFixture(t);await f.pair();await answer(f);
 assert.equal(f.store.state.settings.model,undefined);assert.equal(f.store.state.settings.connectionProfiles.chat.profileId,'chat');
 assert.equal(f.legacy.has('model'),false);assert.ok(!JSON.stringify(f.store.state).includes('synthetic-profile-key'));
 assert.ok(!JSON.stringify(f.manager.snapshot()).includes('apiKey'));assert.ok(!JSON.stringify(f.manager.snapshot()).includes('privateJwk'));
 await f.owner.saveProfiles([{profileId:'chat',profile:profile('chat','synthetic-next-key','new-model')}]);await f.manager.refresh();await answer(f,'synthetic-next-key','https://provider.example.test/v1','new-model');
 assert.ok(!JSON.stringify(f.store.state).includes('synthetic-next-key'));
});
test('manual model stays selected, synced purpose choice is explicit, and saving a manual model switches back safely',async t=>{
 const f=await phoneFixture(t,{manual:true});await f.pair();assert.equal(f.store.state.settings.connectionProfiles?.chat,undefined);
 await answer(f,'synthetic-manual-key','https://manual.example.test/v1','manual-model');
 await f.manager.choose('chat','chat');await answer(f);
 await saveModelSettings(f.store,f.vault,{base:'https://manual.example.test/v1',model:'manual-model',format:'chat',key:''});
 await answer(f,'synthetic-manual-key','https://manual.example.test/v1','manual-model');
 assert.equal(f.entry().value.activeProfiles.chat.apiKey,'synthetic-profile-key');
});
test('speech transcriptions use synced endpoint/model/key without writing the legacy speech slot',async t=>{
 const f=await phoneFixture(t,{sharedSpeech:{...profile('speech'),baseUrl:'https://provider.example.test/v1/audio/transcriptions',language:'en'}});await f.pair();let request;
 assert.equal(f.store.state.settings.connectionProfiles.speech.profileId,'speech');
 const text=await transcribeWithConnections({store:f.store,connectionSync:f.manager,vault:f.vault,audio:{durationMs:1000,data:Buffer.from('synthetic-audio').toString('base64'),mimeType:'audio/wav'},http:async(url,options)=>{request={url,options};return {text:'明天下午三点打篮球'};}});
 assert.equal(text,'明天下午三点打篮球');assert.equal(request.url,'https://provider.example.test/v1/audio/transcriptions');assert.equal(request.options.headers.Authorization,'Bearer synthetic-profile-key');
 const multipart=new TextDecoder().decode(request.options.bytes);assert.ok(multipart.includes('synthetic-model'));assert.match(multipart,/name="language"\r\n\r\nen\r\n/);assert.equal(f.legacy.has('speech'),false);
 const embedding=f.manager.snapshot().profiles.find(p=>p.purpose==='embedding');assert.equal(embedding.supported,false);assert.match(embedding.limitation,/尚未接入/);
});
test('Mac Aliyun speech auto-selects after pairing and updated endpoint/key/model/language drive actual transcription requests',async t=>{
 const f=await phoneFixture(t,{sharedSpeech:aliyunSpeech()});await f.pair();
 assert.equal(f.store.state.settings.connectionProfiles.speech.profileId,'speech');
 assert.equal(f.manager.snapshot().profiles.find(p=>p.id==='speech').supported,true);
 const audio={durationMs:1000,data:Buffer.from('synthetic-aac').toString('base64'),mimeType:'audio/mp4'};
 async function transcribe(expected) {
  let request;
  const text=await transcribeWithConnections({store:f.store,connectionSync:f.manager,vault:f.vault,audio,http:async(url,options)=>{request={url,options};return {output:{text:'明天下午三点打篮球'}};}});
  assert.equal(text,'明天下午三点打篮球');assert.equal(request.url,expected.baseUrl);
  assert.equal(request.options.headers.Authorization,'Bearer '+expected.apiKey);assert.equal(request.options.headers['X-DashScope-SSE'],'disable');
  assert.deepEqual(request.options.body,{model:expected.model,input:{messages:[{role:'user',content:[{type:'input_audio',input_audio:{data:'data:audio/mp4;base64,'+audio.data}}]}]},
   parameters:{format:'m4a',...(expected.language?{language_hints:[expected.language]}:{})}});
 }
 await transcribe(aliyunSpeech());
 const updated=aliyunSpeech({baseUrl:'https://speech-next.example.test/api/v1/services/aigc/multimodal-generation/generation',model:'qwen-audio-3.1-asr-flash',apiKey:'synthetic-new-speech-key',language:''});
 await f.owner.saveProfiles([{profileId:'speech',profile:updated}]);await f.manager.refresh();await transcribe(updated);
 assert.equal(f.legacy.has('speech'),false);assert.equal(f.store.state.settings.speech,undefined);
 for(const key of ['synthetic-profile-key','synthetic-new-speech-key'])assert.equal(JSON.stringify(f.store.state).includes(key),false);
 assert.equal(JSON.stringify(f.manager.snapshot()).includes('apiKey'),false);
});
test('speech manual setup and explicit manual opt-out survive refreshed Mac profiles and controller recreation',async t=>{
 const f=await phoneFixture(t,{sharedSpeech:aliyunSpeech()});
 const manual={provider:'openai',base:'https://manual-speech.example.test/v1',model:'manual-asr',language:'en'};
 await f.store.tx(async s=>{s.settings.speech=await saveSpeechCredential(f.vault,manual,'synthetic-manual-speech-key');});
 await f.pair();assert.equal(f.store.state.settings.connectionProfiles?.speech,undefined);
 let endpoint;await transcribeWithConnections({store:f.store,connectionSync:f.manager,vault:f.vault,audio:{durationMs:1000,data:'YWJj',mimeType:'audio/mp4'},http:async(url,options)=>{
  endpoint=url;assert.equal(options.headers.Authorization,'Bearer synthetic-manual-speech-key');return {text:'本机语音'};
 }});assert.equal(endpoint,'https://manual-speech.example.test/v1/audio/transcriptions');
 await f.manager.choose('speech','speech');await f.manager.choose('speech','');
 await f.store.tx(s=>{delete s.settings.speech;});
 for(const manager of [f.manager,createConnectionManager(f.opts)]) {
  await manager.refresh();assert.equal(f.store.state.settings.connectionProfiles.speech,undefined);assert.equal(f.store.state.settings.connectionManual.speech,true);
 }
 await f.manager.choose('speech','speech');assert.equal(f.store.state.settings.connectionManual.speech,undefined);
});
test('speech update or logout during transcription cannot submit the late transcript',async t=>{
 const f=await phoneFixture(t,{sharedSpeech:aliyunSpeech()});await f.pair();
 for(const change of ['profile','logout']) {
  let finish,started;const ready=new Promise(resolve=>started=resolve);
  const pending=transcribeWithConnections({store:f.store,connectionSync:f.manager,vault:f.vault,audio:{durationMs:1000,data:'YWJj',mimeType:'audio/mp4'},http:()=>{started();return new Promise(resolve=>finish=resolve);}});
  await ready;
  if(change==='profile'){await f.owner.saveProfiles([{profileId:'speech',profile:aliyunSpeech({language:'en'})}]);await f.manager.refresh();}
  else {f.manager.invalidate({signedOut:true});await f.vault.remove('sync');}
  finish({output:{text:'不得发送的迟到指令'}});await assert.rejects(pending);
 }
});
test('ambiguous and unsupported speech profiles do not get silently selected',async t=>{
 assert.equal(supportsConnectionProfile(aliyunSpeech({apiFormat:'audio-transcriptions'})),false);
 assert.equal(supportsConnectionProfile(aliyunSpeech({baseUrl:'https://speech.example.test/wrong-protocol'})),false);
 const f=await phoneFixture(t,{sharedSpeech:aliyunSpeech()});
 await f.owner.saveProfiles([{profileId:'other-speech',profile:aliyunSpeech({language:'en'})}]);await f.pair();
 assert.equal(f.store.state.settings.connectionProfiles?.speech,undefined);
 await f.manager.choose('speech','speech');assert.equal(f.store.state.settings.connectionProfiles.speech.profileId,'speech');
});
test('foreign/extra/tampered owner pairing cannot pin; trust requires explicit confirmation',async t=>{
 const f=await phoneFixture(t);await f.manager.refresh({register:true});
 for(const bad of [{...f.pairing,accountId:'foreign'},{...f.pairing,privateJwk:{}},{...f.pairing,fingerprint:'B'.repeat(43)}])await assert.rejects(f.manager.previewPairing(JSON.stringify(bad)));
 await assert.rejects(f.manager.pinOwner(f.pairing,false));assert.equal(f.entry().value.trustedOwner,null);
 await assert.rejects(parseOwnerPairing('x'.repeat(4097),f.pairing,cryptoAPI));
});
test('unsupported server does not register and leaves a working manual model unchanged',async t=>{
 const f=await phoneFixture(t,{supported:false,manual:true});const before=f.cloud.count();await f.manager.refresh({register:true});
 assert.equal(f.manager.snapshot().stage,'unsupported');assert.equal(f.cloud.count(),before);assert.equal(f.entry().value,null);
 await answer(f,'synthetic-manual-key','https://manual.example.test/v1','manual-model');
});
test('revocation blocks future calls and persists the block across controller recreation',async t=>{
 const f=await phoneFixture(t),phoneId=await f.pair();await f.owner.rotateAndRevoke([phoneId]);
 await assert.rejects(f.manager.refresh());assert.equal(f.manager.snapshot().stage,'blocked');
 for(const manager of [f.manager,createConnectionManager(f.opts)])await assert.rejects(ask({store:f.store,vault:f.vault,connectionSync:manager,prompt:'解释合成资料',http:()=>assert.fail('revoked model was called')}));
});
test('logout during a model response prevents returned tool calls from executing',async t=>{
 const f=await phoneFixture(t);await f.pair();let resolve,started;const ready=new Promise(r=>started=r);
 const pending=ask({store:f.store,vault:f.vault,connectionSync:f.manager,prompt:'查找课程资料',http:async()=>{started();return new Promise(r=>resolve=r);}});
 await ready;f.manager.invalidate({signedOut:true});await f.vault.remove('sync');
 resolve({choices:[{message:{tool_calls:[{id:'late',type:'function',function:{name:'propose_changes',arguments:JSON.stringify({actions:[{kind:'tasks',operation:'create',changes:{title:'must not appear'}}]})}}]},finish_reason:'tool_calls'}]});
 await assert.rejects(pending);assert.equal(f.store.list('tasks').length,0);assert.equal(f.manager.snapshot().stage,'disconnected');
});
test('local unambiguous schedule still creates a reviewable proposal without a model',async()=>{
 const store=await new Store(new MemoryAdapter()).load();
 const result=await ask({store,prompt:'明天下午三点打篮球，帮我新建日程',vault:{get:()=>assert.fail('local agenda should not read API key')},http:()=>assert.fail('local agenda should not call API')});
 assert.equal(result.pendingPlan.actions[0].kind,'agenda');assert.equal(store.list('notes').length,0);assert.equal(result.pendingPlan.status,'pending');
});

test('explicit manual choice remains manual through foreground checks and controller recreation',async t=>{
 const f=await phoneFixture(t);await f.pair();await f.manager.choose('chat','');
 for(const manager of [f.manager,createConnectionManager(f.opts)]) {
  await manager.refresh();assert.equal(f.store.state.settings.connectionProfiles.chat,undefined);
  assert.equal(f.store.state.settings.connectionManual.chat,true);
  await assert.rejects(ask({store:f.store,vault:f.vault,connectionSync:manager,prompt:'解释合成资料',http:()=>assert.fail('manual choice must not call a synced model')}));
 }
 await f.manager.choose('chat','chat');assert.equal(f.store.state.settings.connectionManual.chat,undefined);await answer(f);
});
