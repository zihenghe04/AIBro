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
