'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const B=require('../app/conversation-branches.js'),source=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
const cut=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,start);return source.slice(a,b);};
const clone=x=>JSON.parse(JSON.stringify(x));
const ids=c=>c.messages.map(m=>m.id);
function deferred(){let resolve,reject;return {promise:new Promise((a,b)=>{resolve=a;reject=b;}),resolve,reject};}
function actualFunction(name){const m=source.match(new RegExp(`(?:async )?function ${name}\\([^\\n]+`));assert.ok(m,name);const a=source.indexOf(m[0]);let b=source.indexOf('\n',a);while(b>0){const value=source.slice(a,b);try{new vm.Script(value);return value;}catch{}b=source.indexOf('\n',b+1);}throw Error(name);}
function fixture(){
 const c={id:'c',title:'Fixture',createdAt:1,updatedAt:1,messages:['u1','a1','u2','a2'].map(id=>({id,role:id[0]==='u'?'user':'agent',text:id})),draft:'unsubmitted',draftAttachmentIds:['file'],pendingSubmits:[{id:'q',goal:'next'}]};
 const other={id:'other',messages:[],draft:'other draft'};
 const state={conversations:[c,other],currentConversationId:'c',imports:[],agentRuns:[]};
 const calls={posts:[],renders:0,toasts:[],timers:new Map()};let serial=0,editing=false;
 const input={value:c.draft,selectionStart:2,selectionEnd:5,focus(){throw Error('must not focus');}};
 const ctx=vm.createContext({state,window:{ConversationBranches:B,workstationDesktop:{nativeWorkspacePersistence:true}},document:{querySelector:selector=>selector==='.message-edit'&&editing?{}:null},
  console,JSON,Date,structuredClone,storageHydrated:true,serverConflict:false,serverSaveInFlight:false,serverSaveQueued:false,serverSaveTimer:null,localEditVersion:0,initializingUI:false,
  purgeTrash:{syncPaused:false},localStorage:{getItem:()=>null},ensureConversation:()=>{},rememberCloudAppliedRevision:()=>{},notifyCloudAppliedRevision:()=>{},
  fetch:(url,request)=>{assert.equal(url,'/__state');const gate=deferred();calls.posts.push({snapshot:JSON.parse(request.body),gate});return gate.promise;},
  setTimeout:(fn,delay)=>{const id=++serial;calls.timers.set(id,{fn,delay});return id;},clearTimeout:id=>calls.timers.delete(id),
  sendMessage:()=>{},compactCurrentConversation:()=>{},approvalBusy:()=>false,showView:()=>{},PrivateMode:{shows:()=>true},
  toast:message=>calls.toasts.push(message),renderAll:()=>calls.renders++,uid:prefix=>`${prefix}-${++serial}`,$:selector=>selector==='#agentInput'?input:null});
 ctx.currentConversation=()=>ctx.state.conversations.find(x=>x.id===ctx.state.currentConversationId);
 vm.runInContext(cut('let serverSavePromise = null','// Native and Electron shutdown'),ctx);
 vm.runInContext(cut('function conversationPathSaving()', 'function openPathPanel()'),ctx);
 return {ctx,c,other,calls,input,edit:value=>editing=value,
  reply:(index=0,status=200)=>calls.posts[index].gate.resolve({ok:status===200,status,json:async()=>status===200?{revision:index+1}:{}})};
}

test('actual branch entry waits for real durable helper HTTP receipt, then uses tail count and complete stored path',async()=>{
 const h=fixture(),pending=h.ctx.forkConversationBranch('a1');
 assert.equal(h.calls.posts.length,1);assert.equal(h.calls.renders,0);assert.deepEqual(h.calls.toasts,[]);
 assert.deepEqual(h.calls.posts[0].snapshot.conversations[0].branches[0].messages.map(m=>m.id),['u1','a1','u2','a2']);
 assert.equal(h.ctx.sendMessage.busy,undefined,'local path saving must not impersonate an agent run');
 h.reply();const branch=await pending;assert.ok(branch.id);assert.equal(h.calls.renders,1);assert.match(h.calls.toasts[0],/之后的 2 条/);
 assert.equal(h.c.draft,'unsubmitted');assert.equal(h.input.selectionStart,2);assert.equal(h.input.selectionEnd,5);
 assert.equal(h.ctx.commitConversationPath.busy,false);
});

