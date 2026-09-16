import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabVault, browserRequest } from '../src/web-platform.js';
const storage = () => { const data = new Map(); return { getItem: k => data.get(k), setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) }; };
test('browser credentials survive tab reload and stay separate from demo data', async () => {
  const s = storage(), live = tabVault(s, 'live:'), demo = tabVault(s, 'demo:');
  await live.set('sync', 'token');
  assert.equal(await tabVault(s, 'live:').get('sync'), 'token');
  assert.equal(await demo.get('sync'), undefined);
  await live.remove('sync'); assert.equal(await live.get('sync'), undefined);
});
test('authenticated relay isolates upstream keys, sync and blobs use direct transport', async () => {
  const vault = tabVault(storage());
  let captured;
  const fetcher = async (url,opt) => { captured={url,...opt}; return new Response('{}'); };
  await browserRequest('https://iclass.ucas.edu.cn:8181/app/user/login.action', {method:'POST',body:'phone=demo&password=fixture'},vault,fetcher);
  assert.equal(captured.url,'/api/ucas');
  assert.equal(captured.headers.Authorization,undefined);
  assert.equal(captured.credentials,'omit');
  assert.equal(JSON.parse(captured.body).body,'phone=demo&password=fixture');
  await vault.set('sync', JSON.stringify({ base:'https://sync.example',token:'sync-token' }));
  await browserRequest('https://model.example/v1/responses',{method:'POST',headers:{Authorization:'Bearer model-key'},body:'{}'},vault,fetcher);
  assert.equal(captured.headers.Authorization,'Bearer sync-token');
  assert.equal(JSON.parse(captured.body).headers.Authorization,'Bearer model-key');
  await browserRequest('https://sync.example/v1/blobs/abc',{method:'PUT',body:new Uint8Array([1])},vault,fetcher);
  assert.equal(captured.url,'https://sync.example/v1/blobs/abc');
  assert.deepEqual(captured.body,new Uint8Array([1]));
});
