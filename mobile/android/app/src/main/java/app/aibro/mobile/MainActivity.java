package app.aibro.mobile;

import com.getcapacitor.BridgeActivity;
import android.content.Intent;
import android.os.Bundle;
import android.widget.Toast;
import android.view.KeyEvent;

public class MainActivity extends BridgeActivity {
    private boolean voiceForeground;
    private final VolumePressSequence volumePresses = new VolumePressSequence();
    boolean isVoiceForeground() { return voiceForeground && !isFinishing() && VoiceShortcutService.unlocked(this); }
    @Override public void onResume() { voiceForeground = true; super.onResume(); }
    @Override public void onPause() { voiceForeground = false; volumePresses.reset(); super.onPause(); }
    @Override protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(MobileBridge.class);
        super.onCreate(savedInstanceState);
    }
    @Override protected void onNewIntent(Intent intent) {
        // BridgeActivity invokes this for the cold-start intent too.
        if (VoiceShortcutStore.isVoice(intent.getData())) {
            try {
                new VoiceShortcutStore(this).enqueue(intent.getData().getQueryParameter("requestId"));
                if (bridge != null && bridge.getPlugin("MobileBridge") != null)
                    ((MobileBridge) bridge.getPlugin("MobileBridge").getInstance()).voiceShortcutReceived();
            } catch (Exception error) { Toast.makeText(this, "未能打开语音入口，请在首页重试。", Toast.LENGTH_LONG).show(); }
            // The durable inbox owns this intent, including after recreation/process death.
            intent.setAction(Intent.ACTION_MAIN); intent.setData(null); setIntent(intent);
        } else if (SharedInbox.isShare(intent)) {
            Intent copy = new Intent(intent);
            // Consume the launch action so rotation does not import the same share again.
            intent.setAction(Intent.ACTION_MAIN);
            intent.removeExtra(Intent.EXTRA_STREAM);
            intent.removeExtra(Intent.EXTRA_TEXT);
            intent.setClipData(null);
            setIntent(intent);
            SharedInbox.QUEUE.execute(() -> {
                try {
                    new SharedInbox(getApplicationContext()).capture(copy);
                    runOnUiThread(() -> {
                        if (bridge != null && bridge.getPlugin("MobileBridge") != null)
                            ((MobileBridge) bridge.getPlugin("MobileBridge").getInstance()).sharedReceived();
                    });
                } catch (Exception error) {
                    runOnUiThread(() -> Toast.makeText(this, "分享未保存，请从来源重新分享。" + safeMessage(error), Toast.LENGTH_LONG).show());
                }
            });
        } else setIntent(intent);
        super.onNewIntent(intent);
    }
    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        // Foreground fallback also works when the user has not enabled the system service.
        if (isVoiceForeground() && new VoiceShortcutStore(this).enabled() && !VoiceShortcutService.isConnected()) {
            if (event.getKeyCode() == KeyEvent.KEYCODE_VOLUME_DOWN) {
                if (event.getAction() == KeyEvent.ACTION_DOWN) volumePresses.down(event.getEventTime(), event.getRepeatCount());
                else if (event.getAction() == KeyEvent.ACTION_UP && volumePresses.up(event.getEventTime(), event.isCanceled())) {
                    try {
                        new VoiceShortcutStore(this).enqueue(null);
                        if (bridge != null && bridge.getPlugin("MobileBridge") != null)
                            ((MobileBridge) bridge.getPlugin("MobileBridge").getInstance()).voiceShortcutReceived();
                    } catch (Exception error) { Toast.makeText(this, "语音入口未保存，请在首页重试。", Toast.LENGTH_LONG).show(); }
                }
            } else volumePresses.reset();
        } else volumePresses.reset();
        return super.dispatchKeyEvent(event);
    }
    private String safeMessage(Exception error) {
        return error instanceof IllegalArgumentException ? error.getMessage() : "请检查文件授权与剩余空间。";
    }
}