test('HTTP save failure rolls back only path fields and keeps new draft, attachments, queue and later metadata',async()=>{
 const h=fixture(),original=h.c.messages,pending=h.ctx.forkConversationBranch('a1');
 h.c.draft='new IME draft';h.input.value=h.c.draft;h.input.selectionStart=4;h.input.selectionEnd=8;
 h.c.draftAttachmentIds.push('second');h.c.pendingSubmits.push({id:'later'});h.c.title='renamed while waiting';h.c.updatedAt=123;
 h.reply(0,503);assert.equal(await pending,null);assert.equal(h.c.messages,original);
 for(const field of ['branches','activeBranch','activeBranchId'])assert.equal(Object.hasOwn(h.c,field),false,field);
 assert.equal(h.c.draft,'new IME draft');assert.equal(h.c.draftAttachmentIds.length,2);assert.equal(h.c.pendingSubmits.length,2);assert.equal(h.c.title,'renamed while waiting');assert.equal(h.c.updatedAt,123);
 assert.equal(h.calls.renders,0,'failure must not replace transcript/editor DOM');assert.deepEqual([h.input.value,h.input.selectionStart,h.input.selectionEnd],['new IME draft',4,8]);
 assert.match(h.calls.toasts.at(-1),/保存未确认/);assert.equal(h.ctx.serverSaveQueued,true,'rollback is queued for persistence');
});

test('switch uses the same durable boundary and rolls back on transport failure',async()=>{
 const h=fixture(),f=B.fork(h.c,'a1','old',2);Object.assign(h.c,{messages:f.keep,branches:[f.branch],activeBranch:f.activeBranch,activeBranchId:'main'});
 const before=JSON.stringify(h.c),pending=h.ctx.switchConversationBranch('old');assert.deepEqual(ids(h.c),['u1','a1','u2','a2']);
 h.calls.posts[0].gate.reject(Error('synthetic transport unavailable'));
 assert.equal(await pending,false);assert.equal(JSON.stringify(h.c),before);assert.equal(h.calls.renders,0);
});

test('pending save does not render or announce into a later conversation or route',async()=>{
 for(const change of ['conversation','route']){const h=fixture(),pending=h.ctx.forkConversationBranch('a1');
  if(change==='conversation')h.ctx.state.currentConversationId='other';else h.ctx.showView.navigationVersion=1;
  h.reply();assert.ok(await pending);assert.equal(h.calls.renders,0,change);assert.deepEqual(h.calls.toasts,[],change);assert.equal(h.other.draft,'other draft');
 }
});

test('same ID replacement owner and external path updates are never overwritten by an old failure',async()=>{
 for(const change of ['state','record','path']){const h=fixture(),pending=h.ctx.forkConversationBranch('a1');let replacement;
  if(change==='state'){replacement=clone(h.ctx.state);replacement.conversations[0].messages=[{id:'new',text:'new owner'}];h.ctx.state=replacement;}
  else if(change==='record'){replacement=clone(h.c);replacement.messages=[{id:'new',text:'replacement record'}];h.ctx.state.conversations[0]=replacement;}
  else h.c.messages=[{id:'new',text:'new path'}];
  h.reply(0,503);assert.equal(await pending,null);assert.deepEqual(ids(h.ctx.state.conversations[0]),['new'],change);assert.equal(h.calls.renders,0);
 }
});

test('repeated click and actual send/message/approval/quit entries cannot act on a pending path',async()=>{
 const h=fixture(),pending=h.ctx.forkConversationBranch('a1');
 assert.equal(await h.ctx.forkConversationBranch('a1'),null);assert.equal(await h.ctx.switchConversationBranch('main'),false);assert.equal(h.calls.posts.length,1);
 // Load actual production functions. Only their new front-door guard executes;
 // missing downstream dependencies make an accidental fall-through fail here.
 for(const name of ['sendMessage','submitComposer','updateRetryAttachments','dismissFailedMessage','branchConversationFrom','editUserMessageAndResend','openMessageEditor','continueRunCheckpoint','retryApprovalSave','approveRun','rejectRun','compactCurrentConversation']){
  vm.runInContext(actualFunction(name),h.ctx);assert.equal(await h.ctx[name]('fictional'),false,name);
 }
 vm.runInContext(cut('window.flushLocalDrafts = async function () {','window.flushWorkspace = async function () {'),h.ctx);
 h.ctx.window.ReadingPane={remember(){}};assert.equal(await h.ctx.window.flushLocalDrafts(),false);
 vm.runInContext(actualFunction('cloudConnectionBusy')+'\n'+actualFunction('cloudHostBusy'),h.ctx);assert.equal(h.ctx.cloudHostBusy(),true);
 h.reply();await pending;assert.equal(h.ctx.commitConversationPath.busy,false);
});

