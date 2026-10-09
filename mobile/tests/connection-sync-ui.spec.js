import {test,expect} from '@playwright/test';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {connectionServer} from './fixtures/connection-server.js';
const require=createRequire(import.meta.url);
const {createConnectionSyncClient}=require('../../app/connection-sync-client.js');
const origin='https://sync.example.test',accountId='account_fixture',APP='http://127.0.0.1:8899';
const repo=fileURLToPath(new URL('../../',import.meta.url)).replace(/\/$/,'');
test('actual settings mounts the offline Kit connection UI and retains manual configuration',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(APP);await page.getByRole('button',{name:'设置',exact:true}).click();
 await expect(page.getByRole('heading',{name:'从 Mac 同步模型'})).toBeVisible();
 await expect(page.getByText('请在手机 App 中配对',{exact:true})).toBeVisible();
 await expect(page.locator('#model-form')).toBeVisible();
 await page.locator('#voice-input-settings input[name=autoSend]').uncheck();
 await page.getByRole('button',{name:'保存发送偏好',exact:true}).click();
 await expect(page.locator('#voice-input-settings input[name=autoSend]')).not.toBeChecked();
 await expect(page.locator('#connection-sync-root')).toHaveAttribute('data-halaska-root',/.+/);
 expect(errors).toEqual([]);
});
test('320px pairing, explicit trust, approval and purpose selection drive the actual model request',async({page})=>{
 test.setTimeout(45000);const cleanup=[];
 const cloud=await connectionServer({after:fn=>cleanup.push(fn)});
 try {
  let ownerEntry={revision:0,value:null},phoneEntry={revision:0,value:null};const nativeFence='A'.repeat(43);
  const owner=createConnectionSyncClient({cryptoProvider:webcrypto,currentSession:()=>({serverOrigin:origin,accountId,sessionId:'owner_session',generation:1}),
   atomicVault:{read:async()=>structuredClone(ownerEntry),compareAndSwap:async r=>{if(r.expectedRevision!==ownerEntry.revision)return false;ownerEntry={revision:ownerEntry.revision+1,value:structuredClone(r.value)};return true;}},transport:r=>cloud.transport(r)});
  const info=await owner.initializeOwner();
  await owner.saveProfiles(['chat','speech'].map(purpose=>({profileId:purpose,profile:{format:'aibro.connection-profile.v1',purpose,provider:'openai-compatible',authKind:'api-key',apiFormat:purpose==='chat'?'chat-completions':'audio-transcriptions',baseUrl:'https://provider.example.test/v1',model:'合成模型 · '+purpose,apiKey:'synthetic-ui-key'}})));
  await page.exposeFunction('qaRead',args=>{expect(args.sessionFence.nativeFence).toBe(nativeFence);return structuredClone(phoneEntry);});
  await page.exposeFunction('qaCAS',args=>{expect(args.sessionFence.nativeFence).toBe(nativeFence);if(args.expectedRevision!==phoneEntry.revision)return {swapped:false};phoneEntry={revision:phoneEntry.revision+1,value:structuredClone(args.value)};return {swapped:true};});
  await page.exposeFunction('qaHTTP',async({url,options})=>{
   if(url.endsWith('/v1/sync/capabilities'))return {status:200,body:{encryptedConnectionProfiles:{version:1,origin}}};
   expect(options.headers.Authorization).toBe('Bearer synthetic-cloud-token');
   return cloud.transport({operation:url.split('/').at(-1),session:{accountId,sessionId:'phone_session'},deviceId:options.headers['X-AIBro-Connection-Device'],deviceSecret:options.headers['X-AIBro-Connection-Secret'],payload:options.body});
  });
  await page.route('**/__connection_fixture',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><main><div id="connection-fixture"></div></main>'}));
  await page.setViewportSize({width:320,height:820});await page.emulateMedia({reducedMotion:'reduce'});await page.goto(APP+'/__connection_fixture');
  await page.evaluate(async({repo,origin,accountId,nativeFence})=>{
   await import('/src/style.css');await import('/@fs'+repo+'/app/connection-vault.js');await import('/@fs'+repo+'/app/connection-sync-client.js');
   const {Store,MemoryAdapter}=await import('/src/store.js');const {createConnectionManager}=await import('/src/connection-sync.js');const {mountConnectionSync}=await import('/src/connection-sync-ui.js');
   const store=await new Store(new MemoryAdapter()).load();await store.tx(s=>{s.binding={base:origin,accountID:accountId,deviceID:'phone_session'};});
   const raw=JSON.stringify({base:origin,accountId,sessionId:'phone_session',token:'synthetic-cloud-token'});
   let ui;const manager=createConnectionManager({store,vault:{get:async key=>{if(key!=='sync')throw Error('unexpected secret slot');return raw;}},bridge:{connectionSessionFence:async()=>({fence:nativeFence}),connectionVaultRead:window.qaRead,connectionVaultCompareAndSwap:window.qaCAS},http:async(url,options={})=>{const r=await window.qaHTTP({url,options});if(r.status!==200)throw Object.assign(Error('synthetic failure'),{status:r.status});return r.body;},native:true,cryptoAPI:globalThis.AIBroConnectionVault.createConnectionVault(),onChange:s=>ui?.update(s)});
   ui=await mountConnectionSync(document.querySelector('#connection-fixture'),manager);window.fixture={manager,store};await manager.refresh();
  },{repo,origin,accountId,nativeFence});
  await page.getByRole('button',{name:'连接这台手机',exact:true}).click();
  const phoneId=await page.locator('[data-device-fingerprint]').textContent();expect(phoneId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await page.getByLabel('Mac 配对信息',{exact:true}).fill(JSON.stringify({format:'aibro.connection-pairing.v1',serverOrigin:origin,accountId,publicJwk:info.publicJwk,fingerprint:info.deviceId}));
  await page.getByRole('button',{name:'读取并核对指纹',exact:true}).click();
  await expect(page.locator('[data-owner-preview]')).toHaveText(info.deviceId);
  await expect(page.getByRole('button',{name:'信任此 Mac',exact:true})).toBeDisabled();
  await page.getByLabel('我已核对，与 Mac 显示的整串指纹一致',{exact:true}).check();
  await page.getByRole('button',{name:'信任此 Mac',exact:true}).click();await expect(page.getByText('等待 Mac 批准',{exact:true})).toBeVisible();
  await owner.approveDevice({deviceId:phoneId,confirmedFingerprint:phoneId});await page.getByRole('button',{name:'检查更新',exact:true}).click();
  await expect(page.getByText('配置已同步',{exact:true})).toBeVisible();await expect(page.getByLabel('对话使用',{exact:true})).toHaveValue('chat');
  await page.getByLabel('语音识别使用',{exact:true}).selectOption('speech');
  await expect.poll(()=>page.evaluate(()=>window.fixture.store.state.settings.connectionProfiles.speech?.profileId)).toBe('speech');
  const result=await page.evaluate(async()=>{
   const {ask}=await import('/src/ai.js');let called=false;
   await ask({store:window.fixture.store,connectionSync:window.fixture.manager,vault:{get:()=>{throw Error('legacy vault was read');}},prompt:'解释这段合成资料',http:async(url,options)=>{called=url==='https://provider.example.test/v1/chat/completions'&&options.headers.Authorization==='Bearer synthetic-ui-key';return {choices:[{message:{content:'合成回答'},finish_reason:'stop'}]};}});
   return {called,leak:JSON.stringify(window.fixture.store.state).includes('synthetic-ui-key'),overflow:document.documentElement.scrollWidth>innerWidth,small:Array.from(document.querySelectorAll('.connection-sync button,.connection-sync select')).filter(e=>e.getBoundingClientRect().height>0&&e.getBoundingClientRect().height<43).length};
  });
  expect(result).toEqual({called:true,leak:false,overflow:false,small:0});
  await mkdir('build/connection-ui-048',{recursive:true});
  await page.screenshot({path:'build/connection-ui-048/paired-light-320.png',fullPage:true});
  await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});await page.screenshot({path:'build/connection-ui-048/paired-dark-320.png',fullPage:true});
 } finally {for(const fn of cleanup)await fn();}
});
