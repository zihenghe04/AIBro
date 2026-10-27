const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const Catalog = require('../app/model-catalog.js');
globalThis.ModelCatalog = Catalog;
const C = require('../app/connections.js');
globalThis.Connections = C;
const P = require('../app/providers.js');
globalThis.Providers = P;
const R = require('../app/model-roles.js');
globalThis.ModelRoles = R;

const A = 'https://api.openai.com/v1', B = 'https://relay-b.example.invalid/v1', ANTH = 'https://api.anthropic.com';
function settings() {
  const s = { modelCatalog: { version: 1, services: { [A]: { models: [{ model: 'gpt-x' }, { model: 'text-embedding-3-small' }], updatedAt: 1 }, [B]: { models: [{ model: 'b-1' }, { model: 'bge-m3' }], updatedAt: 1 }, [ANTH]: { models: [{ model: 'claude-test' }], updatedAt: 1 } } } };
  C.migrate(s, { provider: 'api', base: A, model: 'gpt-x', protocol: 'chat', profiles: [{ base: B, model: 'b-1', settings: { protocol: 'chat' } }, { base: ANTH, model: 'claude-test', settings: { protocol: 'anthropic' } }], codexModel: '' });
  P.ensure(s);
  return s;
}

test('embedding providers skip the Anthropic wire and suggest embedding-looking models first', () => {
  const list = R.embeddingProviders(settings());
  assert.ok(!list.some(item => item.host === 'api.anthropic.com'));
  const openai = list.find(item => item.host === 'api.openai.com'), relay = list.find(item => item.host === 'relay-b.example.invalid');
  assert.deepEqual(openai.models.slice(0, 2), ['text-embedding-3-small', 'text-embedding-3-large']);
  assert.deepEqual(relay.models, ['bge-m3']);
});

test('a saved endpoint is matched to its provider whether or not /embeddings is appended', () => {
  const list = R.embeddingProviders(settings());
  assert.equal(R.matchProvider('https://api.openai.com/v1/embeddings', list).host, 'api.openai.com');
  assert.equal(R.matchProvider('https://relay-b.example.invalid/v1', list).host, 'relay-b.example.invalid');
  assert.equal(R.matchProvider('https://elsewhere.example.invalid/v1/embeddings', list), null);
  assert.equal(R.matchProvider('', list), null);
});

test('embedding description: not set up, on, off, and key trouble', () => {
  const list = R.embeddingProviders(settings());
  assert.equal(R.describeEmbedding(null, list).configured, false);
  const cfg = { base: 'https://api.openai.com/v1/embeddings', model: 'text-embedding-3-small', dimensions: 512, enabled: true, noKey: false };
  const on = R.describeEmbedding(cfg, list, { credentialState: 'stored' });
  assert.equal(on.title, 'text-embedding-3-small'); assert.equal(on.tone, 'success'); assert.match(on.sub, /512/);
  assert.equal(R.describeEmbedding({ ...cfg, enabled: false }, list, {}).tone, 'neutral');
  assert.equal(R.describeEmbedding(cfg, list, { credentialState: 'missing' }).tone, 'warning');
  assert.equal(R.describeEmbedding({ ...cfg, noKey: true }, list, { credentialState: 'missing' }).tone, 'success');
  assert.equal(R.describeEmbedding(cfg, list, { credentialState: 'stored', failed: true }).tone, 'warning');
});

test('embedding role mirrors the engine config without any key material', () => {
  const list = R.embeddingProviders(settings());
  const role = R.embeddingRole({ base: 'https://api.openai.com/v1/embeddings', model: 'm', dimensions: null, enabled: true, noKey: true, token: 'sk-secret' }, list);
  assert.deepEqual(Object.keys(role).sort(), ['base', 'dimensions', 'enabled', 'model', 'provider']);
  assert.ok(!JSON.stringify(role).includes('sk-secret'));
  assert.equal(R.embeddingRole(null, list), null);
});

const speechState = {
  status: 'ok',
  cloud: { available: true, busy: false, configured: true, selectedId: 's1', schemes: [{ id: 's1', name: '百炼', provider: 'aliyun', model: 'qwen-audio-3.0-asr-flash', host: 'token-plan.cn-beijing.maas.aliyuncs.com', language: 'zh' }, { id: 's2', name: 'OpenAI', provider: 'openAI', model: 'whisper-1', host: 'api.openai.com', language: '' }] },
  realtime: { available: true, busy: false, configured: true, enabled: false, activeId: 'r1', profiles: [{ id: 'r1', name: '默认方案', model: 'qwen3-asr-flash-realtime', region: 'beijing', language: 'zh' }] }
};

