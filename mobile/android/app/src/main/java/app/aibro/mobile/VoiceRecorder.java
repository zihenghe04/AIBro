package app.aibro.mobile;

import android.app.Activity;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.AudioRecordingConfiguration;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import com.getcapacitor.JSObject;
import java.io.File;
import java.io.FileInputStream;
import java.util.List;

/** Main-thread-owned, foreground-only microphone session with a bounded private temporary file. */
final class VoiceRecorder {
    interface Events { void send(JSObject event); }
    private final Activity activity;
    private final Events events;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final VoiceSessionState state = new VoiceSessionState();
    private final AudioManager audio;
    private MediaRecorder recorder;
    private AudioFocusRequest focusRequest;
    private boolean hasFocus;
    private long generation;
    private File file;
    private final Runnable deadline = () -> limit("duration");
    private AudioManager.OnAudioFocusChangeListener focusListener;
    VoiceRecorder(Activity activity, Events events) {
        this.activity = activity; this.events = events;
        audio = (AudioManager) activity.getSystemService(Context.AUDIO_SERVICE);
        File folder = directory();
        // A killed process cannot resume a microphone session. Remove only this feature's leftovers.
        File[] stale = folder.listFiles();
        if (stale != null) for (File old : stale) if (old.isFile() && old.getName().startsWith("voice-") && old.getName().endsWith(".m4a")) old.delete();
    }
    private File directory() { return new File(activity.getCacheDir(), "voice-recordings"); }
    boolean recording() { return state.recording(); }
    boolean hasSession() { return state.id() != null; }
    String requestId() { return state.id(); }
    @SuppressWarnings("deprecation")
    void start(String id) throws Exception {
        state.begin(id, SystemClock.elapsedRealtime());
        final long session = ++generation;
        focusListener = change -> {
            if (change < 0) main.post(() -> {
                if (generation == session && state.recording()) interrupt("音频被系统或其他应用中断，请重新录音");
            });
        };
        try {
            File folder = directory(); if (!folder.isDirectory() && !folder.mkdirs()) throw new IllegalStateException("无法创建录音临时文件，请检查空间");
            file = File.createTempFile("voice-", ".m4a", folder);
            if (audio == null) throw new IllegalStateException("设备没有可用音频服务");
            int focus;
            if (Build.VERSION.SDK_INT >= 26) {
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                    .setOnAudioFocusChangeListener(focusListener, main).setAcceptsDelayedFocusGain(false).build();
                focus = audio.requestAudioFocus(focusRequest);
            } else focus = audio.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
            hasFocus = focus == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
            if (!hasFocus) throw new IllegalStateException("麦克风音频被其他应用占用，请稍后重试");
            recorder = Build.VERSION.SDK_INT >= 31 ? new MediaRecorder(activity) : new MediaRecorder();
            final MediaRecorder owned = recorder;
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioChannels(1); recorder.setAudioSamplingRate(44100); recorder.setAudioEncodingBitRate(96000);
            recorder.setOutputFile(file.getAbsolutePath());
            recorder.setMaxDuration(VoiceSessionState.MAX_DURATION_MS); recorder.setMaxFileSize(VoiceSessionState.MAX_BYTES);
            recorder.setOnInfoListener((source, what, extra) -> {
                if (source == recorder && source == owned && (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED || what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED))
                    limit(what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED ? "duration" : "size");
            });
            recorder.setOnErrorListener((source, what, extra) -> { if (source == recorder && source == owned) fail("录音被系统中断，请检查麦克风权限后重试"); });
            if (Build.VERSION.SDK_INT >= 29) recorder.registerAudioRecordingCallback(activity.getMainExecutor(), new AudioManager.AudioRecordingCallback() {
                @Override public void onRecordingConfigChanged(List<AudioRecordingConfiguration> configurations) {
                    if (owned != recorder || !state.recording()) return;
                    for (AudioRecordingConfiguration configuration : configurations) if (configuration.isClientSilenced()) { interrupt("麦克风被其他应用或系统静音，请重新录音"); break; }
                }
            });
            recorder.prepare(); recorder.start();
            state.started(SystemClock.elapsedRealtime());
            activity.getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            main.postDelayed(deadline, VoiceSessionState.MAX_DURATION_MS);
        } catch (Exception error) { discard(); throw error; }
    }
    private void finish() throws Exception {
        if (!state.recording()) return;
        main.removeCallbacks(deadline);
        MediaRecorder owned = recorder; recorder = null;
        try { if (owned == null) throw new IllegalStateException("录音已中断"); owned.stop(); }
        finally { if (owned != null) { try { owned.release(); } catch (Exception ignored) {} } releaseFocus(); clearScreenFlag(); }
        state.finish(SystemClock.elapsedRealtime());
        if (file == null || !file.isFile() || file.length() < 128 || file.length() > VoiceSessionState.MAX_BYTES) throw new IllegalStateException("录音为空或超过 16 MB，请重新录音");
    }
    JSObject stop(String id) throws Exception {
        state.require(id);
        try {
            finish();
            byte[] bytes;
            try (FileInputStream input = new FileInputStream(file)) { bytes = NativePolicy.readBounded(input, VoiceSessionState.MAX_BYTES); }
            return new JSObject().put("requestId", id).put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
                .put("mimeType", "audio/mp4").put("durationMs", state.duration());
        } finally { discard(); }
    }
    boolean cancel(String id, String reason) {
        VoiceSessionState.validId(id); if (!state.matches(id)) return false;
        discard(); events.send(new JSObject().put("requestId", id).put("type", "cancelled").put("reason", reason)); return true;
    }
    void interrupt(String reason) { String id = state.id(); if (id != null) cancel(id, reason); }
    private void limit(String reason) {
        String id = state.id(); if (id == null || !state.recording()) return;
        try {
            finish();
            events.send(new JSObject().put("requestId", id).put("type", "limit").put("reason", reason).put("durationMs", state.duration()));
        } catch (Exception error) { fail("达到录音上限，但音频未完整保存，请重新录音"); }
    }
    private void fail(String error) {
        String id = state.id(); discard();
        if (id != null) events.send(new JSObject().put("requestId", id).put("type", "error").put("error", error));
    }
    @SuppressWarnings("deprecation")
    private void releaseFocus() {
        if (audio != null && hasFocus) {
            if (Build.VERSION.SDK_INT >= 26 && focusRequest != null) audio.abandonAudioFocusRequest(focusRequest);
            else audio.abandonAudioFocus(focusListener);
        }
        focusRequest = null; hasFocus = false;
    }
    private void clearScreenFlag() { activity.getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); }
    private void discard() {
        generation++;
        main.removeCallbacks(deadline);
        MediaRecorder owned = recorder; recorder = null;
        if (owned != null) { try { owned.reset(); } catch (Exception ignored) {} try { owned.release(); } catch (Exception ignored) {} }
        releaseFocus(); clearScreenFlag();
        if (file != null) { file.delete(); file = null; }
        state.clear();
    }
}
