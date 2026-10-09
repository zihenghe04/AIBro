// One native vault channel. Keep the currently selected credential alongside a
// candidate until the workspace pointer commits; a failed DB save cannot swap
// the credential of the still-active configuration. Nothing here is cloud data.
import { apiProfiles, apiProfileSnapshot, assertApiProfileCurrent, profileEdit, applyApiProfile, MAX_API_PROFILES } from './api-profiles.js';
import { clearSavedApiDraft } from './api-profile-editor.js';
const FORMAT = 'aibro.model-credentials.v1';
// A legacy client must not send an entire envelope as a Bearer credential.
// Its existing native/browser header validation rejects/omits this newline.
const PREFIX = FORMAT + '\n';
const LEGACY = 'legacy';
const queues = new WeakMap();
const clone = value => value == null ? null : structuredClone(value);
const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
function serial(vault, operation) {
  const next = (queues.get(vault) || Promise.resolve()).catch(() => {}).then(operation);
  queues.set(vault, next.catch(() => {}));
  return next;
}
export function canonicalModelBase(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value.trim())) throw Error('请填写有效 HTTPS API 地址');
  let url; try { url = new URL(value.trim()); } catch { throw Error('请填写有效 HTTPS API 地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('请填写有效 HTTPS API 地址');
  return url.href.replace(/\/+$/, '');
}
function keyValue(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 16384 || /[^\x21-\x7e]/.test(value.trim())) throw Error('API Key 格式无效，请重新填写');
  return value.trim();
}
function decode(raw, legacyConfig) {
  if (raw == null || raw === '') return { format: FORMAT, entries: [] };
  let parsed; try { if (typeof raw === 'string' && raw.startsWith(PREFIX)) parsed = JSON.parse(raw.slice(PREFIX.length)); } catch {}
  if (parsed?.format === FORMAT) {
    if (!Array.isArray(parsed.entries) || parsed.entries.length > MAX_API_PROFILES + 2) throw Error('模型凭据格式异常，原记录已保留');
    const refs = new Set();
    for (const entry of parsed.entries) {
      if (!entry || typeof entry.ref !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.ref) || refs.has(entry.ref)
        || canonicalModelBase(entry.scope) !== entry.scope || keyValue(entry.key) !== entry.key) throw Error('模型凭据格式异常，原记录已保留');
      refs.add(entry.ref);
    }
    return { format: FORMAT, entries: parsed.entries.map(({ ref, scope, key }) => ({ ref, scope, key })) };
  }
  // An envelope that is truncated or from a future version is never an API key.
  if (typeof raw !== 'string' || raw.startsWith('aibro.model-credentials.') || raw.trim().startsWith('{') || legacyConfig?.credentialRef) throw Error('模型凭据不可识别，请重新填写当前服务的 Key');
  if (!legacyConfig?.base) throw Error('旧 Key 没有可确认的服务地址，请重新填写');
  return { format: FORMAT, entries: [{ ref: LEGACY, scope: canonicalModelBase(legacyConfig.base), key: keyValue(raw) }] };
}
function selected(envelope, config) {
  if (!config?.base) return null;
  const scope = canonicalModelBase(config.base), ref = config.credentialRef || LEGACY;
  return envelope.entries.find(entry => entry.ref === ref && entry.scope === scope) || null;
}
const missing = () => Error('此 API 地址没有匹配的已保存 Key，请填写当前服务的 API Key');

export function modelCredential(vault, config) {
  return serial(vault, async () => {
    const raw = await vault.get('model'), envelope = decode(raw, config), entry = selected(envelope, config);
    if (!entry) throw missing();
    if (raw !== PREFIX + JSON.stringify(envelope)) await vault.set('model', PREFIX + JSON.stringify(envelope));
    return entry.key;
  });
}

// Synced configuration and its secret have one authority: the atomic native
// bundle. Store contains only the user's purpose/profile selection.
export async function resolveModelConnection({ store, vault, connectionSync }) {
  if (store.state.settings.connectionProfiles?.chat) {
    if (!connectionSync) throw Error('从 Mac 同步的模型需要原生配置同步连接，请在设置中重新连接。');
    const resolved = await connectionSync.resolve('chat');
    if (!resolved) throw Error('同步模型当前不可用，请在设置中重新选择。');
    const p = resolved.profile;
    if (p.provider !== 'openai-compatible' || !['chat-completions', 'responses'].includes(p.apiFormat)) throw Error('手机暂不支持此模型接口。');
    return { config: { base: p.baseUrl, model: p.model, format: p.apiFormat === 'responses' ? 'responses' : 'chat' },
      token: p.apiKey, assertCurrent: resolved.assertCurrent };
  }
  const config = clone(store.state.settings.model);
  if (!config?.base || !config.model) return null;
  return { config, token: await modelCredential(vault, config), assertCurrent: async () => {
    if (store.state.settings.connectionProfiles?.chat || !equal(store.state.settings.model, config)) throw Error('模型设置已变化，请重新发送。');
  } };
}

export function saveModelSettings(store, vault, values) {
  return serial(vault, async () => {
    const base = canonicalModelBase(values.base), model = typeof values.model === 'string' ? values.model.trim() : '';
    if (!model || model.length > 512 || /[\u0000-\u001f\u007f]/.test(model) || !['chat', 'responses'].includes(values.format)) throw Error('请填写有效模型名称并选择接口格式');
    await store.tail;
    const before = clone(store.state.settings.model), snapshot = apiProfileSnapshot(store.state.settings, 'chat');
    const edit = profileEdit(store.state.settings, 'chat', values), envelope = decode(await vault.get('model'), before);
    const current = selected(envelope, before), target = edit ? selected(envelope, edit.target?.config) : current;
    const supplied = typeof values.key === 'string' && values.key.trim();
    let next;
    if (supplied) next = { ref: crypto.randomUUID().replaceAll('-', ''), scope: base, key: keyValue(supplied) };
    else {
      // An uncommitted candidate from an earlier failure is not an active key.
      if (!target || target.scope !== base) throw missing();
      next = target;
    }
    const keep = new Set([current?.ref, ...apiProfiles(store.state.settings, 'chat').map(p => selected(envelope, p.config)?.ref)]);
    const candidate = { format: FORMAT, entries: [...envelope.entries.filter(e => keep.has(e.ref) && e.ref !== next.ref), next] };
    const encoded = PREFIX + JSON.stringify(candidate);
    if (new TextEncoder().encode(encoded).length >= 60000) throw Error('模型凭据超出安全存储大小限制');
    await vault.set('model', encoded);
    const config = { base, model, format: values.format, credentialRef: next.ref };
    await store.tx(state => {
      assertApiProfileCurrent(state.settings, 'chat', snapshot);
      applyApiProfile(state.settings, 'chat', config, edit);
      clearSavedApiDraft(state, 'chat', values);
    });
    return config;
  });
}

export function useModelProfile(store, vault, profileId) {
  return serial(vault, async () => {
    await store.tail;
    const snapshot = apiProfileSnapshot(store.state.settings, 'chat'), profiles = apiProfiles(store.state.settings, 'chat');
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) throw Error('方案已变化，请重新选择');
    const envelope = decode(await vault.get('model'), store.state.settings.model);
    if (!selected(envelope, profile.config)) throw missing();
    await store.tx(state => {
      assertApiProfileCurrent(state.settings, 'chat', snapshot);
      applyApiProfile(state.settings, 'chat', profile.config, { profiles, target: profile, ...profile });
    });
    return clone(profile.config);
  });
}
