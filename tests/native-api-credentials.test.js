const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createApiCredentialStore, isTrustedCredentialSender, registerApiCredentialHandlers } = require('../app/native-api-credentials');

// Synthetic cipher only. Tests never initialize Electron or the real Keychain.
function fakeStorage() {
  const key = crypto.randomBytes(32);
  return {
    enabled: true, backend: 'gnome_libsecret', decrypts: 0,
    isEncryptionAvailable() { return this.enabled; },
    getSelectedStorageBackend() { return this.backend; },
    encryptString(value) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(value) {
      this.decrypts++;
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString('utf8');
    }
  };
}
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-credentials-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'credentials'), filename = path.join(directory, 'api.json');
  const safeStorage = fakeStorage();
  const config = { directory, safeStorage, platform: 'darwin', now: () => 1780000000000, ...options };
  return { root, directory, filename, safeStorage, config, store: createApiCredentialStore(config) };
}
const connection = { base: 'https://api.example.test/v1', token: 'synthetic-unit-key-DO-NOT-USE', model: 'unit-model' };
const unverified = hasKey => ({ available: null, hasKey, base: '', model: '', requiresUnlock: hasKey, verified: false });

test('status is read-only and missing credentials have an explicit empty read', t => {
  const f = fixture(t);
  assert.deepEqual(f.store.status(), unverified(false));
  assert.equal(fs.existsSync(f.directory), false);
  assert.deepEqual(f.store.read({ base: connection.base }), { token: '', base: connection.base, model: '' });
  assert.equal(fs.existsSync(f.directory), false);
});

test('save encrypts every field with private permissions and survives a new store instance', t => {
  const f = fixture(t), status = f.store.save(connection);
  assert.deepEqual(status, { available: true, hasKey: true, base: connection.base, model: connection.model, requiresUnlock: false, verified: true });
  assert.equal('token' in status, false);
  const disk = fs.readFileSync(f.filename, 'utf8');
  for (const value of Object.values(connection)) assert.equal(disk.includes(value), false);
  assert.equal(fs.statSync(f.filename).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  const restarted = createApiCredentialStore(f.config);
  assert.deepEqual(restarted.read({ base: connection.base }), { token: connection.token, base: connection.base, model: connection.model });
  assert.deepEqual(fs.readdirSync(f.directory), ['api.json']);
});

test('upstream origin binding survives path changes but rejects host, scheme and port changes', t => {
  const f = fixture(t); f.store.save(connection);
  assert.equal(f.store.read({ base: 'https://api.example.test/v2/responses' }).token, connection.token);
  for (const base of ['https://other.example.test/v1', 'http://api.example.test/v1', 'https://api.example.test:8443/v1', 'https://api.example.test.evil.test/v1']) {
    assert.throws(() => f.store.read({ base }), { code: 'ORIGIN_MISMATCH' });
    assert.throws(() => f.store.save({ base, token: '  ' }), { code: 'KEY_REQUIRED' });
  }
  const sameOrigin = 'https://API.EXAMPLE.TEST:443/v2';
  f.store.save({ base: sameOrigin, token: '', model: 'new-model' });
  assert.deepEqual(f.store.read({ base: connection.base }), { token: connection.token, base: 'https://api.example.test/v2', model: 'new-model' });
  f.store.save({ base: 'https://other.example.test/v1', token: 'synthetic-new-origin' });
  assert.throws(() => f.store.read({ base: connection.base }), { code: 'ORIGIN_MISMATCH' });
});

test('empty token keeps a saved key, while explicit remove is required to erase it', t => {
  const f = fixture(t);
  assert.throws(() => f.store.save({ base: connection.base }), { code: 'KEY_REQUIRED' });
  f.store.save(connection);
  f.store.save({ base: connection.base });
  assert.equal(f.store.read({ base: connection.base }).token, connection.token);
  f.store.save({ base: connection.base, token: ' ', model: '' });
  assert.equal(f.store.read({ base: connection.base }).model, '');
  assert.deepEqual(f.store.remove(), unverified(false));
  assert.equal(fs.existsSync(f.filename), false);
  assert.equal(f.store.remove().hasKey, false);
});

test('unavailable encryption refuses plaintext fallback and preserves existing ciphertext', t => {
  const f = fixture(t); f.safeStorage.enabled = false;
  assert.deepEqual(f.store.status(), unverified(false));
  assert.throws(() => f.store.save(connection), { code: 'ENCRYPTION_UNAVAILABLE' });
  assert.equal(fs.existsSync(f.directory), false);
  f.safeStorage.enabled = true; f.store.save(connection);
  const before = fs.readFileSync(f.filename), decrypts = f.safeStorage.decrypts;
  f.safeStorage.enabled = false;
  assert.deepEqual(f.store.status(), unverified(true));
  assert.equal(f.safeStorage.decrypts, decrypts);
  assert.throws(() => f.store.read({ base: connection.base }), { code: 'ENCRYPTION_UNAVAILABLE' });
  assert.throws(() => f.store.save(connection), { code: 'ENCRYPTION_UNAVAILABLE' });
  assert.deepEqual(fs.readFileSync(f.filename), before);
  assert.equal(f.store.remove().hasKey, false);
});

test('Linux basic_text, unknown and unavailable backends never count as secure storage', t => {
  const f = fixture(t, { platform: 'linux' });
  for (const backend of ['basic_text', 'unknown', undefined]) {
    f.safeStorage.backend = backend;
    assert.deepEqual(f.store.status(), unverified(false));
    assert.throws(() => f.store.save(connection), { code: 'ENCRYPTION_UNAVAILABLE' });
    assert.throws(() => f.store.read({ base: connection.base }), { code: 'ENCRYPTION_UNAVAILABLE' });
  }
  for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
    f.safeStorage.backend = backend;
    assert.deepEqual(f.store.status(), unverified(false));
    assert.equal(f.store.read({ base: connection.base }).token, '');
  }
  assert.equal(fs.existsSync(f.directory), false);
});