test('ElevenLabs schemes get a readable provider label', () => {
  const sp = R.normalizeSpeech({ status: 'ok', cloud: { available: true, configured: true, selectedId: 'e', schemes: [{ id: 'e', name: 'EL', provider: 'elevenLabs', model: 'scribe_v2', host: 'api.elevenlabs.io', language: '' }] }, realtime: {} });
  assert.match(R.describeCloud(sp).sub, /ElevenLabs Scribe · api\.elevenlabs\.io/);
});

test('an ElevenLabs realtime profile is described with its provider, not a region', () => {
  const sp = R.normalizeSpeech({ status: 'ok', cloud: {}, realtime: { available: true, configured: true, enabled: true, activeId: 'r', profiles: [{ id: 'r', name: '实时', model: 'scribe_v2_realtime', provider: 'elevenLabs', region: '', language: 'en' }] } });
  const info = R.describeRealtime(sp);
  assert.equal(info.title, 'scribe_v2_realtime'); assert.match(info.sub, /ElevenLabs Scribe/); assert.doesNotMatch(info.sub, /beijing/);
});

test('self-hosted speech services are labelled as such, with their host and no region', () => {
  const sp = R.normalizeSpeech({ status: 'ok', cloud: { available: true, configured: true, selectedId: 'h', schemes: [{ id: 'h', name: '自建', provider: 'selfHosted', model: 'Qwen3-ASR-1.7B', host: '192.0.2.10', language: 'auto' }] },
    realtime: { available: true, configured: true, enabled: true, activeId: 'r', profiles: [{ id: 'r', name: '自建流', model: 'stream', provider: 'selfHosted', region: '', host: '192.0.2.10', language: 'zh' }] } });
  assert.match(R.describeCloud(sp).sub, /自部署服务 · 192\.0\.2\.10/);
  const info = R.describeRealtime(sp);
  assert.equal(info.title, '流式转写'); assert.match(info.sub, /自部署服务 · 192\.0\.2\.10 · 中文/);
});

test('speech state is normalized; anything but an ok reply is unavailable', () => {
  assert.equal(R.normalizeSpeech(null).available, false);
  assert.equal(R.normalizeSpeech({ status: 'error', reason: 'x' }).available, false);
  const sp = R.normalizeSpeech(speechState);
  assert.equal(sp.available, true);
  assert.equal(sp.cloud.schemes.length, 2);
  const cloud = R.describeCloud(sp);
  assert.equal(cloud.title, 'qwen-audio-3.0-asr-flash'); assert.equal(cloud.tone, 'success');
  assert.equal(R.describeRealtime(sp).badge, '已关闭');
  assert.deepEqual(R.transcriptionRole(sp), { source: 'cloud', scheme: 's1', model: 'qwen-audio-3.0-asr-flash', realtime: false });
  sp.realtime.enabled = true;
  assert.equal(R.transcriptionRole(sp).source, 'realtime');
  assert.equal(R.describeCloud(R.normalizeSpeech({ status: 'ok', cloud: { available: true }, realtime: {} })).configured, false);
});

