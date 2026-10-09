package app.aibro.mobile;

/** Counts complete short presses, not auto-repeat downs. All original key events pass through. */
final class VolumePressSequence {
    static final long WINDOW_MS = 1500, MAX_PRESS_MS = 600, COOLDOWN_MS = 2500;
    private long downAt = -1, firstAt = -1, cooldownUntil;
    private int count;
    void down(long now, int repeat) {
        if (repeat != 0 || downAt >= 0 || now < cooldownUntil) { reset(); return; }
        downAt = now;
    }
    boolean up(long now, boolean cancelled) {
        long start = downAt; downAt = -1;
        if (cancelled || start < 0 || now < start || now - start > MAX_PRESS_MS || now < cooldownUntil) { reset(); return false; }
        if (firstAt < 0 || now < firstAt || now - firstAt > WINDOW_MS) { firstAt = start; count = 0; }
        if (++count != 3) return false;
        cooldownUntil = now + COOLDOWN_MS; reset(); return true;
    }
    void reset() { downAt = -1; firstAt = -1; count = 0; }
}