test('send preflight, editor draft and busy approval refuse branch before any mutation or fetch',async()=>{
 for(const mode of ['busy','preflight','preparingWiki','editor','approval']){const h=fixture(),before=JSON.stringify(h.c);
  if(mode==='editor')h.edit(true);else if(mode==='approval')h.ctx.approvalBusy=()=>true;else h.ctx.sendMessage[mode]={};
  assert.equal(await h.ctx.forkConversationBranch('a1'),null,mode);assert.equal(JSON.stringify(h.c),before);assert.equal(h.calls.posts.length,0);
 }
});

test('unprovable legacy history reports the real error without a save or destructive redraw',async()=>{
 const h=fixture();h.c.branches=[{id:'lost',fromMessageId:'unknown',messages:[{id:'tail',text:'old original'}]}];const before=JSON.stringify(h.c);
 assert.equal(await h.ctx.switchConversationBranch('lost'),false);assert.equal(JSON.stringify(h.c),before);assert.equal(h.calls.posts.length,0);assert.equal(h.calls.renders,0);assert.match(h.calls.toasts[0],/前文无法完整核实/);
});


test('an acknowledged path is not rolled back or labelled unsaved if its later renderer fails',async()=>{
 const h=fixture();h.ctx.renderAll=()=>{throw Error('synthetic render failure');};const pending=h.ctx.forkConversationBranch('a1');h.reply();
 assert.ok(await pending);assert.deepEqual(ids(h.c),['u1','a1']);assert.equal(h.c.branches[0].messages.length,4);assert.match(h.calls.toasts.at(-1),/路径已保存/);assert.equal(h.ctx.commitConversationPath.busy,false);
});

test('private source refuses a transition and permission change during receipt cannot cause a late render',async()=>{
 const h=fixture();h.ctx.PrivateMode.shows=()=>false;assert.equal(await h.ctx.forkConversationBranch('a1'),null);assert.equal(h.calls.posts.length,0);
 h.ctx.PrivateMode.shows=()=>true;const pending=h.ctx.forkConversationBranch('a1');h.ctx.PrivateMode.shows=()=>false;h.reply();assert.ok(await pending);assert.equal(h.calls.renders,0);assert.deepEqual(h.calls.toasts,[]);
});


test('an in-flight real feedback commit prevents archiving an unconfirmed message field',async()=>{
 const Feedback=require('../app/answer-feedback.js'),h=fixture();
 vm.runInContext(actualFunction('saveAnswerFeedbackDurably'),h.ctx);
 const controller=Feedback.createController({getConversation:id=>h.ctx.state.conversations.find(c=>c.id===id),save:h.ctx.saveAnswerFeedbackDurably});
 h.ctx.window.AnswerFeedback={isBusy:()=>controller.anyBusy()};
 const feedback=controller.commit('c','a1',{rating:'helpful'});assert.equal(h.c.messages[1].answerFeedback.rating,'helpful');
 assert.equal(await h.ctx.forkConversationBranch('a1'),null);assert.equal(h.calls.posts.length,1);assert.equal(h.c.branches,undefined);
 h.reply(0,503);await assert.rejects(feedback,/本机数据库暂时无法保存/);assert.equal(h.c.messages[1].answerFeedback,undefined);assert.deepEqual(ids(h.c),['u1','a1','u2','a2']);
});

test('feedback clicked during path saving immediately rolls back its field without another POST',async()=>{
 const Feedback=require('../app/answer-feedback.js'),h=fixture();
 vm.runInContext(actualFunction('saveAnswerFeedbackDurably'),h.ctx);
 const controller=Feedback.createController({getConversation:id=>h.ctx.state.conversations.find(c=>c.id===id),save:h.ctx.saveAnswerFeedbackDurably});
 const pending=h.ctx.forkConversationBranch('a1');
 await assert.rejects(controller.commit('c','a1',{rating:'helpful'}),/对话路径正在保存/);
 assert.equal(h.calls.posts.length,1);assert.equal(h.c.messages[1].answerFeedback,undefined);assert.equal(h.c.branches[0].messages[1].answerFeedback,undefined);
 h.reply();assert.ok(await pending);
});

test('queue persistence, open feedback editor and staged feedback draft also hold the path boundary',async()=>{
 for(const kind of ['queue','editor','stage']){const h=fixture();
  if(kind==='queue')h.ctx.window.AgentQueue={anyBusy:()=>true};
  if(kind==='editor')h.ctx.window.AnswerFeedback={isEditing:()=>true};
  if(kind==='stage'){h.ctx.stageAnswerFeedbackDraft=()=>{};h.ctx.stageAnswerFeedbackDraft.busy=true;}
  assert.equal(await h.ctx.forkConversationBranch('a1'),null,kind);assert.equal(h.calls.posts.length,0,kind);assert.equal(h.c.branches,undefined);
 }
});
