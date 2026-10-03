const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const fixtureSource=fs.readFileSync(require.resolve('./composer-speech-host.test.cjs'),'utf8').split('\ntest(')[0];
const hostFixture=new Function('require',fixtureSource+'\nreturn fixture;')(require);
const app=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
const cut=(a,b)=>{const start=app.indexOf(a),end=app.indexOf(b,start);assert.ok(start>=0&&end>start);return app.slice(start,end);};
const flush=async()=>{for(let i=0;i<32;i++)await Promise.resolve();};
const payload={requestId:'e50-wiki-refresh-1',text:'整理虚构课程的观察安排',workspace:'日常',projectId:''};
function fixture(change){
 const h=hostFixture(),snapshots=[];let reads=0;
 h.c.state._wikiEnabled=true;h.c.state._revision=1;
 h.c.localEditVersion=0;h.c.beforePreviewLeave=async()=>true;h.c.rememberCloudAppliedRevision=()=>{};
 // These are the actual Wiki refresh, canonical adoption and sendMessage
 // functions; only local HTTP and persistence are replaced with an in-memory
 // synthetic canonical document. Never contacts a provider or a real workspace.
 h.c.save=()=>snapshots.push(structuredClone(h.c.state));
 h.c.openConversation=()=>{throw Error('Background voice must not open a conversation');};
 h.c.fetch=async url=>{
  assert.equal(url,'/__state');reads++;
  const snapshot=structuredClone(snapshots.at(-1));
  if(change)await change(h,snapshot);
  return{ok:true,json:async()=>snapshot};
 };
 vm.runInContext('currentConversation=()=>state.conversations.find(c=>c.id===state.currentConversationId);'+cut('function adoptCloudSnapshot(', '\nasync function applyCloudRevision(')+cut('async function refreshWikiVault(', '\nwindow.ProjectBoard?.init('),h.c);
 return{...h,snapshots,get reads(){return reads;}};
}
test('actual Wiki refresh adopts a canonical state shell then dispatches one durable voice run',async()=>{
 const h=fixture(),before=h.c.state;
 const result=await h.submit(payload);await flush();
 assert.equal(h.reads,1);assert.notEqual(h.c.state,before,'production adoption replaces state shell');
 assert.equal(result.status,'accepted',JSON.stringify({result,toasts:h.toasts}));
 assert.equal(h.requests.length,1);assert.equal(h.c.state.agentRuns.length,1);
 const conversation=h.c.state.conversations.find(c=>c.id===result.conversationId);
 assert.equal(conversation.messages.filter(m=>m.role==='user').length,1);
 assert.equal(conversation.messages[0].quickVoiceRequestId,payload.requestId);
 assert.ok(h.snapshots.some(s=>s.conversations.find(c=>c.id===result.conversationId)?.quickVoiceRequest?.phase==='accepted'));
 assert.equal((await h.submit(payload)).runId,result.runId);assert.equal(h.requests.length,1);
 assert.equal(h.c.state.conversations[0].draft,'分析课件');assert.equal(h.c.state.currentConversationId,'a');assert.equal(h.node('#agentInput').value,'分析课件');assert.deepEqual(Array.from(h.c.state.conversations[0].draftAttachmentIds),['pdf']);
});
test('a previously prepared voice draft retries in its same conversation after Wiki adoption',async()=>{
 const h=fixture();let reads=0;
 const refresh=h.c.fetch;h.c.fetch=async(...args)=>{reads++;if(reads===1)throw Error('synthetic local refresh failure');return refresh(...args);};
 const first=await h.submit(payload);assert.equal(first.reason,'send_not_started');
 const prepared=h.c.state.conversations.find(c=>c.id===first.conversationId);
 assert.equal(prepared.draft,payload.text);assert.equal(prepared.quickVoiceRequest.phase,'prepared');
 const second=await h.submit(payload);await flush();
 assert.equal(second.status,'accepted');assert.equal(second.conversationId,first.conversationId);
 assert.equal(h.c.state.conversations.length,3);assert.equal(h.requests.length,1);
 assert.equal(prepared.messages.filter(m=>m.role==='user').length,1);
});
test('foreground browsing during real Wiki refresh leaves visible draft and attachments untouched',async()=>{
 const h=fixture(h=>{
  h.c.state.currentConversationId='b';h.c.showView.navigationVersion++;
  h.node('#messageList').dataset.conversationId='b';h.node('#agentInput').value='另一草稿';
 });
 const result=await h.submit(payload);await flush();assert.equal(result.status,'accepted');
 assert.equal(h.c.state.currentConversationId,'b');assert.equal(h.node('#messageList').dataset.conversationId,'b');assert.equal(h.node('#agentInput').value,'另一草稿');
 assert.equal(h.c.state.conversations[0].draft,'分析课件');assert.deepEqual(Array.from(h.c.state.conversations[0].draftAttachmentIds),['pdf']);assert.equal(h.requests.length,1);
});
test('post-Wiki background dispatch rejects changed target draft, scope, privacy, permission or context',async()=>{
 for(const changed of ['draft','scope','private','permission','target-permission','attachments','model','marker']){
  const h=fixture((h,snapshot)=>{
   const row=snapshot.conversations.find(c=>c.quickVoiceRequest?.requestId===payload.requestId);
   if(changed==='draft')row.draft='new synthetic target draft';
   if(changed==='scope'){row.workspace='课程';row.projectId='p';}
   if(changed==='private')row.private=true;
   if(changed==='permission')h.c.window.PrivateMode={isOn:()=>true};
   if(changed==='target-permission')row.permissionMode='full';
   if(changed==='attachments'){row.attachments=['pdf'];row.draftAttachmentIds=['pdf'];}
   if(changed==='model')row.modelConfig.model='new-fixture';
   if(changed==='marker')row.quickVoiceRequest.phase='superseded';
  });
  const result=await h.submit(payload);await flush();
  assert.equal(result.status,'deferred',changed);assert.equal(h.requests.length,0,changed);assert.equal(h.c.state.agentRuns.length,0,changed);
  const row=h.c.state.conversations.find(c=>c.id===result.conversationId);
  assert.equal(row.messages.length,0,changed);assert.equal(row.quickVoiceRequest.phase,changed==='marker'?'superseded':'prepared',changed);
  assert.equal(h.c.state.currentConversationId,'a');assert.equal(h.node('#agentInput').value,'分析课件');
 }
});
test('same-ID target replacement after refresh cannot inherit the old background lease',async()=>{
 const h=fixture();h.c.renderAll=()=>{
  const i=h.c.state.conversations.findIndex(c=>c.quickVoiceRequest?.requestId===payload.requestId);
  h.c.state.conversations[i]=structuredClone(h.c.state.conversations[i]);
 };
 const result=await h.submit(payload);await flush();
 assert.equal(result.status,'deferred');assert.equal(h.requests.length,0);assert.equal(h.c.state.agentRuns.length,0);
 assert.equal(h.c.state.conversations.at(-1).draft,payload.text);assert.equal(h.c.state.currentConversationId,'a');
});
test('foreground edits during Wiki fetch preserve both drafts and expose a retryable refresh conflict',async()=>{
 const h=fixture(h=>{h.node('#agentInput').value='new human foreground draft';h.c.state.conversations[0].draft=h.node('#agentInput').value;h.c.localEditVersion++;});
 const result=await h.submit(payload);await flush();assert.equal(result.reason,'send_not_started');assert.equal(h.requests.length,0);
 assert.equal(h.node('#agentInput').value,'new human foreground draft');assert.equal(h.c.state.conversations[0].draft,'new human foreground draft');
 assert.equal(h.c.state.conversations.at(-1).draft,payload.text);assert.equal(h.c.state.conversations.at(-1).quickVoiceRequest.phase,'prepared');
 assert.ok(h.toasts.some(t=>t.includes('刷新期间出现新编辑')));
});
test('target context is frozen before its persistence await, not recaptured after an edit',async()=>{
 const h=fixture();let saves=0;const save=h.c.save;
 h.c.save=()=>{if(++saves===2)h.c.state.conversations.at(-1).permissionMode='full';return save();};
 const result=await h.submit(payload);await flush();assert.equal(result.reason,'context_changed');assert.equal(h.requests.length,0);assert.equal(h.reads,0);
 assert.equal(h.c.state.conversations.at(-1).permissionMode,'full');assert.equal(h.c.state.conversations.at(-1).quickVoiceRequest.phase,'prepared');
});
test('durable save may adopt an unchanged canonical shell before creating the independent voice chat',async()=>{
 const h=fixture();let adopted=false;
 h.c.save=()=>{
  h.snapshots.push(structuredClone(h.c.state));
  if(!adopted){adopted=true;h.c.adoptCloudSnapshot(structuredClone(h.c.state));}
 };
 const original=h.c.state.conversations[0],result=await h.submit(payload);await flush();
 assert.equal(adopted,true);assert.equal(result.status,'accepted');assert.equal(h.c.state.conversations[0],original);
 assert.equal(original.draft,'分析课件');assert.deepEqual(Array.from(original.draftAttachmentIds),['pdf']);assert.equal(h.requests.length,1);
});
