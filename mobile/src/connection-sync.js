import { createNativeConnectionSync } from './connection-sync-native.js';
import { syncedSpeechConfiguration } from './connection-speech.js';

const clone = value => structuredClone(value);
const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const labels = { chat: '对话', speech: '语音识别', embedding: '知识库向量' };
const accountBinding = store => {
  const b = store.state.binding;
  if (!b?.base || !b.accountID) return null;
  try { return { serverOrigin: new URL(b.base).origin, accountId: b.accountID }; } catch { return null; }
};
const bound = (a, b) => a && b && a.serverOrigin === b.serverOrigin && a.accountId === b.accountId;
const stale = () => Object.assign(Error('云同步已断开或账号发生变化，请重新连接。'), { code: 'STALE_SESSION' });
export const supportsConnectionProfile = profile => {
  try {
    if (profile?.authKind !== 'api-key' || new URL(profile.baseUrl).protocol !== 'https:') return false;
    if (profile.purpose === 'speech') { syncedSpeechConfiguration(profile); return true; }
    return profile.provider === 'openai-compatible' && profile.purpose === 'chat' && ['chat-completions', 'responses'].includes(profile.apiFormat);
  }
  catch { return false; }
};
export function connectionProfileChoices(profiles) {
  return Object.entries(profiles).map(([id, p]) => ({ id, purpose: p.purpose, model: p.model, provider: p.provider,
    apiFormat: p.apiFormat, supported: supportsConnectionProfile(p), purposeLabel: labels[p.purpose] || '未知用途',
    limitation: p.purpose === 'embedding' ? '手机当前使用本机全文检索，尚未接入向量检索。'
      : p.provider === 'anthropic-api' ? '手机暂未接入 Anthropic Messages 协议。'
      : new URL(p.baseUrl).protocol !== 'https:' ? '手机仅启用 HTTPS 模型接口。'
      : p.purpose === 'speech' && !supportsConnectionProfile(p) ? '手机暂不支持此语音接口或配置，请检查 Mac 中的语音服务。' : '' }));
}
export async function parseOwnerPairing(text, binding, cryptoAPI) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 4096) throw Error('配对信息无效，请从 Mac 重新复制。');
  let value; try { value = JSON.parse(text); } catch { throw Error('请粘贴 Mac「配置同步」复制的完整配对信息。'); }
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'accountId,fingerprint,format,publicJwk,serverOrigin' ||
    value.format !== 'aibro.connection-pairing.v1' || !bound(value, binding)) throw Error('配对信息不属于当前云账号或同步服务。');
  const fingerprint = await cryptoAPI.fingerprintPublicKey(value.publicJwk);
  if (fingerprint !== value.fingerprint) throw Error('Mac 指纹与配对信息不一致，请重新复制。');
  return clone(value);
}
const errorText = error => ({
  STALE_SESSION: '云登录已变化，请重新连接云同步后再试。',
  UNSUPPORTED: '此服务器尚未支持模型配置同步；资料同步仍可使用。',
  AUTH: '此设备的连接认证已失效，请重新连接云同步。',
  FORBIDDEN: '此手机未获批准或授权已撤销，请在 Mac 上检查设备授权。',
  ROLLBACK: '收到的配置版本不一致，已停止更新。请在 Mac 上检查后重试。',
  UNPAIRED: '请先粘贴 Mac 配对信息并核对指纹。',
  LOCAL_CONFLICT: '本机配置已变化或未保存成功，请重试。',
  PAIRING_MISMATCH: '配对指纹不一致，未更换可信 Mac。',
  NETWORK: '暂时无法连接同步服务；本机已有配置保持不变。',
}[error?.code] || (/重新连接/.test(error?.message || '') ? '请重新连接云同步，以确认当前账号和设备身份。' : '模型配置同步未完成，请检查连接后重试。'));

