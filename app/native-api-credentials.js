'use strict';

// This store is intentionally separate from workspace JSON and cloud sync.
// Only ciphertext is written, including while replacing an existing record.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_RECORD_BYTES = 128 * 1024;
const CHANNEL_PREFIX = 'workstation:api-credentials:';
class CredentialError extends Error {
  constructor(code, message) { super(message); this.name = 'CredentialError'; this.code = code; }
}
const fail = (code, message) => { throw new CredentialError(code, message); };
function normalizeBase(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value.trim())) fail('INVALID_BASE', '请填写有效的 HTTP 或 HTTPS API 地址。');
  let url;
  try { url = new URL(value.trim()); } catch (_) { fail('INVALID_BASE', '请填写有效的 HTTP 或 HTTPS API 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) fail('INVALID_BASE', 'API 地址不能包含账号、密码或片段。');
  return { base: url.href, origin: url.origin };
}
function cleanModel(value) {
  if (typeof value !== 'string' || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) fail('INVALID_MODEL', '模型名称无效。');
  return value.trim();
}
function cleanToken(value) {
  if (typeof value !== 'string' || value.length > 16384 || /[\u0000-\u001f\u007f]/.test(value)) fail('INVALID_TOKEN', 'API Key 格式无效。');
  return value.trim();
}

function createApiCredentialStore({ directory, safeStorage, platform = process.platform, fsApi = fs, now = Date.now }) {
  const folder = path.resolve(directory);
  const filename = path.join(folder, 'api.json');
  const unavailable = () => fail('ENCRYPTION_UNAVAILABLE', '系统安全存储当前不可用，API Key 未保存。请解锁系统钥匙串或启用系统密钥存储后重试。');
  function available() {
    try {
      if (!safeStorage?.isEncryptionAvailable()) return false;
      if (platform === 'linux') {
        const backend = safeStorage.getSelectedStorageBackend?.();
        if (!['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend)) return false;
      }
      return true;
    } catch (_) { return false; }
  }
  function statOrNull(target) {
    try { return fsApi.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function checkOwner(stat) {
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail('UNSAFE_STORE', '本机凭据存储的所有者不正确。');
  }
  function checkFolder(create = false) {
    const parent = statOrNull(path.dirname(folder));
    if (!parent || parent.isSymbolicLink() || !parent.isDirectory()) fail('UNSAFE_STORE', '本机凭据存储目录无效。');
    let stat = statOrNull(folder);
    if (!stat && create) {
      fsApi.mkdirSync(folder, { mode: 0o700 });
      stat = fsApi.lstatSync(folder);
      syncDirectory(path.dirname(folder));
    }
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('UNSAFE_STORE', '本机凭据存储不能使用符号链接。');
    checkOwner(stat);
    if (create) fsApi.chmodSync(folder, 0o700);
    return stat;
  }
  function checkFile() {
    if (!checkFolder()) return null;
    const stat = statOrNull(filename);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > MAX_RECORD_BYTES) fail('UNSAFE_STORE', '本机凭据文件无效，未读取或覆盖。');
    checkOwner(stat);
    return stat;
  }
  function readRecord() {
    const initial = checkFile();
    if (!initial) return null;
    if (!available()) unavailable();
    let fd;
    try {
      fd = fsApi.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fsApi.fstatSync(fd);
      if (!stat.isFile() || stat.dev !== initial.dev || stat.ino !== initial.ino || stat.size > MAX_RECORD_BYTES) fail('UNSAFE_STORE', '本机凭据文件已变化，请重试。');
      const envelope = JSON.parse(fsApi.readFileSync(fd, 'utf8'));
      if (envelope?.version !== 1 || typeof envelope.ciphertext !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext)) throw new Error('Invalid encrypted record');
      const record = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.ciphertext, 'base64')));
      const parsed = normalizeBase(record.base);
      if (record.version !== 1 || record.origin !== parsed.origin || !cleanToken(record.token)) throw new Error('Invalid credential record');
      return { ...record, base: parsed.base, model: cleanModel(record.model) };
    } catch (_) {
      fail('STORE_UNREADABLE', '无法解密本机保存的 API Key。原记录已保留，请检查系统钥匙串；如需替换，请先明确删除旧记录。');
    } finally { if (fd !== undefined) fsApi.closeSync(fd); }
  }
  function unverifiedStatus(hasKey) {
    // Even isEncryptionAvailable may enter the OS Keychain synchronously.
    // Startup and deletion must never trigger that interaction. null means
    // unknown, not unavailable; only an explicit read/save verifies access.
    return { available: null, hasKey, base: '', model: '', requiresUnlock: hasKey, verified: false };
  }
  function savedStatus(record) {
    return { available: true, hasKey: true, base: record.base, model: record.model, requiresUnlock: false, verified: true };
  }
  function syncDirectory(target = folder) {
    // Windows does not expose directory fsync. The encrypted file is still
    // flushed before atomic rename; POSIX also flushes the directory entry.
    if (platform === 'win32') return;
    const fd = fsApi.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try { fsApi.fsyncSync(fd); } finally { fsApi.closeSync(fd); }
  }
  function writeRecord(record) {
    if (!available()) unavailable();
    const encrypted = safeStorage.encryptString(JSON.stringify(record));
    if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error('Encryption failed');
    const body = JSON.stringify({ version: 1, ciphertext: encrypted.toString('base64') });
    if (Buffer.byteLength(body) > MAX_RECORD_BYTES) fail('INVALID_TOKEN', 'API Key 超出本机安全存储大小限制。');
    const initialFolder = checkFolder(true);
    checkFile();
    const temporary = path.join(folder, `.api-${crypto.randomBytes(16).toString('hex')}.tmp`);
    let fd;
    let committed = false;
    try {
      fd = fsApi.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      fsApi.writeFileSync(fd, body, 'utf8');
      fsApi.fsyncSync(fd);
      fsApi.closeSync(fd); fd = undefined;
      const currentFolder = checkFolder();
      if (!currentFolder || currentFolder.dev !== initialFolder.dev || currentFolder.ino !== initialFolder.ino) fail('UNSAFE_STORE', '本机凭据目录已变化，请重试。');
      checkFile();
      fsApi.renameSync(temporary, filename);
      committed = true;
      try { syncDirectory(); } catch (_) {
        fail('STORE_DURABILITY_UNCERTAIN', '新 API 凭据已替换，但系统尚未确认落盘。请重新保存后再退出应用。');
      }
    } finally {
      if (fd !== undefined) fsApi.closeSync(fd);
      if (!committed) { try { fsApi.unlinkSync(temporary); } catch (_) {} }
    }
  }
  function guarded(fn) {
    return (...args) => {
      try { return fn(...args); } catch (error) {
        if (error instanceof CredentialError) throw error;
        // OS/keychain errors can contain their inputs. Never pass them to IPC.
        fail('STORE_FAILED', '本机 API 凭据保存或读取失败，请重试。旧凭据不会因未完成的写入而被清除。');
      }
    };
  }
  return Object.freeze({
    status: guarded(() => unverifiedStatus(Boolean(checkFile()))),
    read: guarded(({ base } = {}) => {
      const requested = normalizeBase(base);
      if (!available()) unavailable();
      const record = readRecord();
      if (!record) return { token: '', base: requested.base, model: '' };
      if (record.origin !== requested.origin) fail('ORIGIN_MISMATCH', '已保存的 API Key 属于另一个服务地址。请为当前地址重新填写 Key。');
      return { token: record.token, base: record.base, model: record.model };
    }),
    save: guarded((input = {}) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', 'API 连接配置无效。');
      const requested = normalizeBase(input.base);
      const supplied = input.token === undefined ? '' : cleanToken(input.token);
      if (!available()) unavailable();
      const previous = readRecord();
      if (!supplied && (!previous || previous.origin !== requested.origin)) fail('KEY_REQUIRED', '请为当前 API 地址填写 Key；留空只能保留同一服务已保存的 Key。');
      const record = { version: 1, ...requested, token: supplied || previous.token, model: input.model === undefined ? (previous?.model || '') : cleanModel(input.model), savedAt: new Date(now()).toISOString() };
      writeRecord(record);
      return savedStatus(record);
    }),
    remove: guarded(() => {
      const existing = checkFile();
      if (existing) fsApi.unlinkSync(filename);
      if (checkFolder()) {
        try { syncDirectory(); } catch (_) {
          fail('STORE_DURABILITY_UNCERTAIN', 'API 凭据已删除，但系统尚未确认落盘。请再次删除以确认后再退出应用。');
        }
      }
      return unverifiedStatus(false);
    })
  });
}

function isTrustedCredentialSender(event, webContents, localOrigin) {
  try {
    if (!webContents || webContents.isDestroyed?.() || event.sender !== webContents || !event.senderFrame || event.senderFrame !== webContents.mainFrame) return false;
    const url = new URL(event.senderFrame.url);
    return url.origin === localOrigin && ['/', '/index.html'].includes(url.pathname) && !url.username && !url.password;
  } catch (_) { return false; }
}

function registerApiCredentialHandlers({ ipcMain, getWindow, getLocalOrigin, getStore, channelPrefix = CHANNEL_PREFIX }) {
  for (const operation of ['status', 'read', 'save', 'remove']) {
    ipcMain.handle(channelPrefix + operation, (event, input) => {
      if (!isTrustedCredentialSender(event, getWindow()?.webContents, getLocalOrigin())) fail('INVALID_SENDER', '仅当前工作站主窗口可访问本机 API 凭据。');
      return getStore()[operation](input);
    });
  }
}

module.exports = { createApiCredentialStore, isTrustedCredentialSender, registerApiCredentialHandlers };
