// Independent speech credentials never enter workspace records, backups or sync.
import { apiProfiles, apiProfileSnapshot, assertApiProfileCurrent, profileEdit, applyApiProfile, MAX_API_PROFILES } from './api-profiles.js';
import { clearSavedApiDraft } from './api-profile-editor.js';
const encoder = new TextEncoder();
const MAX_AUDIO = 16 * 1024 * 1024;
const MAX_DASHSCOPE_BODY = 10_000_000;
export function speechConfiguration(value = {}) {
  const provider = value.provider || 'aliyun';
  if (!['aliyun', 'qwen', 'openai'].includes(provider)) throw Error('请选择语音接口格式');
  const raw = String(value.base || '').trim();
  if (!raw || raw.length > 2048 || /[\u0000-\u0020]/.test(raw)) throw Error('请填写语音服务 HTTPS 地址');
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('语音服务必须是无账号、参数的 HTTPS 地址');
  const model = String(value.model || '').trim(), language = String(value.language || '').trim();
  if (!model || model.length > 160 || /[\r\n\u0000]/.test(model)) throw Error('请填写有效的语音识别模型');
  if (language && !/^[A-Za-z-]{1,16}$/.test(language)) throw Error('语言代码应为 zh、en 等，可留空自动识别');
  let path = url.pathname.replace(/\/+$/, '');
  if (provider === 'aliyun') {
    if (!['', '/compatible-mode/v1', '/api/v1/services/aigc/multimodal-generation/generation'].includes(path)) throw Error('阿里原生接口请填写服务域名或 compatible-mode/v1 地址');
    path = '/api/v1/services/aigc/multimodal-generation/generation';
  } else {
    const suffix = provider === 'qwen' ? '/chat/completions' : '/audio/transcriptions';
    if (!path) path = '/v1';
    if (!path.endsWith(suffix)) path += suffix;
  }
  url.pathname = path;
  return { provider, base: raw.replace(/\/+$/, ''), model, language, endpoint: url.href, scope: provider + '|' + url.href,
    ...(value.credentialRef ? { credentialRef: value.credentialRef } : {}) };
}
const BANK = 'aibro.speech-credentials.v1';
const queues = new WeakMap();
function serial(vault, fn) { const next = (queues.get(vault) || Promise.resolve()).catch(() => {}).then(fn); queues.set(vault, next.catch(() => {})); return next; }
function checkedKey(key) {
  if (typeof key !== 'string' || !key.trim() || key.trim().length > 16384 || /[^\x21-\x7e]/.test(key.trim())) throw Error('语音 API Key 格式无效');
  return key.trim();
}
function speechBank(raw) {
  if (!raw) return { format: BANK, entries: [] };
  let saved; try { saved = JSON.parse(raw.startsWith(BANK + '\n') ? raw.slice(BANK.length + 1) : raw); } catch { throw Error('语音凭据不可识别，原设置已保留'); }
  if (saved?.key && typeof saved.scope === 'string') return { format: BANK, entries: [{ ref: 'legacy', scope: saved.scope, key: checkedKey(saved.key) }] };
  if (saved?.format !== BANK || !Array.isArray(saved.entries) || saved.entries.length > MAX_API_PROFILES + 2 || new Set(saved.entries.map(e => e.ref)).size !== saved.entries.length || saved.entries.some(e => !e || !/^[a-zA-Z0-9_-]{1,80}$/.test(e.ref) || typeof e.scope !== 'string' || e.scope.length > 2100 || checkedKey(e.key) !== e.key)) throw Error('语音凭据格式异常，原设置已保留');
  return saved;
}
function selected(bank, config) {
  if (!config?.base) return null;
  const c = speechConfiguration(config);
  return bank.entries.find(e => e.ref === (c.credentialRef || 'legacy') && e.scope === c.scope);
}
const missingKey = () => Error('请在设置 → 语音输入中保存当前服务的 API Key');
export async function speechCredential(vault, config) {
  return serial(vault, async () => {
    const entry = selected(speechBank(await vault.get('speech')), config);
    if (!entry) throw missingKey();
    return entry.key;
  });
}
export async function saveSpeechCredential(vault, value, key) {
  const config = speechConfiguration(value);
  if (key?.trim()) {
    if (key.length > 16384 || /[\r\n\u0000]/.test(key)) throw Error('语音 API Key 格式无效');
    await vault.set('speech', JSON.stringify({ key: key.trim(), scope: config.scope }));
  } else await speechCredential(vault, config);
  return { provider: config.provider, base: config.base, model: config.model, language: config.language };
}
export function saveSpeechSettings(store, vault, values) {
  return serial(vault, async () => {
    const config = speechConfiguration(values);
    await store.tail;
    const snapshot = apiProfileSnapshot(store.state.settings, 'speech'), edit = profileEdit(store.state.settings, 'speech', values);
    const bank = speechBank(await vault.get('speech')), current = selected(bank, store.state.settings.speech);
    const target = edit ? selected(bank, edit.target?.config) : current;
    const next = values.key?.trim() ? { ref: crypto.randomUUID().replaceAll('-', ''), scope: config.scope, key: checkedKey(values.key) } : target;
    if (!next || next.scope !== config.scope) throw missingKey();
    const keep = new Set([current?.ref, ...apiProfiles(store.state.settings, 'speech').map(p => selected(bank, p.config)?.ref)]);
    const encoded = BANK + '\n' + JSON.stringify({ format: BANK, entries: [...bank.entries.filter(e => keep.has(e.ref) && e.ref !== next.ref), next] });
    if (encoder.encode(encoded).length >= 60000) throw Error('语音方案超出安全存储大小限制');
    await vault.set('speech', encoded);
    const saved = { provider: config.provider, base: config.base, model: config.model, language: config.language, credentialRef: next.ref };
    await store.tx(state => { assertApiProfileCurrent(state.settings, 'speech', snapshot); applyApiProfile(state.settings, 'speech', saved, edit); clearSavedApiDraft(state, 'speech', values); });
    return saved;
  });
}
export function useSpeechProfile(store, vault, profileId) {
  return serial(vault, async () => {
    await store.tail;
    const snapshot = apiProfileSnapshot(store.state.settings, 'speech'), profiles = apiProfiles(store.state.settings, 'speech');
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) throw Error('方案已变化，请重新选择');
    if (!selected(speechBank(await vault.get('speech')), profile.config)) throw missingKey();
    await store.tx(state => { assertApiProfileCurrent(state.settings, 'speech', snapshot); applyApiProfile(state.settings, 'speech', profile.config, { profiles, target: profile, ...profile }); });
    return structuredClone(profile.config);
  });
}
function audioBytes(audio) {
  if (!audio || !Number.isFinite(audio.durationMs) || audio.durationMs < 250 || audio.durationMs > 125000) throw Error('录音需在 0.25 秒到 2 分钟内，请重新录制');
  if (typeof audio.data !== 'string' || audio.data.length > Math.ceil(MAX_AUDIO / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio.data)) throw Error('录音数据无效或超过 16 MB');
  const bytes = Uint8Array.from(atob(audio.data), c => c.charCodeAt(0));
  if (!bytes.length || bytes.length > MAX_AUDIO) throw Error('没有可识别的录音');
  if (!['audio/mp4', 'audio/m4a', 'audio/wav', 'audio/webm'].includes(audio.mimeType)) throw Error('录音格式暂不支持');
  return bytes;
}
export async function transcribeSpeech({ config: value, audio, http, vault, signal, allowEmpty = false }) {
  const config = speechConfiguration(value), bytes = audioBytes(audio);
  const key = await speechCredential(vault, config);
  if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
  let options = { method: 'POST', headers: { Authorization: 'Bearer ' + key }, signal };
  const audioPart = { type: 'input_audio', input_audio: { data: `data:${audio.mimeType};base64,${audio.data}` } };
  // The DashScope limit applies after Base64 encoding, not to the raw file.
  if (config.provider !== 'openai' && audioPart.input_audio.data.length > MAX_DASHSCOPE_BODY) throw Error('语音服务要求编码后的录音不超过 10 MB，请缩短录音');
  if (config.provider === 'aliyun') {
    const format = audio.mimeType === 'audio/wav' ? 'wav' : audio.mimeType === 'audio/webm' ? 'webm' : 'm4a';
    options.headers['X-DashScope-SSE'] = 'disable';
    options.body = { model: config.model, input: { messages: [{ role: 'user', content: [audioPart] }] }, parameters: { format, ...(config.language ? { language_hints: [config.language] } : {}) } };
  } else if (config.provider === 'qwen') {
    options.body = { model: config.model, messages: [{ role: 'user', content: [audioPart] }], stream: false, asr_options: { enable_itn: true, ...(config.language ? { language: config.language } : {}) } };
  } else {
    const boundary = 'AIBroSpeech' + crypto.randomUUID().replaceAll('-', '');
    const parts = [];
    for (const [name, text] of Object.entries({ model: config.model, response_format: 'json', ...(config.language ? { language: config.language } : {}) }))
      parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${text}\r\n`));
    const extension = audio.mimeType === 'audio/wav' ? 'wav' : audio.mimeType === 'audio/webm' ? 'webm' : 'm4a';
    parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="recording.${extension}"\r\nContent-Type: ${audio.mimeType}\r\n\r\n`), bytes, encoder.encode(`\r\n--${boundary}--\r\n`));
    const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0; for (const p of parts) { body.set(p, offset); offset += p.length; }
    options.bytes = body; options.headers['Content-Type'] = 'multipart/form-data; boundary=' + boundary;
  }
  if (options.body && encoder.encode(JSON.stringify(options.body)).length > MAX_DASHSCOPE_BODY) throw Error('语音服务要求编码后的录音不超过 10 MB，请缩短录音');
  const result = await http(config.endpoint, options);
  if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
  if (result?.error || result?.code) throw Error('语音服务未完成转写，请检查接口与模型配置');
  const content = config.provider === 'aliyun' ? result?.output?.text : config.provider === 'openai' ? result?.text : result?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' && !(config.provider === 'qwen' && Array.isArray(content) && content.every(p => p && typeof p.text === 'string'))) throw Error('语音服务返回内容与所选接口不匹配');
  const text = (typeof content === 'string' ? content : Array.isArray(content) ? content.map(p => p.text || '').join('') : '').trim();
  if (!text && !allowEmpty) throw Error('没有识别到文字，请重新录制');
  if (text.length > 20000) throw Error('转写文字过长，请分成较短的指令');
  return text;
}

