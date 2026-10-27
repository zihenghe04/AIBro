const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const B = require('../app/provider-balance.js');

const reply = (status, body) => ({ ok: status < 400, status, json: async () => { if (body === undefined) throw new Error('not json'); return body; } });

test('adapter detection by host, nothing for unknown hosts', () => {
  assert.equal(B.detect('https://api.deepseek.com/v1'), 'deepseek');
  assert.equal(B.detect('https://API.DeepSeek.com'), 'deepseek');
  assert.equal(B.detect('https://api.stepfun.ai/v1'), 'stepfun');
  assert.equal(B.detect('https://api.siliconflow.cn/v1'), 'siliconflow-cn');
  assert.equal(B.detect('https://api.siliconflow.com/v1'), 'siliconflow-en');
  assert.equal(B.detect('https://openrouter.ai/api/v1'), 'openrouter');
  assert.equal(B.detect('https://api.novita.ai/v3/openai'), 'novita');
  assert.equal(B.detect('https://relay.example.invalid/v1'), '');
  assert.equal(B.detect(''), '');
});

test('each provider response is parsed into plain numbers', () => {
  assert.deepEqual(B.parse('deepseek', { balance_infos: [{ currency: 'CNY', total_balance: '12.50' }, { currency: 'USD', total_balance: '0.00' }] }).items, [{ label: 'CNY', remaining: 12.5, unit: 'CNY' }]);
  assert.equal(B.parse('deepseek', { balance_infos: [{ currency: 'CNY', total_balance: '0' }, { currency: 'USD', total_balance: '0' }] }).items.length, 2, 'all-empty wallets are all kept');
  assert.equal(B.parse('deepseek', { balance_infos: [] }).ok, false);
  assert.deepEqual(B.parse('stepfun', { balance: 8.8 }).items[0], { label: 'StepFun', remaining: 8.8, unit: 'CNY' });
  assert.deepEqual(B.parse('siliconflow-cn', { data: { totalBalance: '3.2' } }).items[0], { label: 'SiliconFlow', remaining: 3.2, unit: 'CNY' });
  assert.equal(B.parse('siliconflow-en', { data: { totalBalance: 1 } }).items[0].unit, 'USD');
  assert.equal(B.parse('siliconflow-cn', { nope: 1 }).ok, false);
  assert.deepEqual(B.parse('openrouter', { data: { total_credits: 10, total_usage: '2.5' } }).items[0], { label: 'OpenRouter', remaining: 7.5, total: 10, used: 2.5, unit: 'USD' });
  assert.equal(B.parse('openrouter', { data: { total_credits: 'x' } }).ok, false);
  assert.equal(B.parse('novita', { availableBalance: '125000' }).items[0].remaining, 12.5);
  assert.equal(B.parse('novita', {}).ok, false);
  assert.equal(B.parse('deepseek', null).ok, false);
  assert.equal(B.parse('nope', {}).ok, false);
});

test('run: bearer key to the fixed provider endpoint only, with distinct failure states and no key in the result', async () => {
  const seen = [];
  const request = (status, body) => async (url, headers) => { seen.push({ url, headers }); return reply(status, body); };
  const ok = await B.run({ base: 'https://openrouter.ai/api/v1', token: 'test-secret-key', request: request(200, { data: { total_credits: 5, total_usage: 1 } }) });
  assert.deepEqual([ok.ok, ok.items[0].remaining], [true, 4]);
  assert.deepEqual([seen[0].url, seen[0].headers.Authorization], ['https://openrouter.ai/api/v1/credits', 'Bearer test-secret-key']);
  assert.ok(!JSON.stringify(ok).includes('test-secret-key'));
  assert.equal((await B.run({ base: 'https://api.deepseek.com', token: 'k', request: request(401, {}) })).state, 'auth');
  assert.equal((await B.run({ base: 'https://api.deepseek.com', token: 'k', request: request(500, {}) })).state, 'error');
  assert.equal((await B.run({ base: 'https://api.deepseek.com', token: 'k', request: request(200, undefined) })).ok, false);
  assert.equal((await B.run({ base: 'https://api.deepseek.com', token: 'k', request: async () => { throw new TypeError('offline'); } })).state, 'unreachable');
  assert.equal((await B.run({ base: 'https://api.deepseek.com', token: 'k', timeoutMs: 20, request: (url, headers, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' })))) })).state, 'timeout');
  seen.length = 0;
  assert.equal((await B.run({ base: 'https://relay.example.invalid/v1', token: 'k', request: request(200, {}) })).state, 'unsupported');
  assert.equal((await B.run({ base: 'https://api.deepseek.com', token: '', request: request(200, {}) })).state, 'auth');
  assert.equal(seen.length, 0, 'no request without an adapter or a key');
});

test('formatting and the notice header', () => {
  assert.equal(B.format({ remaining: 12.5, unit: 'CNY' }), '¥12.50');
  assert.equal(B.format({ remaining: 3, unit: 'USD' }), '$3.00');
  assert.equal(B.format({ remaining: 1234.5, unit: 'CNY' }), '¥1235');
  assert.equal(B.format({ remaining: 2, unit: 'EUR' }), '2.00 EUR');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'app', 'provider-balance.js'), 'utf8').slice(0, 600), /Copyright \(c\) 2025 Jason Young/);
});
