(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./connection-sync-client'));
  else root.AIBroDesktopConnections = factory(root.AIBroConnectionSyncClient);
})(typeof globalThis === 'object' ? globalThis : this, function (shared) {
  'use strict';
  const clone = value => structuredClone(value);
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const fingerprint = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
  const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
  const operations = new Set(['initialize', 'register', 'status', 'read', 'owner_state', 'commit', 'approve', 'rotate_and_revoke', 'operation_result']);
  function stale() { throw Object.assign(new Error('同步账号或连接已经变化，请重新打开连接配置。'), { code: 'STALE_SESSION' }); }
  function validateSnapshot(value) {
    const s = value?.session, t = value?.transport;
    if (!s || !t || !identifier(s.accountId) || !identifier(s.sessionId) || !fingerprint(s.nativeFence)
      || !fingerprint(t.sessionGeneration) || !Number.isSafeInteger(s.generation) || s.generation < 1) stale();
    let origin, transport;
    try { origin = new URL(s.serverOrigin); transport = new URL(t.serverUrl); } catch (_) { stale(); }
    const allowed = url => url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    if (!allowed(origin) || !allowed(transport) || origin.origin !== s.serverOrigin || origin.username || origin.password
      || transport.username || transport.password || transport.search || transport.hash) stale();
    return { session: { serverOrigin: s.serverOrigin, accountId: s.accountId, sessionId: s.sessionId,
      generation: s.generation, nativeFence: s.nativeFence }, transport: { serverUrl: t.serverUrl, sessionGeneration: t.sessionGeneration } };
  }
  function createLocalRequest(fetcher = globalThis.fetch?.bind(globalThis)) {
    return async function request(path, payload) {
      if (!['/__cloud/connections/capabilities', '/__cloud/connections/transport'].includes(path)) stale();
      const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 45000);
      try {
        const response = await fetcher(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload), signal: abort.signal, cache: 'no-store' });
        const body = await response.json();
        if (!response.ok) throw Object.assign(new Error('连接配置请求未完成。'), { status: response.status, code: body?.code });
        return body;
      } finally { clearTimeout(timer); }
    };
  }
  async function createDesktopConnectionSync({ bridge = globalThis.workstationDesktop?.connections,
    request = createLocalRequest(), cryptoProvider = globalThis.crypto,
    createClient = shared?.createConnectionSyncClient } = {}) {
    if (!bridge || typeof createClient !== 'function') throw Object.assign(new Error('请使用已更新的 Mac 客户端。'), { code: 'UNSUPPORTED' });
    async function native(action, options) {
      try { return await bridge[action](options); }
      catch (error) {
        const code = { CONNECTION_SESSION_CHANGED: 'STALE_SESSION', CONNECTION_STORAGE_ERROR: 'LOCAL_CONFLICT',
          CONNECTION_SOURCE_CHANGED: 'SOURCE_CHANGED', CONNECTION_SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE' }[error?.code] || 'INVALID';
        throw Object.assign(new Error('本机连接配置操作未完成。'), { code });
      }
    }
    const captured = validateSnapshot(await native('sessionSnapshot'));
    let alive = true;
    const currentSession = () => { if (!alive) stale(); return clone(captured.session); };
    async function guard() {
      currentSession();
      const latest = validateSnapshot(await native('sessionSnapshot'));
      if (!equal(captured, latest)) { alive = false; stale(); }
      currentSession();
    }
    const atomicVault = {
      read: (binding, { sessionFence }) => native('read', { binding, sessionFence }),
      compareAndSwap: async args => (await native('compareAndSwap', args)).swapped === true,
    };
    const client = createClient({ cryptoProvider, atomicVault, currentSession,
      transport: async ({ operation, session, deviceId, deviceSecret, payload }) => {
        const s = captured.session;
        if (!operations.has(operation) || !fingerprint(deviceId) || !fingerprint(deviceSecret)
          || session.serverOrigin !== s.serverOrigin || session.accountId !== s.accountId
          || session.sessionId !== s.sessionId || session.generation !== s.generation) stale();
        await guard();
        try {
          const result = await request('/__cloud/connections/transport', {
            session: { serverOrigin: s.serverOrigin, accountId: s.accountId, sessionId: s.sessionId, ...captured.transport },
            operation, deviceId, deviceSecret, payload,
          });
          await guard();
          // The local route preserves the remote status, without credentials.
          if (!Number.isInteger(result?.status) || !result.body || typeof result.body !== 'object') return { status: 503, body: {} };
          return result;
        } catch (error) { await guard(); return { status: Number.isInteger(error?.status) ? error.status : 503, body: {} }; }
      },
    });
    return Object.freeze({ client, binding: Object.freeze({ serverOrigin: captured.session.serverOrigin, accountId: captured.session.accountId }),
      dispose() { alive = false; },
      async activeProfiles() {
        await guard();
        const { value } = await atomicVault.read({ serverOrigin: captured.session.serverOrigin, accountId: captured.session.accountId }, { sessionFence: currentSession() });
        await guard(); return clone(value?.activeProfiles || {});
      },
      async pairingCode() {
        await guard(); const info = await client.pairingInfo(); await guard();
        return JSON.stringify({ format: 'aibro.connection-pairing.v1', serverOrigin: captured.session.serverOrigin,
          accountId: captured.session.accountId, publicJwk: info.publicJwk, fingerprint: info.deviceId });
      },
      async exportSavedAPI(apiFormat) { await guard(); const value = await native('exportSavedAPI', { apiFormat }); await guard(); return value; },
      async verifySavedAPI(sourceDigest, apiFormat) { await guard(); await native('verifySavedAPI', { sourceDigest, apiFormat }); await guard(); },
      async exportSavedSpeech() { await guard(); const value = await native('exportSavedSpeech', {}); await guard(); return value; },
      async verifySavedSpeech(sourceDigest) { await guard(); await native('verifySavedSpeech', { sourceDigest }); await guard(); },
    });
  }
  return Object.freeze({ createDesktopConnectionSync, createLocalRequest });
});