// Explicit user action only. A one-second silent PCM fixture checks the actual
// transcription endpoint; it does not open the microphone or activate a profile.
export async function testSpeechSettings({ store, vault, values, http, signal }) {
  const config = speechConfiguration(values);
  let key;
  if (values.key?.trim()) key = checkedKey(values.key);
  else {
    const edit = profileEdit(store.state.settings, 'speech', values);
    const target = edit ? edit.target?.config : store.state.settings.speech;
    if (!target || speechConfiguration(target).scope !== config.scope) throw missingKey();
    key = await speechCredential(vault, speechConfiguration(target));
  }
  const bytes = new Uint8Array(44 + 32000), v = new DataView(bytes.buffer);
  const ascii = (offset, text) => [...text].forEach((c, i) => bytes[offset + i] = c.charCodeAt(0));
  ascii(0, 'RIFF'); v.setUint32(4, bytes.length - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); ascii(36, 'data'); v.setUint32(40, 32000, true);
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  const scopedVault = { get: async name => { if (name !== 'speech') throw Error('用途不匹配'); return JSON.stringify({ key, scope: config.scope }); } };
  // An unsaved form's credentialRef must not become authority in the test vault.
  const { credentialRef: _ref, ...tested } = config;
  await transcribeSpeech({ config: tested, audio: { data: btoa(binary), mimeType: 'audio/wav', durationMs: 1000 }, http, vault: scopedVault, signal, allowEmpty: true });
  return { accepted: true, message: '服务已接受测试音频；未验证真实语音识别效果。' };
}
