const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const Q=require('../app/quick-voice-command');
const gate=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j});return{promise,resolve,reject}};
const flush=async()=>{for(let i=0;i<18;i++)await Promise.resolve()};
function fixture(){let state={conversations:[{id:'old',draft:'existing',messages:[],attachments:['pdf'],draftAttachmentIds:['pdf'],draftFileReferences:[{id:'x'}]}],agentRuns:[],trash:[],currentConversationId:'old'},n=0,route=0,permitted=true,input='unsaved';
 const sent=[],saved=[],hooks={getState:()=>state,fingerprint:async text=>crypto.createHash('sha256').update(text).digest('hex'),canStart:()=>permitted,canContinue:()=>permitted,captureDispatch:c=>c,canDispatch:(owner,c)=>owner===c&&state.conversations.includes(c),preserveDraft:()=>{state.conversations.find(c=>c.id===state.currentConversationId).draft=input},save:async()=>{saved.push(structuredClone(state))},newConversation:(scope,text)=>({id:'voice-'+(++n),workspace:scope.workspace,projectId:scope.projectId,draft:text,messages:[],attachments:[],draftAttachmentIds:[]}),open:id=>{route++;state.currentConversationId=id;input=state.conversations.find(c=>c.id===id).draft},send:async o=>{sent.push(o);const c=state.conversations.find(c=>c.id===o.conversationId);c.messages.push({id:'u'+n,role:'user',text:o.goal,quickVoiceRequestId:o.voiceRequestId});state.agentRuns.push({id:'r'+n,conversationId:c.id,userMessageId:'u'+n});o.onAccepted({runId:'r'+n,userMessageId:'u'+n});}};
 return{hooks,submit:Q.create(hooks),get state(){return state},setState:v=>state=v,sent,saved,navigate:()=>route++,allow:v=>permitted=v,input:()=>input};
}
const payload={requestId:'voice-request-0001',text:'请帮我安排学习',workspace:'日常',projectId:''};
test('fresh independent daily conversation is sent once; old text and staging are preserved',async()=>{
 const f=fixture(),result=await f.submit(payload);assert.equal(result.status,'accepted');assert.equal(result.requestId,payload.requestId);assert.equal(f.sent.length,1);assert.notEqual(result.conversationId,'old');assert.deepEqual(f.state.conversations[0],{id:'old',draft:'unsaved',messages:[],attachments:['pdf'],draftAttachmentIds:['pdf'],draftFileReferences:[{id:'x'}]});assert.equal(f.state.conversations[1].workspace,'日常');assert.equal(f.state.conversations[1].projectId,null);assert.deepEqual(f.state.conversations[1].attachments,[]);assert.equal(f.saved.at(-1).conversations[1].quickVoiceRequest.phase,'accepted');
 assert.equal((await f.submit(payload)).reason,'already_submitted');assert.equal(f.sent.length,1);
});
test('same in-flight ID shares one send; different payload/id cannot overtake',async()=>{
 const f=fixture(),g=gate();f.hooks.save=()=>g.promise;const a=f.submit(payload),b=f.submit({...payload});assert.equal(a,b);assert.equal((await f.submit({...payload,text:'other'})).status,'error');assert.equal((await f.submit({...payload,requestId:'another-request'})).status,'deferred');g.resolve(true);assert.equal((await a).status,'accepted');assert.equal(f.sent.length,1);
});
test('restart replay uses tagged submitted message/run; unrelated user never proves voice acceptance',async()=>{
 const f=fixture();await f.submit(payload);f.setState(JSON.parse(JSON.stringify(f.state)));assert.equal((await Q.create(f.hooks)(payload)).status,'accepted');assert.equal(f.sent.length,1);
 f.state.conversations[1].messages[0].quickVoiceRequestId='other';assert.equal((await f.submit(payload)).status,'uncertain');assert.equal(f.sent.length,1);
});
test('draft save failure or permission revocation during save does not create or send',async()=>{
 const f=fixture();f.hooks.save=async()=>{throw Error('disk')};assert.equal((await f.submit(payload)).reason,'draft_save_failed');assert.equal(f.state.conversations.length,1);assert.equal(f.sent.length,0);
 const a=fixture(),g=gate();a.hooks.save=()=>g.promise;const p=a.submit(payload);await flush();a.allow(false);g.resolve(true);assert.equal((await p).reason,'context_changed');assert.equal(a.state.conversations.length,1);assert.equal(a.sent.length,0);
});
test('busy/IME/privacy gate returns deferred without changing existing draft or navigation',async()=>{
 for(const reason of ['execution_busy','composition_active','workspace_unavailable','editor_active']){const f=fixture();f.allow(reason);const before=structuredClone(f.state);assert.equal((await f.submit(payload)).reason,reason);assert.deepEqual(f.state,before);assert.equal(f.sent.length,0);}
});
test('dispatch durable uncertainty is never blindly replayed; definite early send exit is retryable',async()=>{
 const f=fixture();f.hooks.send=async()=>{throw Error('lost receipt')};const r=await f.submit(payload);assert.equal(r.status,'uncertain');assert.equal((await f.submit(payload)).status,'uncertain');
 const b=fixture();const send=b.hooks.send;b.hooks.send=async()=>false;assert.equal((await b.submit(payload)).reason,'send_not_started');assert.equal(b.state.conversations[1].draft,payload.text);b.hooks.send=send;assert.equal((await b.submit(payload)).status,'accepted');assert.equal(b.state.conversations.length,2);
});
test('actual submission but failed durability reports uncertain; retry returns original tagged run',async()=>{
 const f=fixture();let writes=0;const save=f.hooks.save;f.hooks.save=async()=>{if(++writes===4)throw Error('lost persistence');return save()};const r=await f.submit(payload);assert.equal(r.status,'uncertain');assert.equal(r.reason,'submitted_save_unconfirmed');assert.equal(f.sent.length,1);assert.equal((await f.submit(payload)).status,'accepted');assert.equal(f.sent.length,1);
});
test('retired or ambiguous request IDs and unknown input fields cannot create another conversation',async()=>{
 const f=fixture();await f.submit(payload);f.state.trash.push({data:{conversations:[f.state.conversations.pop()]}});assert.equal((await f.submit(payload)).status,'error');assert.equal(f.sent.length,1);assert.equal((await f.submit({...payload,scope:{}})).reason,'invalid_request');
});
test('normal browsing during preservation does not navigate or cancel the authorized background command',async()=>{
 const f=fixture(),g=gate();const save=f.hooks.save;let first=true;f.hooks.save=async()=>{if(first){first=false;await g.promise;}return save()};
 f.hooks.open=()=>{throw Error('Must not open UI')};const pending=f.submit(payload);await flush();f.navigate();g.resolve(true);
 assert.equal((await pending).status,'accepted');assert.equal(f.sent[0].background,true);assert.equal(f.state.currentConversationId,'old');assert.equal(f.input(),'unsaved');
});
test('a changed request marker during dispatch persistence is never sent or reset as the old request',async()=>{
 const f=fixture(),save=f.hooks.save;let writes=0;
 f.hooks.save=async()=>{await save();if(++writes===3)f.state.conversations[1].quickVoiceRequest={version:1,requestId:'replacement-request',fingerprint:'changed',phase:'superseded'};};
 assert.equal((await f.submit(payload)).reason,'context_changed');assert.equal(f.sent.length,0);assert.equal(f.state.conversations[1].quickVoiceRequest.phase,'superseded');
});
test('prepared chat used manually cannot be submitted again by the old request even if the same text is retyped',async()=>{
 const f=fixture();f.hooks.send=async()=>false;await f.submit(payload);const c=f.state.conversations[1];c.messages.push({id:'manual',role:'user',text:payload.text});c.draft=payload.text;let sent=0;f.hooks.send=async()=>sent++;
 assert.equal((await f.submit(payload)).reason,'conversation_changed');assert.equal(sent,0);c.messages=[];c.quickVoiceRequest.phase='superseded';assert.equal((await f.submit(payload)).reason,'conversation_changed');assert.equal(sent,0);
});

test('same request manually superseded during prepared save is never made dispatchable again',async()=>{
 const f=fixture(),save=f.hooks.save;let writes=0;
 f.hooks.save=async()=>{await save();if(++writes===2)f.state.conversations[1].quickVoiceRequest.phase='superseded';};
 assert.equal((await f.submit(payload)).reason,'context_changed');assert.equal(f.sent.length,0);assert.equal(f.state.conversations[1].quickVoiceRequest.phase,'superseded');
});
