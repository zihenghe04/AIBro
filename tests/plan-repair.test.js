const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const Core=require('../app/workstation-core');
const AttachmentAnalysis = require('../app/attachment-analysis');
const AttachmentContext=require('../app/attachment-context');
const AttachmentDelivery=require('../app/attachment-delivery');
const source=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
const cut=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}};
const plan=(priority='medium',workspace='日常')=>JSON.stringify({workspace,message:'整理完成',actions:[{type:'create_knowledge_item',title:'材料摘要',content:'原始信息',projectId:'project',workspace,sourceAttachmentIds:[]},{type:'create_task',title:'整理材料',priority,projectId:'project',workspace,sourceAttachmentIds:[]}]});
function harness(request) {
  const nodes=new Map(),requests=[];let next=0,commits=0;
  const el=key=>{if(!nodes.has(key))nodes.set(key,{value:'',textContent:'',disabled:false,scrollHeight:0,scrollTop:0,clientHeight:0,classList:{remove(){},add(){}},setAttribute(){},querySelector(){return null},appendChild(){},firstElementChild:{}});return nodes.get(key);};
  const state={projects:[{id:'project',name:'材料准备',workspace:'日常'}],tasks:[],notes:[],papers:[],imports:[],links:[],trash:[],agentRuns:[],conversations:[{id:'conversation',title:'Existing conversation',workspace:'日常',projectId:'project',messages:[],attachments:[]}],currentConversationId:'conversation',settings:{permissions:{'日常':'auto','科研':'approval'}}};
  const models={configuration:()=>({provider:'api',model:'frozen-model',effort:'high'}),resolve:async value=>value};
  const c=vm.createContext({state,Core,AttachmentContext,AttachmentDelivery,AttachmentAnalysis,$:el,window:{ConversationModels:models,AttachmentAnalysis},ConversationModels:models,localStorage:{getItem:()=>''},document:{createElement:()=>el('holder')},AbortController,URL,setTimeout,clearTimeout,
    uid:prefix=>`${prefix}-${++next}`,workspaceName:value=>value==='科研'||value==='课程'?value:'日常',classifyWorkspace:()=> '日常',currentConversation:()=>state.conversations[0],currentAttachments:()=>[],defaultModelConfiguration:()=>({provider:'api',model:'frozen-model',effort:'high'}),
    normalizeStateShape(){},save(){},renderAll(){},renderConversation(){},renderMessage(){},visiblePaper:()=>true,actionSummary:()=> '待批准的动作',addRunStep:(run,text,status)=>run.steps.push({text,status}),
    AgentTransport:{requestPlan:async options=>{requests.push(options);return request(options,requests.length)}},activeRunController:null,liveRenderTimer:null,
  });
  el('#agentInput').value='整理材料并创建任务';el('#apiBase').value='https://example.invalid/v1';el('#apiKey').value='fixture-key';
  vm.runInContext(cut('function activeResultRecord(', '\nfunction conversationProjectIds(') + cut('function dedupeResultEntries(', '\nfunction groupedEntities(') + cut('function commitAttachmentAnalysis(', '\nfunction executeActions(')+cut('function executeActions(', '\nfunction fallbackWorkflow(')+cut('function actionsNeedApproval(', '\nfunction actionSummary(')+cut('function assertRunActive(', '\nlet activeRunController')+cut('function apiOrigin(', '\nfunction renderSettings(')+cut('async function sendMessage(', '\n\nfunction formatBytes('),c);
  const actual=c.executeActions;c.executeActions=(...args)=>{commits++;return actual(...args)};
  return {c,state,requests,send:()=>c.sendMessage(),stop:()=>c.stopCurrentRun(),get commits(){return commits}};
}

test('one invalid priority is repaired then committed exactly once with frozen model and effort',{timeout:4000},async()=>{
  const h=harness(async(request,number)=>{const output=plan(number===1?'普通':'medium');request.onDelta(output.slice(0,14));request.onDelta(output);return output});
  await h.send();
  assert.equal(h.requests.length,2);assert.equal(h.commits,1);
  assert.equal(h.state.tasks.length,1);assert.equal(h.state.notes.length,1);
  assert.equal(h.state.tasks[0].priority,'medium');assert.equal(h.state.agentRuns[0].status,'completed',h.state.agentRuns[0].error);
  assert.equal(h.state.agentRuns[0].validationErrors.length,1);
  assert.match(h.requests[1].input,/普通/);assert.match(h.requests[1].input,/任务优先级无效/);
  for(const request of h.requests){assert.equal(request.model,'frozen-model');assert.equal(request.effort,'high');assert.equal(request.provider,'api');assert.equal(request.signal,h.requests[0].signal)}
});

