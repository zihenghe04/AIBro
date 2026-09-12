const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApiCredentialStore, registerApiCredentialHandlers } = require('../app/native-api-credentials');
const SECRET = 'synthetic-review-credential';

// Contract test for the OS encryption adapter, never the user's keychain.
function encryption() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(text) {
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), data]);
    },
    decryptString(bytes) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-credential-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'credentials'), safeStorage = encryption();
  const make = extra => createApiCredentialStore({ directory, safeStorage, platform: 'darwin', ...extra });
  return { root, directory, safeStorage, make, store: make(), file: path.join(directory, 'api.json') };
}

test('a new store instance restores saved connection without plaintext on disk or public status', t => {
  const h = fixture(t), before = h.store.status();
  assert.equal(before.hasKey, false);
  const status = h.store.save({ base: 'https://gateway.example.invalid/v1/responses', token: SECRET, model: 'review-model' });
  assert.equal(status.hasKey, true);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(SECRET));
  const persisted = fs.readFileSync(h.file, 'utf8');
  assert.equal(persisted.includes(SECRET), false);
  assert.equal(persisted.includes('gateway.example.invalid'), false, 'The complete connection record is encrypted');
  assert.equal(fs.statSync(h.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(h.directory).mode & 0o777, 0o700);
  const restarted = h.make();
  const recovered = restarted.read({ base: 'https://gateway.example.invalid/v1' });
  assert.equal(recovered.token, SECRET);
  assert.equal(recovered.model, 'review-model');
  assert.equal(restarted.status().model, '', 'Passive status must not decrypt stored metadata');
  assert.equal(restarted.status().verified, false);
});

test('empty-key saves retain only same-origin credentials; explicit removal survives restart', t => {
  const h = fixture(t);
  h.store.save({ base: 'https://gateway.example.invalid/v1', token: SECRET, model: 'old' });
  h.store.save({ base: 'https://gateway.example.invalid/v2', model: 'new' });
  assert.equal(h.make().read({ base: 'https://gateway.example.invalid/v2' }).token, SECRET);
  assert.throws(() => h.store.save({ base: 'https://other.example.invalid/v1', token: '' }), /填写 Key|同一服务/);
  assert.throws(() => h.store.read({ base: 'https://other.example.invalid/v1' }), /另一个服务/);
  assert.equal(h.store.remove().hasKey, false);
  assert.equal(h.make().status().hasKey, false);
  assert.equal(h.make().read({ base: 'https://gateway.example.invalid/v1' }).token, '');
});

test('failed pre-commit writes retain old credentials and leave no plaintext temporary files', t => {
  const h = fixture(t);
  h.store.save({ base: 'https://gateway.example.invalid/v1', token: SECRET, model: 'old' });
  const bytes = fs.readFileSync(h.file);
  const faulty = h.make({ fsApi: { ...fs, renameSync() { throw Error('synthetic rename failure'); } } });
  assert.throws(() => faulty.save({ base: 'https://gateway.example.invalid/v1', token: 'synthetic-new-key', model: 'new' }), /保存或读取失败|保存失败/);
  assert.deepEqual(fs.readFileSync(h.file), bytes);
  assert.deepEqual(fs.readdirSync(h.directory), ['api.json']);
  assert.equal(h.make().read({ base: 'https://gateway.example.invalid/v1' }).token, SECRET);
});

test('all credential operations reject other windows, same-origin iframes and navigated frames', t => {
  const h = fixture(t), handlers = new Map();
  const mainFrame = { url: 'http://127.0.0.1:12345/' };
  const webContents = { mainFrame, isDestroyed: () => false };
  registerApiCredentialHandlers({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    getWindow: () => ({ webContents }), getLocalOrigin: () => 'http://127.0.0.1:12345', getStore: () => h.store });
  for (const [name, handler] of handlers) {
    for (const event of [
      { sender: {}, senderFrame: mainFrame },
      { sender: webContents, senderFrame: { url: mainFrame.url } },
      { sender: webContents, senderFrame: null },
    ]) assert.throws(() => handler(event, { base: 'https://gateway.example.invalid', token: SECRET }), /主窗口/);
    const prior = mainFrame.url;
    for (const url of ['http://127.0.0.1:12345/other.html', 'http://localhost:12345/', 'https://external.example.invalid/']) {
      mainFrame.url = url;
      assert.throws(() => handler({ sender: webContents, senderFrame: mainFrame }, { base: 'https://gateway.example.invalid', token: SECRET }), /主窗口/);
    }
    mainFrame.url = prior;
  }
  assert.equal(h.store.status().hasKey, false, 'Denied save handlers never reached persistence');
  assert.equal(handlers.get('workstation:api-credentials:status')({ sender: webContents, senderFrame: mainFrame }).available, null);
});

test('unavailable encryption and a symlinked store fail closed without touching the target', t => {
  const h = fixture(t), unavailable = h.make({ safeStorage: { isEncryptionAvailable: () => false } });
  assert.equal(unavailable.status().available, null, 'Startup cannot probe the system keychain');
  assert.throws(() => unavailable.read({ base: 'https://gateway.example.invalid' }), /安全存储当前不可用/);
  assert.throws(() => unavailable.save({ base: 'https://gateway.example.invalid', token: SECRET }), /安全存储当前不可用/);
  assert.equal(fs.existsSync(h.file), false);
  const outside = path.join(h.root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, h.directory, 'dir');
  assert.throws(() => h.store.save({ base: 'https://gateway.example.invalid', token: SECRET }), /符号链接/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('post-commit directory sync failure reports uncertainty instead of claiming the old key survived', t => {
  const h = fixture(t);
  h.store.save({ base: 'https://gateway.example.invalid/v1', token: SECRET, model: 'old' });
  const faulty = h.make({ fsApi: { ...fs, fsyncSync(fd) {
    if (fs.fstatSync(fd).isDirectory()) throw Error('synthetic directory sync failure');
    return fs.fsyncSync(fd);
  } } });
  assert.throws(() => faulty.save({ base: 'https://gateway.example.invalid/v1', token: 'synthetic-replacement', model: 'new' }), error => error.code === 'STORE_DURABILITY_UNCERTAIN' && /已替换/.test(error.message) && !/旧凭据.*不会/.test(error.message));
  assert.equal(h.make().read({ base: 'https://gateway.example.invalid/v1' }).token, 'synthetic-replacement');
  assert.throws(() => faulty.remove(), error => error.code === 'STORE_DURABILITY_UNCERTAIN' && /已删除/.test(error.message));
  assert.equal(h.make().status().hasKey, false);
});
