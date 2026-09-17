const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const Core=require('../app/workstation-core');
const AttachmentAnalysis = require('../app/attachment-analysis');
const TaskContext = require('../app/task-context');
const ConversationWeb = require('../app/conversation-web');
const source=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
const cut=(a,b)=>{const start=source.indexOf(a),end=source.indexOf(b,start);assert.ok(start>=0&&end>start,`extract ${a}`);return source.slice(start,end);};
const clone=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};
function harness(options={}){
 let n=0;const nodes=new Map(),saved=[],deliveries=[],requests=[],toasts=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',innerHTML:'',disabled:false,style:{height:'180px'},dataset:{},scrollHeight:0,scrollTop:0,clientHeight:0,classList:{remove(){},add(){}},setAttribute(){},querySelector(){return null},querySelectorAll(){return[]},appendChild(){},firstElementChild:{},focus(){},close(){}});return nodes.get(id);};
 const state={projects:[{id:'p',name:'智能系统课程',workspace:'课程'}],imports:[{id:'pdf',name:'47页课件.pdf',originalName:'lecture.pdf',mimeType:'application/pdf',size:100,content:'原始全文',createdAt:1}],tasks:[],notes:[],papers:[],links:[],trash:[],attachments:[],agentRuns:[],settings:{permissions:{'课程':'auto'}},conversations:[{id:'a',title:'Existing',projectId:'p',workspace:'课程',messages:[],attachments:['pdf'],draftAttachmentIds:['pdf'],draft:'分析课件'},{id:'b',title:'另一对话',projectId:null,workspace:'日常',messages:[],attachments:[],draftAttachmentIds:[],draft:'另一草稿'}],currentConversationId:'a'};
 const models={configuration:()=>({provider:'api',model:'fixture',effort:''}),resolve:options.resolve|| (async value=>value)};
 const c=vm.createContext({structuredClone,state,Core,ConversationWeb,fetch:options.fetch,projectIsActive:id=>!id||state.projects.some(p=>p.id===id&&!p.archived),AttachmentAnalysis,TaskContext,Research:{},$ :node,window:{ConversationModels:models,AttachmentAnalysis,TaskContext,ConversationWeb: options.web ? ConversationWeb : null},ConversationModels:models,localStorage:{getItem:()=>''},document:{createElement:()=>node('holder')},AbortController,URL,setTimeout,clearTimeout,activeRunController:null,liveRenderTimer:null,draftSaveTimer:null,
   uid:prefix=>`${prefix}-${++n}`,workspaceName:v=>['课程','科研'].includes(v)?v:'日常',classifyWorkspace:()=> '课程',currentConversation:()=>state.conversations.find(item=>item.id===state.currentConversationId),defaultModelConfiguration:()=>({provider:'api',model:'fixture',effort:''}),
   save:()=>saved.push(clone(state)),renderAll(){},renderConversation(){},renderMessage(){},toast:message=>toasts.push(message),visiblePaper:()=>true,visibleNote:()=>true,actionSummary:()=>'',actionsNeedApproval:()=>false,executeActions:()=>[],addRunStep:(run,text,status)=>run.steps.push({text,status}),
   AttachmentContext:require('../app/attachment-context'),AttachmentDelivery:{prepare:async items=>{deliveries.push(Array.from(items,item=>item.id));return{blocks:[],metadata:options.metadata||[],textAttachments:[],coverage:{},stageLabel:'原件已准备'};}},
   AgentTransport:{requestPlan:async request=>{requests.push(request);return options.request?options.request(request):JSON.stringify({workspace:'课程',message:'Done',actions:[]});}}
 });
 node('#agentInput').value='分析课件';node('#apiBase').value='https://example.invalid/v1';node('#apiKey').value='fixture-key';
 vm.runInContext(cut('function activeResultRecord(', '\nfunction conversationProjectIds(') + cut('function dedupeResultEntries(', '\nfunction groupedEntities(') + cut('function commitAttachmentAnalysis(', '\nfunction executeActions(')+cut('function normalizeStateShape(', '\ntry { normalizeStateShape(')+cut('const currentAttachments =', '\nlet serverSaveInFlight')+cut('function assertRunActive(', '\nlet activeRunController')+cut('function apiOrigin(', '\nfunction renderSettings(')+cut('async function sendMessage(', '\n\nfunction formatBytes('),c);
 c.normalizeStateShape(state);
 return{c,state,node,saved,deliveries,requests,toasts,send:options=>c.sendMessage(options),attachments:()=>vm.runInContext(cut('function activeResultRecord(', '\nfunction conversationProjectIds(') + cut('function dedupeResultEntries(', '\nfunction groupedEntities(') + 'currentAttachments().map(item=>item.id)',c)};
}

