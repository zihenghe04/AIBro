import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createNativeConnectionSync } from '../src/connection-sync-native.js';

async function fixture({metadata = true} = {}) {
  const credential = {base:'https://sync.example.test',token:'synthetic-cloud-token', ...(metadata ? {accountId:'synthetic_account',sessionId:'synthetic_session'} : {})};
  const state = {binding:{base:credential.base,accountID:'synthetic_account',deviceID:'synthetic_session'}};
  let raw = JSON.stringify(credential), liveFence = 'A'.repeat(43), wiring;
  const requests = [], nativeCalls = [];
  const bridge = {
    connectionSessionFence: async args => {
      assert.match(args.expectedSyncSha256, /^[a-f0-9]{64}$/);
      const actual = Buffer.from(await webcrypto.subtle.digest('SHA-256', Buffer.from(raw))).toString('hex');
      if (actual !== args.expectedSyncSha256) throw Error('synthetic changed credential');
      return {fence: liveFence};
    },
    connectionVaultRead: async args => { nativeCalls.push(args); return {revision:0,value:null}; },
    connectionVaultCompareAndSwap: async args => {nativeCalls.push(args); return {swapped:args.sessionFence.nativeFence === liveFence};},
  };
  const options = {native:true,store:{state,tail:Promise.resolve()},vault:{get:async()=>raw},bridge,cryptoProvider:webcrypto,
    http:async(url,options)=>{requests.push({url,options});return {ok:true};},
    createClient: hooks => {wiring = hooks;return {};}};
  const api = metadata ? await createNativeConnectionSync(options) : null;
  return {api,options,state,requests,nativeCalls, wiring:()=>wiring,
    replace: () => raw = JSON.stringify({...credential,token:'another-synthetic-token'}),
    aba: () => liveFence = 'B'.repeat(43),liveFence:()=>liveFence};
}
const request = f => ({operation:'status',session:f.wiring().currentSession(),deviceId:'C'.repeat(43),deviceSecret:'D'.repeat(43),payload:{}});
test('native adapter sends exact captured cloud+device authentication only to the bound route',async()=>{
  const f=await fixture();await f.wiring().transport(request(f));
  assert.equal(f.requests.length,1);const {url,options}=f.requests[0];
  assert.equal(url,'https://sync.example.test/v1/connections/status');assert.deepEqual(options.body,{});
  assert.equal(options.headers.Authorization,'Bearer synthetic-cloud-token');
  assert.equal(options.headers['X-AIBro-Connection-Secret'],'D'.repeat(43));
  assert.ok(!url.includes('synthetic-cloud-token'));
});
test('credential replacement, logout ABA and changed workspace identity stop before network',async()=>{
  for (const change of [f=>f.replace(),f=>f.aba(),f=>f.state.binding.accountID='other_account']) {
    const f=await fixture(), captured=request(f);change(f);
    await assert.rejects(f.wiring().transport(captured));assert.equal(f.requests.length,0);
  }
});
test('read and CAS preserve captured native fence; a newer fence is never acquired at commit',async()=>{
  const f=await fixture(),w=f.wiring(),sessionFence=w.currentSession();
  await w.atomicVault.read({serverOrigin:sessionFence.serverOrigin,accountId:sessionFence.accountId},{sessionFence});
  f.aba();assert.equal(await w.atomicVault.compareAndSwap({binding:{serverOrigin:sessionFence.serverOrigin,accountId:sessionFence.accountId},expectedRevision:0,value:{},sessionFence}),false);
  assert.equal(f.nativeCalls[0].sessionFence.nativeFence,'A'.repeat(43));assert.equal(f.nativeCalls[1].sessionFence.nativeFence,'A'.repeat(43));
});
test('old cloud session without authenticated identity metadata requires reconnect, never guesses account',async()=>{
  const f=await fixture({metadata:false});await assert.rejects(createNativeConnectionSync(f.options),/重新连接/);assert.equal(f.requests.length,0);
});
test('unknown route or foreign session cannot redirect device credentials',async()=>{
  const f=await fixture();await assert.rejects(f.wiring().transport({...request(f),operation:'../../other'}));
  await assert.rejects(f.wiring().transport({...request(f),session:{...request(f).session,serverOrigin:'https://other.example'}}));assert.equal(f.requests.length,0);
});
test('server errors expose status only; shared-client messages remain authoritative',async()=>{
  const f=await fixture();f.options.http=async()=>{throw Object.assign(Error('synthetic secret echoed by server'),{status:409});};
  await createNativeConnectionSync(f.options);const result=await f.wiring().transport(request(f));
  assert.deepEqual(result,{status:409,body:{}});
});
test('legacy capability endpoints remain unsupported without disrupting content sync',async()=>{
  for(const status of [404,405,501]){
    const f=await fixture();f.options.http=async()=>{throw Object.assign(Error('synthetic'),{status});};
    assert.equal(await (await createNativeConnectionSync(f.options)).capabilities(),false);
  }
});
test('capability auth failures produce fixed blocking codes without echoing response details',async()=>{
  for(const [status,code] of [[401,'AUTH'],[403,'FORBIDDEN']]){
    const f=await fixture();f.options.http=async()=>{throw Object.assign(Error('private server detail'),{status});};
    await assert.rejects((await createNativeConnectionSync(f.options)).capabilities(),error=>error.code===code&&!error.message.includes('private server detail'));
  }
});
