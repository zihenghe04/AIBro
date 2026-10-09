package app.aibro.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.net.URI;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.Collections;
import java.util.IdentityHashMap;
import org.json.JSONObject;
import org.json.JSONArray;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Device-bound key material never leaves Android Keystore; disk contains authenticated ciphertext. */
final class SecretVault {
    private static final String ALIAS = "app.aibro.mobile.credentials.v1";
    // Also protects callers using another plugin/vault instance. No callbacks run under this lock.
    private static final Object LOCK = new Object();
    private static final Set<SharedPreferences> QUARANTINED = Collections.newSetFromMap(new IdentityHashMap<>());
    private static final byte[] PROCESS_SALT = new byte[32];
    private static long syncGeneration = 0;
    static { new SecureRandom().nextBytes(PROCESS_SALT); }
    private static final int CONNECTION_LIMIT = 4 * 1024 * 1024;
    private static final long MAX_REVISION = 9007199254740991L;
    private static final String CONNECTION_FORMAT = "aibro.connection-vault-native.v1";
    private static final String INPUT_ERROR = "连接配置格式无效";
    private static final String SESSION_ERROR = "同步登录已变化，请重新连接后重试";
    private static final String RECONNECT_ERROR = "请重新连接云同步后启用配置同步";
    private final SharedPreferences prefs;
    private final String alias;
    SecretVault(Context context) { this(context, "encrypted_credentials", ALIAS); }
    SecretVault(Context context, String preferences, String alias) {
        prefs = context.getSharedPreferences(preferences, Context.MODE_PRIVATE); this.alias = alias;
    }
    private static void validate(String key) {
        if (key == null || !NativePolicy.KEYS.contains(key)) throw new IllegalArgumentException("未知凭据类型");
    }
    private SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(alias)) return (SecretKey) store.getKey(alias, null);
        if (!create) throw new IllegalStateException("设备密钥不可用，请重新设置凭据");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }
    String get(String name) throws Exception {
        synchronized (LOCK) { validate(name); return readEntry(name); }
    }
    private String readEntry(String name) throws Exception {
        checkStorage();
        String saved = prefs.getString(name, null); if (saved == null) return null;
        String[] parts = saved.split(":", -1);
        if (parts.length != 3 || !parts[0].equals("v1")) throw new IllegalStateException("凭据无法解密，请重新设置");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, Base64.decode(parts[1], Base64.NO_WRAP)));
        cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
        return new String(cipher.doFinal(Base64.decode(parts[2], Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }
    void set(String name, String value) throws Exception {
        synchronized (LOCK) {
            validate(name);
            if (value == null || value.getBytes(StandardCharsets.UTF_8).length >= 65536) throw new IllegalArgumentException("凭据格式无效");
            writeEntry(name, value);
            if (name.equals("sync")) advanceSession();
        }
    }
    private void writeEntry(String name, String value) throws Exception {
        checkStorage();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key(true));
        cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
        String encrypted = "v1:" + Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" +
            Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
        commitEntry(name, encrypted);
    }
    void remove(String name) {
        synchronized (LOCK) {
            validate(name);
            commitEntry(name, null);
            if (name.equals("sync")) advanceSession();
        }
    }
    private void checkStorage() {
        if (QUARANTINED.contains(prefs)) throw new IllegalStateException("凭据写入未确认，请关闭后重开应用");
    }
    private void commitEntry(String name, String value) {
        checkStorage();
        VaultEntryCommit.replace(new VaultEntryCommit.Entry() {
            public String read() { return prefs.getString(name, null); }
            public boolean commit(String next) {
                SharedPreferences.Editor edit = prefs.edit();
                if (next == null) edit.remove(name); else edit.putString(name, next);
                return edit.commit();
            }
            public void quarantine() { QUARANTINED.add(prefs); }
        }, value);
    }
    private static void advanceSession() {
        if (syncGeneration == Long.MAX_VALUE) { new SecureRandom().nextBytes(PROCESS_SALT); syncGeneration = 0; }
        else syncGeneration++;
    }
    private static String digest(String text) throws Exception {
        return Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }
    private static String digestHex(String text) throws Exception {
        StringBuilder out = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8))) out.append(String.format(Locale.ROOT, "%02x", b & 255));
        return out.toString();
    }
    private static void fields(JSONObject value, String... allowed) {
        if (value == null || value.length() != allowed.length) throw new IllegalArgumentException(INPUT_ERROR);
        Set<String> names = new HashSet<>(Arrays.asList(allowed));
        java.util.Iterator<String> keys = value.keys();
        while (keys.hasNext()) if (!names.contains(keys.next())) throw new IllegalArgumentException(INPUT_ERROR);
    }
    private static String text(JSONObject object, String field) {
        Object value = object.opt(field);
        if (!(value instanceof String)) throw new IllegalArgumentException(INPUT_ERROR);
        return (String) value;
    }
    private static String identifier(JSONObject object, String field) {
        String value = text(object, field);
        if (!value.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,127}")) throw new IllegalArgumentException(INPUT_ERROR);
        return value;
    }
    private static String fingerprint(String value) {
        if (value == null || !value.matches("[A-Za-z0-9_-]{43}")) throw new IllegalArgumentException(INPUT_ERROR);
        byte[] bytes = Base64.decode(value, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        if (bytes.length != 32 || !Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING).equals(value)) throw new IllegalArgumentException(INPUT_ERROR);
        return value;
    }
    private static long revision(Object raw) {
        if (!(raw instanceof Number) || raw instanceof Float || raw instanceof Double && !Double.isFinite((Double) raw)) throw new IllegalArgumentException(INPUT_ERROR);
        double number = ((Number) raw).doubleValue();
        if (number < 0 || number > MAX_REVISION || number != Math.floor(number)) throw new IllegalArgumentException(INPUT_ERROR);
        return ((Number) raw).longValue();
    }
    private static String origin(String raw) {
        try {
            if (raw.length() > 2048) throw new Exception();
            URI url = new URI(raw);
            String scheme = url.getScheme(), host = url.getHost();
            if (scheme == null || host == null || url.getRawUserInfo() != null || url.getRawQuery() != null || url.getRawFragment() != null) throw new Exception();
            scheme = scheme.toLowerCase(Locale.ROOT); host = host.toLowerCase(Locale.ROOT);
            if (!scheme.equals("https") && !(scheme.equals("http") && Arrays.asList("localhost", "127.0.0.1", "[::1]", "::1").contains(host))) throw new Exception();
            int port = url.getPort(); if (port < -1 || port > 65535) throw new Exception();
            if (host.contains(":") && !host.startsWith("[")) host = "[" + host + "]";
            return scheme + "://" + host + (port < 0 || port == (scheme.equals("https") ? 443 : 80) ? "" : ":" + port);
        } catch (Exception ignored) { throw new IllegalArgumentException(INPUT_ERROR); }
    }
    private static JSONObject binding(JSONObject value) throws Exception {
        fields(value, "serverOrigin", "accountId");
        String server = text(value, "serverOrigin"), account = identifier(value, "accountId");
        if (!origin(server).equals(server)) throw new IllegalArgumentException(INPUT_ERROR);
        return new JSONObject().put("serverOrigin", server).put("accountId", account);
    }
    private static boolean sameBinding(JSONObject left, JSONObject right) {
        return left.optString("serverOrigin").equals(right.optString("serverOrigin")) && left.optString("accountId").equals(right.optString("accountId"));
    }
    private static String slot(JSONObject binding) throws Exception {
        return "connections.v1." + digest(new JSONArray().put(binding.getString("serverOrigin")).put(binding.getString("accountId")).toString());
    }
    private static JSONObject session(String raw) {
        try {
            if (raw == null) throw new Exception();
            JSONObject value = new JSONObject(raw);
            fields(value, "base", "token", "accountId", "sessionId");
            if (text(value, "token").isEmpty()) throw new Exception();
            identifier(value, "accountId"); identifier(value, "sessionId"); origin(text(value, "base"));
            return value;
        } catch (Exception ignored) { throw new IllegalArgumentException(RECONNECT_ERROR); }
    }
    private static String sessionFence(String raw) throws Exception {
        return digest(new JSONArray().put("aibro.connection-session.v1")
            .put(Base64.encodeToString(PROCESS_SALT, Base64.NO_WRAP)).put(Long.toString(syncGeneration)).put(raw).toString());
    }
    String connectionSessionFence(String expectedSyncSha256) throws Exception {
        synchronized (LOCK) {
            if (expectedSyncSha256 == null || !expectedSyncSha256.matches("[a-f0-9]{64}")) throw new IllegalArgumentException(INPUT_ERROR);
            String raw = readEntry("sync"); session(raw);
            if (!MessageDigest.isEqual(digestHex(raw).getBytes(StandardCharsets.US_ASCII), expectedSyncSha256.getBytes(StandardCharsets.US_ASCII))) throw new IllegalArgumentException(SESSION_ERROR);
            return sessionFence(raw);
        }
    }
    private static void validateFence(JSONObject fence, JSONObject binding) {
        fields(fence, "nativeFence", "serverOrigin", "accountId", "sessionId", "generation"); revision(fence.opt("generation"));
        fingerprint(text(fence, "nativeFence")); identifier(fence, "accountId"); identifier(fence, "sessionId");
        if (!sameBinding(fence, binding)) throw new IllegalArgumentException(INPUT_ERROR);
    }
    private boolean matchesSession(JSONObject fence) throws Exception {
        String raw = readEntry("sync"); JSONObject current;
        try { current = session(raw); } catch (IllegalArgumentException ignored) { return false; }
        return current.getString("accountId").equals(fence.getString("accountId")) && current.getString("sessionId").equals(fence.getString("sessionId")) &&
            origin(current.getString("base")).equals(fence.getString("serverOrigin")) &&
            MessageDigest.isEqual(sessionFence(raw).getBytes(StandardCharsets.US_ASCII), fence.getString("nativeFence").getBytes(StandardCharsets.US_ASCII));
    }
    private JSONObject readConnection(JSONObject binding) throws Exception {
        String raw = readEntry(slot(binding));
        if (raw == null) return new JSONObject().put("revision", 0).put("value", JSONObject.NULL);
        try {
            if (raw.getBytes(StandardCharsets.UTF_8).length > CONNECTION_LIMIT) throw new Exception();
            JSONObject stored = new JSONObject(raw);
            fields(stored, "format", "binding", "revision", "value");
            if (!CONNECTION_FORMAT.equals(text(stored, "format")) || !sameBinding(binding(stored.getJSONObject("binding")), binding)) throw new Exception();
            long version = revision(stored.get("revision")); if (version == 0) throw new Exception();
            validateValue(stored.get("value"), binding);
            return new JSONObject().put("revision", version).put("value", stored.get("value"));
        } catch (Exception ignored) { throw new IllegalStateException("连接配置无法读取，原数据已保留"); }
    }
    private static void validateValue(Object value, JSONObject binding) throws Exception {
        if (value == JSONObject.NULL) return;
        if (!(value instanceof JSONObject)) throw new IllegalArgumentException(INPUT_ERROR);
        JSONObject object = (JSONObject) value;
        if (!"aibro.connection-sync-local.v1".equals(text(object, "format")) || !sameBinding(binding(object.optJSONObject("binding")), binding)) throw new IllegalArgumentException(INPUT_ERROR);
    }
    JSONObject connectionVaultRead(JSONObject requestedBinding, JSONObject fence) throws Exception {
        synchronized (LOCK) {
            JSONObject binding = binding(requestedBinding); validateFence(fence, binding);
            if (!matchesSession(fence)) throw new IllegalArgumentException(SESSION_ERROR);
            return readConnection(binding);
        }
    }
    boolean connectionVaultCompareAndSwap(JSONObject requestedBinding, Object expectedRevision, Object value, JSONObject fence) throws Exception {
        synchronized (LOCK) {
            JSONObject binding = binding(requestedBinding); validateFence(fence, binding);
            long expected = revision(expectedRevision); if (expected == MAX_REVISION) throw new IllegalArgumentException(INPUT_ERROR);
            validateValue(value, binding);
            JSONObject next = new JSONObject().put("format", CONNECTION_FORMAT).put("binding", binding).put("revision", expected + 1).put("value", value);
            String raw = next.toString(); if (raw.getBytes(StandardCharsets.UTF_8).length > CONNECTION_LIMIT) throw new IllegalArgumentException("连接配置超过 4 MiB");
            if (!matchesSession(fence) || readConnection(binding).getLong("revision") != expected) return false;
            writeEntry(slot(binding), raw); return true;
        }
    }
}
