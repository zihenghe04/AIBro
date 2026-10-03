const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const Core=require('../app/workstation-core');
const source=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
function section(start,end){const from=source.indexOf(start),to=source.indexOf(end,from);assert.ok(from>=0&&to>from,`Actual host section: ${start}`);return source.slice(from,to);}
function fixture(){
 const conversation={id:'chat',messages:[]},run={id:'run',conversationId:'chat',status:'running',phase:'waiting',startedAt:20,steps:[]};
 const state={currentConversationId:'chat',conversations:[conversation,{id:'other-chat',messages:[]}],agentRuns:[run]};
 const calls={writes:0,refresh:0,composer:0,inspections:0};let text='old';
 const node={get textContent(){return text;},set textContent(value){text=value;calls.writes++;},parentElement:{classList:{toggle:(name,value)=>{assert.equal(name,'conversation-meta-quiet');node.quiet=value;}}}};
 const c=vm.createContext({state,Core,window:{AgentTransport:{inspectProtocolOutput:()=>{calls.inspections++;return null;}}},uid:()=> 'step',currentConversation:()=>state.conversations.find(row=>row.id===state.currentConversationId),$:selector=>selector==='#runStatus'?node:null,renderComposerActivity:()=>calls.composer++,refreshLive:()=>calls.refresh++,syncComposerModel(){}});
 vm.runInContext(section('function runStatusLabel(','\nfunction projectForAction('),c);
 vm.runInContext(section('function renderConversation() {',"  $('#conversationTitle').textContent =")+'}',c);
 vm.runInContext('function phaseUpdater(run){'+section('  const setPhase =','  const onActivity =')+'return setPhase;}',c);
 return {c,state,run,conversation,node,calls,phase:c.phaseUpdater(run)};
}