test('send persists the user message and immutable attachment metadata before model work, clearing only this composer',async()=>{
 const pending=deferred(),h=harness({resolve:()=>pending.promise});const sending=h.send();
 assert.equal(h.node('#agentInput').value,'');assert.equal(h.node('#agentInput').style.height,'auto');assert.equal(h.state.conversations[0].draft,'');assert.deepEqual(Array.from(h.state.conversations[0].draftAttachmentIds),[]);
 assert.deepEqual(h.saved[0].conversations[0].messages[0].attachmentIds,['pdf']);assert.equal(h.saved[0].conversations[0].messages[0].attachments[0].name,'47页课件.pdf');assert.deepEqual(h.saved[0].conversations[0].attachments,['pdf']);assert.equal(h.requests.length,0);
 h.state.imports[0].name='整理后新名称.pdf';assert.equal(h.state.conversations[0].messages[0].attachments[0].name,'47页课件.pdf');
 pending.resolve({provider:'api',model:'fixture',effort:''});await sending;assert.equal(h.state.agentRuns[0].status,'completed',h.state.agentRuns[0].error);
});

test('a plain followup sends no old PDF while conversation membership and historical attachment links persist',async()=>{
 const h=harness();await h.send();h.node('#agentInput').value='这些方法有什么区别？';h.state.conversations[0].draft=h.node('#agentInput').value;await h.send();
 assert.deepEqual(h.deliveries,[['pdf'],[]]);assert.deepEqual(Array.from(h.state.conversations[0].attachments),['pdf']);assert.deepEqual(Array.from(h.state.conversations[0].messages.filter(m=>m.role==='user')[1].attachmentIds),[]);assert.equal(h.node('#agentInput').value,'');
});

test('new typing and uploads during generation survive success, failure, and duplicate send clicks',async()=>{
 for(const fails of [false,true]){
  const pending=deferred(),h=harness({request:()=>pending.promise});const sending=h.send();await flush();assert.equal(h.requests.length,1);
  h.node('#agentInput').value='下一轮的新问题';h.state.conversations[0].draft='下一轮的新问题';h.state.imports.push({id:'new',name:'新上传.txt'});h.state.conversations[0].attachments.push('new');h.state.conversations[0].draftAttachmentIds.push('new');
  await h.send();assert.equal(h.requests.length,1);assert.equal(h.node('#agentInput').value,'下一轮的新问题');
  if(fails)pending.reject(new Error('remote failed'));else pending.resolve(JSON.stringify({message:'done',actions:[]}));await sending;
  assert.equal(h.node('#agentInput').value,'下一轮的新问题');assert.equal(h.state.conversations[0].draft,'下一轮的新问题');assert.deepEqual(Array.from(h.state.conversations[0].draftAttachmentIds),['new']);assert.deepEqual(h.deliveries,[['pdf']]);
  assert.equal(h.state.agentRuns[0].status,fails?'failed':'completed',h.state.agentRuns[0].error);
 }
});

test('retry uses original attachments and message history without consuming or replacing a newer draft',async()=>{
 let fail=true;const h=harness({request:()=>{if(fail)throw Error('first failure');return JSON.stringify({message:'retried',actions:[]});}});await h.send();const failed=h.state.agentRuns[0];
 h.node('#agentInput').value='保留我的新草稿';h.state.conversations[0].draft='保留我的新草稿';h.state.imports.push({id:'next',name:'下轮.txt'});h.state.conversations[0].attachments.push('next');h.state.conversations[0].draftAttachmentIds.push('next');fail=false;
 await h.send({retry:true,goal:failed.goal,conversationId:failed.conversationId,attachmentIds:failed.attachmentIds});
 assert.equal(h.node('#agentInput').value,'保留我的新草稿');assert.equal(h.state.conversations[0].draft,'保留我的新草稿');assert.deepEqual(Array.from(h.state.conversations[0].draftAttachmentIds),['next']);assert.equal(h.state.conversations[0].messages.filter(m=>m.role==='user').length,1);assert.deepEqual(h.deliveries,[['pdf'],['pdf']]);
});

