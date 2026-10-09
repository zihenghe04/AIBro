import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, MemoryAdapter } from '../src/store.js';
import { VoiceSession } from '../src/voice-session.js';
import { voiceDestination, voiceDestinationLabel, prepareVoiceConversation } from '../src/voice-routing.js';

const defer = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
async function fixture() {
  const store = await new Store(new MemoryAdapter()).load();
  await store.put('projects', { id:'p', name:'合成研究项目' });
  for (const id of ['a','b']) await store.put('conversations', { id, title:'合成会话'+id, projectId:id==='a'?'p':null });
  return store;
}
function session(store, overrides = {}) {
  const submitted=[], timers=[];
  const voice = new VoiceSession({ record:{ start:async()=>{}, stop:async()=>({data:'YQ=='}), cancel:async()=>{} },
    transcribe:async()=>'把它改到明天', submit:async(text,requestId,destination)=>{
      const route=await prepareVoiceConversation(store,{text,requestId,destination}); submitted.push({text,...route}); return route;
    }, schedule:fn=>{timers.push(fn);return timers.length;}, unschedule:()=>{}, ...overrides });
  return { voice, submitted, timers };
}

test('conversation capture retains exact project and references despite later navigation/selection', async()=>{
  const store=await fixture(), refs=['notes:one'], destination=voiceDestination(store,'a',refs), f=session(store);
  await f.voice.start(destination); refs.splice(0,1,'notes:other');
  await f.voice.stop({autoSend:false}); await f.voice.send();
  assert.equal(f.submitted[0].conversationID,'a'); assert.equal(f.submitted[0].projectID,'p');
  assert.deepEqual(f.submitted[0].contextKeys,['notes:one']); assert.equal(store.list('conversations').length,2);
  assert.match(voiceDestinationLabel(destination),/当前对话「合成会话a」.*合成研究项目.*1 项引用/);
});
test('home and shortcut default to new unscoped chat; request retry reuses its durable ID',async()=>{
  const store=await fixture(), destination=voiceDestination(store);
  assert.equal(voiceDestinationLabel(destination),'新的 AI 会话');
  const args={requestId:'home-shortcut-request',destination,text:'合成新话题'};
  const first=await prepareVoiceConversation(store,args), reopened=await new Store(store.adapter).load();
  const retry=await prepareVoiceConversation(reopened,args);
  assert.equal(retry.conversationID,first.conversationID); assert.equal(retry.projectID,null);
  assert.deepEqual(retry.contextKeys,[]); assert.equal(reopened.list('conversations').length,3);
});
test('failed atomic preparation cannot leave an orphan chat before retry',async()=>{
  const store=await fixture(), before=structuredClone(store.state), write=store.adapter.write.bind(store.adapter);
  store.adapter.write=async()=>{throw Error('synthetic disk failure');};
  const args={requestId:'failed-create',destination:voiceDestination(store),text:'保留文字'};
  await assert.rejects(prepareVoiceConversation(store,args),/disk/); assert.deepEqual(store.state,before);
  store.adapter.write=write; await prepareVoiceConversation(store,args); await prepareVoiceConversation(store,args);
  assert.equal(store.list('conversations').length,3);
});
test('editing transcript returns to same chat, appends typed draft, preserves the other chat',async()=>{
  const store=await fixture(); await store.tx(s=>{s.drafts['chat:a']='原有未发送输入';s.drafts['chat:b']='另一会话草稿';});
  const f=session(store), destination=voiceDestination(store,'a',['notes:one']);
  await f.voice.start(destination); await f.voice.stop(); const oldTimer=f.timers[0];
  const route=await f.voice.edit((text,requestId,destination)=>prepareVoiceConversation(store,{text,requestId,destination,edit:true}));
  await oldTimer(); assert.equal(route.conversationID,'a'); assert.deepEqual(route.contextKeys,['notes:one']);
  assert.equal(route.draft,'原有未发送输入\n把它改到明天'); assert.equal(store.state.drafts['chat:b'],'另一会话草稿');
  assert.equal(f.submitted.length,0); assert.equal(f.voice.current.stage,'cancelled'); assert.equal(store.list('conversations').length,2);
});
test('direct voice send leaves existing typed draft intact and unavailable destinations never reroute',async()=>{
  for (const change of ['delete','archive','project']) {
    const store=await fixture(); await store.tx(s=>{s.drafts['chat:a']='另写了一段';});
    const destination=voiceDestination(store,'a');
    await prepareVoiceConversation(store,{requestId:'earlier',destination,text:'语音'});
    assert.equal(store.state.drafts['chat:a'],'另写了一段');
    if(change==='delete')await store.remove('conversations','a');
    else await store.put('conversations',{...store.get('conversations','a'),...(change==='archive'?{archived:true}:{projectId:null})});
    const before=structuredClone(store.state);
    await assert.rejects(prepareVoiceConversation(store,{requestId:'earlier',destination,text:'保留语音'}),/原会话/);
    assert.deepEqual(store.state,before);
  }
});
test('cancelled delayed transcription never creates or redirects a conversation',async()=>{
  const store=await fixture(), wait=defer(), f=session(store,{transcribe:()=>wait.promise});
  await f.voice.start(voiceDestination(store,'a',['notes:one'])); const stopping=f.voice.stop();
  await Promise.resolve(); await f.voice.cancel(); wait.resolve('迟到结果'); await stopping;
  assert.equal(f.submitted.length,0); assert.equal(store.list('conversations').length,2);
  assert.equal(store.state.settings.voiceSubmissions,undefined);
});
test('edit owns pending save: send, double edit, cancellation and stale countdown cannot race it',async()=>{
  const store=await fixture(), f=session(store), saving=defer(); await f.voice.start(voiceDestination(store,'a'));
  await f.voice.stop(); let edits=0;
  const editing=f.voice.edit(async()=>{edits++;await saving.promise;return {conversationID:'a'};});
  assert.equal(f.voice.current.stage,'editing'); await f.voice.send(); await f.timers[0]();
  assert.equal(await f.voice.edit(()=>assert.fail('duplicate edit')),null); assert.equal(await f.voice.cancel(),false);
  saving.resolve(); assert.deepEqual(await editing,{conversationID:'a'}); assert.equal(edits,1); assert.equal(f.submitted.length,0);
});
test('edit storage failure keeps transcript and original destination available for retry',async()=>{
  const store=await fixture(), f=session(store), destination=voiceDestination(store,'a');
  await f.voice.start(destination); await f.voice.stop({autoSend:false});
  assert.equal(await f.voice.edit(async()=>{throw Error('synthetic write failed');}),null);
  assert.equal(f.voice.current.stage,'failed'); assert.equal(f.voice.current.destination,destination);
  assert.equal(f.voice.current.text,'把它改到明天'); await f.voice.send();
  assert.equal(f.submitted[0].conversationID,'a'); assert.equal(store.list('conversations').length,2);
});