test('done preparation steps cannot turn a waiting live run into completed',()=>{
 const f=fixture();f.c.addRunStep(f.run,'准备请求','running');f.phase('waiting');f.c.addRunStep(f.run,'已读取引用','done');f.c.addRunStep(f.run,'已准备上下文','done');
 assert.equal(f.node.textContent,'● 等待模型响应');assert.equal(f.run.status,'running');assert.equal(f.run.steps.filter(step=>step.status==='running').length,0);assert.equal(f.node.quiet,false);assert.equal(f.calls.inspections,0);
 f.c.renderConversation();assert.equal(f.node.textContent,'● 等待模型响应');assert.equal(f.node.quiet,false);
});
test('real phase callback reports reasoning/output without inventing running steps or changing run lifecycle',()=>{
 const f=fixture();f.phase('reasoning');assert.equal(f.node.textContent,'● 模型思考中');f.phase('output');assert.equal(f.node.textContent,'● 正在生成回复');assert.deepEqual(f.run.steps,[]);assert.equal(f.run.status,'running');assert.equal(f.calls.refresh,2);
 f.c.addRunStep(f.run,'工具读取失败，准备其他路径','failed');assert.equal(f.node.textContent,'● 正在生成回复');assert.equal(f.run.status,'running');
});
test('a running tool step is shown until it settles, then header falls back to actual run phase',()=>{
 const f=fixture();f.c.addRunStep(f.run,'读取第二页','running');assert.equal(f.node.textContent,'● 读取第二页');f.c.addRunStep(f.run,'第二页读取完成','done');assert.equal(f.node.textContent,'● 等待模型响应');
});
test('pending approval/save statuses override done steps and late provider phase callbacks',()=>{
 for(const [status,label] of [['awaiting-approval','● 等待审批'],['awaiting-save','● 等待保存结果']]){
  const f=fixture();f.run.status=status;f.c.addRunStep(f.run,'某一步已完成','done');assert.equal(f.node.textContent,label);f.phase('output');assert.equal(f.node.textContent,label);assert.equal(f.node.quiet,false);f.c.renderConversation();assert.equal(f.node.textContent,label);
 }
});
test('provisional completed status stays waiting until save receipt acknowledges durable completion',()=>{
 for(const receipt of [{approvalReceipt:{savePending:true}},{executionReceipt:{phase:'applied'}}]){
  const f=fixture();Object.assign(f.run,{status:'completed'},receipt);f.c.addRunStep(f.run,'本机步骤已应用','done');assert.equal(f.node.textContent,'● 等待保存结果');assert.equal(f.node.quiet,false);
  if(f.run.approvalReceipt)f.run.approvalReceipt.savePending=false;if(f.run.executionReceipt)f.run.executionReceipt.phase='committed';f.c.renderRunStatus(f.run);assert.equal(f.node.textContent,'● 已完成');assert.equal(f.node.quiet,true);
 }
});
test('failed, cancelled and completed run states remain authoritative over individual done steps',()=>{
 for(const [status,label] of [['failed','● 执行失败'],['cancelled','● 已停止'],['completed','● 已完成'],['interrupted','● 已中断']]){const f=fixture();f.run.status=status;f.c.addRunStep(f.run,'日志处理完成','done');assert.equal(f.node.textContent,label);f.phase('waiting');assert.equal(f.node.textContent,label);}
});
test('older and background runs cannot overwrite the selected conversation latest header',()=>{
 const f=fixture(),old={id:'old',conversationId:'chat',status:'running',startedAt:10,steps:[]},foreign={id:'foreign',conversationId:'other-chat',status:'running',startedAt:100,steps:[]};f.state.agentRuns.push(old,foreign);f.c.renderConversation();const writes=f.calls.writes;
 f.c.addRunStep(old,'旧轮已完成步骤','done');f.c.phaseUpdater(old)('reasoning');f.c.addRunStep(foreign,'后台执行','running');f.c.phaseUpdater(foreign)('output');assert.equal(f.node.textContent,'● 等待模型响应');assert.equal(f.calls.writes,writes);assert.equal(f.node.quiet,false);
 f.state.currentConversationId='other-chat';f.c.renderConversation();assert.equal(f.node.textContent,'● 接收结构化计划');f.c.addRunStep(f.run,'旧对话回调','done');assert.equal(f.node.textContent,'● 接收结构化计划');
});
test('equal timestamps favor the later inserted run; an old completion cannot steal its header',()=>{
 const f=fixture(),next={id:'new',conversationId:'chat',status:'running',phase:'reasoning',startedAt:20,steps:[]};f.state.agentRuns.push(next);f.c.renderConversation();assert.equal(f.node.textContent,'● 模型思考中');f.run.status='completed';f.c.addRunStep(f.run,'旧轮完成','done');assert.equal(f.node.textContent,'● 模型思考中');
});
test('historical responseIssue failure remains visible through full render and late callbacks',()=>{
 const f=fixture();Object.assign(f.run,{status:'completed',validationErrors:['invalid'],pendingActions:[]});f.conversation.messages.push({id:'reply',runId:'run',role:'agent',text:'已完成整理。',live:false});
 f.c.renderConversation();assert.equal(f.node.textContent,'● 执行失败');f.c.addRunStep(f.run,'历史日志结束','done');assert.equal(f.node.textContent,'● 执行失败');assert.equal(f.run.status,'completed','Presentation must not rewrite persisted history');
 f.run.validationErrors=[];f.conversation.messages[0].text='unexecuted tool syntax';f.c.window.AgentTransport.inspectProtocolOutput=()=>({code:'MODEL_PROTOCOL_ERROR'});f.c.renderRunStatus();assert.equal(f.node.textContent,'● 执行失败');
});
test('no run shows waiting input and repeated equivalent phase updates do not rewrite the live region',()=>{
 const f=fixture();f.c.renderRunStatus();const writes=f.calls.writes;f.phase('waiting');f.phase('waiting');assert.equal(f.calls.writes,writes);f.state.agentRuns=[];f.c.renderConversation();assert.equal(f.node.textContent,'● 等待输入');assert.equal(f.node.quiet,true);
});
