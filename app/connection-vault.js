(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AIBroConnectionVault = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  // Cryptographic building blocks only: no storage, network, pairing, or account discovery.
  // Private JWKs and raw configuration keys must only enter the caller's local vault.
  const PROFILE = 'aibro.connection-profile.v1';
  const SEALED = 'aibro.connection-profile-sealed.v1';
  const WRAPPED = 'aibro.connection-key-wrap.v1';
  const SUITE = 'P256-HKDF-SHA256-A256GCM';
  const LIMITS = Object.freeze({ profileBytes: 24576, apiKeyBytes: 16384, urlBytes: 2048, modelBytes: 256 });
  const encoder = new TextEncoder();
  const contextFields = ['serverOrigin', 'accountId', 'profileId', 'epoch', 'version'];

  class ConnectionVaultError extends Error {
    constructor(code) {
      const messages = {
        INVALID_SCHEMA: '连接配置或加密信封格式无效。',
        INVALID_KEY: '配置密钥或设备密钥无效。',
        CONTEXT_MISMATCH: '连接配置与当前账号、服务或版本不匹配。',
        DEVICE_MISMATCH: '配置未绑定当前可信设备。',
        AUTHENTICATION_FAILED: '连接配置校验失败，未解密或应用。',
        CRYPTO_UNAVAILABLE: '当前环境不支持所需的安全加密能力。'
      };
      super(messages[code]); this.name = 'ConnectionVaultError'; this.code = code;
    }
  }
  function fail(code = 'INVALID_SCHEMA') { throw new ConnectionVaultError(code); }
  function fields(value, required, optional = []) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
    const keys = Reflect.ownKeys(value), allowed = [...required, ...optional];
    if (keys.length > allowed.length || keys.some(key => typeof key !== 'string' || !allowed.includes(key)) ||
        required.some(key => !Object.hasOwn(value, key))) fail();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    }
  }
  function text(value, maxBytes) {
    if (typeof value !== 'string' || !value || value.length > maxBytes ||
        /[\u0000-\u001f\u007f]/.test(value) || encoder.encode(value).length > maxBytes) fail();
    return value;
  }
  function identifier(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) fail();
    return value;
  }
  function revision(value) {
    if (!Number.isSafeInteger(value) || value < 1) fail();
    return value;
  }
  function url(value, originOnly) {
    text(value, LIMITS.urlBytes);
    if (!/^https?:\/\//.test(value) || /[\s?#]/.test(value) || value.includes('\\')) fail();
    let parsed;
    try { parsed = new URL(value); } catch (_) { fail(); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.username || parsed.password || parsed.search || parsed.hash ||
        !(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback)) ||
        (originOnly && parsed.pathname !== '/')) fail();
    return originOnly ? parsed.origin : parsed.href.replace(/\/+$/, '');
  }
  function normalizeContext(value) {
    fields(value, contextFields);
    return { serverOrigin: url(value.serverOrigin, true), accountId: identifier(value.accountId),
      profileId: identifier(value.profileId), epoch: revision(value.epoch), version: revision(value.version) };
  }
  function normalizeProfile(value) {
    fields(value, ['format', 'purpose', 'provider', 'authKind', 'apiFormat', 'baseUrl', 'model', 'apiKey'], ['language']);
    if (value.format !== PROFILE || value.authKind !== 'api-key' ||
        !['purpose', 'provider', 'apiFormat'].every(key => typeof value[key] === 'string')) fail();
    const formats = {
      'openai-compatible': { chat: ['chat-completions', 'responses'], embedding: ['embeddings'], speech: ['audio-transcriptions'] },
      'anthropic-api': { chat: ['anthropic-messages'] },
      'aliyun': { speech: ['aliyun-multimodal'] }
    };
    if (!Object.hasOwn(formats, value.provider) || !Object.hasOwn(formats[value.provider], value.purpose) ||
        !formats[value.provider][value.purpose].includes(value.apiFormat)) fail();
    const apiKey = text(value.apiKey, LIMITS.apiKeyBytes);
    // Never accept cookie/header bundles or known Claude browser/OAuth credentials as API keys.
    // An arbitrary opaque string has no provable provenance: the caller must use an API-key source.
    if (!/^[\x21-\x7e]+$/.test(apiKey) || /[;{}\[\]]/.test(apiKey) ||
        /^(?:bearer|cookie|session(?:key)?|__secure-[a-z0-9_-]+)[=: ]/i.test(apiKey) || /^sk-ant-(?:oat|ort|sid)\d{2}-/i.test(apiKey)) fail();
    const model = text(value.model, LIMITS.modelBytes);
    if (model !== model.trim()) fail();
    const result = { format: PROFILE, purpose: value.purpose, provider: value.provider, authKind: 'api-key',
      apiFormat: value.apiFormat, baseUrl: url(value.baseUrl, false), model, apiKey };
    // Omission remains byte-compatible with existing profiles. Language is a
    // speech option, never a generic model instruction or an arbitrary object.
    if (Object.hasOwn(value, 'language')) {
      if (value.purpose !== 'speech' || typeof value.language !== 'string' || !/^[A-Za-z-]{0,16}$/.test(value.language)) fail();
      result.language = value.language;
    }
    if (encoder.encode(JSON.stringify(result)).length > LIMITS.profileBytes) fail();
    return result;
  }
  function encode64(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decode64(value, min, max = min) {
    if (typeof value !== 'string' || value.length < Math.ceil(min * 4 / 3) ||
        value.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) fail();
    let bytes;
    try { bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0)); }
    catch (_) { fail(); }
    if (bytes.length < min || bytes.length > max || encode64(bytes) !== value) fail();
    return bytes;
  }
  function normalizeJwk(value, privateKey = false) {
    fields(value, ['kty', 'crv', 'x', 'y', ...(privateKey ? ['d'] : [])], ['ext', 'key_ops']);
    if (value.kty !== 'EC' || value.crv !== 'P-256' || (Object.hasOwn(value, 'ext') && value.ext !== true)) fail('INVALID_KEY');
    const usages = privateKey ? ['deriveBits'] : [];
    if (Object.hasOwn(value, 'key_ops') && (!Array.isArray(value.key_ops) || value.key_ops.length !== usages.length ||
        value.key_ops.some((entry, index) => entry !== usages[index]))) fail('INVALID_KEY');
    decode64(value.x, 32); decode64(value.y, 32);
    // RFC 7638 member ordering is also the only canonical public representation.
    const result = { crv: 'P-256', kty: 'EC', x: value.x, y: value.y };
    if (privateKey) { decode64(value.d, 32); result.d = value.d; }
    return result;
  }
  function publicPart(jwk) { return { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }; }
  function configurationBytes(value) {
    if (!(value instanceof Uint8Array) || value.length !== 32) fail('INVALID_KEY');
    return new Uint8Array(value);
  }
  function bindContext(actual, expected) {
    const normalized = normalizeContext(actual), trusted = normalizeContext(expected);
    if (JSON.stringify(normalized) !== JSON.stringify(trusted)) fail('CONTEXT_MISMATCH');
    return trusted;
  }
  function profileAAD(context) { return encoder.encode(JSON.stringify([SEALED, 'A256GCM', context])); }
  function wrapAAD(context, sender, recipient) { return encoder.encode(JSON.stringify([WRAPPED, SUITE, context, sender, recipient])); }

  function createConnectionVault(cryptoProvider = globalThis.crypto) {
    if (!cryptoProvider?.subtle || typeof cryptoProvider.getRandomValues !== 'function' ||
        !['generateKey', 'importKey', 'exportKey', 'deriveBits', 'deriveKey', 'encrypt', 'decrypt', 'digest']
          .every(method => typeof cryptoProvider.subtle[method] === 'function')) fail('CRYPTO_UNAVAILABLE');
    const subtle = cryptoProvider.subtle;
    const random = size => cryptoProvider.getRandomValues(new Uint8Array(size));
    async function importDevice(value, privateKey = false) {
      const jwk = normalizeJwk(value, privateKey);
      try { return await subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, privateKey ? ['deriveBits'] : []); }
      catch (_) { fail('INVALID_KEY'); }
    }
    async function thumbprint(jwk) {
      return encode64(new Uint8Array(await subtle.digest('SHA-256', encoder.encode(JSON.stringify(publicPart(jwk))))));
    }
    async function fingerprintPublicKey(publicJwk) {
      const jwk = normalizeJwk(publicJwk);
      await importDevice(jwk); // Reject points not on P-256, not just malformed JSON.
      return thumbprint(jwk);
    }
    async function generateDeviceKeyPair() {
      const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const publicJwk = normalizeJwk(await subtle.exportKey('jwk', pair.publicKey));
      const privateJwk = normalizeJwk(await subtle.exportKey('jwk', pair.privateKey), true);
      return { publicJwk, privateJwk, fingerprint: await thumbprint(publicJwk) };
    }
    async function configurationCryptoKey(bytes) {
      const raw = configurationBytes(bytes);
      try { return await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']); }
      finally { raw.fill(0); }
    }
    async function wrappingKey(privateJwk, publicJwk, salt, info) {
      const privateKey = await importDevice(privateJwk, true), publicKey = await importDevice(publicJwk);
      const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256));
      try {
        const input = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
        return await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info }, input,
          { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      } finally { shared.fill(0); }
    }
    async function decrypt(key, nonce, ciphertext, aad) {
      try { return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, key, ciphertext)); }
      catch (_) { fail('AUTHENTICATION_FAILED'); }
    }
    async function encryptProfile({ profile, configurationKey, context }) {
      // Snapshot all caller-owned fields before the first await.
      const safe = normalizeProfile(profile), binding = normalizeContext(context);
      const raw = configurationBytes(configurationKey), clear = encoder.encode(JSON.stringify(safe));
      try {
        const key = await configurationCryptoKey(raw), nonce = random(12);
        const encrypted = await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: profileAAD(binding), tagLength: 128 }, key, clear);
        return { format: SEALED, suite: 'A256GCM', context: binding, nonce: encode64(nonce), ciphertext: encode64(new Uint8Array(encrypted)) };
      } finally { raw.fill(0); clear.fill(0); }
    }
    async function decryptProfile({ envelope, configurationKey, expectedContext }) {
      fields(envelope, ['format', 'suite', 'context', 'nonce', 'ciphertext']);
      if (envelope.format !== SEALED || envelope.suite !== 'A256GCM') fail();
      const binding = bindContext(envelope.context, expectedContext), nonce = decode64(envelope.nonce, 12);
      const ciphertext = decode64(envelope.ciphertext, 17, LIMITS.profileBytes + 16);
      const key = await configurationCryptoKey(configurationKey);
      const clear = await decrypt(key, nonce, ciphertext, profileAAD(binding));
      try {
        let decoded;
        try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clear)); }
        catch (_) { fail(); }
        return normalizeProfile(decoded);
      } finally { clear.fill(0); }
    }
    async function wrapConfigurationKey({ configurationKey, senderPrivateJwk, recipientPublicJwk, context }) {
      const sender = normalizeJwk(senderPrivateJwk, true), recipient = normalizeJwk(recipientPublicJwk);
      const binding = normalizeContext(context), raw = configurationBytes(configurationKey);
      try {
        const senderFingerprint = await thumbprint(sender), recipientFingerprint = await thumbprint(recipient);
        const salt = random(32), nonce = random(12), aad = wrapAAD(binding, senderFingerprint, recipientFingerprint);
        const key = await wrappingKey(sender, recipient, salt, aad);
        const encrypted = await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, key, raw);
        return { format: WRAPPED, suite: SUITE, context: binding, senderFingerprint, recipientFingerprint,
          salt: encode64(salt), nonce: encode64(nonce), ciphertext: encode64(new Uint8Array(encrypted)) };
      } finally { raw.fill(0); }
    }
    async function unwrapConfigurationKey({ envelope, recipientPrivateJwk, trustedSenderPublicJwk, expectedContext }) {
      fields(envelope, ['format', 'suite', 'context', 'senderFingerprint', 'recipientFingerprint', 'salt', 'nonce', 'ciphertext']);
      if (envelope.format !== WRAPPED || envelope.suite !== SUITE) fail();
      const binding = bindContext(envelope.context, expectedContext), salt = decode64(envelope.salt, 32);
      const nonce = decode64(envelope.nonce, 12), ciphertext = decode64(envelope.ciphertext, 48);
      decode64(envelope.senderFingerprint, 32); decode64(envelope.recipientFingerprint, 32);
      const sender = normalizeJwk(trustedSenderPublicJwk), recipient = normalizeJwk(recipientPrivateJwk, true);
      // The trusted sender must come from approved local pairing state, NEVER from this envelope.
      const statedSender = envelope.senderFingerprint, statedRecipient = envelope.recipientFingerprint;
      const senderFingerprint = await thumbprint(sender), recipientFingerprint = await thumbprint(recipient);
      if (senderFingerprint !== statedSender || recipientFingerprint !== statedRecipient) fail('DEVICE_MISMATCH');
      const aad = wrapAAD(binding, senderFingerprint, recipientFingerprint);
      const key = await wrappingKey(recipient, sender, salt, aad);
      return decrypt(key, nonce, ciphertext, aad);
    }
    return Object.freeze({ generateDeviceKeyPair, fingerprintPublicKey, generateConfigurationKey: () => random(32),
      encryptProfile, decryptProfile, wrapConfigurationKey, unwrapConfigurationKey });
  }
  return Object.freeze({ createConnectionVault, normalizeContext, normalizeProfile, ConnectionVaultError, LIMITS });
});