test('retry keeps the original relative-date anchor instead of moving tomorrow to the retry day',async()=>{
 const h=harness();const requestedAt=Date.parse('2026-09-12T08:30:00+08:00');
 await h.send({retry:true,goal:'ddl是明天下午3点前',conversationId:'a',attachmentIds:[],requestedAt});
 assert.equal(h.state.agentRuns[0].requestedAt,requestedAt);
 const expected=TaskContext.build(h.state,h.state.conversations[0],{now:requestedAt,goal:'ddl是明天下午3点前',maxChars:10000}).text;
 assert.ok(h.requests[0].input.includes(expected));
 assert.match(source,/requestedAt: run.requestedAt \|\| run.startedAt/);
});

test('task context stays in the submitted scope if the user switches projects during model setup',async()=>{
 const pending=deferred(),h=harness({resolve:()=>pending.promise});
 h.state.tasks.push({id:'course-task',title:'提交报告',workspace:'课程',projectId:'p',status:'todo',dueAt:null});
 const sending=h.send();
 h.state.conversations[0].projectId=null;h.state.conversations[0].workspace='日常';
 pending.resolve({provider:'api',model:'fixture',effort:''});await sending;
 assert.deepEqual(Array.from(h.state.agentRuns[0].taskContext.taskIds),['course-task']);
 assert.ok(h.requests[0].input.includes('course-task'));
});

test('retry of an old conversation never reparents its attachments or changes the currently open composer',async()=>{
 const h=harness();await h.send();const run=h.state.agentRuns[0];h.state.currentConversationId='b';h.node('#agentInput').value='另一草稿';await h.send({retry:true,goal:run.goal,conversationId:'a',attachmentIds:run.attachmentIds});
 assert.equal(h.state.currentConversationId,'b');assert.equal(h.node('#agentInput').value,'另一草稿');assert.equal(h.state.conversations[1].draft,'另一草稿');assert.equal(h.state.conversations[1].messages.length,0);assert.equal(h.state.agentRuns.at(-1).conversationId,'a');
});

test('missing retry attachments are reported without issuing an incomplete model request or clearing fresh input',async()=>{
 const h=harness();h.node('#agentInput').value='new draft';h.state.conversations[0].draft='new draft';await h.send({retry:true,goal:'old goal',conversationId:'a',attachmentIds:['missing']});
 assert.equal(h.requests.length,0);assert.equal(h.state.agentRuns.length,0);assert.equal(h.node('#agentInput').value,'new draft');assert.match(h.toasts.at(-1),/原轮附件已删除/);
});

test('navigation during a pending response preserves independent conversation drafts and staging',async()=>{
 const pending=deferred(),h=harness({request:()=>pending.promise});const sending=h.send();await flush();
 h.state.conversations[0].draft='回到A继续写';h.state.currentConversationId='b';h.node('#agentInput').value='B新输入';h.state.conversations[1].draft='B新输入';h.state.imports.push({id:'bfile',name:'B.txt'});h.state.conversations[1].attachments.push('bfile');h.state.conversations[1].draftAttachmentIds.push('bfile');
 pending.resolve(JSON.stringify({message:'done',actions:[]}));await sending;assert.equal(h.node('#agentInput').value,'B新输入');assert.equal(h.state.conversations[0].draft,'回到A继续写');assert.deepEqual(Array.from(h.state.conversations[1].draftAttachmentIds),['bfile']);assert.deepEqual(h.deliveries,[['pdf']]);
});

test('legacy migration separates sent materials from unsent uploads and repairs only proven stale retry text once',()=>{
 const h=harness();const a=h.state.conversations[0];delete a.draftAttachmentIds;a.messages=[{id:'m',role:'user',text:'分析课件',attachmentIds:['pdf'],at:10}];h.state.agentRuns=[{id:'r',conversationId:'a',goal:'分析课件',attachmentIds:['pdf'],status:'completed',startedAt:10}];
 h.c.normalizeStateShape(h.state);assert.deepEqual(Array.from(a.draftAttachmentIds),[]);assert.equal(a.draft,'');a.draft='分析课件';h.c.normalizeStateShape(h.state);assert.equal(a.draft,'分析课件','new intentional draft is never repeatedly cleared');
 delete a.draftAttachmentIds;a.draft='different new goal';h.state.imports.push({id:'new',name:'new.txt',createdAt:20});a.attachments.push('new');h.c.normalizeStateShape(h.state);assert.deepEqual(Array.from(a.draftAttachmentIds),['new']);assert.equal(a.draft,'different new goal');
});

