const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../app/provider-library.js');
const data = require('../app/provider-presets-data.js');

test('the preset table is large, categorised and free of promotion fields and referral links', () => {
  assert.ok(data.presets.length >= 100);
  const text = JSON.stringify(data.presets);
  assert.ok(!/isPartner|primePartner|partnerPromotion|aff=|track_id|invite|ccswitch/i.test(text));
  for (const preset of data.presets) {
    assert.match(preset.id, /^[a-z0-9一-龥-]+$/);
    assert.ok(['vendor', 'platform', 'cloud', 'local'].includes(preset.category), preset.id);
    assert.ok(['responses', 'chat', 'anthropic'].includes(preset.protocol), preset.id);
    assert.ok(/^https?:\/\//.test(preset.baseUrl) && !/[?#]/.test(preset.baseUrl), preset.id);
    assert.ok(!preset.websiteUrl || !/[?#]/.test(preset.websiteUrl), preset.id);
    assert.ok(!('key' in preset) && !JSON.stringify(preset).match(/sk-[A-Za-z0-9]{8}/), preset.id);
  }
  assert.equal(new Set(data.presets.map(preset => preset.id)).size, data.presets.length);
});

test('the data file keeps the original copyright notice and the table is registered as third-party', () => {
  const head = fs.readFileSync(path.join(__dirname, '..', 'app', 'provider-presets-data.js'), 'utf8').slice(0, 600);
  assert.match(head, /Copyright \(c\) 2025 Jason Young/);
  const notice = fs.readFileSync(path.join(__dirname, '..', 'docs', 'THIRD_PARTY.md'), 'utf8');
  assert.match(notice, /CC Switch/);
  assert.match(notice, /Copyright \(c\) 2025 Jason Young/);
});

test('rows: families collapse into one row, search covers names, hosts and aliases, nothing is weighted', () => {
  const kimi = L.rows({ query: 'kimi' });
  assert.equal(kimi.length, 1);
  assert.ok(kimi[0].versions.length >= 2);
  assert.ok(L.rows({ query: '智谱' }).some(row => /zhipu/i.test(row.name)));
  assert.ok(L.rows({ query: 'deepseek' }).some(row => row.name === 'DeepSeek'));
  assert.ok(L.rows({ query: 'api.deepseek.com' }).some(row => row.name === 'DeepSeek'));
  assert.deepEqual(L.rows({ query: 'zzzz-no-such-provider' }), []);
  const all = L.rows();
  assert.deepEqual(all.map(row => row.name), [...all.map(row => row.name)].sort((a, b) => a.localeCompare(b, 'en')));
  const counts = L.counts();
  assert.equal(counts.all, all.length);
  assert.equal(L.rows({ category: 'local' }).length, counts.local);
});

test('matchHost finds a preset by host and returns capability tags', () => {
  const hit = L.matchHost('api.deepseek.com');
  assert.equal(hit.preset, 'deepseek');
  assert.ok(Object.keys(hit.caps).length >= 1);
  assert.equal(L.matchHost('nope.example.invalid'), null);
  assert.equal(L.matchHost(''), null);
});

test('address recognition tidies endpoints, detects the protocol and refuses unsafe input', () => {
  const a = L.normalizeAddress('https://api.example.invalid/v1/chat/completions');
  assert.deepEqual([a.ok, a.base, a.protocol, a.source], [true, 'https://api.example.invalid/v1', 'chat', 'path']);
  assert.equal(L.normalizeAddress('https://x.example.invalid/v1/responses/').protocol, 'responses');
  assert.equal(L.normalizeAddress('https://api.anthropic.com/v1/messages').protocol, 'anthropic');
  assert.equal(L.normalizeAddress('https://api.anthropic.com').source, 'host');
  assert.equal(L.normalizeAddress('https://gw.example.invalid/api/anthropic').protocol, 'anthropic');
  assert.equal(L.normalizeAddress('relay.example.invalid/v1').base, 'https://relay.example.invalid/v1');
  assert.equal(L.normalizeAddress('relay.example.invalid/v1').protocol, 'auto');
  assert.equal(L.normalizeAddress('https://relay.example.invalid/v1/models').base, 'https://relay.example.invalid/v1');
  assert.equal(L.normalizeAddress('https://RELAY.example.invalid/V1?x=1#y').base, 'https://relay.example.invalid/V1');
  assert.equal(L.normalizeAddress('http://relay.example.invalid/v1').insecure, true);
  assert.equal(L.normalizeAddress('http://localhost:11434/v1').insecure, false);
  for (const bad of ['', '   ', 'ftp://x.example.invalid', 'https://user:pw@x.example.invalid', 'https://a b.example.invalid', 'javascript:alert(1)']) assert.equal(L.normalizeAddress(bad).ok, false, bad);
});