test('invalid URLs, models and tokens cannot overwrite an existing credential', t => {
  const f = fixture(t); f.store.save(connection); const before = fs.readFileSync(f.filename);
  for (const patch of [
    { base: 'file:///tmp/key' }, { base: 'https://name:password@api.example.test' }, { base: 'https://api.example.test/#fragment' },
    { base: 'https://api.example.test/\nheader' }, { base: '' }, { base: 'x'.repeat(4097) },
    { token: null }, { token: { secret: 'no' } }, { token: 'key\r\nAuthorization: no' }, { token: 'x'.repeat(16385) },
    { model: 42 }, { model: 'bad\nmodel' }, { model: 'x'.repeat(513) }
  ]) assert.throws(() => f.store.save({ ...connection, ...patch }));
  assert.deepEqual(fs.readFileSync(f.filename), before);
});

test('corrupt or locked ciphertext is preserved and errors never echo cipher/provider inputs', t => {
  const f = fixture(t); f.store.save(connection);
  const before = fs.readFileSync(f.filename);
  f.safeStorage.decryptString = () => { throw new Error(connection.token); };
  assert.deepEqual(f.store.status(), unverified(true));
  for (const call of [() => f.store.read({ base: connection.base }), () => f.store.save(connection)]) {
    assert.throws(call, error => error.code === 'STORE_UNREADABLE' && !String(error).includes(connection.token));
  }
  assert.deepEqual(fs.readFileSync(f.filename), before);
  f.store.remove();
  f.safeStorage.encryptString = () => { throw new Error(connection.token); };
  assert.throws(() => f.store.save(connection), error => error.code === 'STORE_FAILED' && !String(error).includes(connection.token));
  assert.equal(fs.existsSync(f.filename), false);
});

