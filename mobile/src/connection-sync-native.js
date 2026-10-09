// Native-only binding adapter. A captured cloud session and native fence travel
// together; a late result cannot acquire a fresh fence or switch credentials.
const operations = new Set(['initialize', 'register', 'status', 'read', 'owner_state', 'commit', 'approve', 'rotate_and_revoke', 'operation_result']);
const message = '同步登录状态已变化，请重新连接后再同步模型配置。';
function stale() { throw Object.assign(Error(message), { code: 'STALE_SESSION' }); }
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const validFingerprint = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const clone = value => structuredClone(value);

export async function createNativeConnectionSync({ store, vault, bridge, http, native,
  cryptoProvider = globalThis.crypto, createClient = globalThis.AIBroConnectionSyncClient?.createConnectionSyncClient }) {
  if (!native || typeof createClient !== 'function') throw Error('连接配置同步需要原生 AI Bro 客户端。');
  await store.tail;
  const binding = clone(store.state.binding), raw = await vault.get('sync');
  let credentials; try { credentials = JSON.parse(raw); } catch { stale(); }
  if (!binding || !credentials || !validId(credentials.accountId) || !validId(credentials.sessionId)
    || typeof credentials.token !== 'string' || !credentials.token || /[\s\u0000-\u001f\u007f]/.test(credentials.token)) stale();
  let base; try { base = new URL(credentials.base); } catch { stale(); }
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/'
    || !(base.protocol === 'https:' || (base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) stale();
  const serverOrigin = base.origin;
  const matches = () => {
    const b = store.state.binding;
    return b?.base === credentials.base && b?.accountID === credentials.accountId && b?.deviceID === credentials.sessionId;
  };
  if (!matches()) stale();
  const expectedSyncSha256 = [...new Uint8Array(await cryptoProvider.subtle.digest('SHA-256', new TextEncoder().encode(raw)))].map(x => x.toString(16).padStart(2, '0')).join('');
  const initial = await bridge.connectionSessionFence({ expectedSyncSha256 });
  if (!matches() || !validFingerprint(initial?.fence)) stale();
  const session = { serverOrigin, accountId: credentials.accountId, sessionId: credentials.sessionId, generation: 1, nativeFence: initial.fence };
  const currentSession = () => { if (!matches()) stale(); return clone(session); };
  async function guard() {
    currentSession();
    const result = await bridge.connectionSessionFence({ expectedSyncSha256 });
    if (result?.fence !== session.nativeFence) stale();
    currentSession();
  }
  const atomicVault = {
    read: (requestedBinding, { sessionFence } = {}) => bridge.connectionVaultRead({ binding: requestedBinding, sessionFence }),
    compareAndSwap: async args => (await bridge.connectionVaultCompareAndSwap(args)).swapped === true,
  };
  const transport = async ({ operation, session: requested, deviceId, deviceSecret, payload }) => {
    // The shared coordinator strips nativeFence from its HTTP session metadata.
    if (!operations.has(operation) || !validFingerprint(deviceId) || !validFingerprint(deviceSecret)
      || requested?.serverOrigin !== serverOrigin || requested?.accountId !== session.accountId
      || requested?.sessionId !== session.sessionId || requested?.generation !== session.generation) stale();
    await guard();
    try {
      const body = await http(serverOrigin + '/v1/connections/' + operation, { method: 'POST',
        headers: { Authorization: 'Bearer ' + credentials.token, 'X-AIBro-Connection-Device': deviceId,
          'X-AIBro-Connection-Secret': deviceSecret }, body: payload });
      await guard();
      return { status: 200, body };
    } catch (error) {
      await guard();
      // Error response bodies can echo inputs. Only the coordinator's fixed
      // messages and the HTTP status leave this adapter.
      return { status: Number.isInteger(error?.status) ? error.status : 503, body: {} };
    }
  };
  const client = createClient({ cryptoProvider, transport, atomicVault, currentSession });
  return Object.freeze({ client,
    async capabilities() {
      await guard();
      let result;
      try { result = await http(serverOrigin + '/v1/sync/capabilities', {headers:{Authorization:'Bearer ' + credentials.token}}); }
      catch (error) {
        await guard();
        if ([404,405,501].includes(error?.status)) return false;
        const code = error?.status === 401 ? 'AUTH' : error?.status === 403 ? 'FORBIDDEN' : 'NETWORK';
        throw Object.assign(Error('无法检查模型配置同步。'), {code});
      }
      await guard();
      return result?.encryptedConnectionProfiles?.version === 1 && result.encryptedConnectionProfiles.origin === serverOrigin;
    },
    async activeProfiles() {
      const { value } = await atomicVault.read({serverOrigin, accountId:session.accountId}, {sessionFence:currentSession()});
      await guard();
      return clone(value?.activeProfiles || {});
    },
  });
}
