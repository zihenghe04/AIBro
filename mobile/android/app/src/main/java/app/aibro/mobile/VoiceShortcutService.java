package app.aibro.mobile;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.PowerManager;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityEvent;
import android.widget.Toast;

/** Key filtering only. Does not request screen content, gestures, screenshots or window events. */
public final class VoiceShortcutService extends AccessibilityService {
    private static volatile boolean connected;
    private final VolumePressSequence sequence = new VolumePressSequence();
    private SharedPreferences preferences;
    private final SharedPreferences.OnSharedPreferenceChangeListener settingsChanged = (prefs, key) -> {
        if (VoiceShortcutStore.OPT_IN.equals(key)) { sequence.reset(); configure(); }
    };
    static boolean isConnected() { return connected; }
    static boolean unlocked(Context context) {
        KeyguardManager keyguard = (KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        return keyguard != null && !keyguard.isKeyguardLocked() && power != null && power.isInteractive();
    }
    @Override protected void onServiceConnected() {
        connected = true;
        preferences = getSharedPreferences(VoiceShortcutStore.PREFERENCES, MODE_PRIVATE);
        preferences.registerOnSharedPreferenceChangeListener(settingsChanged); configure();
    }
    private void configure() {
        AccessibilityServiceInfo info = getServiceInfo(); if (info == null) return;
        info.eventTypes = 0;
        info.flags = new VoiceShortcutStore(this).enabled() ? AccessibilityServiceInfo.FLAG_REQUEST_FILTER_KEY_EVENTS : 0;
        setServiceInfo(info);
    }
    @Override protected boolean onKeyEvent(KeyEvent event) {
        if (!new VoiceShortcutStore(this).enabled() || !unlocked(this)) { sequence.reset(); return false; }
        if (event.getKeyCode() != KeyEvent.KEYCODE_VOLUME_DOWN) { sequence.reset(); return false; }
        if (event.getAction() == KeyEvent.ACTION_DOWN) sequence.down(event.getEventTime(), event.getRepeatCount());
        else if (event.getAction() == KeyEvent.ACTION_UP && sequence.up(event.getEventTime(), event.isCanceled())) {
            try {
                com.getcapacitor.JSObject pending = new VoiceShortcutStore(this).enqueue(null);
                Intent intent = new Intent(this, MainActivity.class).setAction(Intent.ACTION_VIEW)
                    .setData(android.net.Uri.parse(pending.getString("url"))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                startActivity(intent);
            } catch (Exception error) { Toast.makeText(this, "未能打开语音入口，请打开 AI Bro 后在首页使用。", Toast.LENGTH_LONG).show(); }
        }
        // Never swallow an unmatched down/up or simulate/replay another app's key events.
        return false;
    }
    @Override public void onAccessibilityEvent(AccessibilityEvent event) { /* No content is requested or read. */ }
    @Override public void onInterrupt() { sequence.reset(); }
    @Override public void onDestroy() {
        connected = false; sequence.reset();
        if (preferences != null) preferences.unregisterOnSharedPreferenceChangeListener(settingsChanged);
        super.onDestroy();
    }
}
