import test from 'node:test';
import assert from 'node:assert/strict';
import { Sync } from '../src/sync.js';
import { Store, MemoryAdapter } from '../src/store.js';

async function fixture(response) {
  const store = await new Store(new MemoryAdapter()).load();
  const writes = [];
  const sync = new Sync(store, async () => response, {set: async (name, value) => writes.push({name, value})}, {});
  let runs = 0; sync.run = async () => {runs++;};
  return {store, sync, writes, runs: () => runs};
}
const session = () => ({accessToken:'synthetic-token-only',account:{id:'synthetic_account',username:'synthetic'},device:{id:'synthetic_session'}});
test('actual sync login persists verified account/session metadata alongside its native token', async () => {
  const f = await fixture(session());
  await f.sync.login('https://sync.example.test', 'synthetic', 'synthetic-passphrase');
  assert.deepEqual(JSON.parse(f.writes[0].value), {base:'https://sync.example.test',token:'synthetic-token-only',accountId:'synthetic_account',sessionId:'synthetic_session'});
  assert.equal(f.store.state.binding.accountID, 'synthetic_account');
  assert.equal(f.store.state.binding.deviceID, 'synthetic_session');
  assert.equal(f.runs(), 1);
});
for (const [label, change] of [
  ['missing device', s => delete s.device], ['missing username', s => delete s.account.username],
  ['invalid identity', s => s.account.id = 'unsafe/id'], ['invalid token', s => s.accessToken = 'line\nbreak'],
]) test(`incomplete ${label} response cannot replace the native session or bind the workspace`, async () => {
  const s = session(); change(s); const f = await fixture(s);
  await assert.rejects(f.sync.login('https://sync.example.test', 'synthetic', 'synthetic-passphrase'), /登录响应不完整/);
  assert.equal(f.writes.length, 0); assert.equal(f.runs(), 0); assert.ok(!f.store.state.binding);
});
test('server-normalized Unicode username is accepted; account/session IDs provide the credential binding', async () => {
  const s=session();s.account.username='strasse';const f=await fixture(s);
  await f.sync.login('https://sync.example.test','Straße','synthetic-passphrase');
  assert.equal(f.store.state.binding.username,'strasse');assert.equal(f.writes.length,1);
});
test('logout invalidates local credentials before remote wait and cannot erase a newer login', async () => {
  const store = await new Store(new MemoryAdapter()).load();
  let value = JSON.stringify({base:'https://sync.example.test',token:'old-synthetic-token'}), release;
  const remote = new Promise(resolve => { release=resolve; });
  let started;
  const entered = new Promise(resolve => { started=resolve; });
  const sync = new Sync(store, async () => { assert.equal(value,null); started(); await remote; },
    {get:async()=>value, remove:async()=>{value=null;}}, {});
  const pending = sync.logout(); await entered;
  assert.equal(value,null); assert.equal(sync.status,'已断开，内容保留');
  value='new-synthetic-login'; release(); await pending;
  assert.equal(value,'new-synthetic-login');
});
test('failed remote logout keeps local session invalidated', async () => {
  const store = await new Store(new MemoryAdapter()).load(); let value=JSON.stringify({base:'https://sync.example.test',token:'synthetic'});
  const sync = new Sync(store, async()=>{throw Error('offline');}, {get:async()=>value,remove:async()=>{value=null;}}, {});
  await assert.rejects(sync.logout(),/offline/); assert.equal(value,null); assert.equal(sync.status,'已断开，内容保留');
});
