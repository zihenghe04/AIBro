/* Isolated native Electron acceptance for composer tools, resizing, theme, file drop and planning. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18898,ORIGIN='http://127.0.0.1:'+PORT,TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aw-workbench-tools-smoke-')),STORE=path.join(TEMP,'store');
fs.mkdirSync(path.join(STORE,'files'),{recursive:true});fs.mkdirSync(path.join(TEMP,'profile'));app.setPath('userData',path.join(TEMP,'profile'));
const pdf=spawnSync(process.env.PYTHON||'python3',['-c',[
'import fitz,sys,json','from pathlib import Path','p=Path(sys.argv[1]);d=fitz.open()',
'for n in range(2):',' page=d.new_page(width=420,height=300);page.insert_text((35,45),"Reading pane QA - page "+str(n+1));page.draw_rect(fitz.Rect(40,80,330,240),color=(0,.2,.6),fill=(.1,.45,.85) if n==0 else (.55,.3,.7))',
'(p/"qa-reading-pdf").write_bytes(d.tobytes());(p/"qa-reading-pdf.meta.json").write_text(json.dumps({"name":"Two-page original.pdf","mimeType":"application/pdf"}))'].join('\n'),path.join(STORE,'files')]);assert.equal(pdf.status,0,pdf.stderr?.toString());
const original=fs.readFileSync(path.join(STORE,'files','qa-reading-pdf')),wait=ms=>new Promise(r=>setTimeout(r,ms));
const request=route=>new Promise((resolve,reject)=>http.get(ORIGIN+route,r=>{const chunks=[];r.on('data',c=>chunks.push(c));r.on('end',()=>resolve({status:r.statusCode,body:Buffer.concat(chunks)}));}).on('error',reject));
async function until(check,label,timeout=15000){const start=Date.now();while(Date.now()-start<timeout){if(await check())return;await wait(60);}throw Error('Timed out: '+label);}
let server,win;const passed=[],failures=[];const watchdog=setTimeout(()=>{console.error('QA timeout',TEMP);win?.destroy();server?.kill('SIGTERM');app.exit(1);},240000);
async function run(){
 await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',()=>reject(Error('18898 occupied; refusing existing workspace')));probe.listen(PORT,'127.0.0.1',()=>probe.close(resolve));});
 const log=fs.openSync(path.join(TEMP,'server.log'),'a');server=spawn(process.env.PYTHON||'python3',[path.join(ROOT,'server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(PORT),AI_WORKSTATION_DATA_DIR:STORE},stdio:['ignore',log,log]});
 await until(async()=>{if(server.exitCode!==null)throw Error('QA service exited');try{return(await request('/__health')).status===200;}catch{return false;}},'temporary service');
 await app.whenReady();win=new BrowserWindow({show:false,width:1440,height:960,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const errors=[],forbidden=[];win.webContents.on('console-message',(_event,level,message)=>{if(level>=3){errors.push(message);console.error('RENDERER',message);}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{const url=new URL(details.url),blocked=['http:','https:'].includes(url.protocol)&&(url.origin!==ORIGIN||/^\/__(proxy|codex\/respond)/.test(url.pathname)||/^\/__auth\/(login|logout)/.test(url.pathname)||url.pathname==='/__cloud/connect');if(blocked)forbidden.push(details.url);callback({cancel:blocked});});
 const evaluate=async code=>{try{return await win.webContents.executeJavaScript(code,true);}catch(error){console.error('Script prefix:',code.slice(0,400));throw error;}};
 async function settle(){await wait(180);await evaluate('document.getAnimations().forEach(a=>{if(Number.isFinite(a.effect?.getComputedTiming().endTime))try{a.finish();}catch(_){}})');await wait(30);}
 async function click(selector){const p=await evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');if(!e)throw Error("Missing "+'+JSON.stringify(selector)+');e.scrollIntoView({block:"nearest",behavior:"instant"});const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2),hit=document.elementFromPoint(x,y);if(!r.width||!r.height||e.disabled||!(e===hit||e.contains(hit)))throw Error("Hidden/covered "+'+JSON.stringify(selector)+');return{x,y}})()');win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await wait(100);}
 async function input(selector,value){await click(selector);await evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');e.value='+JSON.stringify(value)+';e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}))})()');await wait(60);}
 async function step(label,fn){try{await fn();passed.push(label);console.log('PASS',label);}catch(error){failures.push({label,error:error.stack});console.error('FAIL',label,error.message);}}
 async function snapshot(name){await settle();fs.writeFileSync(path.join(ROOT,'design',name),(await win.webContents.capturePage()).toPNG());}
 const domainState=()=>evaluate('JSON.stringify({projects:state.projects,tasks:state.tasks,notes:state.notes,imports:state.imports,papers:state.papers,agentRuns:state.agentRuns,conversations:state.conversations.map(c=>({id:c.id,messages:c.messages,attachments:c.attachments,draftAttachmentIds:c.draftAttachmentIds}))})');
 await win.loadURL(ORIGIN);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydration');
 const now=Date.now(),fixture={projects:[{id:'qa-tools-course',name:'智能控制课程',workspace:'课程',createdAt:now},{id:'qa-tools-research',name:'自适应控制研究',workspace:'科研',createdAt:now}],papers:[],agentRuns:[],trash:[],tasks:[],notes:[{id:'qa-tools-note',title:'控制方法与研究来源',content:'# 控制方法\n\n用于并排宽度调整的固定阅读正文。',projectId:'qa-tools-course',workspace:'课程',sourceAttachmentIds:['qa-reading-pdf'],createdAt:now}],imports:[{id:'qa-reading-pdf',name:'OLD_ATTACHMENT_MUST_NOT_BE_RESENT.pdf',originalName:'Two-page original.pdf',mimeType:'application/pdf',content:'OLD_ATTACHMENT_CONTENT_MUST_NOT_LEAK',projectId:'qa-tools-course',workspace:'课程',createdAt:now}],conversations:[{id:'qa-tools-conversation-a',title:'草稿润色和附件隔离',workspace:'课程',projectId:'qa-tools-course',modelConfig:{provider:'api',model:'isolated-model-alpha',effort:'high'},attachments:['qa-reading-pdf'],draftAttachmentIds:['qa-reading-pdf'],draft:'',messages:[{id:'old-user',role:'user',text:'OLD_HISTORY_MUST_NOT_LEAK',at:now}],createdAt:now},{id:'qa-tools-conversation-b',title:'另一个对话',workspace:'科研',projectId:'qa-tools-research',modelConfig:{provider:'api',model:'isolated-model-beta',effort:'low'},attachments:[],draftAttachmentIds:[],draft:'另一对话的原草稿',messages:[],createdAt:now}],currentConversationId:'qa-tools-conversation-a'};
 await evaluate('Object.assign(state,'+JSON.stringify(fixture)+');normalizeStateShape(state);repairRelationships();state.ui.theme="light";state.ui.inspectorOpen=false;save();applyUiPreferences();showView("agent","持续对话");renderAll()');
 await evaluate('$("#apiBase").value="https://isolated-fixture.invalid/v1";$("#apiKey").value="QA_FAKE_API_TOKEN";window.__qaResolvedConfigs=[];window.__qaRequests=[];ConversationModels.resolve=async config=>{__qaResolvedConfigs.push({...config});return {...config}};AgentTransport.requestPlan=options=>{__qaRequests.push({provider:options.provider,model:options.model,effort:options.effort,token:options.token,input:options.input});return new Promise((resolve,reject)=>{window.__qaPending={options,resolve,reject};options.signal?.addEventListener("abort",()=>{const e=new Error("验收主动取消");e.code="CANCELLED";reject(e)},{once:true})})};true');
 const settleSave=async()=>{await evaluate('flushWorkspace()');await until(()=>evaluate('!serverSaveInFlight&&!serverSaveQueued&&!state._pendingLocalSave'),'saved local fixture');};
 // Feature-specific native interaction cases are added once their public DOM contracts are ready.
assert.equal(await evaluate('!!window.PromptPolisher&&!!$("#polishPrompt")&&!!$("#polishSettings")'),true,'integrated one-click polish module');
 async function openPolishSettings(){if(await evaluate('$("#polishDialog").hidden'))await click('#polishSettings');await until(()=>evaluate('!$("#polishDialog").hidden'),'nonmodal settings visible');assert.equal(await evaluate('$("#polishDialog").matches(":modal")'),false);}
 async function closePolishSettings(){if(!await evaluate('$("#polishDialog").hidden'))await click('#polishClose');}
 async function beginPolish(text){await closePolishSettings();await input('#agentInput',text);const before=await evaluate('__qaRequests.length');await click('#polishPrompt');await until(()=>evaluate('__qaRequests.length>'+before),'one-click polish request');return before;}
 async function finishPolish(text,expected=text){await evaluate('__qaPending.resolve('+JSON.stringify(text)+');true');await until(()=>evaluate('$("#agentInput").value==='+JSON.stringify(expected)),'automatic draft replacement');await wait(100);}
 async function movePointer(selector){const p=await evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+'),r=e.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()');win.webContents.sendInputEvent({type:'mouseMove',...p});await wait(35);}
 await step('one click freezes saved/current model and draft, excludes history and attachments, and automatically replaces without sending a message',async()=>{
  await evaluate('state.settings.promptPolisher={connection:"current",style:"structured"};currentConversation().modelConfig={provider:"api",model:"isolated-model-alpha",effort:"high"};ConversationModels.resolve=config=>{__qaResolvedConfigs.push({...config});return new Promise(resolve=>window.__qaResolveGate=()=>resolve(config))};true');
  const originalDraft='帮我整理课程计划，但没有明确截止时间就不要编日期。';await input('#agentInput',originalDraft);const before=await domainState(),requestCount=await evaluate('__qaRequests.length');await click('#polishPrompt');await until(()=>evaluate('typeof __qaResolveGate==="function"'),'model resolution gate');assert.equal(await evaluate('$("#polishDialog").hidden'),true,'ordinary click does not open setup');
  await evaluate('currentConversation().modelConfig={provider:"api",model:"isolated-model-changed",effort:"low"};__qaResolveGate();ConversationModels.resolve=async config=>{__qaResolvedConfigs.push({...config});return {...config}};true');await until(()=>evaluate('__qaRequests.length>'+requestCount),'frozen polish generation');
  const request=await evaluate('__qaRequests.at(-1)');assert.equal(request.model,'isolated-model-alpha');assert.equal(request.effort,'high');assert.equal(request.input.length,2);const serialized=JSON.stringify(request.input);
  for(const marker of ['OLD_HISTORY_MUST_NOT_LEAK','OLD_ATTACHMENT_CONTENT_MUST_NOT_LEAK','OLD_ATTACHMENT_MUST_NOT_BE_RESENT','qa-reading-pdf'])assert.ok(!serialized.includes(marker),'polishing excludes history and attachments');
  await evaluate('__qaPending.options.onDelta("请整理课程");__qaPending.options.onDelta("请整理课程计划");true');assert.equal(await evaluate('$("#agentInput").value'),originalDraft,'streaming does not erase draft mid-sentence');
  const result='请整理课程计划，区分确定的安排与待确认事项；未提供的截止时间保持为空。';await finishPolish(result);assert.equal(await domainState(),before);assert.equal(await evaluate('currentConversation().draft'),result);assert.equal(await evaluate('$("#polishDialog").hidden'),true);assert.equal(await evaluate('$("#polishUndo").hidden'),false);assert.equal(await evaluate('!!sendMessage.busy'),false);
 });
 await step('undo restores the previous draft and never overwrites text typed after an automatic replacement',async()=>{
  await click('#polishUndo');assert.equal(await evaluate('$("#agentInput").value'),'帮我整理课程计划，但没有明确截止时间就不要编日期。');assert.equal(await evaluate('currentConversation().draft'),await evaluate('$("#agentInput").value'));
  await beginPolish('可撤销的原始文字');await finishPolish('第一次自动润色结果');await input('#agentInput','我在结果之后补写的新信息');if(await evaluate('!$("#polishUndo").hidden&&!$("#polishUndo").disabled'))await click('#polishUndo');assert.equal(await evaluate('$("#agentInput").value'),'我在结果之后补写的新信息');
 });
 await step('model-produced actions text is never interpreted as workstation commands or sent as a conversation message',async()=>{
  await beginPolish('把下面这句话说清楚');const before=await domainState();const result=JSON.stringify({message:'不应执行',actions:[{type:'create_task',title:'禁止生成的任务',workspace:'科研'}]});await finishPolish(result);assert.equal(await domainState(),before);assert.equal(await evaluate('state.tasks.length'),0);assert.equal(await evaluate('state.agentRuns.length'),0);
 });
 await step('the main button stops an active polish, closing settings does not stop it, and failed requests keep the draft',async()=>{
  const originalDraft='保留这个未发送的原始草稿';await beginPolish(originalDraft);const before=await domainState();await openPolishSettings();await click('#polishClose');assert.equal(await evaluate('__qaPending.options.signal.aborted'),false);assert.equal(await evaluate('$("#polishDialog").hidden'),true);await click('#polishPrompt');await until(()=>evaluate('__qaPending.options.signal.aborted'),'main button stops request');assert.match(await evaluate('$("#polishStatus").textContent'),/已停止|取消/);assert.equal(await evaluate('$("#agentInput").value'),originalDraft);assert.equal(await domainState(),before);await evaluate('__qaPending.resolve("迟到结果不可替换");true');await wait(100);assert.equal(await evaluate('$("#agentInput").value'),originalDraft);
  await beginPolish('失败时应保留原文');await evaluate('__qaPending.reject(new Error("隔离验收：服务拒绝请求"));true');await until(()=>evaluate('$("#polishStatus").textContent.includes("失败")'),'inline failure shown');assert.equal(await evaluate('$("#agentInput").value'),'失败时应保留原文');assert.equal(await evaluate('state.agentRuns.length'),0);await closePolishSettings();
 });
 await step('typing during generation or switching conversations preserves the newer draft and leaves the candidate available without auto-applying',async()=>{
  await beginPolish('正在润色的旧草稿');await input('#agentInput','用户后来写的新草稿');await evaluate('__qaPending.resolve("旧草稿的润色候选");true');await until(()=>evaluate('$("#polishStatus").textContent.includes("未覆盖")||$("#polishStatus").textContent.includes("变化")'),'changed draft protected');assert.equal(await evaluate('$("#agentInput").value'),'用户后来写的新草稿');await openPolishSettings();assert.equal(await evaluate('$("#polishCandidate").value'),'旧草稿的润色候选');assert.equal(await evaluate('$("#polishCopy").disabled'),false);await closePolishSettings();
  await beginPolish('属于对话A的旧稿');await evaluate('openConversation("qa-tools-conversation-b");true');await evaluate('__qaPending.resolve("A的候选不得写到B");true');await wait(200);assert.equal(await evaluate('$("#agentInput").value'),'另一对话的原草稿');assert.equal(await evaluate('state.conversations.find(x=>x.id==="qa-tools-conversation-a").draft'),'属于对话A的旧稿');await closePolishSettings();await evaluate('openConversation("qa-tools-conversation-a");true');
 });
 await step('a short hover stays quiet, a long hover opens settings, and moving into the nonmodal panel keeps it usable',async()=>{
  await closePolishSettings();const before=await evaluate('__qaRequests.length');await movePointer('#conversationTitle');await wait(250);await movePointer('#polishPrompt');await wait(250);assert.equal(await evaluate('$("#polishDialog").hidden'),true);await movePointer('#conversationTitle');await wait(700);assert.equal(await evaluate('$("#polishDialog").hidden'),true);
  await movePointer('#polishPrompt');await wait(720);assert.equal(await evaluate('$("#polishDialog").hidden'),false);await movePointer('#polishDialog');await wait(300);assert.equal(await evaluate('$("#polishDialog").hidden'),false);assert.equal(await evaluate('$("#polishDialog").matches(":modal")'),false);assert.equal(await evaluate('__qaRequests.length'),before);await click('#polishClose');assert.equal(await evaluate('$("#polishDialog").hidden'),true);await click('#polishSettings');assert.equal(await evaluate('$("#polishDialog").hidden'),false);await key('Escape');assert.equal(await evaluate('$("#polishDialog").hidden'),true);
 });
 await step('settings changes immediately persist, the next click uses the saved independent API/account model, and account mode receives no API token',async()=>{
  await openPolishSettings();const beforeRequests=await evaluate('__qaRequests.length'),config=await evaluate('JSON.stringify(currentConversation().modelConfig)');await input('#polishConnection','api');await input('#polishApiModel','polish-only-model');await input('#polishEffort','medium');await input('#polishStyle','concise');assert.equal(await evaluate('state.settings.promptPolisher.model'),'polish-only-model');assert.equal(await evaluate('state.settings.promptPolisher.effort'),'medium');assert.equal(await evaluate('state.settings.promptPolisher.style'),'concise');assert.equal(await evaluate('__qaRequests.length'),beforeRequests);await closePolishSettings();await settleSave();const stored=JSON.parse((await request('/__state')).body).settings.promptPolisher;assert.equal(stored.model,'polish-only-model');assert.equal(stored.style,'concise');
  const apiIndex=await beginPolish('独立模型配置验收');assert.equal(await evaluate('__qaRequests['+apiIndex+'].model'),'polish-only-model');assert.equal(await evaluate('__qaRequests['+apiIndex+'].effort'),'medium');assert.match(await evaluate('JSON.stringify(__qaRequests['+apiIndex+'].input)'),/去除重复/);await finishPolish('独立API润色已自动替换');
  await evaluate('window.__qaFetch=window.fetch;window.fetch=(url,options)=>String(url)==="/__auth/models"?Promise.resolve(new Response(JSON.stringify({data:[{id:"account-polish-model",displayName:"验收账号模型",isDefault:true,supportedReasoningEfforts:[{reasoningEffort:"medium"},{reasoningEffort:"high"}],defaultReasoningEffort:"medium"}]}),{status:200,headers:{"Content-Type":"application/json"}})):__qaFetch(url,options);true');
  await openPolishSettings();await input('#polishConnection','openai-auth');await until(()=>evaluate('$("#polishAccountModel").options.length>1&&!$("#polishAccountModel").disabled'),'mock account model metadata');await input('#polishAccountModel','account-polish-model');await input('#polishEffort','high');await closePolishSettings();assert.equal(await evaluate('state.settings.promptPolisher.model'),'account-polish-model');const authIndex=await beginPolish('使用独立账号模型润色');const auth=await evaluate('__qaRequests['+authIndex+']');assert.equal(auth.provider,'openai-auth');assert.equal(auth.model,'account-polish-model');assert.equal(auth.effort,'high');assert.equal(auth.token,undefined);assert.equal(await evaluate('JSON.stringify(currentConversation().modelConfig)'),config);await finishPolish('独立账号润色已自动替换');await openPolishSettings();await input('#polishConnection','current');await input('#polishStyle','structured');await closePolishSettings();await evaluate('window.fetch=__qaFetch;true');
 });
 await step('a delayed account model list preserves an effort changed while metadata is loading, in both visible controls and saved settings',async()=>{
  await closePolishSettings();const before=await evaluate('__qaRequests.length');
  await evaluate('state.settings.promptPolisher={connection:"openai-auth",model:"account-polish-model",effort:"medium",style:"structured"};window.__qaMetadataFetch=window.fetch;window.fetch=(url,options)=>String(url)==="/__auth/models"?new Promise(resolve=>window.__qaReleaseMetadata=()=>resolve(new Response(JSON.stringify({data:[{id:"account-polish-model",displayName:"验收账号模型",supportedReasoningEfforts:[{reasoningEffort:"medium"},{reasoningEffort:"high"}],defaultReasoningEffort:"medium"}]}),{status:200,headers:{"Content-Type":"application/json"}}))):__qaMetadataFetch(url,options);true');
  try {
   await openPolishSettings();await until(()=>evaluate('typeof __qaReleaseMetadata==="function"&&$("#polishAccountModel").dataset.loading==="true"'),'held account metadata');await input('#polishEffort','high');assert.equal(await evaluate('state.settings.promptPolisher.effort'),'high');await evaluate('__qaReleaseMetadata();true');await until(()=>evaluate('$("#polishAccountModel").dataset.loading==="false"'),'late metadata rendered');assert.equal(await evaluate('$("#polishEffort").value'),'high','late metadata must not visually reset the newer saved effort');assert.equal(await evaluate('state.settings.promptPolisher.effort'),'high');assert.equal(await evaluate('__qaRequests.length'),before);await settleSave();const stored=JSON.parse((await request('/__state')).body).settings.promptPolisher;assert.equal(stored.effort,'high');
  } finally {await evaluate('window.fetch=__qaMetadataFetch;true');await closePolishSettings();await evaluate('state.settings.promptPolisher={connection:"current",style:"structured"};true');}
 });
 await step('inline one-click controls and the settings popover stay reachable after resizing in 1440px/650px light and dark modes',async()=>{
  for(const [width,theme]of [[1440,'light'],[1440,'dark'],[650,'light'],[650,'dark']]){
   win.setSize(width,960);await evaluate('state.ui.theme='+JSON.stringify(theme)+';applyUiPreferences()');await input('#agentInput','目前的草稿，可直接点润色，或悬停调整下次使用的模型。');await openPolishSettings();await input('#polishConnection','api');await input('#polishApiModel','用于验收的独立模型名称_'.repeat(8));await input('#polishEffort','high');await settle();
   const boxes=await evaluate('(()=>[...document.querySelectorAll("#polishDialog,.polish-options,#polishPrompt,#polishSettings")].map(e=>{const r=e.getBoundingClientRect();return{name:e.id||e.className,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:e.clientWidth,scroll:e.scrollWidth}}))()');
   for(const box of boxes){assert.ok(box.left>=-1&&box.right<=width+1,JSON.stringify(box));assert.ok(box.scroll<=box.width+1,JSON.stringify(box));assert.ok(box.top>=-1&&box.bottom<=await evaluate('innerHeight')+1,JSON.stringify(box));}
   await snapshot('qa-workbench-polish-'+theme+'-'+width+'.png');await input('#polishConnection','current');await closePolishSettings();
  }
  win.setSize(1440,960);
 });
assert.equal(await evaluate('!!window.WorkspaceLayout&&!!$("#resize-sidebar")'),true,'integrated layout controls');
 async function dragHandle(selector,delta){
  const p=await evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+'),r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+Math.min(220,r.height/2))}})()');
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});
  for(let i=1;i<=5;i++){win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(p.x+delta*i/5),y:p.y,modifiers:['leftButtonDown']});await wait(30);}
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:p.x+delta,y:p.y});await settle();
 }
 async function key(code,modifiers=[]){win.webContents.sendInputEvent({type:'keyDown',keyCode:code,modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode:code,modifiers});await wait(80);}
 await step('native pointer resizing and keyboard bounds resize actual sidebar, conversation list and reader',async()=>{
  await evaluate('ReadingPane.hide();showView("agent","持续对话");WorkspaceLayout.refresh()');await settle();
  const sidebar=await evaluate('$(".sidebar").getBoundingClientRect().width');await dragHandle('#resize-sidebar',65);const wider=await evaluate('$(".sidebar").getBoundingClientRect().width');assert.ok(wider>sidebar+40,'sidebar responds to actual pointer drag');
  assert.equal(await evaluate('state.ui.panelWidths.sidebar'),Math.round(wider));await click('#resize-sidebar');await key('Home');assert.equal(await evaluate('Math.round($(".sidebar").getBoundingClientRect().width)'),await evaluate('Number($("#resize-sidebar").getAttribute("aria-valuemin"))'));
  await key('Right',['shift']);assert.equal(await evaluate('Math.round($(".sidebar").getBoundingClientRect().width)'),194);
  const navigator=await evaluate('$(".conversation-navigator").getBoundingClientRect().width');await dragHandle('#resize-navigator',45);assert.ok(await evaluate('$(".conversation-navigator").getBoundingClientRect().width')>navigator+30);
  await evaluate('openNote("qa-tools-note")');await settle();const reader=await evaluate('$("#readingPane").getBoundingClientRect().width');await dragHandle('#resize-reader',-45);assert.ok(await evaluate('$("#readingPane").getBoundingClientRect().width')>reader+30);
  await click('#resize-reader');await key('End');assert.ok(await evaluate('$(".main").getBoundingClientRect().width')>=359);assert.equal(await evaluate('Number($("#resize-reader").getAttribute("aria-valuenow"))'),await evaluate('Number($("#resize-reader").getAttribute("aria-valuemax"))'));
  await settleSave();const saved=JSON.parse((await request('/__state')).body).ui.panelWidths;assert.equal(saved.sidebar,await evaluate('state.ui.panelWidths.sidebar'));assert.equal(saved.reader,await evaluate('state.ui.panelWidths.reader'));
 });
await step('a 360px chat companion column keeps its title, menu, reading toggle and composer usable',async()=>{
  await evaluate('currentConversation().title="课程研究资料整理与长期知识库建设的持续对话";renderConversation();WorkspaceLayout.refresh()');await settle();
  const dimensions=await evaluate('({main:$(".main").getBoundingClientRect().width,title:$("#conversationTitle").getBoundingClientRect().width,composer:$("#composer").clientWidth,composerScroll:$("#composer").scrollWidth})');
  assert.ok(dimensions.main>=359&&dimensions.main<=370,JSON.stringify(dimensions));assert.ok(dimensions.title>=80,JSON.stringify(dimensions));assert.ok(dimensions.composerScroll<=dimensions.composer+1,JSON.stringify(dimensions));
  await click('#conversationMenu');assert.equal(await evaluate('$("#manageDialog").open'),true);await click('#manageDialog button.secondary[value="cancel"]');
  for(const theme of ['light','dark']){await evaluate('state.ui.theme='+JSON.stringify(theme)+';applyUiPreferences();WorkspaceLayout.refresh()');await snapshot('qa-workbench-chat-minimum-'+theme+'-1440.png');}
  await click('#readingToggle');assert.equal(await evaluate('$("#readingPane").hidden'),true);await click('#readingToggle');assert.equal(await evaluate('$("#readingPane").hidden'),false);await click('#agentInput');await win.webContents.insertText('窄栏仍可输入');assert.match(await evaluate('$("#agentInput").value'),/窄栏仍可输入/);
 });
 await step('minimum-width reader still exposes working PDF page and zoom controls',async()=>{
  await evaluate('state.ui.theme="light";applyUiPreferences();openImport("qa-reading-pdf",1)');await until(()=>evaluate('$(".pdf-sheet img")?.complete&&$(".pdf-sheet img").naturalWidth>0'),'PDF ready');
  await click('#resize-reader');await key('Home');await settle();assert.equal(await evaluate('Math.round($("#readingPane").getBoundingClientRect().width)'),320);
  const boxes=await evaluate('(()=>[...document.querySelectorAll("#readingPane,.pdf-toolbar,.pdf-page-controls,.pdf-zoom-controls,.reading-toolbar")].map(e=>{const r=e.getBoundingClientRect();return{id:e.id||e.className,left:r.left,right:r.right,width:e.clientWidth,scroll:e.scrollWidth}}))()');
  for(const box of boxes){assert.ok(box.scroll<=box.width+1,JSON.stringify(box));assert.ok(box.left>=-1&&box.right<=1441,JSON.stringify(box));}
  await click('[data-pdf-next]');await until(()=>evaluate('$("[data-pdf-page]").value==="2"&&$(".pdf-sheet img").complete'),'PDF next page at minimum reader');
  await click('[data-pdf-plus]');await click('[data-pdf-fit]');await snapshot('qa-workbench-reader-minimum-light-1440.png');
 });
 await step('theme controls are visible in sidebar and full reader, with text labels and no narrow overflow',async()=>{
  await evaluate('state.ui.theme="light";applyUiPreferences();WorkspaceLayout.refresh()');await click('#sidebarThemeBtn');assert.equal(await evaluate('state.ui.theme'),'dark');assert.match(await evaluate('$("#sidebarThemeBtn").textContent'),/切换浅色/);
  await click('#readingExpand');await click('#readerThemeBtn');assert.equal(await evaluate('state.ui.theme'),'light');assert.match(await evaluate('$("#readerThemeBtn").textContent'),/切换深色/);await click('#readingExpand');
  for(const [width,theme]of [[1440,'light'],[1440,'dark'],[650,'light'],[650,'dark']]){
   win.setSize(width,960);await evaluate('state.ui.theme='+JSON.stringify(theme)+';applyUiPreferences();WorkspaceLayout.refresh()');await settle();
   assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),true);await snapshot('qa-workbench-reader-'+theme+'-'+width+'.png');
   if(width===650){assert.equal(await evaluate('$("#resize-reader").hidden&&$("#resize-sidebar").hidden'),true);await click('#readingBack');await click('#sidebarThemeBtn');assert.equal(await evaluate('state.ui.theme'),theme==='light'?'dark':'light');await click('#readingToggle');}
  }
  win.setSize(1440,960);await evaluate('ReadingPane.hide();showView("agent","持续对话")');await settle();
 });
 const dropFile=path.join(TEMP,'dropped-course.pdf');fs.writeFileSync(dropFile,original);const dropFolder=path.join(TEMP,'dropped-folder');fs.mkdirSync(dropFolder);
 win.webContents.debugger.attach('1.3');
 async function fileDrag(selector,paths,{drop=true}={}){
  const p=await evaluate('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+Math.min(120,r.height/2))}})()'),data={items:[],files:paths,dragOperationsMask:1};
  await win.webContents.debugger.sendCommand('Input.dispatchDragEvent',{type:'dragEnter',...p,data});await wait(80);await win.webContents.debugger.sendCommand('Input.dispatchDragEvent',{type:'dragOver',...p,data});await wait(100);
  if(drop)await win.webContents.debugger.sendCommand('Input.dispatchDragEvent',{type:'drop',...p,data});
  return {p,data};
 }
 await step('browser-level file drag over the conversation shows a clear overlay and directly persists the original attachment',async()=>{
  await evaluate('state.ui.theme="light";applyUiPreferences()');const count=await evaluate('state.imports.length'),messages=await evaluate('currentConversation().messages.length'),runs=await evaluate('state.agentRuns.length');
  const drag=await fileDrag('#messageList',[dropFile],{drop:false});assert.equal(await evaluate('$("#conversationDropOverlay").hidden'),false);await snapshot('qa-workbench-file-drop-light-1440.png');
  await win.webContents.debugger.sendCommand('Input.dispatchDragEvent',{type:'drop',...drag.p,data:drag.data});
  await until(()=>evaluate('!importMaterials.busy&&state.imports.length>'+count),'direct dropped attachment');
  assert.equal(await evaluate('$("#conversationDropOverlay").hidden'),true);assert.equal(await evaluate('$("#importDialog").open'),false,'drop does not require another import dialog');
  const source=await evaluate('state.imports.find(i=>i.originalName==="dropped-course.pdf"||i.name==="dropped-course.pdf")');assert.ok(source);assert.equal(source.projectId,'qa-tools-course');
  assert.equal(await evaluate('currentConversation().draftAttachmentIds.includes('+JSON.stringify(source.id)+')'),true);assert.equal(await evaluate('state.conversations.find(c=>c.id==="qa-tools-conversation-b").attachments.includes('+JSON.stringify(source.id)+')'),false);
  assert.deepEqual((await request('/__files/'+source.id)).body,original);assert.equal(await evaluate('currentConversation().messages.length'),messages);assert.equal(await evaluate('state.agentRuns.length'),runs);await settleSave();
  await evaluate('openProject("qa-tools-course");$("#projectTreePanel").open=true;$("#projectTree").querySelectorAll("details").forEach(e=>e.open=true)');
  const sourceSelector='#projectTree [data-open-import="'+source.id+'"]';assert.equal(await evaluate('!!document.querySelector('+JSON.stringify(sourceSelector)+')'),true,'bound dropped source immediately appears in the project tree');await click(sourceSelector);await until(()=>evaluate('$(".pdf-sheet img")?.complete&&$(".pdf-sheet img").naturalWidth>0'),'project-tree original preview');
  assert.equal(await evaluate('$("#previewTitle").textContent'),'dropped-course.pdf');await evaluate('ReadingPane.hide();showView("agent","持续对话")');
 });
 await step('folder drops and drops outside the conversation are rejected without navigation or unexpected import',async()=>{
  const count=await evaluate('state.imports.length');await fileDrag('#messageList',[dropFolder]);await until(()=>evaluate('$("#toast")?.textContent.includes("文件夹")'),'folder rejection');assert.equal(await evaluate('state.imports.length'),count);assert.equal(await evaluate('$("#conversationDropOverlay").hidden'),true);
  await fileDrag('.sidebar',[dropFile]);await wait(180);assert.equal(await evaluate('state.imports.length'),count);assert.equal(win.webContents.getURL(),ORIGIN+'/');
  const textDrop=await evaluate('(()=>{const transfer=new DataTransfer();transfer.setData("text/plain","原生文本拖动");const e=new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:transfer});$("#messageList").dispatchEvent(e);return {prevented:e.defaultPrevented,overlay:$("#conversationDropOverlay").hidden}})()');assert.equal(textDrop.prevented,false);assert.equal(textDrop.overlay,true);
 });
 win.webContents.debugger.detach();
assert.equal(await evaluate('!!window.PlanningWorkbench&&!!$("#dashboardAddTask")&&!!$("#coursesAddTask")&&!!$("#projectAddTask")'),true,'integrated manual planning entries');
 async function createTaskVia(entry,fields){
  await click(entry);for(const [selector,value]of Object.entries(fields))await input(selector,value);await click('#planningCreateSubmit');await until(()=>evaluate('!$("#planningCreateDialog").open'),'manual task saved');
 }
 await step('manual task creation uses the correct space/project, supports empty dates and rejects inverted dates',async()=>{
  await evaluate('ReadingPane.hide();showView("courses","课程空间")');await click('#coursesAddTask');await input('#planningTaskTitle','取消的任务不能入库');await click('#planningCreateDialog .secondary');assert.equal(await evaluate('state.tasks.length'),0);
  await createTaskVia('#coursesAddTask',{'#planningTaskTitle':'课程准备_计划任务','#planningTaskProject':'qa-tools-course','#planningTaskStart':'2026-09-20','#planningTaskDue':'2026-09-24','#planningTaskPriority':'high'});
  const created=await evaluate('state.tasks.find(t=>t.title==="课程准备_计划任务")');assert.equal(created.workspace,'课程');assert.equal(created.projectId,'qa-tools-course');assert.equal(created.startAt,'2026-09-20');assert.equal(created.dueAt,'2026-09-24');
  await createTaskVia('#coursesAddTask',{'#planningTaskTitle':'课程复习_只有截止日期','#planningTaskProject':'qa-tools-course','#planningTaskDue':'2026-09-27','#planningTaskStatus':'done'});
  const deadline=await evaluate('state.tasks.find(t=>t.title==="课程复习_只有截止日期")');assert.equal(deadline.startAt,null);assert.equal(deadline.status,'done');assert.ok(deadline.completedAt);
  await click('#coursesAddTask');await input('#planningTaskTitle','错误日期任务');await input('#planningTaskStart','2026-09-25');await input('#planningTaskDue','2026-09-24');await click('#planningCreateSubmit');
  assert.match(await evaluate('$("#planningCreateError").textContent'),/截止日期不能早于开始日期/);assert.equal(await evaluate('state.tasks.some(t=>t.title==="错误日期任务")'),false);await click('#planningCreateDialog .secondary');
  await evaluate('showView("daily","日常空间")');await createTaskVia('#dailyStart',{'#planningTaskTitle':'日常未排期任务'});const unscheduled=await evaluate('state.tasks.find(t=>t.title==="日常未排期任务")');assert.equal(unscheduled.workspace,'日常');assert.equal(unscheduled.projectId,null);assert.equal(unscheduled.startAt,null);assert.equal(unscheduled.dueAt,null);
 });
 await step('progress, timeline and membership graph derive scoped data and provide real click-through',async()=>{
  await evaluate('showView("courses","课程空间");renderAll()');assert.equal(await evaluate('$("#coursesPlanning .planning-donut").getAttribute("aria-label")'),'1/2 个任务已完成');
  assert.equal(await evaluate('$("#coursesPlanning .planning-donut b").textContent'),'50%');assert.equal(await evaluate('$("#coursesPlanning").querySelectorAll(".planning-timeline-row").length'),2);
  assert.equal(await evaluate('$("#coursesPlanning").querySelectorAll(".planning-timeline-mark.deadline").length'),1);assert.equal(await evaluate('$("#coursesPlanning").querySelectorAll(".planning-timeline-mark.range").length'),1);
  const deadline=await evaluate('state.tasks.find(t=>t.title==="课程复习_只有截止日期").id');
  const row=await evaluate('document.querySelector("#coursesPlanning [data-planning-id=\\"'+deadline+'\\"]").closest(".planning-timeline-row").textContent');assert.match(row,/截止 2026-09-27/);assert.ok(!row.includes('跨度'));
  await click('#coursesPlanning [data-planning-open="task"][data-planning-id="'+deadline+'"]');assert.equal(await evaluate('$("#taskDialog").open'),true);assert.equal(await evaluate('state.openTaskId'),deadline);await evaluate('$("#taskDialog").close()');
  await click('#coursesPlanning .planning-relation-map [data-planning-open="note"][data-planning-id="qa-tools-note"]');assert.equal(await evaluate('$("#previewTitle").textContent'),'控制方法与研究来源');assert.equal(await evaluate('$("#previewDialog").matches(":modal")'),false);await evaluate('ReadingPane.hide()');
  await click('#coursesPlanning .planning-project-progress[data-planning-id="qa-tools-course"]');assert.equal(await evaluate('state.currentProjectId'),'qa-tools-course');assert.equal(await evaluate('document.body.dataset.view'),'project');
 });
 await step('manual task editor and move dialog support cross-space moves while preserving dates and source links',async()=>{
  const task=await evaluate('state.tasks.find(t=>t.title==="课程准备_计划任务").id');
  await evaluate('state.tasks.find(t=>t.id==='+JSON.stringify(task)+').sourceAttachmentIds=["qa-reading-pdf"];openTask('+JSON.stringify(task)+')');
  await input('#taskProjectInput','qa-tools-research');assert.equal(await evaluate('$("#taskWorkspaceInput").value'),'科研');await click('#saveTask');
  let current=await evaluate('state.tasks.find(t=>t.id==='+JSON.stringify(task)+')');assert.equal(current.workspace,'科研');assert.equal(current.projectId,'qa-tools-research');assert.deepEqual(current.sourceAttachmentIds,['qa-reading-pdf']);assert.equal(current.startAt,'2026-09-20');assert.equal(current.dueAt,'2026-09-24');
  await evaluate('showView("research","科研空间")');await click('#researchPlanning [data-planning-move="'+task+'"]');assert.equal(await evaluate('$("#planningMoveDialog").open'),true);
  await input('#planningMoveProject','qa-tools-course');assert.equal(await evaluate('$("#planningMoveWorkspace").value'),'课程');await click('#planningMoveSubmit');await until(()=>evaluate('!$("#planningMoveDialog").open'),'task moved');
  current=await evaluate('state.tasks.find(t=>t.id==='+JSON.stringify(task)+')');assert.equal(current.projectId,'qa-tools-course');assert.equal(current.workspace,'课程');assert.deepEqual(current.sourceAttachmentIds,['qa-reading-pdf']);assert.equal(current.dueAt,'2026-09-24');
  await evaluate('openTask('+JSON.stringify(task)+')');await input('#taskWorkspaceInput','日常');assert.equal(await evaluate('$("#taskProjectInput").value'),'');await click('#saveTask');
  current=await evaluate('state.tasks.find(t=>t.id==='+JSON.stringify(task)+')');assert.equal(current.projectId,null);assert.equal(current.workspace,'日常');assert.equal(current.startAt,'2026-09-20');assert.deepEqual(current.sourceAttachmentIds,['qa-reading-pdf']);
 });
 await step('planning charts and manual dialogs stay within wide, 650px and resized reader companion columns',async()=>{
  for(const [width,theme]of [[1440,'light'],[1440,'dark'],[650,'light'],[650,'dark']]){
   win.setSize(width,960);await evaluate('state.ui.theme='+JSON.stringify(theme)+';applyUiPreferences();ReadingPane.hide();showView("dashboard","总览");renderAll()');await settle();
   const containers=await evaluate('(()=>[...document.querySelectorAll("#dashboardPlanning,.planning-dialog[open]")].filter(e=>e.getBoundingClientRect().width).map(e=>({id:e.id,width:e.clientWidth,scroll:e.scrollWidth,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right})))()');
   for(const box of containers){assert.ok(box.scroll<=box.width+1,JSON.stringify(box));assert.ok(box.left>=-1&&box.right<=width+1,JSON.stringify(box));}
   await evaluate('$("#dashboardPlanning").scrollIntoView({block:"start",behavior:"instant"})');await snapshot('qa-workbench-planning-'+theme+'-'+width+'.png');
   await click('#dashboardAddTask');await input('#planningTaskTitle','长名称_'.repeat(30));await settle();
   const dialog=await evaluate('(()=>{const d=$("#planningCreateDialog"),r=d.getBoundingClientRect();return{width:d.clientWidth,scroll:d.scrollWidth,left:r.left,right:r.right}})()');assert.ok(dialog.scroll<=dialog.width+1&&dialog.left>=-1&&dialog.right<=width+1,JSON.stringify(dialog));await snapshot('qa-workbench-manual-task-'+theme+'-'+width+'.png');await click('#planningCreateDialog .secondary');
  }
  win.setSize(1177,960);await evaluate('openProject("qa-tools-course");openNote("qa-tools-note");WorkspaceLayout.refresh()');await click('#resize-reader');await key('End');await settle();
  assert.equal(await evaluate('$("#projectPlanning").scrollWidth<=$("#projectPlanning").clientWidth+1'),true,'planning fits the smallest companion project column');await snapshot('qa-workbench-planning-reader-dark-1177.png');await evaluate('ReadingPane.hide()');
 });
 await step('manual tasks, layout preferences and attachment ownership survive a full reload',async()=>{
  await settleSave();const expected=await evaluate('JSON.stringify({tasks:state.tasks,panelWidths:state.ui.panelWidths,theme:state.ui.theme})');await win.loadURL(ORIGIN);await until(()=>evaluate('storageHydrated'),'full reload');
  assert.equal(await evaluate('JSON.stringify({tasks:state.tasks,panelWidths:state.ui.panelWidths,theme:state.ui.theme})'),expected);assert.equal(await evaluate('state.tasks.length'),3);
 });
 await step('new workbench UI introduces no renderer errors or real model/account/external request',async()=>{assert.deepEqual(forbidden,[]);assert.deepEqual(errors,[]);});
 console.log(JSON.stringify({passed:passed.length,failures,qaStore:TEMP,screenshots:'design/qa-workbench-*.png',modelCalls:0},null,2));assert.deepEqual(failures,[]);
}
function finish(code){clearTimeout(watchdog);win?.destroy();server?.kill('SIGTERM');code?app.exit(code):app.quit();}
run().then(()=>finish(0)).catch(error=>{console.error(error);console.error('QA store retained:',TEMP);finish(1);});
