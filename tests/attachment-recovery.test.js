const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
function harness(){
 const sent={id:'u',role:'user',attachmentIds:['ok','bad','missing'],attachments:[{id:'bad',name:'Synthetic.pdf'}]};
 const failed={id:'f',role:'agent',retryRunId:'r',runStatus:'failed'};
 const c={id:'c',draft:'Keep my draft',draftAttachmentIds:['new'],messages:[sent,failed,{id:'success',role:'agent',results:[{id:'note'}]}]};
 const run={id:'r',userMessageId:'u',conversationId:'c',attachmentIds:['ok','bad','missing'],status:'failed'};
 const state={currentConversationId:'c',conversations:[c,{id:'other',draft:'Other draft',messages:[]}],agentRuns:[run],imports:[{id:'ok'},{id:'bad'},{id:'missing',deletedAt:1},{id:'new'}]};
 const sendMessage=Object.assign(()=>{}, {busy:false});let saves=0;
 const h=vm.createContext({state,sendMessage,Date,toast(){},save(){saves++},renderConversation(){}});
 vm.runInContext(source.slice(source.indexOf('function retryAttachmentIdsFor('),source.indexOf('function showRetryAttachmentEditor(')),h);
 return {h,c,sent,failed,run,state,sendMessage,saves:()=>saves};
}
test('retry can exclude broken or all attachments without deleting sources or changing drafts/history',()=>{
 const x=harness(),before=JSON.stringify(x.state.imports);
 assert.equal(x.h.updateRetryAttachments('r',['ok']),true);
 assert.deepEqual(Array.from(x.h.retryAttachmentIdsFor(x.run)),['ok']);
 assert.deepEqual(x.run.attachmentIds,['ok','bad','missing']);
 assert.deepEqual(x.sent.attachmentIds,['ok','bad','missing']);
 assert.equal(JSON.stringify(x.state.imports),before);
 assert.equal(x.c.draft,'Keep my draft');assert.deepEqual(x.c.draftAttachmentIds,['new']);
 assert.equal(x.state.conversations[1].draft,'Other draft');
 assert.equal(x.h.updateRetryAttachments('r',[]),true);assert.equal(x.h.retryAttachmentIdsFor(x.run).length,0);
 const restored=JSON.parse(JSON.stringify(x.state));assert.deepEqual(restored.conversations[0].messages[0].retryAttachmentIds,[]);
});
test('retry selection rejects foreign/deleted attachments and running or deleted conversations',()=>{
 const x=harness();for(const ids of [['new'],['missing'],['unknown']])assert.equal(x.h.updateRetryAttachments('r',ids),false);
 x.sendMessage.busy=true;assert.equal(x.h.updateRetryAttachments('r',[]),false);x.sendMessage.busy=false;
 x.run.status='completed';assert.equal(x.h.updateRetryAttachments('r',[]),false);x.run.status='failed';
 x.c.deletedAt=1;assert.equal(x.h.updateRetryAttachments('r',[]),false);assert.equal(x.saves(),0);
});
test('failure deletion persists a tombstone and keeps successful results, user messages and sources',()=>{
 const x=harness();assert.equal(x.h.dismissFailedMessage('success'),false);
 assert.equal(x.h.dismissFailedMessage('u'),false);assert.equal(x.h.dismissFailedMessage('f'),true);
 assert.ok(x.failed.deletedAt);assert.equal(x.c.messages.length,3);assert.equal(x.state.imports.length,4);
 x.failed.deletedAt=null;x.sendMessage.busy=true;assert.equal(x.h.dismissFailedMessage('f'),false);
});
