const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../app/usage-stats.js');
const data = require('../app/model-prices-data.js');

test('the price table is registered, has a copyright header and plausible numbers', () => {
  assert.ok(data.models.length > 100);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'app', 'model-prices-data.js'), 'utf8').slice(0, 500), /Copyright \(c\) 2025 Jason Young/);
  for (const model of data.models) assert.ok(model.input >= 0 && model.output >= 0 && model.id === model.id.toLowerCase(), model.id);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'docs', 'THIRD_PARTY.md'), 'utf8'), /price seed|price table|model-prices-data/);
});

test('price lookup: exact, provider-prefixed, longest-prefix and unknown', () => {
  const exact = S.priceFor('deepseek-chat');
  assert.ok(exact && exact.source === 'builtin');
  assert.deepEqual(S.priceFor('vendor/deepseek-chat'), exact);
  assert.ok(S.priceFor('deepseek-chat-20990101'), 'a dated suffix falls back to the longest known prefix');
  assert.equal(S.priceFor('totally-unknown-model-xyz'), null);
  assert.equal(S.priceFor(''), null);
});

test('user prices override the table and need both input and output', () => {
  const custom = { 'my-model': { input: 1, output: 2, cacheRead: 0.1 } };
  assert.deepEqual(S.priceFor('my-model', custom), { input: 1, output: 2, cacheRead: 0.1, source: 'custom' });
  assert.equal(S.priceFor('my-model', { 'my-model': { input: 1 } }), null);
  assert.equal(S.priceFor('deepseek-chat', { 'deepseek-chat': { input: 9, output: 9 } }).source, 'custom');
});

test('cost: cached input is billed at the cache price, the rest at the input price', () => {
  const overrides = { m: { input: 2, output: 10, cacheRead: 0.5 } };
  assert.equal(S.costOf({ model: 'm', input: 1_000_000, output: 100_000, cache_read: 400_000 }, overrides), 0.6 * 2 + 0.4 * 0.5 + 0.1 * 10);
  assert.equal(S.costOf({ model: 'm', input: 1_000_000, output: 0, cache_read: 9_000_000 }, overrides), 0.5, 'cache cannot exceed input');
  assert.equal(S.costOf({ model: 'unknown-zzz', input: 5, output: 5 }, overrides), null);
  assert.equal(S.costOf({ model: 'm', input: 1_000_000, output: 0 }, { m: { input: 2, output: 10 } }), 2);
});

test('totals: subscription rows are not charged, unknown models are listed instead of counted as zero', () => {
  const overrides = { paid: { input: 1, output: 1 } };
  const out = S.totals([
    { provider_kind: 'api', model: 'paid', requests: 3, input: 1_000_000, output: 1_000_000, cache_read: 0 },
    { provider_kind: 'api', model: 'mystery', requests: 2, input: 10, output: 10 },
    { provider_kind: 'account', model: 'paid', requests: 5, input: 9_000_000, output: 9_000_000 }], overrides);
  assert.deepEqual([out.cost, out.pricedRequests, out.unknownModels, out.subscriptionRequests], [2, 3, ['mystery'], 5]);
});

test('formatting', () => {
  assert.deepEqual([S.compact(0), S.compact(999), S.compact(1500), S.compact(59_500_000), S.compact(2_100_000_000)], ['0', '999', '1.50K', '59.5M', '2.1B']);
  assert.deepEqual([S.money(null), S.money(0), S.money(0.0012), S.money(0.11), S.money(12.345), S.money(250)], ['—', '$0.00', '$0.0012', '$0.11', '$12.35', '$250']);
  assert.deepEqual([S.latency(null), S.latency(735), S.latency(4000)], ['—', '735ms', '4.0s']);
  assert.deepEqual([S.percent(null), S.percent(0), S.percent(0.5), S.percent(1)], ['—', '0%', '50.0%', '100%']);
});