test('a first unsent legacy upload stays staged, while undocumented old context is not blindly resent',()=>{
 const h=harness(),a=h.state.conversations[0];delete a.draftAttachmentIds;h.c.normalizeStateShape(h.state);assert.deepEqual(Array.from(a.draftAttachmentIds),['pdf']);
 delete a.draftAttachmentIds;a.messages=[{id:'old',role:'user',text:'past message',at:50}];h.c.normalizeStateShape(h.state);assert.deepEqual(Array.from(a.draftAttachmentIds),[]);assert.deepEqual(Array.from(a.attachments),['pdf']);
});

test('composer remove and historical reattach handlers modify only staging and leave durable context intact',()=>{
 const h=harness();const a=h.state.conversations[0];let click;h.c.document.addEventListener=(_type,handler)=>{click=handler;};h.c.openImport=id=>{h.opened=id;};
 vm.runInContext(cut('function activeResultRecord(', '\nfunction conversationProjectIds(') + cut('function dedupeResultEntries(', '\nfunction groupedEntities(') + cut("document.addEventListener('click', event => {", "\n$$('button[data-view]')"),h.c);
 const invoke=dataset=>click({target:{closest:selector=>{assert.match(selector,/data-stage-import/);return{dataset};}},stopPropagation(){},preventDefault(){}});
 invoke({removeImport:'pdf'});assert.deepEqual(Array.from(a.draftAttachmentIds),[]);assert.deepEqual(Array.from(a.attachments),['pdf']);invoke({stageImport:'pdf'});invoke({stageImport:'pdf'});assert.deepEqual(Array.from(a.draftAttachmentIds),['pdf']);assert.deepEqual(Array.from(a.attachments),['pdf']);invoke({openImport:'pdf'});assert.equal(h.opened,'pdf');
});

test('historical message attachments retain sent names and explicit unavailable state instead of vanishing',()=>{
 const h=harness(),elements=[];h.c.document.createElement=()=>{const element={className:'',dataset:{},innerHTML:'',textContent:'',append(...items){elements.push(...items);},appendChild(item){elements.push(item);}};return element;};
 h.c.esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');h.c.uiIcon=()=>'';h.c.renderRichText=value=>value;
 vm.runInContext(cut('function activeResultRecord(', '\nfunction conversationProjectIds(') + cut('function dedupeResultEntries(', '\nfunction groupedEntities(') + cut('function renderMessage(', '\nfunction renderStagedAttachments('),h.c);
 const message={id:'m',role:'user',text:'sent',attachmentIds:['pdf','gone'],attachments:[{id:'pdf',name:'发送时原名称.pdf'},{id:'gone',name:'已删除原件.pdf'}]};h.c.renderMessage(message,{appendChild:item=>elements.push(item)});const html=elements.map(item=>item.innerHTML).join('\n');
 assert.match(html,/发送时原名称.pdf/);assert.match(html,/data-open-import="pdf"/);assert.match(html,/data-stage-import="pdf"/);assert.match(html,/已删除原件.pdf/);assert.match(html,/原件已不可用/);assert.doesNotMatch(html,/data-open-import="gone"/);
});


test('pasted URL is acquired in the submitted turn while another draft stays untouched',async()=>{
 const pending=deferred(),h=harness({web:true,fetch:()=>pending.promise});
 h.state.conversations[0].projectId=null;h.state.conversations[0].draftAttachmentIds=[];
 h.node('#agentInput').value='请分析 https://arxiv.org/pdf/2605.31468';
 const sending=h.send();await flush();
 assert.equal(h.requests.length,0);assert.equal(h.state.conversations[0].messages[0].role,'user');assert.equal(h.node('#agentInput').value,'');
 h.state.currentConversationId='b';h.node('#agentInput').value='新的草稿';h.state.conversations[1].draft='新的草稿';
 pending.resolve({ok:true,json:async()=>({id:'web-pdf',name:'DemoGraph.pdf',mimeType:'application/pdf',size:1200,storedLocally:true})});
 await sending;
 const original=h.state.conversations[0],other=h.state.conversations[1];
 assert.equal(h.state.agentRuns[0].status,'completed',h.state.agentRuns[0].error);
 assert.deepEqual(Array.from(original.messages[0].attachmentIds),['web-pdf']);assert.deepEqual(Array.from(original.draftAttachmentIds),[]);
 assert.deepEqual(Array.from(other.attachments),[]);assert.equal(h.node('#agentInput').value,'新的草稿');
 assert.deepEqual(h.deliveries,[['web-pdf']]);assert.match(h.requests[0].input,/upsert_paper/);assert.match(h.requests[0].input,/没有合适科研项目时作为独立科研资料/);
 assert.equal(h.state.imports.find(x=>x.id==='web-pdf').analysis.status,'pending');
});

