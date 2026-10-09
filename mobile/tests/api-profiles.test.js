import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, MemoryAdapter } from '../src/store.js';
import { ask } from '../src/ai.js';
import { saveModelSettings, useModelProfile } from '../src/model-credentials.js';
import { saveSpeechSettings, useSpeechProfile, testSpeechSettings } from '../src/speech.js';
import { transcribeWithConnections } from '../src/connection-speech.js';
import { apiProfiles, activeApiProfile, deleteApiProfile } from '../src/api-profiles.js';
import { createApiProfileEditor } from '../src/api-profile-editor.js';
const A = 'https://a.example.test/v1', B = 'https://b.example.test/v1';
const chat = (base = A, key = 'synthetic-chat-a', extra = {}) => ({ base, key, model: 'synthetic-chat', format: 'chat', profileName: '对话甲', profileId: '', ...extra });
const speech = (base = A, key = 'synthetic-speech-a', extra = {}) => ({ base, key, model: 'synthetic-asr', provider: 'openai', language: '', profileName: '语音甲', profileId: '', ...extra });
async function fixture() {
  const adapter = new MemoryAdapter(), store = await new Store(adapter).load(), secrets = new Map(); let fail = false;
  const write = adapter.write.bind(adapter); adapter.write = async s => { if (fail) { fail = false; throw Error('synthetic DB failure'); } return write(s); };
  const vault = { get: async k => secrets.get(k) || null, set: async (k, v) => { secrets.set(k, v); } };
  return { store, adapter, vault, secrets, fail: () => { fail = true; } };
}
async function actualChat(f, base, key) {
  const requests = [];
  const result = await ask({ store: f.store, vault: f.vault, prompt: '解释合成材料', http: async (url, o) => {
    requests.push([url, o.headers.Authorization]); return { choices: [{ message: { content: '合成回答' }, finish_reason: 'stop' }] };
  } });
  assert.equal(result.status, 'completed'); assert.deepEqual(requests, [[base + '/chat/completions', 'Bearer ' + key]]);
}
async function actualSpeech(f, base, key) {
  let called = 0;
  const text = await transcribeWithConnections({ ...f, audio: { durationMs: 1000, data: btoa('synthetic-audio'), mimeType: 'audio/wav' }, http: async (url, o) => {
    called++; assert.equal(url, base + '/audio/transcriptions'); assert.equal(o.headers.Authorization, 'Bearer ' + key); return { text: '合成转写' };
  } }); assert.equal(called, 1); assert.equal(text, '合成转写');
}
test('independent named chat and speech schemes survive restart and drive actual request builders', async () => {
  const f = await fixture(); await saveModelSettings(f.store, f.vault, chat()); const ca = activeApiProfile(f.store.state.settings, 'chat');
  await saveModelSettings(f.store, f.vault, chat(B, 'synthetic-chat-b', { profileName: '对话乙' })); const cb = activeApiProfile(f.store.state.settings, 'chat');
  await saveSpeechSettings(f.store, f.vault, speech()); const sa = activeApiProfile(f.store.state.settings, 'speech');
  await saveSpeechSettings(f.store, f.vault, speech(B, 'synthetic-speech-b', { profileName: '语音乙' })); const sb = activeApiProfile(f.store.state.settings, 'speech');
  await actualChat(f, B, 'synthetic-chat-b'); await actualSpeech(f, B, 'synthetic-speech-b');
  f.store = await new Store(f.adapter).load(); await useModelProfile(f.store, f.vault, ca); await useSpeechProfile(f.store, f.vault, sa);
  await actualChat(f, A, 'synthetic-chat-a'); await actualSpeech(f, A, 'synthetic-speech-a');
  await useModelProfile(f.store, f.vault, cb); await useSpeechProfile(f.store, f.vault, sb);
  assert.equal(apiProfiles(f.store.state.settings, 'chat').length, 2); assert.equal(apiProfiles(f.store.state.settings, 'speech').length, 2);
  assert.ok(!JSON.stringify(f.store.state).includes('synthetic-chat-a')); assert.ok(!JSON.stringify(f.store.state).includes('synthetic-speech-b'));
});
test('legacy configurations migrate on first named save without losing their old keys', async () => {
  const f = await fixture(); await f.store.tx(s => { s.settings.model = { base: A, model: 'old', format: 'chat' }; s.settings.speech = { base: A, model: 'old-asr', provider: 'openai' }; });
  f.secrets.set('model', 'synthetic-old-chat'); f.secrets.set('speech', JSON.stringify({ scope: 'openai|' + A + '/audio/transcriptions', key: 'synthetic-old-speech' }));
  await saveModelSettings(f.store, f.vault, chat(B)); await saveSpeechSettings(f.store, f.vault, speech(B));
  await useModelProfile(f.store, f.vault, 'legacy-chat'); await useSpeechProfile(f.store, f.vault, 'legacy-speech');
  await actualChat(f, A, 'synthetic-old-chat'); await actualSpeech(f, A, 'synthetic-old-speech');
});
for (const purpose of ['chat', 'speech']) test(`${purpose}: blank key only belongs to edited scheme, including inactive and canonical endpoint`, async () => {
  const f = await fixture(), save = purpose === 'chat' ? saveModelSettings : saveSpeechSettings, values = purpose === 'chat' ? chat : speech;
  await save(f.store, f.vault, values()); const a = activeApiProfile(f.store.state.settings, purpose);
  await save(f.store, f.vault, values(B, 'synthetic-b')); const before = structuredClone(f.store.state.settings);
  await assert.rejects(save(f.store, f.vault, values(B, '', { profileId: a })), /Key/); assert.deepEqual(f.store.state.settings, before);
  await assert.rejects(save(f.store, f.vault, values(A, '')), /Key/, 'a new scheme cannot borrow an existing scheme key');
  await save(f.store, f.vault, values('https://A.example.test:443/v1/', '', { profileId: a }));
  if (purpose === 'chat') await actualChat(f, A, 'synthetic-chat-a'); else await actualSpeech(f, A, 'synthetic-speech-a');
});
for (const purpose of ['chat', 'speech']) test(`${purpose}: failed DB save preserves active and all other schemes through restart`, async () => {
  const f = await fixture(), save = purpose === 'chat' ? saveModelSettings : saveSpeechSettings, use = purpose === 'chat' ? useModelProfile : useSpeechProfile, values = purpose === 'chat' ? chat : speech;
  await save(f.store, f.vault, values()); const a = activeApiProfile(f.store.state.settings, purpose);
  await save(f.store, f.vault, values(B, 'synthetic-b')); const before = structuredClone(f.store.state.settings);
  f.fail(); await assert.rejects(save(f.store, f.vault, values(A, 'synthetic-uncommitted', { profileId: a })), /DB failure/);
  assert.deepEqual(f.store.state.settings, before); f.store = await new Store(f.adapter).load(); assert.deepEqual(f.store.state.settings, before);
  await use(f.store, f.vault, a);
  if (purpose === 'chat') await actualChat(f, A, 'synthetic-chat-a'); else await actualSpeech(f, A, 'synthetic-speech-a');
});
test('saving/using a local purpose preserves the other Mac choice and never rewrites synced vault data', async () => {
  const f = await fixture(); f.secrets.set('connections', 'synthetic-opaque-synced-bundle');
  await f.store.tx(s => s.settings.connectionProfiles = { chat: { profileId: 'mac-chat' }, speech: { profileId: 'mac-speech' } });
  await saveModelSettings(f.store, f.vault, chat());
  assert.equal(f.store.state.settings.connectionProfiles.chat, undefined); assert.equal(f.store.state.settings.connectionProfiles.speech.profileId, 'mac-speech');
  await f.store.tx(s => s.settings.connectionProfiles.chat = { profileId: 'mac-chat' }); await saveSpeechSettings(f.store, f.vault, speech());
  assert.equal(f.store.state.settings.connectionProfiles.chat.profileId, 'mac-chat'); assert.equal(f.store.state.settings.connectionProfiles.speech, undefined);
  assert.equal(f.secrets.get('connections'), 'synthetic-opaque-synced-bundle');
});
test('scheme count limit and active deletion are rejected before altering credentials or settings', async () => {
  const f = await fixture(); for (let i = 0; i < 12; i++) await saveModelSettings(f.store, f.vault, chat(A, 'synthetic-' + i, { profileName: '方案' + i }));
  const raw = f.secrets.get('model'), before = structuredClone(f.store.state);
  await assert.rejects(saveModelSettings(f.store, f.vault, chat()), /最多保存 12/); assert.equal(f.secrets.get('model'), raw); assert.deepEqual(f.store.state, before);
  await assert.rejects(deleteApiProfile(f.store, 'chat', activeApiProfile(f.store.state.settings, 'chat')), /先使用/);
  const first = apiProfiles(f.store.state.settings, 'chat')[0]; await deleteApiProfile(f.store, 'chat', first.id);
  await assert.rejects(useModelProfile(f.store, f.vault, first.id), /重新选择/);
});
test('editor switching keeps independent drafts and memory-only keys; dirty use does not activate old saved content', async () => {
  const f = await fixture(); await saveModelSettings(f.store, f.vault, chat()); const a = activeApiProfile(f.store.state.settings, 'chat');
  await saveModelSettings(f.store, f.vault, chat(B, 'synthetic-b')); const b = activeApiProfile(f.store.state.settings, 'chat');
  const options = { store: f.store, purpose: 'chat', save: v => saveModelSettings(f.store, f.vault, v), use: id => useModelProfile(f.store, f.vault, id), remove: id => deleteApiProfile(f.store, 'chat', id) };
  const editor = createApiProfileEditor(options); await editor.select(a);
  editor.setValues({ ...editor.snapshot().values, model: '未保存🙂', key: 'synthetic-draft-key' });
  await editor.select(b); assert.equal(activeApiProfile(f.store.state.settings, 'chat'), b); await editor.select(a);
  assert.equal(editor.snapshot().values.model, '未保存🙂'); assert.equal(editor.snapshot().values.key, 'synthetic-draft-key');
  await assert.rejects(editor.use(), /未保存/); assert.equal(activeApiProfile(f.store.state.settings, 'chat'), b);
  assert.ok(!JSON.stringify(f.store.state).includes('synthetic-draft-key'));
  const restarted = createApiProfileEditor(options); await restarted.select(a); assert.equal(restarted.snapshot().values.model, '未保存🙂'); assert.equal(restarted.snapshot().values.key, '');
  await editor.save(); assert.equal(activeApiProfile(f.store.state.settings, 'chat'), a); assert.equal(f.store.state.drafts['api-profile:chat:' + a], undefined);
  await actualChat(f, A, 'synthetic-draft-key');
});
for (const provider of ['openai', 'aliyun', 'qwen']) test(`explicit ${provider} speech probe uses synthetic silence and validates response shape without activation`, async () => {
  const f = await fixture(), before = structuredClone(f.store.state); let request;
  const values = speech('https://speech.example.test', 'synthetic-probe', { provider });
  const result = await testSpeechSettings({ ...f, values, http: async (url, o) => { request = { url, o }; return provider === 'openai' ? { text: '' } : provider === 'aliyun' ? { output: { text: '' } } : { choices: [{ message: { content: '' } }] }; } });
  assert.equal(result.accepted, true); assert.match(result.message, /未验证/); assert.deepEqual(f.store.state, before); assert.equal(f.secrets.size, 0);
  assert.equal(request.o.headers.Authorization, 'Bearer synthetic-probe');
  if (provider === 'openai') { assert.ok(request.o.bytes.length > 32044); assert.match(new TextDecoder().decode(request.o.bytes), /RIFF/); }
  else { const content = provider === 'aliyun' ? request.o.body.input.messages[0].content[0] : request.o.body.messages[0].content[0]; assert.match(content.input_audio.data, /^data:audio\/wav;base64,UklGR/); }
  await assert.rejects(testSpeechSettings({ ...f, values, http: async () => ({ ok: true }) }), /接口不匹配/);
  if (provider !== 'qwen') await assert.rejects(testSpeechSettings({ ...f, values, http: async () => provider === 'openai' ? ({ text: [] }) : ({ output: { text: [] } }) }), /接口不匹配/);
});
test('speech probe never borrows key from active or another scheme at a changed endpoint', async () => {
  const f = await fixture(); await saveSpeechSettings(f.store, f.vault, speech()); const a = activeApiProfile(f.store.state.settings, 'speech');
  await assert.rejects(testSpeechSettings({ ...f, values: speech(B, '', { profileId: a }), http: () => assert.fail('must not call network') }), /API Key/);
});
test('manual speech selection changing during transcription rejects late results', async () => {
  const f = await fixture(); await saveSpeechSettings(f.store, f.vault, speech());
  await assert.rejects(transcribeWithConnections({ ...f, audio: { durationMs: 1000, data: btoa('synthetic'), mimeType: 'audio/wav' }, http: async () => {
    await saveSpeechSettings(f.store, f.vault, speech(B, 'synthetic-b')); return { text: 'late transcript' };
  } }), /语音配置已变化/);
});
test('speech vault failure and concurrent public settings changes cannot activate a replacement scheme', async () => {
  const f = await fixture(); await saveSpeechSettings(f.store, f.vault, speech());
  const before = structuredClone(f.store.state.settings), raw = f.secrets.get('speech'), set = f.vault.set;
  f.vault.set = async () => { throw Error('synthetic vault failure'); };
  await assert.rejects(saveSpeechSettings(f.store, f.vault, speech(B, 'synthetic-b')), /vault failure/);
  assert.deepEqual(f.store.state.settings, before); assert.equal(f.secrets.get('speech'), raw);
  f.vault.set = async (...args) => { await set(...args); await f.store.tx(s => s.settings.connectionProfiles = { speech: { profileId: 'newer-user-choice' } }); };
  await assert.rejects(saveSpeechSettings(f.store, f.vault, speech(B, 'synthetic-b')), /保存期间变化/);
  assert.deepEqual(f.store.state.settings.speech, before.speech); assert.equal(f.store.state.settings.connectionProfiles.speech.profileId, 'newer-user-choice');
});
