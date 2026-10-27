/* Pure helpers for the non-chat purposes on the Models page: embedding (semantic search) and speech-to-text.
   Public metadata only; keys never pass through here. The embedding engine keeps its own localStorage config
   (aibro-embedding-settings-v1) as the source of truth; settings.roles.embedding mirrors it. Speech lives in the native
   shell (separate encrypted schemes), so settings.roles.transcription only caches a public summary of it. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ModelRoles = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const Providers = () => root.Providers || (typeof require === 'function' ? require('./providers.js') : null);
  const english = () => root.WorkstationI18n?.getLanguage?.() === 'en' || /^en(?:-|$)/i.test(root.document?.documentElement?.lang || '');
  const t = (zh, en) => english() ? en : zh;

  const hostOf = value => { try { return new URL(String(value || '')).host; } catch (_) { return ''; } };
  const trimSlash = value => String(value || '').replace(/\/+$/, '');
  // What the embedding engine appends itself, so a provider base and a saved endpoint compare equal.
  const stripEmbeddings = value => trimSlash(value).replace(/\/embeddings$/, '');
  const EMBED_NAME = /embed|bge|gte|e5\b|text-embedding|m3e|jina|nomic/i;

  // API providers that can carry an embeddings request: everything except the Anthropic wire (no embeddings endpoint).
  function embeddingProviders(settings) {
    const P = Providers();
    return P.items(settings).filter(item => item.kind === 'api' && item.base && item.protocol !== 'anthropic')
      .map(item => ({ id: item.id, name: item.name, base: item.base, host: hostOf(item.base), needsKey: item.needsKey === true,
        models: embeddingModelNames(item) }));
  }
  // Embedding-looking names first (the user may have added them by hand), then the usual default for well-known hosts.
  function embeddingModelNames(item) {
    const own = (item.models || []).map(entry => entry.model).filter(Boolean);
    const likely = own.filter(name => EMBED_NAME.test(name));
    const host = hostOf(item.base);
    const defaults = /(^|\.)openai\.com$/.test(host) ? ['text-embedding-3-small', 'text-embedding-3-large']
      : /dashscope/.test(host) ? ['text-embedding-v4', 'text-embedding-v3']
      : /siliconflow/.test(host) ? ['BAAI/bge-m3'] : [];
    return [...new Set([...likely, ...defaults])];
  }
  // Which provider does a saved endpoint belong to? Same origin+path prefix; the longest match wins.
  function matchProvider(base, providers) {
    const target = stripEmbeddings(base);
    if (!target) return null;
    let best = null;
    for (const item of providers || []) {
      const own = stripEmbeddings(item.base);
      if (own && (target === own || target.startsWith(own + '/')) && (!best || own.length > stripEmbeddings(best.base).length)) best = item;
    }
    return best;
  }

  /* config: the engine config ({base, model, dimensions, enabled, autoUpdate, noKey}) or null.
     status: { credentialState: 'stored'|'not-required'|'unknown'|'missing'|'legacy'|'mismatch'|'unavailable', failed: bool }. */
  function describeEmbedding(config, providers, status = {}) {
    if (!config || !config.base || !config.model) {
      return { configured: false, enabled: false, title: t('还没有配置嵌入模型', 'No embedding model yet'), sub: t('当前用关键词检索，不会发送任何内容。', 'Keyword search is in use; nothing is sent anywhere.'), tone: 'neutral', badge: t('未配置', 'Not set up') };
    }
    const provider = matchProvider(config.base, providers);
    const host = hostOf(config.base);
    const sub = `${provider ? provider.name : host}${config.dimensions ? ` · ${config.dimensions} ${t('维', 'dim')}` : ''}`;
    let badge = config.enabled ? t('已启用', 'On') : t('已关闭', 'Off'), tone = config.enabled ? 'success' : 'neutral';
    if (!config.noKey && ['missing', 'legacy', 'mismatch', 'unavailable'].includes(status.credentialState)) { badge = t('待补 Key', 'Key needed'); tone = 'warning'; }
    else if (status.failed) { badge = t('上次请求失败', 'Last request failed'); tone = 'warning'; }
    return { configured: true, enabled: !!config.enabled, title: config.model, sub, tone, badge, providerId: provider ? provider.id : '' };
  }
  // The stored role mirrors the engine config; no key, no token.
  function embeddingRole(config, providers) {
    if (!config || !config.base || !config.model) return null;
    const provider = matchProvider(config.base, providers);
    return { provider: provider ? provider.id : '', base: config.base, model: config.model, dimensions: config.dimensions || 0, enabled: config.enabled === true };
  }

  // ---- speech (native state → rows) ----
  const PROVIDER_LABEL = { aliyun: ['阿里云百炼', 'Alibaba Cloud Model Studio'], openAI: ['OpenAI 兼容', 'OpenAI-compatible'], elevenLabs: ['ElevenLabs Scribe', 'ElevenLabs Scribe'], selfHosted: ['自部署服务', 'Self-hosted service'] };
  const LANGUAGE_LABEL = { '': ['自动识别', 'Auto detect'], auto: ['自动识别', 'Auto detect'], zh: ['中文', 'Chinese'], en: ['英文', 'English'], yue: ['粤语', 'Cantonese'], ja: ['日语', 'Japanese'], ko: ['韩语', 'Korean'], de: ['德语', 'German'], fr: ['法语', 'French'], es: ['西班牙语', 'Spanish'] };
  const languageLabel = code => { const pair = LANGUAGE_LABEL[code || ''] || [code, code]; return t(pair[0], pair[1]); };
  const providerLabel = key => { const pair = PROVIDER_LABEL[key] || [key || '', key || '']; return t(pair[0], pair[1]); };

  // state is the native reply of workstationDesktop.speech.state(); anything else (browser, old shell) is "unavailable".
  function normalizeSpeech(state) {
    if (!state || state.status !== 'ok') return { available: false, reason: (state && state.reason) || 'unavailable', cloud: { schemes: [], selectedId: '' }, realtime: { profiles: [], activeId: '' } };
    const cloud = state.cloud || {}, realtime = state.realtime || {};
    const schemes = (Array.isArray(cloud.schemes) ? cloud.schemes : []).filter(item => item && typeof item.id === 'string').map(item => ({
      id: item.id, name: String(item.name || ''), provider: String(item.provider || ''), model: String(item.model || ''), host: String(item.host || ''), baseURL: String(item.baseURL || ''), timeoutSeconds: Number(item.timeoutSeconds) || 0, language: String(item.language || ''), keySaved: item.keySaved === true }));
    const profiles = (Array.isArray(realtime.profiles) ? realtime.profiles : []).filter(item => item && typeof item.id === 'string').map(item => ({
      id: item.id, name: String(item.name || ''), model: String(item.model || ''), provider: String(item.provider || 'bailian'), region: String(item.region || ''), host: String(item.host || ''), serverURL: String(item.serverURL || ''), workspaceID: String(item.workspaceID || ''), language: String(item.language || ''), enabled: item.enabled === true, keySaved: item.keySaved === true }));
    const result = state.result && typeof state.result === 'object' ? { op: String(state.result.op || ''), ok: state.result.ok === true, id: String(state.result.id || ''), message: String(state.result.message || ''), seq: Number(state.result.seq) || 0 } : { op: '', ok: false, id: '', message: '', seq: 0 };
    return { available: cloud.available === true || realtime.available === true, result, silenceSeconds: Number.isFinite(Number(state.silenceSeconds)) ? Number(state.silenceSeconds) : 1.5,
      cloud: { available: cloud.available === true, busy: cloud.busy === true, configured: cloud.configured === true, selectedId: String(cloud.selectedId || ''), schemes,
        testing: cloud.testing === true, testMessage: String(cloud.testMessage || ''), error: String(cloud.error || '') },
      realtime: { available: realtime.available === true, busy: realtime.busy === true, configured: realtime.configured === true, enabled: realtime.enabled === true, activeId: String(realtime.activeId || ''), profiles,
        testing: realtime.testing === true, testMessage: String(realtime.testMessage || ''), error: String(realtime.error || '') } };
  }

  // ---------- speech editing (pure: what a person typed -> what is sent / why it cannot be sent) ----------
  const CLOUD_PROVIDERS = ['aliyun', 'openAI', 'elevenLabs', 'selfHosted'];
  const CLOUD_DEFAULTS = { aliyun: { baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen-audio-3.0-asr-flash' }, openAI: { baseURL: 'https://api.openai.com/v1', model: 'whisper-1' },
    elevenLabs: { baseURL: 'https://api.elevenlabs.io', model: 'scribe_v2' }, selfHosted: { baseURL: '', model: 'Qwen3-ASR-1.7B' } };
  const cloudDefaults = provider => CLOUD_DEFAULTS[provider] || CLOUD_DEFAULTS.aliyun;
  const hostOfUrl = raw => { try { return new URL(/:\/\//.test(raw) ? raw : 'http://' + raw); } catch (_) { return null; } };
  // Mirrors the native normalizer: http(s)://host:port, a base ending in /v1, host:port or ws(s):// all become ws(s)://host[:port]/stream.
  function streamAddress(input) {
    const raw = String(input || '').trim(); if (!raw || raw.length > 2048) return '';
    const url = hostOfUrl(raw); if (!url || !url.hostname) return '';
    const scheme = { 'http:': 'ws:', 'https:': 'wss:', 'ws:': 'ws:', 'wss:': 'wss:' }[url.protocol]; if (!scheme) return '';
    if (url.search || url.hash || url.username || url.password) return '';
    let path = url.pathname;
    for (const tail of ['/audio/transcriptions', '/stream', '/v1']) if (path.endsWith(tail)) path = path.slice(0, -tail.length);
    path = path.replace(/\/+$/, '');
    return `${scheme}//${url.host}${path}/stream`;
  }
  const reusableCloud = speech => (speech && speech.cloud ? speech.cloud.schemes : []).filter(item => item.provider === 'selfHosted');
  const providerLabels = { aliyun: ['阿里云语音', 'Alibaba Cloud speech'], openAI: ['OpenAI 兼容转写', 'OpenAI-compatible transcription'], elevenLabs: ['ElevenLabs Scribe', 'ElevenLabs Scribe'], selfHosted: ['自部署服务（OpenAI 兼容）', 'Self-hosted (OpenAI-compatible)'] };
  // Why a cloud scheme cannot be tested/saved yet, in words for the person typing; '' when it can.
  function cloudProblem(draft, existing) {
    if (!String(draft.name || '').trim()) return t('请填写名称。', 'Enter a name.');
    if (!String(draft.baseURL || '').trim()) return draft.provider === 'selfHosted' ? t('请填写服务地址，例如 http://主机:8000/v1。', 'Enter the server address, e.g. http://host:8000/v1.') : t('请填写服务地址。', 'Enter the service address.');
    const url = hostOfUrl(String(draft.baseURL).trim());
    if (!url || !/^https?:$/.test(url.protocol) || !url.hostname || !/:\/\//.test(String(draft.baseURL))) return t('服务地址需以 http:// 或 https:// 开头。', 'The address must start with http:// or https://.');
    if (url.search || url.hash || url.username) return t('服务地址不能带参数或账号。', 'The address cannot include a query or credentials.');
    if (url.protocol === 'http:' && draft.provider !== 'selfHosted') return t('这个协议只能用 https:// 地址（自部署服务可用 http://）。', 'This protocol needs an https:// address (self-hosted services may use http://).');
    if (!String(draft.model || '').trim()) return t('请填写模型名称。', 'Enter the model name.');
    if (draft.language && !/^[A-Za-z-]{1,16}$/.test(draft.language)) return t('语言只能填 zh、en、auto 这样的代码。', 'Language must be a code such as zh, en or auto.');
    const keyKept = existing && existing.keySaved && existing.provider === draft.provider && String(existing.baseURL || '').replace(/\/+$/, '') === String(draft.baseURL).trim().replace(/\/+$/, '');
    if (!String(draft.key || '').trim() && !keyKept) return t('缺少 Key：请填写此服务的 Key。', 'Key missing: enter the Key for this service.');
    return '';
  }
  // Same for a live scheme. `reuse` is the cloud scheme whose address and Key are borrowed (self-hosted only).
  function realtimeProblem(draft, existing, speech) {
    if (!String(draft.name || '').trim()) return t('请填写名称。', 'Enter a name.');
    const reuse = draft.provider === 'selfHosted' && draft.reuseCloudID ? reusableCloud(speech).find(item => item.id === draft.reuseCloudID) : null;
    if (draft.provider === 'selfHosted') {
      if (draft.reuseCloudID && !reuse) return t('选中的云转写方案已不存在。', 'The chosen cloud scheme no longer exists.');
      if (!reuse) {
        if (!String(draft.serverURL || '').trim()) return t('请填写服务地址，例如 http://主机:8000。', 'Enter the server address, e.g. http://host:8000.');
        if (!streamAddress(draft.serverURL)) return t('服务地址无法识别，请填 http(s)://主机:端口 或 ws(s)://主机:端口。', 'The address is not recognized; use http(s)://host:port or ws(s)://host:port.');
      } else if (!streamAddress(reuse.baseURL)) return t('云转写方案的地址无法用于实时转写。', 'The cloud scheme address cannot be used for live transcription.');
    }
    if (draft.workspaceID && !/^[A-Za-z0-9_-]{1,128}$/.test(draft.workspaceID)) return t('工作空间 ID 只能含字母、数字、- 和 _。', 'Workspace ID may only contain letters, digits, - and _.');
    const same = existing && existing.keySaved && existing.provider === draft.provider && (draft.provider !== 'selfHosted' || streamAddress(existing.serverURL) === streamAddress(draft.serverURL)) && (draft.provider !== 'bailian' || (existing.region === draft.region && existing.workspaceID === (draft.workspaceID || '')));
    if (!reuse && !String(draft.key || '').trim() && !same) return t('缺少 Key：请填写此服务的 Key。', 'Key missing: enter the Key for this service.');
    return '';
  }
  function describeCloud(speech) {
    const cloud = speech.cloud, current = cloud.schemes.find(item => item.id === cloud.selectedId) || null;
    if (!current) return { configured: false, title: t('还没有云转写方案', 'No cloud transcription scheme yet'), sub: t('灵动岛听写、录音转写都会用到它。', 'Island dictation and recording transcripts use it.'), tone: 'neutral', badge: t('未配置', 'Not set up') };
    const sub = [providerLabel(current.provider), current.host, languageLabel(current.language)].filter(Boolean).join(' · ');
    return { configured: true, title: current.model, sub, tone: 'success', badge: t('使用中', 'In use'), schemeName: current.name };
  }
  function describeRealtime(speech) {
    const rt = speech.realtime, current = rt.profiles.find(item => item.id === rt.activeId) || null;
    if (!current) return { configured: false, title: t('还没有实时转写方案', 'No realtime scheme yet'), sub: t('开启后录音时边说边出文字。', 'Turns speech into text while you record.'), tone: 'neutral', badge: t('未配置', 'Not set up') };
    return { configured: true, title: current.provider === 'selfHosted' ? t('流式转写', 'Streaming transcription') : (current.model || 'qwen3-asr-flash-realtime'), sub: [current.name, current.provider === 'elevenLabs' || current.provider === 'selfHosted' ? providerLabel(current.provider) : current.region, current.provider === 'selfHosted' ? current.host : '', languageLabel(current.language)].filter(Boolean).join(' · '), tone: rt.enabled ? 'success' : 'neutral', badge: rt.enabled ? t('已开启', 'On') : t('已关闭', 'Off') };
  }
  function transcriptionRole(speech) {
    if (!speech.available) return null;
    const current = speech.cloud.schemes.find(item => item.id === speech.cloud.selectedId) || null;
    const source = speech.realtime.enabled && speech.realtime.configured ? 'realtime' : current ? 'cloud' : 'none';
    return { source, scheme: current ? current.id : '', model: current ? current.model : '', realtime: speech.realtime.enabled === true };
  }

  return Object.freeze({ embeddingProviders, embeddingModelNames, matchProvider, describeEmbedding, embeddingRole, normalizeSpeech, describeCloud, describeRealtime, transcriptionRole, languageLabel, providerLabel, hostOf, streamAddress, reusableCloud, cloudDefaults, cloudProblem, realtimeProblem, CLOUD_PROVIDERS, providerLabels });
}));
