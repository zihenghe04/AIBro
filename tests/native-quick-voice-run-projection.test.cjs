const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Reuse only the existing in-memory production bridge fixture, not its suites.
const source=fs.readFileSync(require.resolve('./native-quick-workbench.test.cjs'),'utf8').split("\ntest(")[0];
const make=new Function('require','__dirname',source+'\nreturn fixture;')(require,__dirname);
const clone=value=>JSON.parse(JSON.stringify(value));
const requestId='18DB26EA-E9F8-4C31-A74F-083320F47FB8';
function fixture(){
 const f=make(),chat=f.state.conversations[0],run=f.state.agentRuns[0];
 chat.quickVoiceRequest={version:1,requestId,phase:'accepted',runId:run.id,userMessageId:'user-voice'};
 chat.messages=[{id:'user-voice',role:'user',text:'安排虚构课程观察',quickVoiceRequestId:requestId},
  {id:'answer-voice',role:'agent',text:'虚构课程观察应先核对时间，再确认具体安排。',runId:run.id,live:true}];
 run.userMessageId='user-voice';
 vm.runInContext(fs.readFileSync(require.resolve('../app/run-outcome-presentation.js'),'utf8'),f.context);
 return {...f,chat,run,user:chat.messages[0],answer:chat.messages[1]};
}
function completed(f){Object.assign(f.run,{status:'completed',finishedAt:30,executionReceipt:{version:1,phase:'committed',messageId:f.answer.id,answer:f.answer.text}});f.answer.live=false;return f;}
test('only the exact accepted voice request projects bounded text with real run status',()=>{
 const f=fixture(),before=clone(f.state),running=f.snapshot().runs[0];
 assert.equal(running.conversationId,f.chat.id);assert.equal(running.userMessageId,f.user.id);assert.equal(running.voiceRequestId,requestId);
 assert.equal(running.voiceTranscript,f.user.text);assert.equal(running.resultSummary,undefined);assert.equal(running.isActive,true);
 assert.deepEqual(clone(f.state),before);assert.equal(f.calls.persist,0);assert.equal(f.calls.cancel,0);
 completed(f);const row=f.snapshot().runs[0];assert.equal(row.resultSummary,f.answer.text);assert.equal(row.notificationReady,true);
 assert.equal(row.resultTasks,undefined,'Final prose is not a fabricated task/calendar receipt');
});
test('ordinary chat and malformed/ambiguous voice identity never attach any message body',()=>{
 const changes=[f=>delete f.chat.quickVoiceRequest,f=>{f.chat.quickVoiceRequest.requestId='../not-legal';},
  f=>{f.chat.quickVoiceRequest.version=2;},f=>{f.chat.quickVoiceRequest.phase='prepared';},
  f=>{f.chat.quickVoiceRequest.runId='another-run';},f=>{f.chat.quickVoiceRequest.userMessageId='another-user';},
  f=>{f.user.quickVoiceRequestId='different-request';},f=>{f.user.role='agent';},
  f=>f.chat.messages.push(clone(f.user)),f=>{f.run.conversationId='missing';}];
 for(const change of changes){const f=completed(fixture());change(f);const row=f.snapshot().runs[0];
  for(const key of ['voiceRequestId','voiceTranscript','resultSummary','conversationId','userMessageId'])assert.equal(row?.[key],undefined,key);
 }
});
test('private, removed and hidden message owners are rechecked on every snapshot',()=>{
 for(const change of [f=>{f.context.PrivateMode.isOn=()=>true;},f=>{f.chat.private=true;},f=>{f.run.private=true;},
  f=>{f.state.projects[0].private=true;},f=>f.state.conversations.splice(0),f=>f.state.projects.splice(0)]){
  const f=completed(fixture());assert.ok(f.snapshot().runs[0].voiceTranscript);change(f);
  assert.equal(JSON.stringify(f.snapshot()).includes('安排虚构课程观察'),false);
  assert.equal(JSON.stringify(f.snapshot()).includes('虚构课程观察应先'),false);
 }
 for(const field of ['private','ephemeral','incognito','hidden','internal','deleted']){
  const f=completed(fixture());f.user[field]=true;assert.equal(f.snapshot().runs[0]?.voiceTranscript,undefined,field);
 }
 const f=completed(fixture());f.user.channel='reasoning';assert.equal(f.snapshot().runs[0].voiceTranscript,undefined);
});
test('failed, awaiting and unconfirmed completions cannot emit a final summary',()=>{
 for(const status of ['running','awaiting-approval','awaiting-save','awaiting-input','failed','cancelled','interrupted','rejected']){
  const f=completed(fixture());f.run.status=status;assert.equal(f.snapshot().runs[0].resultSummary,undefined,status);
 }
 for(const change of [f=>delete f.run.executionReceipt,f=>{f.run.executionReceipt.phase='applied';},
  f=>{f.run.executionReceipt.messageId='wrong';},f=>{f.answer.live=true;},f=>{f.answer.runId='wrong';},
  f=>{f.run.approvalReceipt={savePending:true};},f=>{f.run.approvalSaveError='synthetic save error';},
  f=>{f.answer.hidden=true;},f=>{f.answer.channel='analysis';},f=>f.chat.messages.push(clone(f.answer))]){
  const f=completed(fixture());change(f);const row=f.snapshot().runs[0];assert.equal(row.resultSummary,undefined);
  assert.notEqual(row.status,'completed');assert.equal(row.notificationReady,false);
 }
});
test('excerpt budgets preserve the saved source and do not split a surrogate pair',()=>{
 const f=completed(fixture());f.user.text='u'.repeat(998)+'😀'+'TAIL';f.answer.text='a'.repeat(598)+'😀'+'END';
 const row=f.snapshot().runs[0];assert.ok(row.voiceTranscript.length<=1000);assert.ok(row.resultSummary.length<=600);
 assert.match(row.voiceTranscript,/…$/);assert.match(row.resultSummary,/…$/);
 assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(row.voiceTranscript+row.resultSummary),false);
 assert.match(f.user.text,/TAIL$/);assert.match(f.answer.text,/END$/);
});
test('final answer follows canonical message mutation and actual helper approval text',()=>{
 const f=completed(fixture());assert.equal(f.snapshot().runs[0].resultSummary,f.answer.text);
 f.answer.text='更新后的合成回答';assert.equal(f.snapshot().runs[0].resultSummary,'更新后的合成回答');
 f.run.routingReview={required:true,message:'需确认课程'};
 f.run.approvalReceipt={id:'approval',messageId:f.answer.id,metadataSettled:true,savePending:false,appliedAt:20,settledAt:30};
 f.answer.planPreview=true;f.answer.text='需确认课程\n\n合成结果\n\n已批准并执行，具体结果见下方。';
 const summary=f.snapshot().runs[0].resultSummary;assert.match(summary,/课程归属已确认/);assert.doesNotMatch(summary,/需确认课程/);
});
test('a legacy earlier tool message cannot mask a protocol failure in the exact final answer',()=>{
 const f=completed(fixture());f.chat.messages.splice(1,0,{id:'tool-before',role:'tool',runId:f.run.id,text:'tool text',live:false});
 f.answer.text='<｜DSML｜function_calls><｜DSML｜invoke name="tool">';
 const row=f.snapshot().runs[0];assert.equal(row.resultSummary,undefined);assert.equal(row.status,'failed');assert.equal(row.notificationReady,false);
});
test('calendar proposals show waiting for confirmation until their native receipts arrive',()=>{
 const f=completed(fixture());f.run.agendaProposals=[{id:'proposal-one',operation:'delete'}];
 let pending=true;f.context.AgendaProposals={hasPending:run=>run===f.run&&pending};
 let row=f.snapshot().runs[0];assert.equal(row.status,'awaiting-approval');assert.equal(row.notificationReady,false);
 assert.equal(row.resultSummary,f.answer.text,'The saved proposal explanation remains visible in the island');
 pending=false;row=f.snapshot().runs[0];assert.equal(row.status,'completed');assert.equal(row.notificationReady,true);
 assert.equal(f.calls.persist,0,'Snapshots do not rewrite the original run');
});
