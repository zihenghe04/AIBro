import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, MemoryAdapter } from '../src/store.js';
import { ask } from '../src/ai.js';
import { saveModelSettings, canonicalModelBase } from '../src/model-credentials.js';

const A = 'https://provider-a.example/v1', B = 'https://provider-b.example/v1';
const OLD = 'synthetic-old-key', NEW = 'synthetic-new-key';
const envelope = raw => JSON.parse(raw.slice(raw.indexOf('\n') + 1));
const config = (base = A) => ({ base, model: 'synthetic-model', format: 'chat' });
async function fixture({ configured = true, key = OLD } = {}) {
  const adapter = new MemoryAdapter(), store = await new Store(adapter).load();
  if (configured) await store.tx(s => s.settings.model = config());
  let value = key, failVault = false, failDB = false, writes = 0;
  const adapterWrite = adapter.write.bind(adapter);
  adapter.write = async state => { if (failDB) { failDB = false; throw Error('synthetic database failure'); } return adapterWrite(state); };
  const vault = { get: async () => value, set: async (name, next) => {
    assert.equal(name, 'model'); if (failVault) { failVault = false; throw Error('synthetic vault failure'); } value = next; writes++;
  } };
  return { store, adapter, vault, raw: () => value, writes: () => writes,
    failVault: () => failVault = true, failDB: () => failDB = true,
    // The profile controller now calls this adapter directly; the removed
    // document-level submit branch must not be used as a test entry point.
    save: (base = A, key = '', extra = {}) => saveModelSettings(store, vault, { ...config(base), key, ...extra }) };
}
async function actualAsk(f, expectedBase, expectedKey) {
  const calls = [];
  const result = await ask({ store: f.store, vault: f.vault, prompt: '解释这段合成材料的含义', http: async (url, options) => {
    calls.push({ url, authorization: options.headers.Authorization });
    return { choices: [{ message: { content: '这是合成测试回答。' }, finish_reason: 'stop' }] };
  } });
  assert.equal(result.status, 'completed'); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, expectedBase + '/chat/completions');
  assert.equal(calls[0].authorization, 'Bearer ' + expectedKey);
}

test('actual model save rejects legacy A-to-B blank key without changing config or vault; actual ask stays on A', async () => {
  const f = await fixture(), before = structuredClone(f.store.state.settings.model);
  await assert.rejects(f.save(B), /匹配的已保存 Key/);
  assert.deepEqual(f.store.state.settings.model, before); assert.equal(f.raw(), OLD); assert.equal(f.writes(), 0);
  await actualAsk(f, A, OLD);
  assert.equal(envelope(f.raw()).entries[0].scope, A);
});
test('existing legacy connection still answers and migrates before any settings change', async () => {
  const f = await fixture(); await actualAsk(f, A, OLD);
  assert.equal(envelope(f.raw()).format, 'aibro.model-credentials.v1');
  await assert.rejects(f.save(B), /匹配的已保存 Key/);
});
test('canonical same base keeps its key; path changes need a new key', async () => {
  const f = await fixture();
  await f.save('https://PROVIDER-A.example:443/v1/');
  assert.equal(f.store.state.settings.model.base, A); assert.ok(f.store.state.settings.model.credentialRef);
  await actualAsk(f, A, OLD);
  await assert.rejects(f.save(A + '/other'), /匹配的已保存 Key/);
  assert.equal(canonicalModelBase('https://PROVIDER-A.example:443/v1/'), A);
});
test('explicit new key selects only the new scope through actual ask', async () => {
  const f = await fixture(); await f.save(B, NEW); await actualAsk(f, B, NEW);
  await assert.rejects(f.save(A), /匹配的已保存 Key/, 'retained old rollback entry is not another active profile');
});
test('native vault failure leaves active config/key unchanged', async () => {
  const f = await fixture(), before = structuredClone(f.store.state.settings.model);
  f.failVault(); await assert.rejects(f.save(B, NEW), /vault failure/);
  assert.deepEqual(f.store.state.settings.model, before); assert.equal(f.raw(), OLD); await actualAsk(f, A, OLD);
});
for (const newBase of [A, B]) test(`database failure preserves old effective key and restart settings for ${newBase === A ? 'same' : 'different'} base`, async () => {
  const f = await fixture(); await f.save();
  const before = structuredClone(f.store.state.settings.model);
  f.failDB(); await assert.rejects(f.save(newBase, NEW), /database failure/);
  assert.deepEqual(f.store.state.settings.model, before); await actualAsk(f, A, OLD);
  const restarted = await new Store(f.adapter).load(); assert.deepEqual(restarted.state.settings.model, before);
  await actualAsk({ ...f, store: restarted }, A, OLD);
});
test('first setup failed DB commit does not activate a candidate or lend its key on retry', async () => {
  const f = await fixture({ configured: false, key: null });
  f.failDB(); await assert.rejects(f.save(B, NEW), /database failure/);
  assert.equal(f.store.state.settings.model, undefined);
  await assert.rejects(f.save(B), /匹配的已保存 Key/);
  let calls = 0;
  await assert.rejects(ask({ store: f.store, vault: f.vault, prompt: '解释这段合成材料', http: async () => calls++ }), /连接模型/);
  assert.equal(calls, 0);
  await f.save(B, NEW); await actualAsk(f, B, NEW);
});
test('a mismatched scope or missing reference is rejected by actual ask before a request', async () => {
  const f = await fixture(); await f.save();
  await f.store.tx(s => s.settings.model.base = B);
  let calls = 0;
  await assert.rejects(ask({ store: f.store, vault: f.vault, prompt: '解释这段合成材料', http: async () => calls++ }), /匹配的已保存 Key/);
  assert.equal(calls, 0);
  await f.store.tx(s => { s.settings.model.base = A; s.settings.model.credentialRef = 'missing'; });
  await assert.rejects(ask({ store: f.store, vault: f.vault, prompt: '解释这段合成材料', http: async () => calls++ }), /匹配的已保存 Key/);
  assert.equal(calls, 0);
});
test('serialized real saves never drop active credentials and keep the model vault bounded', async () => {
  const f = await fixture();
  await Promise.all([f.save(B, NEW), f.save(A, 'synthetic-last-key')]);
  await actualAsk(f, A, 'synthetic-last-key');
  assert.ok(envelope(f.raw()).entries.length <= 2);
});
test('settings CAS rejects a concurrent configuration change rather than overwriting it', async () => {
  const f = await fixture(); await f.save();
  const original = f.vault.set; let once = true;
  f.vault.set = async (...args) => {
    await original(...args);
    if (once) { once = false; await f.store.tx(s => s.settings.model.model = 'concurrent-synthetic-model'); }
  };
  await assert.rejects(f.save(B, NEW), /保存期间变化/);
  assert.equal(f.store.state.settings.model.model, 'concurrent-synthetic-model');
  await actualAsk(f, A, OLD);
});

test('migrated envelope cannot be sent as a Bearer header by a legacy client', async () => {
  const f = await fixture(); await f.save();
  assert.throws(() => new Headers({ Authorization: 'Bearer ' + f.raw() }));
});
