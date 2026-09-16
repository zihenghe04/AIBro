/* Isolated end-to-end cloud settings QA. Invoke with Electron, not node.
   Two local workspaces and a temporary self-hosted cloud use ports 18894-18896.
   No real accounts, model calls, external websites, or persistent keychain entries. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aw-cloud-smoke-')),PASSWORD=crypto.randomUUID()+crypto.randomUUID();
const CLOUD='http://127.0.0.1:18896',ORIGINS=['http://127.0.0.1:18894','http://127.0.0.1:18895'],children=[],windows=[];
fs.mkdirSync(path.join(TEMP,'profile'));app.setPath('userData',path.join(TEMP,'profile'));
const CLOUD_PYTHON=process.env.CLOUD_PYTHON||(fs.existsSync('/opt/homebrew/bin/python3.12')?'/opt/homebrew/bin/python3.12':'python3');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const request=(base,route)=>new Promise((resolve,reject)=>{const req=http.get(base+route,response=>{const data=[];response.on('data',chunk=>data.push(chunk));response.on('end',()=>{try{resolve({status:response.statusCode,data:JSON.parse(Buffer.concat(data))});}catch(error){reject(error);}});});req.setTimeout(5000,()=>req.destroy(new Error('HTTP timeout')));req.on('error',reject);});
async function until(check,label,timeout=20000){const start=Date.now();while(Date.now()-start<timeout){if(await check())return;await wait(150);}throw Error('Timed out: '+label);}
function launch(args,env,name){const log=fs.openSync(path.join(TEMP,name+'.log'),'a');const child=spawn(name==='cloud'?CLOUD_PYTHON:process.env.PYTHON||'python3',args,{cwd:ROOT,env:{...process.env,PYTHON_KEYRING_BACKEND:'keyring.backends.null.Keyring',...env},stdio:['ignore',log,log]});children.push(child);return child;}
async function run(){
  for(const port of [18894,18895,18896])await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',()=>reject(Error(`Port ${port} is occupied; refusing to reuse another service.`)));probe.listen(port,'127.0.0.1',()=>probe.close(resolve));});
  const cloudData=path.join(TEMP,'cloud');
  const initialized=spawnSync(CLOUD_PYTHON,[path.join(ROOT,'cloud_server.py'),'--data-dir',cloudData,'init','--username','qa-researcher','--password-stdin'],{input:PASSWORD+'\n',encoding:'utf8'});assert.equal(initialized.status,0,'initialize isolated cloud account');
  launch([path.join(ROOT,'cloud_server.py'),'--data-dir',cloudData,'serve','--host','127.0.0.1','--port','18896'],{},'cloud');
  for(let i=0;i<2;i++)launch([path.join(ROOT,'server.py')],{AI_WORKSTATION_PORT:String(18894+i),AI_WORKSTATION_DATA_DIR:path.join(TEMP,'workspace-'+i)},'workspace-'+i);
  await until(async()=>{try{return(await request(CLOUD,'/v1/health')).status===200;}catch{return false;}},'cloud health');
  for(const origin of ORIGINS)await until(async()=>{try{return(await request(origin,'/__health')).status===200;}catch{return false;}},'workspace health');
  assert.equal((await request(ORIGINS[0],'/__cloud/status')).status,200,'local cloud API integrated');
  await app.whenReady();const forbidden=[],errors=[];
  for(let i=0;i<2;i++){
    const win=new BrowserWindow({show:false,width:1440,height:960,webPreferences:{sandbox:true,backgroundThrottling:false,partition:'cloud-qa-'+i}});windows.push(win);
    win.webContents.session.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,done)=>{const url=new URL(details.url);const blocked=/^https?:$/.test(url.protocol)&&(url.origin!==ORIGINS[i]||url.pathname.startsWith('/__proxy')||url.pathname==='/__codex/respond'||url.pathname.startsWith('/__auth/'));if(blocked)forbidden.push(url.pathname);done({cancel:blocked});});
    win.webContents.on('console-message',(event)=>{if(event.level==='error')errors.push(event.message);});
    await win.loadURL(ORIGINS[i]);
  }
  const evaluate=(i,code)=>windows[i].webContents.executeJavaScript(code);
  const click=async(i,selector)=>{const point=await evaluate(i,`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(!r.width||!r.height||e.disabled)throw Error('Unavailable '+${JSON.stringify(selector)});return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);windows[i].webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});windows[i].webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});await wait(100);};
  const clickText=async(i,selector,content)=>{const target=await evaluate(i,`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent===${JSON.stringify(content)});if(!b)throw Error('Missing text target');b.id='qa-cloud-target';return '#qa-cloud-target'})()`);await click(i,target);};
  const flush=async i=>{assert.notEqual(await evaluate(i,'flushWorkspace()'),false);await until(()=>evaluate(i,'!serverSaveInFlight&&!serverSaveQueued&&!state._pendingLocalSave'),'local flush');assert.equal(await evaluate(i,'serverConflict'),false);};
  const cloudStatus=async i=>(await request(ORIGINS[i],'/__cloud/status')).data;
  const refresh=async i=>{await evaluate(i,'CloudSyncUI.refresh()');await wait(50);};
  const quiescent=async(i,after=0)=>{await until(async()=>{const s=await cloudStatus(i);return !s.syncing&&s.pending===0&&s.lastSyncAt>after&&!s.error;},'cloud upload/pull',30000);await refresh(i);};
  const syncComplete=async i=>{const before=Number((await cloudStatus(i)).lastSyncAt||0);await click(i,'#cloudSyncNow');await quiescent(i,before);};
  for(let i=0;i<2;i++){await until(()=>evaluate(i,'storageHydrated'),'hydration');await click(i,'[data-view="settings"]');await until(()=>evaluate(i,"!!document.querySelector('#cloudConnect')"),'cloud card');}
  await evaluate(0,`(()=>{const t=Date.now();state.projects.push({id:'cloud_qa_project',name:'云同步验收项目',workspace:'科研',createdAt:t});state.notes.push({id:'cloud_qa_note',title:'跨设备论文笔记',content:'共同的初始版本',projectId:'cloud_qa_project',workspace:'科研',userEdited:true,createdAt:t,updatedAt:t});normalizeStateShape(state);save();renderAll()})()`);await flush(0);
  const connect=async i=>{
    await evaluate(i,`document.querySelector('#cloudServerUrl').value=${JSON.stringify(CLOUD)};document.querySelector('#cloudUsername').value='qa-researcher';document.querySelector('#cloudPassword').value=${JSON.stringify(PASSWORD)};document.querySelector('#cloudDeviceName').value='QA 设备 ${i===0?'A':'B'}'`);
    assert.equal(await evaluate(i,"document.querySelector('#cloudConnect').disabled"),true,'merge consent is required');
    await click(i,'#cloudMergeConfirmed');await click(i,'#cloudConnect');await until(async()=>(await cloudStatus(i)).connected,'connect');await quiescent(i);
    assert.equal(await evaluate(i,"document.querySelector('#cloudPassword').value"),'');
    assert.equal(await evaluate(i,`Object.values(localStorage).some(value=>String(value).includes(${JSON.stringify(PASSWORD)}))`),false,'password never persisted in localStorage');
    const status=await cloudStatus(i);assert.equal(JSON.stringify(status).includes(PASSWORD),false);assert.equal(Object.hasOwn(status,'accessToken'),false);
    await click(i,'#cloudAutoSync');await until(async()=>(await cloudStatus(i)).autoSync===false,'pause automatic sync');
  };
  await connect(0);await connect(1);await until(async()=>{await refresh(1);return evaluate(1,"state.notes.some(n=>n.id==='cloud_qa_note')");},'remote note materialized');
  assert.equal(await evaluate(1,"state.notes.find(n=>n.id==='cloud_qa_note').content"),'共同的初始版本');console.log('PASS explicit merge, two-device initial sync, credentials remain backend-only');
  await evaluate(0,`(()=>{state.notes.push({id:'cloud_qa_context_note',title:'同步中的新资料',content:'云端新增资料',workspace:'科研',projectId:'cloud_qa_project',createdAt:Date.now(),updatedAt:Date.now()});normalizeStateShape(state);save();renderAll()})()`);await flush(0);await syncComplete(0);
  await click(1,'button[data-view="agent"]');await click(1,'#agentInput');await windows[1].webContents.insertText('正在输入且尚未发送的研究想法');
  const draftGuard=await evaluate(1,`(async()=>({dirty:state._pendingLocalSave,timer:draftSaveTimer!==null,applied:await applyCloudRevision(Number(state._revision||0)+1),draft:currentConversation().draft}))()`);
  assert.deepEqual(draftGuard,{dirty:true,timer:true,applied:false,draft:'正在输入且尚未发送的研究想法'},'input is guarded before debounce save');
  await until(()=>evaluate(1,'draftSaveTimer===null'),'draft debounce');await flush(1);
  const beforeDraftPull=Number((await cloudStatus(1)).lastSyncAt||0);
  await evaluate(1,`fetch('/__cloud/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>{if(!r.ok)throw Error('Background sync failed')})`);await quiescent(1,beforeDraftPull);
  assert.equal(await evaluate(1,"document.querySelector('#agentInput').value"),'正在输入且尚未发送的研究想法');assert.equal(await evaluate(1,"currentConversation().draft"),'正在输入且尚未发送的研究想法');
  assert.equal(await evaluate(1,"state.notes.some(n=>n.id==='cloud_qa_context_note')"),false,'incoming state is deferred while composing');
  await click(1,'button[data-view="settings"]');await until(async()=>{await refresh(1);return evaluate(1,"state.notes.some(n=>n.id==='cloud_qa_context_note')");},'deferred cloud note appears after navigation save');
  await click(1,'button[data-view="agent"]');assert.equal(await evaluate(1,"document.querySelector('#agentInput').value"),'正在输入且尚未发送的研究想法');
  await evaluate(1,"document.querySelector('#agentInput').value='';document.querySelector('#agentInput').dispatchEvent(new Event('input',{bubbles:true}))");await until(()=>evaluate(1,'draftSaveTimer===null'),'clear test draft');await flush(1);await click(1,'button[data-view="settings"]');
  console.log('PASS immediate input dirty guard and deferred cloud update preserve the unsent composer draft');
  const edit=async(i,value)=>{await evaluate(i,`(()=>{const n=state.notes.find(n=>n.id==='cloud_qa_note');n.content=${JSON.stringify(value)};n.updatedAt=Date.now();save();renderAll()})()`);await flush(i);};
  await edit(0,'A 的人工修订');await edit(1,'B 的离线补充');
  assert.ok((await cloudStatus(0)).pending>0);assert.ok((await cloudStatus(1)).pending>0);
  await refresh(0);await syncComplete(0);await refresh(1);await click(1,'#cloudSyncNow');
  await until(async()=>(await cloudStatus(1)).conflicts>0,'version conflict');await refresh(1);await click(1,'#cloudConflicts');
  await until(()=>evaluate(1,"document.querySelectorAll('.cloud-sync-versions pre').length>=2"),'both conflict versions');
  const versions=await evaluate(1,"[...document.querySelectorAll('.cloud-sync-versions pre')].map(e=>e.textContent).join(' | ')");assert.match(versions,/A 的人工修订/);assert.match(versions,/B 的离线补充/);
  for(const[width,theme]of[[1440,'light'],[650,'dark']]){windows[1].setSize(width,800);await evaluate(1,`state.ui.theme=${JSON.stringify(theme)};applyUiPreferences()`);await wait(350);await evaluate(1,"document.getAnimations().forEach(animation=>{try{animation.finish()}catch(_){}})");const fit=await evaluate(1,"(()=>{const d=document.querySelector('#cloudSyncDialog');return d.scrollWidth<=d.clientWidth&&d.getBoundingClientRect().right<=innerWidth})()");assert.equal(fit,true);fs.writeFileSync(path.join(ROOT,'design',`qa-cloud-conflict-${theme}.png`),(await windows[1].webContents.capturePage()).toPNG());}
  await clickText(1,'.cloud-sync-conflict-actions button','使用云端');await until(async()=>(await cloudStatus(1)).conflicts===0,'resolve remote');await refresh(1);assert.equal(await evaluate(1,"state.notes.find(n=>n.id==='cloud_qa_note').content"),'A 的人工修订');await evaluate(1,"document.querySelector('#cloudSyncDialog').close()");console.log('PASS conflict review and explicit remote choice');
  await edit(0,'A 的第二次修订');await edit(1,'B 选择保留的版本');await syncComplete(0);await click(1,'#cloudSyncNow');await until(async()=>(await cloudStatus(1)).conflicts>0,'second conflict');await refresh(1);await click(1,'#cloudConflicts');await until(()=>evaluate(1,"!!document.querySelector('.cloud-sync-conflict-actions button')"),'local conflict choice');await clickText(1,'.cloud-sync-conflict-actions button','保留本机');await until(async()=>(await cloudStatus(1)).conflicts===0,'resolve local');await evaluate(1,"document.querySelector('#cloudSyncDialog').close()");await refresh(1);await syncComplete(1);await syncComplete(0);assert.equal(await evaluate(0,"state.notes.find(n=>n.id==='cloud_qa_note').content"),'B 选择保留的版本');console.log('PASS explicit local choice syncs to the other device');
  await click(0,'#cloudDevices');await until(()=>evaluate(0,"document.querySelectorAll('.cloud-sync-device').length>=2"),'device list');const deviceB=await evaluate(0,"(()=>{const row=[...document.querySelectorAll('.cloud-sync-device')].find(r=>r.textContent.includes('QA 设备 B'));const b=row.querySelector('button');b.id='qa-revoke-b';return b.id})()");await click(0,'#'+deviceB);await clickText(0,'.cloud-sync-device button','确认撤销');await evaluate(0,"document.querySelector('#cloudSyncDialog').close()");await click(1,'#cloudSyncNow');await until(async()=>String((await cloudStatus(1)).errorCode||'').includes('401'),'revoked device rejected');await refresh(1);assert.equal(await evaluate(1,"document.querySelector('.cloud-sync-badge').textContent"),'需要重新登录');console.log('PASS confirmed device revocation requires login again');
  await click(0,'#cloudDisconnect');await until(async()=>(await cloudStatus(0)).connected===false,'disconnect');assert.equal(await evaluate(0,"state.notes.find(n=>n.id==='cloud_qa_note').content"),'B 选择保留的版本');await flush(0);await windows[0].loadURL(ORIGINS[0]);await until(()=>evaluate(0,'storageHydrated'),'reload disconnected');assert.equal(await evaluate(0,"state.notes.find(n=>n.id==='cloud_qa_note').content"),'B 选择保留的版本');
  // Best-effort removal of test-only sessions, including any optional keychain entry.
  await evaluate(1,"fetch('/__cloud/disconnect',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})");
  assert.deepEqual(forbidden,[]);assert.deepEqual(errors,[]);console.log('PASS disconnect/reload retains local knowledge; no external/model/account requests or renderer errors.');console.log('QA data:',TEMP);
}
function close(){windows.forEach(win=>{if(!win.isDestroyed())win.destroy();});children.forEach(child=>child.kill('SIGTERM'));}
run().then(()=>{close();app.quit();}).catch(error=>{console.error(error);console.error('Isolated QA artifacts:',TEMP);close();app.exit(1);});