test('startup status and explicit deletion never access any safeStorage property or read ciphertext', t => {
  for (const saved of [false, true]) {
    const f = fixture(t);
    if (saved) f.store.save(connection);
    let safeStorageAccesses = 0, contentsRead = 0;
    const inaccessible = new Proxy({}, { get() { safeStorageAccesses++; throw new Error('Keychain access would block'); } });
    const fsApi = Object.create(fs);
    fsApi.readFileSync = () => { contentsRead++; throw new Error('status must inspect metadata only'); };
    const store = createApiCredentialStore({ ...f.config, fsApi, safeStorage: inaccessible });
    assert.deepEqual(store.status(), unverified(saved));
    assert.deepEqual(store.status(), unverified(saved));
    assert.deepEqual(store.remove(), unverified(false));
    assert.deepEqual(store.status(), unverified(false));
    assert.equal(safeStorageAccesses, 0);
    assert.equal(contentsRead, 0);
    assert.equal(fs.existsSync(f.filename), false);
  }
});

test('legacy encrypted envelopes are unchanged by status and remain readable only through explicit read', t => {
  const f = fixture(t);
  fs.mkdirSync(f.directory, { mode: 0o700 });
  const legacy = { version: 1, ...connection, origin: new URL(connection.base).origin, savedAt: '2026-09-12T00:00:00.000Z' };
  const envelope = JSON.stringify({ version: 1, ciphertext: f.safeStorage.encryptString(JSON.stringify(legacy)).toString('base64') });
  fs.writeFileSync(f.filename, envelope, { mode: 0o600 });
  const before = fs.readFileSync(f.filename);
  assert.deepEqual(f.store.status(), unverified(true));
  assert.equal(f.safeStorage.decrypts, 0);
  assert.deepEqual(fs.readFileSync(f.filename), before);
  assert.deepEqual(f.store.read({ base: connection.base }), { token: connection.token, base: connection.base, model: connection.model });
  assert.equal(f.safeStorage.decrypts, 1);
  assert.deepEqual(fs.readFileSync(f.filename), before);
  // No cached decrypted metadata is revealed by subsequent startup checks.
  assert.deepEqual(f.store.status(), unverified(true));
  assert.equal(f.safeStorage.decrypts, 1);
});

test('metadata status does not certify corrupted ciphertext and explicit read/save still fail closed', t => {
  const f = fixture(t); f.store.save(connection);
  fs.writeFileSync(f.filename, '{malformed-envelope');
  const before = fs.readFileSync(f.filename);
  assert.deepEqual(f.store.status(), unverified(true));
  assert.throws(() => f.store.read({ base: connection.base }), { code: 'STORE_UNREADABLE' });
  assert.throws(() => f.store.save(connection), { code: 'STORE_UNREADABLE' });
  assert.deepEqual(fs.readFileSync(f.filename), before);
  assert.deepEqual(f.store.remove(), unverified(false));
});

test('write, flush and rename failures preserve old credentials and clean only their own encrypted temporary', t => {
  for (const operation of ['writeFileSync', 'fsyncSync', 'renameSync']) {
    const f = fixture(t); f.store.save(connection);
    const before = fs.readFileSync(f.filename);
    fs.writeFileSync(path.join(f.directory, 'unrelated.keep'), 'keep');
    const fsApi = Object.create(fs);
    fsApi[operation] = () => { throw new Error(`synthetic ${operation} failure`); };
    const failing = createApiCredentialStore({ ...f.config, fsApi });
    assert.throws(() => failing.save({ ...connection, token: 'synthetic-replacement' }), { code: 'STORE_FAILED' });
    assert.deepEqual(fs.readFileSync(f.filename), before);
    assert.deepEqual(fs.readdirSync(f.directory).sort(), ['api.json', 'unrelated.keep']);
    assert.equal(f.store.read({ base: connection.base }).token, connection.token);
  }
});

