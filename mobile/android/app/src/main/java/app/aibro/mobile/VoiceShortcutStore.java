package app.aibro.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import com.getcapacitor.JSObject;
import org.json.JSONArray;
import java.util.UUID;

/** Durable one-item intent inbox. Ack happens only after the WebView creates its conversation. */
final class VoiceShortcutStore {
    static final String PREFERENCES = "voice_shortcut", OPT_IN = "enabled";
    static final long MAX_AGE_MS = 5 * 60 * 1000;
    private final SharedPreferences prefs;
    VoiceShortcutStore(Context context) { this(context, PREFERENCES); }
    VoiceShortcutStore(Context context, String name) { prefs = context.getSharedPreferences(name, Context.MODE_PRIVATE); }
    boolean enabled() { return prefs.getBoolean(OPT_IN, false); }
    void setEnabled(boolean enabled) {
        if (!prefs.edit().putBoolean(OPT_IN, enabled).commit()) throw new IllegalStateException("快捷键设置未保存");
    }
    static boolean isVoice(Uri uri) { return uri != null && "aibro".equals(uri.getScheme()) && "voice".equals(uri.getHost()) && "/new".equals(uri.getPath()); }
    synchronized JSObject pending() {
        String id = prefs.getString("pendingId", null); long created = prefs.getLong("createdAt", 0), now = System.currentTimeMillis();
        if (id == null) return new JSObject().put("requestId", org.json.JSONObject.NULL);
        if (created <= 0 || created > now + 10000 || now - created > MAX_AGE_MS) { acknowledge(id); return new JSObject().put("requestId", org.json.JSONObject.NULL); }
        return payload(id, created);
    }
    synchronized JSObject enqueue(String id) {
        id = id == null ? UUID.randomUUID().toString() : VoiceSessionState.validId(id);
        // Expiry may append to recentIds; expire first, then check replay protection.
        JSObject existing = pending();
        JSONArray recent = recent();
        for (int i = 0; i < recent.length(); i++) if (id.equals(recent.optString(i))) return new JSObject().put("requestId", org.json.JSONObject.NULL);
        if (!existing.isNull("requestId")) return existing;
        long now = System.currentTimeMillis();
        if (!prefs.edit().putString("pendingId", id).putLong("createdAt", now).commit()) throw new IllegalStateException("语音入口未保存，请在首页重试");
        return payload(id, now);
    }
    synchronized void acknowledge(String id) {
        VoiceSessionState.validId(id);
        if (!id.equals(prefs.getString("pendingId", null))) return;
        JSONArray previous = recent(), next = new JSONArray(); next.put(id);
        for (int i = 0; i < Math.min(previous.length(), 31); i++) if (!id.equals(previous.optString(i))) next.put(previous.optString(i));
        if (!prefs.edit().remove("pendingId").remove("createdAt").putString("recentIds", next.toString()).commit()) throw new IllegalStateException("语音入口确认未保存");
    }
    private JSONArray recent() { try { return new JSONArray(prefs.getString("recentIds", "[]")); } catch (Exception ignored) { return new JSONArray(); } }
    static JSObject payload(String id, long created) { return new JSObject().put("requestId", id).put("createdAt", created).put("url", "aibro://voice/new?requestId=" + Uri.encode(id)); }
}
