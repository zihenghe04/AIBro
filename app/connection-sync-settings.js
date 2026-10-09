(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ConnectionSyncSettings = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';
  const FOLLOW = 'aibro-connection-export-v1';
  const PROFILES = { chat: 'mac-chat', speech: 'mac-speech' };
  const protocols = ['chat-completions', 'responses'];
  const profileFields = ['format', 'purpose', 'provider', 'authKind', 'apiFormat', 'baseUrl', 'model', 'apiKey'];
  function sameSavedProfile(left, right) {
    // Native dictionaries have no stable key order. Compare the actual schema
    // values; omitted/empty speech language both mean the provider default.
    if (!left || !right || !profileFields.every(key => left[key] === right[key])) return false;
    const language = profile => Object.hasOwn(profile, 'language') ? profile.language : '';
    return language(left) === language(right);
  }
  function parseFollow(raw) {
    try {
      const value = JSON.parse(raw || 'null');
      if (!value || Array.isArray(value) || Object.keys(value).some(key => !['serverOrigin','accountId','apiFormat','speech'].includes(key))
        || typeof value.serverOrigin !== 'string' || typeof value.accountId !== 'string'
        || ('apiFormat' in value && !protocols.includes(value.apiFormat)) || ('speech' in value && value.speech !== true)
        || (!value.apiFormat && value.speech !== true)) return null;
      return value;
    } catch (_) { return null; }
  }
  const errors = {
    UNSUPPORTED: '此同步服务尚未支持模型配置同步，资料同步可以照常使用。',
    STALE_SESSION: '同步登录已变化，请刷新后重新连接。', AUTH: '同步登录已失效，请重新连接服务器。',
    AUTH_REQUIRED: '请先连接同步服务器。', NOT_CONNECTED: '请先连接同步服务器。', FORBIDDEN: '这台设备尚未获准访问配置。',
    UNPAIRED: '请先将这台 Mac 设为配置来源。', OWNER_ONLY: '此账号已由另一台设备管理模型配置。',
    LOCAL_CONFLICT: '本机配置保存未完成，请刷新后重试。', NETWORK: '暂时无法连接同步服务，请稍后重试。',
    CONFLICT: '云端已有更新，请先刷新并处理未确认的操作。', PENDING: '上一项操作尚未确认，请先核对结果。',
    UNTRUSTED_RECIPIENT: '存在尚未在本机核对的设备，未向它发送配置。',
    SOURCE_CHANGED: 'Mac 上的 API 配置已改变，请重新预览。',
    SOURCE_UNAVAILABLE: '请先在模型设置中完整保存 API 地址、模型和 Key。旧钥匙串中的 Key 需要重新填写。',
    SPEECH_SOURCE_UNAVAILABLE: '请先在语音设置中完整保存受支持的语音地址、模型和 Key。本批配置尚未共享，不会改用聊天配置。',
    PAIRING_MISMATCH: '设备指纹不一致，未发送配置。',
  };
  const publicProfiles = profiles => Object.entries(profiles).map(([id, profile]) => ({ id,
    purpose: profile.purpose, provider: profile.provider, apiFormat: profile.apiFormat, baseUrl: profile.baseUrl, model: profile.model, ...(profile.language ? { language: profile.language } : {}) }));
  function createController({ bridge = root.workstationDesktop?.connections, request = root.AIBroDesktopConnections?.createLocalRequest(),
    connect = root.AIBroDesktopConnections?.createDesktopConnectionSync, storage = root.workstationDesktop?.connectionFollowing || root.localStorage,
    clipboard = root.navigator?.clipboard, onChange = () => {}, getProtocol = () => '' } = {}) {
    let adapter, staged, publishingPurposes, disposed = false, epoch = 0, sourceDirty = false, selectionTouched = false;
    let state = { phase: 'idle', busy: false, message: '', failure: false, devices: [], profiles: [], pairingCode: '', apiFormat: '', preview: null, previews: [], following: false, followingPurposes: {chat:false,speech:false}, selectedPurposes: {chat:true,speech:false} };
    const emit = () => onChange(structuredClone(state));
    const follow = () => { try { return parseFollow(storage.getItem(FOLLOW)); } catch (_) { return null; } };
    const matchingFollow = () => { const config = follow(); return config?.serverOrigin === adapter?.binding.serverOrigin && config?.accountId === adapter?.binding.accountId ? config : null; };
    const selected = () => Object.keys(PROFILES).filter(purpose => state.selectedPurposes[purpose]);
    async function saveFollow(config) {
      if (config.apiFormat || config.speech) await storage.setItem(FOLLOW, JSON.stringify(config));
      else await storage.removeItem(FOLLOW);
    }
    function forget() { adapter?.dispose(); adapter = null; staged = null; state.preview = null; state.previews = []; state.pairingCode = ''; state.devices = []; state.profiles = []; state.info = null; state.following = false; state.followingPurposes = {chat:false,speech:false}; }
    async function work(fn) {
      if (state.busy || disposed) return false;
      const token = ++epoch; state.busy = true; state.message = ''; state.failure = false; emit();
      try { await fn(); if (disposed || token !== epoch) return false; return true; }
      catch (error) {
        if (disposed || token !== epoch) return false;
        state.message = errors[error?.code] || '模型配置同步未完成。已保存的资料不受影响，请刷新后重试。'; state.failure = true;
        if (['STALE_SESSION', 'AUTH', 'AUTH_REQUIRED', 'NOT_CONNECTED'].includes(error?.code)) { sourceDirty = false; forget(); state.phase = 'disconnected'; }
        return false;
      } finally { if (!disposed && token === epoch) {
        state.busy = false; emit();
        if (sourceDirty) { sourceDirty = false; if (follow()) queueMicrotask(() => api.sourceChanged()); }
      } }
    }
    async function load() {
      let info;
      try { info = await adapter.client.pairingInfo(); }
      catch (error) { if (error?.code !== 'UNPAIRED') throw error; state.phase = 'ready'; return; }
      if (info.pendingOperation) { state.info = info; state.phase = 'pending'; return; }
      const owner = await adapter.client.ownerState();
      state.info = owner; state.devices = owner.devices.filter(device => device.status !== 'owner');
      state.profiles = publicProfiles(await adapter.activeProfiles()); state.pairingCode = await adapter.pairingCode();
      state.phase = 'owner'; const config = matchingFollow();
      state.following = !!config; state.followingPurposes = {chat:!!config?.apiFormat,speech:config?.speech === true};
      if (config && !selectionTouched) state.selectedPurposes = {...state.followingPurposes};
      if (config?.apiFormat) state.apiFormat = config.apiFormat;
    }
    async function attach() { adapter = await connect({ bridge, request }); await load(); }
    async function refreshInside() {
      forget(); state.phase = 'checking';
      const capability = await request('/__cloud/connections/capabilities', {});
      state.capability = capability;
      if (!capability?.supported) { state.phase = 'unsupported'; return; }
      if (capability.requiresConfirmation) { state.phase = 'confirm-origin'; return; }
      await attach();
    }
    async function exportPurpose(purpose, apiFormat) {
      if (purpose === 'chat') {
        const result = await adapter.exportSavedAPI(apiFormat);
        if (result?.profile?.purpose !== 'chat') throw Object.assign(Error(), {code:'SOURCE_UNAVAILABLE'});
        return result;
      }
      try {
        const result = await adapter.exportSavedSpeech();
        if (result?.profile?.purpose !== 'speech') throw Object.assign(Error(), {code:'SOURCE_UNAVAILABLE'});
        return result;
      }
      catch (error) { if (error?.code === 'SOURCE_UNAVAILABLE' || error?.code === 'UNSUPPORTED') throw Object.assign(Error(), {code:'SPEECH_SOURCE_UNAVAILABLE'}); throw error; }
    }
    async function verifyExports(exports) {
      for (const item of exports) {
        if (item.purpose === 'chat') await adapter.verifySavedAPI(item.sourceDigest, item.profile.apiFormat);
        else await adapter.verifySavedSpeech(item.sourceDigest);
      }
    }
    const changesFor = exports => exports.map(item => ({profileId:PROFILES[item.purpose],profile:item.profile}));
    async function updateSavedInside() {
      if (!adapter || state.phase !== 'owner') return;
      const config = matchingFollow(); if (!config) return;
      const purposes = Object.keys(PROFILES).filter(p => p === 'chat' ? !!config.apiFormat : config.speech === true);
      const exports = [];
      for (const purpose of purposes) exports.push({purpose,...await exportPurpose(purpose, config.apiFormat)});
      const existing = await adapter.activeProfiles();
      if (exports.every(item => sameSavedProfile(existing[PROFILES[item.purpose]], item.profile))) return;
      await verifyExports(exports);
      await adapter.client.saveProfiles(changesFor(exports));
      await load(); state.message = '已同步 Mac 上保存的所选连接配置。';
    }
    const api = {
      refresh: () => work(refreshInside),
      confirmOrigin: () => work(async () => {
        if (state.phase !== 'confirm-origin') return;
        const c = state.capability;
        const next = await request('/__cloud/connections/capabilities', { confirmedOrigin: c.origin, session: c.session });
        if (!next?.supported || next.requiresConfirmation || next.origin !== c.origin) throw Object.assign(Error(), { code: 'STALE_SESSION' });
        state.capability = next; await attach();
      }),
      initialize: () => work(async () => { if (state.phase !== 'ready') return; await adapter.client.initializeOwner(); await load(); }),
      preview: () => work(async () => {
        if (state.phase !== 'owner' || !selected().length || (state.selectedPurposes.chat && !protocols.includes(state.apiFormat))) return;
        // Stage all selected purposes privately before exposing any review.
        const next = [];
        for (const purpose of selected()) next.push({purpose,...await exportPurpose(purpose, state.apiFormat)});
        staged = next; state.previews = publicProfiles(Object.fromEntries(next.map(item => [PROFILES[item.purpose],item.profile])));
        state.preview = state.previews[0];
      }),
      cancelPreview() { if (!state.busy) { staged = null; state.preview = null; state.previews = []; emit(); } },
      publish: () => work(async () => {
        if (!staged || !state.preview) return;
        const current = staged;
        publishingPurposes = new Set(current.map(item => item.purpose));
        try {
          await verifyExports(current);
          await adapter.client.saveProfiles(changesFor(current));
          const config = {...adapter.binding,...(matchingFollow() || {})};
          for (const item of current) { if (item.purpose === 'chat') config.apiFormat = item.profile.apiFormat; else config.speech = true; }
          await saveFollow(config);
          staged = null; state.preview = null; state.previews = []; await load();
          state.message = '所选配置已加密同步；以后保存这些用途的修改时会继续同步。未选择的用途不会被新共享。';
        } finally { publishingPurposes = null; }
      }),
      approve: (deviceId, confirmed) => work(async () => {
        if (confirmed !== true || !state.devices.some(device => device.deviceId === deviceId && device.status === 'pending')) return;
        await adapter.client.approveDevice({ deviceId, confirmedFingerprint: deviceId }); await load(); state.message = '已批准这台手机。返回手机刷新即可使用配置。';
      }),
      revoke: (deviceId, confirmed) => work(async () => {
        if (confirmed !== true || !state.devices.some(device => device.deviceId === deviceId && ['pending', 'approved'].includes(device.status))) return;
        await adapter.client.rotateAndRevoke([deviceId]); await load(); state.message = '已撤销设备并更新配置加密密钥。该设备已获取的 API Key 如需作废，请在服务商处轮换。';
      }),
      retry: () => work(async () => { if (!adapter) return; await adapter.client.retryPending(); await load(); }),
      remove: (purpose = 'chat') => work(async () => {
        if (!Object.hasOwn(PROFILES, purpose) || !state.profiles.some(item => item.id === PROFILES[purpose])) return;
        // Persist this purpose's opt-out before any network mutation. Another
        // opted-in purpose remains intact even if the delete ACK is lost.
        const config = {...adapter.binding,...(matchingFollow() || {})};
        if (purpose === 'chat') delete config.apiFormat; else delete config.speech;
        await saveFollow(config); if (!config.apiFormat && !config.speech) sourceDirty = false;
        state.following = !!(config.apiFormat || config.speech);
        state.followingPurposes = {chat:!!config.apiFormat,speech:config.speech === true};
        await adapter.client.saveProfiles([{ profileId: PROFILES[purpose], profile: null }]);
        await load(); state.message = `已停止共享${purpose === 'chat' ? '对话' : '语音'}配置，手机下次同步时将移除它。此 Mac 的原配置保留。`;
      }),
      copy: () => work(async () => {
        if (!state.pairingCode) return;
        await clipboard.writeText(state.pairingCode); state.message = '已复制配对信息。在手机的模型配置同步中粘贴并核对指纹。';
      }),
      protocol(value) { if (!state.busy && !staged && ['chat-completions', 'responses'].includes(value)) { state.apiFormat = value; emit(); } },
      purpose(purpose, enabled) { if (!state.busy && !staged && Object.hasOwn(PROFILES,purpose) && typeof enabled === 'boolean') { selectionTouched = true; state.selectedPurposes = {...state.selectedPurposes,[purpose]:enabled}; emit(); } },
      sourceChanged(purpose) {
        if (disposed) return Promise.resolve(false);
        // The first explicit publish has no durable FOLLOW yet. Remember only
        // its selected purposes; work() rechecks FOLLOW before any later read.
        if (state.busy && publishingPurposes && (purpose === undefined || publishingPurposes.has(purpose))) {
          sourceDirty = true; return Promise.resolve(false);
        }
        const config = follow();
        if (!config || (purpose === 'chat' && !config.apiFormat) || (purpose === 'speech' && !config.speech)) return Promise.resolve(false);
        if (state.busy) { sourceDirty = true; return Promise.resolve(false); }
        return work(async () => { await refreshInside(); await updateSavedInside(); });
      },
      dispose() { disposed = true; sourceDirty = false; epoch++; forget(); },
    };
    const initialProtocol = getProtocol();
    state.apiFormat = initialProtocol === 'responses' ? 'responses' : initialProtocol === 'chat' ? 'chat-completions' : '';
    emit(); return Object.freeze(api);
  }
  let mounted;
  function init(options = {}) {
    if (mounted || !root.workstationDesktop?.connections || !root.HalaskaUI) return;
    const doc = root.document, panel = doc.getElementById('settings-panel-sync'); if (!panel) return;
    const host = doc.createElement('article'); host.id = 'connectionSyncSettings'; host.className = 'card'; panel.append(host);
    let island, controller, latest, readyPending = false, readyQueued = false, stopped = false;
    const isVisible = () => !panel.hidden && doc.getElementById('settings')?.classList.contains('active-view');
    const followsSavedAPI = purpose => { try { const config = parseFollow((root.workstationDesktop.connectionFollowing || root.localStorage).getItem(FOLLOW)); return !!config && (!purpose || (purpose === 'chat' ? !!config.apiFormat : config.speech === true)); } catch (_) { return false; } };
    // Readiness is one extra check, not a retained adapter or retry loop. It may
    // arrive while the first native call is still rejecting its pre-ready lease.
    const scheduleReadyCheck = () => {
      if (stopped || !readyPending || readyQueued || latest?.busy) return;
      readyQueued = true;
      queueMicrotask(() => {
        readyQueued = false;
        if (stopped || !readyPending || latest?.busy) return;
        readyPending = false;
        if (followsSavedAPI()) controller.sourceChanged();
        else if (isVisible()) controller.refresh();
      });
    };
    const callbacks = { onRefresh: () => controller.refresh(), onConfirmOrigin: () => controller.confirmOrigin(), onInitialize: () => controller.initialize(),
      onPreview: () => controller.preview(), onPublish: () => controller.publish(), onCancelPreview: () => controller.cancelPreview(),
      onApprove: (id, confirmed) => controller.approve(id, confirmed), onRevoke: (id, confirmed) => controller.revoke(id, confirmed),
      onRetry: () => controller.retry(), onRemove: purpose => controller.remove(purpose), onCopy: () => controller.copy(), onProtocol: value => controller.protocol(value), onPurpose: (purpose,enabled) => controller.purpose(purpose,enabled) };
    controller = createController({ ...options, onChange: state => { latest = state; if (island) island.update({ state }); scheduleReadyCheck(); } });
    island = root.HalaskaUI.mount(host, 'ConnectionSyncSettingsSurface', { state: latest, ...callbacks });
    let visible = isVisible();
    const refreshVisible = () => {
      const next = isVisible();
      if (next && !visible) controller.refresh(); visible = next;
    };
    const observer = new MutationObserver(refreshVisible); observer.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    observer.observe(doc.getElementById('settings'), { attributes: true, attributeFilter: ['class'] });
    root.addEventListener('focus', () => { if (followsSavedAPI() || latest?.busy) controller.sourceChanged(); else if (visible) controller.refresh(); });
    // The controller also recognizes an explicit first publish in flight;
    // gating here on persisted FOLLOW would discard those save notifications.
    root.addEventListener('aibro-api-credentials-saved', () => controller.sourceChanged('chat'));
    root.addEventListener('aibro-speech-credentials-saved', () => controller.sourceChanged('speech'));
    // The native host sends this after accepting the initial workspace snapshot.
    // Its credentials bridge intentionally rejects calls before that point.
    doc.addEventListener('aibro-agenda-changed', () => { readyPending = true; scheduleReadyCheck(); }, { once: true });
    root.addEventListener('pagehide', () => { stopped = true; readyPending = false; observer.disconnect(); controller.dispose(); }, { once: true });
    mounted = { controller, island }; if (followsSavedAPI()) controller.sourceChanged(); else if (visible) controller.refresh();
  }
  return Object.freeze({ createController, init });
});
