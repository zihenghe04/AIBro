const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
globalThis.ModelCatalog = require('../app/model-catalog.js');
const C = globalThis.Connections = require('../app/connections.js');
const P = globalThis.Providers = require('../app/providers.js');
globalThis.ProviderLibrary = require('../app/provider-library.js');
globalThis.UsageStats = require('../app/usage-stats.js');
globalThis.UsageStatsUI = require('../app/usage-stats-ui.js');
const UI = require('../app/providers-ui.js');

const click = (document, node) => node.dispatchEvent(new document.defaultView.Event('click', { bubbles: true }));
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check) { for (let i = 0; i < 100; i += 1) { if (check()) return; await tick(); } throw new Error('timed out'); }

const A = 'api:https://a.example.invalid/v1';
const REPLY = { range: '7d', since: 0, retentionDays: 90,
  cards: { requests: 4, input: 3_000_000, output: 200_000, cacheRead: 1_000_000, cacheHitRate: 0.4, failed: 1 },
  byProvider: [{ provider_id: A, provider_kind: 'api', requests: 3, input: 2_000_000, output: 100_000, cache_read: 500_000 }, { provider_id: 'codex-cli', provider_kind: 'account', requests: 1, input: 1_000_000, output: 100_000, cache_read: 500_000 }],
  byModel: [{ provider_id: A, provider_kind: 'api', model: 'priced-m', requests: 2, input: 1_000_000, output: 100_000, cache_read: 0 }, { provider_id: A, provider_kind: 'api', model: 'mystery-m', requests: 1, input: 1000, output: 10, cache_read: 0 }, { provider_id: 'codex-cli', provider_kind: 'account', model: 'gpt-x', requests: 1, input: 1_000_000, output: 100_000, cache_read: 500_000 }],
  rows: [{ ts: 1_800_000_000, provider_id: A, provider_kind: 'api', model: 'priced-m', role: 'qa', input: 500_000, output: 50_000, cache_read: 0, latency_ms: 4000, status: 200, outcome: 'completed' },
    { ts: 1_799_999_000, provider_id: 'codex-cli', provider_kind: 'account', model: 'gpt-x', role: 'kernel', input: 0, output: 0, cache_read: null, latency_ms: 735, status: 402, outcome: 'failed' }] };

function setup() {
  const s = { modelPrices: { 'priced-m': { input: 1, output: 2 } } };
  C.migrate(s, { provider: 'api', base: 'https://a.example.invalid/v1', model: 'priced-m', protocol: 'chat', profiles: [] });
  P.ensure(s);
  const { document } = parseHTML('<html><body><article id="host"></article></body></html>');
  const calls = [], changes = [];
  const fetch = async (path, init) => { calls.push({ path, init }); return { ok: true, status: 200, json: async () => path.startsWith('/__usage/query') ? REPLY : { ok: true } }; };
  const ui = UI.create({ getSettings: () => s, onChange: info => { changes.push(info); }, codexSnapshot: async () => null, fetch, confirm: () => true });
  ui.mount(document.getElementById('host'));
  return { s, document, ui, calls, changes, host: document.getElementById('host') };
}

test('the usage tab shows four cards, subscription rows are not charged and missing prices are admitted', async () => {
  const env = setup();
  click(env.document, env.host.querySelector('#providerTab-stats'));
  await until(() => env.host.querySelector('.pu-cards'));
  assert.equal(env.calls[0].path, '/__usage/query?range=7d');
  const cards = [...env.host.querySelectorAll('.pu-card')].map(card => card.textContent);
  assert.match(cards[0], /请求4.*1 次未成功/);
  assert.match(cards[1], /\$1\.20.*订阅请求 1 次不计入/s, cards[1]);
  assert.match(cards[2], /Token3\.20M/);
  assert.match(cards[3], /40\.0%/);
  const rows = [...env.host.querySelectorAll('tbody tr')].map(row => row.textContent);
  assert.match(rows[0], /问答.*550\.0K.*\$0\.60.*4\.0s.*200/s, rows[0]);
  assert.match(rows[1], /内核.*订阅.*735ms.*402/s, rows[1]);
  assert.ok(env.host.querySelector('.pv-status[data-ok="0"]'));
});

test('range, tabs and the no-content promise', async () => {
  const env = setup();
  click(env.document, env.host.querySelector('#providerTab-stats'));
  await until(() => env.host.querySelector('.pu-cards'));
  click(env.document, env.host.querySelector('[data-range="24h"]'));
  await until(() => env.calls.some(call => call.path === '/__usage/query?range=24h'));
  click(env.document, env.host.querySelector('[data-tab="models"]'));
  assert.match(env.host.querySelector('tbody').textContent, /priced-m.*\$1\.20/s);
  assert.match(env.host.querySelector('tbody').textContent, /mystery-m.*—/s);
  click(env.document, env.host.querySelector('[data-tab="providers"]'));
  assert.match(env.host.textContent, /ChatGPT|codex/i);
  assert.match(env.host.textContent, /不保存提示词和回答/);
});

test('your own price wins and is stored with the settings; clearing and retention call the log', async () => {
  const env = setup();
  click(env.document, env.host.querySelector('#providerTab-stats'));
  await until(() => env.host.querySelector('.pu-cards'));
  const input = env.host.querySelector('input[data-model="mystery-m"][data-key="input"]'), output = env.host.querySelector('input[data-model="mystery-m"][data-key="output"]');
  input.value = '3'; output.value = '6';
  input.dispatchEvent(new env.document.defaultView.Event('change', { bubbles: true }));
  assert.deepEqual(env.s.modelPrices['mystery-m'], { input: 3, output: 6, cacheRead: null });
  assert.equal(env.changes.length >= 1, true);
  click(env.document, env.host.querySelector('#usageClear'));
  await until(() => env.calls.some(call => call.path === '/__usage/clear'));
  assert.equal(env.calls.find(call => call.path === '/__usage/clear').init.method, 'POST');
});