test('retry of repeated identical URL text attaches the saved source to its original user message',async()=>{
 const goal='https://arxiv.org/pdf/2605.31468',h=harness({web:true,fetch:async()=>({ok:true,json:async()=>({id:'fetched',name:'paper.pdf',mimeType:'application/pdf',storedLocally:true})})});
 const a=h.state.conversations[0];a.projectId=null;a.messages=[{id:'old',role:'user',text:goal,at:10},{id:'new',role:'user',text:goal,at:30}];
 await h.send({goal,retry:true,conversationId:'a',userMessageId:'old',requestedAt:20,attachmentIds:[]});
 assert.deepEqual(Array.from(a.messages[0].attachmentIds),['fetched']);assert.equal(a.messages[1].attachmentIds,undefined);
 assert.equal(h.state.agentRuns[0].userMessageId,'old');
});


test('native PDF page count reaches source validation without a full text index',async()=>{
 const h=harness({metadata:[{attachmentId:'pdf',pageCount:22,readMode:'pdf_page_images'}]});h.state.imports[0].content='';h.state.imports[0].pages=[];
 await h.send();assert.equal(h.state.imports[0].pageCount,22);
 assert.throws(()=>Core.applyPlan(h.state,[{type:'upsert_paper',title:'Citation test',workspace:'科研',projectId:null,sourceAttachmentIds:['pdf'],structured:{tldr:{text:'test',citations:[{attachmentId:'pdf',page:23}]}}}],{workspace:'科研'}),/超出已知来源范围/);
});

test('missing API configuration never substitutes local task creation and retains the submitted message for retry',async()=>{
 for (const missing of ['#apiBase','#apiKey']) {
  const h=harness();const existing={id:'existing-note',title:'主笔记',content:'人工正文',projectId:'p'};h.state.notes.push(existing);
  const goal='请 append_note 到主笔记，不要新建任务';h.node('#agentInput').value=goal;h.node(missing).value='';let fallback=0,localRead=0;
  h.c.fallbackWorkflow=()=>{fallback++;h.state.tasks.push({id:'bad',title:goal});return 'local';};
  h.c.window.LocalProjectAgent={prepare:()=>{localRead++;return {text:'found files',candidates:[]};}};h.c.LocalProjectAgent=h.c.window.LocalProjectAgent;h.c.window.LocalProjects={};
  await h.send();assert.equal(fallback,0);assert.equal(localRead,0);assert.equal(h.requests.length,0);assert.equal(h.deliveries.length,0);assert.equal(h.state.tasks.length,0);assert.deepEqual(h.state.notes,[existing]);
  const run=h.state.agentRuns[0],messages=h.state.conversations[0].messages;
  assert.equal(run.status,'failed');assert.match(run.error,/尚未配置/);assert.match(run.error,/不会改用本地规则/);assert.equal(messages[0].text,goal);assert.deepEqual(Array.from(messages[0].attachmentIds),['pdf']);assert.equal(messages[1].retryRunId,run.id);assert.equal(h.node('#agentInput').value,'');
  h.node('#apiBase').value='https://example.invalid/v1';h.node('#apiKey').value='fixture-reconfigured';h.node('#agentInput').value='保留新草稿';h.state.conversations[0].draft='保留新草稿';h.c.window.LocalProjectAgent=null;h.c.window.LocalProjects=null;
  await h.send({retry:true,goal,conversationId:'a',userMessageId:run.userMessageId,attachmentIds:run.attachmentIds,requestedAt:run.requestedAt});
  assert.equal(h.state.agentRuns.at(-1).status,'completed',h.state.agentRuns.at(-1).error);assert.equal(h.requests.length,1);assert.equal(messages.filter(item=>item.role==='user').length,1);assert.equal(h.node('#agentInput').value,'保留新草稿');assert.equal(fallback,0);
 }
});

