const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Q=require('../app/quick-voice-command');
// Reuse the established synthetic host scaffolding without registering/rerunning
// its older tests. sendMessage below is the actual current app function.
const fixtureSource=fs.readFileSync(require.resolve('./composer-send-state.test.js'),'utf8').split("\ntest(")[0];
const base=new Function('require',fixtureSource+'\nreturn harness;')(require);
const app=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
const part=app.slice(app.indexOf('function speechWorkspaceAvailable('),app.indexOf("function newConversation(workspace"));
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
const flush=async()=>{for(let i=0;i<24;i++)await Promise.resolve()};
function fixture(options={}){
 const h=base(options);let revision=0,composing=false,modal=false,settingsBusy=false;
 Object.assign(h.c,{storageHydrated:true,serverConflict:false,purgeTrash:Object.assign(()=>{},{syncPaused:false}),commitConversationPath:()=>{},compactCurrentConversation:()=>{},importMaterials:()=>{},taskEditorHasDrafts:()=>false,approvalBusy:()=>false,crypto:require('node:crypto').webcrypto,TextEncoder,Event:class{constructor(type){this.type=type}},showView:Object.assign(()=>{},{navigationVersion:1})});
 h.c.document.body={dataset:{view:'agent'}};h.c.document.querySelector=()=>modal?{}:null;
 h.c.window.ApprovalIntent=require('../app/approval-intent');h.c.window.TaskWorkflow=require('../app/task-workflow');
 h.c.window.ComposerDictation={init(){},revision:()=>revision,isComposing:()=>composing};h.c.window.QuickVoiceCommand=Q;
 h.c.ConversationModels.forNewConversation=()=>({provider:'api',model:'fixture',effort:''});
 h.node('#messageList').dataset.conversationId='a';h.node('#agentInput').dispatchEvent=e=>{assert.equal(e.type,'input');h.state.conversations.find(c=>c.id===h.state.currentConversationId).draft=h.node('#agentInput').value;revision++};
 h.c.saveDocumentDurably=async()=>{h.c.save();return true};
 h.c.openConversation=id=>{const old=h.state.conversations.find(c=>c.id===h.state.currentConversationId);old.draft=h.node('#agentInput').value;h.state.currentConversationId=id;h.node('#messageList').dataset.conversationId=id;h.node('#agentInput').value=h.state.conversations.find(c=>c.id===id).draft;h.c.showView.navigationVersion++;};
 vm.runInContext(part,h.c);h.c.initSpeechComposer();
 return{...h,compose:value=>composing=value,modal:value=>modal=value,edit:()=>revision++,submit:p=>Q.submit(p)};
}
const p={requestId:'e50-host-request-1',text:'总结我今天的安排',workspace:'日常',projectId:''};
test('public submit runs actual sendMessage once in a forced fresh conversation with exact durable receipt',async()=>{
 const model=gate(),h=fixture({request:()=>model.promise}),prior=structuredClone(h.state.conversations[0]);
 const submitted=await h.submit(p);assert.equal(submitted.status,'accepted',JSON.stringify({submitted,toasts:h.toasts}));await flush();assert.equal(h.requests.length,1,JSON.stringify(h.state.agentRuns[0]));assert.equal(h.state.agentRuns.length,1);assert.equal(h.state.agentRuns[0].conversationId,submitted.conversationId);assert.equal(h.state.agentRuns[0].status,'running');
 assert.equal(h.state.conversations[0].draft,'分析课件');assert.deepEqual(Array.from(h.state.conversations[0].draftAttachmentIds),prior.draftAttachmentIds);assert.equal(h.state.conversations[0].messages.length,0);
 const c=h.state.conversations.find(c=>c.id===submitted.conversationId);assert.equal(c.workspace,'日常');assert.equal(c.projectId,null);assert.equal(c.messages[0].quickVoiceRequestId,p.requestId);assert.deepEqual(Array.from(c.messages[0].attachmentIds),[]);
 assert.equal((await h.submit(p)).runId,submitted.runId);assert.equal(h.requests.length,1);model.resolve(JSON.stringify({message:'已答复',actions:[]}));await flush();
});
test('actual composer host commit repeats owner/scope/IME guard and uses normal input persistence',()=>{
 const h=fixture(),context=h.c.composerDictationContext();assert.equal(context.available,true);assert.equal(h.c.appendDictationDraft({conversationId:'a',before:'分析课件',text:'分析课件\n语音',context}),true);assert.equal(h.state.conversations[0].draft,'分析课件\n语音');
 const now=h.c.composerDictationContext();h.compose(true);assert.equal(h.c.appendDictationDraft({conversationId:'a',before:now.inputValue,text:'bad',context:now}),false);h.compose(false);h.state.projects[0].private=true;assert.equal(h.c.composerDictationContext().available,false);assert.equal(h.state.conversations[0].draft,'分析课件\n语音');
});
test('actual host refuses new voice command while IME/editor/record scope unavailable',async()=>{
 const h=fixture();h.compose(true);assert.equal((await h.submit(p)).reason,'composition_active');h.compose(false);h.modal(true);assert.equal((await h.submit(p)).reason,'editor_active');h.modal(false);
 h.state.projects[0].private=true;assert.equal((await h.submit({...p,workspace:'课程',projectId:'p'})).reason,'workspace_unavailable');assert.equal(h.state.conversations.length,2);assert.equal(h.requests.length,0);
});
test('voice background submit bypasses old-conversation draft shortcuts and preserves the visible editor',async()=>{
 const h=fixture();h.c.window.DraftReview={};h.c.handleDraftCommand=()=>{throw Error('A new voice chat cannot consume the old draft shortcut');};
 const result=await h.submit({...p,text:'采纳草稿'});await flush();assert.equal(result.status,'accepted');
 assert.equal(h.state.currentConversationId,'a');assert.equal(h.node('#messageList').dataset.conversationId,'a');assert.equal(h.node('#agentInput').value,'分析课件');
 assert.equal(h.state.conversations[0].draft,'分析课件');assert.deepEqual(Array.from(h.state.conversations[0].draftAttachmentIds),['pdf']);assert.equal(h.requests.length,1);
});
test('ordinary send permanently supersedes a prepared voice request before message paths can change',async()=>{
 const h=fixture();const c=h.state.conversations[0];c.quickVoiceRequest={version:1,requestId:'prepared-old',phase:'prepared'};await h.send({goal:'手动发送的文字'});assert.equal(c.quickVoiceRequest.phase,'superseded');assert.equal(c.messages[0].quickVoiceRequestId,undefined);
});
test('ordinary foreground send keeps its draft-command path and consumes only the submitted draft',async()=>{
 const h=fixture();let shortcuts=0;h.c.window.DraftReview={};h.c.handleDraftCommand=()=>{shortcuts++;return true;};
 await h.send();assert.equal(shortcuts,1);assert.equal(h.requests.length,0);assert.equal(h.node('#agentInput').value,'分析课件');
 const model=gate(),n=fixture({request:()=>model.promise});const sending=n.send();await flush();
 assert.equal(n.requests.length,1);assert.equal(n.node('#agentInput').value,'');
 n.node('#agentInput').value='新的前台输入';n.state.conversations[0].draft='新的前台输入';
 model.resolve(JSON.stringify({message:'已完成合成回答',actions:[]}));await sending;
 assert.equal(n.node('#agentInput').value,'新的前台输入');assert.equal(n.state.conversations[0].draft,'新的前台输入');
});