test('temporary files contain only ciphertext even before a failed rename', t => {
  const f = fixture(t), observed = [];
  const fsApi = Object.create(fs);
  fsApi.renameSync = (from) => { observed.push(fs.readFileSync(from, 'utf8')); throw new Error('rename failed'); };
  const store = createApiCredentialStore({ ...f.config, fsApi });
  assert.throws(() => store.save(connection), { code: 'STORE_FAILED' });
  assert.equal(observed.length, 1);
  for (const value of Object.values(connection)) assert.equal(observed[0].includes(value), false);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('directory flush failure after atomic rename reports the committed change without claiming old credentials survived', t => {
  const f = fixture(t); f.store.save(connection);
  const fsApi = Object.create(fs);
  fsApi.fsyncSync = fd => { if (fs.fstatSync(fd).isDirectory()) throw new Error('synthetic directory flush failure'); return fs.fsyncSync(fd); };
  const store = createApiCredentialStore({ ...f.config, fsApi });
  assert.throws(() => store.save({ ...connection, token: 'synthetic-committed-key' }), error => error.code === 'STORE_DURABILITY_UNCERTAIN' && /已替换/.test(error.message) && !/旧凭据/.test(error.message));
  assert.equal(f.store.read({ base: connection.base }).token, 'synthetic-committed-key');
  assert.deepEqual(fs.readdirSync(f.directory), ['api.json']);
  assert.throws(() => store.remove(), error => error.code === 'STORE_DURABILITY_UNCERTAIN' && /已删除/.test(error.message));
  assert.equal(f.store.status().hasKey, false);
});

test('symbolic links for the file, credentials folder, or its parent are refused', t => {
  for (const target of ['file', 'folder', 'parent']) {
    const f = fixture(t), outside = path.join(f.root, 'outside');
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'untouched'), 'sentinel');
    let store = f.store;
    if (target === 'file') { fs.mkdirSync(f.directory); fs.symlinkSync(path.join(outside, 'untouched'), f.filename); }
    if (target === 'folder') fs.symlinkSync(outside, f.directory, 'dir');
    if (target === 'parent') { const linked = path.join(f.root, 'linked'); fs.symlinkSync(outside, linked, 'dir'); store = createApiCredentialStore({ ...f.config, directory: path.join(linked, 'credentials') }); }
    for (const operation of [() => store.status(), () => store.read({ base: connection.base }), () => store.save(connection), () => store.remove()]) assert.throws(operation, { code: 'UNSAFE_STORE' });
    assert.equal(fs.readFileSync(path.join(outside, 'untouched'), 'utf8'), 'sentinel');
    assert.deepEqual(fs.readdirSync(outside), ['untouched']);
  }
});

test('hard links and oversized records are rejected without following or deleting them', t => {
  const f = fixture(t); f.store.save(connection);
  fs.linkSync(f.filename, path.join(f.root, 'hardlink'));
  assert.throws(() => f.store.status(), { code: 'UNSAFE_STORE' });
  assert.throws(() => f.store.remove(), { code: 'UNSAFE_STORE' });
  fs.unlinkSync(path.join(f.root, 'hardlink'));
  fs.writeFileSync(f.filename, 'x'.repeat(128 * 1024 + 1));
  assert.throws(() => f.store.status(), { code: 'UNSAFE_STORE' });
});

test('IPC sender trust requires the current main window, exact main frame and application page', () => {
  const frame = { url: 'http://127.0.0.1:9999/' }, wc = { mainFrame: frame, isDestroyed: () => false };
  const event = { sender: wc, senderFrame: frame }, origin = 'http://127.0.0.1:9999';
  assert.equal(isTrustedCredentialSender(event, wc, origin), true);
  assert.equal(isTrustedCredentialSender({ ...event, sender: {} }, wc, origin), false);
  assert.equal(isTrustedCredentialSender({ ...event, senderFrame: { ...frame } }, wc, origin), false);
  assert.equal(isTrustedCredentialSender({ ...event, senderFrame: null }, wc, origin), false);
  for (const url of ['https://external.example/', 'http://127.0.0.1:8765/', origin + '/__files/att.html', origin + '/other.html', 'file:///index.html']) {
    frame.url = url; assert.equal(isTrustedCredentialSender(event, wc, origin), false);
  }
  frame.url = origin + '/index.html#settings'; assert.equal(isTrustedCredentialSender(event, wc, origin), true);
  wc.isDestroyed = () => true; assert.equal(isTrustedCredentialSender(event, wc, origin), false);
});