test('API configuration is validated before automatic URL acquisition can add any source',async()=>{
 let fetches=0;const h=harness({web:true,fetch:async()=>{fetches++;throw Error('must not fetch');}});h.node('#apiKey').value='';h.node('#agentInput').value='请分析 https://example.invalid/paper.pdf';const before=clone(h.state.imports);
 await h.send();assert.equal(fetches,0);assert.equal(h.requests.length,0);assert.deepEqual(clone(h.state.imports),before);assert.equal(h.state.agentRuns[0].status,'failed');
});

test('an explicit API conversation with no model fails without silently selecting a model or local workflow',async()=>{
 const h=harness();h.c.ConversationModels.configuration=()=>({provider:'api',model:'',effort:''});h.state.conversations[0].modelConfig={provider:'api',model:'',effort:''};
 await h.send();assert.equal(h.requests.length,0);assert.equal(h.state.agentRuns[0].status,'failed');assert.match(h.state.agentRuns[0].error,/模型名称/);assert.equal(h.state.tasks.length,0);
});

test('explicit reminder skips retrieval and sends compact context without changing model effort',async()=>{
 const h=harness({request:async request=>{const data=JSON.parse(request.input.split('本轮输入（JSON 数据）：')[1]);return JSON.stringify({workspace:'日常',message:'已处理',actions:[{type:'create_task',...data.reminder,workspace:'日常',projectId:null}]});}});
 const routing=require('../app/agent-routing');h.c.AgentRouting=h.c.window.AgentRouting=routing;
 const c=h.state.conversations[0];c.projectId=null;c.workspace='日常';c.attachments=[];c.draftAttachmentIds=[];
 let retrieved=0;h.c.window.VectorKnowledge={retrieve:async()=>{retrieved++;return{text:'UNRELATED_EVIDENCE',entries:[],coverage:{}}}};h.c.VectorKnowledge=h.c.window.VectorKnowledge;
 await h.send({goal:'明天下午两点提醒我买牛奶'});
 assert.equal(retrieved,0);assert.equal(h.requests.length,1);assert.ok(h.requests[0].input.length<1800);assert.ok(!h.requests[0].input.includes('UNRELATED_EVIDENCE'));
 const run=h.state.agentRuns.at(-1);assert.equal(run.contextRoute.mode,'reminder');assert.equal(run.status,'completed');assert.ok(run.timings.requestCharacters<run.timings.fullContextCharacters);
});
test('compact request escalates to retrieved full context before executing any plan',async()=>{
 let calls=0;const h=harness({request:async request=>{calls++;if(calls===1)return JSON.stringify({needsFullContext:true,actions:[]});assert.ok(request.input.includes('NEEDED_EVIDENCE'));return JSON.stringify({workspace:'日常',message:'有依据的答复',actions:[]});}});
 const routing=require('../app/agent-routing');h.c.AgentRouting=h.c.window.AgentRouting=routing;
 const c=h.state.conversations[0];c.projectId=null;c.workspace='日常';c.attachments=[];c.draftAttachmentIds=[];
 let retrieved=0;h.c.VectorKnowledge=h.c.window.VectorKnowledge={retrieve:async()=>{retrieved++;return{text:'NEEDED_EVIDENCE',entries:[],coverage:{strategy:'fixture'}}}};
 await h.send({goal:'明天下午两点提醒我买牛奶'});
 assert.equal(retrieved,1);assert.equal(calls,2);assert.equal(h.state.agentRuns.at(-1).contextRoute.escalated,true);assert.equal(h.state.agentRuns.at(-1).status,'completed');
});

