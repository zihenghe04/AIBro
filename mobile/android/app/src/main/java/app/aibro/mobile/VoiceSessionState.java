package app.aibro.mobile;

/** Ownership and duration boundary shared by all recorder completion/cancellation paths. */
final class VoiceSessionState {
    static final int MAX_DURATION_MS = 120000, MAX_BYTES = 16 * 1024 * 1024;
    private String requestId;
    private long startedAt, duration;
    private boolean recording;
    static String validId(String id) {
        if (id == null || !id.matches("[A-Za-z0-9_-]{1,100}")) throw new IllegalArgumentException("录音请求标识无效");
        return id;
    }
    void begin(String id, long now) {
        validId(id);
        if (requestId != null) throw new IllegalArgumentException("已有录音待完成，请先停止或取消");
        requestId = id; startedAt = now; duration = 0; recording = true;
    }
    void finish(long now) { if (requestId != null && recording) { duration = Math.max(0, Math.min(MAX_DURATION_MS, now - startedAt)); recording = false; } }
    void started(long now) { if (requestId != null && recording) startedAt = now; }
    void require(String id) { validId(id); if (!id.equals(requestId)) throw new IllegalArgumentException("这次录音已结束或请求不匹配"); }
    boolean matches(String id) { return requestId != null && requestId.equals(id); }
    String id() { return requestId; }
    boolean recording() { return recording; }
    long duration() { return duration; }
    void clear() { requestId = null; recording = false; duration = 0; startedAt = 0; }
}