test('all IPC operations enforce sender checks before opening the credential store', t => {
  const f = fixture(t), handlers = {}, frame = { url: 'http://127.0.0.1:9000/' }, wc = { mainFrame: frame };
  let opened = 0;
  registerApiCredentialHandlers({ ipcMain: { handle: (name, handler) => { handlers[name] = handler; } }, getWindow: () => ({ webContents: wc }), getLocalOrigin: () => 'http://127.0.0.1:9000', getStore: () => { opened++; return f.store; } });
  assert.equal(Object.keys(handlers).length, 4);
  for (const handler of Object.values(handlers)) assert.throws(() => handler({ sender: wc, senderFrame: { ...frame } }, connection), { code: 'INVALID_SENDER' });
  assert.equal(opened, 0);
  const trusted = { sender: wc, senderFrame: frame };
  handlers['workstation:api-credentials:save'](trusted, connection);
  assert.equal(handlers['workstation:api-credentials:status'](trusted).hasKey, true);
  assert.equal(handlers['workstation:api-credentials:read'](trusted, { base: connection.base }).token, connection.token);
  handlers['workstation:api-credentials:remove'](trusted);
  assert.equal(f.store.status().hasKey, false);
});

test('preload exposes only the fixed credential operations and passes no raw IPC capability', () => {
  const calls = []; let exposed;
  vm.runInNewContext(fs.readFileSync(require.resolve('../app/preload'), 'utf8'), {
    process: { platform: 'darwin' }, require: name => {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld: (name, api) => { assert.equal(name, 'workstationDesktop'); exposed = api; } }, ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({}); } } };
    }
  });
  assert.deepEqual(Object.keys(exposed.apiCredentials).sort(), ['read', 'remove', 'save', 'status']);
  exposed.apiCredentials.status(); exposed.apiCredentials.read({ base: connection.base }); exposed.apiCredentials.save(connection); exposed.apiCredentials.remove();
  assert.deepEqual(calls.map(call => call[0]), ['status', 'read', 'save', 'remove'].map(name => 'workstation:api-credentials:' + name));
  assert.equal('ipcRenderer' in exposed, false);
});

test('Electron main import, store construction, status and deletion do not even access the safeStorage getter', t => {
  const f = fixture(t), handlers = {};
  let userData, getterCalls = 0;
  fs.mkdirSync(path.join(f.root, 'ai-workstation-studio'));
  const electron = {
    app: {
      setName: name => assert.equal(name, 'ai-workstation'),
      getPath: name => name === 'userData' ? userData : f.root,
      setPath: (name, value) => { if (name === 'userData') userData = value; },
      requestSingleInstanceLock: () => false, quit() {}, on() {}
    },
    ipcMain: { handle: (name, handler) => { handlers[name] = handler; } }
  };
  Object.defineProperty(electron, 'safeStorage', { get() { getterCalls++; throw new Error('Keychain getter would block'); } });
  const frame = { url: 'http://127.0.0.1:8765/' }, wc = { mainFrame: frame };
  const context = vm.createContext({
    require: name => {
      if (name === 'electron') return electron;
      if (name === './app-assets') return { fingerprint: () => 'synthetic' };
      if (name === './package.json') return { version: 'test' };
      if (name === './native-ui-language') return require('../app/native-ui-language');
      if (name === './native-liquid-glass') return require('../app/native-liquid-glass');
      if (name === './python-runtime') return require('../app/python-runtime');
      if (name === './native-api-credentials') return require('../app/native-api-credentials');
      return require(name);
    },
    __dirname: path.dirname(require.resolve('../app/electron-main')),
    process: { env: {}, platform: 'darwin', on() {} }, console,
    testWindow: { webContents: wc }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../app/electron-main'), 'utf8'), context);
  assert.equal(getterCalls, 0);
  vm.runInContext('mainWindow = testWindow;', context);
  const event = { sender: wc, senderFrame: frame };
  assert.deepEqual(handlers['workstation:api-credentials:status'](event), unverified(false));
  assert.deepEqual(handlers['workstation:api-credentials:remove'](event), unverified(false));
  assert.equal(getterCalls, 0);
  assert.throws(() => handlers['workstation:api-credentials:read'](event, { base: connection.base }), { code: 'ENCRYPTION_UNAVAILABLE' });
  assert.equal(getterCalls, 1);
  assert.equal(fs.existsSync(path.join(userData, 'credentials')), false);
});
