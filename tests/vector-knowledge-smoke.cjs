/* Synthetic provider + isolated Electron/IndexedDB + real loopback proxy. No private corpus. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),http=require('node:http'),net=require('node:net');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-vector-qa-'));app.setPath('userData',path.join(TEMP,'profile'));
let server,provider,win;const calls=[],wait=ms=>new Promise(r=>setTimeout(r,ms));const deadline=setTimeout(()=>finish(1),100000);
async function until(fn,label){for(let i=0;i<400;i++){if(await fn())return;await wait(50)}throw Error('Waiting for '+label)}
async function run(){
 provider=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;const b=JSON.parse(body);calls.push({body:b,auth:req.headers.authorization});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:b.input.map((_,index)=>({index,embedding:[1,0,0]}))}));});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+provider.address().port+'/v1';
 const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})});const origin='http://127.0.0.1:'+port;
 server=spawn('python3',[path.join(ROOT,'app/server.py')],{env:{...process.env,AI_WORKSTATION_DATA_DIR:path.join(TEMP,'store'),AI_WORKSTATION_PORT:String(port),AI_WORKSTATION_ASSET_DIR:path.join(ROOT,'app')},stdio:'ignore'});
 await until(async()=>{try{return(await fetch(origin+'/__health')).ok}catch{return false}},'server');await app.whenReady();win=new BrowserWindow({show:false,width:1200,height:1100,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 const forbidden=[];win.webContents.session.webRequest.onBeforeRequest({urls:['<all_urls>']},(d,done)=>{const u=new URL(d.url),block=['http:','https:'].includes(u.protocol)&&u.origin!==origin;if(block)forbidden.push(u.origin);done({cancel:block})});const ev=s=>win.webContents.executeJavaScript(s,true);
 await win.loadURL(origin);await until(()=>ev('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydrate');
 assert.equal(calls.length,0);
 await ev(`Object.assign(state,{projects:[],notes:Array.from({length:35},(_,i)=>({id:'synthetic-'+i,title:'Sample '+i,content:'automobile evidence '+i,workspace:'科研'})),papers:[],imports:[],tasks:[]});normalizeStateShape(state);save();showView('settings','设置');document.querySelectorAll('dialog[open]').forEach(x=>x.close());document.querySelector('#onboardingSkip')?.click();true`);
 await ev(`for(const [id,value] of Object.entries({embeddingBase:${JSON.stringify(base)},embeddingModel:'synthetic-model',embeddingKey:'synthetic-embedding-secret'})){const e=document.getElementById(id);e.value=value;e.dispatchEvent(new Event('input'));}document.getElementById('embeddingEnabled').checked=true;document.getElementById('embeddingTest').click();true`);
 await until(()=>ev(`document.getElementById('embeddingStatus').textContent.includes('连接成功')`),'connection');assert.equal(calls.length,1);assert.deepEqual(calls[0].body.input,['AI Bro embedding connection test']);
 await ev(`document.getElementById('embeddingSave').click();true`);await until(()=>ev(`!document.getElementById('embeddingUpdate').disabled`),'saved');assert.equal(await ev(`document.getElementById('embeddingKey').value`),'');assert.doesNotMatch(await ev(`localStorage.getItem('aibro-embedding-settings-v1')`),/secret/);
 await ev(`document.getElementById('embeddingUpdate').click();true`);await until(()=>ev(`document.getElementById('embeddingStatus').textContent==='向量索引已更新'`),'updated');assert.equal(calls.length,4);assert.ok(calls.every(c=>c.auth==='Bearer synthetic-embedding-secret'));
 await ev('VectorKnowledge.update();true');await until(()=>ev(`document.getElementById('embeddingStop').hidden`),'unchanged');assert.equal(calls.length,4);
 const result=await ev(`VectorKnowledge.retrieve(state,{workspace:'科研',query:'汽车'})`);assert.equal(result.coverage.strategy,'hybrid-rrf');assert.equal(result.entries.length,20);assert.equal(result.coverage.nextOffset,20);
 await ev(`state.notes[0].content='changed automobile';save();true`);await wait(2000);assert.equal(calls.length,5);
 await ev(`document.getElementById('embeddingAuto').checked=true;document.getElementById('embeddingAuto').dispatchEvent(new Event('input'));document.getElementById('embeddingSave').click();true`);await until(()=>calls.length===6,'automatic change');await until(()=>ev(`document.getElementById('embeddingStop').hidden`),'auto finished');assert.equal(calls[5].body.input.length,1);
 await ev(`document.getElementById('embeddingSettings').scrollIntoView();true`);await wait(200);fs.writeFileSync(path.join(TEMP,'settings.png'),(await win.webContents.capturePage()).toPNG());
 await ev('flushWorkspace();true');await until(()=>ev('!serverSaveInFlight&&!serverSaveQueued'),'save');await win.reload();await until(()=>ev('typeof storageHydrated!=="undefined"&&storageHydrated'),'reload');await ev('VectorKnowledge.refresh()');assert.match(await ev(`document.getElementById('embeddingCounts').textContent`),/35 \/ 35/);
 const fallback=await ev(`VectorKnowledge.retrieve(state,{workspace:'科研',query:'another uncached query'})`);assert.equal(fallback.coverage.semanticStatus,'unavailable');assert.equal(calls.length,6);assert.deepEqual(forbidden,[]);
 console.log(JSON.stringify({passed:true,checks:['synthetic connection through real proxy','separate credential','no persisted plaintext embedding key','35 passages incremental batches','unchanged skip','hybrid query and pagination','automatic saved edit only','IndexedDB survives reload','missing key falls back to BM25','no external requests'],screenshots:TEMP}));
}
function finish(code){clearTimeout(deadline);win?.destroy();server?.kill();provider?.close();app.exit(code)}run().then(()=>finish(0)).catch(e=>{console.error(e.stack);finish(1)});