// Only public status and selection IDs leave this controller. Decrypted profiles
// are read from the atomic native bundle at request time, never copied into Store.
export function createConnectionManager({ store, vault, bridge, http, native,
  createTransport = createNativeConnectionSync, cryptoAPI, createClient, onChange = () => {} }) {
  let transport, channelBinding, epoch = 0, busy = null, disconnected = false;
  let state = { stage: native ? 'idle' : 'native-required', busy: false, error: '', profiles: [], deviceFingerprint: null, ownerFingerprint: null, lastSync: null };
  const snapshot = () => clone({ ...state, selections: store.state.settings.connectionProfiles || {} });
  function publish(patch) { state = { ...state, ...patch }; onChange(snapshot()); }
  function check(ticket, binding) { if (ticket !== epoch || !bound(binding, accountBinding(store))) throw stale(); }
  async function channel(ticket = epoch) {
    const binding = accountBinding(store);
    if (disconnected || !native || !binding || !await vault.get('sync')) throw stale();
    check(ticket, binding);
    if (!transport || !bound(binding, channelBinding)) {
      const candidate = await createTransport({ store, vault, bridge, http, native, createClient });
      check(ticket, binding); transport = candidate; channelBinding = binding;
    }
    return { api: transport, binding, ticket };
  }
  async function readPublic(api, ticket, binding) {
    const profiles = await api.activeProfiles(); check(ticket, binding);
    const choices = connectionProfileChoices(profiles);
    publish({ profiles: choices });
    return profiles;
  }
  async function block(error, ticket, binding) {
    if (['AUTH', 'FORBIDDEN'].includes(error?.code) && ticket === epoch && bound(binding, accountBinding(store))) {
      await store.tx(s => { if (ticket === epoch && bound(binding, accountBinding(store))) s.settings.connectionBlocked = clone(binding); });
    }
  }
  async function operation(work) {
    if (busy?.ticket === epoch) return busy.promise;
    const ticket = epoch;
    publish({ busy: true, error: '' });
    const current = { ticket, promise: null };
    current.promise = (async () => {
      try { return await work(ticket); }
      catch (error) {
        if (ticket === epoch) {
          await block(error, ticket, accountBinding(store));
          publish({ stage: ['AUTH', 'FORBIDDEN'].includes(error?.code) ? 'blocked' : error?.code === 'STALE_SESSION' ? 'reconnect' : 'error', error: errorText(error) });
        }
        throw Object.assign(Error(errorText(error)), { code: error?.code });
      } finally { if (ticket === epoch) publish({ busy: false }); }
    })().finally(() => { if (busy === current) busy = null; });
    busy = current;
    return current.promise;
  }
  async function syncProfiles(api, ticket, binding) {
    const info = await api.client.pull(); check(ticket, binding);
    if (info.pendingApproval) { publish({ stage: 'pending', deviceFingerprint: info.deviceId, ownerFingerprint: info.ownerFingerprint }); return; }
    const profiles = await readPublic(api, ticket, binding);
    await store.tx(s => {
      check(ticket, binding);
      if (bound(s.settings.connectionBlocked, binding)) delete s.settings.connectionBlocked;
      // A first connection with one usable model needs no duplicate API setup.
      // Existing manual setups and explicit choices are never silently replaced.
      for (const [purpose, local] of [['chat', 'model'], ['speech', 'speech']]) {
        if (s.settings.connectionProfiles?.[purpose] || s.settings.connectionManual?.[purpose] || s.settings[local]?.base) continue;
        const candidates = Object.entries(profiles).filter(([,p]) => p.purpose === purpose && supportsConnectionProfile(p));
        if (candidates.length === 1) s.settings.connectionProfiles = { ...s.settings.connectionProfiles, [purpose]: { ...binding, profileId: candidates[0][0] } };
      }
    });
    check(ticket, binding); publish({ stage: 'ready', deviceFingerprint: info.deviceId, ownerFingerprint: info.ownerFingerprint, lastSync: Date.now() });
  }
  const api = {
    snapshot,
    invalidate({ signedOut = false } = {}) { epoch++; disconnected = signedOut; transport = null; channelBinding = null; publish({ stage: 'disconnected', busy: false, error: '', profiles: [], deviceFingerprint: null, ownerFingerprint: null, lastSync: null }); },
    refresh({ register = false } = {}) {
      return operation(async ticket => {
        if (!native) { publish({ stage: 'native-required' }); return; }
        if (disconnected || !accountBinding(store) || !await vault.get('sync')) { checkEpoch(ticket); publish({ stage: 'disconnected', profiles: [] }); return; }
        const { api, binding } = await channel(ticket);
        if (!await api.capabilities()) { check(ticket, binding); publish({ stage: 'unsupported', error: '', profiles: [] }); return; }
        check(ticket, binding);
        let info;
        if (register) info = await api.client.registerPending();
        else {
          try { info = await api.client.pairingInfo(); }
          catch (error) { if (error?.code !== 'UNPAIRED') throw error; publish({ stage: 'available' }); return; }
        }
        check(ticket, binding);
        publish({ deviceFingerprint: info.deviceId, ownerFingerprint: info.ownerFingerprint });
        if (!info.ownerFingerprint) { publish({ stage: 'pairing' }); return; }
        await syncProfiles(api, ticket, binding);
      });
    },
    async previewPairing(text) { return parseOwnerPairing(text, accountBinding(store), cryptoAPI); },
    pinOwner(pairing, confirmed) {
      return operation(async ticket => {
        if (!confirmed) throw Object.assign(Error('请先核对 Mac 显示的整串指纹。'), { code: 'PAIRING_MISMATCH' });
        const { api, binding } = await channel(ticket);
        const checked = await parseOwnerPairing(JSON.stringify(pairing), binding, cryptoAPI); check(ticket, binding);
        await api.client.pinOwner({ publicJwk: checked.publicJwk, confirmedFingerprint: checked.fingerprint }); check(ticket, binding);
        publish({ ownerFingerprint: checked.fingerprint }); await syncProfiles(api, ticket, binding);
      });
    },
    async choose(purpose, profileId) {
      if (!['chat', 'speech'].includes(purpose)) throw Error('手机暂未启用此用途。');
      const ticket = epoch, binding = accountBinding(store);
      if (profileId) {
        const { api } = await channel(ticket), profiles = await api.activeProfiles(); check(ticket, binding);
        if (bound(store.state.settings.connectionBlocked, binding)) throw Error('设备授权已失效，请先重新配对。');
        if (!profiles[profileId] || profiles[profileId].purpose !== purpose || !supportsConnectionProfile(profiles[profileId])) throw Error('所选配置当前不可用。');
      }
      await store.tx(s => {
        if (ticket !== epoch || (profileId && !bound(binding, accountBinding(store)))) throw stale();
        const selections = { ...s.settings.connectionProfiles };
        const manual = { ...s.settings.connectionManual };
        if (profileId) { selections[purpose] = { ...binding, profileId }; delete manual[purpose]; }
        else { delete selections[purpose]; manual[purpose] = true; }
        s.settings.connectionProfiles = selections;
        s.settings.connectionManual = manual;
      });
      publish({});
    },
    async resolve(purpose) {
      const selection = clone(store.state.settings.connectionProfiles?.[purpose] || null);
      if (!selection) return null;
      const ticket = epoch, { api, binding } = await channel(ticket);
      if (!bound(selection, binding) || bound(store.state.settings.connectionBlocked, binding)) throw stale();
      const profiles = await api.activeProfiles(); check(ticket, binding);
      const profile = profiles[selection.profileId];
      if (!profile || profile.purpose !== purpose || !supportsConnectionProfile(profile)) throw Error('从 Mac 同步的配置已移除或不支持，请在设置中重新选择。');
      if (!equal(selection, store.state.settings.connectionProfiles?.[purpose])) throw stale();
      const captured = clone(profile);
      return { profile: captured, async assertCurrent() {
        check(ticket, binding);
        if (!equal(selection, store.state.settings.connectionProfiles?.[purpose]) || bound(store.state.settings.connectionBlocked, binding)) throw stale();
        const current = await api.activeProfiles(); check(ticket, binding);
        if (!equal(current[selection.profileId], captured)) throw Error('模型配置已更新，请重新发送本次请求。');
      } };
    },
  };
  function checkEpoch(ticket) { if (ticket !== epoch) throw stale(); }
  return Object.freeze(api);
}