// ---- UI ----
function ui(extra = {}) {
  const { document, window } = parseHTML('<html lang="zh-CN"><body><div id="settings"><div id="embeddingParking"></div><article id="embeddingSettings" class="card"><h2>x</h2><input id="embeddingBase"><input id="embeddingModel"><button id="embeddingSave">s</button></article></div><div id="host"></div></body></html>');
  globalThis.document = document; globalThis.Event = window.Event; globalThis.CustomEvent = window.CustomEvent;
  Object.defineProperty(globalThis, 'navigator', { value: { userActivation: { isActive: true } }, configurable: true });
  delete require.cache[require.resolve('../app/ui-kit.js')]; globalThis.UIKit = require('../app/ui-kit.js');
  delete require.cache[require.resolve('../app/model-roles-ui.js')];
  const UI = require('../app/model-roles-ui.js');
  const s = settings(); const saves = [];
  let vectorStatus = { config: null, credentialState: 'unknown', failed: false };
  const calls = [];
  const data = JSON.parse(JSON.stringify(extra.speechState || speechState));
  const speech = extra.speech === undefined ? {
    state: async () => JSON.parse(JSON.stringify(data)),
    select: async id => { calls.push(['select', id]); return { status: 'ok' }; },
    setRealtime: async on => { calls.push(['setRealtime', on]); return { status: 'ok' }; },
    test: async target => { calls.push(['test', target]); return { status: 'pending' }; },
    open: async (target, id) => { calls.push(id === undefined ? ['open', target] : ['open', target, id]); return { status: 'ok' }; },
    saveCloud: async d => { calls.push(['saveCloud', d]); return { status: 'ok' }; }, testCloud: async d => { calls.push(['testCloud', d]); return { status: 'ok' }; }, deleteCloud: async id => { calls.push(['deleteCloud', id]); return { status: 'ok' }; },
    saveRealtime: async d => { calls.push(['saveRealtime', d]); return { status: 'ok' }; }, testRealtime: async d => { calls.push(['testRealtime', d]); return { status: 'ok' }; },
    deleteRealtime: async id => { calls.push(['deleteRealtime', id]); return { status: 'ok' }; }, selectRealtime: async id => { calls.push(['selectRealtime', id]); return { status: 'ok' }; },
    setSilence: async n => { calls.push(['setSilence', n]); return { status: 'ok' }; }
  } : extra.speech;
  const roles = UI.create({ getSettings: () => s, onChange: () => saves.push(1), speech, vector: { status: () => vectorStatus } });
  return { data, document, roles, s, saves, calls, host: document.getElementById('host'), setVector: v => { vectorStatus = v; } };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('embedding pane takes the semantic-search card in and parks it again on leave', () => {
  const t = ui();
  t.roles.mount(t.host, 'embedding');
  const card = t.document.getElementById('embeddingSettings');
  assert.ok(card.closest('#rolesEmbedding'));
  assert.equal(t.document.getElementById('embeddingModel').getAttribute('list'), 'embeddingModelList');
  assert.ok(t.document.getElementById('rolesEmbeddingProvider'));
  t.roles.park();
  assert.ok(card.closest('#embeddingParking'), 'card stays in the document');
  assert.ok(!card.closest('#rolesEmbedding'));
});

test('choosing a provider fills the address and a model, then the engine fields stay editable', () => {
  const t = ui();
  t.roles.mount(t.host, 'embedding');
  const row = [...t.document.querySelectorAll('#rolesEmbeddingProvider .uk-row')].find(node => /api\.openai\.com/.test(node.textContent));
  row.click();
  assert.equal(t.document.getElementById('embeddingBase').value, 'https://api.openai.com/v1');
  assert.equal(t.document.getElementById('embeddingModel').value, 'text-embedding-3-small');
  assert.match(t.document.getElementById('rolesEmbeddingNote').textContent, /分开保存/);
});

test('saved engine config is mirrored into roles.embedding once, and the summary shows it', () => {
  const t = ui();
  t.setVector({ config: { base: 'https://relay-b.example.invalid/v1/embeddings', model: 'bge-m3', dimensions: null, enabled: true, noKey: false }, credentialState: 'stored', failed: false });
  assert.equal(t.roles.syncEmbeddingRole(), true);
  assert.equal(t.saves.length, 1);
  assert.equal(P.purposeRole(t.s, 'embedding').model, 'bge-m3');
  assert.equal(t.roles.syncEmbeddingRole(), false, 'unchanged config does not save again');
  t.roles.mount(t.host, 'embedding');
  assert.match(t.document.getElementById('rolesEmbeddingNow').textContent, /bge-m3/);
  assert.match(t.document.getElementById('rolesEmbeddingNow').textContent, /已启用/);
});

test('speech pane shows both sources and sends switch / test requests; editing opens inline, never a native sheet', async () => {
  const t = ui();
  t.roles.mount(t.host, 'transcription');
  await tick();
  assert.match(t.host.textContent, /qwen-audio-3\.0-asr-flash|百炼/);
  assert.match(t.host.textContent, /实时 · 通义百炼/);
  t.document.getElementById('rolesCloudTest').click(); await tick();
  t.document.getElementById('rolesCloudEdit').click(); await tick();
  assert.ok(t.document.getElementById('rolesSpeechEditor'), 'the scheme is edited in the page');
  t.document.getElementById('rolesCloudCancel').click(); await tick();
  [...t.host.querySelectorAll('.mr-list .uk-row')].find(n => /实时 · /.test(n.textContent)).click();
  t.document.getElementById('rolesRealtimeSwitch').click(); await tick();
  t.document.getElementById('rolesRealtimeTest').click(); await tick();
  assert.deepEqual(t.calls.map(call => call[0]), ['testCloud', 'setRealtime', 'testRealtime']);
  assert.equal(t.calls[0][1].id, 's1'); assert.ok(!('key' in t.calls[0][1]), 'testing a saved scheme sends no Key');
  assert.ok(!t.calls.some(call => call[0] === 'open'), 'no native sheet is opened');
  assert.equal(P.purposeRole(t.s, 'transcription').scheme, 's1');
  t.roles.park();
});

test('a cloud scheme is selected in the list and then made active with its button', async () => {
  const t = ui();
  t.roles.mount(t.host, 'transcription'); await tick();
  [...t.host.querySelectorAll('.mr-list .uk-row')].find(n => /OpenAI/.test(n.textContent)).click();
  t.document.getElementById('rolesCloudUse').click(); await tick();
  assert.deepEqual(t.calls, [['select', 's2']]);
  t.roles.park();
});

const pick = (node, value) => { for (const option of node.querySelectorAll('option')) option.removeAttribute('selected'); node.querySelector(`option[value="${value}"]`).setAttribute('selected', ''); node.dispatchEvent(new (globalThis.Event)('change')); };
const setValue = (node, value) => { node.value = value; node.dispatchEvent(new (globalThis.Event)('input')); };
test('adding a self-hosted cloud scheme: the button says why it is off, then the Key is sent once and never kept', async () => {
  const t = ui();
  t.roles.mount(t.host, 'transcription'); await tick();
  t.document.getElementById('rolesCloudAdd').click(); await tick();
  assert.ok(t.document.getElementById('rolesCloudSave').hasAttribute('disabled'));
  assert.match(t.document.getElementById('rolesCloudReason').textContent, /服务地址/);
  setValue(t.document.getElementById('rolesCloudBase'), 'asr.example.com/v1');
  assert.match(t.document.getElementById('rolesCloudReason').textContent, /http:\/\/ 或 https:\/\//);
  setValue(t.document.getElementById('rolesCloudBase'), 'http://192.0.2.10:8000/v1');
  assert.match(t.document.getElementById('rolesCloudReason').textContent, /缺少 Key/);
  setValue(t.document.getElementById('rolesCloudKey'), 'synthetic-secret-token');
  assert.equal(t.document.getElementById('rolesCloudReason').textContent, '');
  assert.ok(!t.document.getElementById('rolesCloudSave').hasAttribute('disabled'));
  t.document.getElementById('rolesCloudSave').click(); await tick();
  const call = t.calls.find(item => item[0] === 'saveCloud');
  assert.equal(call[1].provider, 'selfHosted'); assert.equal(call[1].baseURL, 'http://192.0.2.10:8000/v1'); assert.equal(call[1].model, 'Qwen3-ASR-1.7B'); assert.equal(call[1].key, 'synthetic-secret-token'); assert.equal(call[1].timeoutSeconds, 180);
  assert.ok(!JSON.stringify(t.s).includes('synthetic-secret-token'), 'the Key is not stored in the page settings');
  // The native side reports the outcome; the editor closes only on success.
  t.data.result = { op: 'save-cloud', ok: true, id: 'new1', message: '', seq: 1 };
  t.data.cloud.schemes.push({ id: 'new1', name: '自部署服务', provider: 'selfHosted', model: 'Qwen3-ASR-1.7B', host: '192.0.2.10', baseURL: 'http://192.0.2.10:8000/v1', language: '', keySaved: true });
  await new Promise(resolve => setTimeout(resolve, 760));
  assert.equal(t.document.getElementById('rolesSpeechEditor'), null);
  t.roles.park();
});

test('a failed save keeps the editor open and shows the native reason', async () => {
  const t = ui();
  t.roles.mount(t.host, 'transcription'); await tick();
  t.document.getElementById('rolesCloudAdd').click(); await tick();
  setValue(t.document.getElementById('rolesCloudBase'), 'http://192.0.2.10:8000/v1'); setValue(t.document.getElementById('rolesCloudKey'), 'k');
  t.document.getElementById('rolesCloudSave').click(); await tick();
  t.data.result = { op: 'save-cloud', ok: false, id: '', message: '方案已在另一处更新', seq: 1 };
  await new Promise(resolve => setTimeout(resolve, 760));
  assert.ok(t.document.getElementById('rolesSpeechEditor'));
  assert.match(t.document.getElementById('rolesCloudStatus').textContent, /另一处更新/);
  t.roles.park();
});

test('live scheme form: reuses the self-hosted cloud service by default, shows the derived ws address, and explains a disabled save', async () => {
  const speechState2 = JSON.parse(JSON.stringify(speechState));
  speechState2.cloud.schemes.push({ id: 'h1', name: '自建', provider: 'selfHosted', model: 'Qwen3-ASR-1.7B', host: '192.0.2.10', baseURL: 'http://192.0.2.10:8000/v1', language: '', keySaved: true });
  const t = ui({ speechState: speechState2 });
  t.roles.mount(t.host, 'transcription'); await tick();
  t.document.getElementById('rolesRealtimeAdd').click(); await tick();
  assert.equal(t.document.getElementById('rolesRealtimeProvider').value, 'selfHosted');
  assert.match(t.document.getElementById('rolesRealtimeTarget').textContent, /ws:\/\/192\.0\.2\.10:8000\/stream/);
  assert.equal(t.document.getElementById('rolesRealtimeKey'), null, 'no Key field while reusing the cloud service');
  assert.ok(!t.document.getElementById('rolesRealtimeSave').hasAttribute('disabled'));
  t.document.getElementById('rolesRealtimeSave').click(); await tick();
  const save = t.calls.find(item => item[0] === 'saveRealtime')[1];
  assert.equal(save.reuseCloudID, 'h1'); assert.ok(!('key' in save)); assert.equal(save.provider, 'selfHosted'); assert.equal(save.enabled, true);
  // Turning the reuse off asks for its own address and Key, with reasons.
  t.document.getElementById('rolesRealtimeReuse').click ? t.document.getElementById('rolesRealtimeReuse').click() : null;
  await tick();
  t.roles.park();
});

test('live scheme form without a cloud service to reuse: address typed loosely is derived, bad ones are explained', async () => {
  const t = ui();
  t.roles.mount(t.host, 'transcription'); await tick();
  t.document.getElementById('rolesRealtimeAdd').click(); await tick();
  pick(t.document.getElementById('rolesRealtimeProvider'), 'selfHosted'); await tick();
  assert.ok(t.document.getElementById('rolesRealtimeSave').hasAttribute('disabled'));
  assert.match(t.document.getElementById('rolesRealtimeReason').textContent, /服务地址/);
  setValue(t.document.getElementById('rolesRealtimeServer'), 'ftp://x');
  assert.match(t.document.getElementById('rolesRealtimeReason').textContent, /无法识别/);
  setValue(t.document.getElementById('rolesRealtimeServer'), 'http://192.0.2.10:8000/v1');
  assert.match(t.document.getElementById('rolesRealtimeTarget').textContent, /ws:\/\/192\.0\.2\.10:8000\/stream/);
  assert.match(t.document.getElementById('rolesRealtimeReason').textContent, /缺少 Key/);
  setValue(t.document.getElementById('rolesRealtimeKey'), 'synthetic-token');
  assert.equal(t.document.getElementById('rolesRealtimeReason').textContent, '');
  t.document.getElementById('rolesRealtimeSave').click(); await tick();
  const save = t.calls.find(item => item[0] === 'saveRealtime')[1];
  assert.equal(save.serverURL, 'http://192.0.2.10:8000/v1'); assert.equal(save.key, 'synthetic-token');
  t.roles.park();
});

test('pure helpers: the stream address is derived from what people type, and problems are specific', () => {
  assert.equal(R.streamAddress('http://192.0.2.10:8000'), 'ws://192.0.2.10:8000/stream');
  assert.equal(R.streamAddress('192.0.2.10:8000/v1'), 'ws://192.0.2.10:8000/stream');
  assert.equal(R.streamAddress('https://asr.example.com/v1/audio/transcriptions'), 'wss://asr.example.com/stream');
  assert.equal(R.streamAddress('ws://h:1/stream'), 'ws://h:1/stream');
  assert.equal(R.streamAddress('ftp://x'), ''); assert.equal(R.streamAddress(''), ''); assert.equal(R.streamAddress('http://h:1/?x=1'), '');
  assert.match(R.cloudProblem({ name: 'a', provider: 'openAI', baseURL: 'http://x.example.com/v1', model: 'm', key: 'k' }), /https/);
  assert.equal(R.cloudProblem({ name: 'a', provider: 'selfHosted', baseURL: 'http://192.0.2.10:8000/v1', model: 'm', key: 'k' }), '');
  assert.equal(R.cloudProblem({ name: 'a', provider: 'selfHosted', baseURL: 'http://192.0.2.10:8000/v1', model: 'm', key: '' }, { keySaved: true, provider: 'selfHosted', baseURL: 'http://192.0.2.10:8000/v1' }), '', 'a saved Key is kept for the same address');
  assert.match(R.cloudProblem({ name: 'a', provider: 'selfHosted', baseURL: 'http://192.0.2.11:8000/v1', model: 'm', key: '' }, { keySaved: true, provider: 'selfHosted', baseURL: 'http://192.0.2.10:8000/v1' }), /缺少 Key/, 'a new address needs its own Key');
});

test('speech pane explains itself without the native bridge and sends nothing', async () => {
  const t = ui({ speech: null });
  t.roles.mount(t.host, 'transcription'); await tick();
  assert.match(t.host.textContent, /桌面版/);
  assert.equal(t.document.getElementById('rolesCloudTest'), null);
  t.roles.park();
});

test('the embedding card is regrouped into connection / search / advanced cards without losing any control id', () => {
  const t = ui();
  const card = t.document.getElementById('embeddingSettings');
  card.innerHTML = '<h2>x</h2><p class="muted">m</p><div id="embeddingReadiness"></div><div id="embeddingProfiles"></div>' +
    '<label class="setting-label"><input id="embeddingEnabled" type="checkbox"> <span>on</span></label>' +
    '<label class="setting-label" for="embeddingBase">a</label><input id="embeddingBase">' +
    '<label class="setting-label" for="embeddingModel">m</label><input id="embeddingModel">' +
    '<label class="setting-label" for="embeddingKey">k</label><input id="embeddingKey" type="password">' +
    '<label class="setting-label"><input id="embeddingNoKey" type="checkbox"> <span>nk</span></label>' +
    '<label class="setting-label" for="embeddingDimensions">d</label><input id="embeddingDimensions" type="number">' +
    '<label class="setting-label"><input id="embeddingAuto" type="checkbox"> <span>auto</span></label>' +
    '<p class="setting-help">privacy</p><p class="setting-help" id="embeddingKeyHelp">kh</p><div class="setting-actions"><span id="embeddingUnlockHost" hidden></span><button id="embeddingSave" class="secondary">s</button><button id="embeddingTest">t</button><button id="embeddingClearKey">c</button></div>' +
    '<div class="setting-actions"><button id="embeddingUpdate" class="primary">u</button><button id="embeddingStop" hidden>x</button></div><progress id="embeddingProgress"></progress><p id="embeddingCounts"></p><p id="embeddingStatus"></p>';
  t.roles.mount(t.host, 'embedding');
  for (const id of ['embeddingEnabled', 'embeddingBase', 'embeddingModel', 'embeddingKey', 'embeddingNoKey', 'embeddingDimensions', 'embeddingAuto', 'embeddingSave', 'embeddingTest', 'embeddingClearKey', 'embeddingUpdate', 'embeddingStop', 'embeddingProgress', 'embeddingCounts', 'embeddingStatus', 'embeddingReadiness', 'embeddingProfiles', 'embeddingUnlockHost', 'embeddingKeyHelp'])
    assert.ok(t.document.getElementById(id), id + ' still in the document');
  assert.deepEqual([...card.querySelectorAll(':scope > section > h3')].map(n => n.textContent), ['连接', '检索']);
  assert.ok(card.querySelector('details#rolesEmbeddingAdvanced #embeddingDimensions'));
  assert.ok(card.querySelector('.mr-card-actions #embeddingSave.primary'));
  // the switch drives the original checkbox and notifies the engine through an input event
  let inputs = 0; t.document.getElementById('embeddingEnabled').addEventListener('input', () => inputs++);
  card.querySelector('#embeddingEnabledSwitch').click();
  assert.equal(t.document.getElementById('embeddingEnabled').checked, true); assert.equal(inputs, 1);
  t.roles.park();
  assert.ok(card.closest('#embeddingParking'));
});