test('two invalid plans stop after one repair and never commit even their valid preceding action',{timeout:4000},async()=>{
  const h=harness(async()=>plan('普通'));await h.send();
  assert.equal(h.requests.length,2);assert.equal(h.commits,0);
  assert.equal(h.state.tasks.length,0);assert.equal(h.state.notes.length,0);
  assert.equal(h.state.agentRuns[0].status,'failed');assert.match(h.state.agentRuns[0].error,/优先级/);
});

test('canceling the repair request prevents execution and does not request a third plan',{timeout:4000},async()=>{
  const repairing=deferred();
  const h=harness(async(request,count)=>{
    if(count===1)return plan('普通');repairing.resolve();
    return new Promise((_,reject)=>request.signal.addEventListener('abort',()=>{const error=new Error('已停止');error.code='CANCELLED';reject(error)},{once:true}));
  });
  const sending=h.send();await Promise.race([repairing.promise, sending.then(()=>{throw new Error('Workflow finished before repair request: '+h.state.agentRuns[0]?.error)})]);h.stop();await sending;
  assert.equal(h.requests.length,2);assert.equal(h.requests[1].signal.aborted,true);
  assert.equal(h.commits,0);assert.equal(h.state.tasks.length,0);assert.equal(h.state.notes.length,0);
  assert.equal(h.state.agentRuns[0].status,'cancelled');
});

test('repair never bypasses the actual target workspace approval policy',{timeout:4000},async()=>{
  const h=harness(async(_request,count)=>plan(count===1?'普通':'medium','科研'));
  h.state.projects[0].workspace='科研';
  // A misleading top-level workspace must not relax the protected target.
  const original=h.c.AgentTransport.requestPlan;
  h.c.AgentTransport.requestPlan=async options=>{const raw=await original(options);const data=JSON.parse(raw);data.workspace='日常';return JSON.stringify(data)};
  await h.send();
  assert.equal(h.requests.length,2);assert.equal(h.commits,0);
  assert.equal(h.state.tasks.length,0);assert.equal(h.state.notes.length,0);
  assert.equal(h.state.agentRuns[0].status,'awaiting-approval',h.state.agentRuns[0].error);
  assert.equal(h.state.agentRuns[0].pendingActions.length,2);
});

test('a late repair result after cancellation still cannot commit',{timeout:4000},async()=>{
  const repairing=deferred(),result=deferred();
  const h=harness(async(_request,count)=>{if(count===1)return plan('普通');repairing.resolve();return result.promise});
  const sending=h.send();await Promise.race([repairing.promise, sending.then(()=>{throw new Error('Workflow finished before repair request: '+h.state.agentRuns[0]?.error)})]);h.stop();result.resolve(plan());await sending;
  assert.equal(h.requests[1].signal.aborted,true);
  assert.equal(h.commits,0,'Host must also enforce cancellation before commit if a transport races with abort');
  assert.equal(h.state.tasks.length,0);assert.equal(h.state.agentRuns[0].status,'cancelled');
});

test('native PDF delivery does not duplicate extracted text and is retained through a plan repair', {timeout:4000}, async()=>{
  const h=harness(async(_request,number)=>plan(number===1?'普通':'medium'));
  const source={id:'native-pdf',name:'lesson.pdf',mimeType:'application/pdf',content:'EXTRACTED_FULLTEXT_MUST_NOT_BE_SENT',pages:[{page:1,text:'EXTRACTED_FULLTEXT_MUST_NOT_BE_SENT'}]};
  h.state.imports.push(source);h.c.currentAttachments=()=>[source];h.c.fileStoreGet=async()=>new Blob(['%PDF-test'],{type:'application/pdf'});
  await h.send();
  assert.equal(h.state.agentRuns[0].status,'completed',h.state.agentRuns[0].error);
  assert.equal(h.requests.length,2);
  for(const request of h.requests){
    assert.ok(Array.isArray(request.input));
    assert.equal(request.input[0].content.filter(block=>block.type==='input_file').length,1);
    assert.ok(!JSON.stringify(request.input).includes('EXTRACTED_FULLTEXT_MUST_NOT_BE_SENT'));
  }
  assert.equal(h.commits,1);
});

test('rejected native file input is not silently retried as extracted full text', {timeout:4000},async()=>{
  const h=harness(async()=>{const error=new Error('File input unsupported');error.code='HTTP';error.status=400;throw error});
  const source={id:'native-pdf',name:'lesson.pdf',mimeType:'application/pdf',content:'PRIVATE_EXTRACTED_TEXT'};
  h.state.imports.push(source);h.c.currentAttachments=()=>[source];h.c.fileStoreGet=async()=>new Blob(['%PDF-test'],{type:'application/pdf'});
  await h.send();
  assert.equal(h.requests.length,1);assert.equal(h.commits,0);
  assert.equal(h.state.agentRuns[0].status,'failed');assert.match(h.state.agentRuns[0].error,/未自动重发全文/);
  assert.ok(!JSON.stringify(h.requests[0].input).includes('PRIVATE_EXTRACTED_TEXT'));
});
