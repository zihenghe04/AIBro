/* Isolated Electron acceptance: real PDF bytes/rendering; model transport is stubbed. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-recovery-qa-'));
app.setPath('userData',path.join(TEMP,'profile'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));let server,win;
const deadline=setTimeout(()=>finish(1),150000);
async function until(fn,label){for(let i=0;i<400;i++){if(await fn())return;await wait(50);}throw Error('Waiting for '+label);}
async function run(){
 const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
 const origin='http://127.0.0.1:'+port,store=path.join(TEMP,'store');fs.mkdirSync(store);
 const py=process.env.PYTHON||'python3';
 const made=spawnSync(py,['-c',"import fitz,sys; d=fitz.open(); p=d.new_page(width=2014,height=2896); p.insert_text((100,100),'Synthetic scanner export'); d.save(sys.argv[1])",path.join(TEMP,'synthetic.pdf')]);assert.equal(made.status,0,made.stderr.toString());
 const pdf=fs.readFileSync(path.join(TEMP,'synthetic.pdf')).toString('base64');
 server=spawn(py,[path.join(ROOT,'app/server.py')],{env:{...process.env,AI_WORKSTATION_DATA_DIR:store,AI_WORKSTATION_PORT:String(port),AI_WORKSTATION_ASSET_DIR:path.join(ROOT,'app')},stdio:'ignore'});
 await until(async()=>{try{return (await fetch(origin+'/__health')).ok}catch{return false}},'service');
 await app.whenReady();win=new BrowserWindow({show:false,width:1260,height:940,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 const forbidden=[];
 win.webContents.session.webRequest.onBeforeRequest({urls:['<all_urls>']},(d,done)=>{const u=new URL(d.url),blocked=['http:','https:'].includes(u.protocol)&&(u.origin!==origin||(/^\/__(proxy|codex|auth)/.test(u.pathname)||u.pathname==='/__cloud/connect'));if(blocked)forbidden.push(u.pathname);done({cancel:blocked});});
 const evaluate=code=>win.webContents.executeJavaScript(code,true);
 await win.loadURL(origin);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydration');
 await evaluate(`Object.assign(state,{projects:[],tasks:[],notes:[],papers:[],imports:[],attachments:[],links:[],agentRuns:[],trash:[],conversations:[{id:'qa',title:'Attachment recovery',workspace:'auto',permissionMode:'smart',modelConfig:{provider:'openai-auth',model:'synthetic-model',effort:'medium'},messages:[],attachments:[],draftAttachmentIds:[],draft:''}],currentConversationId:'qa'});normalizeStateShape(state);state.ui.theme='light';save();applyUiPreferences();showView('agent','持续对话');renderAll();ConversationModels.resolve=async config=>config;window.qaCalls=[];AgentTransport.requestPlan=async options=>{qaCalls.push(options.input);return JSON.stringify({workspace:'日常',message:'Synthetic model response: attachment received.',actions:[]})};document.querySelectorAll('dialog[open]').forEach(x=>x.close());document.querySelector('#onboardingSkip')?.click();true`);
 await evaluate(`(()=>{const d=new DataTransfer();d.items.add(new File([Uint8Array.from(atob('${pdf}'),c=>c.charCodeAt(0))],'Large synthetic.pdf',{type:'application/pdf'}));d.items.add(new File(['%PDF-1.7\\ninvalid'],'Broken synthetic.pdf',{type:'application/pdf'}));document.querySelector('#agent').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:d}));})()`);
 await until(()=>evaluate('state.imports.length===2&&!importMaterials.busy'),'drag upload');
 await evaluate(`sendMessage({goal:'Read these two sample attachments.'});true`);
 await until(()=>evaluate('state.agentRuns.length===1&&!sendMessage.busy'),'expected failure');
 assert.equal(await evaluate('state.agentRuns[0].status'),'failed');assert.equal(await evaluate('qaCalls.length'),0);
 const failed=await evaluate('state.conversations[0].messages.at(-1).id');
 await evaluate(`currentConversation().draft='Preserve my next question';$('#agentInput').value=currentConversation().draft;save();document.querySelector('[data-adjust-run]').click();true`);
 assert.equal(await evaluate("document.querySelectorAll('.retry-attachment-editor input').length"),2);
 await wait(250);
 fs.writeFileSync(path.join(TEMP,'recovery-light.png'),(await win.webContents.capturePage()).toPNG());
 await evaluate(`(()=>{const bad=state.imports.find(i=>i.name==='Broken synthetic.pdf');document.querySelector('.retry-attachment-editor input[value="'+bad.id+'"]').checked=false;document.querySelector('.retry-attachment-editor').requestSubmit();})()`);
 await until(()=>evaluate('state.agentRuns.length===2&&!sendMessage.busy'),'recovered retry');
 assert.equal(await evaluate('state.agentRuns.at(-1).status'),'completed');assert.equal(await evaluate('qaCalls.length'),1);
 assert.equal(await evaluate('currentConversation().draft'),'Preserve my next question');
 assert.equal(await evaluate('state.agentRuns.at(-1).attachmentIds.length'),1);
 assert.equal(await evaluate('state.imports.length'),2);
 await evaluate(`document.querySelector('[data-dismiss-failure="${failed}"]').click();flushWorkspace();true`);
 await until(()=>evaluate('!serverSaveInFlight&&!serverSaveQueued&&!state._pendingLocalSave'),'persistence');
 await win.reload();await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'reload');
 await until(()=>evaluate(`!!currentConversation().messages.find(x=>x.id==='${failed}')?.deletedAt`),'deleted reply persists');
 assert.equal(await evaluate(`!!document.querySelector('[data-message-id="${failed}"]')`),false);
 assert.equal(await evaluate('currentConversation().draft'),'Preserve my next question');
 assert.equal(await evaluate('state.imports.length'),2);assert.equal(await evaluate('currentConversation().messages.filter(x=>x.role==="user").length'),1);
 await evaluate(`state.ui.theme='dark';applyUiPreferences();renderAll();true`);
 fs.writeFileSync(path.join(TEMP,'recovery-dark.png'),(await win.webContents.capturePage()).toPNG());

 // A new supplementary turn must retain the failed task, not just its latest words.
 await evaluate(`state.conversations.push({id:'followup',title:'Supplemental files',workspace:'auto',permissionMode:'smart',modelConfig:{provider:'openai-auth',model:'synthetic-model'},messages:[],attachments:[],draftAttachmentIds:[],draft:''});openConversation('followup');window.qaCalls=[];ConversationModels.resolve=async config=>config;AgentTransport.requestPlan=async options=>{qaCalls.push(options.input);if(qaCalls.length===1)throw new Error('Synthetic temporary connection failure');return JSON.stringify({workspace:'日常',message:'Synthetic response',actions:[]})};true`);
 async function dropNames(names){await evaluate(`(()=>{const d=new DataTransfer();for(const name of ${JSON.stringify(names)})d.items.add(new File([Uint8Array.from(atob('${pdf}'),c=>c.charCodeAt(0))],name,{type:'application/pdf'}));$('#agent').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:d}));})()`);await until(()=>evaluate('!importMaterials.busy&&currentConversation().draftAttachmentIds.length==='+names.length),'supplemental upload');}
 await dropNames(['Original checklist.pdf','Original evidence.pdf']);
 await evaluate(`sendMessage({goal:'ORIGINAL REQUIREMENT: compare all submitted evidence against the complete checklist, identify gaps, then save one consolidated note.'});true`);
 await until(()=>evaluate('qaCalls.length===1&&!sendMessage.busy'),'temporary failure');
 const originalIds=await evaluate('currentConversation().messages[0].attachmentIds');
 await dropNames(['Supplement one.pdf','Supplement two.pdf','Supplement three.pdf']);
 await evaluate(`sendMessage({goal:'附加了'});true`);
 await until(()=>evaluate('qaCalls.length===2&&!sendMessage.busy'),'supplemented task');
 const continued=await evaluate('state.agentRuns.at(-1)');assert.equal(continued.status,'completed');assert.equal(continued.attachmentIds.length,5);
 for(const id of originalIds)assert.ok(continued.attachmentIds.includes(id));
 const modelInput=await evaluate('JSON.stringify(qaCalls.at(-1))');assert.match(modelInput,/ORIGINAL REQUIREMENT/);assert.match(modelInput,/identify gaps/);assert.match(modelInput,/Supplement three.pdf/);assert.match(modelInput,/Original evidence.pdf/);assert.doesNotMatch(modelInput,/Broken synthetic/);
 await evaluate('flushWorkspace();true');await until(()=>evaluate('!serverSaveInFlight&&!serverSaveQueued&&!state._pendingLocalSave'),'continuation persistence');
 assert.equal(continued.conversationContext.carriedAttachmentIds.length,2);
 assert.deepEqual(forbidden,[]);
 console.log(JSON.stringify({passed:true,checks:['real drag upload','oversized PDF rendered','corrupt attachment recoverable','retry excludes only selected attachment','draft preserved','failure deletion persists after reload','original files retained','supplemental turn sends 2 original plus 3 new files with the original goal','no external requests'],screenshots:TEMP}));
}
function finish(code){clearTimeout(deadline);win?.destroy();server?.kill();app.exit(code)}
run().then(()=>finish(0)).catch(e=>{console.error(e.stack);finish(1)});
