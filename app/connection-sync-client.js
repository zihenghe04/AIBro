(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./connection-vault'));
  else root.AIBroConnectionSyncClient = factory(root.AIBroConnectionVault);
})(typeof globalThis === 'object' ? globalThis : this, function (vaultAPI) {
  'use strict';

  const FORMAT = 'aibro.connection-sync-local.v1';
  const encoder = new TextEncoder();
  const copy = value => structuredClone(value);
  const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
  const canonical = value => JSON.stringify(sorted(value));
  const same = (a, b) => canonical(a) === canonical(b);
  const own = (map, key) => Object.hasOwn(map, key) ? map[key] : undefined;
  const publicKey = key => Object.fromEntries(['crv', 'kty', 'x', 'y'].map(name => [name, key[name]]));
  class ConnectionSyncClientError extends Error {
    constructor(code) {
      super({ INVALID: '连接同步数据格式无效。', STALE_SESSION: '账号或登录会话已经变化，未应用配置。',
        LOCAL_CONFLICT: '本机安全配置已变化或保存失败，未激活新配置。', UNSUPPORTED: '此服务器尚未支持连接配置同步；资料同步不受影响。',
        AUTH: '连接设备认证失败，请重新连接。', FORBIDDEN: '设备未获批准或无写入权限。',
        CONFLICT: '云端配置已变化，冻结的操作需重新核对。', NETWORK: '连接同步尚未完成，可重试已冻结操作。',
        UNPAIRED: '请先核对并固定可信主设备指纹。', ROLLBACK: '服务器返回旧版本或改变了同版本内容，未应用。',
        PENDING: '存在尚未确认的配置操作，请先重试。', OWNER_ONLY: '只有固定主设备可以写入连接配置。',
        UNTRUSTED_RECIPIENT: '云端列出的接收设备尚未在本机核对指纹，未发送配置密钥。',
        PAIRING_MISMATCH: '设备公钥与用户确认的指纹不一致。' }[code] || '连接同步未完成。');
      this.name = 'ConnectionSyncClientError'; this.code = code;
    }
  }
  function fail(code = 'INVALID') { throw new ConnectionSyncClientError(code); }
  function fields(value, keys, optional = []) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
        Object.keys(value).some(key => !keys.includes(key) && !optional.includes(key)) ||
        keys.some(key => !Object.hasOwn(value, key))) fail();
  }
  function id(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) fail(); return value; }
  function integer(value, zero = false) { if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) fail(); return value; }
  function encode(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function decode(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) fail();
    const raw = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='), x => x.charCodeAt(0));
    if (raw.length !== 32 || encode(raw) !== value) fail();
    return raw;
  }
  function binding(session) { return { serverOrigin: session.serverOrigin, accountId: session.accountId }; }
  function context(session, profileId, epoch, version) {
    return vaultAPI.normalizeContext({ ...binding(session), profileId, epoch, version });
  }

  /** No ordinary Store or standalone activation callback is accepted.
   * atomicVault.read(binding,{sessionFence}) -> {revision,value|null}.
   * atomicVault.compareAndSwap({binding,expectedRevision,value,sessionFence}) -> boolean.
   * The native implementation MUST validate the current cloud credential/session
   * fence at its commit point and atomically replace this entire secure bundle.
   * value.activeProfiles is the sole active base/model/key snapshot; selection IDs
   * may live elsewhere, but no separate config/key mutation is permitted.
   * transport({operation,session,deviceId,deviceSecret,payload}) -> {status,body}.
   * It MUST attach the captured session's cloud authentication as well as the
   * separate deviceSecret. No authentication token is part of this protocol data.
   * currentSession may include nativeFence. Native adapters MUST supply it and
   * pass it to both native read/CAS; omission is for isolated injected tests only.
   * Owner recipient pins are established only by a confirmed approval. Legacy
   * local bundles without pins fail closed; manual pin recovery is not exposed.
   */
  function createConnectionSyncClient({ cryptoProvider = globalThis.crypto, transport, atomicVault, currentSession }) {
    if (!vaultAPI || typeof transport !== 'function' || typeof currentSession !== 'function' ||
        typeof atomicVault?.read !== 'function' || typeof atomicVault?.compareAndSwap !== 'function') fail();
    const crypto = vaultAPI.createConnectionVault(cryptoProvider);
    let tail = Promise.resolve();
    function snapshot() {
      const s = copy(currentSession());
      fields(s, ['serverOrigin', 'accountId', 'sessionId', 'generation'], ['nativeFence']);
      id(s.accountId); id(s.sessionId); integer(s.generation);
      if (Object.hasOwn(s, 'nativeFence')) decode(s.nativeFence);
      if (context(s, 'validation', 1, 1).serverOrigin !== s.serverOrigin) fail();
      return s;
    }
    function check(s) {
      let current; try { current = snapshot(); } catch (_) { fail('STALE_SESSION'); }
      if (!same(current, s)) fail('STALE_SESSION');
    }
    function run(work) {
      const s = snapshot();
      const next = tail.catch(() => {}).then(async () => { check(s); return work(s); });
      tail = next.catch(() => {}); return next;
    }
    async function load(s) {
      check(s); const entry = copy(await atomicVault.read(binding(s), { sessionFence: copy(s) })); check(s);
      fields(entry, ['revision', 'value']); integer(entry.revision, true);
      if (entry.value) {
        const state = entry.value;
        fields(state, ['format', 'binding', 'role', 'device', 'trustedOwner', 'registeredSessionId', 'status',
          'epoch', 'revision', 'profiles', 'activeProfiles', 'pending'], ['trustedRecipients']);
        if (state.format !== FORMAT || !same(state.binding, binding(s)) || !['owner', 'reader'].includes(state.role)) fail();
        integer(state.epoch, true); integer(state.revision, true); decode(state.device.secret);
        if (await crypto.fingerprintPublicKey(state.device.publicJwk) !== state.device.fingerprint) fail();
        // Older local bundles have no recipient consent evidence. Do not learn
        // it from the server's approved flag; require an explicit new comparison.
        state.trustedRecipients ??= {};
        fields(state.trustedRecipients, [], Object.keys(state.trustedRecipients));
        if (Object.keys(state.trustedRecipients).length > 15) fail();
        for (const [fingerprint, pin] of Object.entries(state.trustedRecipients)) {
          fields(pin, ['publicJwk', 'fingerprint']);
          if (pin.fingerprint !== fingerprint || await crypto.fingerprintPublicKey(pin.publicJwk) !== fingerprint) fail();
          check(s);
        }
        check(s);
      }
      return entry;
    }
    async function commitLocal(s, entry, next) {
      check(s);
      let ok;
      try { ok = await atomicVault.compareAndSwap({ binding: binding(s), expectedRevision: entry.revision,
        value: copy(next), sessionFence: copy(s) }); }
      catch (_) { check(s); fail('LOCAL_CONFLICT'); }
      check(s); if (ok !== true) fail('LOCAL_CONFLICT');
      return { revision: entry.revision + 1, value: copy(next) };
    }
    async function request(s, state, operation, payload = {}) {
      check(s); let response;
      const cloudSession = copy(s); delete cloudSession.nativeFence;
      try { response = await transport({ operation, session: cloudSession, deviceId: state.device.fingerprint,
        deviceSecret: state.device.secret, payload: copy(payload) }); }
      catch (_) { check(s); fail('NETWORK'); }
      check(s);
      if (response?.status === 404) fail('UNSUPPORTED');
      if (response?.status === 401) fail('AUTH');
      if (response?.status === 403) fail('FORBIDDEN');
      if (response?.status === 409) fail('CONFLICT');
      if (response?.status !== 200 || !response.body || typeof response.body !== 'object') fail('NETWORK');
      return copy(response.body);
    }
    function statusValid(value, state) {
      fields(value, ['epoch', 'revision', 'deviceId', 'status']);
      integer(value.epoch); integer(value.revision);
      if (value.deviceId !== state.device.fingerprint || !['owner', 'pending', 'approved'].includes(value.status)) fail();
      if (value.epoch < state.epoch || value.revision < state.revision) fail('ROLLBACK');
      if ((state.role === 'owner') !== (value.status === 'owner')) fail('FORBIDDEN');
    }
    function publicState(state) {
      return { deviceId: state.device.fingerprint, publicJwk: copy(state.device.publicJwk), status: state.status,
        ownerFingerprint: state.trustedOwner?.fingerprint || null, epoch: state.epoch, revision: state.revision,
        profileIds: Object.keys(state.profiles), pendingOperation: state.pending?.payload.opId || null };
    }
    async function enroll(s, role) {
      let entry = await load(s);
      if (!entry.value) {
        const pair = await crypto.generateDeviceKeyPair(); check(s);
        // Device authentication and E2EE configuration keys are independently random.
        const secret = encode(cryptoProvider.getRandomValues(new Uint8Array(32)));
        const state = { format: FORMAT, binding: binding(s), role,
          device: { ...pair, secret }, trustedOwner: role === 'owner' ? { publicJwk: pair.publicJwk, fingerprint: pair.fingerprint } : null,
          registeredSessionId: null, status: 'local', epoch: 0, revision: 0, profiles: {}, activeProfiles: {},
          trustedRecipients: {}, pending: null };
        entry = await commitLocal(s, entry, state);
      }
      if (entry.value.role !== role) fail('OWNER_ONLY');
      const state = copy(entry.value);
      if (state.registeredSessionId !== s.sessionId) {
        const remote = await request(s, state, role === 'owner' ? 'initialize' : 'register', { publicJwk: state.device.publicJwk });
        statusValid(remote, state);
        state.registeredSessionId = s.sessionId; state.status = remote.status;
        // The immutable payload retains its original CAS baseline. These fields
        // retain the highest observed head, including while an ACK is uncertain.
        state.epoch = remote.epoch; state.revision = remote.revision;
        entry = await commitLocal(s, entry, state);
      }
      return entry;
    }
    async function existing(s, owner = false) {
      const entry = await load(s); if (!entry.value) fail('UNPAIRED');
      if (owner && entry.value.role !== 'owner') fail('OWNER_ONLY');
      return enroll(s, entry.value.role);
    }
    async function digest(value) { return encode(new Uint8Array(await cryptoProvider.subtle.digest('SHA-256', encoder.encode(canonical(value))))); }
    async function decodeRemote(s, state, remote, owner) {
      fields(remote, ['epoch', 'revision', 'deviceId', 'status', 'ownerFingerprint', 'profiles'], owner ? ['devices'] : []);
      statusValid({ epoch: remote.epoch, revision: remote.revision, deviceId: remote.deviceId, status: remote.status }, state);
      if (!state.trustedOwner || state.trustedOwner.fingerprint !== remote.ownerFingerprint) fail('UNPAIRED');
      if (!Array.isArray(remote.profiles) || remote.profiles.length > 32) fail();
      const profiles = {}, activeProfiles = {};
      for (const row of remote.profiles) {
        fields(row, ['profileId', 'version', 'epoch', 'deleted', 'envelope', 'wrap']);
        id(row.profileId); integer(row.version); integer(row.epoch);
        if (Object.hasOwn(profiles, row.profileId) || row.epoch !== remote.epoch || typeof row.deleted !== 'boolean') fail();
        const old = own(state.profiles, row.profileId);
        const hash = await digest({ deleted: row.deleted, envelope: row.envelope }); check(s);
        if (old && (row.version < old.version || row.epoch < old.epoch ||
          (row.version === old.version && (row.epoch !== old.epoch || hash !== old.hash)))) fail('ROLLBACK');
        if (row.deleted) {
          if (row.envelope !== null || row.wrap !== null) fail();
          profiles[row.profileId] = { epoch: row.epoch, version: row.version, deleted: true, hash };
        } else {
          const expectedContext = context(s, row.profileId, remote.epoch, row.version);
          const key = await crypto.unwrapConfigurationKey({ envelope: row.wrap, recipientPrivateJwk: state.device.privateJwk,
            trustedSenderPublicJwk: state.trustedOwner.publicJwk, expectedContext }); check(s);
          try {
            const profile = await crypto.decryptProfile({ envelope: row.envelope, configurationKey: key, expectedContext }); check(s);
            profiles[row.profileId] = { epoch: row.epoch, version: row.version, deleted: false, hash, key: encode(key), profile };
            activeProfiles[row.profileId] = profile;
          } finally { key.fill(0); }
        }
      }
      if (Object.keys(state.profiles).some(key => !Object.hasOwn(profiles, key))) fail('ROLLBACK');
      const next = { ...state, status: remote.status, epoch: remote.epoch, revision: remote.revision, profiles, activeProfiles };
      let devices = [];
      if (owner) {
        if (!Array.isArray(remote.devices) || remote.devices.length > 16) fail();
        const seen = new Set();
        for (const item of remote.devices) {
          fields(item, ['deviceId', 'status', 'publicJwk']);
          if (!['owner', 'pending', 'approved', 'revoked'].includes(item.status) || seen.has(item.deviceId) ||
            await crypto.fingerprintPublicKey(item.publicJwk) !== item.deviceId) fail();
          check(s); seen.add(item.deviceId); devices.push(copy(item));
        }
        const owners = devices.filter(item => item.status === 'owner');
        if (owners.length !== 1 || owners[0].deviceId !== state.device.fingerprint) fail();
      }
      return { next, devices };
    }
    async function fetchState(s, owner = false) {
      let entry = await existing(s, owner), state = entry.value;
      if (state.pending) fail('PENDING');
      const status = await request(s, state, 'status'); statusValid(status, state);
      if (status.status === 'pending') return { entry, devices: [], pending: true };
      if (!state.trustedOwner) fail('UNPAIRED');
      const remote = await request(s, state, owner ? 'owner_state' : 'read', { epoch: status.epoch });
      if (remote.epoch !== status.epoch || remote.revision < status.revision) fail('ROLLBACK');
      const decoded = await decodeRemote(s, state, remote, owner);
      entry = await commitLocal(s, entry, decoded.next);
      return { entry, devices: decoded.devices, pending: false };
    }
    async function freeze(s, entry, operation, payload, candidate) {
      if (entry.value.pending) fail('PENDING');
      if (encoder.encode(JSON.stringify(payload)).length > 2 * 1024 * 1024) fail();
      const next = { ...entry.value, pending: { operation, payload: copy(payload), candidate: copy(candidate) } };
      return commitLocal(s, entry, next);
    }
    function trustedRecipients(state, devices) {
      return devices.map(device => {
        const expected = device.status === 'owner' && device.deviceId === state.device.fingerprint
          ? state.device : own(state.trustedRecipients, device.deviceId);
        if (!expected || expected.fingerprint !== device.deviceId ||
            !same(publicKey(expected.publicJwk), publicKey(device.publicJwk))) fail('UNTRUSTED_RECIPIENT');
        return device;
      });
    }
    function validatePendingRecipients(state, pending) {
      const pins = pending.operation === 'approve' ? pending.candidate.trustedRecipients : state.trustedRecipients;
      const wraps = pending.operation === 'approve' ? pending.payload.wraps : pending.payload.profiles.flatMap(row => row.wraps);
      for (const wrap of wraps) {
        if (wrap.recipientFingerprint !== state.device.fingerprint && !own(pins || {}, wrap.recipientFingerprint)) fail('UNTRUSTED_RECIPIENT');
      }
    }
    async function observeHead(s, entry, head) {
      statusValid({ epoch: head.epoch, revision: head.revision, deviceId: entry.value.device.fingerprint,
        status: entry.value.status }, entry.value);
      if (entry.value.epoch === head.epoch && entry.value.revision === head.revision) return entry;
      return commitLocal(s, entry, { ...entry.value, epoch: head.epoch, revision: head.revision });
    }
    async function sendPending(s, entry) {
      let state = entry.value; const pending = state.pending;
      if (!pending || state.role !== 'owner') fail('PENDING');
      validatePendingRecipients(state, pending);
      let ack;
      try { ack = await request(s, state, pending.operation, pending.payload); }
      catch (error) {
        if (error.code !== 'CONFLICT') throw error;
        // Rotation deliberately refuses old-epoch mutation replay. Only a
        // current-epoch, exact-payload receipt can settle an uncertain result.
        const current = await request(s, state, 'status'); statusValid(current, state);
        entry = await observeHead(s, entry, current); state = entry.value;
        const kind = pending.operation === 'rotate_and_revoke' ? 'rotate' : pending.operation;
        const hashBytes = new Uint8Array(await cryptoProvider.subtle.digest('SHA-256', encoder.encode(canonical([kind, pending.payload]))));
        check(s);
        const requestHash = [...hashBytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
        const result = await request(s, state, 'operation_result', { epoch: current.epoch, opId: pending.payload.opId, requestHash });
        integer(result.epoch); integer(result.revision);
        if (result.epoch !== current.epoch || result.revision < current.revision) fail('ROLLBACK');
        if (result.status === 'unknown') {
          fields(result, ['epoch', 'revision', 'status', 'opId']);
          if (result.opId !== pending.payload.opId) fail();
          await observeHead(s, entry, result);
          fail('CONFLICT'); // Keep pending and old activation; never infer success.
        }
        fields(result, ['epoch', 'revision', 'status', 'receipt']);
        if (result.status !== 'committed' || result.receipt?.epoch !== result.epoch || result.receipt?.revision > result.revision) fail();
        entry = await observeHead(s, entry, result); state = entry.value;
        ack = result.receipt;
      }
      fields(ack, ['epoch', 'revision', 'opId', 'replayed']);
      const epoch = pending.payload.newEpoch || pending.payload.expectedEpoch;
      if (ack.epoch !== epoch || ack.revision !== pending.payload.expectedRevision + 1 ||
          ack.opId !== pending.payload.opId || typeof ack.replayed !== 'boolean') fail();
      // An idempotent receipt proves only that this operation once committed.
      // It is not a snapshot of the latest configuration after other writes.
      if (ack.replayed) {
        const current = await request(s, state, 'status'); statusValid(current, state);
        entry = await observeHead(s, entry, current); state = entry.value;
      }
      if (ack.epoch < state.epoch || ack.revision < state.revision) fail('CONFLICT');
      const next = { ...state, ...copy(pending.candidate), epoch: ack.epoch, revision: ack.revision, pending: null };
      const committed = await commitLocal(s, entry, next);
      return publicState(committed.value);
    }
    async function encryptedUpdate(s, state, profileId, profile, epoch, version, recipients, rotate = false) {
      const old = own(state.profiles, profileId), baseVersion = old?.version || 0;
      if (profile === null) {
        if (!old) fail();
        return { wire: { profileId, baseVersion, version, deleted: true, envelope: null, wraps: [] },
          record: { epoch, version, deleted: true, hash: await digest({ deleted: true, envelope: null }) } };
      }
      profile = vaultAPI.normalizeProfile(profile);
      const key = !rotate && old && !old.deleted ? decode(old.key) : crypto.generateConfigurationKey();
      try {
        const ctx = context(s, profileId, epoch, version);
        const envelope = await crypto.encryptProfile({ profile, configurationKey: key, context: ctx }); check(s);
        const wraps = [];
        for (const device of recipients) {
          wraps.push(await crypto.wrapConfigurationKey({ configurationKey: key, senderPrivateJwk: state.device.privateJwk,
            recipientPublicJwk: device.publicJwk, context: ctx })); check(s);
        }
        return { wire: { profileId, baseVersion, version, deleted: false, envelope, wraps },
          record: { epoch, version, deleted: false, hash: await digest({ deleted: false, envelope }), key: encode(key), profile } };
      } finally { key.fill(0); }
    }
    function operationBase(state) {
      if (state.revision >= Number.MAX_SAFE_INTEGER || state.epoch >= Number.MAX_SAFE_INTEGER) fail();
      return { opId: 'op_' + encode(cryptoProvider.getRandomValues(new Uint8Array(24))), expectedEpoch: state.epoch, expectedRevision: state.revision };
    }
    return Object.freeze({
      initializeOwner: () => run(async s => publicState((await enroll(s, 'owner')).value)),
      registerPending: () => run(async s => publicState((await enroll(s, 'reader')).value)),
      pairingInfo: () => run(async s => { const entry = await load(s); if (!entry.value) fail('UNPAIRED'); return { ...binding(s), ...publicState(entry.value) }; }),
      pinOwner: input => { const { publicJwk, confirmedFingerprint } = copy(input); return run(async s => {
        const entry = await existing(s), state = copy(entry.value), fingerprint = await crypto.fingerprintPublicKey(publicJwk); check(s);
        if (fingerprint !== confirmedFingerprint || (state.trustedOwner && state.trustedOwner.fingerprint !== fingerprint)) fail('PAIRING_MISMATCH');
        state.trustedOwner = { publicJwk: copy(publicJwk), fingerprint };
        return publicState((await commitLocal(s, entry, state)).value);
      }); },
      pull: () => run(async s => { const f = await fetchState(s); return { ...publicState(f.entry.value), pendingApproval: f.pending }; }),
      ownerState: () => run(async s => { const f = await fetchState(s, true); return { ...publicState(f.entry.value), devices: f.devices }; }),
      approveDevice: ({ deviceId, confirmedFingerprint }) => run(async s => {
        const f = await fetchState(s, true), state = f.entry.value;
        const device = f.devices.find(item => item.deviceId === deviceId && item.status === 'pending');
        if (!device || deviceId !== confirmedFingerprint) fail('PAIRING_MISMATCH');
        const wraps = [];
        for (const [profileId, row] of Object.entries(state.profiles)) {
          if (row.deleted) continue;
          const key = decode(row.key);
          try { wraps.push(await crypto.wrapConfigurationKey({ configurationKey: key, senderPrivateJwk: state.device.privateJwk,
            recipientPublicJwk: device.publicJwk, context: context(s, profileId, state.epoch, row.version) })); }
          finally { key.fill(0); }
          check(s);
        }
        const pins = { ...state.trustedRecipients, [deviceId]: { fingerprint: deviceId, publicJwk: publicKey(device.publicJwk) } };
        return sendPending(s, await freeze(s, f.entry, 'approve', { ...operationBase(state), deviceId, wraps }, { trustedRecipients: pins }));
      }),
      saveProfiles: changes => {
        const snapshotChanges = copy(changes);
        return run(async s => {
          if (!Array.isArray(snapshotChanges) || !snapshotChanges.length || snapshotChanges.length > 32) fail();
          const f = await fetchState(s, true), state = f.entry.value;
          const recipients = trustedRecipients(state, f.devices.filter(item => ['owner', 'approved'].includes(item.status)));
          const profiles = copy(state.profiles), activeProfiles = copy(state.activeProfiles), wires = [], seen = new Set();
          for (const change of snapshotChanges) {
            fields(change, ['profileId', 'profile']); id(change.profileId);
            if (seen.has(change.profileId)) fail(); seen.add(change.profileId);
            const version = integer((own(profiles, change.profileId)?.version || 0) + 1);
            const update = await encryptedUpdate(s, state, change.profileId, change.profile, state.epoch, version, recipients);
            wires.push(update.wire); profiles[change.profileId] = update.record;
            if (update.record.deleted) delete activeProfiles[change.profileId]; else activeProfiles[change.profileId] = update.record.profile;
          }
          if (Object.keys(profiles).length > 32) fail();
          return sendPending(s, await freeze(s, f.entry, 'commit', { ...operationBase(state), profiles: wires }, { profiles, activeProfiles }));
        });
      },
      rotateAndRevoke: deviceIds => {
        const revoked = copy(deviceIds);
        return run(async s => {
          if (!Array.isArray(revoked) || !revoked.length || revoked.length >= 16 || new Set(revoked).size !== revoked.length) fail();
          const f = await fetchState(s, true), state = f.entry.value;
          if (revoked.some(key => !f.devices.some(item => item.deviceId === key && ['pending', 'approved'].includes(item.status)))) fail();
          const recipients = trustedRecipients(state, f.devices.filter(item => ['owner', 'approved'].includes(item.status) && !revoked.includes(item.deviceId)));
          const epoch = integer(state.epoch + 1), profiles = {}, activeProfiles = {}, wires = [];
          for (const [profileId, row] of Object.entries(state.profiles)) {
            const update = await encryptedUpdate(s, state, profileId, row.deleted ? null : row.profile,
              epoch, integer(row.version + 1), recipients, true);
            profiles[profileId] = update.record; wires.push(update.wire);
            if (!row.deleted) activeProfiles[profileId] = update.record.profile;
          }
          const pins = Object.fromEntries(Object.entries(state.trustedRecipients).filter(([key]) => !revoked.includes(key)));
          return sendPending(s, await freeze(s, f.entry, 'rotate_and_revoke', { ...operationBase(state), newEpoch: epoch,
            revokeDeviceIds: revoked, profiles: wires }, { profiles, activeProfiles, trustedRecipients: pins }));
        });
      },
      retryPending: () => run(async s => sendPending(s, await existing(s, true)))
    });
  }
  return Object.freeze({ createConnectionSyncClient, ConnectionSyncClientError });
});