function onDemandHarness(options={}){
 const h=harness(options);for(const [key,file] of [['AgentContext','agent-context'],['ContextWindow','context-window'],['KnowledgeAccess','knowledge-access'],['ToolScheduler','tool-scheduler']])h.c[key]=h.c.window[key]=require('../app/'+file);
 h.c.saveDocumentDurably=async()=>{};h.c.window.VectorKnowledge={retrieve:async()=>{throw Error('Unexpected eager retrieval');},searchRequest:async()=>null};
 const c=h.state.conversations[0];c.attachments=[];c.draftAttachmentIds=[];return h;
}
test('ordinary conversation does not search or send universal operation schemas',async()=>{
 const h=onDemandHarness();await h.send({goal:'你好，今天想聊聊学习方法'});
 const r=h.state.agentRuns.at(-1);assert.equal(r.status,'completed',r.error);assert.equal(h.requests.length,1);assert.equal(r.contextRoute.policy,'on-demand');assert.doesNotMatch(h.requests[0].input,/rename_attachment\(attachmentId|Office 本机文件|retainedCharacters/);assert.equal(r.retrievalCoverage.strategy,'not-requested');
});
test('mixed course search and reminder loads capabilities and evidence before a final action',async()=>{
 let call=0;const h=onDemandHarness({request:async req=>{
  if(++call===1)return JSON.stringify({knowledgeRequests:[{type:'search',query:'机器学习作业截止'},{type:'capabilities',name:'tasks'}],actions:[]});
  assert.match(req.input,/Friday 17:00/);assert.match(req.input,/create_task\(title/);
  return JSON.stringify({workspace:'课程',message:'依据课程要求准备提醒',actions:[{type:'create_task',title:'提交机器学习作业',dueAt:'2026-09-25T17:00:00+08:00',reminderMinutes:30,workspace:'课程',projectId:'p'}]});
 }});h.state.notes.push({id:'assignment',projectId:'p',workspace:'课程',title:'机器学习作业截止',content:'Friday 17:00'});
 await h.send({goal:'找到机器学习作业要求，并按截止时间提前半小时提醒我'});const r=h.state.agentRuns.at(-1);assert.equal(r.status,'completed',r.error);assert.equal(call,2);assert.equal(r.toolCalls.length,2);assert.equal(r.toolCalls.find(x=>x.type==='capabilities').request.name,'tasks');assert.equal(r.knowledgeSearches.length,1);
});
test('unloaded mutations are rechecked against real schemas before any execution',async()=>{
 let calls=0;const h=onDemandHarness({request:async()=>{calls++;return JSON.stringify({workspace:'课程',message:'准备创建',actions:[{type:'create_task',title:'synthetic',projectId:'p',workspace:'课程'}]});}});
 await h.send({goal:'帮我安排一个学习任务'});const r=h.state.agentRuns.at(-1);assert.equal(r.status,'completed',r.error);assert.equal(calls,2);assert.equal(r.toolCalls[0].request.name,'tasks');assert.ok(r.contextMetrics.loadedCapabilities.includes('tasks'));
});

test('web-capable provider with old unsupported replies still creates one reviewed recurring proposal',async()=>{
 const goal='#腾讯会议：123-4567-8901 我每周四下午两点半都要参加这个组会';
 const h=onDemandHarness({web:true,request:async req=>{
  assert.equal(req.webSearch,false);assert.doesNotMatch(req.input,/目前仍无法设置|OLD_UNRELATED_NOTE/);
  const data=JSON.parse(req.input.split('本轮输入（JSON 数据）：')[1]);
  return JSON.stringify({workspace:'日常',message:'请审阅每周组会日程。',actions:[],agendaProposals:[{title:'示例组会',sourceMessageId:data.userMessageId,quote:data.goal,start:'2026-10-01T14:30:00+08:00',end:null,timeZone:'Asia/Shanghai',frequency:'weekly',interval:1,weekdays:[5],reminderMinutes:null,location:'腾讯会议：123-4567-8901'}]});
 }});
 for(const [key,file] of [['AgentRouting','agent-routing'],['AgendaProposals','agenda-proposals']])h.c[key]=h.c.window[key]=require('../app/'+file);
 h.c.apiCredentialState={hasKey:false};h.c.window.workstationDesktop={agendaProposal:()=>{throw Error('Saving must wait for user review');}};
 h.node('#apiBase').value='https://api.openai.com/v1';
 const c=h.state.conversations[0];c.workspace='auto';c.projectId=null;c.messages=[{id:'old-user',role:'user',text:goal},{id:'old-answer',role:'assistant',text:'目前仍无法设置每周四的重复提醒。'}];
 h.state.notes.push({id:'unrelated',title:'其他资料',content:'OLD_UNRELATED_NOTE'});
 await h.send({goal});const r=h.state.agentRuns.at(-1);
 assert.equal(r.status,'completed',r.error);assert.equal(r.webSearch,true,'Provider capability retained');assert.equal(r.contextRoute.mode,'schedule');assert.equal(r.contextRoute.escalated,undefined);assert.equal(h.requests.length,1);assert.equal(r.knowledgeSearches?.length||0,0);
 assert.equal(r.agendaProposals.length,1);assert.equal(r.agendaProposals[0].frequency,'weekly');assert.deepEqual(Array.from(r.agendaProposals[0].weekdays),[5]);assert.equal(r.agendaProposals[0].count,null);assert.equal(r.agendaProposals[0].until,null);assert.equal(h.state.tasks.length,0);assert.equal(c.messages[1].text,'目前仍无法设置每周四的重复提醒。','Historical transcript remains intact');
});

test('mixed recurring event still reads evidence and loads agenda rules with web-capable providers',async()=>{
 let calls=0;const h=onDemandHarness({web:true,request:async req=>{
  assert.equal(req.webSearch,true);
  if(++calls===1){assert.match(req.input,/历史助手答复可能来自旧版本/);return JSON.stringify({knowledgeRequests:[{type:'search',query:'示例课程讨论时间'},{type:'capabilities',name:'agenda'}],actions:[]});}
  assert.match(req.input,/COURSE_EVIDENCE Thursday 14:30/);assert.match(req.input,/frequency:"none\|daily\|weekly\|monthly"/);
  const run=h.state.agentRuns.at(-1);
  return JSON.stringify({workspace:'课程',message:'根据课程安排生成待审阅日程。',actions:[],agendaProposals:[{title:'示例课程讨论',sourceMessageId:run.userMessageId,quote:run.goal,start:'2026-10-01T14:30:00+08:00',end:null,timeZone:'Asia/Shanghai',frequency:'weekly',interval:1,weekdays:[5],reminderMinutes:15}]});
 }});
 for(const [key,file] of [['AgentRouting','agent-routing'],['AgendaProposals','agenda-proposals']])h.c[key]=h.c.window[key]=require('../app/'+file);
 h.c.apiCredentialState={hasKey:false};h.c.window.workstationDesktop={agendaProposal(){}};h.node('#apiBase').value='https://api.openai.com/v1';
 h.state.notes.push({id:'course-times',workspace:'课程',projectId:'p',title:'示例课程讨论时间',content:'COURSE_EVIDENCE Thursday 14:30'});
 await h.send({goal:'查找示例课程讨论时间，帮我安排每周讨论日程，提前15分钟提醒'});const r=h.state.agentRuns.at(-1);
 assert.equal(r.status,'completed',r.error);assert.equal(r.contextRoute.mode,'full');assert.equal(calls,2);assert.equal(r.knowledgeSearches.length,1);assert.equal(r.agendaProposals.length,1);assert.ok(r.contextMetrics.loadedCapabilities.includes('agenda'));
});

test('recurring format fallback preserves current agenda schema before reconsulting older conversation',async()=>{
 let calls=0;const h=onDemandHarness({web:true,request:async req=>{
  if(++calls===1)return JSON.stringify({workspace:'科研',message:'请审阅',actions:[{agendaProposals:[{title:'组会'}]}]});
  assert.match(req.input,/用户可以直接在对话中创建单次或重复日程/);assert.match(req.input,/历史助手答复可能来自旧版本/);
  const run=h.state.agentRuns.at(-1);return JSON.stringify({workspace:'科研',message:'请审阅后保存。',actions:[],agendaProposals:[{title:'示例组会',sourceMessageId:run.userMessageId,quote:run.goal,start:'2026-10-01T14:30:00+08:00',end:null,timeZone:'Asia/Shanghai',frequency:'weekly',weekdays:[5]}]});
 }});
 for(const [key,file] of [['AgentRouting','agent-routing'],['AgendaProposals','agenda-proposals']])h.c[key]=h.c.window[key]=require('../app/'+file);
 h.c.apiCredentialState={hasKey:false};h.c.window.workstationDesktop={agendaProposal(){}};h.node('#apiBase').value='https://api.openai.com/v1';
 const c=h.state.conversations[0];c.projectId=null;c.messages=[{id:'old',role:'assistant',text:'暂不支持重复日程'}];
 await h.send({goal:'每周四下午两点半参加组会'});const r=h.state.agentRuns.at(-1);
 assert.equal(r.status,'completed',r.error);assert.equal(calls,2);assert.equal(r.contextRoute.escalated,true);assert.deepEqual(Array.from(r.contextMetrics.loadedCapabilities),['agenda']);assert.equal(r.agendaProposals.length,1);assert.equal(r.knowledgeSearches?.length||0,0);
});
