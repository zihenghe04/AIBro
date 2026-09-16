/* Isolated native Electron acceptance for the nonmodal reading pane. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18897,ORIGIN='http://127.0.0.1:'+PORT,TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aw-reading-pane-smoke-')),STORE=path.join(TEMP,'store');
fs.mkdirSync(path.join(STORE,'files'),{recursive:true});fs.mkdirSync(path.join(TEMP,'profile'));app.setPath('userData',path.join(TEMP,'profile'));
const pdf=spawnSync(process.env.PYTHON||'python3',['-c',[
'import fitz,sys,json','from pathlib import Path','p=Path(sys.argv[1]);d=fitz.open()',
'for n in range(2):',' page=d.new_page(width=420,height=300);page.insert_text((35,45),"Reading pane QA - page "+str(n+1));page.draw_rect(fitz.Rect(40,80,330,240),color=(0,.2,.6),fill=(.1,.45,.85) if n==0 else (.55,.3,.7))',
'(p/"qa-reading-pdf").write_bytes(d.tobytes());(p/"qa-reading-pdf.meta.json").write_text(json.dumps({"name":"Two-page original.pdf","mimeType":"application/pdf"}))'].join('\n'),path.join(STORE,'files')]);assert.equal(pdf.status,0,pdf.stderr?.toString());
const original=fs.readFileSync(path.join(STORE,'files','qa-reading-pdf')),wait=ms=>new Promise(r=>setTimeout(r,ms));
const request=route=>new Promise((resolve,reject)=>http.get(ORIGIN+route,r=>{const chunks=[];r.on('data',c=>chunks.push(c));r.on('end',()=>resolve({status:r.statusCode,body:Buffer.concat(chunks)}));}).on('error',reject));
async function until(check,label,timeout=15000){const start=Date.now();while(Date.now()-start<timeout){if(await check())return;await wait(60);}throw Error('Timed out: '+label);}
let server,win;const passed=[],failures=[];const watchdog=setTimeout(()=>{console.error('QA timeout',TEMP);win?.destroy();server?.kill('SIGTERM');app.exit(1);},180000);
async function run(){
 await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',()=>reject(Error('18897 occupied; refusing existing workspace')));probe.listen(PORT,'127.0.0.1',()=>probe.close(resolve));});
 const log=fs.openSync(path.join(TEMP,'server.log'),'a');server=spawn(process.env.PYTHON||'python3',[path.join(ROOT,'server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(PORT),AI_WORKSTATION_DATA_DIR:STORE},stdio:['ignore',log,log]});
 await until(async()=>{if(server.exitCode!==null)throw Error('QA service exited');try{return(await request('/__health')).status===200;}catch{return false;}},'temporary service');
 await app.whenReady();win=new BrowserWindow({show:false,width:1440,height:960,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const errors=[],forbidden=[];win.webContents.on('console-message',(_event,level,message)=>{if(level>=3){errors.push(message);console.error('RENDERER',message);}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{const url=new URL(details.url),blocked=['http:','https:'].includes(url.protocol)&&(url.origin!==ORIGIN||/^\/__(proxy|codex\/respond)/.test(url.pathname)||/^\/__auth\/(login|logout)/.test(url.pathname)||url.pathname==='/__cloud/connect');if(blocked)forbidden.push(details.url);callback({cancel:blocked});});
 const evaluate=async code=>{try{return await win.webContents.executeJavaScript(code,true);}catch(error){console.error('Script prefix:',code.slice(0,400));throw error;}};
 async function settle(){await wait(180);await evaluate('document.getAnimations().forEach(a=>{if(Number.isFinite(a.effect?.getComputedTiming().endTime))try{a.finish();}catch(_){}})');await wait(30);}
 async function click(selector){const p=await evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');if(!e)throw Error("Missing "+'+JSON.stringify(selector)+');e.scrollIntoView({block:"nearest",behavior:"instant"});const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2),hit=document.elementFromPoint(x,y);if(!r.width||!r.height||e.disabled||!(e===hit||e.contains(hit)))throw Error("Hidden/covered "+'+JSON.stringify(selector)+');return{x,y}})()');win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await wait(100);}
 const tab=id=>".reading-tab-select[data-reading-key='"+JSON.stringify([id==='qa-reading-pdf'?'import':'note',id])+"']";
 const tabClose=id=>'.reading-tab:has('+tab(id)+') .reading-tab-close';
 async function readyPdf(page){await until(()=>evaluate('(()=>{const i=$(".pdf-sheet img");return !!i&&i.complete&&i.naturalWidth>0&&$("[data-pdf-page]").value==='+JSON.stringify(String(page))+'})()'),'PDF page '+page);}
 async function step(label,fn){try{await fn();passed.push(label);console.log('PASS',label);}catch(error){failures.push({label,error:error.stack});console.error('FAIL',label,error.message);}}
 async function snapshot(name){await settle();fs.writeFileSync(path.join(ROOT,'design',name),(await win.webContents.capturePage()).toPNG());}
 await win.loadURL(ORIGIN);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydration');assert.equal(await evaluate('!!window.ReadingPane'),true);
 const now=Date.now(),project={id:'qa-reading-project',name:'课程研究资料与长期知识网络的完整项目名称'.repeat(4),workspace:'课程',description:'隔离验收项目，检查并排阅读时文件树与项目总览。',createdAt:now};
 const fixture={projects:[project],papers:[],agentRuns:[],trash:[],imports:[{id:'qa-reading-pdf',name:'课程概述与实践要求_两页原始资料.pdf',originalName:'Two-page original.pdf',mimeType:'application/pdf',content:'第1页课程概览。第2页研究问题与实践要求。',pages:[{page:1,text:'课程概览'},{page:2,text:'实践要求'}],projectId:project.id,workspace:'课程',createdAt:now}],notes:[{id:'qa-reading-note-a',title:'课程阅读笔记：方法、公式与实践中的待确认事项',content:'# 核心知识结构\n\n这是一份用于隔离验收的笔记。\n\n## 可持续整理\n\n- 保留原始资料\n- 明确来源和后续行动\n\n**粗体信息**与普通段落应清楚区分。\n\n|主题|来源|\n|---|---|\n|学习方法|第 2 页|\n\n'+('长段落withoutspaces_'.repeat(95))+'\n\n最后一段：不阻塞对话输入。',sourceAttachmentIds:['qa-reading-pdf'],projectId:project.id,workspace:'课程',createdAt:now},{id:'qa-reading-note-b',title:'第二篇笔记_'+('非常长的标题withoutspaces_'.repeat(15)),content:'## 第二篇笔记\n\n这是另一篇独立的持久化笔记。',sourceAttachmentIds:['qa-reading-pdf'],projectId:project.id,workspace:'课程',createdAt:now}],tasks:[{id:'qa-reading-task',title:'复核资料中的实践要求',description:'原始任务详情',projectId:project.id,workspace:'课程',sourceAttachmentIds:['qa-reading-pdf'],status:'todo',priority:'medium',checklist:[],createdAt:now}],conversations:[{id:'qa-reading-conversation',title:'整理课程课件，持续追问与来源核对',workspace:'课程',projectId:project.id,attachments:['qa-reading-pdf'],draftAttachmentIds:[],draft:'',messages:[{id:'qa-user',role:'user',text:'整理课件与笔记，并保留原始来源。',at:now},{id:'qa-agent',role:'agent',text:'已为你建立课程资料与阅读笔记。',results:[{type:'note',id:'qa-reading-note-a',text:'课程阅读笔记'},{type:'import',id:'qa-reading-pdf',text:'原始 PDF'}],at:now+1}],createdAt:now}],currentConversationId:'qa-reading-conversation'};
 await evaluate('Object.assign(state,'+JSON.stringify(fixture)+');normalizeStateShape(state);repairRelationships();state.ui.theme="light";state.ui.inspectorOpen=false;save();applyUiPreferences();showView("agent","持续对话");renderAll()');
 await step('openNote shows a nonmodal rich document and native chat input remains usable',async()=>{
  await evaluate('openNote("qa-reading-note-a")');await settle();
  assert.equal(await evaluate('$("#previewDialog").open&&!$("#previewDialog").matches(":modal")&&$("#previewDialog").parentElement.id==="readingPane"'),true);
  assert.equal(await evaluate('$("#previewContent").querySelector("h1")?.textContent'),'核心知识结构');assert.equal(await evaluate('$("#previewExtracted").open'),true);
  await click('#agentInput');await win.webContents.insertText('继续核对第 2 页');assert.equal(await evaluate('$("#agentInput").value'),'继续核对第 2 页');assert.equal(await evaluate('document.activeElement.id'),'agentInput');await snapshot('qa-reading-chat-light-1440.png');
 });
 await step('native PDF controls, tabs and collapse/reopen preserve page and chat draft',async()=>{
  await evaluate('openImport("qa-reading-pdf",1)');await readyPdf(1);assert.equal(await evaluate('$("#previewDialog").matches(":modal")'),false);assert.equal(await evaluate('$("#previewExtracted").open'),false);
  await click('[data-pdf-next]');await readyPdf(2);await click(tab('qa-reading-note-a'));assert.match(await evaluate('$("#previewTitle").textContent'),/课程阅读笔记/);
  await click(tab('qa-reading-pdf'));await readyPdf(2);assert.equal(await evaluate('$("#agentInput").value'),'继续核对第 2 页');
  await click('#readingCollapse');assert.equal(await evaluate('$("#readingPane").hidden'),true);assert.equal(await evaluate('$("#readingTabs [role=tab]")!==null'),true);
  await click('#readingToggle');await readyPdf(2);assert.equal(await evaluate('$("#readingPane").hidden'),false);
  await click('#readingExpand');assert.equal(await evaluate('document.body.classList.contains("reading-expanded")'),true);await click('#readingExpand');assert.equal(await evaluate('document.body.classList.contains("reading-expanded")'),false);await snapshot('qa-reading-pdf-light-1440.png');
 });
 await step('long note/source title and project columns fit 1440/1177/650 in both themes',async()=>{
  const overflow=[];
  for(const [width,theme]of [[1440,'light'],[1440,'dark'],[1177,'light'],[1177,'dark'],[650,'light'],[650,'dark']]){
   win.setSize(width,960);await evaluate('state.ui.theme='+JSON.stringify(theme)+';applyUiPreferences();openProject("qa-reading-project");openNote("qa-reading-note-b")');await settle();
   assert.equal(await evaluate('(()=>{const a=$("#readingTabs .reading-tab.active").getBoundingClientRect(),s=$("#readingTabs").getBoundingClientRect();return a.left>=s.left-1&&a.right<=s.right+1})()'),true,'active tab and its close control are visible without manually scrolling the strip');
   const boxes=await evaluate('(()=>{const selectors=["#readingPane","#previewDialog","#previewDialog>form","#previewTitle","#previewContent",".reading-toolbar","#readingTabs",".reading-pane .dialog-actions",".main","#projectTitle",".project-layout",".project-content",".project-tree-panel"];return selectors.flatMap(selector=>[...document.querySelectorAll(selector)].filter(e=>e.getBoundingClientRect().width).map(e=>{const r=e.getBoundingClientRect();return{selector,width:e.clientWidth,scroll:e.scrollWidth,left:r.left,right:r.right}}))})()');
   for(const b of boxes)if((b.selector!=='#readingTabs'&&b.scroll>b.width+1)||b.left< -1||b.right>width+1)overflow.push({width,theme,...b});
   assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),true);
   if(width>1000)assert.equal(await evaluate('$(".main").getBoundingClientRect().width>250'),true);else{assert.equal(await evaluate('$(".main").getBoundingClientRect().width'),0);await click('#readingBack');assert.equal(await evaluate('$("#readingPane").hidden'),true);assert.equal(await evaluate('$(".main").getBoundingClientRect().width>0'),true);await click('#readingToggle');}
   await snapshot('qa-reading-project-'+theme+'-'+width+'.png');
  }
  assert.deepEqual(overflow,[],'non-scrolling document and project surfaces stay within their column bounds');
 });
 await step('project/agent/settings navigation preserves tabs; native Escape returns to workspace',async()=>{
  win.setSize(1440,960);await evaluate('ReadingPane.hide();showView("settings","设置")');await click('#readingToggle');assert.equal(await evaluate('$("#readingTabs [role=tab]")!==null'),true);
  await click('#readingCollapse');await evaluate('showView("agent","持续对话")');await click('#readingToggle');await click('.reading-tab.active [role=tab]');assert.equal(await evaluate('document.activeElement.classList.contains("reading-tab-select")'),true,'selected tab keeps DOM focus after repaint');win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await wait(100);assert.equal(await evaluate('$("#readingPane").hidden'),true);await click('#readingToggle');
 });
 await step('task modal opens nonmodal source then returns with unsaved fields intact',async()=>{
  await evaluate('ReadingPane.hide();openTask("qa-reading-task");$("#taskDescriptionInput").value="未保存的任务草稿"');assert.equal(await evaluate('$("#taskDialog").matches(":modal")'),true);
  await click('#taskDialog [data-open-import="qa-reading-pdf"]');await readyPdf(1);assert.equal(await evaluate('$("#taskDialog").open'),false);assert.equal(await evaluate('document.querySelectorAll("dialog:modal").length'),0);
  await click('#previewBack');assert.equal(await evaluate('$("#taskDialog").matches(":modal")'),true);assert.equal(await evaluate('$("#taskDescriptionInput").value'),'未保存的任务草稿');await evaluate('$("#taskDialog").close()');
 });
 await step('individual tab close and delayed original load never reopen a closed reader',async()=>{
  await evaluate('openNote("qa-reading-note-a");openNote("qa-reading-note-b")');await click(tabClose('qa-reading-note-a'));assert.equal(await evaluate('!!document.querySelector('+JSON.stringify(tab('qa-reading-note-a'))+')'),false);assert.match(await evaluate('$("#previewTitle").textContent'),/第二篇笔记/);
  await evaluate('window.__qaOriginalGet=fileStoreGet;fileStoreGet=id=>id==="qa-reading-pdf"?new Promise(resolve=>window.__qaResolveBlob=resolve):window.__qaOriginalGet(id);openImport("qa-reading-pdf")');
  await until(()=>evaluate('typeof __qaResolveBlob==="function"'),'pending source');await click('#readingCollapse');await evaluate('__qaResolveBlob(new Blob(["late response"],{type:"application/pdf"}));fileStoreGet=__qaOriginalGet;true');await wait(180);
  assert.equal(await evaluate('$("#readingPane").hidden'),true);assert.equal(await evaluate('$("#previewDialog").open'),false);assert.equal(await evaluate('$("#previewVisual").children.length'),0);
  await click('#readingToggle');await readyPdf(1);await click(tabClose('qa-reading-pdf'));assert.match(await evaluate('$("#previewTitle").textContent'),/第二篇笔记/);
 });
 await step('note edit modal closes back into the existing reader and restores ongoing chat access',async()=>{
  await evaluate('openNote("qa-reading-note-a")');await click('#editPreviewNote');assert.equal(await evaluate('$("#noteEditorDialog").matches(":modal")'),true);
  await evaluate('$("#noteEditorContent").value="未保存的编辑器草稿";$("#noteEditorContent").dispatchEvent(new Event("input",{bubbles:true}))');await click('#noteEditorDialog .note-editor-close');
  assert.equal(await evaluate('document.querySelectorAll("dialog:modal").length'),0);assert.equal(await evaluate('$("#readingPane").hidden'),false);assert.match(await evaluate('$("#previewContent").textContent'),/核心知识结构/);
  await click('#agentInput');await win.webContents.insertText('，保持对话');assert.match(await evaluate('$("#agentInput").value'),/保持对话/);
 });
 await step('native preview deletion can cancel; confirmed deletion removes the active tab without deleting PDF',async()=>{
  await evaluate('state.notes.push({id:"qa-reading-delete-note",title:"删除入口验收笔记",content:"隔离测试正文",projectId:"qa-reading-project",workspace:"课程",sourceAttachmentIds:["qa-reading-pdf"],createdAt:Date.now()});save();renderAll();openNote("qa-reading-delete-note")');
  await click('#previewDelete');assert.equal(await evaluate('$("#contentDeleteDialog").matches(":modal")'),true);await click('#contentDeleteDialog .secondary');assert.equal(await evaluate('state.notes.some(n=>n.id==="qa-reading-delete-note")'),true);assert.equal(await evaluate('$("#readingPane").hidden'),false);
  await click('#previewDelete');await click('#confirmContentDelete');await until(()=>evaluate('!$("#contentDeleteDialog")'),'delete confirmation closes');
  assert.equal(await evaluate('state.notes.some(n=>n.id==="qa-reading-delete-note")'),false);assert.equal(await evaluate('!!document.querySelector('+JSON.stringify(tab('qa-reading-delete-note'))+')'),false);assert.equal(await evaluate('state.imports.some(i=>i.id==="qa-reading-pdf")'),true);assert.equal(await evaluate('document.querySelectorAll("dialog:modal").length'),0);
  assert.notEqual(await evaluate('$("#previewTitle").textContent'),'删除入口验收笔记');
 });
 await step('removed active/inactive records reconcile tabs and clear unavailable content',async()=>{
  await evaluate('openNote("qa-reading-note-a");openNote("qa-reading-note-b");state.notes=state.notes.filter(n=>n.id!=="qa-reading-note-a");renderAll()');assert.equal(await evaluate('!!document.querySelector('+JSON.stringify(tab('qa-reading-note-a'))+')'),false);assert.match(await evaluate('$("#previewTitle").textContent'),/第二篇笔记/);
  await evaluate('openImport("qa-reading-pdf",2)');await readyPdf(2);await evaluate('openNote("qa-reading-note-b");state.notes=state.notes.filter(n=>n.id!=="qa-reading-note-b");renderAll()');await readyPdf(2);assert.equal(await evaluate('$("#readingTabs").querySelectorAll("[role=tab]").length'),1);
  await evaluate('state.imports[0].archived=true;renderAll()');assert.equal(await evaluate('$("#readingPane").hidden&&$("#readingToggle").hidden'),true);assert.equal(await evaluate('$("#previewVisual").children.length'),0);
 });
 await step('original PDF bytes are unchanged; no model, account, external request or renderer error',async()=>{
  assert.deepEqual((await request('/__files/qa-reading-pdf')).body,original);assert.deepEqual(fs.readFileSync(path.join(STORE,'files','qa-reading-pdf')),original);assert.deepEqual(forbidden,[]);assert.deepEqual(errors,[]);
 });
 console.log(JSON.stringify({passed:passed.length,failures,qaStore:TEMP,screenshots:'design/qa-reading-*.png',modelCalls:0},null,2));assert.deepEqual(failures,[]);
}
function finish(code){clearTimeout(watchdog);win?.destroy();server?.kill('SIGTERM');code?app.exit(code):app.quit();}
run().then(()=>finish(0)).catch(error=>{console.error(error);console.error('QA store retained:',TEMP);finish(1);});

